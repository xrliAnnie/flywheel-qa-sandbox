#!/usr/bin/env bash
# FLY-2404: migrate drained keyed homes while Bridge holds an owned pause.
set -euo pipefail

CURL_BIN="${FLYWHEEL_CODEX_CUTOVER_CURL_BIN:-$(command -v curl || true)}"
SCAN_BIN="${FLYWHEEL_CODEX_CUTOVER_LEGACY_SCAN_BIN:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/codex-home-credential-sweep.mjs}"
LINK_BIN="${FLYWHEEL_CODEX_CUTOVER_LINK_BIN:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/codex-home-link-truth.sh}"
BASE_URL="${FLYWHEEL_CODEX_CUTOVER_BASE_URL:-http://127.0.0.1:3000}"
HOMES_ROOT="${FLYWHEEL_CODEX_HOMES_ROOT:-${HOME}/.flywheel/codex-homes}"
STATE_FILE="${FLYWHEEL_CODEX_CUTOVER_STATE_FILE:-${HOME}/.flywheel/state/fly2404-cutover.json}"
POLL_SECONDS="${FLYWHEEL_CODEX_CUTOVER_POLL_SECONDS:-10}"
TIMEOUT_SECONDS="${FLYWHEEL_CODEX_CUTOVER_TIMEOUT_SECONDS:-14400}"
LEASE_ID=""
FINISHED=0

die() { printf '[codex-cutover] %s\n' "$*" >&2; exit 1; }
[ -n "${TEAMLEAD_API_TOKEN:-}" ] || die "TEAMLEAD_API_TOKEN is required"
for tool in "$CURL_BIN" "$SCAN_BIN" "$LINK_BIN"; do
	[ -x "$tool" ] && [ ! -L "$tool" ] || die "required tool is unavailable"
done
case "$POLL_SECONDS:$TIMEOUT_SECONDS" in
	*[!0-9:]*|:*|*:) die "poll and timeout values must be integers" ;;
esac

api_post() {
	local path="$1" body="$2"
	"$CURL_BIN" -fsS --max-time 5 -X POST \
		-H "Authorization: Bearer ${TEAMLEAD_API_TOKEN}" \
		-H 'Content-Type: application/json' -d "$body" "${BASE_URL}${path}"
}

api_get() {
	local path="$1"
	"$CURL_BIN" -fsS --max-time 5 \
		-H "Authorization: Bearer ${TEAMLEAD_API_TOKEN}" "${BASE_URL}${path}"
}

resume_owned_pause() {
	[ -n "$LEASE_ID" ] || return 0
	local body response
	body="$(jq -cn --arg leaseId "$LEASE_ID" '{leaseId:$leaseId}')"
	response="$(api_post /api/admission/resume "$body")" || return 1
	jq -e '.ok == true' <<<"$response" >/dev/null 2>&1
}

cleanup() {
	local rc=$?
	if [ "$FINISHED" -eq 0 ] && [ -n "$LEASE_ID" ]; then
		resume_owned_pause >/dev/null 2>&1 || true
	fi
	exit "$rc"
}
trap cleanup EXIT

renew_pause() {
	local body response
	body="$(jq -cn --arg leaseId "$LEASE_ID" \
		'{durationSeconds:3600,reason:"fly2404-cutover",leaseId:$leaseId}')"
	response="$(api_post /api/admission/pause "$body")" || return 1
	jq -e --arg leaseId "$LEASE_ID" \
		'.ok == true and .admissionPause.active == true and .admissionPause.leaseId == $leaseId' \
		<<<"$response" >/dev/null 2>&1
}

persist_state() {
	local directory temporary
	directory="$(dirname "$STATE_FILE")"
	mkdir -p "$directory"
	[ -d "$directory" ] && [ ! -L "$directory" ] || die "state directory is unsafe"
	chmod 700 "$directory"
	temporary="${STATE_FILE}.tmp.$$"
	(umask 077; jq -cn --arg leaseId "$LEASE_ID" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		'{v:1,leaseId:$leaseId,startedAt:$at}' > "$temporary")
	mv "$temporary" "$STATE_FILE"
	chmod 600 "$STATE_FILE"
}

# Pre-pause scan is informational; the mandatory mutation gate is repeated
# after quiescence under the owned pause.
"$SCAN_BIN" --json >/dev/null || die "legacy preflight scan failed"

if [ -e "$STATE_FILE" ] || [ -L "$STATE_FILE" ]; then
	[ -f "$STATE_FILE" ] && [ ! -L "$STATE_FILE" ] \
		|| die "cutover state is unsafe"
	existing="$(jq -er 'select(.v == 1) | .leaseId | select(test("^[0-9a-f-]{36}$"))' "$STATE_FILE" 2>/dev/null)" \
		|| die "cutover state is corrupt; resume manually"
	LEASE_ID="$existing"
	renew_pause || die "stored admission lease is not active"
else
	body='{"durationSeconds":3600,"reason":"fly2404-cutover"}'
	response="$(api_post /api/admission/pause "$body")" || die "admission pause failed"
	LEASE_ID="$(jq -er '.admissionPause | select(.active == true) | .leaseId | select(test("^[0-9a-f-]{36}$"))' <<<"$response")" \
		|| die "admission pause response is invalid"
	persist_state
fi

deadline=$(($(date +%s) + TIMEOUT_SECONDS))
while :; do
	quiescence="$(api_get /api/admission/quiescence)" || die "quiescence check failed"
	if jq -e '.quiescent == true' <<<"$quiescence" >/dev/null 2>&1; then break; fi
	[ "$(date +%s)" -lt "$deadline" ] || die "quiescence timed out"
	renew_pause || die "admission pause renewal failed"
	sleep "$POLL_SECONDS"
done

post_scan="$("$SCAN_BIN" --json)" || die "post-pause legacy scan failed"
jq -e '.activeLegacy | type == "array" and length == 0' <<<"$post_scan" >/dev/null 2>&1 \
	|| die "active legacy executions remain after quiescence"

homes=()
if [ -d "$HOMES_ROOT/agents" ] && [ ! -L "$HOMES_ROOT/agents" ]; then
	while IFS= read -r marker; do
		home="$(dirname "$marker")"
		case "$home" in */.locks/*) continue ;; esac
		homes+=("$home")
	done < <(find "$HOMES_ROOT/agents" -mindepth 3 -maxdepth 3 -type f \
		\( -name .flywheel-agent-home.json -o -name .credential-copy-pending \) \
		-print 2>/dev/null | sort -u)
fi

for home in ${homes[@]+"${homes[@]}"}; do
	while :; do
		renew_pause || die "admission pause renewal failed"
		if [ -d "$home/.flywheel-leases" ] \
			&& find "$home/.flywheel-leases" -type f -maxdepth 1 -print -quit | grep -q .; then
			[ "$(date +%s)" -lt "$deadline" ] || die "keyed lease drain timed out: $home"
			sleep "$POLL_SECONDS"
			continue
		fi
		set +e
		"$LINK_BIN" "$home"
		rc=$?
		set -e
		[ "$rc" -eq 0 ] && break
		[ "$rc" -eq 3 ] || die "link-truth failed rc=$rc home=$home"
		[ "$(date +%s)" -lt "$deadline" ] || die "link-truth remained busy: $home"
		sleep "$POLL_SECONDS"
	done
done

resume_owned_pause || die "owned admission resume failed"
LEASE_ID=""
rm -f "$STATE_FILE"
FINISHED=1
trap - EXIT
printf '[codex-cutover] state=complete migrated=%s\n' "${#homes[@]}"

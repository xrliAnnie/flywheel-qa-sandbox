#!/usr/bin/env bash
# FLY-1638: restart-services admission-pause contract.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() {
	FAILED=$((FAILED + 1))
	echo "[TEST] ✗ $1"
	shift
	[[ $# -eq 0 ]] || printf '[TEST]   %s\n' "$*"
}

test_file_mode() {
	local path="$1" mode=""
	if stat -c %a "$path" >/dev/null 2>&1; then
		mode="$(stat -c %a "$path" 2>/dev/null || true)"
		[[ "$mode" =~ ^[0-7]{3,4}$ ]] && { printf '%s\n' "$mode"; return 0; }
	fi
	if stat -f %Lp "$path" >/dev/null 2>&1; then
		mode="$(stat -f %Lp "$path" 2>/dev/null || true)"
		[[ "$mode" =~ ^[0-7]{3,4}$ ]] && { printf '%s\n' "$mode"; return 0; }
	fi
	return 1
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RS="${RESTART_SERVICES_UNDER_TEST:-${SCRIPT_DIR}/../restart-services.sh}"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1638-admission.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "${ROOT}/bin"

export RESTART_TEST_SYSTEM_STAT="$(command -v stat)"
if [[ -z "${QA_STAT_LOG:-}" ]]; then
cat > "${ROOT}/bin/stat" <<'FAKE'
#!/usr/bin/env bash
set -u
real_stat_value() {
	local kind="$1" path="$2" value=""
	if [[ "$kind" == "mode" ]]; then
		value=$("${RESTART_TEST_SYSTEM_STAT:?}" -c %a "$path" 2>/dev/null || true)
		[[ "$value" =~ ^[0-7]{3,4}$ ]] \
			|| value=$("$RESTART_TEST_SYSTEM_STAT" -f %Lp "$path" 2>/dev/null || true)
	else
		value=$("${RESTART_TEST_SYSTEM_STAT:?}" -c %u "$path" 2>/dev/null || true)
		[[ "$value" =~ ^[0-9]+$ ]] \
			|| value=$("$RESTART_TEST_SYSTEM_STAT" -f %u "$path" 2>/dev/null || true)
	fi
	[[ "$value" =~ ^[0-9]+$ ]] || return 1
	printf '%s\n' "$value"
}
if [[ "${1:-}" == "-f" ]]; then
	printf '  File: %s\n  Type: mocked GNU filesystem query\n' "${3:-${2:-unknown}}"
	exit 1
fi
if [[ "${1:-}" == "-c" ]]; then
	case "${2:-}" in
		%a) real_stat_value mode "${3:?}"; exit $? ;;
		%u) real_stat_value owner "${3:?}"; exit $? ;;
	esac
fi
exec "${RESTART_TEST_SYSTEM_STAT:?}" "$@"
FAKE
chmod +x "${ROOT}/bin/stat"
fi
RESTART_TEST_RUNTIME_PATH="${ROOT}/bin:$PATH"

FUNCS="${ROOT}/funcs.sh"
awk '
	/^log\(\)/,/^}/ { print; next }
	/^bridge_admission_request\(\)/,/^}/ { print; next }
	/^restart_admission_file_mode\(\)/,/^}/ { print; next }
	/^cutover_legacy_pause_pending\(\)/,/^}/ { print; next }
	/^cutover_legacy_pause_reason\(\)/,/^}/ { print; next }
	/^restart_admission_receipt_path\(\)/,/^}/ { print; next }
	/^write_restart_admission_receipt\(\)/,/^}/ { print; next }
	/^read_restart_admission_identifier\(\)/,/^}/ { print; next }
	/^clear_restart_admission_receipt\(\)/,/^}/ { print; next }
	/^record_admission_takeover_lapse\(\)/,/^}/ { print; next }
	/^write_cutover_admission_lease_handoff\(\)/,/^}/ { print; next }
	/^pause_admission_best_effort\(\)/,/^}/ { print; next }
	/^takeover_cutover_admission_pause_after_bridge_health\(\)/,/^}/ { print; next }
	/^resume_admission_best_effort\(\)/,/^}/ { print; next }
' "$RS" > "$FUNCS"

cat > "${ROOT}/bin/curl" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CURL_ARGV"
prev="" payload="" action=""
for arg in "$@"; do
	if [[ "$prev" == "-K" && "$arg" == "-" ]]; then cat >> "$CURL_STDIN"; fi
	if [[ "$prev" == "-d" ]]; then payload="$arg"; fi
	case "$arg" in
		*/api/admission/pause) action="pause" ;;
		*/api/admission/resume) action="resume" ;;
	esac
	prev="$arg"
done

# FLY-2280 stateful mode models the ownership predicate and whether a legacy
# NULL-owner row lapsed before an identifier-qualified acquisition.
if [[ -n "${FAKE_BRIDGE_ROW:-}" ]]; then
	normalized_reason=$(jq -r '.reason // "operator maintenance"
		| sub("^\\s+";"") | sub("\\s+$";"") | .[:200]' <<<"$payload")
	expected_reason=$(jq -r '.expectedLegacyReason // empty' <<<"$payload")
	request_lease=$(jq -r '.leaseId // empty' <<<"$payload")
	wire="${CURL_ARGV}.wire"

	if [[ "$action" == "pause" && -n "${FAKE_BRIDGE_FAIL:-}" ]]; then
		failure_rc="${FAKE_BRIDGE_FAIL%%:*}"
		printf 'pause FAIL rc=%s\n' "$failure_rc" >> "$wire"
		if [[ "$FAKE_BRIDGE_FAIL" == *":mutate" ]]; then
			jq -n --arg reason "$normalized_reason" \
				--arg lease_id 'ffffffff-ffff-4fff-8fff-ffffffffffff' \
				'{lease_id:$lease_id,reason:$reason}' > "$FAKE_BRIDGE_ROW"
		fi
		exit "$failure_rc"
	fi

	if [[ "$action" == "pause" ]]; then
		printf 'pause reason=%s expected=%s leaseId=%s\n' \
			"$normalized_reason" "${expected_reason:--}" "${request_lease:--}" >> "$wire"
		if [[ "${FAKE_BRIDGE_VERSION:-}" == "legacy" ]]; then
			if [[ -f "$FAKE_BRIDGE_ROW" ]]; then
				jq --arg reason "$normalized_reason" '.reason = $reason' \
					"$FAKE_BRIDGE_ROW" > "${FAKE_BRIDGE_ROW}.tmp"
			else
				jq -n --arg reason "$normalized_reason" \
					'{lease_id:null,reason:$reason}' > "${FAKE_BRIDGE_ROW}.tmp"
			fi
			mv -f "${FAKE_BRIDGE_ROW}.tmp" "$FAKE_BRIDGE_ROW"
			printf '%s\n' '{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800}}'
			exit 0
		fi

		owner='123e4567-e89b-42d3-a456-426614174000'
		reacquired_after_lapse=false
		if [[ -n "$request_lease" && -n "$expected_reason" ]]; then
			exit 22
		elif [[ -n "$request_lease" ]]; then
			if [[ ! -f "$FAKE_BRIDGE_ROW" ]] \
				|| [[ "$(jq -r '.lease_id // empty' "$FAKE_BRIDGE_ROW")" != "$request_lease" ]]; then
				exit 22
			fi
			owner="$request_lease"
		elif [[ -n "$expected_reason" ]]; then
			if [[ ! -f "$FAKE_BRIDGE_ROW" ]] \
				|| [[ "$(jq -r '.lease_id // empty' "$FAKE_BRIDGE_ROW")" != "" ]] \
				|| [[ "$(jq -r '.reason // empty' "$FAKE_BRIDGE_ROW")" != "$expected_reason" ]]; then
				exit 22
			fi
			if jq -e '.expired == true' "$FAKE_BRIDGE_ROW" >/dev/null 2>&1; then
				reacquired_after_lapse=true
			fi
		else
			if [[ -f "$FAKE_BRIDGE_ROW" ]] \
				&& [[ "$(jq -r '.lease_id // empty' "$FAKE_BRIDGE_ROW")" != "" ]]; then
				exit 22
			fi
		fi
		jq -n --arg reason "$normalized_reason" --arg lease_id "$owner" \
			'{lease_id:$lease_id,reason:$reason}' > "$FAKE_BRIDGE_ROW"
		if [[ "$reacquired_after_lapse" == "true" && -n "${FAKE_BRIDGE_INVALIDATE_RECEIPT:-}" ]]; then
			chmod 644 "$FAKE_BRIDGE_INVALIDATE_RECEIPT"
		fi
		jq -n --arg leaseId "$owner" --argjson reacquiredAfterLapse "$reacquired_after_lapse" \
			'{ok:true,admissionPause:{active:true,remainingSeconds:1800,reacquiredAfterLapse:$reacquiredAfterLapse,leaseId:$leaseId}}'
		exit 0
	fi

	printf 'resume leaseId=%s\n' "${request_lease:--}" >> "$wire"
	if [[ "${FAKE_BRIDGE_VERSION:-}" == "legacy" ]]; then
		rm -f "$FAKE_BRIDGE_ROW"
		printf '%s\n' '{"ok":true,"admissionPause":{"active":false,"remainingSeconds":0}}'
		exit 0
	fi
	if [[ ! -f "$FAKE_BRIDGE_ROW" ]] \
		|| [[ "$(jq -r '.lease_id // empty' "$FAKE_BRIDGE_ROW")" != "$request_lease" ]]; then
		exit 22
	fi
	rm -f "$FAKE_BRIDGE_ROW"
	printf '%s\n' '{"ok":true,"admissionPause":{"active":false,"remainingSeconds":0,"wasActive":true,"leaseLapsed":false}}'
	exit 0
fi

if [[ "$action" == "resume" && -n "${CURL_RESUME_RESPONSE:-}" ]]; then
	printf '%s\n' "$CURL_RESUME_RESPONSE"
elif [[ -n "${CURL_RESPONSE:-}" ]]; then
	printf '%s\n' "$CURL_RESPONSE"
else
	printf '%s\n' '{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800}}'
fi
exit "${CURL_RC:-0}"
FAKE
chmod +x "${ROOT}/bin/curl"

cat >> "$FUNCS" <<'HELPERS'
pause_then_resume() {
	pause_admission_best_effort
	resume_admission_best_effort
}
pause_twice_then_resume() {
	pause_admission_best_effort
	pause_admission_best_effort
	resume_admission_best_effort
}
legacy_pause_takeover_then_resume() {
	export CURL_RC=7
	pause_admission_best_effort
	export CURL_RC=0
	export CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800,"reacquiredAfterLapse":true,"leaseId":"123e4567-e89b-42d3-a456-426614174000"}}'
	takeover_cutover_admission_pause_after_bridge_health
	resume_admission_best_effort
}
plain_legacy_pause_takeover_then_resume() {
	export CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800}}'
	pause_admission_best_effort
	export CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800,"leaseId":"123e4567-e89b-42d3-a456-426614174000"}}'
	takeover_cutover_admission_pause_after_bridge_health
	resume_admission_best_effort
}
plain_failed_pause_then_takeover() {
	export CURL_RC=22
	pause_admission_best_effort
	takeover_cutover_admission_pause_after_bridge_health
}
plain_legacy_takeover_conflict() {
	export CURL_RC=0
	export CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800}}'
	pause_admission_best_effort
	export CURL_RC=22
	takeover_cutover_admission_pause_after_bridge_health
}
plain_foreign_null_without_receipt() {
	ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER=true
	ADMISSION_PAUSE_RELEASE_ON_EXIT=true
	takeover_cutover_admission_pause_after_bridge_health
}
detect_cutover_receipt() {
	cutover_legacy_pause_pending \
		&& write_cutover_admission_lease_handoff \
			'123e4567-e89b-42d3-a456-426614174000'
}
cross_version_legacy_bootstrap() {
	export FAKE_BRIDGE_VERSION=legacy
	pause_admission_best_effort || return 10
	export FAKE_BRIDGE_VERSION=lease
	takeover_cutover_admission_pause_after_bridge_health || return 20
	resume_admission_best_effort
}
cross_version_lease_phase1() {
	export FAKE_BRIDGE_VERSION=lease
	pause_admission_best_effort || return 10
	takeover_cutover_admission_pause_after_bridge_health || return 20
	resume_admission_best_effort
}
cross_version_phase1_only() {
	export FAKE_BRIDGE_VERSION=lease
	pause_admission_best_effort
}
cross_version_rollback_after_adopt() {
	export FAKE_BRIDGE_VERSION=lease
	pause_admission_best_effort || return 10
	pause_admission_best_effort || return 11
	resume_admission_best_effort
}
cross_version_ticket_after_legacy_rollback() {
	export FAKE_BRIDGE_VERSION=legacy
	pause_admission_best_effort || return 10
	export FAKE_BRIDGE_VERSION=lease
	takeover_cutover_admission_pause_after_bridge_health && return 0
	echo "TAKEOVER_REFUSED"
	return 20
}
HELPERS

run_fn() {
	local out="$1" err="$2"; shift 2
	env -i PATH="$RESTART_TEST_RUNTIME_PATH" \
		HOME="${ROOT}/home" \
		BRIDGE_URL="http://127.0.0.1:9876" \
		TEAMLEAD_API_TOKEN="super-secret" \
		ADMISSION_PAUSE_SECONDS=1800 RESTART_REASON="${RESTART_REASON:-deploy}" \
		CURL_ARGV="${ROOT}/curl.argv" CURL_STDIN="${ROOT}/curl.stdin" \
		RESTART_TEST_SYSTEM_STAT="$RESTART_TEST_SYSTEM_STAT" \
		${QA_STAT_LOG:+QA_STAT_LOG="$QA_STAT_LOG"} \
		${CURL_RESPONSE:+CURL_RESPONSE="$CURL_RESPONSE"} \
		${CURL_RESUME_RESPONSE:+CURL_RESUME_RESPONSE="$CURL_RESUME_RESPONSE"} \
		${CURL_RC:+CURL_RC="$CURL_RC"} \
		${FAKE_BRIDGE_ROW:+FAKE_BRIDGE_ROW="$FAKE_BRIDGE_ROW"} \
		${FAKE_BRIDGE_VERSION:+FAKE_BRIDGE_VERSION="$FAKE_BRIDGE_VERSION"} \
		${FAKE_BRIDGE_FAIL:+FAKE_BRIDGE_FAIL="$FAKE_BRIDGE_FAIL"} \
		${FAKE_BRIDGE_INVALIDATE_RECEIPT:+FAKE_BRIDGE_INVALIDATE_RECEIPT="$FAKE_BRIDGE_INVALIDATE_RECEIPT"} \
		${FLYWHEEL_HOST_CUTOVER_RECEIPT:+FLYWHEEL_HOST_CUTOVER_RECEIPT="$FLYWHEEL_HOST_CUTOVER_RECEIPT"} \
		bash -c "set -uo pipefail; source '$FUNCS'; \"\$@\"" _ "$@" >"$out" 2>"$err"
}

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800,"leaseId":"123e4567-e89b-42d3-a456-426614174000"}}' \
	run_fn "${ROOT}/out1" "${ROOT}/err1" pause_then_resume; rc=$?
[[ $rc -eq 0 ]] && pass "pause request is best-effort" || fail "pause rc=$rc"
grep -q 'api/admission/pause' "${ROOT}/curl.argv" \
	&& pass "pause targets the dedicated control API" || fail "pause API not called"
grep -q 'durationSeconds.*1800' "${ROOT}/curl.argv" \
	&& pass "pause sends the 1800-second lease" || fail "pause lease missing"
grep -q 'Authorization: Bearer super-secret' "${ROOT}/curl.stdin" \
	&& pass "master token rides curl stdin config" || fail "stdin auth missing"
if grep -q 'super-secret' "${ROOT}/curl.argv"; then
	fail "master token leaked into curl argv"
else
	pass "master token absent from curl argv"
fi
grep -q 'api/admission/resume' "${ROOT}/curl.argv" \
	&& pass "owned lease is resumed" || fail "owned resume API not called"
grep -q 'leaseId.*123e4567-e89b-42d3-a456-426614174000' "${ROOT}/curl.argv" \
	&& pass "resume sends the server-issued lease id" || fail "owner lease id missing from resume"

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
CURL_RC=22 run_fn "${ROOT}/out2" "${ROOT}/err2" pause_then_resume; rc=$?
[[ $rc -eq 0 ]] && pass "pre-feature/failed pause proceeds" || fail "failed pause rc=$rc"
grep -q 'no owned admission lease acquired; preserving any existing brake' "${ROOT}/out2" \
	&& pass "bootstrap/foreign-owner failure is explicit" || fail "acquisition warning missing"
if grep -q 'api/admission/resume' "${ROOT}/curl.argv"; then
	fail "failed or foreign-owned acquisition triggered resume"
else
	pass "failed or foreign-owned acquisition cannot resume another owner"
fi
if [[ "$(grep -c 'api/admission/pause' "${ROOT}/curl.argv")" == "1" ]]; then
	pass "failed ordinary acquisition does not schedule a post-health takeover"
else
	fail "failed ordinary acquisition scheduled an ownership takeover"
fi
if [[ "$(grep -c 'no owned admission lease acquired; preserving any existing brake' "${ROOT}/out2")" == "1" ]]; then
	pass "foreign active leases produce one warning and do not abort the ordinary deploy"
else
	fail "foreign active lease warning was duplicated or missing"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800}}' \
	run_fn "${ROOT}/out3" "${ROOT}/err3" pause_then_resume; rc=$?
[[ $rc -eq 0 ]] && pass "legacy pause response is best-effort" || fail "legacy pause rc=$rc"
if grep -q 'api/admission/resume' "${ROOT}/curl.argv"; then
	fail "legacy unowned pause was resumed"
else
	pass "legacy unowned pause is preserved for post-deploy takeover"
fi
grep -q 'no owner lease id; preserving the admission brake' "${ROOT}/out3" \
	&& pass "legacy preservation is explicit" || fail "legacy preservation warning missing"
restart_receipt=""
for candidate in "${ROOT}/home/.flywheel/state"/restart-services-admission-pause-*.json; do
	[[ -f "$candidate" ]] || continue
	restart_receipt="$candidate"
	break
done
receipt_mode=""
if [[ -f "$restart_receipt" ]]; then
	receipt_mode=$(test_file_mode "$restart_receipt" || true)
fi
if [[ "$receipt_mode" == "600" ]] \
	&& jq -e '.pid > 0
		and (.createdAt | type == "string")
		and (.pauseIdentifier | startswith("restart-services:deploy:pid="))' \
		"$restart_receipt" >/dev/null; then
	pass "legacy NULL-owner pause writes a durable 0600 run-local receipt"
else
	fail "legacy NULL-owner pause receipt missing or unsafe (mode=${receipt_mode:-missing})"
fi
[[ -z "$restart_receipt" ]] || rm -f "$restart_receipt"

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
run_fn "${ROOT}/out3b" "${ROOT}/err3b" plain_legacy_pause_takeover_then_resume; rc=$?
if [[ $rc -eq 0 ]] \
	&& [[ "$(grep -c 'api/admission/pause' "${ROOT}/curl.argv")" == "2" ]] \
	&& grep -q 'expectedLegacyReason.*restart-services:deploy:pid=' "${ROOT}/curl.argv" \
	&& grep -q 'api/admission/resume' "${ROOT}/curl.argv"; then
	pass "plain version-crossing deploy adopts the legacy NULL owner after health and releases its new lease"
else
	fail "plain legacy pause was not taken over and released (rc=$rc)" \
		"$(cat "${ROOT}/out3b" 2>/dev/null)"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
run_fn "${ROOT}/out3e" "${ROOT}/err3e" plain_foreign_null_without_receipt; rc=$?
if [[ $rc -eq 0 ]] \
	&& [[ ! -s "${ROOT}/curl.argv" ]] \
	&& grep -q 'no run-local receipt; preserving the foreign NULL-owner brake' "${ROOT}/out3e"; then
	pass "ordinary deploy cannot adopt or release a foreign NULL-owner brake"
else
	fail "ordinary deploy touched a foreign NULL-owner brake (rc=$rc)"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
run_fn "${ROOT}/out3c" "${ROOT}/err3c" plain_failed_pause_then_takeover; rc=$?
if [[ $rc -eq 0 ]] \
	&& [[ "$(grep -c 'api/admission/pause' "${ROOT}/curl.argv")" == "1" ]]; then
	pass "ordinary failed acquisition cannot abort after the new Bridge becomes healthy"
else
	fail "ordinary failed acquisition retried takeover and aborted (rc=$rc)"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
run_fn "${ROOT}/out3d" "${ROOT}/err3d" plain_legacy_takeover_conflict; rc=$?
if [[ $rc -eq 0 ]] \
	&& grep -q 'ordinary deploy could not take ownership' "${ROOT}/out3d"; then
	pass "ordinary NULL-owner takeover conflicts degrade to a warning"
else
	fail "ordinary NULL-owner takeover conflict aborted the deploy (rc=$rc)" \
		"$(cat "${ROOT}/out3d" 2>/dev/null)"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800,"leaseId":"123e4567-e89b-42d3-a456-426614174000"}}' \
	run_fn "${ROOT}/out4" "${ROOT}/err4" pause_twice_then_resume; rc=$?
renewal_uses=$(grep -o 'leaseId[^}]*123e4567-e89b-42d3-a456-426614174000' "${ROOT}/curl.argv" | wc -l | tr -d ' ')
if [[ $rc -eq 0 && "$renewal_uses" == "2" ]]; then
	pass "same owner id is reused for renewal and terminal resume"
else
	fail "same-owner renewal contract missing (uses=$renewal_uses rc=$rc)"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800,"reacquiredAfterLapse":true,"leaseId":"123e4567-e89b-42d3-a456-426614174000"}}' \
	run_fn "${ROOT}/out4b" "${ROOT}/err4b" pause_admission_best_effort; rc=$?
if [[ $rc -eq 0 ]] \
	&& grep -q 'admission owner lease was reacquired after expiry; admission continuity was broken' "${ROOT}/out4b"; then
	pass "restart surfaces an admission lease continuity breach"
else
	fail "restart hid the admission lease continuity breach (rc=$rc)"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800,"reacquiredAfterLapse":false,"leaseId":"123e4567-e89b-42d3-a456-426614174000"}}' \
CURL_RESUME_RESPONSE='{"ok":true,"admissionPause":{"active":false,"remainingSeconds":0,"wasActive":false,"leaseLapsed":true}}' \
	run_fn "${ROOT}/out4c" "${ROOT}/err4c" pause_then_resume; rc=$?
if [[ $rc -eq 0 ]] \
	&& grep -q 'admission brake had already expired before resume; admission continuity was broken' "${ROOT}/out4c"; then
	pass "restart logs an expired brake returned by owner-qualified resume"
else
	fail "restart hid an expired brake returned by resume (rc=$rc)"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
mkdir -p "${ROOT}/home/.flywheel/state"
cat > "${ROOT}/home/.flywheel/state/host-terminal-cutover.json" <<'JSON'
{"status":"paused","pause":{"remainingSeconds":1800,"leaseId":null,"reason":"tmux 3.7c host cutover"}}
JSON
chmod 600 "${ROOT}/home/.flywheel/state/host-terminal-cutover.json"
run_fn "${ROOT}/out5" "${ROOT}/err5" legacy_pause_takeover_then_resume; rc=$?
handoff="${ROOT}/home/.flywheel/state/host-terminal-cutover.admission-lease-id"
handoff_mode=""
if [[ -f "$handoff" ]]; then
	handoff_mode=$(test_file_mode "$handoff" || true)
fi
if [[ $rc -eq 0 && -f "$handoff" \
	&& "$(tr -d '\n' < "$handoff")" == "123e4567-e89b-42d3-a456-426614174000" \
	&& "$handoff_mode" == "600" ]] \
	&& grep -q 'legacy pause was reacquired after expiry; admission continuity was broken' "${ROOT}/out5" \
	&& jq -e '.pause.reacquiredAfterLapse == true' \
		"${ROOT}/home/.flywheel/state/host-terminal-cutover.json" >/dev/null; then
	pass "lapsed legacy cutover is warned, receipted, and handed off as a 0600 capability"
else
	fail "legacy cutover lapse/handoff evidence missing or unsafe (rc=$rc mode=${handoff_mode:-missing})"
fi
if grep -q 'api/admission/resume' "${ROOT}/curl.argv"; then
	fail "restart resumed the cutover-owned adopted lease"
else
	pass "adopted cutover lease remains paused for the host transaction"
fi

custom_receipt="${ROOT}/home/custom-state/host-terminal-cutover.json"
rm -f "${ROOT}/home/.flywheel/state/host-terminal-cutover.json"
mkdir -p "$(dirname "$custom_receipt")"
printf '%s\n' '{"status":"paused","pause":{"remainingSeconds":1800,"leaseId":null,"reason":"tmux 3.7c host cutover"}}' \
	> "$custom_receipt"
chmod 600 "$custom_receipt"
if FLYWHEEL_HOST_CUTOVER_RECEIPT="$custom_receipt" \
	run_fn "${ROOT}/out6" "${ROOT}/err6" detect_cutover_receipt \
	&& [[ "$(tr -d '\n' < "$(dirname "$custom_receipt")/host-terminal-cutover.admission-lease-id")" \
		== "123e4567-e89b-42d3-a456-426614174000" ]]; then
	pass "restart inspects the overridden receipt and writes its handoff beside it"
else
	fail "restart receipt/handoff paths ignored FLYWHEEL_HOST_CUTOVER_RECEIPT"
fi

# FLY-2280: stateful cross-version bootstrap coverage. Every case reseeds the
# singleton receipt/row/handoff unless explicitly documented as the T8 chain.
CUTOVER_RECEIPT="${ROOT}/home/.flywheel/state/host-terminal-cutover.json"
FAKE_ROW="${ROOT}/admission-pause-row.json"
HANDOFF="${ROOT}/home/.flywheel/state/host-terminal-cutover.admission-lease-id"
LEGACY='{"status":"paused","pause":{"remainingSeconds":3600,"leaseId":null,"reason":"FLY-2264 arm64 tmux destructive window"}}'
NULLROW='{"lease_id":null,"reason":"FLY-2264 arm64 tmux destructive window"}'
OWNER='123e4567-e89b-42d3-a456-426614174000'
LEGACY_REASON='FLY-2264 arm64 tmux destructive window'

seed_cross_version() {
	local receipt_json="$1" row_json="$2"
	mkdir -p "$(dirname "$CUTOVER_RECEIPT")"
	rm -f "$CUTOVER_RECEIPT" "$HANDOFF" "$FAKE_ROW" "${FAKE_ROW}.tmp"
	printf '%s\n' "$receipt_json" > "$CUTOVER_RECEIPT"
	chmod 600 "$CUTOVER_RECEIPT"
	if [[ "$row_json" != "__missing__" ]]; then
		printf '%s\n' "$row_json" > "$FAKE_ROW"
	fi
	: > "${ROOT}/curl.argv"
	: > "${ROOT}/curl.argv.wire"
	: > "${ROOT}/curl.stdin"
}

seed_cross_version "$LEGACY" "$NULLROW"
FAKE_BRIDGE_ROW="$FAKE_ROW" RESTART_REASON=updater \
	run_fn "${ROOT}/cross1.out" "${ROOT}/cross1.err" cross_version_legacy_bootstrap; cross1_rc=$?
if [[ "$(sed -n '1p' "${ROOT}/curl.argv.wire")" \
	== "pause reason=${LEGACY_REASON} expected=${LEGACY_REASON} leaseId=-" ]]; then
	pass "cross-version cutover bootstrap: phase-1 sends the receipt reason as both reason and expectedLegacyReason"
else
	fail "cross-version cutover bootstrap: phase-1 sends the receipt reason as both reason and expectedLegacyReason" \
		"$(tail -n 1 "${ROOT}/cross1.out" 2>/dev/null)"
fi
cross1_owner="$(jq -r '.lease_id // empty' "$FAKE_ROW" 2>/dev/null || true)"
cross1_handoff_mode=""
if [[ -f "$HANDOFF" ]]; then
	cross1_handoff_mode="$(test_file_mode "$HANDOFF" || true)"
fi
if [[ $cross1_rc -eq 0 && "$cross1_owner" == "$OWNER" \
	&& -f "$HANDOFF" && "$(tr -d '\n' < "$HANDOFF")" == "$cross1_owner" \
	&& "$cross1_handoff_mode" == "600" \
	&& "$(grep -c '^pause ' "${ROOT}/curl.argv.wire" || true)" == "2" \
	&& "$(grep -c '^resume ' "${ROOT}/curl.argv.wire" || true)" == "0" \
	&& $(grep -c 'legacy pause atomically adopted; owner handoff is durable' "${ROOT}/cross1.out" || true) -eq 1 ]]; then
	pass "cross-version cutover bootstrap: new Bridge adopts the legacy row after health and never resumes it"
else
	fail "cross-version cutover bootstrap: new Bridge adopts the legacy row after health and never resumes it" \
		"$(tail -n 1 "${ROOT}/cross1.out" 2>/dev/null)"
fi

long_reason="$(printf '%0201d' 0 | tr '0' 'a')"
invalid_receipts=(
	'{"status":"paused","pause":{"remainingSeconds":3600,"leaseId":null,"reason":"trailing "}}'
	"$(jq -cn --arg reason "$long_reason" '{status:"paused",pause:{remainingSeconds:3600,leaseId:null,reason:$reason}}')"
	'{"status":"paused","pause":{"remainingSeconds":3600,"leaseId":null}}'
)
for invalid_receipt in "${invalid_receipts[@]}"; do
	seed_cross_version "$invalid_receipt" "$NULLROW"
	cp "$FAKE_ROW" "${FAKE_ROW}.before"
	FAKE_BRIDGE_ROW="$FAKE_ROW" RESTART_REASON=updater \
		run_fn "${ROOT}/cross3.out" "${ROOT}/cross3.err" cross_version_phase1_only; cross3_rc=$?
	if [[ $cross3_rc -ne 0 && ! -s "${ROOT}/curl.argv" \
		&& $(grep -c 'cutover receipt has no valid legacy pause identifier; refusing to touch the brake before Bridge stop' "${ROOT}/cross3.out" || true) -eq 1 \
		&& $(cmp -s "$FAKE_ROW" "${FAKE_ROW}.before"; printf '%s' "$?") -eq 0 ]]; then
		pass "cross-version cutover bootstrap: invalid receipt reason fails closed before any Bridge call"
	else
		fail "cross-version cutover bootstrap: invalid receipt reason fails closed before any Bridge call" \
			"$(tail -n 1 "${ROOT}/cross3.out" 2>/dev/null)"
	fi
done

seed_cross_version "$LEGACY" "$NULLROW"
FAKE_BRIDGE_ROW="$FAKE_ROW" RESTART_REASON=updater \
	run_fn "${ROOT}/cross4.out" "${ROOT}/cross4.err" cross_version_lease_phase1; cross4_rc=$?
cross4_owner="$(jq -r '.lease_id // empty' "$FAKE_ROW" 2>/dev/null || true)"
if [[ $cross4_rc -eq 0 \
	&& "$(sed -n '1p' "${ROOT}/curl.argv.wire")" == "pause reason=${LEGACY_REASON} expected=${LEGACY_REASON} leaseId=-" \
	&& "$cross4_owner" == "$OWNER" && -f "$HANDOFF" \
	&& "$(tr -d '\n' < "$HANDOFF")" == "$cross4_owner" \
	&& "$(grep -c '^pause ' "${ROOT}/curl.argv.wire" || true)" == "1" \
	&& "$(grep -c '^resume ' "${ROOT}/curl.argv.wire" || true)" == "0" \
	&& $(grep -c 'cutover lease adopted and handed off' "${ROOT}/cross4.out" || true) -eq 1 ]]; then
	pass "cross-version cutover bootstrap: lease-aware Bridge adopts only the identifier-qualified legacy row"
else
	fail "cross-version cutover bootstrap: lease-aware Bridge adopts only the identifier-qualified legacy row" \
		"$(tail -n 1 "${ROOT}/cross4.out" 2>/dev/null)"
fi

expired_row='{"lease_id":null,"reason":"FLY-2264 arm64 tmux destructive window","expired":true}'
seed_cross_version "$LEGACY" "$expired_row"
FAKE_BRIDGE_ROW="$FAKE_ROW" RESTART_REASON=updater \
	run_fn "${ROOT}/cross4b.out" "${ROOT}/cross4b.err" cross_version_phase1_only; cross4b_rc=$?
if [[ $cross4b_rc -eq 0 \
	&& -f "$HANDOFF" \
	&& $(grep -c 'admission continuity was broken' "${ROOT}/cross4b.out" || true) -eq 1 \
	&& $(jq -r '.pause.reacquiredAfterLapse == true' "$CUTOVER_RECEIPT") == "true" ]]; then
	pass "cross-version cutover bootstrap: phase-1 persists a lapsed legacy acquisition before handoff"
else
	fail "cross-version cutover bootstrap: phase-1 persists a lapsed legacy acquisition before handoff" \
		"$(tail -n 2 "${ROOT}/cross4b.out" 2>/dev/null)"
fi

seed_cross_version "$LEGACY" "$expired_row"
FAKE_BRIDGE_ROW="$FAKE_ROW" FAKE_BRIDGE_INVALIDATE_RECEIPT="$CUTOVER_RECEIPT" RESTART_REASON=updater \
	run_fn "${ROOT}/cross4c.out" "${ROOT}/cross4c.err" cross_version_phase1_only; cross4c_rc=$?
if [[ $cross4c_rc -ne 0 \
	&& ! -e "$HANDOFF" \
	&& $(grep -c 'lapse evidence could not be written' "${ROOT}/cross4c.out" || true) -eq 1 ]]; then
	pass "cross-version cutover bootstrap: phase-1 refuses before handoff when lapse evidence cannot be persisted"
else
	fail "cross-version cutover bootstrap: phase-1 refuses before handoff when lapse evidence cannot be persisted" \
		"$(tail -n 2 "${ROOT}/cross4c.out" 2>/dev/null)"
fi

mismatched_row='{"lease_id":null,"reason":"restart-services:updater:pid=1:started=x"}'
seed_cross_version "$LEGACY" "$mismatched_row"
cp "$FAKE_ROW" "${FAKE_ROW}.before"
FAKE_BRIDGE_ROW="$FAKE_ROW" RESTART_REASON=updater \
	run_fn "${ROOT}/cross5.out" "${ROOT}/cross5.err" cross_version_phase1_only; cross5_rc=$?
if [[ $cross5_rc -ne 0 \
	&& "$(grep -c '^pause ' "${ROOT}/curl.argv.wire" || true)" == "1" \
	&& $(cmp -s "$FAKE_ROW" "${FAKE_ROW}.before"; printf '%s' "$?") -eq 0 \
	&& ! -e "$HANDOFF" \
	&& $(grep -c 'rejected or its outcome is unknown (curl rc=22)' "${ROOT}/cross5.out" || true) -eq 1 ]]; then
	pass "cross-version cutover bootstrap: mismatched NULL-owner row is refused before Bridge stop"
else
	fail "cross-version cutover bootstrap: mismatched NULL-owner row is refused before Bridge stop" \
		"$(tail -n 1 "${ROOT}/cross5.out" 2>/dev/null)"
fi

owned_row='{"lease_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reason":"FLY-2264 arm64 tmux destructive window"}'
for with_handoff in false true; do
	seed_cross_version "$LEGACY" "$owned_row"
	if [[ "$with_handoff" == "true" ]]; then
		printf '%s\n' 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' > "$HANDOFF"
		chmod 600 "$HANDOFF"
	fi
	cp "$FAKE_ROW" "${FAKE_ROW}.before"
	[[ ! -e "$HANDOFF" ]] || cp "$HANDOFF" "${HANDOFF}.before"
	FAKE_BRIDGE_ROW="$FAKE_ROW" RESTART_REASON=updater \
		run_fn "${ROOT}/cross6.out" "${ROOT}/cross6.err" cross_version_phase1_only; cross6_rc=$?
	handoff_unchanged=true
	if [[ "$with_handoff" == "true" ]]; then
		cmp -s "$HANDOFF" "${HANDOFF}.before" || handoff_unchanged=false
	else
		[[ ! -e "$HANDOFF" ]] || handoff_unchanged=false
	fi
	if [[ $cross6_rc -ne 0 \
		&& "$(grep -c '^pause ' "${ROOT}/curl.argv.wire" || true)" == "1" \
		&& $(cmp -s "$FAKE_ROW" "${FAKE_ROW}.before"; printf '%s' "$?") -eq 0 \
		&& "$handoff_unchanged" == "true" \
		&& $(grep -c 'rejected or its outcome is unknown' "${ROOT}/cross6.out" || true) -eq 1 ]]; then
		pass "cross-version cutover bootstrap: already-owned legacy row is refused before Bridge stop (with and without handoff)"
	else
		fail "cross-version cutover bootstrap: already-owned legacy row is refused before Bridge stop (with and without handoff)" \
			"$(tail -n 1 "${ROOT}/cross6.out" 2>/dev/null)"
	fi
done

owned_receipt='{"status":"paused","pause":{"remainingSeconds":3600,"leaseId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","reason":"FLY-2264 arm64 tmux destructive window"}}'
seed_cross_version "$owned_receipt" "$owned_row"
cp "$CUTOVER_RECEIPT" "${CUTOVER_RECEIPT}.before"
cp "$FAKE_ROW" "${FAKE_ROW}.before"
FAKE_BRIDGE_ROW="$FAKE_ROW" RESTART_REASON=updater \
	run_fn "${ROOT}/cross7.out" "${ROOT}/cross7.err" cross_version_lease_phase1; cross7_rc=$?
if [[ $cross7_rc -eq 0 \
	&& $(cmp -s "$CUTOVER_RECEIPT" "${CUTOVER_RECEIPT}.before"; printf '%s' "$?") -eq 0 \
	&& $(cmp -s "$FAKE_ROW" "${FAKE_ROW}.before"; printf '%s' "$?") -eq 0 \
	&& "$(grep -c '^pause ' "${ROOT}/curl.argv.wire" || true)" == "1" \
	&& "$(grep -c '^resume ' "${ROOT}/curl.argv.wire" || true)" == "0" \
	&& $(grep -c 'preserving any existing brake' "${ROOT}/cross7.out" || true) -eq 1 ]]; then
	pass "active owned cutover receipt takes the ordinary path: row and receipt untouched, never resumed"
else
	fail "active owned cutover receipt takes the ordinary path: row and receipt untouched, never resumed" \
		"$(tail -n 1 "${ROOT}/cross7.out" 2>/dev/null)"
fi

seed_cross_version "$LEGACY" "$NULLROW"
FAKE_BRIDGE_ROW="$FAKE_ROW" RESTART_REASON=updater \
	run_fn "${ROOT}/cross8.out" "${ROOT}/cross8.err" cross_version_rollback_after_adopt; cross8_rc=$?
cross8_owner="$(jq -r '.lease_id // empty' "$FAKE_ROW" 2>/dev/null || true)"
if [[ $cross8_rc -eq 0 \
	&& "$(sed -n '2p' "${ROOT}/curl.argv.wire")" == "pause reason=${LEGACY_REASON} expected=- leaseId=${cross8_owner}" \
	&& -f "$HANDOFF" && "$(tr -d '\n' < "$HANDOFF")" == "$cross8_owner" \
	&& "$(grep -c '^resume ' "${ROOT}/curl.argv.wire" || true)" == "0" ]]; then
	pass "rollback after cutover adoption renews by leaseId only and never resumes"
else
	fail "rollback after cutover adoption renews by leaseId only and never resumes" \
		"$(tail -n 1 "${ROOT}/cross8.out" 2>/dev/null)"
fi

# T8b and T8c intentionally continue from the owned row/handoff created by T8.
: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.argv.wire"; : > "${ROOT}/curl.stdin"
FAKE_BRIDGE_ROW="$FAKE_ROW" RESTART_REASON=updater \
	run_fn "${ROOT}/cross8b.out" "${ROOT}/cross8b.err" cross_version_ticket_after_legacy_rollback; cross8b_rc=$?
if [[ $cross8b_rc -eq 20 \
	&& $(grep -c 'TAKEOVER_REFUSED' "${ROOT}/cross8b.out" || true) -eq 1 \
	&& $(grep -c 'could not take ownership of the legacy cutover pause' "${ROOT}/cross8b.out" || true) -eq 1 \
	&& "$(jq -r '.lease_id // empty' "$FAKE_ROW")" == "$cross8_owner" \
	&& "$(jq -r '.reason // empty' "$FAKE_ROW")" == "$LEGACY_REASON" \
	&& "$(tr -d '\n' < "$HANDOFF")" == "$cross8_owner" ]]; then
	pass "ticket after code rollback to the legacy Bridge: phase-1 continues, takeover refuses, owner and handoff preserved"
else
	fail "ticket after code rollback to the legacy Bridge: phase-1 continues, takeover refuses, owner and handoff preserved" \
		"$(tail -n 1 "${ROOT}/cross8b.out" 2>/dev/null)"
fi

jq --arg leaseId "$cross8_owner" '.pause.leaseId = $leaseId' \
	"$CUTOVER_RECEIPT" > "${CUTOVER_RECEIPT}.tmp" && mv -f "${CUTOVER_RECEIPT}.tmp" "$CUTOVER_RECEIPT"
chmod 600 "$CUTOVER_RECEIPT"
: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.argv.wire"; : > "${ROOT}/curl.stdin"
cp "$FAKE_ROW" "${FAKE_ROW}.before"
FAKE_BRIDGE_ROW="$FAKE_ROW" RESTART_REASON=updater \
	run_fn "${ROOT}/cross8c.out" "${ROOT}/cross8c.err" cross_version_lease_phase1; cross8c_rc=$?
if [[ $cross8c_rc -eq 0 \
	&& $(cmp -s "$FAKE_ROW" "${FAKE_ROW}.before"; printf '%s' "$?") -eq 0 \
	&& "$(grep -c '^resume ' "${ROOT}/curl.argv.wire" || true)" == "0" \
	&& $(grep -c 'preserving any existing brake' "${ROOT}/cross8c.out" || true) -eq 1 ]]; then
	pass "owned receipt after handoff import completes on the ordinary path"
else
	fail "owned receipt after handoff import completes on the ordinary path" \
		"$(tail -n 1 "${ROOT}/cross8c.out" 2>/dev/null)"
fi

seed_cross_version "$LEGACY" "$NULLROW"
cp "$FAKE_ROW" "${FAKE_ROW}.before"
FAKE_BRIDGE_ROW="$FAKE_ROW" FAKE_BRIDGE_FAIL=7 RESTART_REASON=updater \
	run_fn "${ROOT}/cross9.out" "${ROOT}/cross9.err" cross_version_phase1_only; cross9_rc=$?
if [[ $cross9_rc -eq 0 \
	&& $(grep -c 'preserving any existing brake' "${ROOT}/cross9.out" || true) -eq 1 \
	&& $(cmp -s "$FAKE_ROW" "${FAKE_ROW}.before"; printf '%s' "$?") -eq 0 ]]; then
	pass "fresh cutover acquisition against an unreachable Bridge keeps the best-effort path"
else
	fail "fresh cutover acquisition against an unreachable Bridge keeps the best-effort path" \
		"$(tail -n 1 "${ROOT}/cross9.out" 2>/dev/null)"
fi

seed_cross_version "$LEGACY" "$NULLROW"
FAKE_BRIDGE_ROW="$FAKE_ROW" FAKE_BRIDGE_FAIL=22 RESTART_REASON=updater \
	run_fn "${ROOT}/cross10.out" "${ROOT}/cross10.err" cross_version_phase1_only; cross10_rc=$?
if [[ $cross10_rc -ne 0 \
	&& $(grep -c 'rejected or its outcome is unknown (curl rc=22)' "${ROOT}/cross10.out" || true) -eq 1 \
	&& ! -e "$HANDOFF" ]]; then
	pass "fresh cutover acquisition rejected with an HTTP error refuses before Bridge stop without claiming 409"
else
	fail "fresh cutover acquisition rejected with an HTTP error refuses before Bridge stop without claiming 409" \
		"$(tail -n 1 "${ROOT}/cross10.out" 2>/dev/null)"
fi

seed_cross_version "$LEGACY" "$NULLROW"
FAKE_BRIDGE_ROW="$FAKE_ROW" FAKE_BRIDGE_FAIL=28:mutate RESTART_REASON=updater \
	run_fn "${ROOT}/cross11.out" "${ROOT}/cross11.err" cross_version_phase1_only; cross11_rc=$?
if [[ $cross11_rc -ne 0 \
	&& $(grep -c 'outcome is unknown (curl rc=28)' "${ROOT}/cross11.out" || true) -eq 1 \
	&& ! -e "$HANDOFF" \
	&& "$(jq -r '.lease_id // empty' "$FAKE_ROW")" == 'ffffffff-ffff-4fff-8fff-ffffffffffff' ]]; then
	pass "ambiguous transport failure after a server-side commit refuses and fabricates no handoff"
else
	fail "ambiguous transport failure after a server-side commit refuses and fabricates no handoff" \
		"$(tail -n 1 "${ROOT}/cross11.out" 2>/dev/null)"
fi

deploy_body="${ROOT}/deploy.body"
rollback_body="${ROOT}/rollback.body"
identity_failure_body="${ROOT}/identity-failure.body"
voice_deploy_body="${ROOT}/voice-deploy.body"
awk '/^deploy_and_verify\(\)/,/^}/' "$RS" > "$deploy_body"
awk '/^rollback_and_restart\(\)/,/^}/' "$RS" > "$rollback_body"
awk '
	/if ! dbi_accept_health_identity/ { capture=1 }
	capture && /rm -f .*deploy-build-identity/ { capture=0 }
	capture { print }
' "$RS" > "$identity_failure_body"
awk '/^ensure_voice_bridge_for_deploy\(\)/,/^}/' "$RS" > "$voice_deploy_body"
notify_line=$(grep -n 'notify_routine "🔄 开始全量重启' "$deploy_body" | cut -d: -f1)
pause_line=$(grep -n 'pause_admission_best_effort' "$deploy_body" | head -1 | cut -d: -f1)
stop_line=$(grep -n 'if ! stop_bridge' "$deploy_body" | head -1 | cut -d: -f1)
if [[ "$notify_line" =~ ^[0-9]+$ && "$pause_line" =~ ^[0-9]+$ && "$stop_line" =~ ^[0-9]+$ ]] \
	&& (( notify_line < pause_line && pause_line < stop_line )); then
	pass "deploy Step 0 pauses after notice and before stop"
else
	fail "deploy Step 0 ordering is wrong"
fi
health_line=$(grep -n 'Bridge health check: OK' "$deploy_body" | cut -d: -f1)
identity_line=$(grep -n 'dbi_accept_health_identity' "$deploy_body" | cut -d: -f1)
takeover_line=$(grep -n 'takeover_cutover_admission_pause_after_bridge_health' "$deploy_body" | cut -d: -f1)
lead_wave_line=$(grep -n 'do_restart_all_leads stagger' "$deploy_body" | cut -d: -f1)
resume_line=$(grep -n 'resume_admission_best_effort' "$deploy_body" | tail -1 | cut -d: -f1)
if [[ "$health_line" =~ ^[0-9]+$ && "$identity_line" =~ ^[0-9]+$ \
	&& "$takeover_line" =~ ^[0-9]+$ && "$lead_wave_line" =~ ^[0-9]+$ \
	&& "$resume_line" =~ ^[0-9]+$ ]] \
	&& (( health_line < identity_line && identity_line < takeover_line \
		&& takeover_line < lead_wave_line && lead_wave_line < resume_line )); then
	pass "legacy ownership takeover occurs after accepted Bridge health and before the full Lead wave"
else
	fail "legacy ownership takeover is not fenced between Bridge identity and the Lead wave"
fi
if grep -q 'resume_admission_best_effort' "$identity_failure_body" \
	&& grep -q 'resume_admission_best_effort' "$voice_deploy_body"; then
	pass "post-health identity and no-rollback voice failures release ordinary owned brakes"
else
	fail "a post-health deploy failure can retain an ordinary owned brake until TTL"
fi
grep -B12 'if ! stop_bridge' "$rollback_body" | grep -q 'pause_admission_best_effort' \
	&& pass "rollback also pauses before stopping Bridge" \
	|| fail "rollback pause ordering missing"
if grep -B16 'if ! stop_bridge' "$rollback_body" \
	| grep -q 'if ! pause_admission_best_effort; then' \
	&& grep -q 'rollback admission pause failed; continuing rollback' "$rollback_body"; then
	pass "rollback handles pause failure explicitly and continues recovery"
else
	fail "rollback pause failure can still interrupt recovery under set -e"
fi
rollback_wave_line=$(grep -n 'do_restart_all_leads immediate' "$rollback_body" | cut -d: -f1)
rollback_resume_line=$(grep -n 'resume_admission_best_effort' "$rollback_body" | tail -1 | cut -d: -f1)
if [[ "$rollback_wave_line" =~ ^[0-9]+$ && "$rollback_resume_line" =~ ^[0-9]+$ ]] \
	&& (( rollback_wave_line < rollback_resume_line )); then
	pass "rollback keeps the owned brake through its Lead recovery wave"
else
	fail "rollback admission resume precedes Lead recovery"
fi
grep -q 'ADMISSION_PAUSE_SECONDS="${FLYWHEEL_RESTART_ADMISSION_PAUSE_SECONDS:-1800}"' "$RS" \
	&& pass "default pause lease is 1800 seconds (> 15-minute health default)" \
	|| fail "1800-second default missing"
if ! grep -q 'FLYWHEEL_RESTART_ADMISSION_RECEIPT' "$RS" \
	&& grep -Fq 'register_restart_transient_file "$(restart_admission_receipt_path)"' "$RS"; then
	pass "restart receipt path is fixed and registered for terminal cleanup"
else
	fail "restart receipt still has an env bypass or is absent from transient cleanup"
fi

echo ""
echo "[TEST] restart-services-admission-pause: ${PASSED} passed, ${FAILED} failed"
[[ $FAILED -eq 0 ]]

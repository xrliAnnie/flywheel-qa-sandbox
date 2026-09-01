#!/usr/bin/env bash
# FLY-2216: tuple-bound recovery for an opted-in resident Codex Lead.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
PROJECT=""
LEAD_ID=""
LABEL=""
DAEMON_KEY=""
WRAPPER=""
EXPECTED_CODEX_HOME=""
TARGET="gui/$(id -u)/${LABEL}"
RUNTIME_SUFFIX="/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js"
TEST_ROOT="${FLYWHEEL_CODEX_RESIDENCY_RECOVERY_TEST_ROOT:-}"

fail() {
	local code="$1" detail="$2"
	jq -cn --arg detail "$detail" '{ok:false,detail:$detail}'
	printf '[resident-codex-lead-recover] %s\n' "$detail" >&2
	exit "$code"
}

[ "${1:-}" = "--project" ] || fail 10 "usage requires --project <name> --lead <id>"
PROJECT="${2:-}"
shift 2
[ "${1:-}" = "--lead" ] || fail 10 "usage requires --project <name> --lead <id>"
LEAD_ID="${2:-}"
shift 2
for identity in "$PROJECT" "$LEAD_ID"; do
	[ -n "$identity" ] && [ "${#identity}" -le 64 ] \
		&& [[ "$identity" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
		|| fail 10 "project and lead identities must be bounded safe ids"
done
DAEMON_KEY="${PROJECT}-${LEAD_ID}"
[ "${#DAEMON_KEY}" -le 128 ] || fail 10 "derived Lead key is too long"
LABEL="com.flywheel.lead.${DAEMON_KEY}"
TARGET="gui/$(id -u)/${LABEL}"

if [ -n "$TEST_ROOT" ]; then
	case "$TEST_ROOT" in
		/tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) ;;
		*) fail 10 "test root is outside an allowed temporary directory" ;;
	esac
	[ -d "$TEST_ROOT" ] && [ ! -L "$TEST_ROOT" ] || fail 10 "test root is unsafe"
	HOME_ROOT="$TEST_ROOT/home"
	PROJECTS_FILE="$TEST_ROOT/projects.json"
	MANIFEST_FILE="$TEST_ROOT/manifest.json"
	PLIST_FILE="$TEST_ROOT/plist"
	HEARTBEAT_FILE="$TEST_ROOT/heartbeat.json"
	OBSERVED_FILE="$TEST_ROOT/observed.json"
	RECEIPT_FILE="$TEST_ROOT/recovery-receipts.jsonl"
	LAUNCHCTL_BIN="${FLYWHEEL_CODEX_RESIDENCY_LAUNCHCTL_BIN:-}"
	PS_BIN="${FLYWHEEL_CODEX_RESIDENCY_PS_BIN:-}"
	BOUNDED_RUN_BIN="${FLYWHEEL_CODEX_RESIDENCY_BOUNDED_RUN_BIN:-}"
	for test_bin in "$LAUNCHCTL_BIN" "$PS_BIN" "$BOUNDED_RUN_BIN"; do
		case "$test_bin" in "$TEST_ROOT"/*) ;; *) fail 10 "test tool escaped test root" ;; esac
		[ -x "$test_bin" ] && [ ! -L "$test_bin" ] || fail 10 "test tool is unsafe"
	done
else
	HOME_ROOT="$HOME"
	PROJECTS_FILE="$HOME_ROOT/.flywheel/projects.json"
	MANIFEST_FILE="$HOME_ROOT/.flywheel/manifests/${DAEMON_KEY}.json"
	PLIST_FILE="$HOME_ROOT/Library/LaunchAgents/${LABEL}.plist"
	HEARTBEAT_FILE="$HOME_ROOT/.flywheel/state/codex-lead/${LEAD_ID}/brain/heartbeat.json"
	OBSERVED_FILE="$HOME_ROOT/.flywheel/state/codex-lead/${LEAD_ID}/brain/patrol-observed-generation.json"
	RECEIPT_FILE="$HOME_ROOT/.flywheel/state/codex-lead/${LEAD_ID}/brain/recovery-receipts.jsonl"
	LAUNCHCTL_BIN="/bin/launchctl"
	PS_BIN="/bin/ps"
	BOUNDED_RUN_BIN="$SCRIPT_DIR/lib/bounded-run.sh"
fi

for tool in jq python3 shasum; do
	command -v "$tool" >/dev/null 2>&1 || fail 10 "required tool is unavailable: $tool"
done
[ -r "$SCRIPT_DIR/lib/lead-restart-lifecycle.sh" ] || fail 10 "restart authority library is unavailable"
# shellcheck source=lib/lead-restart-lifecycle.sh
source "$SCRIPT_DIR/lib/lead-restart-lifecycle.sh"

load_authority() {
	lead_restart_validate_authority \
		"$MANIFEST_FILE" "$PLIST_FILE" "$PROJECTS_FILE" "$LABEL" || return 1
	[ "$LEAD_RESTART_BACKEND" = codex-app-server ] \
		&& [ "$LEAD_RESTART_PROJECT" = "$PROJECT" ] \
		&& [ "$LEAD_RESTART_LEAD_ID" = "$LEAD_ID" ] \
		&& [ "$LEAD_RESTART_LABEL" = "$LABEL" ] || return 1
	local plist_wrapper
	plist_wrapper="$(_lead_restart_plist_json "$PLIST_FILE" | jq -er '.argv[1]')" || return 1
	WRAPPER="${plist_wrapper##*/}"
	[ "$plist_wrapper" = "$HOME_ROOT/.flywheel/bin/$WRAPPER" ] || return 1
	case "$WRAPPER" in
		flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh)
			EXPECTED_CODEX_HOME="$HOME_ROOT/.codex-mufasa"
			;;
		flywheel-codex-lead-wrapper-codex-infra-bot.sh)
			EXPECTED_CODEX_HOME="$HOME_ROOT/.codex-infra-bot"
			;;
		flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh)
			EXPECTED_CODEX_HOME="$HOME_ROOT/.flywheel/raya/codex-home"
			;;
		*) return 1 ;;
	esac
	jq -e --arg project "$PROJECT" --arg lead "$LEAD_ID" '
		[.[] | select(.projectName == $project) | (.leads // [])[] |
		 select(.agentId == $lead)] as $matches |
		($matches | length) == 1 and
		$matches[0].codexResidencyPatrol == true and
		$matches[0].backend == "codex-app-server" and
		$matches[0].canSpawnRunners == false and
		(($matches[0].companion // false) == true or
		 ($matches[0].codexProfile | type) == "string")
	' "$PROJECTS_FILE" >/dev/null 2>&1 || return 1
}

launchd_pid() {
	local out pid count
	out="$($LAUNCHCTL_BIN print "$TARGET" 2>/dev/null)" || return 1
	count="$(printf '%s\n' "$out" | grep -c '^[[:space:]]*pid = [0-9][0-9]*[[:space:]]*$' || true)"
	[ "$count" -eq 1 ] || return 1
	pid="$(printf '%s\n' "$out" | awk '/^[[:space:]]*pid = [0-9]+[[:space:]]*$/ {print $3}')"
	case "$pid" in ''|*[!0-9]*|0) return 1 ;; esac
	printf '%s\n' "$pid"
}

capture_process() {
	local pid lstart command_line environment_line evidence started_at_ms
	pid="$(launchd_pid)" || return 1
	lstart="$(LC_ALL=C "$PS_BIN" -p "$pid" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')" || return 1
	[ -n "$lstart" ] && [ "${#lstart}" -le 128 ] || return 1
	command_line="$(LC_ALL=C "$PS_BIN" -p "$pid" -o command= 2>/dev/null)" || return 1
	[ -n "$command_line" ] && [ "${#command_line}" -le 65536 ] || return 1
	environment_line="$(LC_ALL=C "$PS_BIN" eww -p "$pid" -o command= 2>/dev/null)" || return 1
	[ -n "$environment_line" ] && [ "${#environment_line}" -le 65536 ] || return 1
	evidence="$(python3 - "$command_line" "$EXPECTED_CODEX_HOME" "$RUNTIME_SUFFIX" 3<<<"$environment_line" <<'PY'
import json, os, shlex, sys
tokens = shlex.split(sys.argv[1])
expected_home = sys.argv[2]
runtime_suffix = sys.argv[3]
environment = os.fdopen(3).read()
if f"CODEX_HOME={expected_home}" not in environment.split():
    raise SystemExit(1)
indices = [i for i, token in enumerate(tokens) if token.endswith(runtime_suffix)]
if len(indices) != 1 or indices[0] == 0:
    raise SystemExit(1)
runtime_i = indices[0]
node = tokens[runtime_i - 1]
if os.path.basename(node) != "node":
    raise SystemExit(1)
print(json.dumps({"argv": [node, tokens[runtime_i]], "codexHome": expected_home}, separators=(",", ":")))
PY
	)" || return 1
	started_at_ms="$(python3 - "$lstart" <<'PY'
from datetime import datetime
import sys
try:
    value = datetime.strptime(sys.argv[1], "%a %b %d %H:%M:%S %Y")
except ValueError:
    raise SystemExit(1)
print(int(value.timestamp() * 1000))
PY
	)" || return 1
	jq -cn --argjson pid "$pid" --arg lstart "$lstart" \
		--argjson startedAtMs "$started_at_ms" --argjson evidence "$evidence" \
		--arg label "$LABEL" --arg wrapper "$WRAPPER" '
		{state:"exact",pid:$pid,lstart:$lstart,startedAtMs:$startedAtMs,
		 argv:$evidence.argv,codexHome:$evidence.codexHome,label:$label,wrapper:$wrapper}'
}

read_expected_generation_evidence() {
	local expected_pid="$1" expected_lstart="$2" expected_generation="$3" expected_carrier="$4"
	if [ -f "$HEARTBEAT_FILE" ] && [ ! -L "$HEARTBEAT_FILE" ] \
		&& [ "$(wc -c < "$HEARTBEAT_FILE")" -le 65536 ] \
		&& jq -e --argjson pid "$expected_pid" --arg generation "$expected_generation" \
			--arg carrier "$expected_carrier" '
		select(type == "object" and .v == 1 and .processPid == $pid
		 and .generationId == $generation and .carrierInstanceId == $carrier
		 and (.threadId | type == "string" and length > 0 and length <= 256)
		 and (.updatedAt | type == "string" and length > 0 and length <= 64))' \
			"$HEARTBEAT_FILE" >/dev/null 2>&1; then
		return 0
	fi
	[ -f "$OBSERVED_FILE" ] && [ ! -L "$OBSERVED_FILE" ] || return 1
	[ "$(wc -c < "$OBSERVED_FILE")" -le 65536 ] || return 1
	jq -e --argjson pid "$expected_pid" --arg lstart "$expected_lstart" \
		--arg generation "$expected_generation" --arg carrier "$expected_carrier" '
		select(type == "object" and .pid == $pid and .lstart == $lstart
		 and .generationId == $generation and .carrierInstanceId == $carrier
		 and (.observedAt | type == "string" and length > 0 and length <= 64))' \
		"$OBSERVED_FILE" >/dev/null 2>&1
}

write_receipt() {
	local old="$1" generation="$2" carrier="$3" parent line
	parent="$(dirname "$RECEIPT_FILE")"
	[ ! -L "$parent" ] || return 1
	mkdir -p "$parent" || return 1
	[ -d "$parent" ] && [ ! -L "$parent" ] || return 1
	if [ -e "$RECEIPT_FILE" ] || [ -L "$RECEIPT_FILE" ]; then
		[ -f "$RECEIPT_FILE" ] && [ ! -L "$RECEIPT_FILE" ] || return 1
	fi
	line="$(jq -cn --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg label "$LABEL" \
		--argjson old "$old" --arg generation "$generation" --arg carrier "$carrier" \
		--arg manifest "$LEAD_RESTART_MANIFEST_DIGEST" --arg plist "$LEAD_RESTART_PLIST_DIGEST" \
		--arg projects "$LEAD_RESTART_PROJECTS_DIGEST" '
		{v:1,at:$at,phase:"pre_mutation",label:$label,
		 old:{pid:$old.pid,lstart:$old.lstart},generationId:$generation,
		 carrierInstanceId:$carrier,authority:{manifest:$manifest,plist:$plist,projects:$projects}}')" || return 1
	(umask 077; printf '%s\n' "$line" >> "$RECEIPT_FILE") || return 1
	chmod 600 "$RECEIPT_FILE" || return 1
	python3 - "$RECEIPT_FILE" "$parent" <<'PY' >/dev/null 2>&1
import os, sys
for path in sys.argv[1:]:
    flags = os.O_RDONLY | (getattr(os, "O_DIRECTORY", 0) if os.path.isdir(path) else 0)
    fd = os.open(path, flags)
    try: os.fsync(fd)
    finally: os.close(fd)
PY
}

probe_mode() {
	load_authority || fail 20 "resident Codex Lead projects/manifest/plist authority failed"
	local snapshot
	snapshot="$(capture_process)" || fail 21 "exact resident Codex Lead process evidence failed"
	printf '%s\n' "$snapshot"
}

recover_mode() {
	local expected_pid="$1" expected_lstart="$2" expected_generation="$3" expected_carrier="$4"
	local old second third new attempt verify_attempts verify_interval
	load_authority || fail 20 "resident Codex Lead projects/manifest/plist authority failed"
	old="$(capture_process)" || fail 21 "exact resident Codex Lead process evidence failed"
	[ "$(jq -r '.pid' <<<"$old")" = "$expected_pid" ] \
		&& [ "$(jq -r '.lstart' <<<"$old")" = "$expected_lstart" ] \
		|| fail 22 "expected pid+lstart does not match the live resident Codex Lead job"
	read_expected_generation_evidence "$expected_pid" "$expected_lstart" \
		"$expected_generation" "$expected_carrier" \
		|| fail 23 "expected generation heartbeat does not match the live resident Codex Lead job"

	lead_restart_authority_unchanged || fail 24 "authority changed before recovery recheck"
	second="$(capture_process)" || fail 24 "process identity failed recovery recheck"
	lead_restart_authority_unchanged || fail 24 "authority changed during process recheck"
	[ "$second" = "$old" ] || fail 24 "pid+lstart+argv+CODEX_HOME changed during recheck"
	write_receipt "$old" "$expected_generation" "$expected_carrier" \
		|| fail 25 "durable pre-mutation receipt write failed"

	lead_restart_authority_unchanged || fail 24 "authority changed after recovery receipt"
	third="$(capture_process)" || fail 24 "process identity failed final mutation check"
	[ "$third" = "$old" ] || fail 24 "pid+lstart+argv+CODEX_HOME changed before mutation"
	"$BOUNDED_RUN_BIN" 30 "$LAUNCHCTL_BIN" kickstart -k "$TARGET" >/dev/null 2>&1 \
		|| fail 26 "bounded exact-label launchctl kickstart failed"

	verify_attempts="${CODEX_LEAD_RESIDENCY_VERIFY_ATTEMPTS:-20}"
	verify_interval="${CODEX_LEAD_RESIDENCY_VERIFY_INTERVAL_SECONDS:-1}"
	case "$verify_attempts" in ''|*[!0-9]*|0) verify_attempts=20 ;; esac
	case "$verify_interval" in ''|*[!0-9]*) verify_interval=1 ;; esac
	for ((attempt=1; attempt<=verify_attempts; attempt++)); do
		new="$(capture_process 2>/dev/null || true)"
		if [ -n "$new" ] \
			&& { [ "$(jq -r '.pid' <<<"$new")" != "$expected_pid" ] \
				|| [ "$(jq -r '.lstart' <<<"$new")" != "$expected_lstart" ]; } \
			&& [ -f "$HEARTBEAT_FILE" ] && [ ! -L "$HEARTBEAT_FILE" ] \
			&& jq -e --argjson pid "$(jq -r '.pid' <<<"$new")" \
				--arg generation "$expected_generation" --arg carrier "$expected_carrier" '
				.v == 1 and .processPid == $pid
				and (.generationId | type == "string" and length > 0 and . != $generation)
				and (.carrierInstanceId | type == "string" and length > 0 and . != $carrier)
				and (.updatedAt | type == "string" and length > 0)' \
				"$HEARTBEAT_FILE" >/dev/null 2>&1; then
			jq -cn --arg detail converged --argjson pid "$(jq -r '.pid' <<<"$new")" \
				'{ok:true,detail:$detail,newPid:$pid}'
			return 0
		fi
		[ "$attempt" -lt "$verify_attempts" ] && sleep "$verify_interval"
	done
	fail 27 "replacement did not produce a new pid/lstart and generation heartbeat"
}

mode="${1:-}"
case "$mode" in
	--probe)
		[ "$#" -eq 1 ] || fail 10 "--probe accepts no additional arguments"
		probe_mode
		;;
	--recover)
		shift
		expected_pid=""; expected_lstart=""; expected_generation=""; expected_carrier=""
		while [ "$#" -gt 0 ]; do
			case "$1" in
				--expected-pid) expected_pid="${2:-}"; shift 2 ;;
				--expected-lstart) expected_lstart="${2:-}"; shift 2 ;;
				--expected-generation) expected_generation="${2:-}"; shift 2 ;;
				--expected-carrier-instance) expected_carrier="${2:-}"; shift 2 ;;
				*) fail 10 "unknown recovery argument" ;;
			esac
		done
		case "$expected_pid" in ''|*[!0-9]*|0) fail 10 "expected pid is invalid" ;; esac
		[ -n "$expected_lstart" ] && [ "${#expected_lstart}" -le 128 ] \
			&& [[ "$expected_lstart" != *$'\n'* ]] || fail 10 "expected lstart is invalid"
		for bounded_id in "$expected_generation" "$expected_carrier"; do
			[ -n "$bounded_id" ] && [ "${#bounded_id}" -le 256 ] \
				&& [[ "$bounded_id" =~ ^[A-Za-z0-9._:-]+$ ]] || fail 10 "expected generation identity is invalid"
		done
		recover_mode "$expected_pid" "$expected_lstart" "$expected_generation" "$expected_carrier"
		;;
	*) fail 10 "usage: resident-codex-lead-recover.sh --project <name> --lead <id> --probe | --recover <fixed expected tuple>" ;;
esac

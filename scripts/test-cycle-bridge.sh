#!/usr/bin/env bash
# Cycle only the Bridge process tree inside an existing 529 QA slot.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
# shellcheck source=lib/qa-slot-bridge.sh
source "${SCRIPT_DIR}/lib/qa-slot-bridge.sh"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ $# -eq 1 && "$1" =~ ^[1-9][0-9]*$ ]] \
	|| die "usage: scripts/test-cycle-bridge.sh <slot>"
SLOT="$1"
SLOT_DIR="/tmp/flywheel-test-slot-${SLOT}"
SPEC="${SLOT_DIR}/bridge-launch.json"
BRIDGE_PID_FILE="${SLOT_DIR}/bridge.pid"
CYCLE_LOCK="${SLOT_DIR}/.bridge-cycle.lock"
CYCLE_LOCK_OWNED=0
CYCLE_GUARD_OWNED=0
SENTINEL_PUBLICATION_STARTED=0
SUCCESS=0
OLD_PID=""
NEW_PID=""
NEW_START=""
NEW_GROUP_READY=0
OWNERSHIP_PID_FILES=()

release_cycle_lock() {
	local holder
	if (( CYCLE_LOCK_OWNED == 1 )) \
		&& [[ -d "$CYCLE_LOCK" && ! -L "$CYCLE_LOCK" ]]; then
		holder="$(cat "$CYCLE_LOCK/pid" 2>/dev/null || true)"
		if [[ -z "$holder" || "$holder" == "$$" ]]; then
			rm -rf "$CYCLE_LOCK"
		fi
	fi
	CYCLE_LOCK_OWNED=0
	if (( CYCLE_GUARD_OWNED == 1 )); then
		qa_slot_bridge_guard_release
		CYCLE_GUARD_OWNED=0
	fi
}

locks_match_live_bridge() {
	local pid path
	pid="$(cat "$BRIDGE_PID_FILE" 2>/dev/null || true)"
	[[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
	kill -0 "$pid" 2>/dev/null || return 1
	for path in "${OWNERSHIP_PID_FILES[@]}"; do
		[[ "$(cat "$path" 2>/dev/null || true)" == "$pid" ]] || return 1
	done
}

on_exit() {
	local rc=$? path
	if (( SUCCESS == 0 )) && locks_match_live_bridge; then
		release_cycle_lock
		exit "$rc"
	fi
	if (( SUCCESS == 0 )) && [[ "$NEW_PID" =~ ^[1-9][0-9]*$ ]]; then
		if ! terminate_new_after_failure; then
			echo "ERROR: failed to terminate replacement Bridge after cycle failure" >&2
		fi
	fi
	if (( SENTINEL_PUBLICATION_STARTED == 1 && SUCCESS == 0 )) && ! locks_match_live_bridge; then
		# Only the process that still owns this exact cycle mutex may preserve
		# failure state. A concurrent explicit teardown/redeploy must never be
		# overwritten by a stale trap.
		if [[ "$(cat "$CYCLE_LOCK/pid" 2>/dev/null || true)" == "$$" ]]; then
			for path in "${OWNERSHIP_PID_FILES[@]}"; do
				if [[ ! -d "$(dirname "$path")" || -L "$(dirname "$path")" ]] \
					|| ! qa_slot_bridge_atomic_write "$path" cycle-failed; then
					echo "ERROR: failed to preserve cycle-failed ownership at ${path}" >&2
				fi
			done
		fi
	fi
	release_cycle_lock
	exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

acquire_cycle_lock() {
	local holder guard_rc=0
	qa_slot_bridge_guard_acquire "$SLOT" || guard_rc=$?
	if (( guard_rc == 1 )); then
		holder="$(cat "$CYCLE_LOCK/pid" 2>/dev/null || true)"
		if [[ "$holder" =~ ^[1-9][0-9]*$ ]] && kill -0 "$holder" 2>/dev/null; then
			die "slot ${SLOT} already has a live Bridge cycle (pid ${holder})"
		fi
		die "slot ${SLOT} already has a Bridge cycle in progress"
	fi
	(( guard_rc == 0 )) || die "cannot acquire Bridge cycle serialization guard"
	CYCLE_GUARD_OWNED=1
	holder="$(cat "$CYCLE_LOCK/pid" 2>/dev/null || true)"
	if [[ "$holder" =~ ^[1-9][0-9]*$ ]] && kill -0 "$holder" 2>/dev/null; then
		die "slot ${SLOT} already has a live Bridge cycle (pid ${holder})"
	fi
	rm -rf "$CYCLE_LOCK"
	CYCLE_LOCK_OWNED=1
	mkdir "$CYCLE_LOCK" || die "cannot acquire Bridge cycle lock"
	printf '%s\n' "$$" > "$CYCLE_LOCK/pid"
}

strict_listeners() {
	local port="${1:?port required}" output rc err_file="${CYCLE_LOCK}/lsof.err"
	command -v lsof >/dev/null 2>&1 || return 70
	set +e
	output="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>"$err_file")"
	rc=$?
	set -e
	if (( rc != 0 )); then
		[[ -z "$output" && ! -s "$err_file" ]] || return 71
		return 0
	fi
	printf '%s\n' "$output" | awk '/^[1-9][0-9]*$/ && !seen[$0]++'
}

one_listener() {
	local port="${1:?port required}" output count
	output="$(strict_listeners "$port")" || return 1
	count="$(printf '%s\n' "$output" | awk 'NF { n++ } END { print n+0 }')"
	[[ "$count" == "1" ]] || return 1
	printf '%s\n' "$output"
}

health_ok() {
	curl -q -fsS --noproxy '*' --max-time 5 "${1:?bridge url required}/health" >/dev/null 2>&1
}

wait_all_gone() {
	local timeout="${1:?timeout required}" pid iteration still_live
	shift
	for (( iteration=0; iteration<timeout*10; iteration++ )); do
		still_live=0
		for pid in "$@"; do kill -0 "$pid" 2>/dev/null && still_live=1; done
		(( still_live == 0 )) && return 0
		sleep 0.1
	done
	return 1
}

bind_probe() {
	local host="${1:?host required}" port="${2:?port required}" node_bin
	node_bin="$(command -v node)" || return 1
	"$node_bin" - "$host" "$port" <<'NODE'
const net = require("node:net");
const [host, rawPort] = process.argv.slice(2);
const server = net.createServer();
server.once("error", () => process.exit(1));
server.listen({ host, port: Number(rawPort), exclusive: true }, () => {
  server.close((error) => process.exit(error ? 1 : 0));
});
NODE
}

wait_isolated_new_group() {
	local iteration
	for (( iteration=0; iteration<50; iteration++ )); do
		if qa_slot_bridge_is_isolated_group "$NEW_PID"; then
			NEW_GROUP_READY=1
			return 0
		fi
		kill -0 "$NEW_PID" 2>/dev/null || return 1
		sleep 0.02
	done
	return 1
}

wait_new_group_gone() {
	local iteration
	for (( iteration=0; iteration<TERM_TIMEOUT*10; iteration++ )); do
		kill -0 -- "-$NEW_PID" 2>/dev/null || return 0
		sleep 0.1
	done
	return 1
}

terminate_new_after_failure() {
	local listener_rows="" listener_rc=0 listener_count=0 listener=""
	local released
	set +e
	listener_rows="$(strict_listeners "$PORT")"
	listener_rc=$?
	set -e
	if (( listener_rc != 0 )); then
		echo "ERROR: replacement listener census failed; using launcher fallback" >&2
	else
		listener_count="$(printf '%s\n' "$listener_rows" | awk 'NF { n++ } END { print n+0 }')"
		if [[ "$listener_count" == "1" ]]; then
			listener="$listener_rows"
			read_chain "$listener" "$NEW_PID" \
				|| echo "ERROR: replacement listener ancestry failed; using isolated process group" >&2
		elif (( listener_count > 1 )); then
			echo "ERROR: replacement listener census was ambiguous; using isolated process group" >&2
		fi
	fi
	if (( NEW_GROUP_READY == 0 )) && qa_slot_bridge_is_isolated_group "$NEW_PID"; then
		NEW_GROUP_READY=1
	fi
	if (( NEW_GROUP_READY == 0 )); then
		echo "ERROR: replacement process group was never proven isolated" >&2
		if kill -0 "$NEW_PID" 2>/dev/null; then
			if [[ -z "$NEW_START" ]] \
				|| ! qa_slot_bridge_pid_matches "$NEW_PID" "$NEW_START"; then
				echo "ERROR: replacement Bridge identity changed before launcher fallback TERM" >&2
				return 1
			fi
			if ! kill -TERM "$NEW_PID"; then
				echo "ERROR: replacement launcher fallback TERM failed" >&2
			fi
		fi
		return 1
	fi
	if kill -0 -- "-$NEW_PID" 2>/dev/null; then
		if [[ -z "$NEW_START" ]] \
			|| ! qa_slot_bridge_pid_matches "$NEW_PID" "$NEW_START"; then
			echo "ERROR: replacement Bridge identity changed before process-group TERM" >&2
			return 1
		fi
		kill -TERM -- "-$NEW_PID" || return 1
	fi
	wait_new_group_gone || return 1
	released="$(strict_listeners "$PORT")" || {
		echo "ERROR: post-cleanup replacement listener census failed" >&2
		return 1
	}
	[[ -z "$released" ]] || {
		echo "ERROR: replacement listener survived TERM cleanup" >&2
		return 1
	}
	bind_probe "$HOST" "$PORT" || {
		echo "ERROR: replacement port remained bound after TERM cleanup" >&2
		return 1
	}
}

read_chain() {
	local listener="${1:?listener required}" launcher="${2:?launcher required}"
	CHAIN_PIDS=()
	CHAIN_STARTS=()
	while IFS=$'\t' read -r pid start; do
		[[ -n "$pid" && -n "$start" ]] || continue
		CHAIN_PIDS+=("$pid")
		CHAIN_STARTS+=("$start")
	done < <(qa_slot_bridge_collect_chain "$listener" "$launcher" 64)
	(( ${#CHAIN_PIDS[@]} > 0 )) || return 1
	[[ "${CHAIN_PIDS[${#CHAIN_PIDS[@]}-1]}" == "$launcher" ]]
}

old_bridge_recoverable() {
	local listener index
	for (( index=0; index<${#OLD_CHAIN_PIDS[@]}; index++ )); do
		qa_slot_bridge_pid_matches \
			"${OLD_CHAIN_PIDS[$index]}" "${OLD_CHAIN_STARTS[$index]}" || return 1
	done
	listener="$(one_listener "$PORT")" || return 1
	read_chain "$listener" "$OLD_PID" || return 1
	(( ${#CHAIN_PIDS[@]} == ${#OLD_CHAIN_PIDS[@]} )) || return 1
	for (( index=0; index<${#OLD_CHAIN_PIDS[@]}; index++ )); do
		[[ "${CHAIN_PIDS[$index]}" == "${OLD_CHAIN_PIDS[$index]}" \
			&& "${CHAIN_STARTS[$index]}" == "${OLD_CHAIN_STARTS[$index]}" ]] || return 1
	done
	health_ok "$BRIDGE_URL"
}

[[ -d "$SLOT_DIR" && ! -L "$SLOT_DIR" && "$(qa_slot_bridge_mode "$SLOT_DIR")" == "700" ]] \
	|| die "slot directory must be a mode-0700 regular directory"
acquire_cycle_lock
[[ -f "$SPEC" && ! -L "$SPEC" && "$(qa_slot_bridge_mode "$SPEC")" == "600" ]] \
	|| die "Bridge launch spec is missing or unsafe"
qa_slot_bridge_validate_spec "$SPEC" "$SLOT" "$REPO_ROOT" \
	|| die "Bridge launch spec is invalid or unsafe for slot ${SLOT}"

PORT="$(jq -r '.port' "$SPEC")"
BRIDGE_URL="$(jq -r '.bridgeUrl' "$SPEC")"
HOST="$(jq -r '.host' "$SPEC")"
LOG_PATH="$(jq -r '.logPath' "$SPEC")"
OLD_PID="$(cat "$BRIDGE_PID_FILE" 2>/dev/null || true)"
[[ "$OLD_PID" =~ ^[1-9][0-9]*$ ]] && kill -0 "$OLD_PID" 2>/dev/null \
	|| die "bridge.pid is not a live numeric PID"
while IFS= read -r -d '' path; do OWNERSHIP_PID_FILES+=("$path"); done \
	< <(jq -j '.ownershipPidFiles[] | ., "\u0000"' "$SPEC")
(( ${#OWNERSHIP_PID_FILES[@]} > 0 )) || die "launch spec has no ownership PID files"
for path in "${OWNERSHIP_PID_FILES[@]}"; do
	[[ -f "$path" && ! -L "$path" && "$(cat "$path")" == "$OLD_PID" ]] \
		|| die "ownership PID mismatch before cycle"
done
health_ok "$BRIDGE_URL" || die "old Bridge health control failed"
OLD_LISTENER="$(one_listener "$PORT")" || die "expected exactly one old Bridge listener"
read_chain "$OLD_LISTENER" "$OLD_PID" || die "old listener ancestry does not reach bridge.pid"
OLD_CHAIN_PIDS=("${CHAIN_PIDS[@]}")
OLD_CHAIN_STARTS=("${CHAIN_STARTS[@]}")

TERM_TIMEOUT="$(qa_slot_bridge_timeout "${FLYWHEEL_QA_BRIDGE_TERM_TIMEOUT_SEC:-}" 30 300)" \
	|| die "invalid FLYWHEEL_QA_BRIDGE_TERM_TIMEOUT_SEC"
HEALTH_TIMEOUT="$(qa_slot_bridge_timeout "${FLYWHEEL_QA_BRIDGE_HEALTH_TIMEOUT_SEC:-}" 60 300)" \
	|| die "invalid FLYWHEEL_QA_BRIDGE_HEALTH_TIMEOUT_SEC"

SENTINEL_PUBLICATION_STARTED=1
for path in "${OWNERSHIP_PID_FILES[@]}"; do
	qa_slot_bridge_atomic_write "$path" cycle-failed || die "cannot protect ownership lock"
done

# Signal ancestors before descendants so a wrapper exiting from its own TERM
# cannot make an intermediate disappear before it receives the one intended
# signal. Every target is rebound to its measured start identity first.
for (( index=${#OLD_CHAIN_PIDS[@]}-1; index>=0; index-- )); do
	pid="${OLD_CHAIN_PIDS[$index]}"
	if qa_slot_bridge_pid_matches "$pid" "${OLD_CHAIN_STARTS[$index]}"; then
		if ! kill -TERM "$pid"; then
			kill -0 "$pid" 2>/dev/null \
				&& die "failed to SIGTERM old Bridge PID"
		fi
	elif kill -0 "$pid" 2>/dev/null; then
		# A live PID with a different start identity may be a recycled foreign
		# process. Never signal it. A measured member that is already gone is
		# expected when an ancestor (for example tsx) forwards SIGTERM.
		die "old Bridge PID identity changed before TERM"
	fi
done
if ! wait_all_gone "$TERM_TIMEOUT" "${OLD_CHAIN_PIDS[@]}"; then
	if old_bridge_recoverable; then
		for path in "${OWNERSHIP_PID_FILES[@]}"; do qa_slot_bridge_atomic_write "$path" "$OLD_PID"; done
	fi
	die "old Bridge process chain did not exit after SIGTERM"
fi
RELEASED_LISTENERS="$(strict_listeners "$PORT")" \
	|| die "post-TERM listener census failed"
[[ -z "$RELEASED_LISTENERS" ]] || die "old Bridge still owns the port"
bind_probe "$HOST" "$PORT" || die "positive port release bind probe failed"

printf '[test-cycle-bridge] cycle boundary oldPid=%s at=%s\n' "$OLD_PID" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$LOG_PATH"
(
	# The replacement must not inherit the cycle's advisory-lock descriptor;
	# otherwise it would keep teardown/cycle callers excluded for its lifetime.
	exec 6>&-
	qa_slot_bridge_exec_spec "$SPEC" "$REPO_ROOT"
) >> "$LOG_PATH" 2>&1 &
NEW_PID=$!
NEW_START="$(qa_slot_bridge_pid_start "$NEW_PID")" \
	|| die "replacement Bridge start identity could not be recorded"
wait_isolated_new_group || die "replacement Bridge did not establish an isolated process group"
qa_slot_bridge_pid_matches "$NEW_PID" "$NEW_START" \
	|| die "replacement Bridge identity changed while establishing its isolated process group"

NEW_LISTENER=""
for (( iteration=0; iteration<HEALTH_TIMEOUT*10; iteration++ )); do
	if kill -0 "$NEW_PID" 2>/dev/null && health_ok "$BRIDGE_URL"; then
		NEW_LISTENER="$(one_listener "$PORT" 2>/dev/null || true)"
		[[ -n "$NEW_LISTENER" ]] && break
	fi
	sleep 0.1
done
if [[ -z "$NEW_LISTENER" ]]; then
	terminate_new_after_failure \
		|| die "new Bridge did not become healthy and its TERM cleanup timed out"
	die "new Bridge did not become healthy"
fi
read_chain "$NEW_LISTENER" "$NEW_PID" || die "new listener ancestry does not reach new launcher"
ACTUAL_CWD="$(lsof -a -p "$NEW_LISTENER" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
EXPECTED_CWD="$(jq -r '.cwd' "$SPEC")"
[[ -n "$ACTUAL_CWD" && "$(cd "$ACTUAL_CWD" && pwd -P)" == "$EXPECTED_CWD" ]] \
	|| die "new listener cwd does not match launch spec"

qa_slot_bridge_atomic_write "$BRIDGE_PID_FILE" "$NEW_PID" \
	|| die "cannot update bridge.pid"
for path in "${OWNERSHIP_PID_FILES[@]}"; do
	qa_slot_bridge_atomic_write "$path" "$NEW_PID" || die "cannot update ownership PID"
done
[[ "$(cat "$BRIDGE_PID_FILE")" == "$NEW_PID" ]] || die "bridge.pid read-back mismatch"
for path in "${OWNERSHIP_PID_FILES[@]}"; do
	[[ "$(cat "$path")" == "$NEW_PID" ]] || die "ownership PID read-back mismatch"
done
SUCCESS=1
release_cycle_lock
CYCLE_LOCK_OWNED=0

jq -n --argjson slot "$SLOT" --arg bridgeUrl "$BRIDGE_URL" \
	--argjson oldBridgePid "$OLD_PID" --argjson newBridgePid "$NEW_PID" \
	--arg launchSpec "$SPEC" \
	'{slot:$slot,bridgeUrl:$bridgeUrl,oldBridgePid:$oldBridgePid,newBridgePid:$newBridgePid,launchSpec:$launchSpec}'

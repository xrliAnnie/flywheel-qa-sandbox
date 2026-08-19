#!/usr/bin/env bash
# FLY-1571: best-effort Runner turn-end reporter.
# FLY-1774: Codex notify also rings the durable mailbox doorbell after the
# reporter leg finishes. Claude Stop/StopFailure remain reporter-only.
set -u

runner_stop_log_lib="${FLYWHEEL_LOG_LIB:-}"
if [ -z "$runner_stop_log_lib" ] && [ -n "${FLYWHEEL_DIR:-}" ]; then
  runner_stop_log_lib="$FLYWHEEL_DIR/scripts/lib/flywheel-log.sh"
fi
if [ -z "$runner_stop_log_lib" ] && [ -n "${FLYWHEEL_COMM_CLI:-}" ]; then
  runner_stop_log_lib="$(cd "$(dirname "$FLYWHEEL_COMM_CLI")/../../.." 2>/dev/null && pwd)/scripts/lib/flywheel-log.sh"
fi
if [ -n "$runner_stop_log_lib" ] && [ -r "$runner_stop_log_lib" ]; then
  # shellcheck source=scripts/lib/flywheel-log.sh
  source "$runner_stop_log_lib"
else
  flywheel_log_rotate_if_needed() { return 0; }
fi

log_dir="${HOME:-/tmp}/.flywheel/logs"
log_file="${log_dir}/runner-stop-notify.log"
if mkdir -p "$log_dir" 2>/dev/null && touch "$log_file" 2>/dev/null; then
  flywheel_log_rotate_if_needed "$log_file"
  touch "$log_file" 2>/dev/null || true
  exec >>"$log_file" 2>&1
else
  exec >/dev/null 2>&1
fi

run_supervised_leg() {
  "$@" &
  local child_pid=$!
  local child_pgid supervisor_pgid parent_pgid watchdog_pid watchdog_pgid
  child_pgid="$(ps -o pgid= -p "$child_pid" 2>/dev/null | tr -d ' ')"
  supervisor_pgid="$(ps -o pgid= -p "${BASHPID:-$$}" 2>/dev/null | tr -d ' ')"
  parent_pgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
  (
    sleep 12
    if kill -0 "$child_pid" 2>/dev/null; then
      if [ "$child_pgid" = "$child_pid" ] && [ "$child_pgid" != "$supervisor_pgid" ] && [ "$child_pgid" != "$parent_pgid" ]; then
        kill -TERM -- "-$child_pgid" 2>/dev/null || kill -TERM "$child_pid" 2>/dev/null || true
      else
        kill -TERM "$child_pid" 2>/dev/null || true
      fi
      sleep 2
      if [ "$child_pgid" = "$child_pid" ] && [ "$child_pgid" != "$supervisor_pgid" ] && [ "$child_pgid" != "$parent_pgid" ]; then
        kill -KILL -- "-$child_pgid" 2>/dev/null || kill -KILL "$child_pid" 2>/dev/null || true
      else
        kill -KILL "$child_pid" 2>/dev/null || true
      fi
    fi
  ) &
  watchdog_pid=$!
  watchdog_pgid="$(ps -o pgid= -p "$watchdog_pid" 2>/dev/null | tr -d ' ')"
  wait "$child_pid" 2>/dev/null || true
  if [ "$watchdog_pgid" = "$watchdog_pid" ] && [ "$watchdog_pgid" != "$supervisor_pgid" ] && [ "$watchdog_pgid" != "$parent_pgid" ]; then
    kill -TERM -- "-$watchdog_pgid" 2>/dev/null || kill -TERM "$watchdog_pid" 2>/dev/null || true
  else
    kill -TERM "$watchdog_pid" 2>/dev/null || true
  fi
  wait "$watchdog_pid" 2>/dev/null || true
  return 0
}

main() {
  local exec_id="${FLYWHEEL_EXEC_ID:-}"
  [ -n "$exec_id" ] || return 0

  local source payload transcript session_id error_json last_message turn_id
  transcript=""
  session_id=""
  error_json=""
  last_message=""
  turn_id=""

  if [ "${1:-}" = "--codex" ]; then
    [ "$#" -ge 2 ] || return 0
    payload="${!#}"
    [ "$(jq -r 'if .type == "agent-turn-complete" and .client == "codex-tui" then "yes" else "no" end' <<<"$payload" 2>/dev/null)" = "yes" ] || return 0
    source="codex-notify"
    turn_id="$(jq -r '."turn-id" // empty' <<<"$payload" 2>/dev/null)"
    [ -n "$turn_id" ] || return 0
    last_message="$(jq -r '."last-assistant-message" // empty' <<<"$payload" 2>/dev/null)"
  else
    payload="$(cat)"
    [ "$(jq -r 'if type == "object" then "yes" else "no" end' <<<"$payload" 2>/dev/null)" = "yes" ] || return 0
    [ "$(jq -r '.stop_hook_active // false' <<<"$payload" 2>/dev/null)" != "true" ] || return 0
    case "$(jq -r '.hook_event_name // empty' <<<"$payload" 2>/dev/null)" in
      Stop)
        source="claude-stop"
        ;;
      StopFailure)
        source="claude-stop-failure"
        error_json="$(jq -c '{error:(.error // "unknown"),errorDetails:(.error_details // null),lastAssistantMessage:(.last_assistant_message // null)}' <<<"$payload" 2>/dev/null)"
        ;;
      *)
        return 0
        ;;
    esac
    transcript="$(jq -r '.transcript_path // empty' <<<"$payload" 2>/dev/null)"
    session_id="$(jq -r '.session_id // empty' <<<"$payload" 2>/dev/null)"
  fi

  local cli="${FLYWHEEL_COMM_CLI:-}"
  [ -n "$cli" ] && [ -f "$cli" ] || {
    echo "[runner-stop-notify] FLYWHEEL_COMM_CLI unavailable"
    return 0
  }

  local ingress state_dir prev_ingress
  ingress="$(python3 -c 'from datetime import datetime, timezone; print(datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))' 2>/dev/null)"
  [ -n "$ingress" ] || return 0
  state_dir="${FLYWHEEL_RUNNER_STATE_DIR:-${HOME:-/tmp}/.flywheel/runner-state/${exec_id}}"
  mkdir -p "$state_dir" 2>/dev/null || true

  # Foreground, crash-safe turn-boundary handoff. Codex waits for notify to
  # return, so this compare-and-update is the ordering authority; the DB work
  # below is detached and may finish after a later turn begins.
  prev_ingress="$(python3 - "$state_dir" "$exec_id" "$ingress" <<'PY'
import datetime
import fcntl
import json
import os
import sys
import time

state_dir, execution_id, ingress = sys.argv[1:]
os.makedirs(state_dir, exist_ok=True)
lock_path = os.path.join(state_dir, "turn-boundary.lock")
ledger_path = os.path.join(state_dir, "turn-boundary.json")

def parse_iso(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        return None
    try:
        return datetime.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return None

current = parse_iso(ingress)
if current is None:
    raise SystemExit(0)
with open(lock_path, "a+") as lock:
    deadline = time.monotonic() + 0.2
    while True:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise SystemExit(0)
            time.sleep(0.01)
    previous = None
    try:
        with open(ledger_path) as handle:
            value = json.load(handle)
        if value.get("v") == 1 and value.get("executionId") == execution_id:
            candidate = value.get("lastIngressTs")
            if parse_iso(candidate) is not None:
                previous = candidate
    except (OSError, ValueError, AttributeError):
        pass
    if previous is None or current > parse_iso(previous):
        temp = f"{ledger_path}.{os.getpid()}.tmp"
        with open(temp, "w") as handle:
            json.dump({"v": 1, "executionId": execution_id, "lastIngressTs": ingress}, handle)
            handle.write("\n")
        os.replace(temp, ledger_path)
        if previous is not None:
            print(previous)
PY
)"

  local -a emitter=(
    node "$cli" runner-stopped
    --exec-id "$exec_id"
    --source "$source"
    --ingress-ts "$ingress"
  )
  [ -z "${FLYWHEEL_COMM_DB:-}" ] || emitter+=(--db "$FLYWHEEL_COMM_DB")
  [ -z "${FLYWHEEL_ISSUE_ID:-}" ] || emitter+=(--issue-id "$FLYWHEEL_ISSUE_ID")
  [ -z "$prev_ingress" ] || emitter+=(--prev-ingress "$prev_ingress")
  [ -z "$transcript" ] || emitter+=(--transcript "$transcript")
  [ -z "$session_id" ] || emitter+=(--session-id "$session_id")
  [ -z "$error_json" ] || emitter+=(--error-json "$error_json")
  [ -z "$last_message" ] || emitter+=(--last-message "$last_message")
  [ -z "$turn_id" ] || emitter+=(--turn-id "$turn_id")

  local -a sweep=()
  if [ "$source" = "codex-notify" ]; then
    sweep=(node "$cli" runner-wake-sweep --exec-id "$exec_id")
    [ -z "${FLYWHEEL_COMM_DB:-}" ] || sweep+=(--db "$FLYWHEEL_COMM_DB")
    [ -z "${FLYWHEEL_PROJECT_NAME:-}" ] || sweep+=(--project "$FLYWHEEL_PROJECT_NAME")
  fi

  (
    set -m
    run_supervised_leg "${emitter[@]}"
    if [ "${#sweep[@]}" -gt 0 ]; then
      run_supervised_leg "${sweep[@]}"
    fi
  ) </dev/null &
  return 0
}

main "$@" || true
exit 0

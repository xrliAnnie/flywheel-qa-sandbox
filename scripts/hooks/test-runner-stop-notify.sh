#!/usr/bin/env bash
set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/runner-stop-notify.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fly1571-hook.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  PASS %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check() {
  local name="$1"
  shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}

mkdir -p "$WORK/bin" "$WORK/home" "$WORK/state"
touch "$WORK/flywheel-comm.js"

printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$@" >> "$FLY1571_CAPTURE"' > "$WORK/bin/node"
chmod +x "$WORK/bin/node"

run_hook() {
  local input="$1"
  shift
  local hook_home="${FLY1571_TEST_HOME:-$WORK/home}"
  PATH="$WORK/bin:$PATH" \
  HOME="$hook_home" \
  FLYWHEEL_COMM_CLI="$WORK/flywheel-comm.js" \
  FLYWHEEL_RUNNER_STATE_DIR="$WORK/state" \
  FLY1571_CAPTURE="$WORK/capture" \
  "$HOOK" "$@" <<<"$input" >"$WORK/stdout" 2>"$WORK/stderr"
}

wait_capture() {
  local tries=50
  while [ "$tries" -gt 0 ] && [ ! -s "$WORK/capture" ]; do
    sleep 0.02
    tries=$((tries - 1))
  done
  [ -s "$WORK/capture" ]
}

if [ ! -x "$HOOK" ]; then
  echo "runner-stop-notify.sh is missing or not executable" >&2
  exit 1
fi

unset FLYWHEEL_EXEC_ID || true
run_hook '{}'
check "non-Runner exits silently" test ! -s "$WORK/stdout"
check "non-Runner has no stderr" test ! -s "$WORK/stderr"
check "non-Runner does not invoke CLI" test ! -e "$WORK/capture"

export FLYWHEEL_EXEC_ID="exec-fly1571"
export FLYWHEEL_ISSUE_ID="FLY-1571"
run_hook '{"hook_event_name":"Stop","stop_hook_active":true}'
check "stop_hook_active re-fire does not invoke CLI" test ! -e "$WORK/capture"

run_hook '{}' --codex turn-ended '{"type":"agent-turn-complete","client":null,"turn-id":"child-turn"}'
check "Codex subagent notify is filtered" test ! -e "$WORK/capture"

start_ms="$(python3 -c 'import time; print(int(time.time() * 1000))')"
run_hook '{}' --codex turn-ended '{"type":"agent-turn-complete","client":"codex-tui","turn-id":"main-turn","last-assistant-message":"done"}'
elapsed_ms=$(( $(python3 -c 'import time; print(int(time.time() * 1000))') - start_ms ))
check "Codex foreground handoff returns under one second" test "$elapsed_ms" -lt 1000
check "Codex hook stdout stays empty" test ! -s "$WORK/stdout"
check "Codex hook stderr stays empty" test ! -s "$WORK/stderr"
if wait_capture; then
  pass "Codex main turn invokes detached emitter"
else
  fail "Codex main turn invokes detached emitter"
fi
check "Codex source flag forwarded" grep -q -- '--source' "$WORK/capture"
check "Codex turn id forwarded" grep -q -- 'main-turn' "$WORK/capture"

rm -f "$WORK/capture"
printf '%s\n' \
  '{"type":"user","uuid":"user-1","timestamp":"2026-08-04T12:00:00.000Z","message":{"content":"go"}}' \
  '{"type":"assistant","uuid":"assistant-1","message":{"content":[{"type":"text","text":"done"}]}}' \
  > "$WORK/transcript.jsonl"
run_hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"session-1\",\"transcript_path\":\"$WORK/transcript.jsonl\",\"stop_hook_active\":false}"
if wait_capture; then
  pass "Claude Stop invokes detached emitter"
else
  fail "Claude Stop invokes detached emitter"
fi
check "Claude source forwarded" grep -q -- 'claude-stop' "$WORK/capture"
check "Claude session forwarded" grep -q -- 'session-1' "$WORK/capture"

rm -f "$WORK/capture"
run_hook "{\"hook_event_name\":\"StopFailure\",\"session_id\":\"session-2\",\"transcript_path\":\"$WORK/transcript.jsonl\",\"error\":\"rate_limit\",\"error_details\":null,\"last_assistant_message\":\"API Error 429\"}"
if wait_capture; then
  pass "Claude StopFailure invokes detached emitter"
else
  fail "Claude StopFailure invokes detached emitter"
fi
check "StopFailure source forwarded" grep -q -- 'claude-stop-failure' "$WORK/capture"
check "StopFailure structured error forwarded" grep -q -- 'rate_limit' "$WORK/capture"

rm -f "$WORK/capture"
mkdir -p "$WORK/bad-home"
touch "$WORK/bad-home/.flywheel"
FLY1571_TEST_HOME="$WORK/bad-home" run_hook '{}' --codex turn-ended '{"type":"agent-turn-complete","client":"codex-tui","turn-id":"unwritable-log"}'
if wait_capture; then
  pass "unwritable log path still invokes detached emitter"
else
  fail "unwritable log path still invokes detached emitter"
fi
check "unwritable log fallback keeps stdout empty" test ! -s "$WORK/stdout"
check "unwritable log fallback keeps stderr empty" test ! -s "$WORK/stderr"

printf '\nrunner-stop-notify: passed=%s failed=%s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

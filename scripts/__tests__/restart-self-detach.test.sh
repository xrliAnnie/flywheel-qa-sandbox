#!/usr/bin/env bash
set -uo pipefail

PASS=0
FAIL=0
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1634-detach.XXXXXX")"
CHILD_PIDS=""
cleanup() {
  local pid attempt
  for pid in $CHILD_PIDS; do
    kill "$pid" 2>/dev/null || true
  done
  for ((attempt = 0; attempt < 20; attempt++)); do
    rm -rf "$TEST_ROOT" 2>/dev/null && return 0
    sleep 0.1
  done
  printf '[TEST] WARNING - could not remove test root %s after child cleanup\n' "$TEST_ROOT" >&2
}
trap cleanup EXIT

pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

wait_for_file() {
  local file="$1" attempts="${2:-50}" attempt
  for ((attempt = 0; attempt < attempts; attempt++)); do
    [[ -e "$file" ]] && return 0
    sleep 0.1
  done
  return 1
}

wait_for_child_cycle() {
  local result="$1" completed="$2" pid="" attempt
  wait_for_file "$result" 50 || return 1
  pid="$(awk -F '\t' 'NF == 2 { print $1; exit }' "$result" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  CHILD_PIDS="${CHILD_PIDS}${CHILD_PIDS:+ }${pid}"
  wait_for_file "$completed" 50 || return 1
  for ((attempt = 0; attempt < 50; attempt++)); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}

HARNESS="$TEST_ROOT/restart-detach-harness.sh"
{
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
    'log() {' \
    '  [[ -z "${FLY1783_OBSERVABLE_LOG:-}" ]] || printf "[restart] %s\n" "$*" >&2' \
    '}'
  sed -n '/^alert_launchd_refusal()/,/^}/p' \
    "$ROOT/scripts/restart-services.sh"
  sed -n '/^_rs_is_direct_launchd_invocation()/,/^}/p' \
    "$ROOT/scripts/restart-services.sh"
  # FLY-1649 validates rollback/lock env contracts immediately before the
  # detach seam. Keep the extracted harness behaviorally complete.
  sed -n '/^validate_restart_contract()/,/^}/p' \
    "$ROOT/scripts/restart-services.sh"
  awk '
    /^FORCE=false$/ { capture=1 }
    capture && /^# FLY-1434:/ { exit }
    capture { print }
  ' "$ROOT/scripts/restart-services.sh"
  printf '%s\n' \
    'pgid="$(python3 -c '\''import os; print(os.getpgrp())'\'')"' \
    'printf "%s\t%s\n" "$$" "$pgid" > "$FLY1634_DETACH_RESULT"' \
    'if [[ "${FLY1783_TEST_HOLD_CHILD:-0}" == "1" ]]; then' \
    '  : > "${FLY1783_CHILD_STARTED:?}"' \
    '  sleep "${FLY1783_TEST_HOLD_SECONDS:-2}"' \
    '  : > "${FLY1783_CHILD_COMPLETED:?}"' \
    'fi'
} > "$HARNESS"
chmod +x "$HARNESS"

parent_pgid="$(python3 -c 'import os; print(os.getpgrp())')"
RESULT="$TEST_ROOT/default.result"
DEFAULT_STARTED="$TEST_ROOT/default.started"
DEFAULT_COMPLETED="$TEST_ROOT/default.completed"
DEFAULT_LOG_DIR="$TEST_ROOT/default-logs"
mkdir -p "$DEFAULT_LOG_DIR"
output="$(env -u FLYWHEEL_RESTART_FOREGROUND \
  FLY1634_DETACH_RESULT="$RESULT" \
  FLY1783_TEST_HOLD_CHILD=1 \
  FLY1783_CHILD_STARTED="$DEFAULT_STARTED" \
  FLY1783_CHILD_COMPLETED="$DEFAULT_COMPLETED" \
  FLYWHEEL_RESTART_DETACH_LOG_DIR="$DEFAULT_LOG_DIR" \
  bash "$HARNESS" --reason test)"
default_cycle_ok=false
wait_for_child_cycle "$RESULT" "$DEFAULT_COMPLETED" && default_cycle_ok=true
child_pgid="$(awk -F '\t' 'NF == 2 { print $2 }' "$RESULT" 2>/dev/null || true)"
if printf '%s\n' "$output" | grep -q '^\[restart\] detached' \
  && [ -n "$parent_pgid" ] && [ -n "$child_pgid" ] \
  && [ "$child_pgid" != "$parent_pgid" ] \
  && [[ "$default_cycle_ok" == true ]] \
  && find "$DEFAULT_LOG_DIR" -maxdepth 1 -type f -name 'flywheel-restart-detached-*.log' \
       | grep -q .; then
  pass "default invocation survives the 1s probe in a separate process group and uses the isolated log dir"
else
  fail "default invocation did not complete the detached cycle (parent=$parent_pgid child=$child_pgid cycle=$default_cycle_ok output=$output)"
fi

RESULT="$TEST_ROOT/bash32-zero-args.result"
ZERO_STARTED="$TEST_ROOT/bash32-zero-args.started"
ZERO_COMPLETED="$TEST_ROOT/bash32-zero-args.completed"
ZERO_LOG_DIR="$TEST_ROOT/zero-logs"
mkdir -p "$ZERO_LOG_DIR"
output="$(env -u FLYWHEEL_RESTART_FOREGROUND \
  FLY1634_DETACH_RESULT="$RESULT" \
  FLY1783_TEST_HOLD_CHILD=1 \
  FLY1783_CHILD_STARTED="$ZERO_STARTED" \
  FLY1783_CHILD_COMPLETED="$ZERO_COMPLETED" \
  FLYWHEEL_RESTART_DETACH_LOG_DIR="$ZERO_LOG_DIR" \
  /bin/bash "$HARNESS" 2>&1)"
zero_args_rc=$?
zero_cycle_ok=false
wait_for_child_cycle "$RESULT" "$ZERO_COMPLETED" && zero_cycle_ok=true
if [ "$zero_args_rc" -eq 0 ] && [[ "$zero_cycle_ok" == true ]] \
  && printf '%s\n' "$output" | grep -q '^\[restart\] detached'; then
  pass "zero-argument detach is nounset-safe under /bin/bash"
else
  fail "zero-argument detach failed under /bin/bash (rc=$zero_args_rc cycle=$zero_cycle_ok output=$output)"
fi

# Lead advisory: a child can finish successfully inside the 1s observation
# window (for example, the historical lock-contention no-op). That is not a
# detach failure and must preserve exit 0.
RESULT="$TEST_ROOT/quick-clean.result"
QUICK_LOG_DIR="$TEST_ROOT/quick-clean-logs"
mkdir -p "$QUICK_LOG_DIR"
quick_output="$TEST_ROOT/quick-clean.output"
quick_rc=0
set +e
env -u FLYWHEEL_RESTART_FOREGROUND \
  FLY1634_DETACH_RESULT="$RESULT" \
  FLY1783_OBSERVABLE_LOG=1 \
  FLYWHEEL_RESTART_DETACH_LOG_DIR="$QUICK_LOG_DIR" \
  bash "$HARNESS" >"$quick_output" 2>&1
quick_rc=$?
set -e
if [[ "$quick_rc" -eq 0 && -s "$RESULT" ]] \
  && grep -q 'completed within 1s with exit 0' "$quick_output" \
  && ! grep -q 'failing LOUD' "$quick_output"; then
  pass "quick clean child exit preserves the successful no-op contract"
else
  fail "quick clean child exit was misclassified as detach failure (rc=$quick_rc output=$(cat "$quick_output"))"
fi

RESULT="$TEST_ROOT/dry-run.result"
output="$(env -u FLYWHEEL_RESTART_FOREGROUND \
  FLY1634_DETACH_RESULT="$RESULT" bash "$HARNESS" --dry-run)"
dry_pgid="$(awk -F '\t' 'NF == 2 { print $2 }' "$RESULT" 2>/dev/null || true)"
if [ -s "$RESULT" ] && ! printf '%s\n' "$output" | grep -q 'detached' \
  && [ "$dry_pgid" = "$parent_pgid" ]; then
  pass "dry-run remains synchronous"
else
  fail "dry-run detached unexpectedly (parent=$parent_pgid child=$dry_pgid output=$output)"
fi

RESULT="$TEST_ROOT/foreground.result"
output="$(FLYWHEEL_RESTART_FOREGROUND=1 FLY1634_DETACH_RESULT="$RESULT" \
  bash "$HARNESS")"
foreground_pgid="$(awk -F '\t' 'NF == 2 { print $2 }' "$RESULT" 2>/dev/null || true)"
if [ -s "$RESULT" ] && ! printf '%s\n' "$output" | grep -q 'detached' \
  && [ "$foreground_pgid" = "$parent_pgid" ]; then
  pass "foreground escape hatch remains synchronous"
else
  fail "foreground escape hatch detached (parent=$parent_pgid child=$foreground_pgid output=$output)"
fi

# FLY-1783 T1/T1b: the direct-launchd predicate is pure and has no production
# environment override seam.
PREDICATE_LIB="$TEST_ROOT/direct-launchd-predicate.sh"
sed -n '/^_rs_is_direct_launchd_invocation()/,/^}/p' \
  "$ROOT/scripts/restart-services.sh" > "$PREDICATE_LIB"
if [[ -s "$PREDICATE_LIB" ]] \
  && bash -c 'source "$1"; _rs_is_direct_launchd_invocation 1 0; _rs_is_direct_launchd_invocation 1 ""' \
       _ "$PREDICATE_LIB" \
  && ! bash -c 'source "$1"; _rs_is_direct_launchd_invocation 1 1' _ "$PREDICATE_LIB" \
  && ! bash -c 'source "$1"; _rs_is_direct_launchd_invocation 42 0' _ "$PREDICATE_LIB"; then
  pass "direct-launchd predicate rejects only ppid=1 entry mode"
else
  fail "direct-launchd predicate truth table is missing or incorrect"
fi

# FLY-1783 T1c/T1d: exercise the real refusal block and alert helper. The
# predicate is stubbed true only to deterministically enter the branch; it
# records both received args and the harness shell's true PPID.
FAKE_ROOT="$TEST_ROOT/fake-flywheel"
FAKE_BIN="$TEST_ROOT/fake-bin"
mkdir -p "$FAKE_ROOT/scripts" "$FAKE_BIN"
cat > "$FAKE_ROOT/scripts/lead-alert.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FLY1783_ALERT_ARGS"
exit "${FLY1783_ALERT_RC:-0}"
EOF
cat > "$FAKE_BIN/date" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == "-u +%Y%m%d" ]]; then
  printf '20990102\n'
else
  /bin/date "$@"
fi
EOF
cat > "$FAKE_BIN/launchctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FLY1783_LAUNCHCTL_CALLS"
EOF
chmod +x "$FAKE_ROOT/scripts/lead-alert.sh" "$FAKE_BIN/date" "$FAKE_BIN/launchctl"

DENY_HARNESS="$TEST_ROOT/direct-launchd-deny-harness.sh"
{
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
    'log() { printf "[restart] %s\n" "$*" >&2; }'
  sed -n '/^alert_launchd_refusal()/,/^}/p' "$ROOT/scripts/restart-services.sh"
  printf '%s\n' \
    '_rs_is_direct_launchd_invocation() {' \
    '  printf "%s\t%s\t%s\n" "$1" "$2" "$PPID" > "$FLY1783_PREDICATE_ARGS"' \
    '  return 0' \
    '}'
  sed -n '/^validate_restart_contract()/,/^}/p' "$ROOT/scripts/restart-services.sh"
  awk '
    /^FORCE=false$/ { capture=1 }
    capture && /^# FLY-1434:/ { exit }
    capture { print }
  ' "$ROOT/scripts/restart-services.sh"
  printf '%s\n' 'printf "unexpected fallthrough\n" >&2' 'exit 99'
} > "$DENY_HARNESS"
chmod +x "$DENY_HARNESS"

run_deny_harness() {
  local alert_rc="$1" output_file="$2" rc=0
  : > "$FLY1783_ALERT_ARGS"
  : > "$FLY1783_LAUNCHCTL_CALLS"
  set +e
  env -u FLYWHEEL_RESTART_FOREGROUND \
    PATH="$FAKE_BIN:$PATH" \
    FLYWHEEL_DIR="$FAKE_ROOT" \
    FLY1783_ALERT_RC="$alert_rc" \
    bash "$DENY_HARNESS" >"$output_file" 2>&1
  rc=$?
  set -e
  return "$rc"
}

FLY1783_ALERT_ARGS="$TEST_ROOT/refusal-alert.args"
FLY1783_LAUNCHCTL_CALLS="$TEST_ROOT/refusal-launchctl.calls"
FLY1783_PREDICATE_ARGS="$TEST_ROOT/refusal-predicate.args"
export FLY1783_ALERT_ARGS FLY1783_LAUNCHCTL_CALLS FLY1783_PREDICATE_ARGS
REFUSAL_OUTPUT="$TEST_ROOT/refusal.stderr"
refusal_rc=0
run_deny_harness 0 "$REFUSAL_OUTPUT" || refusal_rc=$?
predicate_arg1="$(awk -F '\t' '{print $1}' "$FLY1783_PREDICATE_ARGS" 2>/dev/null || true)"
predicate_arg2="$(awk -F '\t' '{print $2}' "$FLY1783_PREDICATE_ARGS" 2>/dev/null || true)"
predicate_true_ppid="$(awk -F '\t' '{print $3}' "$FLY1783_PREDICATE_ARGS" 2>/dev/null || true)"
if [[ "$refusal_rc" -eq 78 ]] \
  && grep -q 'request-restart.sh' "$REFUSAL_OUTPUT" \
  && [[ "$predicate_arg1" == "$predicate_true_ppid" && "$predicate_arg2" == "0" ]] \
  && grep -q -- '--kind deploy_failed' "$FLY1783_ALERT_ARGS" \
  && grep -q -- '--signature restart-guard-launchd-refusal-20990102' "$FLY1783_ALERT_ARGS" \
  && [[ ! -s "$FLY1783_LAUNCHCTL_CALLS" ]]; then
  pass "direct launchd refusal exits 78, points to request-restart, and emits one daily alert without scheduler calls"
else
  fail "direct launchd refusal contract mismatch (rc=$refusal_rc args=$(cat "$FLY1783_PREDICATE_ARGS" 2>/dev/null || true) alert=$(cat "$FLY1783_ALERT_ARGS" 2>/dev/null || true) output=$(cat "$REFUSAL_OUTPUT" 2>/dev/null || true))"
fi

REFUSAL_FAIL_OUTPUT="$TEST_ROOT/refusal-alert-failure.stderr"
refusal_alert_fail_rc=0
run_deny_harness 17 "$REFUSAL_FAIL_OUTPUT" || refusal_alert_fail_rc=$?
if [[ "$refusal_alert_fail_rc" -eq 78 ]]; then
  pass "direct launchd refusal remains exit 78 when alert delivery fails"
else
  fail "alert failure changed direct launchd refusal rc (got $refusal_alert_fail_rc)"
fi

callsite_count="$(grep -Fc '_rs_is_direct_launchd_invocation "$PPID" "${FLYWHEEL_RESTART_FOREGROUND:-0}"' \
  "$ROOT/scripts/restart-services.sh" || true)"
if [[ "$callsite_count" == "1" ]]; then
  pass "direct launchd predicate production callsite passes exact PPID and foreground inputs once"
else
  fail "direct launchd predicate production callsite drifted (count=$callsite_count)"
fi

# FLY-1783 T3: a deterministic detach-log setup failure must fail loudly. It
# must never fall back to a launchd scheduler with repeating-job semantics.
BLOCKING_FILE="$TEST_ROOT/not-a-directory"
: > "$BLOCKING_FILE"
FAIL_RESULT="$TEST_ROOT/fail.result"
FAIL_STARTED="$TEST_ROOT/fail.started"
FAIL_COMPLETED="$TEST_ROOT/fail.completed"
FAIL_OUTPUT="$TEST_ROOT/fail.stderr"
: > "$FLY1783_LAUNCHCTL_CALLS"
detach_fail_rc=0
set +e
env -u FLYWHEEL_RESTART_FOREGROUND \
  PATH="$FAKE_BIN:$PATH" \
  FLY1634_DETACH_RESULT="$FAIL_RESULT" \
  FLY1783_TEST_HOLD_CHILD=1 \
  FLY1783_CHILD_STARTED="$FAIL_STARTED" \
  FLY1783_CHILD_COMPLETED="$FAIL_COMPLETED" \
  FLY1783_OBSERVABLE_LOG=1 \
  FLYWHEEL_RESTART_DETACH_LOG_DIR="$BLOCKING_FILE" \
  FLY1783_LAUNCHCTL_CALLS="$FLY1783_LAUNCHCTL_CALLS" \
  bash "$HARNESS" >"$FAIL_OUTPUT" 2>&1
detach_fail_rc=$?
set -e
if [[ -s "$FAIL_RESULT" ]]; then
  wait_for_child_cycle "$FAIL_RESULT" "$FAIL_COMPLETED" || true
fi
if [[ "$detach_fail_rc" -ne 0 ]] \
  && grep -q 'detached restart child exited within 1s with status' "$FAIL_OUTPUT" \
  && ! grep -Eq '(^|[[:space:]])(submit|load|bootstrap)([[:space:]]|$)' "$FLY1783_LAUNCHCTL_CALLS"; then
  pass "macOS-style detach failure is loud and produces no repeating launchd job"
else
  fail "detach failure did not fail loud without scheduler fallback (rc=$detach_fail_rc calls=$(cat "$FLY1783_LAUNCHCTL_CALLS") output=$(cat "$FAIL_OUTPUT"))"
fi

if rg -q 'FLYWHEEL_RESTART_FOREGROUND=1 "\$\{SCRIPT_DIR\}/restart-services\.sh" --reason updater' \
  "$ROOT/scripts/update-flywheel.sh"; then
  pass "updater preserves restart exit-code contract and identifies itself in the report"
else
  fail "updater does not select synchronous restart execution with reason=updater"
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

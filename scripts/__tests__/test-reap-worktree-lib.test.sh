#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$ROOT/.claude/orchestrator/lib/reap-worktree.sh"
TMP_ROOT="$(mktemp -d)"
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)"
BIN_DIR="$TMP_ROOT/bin"
STATE="$TMP_ROOT/alive"
SIGNALS="$TMP_ROOT/signals"
PASS=0
FAIL=0
REAL_PIDS=""

cleanup() {
  for pid in $REAL_PIDS; do
    /bin/kill -KILL "$pid" 2>/dev/null || true
  done
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

wait_for_process_command() {
  local ps_bin="$1" pid="$2" expected="$3"
  local attempts="${4:-100}" interval="${5:-0.05}" sleep_bin="${6:-sleep}"
  local command
  WAIT_FOR_PROCESS_COMMAND_LAST=""
  for _ in $(seq 1 "$attempts"); do
    command="$(TZ=UTC LC_ALL=C "$ps_bin" -p "$pid" -o command= 2>/dev/null \
      | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" || command=""
    WAIT_FOR_PROCESS_COMMAND_LAST="$command"
    [[ "$command" == "$expected" ]] && return 0
    "$sleep_bin" "$interval"
  done
  return 1
}

run_when_process_command_ready() {
  [[ "$#" -ge 7 ]] || return 2
  local ps_bin="$1" pid="$2" expected="$3"
  local attempts="$4" interval="$5" sleep_bin="$6"
  shift 6
  wait_for_process_command \
    "$ps_bin" "$pid" "$expected" "$attempts" "$interval" "$sleep_bin" || return 1
  "$@"
}

print_fixture_process_diagnostics() {
  [[ "$#" -eq 4 ]] || return 2
  local ps_bin="$1" fixture_parent="$2" fixture_child="$3" observed="$4"
  printf '  observed child command: %s\n' "${observed:-<unreadable>}" >&2
  TZ=UTC LC_ALL=C "$ps_bin" -axo pid=,ppid=,command= 2>/dev/null \
    | awk -v fixture_parent="$fixture_parent" -v fixture_child="$fixture_child" \
      '$1 == fixture_parent || $1 == fixture_child || $2 == fixture_parent || $2 == fixture_child {
        print "  fixture row: " $0
      }' >&2 || true
}

if [[ ! -f "$LIB" ]]; then
  echo "FAIL: missing $LIB"
  exit 1
fi
# shellcheck source=/dev/null
source "$LIB"

mkdir -p "$BIN_DIR" "$TMP_ROOT/project" "$TMP_ROOT/project-FLY-1759"
: > "$SIGNALS"

cat > "$BIN_DIR/lsof" <<'SH'
#!/usr/bin/env bash
while IFS= read -r pid; do
  [[ -n "$pid" ]] || continue
  if [[ "$pid" == "101" ]]; then
    printf 'p%s\nfcwd\nn%s\n' "$pid" "$MOCK_TARGET"
  fi
done < "$MOCK_STATE"
SH

cat > "$BIN_DIR/ps" <<'SH'
#!/usr/bin/env bash
if [[ "$*" == "-axo pid=,ppid=" ]]; then
  [[ "${MOCK_PS_FAIL_CENSUS:-0}" == "1" ]] && exit 1
  printf '1 0\n'
  grep -qx '101' "$MOCK_STATE" && printf '101 1\n'
  grep -qx '102' "$MOCK_STATE" && printf '102 101\n'
  grep -qx '103' "$MOCK_STATE" && printf '103 1\n'
  exit 0
fi
pid=""
for ((i=1; i<=$#; i++)); do
  if [[ "${!i}" == "-p" ]]; then j=$((i + 1)); pid="${!j}"; fi
done
grep -qx "$pid" "$MOCK_STATE" 2>/dev/null || exit 1
if [[ "$*" == *"lstart="* ]]; then
  marker="$MOCK_DRIFT_MARKER.$pid"
  if [[ "${MOCK_DRIFT_PID:-}" == "$pid" && -e "$marker" ]]; then
    printf 'Thu Aug 14 01:00:00 2026\n'
  else
    printf 'Wed Aug 13 21:14:03 2026\n'
    : > "$marker"
  fi
elif [[ "$*" == *"command="* ]]; then
  printf 'fixture-unexpected-type-%s\n' "$pid"
else
  exit 1
fi
SH

cat > "$BIN_DIR/kill" <<'SH'
#!/usr/bin/env bash
sig="$1"; pid="$2"
if [[ "$sig" == "-0" ]]; then
  grep -qx "$pid" "$MOCK_STATE" 2>/dev/null
  exit $?
fi
printf '%s %s\n' "$sig" "$pid" >> "$MOCK_SIGNALS"
if [[ "$sig" == "-TERM" && "$pid" == "102" ]]; then
  exit 0
fi
tmp="${MOCK_STATE}.next"
awk -v doomed="$pid" '$1 != doomed' "$MOCK_STATE" > "$tmp"
mv "$tmp" "$MOCK_STATE"
SH

cat > "$BIN_DIR/readiness-ps" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_READY_ARGS"
[[ "$*" == "-p 201 -o command=" ]] || exit 64
count=$(cat "$MOCK_READY_CALLS")
count=$((count + 1))
printf '%s\n' "$count" > "$MOCK_READY_CALLS"
case "${MOCK_READY_MODE:-transition}" in
  transition)
    if [[ "$count" -lt 3 ]]; then
      printf 'fixture-pre-exec\n'
    else
      printf '/bin/sleep 300\n'
    fi
    ;;
  never) printf 'fixture-pre-exec\n' ;;
  *) exit 65 ;;
esac
SH

cat > "$BIN_DIR/census-ps" <<'SH'
#!/usr/bin/env bash
[[ "$*" == "-axo pid=,ppid=,command=" ]] || exit 66
printf '%s\n' \
  '100 1 fixture-parent' \
  '201 100 /bin/sleep 300' \
  '202 201 fixture-descendant' \
  '999 1 unrelated'
SH
chmod +x \
  "$BIN_DIR/lsof" "$BIN_DIR/ps" "$BIN_DIR/kill" \
  "$BIN_DIR/readiness-ps" "$BIN_DIR/census-ps"

export MOCK_TARGET="$TMP_ROOT/project-FLY-1759"
export MOCK_STATE="$STATE"
export MOCK_SIGNALS="$SIGNALS"
export MOCK_DRIFT_MARKER="$TMP_ROOT/drift"
export REAP_WORKTREE_LSOF_BIN="$BIN_DIR/lsof"
export REAP_WORKTREE_PS_BIN="$BIN_DIR/ps"
export REAP_WORKTREE_KILL_BIN="$BIN_DIR/kill"
export REAP_WORKTREE_SLEEP_BIN=/usr/bin/true

reset_mock() {
  printf '101\n102\n103\n' > "$STATE"
  : > "$SIGNALS"
  rm -f "$TMP_ROOT"/drift.*
  export MOCK_PS_FAIL_CENSUS=0
  export MOCK_DRIFT_PID=""
}

record_mock_reaper_call() {
  mock_reaper_called=$((mock_reaper_called + 1))
}

echo "Test: FLY-2180 fixture readiness waits for the child exec command"
MOCK_READY_CALLS="$TMP_ROOT/ready-calls"
MOCK_READY_ARGS="$TMP_ROOT/ready-args"
printf '0\n' > "$MOCK_READY_CALLS"
> "$MOCK_READY_ARGS"
export MOCK_READY_CALLS MOCK_READY_ARGS
export MOCK_READY_MODE=transition
mock_reaper_called=0
if run_when_process_command_ready \
    "$BIN_DIR/readiness-ps" 201 "/bin/sleep 300" 5 0 /usr/bin/true record_mock_reaper_call \
    && [[ "$(cat "$MOCK_READY_CALLS")" -eq 3 ]] \
    && [[ "$mock_reaper_called" -eq 1 ]] \
    && [[ "$(sort -u "$MOCK_READY_ARGS")" == "-p 201 -o command=" ]]; then
  pass "readiness accepts the intended command before entering teardown"
else
  fail "readiness did not gate teardown on the intended exec identity"
fi

echo "Test: FLY-2180 fixture readiness fails closed with the last identity"
printf '0\n' > "$MOCK_READY_CALLS"
> "$MOCK_READY_ARGS"
export MOCK_READY_MODE=never
WAIT_FOR_PROCESS_COMMAND_LAST=""
mock_reaper_called=0
readiness_rc=0
run_when_process_command_ready \
  "$BIN_DIR/readiness-ps" 201 "/bin/sleep 300" 2 0 /usr/bin/true record_mock_reaper_call \
  || readiness_rc=$?
if [[ "$readiness_rc" -ne 0 \
    && "$(cat "$MOCK_READY_CALLS")" -eq 2 \
    && "$WAIT_FOR_PROCESS_COMMAND_LAST" == "fixture-pre-exec" \
    && "$mock_reaper_called" -eq 0 ]]; then
  pass "readiness timeout preserves diagnostics and does not enter teardown"
else
  fail "readiness timeout lost diagnostics or entered teardown"
fi

echo "Test: FLY-2180 fixture readiness rejects an empty teardown callback"
printf '0\n' > "$MOCK_READY_CALLS"
> "$MOCK_READY_ARGS"
export MOCK_READY_MODE=transition
empty_payload_rc=0
run_when_process_command_ready \
  "$BIN_DIR/readiness-ps" 201 "/bin/sleep 300" 5 0 /usr/bin/true \
  || empty_payload_rc=$?
if [[ "$empty_payload_rc" -ne 0 ]]; then
  pass "readiness gate fails closed without a teardown callback"
else
  fail "readiness gate accepted an empty teardown callback"
fi

echo "Test: FLY-2180 fixture failure diagnostics include the bounded process census"
fixture_diagnostic="$TMP_ROOT/fixture-diagnostic"
print_fixture_process_diagnostics \
  "$BIN_DIR/census-ps" 100 201 "/bin/sleep 300" 2> "$fixture_diagnostic"
if grep -Fq 'observed child command: /bin/sleep 300' "$fixture_diagnostic" \
    && grep -Fq 'fixture row: 100 1 fixture-parent' "$fixture_diagnostic" \
    && grep -Fq 'fixture row: 201 100 /bin/sleep 300' "$fixture_diagnostic" \
    && grep -Fq 'fixture row: 202 201 fixture-descendant' "$fixture_diagnostic" \
    && ! grep -Fq 'unrelated' "$fixture_diagnostic"; then
  pass "fixture diagnostics show parent, child, and descendants only"
else
  fail "fixture diagnostics omitted bounded rows or included unrelated rows"
fi

echo "Test: FLY-1759 shell reaper follows cwd roots through descendants"
reset_mock
if reap_worktree_processes "$TMP_ROOT/project" "$MOCK_TARGET"; then
  if grep -qx -- '-TERM 101' "$SIGNALS" \
      && grep -qx -- '-TERM 102' "$SIGNALS" \
      && grep -qx -- '-KILL 102' "$SIGNALS" \
      && ! grep -q -- ' 103$' "$SIGNALS" \
      && grep -qx '103' "$STATE" \
      && ! grep -qx '101' "$STATE" \
      && ! grep -qx '102' "$STATE"; then
    pass "cwd match + child outside cwd are reaped; unrelated process survives"
  else
    fail "descendant/TERM-KILL signal set is wrong: $(tr '\n' ';' < "$SIGNALS")"
  fi
else
  fail "positive descendant reap returned incomplete"
fi

echo "Test: FLY-1759 shell reaper rejects unsafe roots before census/signals"
reset_mock
ln -s "$MOCK_TARGET" "$TMP_ROOT/project-FLY-symlink"
unsafe_ok=1
reap_worktree_processes "$TMP_ROOT/project" / >/dev/null 2>&1 && unsafe_ok=0
reap_worktree_processes "$TMP_ROOT/project" "$TMP_ROOT/project-FLY-symlink" >/dev/null 2>&1 && unsafe_ok=0
mkdir -p "$TMP_ROOT/elsewhere/project-FLY-else"
reap_worktree_processes "$TMP_ROOT/project" "$TMP_ROOT/elsewhere/project-FLY-else" >/dev/null 2>&1 && unsafe_ok=0
if [[ "$unsafe_ok" == "1" && ! -s "$SIGNALS" ]]; then
  pass "root/wrong-parent/real-symlink inputs produce zero signals"
else
  fail "unsafe path guard emitted a signal or accepted an input"
fi

echo "Test: FLY-1759 identity and census ambiguity fail closed"
reset_mock
export MOCK_DRIFT_PID=101
printf '101\n' > "$STATE"
drift_rc=0
reap_worktree_processes "$TMP_ROOT/project" "$MOCK_TARGET" >/dev/null 2>&1 || drift_rc=$?
drift_signals=$(wc -l < "$SIGNALS" | tr -d ' ')
reset_mock
export MOCK_PS_FAIL_CENSUS=1
census_rc=0
reap_worktree_processes "$TMP_ROOT/project" "$MOCK_TARGET" >/dev/null 2>&1 || census_rc=$?
if [[ "$drift_rc" -ne 0 && "$drift_signals" -eq 0 && "$census_rc" -ne 0 && ! -s "$SIGNALS" ]]; then
  pass "PID-generation drift and unreadable census both produce zero signals"
else
  fail "ambiguity guard failed drift_rc=$drift_rc signals=$drift_signals census_rc=$census_rc"
fi

echo "Test: FLY-1759 real shell/sleep child-sun closure (mandatory on CI)"
if ps -axo pid=,ppid= >/dev/null 2>&1 && command -v lsof >/dev/null 2>&1; then
  unset REAP_WORKTREE_LSOF_BIN REAP_WORKTREE_PS_BIN REAP_WORKTREE_KILL_BIN REAP_WORKTREE_SLEEP_BIN
  REAL_ROOT="$TMP_ROOT/real"
  REAL_PROJECT="$REAL_ROOT/flywheel"
  REAL_WORKTREE="$REAL_ROOT/flywheel-FLY-1759"
  REAL_HANDSHAKE="$REAL_ROOT/handshake"
  mkdir -p "$REAL_PROJECT" "$REAL_WORKTREE"
  (
    cd "$REAL_WORKTREE" || exit 1
    HANDSHAKE="$REAL_HANDSHAKE" /bin/sh -c '
      printf "%s\n" "$$" > "$HANDSHAKE"
      (cd / && exec /bin/sleep 300) &
      printf "%s\n" "$!" >> "$HANDSHAKE"
      wait
    ' </dev/null >/dev/null 2>&1
  ) &
  real_launcher=$!
  REAL_PIDS="$real_launcher"
  for _ in $(seq 1 100); do
    [[ -f "$REAL_HANDSHAKE" && "$(wc -l < "$REAL_HANDSHAKE" | tr -d ' ')" -ge 2 ]] && break
    sleep 0.05
  done
  real_parent=$(sed -n '1p' "$REAL_HANDSHAKE" 2>/dev/null || true)
  real_child=$(sed -n '2p' "$REAL_HANDSHAKE" 2>/dev/null || true)
  REAL_PIDS="$REAL_PIDS $real_parent $real_child"
  real_fixture_command="/bin/sleep 300"
  real_fixture_state=not_ready
  WAIT_FOR_PROCESS_COMMAND_LAST=""
  if [[ -n "$real_parent" && -n "$real_child" ]]; then
    if run_when_process_command_ready \
        ps "$real_child" "$real_fixture_command" 100 0.05 sleep \
        reap_worktree_processes "$REAL_PROJECT" "$REAL_WORKTREE"; then
      real_fixture_state=reaped
    elif [[ "$WAIT_FOR_PROCESS_COMMAND_LAST" == "$real_fixture_command" ]]; then
      real_fixture_state=reap_failed
    fi
  fi
  if [[ "$real_fixture_state" == "not_ready" ]]; then
    print_fixture_process_diagnostics \
      ps "$real_parent" "$real_child" "$WAIT_FOR_PROCESS_COMMAND_LAST"
    fail "real fixture did not reach the /bin/sleep 300 identity"
  elif [[ "$real_fixture_state" == "reaped" ]] \
      && ! /bin/kill -0 "$real_parent" 2>/dev/null \
      && ! /bin/kill -0 "$real_child" 2>/dev/null; then
    pass "real non-Node child and descendant both exit"
  else
    print_fixture_process_diagnostics \
      ps "$real_parent" "$real_child" "$WAIT_FOR_PROCESS_COMMAND_LAST"
    if [[ "$real_fixture_state" == "reap_failed" ]]; then
      fail "real teardown reaper returned incomplete after fixture readiness"
    else
      fail "real process closure did not converge"
    fi
  fi
else
  echo "  SKIP: host denies global ps census (Ubuntu CI runs this case)"
fi

echo "PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]

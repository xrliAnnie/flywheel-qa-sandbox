#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/test-teardown.sh"
TMP_ROOT=$(mktemp -d)
SLOT=1272
PASS=0
FAIL=0

cleanup() {
  rm -rf "$TMP_ROOT" "/tmp/flywheel-test-slot-${SLOT}" "/tmp/flywheel-test-slot-${SLOT}.lock"
}
trap cleanup EXIT

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

HOME_DIR="$TMP_ROOT/home"
BIN_DIR="$TMP_ROOT/bin"
STATE="$TMP_ROOT/tmux.sessions"
MUTATIONS="$TMP_ROOT/tmux.mutations"
LEASE="$TMP_ROOT/cmux-mutator.lock"
MARKER="$TMP_ROOT/cmux-maintenance"
WAL_DIR="$TMP_ROOT/view-wal"
mkdir -p "$HOME_DIR/.flywheel" "$BIN_DIR" "$WAL_DIR"
printf '{"slots":[]}\n' > "$HOME_DIR/.flywheel/test-slots.json"

export HOME="$HOME_DIR"
export PATH="$BIN_DIR:$PATH"
export TEST_TMUX_STATE="$STATE"
export TEST_TMUX_MUTATIONS="$MUTATIONS"
export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$LEASE"
export FLYWHEEL_CMUX_MAINTENANCE_MARKER="$MARKER"
export FLYWHEEL_CMUX_VIEW_WAL_DIR="$WAL_DIR"
export FLYWHEEL_CMUX_TMUX_GENERATION="test-generation"
export FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="teardown-test-incarnation"
export FLYWHEEL_QA_TEARDOWN_LEASE_WAIT_S=1

cat > "$BIN_DIR/tmux" <<'TMUX'
#!/bin/bash
set -u
state="$TEST_TMUX_STATE"
mutations="$TEST_TMUX_MUTATIONS"
socket=""
if [[ "${1:-}" == "-S" ]]; then
  socket="${2:-}"
  shift 2
fi
field_for() {
  local name="$1" field="$2"
  awk -F'|' -v n="$name" -v f="$field" '$1 == n { print $f; exit }' "$state" 2>/dev/null
}
exact_target() { local value="${1#=}"; printf '%s\n' "${value%:}"; }
case "${1:-}" in
  has-session)
    shift; [[ "${1:-}" == "-t" ]] && shift
    name=$(exact_target "${1:-}")
    awk -F'|' -v n="$name" '$1 == n { found=1 } END { exit(found ? 0 : 1) }' "$state" 2>/dev/null
    ;;
  list-sessions)
    shift
    format=""; filter=""
    while (($#)); do
      case "$1" in
        -F) format="$2"; shift 2 ;;
        -f) filter="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [[ -n "$filter" ]]; then
      name="${filter##*,}"; name="${name%\}}"
      case "$format" in
        '#{session_group}') field_for "$name" 2 ;;
        '#{session_id}') field_for "$name" 4 ;;
      esac
    else
      awk -F'|' '{ print $1 }' "$state" 2>/dev/null
    fi
    ;;
  display-message)
    shift
    [[ "${1:-}" == "-p" ]] && shift
    [[ "${1:-}" == "-t" ]] && { target="$2"; shift 2; }
    name=$(exact_target "${target:-}")
    case "${1:-}" in
      '#{session_group}') field_for "$name" 2 ;;
      '#{session_id}') field_for "$name" 4 ;;
    esac
    ;;
  show-options)
    shift
    [[ "${1:-}" == "-v" ]] && shift
    [[ "${1:-}" == "-t" ]] && { target="$2"; shift 2; }
    name=$(exact_target "${target:-}")
    [[ "${1:-}" == "@flywheel_cmux_owner" ]] && field_for "$name" 3
    ;;
  kill-session)
    shift; [[ "${1:-}" == "-t" ]] && shift
    name=$(exact_target "${1:-}")
    owner=$(cat "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner" 2>/dev/null || true)
    mode=$(printf '%s\n' "$owner" | cut -d'|' -f3)
    printf 'kill|%s|socket=%s|lease=%s\n' "$name" "$socket" "$mode" >> "$mutations"
    tmp="${state}.tmp"
    awk -F'|' -v n="$name" '$1 != n { print }' "$state" > "$tmp" 2>/dev/null || true
    mv "$tmp" "$state"
    ;;
  list-windows)
    exit 0
    ;;
esac
TMUX
chmod +x "$BIN_DIR/tmux"

cat > "$BIN_DIR/pgrep" <<'STUB'
#!/bin/bash
exit 1
STUB
cat > "$BIN_DIR/lsof" <<'STUB'
#!/bin/bash
exit 1
STUB
chmod +x "$BIN_DIR/pgrep" "$BIN_DIR/lsof"

reset_fixture() {
  : > "$STATE"
  : > "$MUTATIONS"
  rm -rf "$LEASE" "${LEASE}.reap" "$MARKER" "$WAL_DIR"
  mkdir -p "$WAL_DIR" "/tmp/flywheel-test-slot-${SLOT}.lock"
}

echo "Test: FLY-1272 teardown rejects the whole operation during maintenance"
reset_fixture
printf 'runner-test-slot-%s||runner-test-slot-%s|\$1\n' "$SLOT" "$SLOT" > "$STATE"
touch "$MARKER"
rc=0
/bin/bash "$SCRIPT" "$SLOT" >/dev/null 2>&1 || rc=$?
if [[ "$rc" -ne 0 && ! -s "$MUTATIONS" && -d "/tmp/flywheel-test-slot-${SLOT}.lock" && ! -d "$LEASE" ]]; then
  pass "marker is checked under a released qa_teardown lease before any mutation"
else
  fail "maintenance gate rc=$rc mutations=[$(cat "$MUTATIONS")] slot_lock=$([[ -d "/tmp/flywheel-test-slot-${SLOT}.lock" ]] && echo yes || echo no) lease=$([[ -d "$LEASE" ]] && echo yes || echo no)"
fi

echo "Test: FLY-1272 teardown lease excludes a live one-shot mutator"
reset_fixture
printf 'runner-test-slot-%s||runner-test-slot-%s|\$1\n' "$SLOT" "$SLOT" > "$STATE"
mkdir -p "$LEASE"
printf '%s\n' "$$" > "$LEASE/pid"
printf '%s|%s|once|foreign-nonce\n' "$$" "$FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE" > "$LEASE/owner"
rc=0
/bin/bash "$SCRIPT" "$SLOT" >/dev/null 2>&1 || rc=$?
if [[ "$rc" -ne 0 && ! -s "$MUTATIONS" && -d "$LEASE" ]]; then
  pass "live mutator owner blocks teardown without being stolen"
else
  fail "live-owner exclusion rc=$rc mutations=[$(cat "$MUTATIONS")] lease=$([[ -d "$LEASE" ]] && echo yes || echo no)"
fi

echo "Test: FLY-1272 teardown kills only this slot across cmux/keeper/stage namespaces"
reset_fixture
cat > "$STATE" <<EOF
runner-test-slot-${SLOT}||runner-test-slot-${SLOT}|\$1
runner-other||runner-other|\$2
cmux-own-linked||runner-test-slot-${SLOT}|\$3
cmux-own-grouped|runner-test-slot-${SLOT}||\$4
fwkeeper-own||runner-test-slot-${SLOT}|\$5
fwstage-owned||runner-test-slot-${SLOT}|\$6
fwstage-wal|||\$7
cmux-foreign-live||runner-other|\$8
cmux-foreign-dead||runner-dead|\$9
fwkeeper-foreign||runner-dead|\$10
cmux-unowned|||\$11
EOF
printf 'v1|test-generation|created|wal|cmux-wal|runner-test-slot-%s|@42|$7|@100\n' "$SLOT" > "$WAL_DIR/wal.wal"
rc=0
/bin/bash "$SCRIPT" "$SLOT" >/dev/null 2>&1 || rc=$?
killed=$(awk -F'|' '$1 == "kill" { print $2 }' "$MUTATIONS" | sort)
expected=$(printf '%s\n' \
  "cmux-own-grouped" "cmux-own-linked" "fwkeeper-own" "fwstage-owned" \
  "fwstage-wal" "runner-test-slot-${SLOT}" | sort)
runner_socket=$(awk -F'|' -v n="runner-test-slot-${SLOT}" \
  '$1 == "kill" && $2 == n { sub(/^socket=/, "", $3); print $3 }' "$MUTATIONS")
if [[ "$rc" -eq 0 && "$killed" == "$expected" ]] \
    && [[ "$runner_socket" == "/tmp/flywheel-test-slot-${SLOT}/tmux-$(id -u)/default" ]] \
    && ! grep -v 'lease=qa_teardown$' "$MUTATIONS" >/dev/null \
    && [[ ! -d "$LEASE" ]]; then
  pass "source identity/WAL authority reaps this slot and preserves live, dead, and unowned foreign sessions"
else
  fail "ownership sweep rc=$rc killed=[$(tr '\n' ' ' <<< "$killed")] expected=[$(tr '\n' ' ' <<< "$expected")] mutations=[$(cat "$MUTATIONS")]"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]

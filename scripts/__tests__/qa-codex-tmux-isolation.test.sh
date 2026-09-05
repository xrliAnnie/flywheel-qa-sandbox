#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/f2301-tmux.XXXXXX)"
DEFAULT_ROOT="$TMP/default-root"
SLOT_ROOT="$TMP/slot-root"
UID_VALUE=$(id -u)
DEFAULT_SOCKET="$DEFAULT_ROOT/tmux-${UID_VALUE}/default"
SLOT_SOCKET="$SLOT_ROOT/tmux-${UID_VALUE}/default"
SYSTEM_SOCKET_DIR="/tmp/tmux-${UID_VALUE}"
passed=0
failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }
cleanup() {
  TMUX= TMUX_TMPDIR="$DEFAULT_ROOT" tmux kill-server >/dev/null 2>&1 || true
  TMUX= TMUX_TMPDIR="$SLOT_ROOT" tmux kill-server >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

if ! command -v tmux >/dev/null 2>&1; then
  echo "FAIL: tmux is required" >&2
  exit 1
fi
mkdir -p "$DEFAULT_ROOT" "$SLOT_ROOT"
system_mtime_before=$(stat -f %m "$SYSTEM_SOCKET_DIR" 2>/dev/null \
  || stat -c %Y "$SYSTEM_SOCKET_DIR" 2>/dev/null || printf 'absent')

TMUX= TMUX_TMPDIR="$DEFAULT_ROOT" tmux new-session -d -s flywheel -n sentinel
TMUX= TMUX_TMPDIR="$DEFAULT_ROOT" tmux list-windows -t =flywheel \
  -F '#{window_name}' > "$TMP/default.before"

runtime="$TMP/fake-runtime.sh"
cat > "$runtime" <<'SH'
#!/bin/bash
set -e
tmux new-session -Ad -s flywheel >/dev/null 2>&1 || true
tmux kill-window -t "=flywheel:=${PROJECT_NAME}-${LEAD_ID}" >/dev/null 2>&1 || true
tmux new-window -d -t =flywheel -n "${PROJECT_NAME}-${LEAD_ID}" 'while :; do sleep 60; done'
SH
chmod +x "$runtime"

TMUX= TMUX_TMPDIR="$SLOT_ROOT" PROJECT_NAME=test-slot-7 LEAD_ID=qa-lead \
  /bin/bash "$runtime"
TMUX= TMUX_TMPDIR="$DEFAULT_ROOT" tmux list-windows -t =flywheel \
  -F '#{window_name}' > "$TMP/default.after-valid"
slot_count=$(TMUX= TMUX_TMPDIR="$SLOT_ROOT" tmux list-windows -t =flywheel \
  -F '#{window_name}' | grep -Fxc test-slot-7-qa-lead || true)
if cmp -s "$TMP/default.before" "$TMP/default.after-valid" \
    && [[ "$slot_count" == 1 && -S "$SLOT_SOCKET" && -S "$DEFAULT_SOCKET" ]]; then
  pass "slot TMUX_TMPDIR creates one Codex TUI window without changing the fallback server"
else
  fail "slot/fallback tmux server isolation"
fi

# Mutation 1: remove the slot TMUX_TMPDIR override. The inherited fallback root
# must receive the TUI window, proving the isolation test is discriminating.
TMUX= TMUX_TMPDIR="$DEFAULT_ROOT" PROJECT_NAME=test-slot-7 LEAD_ID=mutant-no-root \
  /bin/bash "$runtime"
TMUX= TMUX_TMPDIR="$DEFAULT_ROOT" tmux list-windows -t =flywheel \
  -F '#{window_name}' > "$TMP/default.after-mutant"
if ! cmp -s "$TMP/default.before" "$TMP/default.after-mutant" \
    && grep -Fxq test-slot-7-mutant-no-root "$TMP/default.after-mutant"; then
  pass "removing the TMUX_TMPDIR override contaminates the fallback server (red control)"
else
  fail "TMUX_TMPDIR removal mutant was non-discriminating"
fi

# Mutation 2: omit stale-window removal, then launch twice. Both names remain.
runtime_no_kill="$TMP/fake-runtime-no-kill.sh"
grep -v 'kill-window' "$runtime" > "$runtime_no_kill"
chmod +x "$runtime_no_kill"
TMUX= TMUX_TMPDIR="$SLOT_ROOT" PROJECT_NAME=test-slot-7 LEAD_ID=duplicate \
  /bin/bash "$runtime_no_kill"
TMUX= TMUX_TMPDIR="$SLOT_ROOT" PROJECT_NAME=test-slot-7 LEAD_ID=duplicate \
  /bin/bash "$runtime_no_kill"
duplicate_count=$(TMUX= TMUX_TMPDIR="$SLOT_ROOT" tmux list-windows -t =flywheel \
  -F '#{window_name}' | grep -Fxc test-slot-7-duplicate || true)
if [[ "$duplicate_count" == 2 ]]; then
  pass "removing stale-window cleanup leaves two TUI windows (red control)"
else
  fail "stale-window removal mutant was non-discriminating (${duplicate_count} windows)"
fi

system_mtime_after=$(stat -f %m "$SYSTEM_SOCKET_DIR" 2>/dev/null \
  || stat -c %Y "$SYSTEM_SOCKET_DIR" 2>/dev/null || printf 'absent')
if [[ "$system_mtime_after" == "$system_mtime_before" ]]; then
  pass "real tmux isolation never touches /tmp/tmux-${UID_VALUE}"
else
  fail "real tmux isolation changed /tmp/tmux-${UID_VALUE} mtime"
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]

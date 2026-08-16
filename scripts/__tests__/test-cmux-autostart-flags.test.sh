#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SCRIPT="$ROOT/scripts/flywheel-cmux-autostart.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

pass() { echo "[TEST] ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "[TEST] ✗ $1"; FAIL=$((FAIL + 1)); }

HOME_DIR="$TMP/home"
mkdir -p "$HOME_DIR/.flywheel/bin" "$HOME_DIR/.flywheel/state" \
  "$HOME_DIR/Library/LaunchAgents" "$TMP/bin" "$TMP/control"
cat > "$HOME_DIR/.flywheel/bin/flywheel-cmux-sync" <<'STUB'
#!/bin/bash
printf '%s|%s\n' "$FLYWHEEL_CMUX_LINKED_VIEW" "$*" > "$RECORD"
STUB
chmod +x "$HOME_DIR/.flywheel/bin/flywheel-cmux-sync"

cat > "$TMP/bin/launchctl" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "${CONTROL_DIR:?}/calls"
case "$1" in
  print)
    [[ -e "$CONTROL_DIR/loaded" ]]
    ;;
  bootstrap)
    [[ "${BOOTSTRAP_RC:-0}" == "0" ]] || exit "$BOOTSTRAP_RC"
    touch "$CONTROL_DIR/loaded"
    ;;
  *)
    exit 64
    ;;
esac
STUB
chmod +x "$TMP/bin/launchctl"

run_autostart() {
  local record="$1"; shift
  env -i HOME="$HOME_DIR" PATH="$TMP/bin:/usr/bin:/bin" RECORD="$record" \
    CONTROL_DIR="$TMP/control" "$@" /bin/bash "$SCRIPT" \
    >"$TMP/stdout" 2>"$TMP/stderr"
}

# The old direct-exec behavior remains an explicit incident escape. Keep the
# existing .env parser contract covered under that path.
printf 'FLYWHEEL_CMUX_LINKED_VIEW=0\nUNRELATED=$(touch /tmp/must-not-run)\n' > "$HOME_DIR/.flywheel/.env"
record="$TMP/file-values"
run_autostart "$record" FLYWHEEL_CMUX_AUTOSTART_EXEC=1
if [[ "$(cat "$record")" == "0|--watch" && ! -e /tmp/must-not-run ]]; then
  pass "escape path extracts only cmux bool flags from .env without sourcing unrelated code"
else
  fail "file extraction/exec mismatch: $(cat "$record" 2>/dev/null || true)"
fi

record="$TMP/env-precedence"
run_autostart "$record" FLYWHEEL_CMUX_AUTOSTART_EXEC=1 \
  FLYWHEEL_CMUX_LINKED_VIEW=1
if [[ "$(cat "$record")" == "1|--watch" ]]; then
  pass "process env overrides .env"
else
  fail "env precedence mismatch: $(cat "$record" 2>/dev/null || true)"
fi

printf 'FLYWHEEL_CMUX_LINKED_VIEW=wat\n' > "$HOME_DIR/.flywheel/.env"
record="$TMP/invalid"
run_autostart "$record" FLYWHEEL_CMUX_AUTOSTART_EXEC=1
if [[ "$(cat "$record")" == "1|--watch" ]]; then
  pass "invalid/empty values fail safe to default-on"
else
  fail "invalid bool handling mismatch: $(cat "$record" 2>/dev/null || true)"
fi

# Default unsupervised invocation is now only a launchd job guard. A loaded
# KeepAlive job means success with no direct watcher exec.
: > "$TMP/control/calls"
touch "$TMP/control/loaded"
rm -f "$HOME_DIR/.flywheel/state/cmux-maintenance"
record="$TMP/loaded-guard"
run_autostart "$record"
if [[ ! -e "$record" ]] \
   && grep -q "^print gui/$(id -u)/com.flywheel.cmux-watcher$" "$TMP/control/calls" \
   && ! grep -q '^bootstrap ' "$TMP/control/calls"; then
  pass "default unsupervised path: loaded launchd KeepAlive job → no direct watcher exec"
else
  fail "loaded launchd guard mismatch: $(cat "$TMP/control/calls" "$TMP/stderr" 2>/dev/null)"
fi

# A missing job is bootstrapped from the installed plist, still without direct
# exec. This is the .zshrc self-heal path after an accidental bootout.
: > "$TMP/control/calls"
rm -f "$TMP/control/loaded"
printf '<plist/>\n' > "$HOME_DIR/Library/LaunchAgents/com.flywheel.cmux-watcher.plist"
record="$TMP/bootstrap-guard"
run_autostart "$record"
if [[ ! -e "$record" && -e "$TMP/control/loaded" ]] \
   && grep -q "^bootstrap gui/$(id -u) $HOME_DIR/Library/LaunchAgents/com.flywheel.cmux-watcher.plist$" "$TMP/control/calls"; then
  pass "default unsupervised path: unloaded job + plist → bootstrap only, no direct exec"
else
  fail "bootstrap guard mismatch: $(cat "$TMP/control/calls" "$TMP/stderr" 2>/dev/null)"
fi

# Missing plist is an operator hint but shell startup remains successful.
: > "$TMP/control/calls"
rm -f "$TMP/control/loaded" "$HOME_DIR/Library/LaunchAgents/com.flywheel.cmux-watcher.plist"
record="$TMP/missing-plist"
if run_autostart "$record" \
   && [[ ! -e "$record" ]] \
   && grep -q 'run scripts/flywheel-cmux-install.sh' "$TMP/stderr"; then
  pass "unloaded job + missing plist → install hint, rc=0, no direct watcher exec"
else
  fail "missing-plist guard mismatch: $(cat "$TMP/control/calls" "$TMP/stderr" 2>/dev/null)"
fi

# Even bootstrap failure must not break every interactive shell. It is loud,
# but the KeepAlive/job installation problem belongs to the operator.
: > "$TMP/control/calls"
rm -f "$TMP/control/loaded"
printf '<plist/>\n' > "$HOME_DIR/Library/LaunchAgents/com.flywheel.cmux-watcher.plist"
record="$TMP/bootstrap-failed"
if run_autostart "$record" BOOTSTRAP_RC=5 \
   && [[ ! -e "$record" ]] \
   && grep -q 'launchctl bootstrap failed' "$TMP/stderr"; then
  pass "bootstrap failure → loud rc=0 shell guard, never falls back to direct exec"
else
  fail "bootstrap failure handling mismatch: $(cat "$TMP/control/calls" "$TMP/stderr" 2>/dev/null)"
fi

# The marker dominates both launchctl and the explicit direct-exec escape on
# unsupervised paths.
: > "$TMP/control/calls"
touch "$HOME_DIR/.flywheel/state/cmux-maintenance"
record="$TMP/maintenance-zsh"
run_autostart "$record" FLYWHEEL_CMUX_AUTOSTART_EXEC=1
if [[ ! -e "$record" && ! -s "$TMP/control/calls" ]]; then
  pass "unsupervised maintenance marker precedes launchctl and direct-exec escape"
else
  fail "unsupervised maintenance path touched launchctl/watcher"
fi

record="$TMP/maintenance-supervised"
run_autostart "$record" FLYWHEEL_CMUX_SUPERVISED=1
if [[ "$(cat "$record")" == "1|--watch" ]]; then
  pass "supervised launchd path remains exec-based and delegates maintenance waiting to sync"
else
  fail "supervised maintenance path did not exec watcher"
fi

# The escape can be loaded key-specifically from .env; it must not require
# sourcing arbitrary shell.
rm -f "$HOME_DIR/.flywheel/state/cmux-maintenance"
printf 'FLYWHEEL_CMUX_AUTOSTART_EXEC=1\nUNRELATED=$(touch /tmp/must-not-run)\n' > "$HOME_DIR/.flywheel/.env"
record="$TMP/file-escape"
run_autostart "$record"
if [[ "$(cat "$record")" == "1|--watch" && ! -e /tmp/must-not-run ]]; then
  pass "FLYWHEEL_CMUX_AUTOSTART_EXEC=1 loads from .env via key-specific parser"
else
  fail "file escape parser mismatch: $(cat "$record" "$TMP/stderr" 2>/dev/null)"
fi

echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]

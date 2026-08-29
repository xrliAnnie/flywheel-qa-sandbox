#!/bin/bash
# FLY-650: supervisor.sh — platform-abstraction service supervisor (D1=A).
#
# Contract under test (plan §3.2):
#   - backend resolution: FLYWHEEL_SUPERVISOR_BACKEND wins; else uname-derived.
#   - LINUX backend renders systemd --user units from a unit-spec:
#       kind=service → <name>.service (Restart=always if keepAlive)
#       kind=timer   → <name>.service (oneshot) + <name>.timer (OnCalendar)
#       kind=path    → <name>.service (oneshot) + <name>.path (DirectoryNotEmpty)
#       darwinOnly   → skipped on linux (no unit written, rc 0)
#     then systemctl --user daemon-reload + enable --now <unit>.
#   - lifecycle (start/stop/restart/status/is_loaded) dispatch:
#       linux  → systemctl --user <verb> <name>.<suffix>
#       darwin → launchctl on gui/<uid>/com.flywheel.<name>
#
# Hermetic: stub systemctl/launchctl on PATH (record calls), fixture unit dir.
set -uo pipefail

PASSED=0; FAILED=0
log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); log_test "✗ $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="${REPO_ROOT}/scripts/lib/supervisor.sh"
[ -f "$LIB" ] || { echo "ERROR: $LIB not found"; exit 1; }

SANDBOX="$(mktemp -d -t fly650-supervisor-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

STUB_BIN="$SANDBOX/stubbin"; mkdir -p "$STUB_BIN"
CALLS="$SANDBOX/calls.log"
for b in systemctl launchctl; do
  cat > "$STUB_BIN/$b" <<EOF
#!/bin/bash
echo "$b \$*" >> "$CALLS"
exit 0
EOF
  chmod +x "$STUB_BIN/$b"
done
export PATH="$STUB_BIN:$PATH"

UNIT_DIR="$SANDBOX/systemd-user"
# Helper: source lib + run a function in a subshell with chosen backend + unit dir.
sup() {
  local backend="$1"; shift
  env FLYWHEEL_SUPERVISOR_BACKEND="$backend" \
      FLYWHEEL_SYSTEMD_USER_DIR="$UNIT_DIR" \
      PATH="$PATH" HOME="$HOME" \
      bash -c 'set -uo pipefail; source "'"$LIB"'" || exit 97; "$@"' _ "$@"
}

# ── S1: backend resolution ──
B="$(sup systemd-user supervisor_backend)"
[ "$B" = "systemd-user" ] && pass "S1a backend=systemd-user from env" || fail "S1a got '$B'"
B="$(sup launchd supervisor_backend)"
[ "$B" = "launchd" ] && pass "S1b backend=launchd from env" || fail "S1b got '$B'"

# ── S2: linux render service ──
: > "$CALLS"; rm -rf "$UNIT_DIR"
SPEC='{"name":"flywheel-bridge","kind":"service","exec":"/bin/bash /opt/fw/scripts/flywheel-bridge-wrapper.sh","keepAlive":true,"stdout":"/tmp/flywheel-bridge.log"}'
sup systemd-user supervisor_install "$SPEC" >/dev/null 2>&1
U="$UNIT_DIR/flywheel-bridge.service"
if [ -f "$U" ] && grep -q "ExecStart=/bin/bash /opt/fw/scripts/flywheel-bridge-wrapper.sh" "$U" \
   && grep -q "Restart=always" "$U" && grep -q "WantedBy=default.target" "$U" \
   && grep -q "enable --now flywheel-bridge.service" "$CALLS" \
   && grep -q "daemon-reload" "$CALLS"; then
  pass "S2 linux service unit rendered + enabled"
else
  fail "S2 service render: $(cat "$U" 2>/dev/null) | calls: $(cat "$CALLS")"
fi

# ── S3: linux render timer ──
: > "$CALLS"; rm -rf "$UNIT_DIR"
SPEC='{"name":"daily-standup","kind":"timer","exec":"/bin/bash /opt/fw/scripts/daily-standup.sh","schedule":[{"hour":3,"minute":0}]}'
sup systemd-user supervisor_install "$SPEC" >/dev/null 2>&1
SVC="$UNIT_DIR/daily-standup.service"; TMR="$UNIT_DIR/daily-standup.timer"
if [ -f "$SVC" ] && grep -q "Type=oneshot" "$SVC" \
   && [ -f "$TMR" ] && grep -q "OnCalendar=\*-\*-\* 03:00:00" "$TMR" \
   && grep -q "enable --now daily-standup.timer" "$CALLS"; then
  pass "S3 linux timer unit (.service oneshot + .timer OnCalendar)"
else
  fail "S3 timer render: svc=$(cat "$SVC" 2>/dev/null) tmr=$(cat "$TMR" 2>/dev/null) | calls: $(cat "$CALLS")"
fi

# ── S4: linux render path ──
: > "$CALLS"; rm -rf "$UNIT_DIR"
SPEC='{"name":"updater","kind":"path","exec":"/bin/bash /opt/fw/scripts/update-flywheel.sh","watch":["/opt/state/self-ship-pending.d"]}'
sup systemd-user supervisor_install "$SPEC" >/dev/null 2>&1
SVC="$UNIT_DIR/updater.service"; PTH="$UNIT_DIR/updater.path"
if [ -f "$SVC" ] && [ -f "$PTH" ] \
   && grep -q "DirectoryNotEmpty=/opt/state/self-ship-pending.d" "$PTH" \
   && grep -q "enable --now updater.path" "$CALLS"; then
  pass "S4 linux path unit (.service + .path DirectoryNotEmpty)"
else
  fail "S4 path render: svc=$(cat "$SVC" 2>/dev/null) pth=$(cat "$PTH" 2>/dev/null) | calls: $(cat "$CALLS")"
fi

# ── S5: darwinOnly skipped on linux ──
: > "$CALLS"; rm -rf "$UNIT_DIR"
SPEC='{"name":"cmux-watcher","kind":"service","exec":"/bin/bash x","darwinOnly":true}'
sup systemd-user supervisor_install "$SPEC" >/dev/null 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ ! -f "$UNIT_DIR/cmux-watcher.service" ] && ! grep -q "cmux-watcher" "$CALLS"; then
  pass "S5 darwinOnly unit skipped on linux"
else
  fail "S5 darwinOnly: rc=$RC, unit present? $(ls "$UNIT_DIR" 2>/dev/null), calls: $(cat "$CALLS")"
fi

# ── S6: linux lifecycle dispatch ──
: > "$CALLS"
sup systemd-user supervisor_start "flywheel-bridge" "service" >/dev/null 2>&1
sup systemd-user supervisor_stop "flywheel-bridge" "service" >/dev/null 2>&1
sup systemd-user supervisor_is_loaded "flywheel-bridge" "service" >/dev/null 2>&1
if grep -q "systemctl --user start flywheel-bridge.service" "$CALLS" \
   && grep -q "systemctl --user stop flywheel-bridge.service" "$CALLS" \
   && grep -q "systemctl --user is-active flywheel-bridge.service" "$CALLS"; then
  pass "S6 linux lifecycle → systemctl --user"
else
  fail "S6 linux lifecycle calls: $(cat "$CALLS")"
fi

# ── S7: darwin lifecycle dispatch → launchctl ──
: > "$CALLS"
sup launchd supervisor_restart "bridge" "service" >/dev/null 2>&1
sup launchd supervisor_is_loaded "bridge" "service" >/dev/null 2>&1
if grep -q "launchctl kickstart -k gui/$(id -u)/com.flywheel.bridge" "$CALLS" \
   && grep -q "launchctl print gui/$(id -u)/com.flywheel.bridge" "$CALLS"; then
  pass "S7 darwin lifecycle → launchctl gui/<uid>/com.flywheel.<name>"
else
  fail "S7 darwin lifecycle calls: $(cat "$CALLS")"
fi

echo ""
echo "================================="
echo "supervisor.test: $PASSED passed, $FAILED failed"
echo "================================="
[ "$FAILED" -eq 0 ]

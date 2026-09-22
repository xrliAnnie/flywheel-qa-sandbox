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
SPEC='{"name":"updater","kind":"path","exec":"/bin/bash /opt/fw/scripts/update-flywheel.sh","watch":["/opt/state/self-ship-urgent.d"]}'
sup systemd-user supervisor_install "$SPEC" >/dev/null 2>&1
SVC="$UNIT_DIR/updater.service"; PTH="$UNIT_DIR/updater.path"
if [ -f "$SVC" ] && [ -f "$PTH" ] \
   && grep -q "DirectoryNotEmpty=/opt/state/self-ship-urgent.d" "$PTH" \
   && grep -q "enable --now updater.path" "$CALLS"; then
  pass "S4 linux path unit (.service + .path DirectoryNotEmpty)"
else
  fail "S4 path render: svc=$(cat "$SVC" 2>/dev/null) pth=$(cat "$PTH" 2>/dev/null) | calls: $(cat "$CALLS")"
fi

# ── S3b: bounded interval timer + explicit trigger ──
: > "$CALLS"; rm -rf "$UNIT_DIR"
SPEC='{"name":"interval-worker","kind":"timer","exec":"/bin/bash /opt/fw/scripts/interval-worker-once.sh","intervalSeconds":60,"timeoutSeconds":60}'
sup systemd-user supervisor_install "$SPEC" >/dev/null 2>&1
SVC="$UNIT_DIR/interval-worker.service"; TMR="$UNIT_DIR/interval-worker.timer"
sup systemd-user supervisor_trigger "interval-worker" "timer" >/dev/null 2>&1
if grep -q "TimeoutStartSec=60" "$SVC" \
   && grep -q "OnBootSec=60s" "$TMR" \
   && grep -q "OnUnitActiveSec=60s" "$TMR" \
   && grep -q "systemctl --user start interval-worker.service" "$CALLS"; then
  pass "S3b bounded interval timer renders and triggers its oneshot service"
else
  fail "S3b interval timer: svc=$(cat "$SVC" 2>/dev/null) tmr=$(cat "$TMR" 2>/dev/null) calls=$(cat "$CALLS")"
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

# ── S8–S11: darwin real install must not bootstrap a label launchd is still
# tearing down (FLY-2758: bootout → immediate bootstrap returned EIO and left
# Raya with no carrier). A stateful launchctl stub models launchd: after
# `bootout` the label stays visible for TEARDOWN_TICKS `print` calls, then
# reports "Could not find service"; `bootstrap` fails with EIO while the label
# is still present.
LD_STUB="$SANDBOX/ld-stubbin"; mkdir -p "$LD_STUB"
LD_STATE="$SANDBOX/ld-state"; mkdir -p "$LD_STATE"
cat > "$LD_STUB/launchctl" <<'EOF'
#!/bin/bash
echo "launchctl $*" >> "$LD_CALLS"
verb="$1"
case "$verb" in
  print)
    label="${2##*/}"
    if [ -e "$LD_STATE/absent.$label" ]; then
      echo "Could not find service \"$label\" in domain for user gui: $(id -u)" >&2
      exit 113
    fi
    if [ -e "$LD_STATE/teardown.$label" ]; then
      left="$(cat "$LD_STATE/teardown.$label")"
      if [ "$left" -le 1 ]; then
        rm -f "$LD_STATE/teardown.$label"; touch "$LD_STATE/absent.$label"
        echo "Could not find service \"$label\" in domain for user gui: $(id -u)" >&2
        exit 113
      fi
      echo $((left - 1)) > "$LD_STATE/teardown.$label"
    fi
    printf '%s\n' "$label = {" '	state = running' '	pid = 4321' '}'
    exit 0 ;;
  bootout)
    label="${2##*/}"
    ticks="$(cat "$LD_STATE/teardown_ticks" 2>/dev/null || echo 0)"
    if [ "$ticks" -gt 0 ]; then echo "$ticks" > "$LD_STATE/teardown.$label"; else touch "$LD_STATE/absent.$label"; fi
    exit 0 ;;
  bootstrap)
    label="$(basename "$3" .plist)"
    if [ -e "$LD_STATE/bootstrap_fail_always" ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2; exit 5
    fi
    if [ ! -e "$LD_STATE/absent.$label" ] && [ ! -e "$LD_STATE/bootstrap_ignore_presence" ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2; exit 5
    fi
    rm -f "$LD_STATE/absent.$label" "$LD_STATE/teardown.$label"
    exit 0 ;;
esac
exit 0
EOF
chmod +x "$LD_STUB/launchctl"
LD_CALLS="$SANDBOX/ld-calls.log"
LD_DIR="$SANDBOX/ld-launchd"
ld_install() { # <spec> [env assignments...]
  local spec="$1"; shift
  env "$@" LD_CALLS="$LD_CALLS" LD_STATE="$LD_STATE" \
      FLYWHEEL_SUPERVISOR_BACKEND=launchd FLYWHEEL_LAUNCHD_DIR="$LD_DIR" \
      FLYWHEEL_SUPERVISOR_DARWIN_INSTALL=1 \
      FLYWHEEL_SUPERVISOR_LAUNCHD_POLL_INTERVAL=0 \
      PATH="$LD_STUB:$PATH" HOME="$HOME" \
      bash -c 'set -uo pipefail; source "'"$LIB"'" || exit 97; supervisor_install "$1"' _ "$spec"
}
ld_reset() { rm -rf "$LD_STATE"; mkdir -p "$LD_STATE"; : > "$LD_CALLS"; }
LD_SPEC='{"name":"lead.demo-demo","kind":"service","exec":"/bin/bash /x/flywheel-lead.sh /x/manifest.json","keepAlive":true,"throttleInterval":30,"stdout":"/tmp/lead.log"}'
LD_LABEL="com.flywheel.lead.demo-demo"

# S8: label lingers for two polls after bootout; bootstrap happens exactly once,
# only after launchd reports the label gone, and never sees EIO.
ld_reset; echo 2 > "$LD_STATE/teardown_ticks"
S8_ERR="$(ld_install "$LD_SPEC" 2>&1 >/dev/null)"; S8_RC=$?
S8_EXPECTED="launchctl bootout gui/$(id -u)/$LD_LABEL
launchctl print gui/$(id -u)/$LD_LABEL
launchctl print gui/$(id -u)/$LD_LABEL
launchctl bootstrap gui/$(id -u) $LD_DIR/$LD_LABEL.plist"
if [ "$S8_RC" -eq 0 ] && [ "$(cat "$LD_CALLS")" = "$S8_EXPECTED" ] \
   && ! grep -q "Input/output error" <<<"$S8_ERR"; then
  pass "S8 darwin install waits for launchd to drop the label before bootstrap"
else
  fail "S8 rc=$S8_RC calls=[$(cat "$LD_CALLS")] err=[$S8_ERR]"
fi

# S9: the label never leaves; the wait is bounded, warns, and still hands the
# decision to bootstrap instead of failing without an attempt.
ld_reset; echo 99 > "$LD_STATE/teardown_ticks"; touch "$LD_STATE/bootstrap_ignore_presence"
S9_ERR="$(ld_install "$LD_SPEC" FLYWHEEL_SUPERVISOR_BOOTOUT_WAIT_ATTEMPTS=3 2>&1 >/dev/null)"; S9_RC=$?
if [ "$S9_RC" -eq 0 ] \
   && [ "$(grep -c "^launchctl print " "$LD_CALLS")" -eq 3 ] \
   && [ "$(grep -c "^launchctl bootstrap " "$LD_CALLS")" -eq 1 ] \
   && grep -q "still loaded after bootout" <<<"$S9_ERR"; then
  pass "S9 darwin install bounds the post-bootout wait and still attempts bootstrap"
else
  fail "S9 rc=$S9_RC calls=[$(cat "$LD_CALLS")] err=[$S9_ERR]"
fi

# S10: bootstrap keeps failing; retries are bounded and the error text callers
# already match on ("bootstrap failed: <label>") is preserved.
ld_reset; touch "$LD_STATE/bootstrap_fail_always"
S10_ERR="$(ld_install "$LD_SPEC" FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS=3 2>&1 >/dev/null)"; S10_RC=$?
if [ "$S10_RC" -ne 0 ] \
   && [ "$(grep -c "^launchctl bootstrap " "$LD_CALLS")" -eq 3 ] \
   && grep -q "bootstrap failed: $LD_LABEL" <<<"$S10_ERR" \
   && grep -q "Input/output error" <<<"$S10_ERR"; then
  pass "S10 darwin install retries bootstrap a bounded number of times"
else
  fail "S10 rc=$S10_RC calls=[$(cat "$LD_CALLS")] err=[$S10_ERR]"
fi

# S11: invalid tuning values fall back to defaults (label already gone, so the
# defaults finish immediately) and are reported rather than silently accepted.
ld_reset
S11_ERR="$(ld_install "$LD_SPEC" FLYWHEEL_SUPERVISOR_BOOTOUT_WAIT_ATTEMPTS=abc FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS=0 2>&1 >/dev/null)"; S11_RC=$?
if [ "$S11_RC" -eq 0 ] \
   && [ "$(grep -c "^launchctl bootstrap " "$LD_CALLS")" -eq 1 ] \
   && grep -q "FLYWHEEL_SUPERVISOR_BOOTOUT_WAIT_ATTEMPTS" <<<"$S11_ERR" \
   && grep -q "FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS" <<<"$S11_ERR"; then
  pass "S11 darwin install rejects invalid wait tuning and keeps the defaults"
else
  fail "S11 rc=$S11_RC calls=[$(cat "$LD_CALLS")] err=[$S11_ERR]"
fi

echo ""
echo "================================="
echo "supervisor.test: $PASSED passed, $FAILED failed"
echo "================================="
[ "$FAILED" -eq 0 ]

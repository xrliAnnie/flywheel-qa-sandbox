#!/usr/bin/env bash
# FLY-2446: standalone voice launch boundary and restart classification.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WRAPPER="$REPO_ROOT/scripts/flywheel-voice-wrapper.sh"
PLIST="$REPO_ROOT/scripts/launchd/com.flywheel.voice.plist"
MANIFEST="$REPO_ROOT/scripts/launchd/units.manifest"
RESTART="$REPO_ROOT/scripts/restart-services.sh"
RESTART_LIB="$REPO_ROOT/scripts/lib/restart-voice.sh"

[[ -f "$WRAPPER" ]] && pass "wrapper exists" || fail "wrapper missing"
[[ -f "$PLIST" ]] && pass "plist exists" || fail "plist missing"
[[ -f "$RESTART_LIB" ]] && pass "restart helper exists" || fail "restart helper missing"
if [[ -f "$WRAPPER" ]] && bash -n "$WRAPPER"; then pass "wrapper parses"; else fail "wrapper syntax"; fi

check_wrapper() {
  if [[ -f "$WRAPPER" ]] && grep -qE "$2" "$WRAPPER"; then pass "$1"; else fail "$1"; fi
}
check_wrapper "strict mode" '^set -euo pipefail'
check_wrapper "host config" 'host_config_load'
check_wrapper "dotenv export" '^set -a'
check_wrapper "host gate" 'HOST_TMUX_GATE_BIN.*gate voice'
check_wrapper "host receipt verification" 'HOST_TMUX_GATE_BIN.*verify voice'
check_wrapper "restart storm gate" 'RESTART_STORM_GATE_BIN.*gate voice'
check_wrapper "pid guard" 'voice\.pid'
check_wrapper "built daemon exec" '^exec node packages/voice-codex/dist/cli\.js'

if [[ -f "$PLIST" ]] && grep -q '<key>SuccessfulExit</key><false/>' "$PLIST"; then
  pass "plist restarts only crashes"
else
  fail "plist SuccessfulExit false"
fi
if [[ -f "$PLIST" ]] && grep -q '<key>ThrottleInterval</key>' "$PLIST"; then pass "plist throttles"; else fail "plist throttle"; fi
if grep -Fq $'com.flywheel.voice\tcom.flywheel.voice.plist\thold\t0\t' "$MANIFEST"; then pass "manifest holds voice"; else fail "manifest hold row"; fi
if grep -q 'packages/voice-codex/\*.*_restart_voice=true' "$RESTART" \
  && grep -q 'scripts/flywheel-voice-wrapper\.sh.*_restart_voice=true' "$RESTART"; then
  pass "restart classifier owns voice changes"
else
  fail "restart classifier voice patterns"
fi

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/repo/scripts/lib" "$ROOT/repo/packages/voice-codex/dist" \
  "$ROOT/state" "$ROOT/home/.local/bin"
if [[ -f "$WRAPPER" ]]; then cp "$WRAPPER" "$ROOT/repo/scripts/flywheel-voice-wrapper.sh"; fi
cat > "$ROOT/repo/scripts/lib/host-config.sh" <<'EOF'
host_config_load() { return 0; }
EOF
cat > "$ROOT/host-gate" <<'EOF'
#!/bin/bash
printf '%s %s|%s|%s|%s\n' "$1" "$2" "$FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION" "$FLYWHEEL_HOST_TMUX_MOUNT_POINT" "$FLYWHEEL_HOST_TMUX_TARGET_SHA" >> "$TEST_ROOT/host-calls"
EOF
cat > "$ROOT/restart-gate" <<'EOF'
#!/bin/bash
printf '%s %s\n' "$1" "$2" >> "$TEST_ROOT/restart-calls"
EOF
cat > "$ROOT/home/.local/bin/node" <<'EOF'
#!/bin/bash
if [[ -n "${FLYWHEEL_TEST_INHERITED_SENTINEL:-}" ]]; then
  touch "$TEST_ROOT/inherited-variable-leaked"
  exit 55
fi
printf '%s\n' "$*" >> "$TEST_ROOT/node-calls"
if [[ "${TEST_NODE_FAIL_CHECK:-0}" == "1" && "$*" == *"--check-config"* ]]; then exit 1; fi
EOF
cat > "$ROOT/meta-alert" <<'EOF'
#!/bin/bash
printf '%s\n' "$1" >> "$TEST_ROOT/alert-calls"
EOF
cat > "$ROOT/repo/scripts/lib/bounded-run.sh" <<'EOF'
#!/bin/bash
shift
exec "$@"
EOF
chmod +x "$ROOT/meta-alert" "$ROOT/repo/scripts/lib/bounded-run.sh"
chmod +x "$ROOT/host-gate" "$ROOT/restart-gate" "$ROOT/home/.local/bin/node"
: > "$ROOT/repo/packages/voice-codex/dist/cli.js"
printf 'TEAMLEAD_API_TOKEN=test-only\n' > "$ROOT/state/.env"

# Adversarial inherited host settings must never reach a wrapper subprocess.
# These are all fixtures: even the RED regression cannot touch production.
mkdir -p "$ROOT/inherited-repo" "$ROOT/inherited-state"
printf 'printf read > "%s"\n' "$ROOT/inherited-env-read" > "$ROOT/inherited-state/.env"
export FLYWHEEL_DIR="$ROOT/inherited-repo" FLYWHEEL_STATE_DIR="$ROOT/inherited-state"
export FLYWHEEL_TEST_INHERITED_SENTINEL=must-not-reach-wrapper

if [[ -f "$ROOT/repo/scripts/flywheel-voice-wrapper.sh" ]] && \
  env -i TEST_ROOT="$ROOT" HOME="$ROOT/home" PATH="/usr/bin:/bin" \
  FLYWHEEL_META_ALERT_BIN="$ROOT/meta-alert" \
  FLYWHEEL_DIR="$ROOT/repo" FLYWHEEL_STATE_DIR="$ROOT/state" \
  FLYWHEEL_HOST_TMUX_GATE_BIN="$ROOT/host-gate" \
  FLYWHEEL_RESTART_STORM_GATE_BIN="$ROOT/restart-gate" \
  bash "$ROOT/repo/scripts/flywheel-voice-wrapper.sh" >/dev/null 2>&1; then
  if grep -q '^gate voice|keepalive:voice|scripts/flywheel-voice-wrapper.sh|' "$ROOT/host-calls" \
    && grep -q '^verify voice|keepalive:voice|scripts/flywheel-voice-wrapper.sh|' "$ROOT/host-calls" \
    && grep -qx 'gate voice' "$ROOT/restart-calls" \
    && grep -qx 'packages/voice-codex/dist/cli.js --check-config' "$ROOT/node-calls" \
    && grep -qx 'packages/voice-codex/dist/cli.js' "$ROOT/node-calls"; then
    pass "wrapper executes both host receipts, restart brake, and daemon"
  else
    fail "wrapper gate execution"
  fi
else
  fail "wrapper happy path"
fi

mkdir -p "$ROOT/bootstrap/scripts/lib" "$ROOT/configured-repo/packages/voice-codex/dist" \
  "$ROOT/configured-state"
cp "$WRAPPER" "$ROOT/bootstrap/scripts/flywheel-voice-wrapper.sh"
cat > "$ROOT/bootstrap/scripts/lib/host-config.sh" <<'EOF'
host_config_load() {
  export FLYWHEEL_DIR="${FLYWHEEL_DIR:-$TEST_ROOT/configured-repo}"
  export FLYWHEEL_STATE_DIR="${FLYWHEEL_STATE_DIR:-$TEST_ROOT/configured-state}"
}
EOF
: > "$ROOT/configured-repo/packages/voice-codex/dist/cli.js"
printf 'TEAMLEAD_API_TOKEN=test-only\n' > "$ROOT/configured-state/.env"
: > "$ROOT/node-calls"
if env -i TEST_ROOT="$ROOT" HOME="$ROOT/home" PATH="/usr/bin:/bin" \
  FLYWHEEL_META_ALERT_BIN="$ROOT/meta-alert" \
  FLYWHEEL_HOST_TMUX_GATE_BIN="$ROOT/host-gate" \
  FLYWHEEL_RESTART_STORM_GATE_BIN="$ROOT/restart-gate" \
  bash "$ROOT/bootstrap/scripts/flywheel-voice-wrapper.sh" >/dev/null 2>&1 \
  && grep -qx 'packages/voice-codex/dist/cli.js --check-config' "$ROOT/node-calls" \
  && grep -qx 'packages/voice-codex/dist/cli.js' "$ROOT/node-calls"; then
  pass "host.json paths remain authoritative when no environment override exists"
else
  fail "host.json path precedence"
fi
if [[ ! -e "$ROOT/inherited-env-read" ]]; then
  pass "wrapper ignores inherited host dotenv"
else
  fail "wrapper sourced inherited host dotenv"
fi

: > "$ROOT/node-calls"
CONFIG_RC=0
env -i TEST_ROOT="$ROOT" TEST_NODE_FAIL_CHECK=1 HOME="$ROOT/home" PATH="/usr/bin:/bin" \
FLYWHEEL_META_ALERT_BIN="$ROOT/meta-alert" \
FLYWHEEL_DIR="$ROOT/repo" FLYWHEEL_STATE_DIR="$ROOT/state" \
FLYWHEEL_HOST_TMUX_GATE_BIN="$ROOT/host-gate" \
FLYWHEEL_RESTART_STORM_GATE_BIN="$ROOT/restart-gate" \
  bash "$ROOT/repo/scripts/flywheel-voice-wrapper.sh" >/dev/null 2>&1 || CONFIG_RC=$?
if [[ "$CONFIG_RC" -eq 0 ]] \
  && grep -qx 'packages/voice-codex/dist/cli.js --check-config' "$ROOT/node-calls" \
  && ! grep -qx 'packages/voice-codex/dist/cli.js' "$ROOT/node-calls"; then
  pass "invalid daemon config exits cleanly without a launchd restart storm"
else
  fail "invalid daemon config boundary"
fi
if [[ ! -e "$ROOT/inherited-variable-leaked" ]] \
  && [[ "$(cat "$ROOT/alert-calls" 2>/dev/null)" == voice_config_invalid ]]; then
  pass "wrapper subprocesses scrub inherited variables and record only the expected local alert"
else
  fail "wrapper environment isolation or local alert receipt"
fi

if [[ -f "$RESTART_LIB" ]]; then
  # shellcheck source=/dev/null
  source "$RESTART_LIB"
  supervisor_is_loaded() { return 1; }
  if output="$(restart_voice_managed 2>&1)" && grep -q 'not loaded.*no-op' <<<"$output"; then
    pass "unloaded voice restart is an explicit no-op"
  else
    fail "unloaded voice restart"
  fi
  supervisor_is_loaded() { return 0; }
  # Exercise the real predicate against the shipped plist, without launchctl.
  unset SUPERVISOR_SOURCED
  source "$REPO_ROOT/scripts/lib/supervisor.sh"
  supervisor_backend() { printf '%s\n' launchd; }
  supervisor_is_loaded() { return 0; }
  _sup_launchd_dir() { printf '%s\n' "$ROOT/launchd"; }
  mkdir -p "$ROOT/launchd"
  cp "$PLIST" "$ROOT/launchd/com.flywheel.voice.plist"
  if [[ "$(uname -s)" != Darwin ]]; then
    # Linux has no Apple plutil. Parse the actual XML; never stub the predicate.
    plutil() {
      python3 - "$2" "$6" <<'PY'
import plistlib, sys
try:
    value = plistlib.load(open(sys.argv[2], 'rb'))
    for key in sys.argv[1].split('.'):
        value = value[key]
    if isinstance(value, bool):
        print(str(value).lower())
    elif isinstance(value, dict):
        print('\n'.join(value))
    else:
        print(value)
except (OSError, KeyError, TypeError, ValueError):
    sys.exit(1)
PY
    }
  fi
  supervisor_restart() { printf '%s %s\n' "$1" "$2" > "$ROOT/supervisor-call"; }
  if restart_voice_managed >/dev/null 2>&1 && grep -qx 'voice service' "$ROOT/supervisor-call"; then
    pass "loaded voice unit restarts through supervisor"
  else
    fail "loaded voice restart"
  fi
  for policy in '<true/>' '<false/>' '<dict><key>SuccessfulExit</key><true/></dict>' '<dict/>'; do
    printf '<plist version="1.0"><dict><key>KeepAlive</key>%s</dict></plist>\n' "$policy" > "$ROOT/launchd/com.flywheel.voice.plist"
    rm -f "$ROOT/supervisor-call"
    if ! restart_voice_managed >/dev/null 2>&1 && [[ ! -f "$ROOT/supervisor-call" ]]; then
      pass "voice rejects incompatible restart policy $policy"
    else
      fail "voice accepted incompatible restart policy $policy"
    fi
  done
  cp "$PLIST" "$ROOT/launchd/com.flywheel.voice.plist"
  supervisor_restart() {
    printf '<plist version="1.0"><dict><key>KeepAlive</key><false/></dict></plist>\n' > "$ROOT/launchd/com.flywheel.voice.plist"
  }
  if ! restart_voice_managed >/dev/null 2>&1 && [[ "$VOICE_RESTART_DETAIL" == keepalive_contract_lost ]]; then
    pass "voice rechecks the policy after restart"
  else
    fail "voice failed to detect policy lost after restart"
  fi
  printf '<plist version="1.0"><dict><key>KeepAlive</key><true/></dict></plist>\n' > "$ROOT/launchd/com.flywheel.bridge.plist"
  if supervisor_assert_keepalive bridge; then pass "Bridge boolean policy preserved"; else fail "Bridge boolean policy changed"; fi
  cp "$PLIST" "$ROOT/launchd/com.flywheel.bridge.plist"
  if ! supervisor_assert_keepalive bridge; then pass "Bridge rejects crash-only policy"; else fail "Bridge policy weakened"; fi
fi

if [[ -f "$RESTART" ]]; then
  eval "$(sed -n '/^classify_changes() {$/,/^}$/p' "$RESTART")"
  CHANGED=$'packages/voice-codex/src/daemon.ts\nscripts/flywheel-voice-wrapper.sh'
  eval "$(classify_changes)"
  if [[ "$restart_voice" == "true" && "$restart_bridge" == "false" && "$restart_all_leads" == "false" ]]; then
    pass "voice-only changes classify without widening service scope"
  else
    fail "voice-only restart classification"
  fi
fi

echo
echo "[flywheel-voice-wrapper.test] passed=$PASSED failed=$FAILED"
[[ $FAILED -eq 0 ]] || exit 1

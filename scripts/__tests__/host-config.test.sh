#!/bin/bash
# FLY-650: host-config.sh — core/host config loader (D2=B core layer).
#
# Contract under test (plan §3.1):
#   - missing host.json  → documented defaults == today's hardcoded values
#                          (byte-compat: FLYWHEEL_DIR=$HOME/Dev/flywheel,
#                           stateDir=$HOME/.flywheel, skillsRepo=xrliAnnie/flywheel-skills,
#                           darwin→launchd/cmux, linux→systemd-user/tmux-only)
#   - present host.json  → fields applied
#   - malformed JSON / unknown backend / unknown viewer → FAIL-CLOSED (non-zero)
#   - env override       → wins over host.json (existing scripts' `${VAR:-default}` idiom)
#   - ~ path expansion   → expanded against $HOME
#   - leadEnablement     → absent/empty OK; non-empty → FAIL-LOUD (not implemented)
#
# Hermetic: fixture HOME = mktemp sandbox; no real ~/.flywheel touched. jq stubbed
# only if absent (we require jq like the rest of the toolchain).
set -uo pipefail

PASSED=0
FAILED=0
log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); log_test "✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="${REPO_ROOT}/scripts/lib/host-config.sh"
[ -f "$LIB" ] || { echo "ERROR: $LIB not found"; exit 1; }

SANDBOX="$(mktemp -d -t fly650-hostcfg-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

# Run host_config_load in a clean subshell with a fixture HOME + chosen platform,
# echo "<key>=<value>" lines for the resolved exports, and propagate the exit code.
# Args: <fixture-home> <platform-or-empty> [extra env assignments...]
run_load() {
  local home="$1" platform="$2"; shift 2
  env -i HOME="$home" PATH="$PATH" \
    ${platform:+FLYWHEEL_PLATFORM="$platform"} \
    "$@" \
    bash -c '
      set -uo pipefail
      source "'"$LIB"'" || exit 97
      host_config_load || exit $?
      echo "FLYWHEEL_DIR=$FLYWHEEL_DIR"
      echo "FLYWHEEL_STATE_DIR=$FLYWHEEL_STATE_DIR"
      echo "FLYWHEEL_SKILLS_REPO=$FLYWHEEL_SKILLS_REPO"
      echo "FLYWHEEL_SUPERVISOR_BACKEND=$FLYWHEEL_SUPERVISOR_BACKEND"
      echo "FLYWHEEL_PLATFORM=$FLYWHEEL_PLATFORM"
      echo "FLYWHEEL_VIEWER_BACKEND=$FLYWHEEL_VIEWER_BACKEND"
    '
}

field() { grep -E "^$1=" <<<"$2" | head -1 | sed -E "s/^$1=//"; }

# ── P1: missing host.json → defaults == today's hardcoded values (darwin) ──
H="$SANDBOX/h1"; mkdir -p "$H/.flywheel"
OUT="$(run_load "$H" "darwin")"; RC=$?
if [ "$RC" -eq 0 ] \
   && [ "$(field FLYWHEEL_DIR "$OUT")" = "$H/Dev/flywheel" ] \
   && [ "$(field FLYWHEEL_STATE_DIR "$OUT")" = "$H/.flywheel" ] \
   && [ "$(field FLYWHEEL_SKILLS_REPO "$OUT")" = "xrliAnnie/flywheel-skills" ] \
   && [ "$(field FLYWHEEL_SUPERVISOR_BACKEND "$OUT")" = "launchd" ] \
   && [ "$(field FLYWHEEL_VIEWER_BACKEND "$OUT")" = "cmux" ]; then
  pass "P1 missing host.json → darwin defaults == today's values"
else
  fail "P1 missing host.json defaults (rc=$RC): $OUT"
fi

# ── P2: missing host.json on linux → systemd-user / tmux-only defaults ──
H="$SANDBOX/h2"; mkdir -p "$H/.flywheel"
OUT="$(run_load "$H" "linux")"; RC=$?
if [ "$RC" -eq 0 ] \
   && [ "$(field FLYWHEEL_SUPERVISOR_BACKEND "$OUT")" = "systemd-user" ] \
   && [ "$(field FLYWHEEL_VIEWER_BACKEND "$OUT")" = "tmux-only" ] \
   && [ "$(field FLYWHEEL_PLATFORM "$OUT")" = "linux" ]; then
  pass "P2 missing host.json → linux defaults (systemd-user/tmux-only)"
else
  fail "P2 linux defaults (rc=$RC): $OUT"
fi

# ── P3: present host.json → fields applied ──
H="$SANDBOX/h3"; mkdir -p "$H/.flywheel"
cat > "$H/.flywheel/host.json" <<EOF
{ "platform": "linux", "supervisorBackend": "systemd-user",
  "flywheelDir": "/opt/fw/checkout", "stateDir": "/opt/fw/state",
  "skillsRepo": "someone/their-skills", "viewerBackend": "none" }
EOF
OUT="$(run_load "$H" "")"; RC=$?
if [ "$RC" -eq 0 ] \
   && [ "$(field FLYWHEEL_DIR "$OUT")" = "/opt/fw/checkout" ] \
   && [ "$(field FLYWHEEL_STATE_DIR "$OUT")" = "/opt/fw/state" ] \
   && [ "$(field FLYWHEEL_SKILLS_REPO "$OUT")" = "someone/their-skills" ] \
   && [ "$(field FLYWHEEL_SUPERVISOR_BACKEND "$OUT")" = "systemd-user" ] \
   && [ "$(field FLYWHEEL_VIEWER_BACKEND "$OUT")" = "none" ]; then
  pass "P3 present host.json → fields applied"
else
  fail "P3 fields applied (rc=$RC): $OUT"
fi

# ── P4: malformed JSON → fail-closed ──
H="$SANDBOX/h4"; mkdir -p "$H/.flywheel"
printf '{ this is not json' > "$H/.flywheel/host.json"
run_load "$H" "darwin" >/dev/null 2>&1
[ $? -ne 0 ] && pass "P4 malformed JSON → fail-closed" || fail "P4 malformed JSON should fail-closed"

# ── P5: unknown supervisorBackend → fail-closed ──
H="$SANDBOX/h5"; mkdir -p "$H/.flywheel"
echo '{ "supervisorBackend": "pm2-magic" }' > "$H/.flywheel/host.json"
run_load "$H" "linux" >/dev/null 2>&1
[ $? -ne 0 ] && pass "P5 unknown supervisorBackend → fail-closed" || fail "P5 unknown backend should fail-closed"

# ── P6: unknown viewerBackend → fail-closed ──
H="$SANDBOX/h6"; mkdir -p "$H/.flywheel"
echo '{ "viewerBackend": "hologram" }' > "$H/.flywheel/host.json"
run_load "$H" "darwin" >/dev/null 2>&1
[ $? -ne 0 ] && pass "P6 unknown viewerBackend → fail-closed" || fail "P6 unknown viewer should fail-closed"

# ── P7: env override wins over host.json ──
H="$SANDBOX/h7"; mkdir -p "$H/.flywheel"
echo '{ "flywheelDir": "/from/json" }' > "$H/.flywheel/host.json"
OUT="$(run_load "$H" "darwin" FLYWHEEL_DIR="/from/env")"; RC=$?
if [ "$RC" -eq 0 ] && [ "$(field FLYWHEEL_DIR "$OUT")" = "/from/env" ]; then
  pass "P7 env override wins over host.json"
else
  fail "P7 env override (rc=$RC): $OUT"
fi

# ── P8: ~ path expansion against HOME ──
H="$SANDBOX/h8"; mkdir -p "$H/.flywheel"
echo '{ "flywheelDir": "~/custom/fw" }' > "$H/.flywheel/host.json"
OUT="$(run_load "$H" "darwin")"; RC=$?
if [ "$RC" -eq 0 ] && [ "$(field FLYWHEEL_DIR "$OUT")" = "$H/custom/fw" ]; then
  pass "P8 ~ path expansion"
else
  fail "P8 ~ expansion (rc=$RC): $OUT"
fi

# ── P9: leadEnablement absent/empty OK; non-empty → fail-loud ──
H="$SANDBOX/h9a"; mkdir -p "$H/.flywheel"
echo '{ "leadEnablement": null }' > "$H/.flywheel/host.json"
run_load "$H" "darwin" >/dev/null 2>&1
[ $? -eq 0 ] && pass "P9a leadEnablement null → OK (today's behavior)" || fail "P9a null leadEnablement should be OK"

H="$SANDBOX/h9b"; mkdir -p "$H/.flywheel"
echo '{ "leadEnablement": { "flywheel-cos-lead": false } }' > "$H/.flywheel/host.json"
run_load "$H" "darwin" >/dev/null 2>&1
[ $? -ne 0 ] && pass "P9b non-empty leadEnablement → fail-loud (not implemented)" || fail "P9b non-empty leadEnablement should fail-loud"

# ── P10: non-string scalar field → fail-closed (Codex R1 MED) ──
H="$SANDBOX/h10a"; mkdir -p "$H/.flywheel"
echo '{ "flywheelDir": {} }' > "$H/.flywheel/host.json"
run_load "$H" "darwin" >/dev/null 2>&1
[ $? -ne 0 ] && pass "P10a flywheelDir:{} (object) → fail-closed" || fail "P10a non-string flywheelDir should fail-closed"

H="$SANDBOX/h10b"; mkdir -p "$H/.flywheel"
echo '{ "stateDir": 123 }' > "$H/.flywheel/host.json"
run_load "$H" "darwin" >/dev/null 2>&1
[ $? -ne 0 ] && pass "P10b stateDir:123 (number) → fail-closed" || fail "P10b non-string stateDir should fail-closed"

echo ""
echo "================================="
echo "host-config.test: $PASSED passed, $FAILED failed"
echo "================================="
[ "$FAILED" -eq 0 ]

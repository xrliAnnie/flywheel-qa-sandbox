#!/bin/bash
# FLY-650: reverse-compat sentinel for wrapper host-config wiring (Codex R1#3).
#
# The Bridge + Lead launch wrappers now source host-config.sh. This sentinel
# guarantees that with NO host.json (the deployed reality), every path the
# wrappers resolve is BYTE-IDENTICAL to the pre-FLY-650 hardcoded value — so the
# live macOS fleet cannot regress. It checks both halves:
#   (1) dynamic: host_config_load with no host.json → today's FLYWHEEL_DIR/STATE
#   (2) the wrappers' own resolution expressions evaluate to today's paths
#   (3) static: the byte-compat default forms are present (sync guard)
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HC="${REPO_ROOT}/scripts/lib/host-config.sh"
BW="${REPO_ROOT}/scripts/flywheel-bridge-wrapper.sh"
LW="${REPO_ROOT}/scripts/flywheel-lead-wrapper.sh"

SANDBOX="$(mktemp -d -t fly650-revcompat-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
H="$SANDBOX/home"; mkdir -p "$H/.flywheel"   # NO host.json

# (1)+(2): in a clean subshell with no host.json, source host-config + evaluate
# the EXACT resolution expressions the wrappers use, then print them.
OUT="$(env -i HOME="$H" PATH="$PATH" bash -c '
  set -uo pipefail
  source "'"$HC"'"
  host_config_load || exit 9
  # bridge-wrapper resolution:
  FLYWHEEL_DIR="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
  FLYWHEEL_STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
  ENV_FILE="${FLYWHEEL_STATE_DIR}/.env"
  PID_FILE="${FLYWHEEL_STATE_DIR}/pids/bridge.pid"
  STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state"
  echo "DIR=$FLYWHEEL_DIR"
  echo "ENV=$ENV_FILE"
  echo "PID=$PID_FILE"
  echo "STATE=$STATE_DIR"
')" || { echo "host_config_load failed"; OUT=""; }

g() { grep -E "^$1=" <<<"$OUT" | sed -E "s/^$1=//"; }
if [ "$(g DIR)" = "$H/Dev/flywheel" ] \
   && [ "$(g ENV)" = "$H/.flywheel/.env" ] \
   && [ "$(g PID)" = "$H/.flywheel/pids/bridge.pid" ] \
   && [ "$(g STATE)" = "$H/.flywheel/state" ]; then
  pass "bridge-wrapper paths byte-identical with no host.json"
else
  fail "bridge-wrapper paths drifted: $OUT"
fi

# (3) static sync guards — the byte-compat forms must remain in the wrappers.
grep -q 'FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state' "$BW" \
  && pass "bridge-wrapper keeps reconciled /state form" \
  || fail "bridge-wrapper /state form changed (byte-compat risk)"
grep -q 'ENV_FILE="${FLYWHEEL_STATE_DIR}/.env"' "$BW" \
  && pass "bridge-wrapper ENV_FILE under state root" \
  || fail "bridge-wrapper ENV_FILE form changed"
grep -q 'FLYWHEEL_DIR:-${HOME}/Dev/flywheel}' "$LW" \
  && pass "lead-wrapper keeps FLYWHEEL_DIR default" \
  || fail "lead-wrapper FLYWHEEL_DIR default changed"
grep -q 'host-config.sh' "$BW" && grep -q 'host-config.sh' "$LW" \
  && pass "both wrappers source host-config" \
  || fail "a wrapper stopped sourcing host-config"

# (4) Codex R1 HIGH-2: malformed host.json → wrappers fail-closed (exit non-zero).
BAD="$SANDBOX/badhome"; mkdir -p "$BAD/.flywheel"; printf '{ not valid json' > "$BAD/.flywheel/host.json"
env -i HOME="$BAD" PATH="$PATH" bash "$BW" >/dev/null 2>&1
[ $? -ne 0 ] && pass "bridge-wrapper fail-closed on malformed host.json" || fail "bridge-wrapper should fail-closed"
env -i HOME="$BAD" PATH="$PATH" bash "$LW" "$SANDBOX/dummy-manifest.json" >/dev/null 2>&1
[ $? -ne 0 ] && pass "lead-wrapper fail-closed on malformed host.json" || fail "lead-wrapper should fail-closed"

# (5) Codex R1 MED-1: lead-wrapper resolves .env/pids under FLYWHEEL_STATE_DIR.
LW_OUT="$(env -i HOME="$H" PATH="$PATH" bash -c '
  source "'"$HC"'"; host_config_load || exit 9
  FLYWHEEL_STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
  echo "ENV=${FLYWHEEL_WRAPPER_ENV_FILE:-${FLYWHEEL_STATE_DIR}/.env}"
  echo "PID=${FLYWHEEL_WRAPPER_PID_DIR:-${FLYWHEEL_STATE_DIR}/pids}"
')"
if [ "$(grep -E '^ENV=' <<<"$LW_OUT" | sed -E 's/^ENV=//')" = "$H/.flywheel/.env" ] \
   && [ "$(grep -E '^PID=' <<<"$LW_OUT" | sed -E 's/^PID=//')" = "$H/.flywheel/pids" ]; then
  pass "lead-wrapper .env/pids under state root (byte-identical, no host.json)"
else
  fail "lead-wrapper state-dir resolution: $LW_OUT"
fi
grep -q 'FLYWHEEL_WRAPPER_ENV_FILE:-${FLYWHEEL_STATE_DIR}/.env' "$LW" \
  && pass "lead-wrapper ENV_FILE under FLYWHEEL_STATE_DIR" \
  || fail "lead-wrapper ENV_FILE not under state root"

# syntax
bash -n "$BW" && pass "bridge-wrapper syntax ok" || fail "bridge-wrapper syntax"
bash -n "$LW" && pass "lead-wrapper syntax ok" || fail "lead-wrapper syntax"

echo ""
echo "wrapper-host-config-revcompat.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]

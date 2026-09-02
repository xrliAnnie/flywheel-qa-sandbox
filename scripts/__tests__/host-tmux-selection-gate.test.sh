#!/bin/bash
# FLY-2190: host-tmux-selection-gate.sh public CLI contract.
# Hermetic: every filesystem path and observation is fixture-owned. Production
# overrides are accepted only while FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; shift; [ "$#" -eq 0 ] || echo "        $*"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/host-tmux-selection-gate.sh"
SANDBOX="$(mktemp -d -t fly2190-host-tmux-gate-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }

VALID_ROOT="$SANDBOX/valid"
VALID_HOME="$VALID_ROOT/home"
VALID_BIN="$VALID_ROOT/opt-homebrew/Cellar/tmux/3.7c/bin"
VALID_CANONICAL="$VALID_BIN/tmux"
mkdir -p "$VALID_HOME" "$VALID_BIN" "$VALID_ROOT/tools"

printf '%s\n' '#!/bin/bash' 'printf "tmux 3.7c\n"' > "$VALID_CANONICAL"
chmod +x "$VALID_CANONICAL"
ln -s "$VALID_CANONICAL" "$VALID_ROOT/tools/tmux"
printf '%s\n' '#!/bin/bash' 'printf "%s: Mach-O 64-bit executable arm64\n" "$1"' \
  > "$VALID_ROOT/tools/file"
chmod +x "$VALID_ROOT/tools/file"
VALID_CANONICAL_RESOLVED="$(readlink -f "$VALID_CANONICAL")"

VALID_STATE="$VALID_ROOT/state-root"
VALID_SHA="0123456789abcdef0123456789abcdef01234567"
VALID_OUT="$VALID_ROOT/out.log"
VALID_ERR="$VALID_ROOT/err.log"
VALID_RC=0

LEGACY_ONLY_APPLICABILITY_RC=0
env -i \
  HOME="$VALID_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$VALID_ROOT/applicability-state" \
  FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
  bash "$GATE" test-applicability \
    "$VALID_ROOT/missing-marker" "$VALID_CANONICAL" "$VALID_ROOT/missing-native" \
    >"$VALID_ROOT/applicability.out" 2>"$VALID_ROOT/applicability.err" \
    || LEGACY_ONLY_APPLICABILITY_RC=$?
if [ "$LEGACY_ONLY_APPLICABILITY_RC" -eq 0 ] \
  && [ "$(cat "$VALID_ROOT/applicability.out")" = "required" ]; then
  pass "legacy-only unmarked hosts remain subject to the selection gate"
else
  fail "legacy-only applicability contract (rc=$LEGACY_ONLY_APPLICABILITY_RC)" \
    "$(cat "$VALID_ROOT/applicability.err" 2>/dev/null)"
fi

printf 'required\n' > "$VALID_ROOT/existing-marker"
APPLICABILITY_MATRIX_RC=0
for expected_and_paths in \
  "required|$VALID_ROOT/existing-marker|$VALID_ROOT/missing-legacy|$VALID_ROOT/missing-native" \
  "required|$VALID_ROOT/missing-marker|$VALID_ROOT/missing-legacy|$VALID_CANONICAL" \
  "not-applicable|$VALID_ROOT/missing-marker|$VALID_ROOT/missing-legacy|$VALID_ROOT/missing-native"; do
  IFS='|' read -r expected marker legacy native <<<"$expected_and_paths"
  actual="$(env -i \
    HOME="$VALID_HOME" \
    PATH="/usr/bin:/bin" \
    FLYWHEEL_STATE_DIR="$VALID_ROOT/applicability-state" \
    FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
    bash "$GATE" test-applicability "$marker" "$legacy" "$native" \
    2>"$VALID_ROOT/applicability-matrix.err")" || APPLICABILITY_MATRIX_RC=$?
  [ "$actual" = "$expected" ] || APPLICABILITY_MATRIX_RC=1
done
if [ "$APPLICABILITY_MATRIX_RC" -eq 0 ]; then
  pass "applicability resolver covers marker, native, and clean hosts"
else
  fail "applicability resolver matrix" \
    "$(cat "$VALID_ROOT/applicability-matrix.err" 2>/dev/null)"
fi

PRODUCTION_APPLICABILITY_RC=0
env -i \
  HOME="$VALID_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$VALID_ROOT/production-applicability-state" \
  bash "$GATE" test-applicability \
    "$VALID_ROOT/existing-marker" "$VALID_CANONICAL" "$VALID_CANONICAL" \
    >"$VALID_ROOT/production-applicability.out" \
    2>"$VALID_ROOT/production-applicability.err" \
    || PRODUCTION_APPLICABILITY_RC=$?
if [ "$PRODUCTION_APPLICABILITY_RC" -ne 0 ] \
  && grep -Fq "test-applicability is test-only" \
    "$VALID_ROOT/production-applicability.err" \
  && [ ! -e "$VALID_ROOT/production-applicability-state" ]; then
  pass "production mode rejects the applicability fixture action before probing state"
else
  fail "production applicability action was reachable (rc=$PRODUCTION_APPLICABILITY_RC)" \
    "$(cat "$VALID_ROOT/production-applicability.err" 2>/dev/null)"
fi

NON_TEMP_APPLICABILITY_RC=0
env -i \
  HOME="/Users/flywheel-fixture" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="/Users/flywheel-fixture/.flywheel" \
  FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
  bash "$GATE" test-applicability \
    "$VALID_ROOT/existing-marker" "$VALID_CANONICAL" "$VALID_CANONICAL" \
    >"$VALID_ROOT/non-temp-applicability.out" \
    2>"$VALID_ROOT/non-temp-applicability.err" \
    || NON_TEMP_APPLICABILITY_RC=$?
if [ "$NON_TEMP_APPLICABILITY_RC" -ne 0 ] \
  && grep -Fq "test mode requires a temporary isolated FLYWHEEL_STATE_DIR" \
    "$VALID_ROOT/non-temp-applicability.err"; then
  pass "applicability fixtures require a temporary test state root"
else
  fail "non-temporary applicability fixture root was accepted (rc=$NON_TEMP_APPLICABILITY_RC)" \
    "$(cat "$VALID_ROOT/non-temp-applicability.err" 2>/dev/null)"
fi

env -i \
  HOME="$VALID_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$VALID_STATE" \
  FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
  FLYWHEEL_HOST_TMUX_POST_S1_PATH="$VALID_ROOT/tools:/usr/bin:/bin" \
  FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH="$VALID_CANONICAL_RESOLVED" \
  FLYWHEEL_HOST_TMUX_FILE_BIN="$VALID_ROOT/tools/file" \
  FLYWHEEL_HOST_TMUX_HOST_ID="fixture-host" \
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$VALID_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:bridge" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-bridge-wrapper.sh" \
  FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH=1000 \
  FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS=300 \
  bash "$GATE" gate bridge >"$VALID_OUT" 2>"$VALID_ERR" || VALID_RC=$?

VALID_RECEIPT_DIR="$VALID_STATE/state/host-tmux"
VALID_RECEIPT="$VALID_RECEIPT_DIR/bridge.json"
if [ "$VALID_RC" -eq 0 ] \
  && [ -f "$VALID_RECEIPT" ] \
  && [ "$(mode_of "$VALID_RECEIPT_DIR")" = "700" ] \
  && [ "$(mode_of "$VALID_RECEIPT")" = "600" ] \
  && jq -e \
    --arg path "$VALID_ROOT/tools/tmux" \
    --arg canonical "$VALID_CANONICAL_RESOLVED" \
    --arg sha "$VALID_SHA" \
    '.schemaVersion == 1
      and .hostId == "fixture-host"
      and .targetSha == $sha
      and .generatedAt == 1000
      and .expiresAt == 1300
      and .boundTransaction == "keepalive:bridge"
      and .selectedPath == $path
      and .canonicalPath == $canonical
      and .tmuxVersion == "tmux 3.7c"
      and (.architecture | contains("arm64"))
      and .verdict == "pass"
      and .carrier == "bridge"
      and .mountPoint == "scripts/flywheel-bridge-wrapper.sh"' \
    "$VALID_RECEIPT" >/dev/null; then
  pass "valid 3.7c arm64 selection emits a carrier-bound receipt in a private directory"
else
  fail "valid selection receipt contract (rc=$VALID_RC mode=$(mode_of "$VALID_RECEIPT" 2>/dev/null || true))" \
    "$(cat "$VALID_ERR" 2>/dev/null)"
fi

INTEL_ROOT="$SANDBOX/intel"
INTEL_CANONICAL="$INTEL_ROOT/Cellar/tmux/3.5a/bin/tmux"
mkdir -p "$(dirname "$INTEL_CANONICAL")" "$INTEL_ROOT/tools"
printf '%s\n' '#!/bin/bash' 'printf "tmux 3.5a\n"' > "$INTEL_CANONICAL"
chmod +x "$INTEL_CANONICAL"
ln -s "$INTEL_CANONICAL" "$INTEL_ROOT/tools/tmux"
printf '%s\n' '#!/bin/bash' 'printf "%s: Mach-O 64-bit executable x86_64\n" "$1"' \
  > "$INTEL_ROOT/tools/file"
chmod +x "$INTEL_ROOT/tools/file"
INTEL_RC=0
env -i \
  HOME="$VALID_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$INTEL_ROOT/state" \
  FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
  FLYWHEEL_HOST_TMUX_POST_S1_PATH="$INTEL_ROOT/tools:/usr/bin:/bin" \
  FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH="$(readlink -f "$INTEL_CANONICAL")" \
  FLYWHEEL_HOST_TMUX_FILE_BIN="$INTEL_ROOT/tools/file" \
  FLYWHEEL_HOST_TMUX_HOST_ID="fixture-host" \
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$VALID_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:bridge" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-bridge-wrapper.sh" \
  FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH=1000 \
  FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS=300 \
  bash "$GATE" gate bridge >"$INTEL_ROOT/out" 2>"$INTEL_ROOT/err" || INTEL_RC=$?
if [ "$INTEL_RC" -ne 0 ] \
  && grep -Fq "selected tmux version is not tmux 3.7c: tmux 3.5a" "$INTEL_ROOT/err"; then
  pass "Intel tmux 3.5a is a fail-closed positive control"
else
  fail "Intel tmux 3.5a was accepted (rc=$INTEL_RC)" \
    "$(cat "$INTEL_ROOT/err" 2>/dev/null)"
fi

UNIVERSAL_ROOT="$SANDBOX/universal"
UNIVERSAL_CANONICAL="$UNIVERSAL_ROOT/Cellar/tmux/3.7c/bin/tmux"
mkdir -p "$(dirname "$UNIVERSAL_CANONICAL")" "$UNIVERSAL_ROOT/tools"
printf '%s\n' '#!/bin/bash' 'printf "tmux 3.7c\n"' > "$UNIVERSAL_CANONICAL"
chmod +x "$UNIVERSAL_CANONICAL"
ln -s "$UNIVERSAL_CANONICAL" "$UNIVERSAL_ROOT/tools/tmux"
printf '%s\n' '#!/bin/bash' 'printf "%s: Mach-O universal binary with 2 architectures: [x86_64] [arm64]\n" "$1"' \
  > "$UNIVERSAL_ROOT/tools/file"
chmod +x "$UNIVERSAL_ROOT/tools/file"
UNIVERSAL_RC=0
env -i \
  HOME="$VALID_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$UNIVERSAL_ROOT/state" \
  FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
  FLYWHEEL_HOST_TMUX_POST_S1_PATH="$UNIVERSAL_ROOT/tools:/usr/bin:/bin" \
  FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH="$(readlink -f "$UNIVERSAL_CANONICAL")" \
  FLYWHEEL_HOST_TMUX_FILE_BIN="$UNIVERSAL_ROOT/tools/file" \
  FLYWHEEL_HOST_TMUX_HOST_ID="fixture-host" \
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$VALID_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:bridge" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-bridge-wrapper.sh" \
  FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH=1000 \
  FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS=300 \
  bash "$GATE" gate bridge >"$UNIVERSAL_ROOT/out" \
    2>"$UNIVERSAL_ROOT/err" || UNIVERSAL_RC=$?
if [ "$UNIVERSAL_RC" -ne 0 ] \
  && grep -Fq "selected tmux unexpectedly contains x86_64" \
    "$UNIVERSAL_ROOT/err"; then
  pass "universal tmux with an x86_64 slice is rejected fail closed"
else
  fail "universal tmux was accepted (rc=$UNIVERSAL_RC)" \
    "$(cat "$UNIVERSAL_ROOT/err" 2>/dev/null)"
fi

DEFAULT_CANONICAL_RC=0
env -i \
  HOME="$VALID_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$VALID_ROOT/default-canonical-state" \
  FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
  FLYWHEEL_HOST_TMUX_POST_S1_PATH="$VALID_ROOT/tools:/usr/bin:/bin" \
  FLYWHEEL_HOST_TMUX_FILE_BIN="$VALID_ROOT/tools/file" \
  FLYWHEEL_HOST_TMUX_HOST_ID="fixture-host" \
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$VALID_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:bridge" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-bridge-wrapper.sh" \
  FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH=1000 \
  FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS=300 \
  bash "$GATE" gate bridge >"$VALID_ROOT/default-canonical.out" \
    2>"$VALID_ROOT/default-canonical.err" || DEFAULT_CANONICAL_RC=$?
if [ "$DEFAULT_CANONICAL_RC" -ne 0 ] \
  && grep -Fq "/opt/homebrew/Cellar/tmux/3.7c/bin/tmux" \
    "$VALID_ROOT/default-canonical.err"; then
  pass "shipped canonical default is the native tmux 3.7c Cellar path"
else
  fail "native canonical default was not enforced (rc=$DEFAULT_CANONICAL_RC)" \
    "$(cat "$VALID_ROOT/default-canonical.err" 2>/dev/null)"
fi

CROSS_CARRIER_RC=0
env -i \
  HOME="$VALID_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$VALID_STATE" \
  FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
  FLYWHEEL_HOST_TMUX_POST_S1_PATH="$VALID_ROOT/tools:/usr/bin:/bin" \
  FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH="$VALID_CANONICAL_RESOLVED" \
  FLYWHEEL_HOST_TMUX_FILE_BIN="$VALID_ROOT/tools/file" \
  FLYWHEEL_HOST_TMUX_HOST_ID="fixture-host" \
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$VALID_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:lead" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-lead-wrapper-v2.sh" \
  FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH=1001 \
  FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS=300 \
  bash "$GATE" verify lead >"$VALID_ROOT/cross-carrier.out" \
    2>"$VALID_ROOT/cross-carrier.err" || CROSS_CARRIER_RC=$?

if [ "$CROSS_CARRIER_RC" -ne 0 ] \
  && grep -Fq "selection receipt is missing" "$VALID_ROOT/cross-carrier.err"; then
  pass "one carrier cannot verify another carrier's receipt"
else
  fail "cross-carrier receipt was accepted (rc=$CROSS_CARRIER_RC)" \
    "$(cat "$VALID_ROOT/cross-carrier.err" 2>/dev/null)"
fi

HOST_MISMATCH_RECEIPT="$VALID_ROOT/host-mismatch.json"
jq '.hostId = "other-host"' "$VALID_RECEIPT" > "$HOST_MISMATCH_RECEIPT"
mv "$HOST_MISMATCH_RECEIPT" "$VALID_RECEIPT"
chmod 600 "$VALID_RECEIPT"

HOST_MISMATCH_RC=0
env -i \
  HOME="$VALID_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$VALID_STATE" \
  FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
  FLYWHEEL_HOST_TMUX_POST_S1_PATH="$VALID_ROOT/tools:/usr/bin:/bin" \
  FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH="$VALID_CANONICAL_RESOLVED" \
  FLYWHEEL_HOST_TMUX_FILE_BIN="$VALID_ROOT/tools/file" \
  FLYWHEEL_HOST_TMUX_HOST_ID="fixture-host" \
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$VALID_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:bridge" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-bridge-wrapper.sh" \
  FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH=1100 \
  FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS=300 \
  bash "$GATE" verify bridge >"$VALID_ROOT/host-mismatch.out" \
    2>"$VALID_ROOT/host-mismatch.err" || HOST_MISMATCH_RC=$?

if [ "$HOST_MISMATCH_RC" -ne 0 ] \
  && grep -Fq "receipt host does not match current host" "$VALID_ROOT/host-mismatch.err"; then
  pass "host-mismatched receipt fails closed"
else
  fail "host-mismatched receipt was accepted (rc=$HOST_MISMATCH_RC)" \
    "$(cat "$VALID_ROOT/host-mismatch.err" 2>/dev/null)"
fi

EXPIRED_TMP="$VALID_ROOT/expired.json"
jq '.hostId = "fixture-host" | .expiresAt = 1099' "$VALID_RECEIPT" > "$EXPIRED_TMP"
mv "$EXPIRED_TMP" "$VALID_RECEIPT"
chmod 600 "$VALID_RECEIPT"

EXPIRED_RC=0
env -i \
  HOME="$VALID_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$VALID_STATE" \
  FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
  FLYWHEEL_HOST_TMUX_POST_S1_PATH="$VALID_ROOT/tools:/usr/bin:/bin" \
  FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH="$VALID_CANONICAL_RESOLVED" \
  FLYWHEEL_HOST_TMUX_FILE_BIN="$VALID_ROOT/tools/file" \
  FLYWHEEL_HOST_TMUX_HOST_ID="fixture-host" \
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$VALID_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:bridge" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-bridge-wrapper.sh" \
  FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH=1100 \
  FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS=300 \
  bash "$GATE" verify bridge >"$VALID_ROOT/expired.out" \
    2>"$VALID_ROOT/expired.err" || EXPIRED_RC=$?

if [ "$EXPIRED_RC" -ne 0 ] \
  && grep -Fq "selection receipt has expired" "$VALID_ROOT/expired.err"; then
  pass "expired receipt fails closed"
else
  fail "expired receipt was accepted (rc=$EXPIRED_RC)" \
    "$(cat "$VALID_ROOT/expired.err" 2>/dev/null)"
fi

SHA_MISMATCH_TMP="$VALID_ROOT/sha-mismatch.json"
jq '.expiresAt = 1300 | .targetSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' \
  "$VALID_RECEIPT" > "$SHA_MISMATCH_TMP"
mv "$SHA_MISMATCH_TMP" "$VALID_RECEIPT"
chmod 600 "$VALID_RECEIPT"

SHA_MISMATCH_RC=0
env -i \
  HOME="$VALID_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$VALID_STATE" \
  FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
  FLYWHEEL_HOST_TMUX_POST_S1_PATH="$VALID_ROOT/tools:/usr/bin:/bin" \
  FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH="$VALID_CANONICAL_RESOLVED" \
  FLYWHEEL_HOST_TMUX_FILE_BIN="$VALID_ROOT/tools/file" \
  FLYWHEEL_HOST_TMUX_HOST_ID="fixture-host" \
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$VALID_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:bridge" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-bridge-wrapper.sh" \
  FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH=1100 \
  FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS=300 \
  bash "$GATE" verify bridge >"$VALID_ROOT/sha-mismatch.out" \
    2>"$VALID_ROOT/sha-mismatch.err" || SHA_MISMATCH_RC=$?

if [ "$SHA_MISMATCH_RC" -ne 0 ] \
  && grep -Fq "receipt target SHA does not match deployed SHA" "$VALID_ROOT/sha-mismatch.err"; then
  pass "target-SHA-mismatched receipt fails closed"
else
  fail "target-SHA-mismatched receipt was accepted (rc=$SHA_MISMATCH_RC)" \
    "$(cat "$VALID_ROOT/sha-mismatch.err" 2>/dev/null)"
fi

PAYLOAD_MISMATCH_TMP="$VALID_ROOT/payload-mismatch.json"
jq --arg sha "$VALID_SHA" \
  '.targetSha = $sha | .verdict = "fail"' "$VALID_RECEIPT" \
  > "$PAYLOAD_MISMATCH_TMP"
mv "$PAYLOAD_MISMATCH_TMP" "$VALID_RECEIPT"
chmod 600 "$VALID_RECEIPT"

PAYLOAD_MISMATCH_RC=0
env -i \
  HOME="$VALID_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$VALID_STATE" \
  FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
  FLYWHEEL_HOST_TMUX_POST_S1_PATH="$VALID_ROOT/tools:/usr/bin:/bin" \
  FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH="$VALID_CANONICAL_RESOLVED" \
  FLYWHEEL_HOST_TMUX_FILE_BIN="$VALID_ROOT/tools/file" \
  FLYWHEEL_HOST_TMUX_HOST_ID="fixture-host" \
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$VALID_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:bridge" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-bridge-wrapper.sh" \
  FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH=1100 \
  FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS=300 \
  bash "$GATE" verify bridge >"$VALID_ROOT/payload-mismatch.out" \
    2>"$VALID_ROOT/payload-mismatch.err" || PAYLOAD_MISMATCH_RC=$?

if [ "$PAYLOAD_MISMATCH_RC" -ne 0 ] \
  && grep -Fq "selection receipt payload does not match the current probe" \
    "$VALID_ROOT/payload-mismatch.err"; then
  pass "tampered selection receipt payload fails closed"
else
  fail "tampered selection receipt payload was accepted (rc=$PAYLOAD_MISMATCH_RC)" \
    "$(cat "$VALID_ROOT/payload-mismatch.err" 2>/dev/null)"
fi

rm -f "$VALID_RECEIPT"
MISSING_RC=0
env -i \
  HOME="$VALID_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$VALID_STATE" \
  FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
  FLYWHEEL_HOST_TMUX_POST_S1_PATH="$VALID_ROOT/tools:/usr/bin:/bin" \
  FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH="$VALID_CANONICAL_RESOLVED" \
  FLYWHEEL_HOST_TMUX_FILE_BIN="$VALID_ROOT/tools/file" \
  FLYWHEEL_HOST_TMUX_HOST_ID="fixture-host" \
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$VALID_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:bridge" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-bridge-wrapper.sh" \
  FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH=1100 \
  FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS=300 \
  bash "$GATE" verify bridge >"$VALID_ROOT/missing.out" \
    2>"$VALID_ROOT/missing.err" || MISSING_RC=$?

if [ "$MISSING_RC" -ne 0 ] \
  && grep -Fq "selection receipt is missing" "$VALID_ROOT/missing.err"; then
  pass "missing receipt fails closed"
else
  fail "missing receipt was accepted (rc=$MISSING_RC)" \
    "$(cat "$VALID_ROOT/missing.err" 2>/dev/null)"
fi

SHADOW_BIN="$VALID_HOME/.local/bin"
mkdir -p "$SHADOW_BIN"
printf '%s\n' '#!/bin/bash' 'printf "tmux 3.5a\n"' > "$SHADOW_BIN/tmux"
chmod +x "$SHADOW_BIN/tmux"
SHADOW_RC=0
env -i \
  HOME="$VALID_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$VALID_ROOT/shadow-state" \
  FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
  FLYWHEEL_HOST_TMUX_POST_S1_PATH="$SHADOW_BIN:$VALID_ROOT/tools:/usr/bin:/bin" \
  FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH="$VALID_CANONICAL_RESOLVED" \
  FLYWHEEL_HOST_TMUX_FILE_BIN="$VALID_ROOT/tools/file" \
  FLYWHEEL_HOST_TMUX_HOST_ID="fixture-host" \
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$VALID_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:bridge" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-bridge-wrapper.sh" \
  FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH=1100 \
  FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS=300 \
  bash "$GATE" gate bridge >"$VALID_ROOT/shadow.out" \
    2>"$VALID_ROOT/shadow.err" || SHADOW_RC=$?

if [ "$SHADOW_RC" -ne 0 ] \
  && grep -Fq "post-S1 PATH selected unexpected tmux" "$VALID_ROOT/shadow.err"; then
  pass "user-bin tmux shadow fails closed"
else
  fail "user-bin tmux shadow was accepted (rc=$SHADOW_RC)" \
    "$(cat "$VALID_ROOT/shadow.err" 2>/dev/null)"
fi

INVALID_SHA="01234567zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
INVALID_SHA_RC=0
env -i \
  HOME="$VALID_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$VALID_ROOT/invalid-sha-state" \
  FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
  FLYWHEEL_HOST_TMUX_POST_S1_PATH="$VALID_ROOT/tools:/usr/bin:/bin" \
  FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH="$VALID_CANONICAL_RESOLVED" \
  FLYWHEEL_HOST_TMUX_FILE_BIN="$VALID_ROOT/tools/file" \
  FLYWHEEL_HOST_TMUX_HOST_ID="fixture-host" \
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$INVALID_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:bridge" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-bridge-wrapper.sh" \
  FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH=1100 \
  FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS=300 \
  bash "$GATE" gate bridge >"$VALID_ROOT/invalid-sha.out" \
    2>"$VALID_ROOT/invalid-sha.err" || INVALID_SHA_RC=$?

if [ "$INVALID_SHA_RC" -ne 0 ] \
  && grep -Fq "FLYWHEEL_HOST_TMUX_TARGET_SHA must contain 40 hex characters" \
    "$VALID_ROOT/invalid-sha.err"; then
  pass "target SHA rejects non-hex characters outside the prefix"
else
  fail "non-hex target SHA was accepted (rc=$INVALID_SHA_RC)" \
    "$(cat "$VALID_ROOT/invalid-sha.err" 2>/dev/null)"
fi

NOT_APPLICABLE_STATE="$VALID_ROOT/not-applicable-state"
NOT_APPLICABLE_RC=0
for action in gate verify; do
  env -i \
    HOME="$VALID_HOME" \
    PATH="/usr/bin:/bin" \
    FLYWHEEL_STATE_DIR="$NOT_APPLICABLE_STATE" \
    FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
    FLYWHEEL_HOST_TMUX_GATE_APPLICABILITY=not-applicable \
    bash "$GATE" "$action" portable-host \
      >>"$VALID_ROOT/not-applicable.out" \
      2>>"$VALID_ROOT/not-applicable.err" || NOT_APPLICABLE_RC=$?
done
if [ "$NOT_APPLICABLE_RC" -eq 0 ] \
  && grep -Fq "not applicable" "$VALID_ROOT/not-applicable.out" \
  && [ ! -e "$NOT_APPLICABLE_STATE/state/host-tmux/portable-host.json" ]; then
  pass "hosts without the legacy Intel tmux layout bypass the host-specific gate"
else
  fail "non-target portable host was held (rc=$NOT_APPLICABLE_RC)" \
    "$(cat "$VALID_ROOT/not-applicable.err" 2>/dev/null)"
fi

BREAK_GLASS_STATE="$VALID_ROOT/break-glass-state"
BREAK_GLASS_DIR="$BREAK_GLASS_STATE/state/host-tmux"
mkdir -p "$BREAK_GLASS_DIR"
printf '%s\n' "$VALID_CANONICAL_RESOLVED" > "$BREAK_GLASS_DIR/required"
printf '%s\n' \
  'disabledUntil=1100' \
  'reason=founder-approved-s1-cutover' \
  > "$BREAK_GLASS_DIR/break-glass"
chmod 600 "$BREAK_GLASS_DIR/break-glass"
BREAK_GLASS_RC=0
for action in gate verify; do
  env -i \
    HOME="$VALID_HOME" \
    PATH="/usr/bin:/bin" \
    FLYWHEEL_STATE_DIR="$BREAK_GLASS_STATE" \
    FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
    FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH=1000 \
    bash "$GATE" "$action" lead \
      >>"$VALID_ROOT/break-glass.out" \
      2>>"$VALID_ROOT/break-glass.err" || BREAK_GLASS_RC=$?
done
if [ "$BREAK_GLASS_RC" -eq 0 ] \
  && [ "$(grep -Fc "BREAK-GLASS active carrier=lead" "$VALID_ROOT/break-glass.err")" -eq 2 ] \
  && [ ! -e "$BREAK_GLASS_DIR/lead.json" ]; then
  pass "bounded break-glass authorizes an explicit S1 cutover without a stale receipt"
else
  fail "bounded break-glass did not authorize both gate actions (rc=$BREAK_GLASS_RC)" \
    "$(cat "$VALID_ROOT/break-glass.err" 2>/dev/null)"
fi

printf '%s\n' \
  'disabledUntil=999' \
  'reason=expired-cutover-window' \
  > "$BREAK_GLASS_DIR/break-glass"
chmod 600 "$BREAK_GLASS_DIR/break-glass"
EXPIRED_BREAK_GLASS_RC=0
env -i \
  HOME="$VALID_HOME" \
  PATH="/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$BREAK_GLASS_STATE" \
  FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
  FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH=1000 \
  bash "$GATE" gate lead \
    >"$VALID_ROOT/expired-break-glass.out" \
    2>"$VALID_ROOT/expired-break-glass.err" || EXPIRED_BREAK_GLASS_RC=$?
if [ "$EXPIRED_BREAK_GLASS_RC" -ne 0 ] \
  && grep -Fq "break-glass authorization has expired" \
    "$VALID_ROOT/expired-break-glass.err"; then
  pass "expired break-glass fails closed"
else
  fail "expired break-glass was not rejected (rc=$EXPIRED_BREAK_GLASS_RC)" \
    "$(cat "$VALID_ROOT/expired-break-glass.err" 2>/dev/null)"
fi

echo ""
echo "host-tmux-selection-gate: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ] || exit 1

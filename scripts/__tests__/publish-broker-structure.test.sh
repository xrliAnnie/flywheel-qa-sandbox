#!/bin/bash
# FLY-1062 broker PR · publish-broker STRUCTURE lint — greppable contracts
# that must survive future edits (same posture as the release workflow lint):
#
#   S1  the broker's publish-release executor is ZERO BUILD: no packer, no
#       version injection, no child processes, no tree comparison — the
#       founder approved a sha256, nothing may be rebuilt behind it;
#   S2  publish-shell verifies the staged tarball BEFORE any registry call
#       (broker-side authoritative gate ordering);
#   S3  the wire layer scrubs BOTH outward token envs (they must never ride
#       into a child spawn), and does so INDEPENDENTLY of the feature flag;
#   S4  the broker is default-OFF (flag literal present in the wire guard);
#   S5  no production file under publish-broker/ ever logs a token value
#       (no template interpolation of the token variables).
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BROKER_DIR="$ROOT/packages/teamlead/src/bridge/publish-broker"
COMMIT_FILE="$BROKER_DIR/release-commit.ts"
SHELL_FILE="$BROKER_DIR/shell-publish.ts"
WIRE_FILE="$BROKER_DIR/wire.ts"

# ── S1 · zero-build commit path ──────────────────────────────────────────────
if grep -qE "child_process|execFile|spawn\(|PO_RELEASE_VERSION|package-onboard|proveEquivalence|untar" "$COMMIT_FILE"; then
  fail "S1 release-commit.ts contains build/packer/child-process tokens (ZERO BUILD violated)"
else
  pass "S1 release-commit.ts is zero-build (no packer / version-injection / child processes)"
fi
grep -q "ZERO BUILD" "$COMMIT_FILE" \
  && pass "S1b the zero-build contract marker is present" \
  || fail "S1b zero-build contract marker missing from release-commit.ts"

# ── S2 · verify-before-publish ordering ──────────────────────────────────────
VERIFY_LINE="$(grep -n "verifyShellTarball(" "$SHELL_FILE" | head -1 | cut -d: -f1)"
PUBLISH_LINE="$(grep -n "publishTarball(" "$SHELL_FILE" | grep -v import | head -1 | cut -d: -f1)"
if [ -n "$VERIFY_LINE" ] && [ -n "$PUBLISH_LINE" ] && [ "$VERIFY_LINE" -lt "$PUBLISH_LINE" ]; then
  pass "S2 publish-shell verifies the staged tarball before any registry publish"
else
  fail "S2 ordering broken (verify@$VERIFY_LINE publish@$PUBLISH_LINE)"
fi

# ── S3 · token env scrub, independent of the flag ────────────────────────────
if grep -q "delete env\[CUSTOMER_RELEASE_TOKEN_ENV\]" "$WIRE_FILE" \
   && grep -q "delete env\[NPM_GAT_TOKEN_ENV\]" "$WIRE_FILE"; then
  pass "S3a wire scrubs both outward token envs"
else
  fail "S3a token env scrub missing from wire.ts"
fi
SCRUB_LINE="$(grep -n "readAndScrubPublishTokens(args.env)" "$WIRE_FILE" | head -1 | cut -d: -f1)"
FLAG_LINE="$(grep -n 'FLYWHEEL_PUBLISH_BROKER !== "1"' "$WIRE_FILE" | head -1 | cut -d: -f1)"
if [ -n "$SCRUB_LINE" ] && [ -n "$FLAG_LINE" ] && [ "$SCRUB_LINE" -lt "$FLAG_LINE" ]; then
  pass "S3b scrub happens BEFORE the feature-flag early return (disabled still scrubs)"
else
  fail "S3b scrub/flag ordering broken (scrub@$SCRUB_LINE flag@$FLAG_LINE)"
fi

# ── S4 · default OFF ─────────────────────────────────────────────────────────
grep -q 'FLYWHEEL_PUBLISH_BROKER !== "1"' "$WIRE_FILE" \
  && pass "S4 broker is default-OFF (explicit =1 opt-in)" \
  || fail "S4 default-off guard missing"

# ── S5 · token values only ever reach the Authorization header ───────────────
# the ONE legitimate interpolation is building a Bearer header; any other
# string interpolation of a token variable (a log line, an error message, a
# URL) is a leak.
LEAKS="$(grep -rn '\${token}\|\${npmGatToken}\|\${customerReleaseToken}\|\${opts.token}' \
  "$BROKER_DIR" --include='*.ts' | grep -v __tests__ | grep -iv "authorization" || true)"
if [ -z "$LEAKS" ]; then
  pass "S5 token values are interpolated ONLY into Authorization headers, never logs/errors/URLs"
else
  fail "S5 token interpolation outside the Authorization header: $LEAKS"
fi

# ── S6 · the calibrated fleet secret net is WIRED (shared, not re-ported) ────
VERIFY_FILE="$BROKER_DIR/shell-verify.ts"
if grep -q "scan_code_tree_for_secrets" "$VERIFY_FILE" \
   && grep -q "fleet-sanitize.sh" "$VERIFY_FILE"; then
  pass "S6 shell-verify shares the calibrated fleet secret scanner"
else
  fail "S6 calibrated scanner wiring missing from shell-verify.ts"
fi

echo "RESULTS: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1

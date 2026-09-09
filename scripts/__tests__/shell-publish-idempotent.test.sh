#!/bin/bash
# FLY-2388 · exact workflow dataflow under a local registry stub. No publish is
# invoked: an already-identical artifact must make the workflow guard skip it.
set -uo pipefail

PASSED=0; FAILED=0; STUB_PID=""
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER="$ROOT/scripts/release/shell-publish-helper.mjs"
PREFLIGHT="$ROOT/scripts/release/shell-publish-preflight.sh"
STUB="$ROOT/scripts/__tests__/fixtures/shell-registry-stub.mjs"
SANDBOX="$(mktemp -d -t fly2388-shell-idempotent-XXXXXX)"
cleanup() {
  [ -z "$STUB_PID" ] || { kill "$STUB_PID" 2>/dev/null || true; wait "$STUB_PID" 2>/dev/null || true; }
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

node "$HELPER" pack --out "$SANDBOX/pack" > "$SANDBOX/pack.json"
PACK_RC=$?
TARBALL="$(jq -r '.tarball // empty' "$SANDBOX/pack.json")"
SHA="$(jq -r '.sha // empty' "$SANDBOX/pack.json")"
VER="$(jq -r '.version // empty' "$SANDBOX/pack.json")"
TAG="$(jq -r '.tag // empty' "$SANDBOX/pack.json")"
if [ "$PACK_RC" -eq 0 ] && [ -f "$TARBALL" ] && [[ "$SHA" =~ ^[0-9a-f]{64}$ ]]; then
  pass "I1 pack emits one exact tarball tuple"
else
  fail "I1 pack failed or emitted an invalid tuple"
fi

if bash "$PREFLIGHT" --workflow >/dev/null 2>&1 \
   && node "$HELPER" gate "$TARBALL" >/dev/null 2>&1; then
  pass "I2 workflow preflight and exact-tarball content gate pass"
else
  fail "I2 workflow/content preflight failed"
fi

PORT_FILE="$SANDBOX/registry.port"
node "$STUB" "$TARBALL" "$PORT_FILE" "$VER" "$TAG" &
STUB_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$PORT_FILE" ] && break
  sleep 0.1
done
REGISTRY="$(cat "$PORT_FILE" 2>/dev/null || true)"
REG_OUT="$SANDBOX/reg.output"
GITHUB_OUTPUT="$REG_OUT" node "$HELPER" preflight "$TARBALL" \
  --expect-sha "$SHA" --expect-tag "$TAG" --registry "$REGISTRY" > "$SANDBOX/reg.json"
REG_RC=$?
OUTCOME="$(sed -n 's/^outcome=//p' "$REG_OUT")"
PUBLISH_CALLED=0
if [ "$OUTCOME" = "free" ]; then PUBLISH_CALLED=1; fi
if [ "$REG_RC" -eq 0 ] && [ "$OUTCOME" = "idempotent" ] && [ "$PUBLISH_CALLED" -eq 0 ]; then
  pass "I3 identical registry artifact returns idempotent and skips publish guard"
else
  fail "I3 idempotent rerun did not skip publish (rc=$REG_RC outcome=$OUTCOME)"
fi

VERIFY_OUT="$(FW_SHELL_VERIFY_ATTEMPTS=1 FW_SHELL_VERIFY_DELAY_MS=0 \
  node "$HELPER" verify "$TARBALL" --expect-sha "$SHA" --expect-tag "$TAG" --registry "$REGISTRY" 2>&1)"
VERIFY_RC=$?
if [ "$VERIFY_RC" -eq 0 ] && grep -q '"outcome":"verified"' <<<"$VERIFY_OUT"; then
  pass "I4 idempotent path still verifies registry sha and dist-tag"
else
  fail "I4 verify failed (rc=$VERIFY_RC): $VERIFY_OUT"
fi
kill "$STUB_PID" 2>/dev/null || true; wait "$STUB_PID" 2>/dev/null || true; STUB_PID=""

printf 'different registry bytes\n' > "$SANDBOX/different.tgz"
rm -f "$PORT_FILE"
node "$STUB" "$SANDBOX/different.tgz" "$PORT_FILE" "$VER" "$TAG" &
STUB_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$PORT_FILE" ] && break
  sleep 0.1
done
REGISTRY="$(cat "$PORT_FILE" 2>/dev/null || true)"
CONFLICT_OUT="$(node "$HELPER" preflight "$TARBALL" \
  --expect-sha "$SHA" --expect-tag "$TAG" --registry "$REGISTRY" 2>&1)"
CONFLICT_RC=$?
if [ "$CONFLICT_RC" -ne 0 ] && grep -q '"outcome":"conflict"' <<<"$CONFLICT_OUT"; then
  pass "I5 different registry bytes fail closed as conflict"
else
  fail "I5 registry conflict was not fatal (rc=$CONFLICT_RC): $CONFLICT_OUT"
fi

echo ""
echo "shell-publish-idempotent: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]

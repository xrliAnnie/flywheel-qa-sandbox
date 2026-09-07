#!/bin/bash
# FLY-2387 · the packaging bash and the ESM release contract consume the same
# derivation vectors. Bash remains standalone for hermetic packaging hosts.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PO="$ROOT/scripts/package-onboard.sh"
VECTORS="$ROOT/packages/release-contract/vectors/version-derivation.json"

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }
[ -f "$VECTORS" ] || { echo "ERROR: missing $VECTORS"; exit 1; }

PACKAGE_ONBOARD_SOURCED=1 source "$PO"

while IFS= read -r encoded; do
  vector="$(printf '%s' "$encoded" | base64 --decode)"
  input="$(printf '%s' "$vector" | jq -r '.input')"
  base="$(printf '%s' "$vector" | jq -r '.base')"
  kind="$(printf '%s' "$vector" | jq -r '.expect.kind')"

  if po_version_is_derivation "$base" "$input"; then
    actual="valid"
  else
    actual="invalid"
  fi
  expected="valid"
  [ "$kind" = "invalid" ] && expected="invalid"

  if [ "$actual" = "$expected" ]; then
    pass "vector $input ($kind)"
  else
    fail "vector $input expected $expected, got $actual"
  fi
done < <(jq -r '.[] | @base64' "$VECTORS")

SANDBOX="$(mktemp -d -t fly2387-version-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/doc"

for spec in "v1.56.0|1.56.0" " 1.56.0 |1.56.0"; do
  raw="${spec%%|*}"
  expected="${spec#*|}"
  printf '%s\n' "$raw" > "$SANDBOX/doc/VERSION"
  if actual="$(po_version "$SANDBOX")" && [ "$actual" = "$expected" ]; then
    pass "doc/VERSION normalizes '$raw'"
  else
    fail "doc/VERSION failed to normalize '$raw'"
  fi
done

for invalid in "vv1.56.0" "v1.56.0-beta.2" "1.56.0+build.1" "01.56.0" ""; do
  printf '%s\n' "$invalid" > "$SANDBOX/doc/VERSION"
  if po_version "$SANDBOX" >/dev/null 2>&1; then
    fail "doc/VERSION accepted invalid '$invalid'"
  else
    pass "doc/VERSION rejected invalid '$invalid'"
  fi
done

echo ""
echo "release-contract-vectors: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]

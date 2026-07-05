#!/bin/bash
# FLY-224 Phase 2 (CR #2): codex-lead.sh arg parsing must match claude-lead.sh's
# contract — reject bad lead-id / unknown flag / missing flag value with a
# non-zero exit BEFORE reaching the runtime exec (i.e. it fails at parse, not at
# the "runtime entrypoint missing" stage).
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_LEAD="${SCRIPT_DIR}/../codex-lead.sh"
[ -x "$CODEX_LEAD" ] || { echo "ERROR: codex-lead.sh not executable at $CODEX_LEAD"; exit 1; }

# CR Phase 2a R2 #2: fail-fast if temp dir can't be created (no silent all-pass).
TMP="$(mktemp -d -t fly224-args-XXXXXX)" || { echo "FATAL: mktemp failed"; exit 1; }
[ -d "$TMP" ] || { echo "FATAL: temp dir not created"; exit 1; }
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/project"

# Returns the exit code + first stderr line; never reaches the runtime for these.
run() { out=$(bash "$CODEX_LEAD" "$@" 2>&1); echo "$?|$out"; }

# bad lead-id (leading hyphen) → reject
r=$(run -- "$TMP/project" proj); code=${r%%|*}
if [ "$code" -ne 0 ] && printf '%s' "$r" | grep -qi "Invalid lead-id"; then
  pass "rejects bad lead-id (leading hyphen)"
else fail "bad lead-id should be rejected (got: $r)"; fi

# uppercase lead-id → reject
r=$(run BadLead "$TMP/project" proj); code=${r%%|*}
if [ "$code" -ne 0 ] && printf '%s' "$r" | grep -qi "Invalid lead-id"; then
  pass "rejects uppercase lead-id"
else fail "uppercase lead-id should be rejected (got: $r)"; fi

# unknown flag → reject
r=$(run good-lead "$TMP/project" proj --nope); code=${r%%|*}
if [ "$code" -ne 0 ] && printf '%s' "$r" | grep -qi "Unknown flag"; then
  pass "rejects unknown flag"
else fail "unknown flag should be rejected (got: $r)"; fi

# --subdir missing value → reject
r=$(run good-lead "$TMP/project" proj --subdir); code=${r%%|*}
if [ "$code" -ne 0 ] && printf '%s' "$r" | grep -qi "subdir requires"; then
  pass "rejects --subdir without a value"
else fail "--subdir missing value should be rejected (got: $r)"; fi

# extra positional after project-name → reject
r=$(run good-lead "$TMP/project" proj extra); code=${r%%|*}
if [ "$code" -ne 0 ] && printf '%s' "$r" | grep -qi "Unexpected argument"; then
  pass "rejects an extra positional argument"
else fail "extra positional should be rejected (got: $r)"; fi

echo ""
echo "[codex-lead-args] passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]

#!/bin/bash
# FLY-954: unit tests for scripts/lib/script-sanity.sh — the shared sanity +
# atomic-install helpers every legitimate <state>/bin writer must use.
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../lib/script-sanity.sh
source "$REPO_ROOT/scripts/lib/script-sanity.sh"

SB="$(mktemp -d -t fly954-sanity-XXXXXX)"; trap 'rm -rf "$SB"' EXIT

# S1: the incident's 12-byte stub is rejected
echo '#!/bin/bash' > "$SB/stub.sh"
if ! assert_sane_script_source "$SB/stub.sh" 2>/dev/null; then
  pass "S1: 12-byte shebang-only stub rejected"
else fail "S1: stub accepted"; fi

# S2: comment-only file (large enough) is rejected
{ echo '#!/bin/bash'; for i in $(seq 1 200); do echo "# padding comment line $i"; done; } > "$SB/comments.sh"
if ! assert_sane_script_source "$SB/comments.sh" 2>/dev/null; then
  pass "S2: comment-only file rejected (no substantive lines)"
else fail "S2: comment-only accepted"; fi

# S3: a real script passes
{ echo '#!/bin/bash'; echo 'set -euo pipefail'; for i in $(seq 1 100); do echo "echo real-line-$i >/dev/null"; done; } > "$SB/real.sh"
if assert_sane_script_source "$SB/real.sh"; then
  pass "S3: real script accepted"
else fail "S3: real script rejected"; fi

# S4: missing source rejected
if ! assert_sane_script_source "$SB/nope.sh" 2>/dev/null; then
  pass "S4: missing source rejected"
else fail "S4: missing source accepted"; fi

# S5: install_script_atomic installs with mode 555 (write-protected)
mkdir -p "$SB/bin"
if install_script_atomic "$SB/real.sh" "$SB/bin/real.sh" && [ -f "$SB/bin/real.sh" ] && [ ! -w "$SB/bin/real.sh" ] && [ -x "$SB/bin/real.sh" ]; then
  pass "S5: atomic install lands read-only + executable"
else fail "S5: atomic install"; ls -l "$SB/bin"; fi

# S6: write-protection proof — the incident's bare cp now fails loudly
if ! cp "$SB/stub.sh" "$SB/bin/real.sh" 2>/dev/null; then
  pass "S6: bare cp over installed copy fails (EACCES) — incident shape blocked"
else fail "S6: bare cp overwrote a protected install"; fi

# S7: re-install over a protected copy succeeds (mv is not blocked by target perms)
if install_script_atomic "$SB/real.sh" "$SB/bin/real.sh"; then
  pass "S7: legitimate re-install over 555 copy succeeds (idempotent)"
else fail "S7: re-install blocked"; fi

# S8: degenerate source NEVER installs (dst untouched)
before="$(shasum -a 256 "$SB/bin/real.sh" | awk '{print $1}')"
if ! install_script_atomic "$SB/stub.sh" "$SB/bin/real.sh" 2>/dev/null \
   && [ "$(shasum -a 256 "$SB/bin/real.sh" | awk '{print $1}')" = "$before" ]; then
  pass "S8: stub source refused, existing install untouched"
else fail "S8: stub source installed or dst mutated"; fi

# S9 (Codex R1#4): the floor must NOT be weakenable via inherited env
if ! FLYWHEEL_SCRIPT_MIN_BYTES=1 bash -c "source '$REPO_ROOT/scripts/lib/script-sanity.sh'; assert_sane_script_source '$SB/stub.sh'" 2>/dev/null; then
  pass "S9: FLYWHEEL_SCRIPT_MIN_BYTES env is ignored (stub still rejected)"
else fail "S9: inherited env weakened the sanity floor"; fi

echo ""; echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1

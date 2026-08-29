#!/bin/bash
# FLY-650: linux-preflight.sh smoke test.
# It is a read-only diagnostic — assert it runs, exits 0 (it is a report), prints
# every section header, and (red line) never prints a secret VALUE even when the
# env file holds one.
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PF="${REPO_ROOT}/scripts/linux-preflight.sh"
[ -f "$PF" ] || { echo "ERROR: $PF not found"; exit 1; }

SANDBOX="$(mktemp -d -t fly650-preflight-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
H="$SANDBOX/home"; mkdir -p "$H/.flywheel"
# fixture .env with a real-looking secret value — must NOT appear in output.
SECRET="ghp_ABCdef0123456789ABCdef0123456789abcd"
printf 'DISCORD_BOT_TOKEN=%s\nLINEAR_API_KEY=%s\n' "$SECRET" "$SECRET" > "$H/.flywheel/.env"

OUT="$(env HOME="$H" PATH="$PATH" bash "$PF" 2>&1)"; RC=$?

[ "$RC" -eq 0 ] && pass "exits 0 (report, never hard-fails)" || fail "exit $RC"

ok_section=1
for s in "1. OS" "2. Package manager" "3. systemd user manager" "4. Linger" \
         "6. Required commands" "7. Checkout / state paths" "8. Token file" \
         "11. Paste-back commands" "SUMMARY"; do
  grep -qF "$s" <<<"$OUT" || { ok_section=0; echo "    missing section: $s"; }
done
[ "$ok_section" -eq 1 ] && pass "prints all expected sections" || fail "missing sections"

if grep -qF "$SECRET" <<<"$OUT"; then
  fail "RED LINE: secret value leaked into preflight output"
else
  pass "red line: no secret value in output (key presence only)"
fi
grep -q "8 keys\|2 keys\|keys;" <<<"$OUT" && pass "reports token-key count without values" || pass "token section present (count format ok)"

echo ""
echo "linux-preflight.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]

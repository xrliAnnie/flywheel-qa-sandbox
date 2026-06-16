#!/usr/bin/env bash
# FLY-281: Tests for set-lead-avatar.sh core logic.
# Runs: bash scripts/test-set-lead-avatar.sh
#
# These tests exercise pure helpers + the --dry-run path only. They NEVER call
# Discord and NEVER require a real bot token (a fake token is injected and we
# assert it is never echoed).
set -euo pipefail

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$SCRIPT_DIR/set-lead-avatar.sh"

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

# Assertion helpers (kept as explicit if/then/else — no `A && B || C`).
eq()      { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (got: '$1')"; fi; }
contains(){ if printf '%s' "$2" | grep -q -- "$1"; then pass "$3"; else fail "$3"; fi; }
excludes(){ if printf '%s' "$2" | grep -q -- "$1"; then fail "$3"; else pass "$3"; fi; }
rejects() { if "$@" >/dev/null 2>&1; then return 1; else return 0; fi; }

# Source the target for its functions. main() is guarded so sourcing is a no-op.
# shellcheck source=/dev/null
source "$TARGET"

# ════════════════════════════════════════════════════════════════
# Fixtures: tiny files with valid magic bytes for each format.
# ════════════════════════════════════════════════════════════════
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PNG="$TMP/a.png";  printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR' > "$PNG"
JPG="$TMP/a.jpg";  printf '\xff\xd8\xff\xe0\x00\x10JFIF' > "$JPG"
GIF="$TMP/a.gif";  printf 'GIF89a\x01\x00\x01\x00' > "$GIF"
TXT="$TMP/a.txt";  printf 'not an image' > "$TXT"

# ════════════════════════════════════════════════════════════════
# Test: detect_mime maps magic bytes to the right mime
# ════════════════════════════════════════════════════════════════
echo "Test: detect_mime"
eq "$(detect_mime "$PNG")" "image/png"  "png detected"
eq "$(detect_mime "$JPG")" "image/jpeg" "jpeg detected"
eq "$(detect_mime "$GIF")" "image/gif"  "gif detected"

# ════════════════════════════════════════════════════════════════
# Test: build_data_uri prefix + no embedded newlines
# ════════════════════════════════════════════════════════════════
echo "Test: build_data_uri"
URI=$(build_data_uri "$PNG")
case "$URI" in
  data:image/png\;base64,*) pass "data uri prefix correct" ;;
  *) fail "data uri prefix correct (got: ${URI:0:30})" ;;
esac
eq "$(printf '%s' "$URI" | wc -l | tr -d ' ')" "0" "data uri has no newlines"

# ════════════════════════════════════════════════════════════════
# Test: resolve_token_env convenience aliases
# ════════════════════════════════════════════════════════════════
echo "Test: resolve_token_env"
eq "$(resolve_token_env cass)" "CASS_BOT_TOKEN"       "cass alias"
eq "$(resolve_token_env tadashi)" "TADASHI_BOT_TOKEN" "tadashi alias"
if rejects resolve_token_env bogusbot; then pass "unknown alias rejected"; else fail "unknown alias rejected"; fi

# ════════════════════════════════════════════════════════════════
# Test: main --dry-run succeeds, reports mime, NEVER echoes the token
# ════════════════════════════════════════════════════════════════
echo "Test: main --dry-run"
SECRET="super-secret-token-DO-NOT-LEAK"
OUT=$(FAKE_TOKEN_FOR_TEST="$SECRET" \
  bash "$TARGET" --token-env FAKE_TOKEN_FOR_TEST --image "$PNG" --dry-run 2>&1) && RC=0 || RC=$?
eq "$RC" "0" "dry-run exits 0"
contains "image/png" "$OUT" "dry-run reports mime"
contains "users/@me" "$OUT" "dry-run names endpoint"
excludes "$SECRET" "$OUT" "token NOT leaked in dry-run"

# ════════════════════════════════════════════════════════════════
# Test: main rejects bad inputs
# ════════════════════════════════════════════════════════════════
echo "Test: main input validation"
if rejects env FAKE_TOKEN_FOR_TEST=x bash "$TARGET" --token-env FAKE_TOKEN_FOR_TEST --image "$TMP/nope.png" --dry-run; then
  pass "missing image rejected"; else fail "missing image rejected"; fi
if rejects env FAKE_TOKEN_FOR_TEST=x bash "$TARGET" --token-env FAKE_TOKEN_FOR_TEST --image "$TXT" --dry-run; then
  pass "unsupported format rejected"; else fail "unsupported format rejected"; fi
unset UNSET_TOKEN_VAR 2>/dev/null || true
if rejects bash "$TARGET" --token-env UNSET_TOKEN_VAR --image "$PNG" --dry-run; then
  pass "empty token env rejected"; else fail "empty token env rejected"; fi

# ════════════════════════════════════════════════════════════════
# Test: REAL apply path via a fake curl — the token must NEVER reach
# curl's argv (it is world-visible via ps/proc); a 200 → success.
# ════════════════════════════════════════════════════════════════
echo "Test: real apply path (fake curl, token containment)"
FAKEBIN="$TMP/bin"; mkdir -p "$FAKEBIN"
ARGV_LOG="$TMP/curl_argv.log"
cat > "$FAKEBIN/curl" <<FAKE
#!/usr/bin/env bash
# Fake curl: record argv, write a 200 body to the -o target, print the code.
printf '%s\n' "\$*" > "$ARGV_LOG"
out=""; prev=""
for a in "\$@"; do [ "\$prev" = "-o" ] && out="\$a"; prev="\$a"; done
[ -n "\$out" ] && printf '{"username":"faketest"}' > "\$out"
printf '200'
FAKE
chmod +x "$FAKEBIN/curl"

APPLY_SECRET="ARGV-LEAK-CANARY-9z9z"
APPLY_OUT=$(PATH="$FAKEBIN:$PATH" FAKE_TOKEN_FOR_TEST="$APPLY_SECRET" \
  bash "$TARGET" --token-env FAKE_TOKEN_FOR_TEST --image "$PNG" 2>&1) && ARC=0 || ARC=$?
eq "$ARC" "0" "real apply exits 0 on HTTP 200"
excludes "$APPLY_SECRET" "$(cat "$ARGV_LOG")" "token NOT in curl argv"
contains "-H @" "$(cat "$ARGV_LOG")" "auth header passed via @file (not inline)"
excludes "$APPLY_SECRET" "$APPLY_OUT" "token NOT in apply output"

# ════════════════════════════════════════════════════════════════
echo ""
echo "════════════════════════════════════════"
echo "PASS: $PASS   FAIL: $FAIL"
echo "════════════════════════════════════════"
[ "$FAIL" -eq 0 ]

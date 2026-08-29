#!/bin/bash
# FLY-650: platform-deps.sh — per-platform dependency resolution (WI-6).
#
# Contract (plan §3.3 + Codex R2#4):
#   platform_deps_select <manifest-json> <platform> <pkgmgr> → TSV per dep:
#       name<TAB>action<TAB>arg
#   actions: install-brew|install-apt|install-dnf|present-check|manual|skip|error-no-linux-mapping
#   - new schema platforms.{darwin:{channel,formula},linux:{apt,dnf,presentCheck}}
#   - old single-layer {channel,formula} → treated as DARWIN-only (back-compat)
#   - linux + REQUIRED dep with no linux mapping → error-no-linux-mapping (fail-loud)
#   - linux + non-required dep with no linux mapping → skip (e.g. cmux)
#   - channel=manual → manual (AI CLIs)
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="${REPO_ROOT}/scripts/lib/platform-deps.sh"
[ -f "$LIB" ] || { echo "ERROR: $LIB not found"; exit 1; }
# shellcheck source=/dev/null
source "$LIB"

# line <name> <tsv> → the action+arg for a dep name (portable tab match)
row() { awk -F'\t' -v n="$1" '$1==n {print; exit}' <<<"$2"; }

MANIFEST='{
  "deps": [
    {"name":"jq","required":true,"platforms":{"darwin":{"channel":"brew","formula":"jq"},"linux":{"apt":"jq","dnf":"jq"}}},
    {"name":"pnpm","required":true,"platforms":{"linux":{"presentCheck":true},"darwin":{"channel":"brew","formula":"pnpm"}},"check":{"command":"pnpm"}},
    {"name":"codex","required":false,"channel":"manual"},
    {"name":"cmux","required":false,"platforms":{"darwin":{"channel":"manual"}}},
    {"name":"oldjq","required":true,"channel":"brew","formula":"jq"}
  ]
}'

# ── D1: new-schema dep on linux+apt → install-apt ──
OUT="$(platform_deps_select "$MANIFEST" linux apt)"
[ "$(row jq "$OUT")" = "$(printf 'jq\tinstall-apt\tjq')" ] && pass "D1 linux+apt → install-apt" || fail "D1: $(row jq "$OUT")"

# ── D2: new-schema dep on darwin → install-brew ──
OUT="$(platform_deps_select "$MANIFEST" darwin brew)"
[ "$(row jq "$OUT")" = "$(printf 'jq\tinstall-brew\tjq')" ] && pass "D2 darwin → install-brew" || fail "D2: $(row jq "$OUT")"

# ── D3: old single-layer on darwin → install-brew (back-compat) ──
[ "$(row oldjq "$OUT")" = "$(printf 'oldjq\tinstall-brew\tjq')" ] && pass "D3 old single-layer darwin → install-brew" || fail "D3: $(row oldjq "$OUT")"

# ── D4: old single-layer on linux + required → error-no-linux-mapping ──
OUT="$(platform_deps_select "$MANIFEST" linux apt)"
case "$(row oldjq "$OUT")" in
  *error-no-linux-mapping*) pass "D4 old single-layer linux+required → error-no-linux-mapping" ;;
  *) fail "D4: $(row oldjq "$OUT")" ;;
esac

# ── D5: manual dep → manual ──
case "$(row codex "$OUT")" in
  *$'\t'manual*) pass "D5 channel=manual → manual" ;;
  *) fail "D5: $(row codex "$OUT")" ;;
esac

# ── D6: present-check dep on linux → present-check ──
case "$(row pnpm "$OUT")" in
  *present-check*) pass "D6 linux presentCheck → present-check" ;;
  *) fail "D6: $(row pnpm "$OUT")" ;;
esac

# ── D7: non-required dep with no linux mapping → skip (cmux) ──
case "$(row cmux "$OUT")" in
  *$'\t'skip*) pass "D7 non-required no-linux-mapping → skip (cmux)" ;;
  *) fail "D7: $(row cmux "$OUT")" ;;
esac

# ── D8: dnf pkgmgr selection ──
OUT="$(platform_deps_select "$MANIFEST" linux dnf)"
[ "$(row jq "$OUT")" = "$(printf 'jq\tinstall-dnf\tjq')" ] && pass "D8 linux+dnf → install-dnf" || fail "D8: $(row jq "$OUT")"

echo ""
echo "platform-deps.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]

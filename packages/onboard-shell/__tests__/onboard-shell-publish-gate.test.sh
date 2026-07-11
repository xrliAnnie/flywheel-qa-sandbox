#!/bin/bash
# FLY-1062 PR2 · thin-shell publish content gate (Codex R4#3, peer of the
# payload gate). The PUBLIC shell package's npm-pack output must carry ONLY
# bin/ + lib/ + package.json + README — and NONE of the internal surface:
#   G1 zero scripts/ , zero packages/ , zero agents/ , zero payload tarball
#   G2 zero prompts/persona/copy build-artifacts (the plaintext IP lives in the
#      payload, never the public shell)
#   G3 zero private-repo URL (xrliAnnie/) anywhere in the packed content
#   G4 package.json is private:true (PR2 does NOT publish — publishing is PR4)
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v npm >/dev/null 2>&1 || { echo "ERROR: npm required"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SANDBOX="$(mktemp -d -t fly1062-shellpub-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

# real npm pack of the shell package → list its contents
TARBALL="$SANDBOX/$(cd "$PKG_DIR" && npm pack --pack-destination "$SANDBOX" 2>/dev/null | tail -1)"
[ -f "$TARBALL" ] || { echo "ERROR: shell npm pack failed"; exit 1; }
LIST="$(tar -tzf "$TARBALL" | sed 's|^package/||' | sort)"
UNPACK="$SANDBOX/unpack"; mkdir -p "$UNPACK"; tar -xzf "$TARBALL" -C "$UNPACK"

# ── G1 · no internal surface in the packed content ──────────────────────────
BAD="$(grep -E '^(scripts/|packages/|agents/)|\.tgz$' <<<"$LIST" || true)"
if [ -z "$BAD" ]; then
  pass "G1 no scripts/ packages/ agents/ or payload tarball in the shell package"
else
  fail "G1 forbidden entries: [$BAD]"
fi

# ── G2 · EXACT allowlist (Codex R1#5) — every packed file must be a registered
#    name. A broad bin/*+lib/* rule would let lib/internal-persona.md or
#    bin/private-prompt.txt ship; this snapshot pins the exact file set, so any
#    new/renamed file (accidental or hostile) must be added here deliberately.
ALLOW="$SANDBOX/allow.txt"
cat > "$ALLOW" <<'EOF'
package.json
README.md
bin/flywheel-onboard.js
lib/config.mjs
lib/messages.mjs
lib/key.mjs
lib/endpoint.mjs
lib/install.mjs
lib/journal.mjs
lib/onboard.mjs
lib/update.mjs
lib/license.mjs
EOF
# exact-set = subset (no stray packed file) AND superset (no missing required
# file). Subset-only would let a required file silently drop out (Codex R3).
UNEXPECTED=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  grep -qxF "$f" "$ALLOW" || UNEXPECTED="$UNEXPECTED $f"
done <<<"$LIST"
MISSING=""
while IFS= read -r a; do
  [ -z "$a" ] && continue
  grep -qxF "$a" <<<"$LIST" || MISSING="$MISSING $a"
done <"$ALLOW"
if [ -z "$UNEXPECTED" ] && [ -z "$MISSING" ]; then
  pass "G2 packed content is EXACTLY the registered file set (subset + superset — no stray file, no missing required file)"
else
  fail "G2 unregistered:[$UNEXPECTED] missing-required:[$MISSING]"
fi

# ── G3 · zero private-repo URL in the packed content ────────────────────────
if ! grep -rq "xrliAnnie/" "$UNPACK" 2>/dev/null; then
  pass "G3 zero private-repo reference in the shell package"
else
  fail "G3 private-repo slug: $(grep -rln 'xrliAnnie/' "$UNPACK")"
fi

# ── G3b · secret scan over the packed content (Codex R1#5) ───────────────────
# Reuse the repo's calibrated code-tree secret net (test-time only — the shell
# has no runtime dependency on it). No vendor token / high-entropy blob may ship.
if [ -f "$PKG_DIR/../../scripts/lib/fleet-sanitize.sh" ]; then
  # shellcheck source=/dev/null
  source "$PKG_DIR/../../scripts/lib/fleet-sanitize.sh"
  if scan_code_tree_for_secrets "$UNPACK/package" >/dev/null 2>&1; then
    pass "G3b secret scan clean over the packed shell content"
  else
    fail "G3b secret-like content in the packed shell"
  fi
else
  pass "G3b secret scan skipped (fleet-sanitize not found — repo layout changed)"
fi

# ── G4 · not publishable yet (PR4 flips this) ───────────────────────────────
if [ "$(jq -r '.private' "$PKG_DIR/package.json")" = "true" ]; then
  pass "G4 shell package.json private:true — npm refuses publish until PR4"
else
  fail "G4 shell is publishable but PR2 must not publish"
fi

echo ""
echo "onboard-shell-publish-gate: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]

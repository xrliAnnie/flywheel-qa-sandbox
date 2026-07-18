#!/bin/bash
# FLY-1062 PR2 · thin-shell publish content gate (Codex R4#3, peer of the
# payload gate). The PUBLIC shell package's npm-pack output must carry ONLY
# bin/ + lib/ + package.json + README — and NONE of the internal surface:
#   G1 zero scripts/ , zero packages/ , zero agents/ , zero payload tarball
#   G2 zero prompts/persona/copy build-artifacts (the plaintext IP lives in the
#      payload, never the public shell)
#   G3 zero private-repo URL (xrliAnnie/) anywhere in the packed content
#   G4 publish FORM (PR4): private lock REMOVED + scoped public access (the
#      earlier private:true lock is gone; publishing stays founder-gated at the
#      preflight/runbook level, not by a private flag)
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

# ── G4 · publish FORM (PR4 unlock: the private:true lock is replaced by the
#    explicit publish shape — public scoped access; publishing itself remains
#    founder-gated at the PATH level: shell-publish-preflight.sh refuses while
#    DEFAULT_ENDPOINT is the .invalid placeholder, and the first publish is a
#    founder-local 2FA action per the runbook) ────────────────────────────────
if [ "$(jq -r '.private // "absent"' "$PKG_DIR/package.json")" = "absent" ] \
   && [ "$(jq -r '.publishConfig.access' "$PKG_DIR/package.json")" = "public" ] \
   && [ "$(jq -r '.name' "$PKG_DIR/package.json")" = "@flywheel-ai/onboard" ]; then
  pass "G4 publish form: scoped public package, private lock removed (PR4)"
else
  fail "G4 publish form wrong: private=$(jq -r '.private' "$PKG_DIR/package.json") access=$(jq -r '.publishConfig.access' "$PKG_DIR/package.json")"
fi

# ── G5 · publish preflight refuses the placeholder endpoint ─────────────────
# (the baked DEFAULT_ENDPOINT is what customers get — publishing with the
# .invalid placeholder would ship a dead shell; the preflight is the shared
# guard for BOTH the workflow and the founder-local publish path)
PREFLIGHT="$PKG_DIR/../../scripts/release/shell-publish-preflight.sh"
if [ -f "$PREFLIGHT" ]; then
  if bash "$PREFLIGHT" --check-endpoint-only >/dev/null 2>&1; then
    # endpoint already real — the guard passing is the correct outcome then
    if grep -q 'flywheel\.invalid' "$PKG_DIR/lib/config.mjs"; then
      fail "G5 preflight passed while DEFAULT_ENDPOINT is still the placeholder"
    else
      pass "G5 preflight endpoint guard consistent (real endpoint configured)"
    fi
  else
    if grep -q 'flywheel\.invalid' "$PKG_DIR/lib/config.mjs"; then
      pass "G5 preflight refuses to publish while DEFAULT_ENDPOINT is the placeholder"
    else
      fail "G5 preflight refused although the endpoint looks real"
    fi
  fi
else
  fail "G5 shell-publish-preflight.sh missing"
fi

# ── G6 · FLY-1323 · a bare `npm publish` must run the gate by itself ─────────
# The founder-direct first publish (FLY-1323) has no broker to re-run the
# authoritative content gate, and `npm publish` runs NOTHING on its own. Without
# a prepublishOnly hook the ONLY protection is a human remembering to run the
# preflight. Make it structural.
# Codex R4#4: G6a trusted jq's output without checking its exit; a failed jq
# printing nothing would read as "no hook". Require exit 0 first.
# Codex R5#4 then R6#4: substring/glob checks were both gameable — `echo
# shell-publish-preflight` (R5) and `bash -c 'true' shell-publish-preflight.sh
# --founder-local` (R6, matches the glob `bash *…--founder-local` yet runs
# `bash -c 'true'`, never the gate). This repo owns exactly ONE lifecycle command,
# so pin the EXACT canonical hook string — no lookalike can equal it. The
# behavioral proof that this exact string actually runs the gate lives in
# shell-pack-install-dryrun.test.sh P4d (bare publish IS gated). Two known
# lookalikes are asserted unequal below so the equality's discrimination is explicit.
EXPECTED_HOOK='bash ../../scripts/release/shell-publish-preflight.sh --founder-local'
HOOK="$(jq -r '.scripts.prepublishOnly // ""' "$PKG_DIR/package.json")"; HOOK_RC=$?
if [ "$HOOK_RC" -eq 0 ] && [ "$HOOK" = "$EXPECTED_HOOK" ] \
   && [ "$EXPECTED_HOOK" != "echo shell-publish-preflight" ] \
   && [ "$EXPECTED_HOOK" != "bash -c 'true' shell-publish-preflight.sh --founder-local" ]; then
  pass "G6a prepublishOnly is EXACTLY the canonical preflight invocation (no substring/glob/-c lookalike can pass)"
else
  fail "G6a hook is not the exact canonical invocation (jq rc=$HOOK_RC): got '$HOOK', want '$EXPECTED_HOOK'"
fi

# G6b · npm pack must NOT fire prepublishOnly. shell-prepare.mjs packs the exact
# tarball, and the preflight itself packs while checking content — if pack fired
# the hook it would recurse forever.
# Codex R4#4: this captured pack output but ignored its exit status — a FAILED
# pack (which prints no "shell-publish-preflight") was reported as PASS. Require
# exit 0, so a broken pack fails this test instead of masquerading as "no recursion".
PACK_OUT="$(cd "$PKG_DIR" && npm pack --dry-run 2>&1)"; PACK_RC=$?
if [ "$PACK_RC" -eq 0 ] && ! grep -q "shell-publish-preflight" <<<"$PACK_OUT"; then
  pass "G6b npm pack succeeds and does not fire prepublishOnly (no recursion into the gate)"
else
  fail "G6b npm pack failed (rc=$PACK_RC) or fired the publish hook — recursion risk: $PACK_OUT"
fi

# ── G7 · FLY-1323 (Codex R4#4) · the endpoint gate FAILS CLOSED when config.mjs
#    is missing. G5 only ever exercises the present placeholder file, so reverting
#    the tri-state guard to a bare `if grep -q` (grep exits 2 on a missing file,
#    the `if` reads false, and the script announces "not the placeholder" and
#    passes) left G5 green. This copies the CURRENT preflight into a tree where
#    lib/config.mjs is ABSENT and asserts it refuses with the guard's unique
#    diagnostic — so a regression to the fail-open form turns THIS test red.
G7SB="$SANDBOX/g7"; mkdir -p "$G7SB/scripts/release" "$G7SB/packages/onboard-shell/lib"
cp "$PREFLIGHT" "$G7SB/scripts/release/shell-publish-preflight.sh"
cp "$PKG_DIR/package.json" "$G7SB/packages/onboard-shell/package.json"
# lib/ exists but config.mjs deliberately absent → the endpoint gate must refuse
G7_OUT="$(bash "$G7SB/scripts/release/shell-publish-preflight.sh" --check-endpoint-only 2>&1)"; G7_RC=$?
if [ "$G7_RC" -ne 0 ] && grep -q "A missing file is not a passing check" <<<"$G7_OUT"; then
  pass "G7 endpoint gate fails CLOSED when config.mjs is missing (a missing file is not a passing check)"
else
  fail "G7 missing config.mjs did not fail closed (rc=$G7_RC): $G7_OUT"
fi

# ── G8 · FLY-1323 (Codex R5#1) · a hostile `dirname` on PATH cannot redirect the
#    tree the preflight validates. The old form nested an UNCHECKED external
#    `dirname` inside ROOT's resolution; a `dirname` that printed another valid
#    tree and exited non-zero would send the gate to inspect the wrong package.
#    The current form uses Bash parameter expansion (a builtin). Proof: with a
#    hostile `dirname` shim on PATH, the preflight must still resolve THIS repo and
#    die on the placeholder endpoint — not on "config missing" from a wrong tree.
G8SHIM="$SANDBOX/g8bin"; mkdir -p "$G8SHIM"
printf '#!/bin/bash\necho "/tmp/fly1323-WRONG-TREE"; exit 73\n' > "$G8SHIM/dirname"
chmod +x "$G8SHIM/dirname"
G8_OUT="$(PATH="$G8SHIM:$PATH" bash "$PREFLIGHT" --check-endpoint-only 2>&1)"; G8_RC=$?
if [ "$G8_RC" -ne 0 ] && grep -q "still the .invalid placeholder" <<<"$G8_OUT" \
   && ! grep -q "A missing file is not a passing check" <<<"$G8_OUT"; then
  pass "G8 hostile dirname on PATH cannot redirect the validated tree (builtin resolution, not external dirname)"
else
  fail "G8 preflight tree was redirectable by a hostile dirname (rc=$G8_RC): $G8_OUT"
fi

echo ""
echo "onboard-shell-publish-gate: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]

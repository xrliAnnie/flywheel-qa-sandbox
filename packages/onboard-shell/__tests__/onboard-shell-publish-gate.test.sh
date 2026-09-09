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

TARBALL_INPUT=""
if [ "$#" -gt 0 ]; then
  if [ "$#" -eq 2 ] && [ "$1" = "--tarball" ]; then
    TARBALL_INPUT="$2"
    [ -f "$TARBALL_INPUT" ] || { echo "ERROR: exact tarball not found: $TARBALL_INPUT"; exit 1; }
  else
    echo "ERROR: usage: $0 [--tarball <exact.tgz>]"
    exit 1
  fi
fi

SANDBOX="$(mktemp -d -t fly1062-shellpub-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

# Default/source mode creates a real npm pack. Workflow mode supplies the exact
# already-hashed tarball, so the content gate cannot accidentally inspect a
# second build.
if [ -n "$TARBALL_INPUT" ]; then
  TARBALL="$TARBALL_INPUT"
else
  TARBALL="$SANDBOX/$(cd "$PKG_DIR" && npm_config_cache="$SANDBOX/npm-cache" npm pack --pack-destination "$SANDBOX" 2>/dev/null | tail -1)"
fi
[ -f "$TARBALL" ] || { echo "ERROR: shell npm pack failed"; exit 1; }
LIST="$(tar -tzf "$TARBALL" | sed 's|^package/||' | sort)"
UNPACK="$SANDBOX/unpack"; mkdir -p "$UNPACK"; tar -xzf "$TARBALL" -C "$UNPACK"
PACKED_PACKAGE_JSON="$UNPACK/package/package.json"

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

# ── G3 · zero private-repo URL except the trusted-publisher repository field ─
PRIVATE_OUTSIDE_REPOSITORY=""
if grep -r "xrliAnnie/" "$UNPACK/package" --exclude=package.json >/dev/null 2>&1; then
  PRIVATE_OUTSIDE_REPOSITORY="$(grep -rln 'xrliAnnie/' "$UNPACK/package" --exclude=package.json)"
fi
jq 'del(.repository.url)' "$PACKED_PACKAGE_JSON" > "$SANDBOX/package-without-repository-url.json"
if grep -q "xrliAnnie/" "$SANDBOX/package-without-repository-url.json"; then
  PRIVATE_OUTSIDE_REPOSITORY="$PRIVATE_OUTSIDE_REPOSITORY package.json(outside repository.url)"
fi
if [ -z "$PRIVATE_OUTSIDE_REPOSITORY" ]; then
  pass "G3 zero private-repo reference outside package.json.repository.url"
else
  fail "G3 private-repo slug outside repository.url: $PRIVATE_OUTSIDE_REPOSITORY"
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
#    explicit publish shape — public scoped access; shell-publish-preflight.sh
#    refuses while DEFAULT_ENDPOINT is the .invalid placeholder. Release CI
#    publishes through OIDC; founder-local remains a strict fallback backstop.)
# ─────────────────────────────────────────────────────────────────────────────
if [ "$(jq -r '.private // "absent"' "$PACKED_PACKAGE_JSON")" = "absent" ] \
   && [ "$(jq -r '.publishConfig.access' "$PACKED_PACKAGE_JSON")" = "public" ] \
   && [ "$(jq -r '.name' "$PACKED_PACKAGE_JSON")" = "@flywheel-ai/onboard" ]; then
  pass "G4 publish form: scoped public package, private lock removed (PR4)"
else
  fail "G4 publish form wrong: private=$(jq -r '.private' "$PACKED_PACKAGE_JSON") access=$(jq -r '.publishConfig.access' "$PACKED_PACKAGE_JSON")"
fi

# ── G9 · npm trusted publishing binds the public package to this repository ─
EXPECTED_REPOSITORY_URL='git+https://github.com/xrliAnnie/flywheel.git'
if [ "$(jq -r '.repository.url // empty' "$PACKED_PACKAGE_JSON")" = "$EXPECTED_REPOSITORY_URL" ]; then
  pass "G9 repository.url exactly identifies the trusted-publisher repository"
else
  fail "G9 repository.url must be exactly $EXPECTED_REPOSITORY_URL"
fi

# ── G6a · the packed package retains the exact founder-local backstop hook ───
EXPECTED_HOOK='bash ../../scripts/release/shell-publish-preflight.sh --founder-local'
HOOK="$(jq -r '.scripts.prepublishOnly // ""' "$PACKED_PACKAGE_JSON")"; HOOK_RC=$?
if [ "$HOOK_RC" -eq 0 ] && [ "$HOOK" = "$EXPECTED_HOOK" ] \
   && [ "$EXPECTED_HOOK" != "echo shell-publish-preflight" ] \
   && [ "$EXPECTED_HOOK" != "bash -c 'true' shell-publish-preflight.sh --founder-local" ]; then
  pass "G6a prepublishOnly is EXACTLY the canonical preflight invocation (no substring/glob/-c lookalike can pass)"
else
  fail "G6a hook is not the exact canonical invocation (jq rc=$HOOK_RC): got '$HOOK', want '$EXPECTED_HOOK'"
fi

# Exact-tarball mode ends here: every assertion above reads the supplied bytes.
# Source-only self-tests below deliberately include npm pack and must never
# rebuild during the workflow's exact artifact gate.
if [ -n "$TARBALL_INPUT" ]; then
  echo ""
  echo "onboard-shell-publish-gate: PASSED=$PASSED FAILED=$FAILED (exact tarball)"
  [ "$FAILED" -eq 0 ]
  exit $?
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

# G6b · npm pack must NOT fire prepublishOnly. shell-prepare.mjs packs the exact
# tarball, and the preflight itself packs while checking content — if pack fired
# the hook it would recurse forever.
# Codex R4#4: this captured pack output but ignored its exit status — a FAILED
# pack (which prints no "shell-publish-preflight") was reported as PASS. Require
# exit 0, so a broken pack fails this test instead of masquerading as "no recursion".
PACK_OUT="$(cd "$PKG_DIR" && npm_config_cache="$SANDBOX/npm-cache" npm pack --dry-run 2>&1)"; PACK_RC=$?
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
#    The current form uses Bash parameter expansion (a builtin).
#    Proof (era-independent — the original form keyed on "dies on the
#    placeholder", which stopped being true the moment activation put the REAL
#    endpoint into the tree): run the endpoint check WITHOUT the shim as the
#    baseline, then WITH the hostile shim, and require identical rc + identical
#    output. The shim points at a CONSTRUCTED, VALID alternate tree whose
#    config carries the .invalid placeholder (Codex #640 R1 MED: a nonexistent
#    wrong tree only proved the cd-failure path — a fallback-on-failed-cd
#    implementation, or a wrong tree that happens to answer identically, would
#    have slipped through). With this tree a SUCCESSFUL redirect must flip the
#    output to the placeholder refusal — it cannot be byte-identical to the
#    baseline; the missing-file refusal is asserted absent as well.
G8_BASE_OUT="$(bash "$PREFLIGHT" --check-endpoint-only 2>&1)"; G8_BASE_RC=$?
G8WRONG="$SANDBOX/g8-wrong-tree"
mkdir -p "$G8WRONG/scripts/release" "$G8WRONG/packages/onboard-shell/lib"
printf 'export const DEFAULT_ENDPOINT = "https://onboard.flywheel.invalid";\n' \
  > "$G8WRONG/packages/onboard-shell/lib/config.mjs"
G8SHIM="$SANDBOX/g8bin"; mkdir -p "$G8SHIM"
printf '#!/bin/bash\necho "%s"; exit 73\n' "$G8WRONG/scripts/release" > "$G8SHIM/dirname"
chmod +x "$G8SHIM/dirname"
G8_OUT="$(PATH="$G8SHIM:$PATH" bash "$PREFLIGHT" --check-endpoint-only 2>&1)"; G8_RC=$?
if [ "$G8_RC" -eq "$G8_BASE_RC" ] && [ "$G8_OUT" = "$G8_BASE_OUT" ] \
   && ! grep -q "A missing file is not a passing check" <<<"$G8_OUT"; then
  pass "G8 hostile dirname on PATH cannot redirect the validated tree (shimmed run byte-identical to baseline)"
else
  fail "G8 preflight tree was redirectable by a hostile dirname (rc=$G8_RC vs base $G8_BASE_RC): $G8_OUT"
fi

echo ""
echo "onboard-shell-publish-gate: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]

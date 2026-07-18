#!/bin/bash
# FLY-1323 (Codex code R4 #2) · OIDC toolchain-floor regression matrix.
#
# The OIDC branch of shell-publish-preflight.sh (`if [ "$FOUNDER_LOCAL" -ne 1 ]`)
# had ZERO coverage: shell-preflight-registry.test.sh always passes
# --founder-local, which skips the whole branch. So deleting the npm/node
# exit-status guards, the version grammar, or the comparison-pipeline guard left
# every suite green — the exact "guard deleted, named test still green" class this
# PR exists to kill.
#
# This drives the branch WITHOUT --founder-local, shims npm/node/sort to control
# each answer, and asserts each fail-closed case dies AT the toolchain floor
# (before the repository.url step) with ITS OWN diagnostic. O0 is the positive
# control: a good toolchain must clear the floor (and only then die later at
# repository.url), or every fail-closed assertion below would be vacuous.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFLIGHT="$ROOT/scripts/release/shell-publish-preflight.sh"
CONFIG="$ROOT/packages/onboard-shell/lib/config.mjs"
SANDBOX="$(mktemp -d -t fly1323-oidc-XXXXXX)"

cp "$CONFIG" "$SANDBOX/config.mjs.orig"
restore() { cp "$SANDBOX/config.mjs.orig" "$CONFIG"; rm -f "$CONFIG.bak"; rm -rf "$SANDBOX"; }
trap restore EXIT
# de-placeholder so execution reaches the toolchain floor (step 1 gate = endpoint).
# atomic write (temp + mv) so an interrupted run can never truncate the checked-in
# config.mjs (Codex R7#4); the trap above still restores the original.
sed 's#https://onboard.flywheel.invalid#https://flywheel-onboard-endpoint.example.workers.dev#' \
  "$SANDBOX/config.mjs.orig" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"

SHIM="$SANDBOX/bin"; mkdir -p "$SHIM"
REAL_SORT="$(command -v sort)"

# npm/node print $NPM_OUT/$NODE_OUT and exit $NPM_RC/$NODE_RC for `--version`;
# any other call means we passed the floor (fail-closed cases must not get here).
cat > "$SHIM/npm" <<SH
#!/bin/bash
if [ "\$1" = "--version" ]; then printf '%s\n' "\$NPM_OUT"; exit "\$NPM_RC"; fi
echo "SHIM: unexpected npm \$*" >&2; exit 99
SH
cat > "$SHIM/node" <<SH
#!/bin/bash
if [ "\$1" = "--version" ]; then printf '%s\n' "\$NODE_OUT"; exit "\$NODE_RC"; fi
echo "SHIM: unexpected node \$*" >&2; exit 99
SH
# sort passes through to the real sort unless SORT_FAIL=1 (the failing-pipeline case)
cat > "$SHIM/sort" <<SH
#!/bin/bash
if [ "\${SORT_FAIL:-0}" = "1" ]; then exit 3; fi
exec "$REAL_SORT" "\$@"
SH
chmod +x "$SHIM/npm" "$SHIM/node" "$SHIM/sort"

# defaults = a good toolchain; each scenario overrides only what it tests
run() { # caller sets NPM_OUT NPM_RC NODE_OUT NODE_RC SORT_FAIL
  NPM_OUT="${NPM_OUT:-11.9.0}" NPM_RC="${NPM_RC:-0}" \
  NODE_OUT="${NODE_OUT:-v25.6.1}" NODE_RC="${NODE_RC:-0}" SORT_FAIL="${SORT_FAIL:-0}" \
  PATH="$SHIM:$PATH" bash "$PREFLIGHT" 2>&1   # NO --founder-local → OIDC branch
}

# ── O0 · POSITIVE CONTROL: a good toolchain clears the floor ─────────────────
# In this repo the OIDC branch dies at the repository.url check (line 106), which
# is AFTER the whole floor — so reaching that message proves every floor guard
# (exit-status, grammar, comparison, pipeline) let a valid toolchain through. If
# even the good case died at the floor, every fail-closed assertion below would
# be vacuous. So: reached repository.url AND died at NO floor diagnostic.
OUT="$(run)"; RC=$?
if [ "$RC" -ne 0 ] && grep -q "repository.url missing" <<<"$OUT" \
   && ! grep -qE "toolchain floor|is not a version|< 11.5.1|< 22.14|pipeline failed" <<<"$OUT"; then
  pass "O0 good npm/node clear the toolchain floor (reach repository.url, die at no floor guard) — ruler is live"
else
  fail "O0 good toolchain did not clear the floor (rc=$RC): $(tail -3 <<<"$OUT")"
fi

# ── O1 · npm --version prints a plausible version but EXITS NON-ZERO → die ────
OUT="$(NPM_RC=7 run)"; RC=$?
if [ "$RC" -ne 0 ] && grep -q "cannot confirm the npm toolchain floor" <<<"$OUT" \
   && ! grep -q "repository.url missing" <<<"$OUT"; then
  pass "O1 npm --version nonzero-exit (plausible stdout) fails CLOSED at the floor"
else
  fail "O1 npm exit-status guard did not fire (rc=$RC): $(tail -3 <<<"$OUT")"
fi

# ── O2 · node --version plausible but EXITS NON-ZERO → die ───────────────────
OUT="$(NODE_RC=7 run)"; RC=$?
if [ "$RC" -ne 0 ] && grep -q "cannot confirm the node toolchain floor" <<<"$OUT" \
   && ! grep -q "repository.url missing" <<<"$OUT"; then
  pass "O2 node --version nonzero-exit (plausible stdout) fails CLOSED at the floor"
else
  fail "O2 node exit-status guard did not fire (rc=$RC): $(tail -3 <<<"$OUT")"
fi

# ── O3 · npm exit-0 GARBAGE (not a version) → die (Codex's exact input) ───────
OUT="$(NPM_OUT='99garbage.99junk.99trash' run)"; RC=$?
if [ "$RC" -ne 0 ] && grep -q "which is not a version" <<<"$OUT" \
   && ! grep -q "repository.url missing" <<<"$OUT"; then
  pass "O3 npm exit-0 garbage is refused by the version grammar (glob→anchored-regex)"
else
  fail "O3 grammar guard accepted garbage (rc=$RC): $(tail -3 <<<"$OUT")"
fi

# ── O4 · node exit-0 GARBAGE → die ───────────────────────────────────────────
OUT="$(NODE_OUT='garbage' run)"; RC=$?   # no 'v' so `tr -d v` leaves it garbage
if [ "$RC" -ne 0 ] && grep -q "which is not a version" <<<"$OUT" \
   && ! grep -q "repository.url missing" <<<"$OUT"; then
  pass "O4 node exit-0 garbage is refused by the version grammar"
else
  fail "O4 grammar guard accepted node garbage (rc=$RC): $(tail -3 <<<"$OUT")"
fi

# ── O5 · npm BELOW the floor → die ───────────────────────────────────────────
OUT="$(NPM_OUT='11.0.0' run)"; RC=$?
if [ "$RC" -ne 0 ] && grep -q "npm 11.0.0 < 11.5.1" <<<"$OUT" \
   && ! grep -q "repository.url missing" <<<"$OUT"; then
  pass "O5 below-floor npm is refused (11.0.0 < 11.5.1)"
else
  fail "O5 npm floor comparison did not fire (rc=$RC): $(tail -3 <<<"$OUT")"
fi

# ── O6 · node BELOW the floor → die ──────────────────────────────────────────
OUT="$(NODE_OUT='v20.0.0' run)"; RC=$?
if [ "$RC" -ne 0 ] && grep -q "node 20.0.0 < 22.14" <<<"$OUT" \
   && ! grep -q "repository.url missing" <<<"$OUT"; then
  pass "O6 below-floor node is refused (20.0.0 < 22.14)"
else
  fail "O6 node floor comparison did not fire (rc=$RC): $(tail -3 <<<"$OUT")"
fi

# ── O7 · the sort|head comparison pipeline FAILS → die (not a silent pass) ────
OUT="$(SORT_FAIL=1 run)"; RC=$?
if [ "$RC" -ne 0 ] && grep -q "version comparison pipeline failed" <<<"$OUT" \
   && ! grep -q "repository.url missing" <<<"$OUT"; then
  pass "O7 a failing comparison pipeline fails CLOSED (not read as 'above floor')"
else
  fail "O7 pipeline-status guard did not fire (rc=$RC): $(tail -3 <<<"$OUT")"
fi

echo ""
echo "oidc-toolchain-floor: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]

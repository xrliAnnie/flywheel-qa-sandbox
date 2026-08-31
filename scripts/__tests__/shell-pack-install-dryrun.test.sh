#!/bin/bash
# FLY-1062 · ① thin-shell PACKAGING verification (hermetic, no
# registry contact): the customer-facing form is proven publishable WITHOUT
# publishing anything —
#   P1  npm pack → the exact tarball a customer install resolves;
#   P2  shell-prepare.mjs stages that form + emits the candidate tuple
#       (sha256 of the staged bytes = what the founder approval will bind);
#   P3  npm install --prefix <tmp> <tarball> → the installed bin EXECUTES
#       (packaged-mode reality: installs ≠ importable source tree);
#   P4  npm publish --dry-run lists ONLY the publish whitelist
#       (package.json / README / bin / lib) — zero source, tests, or docs;
#   P5  the REAL publish path stays founder-gated: prepare refuses while the
#       baked endpoint is still the .invalid placeholder (no --allow-placeholder).
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v npm >/dev/null 2>&1 || { echo "ERROR: npm required"; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHELL_DIR="$ROOT/packages/onboard-shell"
PREPARE="$ROOT/scripts/release/shell-prepare.mjs"

SANDBOX="$(mktemp -d -t fly1062-pack-XXXXXX)"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

sha256() { shasum -a 256 "$1" | awk '{print $1}'; }

# ── P1 · npm pack the real shell ─────────────────────────────────────────────
TARBALL="$(cd "$SHELL_DIR" && npm pack --pack-destination "$SANDBOX" 2>/dev/null | tail -1)"
TARBALL="$SANDBOX/$TARBALL"
if [ -f "$TARBALL" ]; then
  pass "P1 npm pack produced the customer tarball"
else
  fail "P1 npm pack failed"; echo "RESULTS: $PASSED passed, $FAILED failed"; exit 1
fi

# ── P2 · prepare/stage emits a tuple bound to the staged bytes ───────────────
REQ_JSON="$(node "$PREPARE" --allow-placeholder --out "$SANDBOX/stage" 2>"$SANDBOX/prep.err")"
RC=$?
STAGED="$(node -e 'console.log(JSON.parse(process.argv[1]).stagedPath)' "$REQ_JSON" 2>/dev/null)"
REQ_SHA="$(node -e 'console.log(JSON.parse(process.argv[1]).sha256)' "$REQ_JSON" 2>/dev/null)"
REQ_ID="$(node -e 'console.log(JSON.parse(process.argv[1]).releaseId)' "$REQ_JSON" 2>/dev/null)"
VER="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version)' "$SHELL_DIR/package.json")"
if [ "$RC" -eq 0 ] && [ -f "$STAGED" ] && [ "$(sha256 "$STAGED")" = "$REQ_SHA" ] \
   && [ "$REQ_ID" = "shell-$VER" ]; then
  pass "P2 shell-prepare staged the tarball; request sha256 = staged bytes; releaseId deterministic"
else
  fail "P2 prepare rc=$RC json=[$REQ_JSON] err=[$(cat "$SANDBOX/prep.err")]"
fi

# ── P3 · install from the tarball; the installed bin runs ───────────────────
PREFIX="$SANDBOX/cli"
mkdir -p "$PREFIX"
if npm install --prefix "$PREFIX" "$TARBALL" >/dev/null 2>&1 \
   && [ -e "$PREFIX/node_modules/.bin/flywheel-onboard" ]; then
  pass "P3a npm install --prefix from the tarball exposes the bin"
else
  fail "P3a install from tarball failed"
fi
# the installed bin must EXECUTE — with an empty runtime + no TTY it must
# fail HONESTLY (non-zero, real message), never with a broken-package error
BIN_OUT="$(env -i HOME="$SANDBOX/h" PATH="$PATH" FLYWHEEL_STATE_DIR="$SANDBOX/h/.flywheel" \
  node "$PREFIX/node_modules/@flywheel-ai/onboard/bin/flywheel-onboard.js" </dev/null 2>&1)"
BIN_RC=$?
if [ "$BIN_RC" -ne 0 ] && [ -n "$BIN_OUT" ] && ! grep -q "Cannot find module" <<<"$BIN_OUT"; then
  pass "P3b installed bin executes (honest failure without key/endpoint, rc=$BIN_RC)"
else
  fail "P3b installed bin: rc=$BIN_RC out=[$(head -3 <<<"$BIN_OUT")]"
fi

# ── P4 · npm publish --dry-run: whitelist only, zero registry contact ───────
# FLY-1323: the package now carries a `prepublishOnly` hook (the gate a bare
# `npm publish` would otherwise skip entirely). That hook DELIBERATELY consults
# the real registry and refuses the .invalid placeholder, so a publish can no
# longer be a purely offline no-op — that is the point of the gate, not a
# regression. P4 inspects the packed FILE SET, so it runs the dry-run with
# --ignore-scripts to keep testing exactly what it was written to test; the hook
# itself is covered by P4d below and by the publish-gate suite (G6a/G6b).
NPMRC="$SANDBOX/npmrc"
printf 'registry=http://127.0.0.1:1/\n//127.0.0.1:1/:_authToken=dry-run-placeholder\n' > "$NPMRC"
DRY_OUT="$(cd "$SHELL_DIR" && npm publish --dry-run --ignore-scripts --userconfig "$NPMRC" 2>&1)"
DRY_RC=$?
if [ "$DRY_RC" -eq 0 ]; then
  pass "P4a npm publish --dry-run succeeds offline (port 1 registry never contacted)"
else
  fail "P4a dry-run rc=$DRY_RC out=[$(tail -5 <<<"$DRY_OUT")]"
fi
# every packed file must be in the publish whitelist
BAD_FILES="$(grep -Eo '^npm notice [0-9.]+[kMB]*B? +[^ ]+$' <<<"$DRY_OUT" \
  | awk '{print $NF}' \
  | grep -Ev '^(package\.json|README\.md|bin/|lib/)' || true)"
if [ -z "$BAD_FILES" ] && grep -q "bin/flywheel-onboard.js" <<<"$DRY_OUT"; then
  pass "P4b dry-run tarball = whitelist only (package.json/README/bin/lib)"
else
  fail "P4b non-whitelist files in dry-run: [$BAD_FILES]"
fi
if grep -qi "integrity\|shasum" <<<"$DRY_OUT"; then
  pass "P4c dry-run computed the artifact integrity locally"
else
  fail "P4c no integrity line in dry-run output"
fi

# ── P4d/P5 fixture · a CONTROLLED placeholder tree (FLY-1323 era fix) ────────
# Both gates below used to assume the LIVE tree still carries the .invalid
# placeholder — activation put the real endpoint into the tree, which flipped
# P5 red and made P4d vacuous (its grep "placeholder" substring-matched the
# SUCCESS text "not the placeholder" while publish failed on the fake registry
# instead — Codex #640 R1 HIGH). Era-independent form: prove each GATE against
# a sandbox tree whose config is FORCED to the placeholder, and match the
# gate's EXACT refusal string, never a substring both outcomes contain.
PHTREE="$SANDBOX/placeholder-tree"
mkdir -p "$PHTREE/scripts/release" "$PHTREE/packages"
cp "$ROOT/scripts/release/shell-publish-preflight.sh" "$PHTREE/scripts/release/"
cp "$PREPARE" "$PHTREE/scripts/release/shell-prepare.mjs"
cp -R "$SHELL_DIR" "$PHTREE/packages/onboard-shell"
node -e '
  const fs = require("node:fs");
  const p = process.argv[1];
  let s = fs.readFileSync(p, "utf8");
  s = s.replace(/DEFAULT_ENDPOINT =\s*"[^"]*"/, `DEFAULT_ENDPOINT = "https://onboard.flywheel.invalid"`);
  if (!s.includes("flywheel.invalid")) { console.error("placeholder injection failed"); process.exit(1); }
  fs.writeFileSync(p, s);
' "$PHTREE/packages/onboard-shell/lib/config.mjs" || { fail "P4d/P5 fixture injection failed"; }

# ── P4d · FLY-1323 · a BARE publish (no --ignore-scripts) is gated ───────────
# P4a above deliberately opts out of the hook to inspect the file set. This
# asserts the other half: without that opt-out a placeholder tree is REFUSED
# by the prepublishOnly hook itself, so the founder-direct path cannot publish
# a shell pointing at .invalid even if nobody runs the preflight by hand.
BARE_OUT="$(cd "$PHTREE/packages/onboard-shell" && npm publish --dry-run --userconfig "$NPMRC" 2>&1)" && BARE_RC=0 || BARE_RC=$?
if [ "$BARE_RC" -ne 0 ] && grep -q "still the .invalid placeholder" <<<"$BARE_OUT" \
   && ! grep -q "Publishing to" <<<"$BARE_OUT"; then
  pass "P4d bare npm publish is gated by prepublishOnly (exact placeholder refusal, never reaches publish)"
else
  fail "P4d bare publish was NOT gated (rc=$BARE_RC): $(tail -4 <<<"$BARE_OUT")"
fi

# ── P5 · the placeholder GATE in shell-prepare still blocks staging ─────────
if node "$PHTREE/scripts/release/shell-prepare.mjs" --out "$SANDBOX/stage2" >/dev/null 2>"$SANDBOX/p5.err"; then
  fail "P5 prepare must refuse a placeholder endpoint"
else
  grep -q "DEFAULT_ENDPOINT is still the placeholder" "$SANDBOX/p5.err" \
    && pass "P5 prepare refuses the placeholder endpoint (exact refusal string)" \
    || fail "P5 refused but with the wrong reason: $(cat "$SANDBOX/p5.err")"
fi

echo "RESULTS: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1

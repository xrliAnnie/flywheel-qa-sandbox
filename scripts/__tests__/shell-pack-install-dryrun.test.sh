#!/bin/bash
# FLY-1062 broker PR · ① thin-shell PACKAGING verification (hermetic, no
# registry contact): the customer-facing form is proven publishable WITHOUT
# publishing anything —
#   P1  npm pack → the exact tarball a customer install resolves;
#   P2  shell-prepare.mjs stages that form + emits the broker request tuple
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

# ── P2 · prepare/stage emits the broker tuple bound to the staged bytes ─────
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
  node "$PREFIX/node_modules/@flywheel/onboard/bin/flywheel-onboard.js" </dev/null 2>&1)"
BIN_RC=$?
if [ "$BIN_RC" -ne 0 ] && [ -n "$BIN_OUT" ] && ! grep -q "Cannot find module" <<<"$BIN_OUT"; then
  pass "P3b installed bin executes (honest failure without key/endpoint, rc=$BIN_RC)"
else
  fail "P3b installed bin: rc=$BIN_RC out=[$(head -3 <<<"$BIN_OUT")]"
fi

# ── P4 · npm publish --dry-run: whitelist only, zero registry contact ───────
NPMRC="$SANDBOX/npmrc"
printf 'registry=http://127.0.0.1:1/\n//127.0.0.1:1/:_authToken=dry-run-placeholder\n' > "$NPMRC"
DRY_OUT="$(cd "$SHELL_DIR" && npm publish --dry-run --userconfig "$NPMRC" 2>&1)"
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

# ── P5 · placeholder endpoint still blocks a REAL staging ───────────────────
if node "$PREPARE" --out "$SANDBOX/stage2" >/dev/null 2>"$SANDBOX/p5.err"; then
  fail "P5 prepare must refuse while DEFAULT_ENDPOINT is the placeholder"
else
  grep -q "placeholder" "$SANDBOX/p5.err" \
    && pass "P5 prepare refuses the placeholder endpoint (real publish stays gated)" \
    || fail "P5 refused but with the wrong reason: $(cat "$SANDBOX/p5.err")"
fi

echo "RESULTS: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1

#!/bin/bash
# FLY-1062 PR4 · PO_RELEASE_VERSION injection (plan B0-3) — hermetic, fixture
# mini-monorepo (same idiom as package-onboard.test.sh).
#
#   V1 reverse-compat sentinel: PO_RELEASE_VERSION unset → assembled version,
#      sentinel, and gate behavior are EXACTLY today's (base from doc/VERSION)
#   V2 legal injection: base-beta.N stamps package.json + sentinel; gate PASSES
#      (derivation rule: base or base-beta.N)
#   V3 illegal injections fail the BUILD (different base / garbage / clean
#      bump) — an arbitrary version can never enter a payload
#   V4 gate negative: a tarball whose version is NOT a derivation of
#      doc/VERSION fails the gate even if internally consistent
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "ERROR: npm required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PO="$REPO_ROOT/scripts/package-onboard.sh"
[ -d "$REPO_ROOT/node_modules/typescript" ] || { echo "ERROR: node_modules/typescript missing — run pnpm install"; exit 1; }

SANDBOX="$(mktemp -d -t fly1062-pover-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

FIX="$SANDBOX/fixture-repo"
mkdir -p "$FIX/doc" "$FIX/scripts/lib" "$FIX/agents" "$FIX/node_modules" \
         "$FIX/packages/alpha/dist" "$FIX/scripts/packaged"
echo "v9.9.9" > "$FIX/doc/VERSION"
cp -p "$REPO_ROOT/scripts/flywheel-onboard.sh" "$FIX/scripts/flywheel-onboard.sh"
cp -p "$REPO_ROOT/scripts/lib/fleet-sanitize.sh" "$FIX/scripts/lib/fleet-sanitize.sh"
ln -s "$REPO_ROOT/node_modules/typescript" "$FIX/node_modules/typescript"
echo "# generic executor" > "$FIX/agents/generic-executor.md"
cat > "$FIX/packages/alpha/package.json" <<'EOF'
{ "name": "fw-alpha", "version": "0.1.0", "dependencies": {} }
EOF
echo 'export const startBridge = (x) => x;' > "$FIX/packages/alpha/dist/index.js"
cat > "$FIX/scripts/run-bridge.ts" <<'EOF'
import { startBridge } from "../packages/alpha/dist/index.js";
startBridge(0);
EOF
cat > "$FIX/files.allow" <<'EOF'
package.json
LICENSE
README.md
.flywheel-prebuilt
dist/run-bridge.js
agents/generic-executor.md
scripts/flywheel-onboard.sh
node_modules/fw-alpha/package.json
node_modules/fw-alpha/dist/*
EOF
printf '# fixture: no registered occurrences\n' > "$FIX/grep.allow"

# run_po <fn-and-args...> — run a pipeline function inside the fixture policy.
# Inject PO_RELEASE_VERSION by prefixing the call (exported prefix assignments
# pass through env, which does not clear the environment).
run_po() {
  env PACKAGE_ONBOARD_SOURCED=1 \
    PO_PACKAGES="alpha" \
    PO_PACKAGE_ASSETS=" " \
    PO_PACKAGE_ASSET_FILES=" " \
    PO_SCRIPT_FILES="flywheel-onboard.sh" \
    PO_SCRIPT_DIRS=" " \
    PO_AGENT_FILES="generic-executor.md" \
    PO_FILES_ALLOWLIST="$FIX/files.allow" \
    PO_GREP_ALLOWLIST="$FIX/grep.allow" \
    bash -c 'source "$1"; shift; "$@"' _ "$PO" "$@"
}

# ── V1 · reverse-compat sentinel (unset → today's bytes) ────────────────────
TREE="$SANDBOX/tree-default"
if run_po po_assemble "$FIX" "$TREE" >/dev/null 2>&1 \
   && [ "$(jq -r '.version' "$TREE/package.json")" = "9.9.9" ] \
   && [ "$(tr -d '[:space:]' < "$TREE/.flywheel-prebuilt")" = "9.9.9" ]; then
  pass "V1a default path stamps the doc/VERSION base verbatim (sentinel)"
else
  fail "V1a default assembly drifted"
fi
if run_po po_gate "$TREE" "$FIX" >/dev/null 2>&1; then
  pass "V1b default gate still PASSES (old exact-equality is a subset of derivation)"
else
  fail "V1b default gate broke"
fi

# ── V2 · legal beta injection ────────────────────────────────────────────────
TREE2="$SANDBOX/tree-beta"
if PO_RELEASE_VERSION="9.9.9-beta.3" run_po po_assemble "$FIX" "$TREE2" >/dev/null 2>&1 \
   && [ "$(jq -r '.version' "$TREE2/package.json")" = "9.9.9-beta.3" ] \
   && [ "$(tr -d '[:space:]' < "$TREE2/.flywheel-prebuilt")" = "9.9.9-beta.3" ]; then
  pass "V2a beta derivation stamps package.json + sentinel"
else
  fail "V2a beta injection did not stamp"
fi
if run_po po_gate "$TREE2" "$FIX" >/dev/null 2>&1; then
  pass "V2b gate accepts a legal base-beta.N derivation"
else
  fail "V2b gate refused a legal derivation"
fi

# ── V3 · illegal injections fail the build ───────────────────────────────────
for bad in "9.9.10" "8.0.0-beta.1" "9.9.9-rc.1" "9.9.9-beta.x" "evil;rm -rf"; do
  if PO_RELEASE_VERSION="$bad" run_po po_assemble "$FIX" "$SANDBOX/tree-bad" >/dev/null 2>&1; then
    fail "V3 build accepted illegal PO_RELEASE_VERSION '$bad'"
  else
    pass "V3 build refused illegal PO_RELEASE_VERSION '$bad'"
  fi
done

# ── V4 · gate refuses a non-derivation tarball ───────────────────────────────
TREE4="$SANDBOX/tree-nonderiv"
PO_RELEASE_VERSION="9.9.9-beta.3" run_po po_assemble "$FIX" "$TREE4" >/dev/null 2>&1
# forge a consistent-but-foreign version pair (internally equal, wrong base)
jq '.version = "8.8.8"' "$TREE4/package.json" > "$TREE4/package.json.tmp" \
  && mv "$TREE4/package.json.tmp" "$TREE4/package.json"
printf '8.8.8\n' > "$TREE4/.flywheel-prebuilt"
if run_po po_gate "$TREE4" "$FIX" >/dev/null 2>&1; then
  fail "V4 gate accepted a version that is no derivation of doc/VERSION"
else
  pass "V4 gate refuses a non-derivation payload version"
fi

echo ""
echo "package-onboard-version-injection: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]

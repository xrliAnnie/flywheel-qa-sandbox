#!/bin/bash
# FLY-1062 P0: package-onboard.sh — the channel-agnostic packaging pipeline,
# exercised against a FIXTURE mini-monorepo (hermetic; real npm pack, zero
# network, zero real-repo state).
#
# Covers (plan §P0 验收):
#   A1  assembly: embedded workspace packages at node_modules/<npm-name>/ +
#       dependency-union payload package.json + file:/bundleDependencies pairing
#       + sentinel + mirror map (the plan's RED starting point)
#   A2  onboard skin patch: git-clone fetch skin replaced, private URL gone,
#       Buddy handoff preserved; anchor drift FAILS the build
#   A3  run-bridge compile: ../packages/<dir>/dist imports rewritten to
#       ../node_modules/<name>/dist, type annotations stripped
#   A4  non-runtime residue stripped (.map/.d.ts/__tests__)
#   A5  idempotence: re-running assembly converges (diff -r empty)
#   U1-U4 dependency union: single/intersecting ranges unify; UNREGISTERED
#       disjoint fails; registered nest vendors the declarer's own resolved
#       closure; "-" resolution-uniform verifies each declarer's real resolution
#   G0-G5 release gates on the packed tarball: clean PASS; secret injection,
#       allowlist escape, forbidden content (.ts/src), unregistered repo-access
#       reference, version mismatch each FAIL
#   M1  create-compat-mirror.sh: packages/<dir> symlinks + vendored nested
#       closure copied into the target package's node_modules/
#   X1  audit-table closure: every default PO_SCRIPT_FILES entry has a row in
#       the packaged-path audit table (a script entering the payload without a
#       disposition fails here)
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "ERROR: npm required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PO="$REPO_ROOT/scripts/package-onboard.sh"
[ -d "$REPO_ROOT/node_modules/typescript" ] || { echo "ERROR: node_modules/typescript missing — run pnpm install"; exit 1; }

SANDBOX="$(mktemp -d -t fly1062-po-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

# ── fixture mini-monorepo ────────────────────────────────────────────────────
FIX="$SANDBOX/fixture-repo"
mk_fixture() {
  rm -rf "$FIX"
  mkdir -p "$FIX/doc" "$FIX/scripts/lib" "$FIX/.flywheel/agents/nodes" "$FIX/node_modules" \
           "$FIX/packages/alpha/dist" "$FIX/packages/beta/dist" \
           "$FIX/packages/alpha/node_modules/zeta" \
           "$FIX/packages/alpha/node_modules/omega" \
           "$FIX/scripts/packaged"
  echo "v9.9.9" > "$FIX/doc/VERSION"
  # real scripts the pipeline patches/sources
  cp -p "$REPO_ROOT/scripts/flywheel-onboard.sh" "$FIX/scripts/flywheel-onboard.sh"
  cp -p "$REPO_ROOT/scripts/lib/fleet-sanitize.sh" "$FIX/scripts/lib/fleet-sanitize.sh"
  # real typescript for the run-bridge transpile step
  ln -s "$REPO_ROOT/node_modules/typescript" "$FIX/node_modules/typescript"
  printf 'nodes:\n  general:\n    file: nodes/general.md\n    label: General\n' > "$FIX/.flywheel/agents/registry.yaml"
  echo "# general" > "$FIX/.flywheel/agents/nodes/general.md"

  cat > "$FIX/packages/alpha/package.json" <<'EOF'
{ "name": "fw-alpha", "version": "0.1.0",
  "files": ["dist"],
  "dependencies": { "lodash-x": "^1.2.0", "zeta": "^3.0.0", "omega": "^3.0.0", "fw-beta": "workspace:*" } }
EOF
  cat > "$FIX/packages/beta/package.json" <<'EOF'
{ "name": "fw-beta", "version": "0.1.0",
  "dependencies": { "lodash-x": "^1.4.0", "zeta": "^4.0.0", "omega": "^4.0.0" } }
EOF
  echo 'export const startBridge = (x) => x;' > "$FIX/packages/alpha/dist/index.js"
  echo '//# sourceMappingURL=index.js.map'   >> "$FIX/packages/alpha/dist/index.js"
  echo '{"sourcesContent":["const leak: string = 1"]}' > "$FIX/packages/alpha/dist/index.js.map"
  echo 'export declare const startBridge: any;' > "$FIX/packages/alpha/dist/index.d.ts"
  mkdir -p "$FIX/packages/beta/dist/__tests__"
  echo 'export const b = 1;' > "$FIX/packages/beta/dist/index.js"
  echo 'test' > "$FIX/packages/beta/dist/__tests__/b.test.js"

  # resolved deps in alpha's own node_modules (pnpm-realpath stand-ins):
  # zeta resolves to 3.5.0 (its true major — the nested-vendor case) and omega
  # to 4.2.0 (resolution-uniform: manifest ^3 but the store holds only v4).
  cat > "$FIX/packages/alpha/node_modules/zeta/package.json" <<'EOF'
{ "name": "zeta", "version": "3.5.0", "dependencies": {} }
EOF
  echo 'module.exports = 3;' > "$FIX/packages/alpha/node_modules/zeta/index.js"
  cat > "$FIX/packages/alpha/node_modules/omega/package.json" <<'EOF'
{ "name": "omega", "version": "4.2.0", "dependencies": {} }
EOF
  echo 'module.exports = 4;' > "$FIX/packages/alpha/node_modules/omega/index.js"

  cat > "$FIX/scripts/run-bridge.ts" <<'EOF'
import { startBridge } from "../packages/alpha/dist/index.js";
const label: string = "fixture";
startBridge(label);
EOF

  # union exceptions: zeta nests alpha's own resolved copy under the winner ^4;
  # omega is resolution-uniform ("-": every declarer really resolves v4).
  printf 'zeta\t^4.0.0\talpha\nomega\t^4.0.0\t-\n' > "$FIX/scripts/packaged/dependency-union-exceptions.tsv"

  # payload path allowlist for the fixture shape
  cat > "$FIX/files.allow" <<'EOF'
package.json
LICENSE
README.md
.flywheel-prebuilt
dist/run-bridge.js
.flywheel/agents/registry.yaml
.flywheel/agents/nodes/general.md
scripts/flywheel-onboard.sh
node_modules/fw-alpha/package.json
node_modules/fw-alpha/dist/*
node_modules/fw-beta/package.json
node_modules/fw-beta/dist/*
vendor/fw-alpha/*
EOF
  # repo-access grep allowlist: empty (fixture payload must be reference-free)
  printf '# fixture: no registered occurrences\n' > "$FIX/grep.allow"
}

# run_po <fn-and-args...> — run a pipeline function inside the fixture policy.
run_po() {
  # NB: overrides use a single SPACE for "none" — ${VAR:-default} treats an
  # empty string as unset and would fall back to the real policy lists.
  env PACKAGE_ONBOARD_SOURCED=1 \
    NPM_CONFIG_CACHE="$SANDBOX/npm-cache" \
    PO_PACKAGES="alpha beta" \
    PO_PACKAGE_ASSETS=" " \
    PO_PACKAGE_ASSET_FILES=" " \
    PO_SCRIPT_FILES="flywheel-onboard.sh" \
    PO_SCRIPT_DIRS=" " \
    PO_AGENT_FILES="registry.yaml
nodes/general.md" \
    PO_MENU_FILES=" " \
    PO_FILES_ALLOWLIST="$FIX/files.allow" \
    PO_GREP_ALLOWLIST="$FIX/grep.allow" \
    bash -c 'source "$1"; shift; "$@"' _ "$PO" "$@"
}

mk_fixture
TREE="$SANDBOX/tree"

# ── A1 · assembly shape ──────────────────────────────────────────────────────
if run_po po_assemble "$FIX" "$TREE" >/dev/null 2>&1; then
  ok=1
  [ -f "$TREE/node_modules/fw-alpha/dist/index.js" ] || ok=0
  [ -f "$TREE/node_modules/fw-beta/dist/index.js" ] || ok=0
  [ -f "$TREE/.flywheel/agents/registry.yaml" ] || ok=0
  [ -f "$TREE/.flywheel/agents/nodes/general.md" ] || ok=0
  [ "$(cat "$TREE/.flywheel-prebuilt")" = "9.9.9" ] || ok=0
  [ "$(jq -r '.version' "$TREE/package.json")" = "9.9.9" ] || ok=0
  [ "$(jq -r '.dependencies["lodash-x"]' "$TREE/package.json")" = "^1.4.0" ] || ok=0
  [ "$(jq -r '.dependencies["fw-alpha"]' "$TREE/package.json")" = "file:node_modules/fw-alpha" ] || ok=0
  [ "$(jq -r '.bundleDependencies | sort | join(",")' "$TREE/package.json")" = "fw-alpha,fw-beta" ] || ok=0
  [ "$(jq -r '.flywheelPackagesMirror.alpha' "$TREE/package.json")" = "fw-alpha" ] || ok=0
  [ "$(jq -r '.license' "$TREE/package.json")" = "UNLICENSED" ] || ok=0
  # Lead guardrail (Tadashi, 2026-07-09): PR1 must NOT be publishable — a
  # key-less public package of the payload IS the channel-A shape Annie
  # rejected. `private: true` makes npm refuse `npm publish` outright.
  [ "$(jq -r '.private' "$TREE/package.json")" = "true" ] || ok=0
  # embedded package.json must NOT keep its own files whitelist (npm pack
  # re-applies it to bundled deps and silently drops runtime assets)
  [ "$(jq -r 'has("files")' "$TREE/node_modules/fw-alpha/package.json")" = "false" ] || ok=0
  [ "$ok" -eq 1 ] && pass "A1 assembly: embedded packages + union + file:/bundle pairing + sentinel + mirror map" \
                 || fail "A1 tree shape wrong: $(jq -c '{deps:.dependencies,bundle:.bundleDependencies}' "$TREE/package.json" 2>/dev/null)"
else
  fail "A1 po_assemble failed: $(run_po po_assemble "$FIX" "$TREE" 2>&1 | tail -5)"
fi

# ── A2 · onboard skin patch ──────────────────────────────────────────────────
onboard="$TREE/scripts/flywheel-onboard.sh"
if ! grep -q "git clone" "$onboard" && ! grep -q "FLYWHEEL_ONBOARD_REPO" "$onboard" \
   && grep -q "FO_BUDDY_SHELL" "$onboard" && grep -q "安装文件不完整" "$onboard"; then
  pass "A2 onboard patch: clone skin gone, honest error in, Buddy handoff intact"
else
  fail "A2 patched onboard wrong"
fi
# anchor drift must FAIL the build, never silently partial-patch
mk_fixture
sed -i '' 's/^# ── 2\. fetch the working copy when not already in one.*$/# (anchor drifted)/' "$FIX/scripts/flywheel-onboard.sh" 2>/dev/null \
  || sed -i 's/^# ── 2\. fetch the working copy when not already in one.*$/# (anchor drifted)/' "$FIX/scripts/flywheel-onboard.sh"
if run_po po_assemble "$FIX" "$SANDBOX/tree-drift" >/dev/null 2>&1; then
  fail "A2b anchor drift did NOT fail the build"
else
  pass "A2b anchor drift fails the build (drift guard)"
fi
mk_fixture
run_po po_assemble "$FIX" "$TREE" >/dev/null 2>&1 || { echo "FATAL: reassembly failed"; exit 1; }

# ── A3 · run-bridge compile ──────────────────────────────────────────────────
rb="$TREE/dist/run-bridge.js"
if [ -f "$rb" ] && grep -q "../node_modules/fw-alpha/dist/index.js" "$rb" \
   && ! grep -q "packages/alpha" "$rb" && ! grep -q ": string" "$rb"; then
  pass "A3 run-bridge compiled: imports rewritten to node_modules, types stripped"
else
  fail "A3 run-bridge compile wrong: $(cat "$rb" 2>/dev/null)"
fi

# ── A4 · residue strip ───────────────────────────────────────────────────────
if [ -z "$(find "$TREE/node_modules" -name '*.map' -o -name '*.d.ts' -o -type d -name '__tests__' 2>/dev/null)" ]; then
  pass "A4 residue stripped: no sourcemaps / declarations / __tests__ in embedded packages"
else
  fail "A4 residue left: $(find "$TREE/node_modules" -name '*.map' -o -name '*.d.ts' -o -type d -name '__tests__')"
fi

# ── A5 · idempotence ─────────────────────────────────────────────────────────
run_po po_assemble "$FIX" "$SANDBOX/tree2" >/dev/null 2>&1
if diff -r "$TREE" "$SANDBOX/tree2" >/dev/null 2>&1; then
  pass "A5 assembly idempotent (re-run diff empty)"
else
  fail "A5 assembly not deterministic: $(diff -r "$TREE" "$SANDBOX/tree2" 2>&1 | head -3)"
fi

# ── U1 · unregistered disjoint conflict fails ────────────────────────────────
mk_fixture
printf '# nothing registered\n' > "$FIX/scripts/packaged/dependency-union-exceptions.tsv"
out="$(run_po po_dependency_union "$FIX" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && grep -q "zeta" <<<"$out"; then
  pass "U1 unregistered disjoint conflict fails the build (named in the error)"
else
  fail "U1 rc=$rc out=$out"
fi

# ── U2 · registered nest vendors the declarer's resolved closure ─────────────
mk_fixture
out="$(run_po po_dependency_union "$FIX" 2>/dev/null)"; rc=$?
if [ "$rc" -eq 0 ] \
   && [ "$(jq -r '.union.zeta' <<<"$out")" = "^4.0.0" ] \
   && [ "$(jq -c '.nested' <<<"$out")" = '[{"pkgDir":"alpha","dep":"zeta"}]' ]; then
  pass "U2 registered disjoint: winner unions top-level, declarer nests"
else
  fail "U2 rc=$rc out=$out"
fi

# ── U3 · '-' resolution-uniform verifies the real resolution ─────────────────
if [ "$(jq -r '.union.omega' <<<"$out")" = "^4.0.0" ] \
   && ! jq -e '.nested[] | select(.dep=="omega")' <<<"$out" >/dev/null; then
  pass "U3 resolution-uniform '-': verified against real resolution, no nesting"
else
  fail "U3 out=$out"
fi
# violated uniformity must fail: alpha really resolves omega@3 → '-' is a lie
mk_fixture
jq '.version="3.1.0"' "$FIX/packages/alpha/node_modules/omega/package.json" > "$SANDBOX/om.tmp" \
  && mv "$SANDBOX/om.tmp" "$FIX/packages/alpha/node_modules/omega/package.json"
out="$(run_po po_dependency_union "$FIX" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && grep -q "resolution-uniform violated" <<<"$out"; then
  pass "U3b '-' with a divergent real resolution fails the build"
else
  fail "U3b rc=$rc out=$out"
fi

# ── U4 · nest-set drift fails ────────────────────────────────────────────────
mk_fixture
printf 'zeta\t^4.0.0\talpha,beta\nomega\t^4.0.0\t-\n' > "$FIX/scripts/packaged/dependency-union-exceptions.tsv"
out="$(run_po po_dependency_union "$FIX" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && grep -q "nest-set drift" <<<"$out"; then
  pass "U4 exception nest-set drift fails the build"
else
  fail "U4 rc=$rc out=$out"
fi

# ── G0 · pack + gates: clean PASS ────────────────────────────────────────────
mk_fixture
run_po po_assemble "$FIX" "$TREE" >/dev/null 2>&1
TARBALL="$(run_po po_pack "$TREE" "$SANDBOX/out" 2>"$SANDBOX/npm-pack.log")"
if [ -n "$TARBALL" ] && [ -f "$TARBALL" ]; then
  pass "G0a npm pack produced a tarball"
else
  fail "G0a npm pack failed: $(tail -8 "$SANDBOX/npm-pack.log")"; TARBALL=""
fi
if [ -n "$TARBALL" ] && run_po po_gate_tarball "$TARBALL" "$FIX" >/dev/null 2>&1; then
  pass "G0b release gates PASS on a clean payload tarball"
else
  fail "G0b clean tarball failed gates: $(run_po po_gate_tarball "$TARBALL" "$FIX" 2>&1 | tail -6)"
fi
# the vendored nested closure must ride the tarball (staged under vendor/).
# Capture once so grep -q cannot close tar's stdout early under pipefail (SIGPIPE).
TARBALL_CONTENTS=""
TARBALL_LIST_OK=0
if [ -n "$TARBALL" ] && TARBALL_CONTENTS="$(tar -tzf "$TARBALL" 2>/dev/null)"; then
  TARBALL_LIST_OK=1
fi
if [ "$TARBALL_LIST_OK" -eq 1 ] \
   && grep -Fqx "package/vendor/fw-alpha/zeta/package.json" <<<"$TARBALL_CONTENTS" \
   && grep -Fqx "package/node_modules/fw-alpha/dist/index.js" <<<"$TARBALL_CONTENTS"; then
  pass "G0c tarball carries bundled packages AND the staged vendor closure"
else
  fail "G0c tarball contents: $(head -20 <<<"$TARBALL_CONTENTS")"
fi

# gate-injection helper: unpack the clean tarball, mutate, gate the tree.
gate_mutated() { # <mutation-fn-name>
  local dir="$SANDBOX/mut.$RANDOM"
  mkdir -p "$dir" && tar -xzf "$TARBALL" -C "$dir"
  "$1" "$dir/package"
  run_po po_gate "$dir/package" "$FIX" >"$SANDBOX/gate.log" 2>&1
  local rc=$?
  rm -rf "$dir"
  return "$rc"
}

# ── G1 · secret injection fails gate① ───────────────────────────────────────
mut_secret() { echo 'token="ghp_ABCdef0123456789ABCdef0123456789abcd"' > "$1/scripts/leak.sh"; }
if gate_mutated mut_secret; then fail "G1 secret injection passed the gates"; else
  grep -q "gate①\|secret" "$SANDBOX/gate.log" && pass "G1 injected vendor token fails gate①" \
    || pass "G1 injected vendor token fails the gates"
fi

# ── G2 · un-allowlisted file fails gate② ────────────────────────────────────
mut_newfile() { echo 'x' > "$1/scripts/unregistered-helper.sh"; }
if gate_mutated mut_newfile; then fail "G2 un-allowlisted file passed the gates"; else
  grep -q "NOT in the release allowlist" "$SANDBOX/gate.log" && pass "G2 un-allowlisted file fails gate② (snapshot discipline)" \
    || fail "G2 failed but not via gate②: $(cat "$SANDBOX/gate.log")"
fi

# ── G3 · forbidden content fails gate③ ──────────────────────────────────────
mut_ts() { mkdir -p "$1/src"; echo 'const a: string = "x";' > "$1/src/leak.ts"; }
if gate_mutated mut_ts; then fail "G3 .ts/src content passed the gates"; else
  grep -q "gate③\|forbidden content" "$SANDBOX/gate.log" && pass "G3 .ts + src/ fail gate③" \
    || fail "G3 failed but not via gate③: $(cat "$SANDBOX/gate.log")"
fi

# ── G4 · unregistered repo-access reference fails gate④ ─────────────────────
mut_clone() { sed -i.bak 's|^# ── 2\.|# git clone https://github.com/xrliAnnie/flywheel.git\n# ── 2.|' "$1/scripts/flywheel-onboard.sh" 2>/dev/null; rm -f "$1/scripts/flywheel-onboard.sh.bak"; }
if gate_mutated mut_clone; then fail "G4 repo-access reference passed the gates"; else
  grep -q "UNREGISTERED repo-access" "$SANDBOX/gate.log" && pass "G4 unregistered git-clone/private-slug reference fails gate④" \
    || fail "G4 failed but not via gate④: $(cat "$SANDBOX/gate.log")"
fi

# ── G5 · version mismatch fails ──────────────────────────────────────────────
mut_ver() { echo "0.0.1" > "$1/.flywheel-prebuilt"; }
if gate_mutated mut_ver; then fail "G5 version mismatch passed the gates"; else
  grep -q "version mismatch" "$SANDBOX/gate.log" && pass "G5 sentinel/package.json/doc-VERSION mismatch fails" \
    || fail "G5 failed but not via version check: $(cat "$SANDBOX/gate.log")"
fi

# ── M1 · compat mirror on an installed-shape tree ────────────────────────────
MIR="$SANDBOX/mirror-root"
mkdir -p "$MIR" && tar -xzf "$TARBALL" -C "$MIR"
if bash "$REPO_ROOT/scripts/packaged/create-compat-mirror.sh" "$MIR/package" >/dev/null 2>&1 \
   && [ "$(readlink "$MIR/package/packages/alpha")" = "../node_modules/fw-alpha" ] \
   && [ -f "$MIR/package/packages/alpha/dist/index.js" ] \
   && [ "$(jq -r '.version' "$MIR/package/node_modules/fw-alpha/node_modules/zeta/package.json")" = "3.5.0" ]; then
  pass "M1 compat mirror: packages/ symlinks + vendored closure installed nested"
else
  fail "M1 mirror wrong: link=$(readlink "$MIR/package/packages/alpha" 2>/dev/null) zeta=$(jq -r '.version' "$MIR/package/node_modules/fw-alpha/node_modules/zeta/package.json" 2>/dev/null)"
fi
# idempotent re-run
if bash "$REPO_ROOT/scripts/packaged/create-compat-mirror.sh" "$MIR/package" >/dev/null 2>&1; then
  pass "M1b compat mirror idempotent"
else
  fail "M1b mirror re-run failed"
fi
# npm's unreified nested-dep husk (empty dir, no package.json) must be pruned —
# an existing dir terminates ESM walk-up and shadows the flat-installed copy.
mkdir -p "$MIR/package/node_modules/@husk-scope/ghost" "$MIR/package/node_modules/plain-ghost"
if bash "$REPO_ROOT/scripts/packaged/create-compat-mirror.sh" "$MIR/package" >/dev/null 2>&1 \
   && [ ! -e "$MIR/package/node_modules/@husk-scope" ] \
   && [ ! -e "$MIR/package/node_modules/plain-ghost" ] \
   && [ -f "$MIR/package/node_modules/fw-alpha/dist/index.js" ]; then
  pass "M1c mirror prunes empty husk dirs (scoped + plain), real content untouched"
else
  fail "M1c husk pruning wrong: $(ls "$MIR/package/node_modules" 2>/dev/null | tr '\n' ' ')"
fi

# ── F1 · force-nested registration vendors without a declared conflict ───────
mk_fixture
mkdir -p "$FIX/packages/beta/node_modules/lodash-x"
cat > "$FIX/packages/beta/node_modules/lodash-x/package.json" <<'EOF'
{ "name": "lodash-x", "version": "1.4.2", "dependencies": {} }
EOF
echo 'module.exports = 1;' > "$FIX/packages/beta/node_modules/lodash-x/index.js"
printf 'beta\tlodash-x\tfixture install-time hoist conflict\n' > "$FIX/force-nest.tsv"
if PO_FORCE_NESTED="$FIX/force-nest.tsv" run_po po_assemble "$FIX" "$SANDBOX/tree-fn" >/dev/null 2>&1 \
   && [ "$(jq -r '.version' "$SANDBOX/tree-fn/vendor/fw-beta/lodash-x/package.json" 2>/dev/null)" = "1.4.2" ]; then
  pass "F1 force-nested row vendors the declarer's resolved closure (no declared conflict needed)"
else
  fail "F1 force-nest staging wrong"
fi
# a registered dir with NO resolved copy must fail the build (never silent)
printf 'alpha\tno-such-dep\tbroken row\n' > "$FIX/force-nest.tsv"
if PO_FORCE_NESTED="$FIX/force-nest.tsv" run_po po_assemble "$FIX" "$SANDBOX/tree-fn2" >/dev/null 2>&1; then
  fail "F1b unresolvable force-nest row did NOT fail the build"
else
  pass "F1b unresolvable force-nest row fails the build"
fi

# ── X0 · launcher runtime closure stays complete ──────────────────────────────
default_asset_files="$(env PACKAGE_ONBOARD_SOURCED=1 bash -c 'source "$1"; printf "%s\n" "$PO_PACKAGE_ASSET_FILES"' _ "$PO")"
if grep -qx 'teamlead:scripts/lib/lead-identity-preflight.sh' <<<"$default_asset_files" \
    && grep -qx 'teamlead:scripts/lead-body.sh' <<<"$default_asset_files" \
    && grep -qx 'teamlead:scripts/lib/lead-body-receipt.sh' <<<"$default_asset_files" \
    && grep -qx 'teamlead:scripts/session-start-adopt-inflight.sh' <<<"$default_asset_files" \
    && grep -qx 'teamlead:scripts/lib/lead-session-authority.sh' <<<"$default_asset_files" \
    && grep -qx 'teamlead:scripts/lib/lead-session-resume-gate.sh' <<<"$default_asset_files" \
    && grep -qx 'teamlead:scripts/lib/session-ctx-usage.mjs' <<<"$default_asset_files" \
    && env PACKAGE_ONBOARD_SOURCED=1 bash -c 'source "$1"; grep -qx "lib/lead-body-evidence.sh" <<<"$PO_SCRIPT_FILES"' _ "$PO"; then
  pass "X0 Lead v2 identity, context gate, clear handoff, body, and evidence assets ship with the launcher runtime closure"
else
  fail "X0 Lead launcher body assets missing from PO_PACKAGE_ASSET_FILES"
fi

# ── X1 · audit-table closure over the REAL default whitelist ─────────────────
AUDIT="$REPO_ROOT/engineering/doc/FLY-1062-npm-distribution/packaged-path-audit.md"
if [ -f "$AUDIT" ]; then
  missing=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    grep -qF "$(basename "$f")" "$AUDIT" || missing="$missing $f"
  done < <(env PACKAGE_ONBOARD_SOURCED=1 bash -c 'source "'"$PO"'"; printf "%s\n" "$PO_SCRIPT_FILES"')
  if [ -z "$missing" ]; then
    pass "X1 every default PO_SCRIPT_FILES entry has an audit-table row"
  else
    fail "X1 scripts in the payload whitelist with NO audit disposition:$missing"
  fi
else
  fail "X1 packaged-path audit table missing at $AUDIT"
fi

# ── X2 · PR1 guardrail: the pipeline contains NO publish action ──────────────
# Lead guardrail (Tadashi, 2026-07-09): until P3 key-gating lands, nothing in
# this layer may publish the payload anywhere a customer could reach key-less.
if ! grep -rn "npm publish" "$REPO_ROOT/scripts/package-onboard.sh" "$REPO_ROOT/scripts/packaged/" >/dev/null 2>&1; then
  pass "X2 packaging layer carries zero publish actions (PR1 guardrail)"
else
  fail "X2 publish action found in the packaging layer: $(grep -rn 'npm publish' "$REPO_ROOT/scripts/package-onboard.sh" "$REPO_ROOT/scripts/packaged/")"
fi

echo ""
echo "package-onboard: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]

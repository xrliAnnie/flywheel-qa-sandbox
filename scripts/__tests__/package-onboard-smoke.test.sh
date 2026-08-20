#!/bin/bash
# FLY-1062 P0 install smoke — the REAL npm full chain on the REAL repo:
# "installs ≠ boots" is the acceptance bar (plan P0-4 / Codex R1#1).
#
#   ①  real `npm pack` (via package-onboard.sh, gates included) → real
#      `npm install --prefix <tmp>/versions/<ver> <tarball>` under a CLEAN npm
#      userconfig (a host-local allowScripts policy must not leak in — customer
#      machines run install scripts, better-sqlite3 needs its prebuild);
#   ②  compat mirror + §0 layout contract on the installed PKG_ROOT:
#      packages/<dir> symlinks, vendored nested closures (@linear/sdk under
#      teamlead, @anthropic-ai/sdk under claude-runner — the mem0ai peer-hoist
#      case), npm's unreified empty husk dirs pruned;
#   ③  agents/generic-executor.md and menus/shapes/*.yaml resolvable from
#      PKG_ROOT (run-infra + workflow-menu boot assets);
#   ④  every embedded package bare-imports from PKG_ROOT context with zero
#      module-resolution errors; better-sqlite3 native module loads; the Bridge
#      entry (dist/run-bridge.js) starts with a stub env and serves /health;
#      the Lead launcher emits its dry-run launch plan THROUGH the mirror path.
#
# SLOW + NETWORK: npm install resolves the dependency union from the registry.
# Everything runs in a sandbox tmpdir + isolated HOME; no real state touched.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "ERROR: npm required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -d "$REPO_ROOT/packages/teamlead/dist" ] || { echo "SKIP: dist not built — run pnpm build first"; exit 0; }

SANDBOX="$(mktemp -d -t fly1062-smoke-XXXXXX)"
BRIDGE_PID=""
cleanup() {
  [ -n "$BRIDGE_PID" ] && kill "$BRIDGE_PID" 2>/dev/null
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/doc/VERSION")"; VERSION="${VERSION#v}"

# ── ① pack + install ─────────────────────────────────────────────────────────
if ! bash "$REPO_ROOT/scripts/package-onboard.sh" --out "$SANDBOX/payload" > "$SANDBOX/pack.log" 2>&1; then
  fail "①a packaging pipeline failed: $(tail -5 "$SANDBOX/pack.log")"
  echo "package-onboard-smoke: PASSED=$PASSED FAILED=$FAILED"; exit 1
fi
TARBALL="$SANDBOX/payload/flywheel-onboard-payload-$VERSION.tgz"
[ -f "$TARBALL" ] && pass "①a packaging pipeline: gated tarball produced (v$VERSION)" \
                  || { fail "①a tarball missing at $TARBALL"; exit 1; }

PREFIX="$SANDBOX/runtime/versions/$VERSION"
mkdir -p "$PREFIX"
: > "$SANDBOX/npmrc-clean"
if NPM_CONFIG_USERCONFIG="$SANDBOX/npmrc-clean" \
   npm install --prefix "$PREFIX" "$TARBALL" --no-audit --no-fund > "$SANDBOX/install.log" 2>&1; then
  pass "①b real npm install into the version prefix"
else
  fail "①b npm install failed: $(tail -8 "$SANDBOX/install.log")"
  echo "package-onboard-smoke: PASSED=$PASSED FAILED=$FAILED"; exit 1
fi
PKG_ROOT="$PREFIX/node_modules/flywheel-onboard-payload"
[ -f "$PKG_ROOT/.flywheel-prebuilt" ] && [ "$(cat "$PKG_ROOT/.flywheel-prebuilt")" = "$VERSION" ] \
  && pass "①c PKG_ROOT layout: sentinel present, version $VERSION" \
  || fail "①c PKG_ROOT sentinel wrong"

# ── ② compat mirror + layout contract ────────────────────────────────────────
if bash "$PKG_ROOT/scripts/packaged/create-compat-mirror.sh" "$PKG_ROOT" > "$SANDBOX/mirror.log" 2>&1; then
  pass "②a compat mirror ran"
else
  fail "②a compat mirror failed: $(cat "$SANDBOX/mirror.log")"
fi
ok=1
[ "$(readlink "$PKG_ROOT/packages/teamlead")" = "../node_modules/flywheel-teamlead" ] || ok=0
[ -f "$PKG_ROOT/packages/teamlead/scripts/claude-lead.sh" ] || ok=0
[ -f "$PKG_ROOT/packages/teamlead/scripts/lead-body.sh" ] || ok=0
[ -f "$PKG_ROOT/packages/teamlead/scripts/lib/lead-body-receipt.sh" ] || ok=0
[ -f "$PKG_ROOT/packages/teamlead/scripts/session-start-adopt-inflight.sh" ] || ok=0
[ -f "$PKG_ROOT/packages/teamlead/scripts/lib/lead-session-authority.sh" ] || ok=0
[ -f "$PKG_ROOT/packages/teamlead/scripts/lib/lead-session-resume-gate.sh" ] || ok=0
[ -f "$PKG_ROOT/packages/teamlead/scripts/lib/session-ctx-usage.mjs" ] || ok=0
[ -f "$PKG_ROOT/scripts/lib/lead-restart-lifecycle.sh" ] || ok=0
[ -f "$PKG_ROOT/scripts/lib/lead-body-sweep.sh" ] || ok=0
[ -f "$PKG_ROOT/scripts/lib/lead-body-evidence.sh" ] || ok=0
[ -f "$PKG_ROOT/scripts/lib/tmux-server-rescue.sh" ] || ok=0
[ -f "$PKG_ROOT/packages/flywheel-comm/dist/index.js" ] || ok=0
[ "$ok" -eq 1 ] && pass "②b monorepo path contracts hold through the mirror" \
              || fail "②b path contracts broken"
# vendored nested closures landed inside their packages
v1="$(jq -r '.version' "$PKG_ROOT/node_modules/flywheel-teamlead/node_modules/@linear/sdk/package.json" 2>/dev/null)"
v2="$(jq -r '.version' "$PKG_ROOT/node_modules/flywheel-claude-runner/node_modules/@anthropic-ai/sdk/package.json" 2>/dev/null)"
if [ -n "$v1" ] && [ -n "$v2" ]; then
  pass "②c vendored nested deps installed (teamlead @linear/sdk@$v1, claude-runner @anthropic-ai/sdk@$v2)"
else
  fail "②c vendored nested deps missing (linear='$v1' anthropic='$v2')"
fi
# npm's unreified husk dirs pruned (an empty dir would shadow the flat copy)
husks="$(find "$PKG_ROOT/node_modules" -mindepth 1 -maxdepth 2 -type d -empty 2>/dev/null)"
[ -z "$husks" ] && pass "②d no empty husk dirs shadowing flat-installed deps" \
               || fail "②d empty husk dirs left: $husks"

# ── ③ agents runtime prompts ─────────────────────────────────────────────────
[ -f "$PKG_ROOT/agents/generic-executor.md" ] && [ -f "$PKG_ROOT/agents/qa-executor.md" ] \
  && pass "③ agents/ runtime prompts at PKG_ROOT (run-infra sentinel resolvable)" \
  || fail "③ agents/ prompts missing from PKG_ROOT"
menus_ok=1
for menu in code prd design prototype generic simple_code; do
  [ -f "$PKG_ROOT/menus/shapes/$menu.yaml" ] || menus_ok=0
done
[ "$menus_ok" -eq 1 ] \
  && pass "③a workflow menu shapes at PKG_ROOT (Bridge boot assets resolvable)" \
  || fail "③a workflow menu shapes missing from PKG_ROOT"

# ── ③b claude-runner runtime assets (FLY-1188) ───────────────────────────────
# codex-home.ts resolves these as ../agents / ../bin siblings of dist — a
# payload missing them fail-louds every codex spawn (contract) or breaks the
# rotation shim default (bin).
CR_ROOT="$PKG_ROOT/node_modules/flywheel-claude-runner"
[ -f "$CR_ROOT/agents/codex-runner-contract.md" ] && [ -x "$CR_ROOT/bin/flywheel-codex-with-fallback" ] \
  && pass "③b claude-runner assets shipped (codex contract + rotation shim)" \
  || fail "③b claude-runner assets missing (agents/codex-runner-contract.md or bin/flywheel-codex-with-fallback)"

# ── ④a bare-import matrix ────────────────────────────────────────────────────
SMOKE_HOME="$SANDBOX/home"; mkdir -p "$SMOKE_HOME/.flywheel"
import_fail=""
while IFS= read -r name; do
  printf 'try { await import("%s"); console.log("LOADED"); } catch (e) { console.log("IMPORTERR " + (e.code||"") + " " + String(e).split("\\n")[0]); }\nprocess.exit(0);\n' "$name" > "$PKG_ROOT/.smoke-one.mjs"
  out="$(env HOME="$SMOKE_HOME" FLYWHEEL_STATE_DIR="$SMOKE_HOME/.flywheel" node "$PKG_ROOT/.smoke-one.mjs" </dev/null 2>&1 | tr '\n' ' ')"
  if grep -qE "ERR_MODULE_NOT_FOUND|Cannot find (module|package)" <<<"$out"; then
    import_fail="$import_fail $name"
    echo "    import FAIL: $name :: $out"
  fi
done < <(jq -r '.flywheelPackagesMirror | to_entries[].value' "$PKG_ROOT/package.json")
rm -f "$PKG_ROOT/.smoke-one.mjs"
[ -z "$import_fail" ] && pass "④a every embedded package bare-imports with zero MODULE_NOT_FOUND" \
                     || fail "④a module resolution broken:$import_fail"

# ── ④b native module (better-sqlite3 prebuild) ──────────────────────────────
printf 'import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\nconst db = new (r("better-sqlite3"))(":memory:");\ndb.exec("create table t(x)");\nconsole.log("SQLITE-OK");\n' > "$PKG_ROOT/.smoke-sqlite.mjs"
out="$(node "$PKG_ROOT/.smoke-sqlite.mjs" 2>&1 | tail -1)"; rm -f "$PKG_ROOT/.smoke-sqlite.mjs"
[ "$out" = "SQLITE-OK" ] && pass "④b better-sqlite3 native module loads (install scripts ran)" \
                        || fail "④b better-sqlite3 broken: $out"

# ── ④c Bridge listens with a stub env ────────────────────────────────────────
PORT=$(( (RANDOM % 20000) + 30000 ))
mkdir -p "$SMOKE_HOME/proj"
env -i HOME="$SMOKE_HOME" PATH="$PATH" \
  FLYWHEEL_STATE_DIR="$SMOKE_HOME/.flywheel" \
  TEAMLEAD_PORT="$PORT" TEAMLEAD_API_TOKEN="stub-token-for-smoke" \
  TEAMLEAD_DEFAULT_LEAD_AGENT="smoke-lead" SMOKE_BOT_TOKEN="stub-bot-token" \
  LINEAR_API_KEY="stub" \
  FLYWHEEL_PROJECTS="[{\"projectName\":\"smoke\",\"projectRoot\":\"$SMOKE_HOME/proj\",\"leads\":[{\"agentId\":\"smoke-lead\",\"chatChannel\":\"111\",\"match\":{\"labels\":[\"x\"]},\"botTokenEnv\":\"SMOKE_BOT_TOKEN\",\"botUserId\":\"12345678901234567\",\"canSpawnRunners\":false}]}]" \
  node "$PKG_ROOT/dist/run-bridge.js" > "$SANDBOX/bridge.log" 2>&1 &
BRIDGE_PID=$!
listen=0
for _ in $(seq 1 30); do
  if curl -sf -m 2 "http://localhost:$PORT/health" >/dev/null 2>&1; then listen=1; break; fi
  kill -0 "$BRIDGE_PID" 2>/dev/null || break
  sleep 1
done
if [ "$listen" -eq 1 ]; then
  pass "④c packaged Bridge (dist/run-bridge.js) starts and serves /health"
else
  fail "④c Bridge never became healthy: $(tail -8 "$SANDBOX/bridge.log")"
fi
kill "$BRIDGE_PID" 2>/dev/null; wait "$BRIDGE_PID" 2>/dev/null; BRIDGE_PID=""

# ── ④d Lead launcher dry-run through the mirror path ────────────────────────
LEAD_HOME="$SANDBOX/lead-home"
mkdir -p "$LEAD_HOME/proj/.lead/smoke-lead"
printf -- '---\nname: smoke-lead\n---\nSmoke\n' > "$LEAD_HOME/proj/.lead/smoke-lead/identity.md"
LEAD_PROJECTS="[{\"projectName\":\"smoke\",\"projectRoot\":\"$LEAD_HOME/proj\",\"leads\":[{\"agentId\":\"smoke-lead\",\"chatChannel\":\"111\",\"match\":{\"labels\":[\"x\"]},\"botTokenEnv\":\"SMOKE_BOT_TOKEN\",\"botUserId\":\"12345678901234567\",\"canSpawnRunners\":true}]}]"
out="$(env -i HOME="$LEAD_HOME" PATH="$PATH" \
  FLYWHEEL_LEAD_DRY_RUN=1 FLYWHEEL_PROJECTS="$LEAD_PROJECTS" \
  SMOKE_BOT_TOKEN="stub" TEAMLEAD_API_TOKEN="stub" \
  bash "$PKG_ROOT/packages/teamlead/scripts/claude-lead.sh" smoke-lead "$LEAD_HOME/proj" smoke 2>&1)"
if grep -q "LAUNCH_PLAN_BEGIN" <<<"$out" && grep -q "LAUNCH_PLAN_END" <<<"$out" \
   && grep -qF $'ROLE\tstandard' <<<"$out"; then
  pass "④d Lead launcher dry-run emits its launch plan from the installed tree"
else
  fail "④d Lead launcher dry-run broken: $(tail -12 <<<"$out")"
fi

echo ""
echo "package-onboard-smoke: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]

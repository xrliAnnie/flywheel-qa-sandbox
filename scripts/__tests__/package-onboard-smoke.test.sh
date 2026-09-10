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
#   ③  bundled registry + node implementations resolvable from PKG_ROOT;
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

# Generic voice is part of TeamLead's runtime dependency closure.
if jq -e '
  ([.dependencies[] | select(startswith("workspace:"))] | length) == 0 and
  .flywheelPackagesMirror["voice-core"] == "flywheel-voice-core" and
  .flywheelPackagesMirror["voice-bridge"] == "flywheel-voice-bridge" and
  .flywheelPackagesMirror["voice-codex"] == "flywheel-voice-codex"
' "$SANDBOX/payload/tree/package.json" >/dev/null \
  && tar -tzf "$TARBALL" | grep '^package/node_modules/flywheel-voice-codex/models/silero_vad.onnx$' >/dev/null \
  && tar -tzf "$TARBALL" | grep '^package/node_modules/flywheel-voice-codex/models/LICENSE.silero-vad$' >/dev/null \
  && tar -tzf "$TARBALL" | grep '^package/scripts/flywheel-voice-wrapper.sh$' >/dev/null; then
  pass "①a voice runtime closure includes packages, model, license and wrapper"
else
  fail "①a voice runtime closure missing or workspace protocol leaked"
  exit 1
fi

# Removing voice-core's explicit classification must fail the real payload gate.
sed '/^node_modules\/flywheel-voice-core\//d' \
  "$REPO_ROOT/scripts/package-onboard-files.allow" > "$SANDBOX/no-voice-core.allow"
if (export PACKAGE_ONBOARD_SOURCED=1
    export PO_FILES_ALLOWLIST="$SANDBOX/no-voice-core.allow"
    source "$REPO_ROOT/scripts/package-onboard.sh"
    po_gate_tarball "$TARBALL" "$REPO_ROOT") > "$SANDBOX/voice-allowlist-negative.log" 2>&1; then
  fail "①a removed voice-core allowlist unexpectedly passed"
  exit 1
elif grep -q 'node_modules/flywheel-voice-core/' "$SANDBOX/voice-allowlist-negative.log" \
  && grep -q 'NOT in the release allowlist' "$SANDBOX/voice-allowlist-negative.log"; then
  pass "①a removed voice-core allowlist rejects the real payload"
else
  fail "①a voice-core allowlist mutation failed for an unexpected reason"
  exit 1
fi

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
[ -f "$PKG_ROOT/packages/teamlead/scripts/lib/lead-model-authority-receipt.mjs" ] || ok=0
[ -f "$PKG_ROOT/packages/teamlead/scripts/lib/session-ctx-usage.mjs" ] || ok=0
[ -f "$PKG_ROOT/scripts/lib/lead-restart-lifecycle.sh" ] || ok=0
[ -f "$PKG_ROOT/scripts/lib/lead-body-sweep.sh" ] || ok=0
[ -f "$PKG_ROOT/scripts/lib/lead-body-evidence.sh" ] || ok=0
[ -f "$PKG_ROOT/scripts/lib/flywheel-log.sh" ] || ok=0
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

# The compatibility paths above are symlinks. Invoke these CLIs through those
# exact paths so a lexical main guard cannot turn verification into exit 0.
MIRROR_INSPECTOR="$PKG_ROOT/packages/teamlead/dist/bin/inspect-lead-outbound.js"
mirror_inspector_out="$(node "$MIRROR_INSPECTOR" \
  --state-dir "$SANDBOX/missing-outbound-state" \
  --delivery-id "chat:smoke-codex:30000000000000002" \
  --dedup-db "$SANDBOX/missing-outbound-dedup.db" 2>&1)"
mirror_inspector_rc=$?
if [ "$mirror_inspector_rc" -ne 0 ] \
   && grep -q '"code":"outbound_inspection_error"' <<<"$mirror_inspector_out"; then
  pass "②e outbound inspector executes through the compat symlink"
else
  fail "②e outbound inspector was vacuous through the compat symlink: rc=$mirror_inspector_rc output=$mirror_inspector_out"
fi

MIRROR_PROJECT_ROOT_PREFLIGHT="$PKG_ROOT/packages/teamlead/dist/bin/preflight-codex-project-root.js"
mirror_preflight_out="$(env HOME="$SANDBOX/compat-home" node "$MIRROR_PROJECT_ROOT_PREFLIGHT" \
  --project-root "$SANDBOX/missing-project-root" \
  --state-dir "$SANDBOX/missing-state-dir" \
  --codex-home "$SANDBOX/missing-codex-home" 2>&1)"
mirror_preflight_rc=$?
if [ "$mirror_preflight_rc" -ne 0 ] \
   && grep -q '"code":"codex_project_root_invalid"' <<<"$mirror_preflight_out"; then
  pass "②f Codex project-root preflight rejects invalid input through the compat symlink"
else
  fail "②f Codex project-root preflight was vacuous through the compat symlink: rc=$mirror_preflight_rc output=$mirror_preflight_out"
fi

MIRROR_PROJECTS_VALIDATOR="$PKG_ROOT/packages/teamlead/dist/bin/validate-projects.js"
cat > "$SANDBOX/invalid-projects.json" <<JSON
[
  {
    "projectName":"invalid-smoke-project",
    "projectRoot":"$SANDBOX/invalid-project-root",
    "leads":[{
      "agentId":"invalid-smoke-lead",
      "chatChannel":"30000000000000003",
      "match":{"labels":["invalid-smoke"]},
      "department":""
    }]
  }
]
JSON
mirror_validator_out="$(node "$MIRROR_PROJECTS_VALIDATOR" \
  "$SANDBOX/invalid-projects.json" 2>&1)"
mirror_validator_rc=$?
if [ "$mirror_validator_rc" -eq 1 ] \
   && grep -q 'validate-projects: INVALID:' <<<"$mirror_validator_out"; then
  pass "②g projects validator rejects invalid input through the compat symlink"
else
  fail "②g projects validator was vacuous through the compat symlink: rc=$mirror_validator_rc output=$mirror_validator_out"
fi

# Native model loading and CLI import closure, without daemon startup/network.
cat > "$PKG_ROOT/.smoke-voice.mjs" <<'JS'
import assert from 'node:assert/strict';
import { SileroVad, createInitialSileroState } from './packages/voice-codex/dist/pipeline/SileroVad.js';
import { fileURLToPath } from 'node:url';
await import('@discordjs/voice');
const vad = await SileroVad.create(fileURLToPath(new URL('./packages/voice-codex/models/silero_vad.onnx', import.meta.url)));
try {
  const result = await vad.score(new Float32Array(512), createInitialSileroState());
  assert.ok(Number.isFinite(result.probability));
  assert.ok(result.probability >= 0 && result.probability <= 1);
  console.log('VOICE_NATIVE_OK');
} finally { await vad.close(); }
JS
if (cd "$SANDBOX" && node "$PKG_ROOT/.smoke-voice.mjs") > "$SANDBOX/voice-native.log" 2>&1; then
  pass "②h installed Discord voice and Silero native model execute"
else
  fail "②h installed voice native closure failed: $(tail -8 "$SANDBOX/voice-native.log")"
fi
voice_cli_out="$(env -i PATH="$PATH" HOME="$SANDBOX/voice-home" \
  CODEX_HOME="$SANDBOX/voice-codex-home" node \
  "$PKG_ROOT/packages/voice-codex/dist/cli.js" --check-config 2>&1)"
voice_cli_rc=$?
if [ "$voice_cli_rc" -eq 1 ] && grep -q '^\[voice\] fatal: TEAMLEAD_API_TOKEN is required$' <<<"$voice_cli_out"; then
  pass "②i installed generic voice CLI loads and rejects absent credentials"
else
  fail "②i voice CLI import/config boundary failed: rc=$voice_cli_rc output=$voice_cli_out"
fi

# ── ③ bundled agent registry ─────────────────────────────────────────────────
[ -f "$PKG_ROOT/.flywheel/agents/registry.yaml" ] \
  && [ -f "$PKG_ROOT/.flywheel/agents/nodes/general.md" ] \
  && [ -f "$PKG_ROOT/.flywheel/agents/nodes/general.bare.md" ] \
  && [ -f "$PKG_ROOT/.flywheel/agents/nodes/general.matt.md" ] \
  && [ -f "$PKG_ROOT/.flywheel/agents/nodes/qa.md" ] \
  && pass "③ bundled registry + node implementations at PKG_ROOT" \
  || fail "③ bundled registry assets missing from PKG_ROOT"

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
  DISCORD_OWNER_USER_ID="98765432109876543" \
  LINEAR_API_KEY="stub" \
  FLYWHEEL_PROJECTS="[{\"projectName\":\"smoke\",\"projectRoot\":\"$SMOKE_HOME/proj\",\"leads\":[{\"agentId\":\"smoke-lead\",\"summaryRole\":\"exempt\",\"chatChannel\":\"111\",\"match\":{\"labels\":[\"x\"]},\"botTokenEnv\":\"SMOKE_BOT_TOKEN\",\"botUserId\":\"12345678901234567\",\"canSpawnRunners\":false}]}]" \
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
mkdir -p "$LEAD_HOME/.flywheel"
printf -- '---\nname: smoke-lead\n---\nSmoke\n' > "$LEAD_HOME/proj/.lead/smoke-lead/identity.md"
printf '%s\n' '{"granularity":"per-lead","setBy":"packaged-smoke","setAt":"2026-08-28T00:00:00.000Z"}' > "$LEAD_HOME/.flywheel/summary-config.json"
LEAD_PROJECTS="[{\"projectName\":\"smoke\",\"projectRoot\":\"$LEAD_HOME/proj\",\"leads\":[{\"agentId\":\"smoke-lead\",\"summaryRole\":\"exempt\",\"chatChannel\":\"111\",\"match\":{\"labels\":[\"x\"]},\"botTokenEnv\":\"SMOKE_BOT_TOKEN\",\"botUserId\":\"12345678901234567\",\"canSpawnRunners\":true}]}]"
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

# ── ④e generalized Lead entrypoint through the installed tree ───────────────
GEN_HOME="$SANDBOX/generalized-home"
GEN_STATE="$GEN_HOME/.flywheel"
GEN_CLAUDE_ROOT="$GEN_HOME/claude-project"
GEN_CODEX_ROOT="$GEN_HOME/codex-project"
GEN_RAYA_ROOT="$GEN_HOME/raya-lead-workspace"
GEN_CLI="$PKG_ROOT/packages/flywheel-comm/dist/index.js"
GEN_VALIDATOR="$PKG_ROOT/packages/teamlead/dist/bin/validate-projects.js"
GEN_LAUNCHER="$GEN_STATE/bin/flywheel-lead.sh"
mkdir -p "$GEN_STATE/state/summary-registry" "$GEN_STATE/bin/lib" \
  "$GEN_CLAUDE_ROOT/.lead/smoke-claude" "$GEN_CODEX_ROOT/.lead/smoke-codex" \
  "$GEN_RAYA_ROOT/.lead/raya"
printf '%s\n' '# Smoke Claude Lead' > "$GEN_CLAUDE_ROOT/.lead/smoke-claude/identity.md"
printf '%s\n' '# Smoke Codex Lead' > "$GEN_CODEX_ROOT/.lead/smoke-codex/identity.md"
printf '%s\n' '# Raya Codex Lead' > "$GEN_RAYA_ROOT/.lead/raya/identity.md"
cat > "$GEN_STATE/host.json" <<JSON
{"flywheelDir":"$PKG_ROOT","stateDir":"$GEN_STATE"}
JSON
cat > "$GEN_STATE/projects.json" <<JSON
[
  {
    "projectName":"smoke-claude-project",
    "projectRoot":"$GEN_CLAUDE_ROOT",
    "leads":[{
      "agentId":"smoke-claude","summaryRole":"exempt",
      "chatChannel":"30000000000000001","match":{"labels":["smoke-claude"]},
      "botTokenEnv":"SMOKE_CLAUDE_TOKEN","botUserId":"40000000000000001",
      "canSpawnRunners":false,"backend":"claude-code","carrier":"v2"
    }]
  },
  {
    "projectName":"smoke-codex-project",
    "projectRoot":"$GEN_CODEX_ROOT",
    "leads":[{
      "agentId":"smoke-codex","summaryRole":"exempt",
      "chatChannel":"30000000000000002","match":{"labels":["smoke-codex"]},
      "botTokenEnv":"SMOKE_CODEX_TOKEN","botUserId":"40000000000000002",
      "canSpawnRunners":false,"backend":"codex-app-server",
      "codexProfile":"full-access"
    }]
  }
]
JSON
printf '%s\n' '{"granularity":"per-lead","setBy":"packaged-smoke","setAt":"2026-09-08T00:00:00.000Z"}' \
  > "$GEN_STATE/summary-config.json"
cat > "$SANDBOX/generalized-assignments.json" <<'JSON'
{
  "assignments":[
    {"projectName":"smoke-claude-project","leadId":"smoke-claude","summaryRole":"exempt"},
    {"projectName":"smoke-codex-project","leadId":"smoke-codex","summaryRole":"exempt"}
  ],
  "projectAggregators":[]
}
JSON
GEN_PROJECTS_SHA="$(shasum -a 256 "$GEN_STATE/projects.json" | awk '{print $1}')"
GEN_SETUP_RC=0
HOME="$GEN_HOME" FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD=1 \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$GEN_VALIDATOR" \
  node "$GEN_CLI" summary-registry migrate \
    --projects-file "$GEN_STATE/projects.json" \
    --assignments-file "$SANDBOX/generalized-assignments.json" \
    --receipt-file "$GEN_STATE/state/summary-registry/migration-receipt.json" \
    --expected-sha256 "$GEN_PROJECTS_SHA" \
    > "$SANDBOX/generalized-migrate.out" 2> "$SANDBOX/generalized-migrate.err" \
  || GEN_SETUP_RC=$?

cp "$PKG_ROOT/scripts/flywheel-lead.sh" "$GEN_STATE/bin/flywheel-lead.sh"
cp "$PKG_ROOT/scripts/flywheel-lead-wrapper-v2.sh" "$GEN_STATE/bin/flywheel-lead-wrapper-v2.sh"
cp "$PKG_ROOT/scripts/lib/host-config.sh" "$GEN_STATE/bin/lib/host-config.sh"
cp "$PKG_ROOT/scripts/lib/lead-address.sh" "$GEN_STATE/bin/lib/lead-address.sh"
cp "$PKG_ROOT/scripts/lib/lead-host-tmux-gate.sh" "$GEN_STATE/bin/lib/lead-host-tmux-gate.sh"
cat > "$GEN_STATE/bin/host-tmux-selection-gate.sh" <<'SH'
#!/bin/bash
exit 0
SH
cat > "$GEN_STATE/bin/codex-home-link-truth.sh" <<'SH'
#!/bin/bash
exit 0
SH
cat > "$GEN_STATE/bin/tmux" <<'SH'
#!/bin/bash
exit 0
SH
cat > "$GEN_STATE/bin/claude" <<'SH'
#!/bin/bash
exit 0
SH
cat > "$GEN_STATE/bin/check-discord-plugin.sh" <<'SH'
#!/bin/bash
[ "${1:-}" = "--print-contract" ] && { echo 'discord@flywheel-plugins/v1'; exit 0; }
exit 0
SH
cat > "$GEN_STATE/bin/update-discord-plugin.sh" <<'SH'
#!/bin/bash
exit 0
SH
chmod +x "$GEN_STATE/bin/"*.sh "$GEN_STATE/bin/lib/"*.sh \
  "$GEN_STATE/bin/tmux" "$GEN_STATE/bin/claude"
cat > "$GEN_STATE/.env" <<'ENV'
SMOKE_CLAUDE_TOKEN=claude-smoke-token
SMOKE_CODEX_TOKEN=codex-smoke-token
RAYA_BOT_TOKEN=raya-smoke-token
TEAMLEAD_API_TOKEN=bridge-smoke-token
ENV
GEN_CODEX_HOME="$GEN_HOME/.codex-smoke-codex"
mkdir -p "$GEN_CODEX_HOME/packages/standalone/current"
cat > "$GEN_CODEX_HOME/packages/standalone/current/codex" <<'SH'
#!/bin/bash
exit 0
SH
chmod +x "$GEN_CODEX_HOME/packages/standalone/current/codex"
printf '%s\n' '{}' > "$GEN_CODEX_HOME/auth.json"
bash "$PKG_ROOT/scripts/materialize-lead-manifests.sh" \
  --home "$GEN_HOME" --projects "$GEN_STATE/projects.json" \
  --manifests-dir "$GEN_STATE/manifests" > "$SANDBOX/generalized-materialize.out"

run_generalized() {
  env -i HOME="$GEN_HOME" PATH="$GEN_STATE/bin:$PATH" \
    FLYWHEEL_DIR="$PKG_ROOT" FLYWHEEL_STATE_DIR="$GEN_STATE" \
    FLYWHEEL_LEAD_DRY_RUN="${FLYWHEEL_LEAD_DRY_RUN:-}" \
    "$@"
}
GEN_DRY_RC=0
run_generalized "$GEN_LAUNCHER" register \
  --project-name smoke-dry-run --project-root "$GEN_CLAUDE_ROOT" \
  --lead-id smoke-dry-run --chat-channel 30000000000000003 \
  --bot-token-env SMOKE_DRY_TOKEN --bot-user-id 40000000000000003 \
  --harness claude --dry-run \
  > "$SANDBOX/generalized-register.out" 2> "$SANDBOX/generalized-register.err" \
  || GEN_DRY_RC=$?
GEN_CLAUDE_RC=0
run_generalized "$GEN_LAUNCHER" preflight \
  "$GEN_STATE/manifests/smoke-claude-project-smoke-claude.json" \
  > "$SANDBOX/generalized-claude.out" 2> "$SANDBOX/generalized-claude.err" \
  || GEN_CLAUDE_RC=$?
GEN_CODEX_RC=0
run_generalized "$GEN_LAUNCHER" preflight \
  "$GEN_STATE/manifests/smoke-codex-project-smoke-codex.json" \
  > "$SANDBOX/generalized-codex.out" 2> "$SANDBOX/generalized-codex.err" \
  || GEN_CODEX_RC=$?
GEN_RUN_RC=0
FLYWHEEL_LEAD_DRY_RUN=1 run_generalized "$GEN_LAUNCHER" run \
  "$GEN_STATE/manifests/smoke-codex-project-smoke-codex.json" \
  > "$SANDBOX/generalized-run.out" 2> "$SANDBOX/generalized-run.err" \
  || GEN_RUN_RC=$?
if [ "$GEN_SETUP_RC" -eq 0 ] && [ "$GEN_DRY_RC" -eq 0 ] \
  && [ "$GEN_CLAUDE_RC" -eq 0 ] && [ "$GEN_CODEX_RC" -eq 0 ] \
  && [ "$GEN_RUN_RC" -eq 0 ] \
  && jq -e '.dryRun == true' "$SANDBOX/generalized-register.out" >/dev/null \
  && grep -q 'PASS preflight complete for smoke-claude-project/smoke-claude' \
    "$SANDBOX/generalized-claude.out" \
  && grep -q 'PASS preflight complete for smoke-codex-project/smoke-codex' \
    "$SANDBOX/generalized-codex.out" \
  && grep -q 'CODEX LEAD DRY RUN' "$SANDBOX/generalized-run.out"; then
  pass "④e packaged generalized launcher dry-runs registration and both harnesses"
else
  fail "④e generalized launcher failed: setup=$GEN_SETUP_RC register=$GEN_DRY_RC claude=$GEN_CLAUDE_RC codex=$GEN_CODEX_RC run=$GEN_RUN_RC $(tail -6 "$SANDBOX/generalized-register.err" "$SANDBOX/generalized-claude.err" "$SANDBOX/generalized-codex.err" "$SANDBOX/generalized-run.err" 2>/dev/null | tr '\n' ' ')"
fi

# ── ④f Raya registers and preflights through the installed tree ─────────────
GEN_RAYA_HOME="$GEN_HOME/.codex-raya"
mkdir -p "$GEN_RAYA_HOME/packages/standalone/current"
cp "$GEN_CODEX_HOME/packages/standalone/current/codex" \
  "$GEN_RAYA_HOME/packages/standalone/current/codex"
printf '%s\n' '{}' > "$GEN_RAYA_HOME/auth.json"
GEN_RAYA_REGISTER_RC=0
run_generalized "$GEN_LAUNCHER" register \
  --project-name raya --project-root "$GEN_RAYA_ROOT" \
  --project-repo xrliAnnie/raya --general-channel 30000000000000004 \
  --lead-id raya --chat-channel 30000000000000004 \
  --bot-token-env RAYA_BOT_TOKEN --bot-user-id 40000000000000004 \
  --harness codex --model gpt-6-astra --effort xhigh \
  --model-context-window 1050000 --summary-role recipient \
  --can-spawn-runners false --roundtable-channel 30000000000000014 \
  --alert-channel 30000000000000004 --alert-bot-token-env RAYA_BOT_TOKEN \
  --alert-fallback-to-core false \
  > "$SANDBOX/generalized-raya-register.out" \
  2> "$SANDBOX/generalized-raya-register.err" || GEN_RAYA_REGISTER_RC=$?
GEN_RAYA_PREFLIGHT_RC=0
run_generalized "$GEN_LAUNCHER" preflight \
  "$GEN_STATE/manifests/raya-raya.json" \
  > "$SANDBOX/generalized-raya-preflight.out" \
  2> "$SANDBOX/generalized-raya-preflight.err" || GEN_RAYA_PREFLIGHT_RC=$?
if [ "$GEN_RAYA_REGISTER_RC" -eq 0 ] && [ "$GEN_RAYA_PREFLIGHT_RC" -eq 0 ] \
  && grep -q 'PASS preflight complete for raya/raya' \
    "$SANDBOX/generalized-raya-preflight.out" \
  && jq -e --arg root "$GEN_RAYA_ROOT" '
    .projectName == "raya" and .leadId == "raya" and
    .projectDir == $root and .leadBackend.backendId == "codex-app-server"
  ' "$GEN_STATE/manifests/raya-raya.json" >/dev/null \
  && jq -e '
    .[] | select(.projectName == "raya" and .projectRepo == "xrliAnnie/raya") |
    .leads[] | select(
      .agentId == "raya" and .summaryRole == "recipient" and
      .backend == "codex-app-server" and .codexProfile == "full-access" and
      .model == "gpt-6-astra" and
      .effort == "xhigh" and .modelContextWindow == 1050000 and
      .canSpawnRunners == false and .alertFallbackToCore == false
    )
  ' "$GEN_STATE/projects.json" >/dev/null; then
  pass "④f packaged Raya performs a real standard registration then Codex preflight"
else
  fail "④f packaged Raya register/preflight failed: register=$GEN_RAYA_REGISTER_RC preflight=$GEN_RAYA_PREFLIGHT_RC $(tail -8 "$SANDBOX/generalized-raya-register.err" "$SANDBOX/generalized-raya-preflight.err" 2>/dev/null | tr '\n' ' ')"
fi

# ── ④g internal summary transport stays dormant for packaged customers ─────
# The release allowlist deliberately registers Raya's repository names because
# flywheel-comm is shipped as one compiled package. Customer setup assigns this
# fixture an explicit exempt role: even with otherwise plausible selectors, the
# command must fail before consulting `gh`.
SUMMARY_BIN="$SANDBOX/summary-bin"; mkdir -p "$SUMMARY_BIN"
printf '#!/bin/bash\nprintf "called\\n" >> "$SUMMARY_GH_LOG"\nexit 97\n' > "$SUMMARY_BIN/gh"
chmod +x "$SUMMARY_BIN/gh"
printf '# packaged smoke\n' > "$SANDBOX/summary.md"
summary_out="$(env -i HOME="$LEAD_HOME" PATH="$SUMMARY_BIN:$PATH" \
  SUMMARY_GH_LOG="$SANDBOX/summary-gh.log" \
  FLYWHEEL_PROJECT_NAME=smoke FLYWHEEL_LEAD_ID=smoke-lead \
  FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=0 \
  node "$PKG_ROOT/node_modules/flywheel-comm/dist/index.js" summary \
    --file "$SANDBOX/summary.md" --project smoke --period 2026-W35 2>&1)"
summary_merge_out="$(env -i HOME="$LEAD_HOME" PATH="$SUMMARY_BIN:$PATH" \
  SUMMARY_GH_LOG="$SANDBOX/summary-gh.log" \
  FLYWHEEL_PROJECT_NAME=smoke FLYWHEEL_LEAD_ID=smoke-lead \
  FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=0 FLYWHEEL_LEAD_SUMMARY_ROLE=exempt \
  FLYWHEEL_SUMMARY_GRANULARITY=per-lead \
  node "$PKG_ROOT/node_modules/flywheel-comm/dist/index.js" summary merge \
    --repo xrliAnnie/raya --pr 1 --dry-run 2>&1)"
if grep -q "summary_duty_required" <<<"$summary_out" \
   && grep -q "summary_merge_authority_required" <<<"$summary_merge_out" \
   && [ ! -e "$SANDBOX/summary-gh.log" ]; then
  pass "④g packaged exempt Lead cannot reach internal Raya summary delivery or merge transport"
else
  fail "④g packaged summary boundary failed: delivery=$summary_out merge=$summary_merge_out"
fi

echo ""
echo "package-onboard-smoke: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]

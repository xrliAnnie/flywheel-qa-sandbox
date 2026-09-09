#!/bin/bash
# FLY-2444: generalized Flywheel Lead entrypoint contracts.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAUNCHER="${REPO_ROOT}/scripts/flywheel-lead.sh"
CLI="${REPO_ROOT}/packages/flywheel-comm/dist/index.js"
VALIDATOR="${REPO_ROOT}/packages/teamlead/dist/bin/validate-projects.js"
TMP="$(mktemp -d -t fly2444-lead-XXXXXX)" || exit 1
trap 'rm -rf "$TMP" "${CODEX_SHORT_STATE:-}"' EXIT

if [ -x "$LAUNCHER" ] \
  && help="$($LAUNCHER --help 2>&1)" \
  && printf '%s' "$help" | grep -q 'register' \
  && printf '%s' "$help" | grep -q 'run' \
  && printf '%s' "$help" | grep -q 'preflight' \
  && printf '%s' "$help" | grep -q 'import-cos-context' \
  && printf '%s' "$help" | grep -q 'recover'; then
  pass "publishes the bounded generalized Lead command surface"
else
  fail "flywheel-lead.sh must expose register/import-cos-context/run/preflight/recover"
fi

H="$TMP/home"
STATE="$H/.flywheel"
PROJECT_ROOT="$H/Dev/outside-repo"
mkdir -p "$STATE/state/summary-registry" "$STATE/bin" "$PROJECT_ROOT/.lead/demo-lead"
printf '%s\n' '# Demo Lead' >"$PROJECT_ROOT/.lead/demo-lead/identity.md"
cat >"$STATE/projects.json" <<JSON
[
  {
    "projectName": "existing",
    "projectRoot": "$H/Dev/existing",
    "leads": [
      {
        "agentId": "existing-lead",
        "summaryRole": "producer",
        "chatChannel": "10000000000000000",
        "match": {"labels": ["existing-lead"]},
        "botTokenEnv": "EXISTING_BOT_TOKEN",
        "botUserId": "20000000000000000",
        "canSpawnRunners": false,
        "backend": "claude-code",
        "carrier": "v2"
      }
    ]
  }
]
JSON
cat >"$STATE/summary-config.json" <<'JSON'
{"granularity":"per-lead","setBy":"founder","setAt":"2026-09-08T00:00:00.000Z"}
JSON
cat >"$TMP/assignments.json" <<'JSON'
{"assignments":[{"projectName":"existing","leadId":"existing-lead","summaryRole":"producer"}],"projectAggregators":[]}
JSON
sha="$(shasum -a 256 "$STATE/projects.json" | awk '{print $1}')"
if ! HOME="$H" FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD=1 \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  node "$CLI" summary-registry migrate \
    --projects-file "$STATE/projects.json" \
    --assignments-file "$TMP/assignments.json" \
    --receipt-file "$STATE/state/summary-registry/migration-receipt.json" \
    --expected-sha256 "$sha" >"$TMP/migrate.out" 2>"$TMP/migrate.err"; then
  echo "fixture migration failed: $(cat "$TMP/migrate.err")" >&2
  exit 1
fi

cat >"$STATE/bin/host-tmux-selection-gate.sh" <<'SH'
#!/bin/bash
[ -z "${FLYWHEEL_HOST_TMUX_GATE_TEST_MODE:-}" ] || exit 91
[ -z "${HOST_GATE_CALLS:-}" ] || printf '%s %s\n' "$1" "$2" >>"$HOST_GATE_CALLS"
exit 0
SH
cat >"$STATE/bin/tmux" <<'SH'
#!/bin/bash
exit 0
SH
chmod +x "$STATE/bin/host-tmux-selection-gate.sh" "$STATE/bin/tmux"

projects_before_dry_run="$(shasum -a 256 "$STATE/projects.json" | awk '{print $1}')"
receipt_before_dry_run="$(shasum -a 256 "$STATE/state/summary-registry/migration-receipt.json" | awk '{print $1}')"
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  "$LAUNCHER" register \
    --project-name dry-run --project-root "$PROJECT_ROOT" \
    --lead-id dry-run-lead --chat-channel 10000000000000009 \
    --bot-token-env DRY_RUN_BOT_TOKEN --bot-user-id 20000000000000009 \
    --harness claude --dry-run >"$TMP/dry-run.out" 2>"$TMP/dry-run.err" \
  && jq -e '.dryRun == true and .leadKey == "dry-run-dry-run-lead"' \
    "$TMP/dry-run.out" >/dev/null \
  && [ "$projects_before_dry_run" = "$(shasum -a 256 "$STATE/projects.json" | awk '{print $1}')" ] \
  && [ "$receipt_before_dry_run" = "$(shasum -a 256 "$STATE/state/summary-registry/migration-receipt.json" | awk '{print $1}')" ] \
  && [ ! -e "$STATE/manifests/dry-run-dry-run-lead.json" ]; then
  pass "register dry-run validates the candidate and exits with zero writes"
else
  fail "register dry-run did not remain side-effect free: $(cat "$TMP/dry-run.err")"
fi

override_guard_ok=1
for forbidden_flag in --projects-file --receipt-file --summary-config-home; do
  case "$forbidden_flag" in
    --projects-file) forbidden_value="$STATE/projects.json" ;;
    --receipt-file) forbidden_value="$STATE/state/summary-registry/migration-receipt.json" ;;
    --summary-config-home) forbidden_value="$H" ;;
  esac
  override_rc=0
  HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
    FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
    FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
    "$LAUNCHER" register \
      --project-name override-guard --project-root "$PROJECT_ROOT" \
      --lead-id override-guard-lead --chat-channel 10000000000000008 \
      --bot-token-env OVERRIDE_GUARD_TOKEN --bot-user-id 20000000000000008 \
      --harness claude --dry-run "$forbidden_flag" "$forbidden_value" \
      >"$TMP/override-guard.out" 2>"$TMP/override-guard.err" || override_rc=$?
  if [ "$override_rc" -ne 64 ] \
    || ! grep -Fq -- "$forbidden_flag is not supported by flywheel-lead register" \
      "$TMP/override-guard.err"; then
    override_guard_ok=0
  fi
done
if [ "$override_guard_ok" -eq 1 ]; then
  pass "rejects test-only registry path overrides at the production register entrypoint"
else
  fail "register accepted or misreported a test-only path override"
fi

register_out="$TMP/register.out"
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  "$LAUNCHER" register \
    --project-name demo --project-root "$PROJECT_ROOT" \
    --lead-id demo-lead --chat-channel 10000000000000001 \
    --bot-token-env DEMO_BOT_TOKEN --bot-user-id 20000000000000001 \
    --harness claude >"$register_out" 2>"$TMP/register.err" \
  && grep -q '"effectiveAt":"next-bridge-restart"' "$register_out" \
  && jq -e '.[] | select(.projectName == "demo") | .leads[] | select(.agentId == "demo-lead" and .backend == "claude-code")' "$STATE/projects.json" >/dev/null \
  && HOME="$H" node "$CLI" summary-registry verify-activation \
    --projects-file "$STATE/projects.json" \
    --receipt-file "$STATE/state/summary-registry/migration-receipt.json" >/dev/null \
  && jq -e --arg root "$PROJECT_ROOT" --arg projects "$STATE/projects.json" '
      .projectName == "demo" and .leadId == "demo-lead" and
      .projectDir == $root and .projectsFile == $projects and
      .leadBackend.backendId == "claude-code"
    ' "$STATE/manifests/demo-demo-lead.json" >/dev/null; then
  pass "register transactionally adds one Claude Lead and materializes its bound manifest"
else
  fail "register did not converge registry, receipt, and manifest: $(cat "$TMP/register.err")"
fi

register_args=(
  --project-name demo --project-root "$PROJECT_ROOT"
  --lead-id retry-lead --chat-channel 10000000000000002
  --bot-token-env RETRY_BOT_TOKEN --bot-user-id 20000000000000002
  --harness claude
)
mkdir -p "$PROJECT_ROOT/.lead/retry-lead"
printf '%s\n' '# Retry Lead' >"$PROJECT_ROOT/.lead/retry-lead/identity.md"
cat >"$TMP/fail-materializer.sh" <<'SH'
#!/bin/bash
exit 42
SH
chmod +x "$TMP/fail-materializer.sh"
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  FLYWHEEL_LEAD_MATERIALIZER="$TMP/fail-materializer.sh" \
  "$LAUNCHER" register "${register_args[@]}" >"$TMP/retry-first.out" 2>"$TMP/retry-first.err"; then
  fail "a failed materializer must make register fail"
else
  retry_first_rc=$?
  projects_after_first="$(shasum -a 256 "$STATE/projects.json" | awk '{print $1}')"
  receipt_after_first="$(shasum -a 256 "$STATE/state/summary-registry/migration-receipt.json" | awk '{print $1}')"
  if [ "$retry_first_rc" -eq 78 ] \
    && jq -e '.[] | select(.projectName == "demo") | [.leads[] | select(.agentId == "retry-lead")] | length == 1' "$STATE/projects.json" >/dev/null \
    && HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
      FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
      FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
      "$LAUNCHER" register "${register_args[@]}" >"$TMP/retry-second.out" 2>"$TMP/retry-second.err" \
    && [ "$projects_after_first" = "$(shasum -a 256 "$STATE/projects.json" | awk '{print $1}')" ] \
    && [ "$receipt_after_first" = "$(shasum -a 256 "$STATE/state/summary-registry/migration-receipt.json" | awk '{print $1}')" ] \
    && [ -f "$STATE/manifests/demo-retry-lead.json" ]; then
    pass "retries a post-commit materializer failure as a zero-write continuation"
  else
    fail "materializer continuation did not preserve registry and receipt bytes"
  fi
fi

RUN_CAPTURE="$TMP/claude-run.capture"
cat >"$STATE/bin/flywheel-lead-wrapper-v2.sh" <<'SH'
#!/bin/bash
printf '%s\n' "$1" >>"$RUN_CAPTURE"
SH
chmod +x "$STATE/bin/flywheel-lead-wrapper-v2.sh"
manifest="$STATE/manifests/demo-demo-lead.json"
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" RUN_CAPTURE="$RUN_CAPTURE" \
  "$LAUNCHER" run "$manifest" \
  && HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
    FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
    FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" RUN_CAPTURE="$RUN_CAPTURE" \
    "$LAUNCHER" "$manifest" \
  && [ "$(grep -cFx "$manifest" "$RUN_CAPTURE" || true)" -eq 2 ]; then
  pass "dispatches Claude through wrapper-v2 and treats one manifest positional as run"
else
  fail "Claude manifest dispatch did not exec wrapper-v2 twice"
fi

before_dispatches="$(wc -l <"$RUN_CAPTURE" | tr -d ' ')"
jq '.projectsFile = "/wrong/projects.json"' "$manifest" >"$TMP/mismatched-manifest.json"
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" RUN_CAPTURE="$RUN_CAPTURE" \
  "$LAUNCHER" run "$TMP/mismatched-manifest.json" >"$TMP/mismatch.out" 2>"$TMP/mismatch.err"; then
  fail "run must reject a manifest whose five-field binding drifted"
elif [ "$?" -eq 78 ] && grep -q 'manifest identity differs' "$TMP/mismatch.err" \
  && [ "$before_dispatches" = "$(wc -l <"$RUN_CAPTURE" | tr -d ' ')" ]; then
  pass "rejects a drifted manifest before backend dispatch"
else
  fail "manifest drift returned the wrong result: $(cat "$TMP/mismatch.err")"
fi

cat >"$STATE/state/summary-registry/migration-receipt.json.lead-registry-intent.json" <<'JSON'
{"schemaVersion":1,"phase":"pending"}
JSON
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" RUN_CAPTURE="$RUN_CAPTURE" \
  "$LAUNCHER" run "$manifest" >"$TMP/pending-run.out" 2>"$TMP/pending-run.err"; then
  fail "run must reject a pending registry recovery intent"
elif [ "$?" -eq 78 ] && grep -q 'recovery' "$TMP/pending-run.err" \
  && [ "$before_dispatches" = "$(wc -l <"$RUN_CAPTURE" | tr -d ' ')" ]; then
  pass "rejects run while a registry recovery intent is pending"
else
  fail "pending intent run guard returned the wrong result: $(cat "$TMP/pending-run.err")"
fi
rm -f "$STATE/state/summary-registry/migration-receipt.json.lead-registry-intent.json"

CODEX_PROJECT="$H/Dev/codex-outside"
mkdir -p "$CODEX_PROJECT/.lead/demo-codex"
printf '%s\n' '# Demo Codex Lead' >"$CODEX_PROJECT/.lead/demo-codex/identity.md"
if ! HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  "$LAUNCHER" register \
    --project-name codex-demo --project-root "$CODEX_PROJECT" \
    --lead-id demo-codex --chat-channel 10000000000000003 \
    --roundtable-channel 10000000000000013 \
    --alert-channel 10000000000000003 \
    --alert-bot-token-env DEMO_CODEX_BOT_TOKEN \
    --alert-fallback-to-core false \
    --bot-token-env DEMO_CODEX_BOT_TOKEN --bot-user-id 20000000000000003 \
    --harness codex >"$TMP/codex-register.out" 2>"$TMP/codex-register.err"; then
  echo "codex fixture registration failed: $(cat "$TMP/codex-register.err")" >&2
  exit 1
fi

TEAMLEAD_FIXTURE="$TMP/teamlead"
mkdir -p "$TEAMLEAD_FIXTURE/scripts/lib" \
  "$TEAMLEAD_FIXTURE/dist/lead-backends/codex/lead-actions" \
  "$TEAMLEAD_FIXTURE/dist/lead-backends/codex"
cp "$REPO_ROOT/packages/teamlead/scripts/codex-lead.sh" "$TEAMLEAD_FIXTURE/scripts/codex-lead.sh"
cp "$REPO_ROOT/packages/teamlead/scripts/lib/canonical-lead-identity.sh" "$TEAMLEAD_FIXTURE/scripts/lib/canonical-lead-identity.sh"
cat >"$TEAMLEAD_FIXTURE/scripts/lead-rules-bundle.sh" <<'SH'
assemble_full_access_governance() {
  export FLY350_FULL_ACCESS_ROLE=dept
  export FLY350_FULL_ACCESS_BUNDLE=test
}
SH
cat >"$TEAMLEAD_FIXTURE/scripts/codex-lead-tui-home.sh" <<'SH'
#!/bin/bash
exit 0
SH
chmod +x "$TEAMLEAD_FIXTURE/scripts/codex-lead-tui-home.sh"
cat >"$TEAMLEAD_FIXTURE/dist/lead-backends/codex/codex-lead-tui-runtime.js" <<'JS'
const fs = require("node:fs");
const names = [
  "FLYWHEEL_PROJECTS_FILE", "FLYWHEEL_LEAD_EXPECTED_PROJECTS_DIGEST",
  "FLYWHEEL_LEAD_PROJECTS_DIGEST", "FLYWHEEL_CODEX_LEAD_MODE",
  "FLYWHEEL_CODEX_LEAD_PROFILE", "FLYWHEEL_CODEX_LEAD_SANDBOX",
  "FLYWHEEL_LEAD_CHAT_CHANNEL_ID", "FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS",
  "FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD", "FLYWHEEL_ROUNDTABLE_CHANNEL_ID",
  "FLYWHEEL_ROUNDTABLE_ENABLED", "FLYWHEEL_ROUNDTABLE_GUILD_ID",
  "FLYWHEEL_LEAD_CORE_CHANNEL_ID", "FLYWHEEL_LEAD_MENTION_PATTERNS",
  "FLYWHEEL_CODEX_LEAD_PROJECT_DIR", "FLYWHEEL_CODEX_TUI_CWD",
  "FLYWHEEL_CODEX_LEAD_HOME_KEY", "CODEX_HOME", "FLYWHEEL_CODEX_BIN",
  "FLYWHEEL_COMM_DB", "FLYWHEEL_COMM_CLI", "FLYWHEEL_LEAD_ACTIONS_MAIN_JS",
  "FLYWHEEL_LEAD_ACTIONS_NODE_BIN", "FLYWHEEL_LEAD_ACTIONS_STATE_DIR",
  "FLYWHEEL_CODEX_LEAD_STATE_DIR", "FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES",
  "FLYWHEEL_CODEX_LEAD_OUTBOUND", "FLYWHEEL_BRIDGE_URL", "FLYWHEEL_API_TOKEN",
  "FLYWHEEL_ROOT", "FLYWHEEL_TEAMLEAD_ROOT"
];
const out = Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]));
fs.writeFileSync(process.env.CODEX_CAPTURE, JSON.stringify(out));
JS
touch "$TEAMLEAD_FIXTURE/dist/lead-backends/codex/lead-actions/lead-actions-main.js"

CLI_CALLS="$TMP/cli.calls"
cat >"$TMP/cli-wrapper.mjs" <<'JS'
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
appendFileSync(process.env.CLI_CALLS, `${process.argv.slice(2).join(" ")}\n`);
const child = spawnSync(process.execPath, [process.env.REAL_CLI, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
});
process.exit(child.status ?? 1);
JS
cat >"$STATE/.env" <<'ENV'
DEMO_BOT_TOKEN=demo-token
RETRY_BOT_TOKEN=retry-token
DEMO_CODEX_BOT_TOKEN=codex-token
TEAMLEAD_API_TOKEN=api-token
FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=forbidden-channel
FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD=1
FLYWHEEL_ROUNDTABLE_CHANNEL_ID=forbidden-roundtable-channel
FLYWHEEL_ROUNDTABLE_ENABLED=1
FLYWHEEL_ROUNDTABLE_GUILD_ID=forbidden-guild
FLYWHEEL_LEAD_CORE_CHANNEL_ID=forbidden-core-channel
FLYWHEEL_LEAD_MENTION_PATTERNS=forbidden-mention
FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1
ENV

CODEX_CAPTURE="$TMP/codex-run.json"
HOST_GATE_CALLS="$TMP/host-gate.calls"
codex_manifest="$STATE/manifests/codex-demo-demo-codex.json"
CODEX_PROJECT_CANON="$(cd "$CODEX_PROJECT" && pwd -P)"
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$TMP/cli-wrapper.mjs" \
  FLYWHEEL_TEAMLEAD_ROOT="$TEAMLEAD_FIXTURE" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  FLYWHEEL_LEAD_DRY_RUN=1 REAL_CLI="$CLI" CLI_CALLS="$CLI_CALLS" \
  FLYWHEEL_BRIDGE_URL= FLYWHEEL_API_TOKEN= BRIDGE_URL= \
  CODEX_CAPTURE="$CODEX_CAPTURE" HOST_GATE_CALLS="$HOST_GATE_CALLS" \
  "$LAUNCHER" run "$codex_manifest" \
  >"$TMP/codex-run.out" 2>"$TMP/codex-run.err" \
  && [ "$(grep -c '^lead-registry selector ' "$CLI_CALLS" || true)" -eq 1 ] \
  && [ "$(grep -c '^lead-identity resolve ' "$CLI_CALLS" || true)" -eq 1 ] \
  && [ "$(grep -cFx 'gate codex-generic' "$HOST_GATE_CALLS" || true)" -eq 1 ] \
  && [ "$(grep -cFx 'verify codex-generic' "$HOST_GATE_CALLS" || true)" -eq 1 ] \
  && jq -e --arg projects "$STATE/projects.json" --arg project "$CODEX_PROJECT_CANON" \
    --arg home "$H/.codex-demo-codex" --arg db "$STATE/comm/codex-demo/comm.db" \
    --arg teamlead "$TEAMLEAD_FIXTURE" --arg repo "$REPO_ROOT" '
      .FLYWHEEL_PROJECTS_FILE == $projects and
      .FLYWHEEL_LEAD_EXPECTED_PROJECTS_DIGEST == .FLYWHEEL_LEAD_PROJECTS_DIGEST and
      .FLYWHEEL_CODEX_LEAD_MODE == "tui" and
      .FLYWHEEL_CODEX_LEAD_PROFILE == "full-access" and
      .FLYWHEEL_CODEX_LEAD_SANDBOX == "workspace-write" and
      .FLYWHEEL_LEAD_CHAT_CHANNEL_ID == "10000000000000003" and
      .FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS == "10000000000000013" and
      .FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD == null and
      .FLYWHEEL_ROUNDTABLE_CHANNEL_ID == null and
      .FLYWHEEL_ROUNDTABLE_ENABLED == null and
      .FLYWHEEL_ROUNDTABLE_GUILD_ID == null and
      .FLYWHEEL_LEAD_CORE_CHANNEL_ID == null and
      .FLYWHEEL_LEAD_MENTION_PATTERNS == null and
      .FLYWHEEL_CODEX_LEAD_PROJECT_DIR == $project and .FLYWHEEL_CODEX_TUI_CWD == $project and
      .FLYWHEEL_CODEX_LEAD_HOME_KEY == "demo-codex" and .CODEX_HOME == $home and
      .FLYWHEEL_CODEX_BIN == ($home + "/packages/standalone/current/codex") and
      .FLYWHEEL_COMM_DB == $db and
      .FLYWHEEL_LEAD_ACTIONS_MAIN_JS == ($teamlead + "/dist/lead-backends/codex/lead-actions/lead-actions-main.js") and
      (.FLYWHEEL_LEAD_ACTIONS_NODE_BIN | length) > 0 and
      .FLYWHEEL_LEAD_ACTIONS_STATE_DIR == .FLYWHEEL_CODEX_LEAD_STATE_DIR and
      .FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES == ($project + "/.lead/demo-codex/identity.md") and
      .FLYWHEEL_CODEX_LEAD_OUTBOUND == "bridge" and
      .FLYWHEEL_BRIDGE_URL == "http://localhost:9876" and
      .FLYWHEEL_API_TOKEN == "api-token" and
      .FLYWHEEL_ROOT == $repo and .FLYWHEEL_TEAMLEAD_ROOT == $teamlead
    ' "$CODEX_CAPTURE" >/dev/null; then
  pass "composes the Codex full-access env and resolves canonical identity exactly once"
else
  fail "Codex run composition failed: $(cat "$TMP/codex-run.err"); capture=$(cat "$CODEX_CAPTURE" 2>/dev/null || true)"
fi

TOOLCHAIN_BIN="$H/.local/bin"
mkdir -p "$TOOLCHAIN_BIN"
ln -s "$(command -v node)" "$TOOLCHAIN_BIN/node"
ln -s "$(command -v jq)" "$TOOLCHAIN_BIN/jq"
cp "$STATE/bin/tmux" "$TOOLCHAIN_BIN/tmux"
chmod +x "$TOOLCHAIN_BIN/tmux"
LAUNCHD_CAPTURE="$TMP/codex-launchd-path.json"
if HOME="$H" PATH="/usr/bin:/bin:/usr/sbin:/sbin" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$TMP/cli-wrapper.mjs" \
  FLYWHEEL_TEAMLEAD_ROOT="$TEAMLEAD_FIXTURE" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  FLYWHEEL_LEAD_DRY_RUN=1 REAL_CLI="$CLI" CLI_CALLS="$CLI_CALLS" \
  CODEX_CAPTURE="$LAUNCHD_CAPTURE" HOST_GATE_CALLS="$HOST_GATE_CALLS" \
  "$LAUNCHER" run "$codex_manifest" \
  >"$TMP/codex-launchd-path.out" 2>"$TMP/codex-launchd-path.err" \
  && jq -e --arg node "$TOOLCHAIN_BIN/node" \
    '.FLYWHEEL_LEAD_ACTIONS_NODE_BIN == $node' "$LAUNCHD_CAPTURE" >/dev/null; then
  pass "Codex carrier owns a user/Homebrew toolchain PATH under launchd defaults"
else
  fail "Codex carrier did not repair launchd PATH: $(cat "$TMP/codex-launchd-path.err")"
fi

cp "$REPO_ROOT/scripts/flywheel-lead-wrapper-v2.sh" "$STATE/bin/flywheel-lead-wrapper-v2.sh"
cat >"$STATE/bin/check-discord-plugin.sh" <<'SH'
#!/bin/bash
if [ "${1:-}" = "--print-contract" ]; then
  printf '%s\n' 'discord@flywheel-plugins/v1'
else
  exit 0
fi
SH
cat >"$STATE/bin/update-discord-plugin.sh" <<'SH'
#!/bin/bash
exit 0
SH
cat >"$STATE/bin/claude" <<'SH'
#!/bin/bash
printf '%s\n' 'claude fixture'
SH
chmod +x "$STATE/bin/check-discord-plugin.sh" "$STATE/bin/update-discord-plugin.sh" \
  "$STATE/bin/claude" "$STATE/bin/flywheel-lead-wrapper-v2.sh"

state_snapshot() {
  (
    cd "$STATE" || exit 1
    find . -type d -print | LC_ALL=C sort
    find . -type f -print | LC_ALL=C sort | while IFS= read -r path; do
      shasum -a 256 "$path"
    done
  )
}

before_preflight="$(state_snapshot)"
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  "$LAUNCHER" preflight "$manifest" >"$TMP/claude-preflight.out" 2>"$TMP/claude-preflight.err" \
  && grep -q 'PASS manifest binding' "$TMP/claude-preflight.out" \
  && grep -q 'PASS Claude Discord plugin' "$TMP/claude-preflight.out" \
  && [ "$before_preflight" = "$(state_snapshot)" ]; then
  pass "preflights Claude through the real checker contract without filesystem writes"
else
  fail "Claude preflight failed or mutated state: $(cat "$TMP/claude-preflight.err")"
fi

cp "$STATE/state/summary-registry/migration-receipt.json" "$TMP/migration-receipt.good"
jq '.summaryAssignmentDigest = ("0" * 64)' \
  "$STATE/state/summary-registry/migration-receipt.json" >"$TMP/migration-receipt.stale"
mv "$TMP/migration-receipt.stale" "$STATE/state/summary-registry/migration-receipt.json"
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  "$LAUNCHER" preflight "$manifest" >"$TMP/stale-receipt.out" 2>"$TMP/stale-receipt.err"; then
  fail "preflight must reject a stale summary activation receipt"
elif [ "$?" -eq 78 ] && grep -q 'summary registry activation' "$TMP/stale-receipt.err"; then
  pass "rejects a stale summary activation receipt"
else
  fail "stale receipt preflight returned the wrong result: $(cat "$TMP/stale-receipt.err")"
fi
mv "$TMP/migration-receipt.good" "$STATE/state/summary-registry/migration-receipt.json"

cat >"$STATE/state/summary-registry/migration-receipt.json.lead-registry-intent.json" <<'JSON'
{"schemaVersion":1,"phase":"pending"}
JSON
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  "$LAUNCHER" preflight "$manifest" >"$TMP/pending-preflight.out" 2>"$TMP/pending-preflight.err"; then
  fail "preflight must reject a pending registry recovery intent"
elif [ "$?" -eq 78 ] && grep -q 'registry recovery is required' "$TMP/pending-preflight.err"; then
  pass "rejects preflight while a registry recovery intent is pending"
else
  fail "pending intent preflight guard returned the wrong result: $(cat "$TMP/pending-preflight.err")"
fi
rm -f "$STATE/state/summary-registry/migration-receipt.json.lead-registry-intent.json"

mv "$PROJECT_ROOT/.lead/demo-lead/identity.md" "$TMP/demo-identity.md"
mv "$STATE/bin/update-discord-plugin.sh" "$TMP/update-discord-plugin.sh"
mv "$STATE/.env" "$TMP/flywheel.env"
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  "$LAUNCHER" preflight "$manifest" >"$TMP/claude-missing.out" 2>"$TMP/claude-missing.err"; then
  fail "Claude preflight must reject missing independent prerequisites"
elif [ "$?" -eq 78 ] \
  && grep -q '.env' "$TMP/claude-missing.err" \
  && grep -q 'identity.md' "$TMP/claude-missing.err" \
  && grep -q 'update-discord-plugin.sh' "$TMP/claude-missing.err" \
  && grep -Fq 'bash scripts/install-discord-plugin-ops.sh' "$TMP/claude-missing.err"; then
  pass "lists all missing Claude prerequisites before exiting 78"
else
  fail "Claude preflight did not aggregate missing prerequisites: $(cat "$TMP/claude-missing.err")"
fi
mv "$TMP/demo-identity.md" "$PROJECT_ROOT/.lead/demo-lead/identity.md"
mv "$TMP/update-discord-plugin.sh" "$STATE/bin/update-discord-plugin.sh"
mv "$TMP/flywheel.env" "$STATE/.env"

CODEX_HOME_DIR="$H/.codex-demo-codex"
mkdir -p "$CODEX_HOME_DIR/packages/standalone/current"
printf '%s\n' '{}' >"$CODEX_HOME_DIR/auth.json"
cat >"$CODEX_HOME_DIR/packages/standalone/current/codex" <<'SH'
#!/bin/bash
exit 0
SH
cat >"$STATE/bin/codex-home-link-truth.sh" <<'SH'
#!/bin/bash
exit 0
SH
chmod +x "$CODEX_HOME_DIR/packages/standalone/current/codex" "$STATE/bin/codex-home-link-truth.sh"
before_preflight="$(state_snapshot)"
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_ROOT="$REPO_ROOT/packages/teamlead" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  "$LAUNCHER" preflight "$codex_manifest" >"$TMP/codex-preflight.out" 2>"$TMP/codex-preflight.err" \
  && grep -q 'PASS Codex project root' "$TMP/codex-preflight.out" \
  && grep -q 'PASS host tmux probe' "$TMP/codex-preflight.out" \
  && [ "$before_preflight" = "$(state_snapshot)" ]; then
  pass "preflights Codex full-access with the runtime project-root validator and zero writes"
else
  fail "Codex preflight failed or mutated state: $(cat "$TMP/codex-preflight.err")"
fi

RAYA_PROJECT="$H/Dev/raya-outside"
mkdir -p "$RAYA_PROJECT/.lead/raya"
printf '%s\n' '# Raya Codex Lead' >"$RAYA_PROJECT/.lead/raya/identity.md"
if ! HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  "$LAUNCHER" register \
    --project-name raya-smoke --project-root "$RAYA_PROJECT" \
    --lead-id raya --chat-channel 10000000000000004 \
    --bot-token-env RAYA_SMOKE_BOT_TOKEN --bot-user-id 20000000000000004 \
    --harness codex >"$TMP/raya-register.out" 2>"$TMP/raya-register.err"; then
  echo "Raya fixture registration failed: $(cat "$TMP/raya-register.err")" >&2
  exit 1
fi
RAYA_CODEX_HOME="$H/.codex-raya"
mkdir -p "$RAYA_CODEX_HOME/packages/standalone/current"
printf '%s\n' '{}' >"$RAYA_CODEX_HOME/auth.json"
cp "$CODEX_HOME_DIR/packages/standalone/current/codex" \
  "$RAYA_CODEX_HOME/packages/standalone/current/codex"
cp "$STATE/.env" "$TMP/flywheel.env.before-raya-parser"
printf '%s\n' 'RAYA_SMOKE_BOT_TOKEN=raya-token' 'RAYA_METRICS_DIR=relative-path' >>"$STATE/.env"
raya_manifest="$STATE/manifests/raya-smoke-raya.json"
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_ROOT="$REPO_ROOT/packages/teamlead" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  "$LAUNCHER" preflight "$raya_manifest" \
    >"$TMP/raya-parser.out" 2>"$TMP/raya-parser.err" \
  && grep -q 'PASS preflight complete for raya-smoke/raya' "$TMP/raya-parser.out"; then
  pass "ignores the retired Raya-only metrics override during standard Lead preflight"
else
  fail "standard Raya preflight still depends on the retired metrics override: $(cat "$TMP/raya-parser.err")"
fi
mv "$TMP/flywheel.env.before-raya-parser" "$STATE/.env"

mkdir -p "$H/non-default"
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$H/non-default" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  "$LAUNCHER" preflight "$manifest" >"$TMP/root.out" 2>"$TMP/root.err"; then
  fail "non-default state root must be rejected"
elif [ "$?" -eq 78 ] && grep -q 'requires FLYWHEEL_STATE_DIR' "$TMP/root.err"; then
  pass "rejects a non-default state root with exit 78"
else
  fail "non-default state root returned the wrong error: $(cat "$TMP/root.err")"
fi

retry_manifest="$STATE/manifests/demo-retry-lead.json"
cp "$retry_manifest" "$TMP/retry-manifest.good"
jq '.projectDir = "/wrong/root"' "$retry_manifest" >"$TMP/retry-manifest.bad"
mv "$TMP/retry-manifest.bad" "$retry_manifest"
before_projects="$(shasum -a 256 "$STATE/projects.json" | awk '{print $1}')"
before_receipt="$(shasum -a 256 "$STATE/state/summary-registry/migration-receipt.json" | awk '{print $1}')"
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  "$LAUNCHER" register "${register_args[@]}" >"$TMP/manifest-retry.out" 2>"$TMP/manifest-retry.err"; then
  fail "register continuation must reject an existing mismatched manifest"
elif [ "$?" -eq 78 ] && grep -q 'manifest identity differs' "$TMP/manifest-retry.err" \
  && [ "$before_projects" = "$(shasum -a 256 "$STATE/projects.json" | awk '{print $1}')" ] \
  && [ "$before_receipt" = "$(shasum -a 256 "$STATE/state/summary-registry/migration-receipt.json" | awk '{print $1}')" ]; then
  pass "rejects an existing mismatched manifest without rewriting registry state"
else
  fail "mismatched continuation manifest returned the wrong result"
fi
mv "$TMP/retry-manifest.good" "$retry_manifest"

if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  "$LAUNCHER" recover >"$TMP/recover.out" 2>"$TMP/recover.err" \
  && jq -e '.ok == true and .state == "none"' "$TMP/recover.out" >/dev/null; then
  pass "reports a no-op recovery through the locked registry command"
else
  fail "no-op recover failed: $(cat "$TMP/recover.err")"
fi

LOCK_READY="$TMP/lock.ready"
(
  # shellcheck source=../flywheel-config-lock.sh
  source "$REPO_ROOT/scripts/flywheel-config-lock.sh"
  config_write_locked "$STATE/projects.json.cfglock" 10 \
    /bin/bash -c 'touch "$1"; sleep 7' _ "$LOCK_READY"
) &
lock_holder=$!
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  [ -f "$LOCK_READY" ] && break
  sleep 0.1
done
if HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
  FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
  FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
  "$LAUNCHER" recover >"$TMP/locked.out" 2>"$TMP/locked.err"; then
  fail "registry lock contention must fail"
elif [ "$?" -eq 75 ]; then
  pass "bounds registry lock contention with exit 75"
else
  fail "registry lock contention returned the wrong exit: $(cat "$TMP/locked.err")"
fi
wait "$lock_holder"

cp "$LAUNCHER" "$STATE/bin/flywheel-lead.sh"
chmod +x "$STATE/bin/flywheel-lead.sh"
LAUNCHD_DIR="$H/Library/LaunchAgents"
LAUNCHCTL_CALLS="$TMP/launchctl.calls"
mkdir -p "$LAUNCHD_DIR"
: > "$LAUNCHCTL_CALLS"
cat > "$STATE/bin/launchctl" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$LAUNCHCTL_CALLS"
exit 0
SH
chmod +x "$STATE/bin/launchctl"

plist_argv() {
  python3 - "$1" <<'PY'
import json
import plistlib
import sys

with open(sys.argv[1], "rb") as handle:
    print(json.dumps(plistlib.load(handle).get("ProgramArguments"), separators=(",", ":")))
PY
}

run_lifecycle() {
  HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
    FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$CLI" \
    FLYWHEEL_TEAMLEAD_ROOT="$REPO_ROOT/packages/teamlead" \
    FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
    FLYWHEEL_SUPERVISOR_BACKEND=launchd FLYWHEEL_LAUNCHD_DIR="$LAUNCHD_DIR" \
    LAUNCHCTL_CALLS="$LAUNCHCTL_CALLS" \
    "$LAUNCHER" "$@"
}

CLAUDE_PLIST="$LAUNCHD_DIR/com.flywheel.lead.demo-demo-lead.plist"
if run_lifecycle install --project demo --lead demo-lead \
  >"$TMP/install-claude.out" 2>"$TMP/install-claude.err" \
  && [ -f "$CLAUDE_PLIST" ] \
  && [ "$(plist_argv "$CLAUDE_PLIST")" = \
    "[\"/bin/bash\",\"$STATE/bin/flywheel-lead-wrapper-v2.sh\",\"$manifest\"]" ] \
  && grep -Fq "bootstrap gui/$(id -u) $CLAUDE_PLIST" "$LAUNCHCTL_CALLS"; then
  pass "install preflights and renders the exact Claude launchd carrier"
else
  fail "Claude install shape failed: $(cat "$TMP/install-claude.err")"
fi

CODEX_PLIST="$LAUNCHD_DIR/com.flywheel.lead.codex-demo-demo-codex.plist"
if run_lifecycle install --project codex-demo --lead demo-codex \
  >"$TMP/install-codex.out" 2>"$TMP/install-codex.err" \
  && [ -f "$CODEX_PLIST" ] \
  && [ "$(plist_argv "$CODEX_PLIST")" = \
    "[\"/bin/bash\",\"$STATE/bin/flywheel-lead.sh\",\"$codex_manifest\"]" ] \
  && grep -Fq "bootstrap gui/$(id -u) $CODEX_PLIST" "$LAUNCHCTL_CALLS"; then
  pass "install preflights and renders the exact generalized Codex carrier"
else
  fail "Codex install shape failed: $(cat "$TMP/install-codex.err")"
fi

projects_before_stop="$(shasum -a 256 "$STATE/projects.json" | awk '{print $1}')"
receipt_before_stop="$(shasum -a 256 "$STATE/state/summary-registry/migration-receipt.json" | awk '{print $1}')"
manifest_before_stop="$(shasum -a 256 "$manifest" | awk '{print $1}')"
if run_lifecycle stop --project demo --lead demo-lead \
  >"$TMP/stop-claude.out" 2>"$TMP/stop-claude.err" \
  && [ ! -e "$CLAUDE_PLIST" ] \
  && grep -Fq "bootout gui/$(id -u)/com.flywheel.lead.demo-demo-lead" "$LAUNCHCTL_CALLS" \
  && [ "$projects_before_stop" = "$(shasum -a 256 "$STATE/projects.json" | awk '{print $1}')" ] \
  && [ "$receipt_before_stop" = "$(shasum -a 256 "$STATE/state/summary-registry/migration-receipt.json" | awk '{print $1}')" ] \
  && [ "$manifest_before_stop" = "$(shasum -a 256 "$manifest" | awk '{print $1}')" ] \
  && grep -Fq 'Bridge still pumps this registered Lead' "$TMP/stop-claude.out"; then
  pass "stop removes only the exact owned service and preserves registry artifacts"
else
  fail "exact owned stop failed: $(cat "$TMP/stop-claude.err")"
fi

DRIFT_PLIST="$LAUNCHD_DIR/com.flywheel.lead.demo-demo-lead.plist"
python3 - "$DRIFT_PLIST" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "wb") as handle:
    plistlib.dump({
        "Label": "com.flywheel.lead.demo-demo-lead",
        "ProgramArguments": ["/bin/bash", "/tmp/unregistered-lead.sh"],
    }, handle)
PY
calls_before_drift_stop="$(wc -l < "$LAUNCHCTL_CALLS" | tr -d ' ')"
if run_lifecycle stop --project demo --lead demo-lead \
  >"$TMP/stop-drift.out" 2>"$TMP/stop-drift.err"; then
  fail "stop must reject an unowned plist shape"
elif [ "$?" -eq 78 ] \
  && [ -f "$DRIFT_PLIST" ] \
  && [ "$calls_before_drift_stop" = "$(wc -l < "$LAUNCHCTL_CALLS" | tr -d ' ')" ] \
  && grep -Fq 'does not match an owned Lead carrier' "$TMP/stop-drift.err"; then
  pass "stop rejects an unowned plist without bootout or deletion"
else
  fail "drifted stop returned the wrong result: $(cat "$TMP/stop-drift.err")"
fi
rm -f "$DRIFT_PLIST"

mv "$PROJECT_ROOT/.lead/demo-lead/identity.md" "$TMP/install-missing-identity.md"
plists_before_failed_install="$(find "$LAUNCHD_DIR" -type f -print -exec shasum -a 256 {} \; | LC_ALL=C sort)"
calls_before_failed_install="$(wc -l < "$LAUNCHCTL_CALLS" | tr -d ' ')"
if run_lifecycle install --project demo --lead demo-lead \
  >"$TMP/install-preflight-fail.out" 2>"$TMP/install-preflight-fail.err"; then
  fail "install must stop when preflight fails"
elif [ "$?" -eq 78 ] \
  && [ "$plists_before_failed_install" = \
    "$(find "$LAUNCHD_DIR" -type f -print -exec shasum -a 256 {} \; | LC_ALL=C sort)" ] \
  && [ "$calls_before_failed_install" = "$(wc -l < "$LAUNCHCTL_CALLS" | tr -d ' ')" ] \
  && grep -Fq 'identity.md' "$TMP/install-preflight-fail.err"; then
  pass "install preflight failure leaves plist and supervisor state untouched"
else
  fail "failed install mutated lifecycle state: $(cat "$TMP/install-preflight-fail.err")"
fi
mv "$TMP/install-missing-identity.md" "$PROJECT_ROOT/.lead/demo-lead/identity.md"

VERIFY_CURL_CALLS="$TMP/verify-curl.calls"
: > "$VERIFY_CURL_CALLS"
cat > "$STATE/bin/curl" <<'SH'
#!/bin/bash
out_file=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out_file="$2"; shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
cat >/dev/null || true
printf '%s\n' "$url" >> "$VERIFY_CURL_CALLS"
case "$url" in
  */health)
    printf '%s\n' '{"ok":true,"buildSha":"fixture-build-sha"}'
    ;;
  */api/lead-inbox/nudge)
    [ -z "$out_file" ] || printf '%s\n' '{"ok":true}' > "$out_file"
    printf '%s' "${VERIFY_NUDGE_STATUS:-202}"
    ;;
  *) exit 22 ;;
esac
SH
chmod +x "$STATE/bin/curl"

cat > "$TMP/verify-cli.mjs" <<'JS'
import { spawnSync } from "node:child_process";
if (process.argv[2] === "message-status") {
  const deliveryId = process.argv[3];
  const state = process.env.MESSAGE_STATUS_STATE ?? "ACKED";
  process.stdout.write(JSON.stringify({
    location: "live",
    message_id: deliveryId,
    state,
    dead_reason: null,
    last_error: null,
    stamps: {
      created_at: "2026-09-08T00:00:00.000Z",
      delivered_at: state === "ACKED" ? "2026-09-08T00:00:01.000Z" : null,
      notified_at: null,
      settled_at: null,
    },
  }) + "\n");
  process.exit(0);
}
const child = spawnSync(process.execPath, [process.env.REAL_CLI, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
});
process.exit(child.status ?? 1);
JS

run_verify() {
  HOME="$H" PATH="$STATE/bin:$PATH" FLYWHEEL_DIR="$REPO_ROOT" \
    FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_COMM_CLI="$TMP/verify-cli.mjs" \
    FLYWHEEL_TEAMLEAD_ROOT="$REPO_ROOT/packages/teamlead" \
    FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$VALIDATOR" \
    FLYWHEEL_SUPERVISOR_BACKEND=launchd FLYWHEEL_LAUNCHD_DIR="$LAUNCHD_DIR" \
    REAL_CLI="$CLI" VERIFY_CURL_CALLS="$VERIFY_CURL_CALLS" \
    LAUNCHCTL_CALLS="$LAUNCHCTL_CALLS" \
    "$LAUNCHER" verify "$@"
}

if run_verify --stage registered "$manifest" \
  > "$TMP/verify-registered.out" 2> "$TMP/verify-registered.err" \
  && grep -Fq 'PASS #1 registry recovery intent' "$TMP/verify-registered.out" \
  && grep -Fq 'PASS #4 preflight' "$TMP/verify-registered.out" \
  && [ ! -s "$VERIFY_CURL_CALLS" ]; then
  pass "registered verification proves only the four local registration checks"
else
  fail "registered verification contract failed: $(cat "$TMP/verify-registered.err")"
fi

if VERIFY_NUDGE_STATUS=202 run_verify --stage installed "$manifest" \
  > "$TMP/verify-installed.out" 2> "$TMP/verify-installed.err" \
  && grep -Fq 'PASS #5 Bridge health buildSha=fixture-build-sha' "$TMP/verify-installed.out" \
  && grep -Fq 'PASS #6 Lead inbox pump mounted' "$TMP/verify-installed.out"; then
  pass "installed verification distinguishes Bridge health from pump mounting"
else
  fail "installed verification contract failed: $(cat "$TMP/verify-installed.err")"
fi

if VERIFY_NUDGE_STATUS=404 run_verify --stage installed "$manifest" \
  > "$TMP/verify-nudge-missing.out" 2> "$TMP/verify-nudge-missing.err"; then
  fail "installed verification must reject a Bridge without this Lead pump"
elif [ "$?" -eq 1 ] \
  && grep -Fq 'registration succeeded; Bridge has not restarted' "$TMP/verify-nudge-missing.err"; then
  pass "reports the expected post-registration pre-Bridge-restart intermediate state"
else
  fail "missing pump returned the wrong verification result: $(cat "$TMP/verify-nudge-missing.err")"
fi

mkdir -p "$H/.claude/teams/demo-lead/inboxes"
cat > "$STATE/bin/launchctl" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$LAUNCHCTL_CALLS"
if [ "${1:-}" = print ]; then
  printf '%s\n' 'state = running' 'pid = 4101'
  [ "${LAUNCHCTL_MODE:-}" != duplicate ] || printf '%s\n' 'pid = 4102'
fi
exit 0
SH
chmod +x "$STATE/bin/launchctl"
if VERIFY_NUDGE_STATUS=202 run_verify --stage live --message-id 323456789012345678 "$manifest" \
  > "$TMP/verify-claude-live.out" 2> "$TMP/verify-claude-live.err" \
  && grep -Fq 'PASS #7 launchd running pid=4101' "$TMP/verify-claude-live.out" \
  && grep -Fq 'PASS #8 Claude inbox' "$TMP/verify-claude-live.out" \
  && grep -Fq 'PASS #9 mailbox state=ACKED delivered_at=2026-09-08T00:00:01.000Z' \
    "$TMP/verify-claude-live.out"; then
  pass "live Claude verification proves one process, inbox, and ACKED mailbox delivery"
else
  fail "live Claude verification contract failed: $(cat "$TMP/verify-claude-live.err")"
fi

if LAUNCHCTL_MODE=duplicate VERIFY_NUDGE_STATUS=202 run_verify --stage live "$manifest" \
  > "$TMP/verify-duplicate-pid.out" 2> "$TMP/verify-duplicate-pid.err"; then
  fail "live verification must reject multiple launchd pids"
elif [ "$?" -eq 1 ] && grep -Fq 'FAIL #7' "$TMP/verify-duplicate-pid.err"; then
  pass "live verification rejects a non-unique Lead process"
else
  fail "duplicate pid verification returned the wrong result: $(cat "$TMP/verify-duplicate-pid.err")"
fi

CODEX_SHORT_STATE="/tmp/fly2444-codex-state-$$"
export FLYWHEEL_CODEX_LEAD_STATE_DIRS
FLYWHEEL_CODEX_LEAD_STATE_DIRS="$(jq -nc --arg path "$CODEX_SHORT_STATE" \
  '{"codex-demo":{"demo-codex":$path}}')"
codex_state_dir="$(HOME="$H" FLYWHEEL_STATE_DIR="$STATE" \
  /bin/bash "$REPO_ROOT/packages/teamlead/scripts/codex-lead.sh" \
    --print-state-dir demo-codex codex-demo)"
mkdir -p "$codex_state_dir"
python3 - "$codex_state_dir/lead-inbox.sock" <<'PY' &
import socket
import sys
import time

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.bind(sys.argv[1])
sock.listen(1)
time.sleep(30)
PY
socket_pid=$!
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  [ -S "$codex_state_dir/lead-inbox.sock" ] && break
  sleep 0.1
done
node - "$REPO_ROOT/packages/teamlead/node_modules/better-sqlite3" \
  "$codex_state_dir" "$STATE/codex-lead-outbound-dedup.db" <<'JS'
const Database = require(process.argv[2]);
const stateDir = process.argv[3];
const dedupPath = process.argv[4];
const deliveryId = "chat:demo-codex:423456789012345678";
const entryId = "entry-for-message";
const key = `${entryId}:out`;
const journal = new Database(`${stateDir}/journal.db`);
journal.exec(`
  CREATE TABLE journal (id TEXT PRIMARY KEY, state TEXT NOT NULL, outbox_id TEXT);
  CREATE TABLE journal_member (entry_id TEXT NOT NULL, delivery_id TEXT NOT NULL UNIQUE);
`);
journal.prepare("INSERT INTO journal (id, state, outbox_id) VALUES (?, 'completed', ?)").run(entryId, key);
journal.prepare("INSERT INTO journal_member (entry_id, delivery_id) VALUES (?, ?)").run(entryId, deliveryId);
journal.close();
const outbox = new Database(`${stateDir}/outbox.db`);
outbox.exec("CREATE TABLE outbox (outbox_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, status TEXT NOT NULL)");
outbox.prepare("INSERT INTO outbox (outbox_id, idempotency_key, status) VALUES (?, ?, 'sent')").run(key, key);
outbox.close();
const dedup = new Database(dedupPath);
dedup.exec("CREATE TABLE outbound_dedup (idempotency_key TEXT PRIMARY KEY, status TEXT NOT NULL, message_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
dedup.prepare("INSERT INTO outbound_dedup VALUES (?, 'sent', ?, 1, 1)").run(key, "523456789012345678");
dedup.prepare("INSERT INTO outbound_dedup VALUES (?, 'sent', ?, 2, 2)").run("later-entry:out", "623456789012345678");
dedup.close();
JS
CODEX_VERIFY_RC=0
VERIFY_NUDGE_STATUS=202 run_verify --stage live --message-id 423456789012345678 "$codex_manifest" \
  > "$TMP/verify-codex-live.out" 2> "$TMP/verify-codex-live.err" || CODEX_VERIFY_RC=$?
kill "$socket_pid" 2>/dev/null || true
wait "$socket_pid" 2>/dev/null || true
if [ "$CODEX_VERIFY_RC" -eq 0 ] \
  && grep -Fq 'PASS #8 Codex inbox socket' "$TMP/verify-codex-live.out" \
  && grep -Fq 'PASS #9 mailbox state=ACKED' "$TMP/verify-codex-live.out" \
  && grep -Fq 'PASS #10 Codex outbound delivery_id=chat:demo-codex:423456789012345678 entry_id=entry-for-message idempotency_key=entry-for-message:out message_id=523456789012345678' \
    "$TMP/verify-codex-live.out" \
  && [ ! -s "$TMP/verify-codex-live.err" ]; then
  pass "Codex live verification proves the exact message through Lead and Bridge outbound ledgers"
else
  fail "Codex outbound verification did not close #10: rc=$CODEX_VERIFY_RC $(cat "$TMP/verify-codex-live.err")"
fi

echo ""
echo "[flywheel-lead] passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]

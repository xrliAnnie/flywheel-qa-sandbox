#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/f2301-layers.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
passed=0
failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }
qa_test_file_mode() {
  local path="$1" mode=""
  if mode="$(stat -c %a "$path" 2>/dev/null)" \
      && [[ "$mode" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s\n' "$mode"
    return 0
  fi
  mode="$(stat -f %Lp "$path" 2>/dev/null)" \
    && [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  printf '%s\n' "$mode"
}

renderer="$ROOT/scripts/lib/qa-launchd-env.py"
env_file="$TMP/lead.env"
hostile="value with spaces and 'quotes'"
if python3 "$renderer" --output "$env_file" \
    "TEST_BOT_TOKEN_7=$hostile" \
    'FLYWHEEL_PROJECTS_FILE=/tmp/flywheel-test-slot-7/q/7/projects.json' \
    'CODEX_HOME=/tmp/flywheel-test-slot-7/cdxh/flywheel-test-7' \
    'QA_SENTINEL_SECRET=projected-arbitrary-value' \
    && [ "$(qa_test_file_mode "$env_file")" = 600 ]; then
  unset TEST_BOT_TOKEN_7 FLYWHEEL_PROJECTS_FILE CODEX_HOME QA_SENTINEL_SECRET
  # shellcheck disable=SC1090
  set -a; source "$env_file"; set +a
  if [[ "$TEST_BOT_TOKEN_7" == "$hostile" ]] \
      && [[ "$FLYWHEEL_PROJECTS_FILE" == /tmp/flywheel-test-slot-7/q/7/projects.json ]] \
      && [[ "$CODEX_HOME" == /tmp/flywheel-test-slot-7/cdxh/flywheel-test-7 ]] \
      && [[ "$QA_SENTINEL_SECRET" == projected-arbitrary-value ]]; then
    pass "Codex env renderer shell-quotes arbitrary non-resolver assignments atomically"
  else
    fail "Codex env renderer value round trip"
  fi
else
  fail "Codex env renderer successful projection"
fi

resolver_names=(
  LEAD_ID PROJECT_NAME FLYWHEEL_LEAD_ID FLYWHEEL_PROJECT_NAME FLYWHEEL_LEAD_KEY
  FLYWHEEL_LEAD_BACKEND FLYWHEEL_LEAD_BOT_USER_ID FLYWHEEL_LEAD_ROLE
  FLYWHEEL_LEAD_MODEL FLYWHEEL_LEAD_EFFORT FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW
  FLYWHEEL_LEAD_SUMMARY_ROLE FLYWHEEL_LEAD_HAS_SUMMARY_DUTY
  FLYWHEEL_SUMMARY_GRANULARITY FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST
  FLYWHEEL_LEAD_IDENTITY_DIGEST FLYWHEEL_LEAD_PROJECTS_DIGEST
  FLYWHEEL_CANONICAL_IDENTITY_RESOLVED FLYWHEEL_CODEX_LEAD_ID
  FLYWHEEL_CODEX_LEAD_PROJECT FLYWHEEL_CODEX_LEAD_BOT_TOKEN_ENV
  DISCORD_STATE_DIR DISCORD_EXPECTED_BOT_USER_ID DISCORD_IDENTITY_MODE
  DISCORD_BOT_TOKEN FLYWHEEL_PROJECTS FLYWHEEL_SUMMARY_CONFIG_HOME
  FLYWHEEL_CODEX_LEAD_STATE_DIR FLYWHEEL_LEAD_DRY_RUN
)
deny_ok=1
for resolver_name in "${resolver_names[@]}"; do
  candidate="$TMP/deny-${resolver_name}.env"
  secret_value="must-not-print-${resolver_name}"
  if python3 "$renderer" --output "$candidate" \
      "${resolver_name}=${secret_value}" >"$TMP/deny.out" 2>"$TMP/deny.err"; then
    deny_ok=0
  fi
  if [[ -e "$candidate" ]] \
      || ! grep -Fq "$resolver_name" "$TMP/deny.err" \
      || grep -Fq "$secret_value" "$TMP/deny.err" \
      || [[ -s "$TMP/deny.out" ]]; then
    deny_ok=0
  fi
done
if [[ "$deny_ok" == 1 ]]; then
  pass "Codex env renderer rejects every canonical identity/resolver-owned name without values"
else
  fail "Codex env renderer resolver deny set"
fi

printf '%s\n' 'preserve-existing-output' > "$TMP/unchanged.env"
duplicate_secret='duplicate-secret-must-not-print'
negative_ok=1
if python3 "$renderer" --output "$TMP/duplicate.env" \
    'TEST_BOT_TOKEN_7=first' "TEST_BOT_TOKEN_7=$duplicate_secret" \
    >"$TMP/duplicate.out" 2>"$TMP/duplicate.err"; then
  negative_ok=0
fi
if [[ -e "$TMP/duplicate.env" ]] \
    || ! grep -Fq 'TEST_BOT_TOKEN_7' "$TMP/duplicate.err" \
    || grep -Fq "$duplicate_secret" "$TMP/duplicate.err"; then
  negative_ok=0
fi
if python3 "$renderer" --output "$TMP/invalid.env" \
    'BAD-NAME=invalid-secret-must-not-print' >"$TMP/invalid.out" 2>"$TMP/invalid.err"; then
  negative_ok=0
fi
if [[ -e "$TMP/invalid.env" ]] \
    || ! grep -Fq 'BAD-NAME' "$TMP/invalid.err" \
    || grep -Fq 'invalid-secret-must-not-print' "$TMP/invalid.err"; then
  negative_ok=0
fi
if python3 "$renderer" --output "$TMP/unchanged.env" \
    'FLYWHEEL_LEAD_ID=replace-secret-must-not-print' >/dev/null 2>&1; then
  negative_ok=0
fi
if [[ "$(cat "$TMP/unchanged.env")" != preserve-existing-output ]] \
    || find "$TMP" -name '*.tmp.*' -print -quit | grep -q .; then
  negative_ok=0
fi
if [[ "$negative_ok" == 1 ]]; then
  pass "Codex env renderer rejects duplicates and invalid names without partial replacement"
else
  fail "Codex env renderer negative assignment matrix"
fi

if python3 "$renderer" --check 'A=one' 'B=two words' >/dev/null 2>&1 \
    && ! python3 "$renderer" --check 'A=one' 'A=two' >/dev/null 2>&1; then
  pass "Codex env renderer supports a side-effect-free preflight before home minting"
else
  fail "Codex env renderer side-effect-free preflight"
fi

stdin_env="$TMP/stdin.env"
stdin_hostile="stdin value with spaces and 'quotes'"
if printf '%s\0' "TEST_BOT_TOKEN_7=$stdin_hostile" 'B=two words' \
    | python3 "$renderer" --check >/dev/null 2>&1 \
    && printf '%s\0' "TEST_BOT_TOKEN_7=$stdin_hostile" 'B=two words' \
      | python3 "$renderer" --output "$stdin_env" \
    && unset TEST_BOT_TOKEN_7 B \
    && set -a && source "$stdin_env" && set +a \
    && [[ "$TEST_BOT_TOKEN_7" == "$stdin_hostile" && "$B" == 'two words' ]]; then
  pass "Codex env renderer accepts NUL-delimited assignments without argv exposure"
else
  fail "Codex env renderer stdin assignment transport"
fi

# Layer 1: the public identity resolver must consume the generated projects row.
# The fake HOME intentionally has no default projects.json, so later launcher
# coverage can prove the explicit slot file is not optional.
source "$ROOT/scripts/lib/qa-multilead.sh"
source "$ROOT/scripts/lib/qa-launchd-lead.sh"
source "$ROOT/scripts/lib/qa-lead-artifacts.sh"
layer_home="$TMP/home"
layer_project_root="$TMP/project"
layer_state="$TMP/discord-state"
layer_workspace="$TMP/lead-workspace"
layer_identity="$TMP/identity.md"
layer_projects="$TMP/projects.json"
layer_env="$TMP/projected.env"
mkdir -p "$layer_home/.flywheel" "$layer_project_root" "$layer_state" "$layer_workspace"
printf '%s\n' '# QA Lead identity' > "$layer_identity"
printf '%s\n' '{"granularity":"per-lead","setBy":"test","setAt":"2026-09-03T00:00:00.000Z"}' \
  > "$layer_home/.flywheel/summary-config.json"
layer_shape='{"backend":"codex-app-server","codexProfile":"companion"}'
qa_multilead_build_projects test-slot-7 "$layer_project_root" repo qa-lead \
  12345678901234567 TEST_BOT_TOKEN_7 lead '["*"]' '[]' \
  12345678901234567 "$layer_state" "$layer_shape" > "$layer_projects"
resolver_json=$(HOME="$layer_home" TEST_BOT_TOKEN_7=layer-token \
  node "$ROOT/packages/flywheel-comm/dist/index.js" lead-identity resolve \
  --projects-file "$layer_projects" --project test-slot-7 --lead qa-lead \
  --summary-config-home "$layer_home" --format json 2>/dev/null || true)
if jq -e '
    .leadId == "qa-lead" and .projectName == "test-slot-7" and
    .backend == "codex-app-server" and .role == "companion" and
    .botTokenEnv == "TEST_BOT_TOKEN_7" and .botUserId == "12345678901234567"
  ' >/dev/null 2>&1 <<<"$resolver_json"; then
  pass "real flywheel-comm resolver accepts the generated companion projects row"
else
  fail "real flywheel-comm companion identity resolution"
fi

# Layer 2: ProjectConfig and the production resident roster agree on eligibility.
roster_probe="$TMP/roster-probe.mjs"
cat > "$roster_probe" <<'JS'
import { pathToFileURL } from "node:url";
const root = process.env.FLYWHEEL_REPO_ROOT;
const { loadProjects } = await import(pathToFileURL(`${root}/packages/teamlead/dist/ProjectConfig.js`));
const { findResidentCodexLeadTargets } = await import(pathToFileURL(`${root}/packages/teamlead/dist/resident-codex-lead-roster.js`));
const projects = loadProjects();
console.log(JSON.stringify({ projectCount: projects.length, targets: findResidentCodexLeadTargets(projects) }));
JS
roster_json=$(HOME="$layer_home" FLYWHEEL_REPO_ROOT="$ROOT" FLYWHEEL_PROJECTS_FILE="$layer_projects" \
  TEST_BOT_TOKEN_7=layer-token node "$roster_probe" 2>/dev/null || true)
jq 'del(.[0].leads[0].codexResidencyPatrol)' "$layer_projects" > "$TMP/projects-no-patrol.json"
roster_negative=$(HOME="$layer_home" FLYWHEEL_REPO_ROOT="$ROOT" FLYWHEEL_PROJECTS_FILE="$TMP/projects-no-patrol.json" \
  TEST_BOT_TOKEN_7=layer-token node "$roster_probe" 2>/dev/null || true)
if jq -e '.projectCount == 1 and (.targets | length) == 1 and
    .targets[0].leadKey == "test-slot-7-qa-lead"' >/dev/null 2>&1 <<<"$roster_json" \
    && jq -e '.projectCount == 1 and (.targets | length) == 0' \
      >/dev/null 2>&1 <<<"$roster_negative"; then
  pass "real ProjectConfig and resident roster require the complete Codex patrol shape"
else
  fail "real ProjectConfig/resident roster shape agreement"
fi

# Layer 3: run the real launcher + canonical resolver to the exec boundary;
# only the final runtime is a dump-only fixture.
fake_repo="$TMP/fake-repo"
mkdir -p "$fake_repo/packages/teamlead/scripts/lib" \
  "$fake_repo/packages/teamlead/dist/lead-backends/codex"
cp "$ROOT/packages/teamlead/scripts/codex-lead.sh" "$fake_repo/packages/teamlead/scripts/codex-lead.sh"
cp "$ROOT/packages/teamlead/scripts/lib/canonical-lead-identity.sh" \
  "$fake_repo/packages/teamlead/scripts/lib/canonical-lead-identity.sh"
cat > "$fake_repo/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js" <<'JS'
const keys = [
  "DISCORD_GUILD_ID", "BRIDGE_URL", "AGENT_SOURCE", "TEAMLEAD_API_TOKEN",
  "FLYWHEEL_PROJECTS_FILE", "TEAMLEAD_DB_PATH", "FLYWHEEL_STATE_DIR",
  "FLYWHEEL_WRAPPER_ENV_FILE", "FLYWHEEL_DELIVERY_SECRET_PATH", "LEAD_WORKSPACE",
  "FLYWHEEL_LEAD_CHAT_CHANNEL_ID", "FLYWHEEL_COMM_DB", "FLYWHEEL_COMM_CLI",
  "CODEX_HOME", "FLYWHEEL_CODEX_BIN", "FLYWHEEL_CODEX_LEAD_MODE",
  "FLYWHEEL_CODEX_TUI_CWD", "FLYWHEEL_CODEX_LEAD_OUTBOUND",
  "FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES", "QA_SENTINEL_SECRET",
  "FLYWHEEL_LEAD_ID", "FLYWHEEL_PROJECT_NAME", "FLYWHEEL_LEAD_KEY",
  "FLYWHEEL_LEAD_BACKEND", "FLYWHEEL_LEAD_IDENTITY_DIGEST",
  "DISCORD_EXPECTED_BOT_USER_ID", "DISCORD_BOT_TOKEN",
  "FLYWHEEL_CODEX_LEAD_STATE_DIR"
];
console.log(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]))));
JS
layer_codex_home="$TMP/cdxh/qa-lead"
layer_state_root="$TMP/q/7"
layer_codex_bin="$layer_codex_home/packages/standalone/current/codex"
layer_comm_db="$layer_home/.flywheel/comm/test-slot-7/comm.db"
layer_prompt_files="$layer_identity,$ROOT/packages/teamlead/lead-rules-base/companion-safety-contract.md"
python3 "$renderer" --output "$layer_env" \
  'TEST_BOT_TOKEN_7=layer-token' \
  'DISCORD_GUILD_ID=guild-7' 'BRIDGE_URL=http://localhost:4242' \
  "AGENT_SOURCE=$layer_identity" 'TEAMLEAD_API_TOKEN=' \
  "FLYWHEEL_PROJECTS_FILE=$layer_projects" "TEAMLEAD_DB_PATH=$TMP/teamlead.db" \
  "FLYWHEEL_STATE_DIR=$layer_state_root" "FLYWHEEL_WRAPPER_ENV_FILE=$layer_env" \
  "FLYWHEEL_DELIVERY_SECRET_PATH=$TMP/delivery-secret" "LEAD_WORKSPACE=$layer_workspace" \
  'QA_SENTINEL_SECRET=layer-sentinel' \
  'FLYWHEEL_LEAD_CHAT_CHANNEL_ID=12345678901234567' \
  "FLYWHEEL_COMM_DB=$layer_comm_db" \
  "FLYWHEEL_COMM_CLI=$ROOT/packages/flywheel-comm/dist/index.js" \
  "CODEX_HOME=$layer_codex_home" "FLYWHEEL_CODEX_BIN=$layer_codex_bin" \
  'FLYWHEEL_CODEX_LEAD_MODE=tui' "FLYWHEEL_CODEX_TUI_CWD=$layer_workspace" \
  'FLYWHEEL_CODEX_LEAD_OUTBOUND=direct' \
  "FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES=$layer_prompt_files"
launcher_dump=$(env -i HOME="$layer_home" PATH="$PATH" FLYWHEEL_DIR="$fake_repo" FLYWHEEL_LEAD_DRY_RUN=1 \
  /bin/bash -c 'set -a; source "$1"; set +a; exec /bin/bash "$2" qa-lead "$3" test-slot-7' \
  _ "$layer_env" "$fake_repo/packages/teamlead/scripts/codex-lead.sh" "$layer_workspace" \
  2>"$TMP/launcher.err" | tail -1)
expected_state=$(qa_launchd_codex_state_dir "$layer_state_root" test-slot-7 qa-lead)
if jq -e --arg projects "$layer_projects" --arg state "$expected_state" \
    --arg home "$layer_codex_home" --arg workspace "$layer_workspace" \
    --arg prompt "$layer_prompt_files" '
    .FLYWHEEL_PROJECTS_FILE == $projects and .FLYWHEEL_CODEX_LEAD_STATE_DIR == $state and
    .CODEX_HOME == $home and .FLYWHEEL_CODEX_TUI_CWD == $workspace and
    .FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES == $prompt and
    .FLYWHEEL_LEAD_ID == "qa-lead" and .FLYWHEEL_PROJECT_NAME == "test-slot-7" and
    .FLYWHEEL_LEAD_KEY == "test-slot-7-qa-lead" and
    .FLYWHEEL_LEAD_BACKEND == "codex-app-server" and
    .DISCORD_EXPECTED_BOT_USER_ID == "12345678901234567" and
    .DISCORD_BOT_TOKEN == "layer-token" and .QA_SENTINEL_SECRET == "layer-sentinel"
  ' >/dev/null 2>&1 <<<"$launcher_dump"; then
  pass "real codex-lead launcher resolves only the slot projects file and exports the projected graph"
else
  sed 's/layer-token/[REDACTED]/g' "$TMP/launcher.err" >&2
  fail "real codex-lead launcher projected environment graph"
fi
grep -v '^FLYWHEEL_PROJECTS_FILE=' "$layer_env" > "$TMP/projected-no-projects.env"
if ! env -i HOME="$layer_home" PATH="$PATH" FLYWHEEL_DIR="$fake_repo" FLYWHEEL_LEAD_DRY_RUN=1 \
    /bin/bash -c 'set -a; source "$1"; set +a; exec /bin/bash "$2" qa-lead "$3" test-slot-7' \
    _ "$TMP/projected-no-projects.env" "$fake_repo/packages/teamlead/scripts/codex-lead.sh" \
    "$layer_workspace" >/dev/null 2>&1; then
  pass "real launcher fails when the slot projects coordinate is removed (no HOME fallback)"
else
  fail "real launcher projects-file positive control"
fi

full_profile=$(qa_codex_profile_assignments full-access "$ROOT" "$expected_state" /usr/bin/node 2>/dev/null || true)
companion_profile=$(qa_codex_profile_assignments companion "$ROOT" "$expected_state" /usr/bin/node 2>/dev/null || true)
expected_full_profile=$(cat <<EOF
FLYWHEEL_CODEX_LEAD_PROFILE=full-access
FLYWHEEL_CODEX_LEAD_SANDBOX=workspace-write
FLYWHEEL_LEAD_ACTIONS_MAIN_JS=${ROOT}/packages/teamlead/dist/lead-backends/codex/lead-actions/lead-actions-main.js
FLYWHEEL_LEAD_ACTIONS_NODE_BIN=/usr/bin/node
FLYWHEEL_LEAD_ACTIONS_STATE_DIR=${expected_state}
EOF
)
if [[ -z "$companion_profile" && "$full_profile" == "$expected_full_profile" ]] \
    && ! qa_codex_profile_assignments write-capable "$ROOT" "$expected_state" /usr/bin/node \
      >/dev/null 2>&1; then
  pass "Codex profile projector emits exactly the five full-access assignments"
else
  fail "Codex full-access assignment projection"
fi

runtime_env_json="$TMP/runtime-env.json"
jq -n --arg digest "$(jq -r '.identityDigest' <<<"$resolver_json")" \
  --arg state "$expected_state" --arg bin "$layer_codex_bin" \
  --arg home "$layer_codex_home" --arg db "$layer_comm_db" \
  --arg projectDir "$layer_workspace" '
  {
    FLYWHEEL_LEAD_ID:"qa-lead", FLYWHEEL_PROJECT_NAME:"test-slot-7",
    FLYWHEEL_LEAD_KEY:"test-slot-7-qa-lead", FLYWHEEL_LEAD_BACKEND:"codex-app-server",
    FLYWHEEL_LEAD_IDENTITY_DIGEST:$digest,
    DISCORD_EXPECTED_BOT_USER_ID:"12345678901234567",
    DISCORD_BOT_TOKEN:"layer-token", FLYWHEEL_LEAD_CHAT_CHANNEL_ID:"12345678901234567",
    FLYWHEEL_CODEX_LEAD_STATE_DIR:$state, FLYWHEEL_CODEX_BIN:$bin,
    CODEX_HOME:$home, FLYWHEEL_COMM_DB:$db, FLYWHEEL_CODEX_LEAD_OUTBOUND:"direct",
    FLYWHEEL_CODEX_LEAD_PROJECT_DIR:$projectDir
  }
' > "$runtime_env_json"
runtime_probe="$TMP/runtime-probe.mjs"
cat > "$runtime_probe" <<'JS'
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const root = process.env.FLYWHEEL_REPO_ROOT;
const { parseCodexLeadRuntimeConfig } = await import(pathToFileURL(
  `${root}/packages/teamlead/dist/lead-backends/codex/codex-lead-runtime.js`
));
const base = JSON.parse(readFileSync(process.argv[2], "utf8"));
const accepts = (over = {}) => {
  const env = { ...base, ...over };
  for (const [key, value] of Object.entries(env)) if (value === null) delete env[key];
  try { parseCodexLeadRuntimeConfig(env); return true; } catch { return false; }
};
console.log(JSON.stringify({
  companion: accepts(),
  fullAccess: accepts({ FLYWHEEL_CODEX_LEAD_PROFILE: "full-access", FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write" }),
  fullReadOnlyRejected: !accepts({ FLYWHEEL_CODEX_LEAD_PROFILE: "full-access", FLYWHEEL_CODEX_LEAD_SANDBOX: "read-only" }),
  fullMissingProjectRejected: !accepts({ FLYWHEEL_CODEX_LEAD_PROFILE: "full-access", FLYWHEEL_CODEX_LEAD_SANDBOX: "workspace-write", FLYWHEEL_CODEX_LEAD_PROJECT_DIR: null }),
  wrongKeyRejected: !accepts({ FLYWHEEL_LEAD_KEY: "wrong-key" }),
  missingChannelRejected: !accepts({ FLYWHEEL_LEAD_CHAT_CHANNEL_ID: null })
}));
JS
runtime_result=$(FLYWHEEL_REPO_ROOT="$ROOT" node "$runtime_probe" "$runtime_env_json" 2>/dev/null || true)
if jq -e 'all(.[]; . == true)' >/dev/null 2>&1 <<<"$runtime_result"; then
  pass "real Codex runtime parser accepts both projected tiers and rejects four drift cases"
else
  fail "real Codex runtime profile contract"
fi

tui_home_script="$ROOT/packages/teamlead/scripts/codex-lead-tui-home.sh"
prepare_tui_home() {
  local target="$1"
  mkdir -p "$target/packages/standalone/releases/r1"
  printf '%s\n' '{}' > "$target/auth.json"
  printf '%s\n' '#!/bin/bash' 'exit 0' > "$target/packages/standalone/releases/r1/codex"
  chmod +x "$target/packages/standalone/releases/r1/codex"
  ln -s releases/r1 "$target/packages/standalone/current"
}
run_tui_home() {
  local target="$1"
  shift
  env -i HOME="$layer_home" PATH="$PATH" \
    FLYWHEEL_CODEX_LEAD_PROFILE=full-access \
    FLYWHEEL_CODEX_TUI_HOME="$target" FLYWHEEL_CODEX_TUI_CWD="$layer_workspace" \
    FLYWHEEL_LEAD_ID=qa-lead FLYWHEEL_PROJECT_NAME=test-slot-7 \
    FLYWHEEL_LEAD_CHAT_CHANNEL_ID=12345678901234567 \
    FLYWHEEL_COMM_DB="$layer_comm_db" "$@" \
    /bin/bash "$tui_home_script" ensure-home >/dev/null 2>&1
}
tui_missing_main="$TMP/tui-missing-main"
tui_missing_state="$TMP/tui-missing-state"
tui_default_node="$TMP/tui-default-node"
prepare_tui_home "$tui_missing_main"
prepare_tui_home "$tui_missing_state"
prepare_tui_home "$tui_default_node"
tui_contract_ok=1
run_tui_home "$tui_missing_main" \
  FLYWHEEL_LEAD_ACTIONS_STATE_DIR="$expected_state" && tui_contract_ok=0
run_tui_home "$tui_missing_state" \
  FLYWHEEL_LEAD_ACTIONS_MAIN_JS="$ROOT/packages/teamlead/dist/lead-backends/codex/lead-actions/lead-actions-main.js" \
  && tui_contract_ok=0
if ! run_tui_home "$tui_default_node" \
    FLYWHEEL_LEAD_ACTIONS_MAIN_JS="$ROOT/packages/teamlead/dist/lead-backends/codex/lead-actions/lead-actions-main.js" \
    FLYWHEEL_LEAD_ACTIONS_STATE_DIR="$expected_state" \
    || ! grep -Fq 'command = "node"' "$tui_default_node/config.toml"; then
  tui_contract_ok=0
fi
if [[ "$tui_contract_ok" == 1 ]]; then
  pass "real TUI home requires projected actions main/state and defaults only the node binary"
else
  fail "real TUI home full-access projection contract"
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]

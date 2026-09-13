#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASK_TMP="$(mktemp -d /tmp/fly2459-capability.XXXXXX)"
trap 'rm -rf "$TASK_TMP"' EXIT
mkdir -p "$TASK_TMP/.flywheel"
printf '%s\n' '{"granularity":"per-lead","setBy":"test","setAt":"2026-09-10T00:00:00Z"}' > "$TASK_TMP/.flywheel/summary-config.json"
cat > "$TASK_TMP/projects.json" <<JSON
[{"projectName":"demo","projectRoot":"$TASK_TMP","leads":[{"agentId":"product-lead","summaryRole":"producer","chatChannel":"11111111111111111","botUserId":"22222222222222222","botTokenEnv":"TEST_TOKEN","backend":"codex-app-server","codexProfile":"full-access","canSpawnRunners":true,"codexRunnerActions":true}]}]
JSON
run_resolver() {
  env -i HOME="$TASK_TMP" PATH="$PATH" FLYWHEEL_COMM_CLI="$ROOT/packages/flywheel-comm/dist/index.js" \
    FLYWHEEL_LEAD_DRY_RUN=1 "$@" bash -c '
      source "$1/packages/teamlead/scripts/lib/canonical-lead-identity.sh"
      canonical_lead_identity_resolve demo product-lead "$2/projects.json" || exit 1
      test "$FLYWHEEL_CODEX_LEAD_RUNNER_ACTIONS" = "$3"
    ' bash "$ROOT" "$TASK_TMP" "$EXPECTED"
}
EXPECTED=1 run_resolver
if EXPECTED=1 run_resolver FLYWHEEL_CODEX_LEAD_RUNNER_ACTIONS=0 >"$TASK_TMP/conflict" 2>&1; then
  echo 'FAIL: accepted conflicting capability env'; exit 1
fi
rg -q identity_env_conflict "$TASK_TMP/conflict"
jq '.[0].leads[0].codexRunnerActions = false' "$TASK_TMP/projects.json" > "$TASK_TMP/disabled.json"
mv "$TASK_TMP/disabled.json" "$TASK_TMP/projects.json"
EXPECTED=0 run_resolver
echo 'PASS: raw capability projection and inherited conflict rejection'

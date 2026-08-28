#!/usr/bin/env bash
# FLY-1631: retired runtime-v2 code must not be able to ship or start again.
#
# Public seams under test:
#   1. the monorepo/package surface contains no retired v2 package or launcher;
#   2. active code and deployment manifests contain no retired runtime-v2
#      identifiers;
#   3. Bridge's active workflow_v2 DAG engine remains present.
#
# Historical docs are intentionally excluded: they are evidence, not runtime.
set -uo pipefail

if ! command -v grep >/dev/null 2>&1; then
  echo "FAIL: grep is required by the v2 retirement guard" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "FAIL: git is required by the v2 retirement guard" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$(mktemp -d -t fly1631-retirement-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
PASSED=0
FAILED=0

pass() {
  PASSED=$((PASSED + 1))
  echo "PASS: $1"
}

fail() {
  FAILED=$((FAILED + 1))
  echo "FAIL: $1" >&2
}

retired_paths=(
  packages/v2-actions
  packages/v2-cli
  packages/v2-cutover
  packages/v2-dag
  packages/v2-engine
  packages/v2-host
  packages/v2-kernel
  packages/v2-mailbox-mcp
  packages/v2-scheduler
  packages/teamlead/src/v2-discord-ingress.ts
  packages/teamlead/src/v2-discord-outbound.ts
  packages/teamlead/src/v2-display-refresher.ts
  packages/teamlead/src/v2-display-state-reader.ts
  packages/teamlead/src/v2-issue-display.ts
  packages/teamlead/src/lead-backends/codex/V2DiscordIngress.ts
  packages/teamlead/src/__tests__/v2-authority-entrypoints.test.ts
  packages/teamlead/src/__tests__/v2-discord-ingress-config.test.ts
  packages/teamlead/src/__tests__/v2-discord-outbound.test.ts
  packages/teamlead/src/__tests__/v2-display-refresher.test.ts
  packages/teamlead/src/__tests__/v2-issue-display.test.ts
  packages/teamlead/src/lead-backends/codex/__tests__/V2DiscordIngress.test.ts
  packages/teamlead/src/lead-backends/codex/__tests__/v2-discord-ingress-config.test.ts
  scripts/install-v2-host.sh
  scripts/install-v2-scheduler.sh
  scripts/rehearse-v2-cutover.sh
  scripts/__tests__/qa-fly1502-real-rehearsal.sh
  scripts/__tests__/test-fly1608-lead-guard-cwd.test.sh
  scripts/__tests__/v2-cutover-rehearsal.test.mjs
  scripts/__tests__/v2-host-install.test.sh
  scripts/__tests__/v2-scheduler-install.test.sh
  .flywheel/agents/nodes
)

path_residue=()
for relative_path in "${retired_paths[@]}"; do
  absolute_path="$REPO_ROOT/$relative_path"
  if [ -f "$absolute_path" ] || \
    { [ -d "$absolute_path" ] && find "$absolute_path" -type f -print -quit | grep -q .; }; then
	path_residue+=("$relative_path")
  fi
done

if [ "${#path_residue[@]}" -eq 0 ]; then
  pass "retired runtime-v2 packages, launchers, and agents are absent"
else
  fail "retired runtime-v2 paths remain (${#path_residue[@]}): ${path_residue[*]}"
fi

forbidden_regex='flywheel-v2-(kernel|dag|host|engine|cli|cutover|scheduler|mailbox-mcp|actions)|FLYWHEEL_V2_|\.flywheel/v2|requireLegacyWriterAllowed|v2_mailbox_server|is_v2_session_shape|is_v2_runner_session|@flywheel_v2_session_ref|com\.flywheel\.v2-|v2-(issue-display|display-refresher|display-state-reader|discord-(outbound|ingress))|V2DiscordIngress'
residue="$(git -C "$REPO_ROOT" grep -nE "$forbidden_regex" -- . \
  ':(top,exclude)doc/**' \
  ':(top,exclude)engineering/doc/**' \
  ':(top,exclude)CLAUDE.md' \
  ':(top,exclude)scripts/__tests__/v2-retirement-cleanup.test.sh' 2>&1)"
residue_rc=$?

if [ "$residue_rc" -eq 1 ]; then
  pass "active source, scripts, manifests, and lockfile have zero runtime-v2 identifiers"
elif [ "$residue_rc" -eq 0 ]; then
  fail "active runtime-v2 identifiers remain"
  printf '%s\n' "$residue" | sed -n '1,40p' >&2
else
  fail "tracked-file runtime-v2 scan failed (rc=$residue_rc)"
  printf '%s\n' "$residue" | sed -n '1,40p' >&2
fi

if grep -Eq '"\./channel-lease"|lastOkAt|touchLease|readLease|leaseIsHealthy' \
  "$REPO_ROOT/packages/inbox-mcp/package.json" \
  "$REPO_ROOT/packages/inbox-mcp/src/channel-lease.ts"; then
  fail "v2-only inbox channel-health API remains exported"
else
  pass "inbox lease keeps only the v1 pid/start contract"
fi

lead_home="$SANDBOX/home"
project_dir="$lead_home/project"
identity_dir="$project_dir/.lead/test-lead"
mkdir -p "$identity_dir"
printf -- '---\nname: test-lead\n---\nTest Lead\n' > "$identity_dir/identity.md"
projects_json="[{\"projectName\":\"test\",\"projectRoot\":\"$project_dir\",\"leads\":[{\"agentId\":\"test-lead\",\"summaryRole\":\"producer\",\"chatChannel\":\"111\",\"match\":{\"labels\":[\"test\"]},\"botTokenEnv\":\"TEST_BOT_TOKEN\",\"botUserId\":\"12345678901234567\",\"canSpawnRunners\":true}]}]"
launcher_output="$SANDBOX/launcher.out"
env -i HOME="$lead_home" PATH="$PATH" \
  FLYWHEEL_LEAD_DRY_RUN=1 \
  FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=1 \
  FLYWHEEL_PROJECTS="$projects_json" \
  TEST_BOT_TOKEN=stub \
  TEAMLEAD_API_TOKEN=stub \
  bash "$REPO_ROOT/packages/teamlead/scripts/claude-lead.sh" \
    test-lead "$project_dir" test > "$launcher_output" 2>&1
launcher_rc=$?
mcp_config="$lead_home/.flywheel/lead-workspace/test-lead/.mcp.json"

if [ "$launcher_rc" -eq 0 ] \
  && grep -Eq 'LAUNCH_PLAN_END' "$launcher_output" \
  && [ -f "$mcp_config" ] \
  && jq -e '.mcpServers | has("flywheel-v2-mailbox") | not' "$mcp_config" >/dev/null \
  && ! grep -Eq 'FLYWHEEL_V2_|\.flywheel/v2' "$mcp_config"; then
  pass "hermetic Lead dry-run writes an MCP config with no retired v2 server"
else
  fail "hermetic Lead dry-run failed or emitted retired v2 MCP config (rc=$launcher_rc)"
  tail -20 "$launcher_output" >&2
fi

workflow_refs="$(grep -rlE 'workflow_v2' \
  "$REPO_ROOT/packages/teamlead/src/bridge" 2>/dev/null | sort -u || true)"
if [ -n "$workflow_refs" ]; then
  pass "active workflow_v2 DAG engine remains present"
else
  fail "workflow_v2 DAG engine was removed or renamed"
fi

echo "v2-retirement-cleanup: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]

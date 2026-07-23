#!/usr/bin/env bash
# Start the slot-1 Lead in the companion=true shape using the same launcher,
# pinned isolated plugin/config, and a dedicated workspace/state directory.
set -euo pipefail

slot_dir="/tmp/flywheel-test-slot-1"
repo_root="/Users/xiaorongli/Dev/flywheel-FLY-1439"
slots_file="${HOME}/.flywheel/test-slots.json"
env_file="${HOME}/.flywheel/.env"
project="test-slot-1"
lead_id="flywheel-test-1"
token_env="TEST_BOT_TOKEN_1"
config_dir="${slot_dir}/claude-config"
companion_state="${slot_dir}/discord-state-companion"
companion_workspace="${slot_dir}/lead-workspace-companion"
companion_projects_file="${slot_dir}/s4-companion-projects.json"

# shellcheck disable=SC1090
source "$env_file"
token="${!token_env:?TEST_BOT_TOKEN_1 is required}"
guild_id="$(jq -r '.guildId' "$slots_file")"

if [[ "$config_dir" != "${slot_dir}/claude-config" ]]; then
  printf 'isolated config mismatch\n' >&2
  exit 1
fi
mkdir -p "$companion_state" "$companion_workspace"
jq -c '
  map(
    if .projectName == "test-slot-1" then
      .leads |= map(
        if .agentId == "flywheel-test-1" then
          . + {companion: true}
        else .
        end
      )
    else .
    end
  )
' "${slot_dir}/flywheel-projects.json" >"$companion_projects_file"
jq -e '
  any(.[];
    .projectName == "test-slot-1" and
    any(.leads[];
      .agentId == "flywheel-test-1" and .companion == true
    )
  )
' "$companion_projects_file" >/dev/null
jq -n \
  --arg driver "1493072948683341976" \
  --arg channel "1504277055406211142" \
  '{
    dmPolicy: "allowlist",
    allowFrom: [],
    allowBots: [$driver],
    groups: {($channel): {requireMention: false, allowFrom: []}},
    pending: {}
  }' >"${companion_state}/access.json"
chmod 600 "${companion_state}/access.json"
projects="$(<"$companion_projects_file")"

exec env \
  -u LEAD_WORKSPACE \
  -u FLYWHEEL_LEAD_MODEL \
  -u FLYWHEEL_LEAD_EFFORT \
  DISCORD_BOT_TOKEN="$token" \
  DISCORD_GUILD_ID="$guild_id" \
  BRIDGE_URL="http://localhost:19871" \
  DISCORD_STATE_DIR="$companion_state" \
  AGENT_SOURCE="${slot_dir}/test-identity.md" \
  FLYWHEEL_LEAD_ROLE="cos" \
  FLYWHEEL_PROJECTS="$projects" \
  LEAD_WORKSPACE="$companion_workspace" \
  CLAUDE_CONFIG_DIR="$config_dir" \
  TEST_SKIP_PLUGIN_FORK_CHECK=1 \
  TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="$config_dir" \
  FLYWHEEL_FOUNDER_ATTRIBUTION_GATE=0 \
  FLYWHEEL_RECEIPT_WINDOW_P0_MIN=2 \
  FLYWHEEL_RECEIPT_WINDOW_P1_MIN=2 \
  FLYWHEEL_DELIVERY_SECRET_PATH="${slot_dir}/delivery-secret" \
  bash "${repo_root}/packages/teamlead/scripts/claude-lead.sh" \
    "$lead_id" "${slot_dir}/project-slot-1" "$project"

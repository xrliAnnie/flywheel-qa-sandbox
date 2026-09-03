#!/usr/bin/env bash
# Sourceable artifact renderers for 529-room Lead carriers. Keep these helpers
# free of ambient state so byte-level compatibility can be tested without
# launching a room.

# Build the launch environment captured in a v2 manifest from NAME=value
# arguments. Values stay data (jq --arg), never shell syntax.
qa_slot_launch_env_json() {
  local json='{}' assignment name value
  for assignment in "$@"; do
    name="${assignment%%=*}"
    value="${assignment#*=}"
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
      || { log "ERROR: invalid QA Lead environment key: ${name}"; return 1; }
    json=$(jq -c --arg name "$name" --arg value "$value" \
      '. + {($name): $value}' <<<"$json") || return 1
  done
  printf '%s\n' "$json"
}

# Write the wrapper-owned secret environment using the legacy bash %q byte
# representation. The token value is never printed.
qa_lead_write_env() {
  local env_file="$1" token_env="$2" token_value="$3"
  printf '%s=%q\n' "$token_env" "$token_value" > "$env_file" || return 1
  chmod 600 "$env_file"
}

qa_lead_write_manifest() {
  local manifest="$1" agent="$2" project_dir="$3" project_name="$4"
  local projects="$5" workspace="$6" mcp_exclude="$7" launch_env="$8"
  jq -n \
    --arg leadId "$agent" --arg projectDir "$project_dir" \
    --arg projectName "$project_name" --arg projectsFile "$projects" \
    --arg workspace "$workspace" --arg mcpExclude "$mcp_exclude" \
    --argjson launchEnvironment "$launch_env" \
    '{leadId:$leadId,projectDir:$projectDir,projectName:$projectName,
      projectsFile:$projectsFile,workspace:$workspace,mcpExclude:$mcpExclude,
      launchEnvironment:$launchEnvironment}' \
    > "$manifest" || return 1
  chmod 600 "$manifest"
}

qa_lead_write_launch_manifest() {
  local out="$1" bridge_pid="$2" dist_sha="$3" from_branch="$4" mode="$5"
  local campaign_id="$6" lead_label="$7" extra_leads_json="$8" carrier="$9"
  local registry="${10}" label="${11}" socket="${12}"
  local codex_lead_json="${13:-null}"
  qa_multilead_launch_manifest "$bridge_pid" "$dist_sha" "$from_branch" "$mode" \
    "$campaign_id" "$lead_label" "$extra_leads_json" > "$out" || return 1
  jq --arg carrier "$carrier" --arg registry "$registry" \
    --arg label "$label" --arg socket "$socket" \
    --argjson codexLead "$codex_lead_json" \
    '. + {leadCarrier:$carrier,launchdRegistry:$registry,mainLeadLabel:$label,mainLeadSocket:$socket}
      | if $codexLead != null then . + {codexLead:$codexLead} else . end' \
    "$out" > "${out}.tmp" && mv "${out}.tmp" "$out"
}

qa_lead_render_stdout_json() {
  local slot="$1" mode="$2" no_lead_json="$3" mirror_channel_id="$4"
  local port="$5" agent_id="$6" project_name="$7" chat_channel_id="$8"
  local bot_token_env="$9" bridge_pid="${10}" lead_pid_file="${11}"
  local lead_carrier="${12}" lead_launchd_label="${13}" lead_socket="${14}"
  local launchd_registry="${15}" slot_dir="${16}" from_branch="${17}"
  local sandbox="${18}" host_repo="${19}" temp_branch="${20}"
  local branch_sha="${21}" runner_start_ref="${22}" db_path="${23}"
  local bridge_log="${24}" bridge_launch_spec="${25}" lead_log="${26}"
  local flywheel_projects_file="${27}" launch_manifest="${28}"
  local campaign_manifest="${29}" campaign_id="${30}" lead_label="${31}"
  local extra_leads_json="${32}" generalized_output_fields="${33}"
  cat <<EOF
{
  "slot": ${slot},
  "mode": "${mode}",
  "noLead": ${no_lead_json},
  "mirrorChannelId": "${mirror_channel_id}",
  "port": ${port},
  "agentId": "${agent_id}",
  "projectName": "${project_name}",
  "chatChannelId": "${chat_channel_id}",
  "botTokenEnv": "${bot_token_env}",
  "bridgePid": ${bridge_pid},
  "leadPidFile": "${lead_pid_file}",
  "leadCarrier": "${lead_carrier}",
  "leadLaunchdLabel": "${lead_launchd_label}",
  "leadSocket": "${lead_socket}",
  "launchdRegistry": "${launchd_registry}",
  "slotDir": "${slot_dir}",
  "bridgeUrl": "http://localhost:${port}",
  "fromBranch": "${from_branch}",
  "sandbox": "${sandbox}",
  "hostRepo": "${host_repo}",
  "tempBranch": "${temp_branch}",
  "branchSha": "${branch_sha}",
  "runnerStartPoint": "${runner_start_ref}",
  "dbPath": "${db_path}",
  "bridgeLog": "${bridge_log}",
  "bridgeLaunchSpec": "${bridge_launch_spec}",
  "leadLog": "${lead_log}",
  "flywheelProjectsFile": "${flywheel_projects_file}",
  "launchManifest": "${launch_manifest}",
  "campaignManifest": "${campaign_manifest}",
  "campaignId": "${campaign_id}",
  "leadLabel": "${lead_label}",
  "extraLeads": $(jq -c 'map({slotId, agentId, deptLabel, chatChannel, tokenEnvVar})' <<<"$extra_leads_json")${generalized_output_fields}
}
EOF
}

qa_lead_log_launchd_label() {
  printf 'Lead launchd label: %s; private socket: %s\n' "$1" "$2"
}

qa_lead_log_extra_pid() {
  printf 'Extra Lead %s background PID: %s\n' "$1" "$2"
}

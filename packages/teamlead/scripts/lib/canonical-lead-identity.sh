#!/bin/bash
# FLY-1726: one-shot registry identity projection for every Codex launcher.
# The caller supplies selectors only. Every identity coordinate and the Discord
# credential selector comes from the canonical flywheel-comm resolver.

canonical_lead_identity_error() {
  echo "[canonical-lead-identity] $1" >&2
}

canonical_lead_identity_record_failure() {
  local code="$1"
  local message="$2"
  if [ -n "${_FLYWHEEL_CANONICAL_COMM_CLI:-}" ] \
      && [ -n "${_FLYWHEEL_CANONICAL_PROJECTS_FILE:-}" ] \
      && [ -n "${_FLYWHEEL_CANONICAL_PROJECT:-}" ] \
      && [ -n "${_FLYWHEEL_CANONICAL_LEAD:-}" ]; then
    node "$_FLYWHEEL_CANONICAL_COMM_CLI" lead-identity record-failure \
      --projects-file "$_FLYWHEEL_CANONICAL_PROJECTS_FILE" \
      --project "$_FLYWHEEL_CANONICAL_PROJECT" \
      --lead "$_FLYWHEEL_CANONICAL_LEAD" \
      --code "$code" \
      --message "$message" >/dev/null 2>&1 || true
  fi
}

canonical_lead_identity_fail() {
  local code="$1"
  local message="$2"
  canonical_lead_identity_record_failure "$code" "$message"
  canonical_lead_identity_error "[$code] $message"
  return 1
}

canonical_lead_identity_assert_existing() {
  local name="$1"
  local expected="$2"
  local actual="${!name-}"
  if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
    canonical_lead_identity_fail identity_env_conflict \
      "${name}=${actual} conflicts with canonical ${expected}"
    return $?
  fi
}

canonical_lead_identity_resolve() {
  local selected_project="${1:?project selector required}"
  local selected_lead="${2:?lead selector required}"
  local projects_file="${3:-${FLYWHEEL_PROJECTS_FILE:-${HOME}/.flywheel/projects.json}}"
  local comm_cli="${FLYWHEEL_COMM_CLI:-}"
  local identity_json
  local canonical_lead canonical_project canonical_key canonical_team
  local canonical_bot_id canonical_token_env canonical_state_dir
  local canonical_backend canonical_role projects_digest identity_digest
  local canonical_summary_role canonical_summary_granularity
  local canonical_has_summary_duty summary_assignment_digest
  local token_value

  _FLYWHEEL_CANONICAL_PROJECTS_FILE="$projects_file"
  _FLYWHEEL_CANONICAL_PROJECT="$selected_project"
  _FLYWHEEL_CANONICAL_LEAD="$selected_lead"
  _FLYWHEEL_CANONICAL_COMM_CLI="$comm_cli"

  if [ "${FLYWHEEL_CANONICAL_IDENTITY_RESOLVED:-0}" = "1" ]; then
    canonical_lead_identity_fail identity_resolve_repeated \
      "canonical identity may be resolved only once per launcher"
    return $?
  fi
  if [ -z "$comm_cli" ] || [ ! -f "$comm_cli" ]; then
    canonical_lead_identity_error "[identity_resolver_missing] FLYWHEEL_COMM_CLI is not a readable file: ${comm_cli:-<unset>}"
    return 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    canonical_lead_identity_error "[identity_resolver_dependency_missing] jq is required"
    return 1
  fi

  identity_json="$(node "$comm_cli" lead-identity resolve \
    --projects-file "$projects_file" \
    --project "$selected_project" \
    --lead "$selected_lead" \
    --format json)" || return 1

  canonical_lead="$(jq -er '.leadId | select(type == "string" and length > 0)' <<<"$identity_json")" || return 1
  canonical_project="$(jq -er '.projectName | select(type == "string" and length > 0)' <<<"$identity_json")" || return 1
  canonical_key="$(jq -er '.leadKey | select(type == "string" and length > 0)' <<<"$identity_json")" || return 1
  canonical_team="$(jq -er '.agentTeamName | select(type == "string" and length > 0)' <<<"$identity_json")" || return 1
  canonical_bot_id="$(jq -er '.botUserId | select(type == "string" and length > 0)' <<<"$identity_json")" || {
    canonical_lead_identity_error "[identity_bot_user_id_missing] Codex Lead requires canonical botUserId"
    return 1
  }
  canonical_token_env="$(jq -er '.botTokenEnv | select(type == "string" and length > 0)' <<<"$identity_json")" || {
    canonical_lead_identity_error "[identity_bot_token_env_missing] Codex Lead requires canonical botTokenEnv"
    return 1
  }
  canonical_state_dir="$(jq -er '.discordStateDir | select(type == "string" and length > 0)' <<<"$identity_json")" || return 1
  canonical_backend="$(jq -er '.backend | select(type == "string" and length > 0)' <<<"$identity_json")" || return 1
  canonical_role="$(jq -er '.role | select(type == "string" and length > 0)' <<<"$identity_json")" || return 1
  canonical_summary_role="$(jq -er '.summaryRole | select(. == "producer" or . == "aggregator" or . == "recipient" or . == "exempt")' <<<"$identity_json")" || return 1
  canonical_summary_granularity="$(jq -er '.summaryGranularity | select(. == "per-lead" or . == "per-project")' <<<"$identity_json")" || return 1
  canonical_has_summary_duty="$(jq -er '.hasSummaryDuty | if . == true then "1" elif . == false then "0" else error("hasSummaryDuty must be boolean") end' <<<"$identity_json")" || return 1
  summary_assignment_digest="$(jq -er '.summaryAssignmentDigest | select(test("^[a-f0-9]{64}$"))' <<<"$identity_json")" || return 1
  projects_digest="$(jq -er '.projectsDigest | select(test("^[a-f0-9]{64}$"))' <<<"$identity_json")" || return 1
  identity_digest="$(jq -er '.identityDigest | select(test("^[a-f0-9]{64}$"))' <<<"$identity_json")" || return 1

  if [ "$canonical_lead" != "$selected_lead" ] || [ "$canonical_project" != "$selected_project" ]; then
    canonical_lead_identity_fail identity_selector_mismatch \
      "resolver returned ${canonical_project}/${canonical_lead} for ${selected_project}/${selected_lead}"
    return $?
  fi
  if [ "$canonical_key" != "${canonical_project}-${canonical_lead}" ] || [ "$canonical_team" != "$canonical_lead" ]; then
    canonical_lead_identity_fail identity_projection_invalid \
      "canonical leadKey or agentTeamName is inconsistent"
    return $?
  fi
  if [ "$canonical_backend" != "codex-app-server" ]; then
    canonical_lead_identity_fail identity_backend_mismatch \
      "${canonical_key} backend is ${canonical_backend}, not codex-app-server"
    return $?
  fi
  if [ -n "${FLYWHEEL_LEAD_BOT_USER_ID+x}" ]; then
    canonical_lead_identity_fail identity_legacy_field_forbidden \
      "FLYWHEEL_LEAD_BOT_USER_ID is no longer an identity source"
    return $?
  fi

  canonical_lead_identity_assert_existing FLYWHEEL_LEAD_ID "$canonical_lead" || return 1
  canonical_lead_identity_assert_existing LEAD_ID "$canonical_lead" || return 1
  canonical_lead_identity_assert_existing FLYWHEEL_PROJECT_NAME "$canonical_project" || return 1
  canonical_lead_identity_assert_existing PROJECT_NAME "$canonical_project" || return 1
  canonical_lead_identity_assert_existing FLYWHEEL_LEAD_KEY "$canonical_key" || return 1
  canonical_lead_identity_assert_existing FLYWHEEL_LEAD_BACKEND "$canonical_backend" || return 1
  canonical_lead_identity_assert_existing FLYWHEEL_LEAD_ROLE "$canonical_role" || return 1
  canonical_lead_identity_assert_existing FLYWHEEL_LEAD_SUMMARY_ROLE "$canonical_summary_role" || return 1
  canonical_lead_identity_assert_existing FLYWHEEL_LEAD_HAS_SUMMARY_DUTY "$canonical_has_summary_duty" || return 1
  canonical_lead_identity_assert_existing FLYWHEEL_SUMMARY_GRANULARITY "$canonical_summary_granularity" || return 1
  canonical_lead_identity_assert_existing FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST "$summary_assignment_digest" || return 1
  canonical_lead_identity_assert_existing DISCORD_STATE_DIR "$canonical_state_dir" || return 1
  canonical_lead_identity_assert_existing DISCORD_EXPECTED_BOT_USER_ID "$canonical_bot_id" || return 1
  canonical_lead_identity_assert_existing DISCORD_IDENTITY_MODE managed || return 1
  canonical_lead_identity_assert_existing FLYWHEEL_LEAD_IDENTITY_DIGEST "$identity_digest" || return 1

  token_value="${!canonical_token_env-}"
  if [ -z "$token_value" ] && [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" = "1" ]; then
    token_value="DRYRUN_PLACEHOLDER"
  fi
  if [ -z "$token_value" ]; then
    canonical_lead_identity_fail identity_bot_token_missing \
      "${canonical_token_env} is unset or empty for ${canonical_key}"
    return $?
  fi

  unset FLYWHEEL_PROJECTS FLYWHEEL_CODEX_LEAD_ID FLYWHEEL_CODEX_LEAD_PROJECT \
    FLYWHEEL_CODEX_LEAD_BOT_TOKEN_ENV
  unset "$canonical_token_env"
  export FLYWHEEL_PROJECTS_FILE="$projects_file"
  export FLYWHEEL_LEAD_ID="$canonical_lead"
  export LEAD_ID="$canonical_lead"
  export FLYWHEEL_PROJECT_NAME="$canonical_project"
  export PROJECT_NAME="$canonical_project"
  export FLYWHEEL_LEAD_KEY="$canonical_key"
  export FLYWHEEL_LEAD_ROLE="$canonical_role"
  export FLYWHEEL_LEAD_SUMMARY_ROLE="$canonical_summary_role"
  export FLYWHEEL_LEAD_HAS_SUMMARY_DUTY="$canonical_has_summary_duty"
  export FLYWHEEL_SUMMARY_GRANULARITY="$canonical_summary_granularity"
  export FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST="$summary_assignment_digest"
  export FLYWHEEL_LEAD_BACKEND="$canonical_backend"
  export DISCORD_STATE_DIR="$canonical_state_dir"
  export DISCORD_EXPECTED_BOT_USER_ID="$canonical_bot_id"
  export DISCORD_IDENTITY_MODE=managed
  export FLYWHEEL_LEAD_PROJECTS_DIGEST="$projects_digest"
  export FLYWHEEL_LEAD_IDENTITY_DIGEST="$identity_digest"
  export DISCORD_BOT_TOKEN="$token_value"
  export FLYWHEEL_CANONICAL_IDENTITY_RESOLVED=1
  unset token_value identity_json
}

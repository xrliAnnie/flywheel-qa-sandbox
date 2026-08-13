#!/usr/bin/env bash
# FLY-1726: deliver TEAMLEAD_DEFAULT_LEAD_AGENT as explicit host config.
#
# Fresh installs receive the generated CoS Lead from flywheel-setup.sh. Existing
# monorepo hosts previously relied on config.ts's implicit "product-lead"
# default; restart-services.sh calls this helper under its global lock to turn
# that historical choice into a literal, validated .env assignment before any
# build or service mutation. A custom host where that former default is absent
# must choose explicitly instead of receiving a guessed identity.

default_lead_agent_env_log() {
  if declare -F log >/dev/null 2>&1; then
    log "$*"
  else
    printf '[default-lead-agent] %s\n' "$*" >&2
  fi
}

# default_lead_agent_env_converge <env-file> <projects-file> <inline-projects-json> <dry-run>
#
# Registry precedence mirrors Bridge loadProjects(): a non-empty
# FLYWHEEL_PROJECTS payload wins; otherwise ~/.flywheel/projects.json is read.
# On success the selected value is exported in the current shell so the same
# restart invocation sees the newly materialized config.
default_lead_agent_env_converge() {
  local env_file="$1" projects_file="$2" inline_projects="${3:-}" dry_run="${4:-false}"
  local configured="" selected="" declaration_present=false declaration_count=0
  local count="" tmp=""

  command -v jq >/dev/null 2>&1 || {
    default_lead_agent_env_log "ERROR: jq is required to validate TEAMLEAD_DEFAULT_LEAD_AGENT"
    return 1
  }
  [ -f "$env_file" ] || {
    default_lead_agent_env_log "ERROR: $env_file is missing; create it and set TEAMLEAD_DEFAULT_LEAD_AGENT=<canonical agentId>"
    return 1
  }
  [ ! -L "$env_file" ] || {
    default_lead_agent_env_log "ERROR: refusing symlinked host env file: $env_file"
    return 1
  }

  declaration_count="$(grep -Ec '^[[:space:]]*(export[[:space:]]+)?TEAMLEAD_DEFAULT_LEAD_AGENT=' "$env_file" || true)"
  if [ "$declaration_count" -gt 1 ]; then
    default_lead_agent_env_log "ERROR: TEAMLEAD_DEFAULT_LEAD_AGENT is declared $declaration_count times in $env_file; keep exactly one literal assignment"
    return 1
  fi
  if [ "$declaration_count" -eq 1 ]; then
    declaration_present=true
    # Parse one literal assignment instead of trusting the already-sourced
    # process env. An ancestor tmux value can therefore never masquerade as
    # persisted host configuration, and this preflight does not execute the
    # trusted env file a second time.
    configured="$(grep -E '^[[:space:]]*(export[[:space:]]+)?TEAMLEAD_DEFAULT_LEAD_AGENT=' "$env_file" | tail -1)"
    configured="${configured#*=}"
    configured="${configured#"${configured%%[![:space:]]*}"}"
    configured="${configured%"${configured##*[![:space:]]}"}"
    if [[ ! "$configured" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
      default_lead_agent_env_log "ERROR: TEAMLEAD_DEFAULT_LEAD_AGENT must be one literal canonical agentId in $env_file"
      return 1
    fi
    selected="$configured"
  else
    # This is migration data, not a runtime default: it preserves the exact
    # pre-FLY-1726 selection once, writes it explicitly, and then disappears
    # from authority. New installs never take this branch.
    selected="product-lead"
  fi

  if [ -n "$inline_projects" ]; then
    if ! grep -Eq '^[[:space:]]*(export[[:space:]]+)?FLYWHEEL_PROJECTS=' "$env_file"; then
      default_lead_agent_env_log "ERROR: inherited FLYWHEEL_PROJECTS is not persisted in $env_file; refusing an ambient registry override"
      return 1
    fi
    count="$(jq -er --arg id "$selected" '
      if type != "array" then error("registry must be an array") else
        [.[]?.leads[]? | select(.agentId == $id)] | length
      end
    ' <<<"$inline_projects" 2>/dev/null)" || {
      default_lead_agent_env_log "ERROR: FLYWHEEL_PROJECTS is invalid; cannot validate TEAMLEAD_DEFAULT_LEAD_AGENT"
      return 1
    }
  else
    [ -r "$projects_file" ] || {
      default_lead_agent_env_log "ERROR: canonical registry is unreadable at $projects_file"
      return 1
    }
    count="$(jq -er --arg id "$selected" '
      if type != "array" then error("registry must be an array") else
        [.[]?.leads[]? | select(.agentId == $id)] | length
      end
    ' "$projects_file" 2>/dev/null)" || {
      default_lead_agent_env_log "ERROR: canonical registry is invalid at $projects_file"
      return 1
    }
  fi

  if [ "$count" != 1 ]; then
    if [ "$declaration_present" = true ]; then
      default_lead_agent_env_log "ERROR: TEAMLEAD_DEFAULT_LEAD_AGENT=$selected resolves to $count canonical Leads; set one globally unique agentId in $env_file"
    else
      default_lead_agent_env_log "ERROR: legacy default product-lead resolves to $count canonical Leads; set TEAMLEAD_DEFAULT_LEAD_AGENT=<globally unique agentId> in $env_file before restart"
    fi
    return 1
  fi

  if [ "$declaration_present" = true ]; then
    export TEAMLEAD_DEFAULT_LEAD_AGENT="$selected"
    default_lead_agent_env_log "validated explicit TEAMLEAD_DEFAULT_LEAD_AGENT=$selected"
    return 0
  fi
  if [ "$dry_run" = true ]; then
    default_lead_agent_env_log "DRY RUN: would materialize TEAMLEAD_DEFAULT_LEAD_AGENT=product-lead in $env_file"
    return 0
  fi

  tmp="$(mktemp "$(dirname "$env_file")/.default-lead-agent.XXXXXX")" || {
    default_lead_agent_env_log "ERROR: could not allocate atomic env update beside $env_file"
    return 1
  }
  if ! cp "$env_file" "$tmp" \
    || ! printf '\nTEAMLEAD_DEFAULT_LEAD_AGENT=product-lead\n' >> "$tmp" \
    || ! chmod 600 "$tmp" \
    || ! mv -f "$tmp" "$env_file"; then
    rm -f "$tmp" 2>/dev/null || true
    default_lead_agent_env_log "ERROR: could not atomically materialize TEAMLEAD_DEFAULT_LEAD_AGENT in $env_file"
    return 1
  fi
  export TEAMLEAD_DEFAULT_LEAD_AGENT=product-lead
  default_lead_agent_env_log "materialized and validated TEAMLEAD_DEFAULT_LEAD_AGENT=product-lead"
}

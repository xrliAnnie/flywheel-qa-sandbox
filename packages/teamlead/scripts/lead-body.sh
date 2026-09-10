#!/bin/bash
# FLY-1663: one-shot Claude Lead body.
# The proven Lead assembly remains in claude-lead.sh during the mixed-fleet
# migration, but this entry selects its launchd-native one-shot path. Source it
# so the long-lived wait parent remains this body pane process.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${1:?Usage: lead-body.sh <manifest-path>}"

# FLY-2455: reset every ambient ownership marker/function before installing the
# body-owned EXIT observer. The public QA opt-in is captured before .env is
# sourced and never trusted again from that mutable source.
unset -f _v2_body_exit _v2_body_finalize _v2_body_status_write 2>/dev/null || true
_V2_BODY_EXIT_TRAP_ACTIVE=0
_V2_BODY_FINALIZED=0
_V2_BODY_RESULT_RECORDED=0
_V2_BODY_EXIT_RUNNING=0
_V2_RULES_CLEANUP_READY=0
_V2_QA_DIAGNOSTICS_DIR="${FLYWHEEL_QA_LEAD_DIAGNOSTICS_DIR:-}"
_V2_QA_DIAGNOSTICS_PYTHON="${FLYWHEEL_QA_LEAD_DIAGNOSTICS_PYTHON:-}"
unset FLYWHEEL_QA_LEAD_DIAGNOSTICS_DIR FLYWHEEL_QA_LEAD_DIAGNOSTICS_PYTHON
if [ -z "$_V2_QA_DIAGNOSTICS_PYTHON" ]; then
  _V2_QA_DIAGNOSTICS_PYTHON="$(command -v python3 2>/dev/null || true)"
fi
_V2_QA_DIAGNOSTICS_HELPER="${SCRIPT_DIR}/../../../scripts/lib/qa-lead-diagnostics.py"

_v2_body_status_write() {
  [ -n "$_V2_QA_DIAGNOSTICS_DIR" ] || return 1
  [ -n "$_V2_QA_DIAGNOSTICS_PYTHON" ] || return 1
  [ -f "$_V2_QA_DIAGNOSTICS_HELPER" ] || return 1
  "$_V2_QA_DIAGNOSTICS_PYTHON" "$_V2_QA_DIAGNOSTICS_HELPER" body-status \
    --runtime "$_V2_QA_DIAGNOSTICS_DIR" \
    --carrier-pid "$_FLYWHEEL_LEAD_CARRIER_PID_CAPTURED" "$@"
}

_v2_body_finalize() {
  local primary_rc="$1" observation="$2" claude_rc="${3:-}"
  local status_rc=0
  if [ "$_V2_BODY_FINALIZED" != 1 ]; then
    _V2_BODY_FINALIZED=1
    if [ "${_V2_RULES_CLEANUP_READY:-0}" = 1 ] \
        && declare -F _rules_bundle_uncommitted_cleanup >/dev/null 2>&1; then
      _rules_bundle_uncommitted_cleanup || true
      if [ "${_RULES_BUNDLE_COMMITTED:-0}" != 1 ] \
          && [ "${RULES_BUNDLE_MODE:-bundle}" = bundle ] \
          && [ -n "${RULES_BUNDLE_PATH:-}" ] \
          && [[ -e "$RULES_BUNDLE_PATH" || -L "$RULES_BUNDLE_PATH" ]]; then
        printf '[lead-body] ERROR: bundle_cleanup_failed: uncommitted_generation_remains\n' >&2
      fi
    fi
  fi
  if [ "$_V2_BODY_RESULT_RECORDED" = 1 ]; then
    return 0
  fi
  if [ "$observation" = pre_server_stop ]; then
    _v2_body_status_write --event pre-server-stop --exit-code "$primary_rc" \
      --claude-exit-code "$claude_rc" || status_rc=$?
  else
    _v2_body_status_write --event shell-exit --exit-code "$primary_rc" \
      || status_rc=$?
  fi
  if [ "$status_rc" -eq 0 ]; then
    _V2_BODY_RESULT_RECORDED=1
  else
    printf '[lead-body] ERROR: diagnostic_capture_failed: body_status_write_failed\n' >&2
  fi
  return 0
}

_v2_body_exit() {
  local primary_rc="$1" result_was_recorded="$_V2_BODY_RESULT_RECORDED"
  trap - EXIT
  if [ "$_V2_BODY_EXIT_RUNNING" = 1 ]; then
    exit "$primary_rc"
  fi
  _V2_BODY_EXIT_RUNNING=1
  _v2_body_finalize "$primary_rc" shell_exit
  if [ "$result_was_recorded" = 1 ]; then
    _v2_body_status_write --event shell-exit --exit-code "$primary_rc" \
      || printf '[lead-body] ERROR: diagnostic_capture_failed: shell_status_write_failed\n' >&2
  fi
  exit "$primary_rc"
}
readonly -f _v2_body_status_write _v2_body_finalize _v2_body_exit

# The carrier tuple was projected by the wrapper. Diagnostics are optional: a
# missing/malformed tuple degrades capture without changing Lead startup.
_FLYWHEEL_LEAD_CARRIER_PID_CAPTURED=""
_FLYWHEEL_LEAD_CARRIER_START_CAPTURED=""
if [[ "${FLYWHEEL_LEAD_CARRIER_PID:-}" =~ ^[1-9][0-9]*$ ]] \
  && [ -n "${FLYWHEEL_LEAD_CARRIER_START:-}" ] \
  && [[ "$FLYWHEEL_LEAD_CARRIER_START" != *$'\t'* ]] \
  && [[ "$FLYWHEEL_LEAD_CARRIER_START" != *$'\n'* ]]; then
  _FLYWHEEL_LEAD_CARRIER_PID_CAPTURED="$FLYWHEEL_LEAD_CARRIER_PID"
  _FLYWHEEL_LEAD_CARRIER_START_CAPTURED="$FLYWHEEL_LEAD_CARRIER_START"
fi
unset FLYWHEEL_LEAD_CARRIER_PID FLYWHEEL_LEAD_CARRIER_START

if [ -n "$_V2_QA_DIAGNOSTICS_DIR" ]; then
  if [ -z "$_FLYWHEEL_LEAD_CARRIER_PID_CAPTURED" ] \
      || [ -z "$_V2_QA_DIAGNOSTICS_PYTHON" ] \
      || [ ! -f "$_V2_QA_DIAGNOSTICS_HELPER" ] \
      || ! "$_V2_QA_DIAGNOSTICS_PYTHON" "$_V2_QA_DIAGNOSTICS_HELPER" \
        validate-runtime --runtime "$_V2_QA_DIAGNOSTICS_DIR" --manifest "$MANIFEST" \
      || ! _v2_body_status_write --event started --body-pid "$$"; then
    printf '[lead-body] ERROR: diagnostic_capture_failed: body_trap_install_failed\n' >&2
  elif trap '_v2_body_exit "$?"' EXIT; then
    _V2_BODY_EXIT_TRAP_ACTIVE=1
  fi
fi
readonly _V2_BODY_EXIT_TRAP_ACTIVE
readonly _V2_QA_DIAGNOSTICS_DIR _V2_QA_DIAGNOSTICS_PYTHON \
  _V2_QA_DIAGNOSTICS_HELPER _FLYWHEEL_LEAD_CARRIER_PID_CAPTURED \
  _FLYWHEEL_LEAD_CARRIER_START_CAPTURED

command -v jq >/dev/null 2>&1 || { echo '[lead-body] ERROR: jq is required' >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "[lead-body] ERROR: manifest not found: $MANIFEST" >&2; exit 1; }

# The v2 wrapper becomes the foreground tmux carrier via exec, so its PID/start
# tuple is the identity restart-services verifies. Capture it before sourcing
# the host .env: operator configuration may contain stale public variables and
# must never rewrite this per-launch handoff. Malformed input degrades the
# optional body observation to unknown; it never blocks Lead startup.
# The wrapper has already resolved and projected one canonical identity tuple.
# .env is a host configuration/secret source, never an identity source. Preserve
# the tuple (and the generic per-Lead token) byte-for-byte across the source.
_V2_IDENTITY_ENV_NAMES=(
  FLYWHEEL_LEAD_ID LEAD_ID
  FLYWHEEL_PROJECT_NAME PROJECT_NAME
  FLYWHEEL_LEAD_KEY FLYWHEEL_LEAD_ROLE FLYWHEEL_LEAD_BACKEND
  FLYWHEEL_LEAD_SUMMARY_ROLE FLYWHEEL_LEAD_HAS_SUMMARY_DUTY
  FLYWHEEL_SUMMARY_GRANULARITY FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST
  FLYWHEEL_SUMMARY_CONFIG_HOME
  DISCORD_STATE_DIR DISCORD_EXPECTED_BOT_USER_ID DISCORD_IDENTITY_MODE DISCORD_BOT_TOKEN
  FLYWHEEL_LEAD_IDENTITY_DIGEST FLYWHEEL_LEAD_PROJECTS_DIGEST
  FLYWHEEL_PROJECTS_FILE
)
_V2_IDENTITY_ENV_DECLARATIONS=()
for _v2_identity_name in "${_V2_IDENTITY_ENV_NAMES[@]}"; do
  _v2_identity_declaration="$(declare -p "$_v2_identity_name" 2>/dev/null || true)"
  _V2_IDENTITY_ENV_DECLARATIONS+=("$_v2_identity_declaration")
done
unset _v2_identity_name _v2_identity_declaration

# Read launcher configuration into this body shell. Assembly helpers retain the
# exported configuration, while the Claude child still crosses claude-lead.sh's
# explicit env -i barrier.
ENV_FILE="${FLYWHEEL_WRAPPER_ENV_FILE:-${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/.env}"
if [ -f "$ENV_FILE" ]; then
  _v2_body_allexport_was_on=false
  [[ "$-" == *a* ]] && _v2_body_allexport_was_on=true
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  [ "$_v2_body_allexport_was_on" = true ] || set +a
  unset _v2_body_allexport_was_on
fi
if [ "${FLYWHEEL_PROJECTS+x}" = x ]; then
  echo "[lead-body] ERROR: identity_env_source_forbidden: FLYWHEEL_PROJECTS may not be supplied by ${ENV_FILE}; use canonical FLYWHEEL_PROJECTS_FILE" >&2
  exit 1
fi
unset FLYWHEEL_LEAD_CARRIER_PID FLYWHEEL_LEAD_CARRIER_START

for ((_v2_identity_index = 0; _v2_identity_index < ${#_V2_IDENTITY_ENV_NAMES[@]}; _v2_identity_index++)); do
  _v2_identity_name="${_V2_IDENTITY_ENV_NAMES[$_v2_identity_index]}"
  unset "$_v2_identity_name"
  _v2_identity_declaration="${_V2_IDENTITY_ENV_DECLARATIONS[$_v2_identity_index]}"
  if [ -n "$_v2_identity_declaration" ]; then
    eval "$_v2_identity_declaration"
    export "$_v2_identity_name"
  fi
done
unset _v2_identity_index _v2_identity_name _v2_identity_declaration
unset _V2_IDENTITY_ENV_NAMES _V2_IDENTITY_ENV_DECLARATIONS
unset FLYWHEEL_QA_LEAD_DIAGNOSTICS_DIR FLYWHEEL_QA_LEAD_DIAGNOSTICS_PYTHON
_V2_RULES_CLEANUP_READY=0

LEAD_ID="$(jq -er '.leadId' "$MANIFEST")"
PROJECT_DIR="$(jq -er '.projectDir' "$MANIFEST")"
PROJECT_NAME="$(jq -er '.projectName' "$MANIFEST")"
# FLY-2076: .env is a fleet-wide source, but the duty bearer is a one-seat
# capability. Scrub it immediately after the body reload for every other Lead.
if [ "$LEAD_ID" != "claude-infra-bot-lead" ]; then
  unset FLYWHEEL_ALERT_DUTY_TOKEN
fi
SUBDIR="$(jq -r '.subdir // ""' "$MANIFEST")"
WORKSPACE="$(jq -er '(.workspace // "") | select(type == "string")' "$MANIFEST")" \
  || { echo '[lead-body] ERROR: invalid workspace' >&2; exit 1; }
MCP_EXCLUDE="$(jq -er '(.mcpExclude // "") | select(type == "string")' "$MANIFEST")" \
  || { echo '[lead-body] ERROR: invalid mcpExclude' >&2; exit 1; }
[ -n "${DISCORD_BOT_TOKEN:-}" ] \
  || { echo '[lead-body] ERROR: canonical DISCORD_BOT_TOKEN is missing' >&2; exit 1; }
export FLYWHEEL_LEAD_CARRIER=v2
export FLYWHEEL_LEAD_MCP_EXCLUDE="$MCP_EXCLUDE"
if [ -n "$WORKSPACE" ]; then
  export LEAD_WORKSPACE="$WORKSPACE"
fi

ARGS=("$LEAD_ID" "$PROJECT_DIR" "$PROJECT_NAME")
[ -z "$SUBDIR" ] || ARGS+=(--subdir "$SUBDIR")

export FLYWHEEL_LEAD_BODY_V2=1
# shellcheck source=claude-lead.sh
source "$SCRIPT_DIR/claude-lead.sh" "${ARGS[@]}"

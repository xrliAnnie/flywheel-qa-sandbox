#!/bin/bash
# FLY-2076 — one-shot, source-safe startup provisioning for the single Claw
# Alerts duty seat. Every outcome emits exactly one fixed-shape status line.

_alert_duty_provision_main() {
  local lead_id="${LEAD_ID:-${FLYWHEEL_LEAD_ID:-}}"
  local project_name="${PROJECT_NAME:-${FLYWHEEL_PROJECT_NAME:-}}"
  local script_dir="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
  local seat_cli="${FLYWHEEL_ALERT_DUTY_SEAT_CLI:-${script_dir}/../dist/alert-duty-seat-cli.js}"
  local gate_script="${FLYWHEEL_ALERT_DUTY_GATE_SCRIPT:-${script_dir}/apply-alert-duty-gate.sh}"
  local state_dir="${DISCORD_STATE_DIR:-}"

  _alert_duty_status() {
    echo "[alert-duty] seat=$1 lead=${lead_id:--} channel=$2 gate=$3 dispatcher=$4 token=$5"
  }

  if [ -z "$lead_id" ] || [ -z "$project_name" ]; then
    unset FLYWHEEL_ALERT_DUTY_TOKEN
    echo "[alert-duty] ERROR: LEAD_ID and PROJECT_NAME are required" >&2
    _alert_duty_status false - skipped:identity_missing - unset
    return 0
  fi
  if [ ! -f "$seat_cli" ]; then
    unset FLYWHEEL_ALERT_DUTY_TOKEN
    echo "[alert-duty] CLI missing: $seat_cli" >&2
    _alert_duty_status false - skipped:cli_missing - unset
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    unset FLYWHEEL_ALERT_DUTY_TOKEN
    echo "[alert-duty] jq missing; duty provisioning skipped" >&2
    _alert_duty_status false - skipped:jq_missing - unset
    return 0
  fi

  local cli_output="" cli_rc=0
  local cli_args=(--lead-id "$lead_id" --project "$project_name")
  if [ -n "${FLYWHEEL_PROJECTS_FILE:-}" ]; then
    cli_args+=(--projects-file "$FLYWHEEL_PROJECTS_FILE")
  fi
  if [ -n "${FLYWHEEL_BRIDGE_URL:-}" ]; then
    cli_args+=(--bridge-url "$FLYWHEEL_BRIDGE_URL")
  fi
  cli_output="$(node "$seat_cli" "${cli_args[@]}")" || cli_rc=$?
  if [ "$cli_rc" -ne 0 ] || ! printf '%s' "$cli_output" | jq -e . >/dev/null 2>&1; then
    unset FLYWHEEL_ALERT_DUTY_TOKEN
    echo "[alert-duty] seat CLI failed (exit ${cli_rc})" >&2
    _alert_duty_status false - skipped:cli_failed - unset
    return 0
  fi

  local is_seat channel dispatcher dispatcher_status token_status
  is_seat="$(printf '%s' "$cli_output" | jq -r '.isDutySeat == true')"
  channel="$(printf '%s' "$cli_output" | jq -r '.alertChannelId // empty')"
  dispatcher="$(printf '%s' "$cli_output" | jq -r '.dispatcherBotUserId // empty')"
  if [ "$is_seat" != true ]; then
    unset FLYWHEEL_ALERT_DUTY_TOKEN
    _alert_duty_status false - - - unset
    return 0
  fi

  token_status="unset"
  [ -n "${FLYWHEEL_ALERT_DUTY_TOKEN:-}" ] && token_status="set"
  dispatcher_status="$dispatcher"
  [ -n "$dispatcher_status" ] || dispatcher_status=unresolved:bridge_unreachable
  if [ -z "$channel" ]; then
    _alert_duty_status true - skipped:no_alert_channel "$dispatcher_status" "$token_status"
    return 0
  fi
  if [ "$token_status" != set ]; then
    _alert_duty_status true "$channel" skipped:no_duty_token "$dispatcher_status" unset
    return 0
  fi
  if [ ! -x "$gate_script" ]; then
    echo "[alert-duty] gate helper missing or not executable: $gate_script" >&2
    _alert_duty_status true "$channel" skipped:gate_missing "$dispatcher_status" set
    return 0
  fi

  local gate_output="" gate_rc=0 gate_status=""
  local gate_args=(
    --access-file "${state_dir}/access.json"
    --channel-id "$channel"
    --lead-id "$lead_id"
  )
  if [ -n "$dispatcher" ]; then
    gate_args+=(--allow-bot "$dispatcher")
  fi
  gate_output="$("$gate_script" "${gate_args[@]}")" || gate_rc=$?
  if [ "$gate_rc" -ne 0 ]; then
    echo "[alert-duty] gate apply failed (exit ${gate_rc})" >&2
    _alert_duty_status true "$channel" skipped:apply_failed "$dispatcher_status" set
    return 0
  fi
  gate_status="$(printf '%s\n' "$gate_output" | sed -n 's/.*(\([^()]*\))[[:space:]]*$/\1/p' | tail -1)"
  [ -n "$gate_status" ] || gate_status=skipped:invalid_gate_output
  _alert_duty_status true "$channel" "$gate_status" "$dispatcher_status" set
  return 0
}

_alert_duty_provision_main
_alert_duty_rc=$?
unset -f _alert_duty_provision_main _alert_duty_status 2>/dev/null || true
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  exit "$_alert_duty_rc"
fi
return "$_alert_duty_rc"

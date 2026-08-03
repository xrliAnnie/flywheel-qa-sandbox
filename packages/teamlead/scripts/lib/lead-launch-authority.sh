#!/bin/bash
# FLY-1602: source-only launchd ownership gate for claude-lead.sh.
# Depends on scripts/lib/lead-restart-lifecycle.sh and performs no mutations.

LEAD_LAUNCH_MANAGED=false
LEAD_LAUNCH_AUTHORITY_REASON=""
LEAD_LAUNCH_AUTHORITY_TARGET=""
LEAD_LAUNCH_AUTHORITY_SELF_PID=""
LEAD_LAUNCH_AUTHORITY_SELF_START=""
LEAD_LAUNCH_AUTHORITY_MANIFEST=""
LEAD_LAUNCH_AUTHORITY_PLIST=""
LEAD_LAUNCH_AUTHORITY_PROJECTS=""
LEAD_LAUNCH_AUTHORITY_LABEL=""

_lead_launch_authority_process_check() {
  local probe pid actual_start
  probe="$(lead_restart_launchd_probe "$LEAD_LAUNCH_AUTHORITY_TARGET")" || {
    LEAD_LAUNCH_AUTHORITY_REASON="launchd_probe_error"
    return 2
  }
  case "$probe" in
    error)
      LEAD_LAUNCH_AUTHORITY_REASON="launchd_probe_error"
      return 2
      ;;
    unloaded)
      LEAD_LAUNCH_AUTHORITY_REASON="launchd_unloaded"
      return 2
      ;;
    loaded$'\t'*)
      pid="${probe#*$'\t'}"
      ;;
    *)
      LEAD_LAUNCH_AUTHORITY_REASON="launchd_probe_error"
      return 2
      ;;
  esac
  case "$pid" in
    ''|0|*[!0-9]*)
      LEAD_LAUNCH_AUTHORITY_REASON="launchd_pid_missing"
      return 2
      ;;
  esac
  if [ "$pid" != "$LEAD_LAUNCH_AUTHORITY_SELF_PID" ]; then
    LEAD_LAUNCH_AUTHORITY_REASON="launchd_foreign_pid"
    return 2
  fi
  if ! lead_restart_process_alive "$pid"; then
    LEAD_LAUNCH_AUTHORITY_REASON="supervisor_not_alive"
    return 2
  fi
  actual_start="$(lead_restart_process_start_identity "$pid")" || {
    LEAD_LAUNCH_AUTHORITY_REASON="supervisor_start_sensor_degraded"
    return 2
  }
  if [ -z "$actual_start" ] || [ "$actual_start" != "$LEAD_LAUNCH_AUTHORITY_SELF_START" ]; then
    LEAD_LAUNCH_AUTHORITY_REASON="supervisor_start_sensor_degraded"
    return 2
  fi
  LEAD_LAUNCH_AUTHORITY_REASON=""
  return 0
}

lead_launch_authority_prepare() {
  local manifest="$1" plist="$2" projects_file="$3" label="$4"
  local target="$5" self_pid="$6" self_start="$7"
  LEAD_LAUNCH_MANAGED=false
  LEAD_LAUNCH_AUTHORITY_REASON=""
  LEAD_LAUNCH_AUTHORITY_TARGET="$target"
  LEAD_LAUNCH_AUTHORITY_SELF_PID="$self_pid"
  LEAD_LAUNCH_AUTHORITY_SELF_START="$self_start"
  LEAD_LAUNCH_AUTHORITY_MANIFEST="$manifest"
  LEAD_LAUNCH_AUTHORITY_PLIST="$plist"
  LEAD_LAUNCH_AUTHORITY_PROJECTS="$projects_file"
  LEAD_LAUNCH_AUTHORITY_LABEL="$label"

  if [ ! -f "$plist" ] && [ ! -L "$plist" ]; then
    return 0
  fi
  LEAD_LAUNCH_MANAGED=true
  if ! lead_restart_validate_authority "$manifest" "$plist" "$projects_file" "$label"; then
    LEAD_LAUNCH_AUTHORITY_REASON="disk_authority_unproven"
    return 2
  fi
  _lead_launch_authority_process_check
}

# A supervisor may legitimately update non-authority manifest evidence after a
# child launch. Refresh revalidates the complete disk authority at the next loop
# without ever downgrading a process that started managed into unmanaged mode.
lead_launch_authority_refresh() {
  [ "$LEAD_LAUNCH_MANAGED" = true ] || return 0
  if ! lead_restart_validate_authority \
    "$LEAD_LAUNCH_AUTHORITY_MANIFEST" "$LEAD_LAUNCH_AUTHORITY_PLIST" \
    "$LEAD_LAUNCH_AUTHORITY_PROJECTS" "$LEAD_LAUNCH_AUTHORITY_LABEL"; then
    LEAD_LAUNCH_AUTHORITY_REASON="disk_authority_unproven"
    return 2
  fi
  _lead_launch_authority_process_check
}

lead_launch_authority_recheck() {
  [ "$LEAD_LAUNCH_MANAGED" = true ] || return 0
  if ! lead_restart_authority_unchanged; then
    LEAD_LAUNCH_AUTHORITY_REASON="disk_authority_changed"
    return 2
  fi
  _lead_launch_authority_process_check
}

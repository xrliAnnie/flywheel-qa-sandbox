#!/bin/bash
# FLY-2446: managed restart seam for the optional standalone voice unit.

VOICE_RESTART_STATE="${VOICE_RESTART_STATE:-not_attempted}"
VOICE_RESTART_DETAIL="${VOICE_RESTART_DETAIL:-}"

voice_restart_log() {
  if declare -F log >/dev/null 2>&1; then log "$*"; else printf '[voice-restart] %s\n' "$*"; fi
}

restart_voice_managed() {
  VOICE_RESTART_STATE="not_attempted"
  VOICE_RESTART_DETAIL=""
  if ! supervisor_is_loaded voice service >/dev/null 2>&1; then
    VOICE_RESTART_STATE="not_loaded"
    VOICE_RESTART_DETAIL="supervisor not loaded"
    voice_restart_log "voice unit not loaded; managed restart is a no-op"
    return 0
  fi
  if ! declare -F voice_on_demand_contract_check >/dev/null 2>&1; then
    # shellcheck source=voice-on-demand.sh
    source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/voice-on-demand.sh"
  fi
  if ! voice_on_demand_contract_check \
    "${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}" "${HOME}" "gui/$(id -u)"; then
    VOICE_RESTART_STATE="failed"
    VOICE_RESTART_DETAIL="on_demand_contract_mismatch"
    voice_restart_log "ERROR: loaded voice unit does not match the on-demand contract; refusing an unsafe restart"
    return 1
  fi
  VOICE_RESTART_STATE="registered"
  VOICE_RESTART_DETAIL="on-demand registration already current; no process restart"
  voice_restart_log "voice on-demand registration already current; leaving the idle job dormant"
}

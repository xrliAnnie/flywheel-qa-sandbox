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
  if ! supervisor_assert_keepalive voice on-failure; then
    VOICE_RESTART_STATE="failed"
    VOICE_RESTART_DETAIL="keepalive_contract_missing"
    voice_restart_log "ERROR: loaded voice unit has no KeepAlive contract"
    return 1
  fi
  if ! supervisor_restart voice service >/dev/null 2>&1; then
    VOICE_RESTART_STATE="failed"
    VOICE_RESTART_DETAIL="supervisor_restart_failed"
    voice_restart_log "ERROR: voice supervisor restart failed"
    return 1
  fi
  if ! supervisor_assert_keepalive voice on-failure; then
    VOICE_RESTART_STATE="failed"
    VOICE_RESTART_DETAIL="keepalive_contract_lost"
    voice_restart_log "ERROR: voice unit lost its KeepAlive contract after restart"
    return 1
  fi
  VOICE_RESTART_STATE="restarted"
  VOICE_RESTART_DETAIL="supervisor restart accepted"
  voice_restart_log "voice supervisor restart accepted"
}

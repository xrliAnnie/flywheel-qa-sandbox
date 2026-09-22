#!/bin/bash
# FLY-2446: managed restart seam for the optional standalone voice unit.

VOICE_RESTART_STATE="${VOICE_RESTART_STATE:-not_attempted}"
VOICE_RESTART_DETAIL="${VOICE_RESTART_DETAIL:-}"

voice_restart_log() {
  if declare -F log >/dev/null 2>&1; then log "$*"; else printf '[voice-restart] %s\n' "$*"; fi
}

# FLY-2701: is the installed plist exactly the pre-on-demand resident contract?
# Only those known bytes are safe to replace automatically; anything else is
# drift of unknown origin and keeps the old fail-closed refusal.
voice_installed_is_legacy_resident() {
  python3 - "$1" <<'PY' 2>/dev/null
import plistlib, sys
try:
    p = plistlib.load(open(sys.argv[1], "rb"))
except Exception:
    sys.exit(1)
keep_alive = p.get("KeepAlive")
sys.exit(
    0
    if (
        p.get("Label") == "com.flywheel.voice"
        and p.get("RunAtLoad") is True
        and keep_alive not in (None, False)
        and p.get("ThrottleInterval") == 30
    )
    else 1
)
PY
}

# 0 = proven quiet, 1 = a call is in progress, 2 = cannot tell.
# Read-only: the deploy never writes to the Bridge's database.
voice_active_session_probe() {
  local db="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/teamlead.db"
  python3 - "$db" <<'PY' 2>/dev/null
import os, sqlite3, sys
path = sys.argv[1]
if not os.path.isfile(path):
    sys.exit(2)
try:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    row = con.execute(
        "SELECT 1 FROM voice_sessions"
        " WHERE state NOT IN ('ended','cancelled','failed') LIMIT 1"
    ).fetchone()
    con.close()
except Exception:
    sys.exit(2)
sys.exit(1 if row else 0)
PY
}

# Replace the resident unit with the on-demand one under the deploy's restart
# lock. bootout stops the running resident daemon — which is the point: the old
# binary has no idle exit, so leaving it running means on-demand never starts.
voice_migrate_to_on_demand() {
  local source_plist="$1" installed="$2" domain="$3"
  launchctl bootout "${domain}/com.flywheel.voice" >/dev/null 2>&1 || true
  cp "$source_plist" "$installed" || return 1
  chmod 0644 "$installed" || return 1
  launchctl bootstrap "$domain" "$installed" >/dev/null 2>&1 || return 1
  voice_on_demand_contract_check \
    "${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}" "${HOME}" "$domain"
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
  local repo="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
  local domain="gui/$(id -u)"
  if voice_on_demand_contract_check "$repo" "${HOME}" "$domain"; then
    VOICE_RESTART_STATE="registered"
    VOICE_RESTART_DETAIL="on-demand registration already current; no process restart"
    voice_restart_log "voice on-demand registration already current; leaving the idle job dormant"
    return 0
  fi

  local source_plist="${repo}/scripts/launchd/com.flywheel.voice.plist"
  local installed="${HOME}/Library/LaunchAgents/com.flywheel.voice.plist"
  if [[ -f "$source_plist" && -f "$installed" ]] &&
    voice_installed_is_legacy_resident "$installed"; then
    local probe=0
    voice_active_session_probe || probe=$?
    if [[ "$probe" -ne 0 ]]; then
      # Never cut a call for a migration, and never treat "cannot tell" as
      # quiet. Deferring keeps the deploy green and retries next time.
      VOICE_RESTART_STATE="deferred"
      VOICE_RESTART_DETAIL=$([[ "$probe" -eq 1 ]] &&
        echo "active_call_defers_on_demand_migration" ||
        echo "voice_session_state_unknown_defers_migration")
      voice_restart_log "deferring the voice on-demand migration (${VOICE_RESTART_DETAIL})"
      return 0
    fi
    if voice_migrate_to_on_demand "$source_plist" "$installed" "$domain"; then
      VOICE_RESTART_STATE="migrated"
      VOICE_RESTART_DETAIL="legacy resident unit replaced by the on-demand contract"
      voice_restart_log "migrated the voice unit from the resident contract to on-demand"
      return 0
    fi
    VOICE_RESTART_STATE="failed"
    VOICE_RESTART_DETAIL="on_demand_migration_failed"
    voice_restart_log "ERROR: voice on-demand migration did not converge"
    return 1
  fi

  VOICE_RESTART_STATE="failed"
  VOICE_RESTART_DETAIL="on_demand_contract_mismatch"
  voice_restart_log "ERROR: loaded voice unit does not match the on-demand contract; refusing an unsafe restart"
  return 1
}

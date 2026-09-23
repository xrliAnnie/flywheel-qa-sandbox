#!/bin/bash
# FLY-2446: managed restart seam for the optional standalone voice unit.

VOICE_RESTART_STATE="${VOICE_RESTART_STATE:-not_attempted}"
VOICE_RESTART_DETAIL="${VOICE_RESTART_DETAIL:-}"

voice_restart_log() {
  if declare -F log >/dev/null 2>&1; then log "$*"; else printf '[voice-restart] %s\n' "$*"; fi
}

# FLY-2701: is the installed plist the pre-on-demand resident contract we
# shipped? Exactly one resident shape ever existed (4eeaeda51..74be58453), so
# "known" means the whole normalized dict matches it key for key — including the
# wrapper it runs. FLY-2701 review R1: a four-field predicate accepted anything
# merely *shaped* like the resident unit, so a job running somebody else's
# program, or carrying extra keys such as injected environment variables, was
# booted out and overwritten as if it were ours. That is the unknown drift this
# seam exists to refuse. The file must also be a real, self-owned file, never a
# symlink pointing somewhere we do not control.
voice_installed_is_legacy_resident() {
  local installed="$1" wrapper="$2"
  [[ -f "$installed" && ! -L "$installed" ]] || return 1
  python3 - "$installed" "$wrapper" <<'PY' 2>/dev/null
import os, plistlib, stat, sys
installed, wrapper = sys.argv[1:]
try:
    info = os.lstat(installed)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        sys.exit(1)
    p = plistlib.load(open(installed, "rb"))
except Exception:
    sys.exit(1)
# The one resident contract this repository ever shipped, in full.
expected = {
    "Label": "com.flywheel.voice",
    "ProgramArguments": ["/bin/bash", wrapper],
    "KeepAlive": {"SuccessfulExit": False},
    "ThrottleInterval": 30,
    "RunAtLoad": True,
    "StandardOutPath": "/tmp/flywheel-voice.log",
    "StandardErrorPath": "/tmp/flywheel-voice.log",
}
sys.exit(0 if p == expected else 1)
PY
}

# The bytes on disk are only half of it: launchd may be running something else
# entirely under this label. Never bootout a job we have not identified.
voice_loaded_is_our_unit() {
  local installed="$1" wrapper="$2" domain="$3" loaded
  loaded="$(launchctl print "${domain}/com.flywheel.voice" 2>/dev/null)" || return 1
  printf '%s\n' "$loaded" | voice_on_demand_loaded_identity "$installed" "$wrapper"
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
  local wrapper="${repo}/scripts/flywheel-voice-wrapper.sh"
  if [[ -f "$source_plist" && -f "$installed" ]] &&
    voice_installed_is_legacy_resident "$installed" "$wrapper" &&
    voice_loaded_is_our_unit "$installed" "$wrapper" "$domain"; then
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
  # Plan section 11: a rollback to pre-on-demand code lands here on purpose —
  # this never silently restores a RunAtLoad resident unit. Name the manual
  # remedy so an operator is not left guessing why voice is unavailable.
  voice_restart_log "remedy: reinstall the voice unit for the deployed checkout (scripts/install-voice-launchd.sh) inside an authorized deploy window"
  return 1
}

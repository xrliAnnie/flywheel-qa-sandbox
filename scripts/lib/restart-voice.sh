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

# Reuse the launchd timing knobs already validated by the generic supervisor
# path. Focused tests source this file directly, so retain a small standalone
# fallback instead of making the restart seam depend on a private helper.
voice_launchd_tuning() {
  local name="$1" default="$2" pattern="$3" value
  if declare -F _sup_tuning >/dev/null 2>&1; then
    _sup_tuning "$name" "$default" "$pattern"
    return
  fi
  value="${!name:-}"
  if [[ -n "$value" && "$value" =~ $pattern ]]; then
    printf '%s\n' "$value"
  else
    if [[ -n "$value" ]]; then
      voice_restart_log "WARNING: invalid ${name}='${value}'; using default ${default}" >&2
    fi
    printf '%s\n' "$default"
  fi
}

# A non-zero launchctl print is not enough to prove absence: permission/domain
# errors must not authorize a bootstrap over an identity we could not inspect.
voice_launchd_label_absent() {
  local target="$1" stderr rc=0
  stderr="$(launchctl print "$target" 2>&1 >/dev/null)" || rc=$?
  [[ "$rc" -ne 0 ]] || return 1
  printf '%s\n' "$stderr" | grep -qiE 'could not find service|no such process'
}

voice_wait_until_launchd_label_absent() {
  local target="$1" attempts interval attempt
  attempts="$(voice_launchd_tuning FLYWHEEL_SUPERVISOR_BOOTOUT_WAIT_ATTEMPTS 40 '^[1-9][0-9]*$')"
  interval="$(voice_launchd_tuning FLYWHEEL_SUPERVISOR_LAUNCHD_POLL_INTERVAL 1 '^[0-9]+$')"
  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    if voice_launchd_label_absent "$target"; then return 0; fi
    [[ "$attempt" -ge "$attempts" ]] || sleep "$interval"
  done
  VOICE_RESTART_DETAIL="launchctl print did not confirm ${target} absent after ${attempts} attempts"
  voice_restart_log "ERROR: ${VOICE_RESTART_DETAIL}"
  return 1
}

# bootstrap may return before the new registration is visible to print. Poll
# the complete contract with the same bounded budget instead of rolling back on
# one transient post-bootstrap miss.
voice_wait_until_on_demand_contract() {
  local repo="$1" home_dir="$2" domain="$3"
  local attempts=5 interval attempt
  interval="$(voice_launchd_tuning FLYWHEEL_SUPERVISOR_LAUNCHD_POLL_INTERVAL 1 '^[0-9]+$')"
  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    if voice_on_demand_contract_check "$repo" "$home_dir" "$domain"; then return 0; fi
    [[ "$attempt" -ge "$attempts" ]] || sleep "$interval"
  done
  VOICE_RESTART_DETAIL="on_demand_contract_check_failed_after_bootstrap (${attempts} attempts)"
  voice_restart_log "ERROR: ${VOICE_RESTART_DETAIL}"
  return 1
}

voice_bootstrap_on_demand() {
  local domain="$1" installed="$2" repo="$3" home_dir="$4"
  local attempts interval attempt stderr rc
  attempts="$(voice_launchd_tuning FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS 5 '^[1-9][0-9]*$')"
  interval="$(voice_launchd_tuning FLYWHEEL_SUPERVISOR_LAUNCHD_POLL_INTERVAL 1 '^[0-9]+$')"
  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    # A previous bootstrap can report an error after launchd has accepted the
    # registration. Re-probe before issuing another bootstrap for the label.
    if voice_on_demand_contract_check "$repo" "$home_dir" "$domain"; then
      return 0
    fi
    rc=0
    stderr="$(launchctl bootstrap "$domain" "$installed" 2>&1 >/dev/null)" || rc=$?
    if [[ "$rc" -eq 0 ]]; then
      if voice_wait_until_on_demand_contract "$repo" "$home_dir" "$domain"; then
        return 0
      fi
      return 1
    fi
    [[ -n "$stderr" ]] || stderr="<empty stderr>"
    VOICE_RESTART_DETAIL="launchctl bootstrap attempt ${attempt}/${attempts} failed rc=${rc}: ${stderr}"
    if voice_on_demand_contract_check "$repo" "$home_dir" "$domain"; then
      voice_restart_log "WARNING: ${VOICE_RESTART_DETAIL}; registration is present despite the error"
      return 0
    fi
    if [[ "$attempt" -ge "$attempts" ]]; then
      voice_restart_log "ERROR: ${VOICE_RESTART_DETAIL}"
      return 1
    fi
    voice_restart_log "WARNING: ${VOICE_RESTART_DETAIL}"
    sleep "$((attempt * interval))"
  done
  return 1
}

# Replace the resident unit with the on-demand one under the deploy's restart
# lock. bootout stops the running resident daemon — which is the point: the old
# binary has no idle exit, so leaving it running means on-demand never starts.
voice_migrate_to_on_demand() {
  local source_plist="$1" installed="$2" domain="$3"
  local repo="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
  launchctl bootout "${domain}/com.flywheel.voice" >/dev/null 2>&1 || true
  voice_wait_until_launchd_label_absent "${domain}/com.flywheel.voice" || return 1
  cp "$source_plist" "$installed" || {
    VOICE_RESTART_DETAIL="copy_on_demand_plist_failed"
    return 1
  }
  chmod 0644 "$installed" || {
    VOICE_RESTART_DETAIL="chmod_on_demand_plist_failed"
    return 1
  }
  voice_bootstrap_on_demand "$domain" "$installed" "$repo" "$HOME"
}

restart_voice_managed() {
  VOICE_RESTART_STATE="not_attempted"
  VOICE_RESTART_DETAIL=""
  if ! declare -F voice_on_demand_contract_check >/dev/null 2>&1 \
    || ! declare -F voice_on_demand_disk_contract_check >/dev/null 2>&1; then
    # shellcheck source=voice-on-demand.sh
    source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/voice-on-demand.sh"
  fi
  local repo="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
  local domain="gui/$(id -u)"
  local source_plist="${repo}/scripts/launchd/com.flywheel.voice.plist"
  local installed="${HOME}/Library/LaunchAgents/com.flywheel.voice.plist"
  local wrapper="${repo}/scripts/flywheel-voice-wrapper.sh"
  local supervisor_loaded=false
  if supervisor_is_loaded voice service >/dev/null 2>&1; then
    supervisor_loaded=true
  fi

  if [[ "$supervisor_loaded" != true ]]; then
    if voice_on_demand_disk_contract_check "$repo" "$HOME" \
      && voice_launchd_label_absent "${domain}/com.flywheel.voice"; then
      if ! declare -F nonlead_daemon_disabled_labels >/dev/null 2>&1; then
        # shellcheck source=converge-nonlead-daemons.sh
        source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/converge-nonlead-daemons.sh"
      fi
      local disabled_labels=""
      if ! disabled_labels="$(nonlead_daemon_disabled_labels "$domain")"; then
        VOICE_RESTART_STATE="not_loaded"
        VOICE_RESTART_DETAIL="disabled overrides unreadable; registration recovery skipped"
        voice_restart_log "WARNING: ${VOICE_RESTART_DETAIL}"
        return 0
      fi
      if printf '%s\n' "$disabled_labels" | grep -Fxq 'com.flywheel.voice'; then
        VOICE_RESTART_STATE="not_loaded"
        VOICE_RESTART_DETAIL="voice is explicitly disabled; registration recovery skipped"
        voice_restart_log "voice unit is explicitly disabled; managed restart is a no-op"
        return 0
      fi
      if voice_bootstrap_on_demand "$domain" "$installed" "$repo" "$HOME"; then
        VOICE_RESTART_STATE="registered"
        VOICE_RESTART_DETAIL="on-demand plist was installed but unregistered; registration restored"
        voice_restart_log "restored the missing voice on-demand registration"
        return 0
      fi
      VOICE_RESTART_STATE="failed"
      voice_restart_log "ERROR: voice on-demand registration recovery failed (${VOICE_RESTART_DETAIL})"
      return 1
    fi
    VOICE_RESTART_STATE="not_loaded"
    VOICE_RESTART_DETAIL="supervisor not loaded"
    voice_restart_log "voice unit not loaded; managed restart is a no-op"
    return 0
  fi

  if voice_on_demand_contract_check "$repo" "${HOME}" "$domain"; then
    VOICE_RESTART_STATE="registered"
    VOICE_RESTART_DETAIL="on-demand registration already current; no process restart"
    voice_restart_log "voice on-demand registration already current; leaving the idle job dormant"
    return 0
  fi

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
    [[ -n "$VOICE_RESTART_DETAIL" ]] || VOICE_RESTART_DETAIL="on_demand_migration_failed"
    voice_restart_log "ERROR: voice on-demand migration did not converge (${VOICE_RESTART_DETAIL})"
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

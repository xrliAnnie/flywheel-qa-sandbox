#!/bin/bash
# FLY-650: supervisor.sh — platform-abstraction service supervisor (D1=A).
#
# launchd (macOS) is the only load-bearing macOS coupling in the fleet runtime:
# it keeps the Bridge + Leads + auxiliary jobs resident. This lib abstracts
# "manage a long-running/scheduled/triggered service" behind one interface so the
# SAME provisioner runs on Linux (systemd --user) and macOS (launchd), with a
# documented seam for a future container backend (FLY-652).
#
# Service-spec (a managed unit is declared as JSON; plan §3.2). Kinds:
#   service  — long-running daemon         (launchd KeepAlive  / systemd .service)
#   timer    — scheduled job               (launchd StartCalendarInterval / .timer)
#   path     — dir/queue-triggered job     (launchd QueueDirectories / systemd .path)
#   + darwinOnly:true → installed on macOS only (e.g. cmux-watcher), skipped on Linux.
# A spec MAY combine triggers (e.g. updater = path + timer fallback) by carrying
# both `watch` and `schedule`.
#
# Backend selection: FLYWHEEL_SUPERVISOR_BACKEND (from host-config) wins; else
# uname-derived (Darwin→launchd, Linux→systemd-user).
#
# DARWIN keeps the existing committed launchd plists + flywheel-daemon.sh
# machinery (byte-compat); this lib's darwin path only provides the uniform
# lifecycle verbs over launchctl. LINUX is the new code: it renders systemd user
# units from the spec. CONTAINER is a fail-loud stub (FLY-652).
[ -n "${SUPERVISOR_SOURCED:-}" ] && return 0
SUPERVISOR_SOURCED=1

_sup_err() { echo "[supervisor] ERROR: $*" >&2; }
_sup_log() { echo "[supervisor] $*"; }

# supervisor_backend — resolve the active backend.
supervisor_backend() {
  if [ -n "${FLYWHEEL_SUPERVISOR_BACKEND:-}" ]; then
    printf '%s' "$FLYWHEEL_SUPERVISOR_BACKEND"; return 0
  fi
  case "$(uname -s 2>/dev/null)" in
    Darwin) printf 'launchd' ;;
    Linux)  printf 'systemd-user' ;;
    *)      printf '' ;;
  esac
}

_sup_systemd_dir() { printf '%s' "${FLYWHEEL_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"; }

# _sup_spec_get <spec-json> <jq-filter> — read a field, empty if null/absent.
_sup_spec_get() { jq -r "$2 // empty" <<<"$1" 2>/dev/null; }

# _sup_oncalendar <spec-json> — emit one "OnCalendar=*-*-* HH:MM:00" line per
# schedule entry (launchd StartCalendarInterval analog).
_sup_oncalendar() {
  jq -r '.schedule[]? | "OnCalendar=*-*-* \(.hour // 0 | tostring | (if (.|length)<2 then "0"+. else . end)):\(.minute // 0 | tostring | (if (.|length)<2 then "0"+. else . end)):00"' <<<"$1" 2>/dev/null
}

# ── LINUX: render systemd --user units from a spec ──────────────────────────
_sup_linux_install() {
  local spec="$1"
  local name kind exec_cmd
  name="$(_sup_spec_get "$spec" '.name')"
  kind="$(_sup_spec_get "$spec" '.kind')"
  exec_cmd="$(_sup_spec_get "$spec" '.exec')"
  [ -n "$name" ] || { _sup_err "spec missing name"; return 1; }
  [ -n "$exec_cmd" ] || { _sup_err "spec '$name' missing exec"; return 1; }

  # darwinOnly units are not installed on Linux.
  if [ "$(_sup_spec_get "$spec" '.darwinOnly')" = "true" ]; then
    _sup_log "skip darwinOnly unit on linux: $name"
    return 0
  fi

  local dir; dir="$(_sup_systemd_dir)"; mkdir -p "$dir" || return 1
  local keepalive stdout
  keepalive="$(_sup_spec_get "$spec" '.keepAlive')"
  stdout="$(_sup_spec_get "$spec" '.stdout')"

  # Always render a .service. service-kind = long-running; timer/path = oneshot.
  local svc="$dir/$name.service"
  {
    echo "[Unit]"
    echo "Description=Flywheel $name"
    echo ""
    echo "[Service]"
    if [ "$kind" = "service" ]; then
      echo "ExecStart=$exec_cmd"
      [ "$keepalive" = "true" ] && echo "Restart=always"
    else
      echo "Type=oneshot"
      echo "ExecStart=$exec_cmd"
    fi
    [ -n "$stdout" ] && { echo "StandardOutput=append:$stdout"; echo "StandardError=append:$stdout"; }
    echo ""
    echo "[Install]"
    echo "WantedBy=default.target"
  } > "$svc"

  local enable_unit="$name.service"
  case "$kind" in
    timer)
      local tmr="$dir/$name.timer"
      {
        echo "[Unit]"
        echo "Description=Flywheel $name timer"
        echo ""
        echo "[Timer]"
        _sup_oncalendar "$spec"
        echo "Persistent=true"
        echo ""
        echo "[Install]"
        echo "WantedBy=timers.target"
      } > "$tmr"
      enable_unit="$name.timer"
      ;;
    path)
      local pth="$dir/$name.path"
      {
        echo "[Unit]"
        echo "Description=Flywheel $name path trigger"
        echo ""
        echo "[Path]"
        local w
        while IFS= read -r w; do
          [ -n "$w" ] && echo "DirectoryNotEmpty=$w"
        done < <(jq -r '.watch[]? // empty' <<<"$spec" 2>/dev/null)
        echo ""
        echo "[Install]"
        echo "WantedBy=default.target"
      } > "$pth"
      enable_unit="$name.path"
      # path-kind may ALSO carry a timer fallback (e.g. updater).
      if [ "$(jq -r '(.schedule | length) // 0' <<<"$spec" 2>/dev/null)" -gt 0 ] 2>/dev/null; then
        local tmr="$dir/$name.timer"
        {
          echo "[Unit]"; echo "Description=Flywheel $name timer fallback"; echo ""
          echo "[Timer]"; _sup_oncalendar "$spec"; echo "Persistent=true"; echo ""
          echo "[Install]"; echo "WantedBy=timers.target"
        } > "$tmr"
      fi
      ;;
  esac

  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user enable --now "$enable_unit" || { _sup_err "enable failed: $enable_unit"; return 1; }
  [ -f "$dir/$name.timer" ] && [ "$kind" = "path" ] && systemctl --user enable --now "$name.timer" >/dev/null 2>&1 || true
  return 0
}

# _sup_linux_unit_suffix <kind> — which unit the lifecycle verb targets.
_sup_linux_suffix() { case "$1" in timer) echo timer ;; path) echo path ;; *) echo service ;; esac; }

# ── DARWIN: lifecycle over launchctl (committed plists stay the install source) ─
_sup_darwin_label() { printf 'com.flywheel.%s' "$1"; }

_sup_launchd_dir() { printf '%s' "${FLYWHEEL_LAUNCHD_DIR:-$HOME/Library/LaunchAgents}"; }

# _sup_darwin_install <spec> — FLY-1062: render a launchd plist from the SAME
# service-spec JSON the linux path consumes, then bootstrap it. Only reachable
# behind the explicit FLYWHEEL_SUPERVISOR_DARWIN_INSTALL=1 opt-in (the packaged
# bootstrap sets it); the default darwin path stays the delegating no-op below
# (byte-compat with FLY-650 — reverse-compat sentinel).
_sup_darwin_install() {
  local spec="$1"
  local name kind exec_cmd keepalive stdout
  name="$(_sup_spec_get "$spec" '.name')"
  kind="$(_sup_spec_get "$spec" '.kind')"
  exec_cmd="$(_sup_spec_get "$spec" '.exec')"
  [ -n "$name" ] || { _sup_err "spec missing name"; return 1; }
  [ -n "$exec_cmd" ] || { _sup_err "spec '$name' missing exec"; return 1; }
  keepalive="$(_sup_spec_get "$spec" '.keepAlive')"
  stdout="$(_sup_spec_get "$spec" '.stdout')"

  local dir label plist
  dir="$(_sup_launchd_dir)"; mkdir -p "$dir" || return 1
  label="$(_sup_darwin_label "$name")"
  plist="$dir/$label.plist"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0">'
    echo '<dict>'
    echo "  <key>Label</key><string>$label</string>"
    echo '  <key>ProgramArguments</key>'
    echo '  <array>'
    local word
    for word in $exec_cmd; do
      echo "    <string>$word</string>"
    done
    echo '  </array>'
    if [ "$kind" = "service" ]; then
      echo '  <key>RunAtLoad</key><true/>'
      [ "$keepalive" = "true" ] && echo '  <key>KeepAlive</key><true/>'
      echo '  <key>ThrottleInterval</key><integer>15</integer>'
    fi
    if [ "$(jq -r '(.schedule | length) // 0' <<<"$spec" 2>/dev/null)" -gt 0 ] 2>/dev/null; then
      echo '  <key>StartCalendarInterval</key>'
      echo '  <array>'
      jq -r '.schedule[]? | "    <dict><key>Hour</key><integer>\(.hour // 0)</integer><key>Minute</key><integer>\(.minute // 0)</integer></dict>"' <<<"$spec"
      echo '  </array>'
    fi
    if [ "$(jq -r '(.watch | length) // 0' <<<"$spec" 2>/dev/null)" -gt 0 ] 2>/dev/null; then
      echo '  <key>QueueDirectories</key>'
      echo '  <array>'
      jq -r '.watch[]? | "    <string>\(.)</string>"' <<<"$spec"
      echo '  </array>'
    fi
    if [ -n "$stdout" ]; then
      echo "  <key>StandardOutPath</key><string>$stdout</string>"
      echo "  <key>StandardErrorPath</key><string>$stdout</string>"
    fi
    echo '</dict>'
    echo '</plist>'
  } > "$plist" || { _sup_err "cannot write $plist"; return 1; }

  local uid; uid="$(id -u)"
  launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$uid" "$plist" || { _sup_err "bootstrap failed: $label"; return 1; }
  return 0
}

# ── public lifecycle verbs: <name> [kind] ───────────────────────────────────
supervisor_install() {
  local spec="$1"
  command -v jq >/dev/null 2>&1 || { _sup_err "jq required"; return 2; }
  case "$(supervisor_backend)" in
    systemd-user) _sup_linux_install "$spec" ;;
    launchd)
      # FLY-1062: the packaged bootstrap opts into a REAL darwin install
      # (spec-rendered plist + bootstrap). Everything else keeps the FLY-650
      # delegating no-op verbatim (byte-compat).
      if [ "${FLYWHEEL_SUPERVISOR_DARWIN_INSTALL:-0}" = "1" ]; then
        _sup_darwin_install "$spec"
        return $?
      fi
      # macOS keeps the existing committed-plist + flywheel-daemon.sh install
      # flow (byte-compat). The provisioner's darwin path delegates there; this
      # is a no-op success so a cross-platform caller can call uniformly.
      _sup_log "darwin: install delegated to existing launchd flow (committed plists / flywheel-daemon.sh)"
      return 0
      ;;
    container) _sup_err "container backend not implemented (see FLY-652)"; return 3 ;;
    *) _sup_err "unknown supervisor backend"; return 1 ;;
  esac
}

supervisor_start()   { _sup_verb start "$@"; }
supervisor_stop()    { _sup_verb stop "$@"; }
supervisor_restart() { _sup_verb restart "$@"; }
supervisor_status()  { _sup_verb status "$@"; }
supervisor_is_loaded(){ _sup_verb is_loaded "$@"; }

_sup_verb() {
  local verb="$1" name="$2" kind="${3:-service}"
  case "$(supervisor_backend)" in
    systemd-user)
      local unit="$name.$(_sup_linux_suffix "$kind")"
      case "$verb" in
        start)     systemctl --user start "$unit" ;;
        stop)      systemctl --user stop "$unit" ;;
        restart)   systemctl --user restart "$unit" ;;
        status)    systemctl --user status "$unit" ;;
        is_loaded) systemctl --user is-active "$unit" ;;
      esac
      ;;
    launchd)
      local uid label; uid="$(id -u)"; label="$(_sup_darwin_label "$name")"
      local target="gui/$uid/$label"
      case "$verb" in
        start)     launchctl kickstart "$target" ;;
        stop)      launchctl bootout "$target" ;;
        restart)   launchctl kickstart -k "$target" ;;
        status)    launchctl print "$target" ;;
        is_loaded) launchctl print "$target" ;;
      esac
      ;;
    container) _sup_err "container backend not implemented (see FLY-652)"; return 3 ;;
    *) _sup_err "unknown supervisor backend"; return 1 ;;
  esac
}

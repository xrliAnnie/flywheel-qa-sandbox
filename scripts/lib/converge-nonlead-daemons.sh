#!/usr/bin/env bash
# FLY-1830: idempotent convergence of the NON-Lead flywheel launchd daemons.
# Source-only. macOS Bash 3.2 compatible.
#
# WHY THIS EXISTS
#   A launchd service can leave the user domain (an operator bootout, an aborted
#   install path) while its plist stays on disk and its override entry stays
#   "enabled". Nothing ever put it back. com.flywheel.quota-monitor ran from
#   2026-08-01 10:45 to 2026-08-06 00:17 and then sat unloaded for eleven days,
#   taking automatic Claude account switching offline with it — silently, because
#   the plist on disk still looked installed. Three more labels were in the same
#   state at the same time (updater, bridge-liveness-probe, daily-standup).
#
# SHAPE: CONVERGENCE, NOT DETECTION
#   The obvious patch — a startup self-check that enumerates plists and alerts on
#   the missing ones — is an alarm bolted onto a broken structure, which is the
#   shape Annie ruled out on 2026-08-05 ("先问能不能让它无从发生,检测是退而求其次").
#   So the already-existing full-restart wave reconciles the set on every deploy.
#   No new timer, no new flag, no new daemon: the same event that already
#   replaces the Bridge, the Leads and the cmux watcher now also puts back any
#   non-Lead daemon that fell out of the domain.
#
# ROSTER AUTHORITY: LAUNCHD'S OWN ENABLED BIT
#   A side roster ("register your daemon here") is the every-call-site-must-
#   remember shape that leaks by construction, and a hardcoded label list rots.
#   Instead the declaration already on the machine is the roster: a non-Lead
#   com.flywheel plist that is on disk AND not disabled in the launchd override
#   database AND not in the domain is, by that very declaration, something that
#   is supposed to be running. Absence from the override database means enabled —
#   that is launchd's own default, not an assumption of ours.
#
# THE LEAD FAMILY IS EXCLUDED ON PURPOSE
#   com.flywheel.lead.* carriers are owned by the Lead wave / fleet tooling, and
#   some are deliberately enabled-on-disk while being driven by a different
#   launcher — growth-mufasa-lead runs as a real TUI per FLY-398, so bootstrapping
#   its plist would create a second listener. Excluding the whole family (rather
#   than special-casing one label) keeps that hazard structurally out of reach.
#
# Outcomes (globals, mirroring the restart_cmux_watcher contract):
#   NONLEAD_DAEMON_CONVERGE_STATE   healthy|degraded|unverifiable
#   NONLEAD_DAEMON_CONVERGE_DETAIL  operator-readable evidence

_cnd_log() {
  if declare -F log >/dev/null 2>&1; then
    log "$*"
  else
    echo "[nonlead-daemon-converge] $*" >&2
  fi
}

# Single seam for every launchd call so the suite can drive this library against
# a scripted domain without touching the real one.
_cnd_launchctl() {
  launchctl "$@"
}

_cnd_launch_agents_dir() {
  printf '%s\n' "${HOME}/Library/LaunchAgents"
}

_cnd_domain() {
  printf '%s\n' "gui/$(id -u)"
}

_cnd_set_outcome() {
  NONLEAD_DAEMON_CONVERGE_STATE="$1"
  NONLEAD_DAEMON_CONVERGE_DETAIL="$2"
}

# The Lead family is out of scope for this convergence (see header).
nonlead_daemon_is_lead_label() {
  case "$1" in
    com.flywheel.lead.*) return 0 ;;
    *) return 1 ;;
  esac
}

_cnd_plutil() {
  plutil "$@"
}

# Print the Label DECLARED INSIDE the plist. This — not the file name — is the
# identity launchd registers the job under, so it is the only identity the Lead
# exclusion and the domain lookups may use. A file called anything at all can
# declare `com.flywheel.lead.growth-mufasa-lead` and would otherwise sail past a
# filename-only exclusion straight into a second Mufasa listener.
# Returns 1 when no plausible Label can be read; the caller must then skip the
# file and say so rather than fall back to the file name.
nonlead_daemon_plist_label() {
  local plist="$1" label=""
  if command -v plutil >/dev/null 2>&1; then
    label=$(_cnd_plutil -extract Label raw -o - "$plist" 2>/dev/null) || label=""
  fi
  if [[ -z "$label" ]]; then
    # Portable XML fallback (also the path CI takes, where plutil does not
    # exist): the first <string> that comes AFTER <key>Label</key>. Scanning the
    # whole Label line from column 0 would happily pick up a <string> belonging
    # to an earlier key on the same line, which is a way to smuggle a Lead label
    # past this function.
    label=$(awk '
      !seen {
        pos = index($0, "<key>Label</key>")
        if (pos == 0) next
        seen = 1
        rest = substr($0, pos + length("<key>Label</key>"))
        # An empty remainder means the key ended the line; continue on the NEXT
        # line. It must never fall back to re-scanning this one, which would put
        # an earlier key'"'"'s <string> back in play.
        if (match(rest, /<string>[^<]*<\/string>/)) {
          print substr(rest, RSTART + 8, RLENGTH - 17)
          exit
        }
        next
      }
      {
        if (match($0, /<string>[^<]*<\/string>/)) {
          print substr($0, RSTART + 8, RLENGTH - 17)
          exit
        }
      }
    ' "$plist" 2>/dev/null)
  fi
  label="${label%%$'\n'*}"
  case "$label" in
    ""|*[!A-Za-z0-9._-]*) return 1 ;;
  esac
  printf '%s\n' "$label"
}

# Print the labels launchd currently holds DISABLED in the given domain, one per
# line. Returns 1 when the override database cannot be read OR cannot be parsed
# with certainty — the caller must then converge nothing, because without it
# "enabled" is not knowable and a deliberately disabled daemon would be started
# against its operator's intent. An exit code of 0 is not enough: an entry whose
# value we do not recognise would silently read as enabled.
nonlead_daemon_disabled_labels() {
  local domain="$1" raw="" line="" body=""
  raw=$(_cnd_launchctl print-disabled "$domain" 2>/dev/null) || return 1
  # Shape:   disabled services = {
  #                  "com.flywheel.growth-learn" => disabled
  #          }
  printf '%s\n' "$raw" | grep -q 'disabled services = {' || return 1
  body=$(printf '%s\n' "$raw" | sed -n '/disabled services = {/,/^[[:space:]]*}[[:space:]]*$/p')
  [[ -n "$body" ]] || return 1
  # sed's range runs to end-of-input when the closing brace never arrives, so an
  # unterminated listing would otherwise parse as a complete one.
  printf '%s\n' "$body" | grep -Eq '^[[:space:]]*\}[[:space:]]*$' || return 1
  while IFS= read -r line; do
    # Skip ONLY the two framing lines and blanks. Anything else has to parse:
    # a line that merely contains a brace (`"x" => disabled } junk`) must not be
    # waved through, or a disabled label silently becomes an enabled one.
    case "$line" in
      '') continue ;;
    esac
    if printf '%s\n' "$line" | grep -Eq '^[[:space:]]*disabled services = \{[[:space:]]*$'; then
      continue
    fi
    if printf '%s\n' "$line" | grep -Eq '^[[:space:]]*\}[[:space:]]*$'; then
      continue
    fi
    if printf '%s\n' "$line" | grep -Eq '^[[:space:]]*"[^"]+"[[:space:]]*=>[[:space:]]*disabled[[:space:]]*$'; then
      printf '%s\n' "$line" | sed -E 's/^[[:space:]]*"([^"]+)".*$/\1/'
    elif printf '%s\n' "$line" | grep -Eq '^[[:space:]]*"[^"]+"[[:space:]]*=>[[:space:]]*enabled[[:space:]]*$'; then
      : # explicitly enabled — nothing to record
    else
      # An entry we cannot classify. Fail closed rather than guess "enabled".
      return 1
    fi
  done <<EOF
$body
EOF
  return 0
}

# Tri-state domain lookup: loaded | missing | error.
# "launchctl print failed" is NOT the same claim as "the service is absent" — a
# permissions or IPC failure would otherwise be read as absence and provoke a
# bootstrap of something that is already running. Only launchd's verbatim
# not-found message counts as absence.
nonlead_daemon_domain_state() {
  local domain="$1" label="$2" out="" rc=0
  out=$(_cnd_launchctl print "${domain}/${label}" 2>&1) || rc=$?
  if (( rc == 0 )); then
    printf 'loaded\n'
    return 0
  fi
  # The message must name the label we actually asked about. An unrelated
  # failure that happens to quote some other service's not-found text is not
  # evidence about ours. (macOS returns rc 113 here; the rc is deliberately NOT
  # required, because binding to it would silently disable convergence on any
  # OS release that renumbers it — and that failure direction is the damaging
  # one, whereas a stray false "missing" costs at most one refused bootstrap.)
  case "$out" in
    *"Could not find service \"${label}\""*) printf 'missing\n' ;;
    *) printf 'error\n' ;;
  esac
  return 0
}

converge_nonlead_daemons() {
  local domain agents_dir disabled_labels plist label
  local considered=0 already=0 converged=0 failed=0
  local converged_names="" failed_names=""

  _cnd_set_outcome unverifiable "convergence did not run"
  domain=$(_cnd_domain)
  agents_dir=$(_cnd_launch_agents_dir)

  if [[ ! -d "$agents_dir" ]]; then
    _cnd_set_outcome unverifiable "LaunchAgents directory missing: $agents_dir"
    _cnd_log "WARNING: ${NONLEAD_DAEMON_CONVERGE_DETAIL}"
    return 0
  fi

  if ! disabled_labels=$(nonlead_daemon_disabled_labels "$domain"); then
    _cnd_set_outcome unverifiable \
      "launchctl print-disabled failed for ${domain}; converged nothing (enabled/disabled is unknowable)"
    _cnd_log "ERROR: ${NONLEAD_DAEMON_CONVERGE_DETAIL}"
    return 0
  fi

  local file_label state
  for plist in "$agents_dir"/com.flywheel.*.plist; do
    # An unmatched glob yields the literal pattern; a symlinked plist is refused
    # rather than followed.
    [[ -e "$plist" ]] || continue
    [[ -f "$plist" && ! -L "$plist" ]] || continue

    file_label="$(basename "$plist" .plist)"
    # No file-name shortcut in either direction: the declared Label is the whole
    # identity. A cheap "looks like a Lead" pre-filter would silently drop a
    # non-Lead daemon that merely happens to sit in a Lead-shaped file.
    if ! label="$(nonlead_daemon_plist_label "$plist")"; then
      failed=$((failed + 1))
      failed_names="${failed_names:+${failed_names},}${file_label}(unreadable Label)"
      _cnd_log "ERROR: cannot read the Label declared in ${plist}; refusing to guess it from the file name"
      continue
    fi

    # The declared Label is the identity that matters. A non-Lead file name that
    # declares a Lead label must not slip through, and a flywheel-named file must
    # not smuggle a service from someone else's namespace into the domain.
    if nonlead_daemon_is_lead_label "$label"; then
      continue
    fi
    case "$label" in
      com.flywheel.*) ;;
      *)
        failed=$((failed + 1))
        failed_names="${failed_names:+${failed_names},}${file_label}(foreign label ${label})"
        _cnd_log "ERROR: ${plist} declares ${label}, outside the com.flywheel namespace; refusing"
        continue
        ;;
    esac

    if printf '%s\n' "$disabled_labels" | grep -Fxq "$label"; then
      continue
    fi

    considered=$((considered + 1))
    state="$(nonlead_daemon_domain_state "$domain" "$label")"
    if [[ "$state" == "loaded" ]]; then
      already=$((already + 1))
      continue
    fi
    if [[ "$state" != "missing" ]]; then
      failed=$((failed + 1))
      failed_names="${failed_names:+${failed_names},}${label}(probe error)"
      _cnd_log "ERROR: domain probe for ${domain}/${label} failed for a reason other than absence; not bootstrapping"
      continue
    fi

    _cnd_log "converging non-Lead daemon back into launchd: $label"
    if _cnd_launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1 \
      && [[ "$(nonlead_daemon_domain_state "$domain" "$label")" == "loaded" ]]; then
      converged=$((converged + 1))
      converged_names="${converged_names:+${converged_names},}${label}"
    else
      failed=$((failed + 1))
      failed_names="${failed_names:+${failed_names},}${label}"
      _cnd_log "ERROR: could not converge ${domain}/${label} back into launchd"
    fi
  done

  local detail="enabled=${considered} already_loaded=${already} converged=${converged} failed=${failed}"
  [[ -n "$converged_names" ]] && detail="${detail}; converged: ${converged_names}"
  [[ -n "$failed_names" ]] && detail="${detail}; failed: ${failed_names}"

  if (( failed > 0 )); then
    _cnd_set_outcome degraded "$detail"
    _cnd_log "WARNING: non-Lead daemon convergence degraded — $detail"
  else
    _cnd_set_outcome healthy "$detail"
    _cnd_log "non-Lead daemon convergence: $detail"
  fi
  return 0
}

#!/usr/bin/env bash
# Shared safety boundary for the FLY-1814 single-action launchd tools.
# Source-only, Bash 3.2 compatible. Tests replace these narrow functions after
# sourcing; direct production execution retains real TTY/launchctl/audit paths.

_FLY1814_OPERATOR_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! declare -F nonlead_daemon_domain_state >/dev/null 2>&1; then
  # Reuse the manifest/census plist parser and fail-closed launchctl probes.
  # shellcheck source=scripts/lib/converge-nonlead-daemons.sh
  # shellcheck disable=SC1091
  source "${_FLY1814_OPERATOR_LIB_DIR}/converge-nonlead-daemons.sh"
fi

fly1814_operator_has_tty() {
  [[ -t 0 && -t 1 ]]
}

fly1814_domain() {
  printf 'gui/%s\n' "$(id -u)"
}

fly1814_launch_agents_dir() {
  printf '%s\n' "${HOME}/Library/LaunchAgents"
}

fly1814_launchctl() {
  launchctl "$@"
}

# Keep the reused parsers on the operator tool's one launchctl seam.
_cnd_launchctl() {
  fly1814_launchctl "$@"
}

fly1814_plist_is_active() {
  _cnd_plist_is_active "$1"
}

fly1814_plist_label() {
  nonlead_daemon_plist_label "$1"
}

fly1814_program_target() {
  launchd_plist_program_target "$1"
  [[ "${LAUNCHD_PROGRAM_STATE:-unknown}" == resolved \
    && -n "${LAUNCHD_PROGRAM_TARGET:-}" ]] || return 1
  printf '%s\n' "$LAUNCHD_PROGRAM_TARGET"
}

fly1814_domain_state() {
  nonlead_daemon_domain_state "$1" "$2"
}

fly1814_disabled_state() {
  local domain="$1" label="$2" disabled_labels=""
  disabled_labels="$(nonlead_daemon_disabled_labels "$domain")" || return 1
  if printf '%s\n' "$disabled_labels" | grep -Fxq "$label"; then
    printf 'disabled\n'
  else
    printf 'enabled\n'
  fi
}

fly1814_today() {
  date -u +%Y%m%d
}

fly1814_alert_send() {
  "${_FLY1814_OPERATOR_LIB_DIR}/../lead-alert.sh" "$@"
}

fly1814_sha256() {
  local output="" digest=""
  if command -v shasum >/dev/null 2>&1; then
    output="$(shasum -a 256)" || return 1
  elif command -v sha256sum >/dev/null 2>&1; then
    output="$(sha256sum)" || return 1
  else
    return 1
  fi
  digest="${output%%[[:space:]]*}"
  [[ "${#digest}" == 64 ]] || return 1
  printf '%s\n' "$digest" | grep -Eq '^[0-9a-f]{64}$' || return 1
  printf '%s\n' "$digest"
}

# A mutation may begin only after lead-alert has returned its durable sent
# receipt. queued_transient/dead_lettered/config_error/duplicate are not proof
# that this operator intent was durably delivered, regardless of exit code.
fly1814_operator_audit() {
  local action="$1" label="$2" title="$3" body="$4" intent="$5"
  local result="" signature="" intent_hash=""
  intent_hash="$({
    printf 'action=%s\n' "$action"
    printf 'label=%s\n' "$label"
    printf '%s' "$intent"
  } | fly1814_sha256)" || return 1
  [[ -n "$intent_hash" ]] || return 1
  # A strict-delivery retry for the same canonical intent on the same UTC day
  # deliberately reuses the signature. The sender can then return the durable
  # receipt for that exact intent rather than create an uncorrelated alert.
  signature="fly1814-${action}-${label}-$(fly1814_today)-${intent_hash}"
  result="$(fly1814_alert_send \
    --project flywheel --lead updater \
    --kind deploy_degraded --severity warning \
    --title "$title" --body "$body" \
    --signature "$signature" --strict-delivery)" || return 1
  [[ "$result" == sent ]]
}

fly1814_mkdir() {
  mkdir "$@"
}

fly1814_archive_publish() {
  local source="$1" destination="$2"
  # Same-filesystem hard-link publication is atomic and create-if-absent: a
  # raced operator file is never overwritten. The caller owns the destination
  # only after this returns success.
  ln "$source" "$destination"
}

fly1814_file_identity() {
  local path="$1" identity=""
  identity="$(stat -c '%d:%i' "$path" 2>/dev/null || true)"
  if ! printf '%s\n' "$identity" | grep -Eq '^[0-9]+:[0-9]+$'; then
    identity="$(stat -f '%d:%i' "$path" 2>/dev/null || true)"
  fi
  printf '%s\n' "$identity" | grep -Eq '^[0-9]+:[0-9]+$' || return 1
  printf '%s\n' "$identity"
}

fly1814_files_are_same() {
  [[ "$1" -ef "$2" ]]
}

fly1814_unlink() {
  rm -f -- "$1"
}

fly1814_source_remove() {
  local source="$1" archive="$2" owned_identity="$3"
  [[ "$(fly1814_file_identity "$source" 2>/dev/null || true)" == "$owned_identity" ]] || return 1
  [[ "$(fly1814_file_identity "$archive" 2>/dev/null || true)" == "$owned_identity" ]] || return 1
  fly1814_files_are_same "$source" "$archive" || return 1
  fly1814_unlink "$source"
}

fly1814_archive_remove_owned() {
  local archive="$1" owned_identity="$2"
  [[ "$(fly1814_file_identity "$archive" 2>/dev/null || true)" == "$owned_identity" ]] || return 1
  fly1814_unlink "$archive"
}

fly1814_active_restore() {
  local archive="$1" active="$2" owned_identity="$3"
  [[ "$(fly1814_file_identity "$archive" 2>/dev/null || true)" == "$owned_identity" ]] || return 1
  [[ ! -e "$active" && ! -L "$active" ]] || return 1
  ln "$archive" "$active" || return 1
  [[ "$(fly1814_file_identity "$active" 2>/dev/null || true)" == "$owned_identity" ]]
}

fly1814_archive_dir_remove_owned() {
  local archive_dir="$1" owned_identity="$2"
  [[ -d "$archive_dir" && ! -L "$archive_dir" ]] || return 1
  [[ "$(fly1814_file_identity "$archive_dir" 2>/dev/null || true)" == "$owned_identity" ]] || return 1
  rmdir "$archive_dir"
}

fly1814_reference_scan() {
  local label="$1" root="$2" output="" rc=0
  output="$(grep -R -l -F -- "$label" "$root" 2>/dev/null)" || rc=$?
  case "$rc" in
    0) printf '%s\n' "$output" ;;
    1) return 0 ;;
    *) return "$rc" ;;
  esac
}

fly1814_aux_decisions_file() {
  printf '%s\n' "${_FLY1814_OPERATOR_LIB_DIR}/../launchd/fly1814-aux-decisions.tsv"
}

# Print the one validated seven-field row. The whole artifact is checked so a
# malformed or duplicated peer row cannot be hidden behind a valid selection.
fly1814_aux_decision_row() {
  local wanted="$1" decisions=""
  decisions="$(fly1814_aux_decisions_file)"
  [[ -f "$decisions" && ! -L "$decisions" ]] || return 1
  awk -F '\t' -v wanted="$wanted" '
    BEGIN {
      expected["com.flywheel.growth-improve"] = 1
      expected["com.flywheel.growth-learn"] = 1
      expected["com.flywheel.growth-report"] = 1
      expected["com.flywheel.growth-retro"] = 1
      expected["com.flywheel.sub-create-nightly"] = 1
      expected["com.flywheel.sub-daily-loop"] = 1
      expected["com.flywheel.skills-update"] = 1
      expected["com.flywheel.token-usage-daily"] = 1
      valid = 1
    }
    NR == 1 {
      if ($0 != "label\tstatus\tapproved_target\tpurpose\tprovenance\trecommendation\tevidence") valid = 0
      next
    }
    {
      if (NF != 7 || $1 == "" || $2 == "" || $3 !~ /^\// || $4 == "" || $5 == "" || $6 == "" || $7 == "") valid = 0
      if (!expected[$1] || seen[$1]++) valid = 0
      if ($2 != "pending" && $2 != "approved" && $2 != "hold") valid = 0
      if ($5 != "bak-fly886" && $5 != "unknown") valid = 0
      if ($1 == wanted) { selected = $0; selected_count++ }
      rows++
    }
    END {
      for (label in expected) if (seen[label] != 1) valid = 0
      if (rows != 8 || selected_count != 1) valid = 0
      if (!valid) exit 1
      print selected
    }
  ' "$decisions"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf 'ERROR: fly1814-operator-tools.sh is a source-only library\n' >&2
  exit 64
fi

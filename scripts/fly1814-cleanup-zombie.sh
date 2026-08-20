#!/usr/bin/env bash
# Explicit retirement of the one observed FLY-1814 qa528 zombie.
# Dry-run is the default. No label other than the exact qa528 identity is ever
# selected, and apply archives rather than deletes the active plist.
set -uo pipefail

FLY1814_CLEANUP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! declare -F fly1814_operator_audit >/dev/null 2>&1; then
  # shellcheck source=scripts/lib/fly1814-operator-tools.sh
  source "${FLY1814_CLEANUP_SCRIPT_DIR}/lib/fly1814-operator-tools.sh"
fi

FLY1814_QA528_LABEL="com.xiaohongshu-deep-learning.qa528"

fly1814_cleanup_usage() {
  cat >&2 <<'USAGE'
Usage: fly1814-cleanup-zombie.sh [--apply --i-am-operator]

Dry-run is the default. Apply handles only
com.xiaohongshu-deep-learning.qa528, requires an interactive TTY plus the
explicit operator acknowledgement, and archives the verified stale plist.
USAGE
}

fly1814_cleanup_target_is_stale() {
  local target="$1"
  printf '%s\n' "$target" | awk -F / '
    NF != 8 { exit 1 }
    $1 != "" || $2 != "var" || $3 != "folders" || length($4) != 2 || $6 != "T" { exit 1 }
    $8 != "com.xiaohongshu-deep-learning.qa528-scheduled.sh" { exit 1 }
    {
      for (i = 4; i <= 7; i++) {
        if ($i == "" || $i == "." || $i == ".." || $i !~ /^[A-Za-z0-9_.+-]+$/) exit 1
      }
    }
  ' || return 1
  [[ ! -e "$target" && ! -L "$target" ]]
}

fly1814_cleanup_validate_identity() {
  local plist="$1" expected_target="$2" label="" target=""
  fly1814_plist_is_active "$plist" || return 1
  label="$(fly1814_plist_label "$plist" 2>/dev/null)" || return 1
  [[ "$label" == "$FLY1814_QA528_LABEL" ]] || return 1
  target="$(fly1814_program_target "$plist" 2>/dev/null)" || return 1
  [[ -z "$expected_target" || "$target" == "$expected_target" ]] || return 1
  fly1814_cleanup_target_is_stale "$target" || return 1
  printf '%s\n' "$target"
}

fly1814_cleanup_archive_boundary_safe() {
  local archive_dir="$1" archive_path="$2"
  [[ ! -L "$archive_dir" ]] || return 1
  [[ ! -e "$archive_dir" || -d "$archive_dir" ]] || return 1
  [[ ! -e "$archive_path" && ! -L "$archive_path" ]]
}

fly1814_cleanup_archive_matches() {
  local archive_path="$1" owned_identity="$2" expected_target="$3" archive_target=""
  [[ -n "$owned_identity" ]] || return 1
  [[ "$(fly1814_file_identity "$archive_path" 2>/dev/null || true)" == "$owned_identity" ]] || return 1
  archive_target="$(fly1814_cleanup_validate_identity "$archive_path" "$expected_target" 2>/dev/null || true)"
  [[ "$archive_target" == "$expected_target" ]]
}

fly1814_cleanup_active_matches() {
  local plist="$1" owned_identity="$2" expected_target="$3" source_target=""
  [[ -n "$owned_identity" ]] || return 1
  [[ "$(fly1814_file_identity "$plist" 2>/dev/null || true)" == "$owned_identity" ]] || return 1
  source_target="$(fly1814_cleanup_validate_identity "$plist" "$expected_target" 2>/dev/null || true)"
  [[ "$source_target" == "$expected_target" ]]
}

fly1814_cleanup_archive_pair_matches() {
  local plist="$1" archive_path="$2" owned_identity="$3" expected_target="$4"
  fly1814_cleanup_active_matches "$plist" "$owned_identity" "$expected_target" || return 1
  fly1814_cleanup_archive_matches "$archive_path" "$owned_identity" "$expected_target" || return 1
  fly1814_files_are_same "$plist" "$archive_path" || return 1
}

fly1814_cleanup_restore_transaction() {
  local domain="$1" plist="$2" archive_path="$3" prior_domain="$4"
  local source_identity="$5" archive_identity="$6" source_removed="$7" expected_target="$8"
  local archive_dir="$9" archive_dir_identity="${10}"
  local failed=0 state="" restored_target="" active_owned=0 archive_matches=0

  [[ -n "$source_identity" ]] || failed=1
  if [[ -n "$archive_identity" ]]; then
    if [[ "$archive_identity" == "$source_identity" ]] \
      && fly1814_cleanup_archive_matches "$archive_path" "$archive_identity" "$expected_target"; then
      archive_matches=1
    else
      failed=1
    fi
  fi

  if (( source_removed == 1 )); then
    if [[ ! -e "$plist" && ! -L "$plist" ]] && (( archive_matches == 1 )); then
      fly1814_active_restore "$archive_path" "$plist" "$archive_identity" || failed=1
    elif [[ ! -e "$plist" && ! -L "$plist" ]]; then
      failed=1
    fi
  fi

  if fly1814_cleanup_active_matches "$plist" "$source_identity" "$expected_target"; then
    active_owned=1
  else
    failed=1
  fi

  state="$(fly1814_domain_state "$domain" "$FLY1814_QA528_LABEL")"
  if (( active_owned == 1 )) && [[ "$prior_domain" == loaded && "$state" == missing ]]; then
    if fly1814_cleanup_active_matches "$plist" "$source_identity" "$expected_target"; then
      fly1814_launchctl bootstrap "$domain" "$plist" || failed=1
    else
      active_owned=0
      failed=1
    fi
  elif (( active_owned == 1 )) && [[ "$prior_domain" == loaded && "$state" != loaded ]]; then
    failed=1
  elif (( active_owned == 1 )) && [[ "$prior_domain" == missing && "$state" != missing ]]; then
    fly1814_launchctl bootout "${domain}/${FLY1814_QA528_LABEL}" || failed=1
  elif (( active_owned == 0 )) && [[ "$state" != "$prior_domain" ]]; then
    failed=1
  fi

  if [[ -n "$archive_identity" ]]; then
    if (( active_owned == 1 )) \
      && fly1814_cleanup_archive_pair_matches "$plist" "$archive_path" "$archive_identity" "$expected_target"; then
      fly1814_archive_remove_owned "$archive_path" "$archive_identity" || failed=1
    else
      failed=1
    fi
  fi

  restored_target="$(fly1814_cleanup_validate_identity "$plist" "$expected_target" 2>/dev/null || true)"
  [[ "$restored_target" == "$expected_target" ]] || failed=1
  if [[ "$(fly1814_file_identity "$plist" 2>/dev/null || true)" != "$source_identity" ]]; then
    failed=1
  fi
  if [[ -n "$archive_identity" && ( -e "$archive_path" || -L "$archive_path" ) ]]; then
    failed=1
  fi
  if [[ -n "$archive_dir_identity" ]]; then
    fly1814_archive_dir_remove_owned "$archive_dir" "$archive_dir_identity" || failed=1
  fi
  state="$(fly1814_domain_state "$domain" "$FLY1814_QA528_LABEL")"
  [[ "$state" == "$prior_domain" ]] || failed=1
  (( failed == 0 ))
}

fly1814_cleanup_fail_transaction() {
  local message="$1" domain="$2" plist="$3" archive_path="$4" prior_domain="$5"
  local source_identity="$6" archive_identity="$7" source_removed="$8" expected_target="$9"
  local archive_dir="${10}" archive_dir_identity="${11}" original_rc="${12}"
  if fly1814_cleanup_restore_transaction "$domain" "$plist" "$archive_path" \
      "$prior_domain" "$source_identity" "$archive_identity" "$source_removed" "$expected_target" \
      "$archive_dir" "$archive_dir_identity"; then
    printf 'ERROR: %s; prior active plist/domain state restored\n' "$message" >&2
    return "$original_rc"
  fi
  printf 'ERROR: rollback-failed after %s\n' "$message" >&2
  return 78
}

fly1814_cleanup_fail_before_bootout() {
  local message="$1" archive_dir="$2" archive_dir_identity="$3" original_rc="$4"
  if [[ -n "$archive_dir_identity" ]] \
    && ! fly1814_archive_dir_remove_owned "$archive_dir" "$archive_dir_identity"; then
    printf 'ERROR: rollback-failed after %s\n' "$message" >&2
    return 78
  fi
  printf 'ERROR: %s; no launchctl mutation\n' "$message" >&2
  return "$original_rc"
}

fly1814_cleanup_main() {
  local apply=0 operator=0 arg="" domain="" agents="" plist="" label=""
  local target="" before_domain="" after_domain="" archive_dir="" archive_path=""
  local references="" revalidated_target="" source_identity="" archive_identity=""
  local archive_dir_identity="" audit_intent="" post_audit_domain="" source_removed=0

  while (( $# > 0 )); do
    arg="$1"
    case "$arg" in
      --apply) apply=1 ;;
      --dry-run) apply=0 ;;
      --i-am-operator) operator=1 ;;
      -h|--help) fly1814_cleanup_usage; return 0 ;;
      *) printf 'ERROR: unknown option: %s\n' "$arg" >&2; fly1814_cleanup_usage; return 64 ;;
    esac
    shift
  done

  if (( apply == 1 )); then
    if ! fly1814_operator_has_tty; then
      printf 'ERROR: --apply requires an interactive TTY; non-TTY execution is refused\n' >&2
      return 66
    fi
    if (( operator != 1 )); then
      printf 'ERROR: --apply requires the explicit --i-am-operator acknowledgement\n' >&2
      return 66
    fi
  fi

  domain="$(fly1814_domain)"
  agents="$(fly1814_launch_agents_dir)"
  plist="${agents}/${FLY1814_QA528_LABEL}.plist"
  before_domain="$(fly1814_domain_state "$domain" "$FLY1814_QA528_LABEL")"
  case "$before_domain" in loaded|missing) ;; *) printf 'ERROR: cannot prove qa528 domain state\n' >&2; return 69 ;; esac

  if ! fly1814_plist_is_active "$plist"; then
    if [[ -e "$plist" || -L "$plist" ]]; then
      printf 'ERROR: qa528 plist exists but is not an active regular plist; identity changed\n' >&2
      return 68
    fi
    if [[ "$before_domain" == missing ]]; then
      printf 'already absent/retired: active plist absent and launchd label missing\n'
      return 0
    fi
    printf 'ERROR: qa528 remains loaded but its active plist is absent; refusing unverifiable cleanup\n' >&2
    return 68
  fi

  label="$(fly1814_plist_label "$plist" 2>/dev/null || true)"
  if [[ "$label" != "$FLY1814_QA528_LABEL" ]]; then
    printf 'ERROR: qa528 plist internal Label changed (found=%s); refusing\n' "${label:-unreadable}" >&2
    return 68
  fi
  target="$(fly1814_cleanup_validate_identity "$plist" "" 2>/dev/null || true)"
  if [[ -z "$target" ]]; then
    printf 'ERROR: qa528 ProgramArguments no longer resolves to the exact missing temporary target shape\n' >&2
    return 68
  fi
  source_identity="$(fly1814_file_identity "$plist" 2>/dev/null || true)"
  if [[ -z "$source_identity" ]]; then
    printf 'ERROR: cannot capture stable qa528 plist file identity\n' >&2
    return 68
  fi

  archive_dir="${agents}/retired-$(fly1814_today)"
  archive_path="${archive_dir}/${FLY1814_QA528_LABEL}.plist"
  if ! fly1814_cleanup_archive_boundary_safe "$archive_dir" "$archive_path"; then
    printf 'ERROR: archive directory is unsafe or destination collision exists at %s\n' "$archive_path" >&2
    return 73
  fi

  if ! references="$(fly1814_reference_scan "$FLY1814_QA528_LABEL" "$agents")"; then
    printf 'ERROR: remaining-reference scan failed; cleanup cannot prove its scope\n' >&2
    return 73
  fi
  printf 'label: %s\n' "$FLY1814_QA528_LABEL"
  printf 'target: %s (missing)\n' "$target"
  printf 'before: %s\n' "$before_domain"
  printf 'remaining references before archive:\n%s\n' "${references:-(none)}"

  if (( apply == 0 )); then
    printf 'DRY-RUN: would run launchctl bootout %s/%s (already unloaded is acceptable)\n' "$domain" "$FLY1814_QA528_LABEL"
    printf 'DRY-RUN: would archive %s -> %s without overwrite\n' "$plist" "$archive_path"
    return 0
  fi

  audit_intent="$(printf '%s\n' \
    "decision_target=${target}" \
    "prior_disabled=not-applicable" \
    "prior_domain=${before_domain}" \
    "source_plist=${plist}" \
    "source_identity=${source_identity}" \
    "archive_destination=${archive_path}")"
  if ! fly1814_operator_audit cleanup-zombie "$FLY1814_QA528_LABEL" \
      "FLY-1814 qa528 retirement requested" \
      "Operator requested exact qa528 cleanup; before=${before_domain}; missing target=${target}; archive=${archive_path}." \
      "$audit_intent"; then
    printf 'ERROR: mandatory operator audit was not delivered; no mutation\n' >&2
    return 70
  fi

  revalidated_target="$(fly1814_cleanup_validate_identity "$plist" "$target" 2>/dev/null || true)"
  if [[ "$revalidated_target" != "$target" \
    || "$(fly1814_file_identity "$plist" 2>/dev/null || true)" != "$source_identity" ]]; then
    printf 'ERROR: qa528 Label, target, or file identity changed after audit; no mutation\n' >&2
    return 68
  fi
  post_audit_domain="$(fly1814_domain_state "$domain" "$FLY1814_QA528_LABEL")"
  case "$post_audit_domain" in
    loaded|missing) ;;
    *) printf 'ERROR: cannot re-probe qa528 domain state after audit; no mutation\n' >&2; return 69 ;;
  esac
  if [[ "$post_audit_domain" != "$before_domain" ]]; then
    printf 'ERROR: signed qa528 domain state changed during audit; no mutation\n' >&2
    return 69
  fi
  if ! fly1814_cleanup_archive_boundary_safe "$archive_dir" "$archive_path"; then
    printf 'ERROR: archive collision or unsafe directory appeared after audit; no mutation\n' >&2
    return 73
  fi

  if [[ ! -d "$archive_dir" ]]; then
    fly1814_mkdir "$archive_dir" || {
      printf 'ERROR: cannot create archive directory: %s\n' "$archive_dir" >&2
      return 74
    }
    archive_dir_identity="$(fly1814_file_identity "$archive_dir" 2>/dev/null || true)"
    if [[ -z "$archive_dir_identity" ]]; then
      printf 'ERROR: rollback-failed: created archive directory has no stable file identity: %s\n' "$archive_dir" >&2
      return 78
    fi
  fi
  revalidated_target="$(fly1814_cleanup_validate_identity "$plist" "$target" 2>/dev/null || true)"
  if [[ "$revalidated_target" != "$target" \
    || "$(fly1814_file_identity "$plist" 2>/dev/null || true)" != "$source_identity" ]]; then
    fly1814_cleanup_fail_before_bootout "qa528 Label, target, or file identity changed after audit" \
      "$archive_dir" "$archive_dir_identity" 68
    return $?
  fi
  if ! fly1814_cleanup_archive_boundary_safe "$archive_dir" "$archive_path"; then
    fly1814_cleanup_fail_before_bootout "archive collision or unsafe directory appeared after audit" \
      "$archive_dir" "$archive_dir_identity" 73
    return $?
  fi

  if [[ "$before_domain" == loaded ]]; then
    if ! fly1814_launchctl bootout "${domain}/${FLY1814_QA528_LABEL}"; then
      after_domain="$(fly1814_domain_state "$domain" "$FLY1814_QA528_LABEL")"
      if [[ "$after_domain" != missing ]]; then
        fly1814_cleanup_fail_transaction "bootout failed and qa528 is not proven unloaded" \
          "$domain" "$plist" "$archive_path" "$before_domain" "$source_identity" "$archive_identity" "$source_removed" "$target" \
          "$archive_dir" "$archive_dir_identity" 75
        return $?
      fi
      printf 'bootout returned failure but re-probe proves already unloaded\n'
    fi
  else
    printf 'qa528 was already unloaded; bootout skipped\n'
  fi

  if ! fly1814_archive_publish "$plist" "$archive_path"; then
    fly1814_cleanup_fail_transaction "atomic archive publication failed or destination raced" \
      "$domain" "$plist" "$archive_path" "$before_domain" "$source_identity" "$archive_identity" "$source_removed" "$target" \
      "$archive_dir" "$archive_dir_identity" 76
    return $?
  fi
  archive_identity="$source_identity"
  if ! fly1814_cleanup_archive_pair_matches "$plist" "$archive_path" "$archive_identity" "$target"; then
    fly1814_cleanup_fail_transaction "archive publication identity proof failed" \
      "$domain" "$plist" "$archive_path" "$before_domain" "$source_identity" "$archive_identity" "$source_removed" "$target" \
      "$archive_dir" "$archive_dir_identity" 76
    return $?
  fi
  if ! fly1814_cleanup_archive_pair_matches "$plist" "$archive_path" "$archive_identity" "$target" \
    || ! fly1814_source_remove "$plist" "$archive_path" "$archive_identity"; then
    if [[ ! -e "$plist" && ! -L "$plist" ]] \
      && fly1814_cleanup_archive_matches "$archive_path" "$archive_identity" "$target"; then
      source_removed=1
    fi
    fly1814_cleanup_fail_transaction "active plist removal failed after archive publication" \
      "$domain" "$plist" "$archive_path" "$before_domain" "$source_identity" "$archive_identity" "$source_removed" "$target" \
      "$archive_dir" "$archive_dir_identity" 76
    return $?
  fi
  source_removed=1
  if ! fly1814_cleanup_archive_matches "$archive_path" "$archive_identity" "$target" \
    || [[ -e "$plist" || -L "$plist" ]]; then
    fly1814_cleanup_fail_transaction "archive evidence is incomplete after publication" \
      "$domain" "$plist" "$archive_path" "$before_domain" "$source_identity" "$archive_identity" "$source_removed" "$target" \
      "$archive_dir" "$archive_dir_identity" 76
    return $?
  fi

  after_domain="$(fly1814_domain_state "$domain" "$FLY1814_QA528_LABEL")"
  printf 'archive: %s\n' "$archive_path"
  printf 'after: %s\n' "$after_domain"
  if [[ "$after_domain" != missing ]]; then
    fly1814_cleanup_fail_transaction "qa528 absence re-probe failed after archive (state=${after_domain})" \
      "$domain" "$plist" "$archive_path" "$before_domain" "$source_identity" "$archive_identity" "$source_removed" "$target" \
      "$archive_dir" "$archive_dir_identity" 77
    return $?
  fi
  printf 'retired exact qa528 plist without deletion\n'
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  fly1814_cleanup_main "$@"
  exit $?
fi

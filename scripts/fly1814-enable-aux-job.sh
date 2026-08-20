#!/usr/bin/env bash
# Explicit, single-label recovery for the eight FLY-1814 auxiliary jobs.
# Dry-run is the default. Apply is operator-only and decision-artifact-gated.
set -uo pipefail

FLY1814_AUX_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! declare -F fly1814_operator_audit >/dev/null 2>&1; then
  # shellcheck source=scripts/lib/fly1814-operator-tools.sh
  source "${FLY1814_AUX_SCRIPT_DIR}/lib/fly1814-operator-tools.sh"
fi

fly1814_aux_usage() {
  cat >&2 <<'USAGE'
Usage: fly1814-enable-aux-job.sh <label> [--apply --i-am-operator]

Dry-run is the default. Apply handles exactly one allowlisted label, requires
an interactive TTY plus --i-am-operator, and requires its decision row to be
approved before a mandatory audit send can precede launchctl mutation.
USAGE
}

fly1814_aux_allowed_label() {
  case "$1" in
    com.flywheel.growth-improve|com.flywheel.growth-learn|com.flywheel.growth-report|com.flywheel.growth-retro|com.flywheel.sub-create-nightly|com.flywheel.sub-daily-loop|com.flywheel.skills-update|com.flywheel.token-usage-daily) return 0 ;;
    *) return 1 ;;
  esac
}

fly1814_aux_loaded_word() {
  case "$1" in loaded) printf 'yes\n' ;; missing) printf 'no\n' ;; *) printf 'unknown\n' ;; esac
}

fly1814_aux_validate_payload() {
  local plist="$1" label="$2" approved_target="$3" actual_label="" resolved_target=""
  fly1814_plist_is_active "$plist" || return 1
  actual_label="$(fly1814_plist_label "$plist" 2>/dev/null)" || return 1
  [[ "$actual_label" == "$label" ]] || return 1
  resolved_target="$(fly1814_program_target "$plist" 2>/dev/null)" || return 1
  [[ "$resolved_target" == "$approved_target" ]] || return 2
  [[ -f "$resolved_target" && ! -L "$resolved_target" ]] || return 3
  printf '%s\n' "$resolved_target"
}

fly1814_aux_restore_prior_state() {
  local domain="$1" label="$2" plist="$3" prior_disabled="$4" prior_domain="$5" approved_target="$6"
  local current_domain="" restored_disabled="" restored_domain="" restored_target="" failed=0

  current_domain="$(fly1814_domain_state "$domain" "$label")"
  if [[ "$prior_domain" == missing && "$current_domain" != missing ]]; then
    fly1814_launchctl bootout "${domain}/${label}" || failed=1
  elif [[ "$prior_domain" == loaded && "$current_domain" == missing ]]; then
    restored_target="$(fly1814_aux_validate_payload "$plist" "$label" "$approved_target" 2>/dev/null || true)"
    if [[ "$restored_target" == "$approved_target" ]]; then
      fly1814_launchctl bootstrap "$domain" "$plist" || failed=1
    else
      failed=1
    fi
  fi
  if [[ "$prior_disabled" == disabled ]]; then
    fly1814_launchctl disable "${domain}/${label}" || failed=1
  fi

  restored_disabled="$(fly1814_disabled_state "$domain" "$label")" || restored_disabled=unknown
  restored_domain="$(fly1814_domain_state "$domain" "$label")"
  [[ "$restored_disabled" == "$prior_disabled" ]] || failed=1
  [[ "$restored_domain" == "$prior_domain" ]] || failed=1
  (( failed == 0 ))
}

fly1814_aux_fail_after_mutation() {
  local message="$1" domain="$2" label="$3" plist="$4"
  local prior_disabled="$5" prior_domain="$6" approved_target="$7" original_rc="$8"
  if fly1814_aux_restore_prior_state "$domain" "$label" "$plist" "$prior_disabled" "$prior_domain" "$approved_target"; then
    printf 'ERROR: %s; prior state restored\n' "$message" >&2
    return "$original_rc"
  fi
  printf 'ERROR: rollback-failed after %s\n' "$message" >&2
  return 78
}

fly1814_aux_main() {
  local apply=0 operator=0 label="" arg="" domain="" agents="" plist=""
  local row="" status="" approved_target="" purpose="" provenance="" recommendation="" evidence=""
  local before_disabled="" before_domain="" after_disabled="" after_domain="" target="" revalidated_target=""
  local post_audit_row="" post_authority="" expected_authority="" audit_intent=""
  local post_audit_disabled="" post_audit_domain=""
  local attempted_mutation=0

  while (( $# > 0 )); do
    arg="$1"
    case "$arg" in
      --apply) apply=1 ;;
      --dry-run) apply=0 ;;
      --i-am-operator) operator=1 ;;
      -h|--help) fly1814_aux_usage; return 0 ;;
      --*) printf 'ERROR: unknown option: %s\n' "$arg" >&2; fly1814_aux_usage; return 64 ;;
      *)
        if [[ -n "$label" ]]; then
          printf 'ERROR: exactly one label is required; batch operation is forbidden\n' >&2
          return 64
        fi
        label="$arg"
        ;;
    esac
    shift
  done

  [[ -n "$label" ]] || { printf 'ERROR: one label is required\n' >&2; fly1814_aux_usage; return 64; }
  if ! fly1814_aux_allowed_label "$label"; then
    printf 'ERROR: label is outside the exact FLY-1814 aux allowlist: %s\n' "$label" >&2
    return 64
  fi

  row="$(fly1814_aux_decision_row "$label")" || {
    printf 'ERROR: decision artifact is missing or malformed\n' >&2
    return 65
  }
  IFS=$'\t' read -r label status approved_target purpose provenance recommendation evidence <<EOF
$row
EOF

  if (( apply == 1 )); then
    if ! fly1814_operator_has_tty; then
      printf 'ERROR: --apply requires an interactive TTY; non-TTY execution is refused\n' >&2
      return 66
    fi
    if (( operator != 1 )); then
      printf 'ERROR: --apply requires the explicit --i-am-operator acknowledgement\n' >&2
      return 66
    fi
    if [[ "$status" != approved ]]; then
      printf 'ERROR: decision for %s is %s, not approved; no mutation\n' "$label" "$status" >&2
      return 67
    fi
  fi

  domain="$(fly1814_domain)"
  agents="$(fly1814_launch_agents_dir)"
  plist="${agents}/${label}.plist"
  target="$(fly1814_aux_validate_payload "$plist" "$label" "$approved_target")"
  case "$?" in
    0) ;;
    2) printf 'ERROR: installed plist target changed from approved target for %s\n' "$label" >&2; return 68 ;;
    3) printf 'ERROR: approved target is missing for %s: %s\n' "$label" "$approved_target" >&2; return 68 ;;
    *) printf 'ERROR: installed plist Label/target is missing, unsafe, or unresolved for %s\n' "$label" >&2; return 68 ;;
  esac

  before_disabled="$(fly1814_disabled_state "$domain" "$label")" || {
    printf 'ERROR: cannot prove prior enabled/disabled state for %s\n' "$label" >&2
    return 69
  }
  before_domain="$(fly1814_domain_state "$domain" "$label")"
  case "$before_domain" in loaded|missing) ;; *) printf 'ERROR: cannot prove prior domain state for %s\n' "$label" >&2; return 69 ;; esac

  printf 'label: %s\n' "$label"
  printf 'decision: %s (provenance=%s)\n' "$status" "$provenance"
  printf 'approved target: %s\n' "$approved_target"
  printf 'purpose: %s\n' "$purpose"
  printf 'recommendation: %s\n' "$recommendation"
  printf 'evidence: %s\n' "$evidence"
  printf 'before: %s loaded=%s\n' "$before_disabled" "$(fly1814_aux_loaded_word "$before_domain")"

  if (( apply == 0 )); then
    if [[ "$status" == approved ]]; then
      printf 'DRY-RUN: would run launchctl enable %s/%s if disabled\n' "$domain" "$label"
      printf 'DRY-RUN: would bootstrap %s from %s (target=%s) only if unloaded\n' "$domain" "$plist" "$target"
    else
      printf 'DRY-RUN: decision=%s; --apply remains blocked pending explicit approval\n' "$status"
    fi
    return 0
  fi

  audit_intent="$(printf '%s\n' \
    "decision_row=${row}" \
    "approved_target=${approved_target}" \
    "prior_disabled=${before_disabled}" \
    "prior_domain=${before_domain}" \
    "domain_target=${domain}/${label}" \
    "plist=${plist}")"
  if ! fly1814_operator_audit enable-aux "$label" \
      "FLY-1814 aux recovery requested" \
      "Operator approved single-label recovery for ${label}; target=${target}; before=${before_disabled}/${before_domain}; decision=${status}." \
      "$audit_intent"; then
    printf 'ERROR: mandatory operator audit was not delivered; no mutation\n' >&2
    return 70
  fi

  post_audit_row="$(fly1814_aux_decision_row "$label")" || {
    printf 'ERROR: decision artifact became missing or malformed after audit; no mutation\n' >&2
    return 67
  }
  post_authority="$(printf '%s\n' "$post_audit_row" | awk -F '\t' '{ print $1 "\t" $2 "\t" $3 }')"
  expected_authority="${label}"$'\t'"approved"$'\t'"${approved_target}"
  if [[ "$post_audit_row" != "$row" || "$post_authority" != "$expected_authority" ]]; then
    printf 'ERROR: approved decision changed or was revoked after audit; no mutation\n' >&2
    return 67
  fi

  revalidated_target="$(fly1814_aux_validate_payload "$plist" "$label" "$approved_target")"
  case "$?" in
    0) ;;
    2) printf 'ERROR: installed plist target changed after audit; no mutation\n' >&2; return 68 ;;
    3) printf 'ERROR: approved target disappeared after audit; no mutation\n' >&2; return 68 ;;
    *) printf 'ERROR: installed plist Label/target changed after audit; no mutation\n' >&2; return 68 ;;
  esac
  [[ "$revalidated_target" == "$target" ]] || {
    printf 'ERROR: installed plist target changed after audit; no mutation\n' >&2
    return 68
  }

  post_audit_disabled="$(fly1814_disabled_state "$domain" "$label")" || {
    printf 'ERROR: cannot re-probe enabled/disabled state after audit; no mutation\n' >&2
    return 69
  }
  post_audit_domain="$(fly1814_domain_state "$domain" "$label")"
  case "$post_audit_domain" in
    loaded|missing) ;;
    *) printf 'ERROR: cannot re-probe domain state after audit; no mutation\n' >&2; return 69 ;;
  esac
  if [[ "$post_audit_disabled" != "$before_disabled" \
    || "$post_audit_domain" != "$before_domain" ]]; then
    printf 'ERROR: signed launchctl state changed during audit; no mutation\n' >&2
    return 69
  fi

  if [[ "$before_disabled" == disabled ]]; then
    attempted_mutation=1
    if ! fly1814_launchctl enable "${domain}/${label}"; then
      fly1814_aux_fail_after_mutation "launchctl enable failed for ${label}" \
        "$domain" "$label" "$plist" "$before_disabled" "$before_domain" "$approved_target" 71
      return $?
    fi
  fi
  if [[ "$before_domain" == missing ]]; then
    attempted_mutation=1
    if ! fly1814_launchctl bootstrap "$domain" "$plist"; then
      fly1814_aux_fail_after_mutation "launchctl bootstrap failed for ${label}" \
        "$domain" "$label" "$plist" "$before_disabled" "$before_domain" "$approved_target" 71
      return $?
    fi
  fi

  after_disabled="$(fly1814_disabled_state "$domain" "$label")" || after_disabled=unknown
  after_domain="$(fly1814_domain_state "$domain" "$label")"
  printf 'after: %s loaded=%s\n' "$after_disabled" "$(fly1814_aux_loaded_word "$after_domain")"
  if [[ "$after_disabled" != enabled || "$after_domain" != loaded ]]; then
    if (( attempted_mutation == 1 )); then
      fly1814_aux_fail_after_mutation "post-apply proof failed for ${label}" \
        "$domain" "$label" "$plist" "$before_disabled" "$before_domain" "$approved_target" 72
      return $?
    fi
    printf 'ERROR: post-apply proof failed for %s; no state mutation was attempted\n' "$label" >&2
    return 72
  fi
  if [[ "$before_disabled" == enabled && "$before_domain" == loaded ]]; then
    printf 'already enabled and loaded; apply was idempotent\n'
  else
    printf 'recovered one label: %s\n' "$label"
  fi
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  fly1814_aux_main "$@"
  exit $?
fi

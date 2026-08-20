#!/usr/bin/env bash
# FLY-1814: read-only launchd fleet census on existing lifecycle anchors.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-${HOME}/.flywheel/.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

if ! declare -F census_launchd_fleet >/dev/null 2>&1; then
  # shellcheck source=lib/converge-nonlead-daemons.sh
  source "${SCRIPT_DIR}/lib/converge-nonlead-daemons.sh"
fi
if ! declare -F lead_restart_collect_candidates >/dev/null 2>&1 \
  && [[ -f "${SCRIPT_DIR}/lib/lead-restart-lifecycle.sh" ]]; then
  # shellcheck source=lib/lead-restart-lifecycle.sh
  source "${SCRIPT_DIR}/lib/lead-restart-lifecycle.sh"
fi

_launchd_census_lead_alert() {
  "${SCRIPT_DIR}/lead-alert.sh" "$@"
}

census_alert() {
  local summary="${1:-${LAUNCHD_CENSUS_SUMMARY:-unavailable}}"
  local detail="${2:-${LAUNCHD_CENSUS_DETAIL:-unavailable}}"
  local alert_key="${3:-${LAUNCHD_CENSUS_ALERT_KEY:-${detail}}}"
  local alert_digest=""
  alert_digest="$(printf '%s' "$alert_key" \
    | LC_ALL=C shasum -a 256 2>/dev/null \
    | awk '{ print substr($1, 1, 16) }')" || alert_digest=""
  [[ "$alert_digest" =~ ^[0-9a-f]{16}$ ]] || alert_digest="hash-unavailable"
  _launchd_census_lead_alert \
    --project flywheel --lead updater \
    --kind deploy_degraded --severity warning \
    --title "Launchd fleet census degraded" \
    --body "launchd: ${summary}; detail: ${detail}" \
    --signature "launchd-census-$(date -u +%Y%m%d)-${alert_digest}" 1>&2 || true
  return 0
}

launchd_census_main() {
  census_launchd_fleet || true
  printf 'launchd: %s\n' "${LAUNCHD_CENSUS_SUMMARY:-unavailable}"
  printf 'launchd-detail: %s\n' "${LAUNCHD_CENSUS_DETAIL:-unavailable}"
  if [[ "${LAUNCHD_CENSUS_ANOMALY:-1}" == 1 ]]; then
    census_alert "${LAUNCHD_CENSUS_SUMMARY:-unavailable}" \
      "${LAUNCHD_CENSUS_DETAIL:-unavailable}" \
      "${LAUNCHD_CENSUS_ALERT_KEY:-census-state:${LAUNCHD_CENSUS_STATE:-unverifiable}}"
  fi
  return 0
}

if [[ "${LAUNCHD_CENSUS_SOURCED:-0}" != 1 ]]; then
  launchd_census_main
  exit $?
fi

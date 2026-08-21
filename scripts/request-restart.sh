#!/usr/bin/env bash
# FLY-1959: founder-only emergency full restart through the detached updater.
# This command publishes one durable urgent token and nudges launchd. It never
# restarts services itself and never claims that the asynchronous restart ended.
set -uo pipefail

_RR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLYWHEEL_DIR="${FLYWHEEL_DIR:-$(cd "${_RR_DIR}/.." && pwd)}"
: "${FLYWHEEL_HOME:=${HOME}/.flywheel}"
SELF_SHIP_URGENT_DIR="${SELF_SHIP_URGENT_DIR:-${FLYWHEEL_HOME}/self-ship-urgent.d}"
SELF_SHIP_LAUNCHCTL="${SELF_SHIP_LAUNCHCTL:-launchctl}"
SELF_SHIP_UPDATER_LABEL="${SELF_SHIP_UPDATER_LABEL:-com.flywheel.updater}"
REQUEST_RESTART_GIT="${REQUEST_RESTART_GIT:-git}"
REQUEST_RESTART_BOUNDED_RUN="${REQUEST_RESTART_BOUNDED_RUN:-${_RR_DIR}/lib/bounded-run.sh}"
REQUEST_RESTART_REMOTE_TIMEOUT_SECONDS="${REQUEST_RESTART_REMOTE_TIMEOUT_SECONDS:-10}"

rr_log() { printf '[request-restart] %s\n' "$*" >&2; }
rr_is_sha40() { [[ "${1:-}" =~ ^[0-9a-fA-F]{40}$ ]]; }

rr_remote_main_sha() {
  local output="" sha="" ref="" extra="" error_file="" error_line="" rc=0
  if [ ! -x "$REQUEST_RESTART_BOUNDED_RUN" ]; then
    rr_log "origin main lookup unavailable: bounded runner is not executable: $REQUEST_RESTART_BOUNDED_RUN"
    return 1
  fi
  error_file="$(mktemp "${TMPDIR:-/tmp}/flywheel-request-restart.XXXXXX")" || {
    rr_log "origin main lookup unavailable: could not allocate a diagnostic file"
    return 1
  }
  output="$(GIT_TERMINAL_PROMPT=0 \
    "$REQUEST_RESTART_BOUNDED_RUN" "$REQUEST_RESTART_REMOTE_TIMEOUT_SECONDS" \
    "$REQUEST_RESTART_GIT" -C "$FLYWHEEL_DIR" ls-remote origin refs/heads/main \
    2>"$error_file")" || rc=$?
  while IFS= read -r error_line; do
    [ -z "$error_line" ] || rr_log "origin main lookup: $error_line"
  done < "$error_file"
  rm -f "$error_file"
  if [ "$rc" -ne 0 ]; then
    rr_log "origin main lookup command failed (rc=$rc)"
    return 1
  fi
  [[ -n "$output" && "$output" != *$'\n'* ]] || return 1
  IFS=$'\t' read -r sha ref extra <<< "$output"
  [[ -z "$extra" && "$ref" == refs/heads/main ]] || return 1
  rr_is_sha40 "$sha" || return 1
  printf '%s\n' "$sha"
}

rr_local_main_sha() {
  local sha=""
  sha="$("$REQUEST_RESTART_GIT" -C "$FLYWHEEL_DIR" rev-parse origin/main 2>/dev/null)" \
    || return 1
  rr_is_sha40 "$sha" || return 1
  printf '%s\n' "$sha"
}

rr_updater_loaded() {
  local target="gui/$(id -u)/${SELF_SHIP_UPDATER_LABEL}"
  "$SELF_SHIP_LAUNCHCTL" print "$target" >/dev/null 2>&1
}

rr_updater_enabled() {
  local domain="gui/$(id -u)" output="" line=""
  output="$("$SELF_SHIP_LAUNCHCTL" print-disabled "$domain" 2>/dev/null)" || return 1
  line="$(printf '%s\n' "$output" | grep -F "\"${SELF_SHIP_UPDATER_LABEL}\"" | tail -1)"
  # launchctl omits labels without a disabled override. An explicitly true /
  # disabled entry is fail-close; false / enabled and absence are startable.
  if [[ -z "$line" ]]; then return 0; fi
  case "$line" in
    *'=> true'*|*'=> disabled'*) return 1 ;;
    *'=> false'*|*'=> enabled'*) return 0 ;;
    *) return 1 ;;
  esac
}

rr_publish_urgent_token() {
  local sha="$1" now="" nonce="" tmp="" final=""
  rr_is_sha40 "$sha" || return 64
  mkdir -p "$FLYWHEEL_HOME" "$SELF_SHIP_URGENT_DIR" || return 1
  chmod 700 "$FLYWHEEL_HOME" "$SELF_SHIP_URGENT_DIR" || return 1
  now="$(date +%s)"
  nonce="$$-${now}-${RANDOM}"
  tmp="$(mktemp "${FLYWHEEL_HOME}/.urgent-token.XXXXXX")" || return 1
  if ! jq -n --arg sha "$sha" --argjson now "$now" \
      '{schemaVersion:1,kind:"founder-urgent-restart",targetSha:$sha,createdAt:$now}' \
      > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  final="${SELF_SHIP_URGENT_DIR}/${sha}.${nonce}.urgent.json"
  if [[ -e "$final" ]] || ! mv "$tmp" "$final"; then
    rm -f "$tmp"
    return 1
  fi
  printf '%s\n' "$final"
}

rr_kickstart_updater() {
  local target="gui/$(id -u)/${SELF_SHIP_UPDATER_LABEL}"
  # Never use -k: a new ticket must not terminate an updater already deploying.
  "$SELF_SHIP_LAUNCHCTL" kickstart "$target" >/dev/null 2>&1
}

rr_main() {
  local dry_run=0 target_sha="" token=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) dry_run=1; shift ;;
      *) rr_log "unknown arg '$1'"; return 64 ;;
    esac
  done

  if ! target_sha="$(rr_remote_main_sha)"; then
    rr_log "WARNING: origin main lookup failed or returned an invalid shape; falling back to the validated local origin/main ref"
    if ! target_sha="$(rr_local_main_sha)"; then
      rr_log "FATAL: neither remote main nor local origin/main produced one 40-hex SHA"
      return 69
    fi
  fi

  if (( dry_run == 1 )); then
    rr_log "DRY RUN: would publish one founder urgent token for ${target_sha} and nudge ${SELF_SHIP_UPDATER_LABEL}; no repository, queue, or Flywheel state was written"
    return 0
  fi

  if ! rr_updater_loaded; then
    rr_log "FATAL: updater '${SELF_SHIP_UPDATER_LABEL}' is not loaded; refusing to publish an unconsumable urgent token"
    return 69
  fi
  if ! rr_updater_enabled; then
    rr_log "FATAL: updater '${SELF_SHIP_UPDATER_LABEL}' is disabled or its enabled state is unreadable; refusing urgent token"
    return 69
  fi
  if ! token="$(rr_publish_urgent_token "$target_sha")"; then
    rr_log "FATAL: urgent token publication failed; updater was not kickstarted"
    return 1
  fi
  if ! rr_kickstart_updater; then
    rr_log "FATAL: kickstart failed after durable token publication. The token remains at ${token}; do not submit blindly. Check /tmp/flywheel-updater.log before deciding whether another票 is needed."
    return 69
  fi
  rr_log "已受理 founder 紧急票: updater 将收敛 origin/main 后执行一次全量重启。这里不代表重启完成；完成以 updater 日志和 reason=updater 的 founder 播报为准。"
  return 0
}

if [[ "${REQUEST_RESTART_SOURCED:-0}" != 1 ]]; then
  rr_main "$@"
  exit $?
fi

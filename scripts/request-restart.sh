#!/usr/bin/env bash
# FLY-1671: founder-timed full restart through the existing FLY-270 updater.
# This command only enqueues a durable restart intent and nudges launchd. The
# updater, which is outside the Lead fleet, converges origin/main and performs
# the full restart asynchronously.
set -uo pipefail

_RR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLYWHEEL_DIR="${FLYWHEEL_DIR:-$(cd "${_RR_DIR}/.." && pwd)}"
REQUEST_RESTART_GIT="${REQUEST_RESTART_GIT:-git}"
REQUEST_RESTART_HANDOFF="${REQUEST_RESTART_HANDOFF:-${_RR_DIR}/self-ship-restart.sh}"
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
  sha="$($REQUEST_RESTART_GIT -C "$FLYWHEEL_DIR" rev-parse origin/main 2>/dev/null)" \
    || return 1
  rr_is_sha40 "$sha" || return 1
  printf '%s\n' "$sha"
}

rr_main() {
  local dry_run=0 target_sha="" rc=0
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

  local args=(--target-sha "$target_sha")
  (( dry_run == 0 )) || args+=(--dry-run)
  if bash "$REQUEST_RESTART_HANDOFF" "${args[@]}"; then
    if (( dry_run == 1 )); then
      rr_log "DRY RUN: no repository, queue, or Flywheel state was written by this command"
    else
      rr_log "已受理入队: updater 将收敛 origin/main 后执行全量重启。这里不代表重启完成；完成以 updater 日志和 reason=updater 的 founder 播报为准。"
    fi
    return 0
  else
    rc=$?
    rr_log "FATAL: updater handoff failed (rc=$rc)"
    return "$rc"
  fi
}

rr_main "$@"
exit $?

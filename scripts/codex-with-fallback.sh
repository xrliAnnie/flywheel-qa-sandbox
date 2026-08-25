#!/usr/bin/env bash
# FLY-1887: repo-owned one-shot Codex wrapper. The installed global shim points
# at a stable vendored copy of this file; long-lived runner daemons never do.
set -uo pipefail

# Preserve the caller's streams while an attempt temporarily redirects fd 1/2
# into capture files. Signal traps run inside that redirected function scope;
# publishing through fd 1/2 there would append a file to itself forever.
exec 8>&1 9>&2
CODEX_GUARD_CLOSE_WRAPPER_FDS=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD_LIB="${FLYWHEEL_CODEX_GUARD_LIB:-$SCRIPT_DIR/lib/codex-guard.sh}"
[[ -r "$GUARD_LIB" ]] || GUARD_LIB="$SCRIPT_DIR/codex-guard.sh"
if [[ ! -r "$GUARD_LIB" ]]; then
  printf '[codex-guard] INSTALL_ERROR stable guard library is missing\n' >&2
  exit 125
fi
# shellcheck source=scripts/lib/codex-guard.sh
source "$GUARD_LIB"

TOTAL_TIMEOUT_SECONDS="${FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS:-1800}"
ATTEMPT_TIMEOUT_SECONDS="${FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS:-1800}"
if ! codex_guard_positive_integer "$TOTAL_TIMEOUT_SECONDS" \
  || ! codex_guard_positive_integer "$ATTEMPT_TIMEOUT_SECONDS"; then
  printf '[codex-guard] CONFIG_ERROR timeout values must be positive integers\n' >&2
  exit 125
fi

codex_guard_sweep

started_at="$(date +%s)"

cleanup_files=()
ACTIVE_STDOUT_FILE=""
ACTIVE_STDERR_FILE=""
# Invoked through EXIT/signal traps below.
# shellcheck disable=SC2329
cleanup_temp_files() {
  local file
  for file in "${cleanup_files[@]}"; do rm -f "$file" 2>/dev/null || true; done
}
# shellcheck disable=SC2329
publish_active_output() {
  if [[ -n "$ACTIVE_STDOUT_FILE" && -f "$ACTIVE_STDOUT_FILE" ]]; then
    cat "$ACTIVE_STDOUT_FILE" >&8 2>/dev/null || true
  fi
  if [[ -n "$ACTIVE_STDERR_FILE" && -f "$ACTIVE_STDERR_FILE" ]]; then
    cat "$ACTIVE_STDERR_FILE" >&9 2>/dev/null || true
  fi
  ACTIVE_STDOUT_FILE=""
  ACTIVE_STDERR_FILE=""
}
# shellcheck disable=SC2329
cleanup_normal_exit() {
  codex_guard_forget_active
  cleanup_temp_files
}
# shellcheck disable=SC2329
cleanup_signal_exit() {
  local status="$1"
  # The child is in its own process group. If this wrapper is interrupted it
  # may outlive us, so preserve its identity record for the next guarded call.
  trap - EXIT HUP INT TERM
  publish_active_output
  cleanup_temp_files
  exit "$status"
}
trap cleanup_normal_exit EXIT
trap 'cleanup_signal_exit 129' HUP
trap 'cleanup_signal_exit 130' INT
trap 'cleanup_signal_exit 143' TERM

remaining_budget() {
  local elapsed remaining
  elapsed=$(( $(date +%s) - started_at ))
  remaining=$(( TOTAL_TIMEOUT_SECONDS - elapsed ))
  (( remaining > 0 )) || return 1
  if (( remaining > ATTEMPT_TIMEOUT_SECONDS )); then
    remaining="$ATTEMPT_TIMEOUT_SECONDS"
  fi
  printf '%s\n' "$remaining"
}

run_codex_attempt() {
  local label="$1"
  shift
  local budget stdout_file stderr_file status
  budget="$(remaining_budget)" || {
    printf '%s label=total-budget budget_seconds=%s\n' "$CODEX_GUARD_TIMEOUT_MARKER" "$TOTAL_TIMEOUT_SECONDS" >&2
    return 124
  }
  stdout_file="$(mktemp "${TMPDIR:-/tmp}/codex-with-fallback.out.XXXXXX")" || return 125
  stderr_file="$(mktemp "${TMPDIR:-/tmp}/codex-with-fallback.err.XXXXXX")" || { rm -f "$stdout_file"; return 125; }
  cleanup_files+=("$stdout_file" "$stderr_file")
  ACTIVE_STDOUT_FILE="$stdout_file"
  ACTIVE_STDERR_FILE="$stderr_file"

  codex_guard_run "$budget" "$label" codex "$@" >"$stdout_file" 2>"$stderr_file"
  status=$?
  publish_active_output
  CODEX_ATTEMPT_OUTPUT="$(cat "$stdout_file" "$stderr_file")"
  return "$status"
}

CODEX_ATTEMPT_OUTPUT=""
run_codex_attempt "selected-account" "$@"
exit_code=$?
[[ "$exit_code" -eq 0 ]] && exit 0
[[ "$exit_code" -eq 124 ]] && exit 124

if printf '%s\n' "$CODEX_ATTEMPT_OUTPUT" | grep -qiE 'not supported when using Codex'; then
  printf '\n[codex-with-fallback] Model unsupported on the selected account; retrying once on the same account with gpt-5.5.\n' >&2
  new_args=()
  skip_next=false
  for arg in "$@"; do
    if $skip_next; then skip_next=false; continue; fi
    if [[ "$arg" == "-m" || "$arg" == "--model" ]]; then skip_next=true; continue; fi
    [[ "$arg" == -m=* || "$arg" == --model=* ]] && continue
    new_args+=("$arg")
  done
  run_codex_attempt "model-fallback" -m gpt-5.5 "${new_args[@]}"
  exit $?
elif printf '%s\n' "$CODEX_ATTEMPT_OUTPUT" | grep -qiE 'refresh_token_reused|token_expired|Please try signing in again|Please log out and sign in again'; then
  printf '\n[codex-with-fallback] AUTH_EXPIRED on the selected account. Run codex-profile status; the Founder may manually select school/personal/business with the profile tool use command.\n' >&2
  exit "$exit_code"
elif printf '%s\n' "$CODEX_ATTEMPT_OUTPUT" | grep -qiE '429|rate.?limit|too many requests|capacity|usage.?limit'; then
  printf '\n[codex-with-fallback] RATE_LIMIT on the selected account. Run codex-profile status; the Founder may manually select school/personal/business with the profile tool use command.\n' >&2
  exit "$exit_code"
fi

exit "$exit_code"

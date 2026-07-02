#!/usr/bin/env bash
# FLY-270: self-hosting ship handoff (Method B).
#
# A flywheel-repo Runner calls this AFTER a merge + repo-external bookkeeping +
# worktree cleanup + a clean-checkout preflight, INSTEAD of running
# `restart-services.sh` inline. It durably enqueues the merged ship for the
# detached launchd updater, then nudges the updater. The Runner emits
# `session_completed` only if this exits 0 (handoff fail-close — see spin.md /
# orchestrator.md). Durable scheduling is launchd `QueueDirectories` watching the
# pending dir; this script never runs the restart itself.
#
# Usage:
#   self-ship-restart.sh --target-sha <40hex merge-commit-sha> [--pr <n>] [--dry-run]
#
# The target SHA MUST be the canonical squash-merge commit SHA (from
# `gh pr view <PR> --json mergeCommit -q '.mergeCommit.oid'` or the verified
# landing signal) — NOT `git rev-parse HEAD` of the feature worktree, which is
# not an ancestor of the squash merge and would never acknowledge (§2.3 R3#2).
#
# Sourceable for tests via SELF_SHIP_RESTART_SOURCED=1. launchctl is injectable
# via SELF_SHIP_LAUNCHCTL so tests never touch the real launchd domain.
set -uo pipefail

_SSR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SELF_SHIP_QUEUE_SOURCED=1
# shellcheck source=lib/self-ship-queue.sh
source "${_SSR_DIR}/lib/self-ship-queue.sh"

SELF_SHIP_LAUNCHCTL="${SELF_SHIP_LAUNCHCTL:-launchctl}"
SELF_SHIP_UPDATER_LABEL="${SELF_SHIP_UPDATER_LABEL:-com.flywheel.updater}"

ssr_log() { echo "[self-ship-restart] $*" >&2; }

# Verify the updater launchd job is actually loaded (and not disabled). If it is
# not, QueueDirectories will never fire and the marker would rot — so fail loud
# rather than enqueue into a void.
ssr_updater_loaded() {
  local target="gui/$(id -u)/${SELF_SHIP_UPDATER_LABEL}"
  "$SELF_SHIP_LAUNCHCTL" print "$target" >/dev/null 2>&1
}

ssr_kickstart() {
  local target="gui/$(id -u)/${SELF_SHIP_UPDATER_LABEL}"
  # NO -k: never terminate a running updater (R2#1). This is only a low-latency
  # nudge; durability comes from QueueDirectories, not this call.
  "$SELF_SHIP_LAUNCHCTL" kickstart "$target" >/dev/null 2>&1
}

ssr_main() {
  # FLY-727: --issue (e.g. FLY-727) is recorded in the marker so the self-ship ack
  # point can report a high-fidelity, ISSUE-attributed deployment event. Optional +
  # backward compatible (missing → PR-only deployment event; old markers still work).
  local target_sha="" pr="" issue="" dry_run=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --target-sha) target_sha="${2:-}"; shift 2 ;;
      --pr)         pr="${2:-}"; shift 2 ;;
      --issue)      issue="${2:-}"; shift 2 ;;
      --dry-run)    dry_run=1; shift ;;
      *) ssr_log "unknown arg '$1'"; return 64 ;;
    esac
  done

  if ! ssq_is_sha40 "$target_sha"; then
    ssr_log "FATAL: --target-sha must be a 40-hex canonical merge commit SHA (got '${target_sha}'). Refusing handoff."
    return 64
  fi

  if ! command -v jq >/dev/null 2>&1; then
    ssr_log "FATAL: jq not found — cannot build durable marker."
    return 69
  fi

  if [[ "$dry_run" == "1" ]]; then
    ssr_log "DRY RUN: would enqueue ${target_sha} (pr=${pr:-none}) into ${SELF_SHIP_PENDING_DIR} and kickstart ${SELF_SHIP_UPDATER_LABEL}"
    ssr_updater_loaded && ssr_log "DRY RUN: updater job is loaded" || ssr_log "DRY RUN: WARNING updater job NOT loaded"
    return 0
  fi

  if ! ssr_updater_loaded; then
    ssr_log "FATAL: updater job '${SELF_SHIP_UPDATER_LABEL}' is not loaded in gui/$(id -u). QueueDirectories would never fire. Install/enable it (Bootstrap Phase 0) before self-ship handoff."
    return 69
  fi

  local marker
  # 3rd arg is the nonce (empty → auto-generated); 4th is the issue identifier.
  if ! marker="$(ssq_enqueue "$target_sha" "$pr" "" "$issue")"; then
    ssr_log "FATAL: failed to enqueue marker for ${target_sha}."
    return 1
  fi
  ssr_log "enqueued durable marker: ${marker}"

  if ! ssr_kickstart; then
    # FAIL-CLOSE (code-review R1 HIGH-2): `print` can pass for a job that is loaded
    # but DISABLED — then `kickstart` fails AND QueueDirectories won't fire either,
    # so the durable marker would rot while the Runner falsely reports completed.
    # Treat kickstart failure as a hard handoff failure so the Runner does NOT emit
    # a successful session_completed. (The marker is already enqueued; an operator /
    # the next deploy must re-enable the job — it is NOT silently dropped.)
    ssr_log "FATAL: kickstart of ${SELF_SHIP_UPDATER_LABEL} failed (job disabled / not startable?). Marker ${marker} is enqueued but no updater is guaranteed to run — failing handoff so the ship is NOT reported complete."
    return 69
  fi
  ssr_log "handoff OK — Runner may now emit session_completed."
  return 0
}

if [[ "${SELF_SHIP_RESTART_SOURCED:-0}" != "1" ]]; then
  ssr_main "$@"
  exit $?
fi

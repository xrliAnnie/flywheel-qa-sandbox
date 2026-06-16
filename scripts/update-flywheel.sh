#!/usr/bin/env bash
# FLY-270 (was FLY-20): launchd-driven Flywheel updater.
#
# Two trigger sources:
#   • QueueDirectories on ~/.flywheel/self-ship-pending.d  → self-hosting ship
#     handoff (Method B): a flywheel-repo Runner merged a PR and enqueued a
#     durable marker; this updater pulls + deploys + acknowledges the marker.
#   • StartCalendarInterval (00:00 / 12:00)                → fallback sweep:
#     pull origin/main if the deployed-sha is behind, even with no markers.
#
# Durability + at-least-once come from QueueDirectories (launchd keeps/re-launches
# this job while the watched dir is non-empty) PLUS a singleton lock that covers
# the git phase and survives crashes. See scripts/lib/self-ship-queue.sh and
# doc/engineer/plan/new/v1.47.0-FLY-270-self-onboard.md §2.2/§2.3.
#
# Sourceable for tests via UPDATE_FLYWHEEL_SOURCED=1. The deploy step is injectable
# via SELF_SHIP_DEPLOY_CMD so the queue loop is testable without real git/restart.
set -uo pipefail

FLYWHEEL_DIR="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable so a sourced test (UPDATE_FLYWHEEL_SOURCED=1) can point it at
# /dev/null and never pull the real bot token / core-channel into the test shell
# (else severe_alert→notify_discord would POST to the production Discord channel
# on a configured dev machine — FLY-218/220 spam zone; qa-fly-270 finding).
ENV_FILE="${ENV_FILE:-${HOME}/.flywheel/.env}"
DEPLOYED_SHA_FILE="${DEPLOYED_SHA_FILE:-${HOME}/.flywheel/deployed-sha}"

# shellcheck source=/dev/null
[[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }

export SELF_SHIP_QUEUE_SOURCED=1
# shellcheck source=lib/self-ship-queue.sh
source "${SCRIPT_DIR}/lib/self-ship-queue.sh"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [flywheel-updater] $*"; }

DISCORD_CORE_CHANNEL="${DISCORD_CORE_CHANNEL:-1487340532610109520}"
NOTIFY_BOT_TOKEN="${SIMBA_BOT_TOKEN:-${DISCORD_BOT_TOKEN:-}}"
notify_discord() {
  [[ -z "$NOTIFY_BOT_TOKEN" ]] && return 0
  curl -sf -X POST "https://discord.com/api/v10/channels/${DISCORD_CORE_CHANNEL}/messages" \
    -H "Authorization: Bot ${NOTIFY_BOT_TOKEN}" -H "Content-Type: application/json" \
    -d "$(jq -n --arg c "$1" '{content:$c}')" --max-time 5 >/dev/null 2>&1 || true
}
severe_alert() { log "SEVERE: $1"; notify_discord "🚨 $1"; }

# ── Deploy step (injectable) ────────────────────────────────────────────────
# Pull main to origin/main and run the real restart-services.sh. Returns:
#   0  deploy succeeded (deployed-sha advanced by restart-services.sh)
#   2  transient failure (fetch/pull/network)
#   3  deterministic failure (dirty checkout, build/health/lead-restart failure)
default_deploy() {
  # Clean-checkout preflight (single-writer; rollback also requires it).
  if [[ -n "$(git -C "$FLYWHEEL_DIR" status --porcelain 2>/dev/null)" ]]; then
    log "main checkout dirty — refusing deploy (single-writer preflight)"; return 3
  fi
  if ! git -C "$FLYWHEEL_DIR" fetch origin main --quiet 2>/dev/null; then
    log "git fetch failed (transient)"; return 2
  fi
  if ! git -C "$FLYWHEEL_DIR" pull origin main --ff-only --quiet 2>/dev/null; then
    log "git pull --ff-only failed (transient: untracked collision / non-ff)"; return 2
  fi
  if "${SCRIPT_DIR}/restart-services.sh"; then return 0; else
    log "restart-services.sh failed (deterministic)"; return 3
  fi
}
SELF_SHIP_DEPLOY_CMD="${SELF_SHIP_DEPLOY_CMD:-default_deploy}"

deployed_sha() { cat "$DEPLOYED_SHA_FILE" 2>/dev/null || echo ""; }

# ── Process one marker-driven deploy cycle ──────────────────────────────────
# Runs a deploy, then acks every due marker the deploy satisfied; markers that
# don't ack record a failure (classified) and back off / block.
process_due_markers() {
  local rc class
  "$SELF_SHIP_DEPLOY_CMD"; rc=$?
  local deployed; deployed="$(deployed_sha)"
  local f rec
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    if (( rc == 0 )) && ssq_try_ack "$f" "$deployed" "$FLYWHEEL_DIR"; then
      log "acked + cleared marker $(basename "$f") (deployed ${deployed:0:7})"
      continue
    fi
    # Not acked. Distinguish the failure class:
    if (( rc == 0 )); then
      # Deploy SUCCEEDED but the target didn't ack.
      if ! ssq_target_on_origin "$f" "$FLYWHEEL_DIR"; then
        # Target isn't even on origin/main → bad/foreign SHA that will NEVER ack
        # → block NOW (don't retry — code-review R1 / §2.3#8).
        ssq_block "$f" "target-not-on-origin-main"
        severe_alert "Flywheel self-ship marker $(basename "$f") has a target SHA that is NOT on origin/main after a successful deploy — bad/foreign SHA, will never acknowledge. Blocked; needs manual attention."
        continue
      fi
      # Target IS on origin/main but deployed-sha did NOT advance to include it
      # (e.g. restart-services returned 0 on a Lead-SKIP path without advancing
      # deployed-sha — code-review R1 MED-5). This is a real deploy problem, not a
      # network blip → classify DETERMINISTIC so it backs off and BLOCKS+alerts
      # after the threshold instead of retrying forever as transient.
      class="deterministic"
    elif (( rc == 2 )); then
      class="transient"          # fetch/pull flake → retry
    else
      class="deterministic"      # dirty checkout / build / health / lead-restart failure
    fi
    ssq_record_failure "$f" "$class"; rec=$?
    if (( rec == 10 )); then
      ssq_block "$f" "deterministic-threshold"
      severe_alert "Flywheel self-ship marker $(basename "$f") blocked after repeated deterministic failures (last class=$class). Old code still deployed; needs manual attention."
    fi
  done < <(ssq_due_markers)
}

# ── Calendar/manual fallback: deploy if remote is ahead, no markers needed ──
fallback_sweep() {
  git -C "$FLYWHEEL_DIR" fetch origin main --quiet 2>/dev/null || { log "fallback fetch failed"; return 0; }
  local head remote
  head="$(git -C "$FLYWHEEL_DIR" rev-parse HEAD 2>/dev/null)"
  remote="$(git -C "$FLYWHEEL_DIR" rev-parse origin/main 2>/dev/null)"
  if [[ "$head" != "$remote" || "$(deployed_sha)" != "$head" ]]; then
    log "fallback: remote/deployed drift (head ${head:0:7} remote ${remote:0:7}) — deploying"
    "$SELF_SHIP_DEPLOY_CMD" || log "fallback deploy returned non-zero"
  else
    log "fallback: nothing to do"
  fi
}

# ── Main loop ───────────────────────────────────────────────────────────────
update_main() {
  ssq_init_dirs
  if ! ssq_lock_acquire "update-flywheel"; then
    log "another live updater holds the singleton lock — exiting (it will process the queue)"
    return 0
  fi
  trap 'ssq_lock_release' EXIT INT TERM

  local guard=0
  while :; do
    guard=$((guard + 1)); (( guard > 1000 )) && { log "loop guard tripped"; break; }
    # Quarantine any invalid/corrupt entries FIRST so a junk-only watched dir is
    # emptied (else QueueDirectories hot-loops the job — code-review R2 HIGH-1).
    ssq_sweep_invalid
    local pending; pending="$(ssq_pending_count)"
    if (( pending == 0 )); then
      fallback_sweep
      break
    fi
    local due; due="$(ssq_due_markers | grep -c . || true)"
    if (( due == 0 )); then
      log "pending=${pending} but none due — sleeping until earliest nextAttemptAt"
      ssq_sleep_until_due
      continue
    fi
    process_due_markers
  done
  ssq_lock_release
  trap - EXIT INT TERM
}

if [[ "${UPDATE_FLYWHEEL_SOURCED:-0}" != "1" ]]; then
  update_main
  exit $?
fi

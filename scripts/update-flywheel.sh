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

# FLY-1062: a PACKAGED install (tree root carries .flywheel-prebuilt) has no
# git checkout — this git-pull updater is the monorepo self-ship path and must
# not run there. Honest plain-words refusal + pointer at the packaged update
# command. Monorepo trees carry no sentinel, so everything below is verbatim
# unchanged (reverse-compat sentinel: packaged-seams.test.sh). The sourced-test
# seam (UPDATE_FLYWHEEL_SOURCED=1) is exempt so hermetic tests keep working.
if [[ "${UPDATE_FLYWHEEL_SOURCED:-0}" != "1" ]] && [[ -f "$SCRIPT_DIR/../.flywheel-prebuilt" ]]; then
  echo "这台机器上的 Flywheel 是安装包形态,不能用这个老的更新方式。" >&2
  echo "要更新的话,运行你当初安装时用的那条命令,在后面加上 update 就可以了。" >&2
  exit 3
fi
# Overridable so a sourced test (UPDATE_FLYWHEEL_SOURCED=1) can point it at
# /dev/null and never pull the real bot/sender tokens into the test shell
# (else severe_alert→lead-alert.sh would POST to the production alert channel
# on a configured dev machine — FLY-218/220 spam zone; qa-fly-270 finding).
ENV_FILE="${ENV_FILE:-${HOME}/.flywheel/.env}"
DEPLOYED_SHA_FILE="${DEPLOYED_SHA_FILE:-${HOME}/.flywheel/deployed-sha}"

# shellcheck source=/dev/null
[[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }

export SELF_SHIP_QUEUE_SOURCED=1
# shellcheck source=lib/self-ship-queue.sh
source "${SCRIPT_DIR}/lib/self-ship-queue.sh"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [flywheel-updater] $*"; }

# FLY-1081 (FLY-915 pain #3): 🚨 self-ship failures route via lead-alert.sh
# (system identity --lead updater, kind deploy_failed) — the FLY-927 sender
# seam (FLYWHEEL_ALERT_SENDER_TOKEN_ENV), claims dedup and queue/dead-letter
# fail-loud all come for free. The old Simba/bot-token direct-curl
# fallback is deliberately GONE: an unresolvable sender dead-letters +
# meta-alerts inside lead-alert.sh instead of posting as the wrong identity.
# Founder ping (gate-approved hard requirement): FLYWHEEL_FOUNDER_USER_ID
# unset → stderr WARNING + send WITHOUT the @ (degraded, never silent).
# 1>&2 + || true: a failed notification never wedges the self-ship queue loop
# and never pollutes stdout.
severe_alert() { # $1 = signature slug, $2 = body
  log "SEVERE: $2"
  if [[ -z "${FLYWHEEL_FOUNDER_USER_ID:-}" ]]; then
    log "WARNING: FLYWHEEL_FOUNDER_USER_ID not set — deploy_failed alert will NOT @-mention the founder" >&2
  fi
  "${FLYWHEEL_DIR}/scripts/lead-alert.sh" --project flywheel --lead updater \
    --kind deploy_failed --severity severe \
    --title "Flywheel deploy failed" --body "$2" \
    --signature "$1-$(date -u +%Y%m%d%H%M)" \
    ${FLYWHEEL_FOUNDER_USER_ID:+--mention-user "$FLYWHEEL_FOUNDER_USER_ID"} 1>&2 || true
}

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
# FLY-727: report ONE deployment event via `flywheel-comm report-deployed`
# (thin HTTP client → Bridge /api/deployments/report; spools if Bridge down).
# Returns 0 when the event is durable (posted OR spooled), non-zero otherwise.
# The return value is ADVISORY only: the caller (process_due_markers) acks a
# satisfied marker regardless — the report is a best-effort side-effect and must
# never wedge the self-ship deploy (QA FLY-739). A non-zero return just gets logged.
# $1=issueIdentifier(optional) $2=prNumber $3=merge_sha $4=deployed_sha
report_deployment() {
  local issue="$1" pr="$2" merge="$3" deployed="$4"
  local comm="${FLYWHEEL_DIR}/packages/flywheel-comm/dist/index.js"
  # A missing/unbuilt CLI is an environment problem, NOT a reason to wedge the
  # deploy forever (marker never clears). Log loudly and let the ack proceed —
  # deploy availability wins over one lost digest event.
  [[ -f "$comm" ]] || { log "report_deployment: flywheel-comm not built at $comm — skipping deployment report (ack proceeds)"; return 0; }
  local args=(--project flywheel --source self-ship --deploy-batch-id "$deployed")
  ssq_is_sha40 "$merge" 2>/dev/null && args+=(--merge-sha "$merge")
  ssq_is_sha40 "$deployed" 2>/dev/null && args+=(--deployed-sha "$deployed")
  [[ -n "$issue" ]] && args+=(--issue "$issue")
  [[ -n "$pr" ]] && args+=(--pr "$pr")
  # FLY-727 (QA FLY-739): the launchd updater env carries no bridge URL (only PATH;
  # ~/.flywheel/.env has TEAMLEAD_API_TOKEN but no FLYWHEEL_BRIDGE_URL/BRIDGE_URL).
  # Pass an explicit local default so report-deployed can POST (or spool) instead of
  # exiting 2. An operator-set FLYWHEEL_BRIDGE_URL / BRIDGE_URL still wins.
  local bridge_url="${FLYWHEEL_BRIDGE_URL:-${BRIDGE_URL:-http://localhost:9876}}"
  FLYWHEEL_BRIDGE_URL="$bridge_url" node "$comm" report-deployed "${args[@]}"
  local rc=$?
  # 0=posted, 1=spooled (both durable). Any other code is a best-effort miss — the
  # caller acks the marker regardless (deploy availability wins; see process_due_markers).
  (( rc == 0 || rc == 1 ))
}

process_due_markers() {
  local rc class
  "$SELF_SHIP_DEPLOY_CMD"; rc=$?
  local deployed; deployed="$(deployed_sha)"
  local f rec
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    if (( rc == 0 )) && ssq_is_satisfied "$f" "$deployed" "$FLYWHEEL_DIR"; then
      # FLY-727 (QA FLY-739): the deployment-event report is a SECONDARY, best-effort
      # side-effect of a self-ship deploy and must NEVER gate or alert on the PRIMARY
      # concern (the deploy happened → clear the marker). report-deployed is itself
      # durable — it POSTs to the local Bridge or SPOOLs for a later drain — so a
      # satisfied marker is ALWAYS acked. The earlier "report before ack, keep the
      # marker on a non-durable report" design turned an env gap (no bridge URL) into
      # a marker block + severe_alert to Annie on every deploy, a regression that
      # violated AC5 ("zero prod change when default-off"). Report, log, then ack.
      local mtarget mpr missue
      mtarget="$(ssq_marker_field "$f" targetSha)"
      mpr="$(ssq_marker_field "$f" prNumber)"
      missue="$(ssq_marker_field "$f" issueIdentifier)"
      if ! report_deployment "$missue" "$mpr" "$mtarget" "$deployed"; then
        log "marker $(basename "$f") satisfied; deployment-event report not durable (best-effort — digest event may be delayed/lost). Acking anyway; self-ship deploy must not wedge."
      fi
      ssq_delete_ack "$f"
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
        # FLY-1081 (Codex R1#6): the slug carries the marker basename so two
        # DIFFERENT markers blocked in the same minute are not claims-deduped
        # into one alert (eventId embeds the signature).
        severe_alert "marker-not-on-origin-$(basename "$f")" \
          "Flywheel self-ship marker $(basename "$f") has a target SHA that is NOT on origin/main after a successful deploy — bad/foreign SHA, will never acknowledge. Blocked; needs manual attention."
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
      severe_alert "marker-det-threshold-$(basename "$f")" \
        "Flywheel self-ship marker $(basename "$f") blocked after repeated deterministic failures (last class=$class). Old code still deployed; needs manual attention."
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

  # FLY-954: converge <state>/bin BEFORE any deploy decision. This job's plist
  # execs the repo script directly, so it is the ONLY self-heal path that does
  # not depend on a possibly-broken lead wrapper (a stub wrapper exits 0
  # instantly — Lead-start convergence never runs). Non-fatal: deploy
  # availability wins (FLY-739 principle); drift alerts via lead-alert.sh.
  if ! bash "${SCRIPT_DIR}/converge-flywheel-bin.sh" >/dev/null 2>&1; then
    log "converge-flywheel-bin reported unhealthy state (non-fatal; continuing)"
  fi

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

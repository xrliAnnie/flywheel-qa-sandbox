#!/usr/bin/env bash
# FLY-20: Auto-restart Bridge + Lead after merge.
# Core restart script: diff analysis → idle wait → build → restart → health check → notify.
#
# Usage: restart-services.sh [--force] [--wait-idle] [--dry-run] [--reason <text>]
#   --force:       kept for back-compat — skipping the idle wait is now the
#                  DEFAULT (FLY-1224 founder directive). When given together
#                  with --wait-idle, --force wins (idle wait skipped).
#   --wait-idle:   wait for active sessions to go idle before restarting (the
#                  pre-FLY-1224 default). Env FLYWHEEL_RESTART_WAIT_IDLE=1 is
#                  equivalent.
#   --dry-run:     print plan, don't execute
#   --reason:      operator-visible reason included in automatic start/finish
#                  notices (default: manual; examples: deploy, env-change).
#
# Called by:
#   1. Orchestrator/spin post-merge bookkeeping (main path)
#   2. update-flywheel.sh via launchd (fallback)
set -euo pipefail
SCRIPT_START_EPOCH=$(date +%s)

RESTART_NOTICE_STARTED=false
RESTART_TERMINAL_REPORTED=false
RESTART_EXIT_SIGNAL=""
DEPLOY_CONSISTENCY_ARMED=false

# FLY-299: when launched by the launchd updater (com.flywheel.updater), the
# environment may carry only a minimal default PATH that lacks /usr/local/bin,
# so `pnpm`/`node`/`git` are not found and the build silently fails. Prepend the
# dirs where the toolchain lives so this script resolves them regardless of how
# it was invoked (launchd, cron, interactive). Belt-and-suspenders with the
# plist's EnvironmentVariables→PATH.
export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

# ════════════════════════════════════════════════════════════════
# Configuration
# ════════════════════════════════════════════════════════════════

FLYWHEEL_DIR="${HOME}/Dev/flywheel"
DEPLOYED_SHA_FILE="${HOME}/.flywheel/deployed-sha"
LOCK_DIR="${HOME}/.flywheel/restart.lock.d"
SCHEDULER_REPAIR_LOCK_DIR="${FLYWHEEL_SCHEDULER_REPAIR_LOCK_DIR:-${HOME}/.flywheel/scheduler-repair.lock.d}"
# shellcheck source=lib/kill-ledger.sh
if [[ -r "${FLYWHEEL_DIR}/scripts/lib/kill-ledger.sh" ]]; then
    source "${FLYWHEEL_DIR}/scripts/lib/kill-ledger.sh"
else
    # Bridge restart is an explicit forced-shutdown path. If the helper is
    # unavailable during a partial deploy, preserve liveness while emitting a
    # conspicuous unaudited fallback instead of silently skipping the signal.
    flywheel_audited_signal() {
        local source="$1" signal="$2" target_kind="$3" target="$4"
        local exec_id="$5" reason="$6" failure_mode="${7:-fail-closed}"
        if [[ "$failure_mode" != "forced-shutdown-fail-open" ]]; then
            echo "[restart] kill ledger helper unavailable; signal refused" >&2
            return 1
        fi
        printf '{"kind":"KILL_LEDGER_FALLBACK","source":"%s","signal":"%s","targetKind":"%s","target":"%s","executionId":"%s","reason":"%s","ledgerError":"helper_unavailable"}\n' \
            "$source" "$signal" "$target_kind" "$target" "$exec_id" "$reason" >&2
        case "$target_kind" in
            pid) kill -s "$signal" -- "$target" ;;
            pgid) kill -s "$signal" -- "-$target" ;;
            tmux-window) tmux kill-window -t "$target" ;;
            *) return 2 ;;
        esac
    }
fi
# shellcheck source=lib/lead-restart-lifecycle.sh
# shellcheck disable=SC1091
source "${FLYWHEEL_DIR}/scripts/lib/lead-restart-lifecycle.sh"

# shellcheck source=lib/restart-notify.sh
source "${FLYWHEEL_DIR}/scripts/lib/restart-notify.sh"
# shellcheck source=lib/restart-cmux-watcher.sh
source "${FLYWHEEL_DIR}/scripts/lib/restart-cmux-watcher.sh"
# shellcheck source=lib/converge-nonlead-daemons.sh
source "${FLYWHEEL_DIR}/scripts/lib/converge-nonlead-daemons.sh"
LAUNCHD_CENSUS_SOURCED=1
# shellcheck source=launchd-census.sh
source "${FLYWHEEL_DIR}/scripts/launchd-census.sh"
# shellcheck source=lib/deploy-build-identity.sh
source "${FLYWHEEL_DIR}/scripts/lib/deploy-build-identity.sh"
# shellcheck source=lib/default-lead-agent-env.sh
source "${FLYWHEEL_DIR}/scripts/lib/default-lead-agent-env.sh"
# shellcheck source=lib/discord-pointer-guard.sh
# shellcheck disable=SC1091
source "${FLYWHEEL_DIR}/scripts/lib/discord-pointer-guard.sh"
# shellcheck source=lib/supervisor.sh
source "${FLYWHEEL_DIR}/scripts/lib/supervisor.sh"
# shellcheck source=lib/restart-voice-bridge.sh
source "${FLYWHEEL_DIR}/scripts/lib/restart-voice-bridge.sh"
# shellcheck source=lib/tmux-server-rescue.sh
if [[ -f "${FLYWHEEL_DIR}/scripts/lib/tmux-server-rescue.sh" ]]; then
    source "${FLYWHEEL_DIR}/scripts/lib/tmux-server-rescue.sh"
fi
# shellcheck source=lib/legacy-swap-broadcast-retirement.sh
source "${FLYWHEEL_DIR}/scripts/lib/legacy-swap-broadcast-retirement.sh"

# FLY-727 (Codex design review R2#4): mandatory markerless deployment fallback.
# Whenever deployed-sha advances OLD→NEW, report a deployment event per merged
# commit in the range as source=fallback-git-log (inferred). merge_sha = the
# commit hash, which is the SAME identity the self-ship marker/ack path uses, so
# the deploy-events dedup naturally collapses any overlap. Fully best-effort: it
# NEVER affects the deploy outcome (all failures swallowed).
record_deployed_range() {
    local old="$1" new="$2"
    local comm="${FLYWHEEL_DIR}/packages/flywheel-comm/dist/index.js"
    [[ -f "$comm" ]] || return 0
    [[ "$old" =~ ^[0-9a-f]{40}$ ]] || return 0   # need a base commit for the range
    [[ "$new" =~ ^[0-9a-f]{40}$ ]] || return 0
    git -C "$FLYWHEEL_DIR" log --no-merges --format='%H %s' "${old}..${new}" 2>/dev/null | \
    while read -r hash subj; do
        [[ "$hash" =~ ^[0-9a-f]{40}$ ]] || continue
        local issue pr args
        issue=$(printf '%s' "$subj" | grep -oE '[A-Z]+-[0-9]+' | head -1)
        pr=$(printf '%s' "$subj" | grep -oE '#[0-9]+' | head -1 | tr -d '#')
        [[ -z "$issue" && -z "$pr" ]] && continue
        args=(--project flywheel --source fallback-git-log --merge-sha "$hash" --deployed-sha "$new" --deploy-batch-id "$new")
        [[ -n "$issue" ]] && args+=(--issue "$issue")
        [[ -n "$pr" ]] && args+=(--pr "$pr")
        # FLY-727 (QA FLY-739): BRIDGE_URL is a plain local var here (never exported),
        # so the child node saw no bridge URL and report-deployed exited 2 (no row, no
        # spool). Pass it explicitly (default localhost:9876) so the fallback records
        # the event. Best-effort: still swallow failures — this must never fail a deploy.
        FLYWHEEL_BRIDGE_URL="${FLYWHEEL_BRIDGE_URL:-${BRIDGE_URL:-http://localhost:9876}}" \
            node "$comm" report-deployed "${args[@]}" >/dev/null 2>&1 || true
    # FLY-957: `|| true` runs the pipeline in an -e-ignored context (bash
    # extends that suppression into the loop subshell), so a no-match grep —
    # commit subject without an issue/PR marker — leaves the var empty and the
    # range keeps processing instead of killing the whole deploy finalization
    # under set -euo pipefail. Also swallows git-log failures (contract above).
    done || true
    return 0
}
PLUGIN_RESTART_PENDING="${HOME}/.flywheel/plugin-restart-pending"
LEADS_RESTART_STATUS_FILE="${HOME}/.flywheel/leads-restart-status.json"

MAX_WAIT_SECONDS="${RESTART_MAX_WAIT:-300}"   # 5 minutes default (env override: RESTART_MAX_WAIT)
POLL_INTERVAL=30        # seconds between idle checks
BRIDGE_URL="${BRIDGE_URL:-http://localhost:9876}"
ADMISSION_PAUSE_SECONDS="${FLYWHEEL_RESTART_ADMISSION_PAUSE_SECONDS:-1800}"
LEAD_STOP_WAIT_SECONDS="${RESTART_LEAD_STOP_WAIT_SECONDS:-60}"
LEAD_QUIESCENCE_ATTEMPTS="${RESTART_LEAD_QUIESCENCE_ATTEMPTS:-30}"
LEAD_QUIESCENCE_INTERVAL="${RESTART_LEAD_QUIESCENCE_INTERVAL:-1}"
LEAD_VERIFY_ATTEMPTS="${RESTART_LEAD_VERIFY_ATTEMPTS:-30}"
LEAD_VERIFY_INTERVAL="${RESTART_LEAD_VERIFY_INTERVAL:-2}"
if [[ ! "$LEAD_STOP_WAIT_SECONDS" =~ ^[0-9]+$ ]]; then
    echo "[restart] WARNING: invalid RESTART_LEAD_STOP_WAIT_SECONDS; using 60" >&2
    LEAD_STOP_WAIT_SECONDS=60
fi
if [[ ! "$LEAD_QUIESCENCE_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
    echo "[restart] WARNING: invalid RESTART_LEAD_QUIESCENCE_ATTEMPTS; using 30" >&2
    LEAD_QUIESCENCE_ATTEMPTS=30
fi
if [[ ! "$LEAD_QUIESCENCE_INTERVAL" =~ ^[0-9]+$ ]]; then
    echo "[restart] WARNING: invalid RESTART_LEAD_QUIESCENCE_INTERVAL; using 1" >&2
    LEAD_QUIESCENCE_INTERVAL=1
fi
if [[ ! "$LEAD_VERIFY_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
    echo "[restart] WARNING: invalid RESTART_LEAD_VERIFY_ATTEMPTS; using 30" >&2
    LEAD_VERIFY_ATTEMPTS=30
fi
if [[ ! "$LEAD_VERIFY_INTERVAL" =~ ^[0-9]+$ ]]; then
    echo "[restart] WARNING: invalid RESTART_LEAD_VERIFY_INTERVAL; using 2" >&2
    LEAD_VERIFY_INTERVAL=2
fi
if [[ ! "$ADMISSION_PAUSE_SECONDS" =~ ^[1-9][0-9]*$ ]] || (( ADMISSION_PAUSE_SECONDS > 3600 )); then
    echo "[restart] WARNING: invalid FLYWHEEL_RESTART_ADMISSION_PAUSE_SECONDS; using 1800" >&2
    ADMISSION_PAUSE_SECONDS=1800
fi

# ════════════════════════════════════════════════════════════════
# Env loading
# ════════════════════════════════════════════════════════════════

ENV_FILE="${HOME}/.flywheel/.env"
if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    # FLY-80: set -a exports all sourced vars to child processes (Bridge, etc.)
    set -a
    source "$ENV_FILE"
    set +a
else
    echo "[restart] WARNING: $ENV_FILE not found"
fi

# ════════════════════════════════════════════════════════════════
# Utility functions
# ════════════════════════════════════════════════════════════════

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [restart] $*"
}

# FLY-2030: the new required summary assignment schema/rule bundle may activate
# only after the live registry passes BOTH parser entrances and still matches
# its migration receipt. This source-mode preflight runs after pulling main but
# before build, Bridge stop, Lead bootout, or any other service mutation.
summary_registry_activation_preflight() {
    local source_cli="${FLYWHEEL_DIR}/packages/flywheel-comm/src/bin/summary-registry.ts"
    local projects_path="${FLYWHEEL_PROJECTS_FILE:-${HOME}/.flywheel/projects.json}"
    local receipt_path="${FLYWHEEL_SUMMARY_MIGRATION_RECEIPT:-${HOME}/.flywheel/state/summary-registry/migration-receipt.json}"
    if [[ ! -f "$source_cli" ]]; then
        log "ERROR: summary registry activation source CLI is missing; refusing restart fail-closed: $source_cli"
        return 1
    fi
    if [[ -n "${FLYWHEEL_PROJECTS:-}" ]]; then
        log "ERROR: summary registry activation refuses inline FLYWHEEL_PROJECTS split-brain"
        return 1
    fi
    pnpm --dir "$FLYWHEEL_DIR" exec tsx "$source_cli" verify-activation \
        --projects-file "$projects_path" \
        --receipt-file "$receipt_path"
}

# FLY-1638: authenticated Bridge admission brake. The token rides curl's
# stdin config and therefore never appears in argv/process listings.
bridge_admission_request() {
    local action="$1" payload="$2" token="${TEAMLEAD_API_TOKEN:-}"
    [[ -n "$token" ]] || return 1
    curl -sf -X POST "${BRIDGE_URL}/api/admission/${action}" \
        -H "Content-Type: application/json" \
        -d "$payload" --max-time 5 -K - <<CURLCFG
header = "Authorization: Bearer ${token}"
CURLCFG
}

restart_admission_file_mode() {
    local path="$1" mode=""
    if stat -c %a "$path" >/dev/null 2>&1; then
        mode="$(stat -c %a "$path" 2>/dev/null || true)"
        if [[ "$mode" =~ ^[0-7]{3,4}$ ]]; then
            printf '%s\n' "$mode"
            return 0
        fi
    fi
    if stat -f %Lp "$path" >/dev/null 2>&1; then
        mode="$(stat -f %Lp "$path" 2>/dev/null || true)"
        if [[ "$mode" =~ ^[0-7]{3,4}$ ]]; then
            printf '%s\n' "$mode"
            return 0
        fi
    fi
    return 1
}

cutover_legacy_pause_pending() {
    local receipt="${FLYWHEEL_HOST_CUTOVER_RECEIPT:-${HOME}/.flywheel/state/host-terminal-cutover.json}" mode=""
    [[ -f "$receipt" && ! -L "$receipt" ]] || return 1
    mode="$(restart_admission_file_mode "$receipt" || true)"
    [[ "$mode" == "600" ]] || return 1
    jq -e '.status == "paused" and ((.pause.leaseId // "") == "")' \
        "$receipt" >/dev/null 2>&1
}

restart_admission_receipt_path() {
    printf '%s\n' "${HOME}/.flywheel/state/restart-services-admission-pause-$$.json"
}

write_restart_admission_receipt() {
    local pause_identifier="$1" receipt state_dir temporary created_at
    receipt="$(restart_admission_receipt_path)"
    state_dir="$(dirname "$receipt")"
    temporary="${receipt}.tmp.$$"
    created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    mkdir -p "$state_dir" || return 1
    chmod 700 "$state_dir" || return 1
    (umask 077; jq -n --argjson pid "$$" --arg createdAt "$created_at" \
        --arg pauseIdentifier "$pause_identifier" \
        '{pid:$pid,createdAt:$createdAt,pauseIdentifier:$pauseIdentifier}' > "$temporary") \
        || return 1
    chmod 600 "$temporary" || return 1
    mv -f "$temporary" "$receipt" || return 1
}

read_restart_admission_identifier() {
    local receipt mode
    receipt="$(restart_admission_receipt_path)"
    [[ -f "$receipt" && ! -L "$receipt" ]] || return 1
    mode="$(restart_admission_file_mode "$receipt" || true)"
    [[ "$mode" == "600" ]] || return 1
    jq -er --argjson pid "$$" \
        'select(.pid == $pid and (.createdAt | type == "string"))
         | .pauseIdentifier
         | select(type == "string" and startswith("restart-services:"))' \
        "$receipt" 2>/dev/null
}

clear_restart_admission_receipt() {
    local receipt
    receipt="$(restart_admission_receipt_path)"
    rm -f "$receipt"
}

record_admission_takeover_lapse() {
    local cutover_owner="$1" receipt temporary filter
    if [[ "$cutover_owner" == "true" ]]; then
        receipt="${FLYWHEEL_HOST_CUTOVER_RECEIPT:-${HOME}/.flywheel/state/host-terminal-cutover.json}"
        filter='.pause.reacquiredAfterLapse = true'
    else
        receipt="$(restart_admission_receipt_path)"
        filter='.reacquiredAfterLapse = true'
    fi
    [[ -f "$receipt" && ! -L "$receipt" ]] || return 1
    [[ "$(restart_admission_file_mode "$receipt" || true)" == "600" ]] || return 1
    temporary="${receipt}.tmp.$$"
    (umask 077; jq "$filter" "$receipt" > "$temporary") || {
        rm -f "$temporary"
        return 1
    }
    chmod 600 "$temporary" || { rm -f "$temporary"; return 1; }
    mv -f "$temporary" "$receipt"
}

write_cutover_admission_lease_handoff() {
    local lease_id="$1"
    local receipt="${FLYWHEEL_HOST_CUTOVER_RECEIPT:-${HOME}/.flywheel/state/host-terminal-cutover.json}"
    local state_dir
    state_dir="$(dirname "$receipt")"
    local handoff="${state_dir}/host-terminal-cutover.admission-lease-id"
    local temporary="${handoff}.tmp.$$"
    [[ "$lease_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] \
        || return 1
    mkdir -p "$state_dir" || return 1
    chmod 700 "$state_dir" || return 1
    (umask 077; printf '%s\n' "$lease_id" > "$temporary") || return 1
    chmod 600 "$temporary" || return 1
    mv -f "$temporary" "$handoff" || return 1
    return 0
}

pause_admission_best_effort() {
    local payload response lease_id="" owned_lease_id="${ADMISSION_PAUSE_LEASE_ID:-}"
    local cutover_pending=false pause_identifier
    case "${RESTART_REASON}" in
        *[!a-zA-Z0-9._-]*) pause_identifier="restart-services:deploy:pid=$$:started=$(date -u +%Y-%m-%dT%H:%M:%SZ)" ;;
        *) pause_identifier="restart-services:${RESTART_REASON}:pid=$$:started=$(date -u +%Y-%m-%dT%H:%M:%SZ)" ;;
    esac
    if cutover_legacy_pause_pending; then
        cutover_pending=true
        ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER=true
        ADMISSION_PAUSE_RELEASE_ON_EXIT=false
    else
        ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER=false
        ADMISSION_PAUSE_RELEASE_ON_EXIT=true
    fi
    payload=$(jq -n \
        --argjson durationSeconds "$ADMISSION_PAUSE_SECONDS" \
        --arg reason "$pause_identifier" \
        --arg leaseId "$owned_lease_id" \
        '{durationSeconds: $durationSeconds, reason: $reason}
         + (if $leaseId == "" then {} else {leaseId: $leaseId} end)')
    if response=$(bridge_admission_request pause "$payload"); then
        if jq -e '.admissionPause.reacquiredAfterLapse == true' <<<"$response" >/dev/null 2>&1; then
            log "WARNING: Bridge admission owner lease was reacquired after expiry; admission continuity was broken"
        fi
        lease_id=$(jq -r '.admissionPause.leaseId // empty' <<<"$response" 2>/dev/null || true)
        if [[ "$lease_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
            ADMISSION_PAUSE_LEASE_ID="$lease_id"
            if [[ "$cutover_pending" == "true" ]]; then
                if ! write_cutover_admission_lease_handoff "$lease_id"; then
                    log "ERROR: cutover admission lease handoff could not be written; refusing to continue"
                    return 1
                fi
                ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER=false
                ADMISSION_PAUSE_RELEASE_ON_EXIT=false
                log "Bridge admission cutover lease adopted and handed off; restart will not resume it"
            else
                ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER=false
                ADMISSION_PAUSE_RELEASE_ON_EXIT=true
                log "Bridge admission paused for ${ADMISSION_PAUSE_SECONDS}s with owner lease"
            fi
        else
            ADMISSION_PAUSE_LEASE_ID=""
            if [[ "$cutover_pending" == "true" ]]; then
                ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER=true
                log "WARNING: Bridge admission paused without an owner lease id; preserving the cutover brake for post-deploy takeover"
            elif write_restart_admission_receipt "$pause_identifier"; then
                ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER=true
                log "WARNING: Bridge admission paused without an owner lease id; preserving this wave's brake for post-deploy takeover"
            else
                ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER=false
                log "WARNING: Bridge admission paused without an owner lease id but its run-local receipt could not be written; preserving the brake without takeover"
            fi
        fi
    else
        # Bootstrap compatibility: the pre-feature Bridge answers 404. Phase 1
        # is intentionally best-effort; TTL protects pause-aware versions.
        log "WARNING: admission pause unavailable (pre-feature Bridge, foreign owner, or control API failure); no owned admission lease acquired; preserving any existing brake"
    fi
    return 0
}

takeover_cutover_admission_pause_after_bridge_health() {
    [[ "${ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER:-false}" == "true" ]] || return 0
    local payload response lease_id="" cutover_owner=false expected_legacy_reason=""
    [[ "${ADMISSION_PAUSE_RELEASE_ON_EXIT:-true}" == "true" ]] || cutover_owner=true
    if [[ "$cutover_owner" == "true" ]]; then
        local receipt="${FLYWHEEL_HOST_CUTOVER_RECEIPT:-${HOME}/.flywheel/state/host-terminal-cutover.json}"
        expected_legacy_reason=$(jq -er '.pause.reason | select(type == "string" and length > 0 and length <= 200)' "$receipt" 2>/dev/null) || {
            log "ERROR: cutover receipt has no valid legacy pause identifier"
            return 1
        }
    else
        expected_legacy_reason=$(read_restart_admission_identifier) || {
            ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER=false
            log "WARNING: ordinary deploy has no run-local receipt; preserving the foreign NULL-owner brake"
            return 0
        }
    fi
    payload=$(jq -n \
        --argjson durationSeconds "$ADMISSION_PAUSE_SECONDS" \
        --arg reason "restart-services:${RESTART_REASON}:cutover-takeover" \
        --arg expectedLegacyReason "$expected_legacy_reason" \
        '{durationSeconds: $durationSeconds, reason: $reason, expectedLegacyReason:$expectedLegacyReason}')
    if ! response=$(bridge_admission_request pause "$payload"); then
        if [[ "$cutover_owner" == "true" ]]; then
            log "ERROR: new Bridge could not take ownership of the legacy cutover pause"
            return 1
        fi
        ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER=false
        clear_restart_admission_receipt || true
        log "WARNING: ordinary deploy could not take ownership of the legacy NULL-owner pause; preserving the foreign brake and continuing"
        return 0
    fi
    if jq -e '.admissionPause.reacquiredAfterLapse == true' <<<"$response" >/dev/null 2>&1; then
        log "WARNING: Bridge admission legacy pause was reacquired after expiry; admission continuity was broken"
        if ! record_admission_takeover_lapse "$cutover_owner"; then
            log "ERROR: legacy admission lapse evidence could not be written to the owning receipt"
            return 1
        fi
    fi
    lease_id=$(jq -r '.admissionPause.leaseId // empty' <<<"$response" 2>/dev/null || true)
    if [[ ! "$lease_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
        if [[ "$cutover_owner" == "true" ]]; then
            log "ERROR: new Bridge did not return a valid owner for the legacy cutover pause"
            return 1
        fi
        ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER=false
        clear_restart_admission_receipt || true
        log "WARNING: ordinary deploy takeover returned no valid owner lease; preserving the brake and continuing"
        return 0
    fi
    if [[ "$cutover_owner" == "true" ]]; then
        if ! write_cutover_admission_lease_handoff "$lease_id"; then
            log "ERROR: cutover admission lease handoff could not be written; refusing the Lead wave"
            return 1
        fi
    fi
    ADMISSION_PAUSE_LEASE_ID="$lease_id"
    ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER=false
    if [[ "$cutover_owner" == "true" ]]; then
        ADMISSION_PAUSE_RELEASE_ON_EXIT=false
        log "Bridge admission legacy pause atomically adopted; owner handoff is durable and restart will not resume it"
    else
        ADMISSION_PAUSE_RELEASE_ON_EXIT=true
        log "Bridge admission legacy pause atomically adopted for release after the Lead wave"
    fi
    return 0
}

resume_admission_best_effort() {
    local lease_id="${ADMISSION_PAUSE_LEASE_ID:-}" payload response
    if [[ "${ADMISSION_PAUSE_RELEASE_ON_EXIT:-true}" != "true" ]]; then
        log "Bridge admission cutover lease belongs to the host transaction; preserving the brake"
        return 0
    fi
    if [[ -z "$lease_id" ]]; then
        log "WARNING: no owner lease id; preserving the admission brake for post-deploy takeover"
        return 0
    fi
    payload=$(jq -n --arg leaseId "$lease_id" '{leaseId: $leaseId}')
    if response=$(bridge_admission_request resume "$payload"); then
        if jq -e '.admissionPause.leaseLapsed == true' <<<"$response" >/dev/null 2>&1; then
            log "WARNING: admission brake had already expired before resume; admission continuity was broken"
        fi
        ADMISSION_PAUSE_LEASE_ID=""
        clear_restart_admission_receipt || true
        log "Bridge admission resumed"
    else
        log "WARNING: owner-qualified admission resume unavailable; preserving the brake until TTL"
    fi
    return 0
}

file_mtime_epoch() {
    local path="$1" mtime
    if mtime=$(stat -f %m "$path" 2>/dev/null) && [[ "$mtime" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$mtime"
        return 0
    fi
    if mtime=$(stat -c %Y "$path" 2>/dev/null) && [[ "$mtime" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$mtime"
        return 0
    fi
    return 1
}

# FLY-1434: code deployment truth and Lead restart health are independent.
# deployed-sha records which code is active; this atomic status record preserves
# degraded Lead evidence without lying that the code failed to deploy.
write_leads_restart_status() {
    local status="$1" failed="$2" skipped="$3" total="$4"
    local status_dir tmp
    status_dir="$(dirname "$LEADS_RESTART_STATUS_FILE")"
    mkdir -p "$status_dir" || return 1
    tmp=$(mktemp "${status_dir}/.leads-restart-status.XXXXXX") || return 1
    if ! jq -n \
        --arg sha "$CURRENT_HEAD" \
        --arg status "$status" \
        --arg reason "$RESTART_REASON" \
        --arg recordedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson failed "$failed" \
        --argjson skipped "$skipped" \
        --argjson total "$total" \
        '{
          schemaVersion: 1,
          codeDeployedSha: $sha,
          leadsRestartStatus: $status,
          failed: $failed,
          skipped: $skipped,
          total: $total,
          reason: $reason,
          recordedAt: $recordedAt
        }' > "$tmp"; then
        rm -f "$tmp"
        return 1
    fi
    chmod 600 "$tmp"
    mv -f "$tmp" "$LEADS_RESTART_STATUS_FILE"
}

# Discord-INDEPENDENT trace (desktop + <state>/meta-alert file; per-reason
# 10min debounce lives inside meta-alert.sh). Best-effort — never fails the
# caller, never blocks the deploy.
fire_meta_alert() {
    # $1 = reason, $2 = title, $3 = body
    [[ -x "${FLYWHEEL_DIR}/scripts/meta-alert.sh" ]] && \
        "${FLYWHEEL_DIR}/scripts/meta-alert.sh" "$1" "$2" "$3" || true
}

# FLY-1659: audit detached same-uid tmux servers before a fleet restart. This
# is intentionally observation-only: ppid=1 is shared by abandoned QA servers
# and legitimate daemons, so it is not deletion authority. The production
# default socket and the operator-owned atlas socket are allowlisted; every
# other socket is logged with its session census. A foreign socket using the
# production-reserved `flywheel` session name additionally raises a severe
# alert, but never receives a signal or tmux mutation.
audit_tmux_qa_residue_read_only() {
    local current_uid timeout rows uid pid ppid command argv0 socket_rows line
    local socket normalized_socket session_rows session_csv session_name has_reserved allowlist
    local default_root default_socket seen_sockets="" normalized_allowlist=""
    local allow normalized_allow old_ifs
    if ! type tmux_rescue_probe >/dev/null 2>&1 \
        || ! type _tmux_rescue_normalize_socket >/dev/null 2>&1; then
        log "WARNING: tmux QA residue audit unavailable (bounded probe library missing)"
        return 0
    fi
    current_uid="$(id -u 2>/dev/null)" || {
        log "WARNING: tmux QA residue audit could not read the current uid"
        return 0
    }
    timeout="${FLYWHEEL_TMUX_AUDIT_TIMEOUT_SEC:-3}"
    [[ "$timeout" =~ ^[1-9][0-9]*$ ]] || timeout=3
    default_root="${TMUX_TMPDIR:-/tmp}/tmux-${current_uid}"
    default_socket="${FLYWHEEL_TMUX_AUDIT_DEFAULT_SOCKET:-${default_root}/default}"
    allowlist="${default_socket}:${default_root}/atlas"
    [[ -z "${FLYWHEEL_TMUX_AUDIT_ALLOWLIST:-}" ]] \
        || allowlist="${allowlist}:${FLYWHEEL_TMUX_AUDIT_ALLOWLIST}"
    old_ifs="$IFS"
    IFS=:
    for allow in $allowlist; do
        if normalized_allow="$(_tmux_rescue_normalize_socket "$allow" 2>/dev/null)"; then
            normalized_allowlist="${normalized_allowlist}${normalized_allowlist:+$'\n'}${normalized_allow}"
        else
            log "WARNING: tmux QA residue audit could not normalize allowlisted socket ${allow}"
        fi
    done
    IFS="$old_ifs"

    rows="$(tmux_rescue_probe "$timeout" \
        ps axww -o uid= -o pid= -o ppid= -o command= 2>/dev/null)" || {
        log "WARNING: tmux QA residue audit process census was unavailable"
        return 0
    }
    while read -r uid pid ppid command; do
        [[ "$uid" == "$current_uid" && "$ppid" == 1 && "$pid" =~ ^[1-9][0-9]*$ ]] \
            || continue
        argv0="${command%% *}"
        case "$argv0" in
            tmux|*/tmux) ;;
            *) [[ "$command" == *"tmux: server"* || "$command" == *"tmux server"* ]] \
                || continue ;;
        esac

        socket_rows="$(tmux_rescue_probe "$timeout" \
            lsof -a -p "$pid" -U -Fn 2>/dev/null)" || {
            log "WARNING: tmux QA residue audit socket census failed for pid=$pid"
            continue
        }
        while IFS= read -r line; do
            [[ "$line" == n/* ]] || continue
            socket="${line#n}"
            [[ "$socket" == *' type=STREAM' ]] && socket="${socket% type=STREAM}"
            [[ "$socket" == /* ]] || continue
            if ! normalized_socket="$(_tmux_rescue_normalize_socket "$socket" 2>/dev/null)"; then
                log "WARNING: tmux QA residue audit could not normalize socket for pid=$pid"
                continue
            fi
            if printf '%s\n' "$seen_sockets" | grep -Fqx -- "$normalized_socket"; then
                continue
            fi
            seen_sockets="${seen_sockets}${seen_sockets:+$'\n'}${normalized_socket}"

            if printf '%s\n' "$normalized_allowlist" | grep -Fqx -- "$normalized_socket"; then
                continue
            fi

            session_rows="$(tmux_rescue_probe "$timeout" \
                tmux -S "$socket" -N list-sessions -F '#{session_name}' 2>/dev/null)" \
                || session_rows="<unreadable>"
            session_csv="$(printf '%s\n' "$session_rows" \
                | awk 'NF { if (out != "") out=out ","; out=out $0 } END { print out }')"
            [[ -n "$session_csv" ]] || session_csv="<none>"
            log "WARNING: non-production tmux server audit pid=${pid} socket=${socket} sessions=${session_csv}"

            has_reserved=false
            while IFS= read -r session_name; do
                [[ "$session_name" == flywheel ]] && has_reserved=true
            done <<< "$session_rows"
            if [[ "$has_reserved" == true ]]; then
                alert_severe "tmux-qa-residue-flywheel-session" \
                    "QA tmux server uses the production session name" \
                    "检测到非生产 tmux socket ${socket} (PID ${pid}) 使用保留 session 名 flywheel。restart 只读审计未做清理；请按 operator 手册核实并移除残留。"
            fi
        done <<< "$socket_rows"
    done <<< "$rows"
    return 0
}

# FLY-1081 (FLY-915 pain #3): ⚠️/🚨 deploy notices route through lead-alert.sh
# — the FLY-927 sender seam (FLYWHEEL_ALERT_SENDER_TOKEN_ENV), claims dedup,
# queue/dead-letter fail-loud all come for free. There is deliberately NO
# Simba/legacy-bot-token fallback anymore: an unresolvable sender is
# lead-alert.sh's dead-letter + meta-alert, never a mis-attributed post.
#
# stdout discipline: these helpers are reachable from command-substitution
# paths (bp_fail_loud inside the $(bp_confirm_port_released …) chain), so they
# must NEVER write stdout — diagnostics go to stderr, and the lead-alert.sh
# call is redirected 1>&2 (its own logs are stderr already; stdout only speaks
# under --strict-delivery, unused here). Do NOT >/dev/null 2>&1 — that would
# swallow lead-alert.sh's ERROR traces from the deploy log.
# `|| true`: a failed notification must never block the deploy (FLY-739).
alert_warning() {
    # $1 = signature slug, $2 = title, $3 = body
    "${FLYWHEEL_DIR}/scripts/lead-alert.sh" --project flywheel --lead deploy \
        --kind deploy_degraded --severity warning --title "$2" --body "$3" \
        --signature "$1-$(date -u +%Y%m%d%H%M)" 1>&2 || true
}

# Launchd convergence and census share one alert surface. Even when both report
# overlapping failures, restart emits only census_alert's UTC-day plus anomaly
# set signature; the legacy minute-level deploy warning remains for non-launchd
# restart degradation below.
restart_report_launchd_census() {
    local census_state="$1" summary="$2" census_detail="$3" census_anomaly="$4"
    local nonlead_state="$5" nonlead_detail="$6" alert_detail="$census_detail"
    local alert_key="${LAUNCHD_CENSUS_ALERT_KEY:-}"
    log "launchd census: ${census_state} ${summary}"
    if [[ "$nonlead_state" != healthy ]]; then
        log "WARNING: non-Lead daemon convergence=${nonlead_state}: ${nonlead_detail}"
        alert_detail="${alert_detail}${alert_detail:+; }convergence=${nonlead_state}: ${nonlead_detail}"
        [[ -n "$alert_key" ]] || alert_key="convergence:${nonlead_state}"
    fi
    [[ -n "$alert_key" ]] || alert_key="census-state:${census_state}"
    if [[ "$census_anomaly" == 1 || "$nonlead_state" != healthy ]]; then
        log "WARNING: launchd census anomaly — ${alert_detail}"
        census_alert "$summary" "$alert_detail" "$alert_key"
    fi
    return 0
}

alert_severe() {
    # $1 = signature slug, $2 = title, $3 = body
    # deploy_failed must @-mention the founder (gate-approved hard requirement).
    # FLYWHEEL_FOUNDER_USER_ID unset → WARNING trace + send WITHOUT the ping
    # (degraded, never silent, never blocking).
    if [[ -z "${FLYWHEEL_FOUNDER_USER_ID:-}" ]]; then
        log "WARNING: FLYWHEEL_FOUNDER_USER_ID not set — deploy_failed alert will NOT @-mention the founder" >&2
    fi
    "${FLYWHEEL_DIR}/scripts/lead-alert.sh" --project flywheel --lead deploy \
        --kind deploy_failed --severity severe --title "$2" --body "$3" \
        --signature "$1-$(date -u +%Y%m%d%H%M)" \
        ${FLYWHEEL_FOUNDER_USER_ID:+--mention-user "$FLYWHEEL_FOUNDER_USER_ID"} 1>&2 || true
}

alert_discord_plugin_integrity() {
    # $1 = daily signature reason, $2 = diagnostic body
    "${FLYWHEEL_DIR}/scripts/lead-alert.sh" --project flywheel --lead deploy \
        --kind discord_plugin_integrity_failed --severity severe \
        --title "Discord plugin integrity failed" --body "$2" \
        --signature "$1-$(date -u +%Y%m%d)" 1>&2 || true
}

alert_launchd_refusal() {
    # A refused repeating job can relaunch every few seconds. Keep this
    # signature daily so the safe refusal loop cannot become an alert storm.
    if [[ -z "${FLYWHEEL_FOUNDER_USER_ID:-}" ]]; then
        log "WARNING: FLYWHEEL_FOUNDER_USER_ID not set — deploy_failed alert will NOT @-mention the founder" >&2
    fi
    "${FLYWHEEL_DIR}/scripts/lead-alert.sh" --project flywheel --lead deploy \
        --kind deploy_failed --severity severe \
        --title "restart-services refused a direct launchd invocation" --body "$1" \
        --signature "restart-guard-launchd-refusal-$(date -u +%Y%m%d)" \
        ${FLYWHEEL_FOUNDER_USER_ID:+--mention-user "$FLYWHEEL_FOUNDER_USER_ID"} 1>&2 || true
}

# FLY-929 W3b ②: ROUTINE notices (✅/🔄/⏳ — progress/result, no human action
# needed) ride the Claude Infra Bot → #flywheel-notify when BOTH
# CLAUDE_INFRA_BOT_TOKEN and FLYWHEEL_NOTIFY_CHANNEL are set (P-identity).
# FLY-1081 (Codex R1#4): the old silent fallback to Simba is GONE — env not
# fully set means loud refusal (stderr ERROR + meta-alert) and a failed POST
# leaves the same trace. Both paths return 0: routine notices never block a
# deploy.
notify_routine() {
    local message="$1"
    if [[ -n "${CLAUDE_INFRA_BOT_TOKEN:-}" && -n "${FLYWHEEL_NOTIFY_CHANNEL:-}" ]]; then
        local payload rc=0
        payload=$(jq -n --arg content "$message" '{content: $content}')
        # Token rides a curl stdin config (`-K -`), never argv — same
        # lead-alert.sh / FLY-510 convention (Codex code R1 MEDIUM).
        curl -sf -X POST "https://discord.com/api/v10/channels/${FLYWHEEL_NOTIFY_CHANNEL}/messages" \
            -H "Content-Type: application/json" \
            -d "$payload" \
            --max-time 5 -K - >/dev/null <<CURLCFG || rc=$?
header = "Authorization: Bot ${CLAUDE_INFRA_BOT_TOKEN}"
CURLCFG
        if (( rc != 0 )); then
            log "ERROR: routine notify POST failed (channel=${FLYWHEEL_NOTIFY_CHANNEL})" >&2
            fire_meta_alert "routine_notify_failed" "Flywheel routine notify failed" \
                "notify_routine POST to FLYWHEEL_NOTIFY_CHANNEL failed; dropped notice: ${message}"
        fi
        return 0
    fi
    log "ERROR: routine notify unconfigured (CLAUDE_INFRA_BOT_TOKEN/FLYWHEEL_NOTIFY_CHANNEL missing) — NOT falling back" >&2
    fire_meta_alert "notify_routine_unconfigured" "Flywheel routine notify unconfigured" \
        "CLAUDE_INFRA_BOT_TOKEN / FLYWHEEL_NOTIFY_CHANNEL missing; dropped notice: ${message}"
    return 0
}

# FLY-1743: once a run owns the deploy transaction, every terminal path must
# converge source HEAD and the deployed artifact ledger. This deliberately
# checks the result state rather than enumerating failure steps: later steps
# can change without reopening a silent source/deployed split.
verify_deploy_consistency_on_exit() {
    [[ "$DEPLOY_CONSISTENCY_ARMED" == "true" ]] || return 0
    [[ "$DRY_RUN" == "true" ]] && return 0

    local final_head="" head_rc=0 final_deployed="" deployed_rc=0
    local deployed_display=""

    final_head="$(git -C "$FLYWHEEL_DIR" rev-parse --verify HEAD 2>/dev/null)" || head_rc=$?
    if (( head_rc != 0 )) || [[ -z "$final_head" ]]; then
        log "ERROR: deploy consistency check could not read source HEAD at exit (rc=${head_rc})" >&2
        alert_severe "restart-deploy-consistency-unverifiable" \
            "Flywheel deploy end-state unverifiable" \
            "重启结束时无法读取 ${FLYWHEEL_DIR} 的 HEAD (git rev-parse rc=${head_rc}),无法证明源码与 deployed-sha 账本一致。请人工核对后 deliberate 重跑。"
        return 1
    fi

    if [[ -f "$DEPLOYED_SHA_FILE" ]]; then
        final_deployed="$(cat "$DEPLOYED_SHA_FILE" 2>/dev/null)" || deployed_rc=$?
        if (( deployed_rc != 0 )); then
            log "ERROR: deploy consistency check could not read ${DEPLOYED_SHA_FILE} (rc=${deployed_rc})" >&2
            alert_severe "restart-deploy-consistency-unverifiable" \
                "Flywheel deploy end-state unverifiable" \
                "重启结束时 deployed-sha 账本存在但读取失败 (rc=${deployed_rc}),无法证明源码与已部署产物一致。源码 HEAD=\`${final_head:0:7}\`。请人工核对后 deliberate 重跑。"
            return 1
        fi
    fi

    if [[ -n "$final_deployed" && "$final_head" == "$final_deployed" ]]; then
        return 0
    fi

    deployed_display="${final_deployed:-missing}"
    [[ "$deployed_display" == "missing" ]] || deployed_display="${deployed_display:0:7}"
    log "ERROR: deploy did not converge — source HEAD ${final_head:0:7} vs deployed-sha ${deployed_display}" >&2
    alert_severe "restart-source-deployed-mismatch" \
        "Flywheel source and deployed ledger differ" \
        "重启退出时源码 HEAD=\`${final_head:0:7}\` 与 deployed-sha=\`${deployed_display}\` 不一致——部署事务未收敛。系统可能仍在运行,但下一次构建/部署决策会基于不一致状态。请 deliberate 重跑 restart 完成部署,或按 runbook 回滚;不要手工 reset。退出码已置非零。"
    return 1
}

# FLY-1603: once a human-visible progress notice has been emitted, every exit
# must have exactly one terminal outcome. Known terminal branches set
# RESTART_TERMINAL_REPORTED themselves; this finalizer covers only unexpected
# exits and never routes routine output to the founder's Core channel.
restart_on_exit() {
    local original_rc="${1:-1}"
    local end_epoch="" duration="unknown" body="" path=""
    local old_display="${DEPLOYED_SHA:-unknown}"
    local new_display="${CURRENT_HEAD:-unknown}"
    trap - EXIT INT TERM
    set +e

    old_display="${old_display:0:7}"
    new_display="${new_display:0:7}"

    if [[ "$RESTART_NOTICE_STARTED" == "true" && "$RESTART_TERMINAL_REPORTED" != "true" ]]; then
        end_epoch=$(date +%s 2>/dev/null) || end_epoch=""
        if [[ "$SCRIPT_START_EPOCH" =~ ^[0-9]+$ && "$end_epoch" =~ ^[0-9]+$ ]] \
          && (( end_epoch >= SCRIPT_START_EPOCH )); then
            duration=$(rn_format_duration "$((end_epoch - SCRIPT_START_EPOCH))")
        fi
        body="Flywheel 全量重启异常终止，状态未知。版本 \`${old_display}\` → \`${new_display}\`，reason=${RESTART_REASON:-unknown}，总耗时 ${duration}，退出码 ${original_rc}。请查部署日志。"
        if [[ "$RESTART_EXIT_SIGNAL" == "INT" ]]; then
            alert_warning "restart-cancelled-by-operator" "Flywheel restart cancelled" \
                "操作员取消了全量重启，当前状态未知。版本 \`${old_display}\` → \`${new_display}\`，reason=${RESTART_REASON:-unknown}，总耗时 ${duration}。请查部署日志。"
        else
            alert_severe "restart-aborted-unexpectedly" "Flywheel restart aborted" "$body"
        fi
    fi

    if ! verify_deploy_consistency_on_exit; then
        if [[ "$original_rc" == "0" ]]; then
            original_rc=1
        fi
    fi

    rmdir "$LOCK_DIR" 2>/dev/null || true
    rm -f "${PROJECT_SHA_UPDATES_FILE:-}" 2>/dev/null || true
    rm -f "${LEAD_RESTART_NAMES_FILE:-}" 2>/dev/null || true
    while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        rm -f -- "$path" 2>/dev/null || true
    done <<< "${RESTART_TRANSIENT_FILES:-}"
    exit "$original_rc"
}

# ════════════════════════════════════════════════════════════════
# Discord plugin fork detection
# ════════════════════════════════════════════════════════════════

DISCORD_PLUGIN_UPDATE="${HOME}/.flywheel/bin/update-discord-plugin.sh"
DISCORD_PLUGIN_CHECK="${HOME}/.flywheel/bin/check-discord-plugin.sh"
DISCORD_PLUGIN_CONTRACT="discord@flywheel-plugins/v1"

# FLY-1729: update the single-writer production main checkout before any build
# or service-restart decision. The caller owns restart.lock.d, so fetch/merge
# cannot race another restart's build. Dry-run fetches remote truth but never
# moves HEAD, the index, or the working tree.
restart_host_tmux_gate() {
    local target_sha="$1" carrier="$2" mount_point="$3"
    local state_dir="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
    local gate_bin="${state_dir}/bin/host-tmux-selection-gate.sh" rc=0
    [[ "$target_sha" =~ ^[0-9a-fA-F]{40}$ ]] || return 2
    if [[ ! -x "$gate_bin" ]]; then
        gate_bin="${FLYWHEEL_DIR}/scripts/host-tmux-selection-gate.sh"
    fi
    [[ -f "$gate_bin" && ! -L "$gate_bin" && -x "$gate_bin" ]] || return 127
    (
        # do_restart_all_leads owns a single-line stdout contract. Keep every
        # host-tmux diagnostic on stderr even when the child writes stdout.
        unset FLYWHEEL_HOST_TMUX_GATE_TEST_MODE \
          FLYWHEEL_HOST_TMUX_POST_S1_PATH \
          FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH \
          FLYWHEEL_HOST_TMUX_FILE_BIN \
          FLYWHEEL_HOST_TMUX_HOST_ID \
          FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH \
          FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS \
          FLYWHEEL_HOST_TMUX_GATE_APPLICABILITY \
          FLYWHEEL_HOST_TMUX_CENSUS_PLIST_DIR \
          FLYWHEEL_HOST_TMUX_CENSUS_SOURCE_DIR
        FLYWHEEL_STATE_DIR="$state_dir" \
        FLYWHEEL_HOST_TMUX_TARGET_SHA="$target_sha" \
        FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="${carrier}:${target_sha}" \
        FLYWHEEL_HOST_TMUX_MOUNT_POINT="$mount_point" \
          "$gate_bin" gate "$carrier" 1>&2 || rc=$?
        if (( rc == 0 )); then
            FLYWHEEL_STATE_DIR="$state_dir" \
            FLYWHEEL_HOST_TMUX_TARGET_SHA="$target_sha" \
            FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="${carrier}:${target_sha}" \
            FLYWHEEL_HOST_TMUX_MOUNT_POINT="$mount_point" \
              "$gate_bin" verify "$carrier" 1>&2 || rc=$?
        fi
        exit "$rc"
    )
}

restart_host_tmux_census() {
    local candidates_file="$1"
    local state_dir="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
    local gate_bin="${state_dir}/bin/host-tmux-selection-gate.sh"
    [[ -x "$gate_bin" ]] || return 127
    (
        # This helper is called inside do_restart_all_leads; stdout is reserved
        # for its skipped/failed/total result line.
        unset FLYWHEEL_HOST_TMUX_GATE_TEST_MODE \
          FLYWHEEL_HOST_TMUX_CENSUS_PLIST_DIR \
          FLYWHEEL_HOST_TMUX_CENSUS_SOURCE_DIR
        FLYWHEEL_STATE_DIR="$state_dir" FLYWHEEL_DIR="$FLYWHEEL_DIR" \
          "$gate_bin" census "$candidates_file" 1>&2
    )
}

preflight_pull_latest_main() {
    local branch="" branch_rc=0 status_output="" status_rc=0
    local status_preview="" status_alert_preview=""
    local bounded="${FLYWHEEL_RESTART_BOUNDED_RUN_BIN:-${FLYWHEEL_DIR}/scripts/lib/bounded-run.sh}"
    local old_head="" target_sha="" behind_count="" git_rc=0 reverse_rc=0
    local accepted_state="" cutover_rc=0 post_head="" merge_output=""
    local merge_preview="" merge_alert_preview=""

    branch="$(git -C "$FLYWHEEL_DIR" symbolic-ref --short -q HEAD 2>/dev/null)" || branch_rc=$?
    if (( branch_rc > 1 )); then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "PREFLIGHT WOULD FAIL: Git branch state is unreadable"
        else
            log "ERROR: restart preflight could not read the checkout branch"
            alert_severe "restart-preflight-git-state-unreadable" \
                "Flywheel restart preflight could not read Git state" \
                "restart-services could not determine the branch of ${FLYWHEEL_DIR}. The fleet restart was not started. Inspect the checkout and retry."
        fi
        return 1
    fi
    if (( branch_rc == 1 )); then
        branch="detached HEAD"
    fi
    if [[ "$branch" != "main" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "PREFLIGHT WOULD FAIL: checkout not on main (${branch:-unknown})"
        else
            log "ERROR: restart preflight requires main; checkout is ${branch:-unknown}"
            alert_severe "restart-preflight-not-on-main" \
                "Flywheel restart refused a non-main checkout" \
                "restart-services found ${FLYWHEEL_DIR} on ${branch:-unknown}, not main. No pull, build, or restart was attempted. Check out main cleanly and retry."
        fi
        return 1
    fi

    status_output="$(GIT_OPTIONAL_LOCKS=0 git -C "$FLYWHEEL_DIR" status --porcelain --untracked-files=no 2>/dev/null)" || status_rc=$?
    if (( status_rc != 0 )); then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "PREFLIGHT WOULD FAIL: Git checkout state is unreadable"
        else
            log "ERROR: restart preflight could not inspect checkout cleanliness"
            alert_severe "restart-preflight-git-state-unreadable" \
                "Flywheel restart preflight could not read Git state" \
                "restart-services could not inspect ${FLYWHEEL_DIR} for local changes. The fleet restart was not started. Inspect the checkout and retry."
        fi
        return 1
    fi
    if [[ -n "$status_output" ]]; then
        status_preview="$(printf '%s\n' "$status_output" | sed -n '1,10p')"
        status_alert_preview="${status_preview//$'\n'/; }"
        if [[ "$DRY_RUN" == "true" ]]; then
            log "PREFLIGHT WOULD FAIL: dirty checkout"
            printf '%s\n' "$status_preview"
        else
            log "ERROR: restart preflight found a dirty checkout; refusing to overwrite local state"
            printf '%s\n' "$status_preview"
            alert_severe "restart-preflight-dirty" \
                "Flywheel restart refused a dirty checkout" \
                "${FLYWHEEL_DIR} has tracked changes (${status_alert_preview}). No pull, build, or restart was attempted, and restart-services will not reset or stash local state. Clean the checkout deliberately and retry."
        fi
        return 1
    fi

    if [[ ! -x "$bounded" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "PREFLIGHT WOULD FAIL: bounded fetch runner is missing or not executable (${bounded})"
        else
            log "ERROR: restart preflight bounded runner is missing or not executable: $bounded"
            alert_severe "restart-preflight-bounded-run-missing" \
                "Flywheel restart preflight tooling is missing" \
                "restart-services could not execute ${bounded}, so it refused to fetch or restart. Restore the deployed scripts and retry."
        fi
        return 1
    fi
    if ! GIT_TERMINAL_PROMPT=0 "$bounded" 120 git -C "$FLYWHEEL_DIR" fetch origin \
      '+refs/heads/main:refs/remotes/origin/main' --quiet; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "PREFLIGHT WOULD FAIL: fetch origin main failed"
        else
            log "ERROR: restart preflight could not fetch origin/main; refusing a potentially stale restart"
            alert_warning "restart-preflight-fetch-failed" \
                "Flywheel restart could not fetch latest main" \
                "restart-services could not fetch origin/main within 120 seconds. No build or restart was attempted. Check network/remote availability and retry."
        fi
        return 1
    fi

    # Fetch may take long enough for an operator or another process to change
    # the checkout. The restart lock serializes restart callers, not arbitrary
    # Git commands, so re-check both branch and cleanliness before topology.
    branch=""
    branch_rc=0
    branch="$(git -C "$FLYWHEEL_DIR" symbolic-ref --short -q HEAD 2>/dev/null)" || branch_rc=$?
    if (( branch_rc > 1 )); then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "PREFLIGHT WOULD FAIL: Git branch state became unreadable during fetch"
        else
            log "ERROR: restart preflight could not re-read the checkout branch after fetch"
            alert_severe "restart-preflight-git-state-unreadable" \
                "Flywheel restart preflight could not read Git state" \
                "The checkout branch became unreadable during fetch. No merge, build, or restart was attempted. Inspect ${FLYWHEEL_DIR} and retry."
        fi
        return 1
    fi
    if (( branch_rc == 1 )); then
        branch="detached HEAD"
    fi
    if [[ "$branch" != "main" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "PREFLIGHT WOULD FAIL: checkout not on main after fetch (${branch:-unknown})"
        else
            log "ERROR: checkout left main during restart preflight (${branch:-unknown})"
            alert_severe "restart-preflight-not-on-main" \
                "Flywheel restart checkout changed branch during fetch" \
                "${FLYWHEEL_DIR} moved to ${branch:-unknown} during fetch. No merge, build, or restart was attempted. Return it to a clean main branch and retry."
        fi
        return 1
    fi
    status_output=""
    status_rc=0
    status_output="$(GIT_OPTIONAL_LOCKS=0 git -C "$FLYWHEEL_DIR" status --porcelain --untracked-files=no 2>/dev/null)" || status_rc=$?
    if (( status_rc != 0 )); then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "PREFLIGHT WOULD FAIL: Git checkout state became unreadable during fetch"
        else
            log "ERROR: restart preflight could not re-check checkout cleanliness after fetch"
            alert_severe "restart-preflight-git-state-unreadable" \
                "Flywheel restart preflight could not read Git state" \
                "The checkout state became unreadable during fetch. No merge, build, or restart was attempted. Inspect ${FLYWHEEL_DIR} and retry."
        fi
        return 1
    fi
    if [[ -n "$status_output" ]]; then
        status_preview="$(printf '%s\n' "$status_output" | sed -n '1,10p')"
        status_alert_preview="${status_preview//$'\n'/; }"
        if [[ "$DRY_RUN" == "true" ]]; then
            log "PREFLIGHT WOULD FAIL: dirty checkout (appeared during fetch)"
            printf '%s\n' "$status_preview"
        else
            log "ERROR: checkout became dirty during fetch; refusing to merge"
            printf '%s\n' "$status_preview"
            alert_severe "restart-preflight-dirty" \
                "Flywheel restart checkout changed during fetch" \
                "${FLYWHEEL_DIR} gained tracked changes during fetch (${status_alert_preview}). No merge, build, or restart was attempted, and restart-services did not reset or stash them. Inspect the checkout and retry."
        fi
        return 1
    fi

    git_rc=0
    old_head="$(git -C "$FLYWHEEL_DIR" rev-parse --verify HEAD 2>/dev/null)" || git_rc=$?
    if (( git_rc == 0 )); then
        target_sha="$(git -C "$FLYWHEEL_DIR" rev-parse --verify origin/main 2>/dev/null)" || git_rc=$?
    fi
    if (( git_rc != 0 )) || [[ ! "$old_head" =~ ^[0-9a-f]{40}$ ]] || [[ ! "$target_sha" =~ ^[0-9a-f]{40}$ ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "PREFLIGHT WOULD FAIL: fetched Git target is unreadable"
        else
            log "ERROR: restart preflight could not resolve HEAD and origin/main"
            alert_severe "restart-preflight-git-state-unreadable" \
                "Flywheel restart preflight could not resolve Git commits" \
                "restart-services fetched origin/main but could not resolve immutable 40-character HEAD and target SHAs. No merge, build, or restart was attempted."
        fi
        return 1
    fi
    PREFLIGHT_TARGET_SHA="$target_sha"

    git_rc=0
    behind_count="$(git -C "$FLYWHEEL_DIR" rev-list --count "${old_head}..${target_sha}" 2>/dev/null)" || git_rc=$?
    if (( git_rc != 0 )) || [[ ! "$behind_count" =~ ^[0-9]+$ ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "PREFLIGHT WOULD FAIL: commit distance is unreadable"
        else
            log "ERROR: restart preflight could not count commits to origin/main"
            alert_severe "restart-preflight-git-state-unreadable" \
                "Flywheel restart preflight could not read Git topology" \
                "restart-services could not determine the distance from HEAD to the fetched target. No merge, build, or restart was attempted."
        fi
        return 1
    fi
    log "restart preflight: current HEAD=${old_head} target origin/main=${target_sha} behind=${behind_count}"

    if [[ "$old_head" == "$target_sha" ]]; then
        accepted_state="already-at"
    else
        git_rc=0
        git -C "$FLYWHEEL_DIR" merge-base --is-ancestor "$old_head" "$target_sha" 2>/dev/null || git_rc=$?
        if (( git_rc == 0 )); then
            accepted_state="behind"
        elif (( git_rc > 1 )); then
            accepted_state="unreadable"
        else
            reverse_rc=0
            git -C "$FLYWHEEL_DIR" merge-base --is-ancestor "$target_sha" "$old_head" 2>/dev/null || reverse_rc=$?
            if (( reverse_rc == 0 )); then
                accepted_state="local-ahead"
            elif (( reverse_rc == 1 )); then
                accepted_state="diverged"
            else
                accepted_state="unreadable"
            fi
        fi
    fi

    case "$accepted_state" in
        local-ahead)
            if [[ "$DRY_RUN" == "true" ]]; then
                log "PREFLIGHT WOULD FAIL: local-ahead main contains commits absent from origin/main"
            else
                log "ERROR: local main is ahead of origin/main; refusing to deploy local-only commits"
                alert_severe "restart-preflight-local-ahead" \
                    "Flywheel restart refused local-only main commits" \
                    "${FLYWHEEL_DIR} main contains commits that are not on origin/main. No reset, merge, build, or restart was attempted. Reconcile the checkout deliberately and retry."
            fi
            return 1
            ;;
        diverged)
            if [[ "$DRY_RUN" == "true" ]]; then
                log "PREFLIGHT WOULD FAIL: local main has diverged from origin/main"
            else
                log "ERROR: local main diverged from origin/main; refusing a non-fast-forward deployment"
                alert_severe "restart-preflight-diverged" \
                    "Flywheel restart refused a diverged main checkout" \
                    "${FLYWHEEL_DIR} main and origin/main have diverged. No reset, merge, build, or restart was attempted. Reconcile the history deliberately and retry."
            fi
            return 1
            ;;
        unreadable)
            if [[ "$DRY_RUN" == "true" ]]; then
                log "PREFLIGHT WOULD FAIL: Git topology is unreadable"
            else
                log "ERROR: restart preflight could not classify Git topology"
                alert_severe "restart-preflight-git-state-unreadable" \
                    "Flywheel restart preflight could not read Git topology" \
                    "restart-services could not prove a safe fast-forward relationship to origin/main. No merge, build, or restart was attempted."
            fi
            return 1
            ;;
    esac

    cutover_rc=0
    discord_pointer_cutover_required "$target_sha" || cutover_rc=$?
    case "$cutover_rc" in
        0)
            if [[ "$DRY_RUN" == "true" ]]; then
                log "PREFLIGHT WOULD FAIL: Discord pointer cutover required for ${target_sha}"
            else
                log "ERROR: fetched target requires the guarded FLY-1676 Discord pointer cutover"
                alert_severe "restart-preflight-cutover-required" \
                    "Flywheel restart requires the guarded Discord cutover" \
                    "Fetched target ${target_sha} selects discord@flywheel-plugins while the live checker is legacy. No merge, build, or restart was attempted. Run the guarded FLY-1676 cutover first."
            fi
            return 1
            ;;
        1) ;;
        *)
            if [[ "$DRY_RUN" == "true" ]]; then
                log "PREFLIGHT WOULD FAIL: target launcher is unreadable"
            else
                log "ERROR: restart preflight could not inspect the target launcher"
                alert_severe "restart-preflight-git-state-unreadable" \
                    "Flywheel restart preflight could not inspect the target" \
                    "restart-services could not read claude-lead.sh from ${target_sha}. No merge, build, or restart was attempted."
            fi
            return 1
            ;;
    esac

    if [[ "$DRY_RUN" == "true" ]]; then
        log "DRY RUN: would run host tmux selection gate for ${target_sha}"
    elif ! restart_host_tmux_gate "$target_sha" restart-preflight \
      scripts/restart-services.sh:before-ff; then
        log "ERROR: host tmux selection gate refused restart target ${target_sha}"
        alert_severe "restart-preflight-host-tmux-gate" \
            "Flywheel restart host tmux gate failed" \
            "restart-services could not prove the required host tmux selection contract for ${target_sha}. No merge, build, or restart was attempted."
        return 1
    fi

    if [[ "$accepted_state" == "already-at" ]]; then
        log "restart preflight: already at origin/main (${target_sha})"
        return 0
    fi
    if [[ "$DRY_RUN" == "true" ]]; then
        log "DRY RUN: would pull ${old_head} -> ${target_sha}"
        return 0
    fi

    # Arm before the mutation. Bash may deliver a pending signal after the
    # merge process returns but before the next statement runs; arming after
    # merge would leave that source-advanced boundary silent.
    DEPLOY_CONSISTENCY_ARMED=true
    if ! merge_output="$(git -C "$FLYWHEEL_DIR" merge --ff-only --quiet "$target_sha" 2>&1)"; then
        merge_preview="$(printf '%s\n' "$merge_output" | sed -n '1,10p')"
        merge_alert_preview="${merge_preview//$'\n'/; }"
        log "ERROR: restart preflight fast-forward merge failed; refusing to reset local state"
        [[ -z "$merge_preview" ]] || printf '%s\n' "$merge_preview" >&2
        alert_severe "restart-preflight-nonff" \
            "Flywheel restart could not fast-forward main" \
            "restart-services fetched ${target_sha} but git merge --ff-only failed (${merge_alert_preview:-no Git diagnostic}). No build or restart was attempted, and local state was not reset. Inspect ${FLYWHEEL_DIR} and retry."
        return 1
    fi
    post_head="$(git -C "$FLYWHEEL_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
    if [[ "$post_head" != "$target_sha" ]]; then
        log "ERROR: restart preflight merge did not land on the captured target"
        alert_severe "restart-preflight-postmerge-mismatch" \
            "Flywheel restart fast-forward verification failed" \
            "After git merge --ff-only, HEAD was ${post_head:-unreadable} instead of captured target ${target_sha}. No build or restart was attempted. Inspect the checkout before retrying."
        return 1
    fi
    status_output=""
    status_rc=0
    status_output="$(GIT_OPTIONAL_LOCKS=0 git -C "$FLYWHEEL_DIR" status --porcelain --untracked-files=no 2>/dev/null)" || status_rc=$?
    if (( status_rc != 0 )); then
        log "ERROR: restart preflight could not verify checkout cleanliness after merge"
        alert_severe "restart-preflight-git-state-unreadable" \
            "Flywheel restart post-merge state is unreadable" \
            "main reached ${target_sha}, but restart-services could not verify checkout cleanliness. No build or restart was attempted. Inspect the checkout before retrying."
        return 1
    fi
    if [[ -n "$status_output" ]]; then
        log "ERROR: checkout became dirty during the fast-forward merge; refusing to continue"
        alert_severe "restart-preflight-postmerge-dirty" \
            "Flywheel restart checkout became dirty during fast-forward" \
            "main reached ${target_sha}, but a hook or concurrent writer left local changes. No build or restart was attempted. Inspect and clean the checkout deliberately before retrying."
        return 1
    fi
    log "restart preflight: pulled ${old_head:0:7} -> ${target_sha:0:7}"
    return 0
}

# Returns: 0=updated, 1=no update needed, 2=hard failure
check_discord_plugin_fork() {
    # The canonical checker owns registry/installPath/remote-SHA authority.
    # restart-services must not maintain a second clone-based freshness model.
    if [[ ! -x "$DISCORD_PLUGIN_CHECK" || ! -x "$DISCORD_PLUGIN_UPDATE" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "DRY RUN: managed Discord plugin operations are missing; the real restart would fail before mutation"
            return 1
        fi
        log "ERROR: managed Discord plugin operations are missing or not executable"
        alert_discord_plugin_integrity "restart-tools-missing" \
            "restart-services refused the fleet wave because the managed Discord checker/updater is missing. Re-run scripts/install-discord-plugin-ops.sh from the deployed checkout."
        return 2
    fi
    local live_contract=""
    live_contract="$($DISCORD_PLUGIN_CHECK --print-contract 2>/dev/null || true)"
    if [[ "$live_contract" != "$DISCORD_PLUGIN_CONTRACT" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "DRY RUN: live Discord checker is still legacy; the guarded FLY-1676 cutover is required before deployment"
            return 1
        fi
        log "ERROR: live Discord checker does not match the deployed pointer selector"
        alert_discord_plugin_integrity "restart-contract-mismatch" \
            "restart-services refused the fleet wave because the deployed launcher selects discord@flywheel-plugins but the live checker/updater still belongs to the legacy overlay. Run the guarded FLY-1676 cutover instead of a normal restart."
        return 2
    fi

    # Dry-run mode: checker is read-only (bounded remote SHA lookup), updater is
    # never invoked.
if [[ "$DRY_RUN" == "true" ]]; then
        if bash "$DISCORD_PLUGIN_CHECK" >/dev/null 2>&1; then
            log "DRY RUN: Discord plugin pointer is current"
            return 1
        fi
        log "DRY RUN: Would update discord@flywheel-plugins and force Lead restart"
        return 0
    fi

    if bash "$DISCORD_PLUGIN_CHECK" >/dev/null 2>&1; then
        log "Discord plugin pointer: up to date and runtime healthy"
        return 1
    fi

    log "Discord plugin pointer is stale or invalid; updating through Claude CLI..."
    if ! bash "$DISCORD_PLUGIN_UPDATE"; then
        log "ERROR: Discord plugin update failed"
        alert_discord_plugin_integrity "restart-update-failed" \
            "restart-services stopped the fleet wave because discord@flywheel-plugins could not update to fork main. No Lead restart was attempted."
        return 2
    fi

    if ! bash "$DISCORD_PLUGIN_CHECK" >/dev/null 2>&1; then
        log "ERROR: Discord plugin update completed but re-check still fails"
        alert_discord_plugin_integrity "restart-recheck-failed" \
            "restart-services stopped the fleet wave because discord@flywheel-plugins still failed SHA/marker verification after update. Vanilla bytes may be present."
        return 2
    fi

    log "Discord plugin updated and verified successfully"
    return 0
}

# ════════════════════════════════════════════════════════════════
# Project repo .lead/ change detection (FLY-43)
# ════════════════════════════════════════════════════════════════

PROJECT_SHA_DIR="${HOME}/.flywheel/project-deployed-sha"

# Resolve a git dir (possibly a worktree) to its main worktree path.
# Returns: main repo path on stdout, or fails with return 1.
resolve_main_repo() {
    local dir="$1"
    [[ -d "$dir" ]] || return 1
    local common_dir
    common_dir=$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null) || return 1
    if [[ "$common_dir" == ".git" ]]; then
        # Already the main worktree
        echo "$dir"
    else
        # common_dir is an absolute path like /path/to/main-repo/.git
        dirname "$common_dir"
    fi
}

# Check all project repos from manifests for .lead/ changes.
# Sets global: project_lead_changed=true/false
# Writes to: PROJECT_SHA_UPDATES_FILE (one "projectName=sha" per line)
check_project_lead_changes() {
    project_lead_changed=false
    : > "$PROJECT_SHA_UPDATES_FILE"  # truncate

    shopt -s nullglob
    local manifests=("${HOME}/.flywheel/manifests/"*.json)
    shopt -u nullglob

    if (( ${#manifests[@]} == 0 )); then
        log "No manifests found, skipping project repo check"
        return
    fi

    # Collect unique project repos (try each manifest's projectDir until one works)
    local seen_names=""
    local project_names=()
    local project_dirs=()

    for mf in "${manifests[@]}"; do
        local pname pdir
        pname=$(jq -r '.projectName' "$mf")
        pdir=$(jq -r '.projectDir' "$mf")

        # Skip if already seen this project
        case " $seen_names " in
            *" $pname "*) continue ;;
        esac

        local main_repo
        if main_repo=$(resolve_main_repo "$pdir"); then
            project_names+=("$pname")
            project_dirs+=("$main_repo")
            seen_names="$seen_names $pname"
        fi
    done

    # Check each unique project
    local i
    for (( i=0; i<${#project_names[@]}; i++ )); do
        local pname="${project_names[$i]}"
        local repo="${project_dirs[$i]}"
        local sha_file="${PROJECT_SHA_DIR}/${pname}"
        local stored_sha
        stored_sha=$(cat "$sha_file" 2>/dev/null || echo "")

        # Fetch latest from remote (best-effort, don't block on failure)
        if [[ "$DRY_RUN" != "true" ]]; then
            git -C "$repo" fetch origin main --quiet 2>/dev/null || {
                log "WARNING: Failed to fetch project $pname (${repo}), skipping"
                continue
            }
        fi

        local current_sha
        current_sha=$(git -C "$repo" rev-parse origin/main 2>/dev/null) || {
            log "WARNING: Cannot resolve origin/main for project $pname, skipping"
            continue
        }

        # Store for later SHA update (tab-separated, one per line)
        printf '%s\t%s\n' "$pname" "$current_sha" >> "$PROJECT_SHA_UPDATES_FILE"

        if [[ "$stored_sha" == "$current_sha" ]]; then
            continue
        fi

        if [[ -z "$stored_sha" ]]; then
            # First run: record SHA, don't force restart
            log "Project $pname: first run, recording SHA ${current_sha:0:7} (no restart forced)"
            mkdir -p "$PROJECT_SHA_DIR"
            echo "$current_sha" > "$sha_file"
            continue
        fi

        # Check if .lead/ changed between stored and current
        # Fail-safe: if git diff fails (bad SHA, force-push, etc.), treat as changed
        local lead_changes
        local diff_ok=true
        lead_changes=$(git -C "$repo" diff --name-only "$stored_sha" "$current_sha" -- .lead/ 2>/dev/null) || diff_ok=false

        if [[ "$diff_ok" == "false" ]]; then
            log "WARNING: git diff failed for project $pname (${stored_sha:0:7}→${current_sha:0:7}), treating as changed (fail-safe)"
            project_lead_changed=true
        elif [[ -n "$lead_changes" ]]; then
            local change_count
            change_count=$(echo "$lead_changes" | wc -l | tr -d ' ')
            log "Project $pname: ${change_count} .lead/ file(s) changed (${stored_sha:0:7} → ${current_sha:0:7})"
            if [[ "$DRY_RUN" == "true" ]]; then
                log "DRY RUN: Changed .lead/ files:"
                echo "$lead_changes" | head -10
            fi
            project_lead_changed=true
        fi
    done
}

# Update project deployed SHAs after successful restart.
update_project_shas() {
    [[ ! -s "$PROJECT_SHA_UPDATES_FILE" ]] && return
    mkdir -p "$PROJECT_SHA_DIR"
    while IFS=$'\t' read -r pname sha; do
        [[ -z "$pname" || -z "$sha" ]] && continue
        echo "$sha" > "${PROJECT_SHA_DIR}/${pname}"
        log "Project $pname: deployed-sha updated to ${sha:0:7}"
    done < "$PROJECT_SHA_UPDATES_FILE"
}

# Allocated only after the mutual-exclusion lock is owned, so a contention exit
# cannot leak per-run sidecars before the cleanup trap exists.
PROJECT_SHA_UPDATES_FILE=""
LEAD_RESTART_NAMES_FILE=""
LEAD_BODY_OBSERVATIONS_FILE=""
LEAD_VERIFY_TIMINGS_FILE=""
RESTART_TRANSIENT_FILES=""

register_restart_transient_file() {
    local path="$1"
    [[ -n "$path" && "$path" != *$'\n'* ]] || return 1
    RESTART_TRANSIENT_FILES="${RESTART_TRANSIENT_FILES}${path}"$'\n'
}

record_lead_restart_detail() {
    local kind="${1:-}" detail="${2:-}"
    [[ -n "${LEAD_RESTART_NAMES_FILE:-}" ]] || return 0
    { printf '%s\t%s\n' "$kind" "$detail" >> "$LEAD_RESTART_NAMES_FILE"; } 2>/dev/null || true
    return 0
}

lead_restart_details_csv() {
    local kind="${1:-}"
    [[ -n "${LEAD_RESTART_NAMES_FILE:-}" && -r "$LEAD_RESTART_NAMES_FILE" ]] || {
        printf '\n'
        return 0
    }
    awk -F '\t' -v wanted="$kind" '
        $1 == wanted {
            if (seen++) printf ", "
            printf "%s", $2
        }
        END { print "" }
    ' "$LEAD_RESTART_NAMES_FILE" 2>/dev/null || printf '\n'
    return 0
}

lead_restart_wave_error() {
    [[ -n "${LEAD_RESTART_NAMES_FILE:-}" && -r "$LEAD_RESTART_NAMES_FILE" ]] || {
        printf '\n'
        return 0
    }
    awk -F '\t' '$1 == "wave_error" { print $2; exit }' \
        "$LEAD_RESTART_NAMES_FILE" 2>/dev/null || printf '\n'
    return 0
}

record_successful_lead_body_observation() {
    local key="${1:-}" project="${2:-}" lead="${3:-}"
    local carrier_pid="${4:-}" carrier_start="${5:-}"
    [[ -n "${LEAD_BODY_OBSERVATIONS_FILE:-}" ]] || return 0
    case "$key$project$lead$carrier_start" in *$'\t'*|*$'\n'*) return 0 ;; esac
    [[ "$carrier_pid" =~ ^[1-9][0-9]*$ && -n "$carrier_start" ]] || {
        carrier_pid="-"
        carrier_start="-"
    }
    { printf '%s\t%s\t%s\t%s\t%s\n' \
        "$key" "$project" "$lead" "$carrier_pid" "$carrier_start" \
        >> "$LEAD_BODY_OBSERVATIONS_FILE"; } 2>/dev/null || true
    return 0
}

# Successful verification timing is intentionally independent of the stable
# five-field body-observation contract above. Format: <daemon-key> TAB <seconds>.
record_successful_lead_verify_timing() {
    local key="${1:-}" elapsed_seconds="${2:-}"
    [[ -n "${LEAD_VERIFY_TIMINGS_FILE:-}" ]] || return 0
    [[ -n "$key" && "$elapsed_seconds" =~ ^[0-9]+$ ]] || return 0
    case "$key" in *$'\t'*|*$'\n'*) return 0 ;; esac
    { printf '%s\t%s\n' "$key" "$elapsed_seconds" \
        >> "$LEAD_VERIFY_TIMINGS_FILE"; } 2>/dev/null || true
    return 0
}

_lead_verify_now() {
    local now=""
    now="$(date +%s 2>/dev/null)" || return 1
    [[ "$now" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$now"
}

capture_successful_lead_verify_elapsed() {
    local started_at="${1:-}" finished_at=""
    VERIFIED_LEAD_ELAPSED_SECONDS=""
    [[ "$started_at" =~ ^[0-9]+$ ]] || return 0
    finished_at="$(_lead_verify_now 2>/dev/null)" || return 0
    [[ "$finished_at" =~ ^[0-9]+$ ]] || return 0
    (( finished_at >= started_at )) || return 0
    VERIFIED_LEAD_ELAPSED_SECONDS="$((finished_at - started_at))"
    return 0
}

summarize_lead_verify_timings() {
    local timings="${1:-}" summary=""
    if [[ -r "$timings" ]]; then
        summary="$(LC_ALL=C awk -F '\t' '
          NF == 2 && $1 != "" && $2 ~ /^[0-9]+$/ { print $2 }
        ' "$timings" 2>/dev/null \
          | LC_ALL=C sort -n \
          | LC_ALL=C awk '
              { values[++count] = $1 }
              END {
                if (count == 0) exit
                p50 = int((count * 50 + 99) / 100)
                p95 = int((count * 95 + 99) / 100)
                printf "Lead verify timing: samples=%d p50=%ss p95=%ss max=%ss; failed Leads excluded", \
                  count, values[p50], values[p95], values[count]
              }
            ' 2>/dev/null)" || summary=""
    fi
    if [[ -z "$summary" ]]; then
        summary="Lead verify timing: samples=0 p50=unknown p95=unknown max=unknown; failed Leads excluded"
    fi
    printf '%s\n' "$summary"
    return 0
}

# Print: <launched-count> TAB <adopted-count> TAB <unknown-count>.
# The optional wait is one total observation budget, never a per-Lead delay.
summarize_lead_body_observations() {
    local observations="${1:-}" wait_seconds="${LEAD_BODY_EVIDENCE_WAIT_SECONDS:-10}"
    local deadline=0 now=0 unresolved=0 result="" provenance="" snapshot=""
    local key project lead carrier_pid carrier_start
    [[ -r "$observations" ]] || { printf '0\t0\t0\n'; return 0; }
    [[ "$wait_seconds" =~ ^[0-9]+$ ]] || wait_seconds=10
    (( wait_seconds <= 10 )) || wait_seconds=10
    now="$(date +%s 2>/dev/null || printf '0')"
    [[ "$now" =~ ^[0-9]+$ ]] || now=0
    deadline=$((now + wait_seconds))
    snapshot="$(mktemp "${TMPDIR:-/tmp}/flywheel-body-summary.XXXXXX" 2>/dev/null)" \
      || { printf '0\t0\t0\n'; return 0; }

    while :; do
        : > "$snapshot"
        unresolved=0
        while IFS=$'\t' read -r key project lead carrier_pid carrier_start; do
            [[ -n "$key" ]] || continue
            provenance=""
            if declare -F lbe_read_matching >/dev/null 2>&1; then
                provenance="$(lbe_read_matching \
                    "$project" "$lead" "$carrier_pid" "$carrier_start" 2>/dev/null || true)"
            fi
            case "$provenance" in
              launched|adopted) printf '%s\n' "$provenance" >> "$snapshot" ;;
              *) printf 'unknown\n' >> "$snapshot"; unresolved=$((unresolved + 1)) ;;
            esac
        done < "$observations"
        (( unresolved == 0 || wait_seconds == 0 )) && break
        now="$(date +%s 2>/dev/null || printf '%s' "$deadline")"
        [[ "$now" =~ ^[0-9]+$ ]] || now="$deadline"
        (( now >= deadline )) && break
        sleep 1
    done

    result="$(awk '
      $0 == "launched" { launched++ }
      $0 == "adopted" { adopted++ }
      $0 == "unknown" { unknown++ }
      END { printf "%d\t%d\t%d", launched+0, adopted+0, unknown+0 }
    ' "$snapshot" 2>/dev/null)"
    rm -f "$snapshot" 2>/dev/null || true
    [[ -n "$result" ]] || result=$'0\t0\t0'
    printf '%s\n' "$result"
    return 0
}

validate_restart_contract() {
    local raw normalized
    if [[ "${FLYWHEEL_RESTART_LOCK_WAIT_SECS+x}" == "x" ]]; then
        raw="$FLYWHEEL_RESTART_LOCK_WAIT_SECS"
        if [[ ! "$raw" =~ ^[0-9]+$ ]]; then
            log "ERROR: FLYWHEEL_RESTART_LOCK_WAIT_SECS must be an integer from 0 to 7200"
            return 1
        fi
        normalized="$raw"
        while [[ ${#normalized} -gt 1 && "$normalized" == 0* ]]; do
            normalized="${normalized#0}"
        done
        if (( ${#normalized} > 4 )) || (( 10#$normalized > 7200 )); then
            log "ERROR: FLYWHEEL_RESTART_LOCK_WAIT_SECS must be an integer from 0 to 7200"
            return 1
        fi
        RESTART_LOCK_WAIT_SECS_EFFECTIVE="$((10#$normalized))"
    else
        RESTART_LOCK_WAIT_SECS_EFFECTIVE=0
    fi

    if [[ "${FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK+x}" == "x" ]]; then
        raw="$FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK"
        if [[ "$raw" != "0" && "$raw" != "1" ]]; then
            log "ERROR: FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK must be exactly 0 or 1"
            return 1
        fi
        RESTART_CODE_ROLLBACK_DISABLED="$raw"
    else
        RESTART_CODE_ROLLBACK_DISABLED=0
    fi
}

# FLY-1783: pure predicate. A foreground child belongs to the sanctioned
# updater/self-detach path; entry mode with caller PID 1 is a direct launchd
# job and must stop before validation, locking, build, or service mutation.
_rs_is_direct_launchd_invocation() {
    [[ "$2" != "1" && "$1" == "1" ]]
}

# ════════════════════════════════════════════════════════════════
# Parse arguments
# ════════════════════════════════════════════════════════════════

FORCE=false
DRY_RUN=false
RESTART_REASON="manual"
RESTART_ARGS=("$@")
# FLY-1224 (founder directive): the idle wait is DEFAULT-OFF. `--wait-idle`
# or env FLYWHEEL_RESTART_WAIT_IDLE=1 restores the old waiting behavior;
# `--force` is kept as an accepted flag (its old meaning — skip the wait — is
# now the default) and WINS when given together with --wait-idle.
WAIT_IDLE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force) FORCE=true; shift ;;
        --wait-idle) WAIT_IDLE=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        --reason)
            [[ $# -ge 2 && -n "$2" && "$2" != *$'\n'* && "$2" != *$'\r'* ]] || {
                log "ERROR: --reason requires one non-empty line of text"
                exit 1
            }
            RESTART_REASON="$2"
            shift 2
            ;;
        *) log "ERROR: Unknown argument '$1'"; exit 1 ;;
    esac
done

if [[ "${FLYWHEEL_RESTART_WAIT_IDLE:-}" == "1" ]]; then
    WAIT_IDLE=true
fi
if [[ "$FORCE" == "true" && "$WAIT_IDLE" == "true" ]]; then
    log "--force wins over --wait-idle/FLYWHEEL_RESTART_WAIT_IDLE — skipping the idle wait"
    WAIT_IDLE=false
fi

if _rs_is_direct_launchd_invocation "$PPID" "${FLYWHEEL_RESTART_FOREGROUND:-0}"; then
    log "ERROR: started DIRECTLY by launchd (ppid 1) — refusing before any mutation (FLY-1783)."
    log "A submit-style job relaunches on every exit — the 2026-08-14 66-spawn storm shape."
    log "Fleet deployment has only two updater sources: the local 00:00/12:00 shuttle"
    log "and a founder-authorized emergency ticket from scripts/request-restart.sh."
    alert_launchd_refusal \
        "refused direct launchd invocation of restart-services.sh (ppid 1); see FLY-1783 / incident 2026-08-14"
    exit 78
fi

validate_restart_contract || exit 1

# Direct invocation is safe even from a Lead that this run will replace. The
# child gets its own process group before any lock, build, or service mutation.
# This block is the only sanctioned self-detach mechanism. If it cannot start
# a live child, stop and report; never improvise another process supervisor.
if [[ "${FLYWHEEL_RESTART_FOREGROUND:-0}" != "1" && "$DRY_RUN" != "true" ]]; then
    detach_log_dir="${FLYWHEEL_RESTART_DETACH_LOG_DIR:-/tmp}"
    detach_log="${detach_log_dir}/flywheel-restart-detached-$(date +%Y%m%d-%H%M%S).log"
    set -m
    FLYWHEEL_RESTART_FOREGROUND=1 nohup "$0" "${RESTART_ARGS[@]+"${RESTART_ARGS[@]}"}" \
        </dev/null >>"$detach_log" 2>&1 &
    detach_pid=$!
    sleep 1
    if kill -0 "$detach_pid" 2>/dev/null; then
        disown "$detach_pid" 2>/dev/null || true
        echo "[restart] detached (PID $detach_pid, log: $detach_log)"
        exit 0
    fi
    if wait "$detach_pid"; then
        log "Detached restart child completed within 1s with exit 0 (PID $detach_pid)."
        log "No live wave remains; child log: $detach_log"
        exit 0
    else
        detach_rc=$?
    fi
    log "ERROR: detached restart child exited within 1s with status $detach_rc (PID $detach_pid) — failing LOUD."
    log "NOT retrying via any re-spawning scheduler. Last log lines:"
    tail -n 20 "$detach_log" >&2 || true
    exit "$detach_rc"
fi

# FLY-1434: restart scope is no longer classified. These flags only decide
# whether a build/install is needed; every legal invocation restarts the Bridge
# and all Leads.
plugin_needs_restart=false
project_lead_changed=false
restart_bridge=false
restart_all_leads=false
need_install=false
SKIP_BUILD=false
BRIDGE_HEALTH_JSON=""

# ════════════════════════════════════════════════════════════════
# Mutual exclusion lock
# ════════════════════════════════════════════════════════════════

acquire_lock() {
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
        # wait=0 is the historical byte-compatible path: contention is a
        # successful no-op. Rollback/automation callers may opt into bounded
        # waiting so a transient restart owner cannot strand the fleet.
        local lock_age lock_mtime
        if (( RESTART_LOCK_WAIT_SECS_EFFECTIVE == 0 )); then
            lock_mtime=$(file_mtime_epoch "$LOCK_DIR" 2>/dev/null || echo 0)
            lock_age=$(( $(date +%s) - lock_mtime ))
            if (( lock_age > 7200 )); then
                log "Stale lock detected (${lock_age}s), breaking."
                rmdir "$LOCK_DIR" 2>/dev/null || true
                mkdir "$LOCK_DIR" 2>/dev/null || { log "Lock contention, exiting."; exit 0; }
            else
                log "Another restart in progress (${lock_age}s old), exiting."
                exit 0
            fi
        else
            local start deadline now remaining sleep_secs
            start=$(date +%s)
            deadline=$(( start + RESTART_LOCK_WAIT_SECS_EFFECTIVE ))
            while true; do
                # The incumbent may release between the initial failed mkdir
                # and this loop (or between iterations). Claim ownership before
                # reading metadata so a missing lock cannot look stale and burn
                # the bounded deadline.
                if mkdir "$LOCK_DIR" 2>/dev/null; then
                    break
                fi
                lock_mtime=$(file_mtime_epoch "$LOCK_DIR" 2>/dev/null || echo 0)
                now=$(date +%s)
                lock_age=$(( now - lock_mtime ))
                if (( lock_age > 7200 )); then
                    log "Stale lock detected (${lock_age}s), breaking."
                    if rmdir "$LOCK_DIR" 2>/dev/null && mkdir "$LOCK_DIR" 2>/dev/null; then
                        break
                    fi
                    log "Lock contention after stale-lock break; waiting."
                fi
                now=$(date +%s)
                if (( now >= deadline )); then
                    log "ERROR: restart lock was not acquired within ${RESTART_LOCK_WAIT_SECS_EFFECTIVE}s"
                    alert_severe "restart-lock-wait-timeout" \
                        "Flywheel restart lock wait timed out" \
                        "restart-services waited ${RESTART_LOCK_WAIT_SECS_EFFECTIVE}s for the current restart owner, then failed without starting another restart."
                    exit 1
                fi
                remaining=$(( deadline - now ))
                sleep_secs=5
                (( remaining < sleep_secs )) && sleep_secs="$remaining"
                log "Another restart in progress (${lock_age}s old); waiting (${remaining}s remaining)."
                sleep "$sleep_secs"
            done
        fi
    fi
    trap 'restart_on_exit "$?"' EXIT
    trap 'RESTART_EXIT_SIGNAL=INT; exit 130' INT
    trap 'RESTART_EXIT_SIGNAL=TERM; exit 143' TERM
    if ! lead_restart_wait_scheduler_mutation "$SCHEDULER_REPAIR_LOCK_DIR" 15; then
        log "ERROR: scheduler restart mutation did not drain (${LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON}); failing closed"
        alert_severe "scheduler-restart-lock-${LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON}" \
            "Flywheel restart coordination blocked" \
            "restart-services 已持有全局锁，但 scheduler-repair mutation lock 未在 15 秒内安全释放 (${LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON})。本次重启未执行任何服务 mutation。"
        exit 1
    fi
}

acquire_lock

# Temp files are per owned restart run and are covered by restart_on_exit.
register_restart_transient_file "$(restart_admission_receipt_path)"
PROJECT_SHA_UPDATES_FILE=$(mktemp "${TMPDIR:-/tmp}/flywheel-project-sha-XXXXXX")
if ! LEAD_RESTART_NAMES_FILE=$(mktemp "${TMPDIR:-/tmp}/flywheel-lead-results-XXXXXX"); then
    log "ERROR: cannot allocate Lead restart result sidecar; terminal message will report incomplete evidence"
    LEAD_RESTART_NAMES_FILE=""
fi
if LEAD_BODY_OBSERVATIONS_FILE=$(mktemp "${TMPDIR:-/tmp}/flywheel-lead-bodies-XXXXXX"); then
    register_restart_transient_file "$LEAD_BODY_OBSERVATIONS_FILE"
else
    log "ERROR: cannot allocate Lead body observation sidecar; body provenance will be unknown"
    LEAD_BODY_OBSERVATIONS_FILE=""
fi
if LEAD_VERIFY_TIMINGS_FILE=$(mktemp "${TMPDIR:-/tmp}/flywheel-lead-verify-timings-XXXXXX"); then
    register_restart_transient_file "$LEAD_VERIFY_TIMINGS_FILE"
else
    log "ERROR: cannot allocate Lead verification timing sidecar; timing evidence will be unknown"
    LEAD_VERIFY_TIMINGS_FILE=""
fi

preflight_pull_latest_main || exit 1
if [[ "$DRY_RUN" != "true" ]]; then
    # Also covers the already-current success path, which performs no merge.
    DEPLOY_CONSISTENCY_ARMED=true
fi

if ! summary_registry_activation_preflight; then
    log "ERROR: summary registry activation evidence is absent or stale; existing Bridge and Leads remain untouched"
    exit 1
fi

# The release below makes managed-Lead botUserId mandatory at every Bridge,
# launcher, and write boundary. Prove the independent-roster migration landed
# before changing host config, building strict binaries, or stopping services.
if ! lead_identity_registry_preflight \
  "${HOME}/.flywheel/projects.json" "${FLYWHEEL_PROJECTS:-}"; then
    log "ERROR: canonical Lead identity registry is not migration-ready; existing Bridge and Leads remain untouched"
    exit 1
fi

# FLY-1726: config.ts no longer invents a default Lead. Under the restart lock,
# validate an existing explicit choice or atomically materialize the historical
# product-lead choice for legacy hosts. This runs before plugin/build/service
# work, so an ambiguous custom host fails with the old Bridge still running.
if ! default_lead_agent_env_converge \
  "$ENV_FILE" "${HOME}/.flywheel/projects.json" "${FLYWHEEL_PROJECTS:-}" "$DRY_RUN"; then
    log "ERROR: default Lead identity delivery failed before deploy mutation"
    exit 1
fi

# ════════════════════════════════════════════════════════════════
# Discord plugin detection — marker + fork check
# ════════════════════════════════════════════════════════════════

# Check for pending plugin-only restart retry
if [[ -f "$PLUGIN_RESTART_PENDING" ]]; then
    log "Found plugin-restart-pending marker — retrying Lead restart"
    plugin_needs_restart=true
fi

# Run fork detection (before deployed-sha check)
fork_rc=0
check_discord_plugin_fork || fork_rc=$?
if (( fork_rc == 0 )); then
    plugin_needs_restart=true
    log "Discord plugin updated — will force Lead restart"
elif (( fork_rc == 2 )); then
    log "ERROR: Discord plugin integrity could not be established; aborting the fleet restart before build/service mutation"
    exit 1
fi

# ════════════════════════════════════════════════════════════════
# Project repo .lead/ change detection (FLY-43)
# ════════════════════════════════════════════════════════════════

check_project_lead_changes

# ════════════════════════════════════════════════════════════════
# Deployed-SHA comparison
# ════════════════════════════════════════════════════════════════

DEPLOYED_SHA=$(cat "$DEPLOYED_SHA_FILE" 2>/dev/null || echo "")
CURRENT_HEAD=$(git -C "$FLYWHEEL_DIR" rev-parse HEAD)
if [[ "$DRY_RUN" == "true" ]]; then
    CURRENT_HEAD="$PREFLIGHT_TARGET_SHA"
fi

if [[ "$DEPLOYED_SHA" == "$CURRENT_HEAD" ]]; then
    log "Already built at ${CURRENT_HEAD:0:7}; skipping build, continuing full restart."
    SKIP_BUILD=true
fi

# ════════════════════════════════════════════════════════════════
# Diff classification (build/install only; never restart scope)
# ════════════════════════════════════════════════════════════════

# Bootstrap: deployed-sha not found → first run, force full restart
FIRST_RUN=false
if [[ -z "$DEPLOYED_SHA" ]]; then
    log "No deployed-sha found — first run, forcing full restart"
    FIRST_RUN=true
fi

classify_changes() {
    local _restart_bridge=false
    local _restart_all_leads=false
    local _need_install=false

    while IFS= read -r file; do
        case "$file" in
            # Lead impact (specific patterns BEFORE wildcard teamlead/*)
            packages/teamlead/scripts/claude-lead.sh)   _restart_all_leads=true ;;
            packages/teamlead/scripts/post-compact*)     _restart_all_leads=true ;;
            # FLY-127 R3: base prompt rules read by claude-lead.sh on every Lead
            # spawn. Editing these requires Lead daemon kickstart; Bridge does
            # NOT read them, so don't trigger a Bridge restart for these.
            packages/teamlead/lead-rules-base/*)         _restart_all_leads=true ;;

            # Bridge impact: teamlead + dependency packages + scripts
            packages/teamlead/*)         _restart_bridge=true ;;
            packages/core/*)             _restart_bridge=true ;;
            packages/edge-worker/*)      _restart_bridge=true ;;
            packages/flywheel-comm/*)    _restart_bridge=true; _restart_all_leads=true ;;
            scripts/run-bridge.ts)       _restart_bridge=true ;;
            scripts/lib/*)               _restart_bridge=true ;;

            # Dependency changes → everything
            package.json)                _need_install=true; _restart_bridge=true; _restart_all_leads=true ;;
            pnpm-lock.yaml)              _need_install=true; _restart_bridge=true; _restart_all_leads=true ;;
            pnpm-workspace.yaml)         _need_install=true; _restart_bridge=true; _restart_all_leads=true ;;

            # No restart needed
            doc/*|tests/*|.claude/*|.github/*|*.md)  ;;
            *)  ;;
        esac
    done <<< "$CHANGED"

    echo "restart_bridge=$_restart_bridge"
    echo "restart_all_leads=$_restart_all_leads"
    echo "need_install=$_need_install"
}

restart_bridge=false
restart_all_leads=false
need_install=false

if [[ "$FIRST_RUN" == "true" ]]; then
    restart_bridge=true
    restart_all_leads=true
    need_install=true
    log "First run: full restart (bridge + all leads + install)"
else
    CHANGED=$(git -C "$FLYWHEEL_DIR" diff --name-only "$DEPLOYED_SHA" "$CURRENT_HEAD")
    if [[ -z "$CHANGED" ]]; then
        log "No build-relevant changes; skipping build, continuing full restart."
        SKIP_BUILD=true
    else
        eval "$(classify_changes)"
        log "Diff analysis: bridge=$restart_bridge leads=$restart_all_leads install=$need_install"
    fi
fi

# Merge plugin update + project .lead/ change flags into diff classification result
if [[ "$plugin_needs_restart" == "true" || "$project_lead_changed" == "true" ]]; then
    restart_all_leads=true
fi

if [[ "$restart_bridge" == "false" && "$restart_all_leads" == "false" && "$need_install" == "false" ]]; then
    SKIP_BUILD=true
fi

# Built artifacts carry an immutable build SHA. Metadata never re-labels old
# bytes as new: a built deployment may skip only when the artifact was produced
# from this exact intended checkout. Source mode requires an explicit override.
BRIDGE_DEPLOY_MODE="${FLYWHEEL_BRIDGE_DEPLOY_MODE:-built}"
BRIDGE_ARTIFACT_SHA="$(jq -r '.artifactBuildSha // empty' \
    "${FLYWHEEL_DIR}/packages/teamlead/dist/build-identity.json" 2>/dev/null || true)"
if ! dbi_skip_build_allowed "$BRIDGE_DEPLOY_MODE" "$CURRENT_HEAD" "$BRIDGE_ARTIFACT_SHA"; then
    SKIP_BUILD=false
    log "Build identity requires rebuild (mode=${BRIDGE_DEPLOY_MODE} artifact=${BRIDGE_ARTIFACT_SHA:-missing})"
fi

# FLY-1434: the only restart scope is full fleet.
restart_bridge=true
restart_all_leads=true

    if [[ "$DRY_RUN" == "true" ]]; then
    log "DRY RUN: Would restart Bridge + voice-bridge (when configured/loaded) + all Leads (reason=$RESTART_REASON build=$([[ "$SKIP_BUILD" == "true" ]] && echo skip || echo run) install=$need_install)"
    log "DRY RUN: Changes since ${DEPLOYED_SHA:0:7}:"
    echo "${CHANGED:-"(first run)"}" | head -20
    exit 0
fi

# ════════════════════════════════════════════════════════════════
# Idle wait
# ════════════════════════════════════════════════════════════════

wait_for_idle() {
    local elapsed=0
    local consecutive_failures=0
    local max_consecutive_failures=3
    while (( elapsed < MAX_WAIT_SECONDS )); do
        local count
        local health_ok=true
        count=$(curl -sf "$BRIDGE_URL/health" | jq '.sessions_count // 0') || health_ok=false
        if [[ "$health_ok" == "false" ]]; then
            consecutive_failures=$((consecutive_failures + 1))
            if (( consecutive_failures >= max_consecutive_failures )); then
                log "Bridge unreachable for ${consecutive_failures} consecutive checks — treating as down"
                return 0
            fi
            log "Health check failed (${consecutive_failures}/${max_consecutive_failures}), retrying..."
        else
            consecutive_failures=0
            if (( count == 0 )); then
                return 0
            else
                if (( elapsed == 0 || elapsed % 300 == 0 )); then
                    RESTART_NOTICE_STARTED=true
                    notify_routine "⏳ 等待 ${count} 个 active session idle... (${elapsed}s/${MAX_WAIT_SECONDS}s)"
                fi
            fi
        fi
        sleep "$POLL_INTERVAL"
        elapsed=$((elapsed + POLL_INTERVAL))
    done
    log "WARNING: Timeout waiting for idle after ${MAX_WAIT_SECONDS}s"
    return 1
}

# FLY-1224: the idle wait is opt-in (--wait-idle / FLYWHEEL_RESTART_WAIT_IDLE=1).
if [[ "$WAIT_IDLE" == "true" ]]; then
    log "Waiting for idle sessions before restart..."
    if ! wait_for_idle; then
        log "Proceeding with restart after idle timeout"
        alert_warning "idle-timeout" "Deploy idle wait timed out" \
            "Idle 等待超时 (${MAX_WAIT_SECONDS}s)，强制重启。"
    fi
fi

# ════════════════════════════════════════════════════════════════
# Bridge stop / start
# ════════════════════════════════════════════════════════════════

# FLY-516: shared port helpers (bp_confirm_port_released, bp_wait_port_free, …).
# Route the lib's fail-loud seam through this script's existing Discord channel
# plus the Bridge-independent meta-alert.
# shellcheck source=lib/bridge-port.sh
source "${FLYWHEEL_DIR}/scripts/lib/bridge-port.sh"
# shellcheck source=lib/bridge-process-tree.sh
source "${FLYWHEEL_DIR}/scripts/lib/bridge-process-tree.sh"
bp_fail_loud() {
    local reason="$1" title="$2" body="$3"
    # >&2: never write to stdout — bp_confirm_port_released's verdict is captured
    # via `$(...)` and any stdout here would defeat the fail-closed check
    # (Codex R2 HIGH). alert_severe honors the same discipline (stdout empty).
    log "FAIL-LOUD [$reason] $title — $body" >&2
    alert_severe "port-fail-loud-${reason}" "$title" "$body"
    [[ -x "${FLYWHEEL_DIR}/scripts/meta-alert.sh" ]] && \
        "${FLYWHEEL_DIR}/scripts/meta-alert.sh" "$reason" "$title" "$body" || true
}

# ── FLY-239: precise Bridge-stop targeting ──────────────────────────────
# The old `pgrep -f "run-bridge.ts"` over-matched. Its command-line substring
# also appears in:
#   • QA-slot Bridges running from `worktrees/<slot>/scripts/run-bridge.ts`
#     (a different Bridge, on a different port — must NEVER be killed here), and
#   • the npm/tsx wrapper PIDs of any run-bridge invocation.
# So a deploy restart could cross-kill a live QA-slot Bridge, and the multi-PID
# string fed straight into `kill`/`kill -0` behaved unreliably (the historical
# "multi-PID kill bug"). Instead we locate the REAL production Bridge by the
# port it LISTENS on (authoritative, one process), then walk up its own
# run-bridge ancestor tree (listener → tsx → npm wrapper) so launchd KeepAlive
# re-spawns cleanly. A `worktrees/` path is never targeted, belt-and-suspenders.

stop_bridge() {
    local port pids
    port="$(bridge_port)"
    pids="$(bridge_target_pids)"
    if [[ -z "$pids" ]]; then
        log "Bridge not listening on :$port, nothing to stop"
        return 0
    fi
    # shellcheck disable=SC2086
    log "Stopping Bridge (port :$port, PIDs: $(echo $pids | tr '\n' ' '))..."
    local p
    for p in $pids; do
        flywheel_audited_signal "restart_services" "SIGTERM" "pid" "$p" "" "bridge_restart" "forced-shutdown-fail-open" || true
    done
    local wait_count=0 alive
    while (( wait_count < 120 )); do
        alive=0
        for p in $pids; do kill -0 "$p" 2>/dev/null && { alive=1; break; }; done
        (( alive == 0 )) && break
        sleep 1
        # NOT `((wait_count++))`: post-increment returns the OLD value (0 on the
        # first pass), so the arithmetic command exits 1 and `set -e` aborts the
        # whole deploy mid-stop. Assignment form always exits 0.
        wait_count=$((wait_count + 1))
    done
    for p in $pids; do
        if kill -0 "$p" 2>/dev/null; then
            log "WARNING: Bridge PID $p still alive after 120s, force killing"
            flywheel_audited_signal "restart_services" "SIGKILL" "pid" "$p" "" "bridge_restart_escalation" "forced-shutdown-fail-open" || true
        fi
    done
    # shellcheck disable=SC2086
    log "Bridge stopped (PIDs: $(echo $pids | tr '\n' ' '), waited ${wait_count}s)"

    # FLY-516: killing the PID(s) does NOT guarantee :port is released (a lingering
    # socket / different holder). Confirm the port is actually free before handing
    # off to start_bridge / launchd — otherwise the new Bridge crash-loops on
    # EADDRINUSE (batch restart #2 wedge). bp_confirm_port_released polls, reclaims
    # a surviving listener, and fail-louds (Discord + meta-alert) if it stays bound.
    #
    # FLY-516 (Codex R1 HIGH): fail-CLOSED. If the port is still stuck we must NOT
    # let the deploy proceed to start_bridge + the /health check — the new Bridge
    # can't bind, and the health probe would hit the OLD stuck holder (a legacy one
    # answers `{ok:true}`) and FALSELY report success. Return non-zero so the caller
    # aborts. The alert already fired inside bp_confirm_port_released.
    if [[ "$(bp_confirm_port_released "$port")" == "stuck" ]]; then
        log "ERROR: Bridge port :$port still bound after stop — refusing to continue (new Bridge can't bind; alerted). stop_bridge fail-closed."
        return 1
    fi
    log "Bridge port :$port confirmed released"
    return 0
}

start_bridge() {
    if ! supervisor_assert_keepalive bridge; then
        log "ERROR: com.flywheel.bridge is not loaded with KeepAlive=true; refusing orphan fallback. Run scripts/install-bridge-launchd.sh first."
        return 1
    fi
    if ! supervisor_restart bridge >/dev/null 2>&1; then
        log "ERROR: launchd kickstart failed for com.flywheel.bridge"
        return 1
    fi
    if ! supervisor_assert_keepalive bridge; then
        log "ERROR: com.flywheel.bridge lost its loaded KeepAlive contract after kickstart"
        return 1
    fi
    log "Bridge restart requested via canonical launchd job"
}

# ════════════════════════════════════════════════════════════════
# Lead restart
# ════════════════════════════════════════════════════════════════

# FLY-1507: keep destructive identity logic in sourceable production libraries.
# shellcheck source=lib/lead-body-sweep.sh
# shellcheck disable=SC1091
source "${FLYWHEEL_DIR}/scripts/lib/lead-body-sweep.sh"
# FLY-1671: optional provenance reader. Missing/corrupt evidence is unknown and
# never changes the launchd carrier verdict established below.
if [[ -f "${FLYWHEEL_DIR}/scripts/lib/lead-body-evidence.sh" ]]; then
    # shellcheck source=lib/lead-body-evidence.sh
    source "${FLYWHEEL_DIR}/scripts/lib/lead-body-evidence.sh" \
      || log "DEBUG: body evidence library unavailable; provenance will be unknown"
fi
# FLY-1602 lifecycle helpers were sourced before global lock acquisition.

# One Lead verdict: launchd has loaded a replacement supervisor tuple.
VERIFIED_LEAD_PID=""
VERIFIED_LEAD_START=""
LEAD_RESTART_OUTCOME_REASON=""
launchd_lead_outcome_ready() {
    local daemon_target="$1" old_pid="${2:-}" old_start="${3:-}"
    local probe daemon_pid daemon_start
    LEAD_RESTART_OUTCOME_REASON=""
    probe="$(lead_restart_launchd_probe "$daemon_target")"
    [[ "$probe" == loaded$'\t'* ]] || {
        LEAD_RESTART_OUTCOME_REASON="supervisor_not_loaded"
        return 1
    }
    daemon_pid="${probe#*$'\t'}"
    [[ "$daemon_pid" =~ ^[1-9][0-9]*$ ]] || {
        LEAD_RESTART_OUTCOME_REASON="supervisor_pid_invalid"
        return 1
    }
    daemon_start="$(lead_restart_process_start_identity "$daemon_pid")" || {
        LEAD_RESTART_OUTCOME_REASON="supervisor_start_unavailable"
        return 1
    }
    [[ -n "$daemon_start" ]] || {
        LEAD_RESTART_OUTCOME_REASON="supervisor_start_unavailable"
        return 1
    }
    if [[ "$old_pid" =~ ^[1-9][0-9]*$ && "$daemon_pid" == "$old_pid" ]] \
      && [[ -z "$old_start" || "$daemon_start" == "$old_start" ]]; then
        LEAD_RESTART_OUTCOME_REASON="old_supervisor_still_loaded"
        return 1
    fi
    VERIFIED_LEAD_PID="$daemon_pid"
    VERIFIED_LEAD_START="$daemon_start"
    return 0
}

lead_body_debug_observation() {
    local project_name="$1" lead_id="$2" inventory="" row=""
    inventory="$(lead_body_pane_inventory 2>/dev/null || true)"
    row="$(printf '%s\n' "$inventory" | awk -F '\t' \
      -v name="${project_name}-${lead_id}" '$2 == name && $5 == 0 {print $4; exit}')"
    [[ -n "$row" ]] && printf 'pane-pid=%s\n' "$row" || printf 'none\n'
}

restart_lead_bootstrap_job() {
    local plist="$1" lead_id="$2" rc=0
    launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1 || rc=$?
    if (( rc != 0 )); then
        log "WARNING: launchctl bootstrap returned $rc for $lead_id; retrying once"
        sleep 1
        rc=0
        launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1 || rc=$?
    fi
    return "$rc"
}

restart_lead_recover_job_after_failure() {
    local backend="$1" old_pid="$2" old_start="$3" sweep_safe="$4"
    local plist="$5" lead_id="$6" daemon_key="${7:-}"
    local marker="${8:-}" attempt_id="${9:-}" gate_root="${10:-}"
    local old_dead=false
    lead_restart_old_tuple_dead "$old_pid" "$old_start" && old_dead=true
    if lead_restart_recovery_bootstrap_allowed "$backend" "$old_dead" "$sweep_safe"; then
        if [[ -n "$daemon_key" && -n "$marker" && -n "$attempt_id" && -n "$gate_root" ]] \
          && lead_restart_arm_controlled_wave \
            "$daemon_key" "$marker" "$attempt_id" "$gate_root" \
          && lead_restart_authority_unchanged \
          && restart_lead_bootstrap_job "$plist" "$lead_id"; then
            lead_restart_update_marker_phase "$marker" "$attempt_id" bootstrap || true
            log "WARNING: Lead $lead_id restart failed, but its launchd job was restored under the verified carrier"
            return 0
        fi
    fi
    alert_severe "lead-restart-offline-${lead_id}" "Lead restart requires manual recovery" \
        "Lead $lead_id 重启证据不完整，且无法安全恢复 launchd job。为避免双 supervisor/误清窗口，Lead 保持离线等待人工处理。"
    return 1
}

# Returns: 0=success, 1=error
# Args: <manifest_path>  (caller passes the manifest directly, no re-globbing)
restart_lead() {
    local manifest="$1"

    VERIFIED_LEAD_PID=""
    VERIFIED_LEAD_START=""
    VERIFIED_LEAD_ELAPSED_SECONDS=""

    local lead_id project_dir project_name projects_file canonical_identity bot_token_env
    local legacy_bot_token_env legacy_backend canonical_backend
    local lead_verify_started_at=""
    lead_id=$(jq -er '.leadId | select(type == "string" and length > 0)' "$manifest") || return 1
    project_dir=$(jq -er '.projectDir | select(type == "string" and length > 0)' "$manifest") || return 1
    project_name=$(jq -er '.projectName | select(type == "string" and length > 0)' "$manifest") || return 1
    projects_file=$(jq -er --arg fallback "${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/projects.json" \
        '.projectsFile // $fallback | select(type == "string" and length > 0)' "$manifest") || return 1

    # FLY-1726: the manifest is a selector, never a second identity source.
    # Resolve the canonical row and its token selector before bootout, TERM, or
    # any other state change so a broken identity cannot turn a healthy Lead
    # into an offline one. The wrapper repeats this at actual process birth.
    if jq -e '
        has("botUserId") or has("discordStateDir")
        or has("identityDigest") or has("projectsDigest") or has("leadKey")
        or has("role") or has("backend")
      ' "$manifest" >/dev/null 2>&1; then
        log "ERROR: Lead $lead_id manifest contains forbidden identity fields"
        return 1
    fi
    legacy_bot_token_env=$(jq -er '
        if has("botTokenEnv")
        then .botTokenEnv | select(type == "string" and length > 0)
        else ""
        end' "$manifest") || {
        log "ERROR: Lead $lead_id manifest botTokenEnv witness is invalid"
        return 1
    }
    legacy_backend=$(jq -er '
        if has("leadBackend")
        then .leadBackend
          | select(type == "object" and (keys == ["backendId"]))
          | .backendId | select(type == "string" and length > 0)
        else ""
        end' "$manifest") || {
        log "ERROR: Lead $lead_id manifest leadBackend witness is invalid"
        return 1
    }
    local identity_cli="${FLYWHEEL_LEAD_IDENTITY_CLI:-${FLYWHEEL_DIR}/packages/flywheel-comm/dist/index.js}"
    if [[ ! -f "$identity_cli" ]]; then
        log "ERROR: canonical Lead identity CLI is missing; cannot restart $lead_id"
        return 1
    fi
    canonical_identity=$(node "$identity_cli" lead-identity resolve \
        --projects-file "$projects_file" \
        --project "$project_name" \
        --lead "$lead_id" \
        --format json) || {
        log "ERROR: canonical Lead identity resolution failed; cannot restart $lead_id"
        return 1
    }
    bot_token_env=$(jq -er '.botTokenEnv | select(type == "string" and length > 0)' \
        <<<"$canonical_identity") || return 1
    canonical_backend=$(jq -er '.backend | select(type == "string" and length > 0)' \
        <<<"$canonical_identity") || return 1
    if [[ -n "$legacy_bot_token_env" && "$legacy_bot_token_env" != "$bot_token_env" ]]; then
        log "ERROR: Lead $lead_id manifest botTokenEnv conflicts with canonical identity"
        return 1
    fi
    if [[ -n "$legacy_backend" && "$legacy_backend" != "$canonical_backend" ]]; then
        log "ERROR: Lead $lead_id manifest leadBackend conflicts with canonical identity"
        return 1
    fi
    # Invalid indirect env names must not reach ${!name}.
    if [[ ! "$bot_token_env" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || [[ -z "${!bot_token_env:-}" ]]; then
        log "ERROR: $bot_token_env is not set or is not a valid env name; cannot restart $lead_id"
        alert_warning "lead-restart-failed-${lead_id}" "Lead restart failed" \
            "Lead $lead_id 重启失败: bot token env 未定义或名称无效"
        return 1
    fi

    # FLY-80: Fallback if projectDir is a deleted worktree — resolve to main repo
    if [[ ! -d "$project_dir" ]]; then
        log "projectDir '$project_dir' not found (worktree may be deleted)"
        local parent_dir stale_base best_cand="" best_len=0
        parent_dir="$(dirname "$project_dir")"
        stale_base="$(basename "$project_dir")"
        if [[ -d "$parent_dir" ]]; then
            local candidate cand_base
            for candidate in "$parent_dir"/*; do
                cand_base="$(basename "$candidate")"
                # Only consider candidates matching worktree naming convention:
                # stale path (e.g. "flywheel-fly-80") must start with candidate + "-"
                [[ -d "$candidate/.git" ]] || continue
                [[ "$stale_base" == "${cand_base}-"* || "$stale_base" == "$cand_base" ]] || continue
                # Prefer longest matching basename (most specific: "foo-app" > "foo")
                if (( ${#cand_base} > best_len )); then
                    best_len=${#cand_base}
                    best_cand="$candidate"
                fi
            done
            if [[ -n "$best_cand" ]]; then
                if main_repo=$(resolve_main_repo "$best_cand"); then
                    log "Resolved projectDir to main repo: $main_repo"
                    project_dir="$main_repo"
                fi
            fi
        fi
        if [[ ! -d "$project_dir" ]]; then
            log "ERROR: Cannot resolve projectDir for Lead $lead_id — skipping"
            return 1
        fi
    fi

    local daemon_key="${project_name}-${lead_id}"
    local daemon_label="com.flywheel.lead.${daemon_key}"
    local daemon_target
    daemon_target="gui/$(id -u)/${daemon_label}"
    local pid_file="${HOME}/.flywheel/pids/${project_name}-${lead_id}.pid"
    local plist="${HOME}/Library/LaunchAgents/${daemon_label}.plist"
    # A plist on disk defines launchd lifecycle ownership even when the job is
    # currently unloaded. This avoids misclassifying an offline daemon as legacy.
    if [[ -f "$plist" || -L "$plist" ]]; then
        if ! lead_restart_validate_authority "$manifest" "$plist" "$projects_file" "$daemon_label"; then
            log "ERROR: Lead $lead_id carrier/plist/projects authority is invalid; refusing before bootout"
            alert_warning "lead-restart-carrier-drift-${lead_id}" "Lead restart carrier drift" \
                "Lead $lead_id 的 manifest/projects/plist 载体无法交叉验证，已在任何状态变更前拒绝重启。"
            return 1
        fi
        local backend="$LEAD_RESTART_BACKEND"

        # launchd owns every Claude body. A regular rebirth is
        # one native kickstart; no bootout choreography, body sweep, global
        # tmux lock, replacement marker, or adoption/recovery loop participates.
        if [[ "$backend" == "claude-code" ]]; then
            local v2_probe v2_old_pid="" v2_old_start="" v2_attempt
            v2_probe="$(lead_restart_launchd_probe "$daemon_target")"
            if [[ "$v2_probe" != loaded$'\t'* ]]; then
                log "ERROR: Claude Lead $lead_id is not loaded; refusing any unmanaged fallback"
                return 1
            fi
            v2_old_pid="${v2_probe#*$'\t'}"
            [[ "$v2_old_pid" =~ ^[1-9][0-9]*$ ]] || return 1
            v2_old_start="$(lead_restart_process_start_identity "$v2_old_pid")" || return 1
            [[ -n "$v2_old_start" ]] || return 1
            lead_verify_started_at="$(_lead_verify_now 2>/dev/null)" || lead_verify_started_at=""
            if ! launchctl kickstart -k "$daemon_target" >/dev/null 2>&1; then
                log "ERROR: native launchd kickstart failed for Claude Lead $lead_id"
                return 1
            fi
            for (( v2_attempt=1; v2_attempt<=LEAD_VERIFY_ATTEMPTS; v2_attempt++ )); do
                if launchd_lead_outcome_ready "$daemon_target" "$v2_old_pid" "$v2_old_start"; then
                    capture_successful_lead_verify_elapsed "$lead_verify_started_at"
                    log "Lead $lead_id restarted via native launchd carrier v2 (PID $VERIFIED_LEAD_PID)"
                    return 0
                fi
                (( v2_attempt < LEAD_VERIFY_ATTEMPTS )) && sleep "$LEAD_VERIFY_INTERVAL"
            done
            log "ERROR: Claude Lead $lead_id did not produce a fresh launchd PID (${LEAD_RESTART_OUTCOME_REASON:-unknown})"
            return 1
        fi

        local probe old_pid="" old_start="" probe_pid=""
        local replacement_marker="" replacement_attempt=""
        local gate_root="${HOME}/.flywheel/restart-ledger"
        probe="$(lead_restart_launchd_probe "$daemon_target")"
        if [[ "$probe" == "error" ]]; then
            log "ERROR: launchd probe failed for $lead_id; refusing before bootout"
            return 1
        fi
        if [[ "$probe" == loaded$'\t'* ]]; then
            probe_pid="${probe#*$'\t'}"
            if [[ "$probe_pid" =~ ^[1-9][0-9]*$ ]]; then
                old_pid="$probe_pid"
                old_start="$(lead_restart_process_start_identity "$old_pid")" || {
                    log "ERROR: cannot capture old supervisor start identity for $lead_id (PID $old_pid)"
                    return 1
                }
                [[ -n "$old_start" ]] || return 1
            fi
        fi
        if ! lead_restart_write_replacement_marker \
          "$daemon_key" "$daemon_label" "$old_pid" "$old_start"; then
            log "ERROR: Lead $lead_id restart breadcrumb could not be committed; refusing before bootout"
            alert_severe "lead-restart-marker-${lead_id}" "Lead restart breadcrumb failed" \
                "Lead $lead_id 无法在 bootout 前持久化 restart breadcrumb，已保持现状并拒绝换代。"
            return 1
        fi
        replacement_marker="$LEAD_RESTART_MARKER_FILE"
        replacement_attempt="$LEAD_RESTART_ATTEMPT_ID"
        if [[ "$probe" == loaded$'\t'* ]]; then
            log "Stopping and unloading Lead $lead_id via launchd bootout (old supervisor ${old_pid:-none})..."
            local bootout_rc=0
            launchctl bootout "$daemon_target" >/dev/null 2>&1 || bootout_rc=$?
            (( bootout_rc == 0 )) || log "WARNING: launchctl bootout returned $bootout_rc for $lead_id; quiescence proof remains authoritative"
        fi

        local assertion_file="${HOME}/.flywheel/state/carrier-assertions/${daemon_key}.json"
        local quiet_rc=0
        LEAD_RESTART_QUIESCENCE_ATTEMPTS="$LEAD_QUIESCENCE_ATTEMPTS" \
        LEAD_RESTART_QUIESCENCE_INTERVAL="$LEAD_QUIESCENCE_INTERVAL" \
          lead_restart_wait_quiescent \
            "$daemon_target" "$old_pid" "$old_start" "$backend" \
            "$project_name" "$lead_id" "$assertion_file" || quiet_rc=$?
        if (( quiet_rc != 0 )); then
            log "ERROR: Lead $lead_id did not reach proven launchd/supervisor quiescence (rc=$quiet_rc)"
            restart_lead_recover_job_after_failure \
                "$backend" "$old_pid" "$old_start" false "$plist" "$lead_id" \
                "$daemon_key" "$replacement_marker" "$replacement_attempt" "$gate_root" || true
            return 1
        fi

        local clear_rc=0
        lead_body_hard_clear "$project_name" "$lead_id" "$backend" || clear_rc=$?
        if (( clear_rc != 0 )); then
            log "ERROR: Lead $lead_id body hard-clear did not converge (rc=$clear_rc)"
            restart_lead_recover_job_after_failure \
                "$backend" "$old_pid" "$old_start" false "$plist" "$lead_id" \
                "$daemon_key" "$replacement_marker" "$replacement_attempt" "$gate_root" || true
            return 1
        fi
        rm -f "$pid_file"

        if ! lead_restart_arm_controlled_wave \
          "$daemon_key" "$replacement_marker" "$replacement_attempt" "$gate_root"; then
            log "ERROR: Lead $lead_id controlled restart gate arm failed (${LEAD_RESTART_GATE_FAILURE_REASON})"
            alert_severe "lead-restart-gate-control-${lead_id}" "Lead restart gate control failed" \
                "Lead $lead_id 已完成安全清场，但 controlled-wave gate 未武装 (${LEAD_RESTART_GATE_FAILURE_REASON})；零 bootstrap，breadcrumb 留作下次诊断。"
            return 1
        fi
        if ! lead_restart_authority_unchanged; then
            log "ERROR: Lead $lead_id authority changed after bootout; refusing bootstrap"
            alert_severe "lead-restart-authority-drift-${lead_id}" "Lead restart authority changed" \
                "Lead $lead_id 在 bootout 后 manifest/projects/plist 发生漂移，已拒绝 bootstrap，等待人工处理。"
            return 1
        fi
        lead_verify_started_at="$(_lead_verify_now 2>/dev/null)" || lead_verify_started_at=""
        if ! restart_lead_bootstrap_job "$plist" "$lead_id"; then
            log "ERROR: launchctl bootstrap failed twice for $lead_id"
            alert_severe "lead-restart-bootstrap-failed-${lead_id}" "Lead restart bootstrap failed" \
                "Lead $lead_id 已完成安全清场，但 launchd bootstrap 两次失败，Lead 当前离线，需人工处理。"
            return 1
        fi
        if ! lead_restart_update_marker_phase \
          "$replacement_marker" "$replacement_attempt" bootstrap; then
            log "DEBUG: Lead $lead_id bootstrap succeeded but breadcrumb phase update failed"
        fi

        local attempt
        for (( attempt=1; attempt<=LEAD_VERIFY_ATTEMPTS; attempt++ )); do
            if launchd_lead_outcome_ready "$daemon_target" "$old_pid" "$old_start"; then
                capture_successful_lead_verify_elapsed "$lead_verify_started_at"
                log "Lead $lead_id restarted via launchd (supervisor $VERIFIED_LEAD_PID born $VERIFIED_LEAD_START)"
                log "DEBUG: Lead $lead_id body observation: $(lead_body_debug_observation "$project_name" "$lead_id")"
                if ! lead_restart_remove_marker "$replacement_marker" "$replacement_attempt"; then
                    log "DEBUG: Lead $lead_id restart succeeded but breadcrumb cleanup failed"
                fi
                return 0
            fi
            (( attempt < LEAD_VERIFY_ATTEMPTS )) && sleep "$LEAD_VERIFY_INTERVAL"
        done
        log "ERROR: Lead $lead_id launchd replacement did not appear within $((LEAD_VERIFY_ATTEMPTS * LEAD_VERIFY_INTERVAL))s (${LEAD_RESTART_OUTCOME_REASON:-unknown})"
        return 1
    fi

    log "ERROR: Lead $lead_id has no launchd job; refusing to create an unmanaged body. Install its canonical plist first."
    alert_warning "lead-restart-unmanaged-${lead_id}" "Lead restart refused" \
        "Lead $lead_id 没有 canonical launchd job；已拒绝 nohup/orphan fallback，请先安装 plist。"
    return 1
}

# FLY-98 + FLY-129 Phase 8: Trigger cmux linked-session refresh + (Path A)
# cmux UI surface invalidation after Lead restart.
# Must be called OUTSIDE do_restart_all_leads to preserve stdout contract.
# Uses repo script directly (not ~/.flywheel/bin copy) to avoid stale-install rollout gap.
#
# FLY-129 Phase 8 Path A (H2 fix): after the tmux-only refresh lands, call
# `cmux refresh-surfaces --workspace <ref>` for each Lead workspace ref to
# invalidate the cmux Electron-side pane cache that would otherwise show
# the old (pre-restart) zsh / Claude process.
#
# Gated by env var FLYWHEEL_CMUX_H2_FIX (default: refresh-surfaces).
# Set to "none" to disable Path A while leaving Path B (--close-for-restart)
# usable as an operator escape hatch. See doc/engineer/research/new/FLY-129-refresh-surfaces-spike.md.
trigger_cmux_refresh() {
    local sync_script="${FLYWHEEL_DIR}/scripts/flywheel-cmux-sync.sh"
    if [[ ! -x "$sync_script" ]]; then
        return 0
    fi
    # Step 1: tmux-only refresh (unchanged, FLY-98).
    (sleep 5 && "$sync_script" --refresh >> "/tmp/flywheel-cmux-sync.log" 2>&1) &
    log "cmux refresh scheduled (background, 5s delay)"

    # Step 2: Phase 8 Path A — cmux refresh-surfaces per Lead ref (10s after
    # refresh so linked sessions are settled). No-op if cmux CLI missing or
    # the env var disables it.
    local h2_mode="${FLYWHEEL_CMUX_H2_FIX:-refresh-surfaces}"
    if [[ "$h2_mode" != "refresh-surfaces" ]]; then
        log "cmux refresh-surfaces disabled (FLYWHEEL_CMUX_H2_FIX=$h2_mode)"
        return 0
    fi
    if ! command -v cmux >/dev/null 2>&1; then
        log "cmux CLI not on PATH — skipping refresh-surfaces step"
        return 0
    fi
    (
        sleep 10
        local rc=0
        local refs
        refs=$("$sync_script" --list-lead-refs 2>>"/tmp/flywheel-cmux-sync.log") || rc=$?
        if [[ $rc -ne 0 || -z "$refs" ]]; then
            echo "[trigger_cmux_refresh] no lead refs to refresh (rc=$rc)" >> "/tmp/flywheel-cmux-sync.log"
            exit 0
        fi
        while read -r ref; do
            [[ -z "$ref" ]] && continue
            cmux refresh-surfaces --workspace "$ref" >> "/tmp/flywheel-cmux-sync.log" 2>&1 || true
            echo "[trigger_cmux_refresh] refresh-surfaces ws=$ref" >> "/tmp/flywheel-cmux-sync.log"
        done <<< "$refs"
    ) &
    log "cmux refresh-surfaces scheduled (background, 10s delay)"
}

# Single batching delay seam. It intentionally emits no stdout so callers keep
# receiving only the machine-readable Lead result contract.
_dral_sleep() {
    sleep "$1"
}

# Restart all Leads in explicit stagger|immediate mode.
# Outputs "skipped:N failed:M total:K" to stdout.
# All logs go to stderr; stdout is machine-readable only.
do_restart_all_leads() {
    local mode="${1:-}"
    local batch_size=4 pause_secs=60
    local skipped=0
    local failed=0
    local eligible=0
    local restart_attempts=0
    case "$mode" in
        stagger|immediate) ;;
        *)
            printf 'ERROR: do_restart_all_leads requires mode stagger|immediate (got %s)\n' \
                "${mode:-missing}" >&2
            return 64
            ;;
    esac
    if [[ -n "${LEAD_RESTART_NAMES_FILE:-}" ]]; then
        { : > "$LEAD_RESTART_NAMES_FILE"; } 2>/dev/null || true
    fi
    if [[ -n "${LEAD_BODY_OBSERVATIONS_FILE:-}" ]]; then
        { : > "$LEAD_BODY_OBSERVATIONS_FILE"; } 2>/dev/null || true
    fi
    if [[ -n "${LEAD_VERIFY_TIMINGS_FILE:-}" ]]; then
        { : > "$LEAD_VERIFY_TIMINGS_FILE"; } 2>/dev/null || true
    fi

    # FLY-954: converge <state>/bin BEFORE kickstarting any Lead — kickstarting
    # a corrupted wrapper takes the fleet down (2026-07-06: 12-byte stub +
    # KeepAlive throttling = 13 Leads offline). FAIL-LOUD: if convergence
    # cannot leave bin healthy, refuse the whole Lead restart wave (reported
    # through the existing skipped/failed stdout contract; code deployment
    # truth still advances while Lead health is recorded degraded).
    # Codex code R1 MEDIUM: report the refusal through the stdout contract and
    # return 0 — both production call sites capture this function via $( ) under
    # `set -e`, so a non-zero return would kill the whole script at the
    # assignment, skipping the existing failed>0 handling (deploy-failure
    # notification + degraded Lead-status evidence + plugin-only retry marker).
    local _conv_dir
    _conv_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -f "${_conv_dir}/converge-flywheel-bin.sh" ]; then
        if ! bash "${_conv_dir}/converge-flywheel-bin.sh" >&2; then
            log "ERROR: flywheel-bin convergence failed — refusing to kickstart Leads on a possibly-corrupt bin (FLY-954)" >&2
            record_lead_restart_detail wave_error "flywheel-bin convergence 失败"
            echo "skipped:0 failed:1 total:0"
            return 0
        fi
    else
        # bin-copy execution context (fleet host): fall back to FLYWHEEL_DIR repo
        if ! bash "${FLYWHEEL_DIR}/scripts/converge-flywheel-bin.sh" >&2; then
            log "ERROR: flywheel-bin convergence failed — refusing to kickstart Leads (FLY-954)" >&2
            record_lead_restart_detail wave_error "flywheel-bin convergence 失败"
            echo "skipped:0 failed:1 total:0"
            return 0
        fi
    fi

    local host_tmux_target_sha=""
    host_tmux_target_sha="$(git -C "$FLYWHEEL_DIR" rev-parse --verify HEAD 2>/dev/null)" || host_tmux_target_sha=""
    if ! restart_host_tmux_gate "$host_tmux_target_sha" restart-lead-wave \
      scripts/restart-services.sh:before-lead-wave; then
        log "ERROR: host tmux selection gate failed after bin convergence — refusing Lead restart wave" >&2
        record_lead_restart_detail wave_error "host tmux 选择门失败"
        echo "skipped:0 failed:1 total:0"
        return 0
    fi
    # FLY-1507: one authoritative inventory (manifest + positively loaded plist),
    # deduplicated by exact
    # (projectName, leadId) daemon key. QA candidates never affect counts.
    local candidates_file=""
    candidates_file="$(mktemp "${TMPDIR:-/tmp}/flywheel-restart-candidates.XXXXXX")" || {
        log "ERROR: cannot allocate Lead restart candidate inventory" >&2
        record_lead_restart_detail wave_error "候选清单分配失败"
        echo "skipped:0 failed:1 total:0"
        return 0
    }
    register_restart_transient_file "$candidates_file"
    local candidate_rc=0
    lead_restart_collect_candidates \
        "${HOME}/.flywheel/manifests" \
        "${HOME}/Library/LaunchAgents" \
        "${HOME}/.flywheel/projects.json" \
        "$candidates_file" || candidate_rc=$?
    if (( candidate_rc != 0 )); then
        log "ERROR: Lead candidate inventory is indeterminate (rc=$candidate_rc)" >&2
        rm -f "$candidates_file"
        record_lead_restart_detail wave_error "清单收敛失败(rc=$candidate_rc)"
        echo "skipped:0 failed:1 total:0"
        return 0
    fi
    if ! restart_host_tmux_census "$candidates_file"; then
        log "ERROR: loaded Lead plist carrier census failed — refusing Lead restart wave" >&2
        rm -f "$candidates_file"
        record_lead_restart_detail wave_error "Lead carrier census 失败"
        echo "skipped:0 failed:1 total:0"
        return 0
    fi
    # A retained marker is only a breadcrumb from an interrupted prior run.
    # The current run performs the normal hard replacement from live authority.
    local marker_dir="${FLYWHEEL_LEAD_REPLACEMENT_DIR:-${HOME}/.flywheel/state/lead-replacements}"
    local marker marker_key old_nullglob
    old_nullglob="$(shopt -p nullglob || true)"
    shopt -s nullglob
    local replacement_markers=("$marker_dir"/*.json)
    eval "$old_nullglob"
    for marker in ${replacement_markers[@]+"${replacement_markers[@]}"}; do
        marker_key="${marker##*/}"; marker_key="${marker_key%.json}"
        log "WARNING: removing interrupted-restart breadcrumb for $marker_key; normal replacement will run" >&2
        rm -f "$marker" 2>/dev/null \
          || log "DEBUG: could not remove breadcrumb $marker; normal replacement still runs" >&2
    done

    local key pn lid mf classification sources rc
    local candidate_count=0
    while IFS=$'\t' read -r key pn lid mf classification sources; do
        [[ -n "$key" ]] || continue
        candidate_count=$((candidate_count + 1))
        if [[ "$classification" != skip-test ]]; then
            eligible=$((eligible + 1))
        fi
        case "$classification" in
            skip-test)
                log "Skipping test-slot Lead candidate (lifecycle-owned, not deploy-blocking): key=$key sources=$sources" >&2
                ;;
            restart)
                if [[ "$mf" == "-" || ! -f "$mf" ]]; then
                    log "ERROR: restart candidate $key has no readable manifest" >&2
                    failed=$((failed + 1))
                    record_lead_restart_detail failed "$key"
                    continue
                fi
                if [[ "$mode" == "stagger" && "$restart_attempts" -gt 0 ]] \
                  && (( restart_attempts % batch_size == 0 )); then
                    _dral_sleep "$pause_secs" >&2
                fi
                restart_attempts=$((restart_attempts + 1))
                rc=0
                restart_lead "$mf" >&2 || rc=$?
                if (( rc != 0 )); then
                    failed=$((failed + 1))
                    record_lead_restart_detail failed "$key"
                else
                    record_successful_lead_verify_timing \
                      "$key" "$VERIFIED_LEAD_ELAPSED_SECONDS"
                    record_successful_lead_body_observation \
                      "$key" "$pn" "$lid" "$VERIFIED_LEAD_PID" "$VERIFIED_LEAD_START"
                fi
                ;;
            manifestless)
                log "WARNING: loaded/running Lead $key has no manifest — visible but not restarted (sources=$sources)" >&2
                alert_warning "lead-restart-manifestless-${key}" "Lead restart skipped" \
                    "Lead $key 已加载但没有 manifest，本次未重启；请补齐 carrier 配置后再收敛。"
                skipped=$((skipped + 1))
                record_lead_restart_detail skipped "$key"
                ;;
            probe-error|config-drift|*)
                log "ERROR: Lead candidate $key cannot be assigned safe restart authority (class=$classification project=$pn lead=$lid sources=$sources)" >&2
                alert_warning "lead-restart-config-drift-${key}" "Lead restart config drift" \
                    "Lead $key 无法从 manifest/loaded plist/process 与 projects.json 得到唯一一致身份，本次拒绝重启。"
                failed=$((failed + 1))
                record_lead_restart_detail failed "$key"
                ;;
        esac
    done < "$candidates_file"
    rm -f "$candidates_file"

    if (( candidate_count == 0 )); then
        log "WARNING: No Leads found (no manifests, no running processes)" >&2
    fi

    echo "skipped:${skipped} failed:${failed} total:${eligible}"
}

# ════════════════════════════════════════════════════════════════
# Build
# ════════════════════════════════════════════════════════════════

build_project() {
    log "Building..."
    cd "$FLYWHEEL_DIR"

    if [[ "$need_install" == "true" ]]; then
        log "Running pnpm install..."
        pnpm install --frozen-lockfile || {
            log "ERROR: pnpm install failed"
            cd - > /dev/null
            return 1
        }
    fi

    pnpm build || {
        log "ERROR: pnpm build failed"
        cd - > /dev/null
        return 1
    }

    cd - > /dev/null
    log "Build successful"
}

# FLY-2240: public profile switching has no bash-only fallback. Prove the
# freshly built atomic switch runtime is present and loadable before any new
# Bridge/Lead process is started. A generation predating FLY-2240 has neither
# artifact and remains restart/rollback compatible; a partial installation is
# always a hard failure.
account_switch_runtime_preflight() {
    local runtime="${FLYWHEEL_DIR}/packages/teamlead/dist/account-heal/account-switch-cli.js"
    local launcher="${FLYWHEEL_DIR}/packages/teamlead/bin/flywheel-claude-switch"
    if [[ ! -e "$runtime" && ! -e "$launcher" ]]; then
        log "Atomic account-switch runtime preflight: not required by this source generation"
        return 0
    fi
    if [[ ! -f "$runtime" || ! -x "$launcher" ]]; then
        log "ERROR: atomic account-switch runtime is missing after build"
        return 1
    fi
    if ! "$launcher" --runtime-check >/dev/null; then
        log "ERROR: atomic account-switch runtime failed its load check"
        return 1
    fi
    log "Atomic account-switch runtime preflight: OK"
}

# ════════════════════════════════════════════════════════════════
# Rollback
# ════════════════════════════════════════════════════════════════

rollback_and_restart() {
    local rollback_sha="$1"
    local rb_status_output="" rb_status_rc=0

    # Guard: first run has no known-good SHA
    if [[ -z "$rollback_sha" ]]; then
        log "ERROR: No known-good SHA for rollback (first run). Manual intervention required."
        alert_severe "deploy-failed-no-rollback" "Flywheel deploy failed" \
            "Flywheel 首次部署失败且无法自动回滚（无 known-good SHA）。需要手动介入。"
        RESTART_TERMINAL_REPORTED=true
        return 1
    fi

    log "Rolling back to ${rollback_sha:0:7}"

    # Fail-closed for tracked dirt. Untracked paths were already admitted by
    # the pull preflight and reset --hard does not remove them.
    rb_status_output="$(GIT_OPTIONAL_LOCKS=0 git -C "$FLYWHEEL_DIR" status --porcelain --untracked-files=no 2>/dev/null)" || rb_status_rc=$?
    if (( rb_status_rc != 0 )); then
        log "ERROR: cannot read working-tree state (git status rc=${rb_status_rc}); refusing reset --hard"
        alert_severe "rollback-blocked-state-unreadable" "Flywheel rollback blocked" \
            "Flywheel rollback 被阻止: 无法读取工作区状态 (git status 失败, rc=${rb_status_rc})。状态未知时绝不执行 reset --hard。需要手动介入。"
        RESTART_TERMINAL_REPORTED=true
        return 1
    fi
    if [[ -n "$rb_status_output" ]]; then
        log "ERROR: Working directory not clean, refusing rollback"
        alert_severe "rollback-blocked-dirty" "Flywheel rollback blocked" \
            "Flywheel rollback 被阻止: 工作区不干净。需要手动介入。"
        RESTART_TERMINAL_REPORTED=true
        return 1
    fi

    if ! git -C "$FLYWHEEL_DIR" reset --hard "$rollback_sha"; then
        log "ERROR: git reset --hard ${rollback_sha:0:7} failed during rollback; working tree state unknown, stopping"
        alert_severe "rollback-reset-failed" "Flywheel rollback failed" \
            "Flywheel rollback 执行 reset --hard 到 \`${rollback_sha:0:7}\` 失败,工作区状态未知。已停止(不重建、不重启旧版本)。需要手动介入。"
        RESTART_TERMINAL_REPORTED=true
        return 1
    fi

    # Best-effort: rebuild old version and restart
    if pnpm -C "$FLYWHEEL_DIR" install --frozen-lockfile && \
       pnpm -C "$FLYWHEEL_DIR" build; then
        if [[ "$restart_bridge" == "true" ]]; then
            if ! pause_admission_best_effort; then
                log "WARNING: rollback admission pause failed; continuing rollback recovery"
            fi
            # FLY-516 (Codex R1 HIGH): stop_bridge is now fail-closed (returns 1 on
            # a stuck port). Guard the bare call — under `set -e` an unguarded
            # non-zero would abort the rollback silently. If the port can't be
            # freed even during rollback, the old version can't bind either →
            # severe alert + bail (a human must SIGKILL the listener).
            if ! stop_bridge; then
                alert_severe "rollback-port-stuck" "Flywheel deploy failed" \
                    "Flywheel 回滚时 Bridge 端口 :$(bridge_port) 未能释放 — 无法重启旧版本。需手动 SIGKILL listener (lsof -ti:$(bridge_port))。"
                RESTART_TERMINAL_REPORTED=true
                return 1
            fi
            start_bridge
        fi
        local rb_leads_failed=0
        if [[ "$restart_all_leads" == "true" ]]; then
            # FLY-270 (R1#4): parse the Lead-restart result instead of discarding
            # it. A rolled-back-but-NOT-recovered Eng Lead must be surfaced as a
            # severe alert, never conflated with "code rolled back" success.
            local rb_lead_result
            rb_lead_result=$(do_restart_all_leads immediate)
            rb_leads_failed=$(rn_parse_count failed "$rb_lead_result")
            if [[ "$rb_leads_failed" == "invalid" ]]; then
                alert_severe "rollback-lead-result-unreadable" "Flywheel deploy failed" \
                    "Flywheel 已尝试回滚到 \`${rollback_sha:0:7}\`，但回滚后的 Lead 结果无法读取，恢复状态未知。请查部署日志并手动确认。"
                RESTART_TERMINAL_REPORTED=true
                return 1
            fi
            # FLY-98: trigger cmux refresh after rollback restart
            trigger_cmux_refresh
        fi
        if [[ "$restart_bridge" == "true" ]]; then
            resume_admission_best_effort
        fi
        if ! restart_voice_bridge_managed; then
            alert_severe "rollback-voice-bridge-failed" "Flywheel deploy failed" \
                "Flywheel 已回滚并重建到 \`${rollback_sha:0:7}\`，但 voice-bridge 旧版本受管重启/健康复验失败 (${VOICE_BRIDGE_RESTART_DETAIL})。Lead 恢复波次已先执行，deployed-sha 未推进，需要手动介入。"
            RESTART_TERMINAL_REPORTED=true
            return 1
        fi
        if (( rb_leads_failed > 0 )); then
            alert_severe "rollback-leads-failed" "Flywheel deploy failed" \
                "Flywheel 回滚到 \`${rollback_sha:0:7}\` 成功，但 ${rb_leads_failed} 个 Lead（含 Eng Lead？）未恢复——KeepAlive 重拉不了坏 token/manifest/config。需要手动开 terminal 检查。"
            RESTART_TERMINAL_REPORTED=true
        else
            alert_warning "update-rolled-back" "Flywheel update rolled back" \
                "Flywheel 更新到 \`${CURRENT_HEAD:0:7}\` 失败。已回滚到 \`${rollback_sha:0:7}\` 并重启旧版本（Lead 已恢复）。"
            RESTART_TERMINAL_REPORTED=true
        fi
        return 0
    else
        alert_severe "update-and-rollback-failed" "Flywheel deploy failed" \
            "Flywheel 更新失败且回滚 build 也失败。服务可能处于异常状态。需要手动介入。"
        RESTART_TERMINAL_REPORTED=true
        return 1
    fi
}

ensure_voice_bridge_for_deploy() {
    if restart_voice_bridge_managed; then
        return 0
    fi

    local detail="${VOICE_BRIDGE_RESTART_DETAIL:-unknown failure}"
    if [[ "$RESTART_CODE_ROLLBACK_DISABLED" == "1" ]]; then
        log "ERROR: voice-bridge verification failed; code-only rollback is disabled"
        alert_severe "deploy-voice-bridge-failed-code-rollback-disabled" \
            "Flywheel voice-bridge restart failed; code-only rollback disabled" \
            "voice-bridge 受管重启/健康复验失败 (${detail})。deployed-sha 未推进；未执行不带数据库快照的代码回滚，请走 window rollback。"
        resume_admission_best_effort
        RESTART_TERMINAL_REPORTED=true
        return 1
    fi

    log "ERROR: voice-bridge verification failed (${detail}); attempting rollback"
    if ! rollback_and_restart "$DEPLOYED_SHA"; then
        log "ERROR: rollback after voice-bridge failure did not restore a healthy old voice service"
    fi
    return 1
}

# ════════════════════════════════════════════════════════════════
# Deploy + Verify
# ════════════════════════════════════════════════════════════════

deploy_and_verify() {
    RESTART_NOTICE_STARTED=true
    notify_routine "🔄 开始全量重启 Flywheel (reason=${RESTART_REASON}): \`${DEPLOYED_SHA:0:7}\` → \`${CURRENT_HEAD:0:7}\`"

    # Read-only preflight: surface detached QA tmux noise before the Lead wave
    # without treating daemon shape as cleanup authority.
    if type audit_tmux_qa_residue_read_only >/dev/null 2>&1; then
        audit_tmux_qa_residue_read_only
    fi

    # Step 0: reject new admissions before the Bridge begins draining. This runs
    # inside the detached deploy body, never in the self-detaching parent.
    if [[ "$restart_bridge" == "true" ]]; then
        if ! pause_admission_best_effort; then
            log "ERROR: admission cutover owner handoff failed before Bridge stop"
            return 1
        fi
    fi

    # Step 1: Stop Bridge FIRST (triggers stopAccepting + drain)
    # FLY-516 (Codex R1 HIGH): fail-closed — if the old Bridge's port can't be
    # freed, abort BEFORE start_bridge + the /health check (which would otherwise
    # hit the stuck holder and falsely pass). bp_confirm_port_released already
    # alerted; do NOT advance deployed-sha.
    if [[ "$restart_bridge" == "true" ]]; then
        if ! stop_bridge; then
            resume_admission_best_effort
            log "ERROR: stop_bridge failed to free the port — aborting deploy (deployed-sha NOT advanced)."
            alert_severe "deploy-port-stuck" "Flywheel deploy aborted" \
                "Flywheel 部署中止: Bridge 端口未能释放,新 Bridge 无法 bind。需手动 SIGKILL listener (lsof -ti:$(bridge_port))。"
            RESTART_TERMINAL_REPORTED=true
            return 1
        fi

        # FLY-2139: use the already-stopped Bridge window for bounded SQLite
        # backup/checkpoint/weekly compaction. Failure evidence is durable and
        # alerting is emitted by the helper; maintenance must never strand the
        # fleet offline, so restart proceeds on a non-zero helper result.
        if ! bash "$FLYWHEEL_DIR/scripts/db-maintenance.sh"; then
            log "WARNING: database maintenance failed; continuing service restart"
            alert_severe "database-maintenance-failed" \
                "Flywheel database maintenance failed" \
                "Stopped-window database maintenance failed. Durable evidence is under ~/.flywheel/maintenance/fly-2139/db-maintenance; the restart continues so the fleet is not stranded offline. Inspect backup/checkpoint/integrity failure receipts immediately."
        fi
    fi

    # Step 2: Build (Bridge is stopped, no race possible)
    if [[ "$SKIP_BUILD" != "true" ]]; then
        if ! build_project; then
            if [[ "$RESTART_CODE_ROLLBACK_DISABLED" == "1" ]]; then
                log "ERROR: Build failed; code-only rollback is disabled for this restart"
                alert_severe "deploy-build-failed-code-rollback-disabled" \
                    "Flywheel build failed; code-only rollback disabled" \
                    "The migration-safe restart stopped after its build failed. It did not reset code without the matching database snapshot; use the window rollback procedure."
                RESTART_TERMINAL_REPORTED=true
            else
                log "Build failed, attempting rollback"
                rollback_and_restart "$DEPLOYED_SHA"
            fi
            # rollback_and_restart already handles stop+start of Bridge/Leads
            return 1
        fi

        if ! account_switch_runtime_preflight; then
            if [[ "$RESTART_CODE_ROLLBACK_DISABLED" == "1" ]]; then
                log "ERROR: atomic account-switch runtime preflight failed; code-only rollback is disabled"
                alert_severe "deploy-account-switch-runtime-unavailable" \
                    "Flywheel account switch runtime is unavailable" \
                    "The freshly built atomic Claude account-switch runtime is missing or unloadable. No new service was started; deployed-sha was not advanced. Use the window rollback procedure."
                RESTART_TERMINAL_REPORTED=true
            else
                log "Atomic account-switch runtime preflight failed, attempting rollback"
                rollback_and_restart "$DEPLOYED_SHA"
            fi
            return 1
        fi
    else
        log "Build skipped (no build-relevant code delta)"
    fi

    # FLY-1764: the old Bridge is stopped and the freshly built bytes no longer
    # produce per-Lead swap-broadcast rows. Retire every live legacy row across
    # the on-disk CommDB universe and prove the postcondition before the new
    # Bridge starts. Any DB/schema/lock failure is fail-closed.
    if [[ "$restart_bridge" == "true" ]]; then
        if legacy_swap_retirement_required "$DEPLOYED_SHA" "$FLYWHEEL_DIR"; then
            if ! retire_legacy_swap_broadcasts; then
                if [[ "$RESTART_CODE_ROLLBACK_DISABLED" == "1" ]]; then
                    log "ERROR: legacy swap broadcast retirement failed; code-only rollback is disabled for this restart"
                    alert_severe "legacy-swap-retirement-failed-code-rollback-disabled" \
                        "Fleet alert cleanup failed; code-only rollback disabled" \
                        "FLY-1764 旧 swap 广播清障未满足事务后置条件；迁移安全窗口禁止只回滚代码，新 Bridge 未启动。请按窗口回滚流程恢复。"
                    RESTART_TERMINAL_REPORTED=true
                else
                    log "Legacy swap broadcast retirement failed, attempting rollback"
                    rollback_and_restart "$DEPLOYED_SHA"
                fi
                # rollback_and_restart already handles rebuild + Bridge/Lead recovery.
                return 1
            fi
        fi
    fi

    # Step 3: Start new Bridge. The renderer consumes this explicit evidence;
    # it must never infer startup health from a later best-effort observation.
    local bridge_startup_state="unknown"
    if [[ "$restart_bridge" == "true" ]]; then
        start_bridge

        # Health check — wait for the new Bridge to be ready.
        # FLY-1600: the window was hardcoded to 60s (30×2s) while a real Bridge
        # boot took ~9 minutes under load — deployment was STRUCTURALLY unable
        # to succeed: health check always timed out, rollback_and_restart reset
        # the checkout to DEPLOYED_SHA (ejecting the just-merged fix), and the
        # Lead wave then relaunched from the OLD script. Five deploys failed in
        # exactly this loop on 2026-08-01/02 — including the one carrying the
        # spin-storm hotfix whose absence was what made the boot slow.
        # A long window is safe: the loop exits on the FIRST healthy probe, so
        # a fast boot still passes in seconds; only a genuinely dead Bridge
        # waits the full window before rolling back.
        local hc_tries="${FLYWHEEL_BRIDGE_HEALTH_TRIES:-450}"   # ×2s = 15 min default
        local hc_ok=false health_json=""
        for i in $(seq 1 "$hc_tries"); do
            if health_json="$(curl -sf "$BRIDGE_URL/health")" \
                && jq -e '.ok' <<<"$health_json" > /dev/null 2>&1; then
                hc_ok=true
                BRIDGE_HEALTH_JSON="$health_json"
                break
            fi
            if (( i % 15 == 0 )); then
                log "Bridge health: waiting ($((i*2))s / $((hc_tries*2))s max)"
            fi
            sleep 2
        done
        if [[ "$hc_ok" != "true" ]]; then
            if [[ "$RESTART_CODE_ROLLBACK_DISABLED" == "1" ]]; then
                log "ERROR: Bridge health check failed; code-only rollback is disabled for this restart"
                alert_severe "deploy-health-failed-code-rollback-disabled" \
                    "Flywheel health check failed; code-only rollback disabled" \
                    "The migration-safe restart stopped after Bridge health failed. It did not reset code without the matching database snapshot; use the window rollback procedure."
                RESTART_TERMINAL_REPORTED=true
            else
                log "ERROR: Bridge health check failed after restart. Attempting rollback."
                rollback_and_restart "$DEPLOYED_SHA"
            fi
            return 1
        fi
        log "Bridge health check: OK"
        if ! dbi_accept_health_identity "$FLYWHEEL_DIR" "$CURRENT_HEAD" "$BRIDGE_HEALTH_JSON" "$BRIDGE_DEPLOY_MODE"; then
            local identity_marker="${HOME}/.flywheel/state/deploy-build-identity-${CURRENT_HEAD}"
            log "ERROR: Bridge build identity rejected (${DBI_REASON}); deployed-sha NOT advanced."
            if [[ ! -f "$identity_marker" ]]; then
                alert_warning "deploy-build-identity-${CURRENT_HEAD}" \
                    "Flywheel build identity mismatch" \
                    "Bridge 健康但运行身份未证明包含 intended ${CURRENT_HEAD:0:7} (${DBI_REASON})。deployed-sha 未推进；已尝试释放本次普通部署拥有的 admission brake，legacy NULL-owner brake 可能保留到 TTL；请重建并重试。"
                mkdir -p "$(dirname "$identity_marker")" 2>/dev/null || true
                : > "$identity_marker" 2>/dev/null || true
            fi
            resume_admission_best_effort
            RESTART_TERMINAL_REPORTED=true
            return 1
        fi
        rm -f "${HOME}/.flywheel/state/deploy-build-identity-${CURRENT_HEAD}"
        bridge_startup_state="passed"
        if ! takeover_cutover_admission_pause_after_bridge_health; then
            log "ERROR: legacy cutover admission pause ownership was not transferred; refusing the Lead wave"
            alert_severe "cutover-admission-takeover-failed" \
                "Flywheel cutover admission takeover failed" \
                "The new Bridge is healthy but could not transfer the legacy cutover pause into a durable owner lease. No Lead restart wave was started; keep the fleet paused and inspect the cutover receipt/handoff."
            RESTART_TERMINAL_REPORTED=true
            return 1
        fi
    fi

    # Step 3.5: voice-bridge consumes the same freshly-built workspace but has
    # an independent supervisor and long-lived Headless/Resident descendants.
    # Replace it under this transaction's restart lock, prove :9878/health and
    # old PID+start tree reclamation, and fail before deployed-sha advancement.
    if ! ensure_voice_bridge_for_deploy; then
        return 1
    fi

    # FLY-1926: sample Bridge latency before the Lead restart wave creates its
    # load peak. This bounded probe is observational only: startup health and
    # build identity were proven independently above. Persistent wave/post-wave
    # downtime is covered by the loaded com.flywheel.bridge-liveness-probe,
    # which runs every 60s and pages after five consecutive down observations.
    local bridge_probe="" bridge_state="unavailable" bridge_ms="-"
    if [[ "$bridge_startup_state" == "passed" ]]; then
        bridge_probe=$(rn_probe_bridge_health "$BRIDGE_URL")
        IFS=$'\t' read -r bridge_state bridge_ms <<< "$bridge_probe" || true
        if [[ "$bridge_state" != "ok" || ! "$bridge_ms" =~ ^[0-9]+$ ]]; then
            bridge_state="unavailable"
            bridge_ms="-"
            log "WARNING: Bridge Lead-wave preflight latency observation unavailable; startup health and build identity already passed"
        fi
    fi

    # Step 4: Restart Leads (after Bridge is confirmed healthy)
    local leads_skipped=0
    local leads_failed=0
    local leads_total=0
    local lead_counts_known=true
    local lead_result_state="known"
    local lead_result_detail=""
    local watcher_state="unverifiable"
    local watcher_detail="watcher restart not attempted"
    if [[ "$restart_all_leads" == "true" ]]; then
        local lead_result parsed_skipped parsed_failed parsed_total
        lead_result=$(do_restart_all_leads stagger)
        parsed_skipped=$(rn_parse_count skipped "$lead_result")
        parsed_failed=$(rn_parse_count failed "$lead_result")
        parsed_total=$(rn_parse_count total "$lead_result")
        if [[ "$parsed_skipped" == "invalid" || "$parsed_failed" == "invalid" || "$parsed_total" == "invalid" ]]; then
            lead_counts_known=false
            lead_result_state="unreadable"
            log "ERROR: Lead restart stdout contract is unreadable: $lead_result"
        else
            leads_skipped="$parsed_skipped"
            leads_failed="$parsed_failed"
            leads_total="$parsed_total"
            lead_result_detail=$(lead_restart_wave_error)
            if [[ -n "$lead_result_detail" ]]; then
                lead_result_state="wave_not_run"
            fi
        fi
    fi

    # FLY-1482: a full-fleet restart also replaces the long-lived watcher.
    # Run this after Lead outcome capture even when the Lead wave degraded.
    # Bootstrap is forbidden until old-process absence is conclusive, and the
    # replacement is healthy only after a fresh PID owns the mode=watch lease.
    restart_cmux_watcher
    watcher_state="$CMUX_WATCHER_RESTART_STATE"
    watcher_detail="$CMUX_WATCHER_RESTART_DETAIL"

    # FLY-98: trigger cmux refresh after watcher restart outcome capture.
    if [[ "$restart_all_leads" == "true" ]]; then
        trigger_cmux_refresh
    fi

    # Step 5: Record code deployment truth independently of Lead health.
    # Bridge is already healthy and the new code is active at this point, so a
    # later Lead failure must not leave deployed-sha lying about the old code.
    record_deployed_range "$DEPLOYED_SHA" "$CURRENT_HEAD"
    echo "$CURRENT_HEAD" > "$DEPLOYED_SHA_FILE"
    log "deployed-sha updated to ${CURRENT_HEAD:0:7}"
    update_project_shas

    # FLY-1830: the Bridge, the Leads and the cmux watcher all have somebody who
    # puts them back. The rest of the non-Lead daemons had nobody — a label that
    # left the domain stayed gone, plist still on disk, override still "enabled".
    # quota-monitor sat like that for eleven days with automatic account
    # switching off. This reconciles that set on the wave that already exists.
    #
    # Deliberately AFTER deployed-sha advances: a job converged back into the
    # domain can start immediately (RunAtLoad, or QueueDirectories over a
    # non-empty queue as com.flywheel.updater has). Converging mid-deploy could
    # therefore hand the updater a git fetch/pull on the very checkout this
    # deploy is still building from. By this point the build is finished and
    # deployed-sha is current, so a woken updater simply finds nothing to do or
    # drains its queue through the normal restart lock.
    #
    # Auxiliary by design: a degraded result is reported, never a deploy abort.
    converge_nonlead_daemons
    local nonlead_state="$NONLEAD_DAEMON_CONVERGE_STATE"
    local nonlead_detail="$NONLEAD_DAEMON_CONVERGE_DETAIL"
    census_launchd_fleet
    local launchd_census_state="$LAUNCHD_CENSUS_STATE"
    local launchd_summary="$LAUNCHD_CENSUS_SUMMARY"
    local launchd_census_detail="$LAUNCHD_CENSUS_DETAIL"
    restart_report_launchd_census \
        "$launchd_census_state" "$launchd_summary" "$launchd_census_detail" \
        "${LAUNCHD_CENSUS_ANOMALY:-1}" "$nonlead_state" "$nonlead_detail"

    if [[ "$lead_counts_known" == "true" ]]; then
        local leads_status="healthy"
        if (( leads_failed > 0 || leads_skipped > 0 )); then
            leads_status="degraded"
        fi
        if ! write_leads_restart_status "$leads_status" "$leads_failed" "$leads_skipped" "$leads_total"; then
            log "ERROR: code deployed but failed to persist $LEADS_RESTART_STATUS_FILE"
            alert_severe "restart-status-write-failed" "Lead restart status write failed" \
                "Flywheel 代码已部署到 \`${CURRENT_HEAD:0:7}\`，但无法写入 Lead restart status。请检查 $LEADS_RESTART_STATUS_FILE。"
        fi
        # Preserve the historical retry-marker contract: failed=0 clears even
        # for skipped-only runs. Unknown counts retain the marker.
        if (( leads_failed == 0 )); then
            rm -f "$PLUGIN_RESTART_PENDING"
        fi
    else
        log "ERROR: not overwriting $LEADS_RESTART_STATUS_FILE because Lead counts are unknown"
    fi

    local failed_names_raw="" skipped_names_raw="" failed_names="" skipped_names=""
    failed_names_raw=$(lead_restart_details_csv failed)
    skipped_names_raw=$(lead_restart_details_csv skipped)
    failed_names=$(rn_normalize_lead_names "$leads_failed" "$failed_names_raw")
    skipped_names=$(rn_normalize_lead_names "$leads_skipped" "$skipped_names_raw")

    local end_epoch="" duration_str="unknown"
    end_epoch=$(date +%s 2>/dev/null) || end_epoch=""
    if [[ "$SCRIPT_START_EPOCH" =~ ^[0-9]+$ && "$end_epoch" =~ ^[0-9]+$ ]] \
      && (( end_epoch >= SCRIPT_START_EPOCH )); then
        duration_str=$(rn_format_duration "$((end_epoch - SCRIPT_START_EPOCH))")
    fi

    local body_new=0 body_adopted=0 body_unknown=0 body_counts=""
    if [[ "$lead_result_state" == "known" && "$leads_total" =~ ^[0-9]+$ \
      && "$leads_failed" =~ ^[0-9]+$ && "$leads_skipped" =~ ^[0-9]+$ \
      && -n "${LEAD_BODY_OBSERVATIONS_FILE:-}" ]]; then
        body_counts=$(summarize_lead_body_observations "$LEAD_BODY_OBSERVATIONS_FILE")
        IFS=$'\t' read -r body_new body_adopted body_unknown <<< "$body_counts" || true
    fi
    local completion_msg=""
    completion_msg=$(rn_render_completion_message \
        "$DEPLOYED_SHA" "$CURRENT_HEAD" "$RESTART_REASON" \
        "$leads_total" "$leads_failed" "$leads_skipped" \
        "$failed_names" "$skipped_names" "$lead_result_state" "$lead_result_detail" \
        "$bridge_state" "$bridge_ms" "$duration_str" "$watcher_state" "$watcher_detail" \
        "$body_new" "$body_adopted" "$body_unknown" \
        "$launchd_summary" "$bridge_startup_state" \
        2>/dev/null) || completion_msg=""
    if [[ -z "$completion_msg" ]]; then
        completion_msg="⚠️ Flywheel 全量重启结束 (reason=${RESTART_REASON}) — 播报组装失败,数字见部署日志。版本: \`${DEPLOYED_SHA:0:7}\` → \`${CURRENT_HEAD:0:7}\`。Lead: 统计未知。Bridge: 状态未知。cmux watcher: ${watcher_state}。总耗时: ${duration_str}。"
        log "ERROR: restart completion renderer returned an empty message"
        fire_meta_alert "completion_render_failed" "Flywheel completion render failed" \
            "Code deployed to ${CURRENT_HEAD:0:7}, but the restart completion payload could not be rendered."
    fi
    local lead_timing_line=""
    lead_timing_line=$(summarize_lead_verify_timings "${LEAD_VERIFY_TIMINGS_FILE:-}") || lead_timing_line=""
    if [[ -z "$lead_timing_line" ]]; then
        lead_timing_line="Lead verify timing: samples=0 p50=unknown p95=unknown max=unknown; failed Leads excluded"
    fi
    completion_msg="${completion_msg}"$'\n'"${lead_timing_line}"

    log "$completion_msg"
    notify_routine "$completion_msg"

    local tail_detail="" tail_signature="" tail_title="Lead restarts degraded"
    local tail_log_subject="Lead restart result"
    if [[ "$lead_result_state" == "wave_not_run" ]]; then
        tail_signature="leads-wave-not-run"
        tail_detail="波次错误: ${lead_result_detail:-原因记录失败,见部署日志}"
    elif [[ "$lead_result_state" == "unreadable" ]]; then
        tail_signature="leads-result-unreadable"
        tail_detail="结果错误: 统计合同解析失败，Lead 状态未知"
    elif (( leads_total == 0 )); then
        tail_signature="leads-no-candidates"
        tail_detail="未发现可重启 Lead 候选，舰队上线状态未知"
    elif (( leads_failed > 0 || leads_skipped > 0 )); then
        if (( leads_failed > 0 )); then
            tail_signature="leads-partial-failed"
            tail_detail="失败: ${failed_names}"
        else
            tail_signature="leads-skipped-no-manifest"
        fi
        if (( leads_skipped > 0 )); then
            [[ -n "$tail_detail" ]] && tail_detail="${tail_detail}；"
            tail_detail="${tail_detail}跳过(无 manifest): ${skipped_names}"
        fi
    fi
    if [[ "$watcher_state" != "healthy" ]]; then
        if [[ -z "$tail_signature" ]]; then
            tail_signature="cmux-watcher-${watcher_state}"
        fi
        tail_title="Flywheel restart degraded"
        tail_log_subject="full restart result"
        [[ -n "$tail_detail" ]] && tail_detail="${tail_detail}；"
        tail_detail="${tail_detail}cmux watcher=${watcher_state}: ${watcher_detail}"
    fi
    if [[ -n "$tail_signature" ]]; then
        log "WARNING: code deployed; ${tail_log_subject} is degraded — $tail_detail"
        alert_warning "$tail_signature" "$tail_title" \
            "Flywheel 代码已部署到 \`${CURRENT_HEAD:0:7}\` 且 deployed-sha 已推进；${tail_detail}。"
    fi

    if [[ "$restart_bridge" == "true" ]]; then
        resume_admission_best_effort
    fi

    RESTART_TERMINAL_REPORTED=true
    return 0
}

# ════════════════════════════════════════════════════════════════
# Main
# ════════════════════════════════════════════════════════════════

log "Starting full restart: ${DEPLOYED_SHA:0:7} → ${CURRENT_HEAD:0:7} (reason=$RESTART_REASON)"
deploy_and_verify
# FLY-90: Sync gbrain project Wiki (non-blocking, best-effort)
if [[ -x "$HOME/.flywheel/bin/sync-gbrain-docs.sh" ]]; then
    nohup "$HOME/.flywheel/bin/sync-gbrain-docs.sh" >/dev/null 2>&1 &
    log "gbrain doc sync triggered (background PID $!)"
fi
log "Done."

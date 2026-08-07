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

# FLY-299: when launched by the launchd updater (com.flywheel.updater), the
# environment may carry only a minimal default PATH that lacks /usr/local/bin,
# so `pnpm`/`node`/`git` are not found and the build silently fails. Prepend the
# dirs where the toolchain lives so this script resolves them regardless of how
# it was invoked (launchd, cron, interactive). Belt-and-suspenders with the
# plist's EnvironmentVariables→PATH.
export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:${PATH}"

# ════════════════════════════════════════════════════════════════
# Configuration
# ════════════════════════════════════════════════════════════════

FLYWHEEL_DIR="${HOME}/Dev/flywheel"
DEPLOYED_SHA_FILE="${HOME}/.flywheel/deployed-sha"
LOCK_DIR="${HOME}/.flywheel/restart.lock.d"
SCHEDULER_REPAIR_LOCK_DIR="${FLYWHEEL_SCHEDULER_REPAIR_LOCK_DIR:-${HOME}/.flywheel/scheduler-repair.lock.d}"
# shellcheck source=lib/lead-restart-lifecycle.sh
# shellcheck disable=SC1091
source "${FLYWHEEL_DIR}/scripts/lib/lead-restart-lifecycle.sh"

# shellcheck source=lib/restart-notify.sh
source "${FLYWHEEL_DIR}/scripts/lib/restart-notify.sh"
# shellcheck source=lib/restart-cmux-watcher.sh
source "${FLYWHEEL_DIR}/scripts/lib/restart-cmux-watcher.sh"

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

# FLY-1638: authenticated Bridge admission brake. The token rides curl's
# stdin config and therefore never appears in argv/process listings.
bridge_admission_request() {
    local action="$1" payload="$2" token="${TEAMLEAD_API_TOKEN:-}"
    [[ -n "$token" ]] || return 1
    curl -sf -X POST "${BRIDGE_URL}/api/admission/${action}" \
        -H "Content-Type: application/json" \
        -d "$payload" --max-time 5 -K - >/dev/null <<CURLCFG
header = "Authorization: Bearer ${token}"
CURLCFG
}

pause_admission_best_effort() {
    local payload
    payload=$(jq -n \
        --argjson durationSeconds "$ADMISSION_PAUSE_SECONDS" \
        --arg reason "restart-services:${RESTART_REASON}" \
        '{durationSeconds: $durationSeconds, reason: $reason}')
    if bridge_admission_request pause "$payload"; then
        log "Bridge admission paused for ${ADMISSION_PAUSE_SECONDS}s"
    else
        # Bootstrap compatibility: the pre-feature Bridge answers 404. Phase 1
        # is intentionally best-effort; TTL protects pause-aware versions.
        log "WARNING: admission pause unavailable (pre-feature Bridge or control API failure), proceeding without brake"
    fi
    return 0
}

resume_admission_best_effort() {
    if bridge_admission_request resume '{}'; then
        log "Bridge admission resumed"
    else
        log "WARNING: admission resume unavailable; TTL will release the brake"
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
    local status="$1" failed="$2" skipped="$3"
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
        '{
          schemaVersion: 1,
          codeDeployedSha: $sha,
          leadsRestartStatus: $status,
          failed: $failed,
          skipped: $skipped,
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

DISCORD_FORK_DIR="${HOME}/.flywheel/repos/claude-plugins-official"
DISCORD_PLUGIN_UPDATE="${HOME}/.flywheel/bin/update-discord-plugin.sh"
DISCORD_PLUGIN_CHECK="${HOME}/.flywheel/bin/check-discord-plugin.sh"

# Returns: 0=updated, 1=no update needed, 2=skipped or failed
check_discord_plugin_fork() {
    # Guard: required scripts must exist
    if [[ ! -f "$DISCORD_PLUGIN_CHECK" ]]; then
        log "Discord plugin check script not found, skipping fork detection"
        return 2
    fi
    if [[ ! -f "$DISCORD_PLUGIN_UPDATE" ]]; then
        log "Discord plugin update script not found, skipping fork detection"
        return 2
    fi

    # Dry-run mode: only report, no side effects (no git fetch, no update)
    if [[ "$DRY_RUN" == "true" ]]; then
        local runtime_ok=true
        bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1 || runtime_ok=false
        local fork_behind=false
        if [[ -d "$DISCORD_FORK_DIR/.git" ]]; then
            # Use cached origin/main ref (no fetch — dry-run must not modify state)
            local local_sha remote_sha
            local_sha=$(git -C "$DISCORD_FORK_DIR" rev-parse HEAD 2>/dev/null || echo "?")
            remote_sha=$(git -C "$DISCORD_FORK_DIR" rev-parse origin/main 2>/dev/null || echo "?")
            [[ "$local_sha" != "$remote_sha" ]] && fork_behind=true
        fi
        log "DRY RUN: Discord plugin — runtime_ok=$runtime_ok fork_behind=$fork_behind (fork status may be stale without fetch)"
        if [[ "$runtime_ok" == "false" || "$fork_behind" == "true" ]]; then
            log "DRY RUN: Would run update-discord-plugin.sh and force Lead restart"
            return 0
        fi
        return 1
    fi

    # Step 1: Check runtime integrity (canonical check)
    local runtime_ok=true
    if ! bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1; then
        log "Discord plugin runtime check failed — needs update"
        runtime_ok=false
    fi

    # Step 2: Check fork for new commits (if clone exists)
    local fork_updated=false
    if [[ -d "$DISCORD_FORK_DIR/.git" ]]; then
        if git -C "$DISCORD_FORK_DIR" fetch origin main --quiet 2>/dev/null; then
            local local_sha remote_sha
            local_sha=$(git -C "$DISCORD_FORK_DIR" rev-parse HEAD 2>/dev/null)
            remote_sha=$(git -C "$DISCORD_FORK_DIR" rev-parse origin/main 2>/dev/null)
            if [[ -n "$local_sha" && -n "$remote_sha" && "$local_sha" != "$remote_sha" ]]; then
                log "Discord plugin fork: ${local_sha:0:7} → ${remote_sha:0:7}"
                fork_updated=true
            fi
        else
            log "WARN: Failed to fetch Discord plugin fork (network issue?)"
        fi
    fi

    # Step 3: If nothing needs updating, we're done
    if [[ "$runtime_ok" == "true" && "$fork_updated" == "false" ]]; then
        log "Discord plugin: up to date and runtime healthy"
        return 1
    fi

    # Step 4: Run update
    log "Updating Discord plugin (runtime_ok=$runtime_ok fork_updated=$fork_updated)..."
    if ! bash "$DISCORD_PLUGIN_UPDATE"; then
        log "ERROR: Discord plugin update failed"
        alert_warning "plugin-update-failed" "Discord plugin update failed" \
            "Discord plugin 更新失败 (runtime_ok=$runtime_ok fork_updated=$fork_updated)。Lead 启动时 preflight 会重试。"
        return 2
    fi

    # Step 5: Verify update succeeded
    if ! bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1; then
        log "ERROR: Discord plugin update completed but re-check still fails"
        alert_warning "plugin-update-recheck-failed" "Discord plugin re-check failed" \
            "Discord plugin update 执行成功但 re-check 失败。请手动检查。"
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

validate_restart_contract || exit 1

# Direct invocation is safe even from a Lead that this run will replace. The
# child gets its own process group before any lock, build, or service mutation.
if [[ "${FLYWHEEL_RESTART_FOREGROUND:-0}" != "1" && "$DRY_RUN" != "true" ]]; then
    detach_log="/tmp/flywheel-restart-detached-$(date +%Y%m%d-%H%M%S).log"
    set -m
    FLYWHEEL_RESTART_FOREGROUND=1 nohup "$0" "${RESTART_ARGS[@]+"${RESTART_ARGS[@]}"}" \
        </dev/null >>"$detach_log" 2>&1 &
    detach_pid=$!
    disown "$detach_pid" 2>/dev/null || true
    echo "[restart] detached (PID $detach_pid, log: $detach_log)"
    exit 0
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
PROJECT_SHA_UPDATES_FILE=$(mktemp "${TMPDIR:-/tmp}/flywheel-project-sha-XXXXXX")
if ! LEAD_RESTART_NAMES_FILE=$(mktemp "${TMPDIR:-/tmp}/flywheel-lead-results-XXXXXX"); then
    log "ERROR: cannot allocate Lead restart result sidecar; terminal message will report incomplete evidence"
    LEAD_RESTART_NAMES_FILE=""
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

# FLY-1434: the only restart scope is full fleet.
restart_bridge=true
restart_all_leads=true

if [[ "$DRY_RUN" == "true" ]]; then
    log "DRY RUN: Would restart Bridge + all Leads (reason=$RESTART_REASON build=$([[ "$SKIP_BUILD" == "true" ]] && echo skip || echo run) install=$need_install)"
    log "DRY RUN: Changes since ${DEPLOYED_SHA:0:7}:"
    echo "${CHANGED:-"(first run)"}" | head -20
    exit 0
fi

# ════════════════════════════════════════════════════════════════
# Idle wait
# ════════════════════════════════════════════════════════════════

# FLY-270: self-ship stabilization window. When this deploy was triggered by a
# self-hosting ship handoff (markers present in self-ship-pending.d), requiring a
# SINGLE count==0 sample is unsafe: the shipping Runner emits session_completed
# and Bridge's runPostShipFinalization (tmux cleanup / thread archive) runs
# fire-and-forget AFTER the session leaves the active set — so count can read 0
# while finalization is still in flight. We therefore require TWO consecutive 0
# samples (any non-zero resets) before stopping Bridge — a stabilization window,
# NOT a completion barrier (it lowers the probability of interrupting
# finalization, it does not prove completion). This is self-ship-ONLY so ordinary
# Bridge deploys for other projects keep the single-0 fast path.
_self_ship_active() {
    local d="${SELF_SHIP_PENDING_DIR:-${HOME}/.flywheel/self-ship-pending.d}"
    local f
    shopt -s nullglob
    for f in "$d"/*.json; do shopt -u nullglob; return 0; done
    shopt -u nullglob
    return 1
}

wait_for_idle() {
    local elapsed=0
    local consecutive_failures=0
    local max_consecutive_failures=3
    local zero_streak=0
    local required_zeros=1
    if _self_ship_active; then
        required_zeros=2
        log "self-ship pending → stabilization window: requiring ${required_zeros} consecutive idle samples"
    fi
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
            zero_streak=0
        else
            consecutive_failures=0
            if (( count == 0 )); then
                zero_streak=$((zero_streak + 1))
                if (( zero_streak >= required_zeros )); then return 0; fi
            else
                zero_streak=0   # any active session resets the stabilization streak
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
    for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done
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
            kill -9 "$p" 2>/dev/null || true
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
    # FLY-151: prefer launchd-managed Bridge (env loaded by
    # flywheel-bridge-wrapper.sh, single source of truth). Fall back to
    # legacy nohup branch if the plist is not loaded for this user.
    # TODO(v1.28+): remove the nohup fallback once everyone has migrated
    # per docs/operations/bridge-daemon-management.md.
    local label="com.flywheel.bridge"
    local target="gui/$(id -u)/${label}"
    if launchctl print "$target" >/dev/null 2>&1; then
        if launchctl kickstart -k "$target" >/dev/null 2>&1; then
            log "Bridge restart requested via launchctl ($target)"
            return 0
        fi
        log "WARNING: launchctl kickstart failed for $target — falling back to nohup"
    else
        log "WARNING: FLY-151 plist not installed (launchctl has no $label). " \
            "Using legacy nohup. Install per docs/operations/bridge-daemon-management.md"
    fi
    cd "$FLYWHEEL_DIR"
    nohup npx tsx scripts/run-bridge.ts \
        >> /tmp/flywheel-bridge.log 2>&1 &
    log "Bridge started (PID $!) via legacy nohup"
    cd - > /dev/null
}

# ════════════════════════════════════════════════════════════════
# Lead restart
# ════════════════════════════════════════════════════════════════

# FLY-1507: keep all destructive identity logic in sourceable production
# libraries. restart-services.sh owns orchestration only.
# shellcheck source=../packages/teamlead/scripts/lib/lead-identity-preflight.sh
# shellcheck disable=SC1091
source "${FLYWHEEL_DIR}/packages/teamlead/scripts/lib/lead-identity-preflight.sh"
# shellcheck source=../packages/teamlead/scripts/lib/tmux-supervisor-guard.sh
# shellcheck disable=SC1091
source "${FLYWHEEL_DIR}/packages/teamlead/scripts/lib/tmux-supervisor-guard.sh"
# shellcheck source=lib/lead-body-sweep.sh
# shellcheck disable=SC1091
source "${FLYWHEEL_DIR}/scripts/lib/lead-body-sweep.sh"
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

    local lead_id project_dir project_name subdir bot_token_env workspace mcp_exclude chrome_enabled
    lead_id=$(jq -er '.leadId | select(type == "string" and length > 0)' "$manifest") || return 1
    project_dir=$(jq -er '.projectDir | select(type == "string" and length > 0)' "$manifest") || return 1
    project_name=$(jq -er '.projectName | select(type == "string" and length > 0)' "$manifest") || return 1
    subdir=$(jq -r '.subdir // ""' "$manifest") || return 1
    bot_token_env=$(jq -er '.botTokenEnv | select(type == "string" and length > 0)' "$manifest") || return 1
    workspace=$(jq -r '.workspace // ""' "$manifest") || return 1
    # FLY-143: per-Lead MCP scope fields. Default empty/false for older
    # manifests so legacy nohup path matches launchd wrapper behavior.
    mcp_exclude=$(jq -r '.mcpExclude // ""' "$manifest") || return 1
    chrome_enabled=$(jq -r '.chromeEnabled // false' "$manifest") || return 1

    # All preflight checks happen before bootout, TERM, or any other state
    # change. Invalid indirect env names must not reach ${!name}.
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
    local archive_file="${HOME}/.flywheel/pids/${project_name}-${lead_id}.claude.tmux"
    local plist="${HOME}/Library/LaunchAgents/${daemon_label}.plist"
    local projects_file="${HOME}/.flywheel/projects.json"
    local subdir_args=""
    [[ -n "$subdir" && "$subdir" != "null" ]] && subdir_args="--subdir $subdir"

    # Per-lead Discord state directory for channel/token isolation
    local discord_state_dir="${HOME}/.claude/channels/discord-${lead_id}"

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

    # Legacy path: manual nohup (Lead not daemon-managed)
    local old_pid="" old_start=""
    if [[ -f "$pid_file" ]]; then
        old_pid="$(cat "$pid_file" 2>/dev/null || true)"
        if [[ "$old_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$old_pid" 2>/dev/null; then
            old_start="$(lead_restart_process_start_identity "$old_pid")" || return 1
            kill -TERM "$old_pid" 2>/dev/null || true
            local wait_count=0
            while kill -0 "$old_pid" 2>/dev/null && (( wait_count < LEAD_STOP_WAIT_SECONDS )); do
                sleep 1
                wait_count=$((wait_count + 1))
            done
            if kill -0 "$old_pid" 2>/dev/null; then
                local now_start=""
                now_start="$(lead_restart_process_start_identity "$old_pid")" || return 1
                if [[ "$now_start" == "$old_start" ]]; then
                    kill -KILL "$old_pid" 2>/dev/null || return 1
                fi
            fi
        fi
    fi
    local legacy_clear_rc=0
    lead_body_hard_clear "$project_name" "$lead_id" claude-code || legacy_clear_rc=$?
    if (( legacy_clear_rc != 0 )); then
        log "ERROR: legacy Lead $lead_id body hard-clear did not converge (rc=$legacy_clear_rc)"
        return 1
    fi
    rm -f "$pid_file"

    # Replay LEAD_WORKSPACE if manifest recorded a custom one.
    # FLY-143: also propagate FLYWHEEL_LEAD_MCP_EXCLUDE / FLYWHEEL_LEAD_CHROME_ENABLED
    # so per-Lead MCP scope matches the launchd path. Use `env` with explicit
    # arguments — late-expanded `NAME=value` words are NOT recognized as env
    # assignments by bash (assignment recognition happens before parameter
    # expansion), so a `$_chrome_env` style would launch
    # "FLYWHEEL_LEAD_CHROME_ENABLED=true" as the command name.
    local lead_env=(
      "DISCORD_STATE_DIR=$discord_state_dir"
      "DISCORD_BOT_TOKEN=${!bot_token_env}"
      "FLYWHEEL_LEAD_MCP_EXCLUDE=$mcp_exclude"
    )
    if [[ -n "$workspace" && "$workspace" != "null" ]]; then
        lead_env+=("LEAD_WORKSPACE=$workspace")
    fi
    if [[ "$chrome_enabled" == "true" ]]; then
        lead_env+=("FLYWHEEL_LEAD_CHROME_ENABLED=true")
    fi
    nohup env "${lead_env[@]}" \
        "$FLYWHEEL_DIR/packages/teamlead/scripts/claude-lead.sh" \
        "$lead_id" "$project_dir" "$project_name" $subdir_args \
        --bot-token-env "$bot_token_env" \
        >> "/tmp/flywheel-lead-${lead_id}.log" 2>&1 &
    local new_pid=$!
    # Brief liveness check: wait 3s and verify process didn't exit immediately
    sleep 3
    if ! kill -0 "$new_pid" 2>/dev/null; then
        log "ERROR: Lead $lead_id (PID $new_pid) exited within 3s of startup — likely preflight failure"
        alert_warning "lead-exited-early-${lead_id}" "Lead exited early" \
            "Lead $lead_id 启动后 3 秒内退出，请检查日志: /tmp/flywheel-lead-${lead_id}.log"
        return 1
    fi
    log "Lead $lead_id restarted (PID $new_pid, liveness check OK)"
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

# Restart all Leads. Outputs "skipped:N failed:M total:K" to stdout.
# All logs go to stderr; stdout is machine-readable only.
# FLY-231: production-candidate resolver (_prod_membership / _classify_restart_manifest)
# lives in a sourceable lib so its deploy-gating logic is unit-testable. FLYWHEEL_DIR
# is set above; node + jq are required (already preconditions of this script).
# shellcheck source=lib/restart-candidate.sh
source "${FLYWHEEL_DIR}/scripts/lib/restart-candidate.sh"

do_restart_all_leads() {
    local skipped=0
    local failed=0
    local eligible=0
    if [[ -n "${LEAD_RESTART_NAMES_FILE:-}" ]]; then
        { : > "$LEAD_RESTART_NAMES_FILE"; } 2>/dev/null || true
    fi

    # FLY-954: converge <state>/bin BEFORE kickstarting any Lead — kickstarting
    # a corrupted wrapper takes the fleet down (2026-07-06: 12-byte stub +
    # KeepAlive throttling = 13 Leads offline). FAIL-LOUD: if convergence
    # cannot leave bin healthy, refuse the whole Lead restart wave (reported
    # through the existing skipped/failed stdout contract; code deployment
    # truth still advances while Lead health is recorded degraded).
    # Codex code R1 MEDIUM: report the refusal through the stdout contract and
    # return 0 — all three call sites capture this function via $( ) under
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

    # FLY-1507: one authoritative three-source inventory (manifest + positively
    # loaded plist + legacy supervisor process), deduplicated by exact
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
                rc=0
                restart_lead "$mf" >&2 || rc=$?
                if (( rc != 0 )); then
                    failed=$((failed + 1))
                    record_lead_restart_detail failed "$key"
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

# ════════════════════════════════════════════════════════════════
# Rollback
# ════════════════════════════════════════════════════════════════

rollback_and_restart() {
    local rollback_sha="$1"

    # Guard: first run has no known-good SHA
    if [[ -z "$rollback_sha" ]]; then
        log "ERROR: No known-good SHA for rollback (first run). Manual intervention required."
        alert_severe "deploy-failed-no-rollback" "Flywheel deploy failed" \
            "Flywheel 首次部署失败且无法自动回滚（无 known-good SHA）。需要手动介入。"
        RESTART_TERMINAL_REPORTED=true
        return 1
    fi

    log "Rolling back to ${rollback_sha:0:7}"

    # Fail-closed: refuse rollback on dirty checkout
    if [[ -n "$(git -C "$FLYWHEEL_DIR" status --porcelain)" ]]; then
        log "ERROR: Working directory not clean, refusing rollback"
        alert_severe "rollback-blocked-dirty" "Flywheel rollback blocked" \
            "Flywheel rollback 被阻止: 工作区不干净。需要手动介入。"
        RESTART_TERMINAL_REPORTED=true
        return 1
    fi

    git -C "$FLYWHEEL_DIR" reset --hard "$rollback_sha"

    # Best-effort: rebuild old version and restart
    if pnpm -C "$FLYWHEEL_DIR" install --frozen-lockfile && \
       pnpm -C "$FLYWHEEL_DIR" build; then
        if [[ "$restart_bridge" == "true" ]]; then
            pause_admission_best_effort
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
            resume_admission_best_effort
        fi
        local rb_leads_failed=0
        if [[ "$restart_all_leads" == "true" ]]; then
            # FLY-270 (R1#4): parse the Lead-restart result instead of discarding
            # it. A rolled-back-but-NOT-recovered Eng Lead must be surfaced as a
            # severe alert, never conflated with "code rolled back" success.
            local rb_lead_result
            rb_lead_result=$(do_restart_all_leads)
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
        if (( rb_leads_failed > 0 )); then
            alert_severe "rollback-leads-failed" "Flywheel deploy failed" \
                "Flywheel 回滚到 \`${rollback_sha:0:7}\` 成功，但 ${rb_leads_failed} 个 Lead（含 Eng Lead？）未恢复——KeepAlive 重拉不了坏 token/manifest/config。需要手动开 terminal 检查。"
            RESTART_TERMINAL_REPORTED=true
        else
            alert_warning "update-rolled-back" "Flywheel update rolled back" \
                "Flywheel 更新到 \`${CURRENT_HEAD:0:7}\` 失败。已回滚到 \`${rollback_sha:0:7}\` 并重启旧版本（Lead 已恢复）。"
            RESTART_TERMINAL_REPORTED=true
        fi
    else
        alert_severe "update-and-rollback-failed" "Flywheel deploy failed" \
            "Flywheel 更新失败且回滚 build 也失败。服务可能处于异常状态。需要手动介入。"
        RESTART_TERMINAL_REPORTED=true
    fi
}

# ════════════════════════════════════════════════════════════════
# Deploy + Verify
# ════════════════════════════════════════════════════════════════

deploy_and_verify() {
    RESTART_NOTICE_STARTED=true
    notify_routine "🔄 开始全量重启 Flywheel (reason=${RESTART_REASON}): \`${DEPLOYED_SHA:0:7}\` → \`${CURRENT_HEAD:0:7}\`"

    # Step 0: reject new admissions before the Bridge begins draining. This runs
    # inside the detached deploy body, never in the self-detaching parent.
    if [[ "$restart_bridge" == "true" ]]; then
        pause_admission_best_effort
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
    else
        log "Build skipped (no build-relevant code delta)"
    fi

    # Step 3: Start new Bridge
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
        local hc_ok=false
        for i in $(seq 1 "$hc_tries"); do
            if curl -sf "$BRIDGE_URL/health" | jq -e '.ok' > /dev/null 2>&1; then
                hc_ok=true
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
        resume_admission_best_effort
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
        lead_result=$(do_restart_all_leads)
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

    if [[ "$lead_counts_known" == "true" ]]; then
        local leads_status="healthy"
        if (( leads_failed > 0 || leads_skipped > 0 )); then
            leads_status="degraded"
        fi
        if ! write_leads_restart_status "$leads_status" "$leads_failed" "$leads_skipped"; then
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

    # Probe before taking the end timestamp: total duration includes the
    # measured end-of-restart Bridge response.
    local bridge_probe="fail" bridge_state="fail" bridge_ms="-"
    bridge_probe=$(rn_probe_bridge_health "$BRIDGE_URL")
    IFS=$'\t' read -r bridge_state bridge_ms <<< "$bridge_probe" || true
    if [[ "$bridge_state" != "ok" || ! "$bridge_ms" =~ ^[0-9]+$ ]]; then
        bridge_state="fail"
        bridge_ms="-"
    fi

    local end_epoch="" duration_str="unknown"
    end_epoch=$(date +%s 2>/dev/null) || end_epoch=""
    if [[ "$SCRIPT_START_EPOCH" =~ ^[0-9]+$ && "$end_epoch" =~ ^[0-9]+$ ]] \
      && (( end_epoch >= SCRIPT_START_EPOCH )); then
        duration_str=$(rn_format_duration "$((end_epoch - SCRIPT_START_EPOCH))")
    fi

    local completion_msg=""
    completion_msg=$(rn_render_completion_message \
        "$DEPLOYED_SHA" "$CURRENT_HEAD" "$RESTART_REASON" \
        "$leads_total" "$leads_failed" "$leads_skipped" \
        "$failed_names" "$skipped_names" "$lead_result_state" "$lead_result_detail" \
        "$bridge_state" "$bridge_ms" "$duration_str" "$watcher_state" "$watcher_detail" \
        2>/dev/null) || completion_msg=""
    if [[ -z "$completion_msg" ]]; then
        completion_msg="⚠️ Flywheel 全量重启结束 (reason=${RESTART_REASON}) — 播报组装失败,数字见部署日志。版本: \`${DEPLOYED_SHA:0:7}\` → \`${CURRENT_HEAD:0:7}\`。Lead: 统计未知。Bridge: 状态未知。cmux watcher: ${watcher_state}。总耗时: ${duration_str}。"
        log "ERROR: restart completion renderer returned an empty message"
        fire_meta_alert "completion_render_failed" "Flywheel completion render failed" \
            "Code deployed to ${CURRENT_HEAD:0:7}, but the restart completion payload could not be rendered."
    fi

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
    if [[ "$bridge_state" != "ok" ]]; then
        if [[ -z "$tail_signature" ]]; then
            tail_signature="bridge-completion-probe-failed"
            tail_title="Flywheel restart degraded"
        fi
        tail_log_subject="full restart result"
        [[ -n "$tail_detail" ]] && tail_detail="${tail_detail}；"
        tail_detail="${tail_detail}Bridge /health 结束时刻探测失败，服务可用性需人工确认"
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

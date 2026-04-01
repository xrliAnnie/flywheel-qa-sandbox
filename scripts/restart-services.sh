#!/usr/bin/env bash
# FLY-20: Auto-restart Bridge + Lead after merge.
# Core restart script: diff analysis → idle wait → build → restart → health check → notify.
#
# Usage: restart-services.sh [--force] [--dry-run]
#   --force:   skip idle wait
#   --dry-run: print plan, don't execute
#
# Called by:
#   1. Orchestrator/spin post-merge bookkeeping (main path)
#   2. update-flywheel.sh via launchd (fallback)
set -euo pipefail

# ════════════════════════════════════════════════════════════════
# Configuration
# ════════════════════════════════════════════════════════════════

FLYWHEEL_DIR="${HOME}/Dev/flywheel"
DEPLOYED_SHA_FILE="${HOME}/.flywheel/deployed-sha"
LOCK_DIR="${HOME}/.flywheel/restart.lock.d"
PLUGIN_RESTART_PENDING="${HOME}/.flywheel/plugin-restart-pending"

MAX_WAIT_SECONDS=1800   # 30 minutes
POLL_INTERVAL=30        # seconds between idle checks
BRIDGE_URL="${BRIDGE_URL:-http://localhost:9876}"

# ════════════════════════════════════════════════════════════════
# Env loading
# ════════════════════════════════════════════════════════════════

ENV_FILE="${HOME}/.flywheel/.env"
if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$ENV_FILE"
else
    echo "[restart] WARNING: $ENV_FILE not found"
fi

# Validate required variables
DISCORD_CORE_CHANNEL="${DISCORD_CORE_CHANNEL:-}"
SIMBA_BOT_TOKEN="${SIMBA_BOT_TOKEN:-${DISCORD_BOT_TOKEN:-}}"
NOTIFY_BOT_TOKEN="${SIMBA_BOT_TOKEN}"

# ════════════════════════════════════════════════════════════════
# Utility functions
# ════════════════════════════════════════════════════════════════

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [restart] $*"
}

notify_discord() {
    local message="$1"
    [[ -z "$NOTIFY_BOT_TOKEN" || -z "$DISCORD_CORE_CHANNEL" ]] && return 0
    local payload
    payload=$(jq -n --arg content "$message" '{content: $content}')
    curl -sf -X POST "https://discord.com/api/v10/channels/${DISCORD_CORE_CHANNEL}/messages" \
        -H "Authorization: Bot ${NOTIFY_BOT_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "$payload" \
        --max-time 5 || log "WARNING: Discord notification failed"
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
        notify_discord "⚠️ Discord plugin 更新失败 (runtime_ok=$runtime_ok fork_updated=$fork_updated)。Lead 启动时 preflight 会重试。"
        return 2
    fi

    # Step 5: Verify update succeeded
    if ! bash "$DISCORD_PLUGIN_CHECK" > /dev/null 2>&1; then
        log "ERROR: Discord plugin update completed but re-check still fails"
        notify_discord "⚠️ Discord plugin update 执行成功但 re-check 失败。请手动检查。"
        return 2
    fi

    log "Discord plugin updated and verified successfully"
    return 0
}

# ════════════════════════════════════════════════════════════════
# Parse arguments
# ════════════════════════════════════════════════════════════════

FORCE=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force) FORCE=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        *) log "ERROR: Unknown argument '$1'"; exit 1 ;;
    esac
done

# ════════════════════════════════════════════════════════════════
# Mutual exclusion lock
# ════════════════════════════════════════════════════════════════

acquire_lock() {
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
        # Check if lock is stale (>2 hours)
        local lock_age
        lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0) ))
        if (( lock_age > 7200 )); then
            log "Stale lock detected (${lock_age}s), breaking."
            rmdir "$LOCK_DIR" 2>/dev/null || true
            mkdir "$LOCK_DIR" 2>/dev/null || { log "Lock contention, exiting."; exit 0; }
        else
            log "Another restart in progress (${lock_age}s old), exiting."
            exit 0
        fi
    fi
    trap 'rmdir "$LOCK_DIR" 2>/dev/null; exit' EXIT INT TERM
}

acquire_lock

# ════════════════════════════════════════════════════════════════
# Discord plugin detection — marker + fork check
# ════════════════════════════════════════════════════════════════

PLUGIN_ONLY_RESTART=false
plugin_needs_restart=false

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
# Deployed-SHA comparison
# ════════════════════════════════════════════════════════════════

DEPLOYED_SHA=$(cat "$DEPLOYED_SHA_FILE" 2>/dev/null || echo "")
CURRENT_HEAD=$(git -C "$FLYWHEEL_DIR" rev-parse HEAD)

if [[ "$DEPLOYED_SHA" == "$CURRENT_HEAD" ]]; then
    if [[ "$plugin_needs_restart" == "true" ]]; then
        # Dry-run guard for plugin-only path
        if [[ "$DRY_RUN" == "true" ]]; then
            log "DRY RUN: Would restart Leads (plugin update or retry marker)"
            [[ -f "$PLUGIN_RESTART_PENDING" ]] && log "DRY RUN: Marker exists, would retry"
            exit 0
        fi
        PLUGIN_ONLY_RESTART=true
        # Fall through to Main section (do_restart_all_leads is defined below)
    else
        log "Already deployed at ${CURRENT_HEAD:0:7}, exiting."
        exit 0
    fi
fi

# ════════════════════════════════════════════════════════════════
# Diff classification (skipped when plugin-only restart)
# ════════════════════════════════════════════════════════════════

if [[ "$PLUGIN_ONLY_RESTART" != "true" ]]; then

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
        log "No file changes between ${DEPLOYED_SHA:0:7} and ${CURRENT_HEAD:0:7}, exiting."
        echo "$CURRENT_HEAD" > "$DEPLOYED_SHA_FILE"
        exit 0
    fi
    eval "$(classify_changes)"
    log "Diff analysis: bridge=$restart_bridge leads=$restart_all_leads install=$need_install"
fi

# Merge plugin update flag into diff classification result
if [[ "$plugin_needs_restart" == "true" ]]; then
    restart_all_leads=true
fi

if [[ "$restart_bridge" == "false" && "$restart_all_leads" == "false" ]]; then
    log "No services affected by changes. Updating deployed-sha only."
    echo "$CURRENT_HEAD" > "$DEPLOYED_SHA_FILE"
    exit 0
fi

if [[ "$DRY_RUN" == "true" ]]; then
    log "DRY RUN: Would restart bridge=$restart_bridge leads=$restart_all_leads install=$need_install"
    log "DRY RUN: Changes since ${DEPLOYED_SHA:0:7}:"
    echo "${CHANGED:-"(first run)"}" | head -20
    exit 0
fi

fi  # end PLUGIN_ONLY_RESTART guard

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
            if (( count == 0 )); then return 0; fi
            if (( elapsed == 0 || elapsed % 300 == 0 )); then
                notify_discord "⏳ 等待 ${count} 个 active session idle... (${elapsed}s/${MAX_WAIT_SECONDS}s)"
            fi
        fi
        sleep "$POLL_INTERVAL"
        elapsed=$((elapsed + POLL_INTERVAL))
    done
    log "WARNING: Timeout waiting for idle after ${MAX_WAIT_SECONDS}s"
    return 1
}

if [[ "$PLUGIN_ONLY_RESTART" != "true" && "$restart_bridge" == "true" && "$FORCE" != "true" ]]; then
    log "Waiting for idle sessions before restart..."
    if ! wait_for_idle; then
        log "Proceeding with restart after idle timeout"
        notify_discord "⚠️ Idle 等待超时 (${MAX_WAIT_SECONDS}s)，强制重启。"
    fi
fi

# ════════════════════════════════════════════════════════════════
# Bridge stop / start
# ════════════════════════════════════════════════════════════════

stop_bridge() {
    local pid
    pid=$(pgrep -f "run-bridge.ts" || true)
    if [[ -z "$pid" ]]; then
        log "Bridge not running, nothing to stop"
        return 0
    fi
    log "Stopping Bridge (PID $pid)..."
    kill -TERM "$pid"
    local wait_count=0
    while kill -0 "$pid" 2>/dev/null && (( wait_count < 120 )); do
        sleep 1
        ((wait_count++))
    done
    if kill -0 "$pid" 2>/dev/null; then
        log "WARNING: Bridge still alive after 120s, force killing"
        kill -9 "$pid" 2>/dev/null || true
    fi
    log "Bridge stopped (was PID $pid, waited ${wait_count}s)"
}

start_bridge() {
    cd "$FLYWHEEL_DIR"
    nohup npx tsx scripts/run-bridge.ts \
        >> /tmp/flywheel-bridge.log 2>&1 &
    log "Bridge started (PID $!)"
    cd - > /dev/null
}

# ════════════════════════════════════════════════════════════════
# Lead restart
# ════════════════════════════════════════════════════════════════

# Returns: 0=success, 1=error
# Args: <manifest_path>  (caller passes the manifest directly, no re-globbing)
restart_lead() {
    local manifest="$1"

    local lead_id project_dir project_name subdir bot_token_env workspace
    lead_id=$(jq -r '.leadId' "$manifest")
    project_dir=$(jq -r '.projectDir' "$manifest")
    project_name=$(jq -r '.projectName' "$manifest")
    subdir=$(jq -r '.subdir // ""' "$manifest")
    bot_token_env=$(jq -r '.botTokenEnv' "$manifest")
    workspace=$(jq -r '.workspace // ""' "$manifest")

    # Use PID file for precise supervisor targeting
    local pid_file="${HOME}/.flywheel/pids/${project_name}-${lead_id}.pid"
    if [[ -f "$pid_file" ]]; then
        local pid
        pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            log "Stopping Lead $lead_id (supervisor PID $pid)..."
            kill -TERM "$pid"
            local wait_count=0
            while kill -0 "$pid" 2>/dev/null && (( wait_count < 60 )); do
                sleep 1
                ((wait_count++))
            done
            # Fail-fast: refuse to start new supervisor if old is still alive
            if kill -0 "$pid" 2>/dev/null; then
                log "ERROR: Old supervisor for $lead_id (PID $pid) still alive after 60s"
                notify_discord "⚠️ Lead $lead_id 旧 supervisor (PID $pid) 60s 后仍未退出，跳过重启避免双启动"
                return 1
            fi
        fi
        rm -f "$pid_file"
    fi

    local subdir_args=""
    [[ -n "$subdir" && "$subdir" != "null" ]] && subdir_args="--subdir $subdir"

    # Fail-fast: bot token env must be defined
    if [[ -z "${!bot_token_env:-}" ]]; then
        log "ERROR: $bot_token_env is not set, cannot restart $lead_id"
        notify_discord "⚠️ Lead $lead_id 重启失败: \`$bot_token_env\` 未定义"
        return 1
    fi

    # Replay LEAD_WORKSPACE if manifest recorded a custom one
    if [[ -n "$workspace" && "$workspace" != "null" ]]; then
        LEAD_WORKSPACE="$workspace" DISCORD_BOT_TOKEN="${!bot_token_env}" \
            nohup "$FLYWHEEL_DIR/packages/teamlead/scripts/claude-lead.sh" \
            "$lead_id" "$project_dir" "$project_name" $subdir_args \
            --bot-token-env "$bot_token_env" \
            >> "/tmp/flywheel-lead-${lead_id}.log" 2>&1 &
    else
        DISCORD_BOT_TOKEN="${!bot_token_env}" \
            nohup "$FLYWHEEL_DIR/packages/teamlead/scripts/claude-lead.sh" \
            "$lead_id" "$project_dir" "$project_name" $subdir_args \
            --bot-token-env "$bot_token_env" \
            >> "/tmp/flywheel-lead-${lead_id}.log" 2>&1 &
    fi
    local new_pid=$!
    # Brief liveness check: wait 3s and verify process didn't exit immediately
    sleep 3
    if ! kill -0 "$new_pid" 2>/dev/null; then
        log "ERROR: Lead $lead_id (PID $new_pid) exited within 3s of startup — likely preflight failure"
        notify_discord "⚠️ Lead $lead_id 启动后 3 秒内退出，请检查日志: /tmp/flywheel-lead-${lead_id}.log"
        return 1
    fi
    log "Lead $lead_id restarted (PID $new_pid, liveness check OK)"
}

# Restart all Leads. Outputs "skipped:N failed:M" to stdout.
# All logs go to stderr; stdout is machine-readable only.
do_restart_all_leads() {
    local skipped=0
    local failed=0

    # Source 1: collect Lead IDs from manifests
    local manifest_leads=""
    shopt -s nullglob
    local manifests=("${HOME}/.flywheel/manifests/"*.json)
    shopt -u nullglob
    for mf in ${manifests[@]+"${manifests[@]}"}; do
        local lid
        lid=$(jq -r '.leadId' "$mf")
        manifest_leads="$manifest_leads $lid"
    done

    # Source 2: detect running Leads without manifests (legacy migration)
    while IFS= read -r cmd_line; do
        [[ -z "$cmd_line" ]] && continue
        local lid
        lid=$(echo "$cmd_line" | awk -F'claude-lead.sh ' '{print $2}' | awk '{print $1}')
        if [[ -n "$lid" ]] && ! echo "$manifest_leads" | grep -qw "$lid"; then
            log "WARNING: Lead $lid is running but has no manifest — needs manual restart to generate manifest" >&2
            skipped=$((skipped + 1))
        fi
    done < <(pgrep -af "claude-lead.sh" 2>/dev/null || true)

    # Restart Leads that have manifests (pass manifest path directly)
    for mf in ${manifests[@]+"${manifests[@]}"}; do
        local rc=0
        restart_lead "$mf" >&2 || rc=$?
        if (( rc == 1 )); then
            failed=$((failed + 1))
        fi
    done

    if (( ${#manifests[@]} == 0 && skipped == 0 )); then
        log "WARNING: No Leads found (no manifests, no running processes)" >&2
    fi

    echo "skipped:${skipped} failed:${failed}"
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
        notify_discord "🚨 Flywheel 首次部署失败且无法自动回滚（无 known-good SHA）。需要手动介入。"
        return 1
    fi

    log "Rolling back to ${rollback_sha:0:7}"

    # Fail-closed: refuse rollback on dirty checkout
    if [[ -n "$(git -C "$FLYWHEEL_DIR" status --porcelain)" ]]; then
        log "ERROR: Working directory not clean, refusing rollback"
        notify_discord "🚨 Flywheel rollback 被阻止: 工作区不干净。需要手动介入。"
        return 1
    fi

    git -C "$FLYWHEEL_DIR" reset --hard "$rollback_sha"

    # Best-effort: rebuild old version and restart
    if pnpm -C "$FLYWHEEL_DIR" install --frozen-lockfile && \
       pnpm -C "$FLYWHEEL_DIR" build; then
        if [[ "$restart_bridge" == "true" ]]; then
            stop_bridge
            start_bridge
        fi
        if [[ "$restart_all_leads" == "true" ]]; then
            do_restart_all_leads > /dev/null
        fi
        notify_discord "⚠️ Flywheel 更新到 \`${CURRENT_HEAD:0:7}\` 失败。已回滚到 \`${rollback_sha:0:7}\` 并重启旧版本。"
    else
        notify_discord "🚨 Flywheel 更新失败且回滚 build 也失败。服务可能处于异常状态。需要手动介入。"
    fi
}

# ════════════════════════════════════════════════════════════════
# Deploy + Verify
# ════════════════════════════════════════════════════════════════

deploy_and_verify() {
    local restarted=()

    notify_discord "🔄 开始更新 Flywheel: \`${DEPLOYED_SHA:0:7}\` → \`${CURRENT_HEAD:0:7}\`"

    # Step 1: Stop Bridge FIRST (triggers stopAccepting + drain)
    if [[ "$restart_bridge" == "true" ]]; then
        stop_bridge
    fi

    # Step 2: Build (Bridge is stopped, no race possible)
    if ! build_project; then
        log "Build failed, attempting rollback"
        rollback_and_restart "$DEPLOYED_SHA"
        # rollback_and_restart already handles stop+start of Bridge/Leads
        return 1
    fi

    # Step 3: Start new Bridge
    if [[ "$restart_bridge" == "true" ]]; then
        start_bridge
        restarted+=("Bridge")

        # Health check — wait for new Bridge to be ready (up to 60s)
        local hc_ok=false
        for i in $(seq 1 30); do
            if curl -sf "$BRIDGE_URL/health" | jq -e '.ok' > /dev/null 2>&1; then
                hc_ok=true
                break
            fi
            sleep 2
        done
        if [[ "$hc_ok" != "true" ]]; then
            log "ERROR: Bridge health check failed after restart. Attempting rollback."
            rollback_and_restart "$DEPLOYED_SHA"
            return 1
        fi
        log "Bridge health check: OK"
    fi

    # Step 4: Restart Leads (after Bridge is confirmed healthy)
    local leads_skipped=0
    local leads_failed=0
    if [[ "$restart_all_leads" == "true" ]]; then
        local lead_result
        lead_result=$(do_restart_all_leads)
        leads_skipped=$(echo "$lead_result" | sed 's/.*skipped:\([0-9]*\).*/\1/')
        leads_failed=$(echo "$lead_result" | sed 's/.*failed:\([0-9]*\).*/\1/')
        restarted+=("Leads")
    fi

    # Step 5: Update deployed-sha
    if (( leads_failed > 0 )); then
        log "ERROR: ${leads_failed} lead(s) failed to restart. deployed-sha NOT advanced."
        notify_discord "⚠️ Flywheel 更新到 \`${CURRENT_HEAD:0:7}\` 部分失败。${leads_failed} 个 Lead 重启失败。下次运行会重试。"
        return 1
    fi

    # Clear any stale plugin-restart-pending marker after successful deploy
    rm -f "$PLUGIN_RESTART_PENDING"

    if (( leads_skipped > 0 )); then
        log "WARNING: ${leads_skipped} lead(s) skipped (no manifest). deployed-sha NOT advanced."
        notify_discord "⚠️ Flywheel 部分更新到 \`${CURRENT_HEAD:0:7}\`。${leads_skipped} 个 Lead 因缺少 manifest 被跳过。请手动重启这些 Lead 一次以生成 manifest。"
        return 0
    fi

    echo "$CURRENT_HEAD" > "$DEPLOYED_SHA_FILE"
    log "deployed-sha updated to ${CURRENT_HEAD:0:7}"

    notify_discord "✅ Flywheel 已更新到 \`${CURRENT_HEAD:0:7}\`。重启了: ${restarted[*]:-无}"
}

# ════════════════════════════════════════════════════════════════
# Main
# ════════════════════════════════════════════════════════════════

if [[ "$PLUGIN_ONLY_RESTART" == "true" ]]; then
    # Plugin-only path: restart Leads without build/Bridge changes
    log "Plugin-only restart: restarting Leads..."
    notify_discord "🔄 Discord plugin 更新，重启 Leads..."

    lead_result=$(do_restart_all_leads)
    leads_skipped=$(echo "$lead_result" | sed 's/.*skipped:\([0-9]*\).*/\1/')
    leads_failed=$(echo "$lead_result" | sed 's/.*failed:\([0-9]*\).*/\1/')

    if (( leads_failed > 0 )); then
        # Write retry marker — next run will retry Lead restart
        echo "failed=$leads_failed at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PLUGIN_RESTART_PENDING"
        notify_discord "⚠️ Discord plugin 更新后 ${leads_failed} 个 Lead 重启失败。请检查日志。"
        exit 1
    fi
    # Success (full or partial-skip) — clear retry marker
    rm -f "$PLUGIN_RESTART_PENDING"
    if (( leads_skipped > 0 )); then
        notify_discord "⚠️ Discord plugin 更新后 ${leads_skipped} 个 Lead 跳过（无 manifest）。请手动重启。"
        exit 0
    fi
    notify_discord "✅ Discord plugin 更新完成，Leads 已重启。"
    log "Done."
else
    # Normal deploy path
    log "Starting restart: ${DEPLOYED_SHA:0:7} → ${CURRENT_HEAD:0:7} (bridge=$restart_bridge leads=$restart_all_leads)"
    deploy_and_verify
    log "Done."
fi

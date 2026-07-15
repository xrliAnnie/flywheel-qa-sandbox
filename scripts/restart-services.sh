#!/usr/bin/env bash
# FLY-20: Auto-restart Bridge + Lead after merge.
# Core restart script: diff analysis → idle wait → build → restart → health check → notify.
#
# Usage: restart-services.sh [--force] [--wait-idle] [--dry-run] [--bridge-only]
#   --force:       kept for back-compat — skipping the idle wait is now the
#                  DEFAULT (FLY-1224 founder directive). When given together
#                  with --wait-idle, --force wins (idle wait skipped).
#   --wait-idle:   wait for active sessions to go idle before restarting (the
#                  pre-FLY-1224 default). Env FLYWHEEL_RESTART_WAIT_IDLE=1 is
#                  equivalent.
#   --dry-run:     print plan, don't execute
#   --bridge-only: FLY-1142 sanctioned env-reload path — restart ONLY the
#                  Bridge in place (stop → start → health check). No build,
#                  no deployed-sha reads/writes, no Lead restarts, no plugin
#                  update, no deploy notifications. For pure ~/.flywheel/.env
#                  changes that a no-code-delta deploy would otherwise skip.
#
# Called by:
#   1. Orchestrator/spin post-merge bookkeeping (main path)
#   2. update-flywheel.sh via launchd (fallback)
set -euo pipefail

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

MAX_WAIT_SECONDS="${RESTART_MAX_WAIT:-300}"   # 5 minutes default (env override: RESTART_MAX_WAIT)
POLL_INTERVAL=30        # seconds between idle checks
BRIDGE_URL="${BRIDGE_URL:-http://localhost:9876}"

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

# Temp file for project SHA updates (populated by check_project_lead_changes)
PROJECT_SHA_UPDATES_FILE=$(mktemp "${TMPDIR:-/tmp}/flywheel-project-sha-XXXXXX")

# ════════════════════════════════════════════════════════════════
# Parse arguments
# ════════════════════════════════════════════════════════════════

FORCE=false
DRY_RUN=false
BRIDGE_ONLY=false
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
        --bridge-only) BRIDGE_ONLY=true; shift ;;
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

# FLY-1142: every mode/impact flag gets a default BEFORE any guarded section.
# --bridge-only skips the detection + classification blocks below, and under
# `set -u` any later reference (idle-wait guard, Main branch selection) to a
# variable those blocks would have set must not die on "unbound variable".
PLUGIN_ONLY_RESTART=false
plugin_needs_restart=false
project_lead_changed=false
restart_bridge=false
restart_all_leads=false
need_install=false

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
    trap 'rmdir "$LOCK_DIR" 2>/dev/null; rm -f "$PROJECT_SHA_UPDATES_FILE" 2>/dev/null; exit' EXIT INT TERM
}

acquire_lock

# ════════════════════════════════════════════════════════════════
# Discord plugin detection — marker + fork check
# ════════════════════════════════════════════════════════════════

# FLY-1142: --bridge-only skips plugin fork/update, project .lead/ scanning
# and the whole deployed-sha gate + diff classification — it is a pure
# in-place Bridge bounce for env reloads, never a deploy.
if [[ "$BRIDGE_ONLY" != "true" ]]; then

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
    if [[ "$plugin_needs_restart" == "true" || "$project_lead_changed" == "true" ]]; then
        # Dry-run guard for lead-only restart path
        if [[ "$DRY_RUN" == "true" ]]; then
            log "DRY RUN: Would restart Leads (plugin=$plugin_needs_restart project_lead=$project_lead_changed)"
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
        log "No file changes between ${DEPLOYED_SHA:0:7} and ${CURRENT_HEAD:0:7}, exiting."
        record_deployed_range "$DEPLOYED_SHA" "$CURRENT_HEAD"
        echo "$CURRENT_HEAD" > "$DEPLOYED_SHA_FILE"
        exit 0
    fi
    eval "$(classify_changes)"
    log "Diff analysis: bridge=$restart_bridge leads=$restart_all_leads install=$need_install"
fi

# Merge plugin update + project .lead/ change flags into diff classification result
if [[ "$plugin_needs_restart" == "true" || "$project_lead_changed" == "true" ]]; then
    restart_all_leads=true
fi

if [[ "$restart_bridge" == "false" && "$restart_all_leads" == "false" ]]; then
    log "No services affected by changes. Updating deployed-sha only."
    record_deployed_range "$DEPLOYED_SHA" "$CURRENT_HEAD"
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

fi  # end BRIDGE_ONLY guard (FLY-1142)

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
                    # FLY-1142 (Codex code R1 MEDIUM-1): --bridge-only promises
                    # ZERO deploy notifications — the busy-wait progress notice
                    # must stay a local log there, not a Discord post.
                    if [[ "$BRIDGE_ONLY" == "true" ]]; then
                        log "waiting for ${count} active session(s) to idle... (${elapsed}s/${MAX_WAIT_SECONDS}s)"
                    else
                        notify_routine "⏳ 等待 ${count} 个 active session idle... (${elapsed}s/${MAX_WAIT_SECONDS}s)"
                    fi
                fi
            fi
        fi
        sleep "$POLL_INTERVAL"
        elapsed=$((elapsed + POLL_INTERVAL))
    done
    log "WARNING: Timeout waiting for idle after ${MAX_WAIT_SECONDS}s"
    return 1
}

# FLY-1142: --bridge-only runs its own single wait_for_idle inside its Main
# branch (after the dry-run early-exit), so it is excluded here.
# FLY-1224: the idle wait is opt-in (--wait-idle / FLYWHEEL_RESTART_WAIT_IDLE=1).
if [[ "$BRIDGE_ONLY" != "true" && "$PLUGIN_ONLY_RESTART" != "true" && "$restart_bridge" == "true" && "$WAIT_IDLE" == "true" ]]; then
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

# Bridge TCP port, parsed from BRIDGE_URL (default 9876).
bridge_port() {
    local p
    p="$(printf '%s' "$BRIDGE_URL" | sed -E 's#^.*:([0-9]+).*$#\1#')"
    if [[ "$p" =~ ^[0-9]+$ ]]; then printf '%s\n' "$p"; else printf '9876\n'; fi
}

# Seams (overridable in tests): port listeners + process introspection.
_listeners_on_port() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }
_ppid_of()           { ps -o ppid= -p "$1" 2>/dev/null | tr -dc '0-9'; }
_args_of()           { ps -o command= -p "$1" 2>/dev/null; }

# Given a port-listener PID, emit that PID plus the ancestor PIDs that belong to
# the SAME run-bridge invocation, stopping at launchd (ppid 0/1) or the first
# ancestor that is not part of this run-bridge tree. Never emits a worktree PID.
collect_bridge_tree() {
    local pid="$1" cur ppid args
    [[ -z "$pid" ]] && return 0
    args="$(_args_of "$pid")"
    case "$args" in *worktrees/*) return 0 ;; esac   # not a production Bridge
    printf '%s\n' "$pid"
    cur="$pid"
    while :; do
        ppid="$(_ppid_of "$cur")"
        [[ -z "$ppid" || "$ppid" == 0 || "$ppid" == 1 ]] && break
        args="$(_args_of "$ppid")"
        case "$args" in
            *worktrees/*)   break ;;                 # don't climb into a worktree wrapper
            *run-bridge.ts*) printf '%s\n' "$ppid"; cur="$ppid" ;;
            *)              break ;;
        esac
    done
}

# Resolve the full set of production-Bridge PIDs to stop (deduped).
bridge_target_pids() {
    local port listener
    port="$(bridge_port)"
    {
        while IFS= read -r listener; do
            [[ -z "$listener" ]] && continue
            collect_bridge_tree "$listener"
        done < <(_listeners_on_port "$port")
    } | awk 'NF && !seen[$0]++'
}

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

# Returns: 0=success, 1=error
# Args: <manifest_path>  (caller passes the manifest directly, no re-globbing)
restart_lead() {
    local manifest="$1"

    local lead_id project_dir project_name subdir bot_token_env workspace mcp_exclude chrome_enabled
    lead_id=$(jq -r '.leadId' "$manifest")
    project_dir=$(jq -r '.projectDir' "$manifest")
    project_name=$(jq -r '.projectName' "$manifest")
    subdir=$(jq -r '.subdir // ""' "$manifest")
    bot_token_env=$(jq -r '.botTokenEnv' "$manifest")
    workspace=$(jq -r '.workspace // ""' "$manifest")
    # FLY-143: per-Lead MCP scope fields. Default empty/false for older
    # manifests so legacy nohup path matches launchd wrapper behavior.
    mcp_exclude=$(jq -r '.mcpExclude // ""' "$manifest")
    chrome_enabled=$(jq -r '.chromeEnabled // false' "$manifest")

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
                # FLY-239: assignment form, not `((wait_count++))` — the latter
                # exits 1 on the first pass (n=0) and `set -e` would abort the
                # Lead restart here (the supervisor is always alive at this
                # point). Same footgun fixed in stop_bridge.
                wait_count=$((wait_count + 1))
            done
            # Fail-fast: refuse to start new supervisor if old is still alive
            if kill -0 "$pid" 2>/dev/null; then
                log "ERROR: Old supervisor for $lead_id (PID $pid) still alive after 60s"
                alert_warning "supervisor-stuck-${lead_id}" "Lead supervisor stuck" \
                    "Lead $lead_id 旧 supervisor (PID $pid) 60s 后仍未退出，跳过重启避免双启动"
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
        alert_warning "lead-restart-failed-${lead_id}" "Lead restart failed" \
            "Lead $lead_id 重启失败: \`$bot_token_env\` 未定义"
        return 1
    fi

    # Per-lead Discord state directory for channel/token isolation
    local discord_state_dir="${HOME}/.claude/channels/discord-${lead_id}"

    # FLY-74: If this Lead is managed by launchd daemon, use kickstart instead
    # of nohup to avoid double-start (launchd KeepAlive would respawn alongside
    # the nohup'd instance).
    local daemon_key="${project_name}-${lead_id}"
    local daemon_label="com.flywheel.lead.${daemon_key}"
    if launchctl print "gui/$(id -u)/${daemon_label}" &>/dev/null; then
        log "Lead $lead_id is managed by launchd — using kickstart"
        launchctl kickstart -k "gui/$(id -u)/${daemon_label}"
        sleep 3
        local daemon_pid
        daemon_pid=$(launchctl print "gui/$(id -u)/${daemon_label}" 2>/dev/null | grep -m1 'pid =' | awk '{print $NF}' || true)
        log "Lead $lead_id restarted via launchd (PID ${daemon_pid:-unknown})"
        return 0
    fi

    # Legacy path: manual nohup (Lead not daemon-managed)
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

# Restart all Leads. Outputs "skipped:N failed:M" to stdout.
# All logs go to stderr; stdout is machine-readable only.
# FLY-231: production-candidate resolver (_prod_membership / _classify_restart_manifest)
# lives in a sourceable lib so its deploy-gating logic is unit-testable. FLYWHEEL_DIR
# is set above; node + jq are required (already preconditions of this script).
# shellcheck source=lib/restart-candidate.sh
source "${FLYWHEEL_DIR}/scripts/lib/restart-candidate.sh"

do_restart_all_leads() {
    local skipped=0
    local failed=0

    # FLY-954: converge <state>/bin BEFORE kickstarting any Lead — kickstarting
    # a corrupted wrapper takes the fleet down (2026-07-06: 12-byte stub +
    # KeepAlive throttling = 13 Leads offline). FAIL-LOUD: if convergence
    # cannot leave bin healthy, refuse the whole Lead restart wave (reported
    # through the existing skipped/failed stdout contract; deploy aborts and
    # deployed-sha does not advance).
    # Codex code R1 MEDIUM: report the refusal through the stdout contract and
    # return 0 — all three call sites capture this function via $( ) under
    # `set -e`, so a non-zero return would kill the whole script at the
    # assignment, skipping the existing failed>0 handling (deploy-failure
    # notification + deployed-sha hold + plugin-only retry marker).
    local _conv_dir
    _conv_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -f "${_conv_dir}/converge-flywheel-bin.sh" ]; then
        if ! bash "${_conv_dir}/converge-flywheel-bin.sh" >&2; then
            log "ERROR: flywheel-bin convergence failed — refusing to kickstart Leads on a possibly-corrupt bin (FLY-954)" >&2
            echo "skipped:0 failed:1"
            return 0
        fi
    else
        # bin-copy execution context (fleet host): fall back to FLYWHEEL_DIR repo
        if ! bash "${FLYWHEEL_DIR}/scripts/converge-flywheel-bin.sh" >&2; then
            log "ERROR: flywheel-bin convergence failed — refusing to kickstart Leads (FLY-954)" >&2
            echo "skipped:0 failed:1"
            return 0
        fi
    fi

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

    # Restart Leads that have manifests (pass manifest path directly).
    # FLY-231 fail-closed resolver: only restart manifests whose (projectName,
    # leadId) match the HOST production projects.json. Skip test-slot-owned
    # manifests (leadId flywheel-test-*) WITHOUT counting them — they must not
    # block deployed-sha advance. Any OTHER non-matching manifest (config drift /
    # removed projects entry / typo) counts as failed → blocks sha advance + alerts,
    # instead of being silently restarted into claude-lead.sh's notfound fail-STOP
    # (Codex R6 BLOCKER-1). "Cannot match" is NEVER treated as test-slot.
    for mf in ${manifests[@]+"${manifests[@]}"}; do
        local lid pn
        lid=$(jq -r '.leadId' "$mf")
        pn=$(jq -r '.projectName' "$mf")
        case "$(_classify_restart_manifest "$lid" "$pn")" in
            skip-test)
                log "Skipping test-slot manifest (lifecycle-owned, not deploy-blocking): $mf (lead=$lid)" >&2
                continue
                ;;
            restart)
                local rc=0
                restart_lead "$mf" >&2 || rc=$?
                if (( rc == 1 )); then
                    failed=$((failed + 1))
                fi
                ;;
            *)  # fail — config drift / removed entry / typo / loadProjects error.
                # NOT a test slot and NOT a host-config match → block deploy
                # (counts as failed → deployed-sha not advanced + Annie alerted).
                log "ERROR: manifest $mf (project=$pn lead=$lid) is NOT in host projects.json and is NOT a test slot — refusing to restart (config drift?). Blocking deploy." >&2
                failed=$((failed + 1))
                ;;
        esac
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
        alert_severe "deploy-failed-no-rollback" "Flywheel deploy failed" \
            "Flywheel 首次部署失败且无法自动回滚（无 known-good SHA）。需要手动介入。"
        return 1
    fi

    log "Rolling back to ${rollback_sha:0:7}"

    # Fail-closed: refuse rollback on dirty checkout
    if [[ -n "$(git -C "$FLYWHEEL_DIR" status --porcelain)" ]]; then
        log "ERROR: Working directory not clean, refusing rollback"
        alert_severe "rollback-blocked-dirty" "Flywheel rollback blocked" \
            "Flywheel rollback 被阻止: 工作区不干净。需要手动介入。"
        return 1
    fi

    git -C "$FLYWHEEL_DIR" reset --hard "$rollback_sha"

    # Best-effort: rebuild old version and restart
    if pnpm -C "$FLYWHEEL_DIR" install --frozen-lockfile && \
       pnpm -C "$FLYWHEEL_DIR" build; then
        if [[ "$restart_bridge" == "true" ]]; then
            # FLY-516 (Codex R1 HIGH): stop_bridge is now fail-closed (returns 1 on
            # a stuck port). Guard the bare call — under `set -e` an unguarded
            # non-zero would abort the rollback silently. If the port can't be
            # freed even during rollback, the old version can't bind either →
            # severe alert + bail (a human must SIGKILL the listener).
            if ! stop_bridge; then
                alert_severe "rollback-port-stuck" "Flywheel deploy failed" \
                    "Flywheel 回滚时 Bridge 端口 :$(bridge_port) 未能释放 — 无法重启旧版本。需手动 SIGKILL listener (lsof -ti:$(bridge_port))。"
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
            rb_lead_result=$(do_restart_all_leads)
            rb_leads_failed=$(echo "$rb_lead_result" | sed 's/.*failed:\([0-9]*\).*/\1/')
            # FLY-98: trigger cmux refresh after rollback restart
            trigger_cmux_refresh
        fi
        if (( rb_leads_failed > 0 )); then
            alert_severe "rollback-leads-failed" "Flywheel deploy failed" \
                "Flywheel 回滚到 \`${rollback_sha:0:7}\` 成功，但 ${rb_leads_failed} 个 Lead（含 Eng Lead？）未恢复——KeepAlive 重拉不了坏 token/manifest/config。需要手动开 terminal 检查。"
        else
            alert_warning "update-rolled-back" "Flywheel update rolled back" \
                "Flywheel 更新到 \`${CURRENT_HEAD:0:7}\` 失败。已回滚到 \`${rollback_sha:0:7}\` 并重启旧版本（Lead 已恢复）。"
        fi
    else
        alert_severe "update-and-rollback-failed" "Flywheel deploy failed" \
            "Flywheel 更新失败且回滚 build 也失败。服务可能处于异常状态。需要手动介入。"
    fi
}

# ════════════════════════════════════════════════════════════════
# Deploy + Verify
# ════════════════════════════════════════════════════════════════

deploy_and_verify() {
    local restarted=()

    notify_routine "🔄 开始更新 Flywheel: \`${DEPLOYED_SHA:0:7}\` → \`${CURRENT_HEAD:0:7}\`"

    # Step 1: Stop Bridge FIRST (triggers stopAccepting + drain)
    # FLY-516 (Codex R1 HIGH): fail-closed — if the old Bridge's port can't be
    # freed, abort BEFORE start_bridge + the /health check (which would otherwise
    # hit the stuck holder and falsely pass). bp_confirm_port_released already
    # alerted; do NOT advance deployed-sha.
    if [[ "$restart_bridge" == "true" ]]; then
        if ! stop_bridge; then
            log "ERROR: stop_bridge failed to free the port — aborting deploy (deployed-sha NOT advanced)."
            alert_severe "deploy-port-stuck" "Flywheel deploy aborted" \
                "Flywheel 部署中止: Bridge 端口未能释放,新 Bridge 无法 bind。需手动 SIGKILL listener (lsof -ti:$(bridge_port))。"
            return 1
        fi
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
        # FLY-98: trigger cmux refresh after all Leads restarted
        trigger_cmux_refresh
    fi

    # Step 5: Update deployed-sha
    if (( leads_failed > 0 )); then
        log "ERROR: ${leads_failed} lead(s) failed to restart. deployed-sha NOT advanced."
        alert_warning "leads-partial-failed" "Lead restarts partially failed" \
            "Flywheel 更新到 \`${CURRENT_HEAD:0:7}\` 部分失败。${leads_failed} 个 Lead 重启失败。下次运行会重试。"
        return 1
    fi

    # Clear any stale plugin-restart-pending marker after successful deploy
    rm -f "$PLUGIN_RESTART_PENDING"

    if (( leads_skipped > 0 )); then
        log "WARNING: ${leads_skipped} lead(s) skipped (no manifest). deployed-sha NOT advanced."
        alert_warning "leads-skipped-no-manifest" "Leads skipped (no manifest)" \
            "Flywheel 部分更新到 \`${CURRENT_HEAD:0:7}\`。${leads_skipped} 个 Lead 因缺少 manifest 被跳过。请手动重启这些 Lead 一次以生成 manifest。"
        return 0
    fi

    record_deployed_range "$DEPLOYED_SHA" "$CURRENT_HEAD"
    echo "$CURRENT_HEAD" > "$DEPLOYED_SHA_FILE"
    log "deployed-sha updated to ${CURRENT_HEAD:0:7}"

    # Update project repo deployed SHAs (FLY-43)
    update_project_shas

    notify_routine "✅ Flywheel 已更新到 \`${CURRENT_HEAD:0:7}\`。重启了: ${restarted[*]:-无}"
}

# ════════════════════════════════════════════════════════════════
# Main
# ════════════════════════════════════════════════════════════════

if [[ "$BRIDGE_ONLY" == "true" ]]; then
    # FLY-1142: sanctioned env-reload path. The 2026-07-10 stopgap removal
    # needed a Bridge bounce with ZERO code delta, and the normal deploy path
    # exits early on "already deployed" — the only way through was a
    # guard-bypass manual kickstart. This branch is the sanctioned road:
    # stop → start → health check, nothing else. It never builds, never
    # touches deployed-sha / project SHAs / the plugin marker, never restarts
    # Leads, never sends deploy notifications, and never reuses
    # deploy_and_verify (no rollback machinery — there is no code change to
    # roll back).
    log "Bridge-only restart (env reload): no build, no SHA writes, Leads untouched"
    if [[ "$DRY_RUN" == "true" ]]; then
        log "DRY RUN: Would restart ONLY the Bridge in place — skip the idle wait by default (pass --wait-idle or FLYWHEEL_RESTART_WAIT_IDLE=1 to wait), stop Bridge on :$(bridge_port), start via launchctl kickstart, health-check up to 60s."
        log "DRY RUN: No build, no deployed-sha/project-sha writes, no Lead restarts, no plugin update, no deploy notifications."
        exit 0
    fi
    # FLY-1224: idle wait is opt-in.
    if [[ "$WAIT_IDLE" == "true" ]]; then
        log "Waiting for idle sessions before bridge-only restart..."
        if ! wait_for_idle; then
            log "Proceeding with bridge-only restart after idle timeout"
        fi
    fi
    if ! stop_bridge; then
        log "ERROR: stop_bridge failed to free the port — aborting bridge-only restart."
        alert_severe "bridge-only-port-stuck" "Flywheel bridge-only restart aborted" \
            "bridge-only 重启中止: Bridge 端口未能释放,新 Bridge 无法 bind。需手动 SIGKILL listener (lsof -ti:$(bridge_port))。"
        exit 1
    fi
    start_bridge
    # Same-strength health check as deploy_and_verify Step 3 (up to 60s).
    hc_ok=false
    for _ in $(seq 1 30); do
        if curl -sf "$BRIDGE_URL/health" | jq -e '.ok' > /dev/null 2>&1; then
            hc_ok=true
            break
        fi
        sleep 2
    done
    if [[ "$hc_ok" != "true" ]]; then
        log "ERROR: Bridge health check failed after bridge-only restart."
        alert_severe "bridge-only-health-failed" "Flywheel bridge-only restart failed" \
            "bridge-only 重启后 Bridge health check 60s 内未通过。Bridge 可能没起来 — 请查 /tmp/flywheel-bridge.log 与 launchctl print gui/\$(id -u)/com.flywheel.bridge。"
        exit 1
    fi
    log "Bridge health check: OK"
    log "Done (bridge-only)."
    exit 0
fi

if [[ "$PLUGIN_ONLY_RESTART" == "true" ]]; then
    # Lead-only restart path: plugin update or project .lead/ changes (no Flywheel code change)
    log "Lead-only restart: plugin=$plugin_needs_restart project_lead=$project_lead_changed"
    notify_routine "🔄 Lead 重启中 (plugin=$plugin_needs_restart project_lead=$project_lead_changed)..."

    lead_result=$(do_restart_all_leads)
    leads_skipped=$(echo "$lead_result" | sed 's/.*skipped:\([0-9]*\).*/\1/')
    leads_failed=$(echo "$lead_result" | sed 's/.*failed:\([0-9]*\).*/\1/')

    # FLY-98: trigger cmux refresh after Lead-only restart
    trigger_cmux_refresh

    if (( leads_failed > 0 )); then
        # Write retry marker — next run will retry Lead restart
        echo "failed=$leads_failed at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PLUGIN_RESTART_PENDING"
        alert_warning "plugin-leads-failed" "Lead restarts failed after plugin update" \
            "Discord plugin 更新后 ${leads_failed} 个 Lead 重启失败。请检查日志。"
        exit 1
    fi
    # Success (full or partial-skip) — clear retry marker
    rm -f "$PLUGIN_RESTART_PENDING"
    # Update project repo deployed SHAs (FLY-43)
    update_project_shas
    if (( leads_skipped > 0 )); then
        alert_warning "plugin-leads-skipped" "Leads skipped after plugin update" \
            "Discord plugin 更新后 ${leads_skipped} 个 Lead 跳过（无 manifest）。请手动重启。"
        exit 0
    fi
    notify_routine "✅ Lead 重启完成 (plugin=$plugin_needs_restart project_lead=$project_lead_changed)。"
    # FLY-90: Sync gbrain project Wiki (non-blocking, best-effort)
    if [[ -x "$HOME/.flywheel/bin/sync-gbrain-docs.sh" ]]; then
        nohup "$HOME/.flywheel/bin/sync-gbrain-docs.sh" >/dev/null 2>&1 &
        log "gbrain doc sync triggered (background PID $!)"
    fi
    log "Done."
else
    # Normal deploy path
    log "Starting restart: ${DEPLOYED_SHA:0:7} → ${CURRENT_HEAD:0:7} (bridge=$restart_bridge leads=$restart_all_leads)"
    deploy_and_verify
    # FLY-90: Sync gbrain project Wiki (non-blocking, best-effort)
    if [[ -x "$HOME/.flywheel/bin/sync-gbrain-docs.sh" ]]; then
        nohup "$HOME/.flywheel/bin/sync-gbrain-docs.sh" >/dev/null 2>&1 &
        log "gbrain doc sync triggered (background PID $!)"
    fi
    log "Done."
fi

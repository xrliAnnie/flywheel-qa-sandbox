#!/usr/bin/env bash
set -euo pipefail

FLYWHEEL_DIR="${HOME}/Dev/flywheel"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${HOME}/.flywheel/.env"
DEPLOYED_SHA_FILE="${HOME}/.flywheel/deployed-sha"

[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [flywheel-updater] $*"; }

DISCORD_CORE_CHANNEL="${DISCORD_CORE_CHANNEL:-1485787822894878955}"
NOTIFY_BOT_TOKEN="${SIMBA_BOT_TOKEN:-${DISCORD_BOT_TOKEN:-}}"

notify_discord() {
    [[ -z "$NOTIFY_BOT_TOKEN" ]] && return
    local payload
    payload=$(jq -n --arg content "$1" '{content: $content}')
    curl -sf -X POST "https://discord.com/api/v10/channels/${DISCORD_CORE_CHANNEL}/messages" \
        -H "Authorization: Bot ${NOTIFY_BOT_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "$payload" \
        --max-time 5 || log "WARNING: Discord notification failed"
}

# Fetch latest
git -C "$FLYWHEEL_DIR" fetch origin main --quiet

LOCAL=$(git -C "$FLYWHEEL_DIR" rev-parse HEAD)
REMOTE=$(git -C "$FLYWHEEL_DIR" rev-parse origin/main)
DEPLOYED=$(cat "$DEPLOYED_SHA_FILE" 2>/dev/null || echo "")

# No early exit — always delegate to restart-services.sh
# (it handles "nothing to do" + Discord plugin fork detection)

# Pull if remote is ahead
if [[ "$LOCAL" != "$REMOTE" ]]; then
    log "Local ${LOCAL:0:7} != remote ${REMOTE:0:7}. Pulling..."
    git -C "$FLYWHEEL_DIR" pull origin main --ff-only || {
        log "ERROR: git pull failed"
        notify_discord "⚠️ launchd 兜底: git pull 失败。可能有 local changes 冲突。"
        exit 1
    }

    # Notify that fallback was triggered (Orchestrator didn't run)
    notify_discord "⚠️ **launchd 兜底更新触发** — Orchestrator 似乎未在 merge 后执行 restart。\nLocal: \`${LOCAL:0:7}\` → Remote: \`${REMOTE:0:7}\`"
elif [[ "$DEPLOYED" != "$LOCAL" ]]; then
    log "Repo at ${LOCAL:0:7} but deployed at ${DEPLOYED:0:7}. Retrying failed deploy."
fi

# Always delegate to restart-services.sh (deployed-sha is the gate)
"${SCRIPT_DIR}/restart-services.sh"

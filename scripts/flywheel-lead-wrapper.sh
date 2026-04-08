#!/bin/bash
# FLY-74: launchd -> claude-lead.sh thin wrapper.
# Reads manifest, sources environment, execs claude-lead.sh.
#
# launchd cannot source .bashrc or .env files, so this wrapper handles
# environment setup before exec-ing the real supervisor script.
#
# Usage: flywheel-lead-wrapper.sh <manifest-path>
#   Called by launchd plist ProgramArguments — not intended for manual use.
#   For manual Lead startup, use claude-lead.sh directly.
#
# The manifest path (not just lead-id) is passed to avoid cross-project
# collision when multiple projects have Leads with the same name.
set -euo pipefail

MANIFEST="${1:?Usage: flywheel-lead-wrapper.sh <manifest-path>}"
FLYWHEEL_DIR="${HOME}/Dev/flywheel"
ENV_FILE="${HOME}/.flywheel/.env"
PID_DIR="${HOME}/.flywheel/pids"

log() {
  echo "[wrapper] $(date '+%H:%M:%S') $*"
}

# ── Source environment ─────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  log "ERROR: Environment file not found: ${ENV_FILE}"
  exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"

# ── Expand PATH for launchd ───────────────────────────────────
# launchd provides only /usr/bin:/bin:/usr/sbin:/sbin.
# claude CLI, jq, node, and brew tools live outside that.
export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:${PATH}"

# ── Validate manifest ─────────────────────────────────────────
if [ ! -f "$MANIFEST" ]; then
  log "ERROR: Manifest not found: ${MANIFEST}"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  log "ERROR: jq is required but not found."
  exit 1
fi

# ── Read manifest parameters ──────────────────────────────────
LEAD_ID=$(jq -r '.leadId' "$MANIFEST")
PROJECT_DIR=$(jq -r '.projectDir' "$MANIFEST")
PROJECT_NAME=$(jq -r '.projectName' "$MANIFEST")
SUBDIR=$(jq -r '.subdir // ""' "$MANIFEST")
BOT_TOKEN_ENV=$(jq -r '.botTokenEnv // "DISCORD_BOT_TOKEN"' "$MANIFEST")
WORKSPACE=$(jq -r '.workspace // ""' "$MANIFEST")

# Validate critical fields
if [ -z "$LEAD_ID" ] || [ "$LEAD_ID" = "null" ]; then
  log "ERROR: Manifest missing leadId: ${MANIFEST}"
  exit 1
fi
if [ -z "$PROJECT_DIR" ] || [ "$PROJECT_DIR" = "null" ]; then
  log "ERROR: Manifest missing projectDir: ${MANIFEST}"
  exit 1
fi
if [ ! -d "$PROJECT_DIR" ]; then
  log "ERROR: Project directory does not exist: ${PROJECT_DIR}"
  exit 1
fi

# ── PID lock: prevent double-start during restart-services.sh transition ──
# When launchd KeepAlive respawns this wrapper while restart-services.sh
# has already nohup'd a new supervisor, exit to avoid dual instances.
PID_FILE="${PID_DIR}/${PROJECT_NAME}-${LEAD_ID}.pid"
if [ -f "$PID_FILE" ]; then
  EXISTING_PID=$(cat "$PID_FILE")
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    log "Lead '${LEAD_ID}' already running (PID ${EXISTING_PID}). Exiting to avoid double-start."
    # Exit 0: launchd will retry after ThrottleInterval (30s).
    # By then, if the nohup'd instance crashed, we'll take over.
    exit 0
  fi
fi

# ── Set environment variables ──────────────────────────────────
# Resolve bot token from the named env var (e.g., PETER_BOT_TOKEN)
export DISCORD_BOT_TOKEN="${!BOT_TOKEN_ENV:-}"
if [ -z "$DISCORD_BOT_TOKEN" ]; then
  log "WARNING: Bot token env '${BOT_TOKEN_ENV}' is empty. Discord may not work."
fi
export DISCORD_STATE_DIR="${HOME}/.claude/channels/discord-${LEAD_ID}"

# Replay custom workspace if manifest recorded one
if [ -n "$WORKSPACE" ] && [ "$WORKSPACE" != "null" ]; then
  export LEAD_WORKSPACE="$WORKSPACE"
fi

# ── Build claude-lead.sh arguments ─────────────────────────────
ARGS=("$LEAD_ID" "$PROJECT_DIR" "$PROJECT_NAME")
if [ -n "$SUBDIR" ]; then
  ARGS+=(--subdir "$SUBDIR")
fi
ARGS+=(--bot-token-env "$BOT_TOKEN_ENV")

log "Starting Lead '${LEAD_ID}' (project: ${PROJECT_NAME}, subdir: ${SUBDIR:-root}, workspace: ${WORKSPACE:-default})"

# ── exec claude-lead.sh ───────────────────────────────────────
# exec replaces this wrapper process, so launchd directly manages
# the claude-lead.sh supervisor (correct PID tracking, signal delivery).
LEAD_SCRIPT="${FLYWHEEL_DIR}/packages/teamlead/scripts/claude-lead.sh"
if [ ! -x "$LEAD_SCRIPT" ]; then
  log "ERROR: claude-lead.sh not found or not executable: ${LEAD_SCRIPT}"
  exit 1
fi

cd "${FLYWHEEL_DIR}/packages/teamlead"
exec "$LEAD_SCRIPT" "${ARGS[@]}"

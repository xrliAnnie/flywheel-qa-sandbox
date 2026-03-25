#!/bin/bash
# GEO-195: Manual supervisor script for Claude Lead session.
# GEO-234: Agent file + workspace isolation + flywheel-comm integration.
# GEO-246: Parameterized for multi-lead — supports any agent name.
#
# Usage: ./scripts/claude-lead.sh <lead-id> <project-dir> [project-name]
#
# lead-id: Must match an agent file in packages/teamlead/agents/<lead-id>.md
#   and an agentId in projects.json leads[].
#
# project-name: canonical name used for comm DB path (must match Blueprint's
#   ctx.projectName). Defaults to basename of project-dir if omitted.
#   This MUST match the value Blueprint uses, otherwise Lead and Runner
#   will read/write different comm.db files.
#
# Environment variables:
#   DISCORD_BOT_TOKEN  — Bot token for this Lead's Discord identity (required for Discord)
#   LEAD_WORKSPACE     — Custom workspace directory (optional, default: ~/.flywheel/lead-workspace/<lead-id>)
#   BRIDGE_URL         — Bridge API URL (default: http://localhost:9876)
#   TEAMLEAD_API_TOKEN — Bridge API auth token
#
# Examples:
#   # Product Lead (Peter)
#   source ~/.flywheel/.env
#   cd ~/Dev/flywheel/packages/teamlead && \
#   DISCORD_BOT_TOKEN=$PETER_BOT_TOKEN \
#   LEAD_WORKSPACE=/path/to/geoforge3d/product/.lead/product-lead \
#     ./scripts/claude-lead.sh product-lead /path/to/geoforge3d geoforge3d
#
#   # Ops Lead (Oliver)
#   source ~/.flywheel/.env
#   cd ~/Dev/flywheel/packages/teamlead && \
#   DISCORD_BOT_TOKEN=$OLIVER_BOT_TOKEN \
#   LEAD_WORKSPACE=/path/to/geoforge3d/operations/.lead/ops-lead \
#     ./scripts/claude-lead.sh ops-lead /path/to/geoforge3d geoforge3d
#
# On crash: up-arrow + enter to restart.
#
# flywheel-comm CLI commands (available via $FLYWHEEL_COMM_CLI):
#   Check pending Runner questions:
#     node "$FLYWHEEL_COMM_CLI" pending --lead "$LEAD_ID" --project "$PROJECT_NAME"
#   Respond to Runner question:
#     node "$FLYWHEEL_COMM_CLI" respond --lead "$LEAD_ID" <question-id> "answer"
#   Send instruction to Runner:
#     node "$FLYWHEEL_COMM_CLI" send --from "$LEAD_ID" --to <exec-id> "instruction text"
#   View Runner sessions (all statuses):
#     node "$FLYWHEEL_COMM_CLI" sessions --project "$PROJECT_NAME"
#   Capture Runner tmux output:
#     node "$FLYWHEEL_COMM_CLI" capture --exec-id <exec-id>
set -euo pipefail

# ── Parse arguments and export for agent prompt ──────────────
export LEAD_ID="${1:?Usage: claude-lead.sh <lead-id> <project-dir> [project-name]}"
# GEO-246: Validate LEAD_ID format to prevent path traversal.
# Only lowercase alphanumeric and hyphens allowed (e.g., "product-lead", "ops-lead").
if [[ ! "$LEAD_ID" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "[lead] ERROR: Invalid lead-id '${LEAD_ID}'. Must match [a-z0-9][a-z0-9-]*"
  exit 1
fi
# Normalize PROJECT_DIR: expand ~ and resolve to absolute path (must match
# projectRoot in projects.json exactly for canonical name resolution)
PROJECT_DIR_RAW="${2:?Usage: claude-lead.sh <lead-id> <project-dir> [project-name]}"
PROJECT_DIR="$(cd "$PROJECT_DIR_RAW" && pwd)"
export BRIDGE_URL="${BRIDGE_URL:-http://localhost:9876}"
export TEAMLEAD_API_TOKEN="${TEAMLEAD_API_TOKEN:-}"
# GEO-246: Per-lead Discord state directory for channel/token isolation.
# Each lead gets its own .env (bot token) and access.json (channel list).
# Default: ~/.claude/channels/discord-<lead-id>/
export DISCORD_STATE_DIR="${DISCORD_STATE_DIR:-${HOME}/.claude/channels/discord-${LEAD_ID}}"
echo "[lead] Discord state: ${DISCORD_STATE_DIR}"
SESSION_DIR="${HOME}/.flywheel/claude-sessions"
# GEO-246: SESSION_ID_FILE set after PROJECT_NAME resolution (below)
# to include project name and avoid cross-project session collisions.

mkdir -p "$SESSION_DIR"

# ── Resolve canonical project name ───────────────────────────
# Priority: 1) explicit 3rd arg, 2) loadProjects() lookup by projectRoot, 3) basename
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${3:-}" ]; then
  PROJECT_NAME="$3"
else
  PROJECT_NAME=$(node -e "
    import('file://${SCRIPT_DIR}/../dist/ProjectConfig.js').then(({ loadProjects }) => {
      try {
        const m = loadProjects().find(e => e.projectRoot === process.argv[1]);
        if (m) process.stdout.write(m.projectName);
      } catch {}
    }).catch(() => {});
  " "$PROJECT_DIR" 2>/dev/null)
  PROJECT_NAME="${PROJECT_NAME:-$(basename "$PROJECT_DIR")}"
fi
export PROJECT_NAME

# GEO-246: Include PROJECT_NAME in session file to avoid cross-project collisions.
# e.g., ~/.flywheel/claude-sessions/geoforge3d-product-lead.session-id
SESSION_ID_FILE="${SESSION_DIR}/${PROJECT_NAME}-${LEAD_ID}.session-id"

# ── Comm DB + CLI setup ──────────────────────────────────────
export FLYWHEEL_COMM_DB="${HOME}/.flywheel/comm/${PROJECT_NAME}/comm.db"
# GEO-234: Non-failing probe — use [ -f ] first, then cd && pwd only if exists.
# This prevents set -e from aborting when flywheel-comm is not built.
COMM_DIST_DIR="${SCRIPT_DIR}/../../flywheel-comm/dist"
if [ -f "${COMM_DIST_DIR}/index.js" ]; then
  export FLYWHEEL_COMM_CLI="$(cd "$COMM_DIST_DIR" && pwd)/index.js"
  echo "[lead] Comm CLI: ${FLYWHEEL_COMM_CLI}"
else
  echo "[lead] WARNING: flywheel-comm not built. Runner communication disabled."
  echo "[lead] Lead will still handle Discord events and CEO commands."
  echo "[lead] Run 'pnpm -r build' to enable Runner communication."
fi
mkdir -p "$(dirname "$FLYWHEEL_COMM_DB")"
echo "[lead] Comm DB: ${FLYWHEEL_COMM_DB}"

# ── Agent file auto-sync (project source → global target) ──
# GEO-246: Agent files are project-specific, not Flywheel infrastructure.
# Priority: 1) AGENT_SOURCE env var, 2) LEAD_WORKSPACE/agent.md, 3) Flywheel repo agents/ (fallback)
if [ -n "${AGENT_SOURCE:-}" ]; then
  : # explicit override, use as-is
elif [ -f "${LEAD_WORKSPACE}/agent.md" ]; then
  AGENT_SOURCE="${LEAD_WORKSPACE}/agent.md"
else
  AGENT_SOURCE="${SCRIPT_DIR}/../agents/${LEAD_ID}.md"
fi
AGENT_TARGET="${HOME}/.claude/agents/${LEAD_ID}.md"
mkdir -p "${HOME}/.claude/agents"

if [ -f "$AGENT_SOURCE" ]; then
  # Copy (not symlink) to prevent Lead from writing back to repo via symlink.
  # Lead has Bash + bypassPermissions, so a symlink would let it mutate the
  # version-controlled agent source file.
  # Remove first: if target is an existing symlink (from older versions),
  # cp would follow it and overwrite the symlink target in-place.
  rm -f "$AGENT_TARGET"
  cp "$AGENT_SOURCE" "$AGENT_TARGET"
  echo "[lead] Agent file installed: ${AGENT_TARGET} (copied from ${AGENT_SOURCE})"
else
  echo "[lead] ERROR: Agent source not found at ${AGENT_SOURCE}"
  echo "[lead] Searched: AGENT_SOURCE env, ${PROJECT_DIR}/.lead/${LEAD_ID}/agent.md, ${SCRIPT_DIR}/../agents/${LEAD_ID}.md"
  exit 1
fi

# ── Workspace isolation ──────────────────────────────────────
# Lead runs in an isolated workspace, NOT in the product repo.
# This reduces risk of accidental code modification via Bash.
LEAD_WORKSPACE="${LEAD_WORKSPACE:-${HOME}/.flywheel/lead-workspace/${LEAD_ID}}"
mkdir -p "$LEAD_WORKSPACE"
echo "[lead] Working directory: ${LEAD_WORKSPACE} (isolated from product repo)"

# ── Bootstrap via Bridge API ─────────────────────────────────
echo "[lead] Sending bootstrap for ${LEAD_ID}..."
BRIDGE_TOKEN="${TEAMLEAD_API_TOKEN:-}"
if [ -n "$BRIDGE_TOKEN" ]; then
  curl -s -X POST "${BRIDGE_URL}/api/bootstrap/${LEAD_ID}" \
    -H "Authorization: Bearer ${BRIDGE_TOKEN}" \
    -H "Content-Type: application/json" || echo "[lead] Bootstrap failed (non-fatal)"
else
  curl -s -X POST "${BRIDGE_URL}/api/bootstrap/${LEAD_ID}" \
    -H "Content-Type: application/json" || echo "[lead] Bootstrap failed (non-fatal)"
fi

# Wait for bootstrap message to arrive in Discord
sleep 3

# ── Launch Claude with agent identity ────────────────────────
cd "$LEAD_WORKSPACE"

# Build claude args using bash array (avoids quoting/word-splitting issues)
CLAUDE_ARGS=(--agent "$LEAD_ID" --channels "plugin:discord@claude-plugins-official")

# Resume if we have a session ID, otherwise start fresh
if [ -f "$SESSION_ID_FILE" ]; then
  SESSION_ID=$(cat "$SESSION_ID_FILE")
  echo "[lead] Resuming session ${SESSION_ID}..."
  echo "[lead] (To clear session: rm ${SESSION_ID_FILE})"
  claude "${CLAUDE_ARGS[@]}" --resume "$SESSION_ID"
else
  echo "[lead] Starting fresh session..."
  echo "[lead] After Claude starts, save the session ID with:"
  echo "[lead]   echo '<session-id>' > ${SESSION_ID_FILE}"
  echo "[lead] You can find it in ~/.claude/projects/*/sessions/"
  claude "${CLAUDE_ARGS[@]}"
fi

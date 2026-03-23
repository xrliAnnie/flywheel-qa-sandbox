#!/bin/bash
# GEO-195: Manual supervisor script for Claude Lead session.
# GEO-234: Agent file + workspace isolation + flywheel-comm integration.
#
# Usage: ./scripts/claude-lead.sh <lead-id> <project-dir> [project-name]
#
# project-name: canonical name used for comm DB path (must match Blueprint's
#   ctx.projectName). Defaults to basename of project-dir if omitted.
#   This MUST match the value Blueprint uses, otherwise Lead and Runner
#   will read/write different comm.db files.
#
# Run inside a tmux session:
#   tmux new -s product-lead
#   ./scripts/claude-lead.sh product-lead /Users/xiaorongli/Dev/geoforge3d geoforge3d
#
# On crash: up-arrow + enter to restart.
#
# GEO-234: Lead uses --agent product-lead (defined in packages/teamlead/agents/).
#   The agent file is auto-symlinked to ~/.claude/agents/product-lead.md on startup.
#   Lead runs in an isolated workspace (~/.flywheel/lead-workspace/<lead-id>/),
#   NOT in the product repo, to reduce risk of accidental code modification.
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
# Normalize PROJECT_DIR: expand ~ and resolve to absolute path (must match
# projectRoot in projects.json exactly for canonical name resolution)
PROJECT_DIR_RAW="${2:?Usage: claude-lead.sh <lead-id> <project-dir> [project-name]}"
PROJECT_DIR="$(cd "$PROJECT_DIR_RAW" && pwd)"
export BRIDGE_URL="${BRIDGE_URL:-http://localhost:9876}"
export TEAMLEAD_API_TOKEN="${TEAMLEAD_API_TOKEN:-}"
SESSION_DIR="${HOME}/.flywheel/claude-sessions"
SESSION_ID_FILE="${SESSION_DIR}/${LEAD_ID}.session-id"

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

# ── Agent file auto-sync (symlink repo source → global target) ──
AGENT_SOURCE="${SCRIPT_DIR}/../agents/product-lead.md"
AGENT_TARGET="${HOME}/.claude/agents/product-lead.md"
mkdir -p "${HOME}/.claude/agents"

if [ -f "$AGENT_SOURCE" ]; then
  ln -sf "$(cd "$(dirname "$AGENT_SOURCE")" && pwd)/$(basename "$AGENT_SOURCE")" "$AGENT_TARGET"
  echo "[lead] Agent file synced: ${AGENT_TARGET} -> $(readlink "$AGENT_TARGET")"
else
  echo "[lead] ERROR: Agent source not found at ${AGENT_SOURCE}"
  echo "[lead] Ensure packages/teamlead/agents/product-lead.md exists."
  exit 1
fi

# ── Workspace isolation ──────────────────────────────────────
# Lead runs in an isolated workspace, NOT in the product repo.
# This reduces risk of accidental code modification via Bash.
LEAD_WORKSPACE="${HOME}/.flywheel/lead-workspace/${LEAD_ID}"
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
CLAUDE_ARGS=(--agent product-lead --channels "plugin:discord@claude-plugins-official")

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
  claude "${CLAUDE_ARGS[@]}" \
    | tee >(
      # Attempt to capture session ID from Claude's startup output
      grep -m1 -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
        > "$SESSION_ID_FILE" 2>/dev/null || true
    )
  # If the grep captured a session ID, log it
  if [ -f "$SESSION_ID_FILE" ] && [ -s "$SESSION_ID_FILE" ]; then
    echo "[lead] Auto-captured session ID: $(cat "$SESSION_ID_FILE")"
  fi
fi

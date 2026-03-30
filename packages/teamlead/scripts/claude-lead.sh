#!/bin/bash
# GEO-195: Manual supervisor script for Claude Lead session.
# GEO-234: Agent file + flywheel-comm integration.
# GEO-246: Parameterized for multi-lead — supports any agent name.
# GEO-286: Per-Lead workspace subdirectory. Claude Code walks up to load
#   project CLAUDE.md, so subdirectory still gets full project context.
#
# Usage: ./scripts/claude-lead.sh <lead-id> <project-dir> [project-name] [--subdir <dir>]
#
# lead-id: Must match an agent file at <project-dir>/.lead/<lead-id>/agent.md
#   and an agentId in projects.json leads[].
#
# project-name: canonical name used for comm DB path (must match Blueprint's
#   ctx.projectName). Defaults to basename of project-dir if omitted.
#   This MUST match the value Blueprint uses, otherwise Lead and Runner
#   will read/write different comm.db files.
#
# --subdir <dir>: subdirectory within project-dir for this Lead's workspace.
#   Must be a relative path within project-dir (no .. traversal).
#   Omit for root directory (e.g. Simba as Chief of Staff).
#   Examples: --subdir product (Peter), --subdir operations (Oliver).
#
# Environment variables:
#   DISCORD_BOT_TOKEN  — Bot token for this Lead's Discord identity (required for Discord)
#   LEAD_WORKSPACE     — Custom workspace directory (optional, overrides --subdir)
#   BRIDGE_URL         — Bridge API URL (default: http://localhost:9876)
#   TEAMLEAD_API_TOKEN — Bridge API auth token
#
# Examples:
#   # Product Lead (Peter) — runs in GeoForge3D/product/
#   source ~/.flywheel/.env
#   cd ~/Dev/flywheel/packages/teamlead && \
#   DISCORD_BOT_TOKEN=$PETER_BOT_TOKEN \
#     ./scripts/claude-lead.sh product-lead /path/to/geoforge3d geoforge3d --subdir product
#
#   # Ops Lead (Oliver) — runs in GeoForge3D/operations/
#   source ~/.flywheel/.env
#   cd ~/Dev/flywheel/packages/teamlead && \
#   DISCORD_BOT_TOKEN=$OLIVER_BOT_TOKEN \
#     ./scripts/claude-lead.sh ops-lead /path/to/geoforge3d geoforge3d --subdir operations
#
#   # Chief of Staff (Simba) — runs in GeoForge3D/ (root, no --subdir)
#   source ~/.flywheel/.env
#   cd ~/Dev/flywheel/packages/teamlead && \
#   DISCORD_BOT_TOKEN=$SIMBA_BOT_TOKEN \
#     ./scripts/claude-lead.sh cos-lead /path/to/geoforge3d geoforge3d
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
export LEAD_ID="${1:?Usage: claude-lead.sh <lead-id> <project-dir> [project-name] [--subdir <dir>]}"
# GEO-246: Validate LEAD_ID format to prevent path traversal.
# Only lowercase alphanumeric and hyphens allowed (e.g., "product-lead", "ops-lead").
if [[ ! "$LEAD_ID" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "[lead] ERROR: Invalid lead-id '${LEAD_ID}'. Must match [a-z0-9][a-z0-9-]*"
  exit 1
fi
# Normalize PROJECT_DIR: expand ~ and resolve to absolute path.
PROJECT_DIR_RAW="${2:?Usage: claude-lead.sh <lead-id> <project-dir> [project-name] [--subdir <dir>]}"
# Logical path (preserves symlinks) — used for projects.json name lookup,
# where projectRoot must match exactly as configured.
PROJECT_DIR_LOGICAL="$(cd "$PROJECT_DIR_RAW" && pwd)"
# Physical path (resolves symlinks) — used for --subdir boundary enforcement,
# where symlink-based escapes must be detected.
PROJECT_DIR="$(cd "$PROJECT_DIR_RAW" && pwd -P)"
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

# ── Resolve canonical project name + parse flags ─────────────
# GEO-286: $3 is project-name IF it doesn't start with "--".
# Flags (--subdir) can appear at $3+ position.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LEAD_SUBDIR=""
PROJECT_NAME=""

# Parse $3+ as either project-name (first non-flag) or flags
shift 2
while [ $# -gt 0 ]; do
  case "$1" in
    --subdir)
      if [ $# -lt 2 ] || [ -z "${2:-}" ] || [[ "${2:-}" == --* ]]; then
        echo "[lead] ERROR: --subdir requires a directory argument."
        exit 1
      fi
      LEAD_SUBDIR="$2"
      shift 2
      ;;
    --*)
      echo "[lead] ERROR: Unknown flag '$1'. Did you mean --subdir?"
      exit 1
      ;;
    *)
      if [ -z "$PROJECT_NAME" ]; then
        PROJECT_NAME="$1"
        shift
      else
        echo "[lead] ERROR: Unexpected argument '$1'. Use --subdir for workspace subdirectory."
        exit 1
      fi
      ;;
  esac
done

# If project-name wasn't provided, auto-resolve
if [ -z "$PROJECT_NAME" ]; then
  PROJECT_NAME=$(node -e "
    import('file://${SCRIPT_DIR}/../dist/ProjectConfig.js').then(({ loadProjects }) => {
      try {
        const m = loadProjects().find(e => e.projectRoot === process.argv[1]);
        if (m) process.stdout.write(m.projectName);
      } catch {}
    }).catch(() => {});
  " "$PROJECT_DIR_LOGICAL" 2>/dev/null)
  PROJECT_NAME="${PROJECT_NAME:-$(basename "$PROJECT_DIR_LOGICAL")}"
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

# ── Workspace ────────────────────────────────────────────────
# GEO-286: Per-Lead subdirectory. Claude Code walks up the directory tree
# to find CLAUDE.md, so running in a subdirectory still gets full project
# context from the root CLAUDE.md.
# LEAD_WORKSPACE env var is the highest-priority escape hatch: if set,
# skip --subdir path validation (existence, boundary check) and use it
# directly. Note: CLI syntax parsing (--subdir arg presence) still runs
# above — a malformed --subdir is a CLI error regardless of env vars.
if [ -n "${LEAD_WORKSPACE:-}" ]; then
  echo "[lead] Using LEAD_WORKSPACE override: ${LEAD_WORKSPACE}"
elif [ -n "$LEAD_SUBDIR" ]; then
  # Validate: no path traversal (reject ..)
  if [[ "$LEAD_SUBDIR" == *..* ]]; then
    echo "[lead] ERROR: --subdir must not contain '..': ${LEAD_SUBDIR}"
    exit 1
  fi
  CANDIDATE="${PROJECT_DIR}/${LEAD_SUBDIR}"
  # Resolve to physical absolute path (pwd -P follows symlinks) to prevent
  # symlink-based escapes from PROJECT_DIR.
  RESOLVED="$(cd "$CANDIDATE" 2>/dev/null && pwd -P)" || true
  if [ -z "$RESOLVED" ]; then
    echo "[lead] ERROR: --subdir directory does not exist: ${CANDIDATE}"
    echo "[lead] Create it first, or omit --subdir to use project root."
    exit 1
  fi
  case "$RESOLVED" in
    "${PROJECT_DIR}"/*) ;; # OK — inside project
    "${PROJECT_DIR}") ;; # OK — is project root (e.g. --subdir .)
    *)
      echo "[lead] ERROR: --subdir resolved to '${RESOLVED}' which is outside project '${PROJECT_DIR}'"
      exit 1
      ;;
  esac
  LEAD_WORKSPACE="${RESOLVED}"
else
  LEAD_WORKSPACE="${PROJECT_DIR}"
fi
echo "[lead] Working directory: ${LEAD_WORKSPACE}"

# ── Agent file auto-sync (project source → global target) ──
# GEO-246: Agent files live in the project repo, not Flywheel infrastructure.
# GEO-286: Agent source always from PROJECT_DIR/.lead/ (not workspace).
# Priority: 1) AGENT_SOURCE env var, 2) PROJECT_DIR/.lead/<lead-id>/agent.md, 3) fail-fast.
if [ -n "${AGENT_SOURCE:-}" ]; then
  : # explicit override, use as-is
elif [ -f "${PROJECT_DIR}/.lead/${LEAD_ID}/agent.md" ]; then
  AGENT_SOURCE="${PROJECT_DIR}/.lead/${LEAD_ID}/agent.md"
fi
AGENT_TARGET="${HOME}/.claude/agents/${LEAD_ID}.md"
mkdir -p "${HOME}/.claude/agents"

if [ -f "${AGENT_SOURCE:-}" ]; then
  # Copy (not symlink) to prevent Lead from writing back to repo via symlink.
  # Lead has Bash + bypassPermissions, so a symlink would let it mutate the
  # version-controlled agent source file.
  # Remove first: if target is an existing symlink (from older versions),
  # cp would follow it and overwrite the symlink target in-place.
  rm -f "$AGENT_TARGET"
  cp "$AGENT_SOURCE" "$AGENT_TARGET"
  echo "[lead] Agent file installed: ${AGENT_TARGET} (copied from ${AGENT_SOURCE})"
else
  echo "[lead] ERROR: Agent source not found."
  if [ -n "${AGENT_SOURCE:-}" ]; then
    echo "[lead] AGENT_SOURCE was set to '${AGENT_SOURCE}' but file does not exist."
    echo "[lead] Unset AGENT_SOURCE to use automatic resolution, or fix the path."
  else
    echo "[lead] Expected: ${PROJECT_DIR}/.lead/${LEAD_ID}/agent.md"
  fi
  exit 1
fi

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

# ── Discord plugin fork integrity check ─────────────────────
# GEO-296: Ensure Discord plugin is our fork version (with allowBots support).
# Claude Code may overwrite the cache during plugin updates; this preflight
# re-applies our fork if the cache was reverted to the official version.
# Uses absolute paths — do NOT rely on PATH including ~/.flywheel/bin.
FLYWHEEL_BIN="${HOME}/.flywheel/bin"
CHECK_SCRIPT="${FLYWHEEL_BIN}/check-discord-plugin.sh"
UPDATE_SCRIPT="${FLYWHEEL_BIN}/update-discord-plugin.sh"

if [ ! -x "$CHECK_SCRIPT" ] || [ ! -x "$UPDATE_SCRIPT" ]; then
  echo "[lead] ERROR: Discord plugin fork scripts not found or not executable:"
  echo "[lead]   check:  $CHECK_SCRIPT"
  echo "[lead]   update: $UPDATE_SCRIPT"
  echo "[lead] Run GEO-296 setup first. Aborting."
  exit 1
fi

if ! "$CHECK_SCRIPT"; then
  echo "[lead] Discord plugin cache is not fork version, updating..."
  "$UPDATE_SCRIPT"
  # Re-check after update — hard fail if still not matching
  if ! "$CHECK_SCRIPT"; then
    echo "[lead] ERROR: Discord plugin still not fork version after update. Aborting."
    exit 1
  fi
fi
echo "[lead] Discord plugin fork check: OK"

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

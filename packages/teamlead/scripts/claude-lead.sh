#!/bin/bash
# GEO-195: Manual supervisor script for Claude Lead session.
# GEO-234: Agent file + flywheel-comm integration.
# GEO-246: Parameterized for multi-lead — supports any agent name.
# GEO-285: Crash recovery loop + auto session ID + graceful shutdown
#          + PostCompact hook for bootstrap re-send after auto-compact.
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
# The supervisor automatically restarts Claude on crash with exponential
# backoff. Use Ctrl+C or SIGTERM for graceful shutdown.
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

# ════════════════════════════════════════════════════════════════
# Layer 1: One-time Preflight
# ════════════════════════════════════════════════════════════════

# ── Utility functions ───────────────────────────────────────────
log() {
  echo "[lead] $(date '+%H:%M:%S') $*"
}

# Interruptible sleep: runs sleep in the background so SIGINT/SIGTERM
# can set SHOULD_EXIT during the wait. Falls through immediately if
# the shell receives a signal while waiting. Tracks sleep PID to avoid
# orphaned sleep processes on signal delivery.
interruptible_sleep() {
  local _sleep_pid
  sleep "$1" &
  _sleep_pid=$!
  wait $_sleep_pid 2>/dev/null || true
  # If we were interrupted by a signal, kill the sleep child
  kill $_sleep_pid 2>/dev/null || true
}


# ── Parse arguments and export for agent prompt ──────────────
export LEAD_ID="${1:?Usage: claude-lead.sh <lead-id> <project-dir> [project-name] [--subdir <dir>]}"
# GEO-246: Validate LEAD_ID format to prevent path traversal.
# Only lowercase alphanumeric and hyphens allowed (e.g., "product-lead", "ops-lead").
if [[ ! "$LEAD_ID" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  log "ERROR: Invalid lead-id '${LEAD_ID}'. Must match [a-z0-9][a-z0-9-]*"
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
log "Discord state: ${DISCORD_STATE_DIR}"
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
  log "Comm CLI: ${FLYWHEEL_COMM_CLI}"
else
  log "WARNING: flywheel-comm not built. Runner communication disabled."
  log "Lead will still handle Discord events and Annie commands."
  log "Run 'pnpm -r build' to enable Runner communication."
fi
mkdir -p "$(dirname "$FLYWHEEL_COMM_DB")"
log "Comm DB: ${FLYWHEEL_COMM_DB}"

# ── Workspace isolation ──────────────────────────────────────
# GEO-285: LEAD_WORKSPACE default must be set BEFORE agent source resolution,
# because the agent file lookup checks LEAD_WORKSPACE/agent.md (set -u safe).
# Lead runs in an isolated workspace, NOT in the product repo.
# This reduces risk of accidental code modification via Bash.
LEAD_WORKSPACE="${LEAD_WORKSPACE:-${HOME}/.flywheel/lead-workspace/${LEAD_ID}}"
export LEAD_WORKSPACE
mkdir -p "$LEAD_WORKSPACE"
log "Working directory: ${LEAD_WORKSPACE} (isolated from product repo)"

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
  log "Agent file installed: ${AGENT_TARGET} (copied from ${AGENT_SOURCE})"
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

# GEO-285: Bootstrap moved to recovery loop (send_bootstrap function).
# Only sent on fresh start, not on resume.
# ── Discord plugin fork integrity check ─────────────────────
# GEO-296: Ensure Discord plugin is our fork version (with allowBots support).
# Claude Code may overwrite the cache during plugin updates; this preflight
# re-applies our fork if the cache was reverted to the official version.
# Uses absolute paths — do NOT rely on PATH including ~/.flywheel/bin.
FLYWHEEL_BIN="${HOME}/.flywheel/bin"
CHECK_SCRIPT="${FLYWHEEL_BIN}/check-discord-plugin.sh"
UPDATE_SCRIPT="${FLYWHEEL_BIN}/update-discord-plugin.sh"

if [ ! -x "$CHECK_SCRIPT" ] || [ ! -x "$UPDATE_SCRIPT" ]; then
  log "ERROR: Discord plugin fork scripts not found or not executable:"
  log "  check:  $CHECK_SCRIPT"
  log "  update: $UPDATE_SCRIPT"
  log "Run GEO-296 setup first. Aborting."
  exit 1
fi

if ! "$CHECK_SCRIPT"; then
  log "Discord plugin cache is not fork version, updating..."
  "$UPDATE_SCRIPT"
  # Re-check after update — hard fail if still not matching
  if ! "$CHECK_SCRIPT"; then
    log "ERROR: Discord plugin still not fork version after update. Aborting."
    exit 1
  fi
fi
log "Discord plugin fork check: OK"

# ── GEO-285: Install PostCompact hook ─────────────────────
# Requires jq for idempotent JSON merge. Skip gracefully if not installed.
if ! command -v jq >/dev/null 2>&1; then
  log "WARNING: jq not found. Skipping PostCompact hook install."
  log "Install jq to enable automatic bootstrap after auto-compact."
fi
install_post_compact_hook() {
  local src_script
  src_script="$(cd "$SCRIPT_DIR" && pwd)/post-compact-bootstrap.sh"
  if [ ! -f "$src_script" ]; then
    log "WARNING: PostCompact hook source not found: $src_script"
    return
  fi

  # Install to stable path (~/.flywheel/bin/) to avoid duplicate entries
  # when the repo is cloned to different directories or worktrees.
  local hook_script="${HOME}/.flywheel/bin/post-compact-bootstrap.sh"
  mkdir -p "$(dirname "$hook_script")"
  cp "$src_script" "$hook_script"
  chmod +x "$hook_script"

  # Clean up any old entries pointing to different paths (repo-local copies)
  # before adding the stable path entry.
  local settings_file="${HOME}/.claude/settings.json"
  mkdir -p "$(dirname "$settings_file")"

  local existing
  if [ -f "$settings_file" ]; then
    if ! jq empty "$settings_file" 2>/dev/null; then
      log "WARNING: $settings_file is not valid JSON. Skipping hook install."
      return
    fi
    existing=$(cat "$settings_file")
  else
    existing="{}"
  fi

  local tmpfile
  tmpfile=$(mktemp "${settings_file}.XXXXXX")

  if ! echo "$existing" | jq --arg cmd "$hook_script" '
    # Reset PostCompact to array if it exists but is not an array (defensive)
    .hooks.PostCompact = (if .hooks.PostCompact | type == "array" then .hooks.PostCompact else [] end) |
    # Remove any old entries whose hooks contain a post-compact-bootstrap.sh command
    # Uses any() to produce a single boolean (avoids select+generator ambiguity)
    .hooks.PostCompact = [.hooks.PostCompact[] | select(any(.hooks[]?.command // ""; endswith("post-compact-bootstrap.sh")) | not)] |
    # Add the stable-path entry if not already present
    if (.hooks.PostCompact | map(select(any(.hooks[]?.command // ""; . == $cmd))) | length) == 0
    then .hooks.PostCompact += [{"hooks": [{"type": "command", "command": $cmd}]}]
    else .
    end
  ' > "$tmpfile" 2>/dev/null; then
    log "WARNING: Failed to merge PostCompact hook into settings. Skipping."
    rm -f "$tmpfile"
    return
  fi

  if ! jq empty "$tmpfile" 2>/dev/null; then
    log "WARNING: Generated settings JSON is invalid. Skipping hook install."
    rm -f "$tmpfile"
    return
  fi

  mv "$tmpfile" "$settings_file"
  log "PostCompact hook installed: $hook_script"
}
if command -v jq >/dev/null 2>&1; then
  install_post_compact_hook
fi

# ── GEO-285: Early auto-compact + env exports ─────────────
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE="${CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:-70}"
export FLYWHEEL_LEAD_ID="$LEAD_ID"
log "Auto-compact threshold: ${CLAUDE_AUTOCOMPACT_PCT_OVERRIDE}%"

# ── Bootstrap function ──────────────────────────────────────
# GEO-285: Extracted from inline code. Called only on fresh start,
# NOT on resume (resumed sessions already have context).
send_bootstrap() {
  log "Sending bootstrap for ${LEAD_ID}..."
  local token="${TEAMLEAD_API_TOKEN:-}"
  # GEO-203: Increased timeout from 10→15s to account for dual-bucket memory recall
  local args=(-s -X POST "${BRIDGE_URL}/api/bootstrap/${LEAD_ID}" -H "Content-Type: application/json" --max-time 15 -w '\n%{http_code}')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer ${token}")

  local response
  response=$(curl "${args[@]}" 2>/dev/null) || {
    log "WARNING: Bootstrap request failed (curl error, non-fatal)"
    interruptible_sleep 3
    return
  }

  local http_code
  http_code=$(echo "$response" | tail -1)
  if [ "$http_code" -ge 400 ] 2>/dev/null; then
    log "WARNING: Bootstrap returned HTTP ${http_code} (non-fatal)"
  fi
  # Wait for bootstrap message to arrive in Discord
  interruptible_sleep 3
}

# ── Graceful shutdown ───────────────────────────────────────
# GEO-285: PID tracking + signal forwarding.
# SIGINT (Ctrl+C) in a terminal is delivered to the foreground process group,
# so Claude receives it directly. But SIGTERM (e.g., kill <supervisor-pid>)
# only hits the shell — we must forward it to the Claude child process.
SHOULD_EXIT=0
CLAUDE_PID=0

cleanup() {
  SHOULD_EXIT=1
  log "Shutdown signal received..."
  if [ "$CLAUDE_PID" -ne 0 ] && kill -0 "$CLAUDE_PID" 2>/dev/null; then
    log "Forwarding SIGTERM to Claude (PID $CLAUDE_PID)..."
    kill -TERM "$CLAUDE_PID" 2>/dev/null || true
    wait "$CLAUDE_PID" 2>/dev/null || true
  fi
  # Kill any background jobs not yet captured in CLAUDE_PID (race window)
  local bg_pids
  bg_pids=$(jobs -pr 2>/dev/null) || true
  if [ -n "$bg_pids" ]; then
    log "Cleaning up uncaptured background processes: $bg_pids"
    kill -TERM $bg_pids 2>/dev/null || true
    wait $bg_pids 2>/dev/null || true
  fi
  # Exit from trap to prevent main flow from continuing after signal
  exit 0
}
trap cleanup SIGINT SIGTERM

# ── Claude args ─────────────────────────────────────────────
cd "$LEAD_WORKSPACE"

# Build claude args using bash array (avoids quoting/word-splitting issues)
CLAUDE_ARGS=(--agent "$LEAD_ID" --channels "plugin:discord@claude-plugins-official" --permission-mode bypassPermissions)

# ════════════════════════════════════════════════════════════════
# Layer 2: Recovery Loop
# ════════════════════════════════════════════════════════════════

# GEO-285: Crash recovery with exponential backoff.
# - Fresh start: generate UUID → bootstrap → save → claude --session-id
# - Resume: read session ID → claude --resume (no bootstrap)
# - Crash recovery: backoff → restart
# - Resume failure: retry-before-delete (3 consecutive quick exits → delete session file)
# - Graceful shutdown: SIGINT/SIGTERM → forward to Claude child → wait → exit loop

CRASH_COUNT=0
BACKOFF_SECONDS=(5 15 30 60 60 60)
RESTART_COUNT=0
RESUME_FAIL_COUNT=0
RESUME_FAIL_THRESHOLD=3

log "Supervisor starting (recovery loop enabled)"
log "Session ID file: ${SESSION_ID_FILE}"

while true; do
  # ── Check shutdown flag ───────────────────────────────────
  if [ "$SHOULD_EXIT" -ne 0 ]; then
    log "Shutdown flag set — exiting supervisor."
    break
  fi

  CLAUDE_EXIT=0
  PROCESS_START_TS=$(date +%s)  # Per-process time (for crash classification)
  RESTART_COUNT=$((RESTART_COUNT + 1))
  IS_RESUME=0

  if [ -f "$SESSION_ID_FILE" ]; then
    # ── Resume existing session ───────────────────────────
    IS_RESUME=1
    SESSION_ID=$(cat "$SESSION_ID_FILE")
    log "[restart #${RESTART_COUNT}] Resuming session ${SESSION_ID}..."
    log "(To force fresh start: rm ${SESSION_ID_FILE})"

    # Final SIGTERM gate — must be right before fork to close the race window
    if [ "$SHOULD_EXIT" -ne 0 ]; then break; fi
    claude "${CLAUDE_ARGS[@]}" --resume "$SESSION_ID" &
    CLAUDE_PID=$!
  else
    # ── Fresh start ───────────────────────────────────────
    SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    log "[restart #${RESTART_COUNT}] Fresh start with session ${SESSION_ID}"

    # Bootstrap only on fresh start — resumed sessions already have context
    send_bootstrap

    # Check shutdown flag after bootstrap (sleep may have been interrupted)
    if [ "$SHOULD_EXIT" -ne 0 ]; then
      log "Shutdown during bootstrap — exiting supervisor."
      break
    fi

    # Final SIGTERM gate — right before fork. cleanup() now exits the trap,
    # so signals after this point terminate the script immediately.
    if [ "$SHOULD_EXIT" -ne 0 ]; then break; fi
    # Fork first, write session file after — avoids orphan session ID if
    # SIGTERM arrives between gate and fork (cleanup's exit+jobs-pr handles it).
    claude "${CLAUDE_ARGS[@]}" --session-id "$SESSION_ID" &
    CLAUDE_PID=$!
    # Write session file only after successful fork — no orphan on SIGTERM
    echo "$SESSION_ID" > "$SESSION_ID_FILE"
  fi

  wait "$CLAUDE_PID" 2>/dev/null || CLAUDE_EXIT=$?
  CLAUDE_PID=0

  # DURATION = this process's runtime (for crash classification / backoff)
  DURATION=$(( $(date +%s) - PROCESS_START_TS ))

  # ── Check shutdown flag (may have been set during Claude's run) ──
  if [ "$SHOULD_EXIT" -ne 0 ]; then
    log "Shutdown signal received — exiting supervisor. (Claude exit code: ${CLAUDE_EXIT})"
    break
  fi

  # ── Classify exit reason ──────────────────────────────────
  if [ "$CLAUDE_EXIT" -eq 0 ]; then
    # Normal exit (Claude exited cleanly, but without shutdown signal).
    # This can happen if Claude's session ends normally.
    log "Claude exited normally (code 0) after ${DURATION}s. Restarting..."
    CRASH_COUNT=0
    # Brief cooldown to prevent hot-loop if Claude keeps exiting immediately
    sleep 2
    continue
  fi

  # Non-zero exit = crash or resume failure
  CRASH_COUNT=$((CRASH_COUNT + 1))
  log "Claude crashed (exit code ${CLAUDE_EXIT}) after ${DURATION}s. Crash count: ${CRASH_COUNT}"

  # Resume failure heuristic: retry-before-delete.
  # Only applies to resume path (IS_RESUME=1). Quick exit (<10s) on resume
  # MAY indicate session corruption, but could also be a transient fault.
  # Delete session file only after RESUME_FAIL_THRESHOLD consecutive failures.
  if [ "$IS_RESUME" -eq 1 ] && [ "$DURATION" -lt 10 ]; then
    RESUME_FAIL_COUNT=$((RESUME_FAIL_COUNT + 1))
    log "Quick exit on resume (${DURATION}s) — possible failure (${RESUME_FAIL_COUNT}/${RESUME_FAIL_THRESHOLD})."
    if [ "$RESUME_FAIL_COUNT" -ge "$RESUME_FAIL_THRESHOLD" ]; then
      log "Consecutive resume failures reached threshold. Deleting session file for fresh start."
      rm -f "$SESSION_ID_FILE"
      RESUME_FAIL_COUNT=0
    fi
  else
    # Successful run (>10s) or fresh start — reset resume failure count
    RESUME_FAIL_COUNT=0
  fi

  # Reset crash count if Claude ran for a meaningful duration (>60s).
  # This prevents crash count from accumulating across unrelated failures.
  if [ "$DURATION" -gt 60 ]; then
    CRASH_COUNT=1
  fi

  # Exponential backoff
  BACKOFF_IDX=$((CRASH_COUNT - 1))
  if [ "$BACKOFF_IDX" -ge ${#BACKOFF_SECONDS[@]} ]; then
    BACKOFF_IDX=$(( ${#BACKOFF_SECONDS[@]} - 1 ))
  fi
  BACKOFF=${BACKOFF_SECONDS[$BACKOFF_IDX]}

  if [ "$CRASH_COUNT" -ge 5 ]; then
    log "WARNING: ${CRASH_COUNT} consecutive crashes. Check Claude CLI health."
  fi

  log "Waiting ${BACKOFF}s before restart..."
  interruptible_sleep "$BACKOFF"
done

log "Supervisor stopped. Total restarts: ${RESTART_COUNT}"

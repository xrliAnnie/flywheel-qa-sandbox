#!/bin/bash
# GEO-195: Manual supervisor script for Claude Lead session.
# GEO-234: Agent file + flywheel-comm integration.
# GEO-246: Parameterized for multi-lead — supports any agent name.
# GEO-285: Crash recovery loop + auto session ID + graceful shutdown
# FLY-20 E2E verification timestamp: 2026-04-01
#          + PostCompact hook for bootstrap re-send after auto-compact.
# GEO-286: Per-Lead workspace subdirectory. Claude Code walks up to load
#   project CLAUDE.md, so subdirectory still gets full project context.
#
# Usage: ./scripts/claude-lead.sh <lead-id> <project-dir> [project-name] [--subdir <dir>] [--bot-token-env <ENV_NAME>]
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
# --bot-token-env <ENV_NAME>: name of the environment variable holding this
#   Lead's Discord bot token (e.g. PETER_BOT_TOKEN). Recorded in the manifest
#   so auto-restart can reconstruct the startup command. Defaults to
#   DISCORD_BOT_TOKEN if omitted.
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

# ── TTY guard ──────────────────────────────────────────────────
# FLY-88: TTY is now provided by tmux (Claude runs inside a tmux window).
# The old `script -q /dev/null` PTY hack is no longer needed.
# Keep this as documentation: tmux new-window automatically allocates a PTY.

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

# FLY-80: Fallback if projectDir is stale (worktree was deleted)
if [[ ! -d "$PROJECT_DIR_RAW" ]]; then
  log "projectDir '$PROJECT_DIR_RAW' not found, attempting recovery..."
  _parent="$(dirname "$PROJECT_DIR_RAW")"
  _stale_base="$(basename "$PROJECT_DIR_RAW")"
  _recovered=false
  _best_cand=""
  _best_len=0
  if [[ -d "$_parent" ]]; then
    for _cand in "$_parent"/*; do
      _cand_base="$(basename "$_cand")"
      # Only consider candidates that match worktree naming convention:
      # stale path (e.g. "flywheel-fly-80") must start with candidate name + "-"
      # This prevents picking an unrelated repo in the same parent dir.
      if [[ ! -d "$_cand/.git" ]]; then continue; fi
      if [[ "$_stale_base" != "${_cand_base}-"* && "$_stale_base" != "$_cand_base" ]]; then continue; fi
      # Prefer longest matching basename (most specific: "foo-app" > "foo")
      if (( ${#_cand_base} > _best_len )); then
        _best_len=${#_cand_base}
        _best_cand="$_cand"
      fi
    done
    if [[ -n "$_best_cand" ]]; then
      _common=$(git -C "$_best_cand" rev-parse --git-common-dir 2>/dev/null) || true
      if [[ "$_common" == ".git" ]]; then
        PROJECT_DIR_RAW="$_best_cand"
      elif [[ -n "$_common" ]]; then
        PROJECT_DIR_RAW="$(dirname "$_common")"
      fi
      if [[ -d "$PROJECT_DIR_RAW" ]]; then
        log "Recovered to main repo: $PROJECT_DIR_RAW"
        _recovered=true
      fi
    fi
  fi
  if [[ "$_recovered" != "true" ]]; then
    log "ERROR: Cannot recover projectDir — no valid parent directory found"
    exit 1
  fi
fi

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
BOT_TOKEN_ENV_NAME=""

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
    --bot-token-env)
      if [ $# -lt 2 ] || [ -z "${2:-}" ] || [[ "${2:-}" == --* ]]; then
        echo "[lead] ERROR: --bot-token-env requires an environment variable name."
        exit 1
      fi
      BOT_TOKEN_ENV_NAME="$2"
      shift 2
      ;;
    --*)
      echo "[lead] ERROR: Unknown flag '$1'. Did you mean --subdir or --bot-token-env?"
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

# ── FLY-20: Write manifest for auto-restart ──────────────────
# Records startup parameters so restart-services.sh can faithfully
# reconstruct the launch command after a deploy.
MANIFEST_DIR="${HOME}/.flywheel/manifests"
MANIFEST_FILE="${MANIFEST_DIR}/${PROJECT_NAME}-${LEAD_ID}.json"
mkdir -p "$MANIFEST_DIR"
if command -v jq >/dev/null 2>&1; then
  jq -n \
    --arg leadId "$LEAD_ID" \
    --arg projectDir "$PROJECT_DIR" \
    --arg projectName "$PROJECT_NAME" \
    --arg subdir "${LEAD_SUBDIR:-}" \
    --arg workspace "$LEAD_WORKSPACE" \
    --arg botTokenEnv "${BOT_TOKEN_ENV_NAME:-DISCORD_BOT_TOKEN}" \
    --arg pid "$$" \
    '{leadId: $leadId, projectDir: $projectDir, projectName: $projectName, subdir: $subdir, workspace: $workspace, botTokenEnv: $botTokenEnv, pid: ($pid | tonumber)}' \
    > "$MANIFEST_FILE"
  log "Manifest written: ${MANIFEST_FILE}"
else
  log "WARNING: jq not found. Manifest not written — auto-restart will skip this Lead."
fi

# ── Agent file auto-sync (project source → global target) ──
# GEO-246: Agent files live in the project repo, not Flywheel infrastructure.
# GEO-286: Agent source always from PROJECT_DIR/.lead/ (not workspace).
# FLY-26: identity.md preferred over agent.md (agent.md kept as backward-compatible fallback).
# Priority: 1) AGENT_SOURCE env var, 2) identity.md, 3) agent.md, 4) fail-fast.
if [ -n "${AGENT_SOURCE:-}" ]; then
  : # explicit override, use as-is
elif [ -f "${PROJECT_DIR}/.lead/${LEAD_ID}/identity.md" ]; then
  AGENT_SOURCE="${PROJECT_DIR}/.lead/${LEAD_ID}/identity.md"
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
    echo "[lead] Expected: ${PROJECT_DIR}/.lead/${LEAD_ID}/identity.md (or agent.md as fallback)"
  fi
  exit 1
fi

# ── FLY-26: Shared rule file sync (atomic replacement) ─────────
# Copy shared rule files from project repo to a local staging directory.
# Uses atomic replacement to prevent loading stale files if source changes.
SHARED_RULES_DIR="${PROJECT_DIR}/.lead/shared"
LEAD_RULES_DIR="${HOME}/.flywheel/lead-rules/${LEAD_ID}"

if [ -d "$SHARED_RULES_DIR" ]; then
  # Ensure parent directory exists
  mkdir -p "$(dirname "$LEAD_RULES_DIR")"

  # Stage to temp directory, then atomic swap
  LEAD_RULES_TMP=$(mktemp -d "${LEAD_RULES_DIR}.XXXXXX")

  SHARED_RULES_COUNT=0
  for rule_file in "$SHARED_RULES_DIR"/*.md; do
    [ -f "$rule_file" ] || continue
    rule_name=$(basename "$rule_file")
    cp "$rule_file" "${LEAD_RULES_TMP}/${rule_name}" || {
      echo "[lead] ERROR: Failed to copy shared rule: ${rule_file}"
      rm -rf "$LEAD_RULES_TMP"
      exit 1
    }
    SHARED_RULES_COUNT=$((SHARED_RULES_COUNT + 1))
    log "Shared rule staged: ${rule_name}"
  done

  if [ "$SHARED_RULES_COUNT" -gt 0 ]; then
    # Atomic replace: remove old, move new into place
    rm -rf "$LEAD_RULES_DIR"
    mv "$LEAD_RULES_TMP" "$LEAD_RULES_DIR"
    log "Shared rules installed: ${LEAD_RULES_DIR} (${SHARED_RULES_COUNT} files)"
  else
    rm -rf "$LEAD_RULES_TMP"
    # Empty shared dir: also clean stale cache to prevent loading outdated rules
    if [ -d "$LEAD_RULES_DIR" ]; then
      rm -rf "$LEAD_RULES_DIR"
      log "Cleaned stale shared rules cache (empty source): ${LEAD_RULES_DIR}"
    fi
    log "No shared rule files found in ${SHARED_RULES_DIR}"
  fi
else
  # No shared rules source — clean up any stale local cache to prevent
  # loading outdated rules after rollback/branch switch.
  if [ -d "$LEAD_RULES_DIR" ]; then
    rm -rf "$LEAD_RULES_DIR"
    log "Cleaned stale shared rules cache: ${LEAD_RULES_DIR}"
  fi
  log "No shared rules directory at ${SHARED_RULES_DIR} (skipping)"
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
# FLY-88: Signal handling adapted for tmux-based Claude.
# SIGTERM from launchd → cleanup() sends C-c to tmux window → kill-window.
SHOULD_EXIT=0

# FLY-88: tmux-based launch.
# Claude runs inside a tmux window in the shared "flywheel" session.
# FLY-80 restored: expect auto-confirms --dangerously-load-development-channels prompt.
# tmux provides the window; expect provides PTY + prompt detection inside the window.
LEAD_WINDOW_ID=""

# FLY-80 / FLY-109: expect script for auto-confirming dev channels dialog.
# Claude Code shows a TUI confirmation for --dangerously-load-development-channels.
# In daemon mode (launchd), no human can press Enter. expect watches for the prompt
# text and sends Enter automatically, then waits for Claude to exit.
#
# FLY-109 rework: the script is now a standalone file under scripts/, versioned with
# the rest of the repo and unit-tested. The two-stage state machine only sends "1\r"
# after seeing a DevChannelsDialog marker — blind-sending on timeout (the old
# behavior) could inject "1" into regular Claude prompts, so we explicitly DO NOT
# do that. All state transitions are appended to $FLYWHEEL_EXPECT_LOG for post-hoc
# diagnosis of startup problems.
_EXPECT_SCRIPT="${SCRIPT_DIR}/expect-dev-channels.exp"
if [ ! -x "$_EXPECT_SCRIPT" ]; then
  chmod +x "$_EXPECT_SCRIPT" 2>/dev/null || true
fi

# Ensure startup log directory exists and export env consumed by the .exp script.
mkdir -p "${HOME}/.flywheel/logs" 2>/dev/null || true
export FLYWHEEL_EXPECT_DIALOG_TIMEOUT_SEC="${FLYWHEEL_EXPECT_DIALOG_TIMEOUT_SEC:-90}"
export FLYWHEEL_EXPECT_LOG="${FLYWHEEL_EXPECT_LOG:-${HOME}/.flywheel/logs/lead-${LEAD_ID}-startup.log}"

# Ensure the shared flywheel tmux session exists (race-safe, idempotent).
# Called before every launch — handles session being killed externally.
ensure_tmux_session() {
  # -A: attach-or-create (atomic). -d: stay detached. -x/-y: default size.
  tmux new-session -Ad -s flywheel -x 200 -y 50 2>/dev/null || true
}

# Launch Claude in a tmux window within the flywheel session.
# Uses -P -F to capture window_id (like TmuxAdapter).
# Uses -e to inject per-window environment (no shell inheritance in shared session).
_launch_claude() {
  ensure_tmux_session

  local window_name="${PROJECT_NAME}-${LEAD_ID}"

  # Kill stale window with same name (from previous crash)
  tmux kill-window -t "=flywheel:=${window_name}" 2>/dev/null || true

  # Build env injection args (explicit per-window, match TmuxAdapter pattern)
  local env_args=(
    -e "DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN:-}"
    -e "DISCORD_STATE_DIR=${DISCORD_STATE_DIR:-}"
    -e "FLYWHEEL_LEAD_ID=${LEAD_ID}"
    -e "FLYWHEEL_COMM_DB=${FLYWHEEL_COMM_DB:-}"
    -e "FLYWHEEL_COMM_CLI=${FLYWHEEL_COMM_CLI:-}"
    -e "FLYWHEEL_PROJECT_NAME=${PROJECT_NAME}"
    -e "BRIDGE_URL=${BRIDGE_URL:-}"
    -e "TEAMLEAD_API_TOKEN=${TEAMLEAD_API_TOKEN:-}"
    -e "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:-70}"
    -e "OPENAI_API_KEY=${OPENAI_API_KEY:-}"
    -e "FLYWHEEL_EXPECT_DIALOG_TIMEOUT_SEC=${FLYWHEEL_EXPECT_DIALOG_TIMEOUT_SEC}"
    -e "FLYWHEEL_EXPECT_LOG=${FLYWHEEL_EXPECT_LOG}"
    -e "HOME=${HOME}"
    -e "PATH=${PATH}"
  )

  # Create new window running claude via expect (auto-confirms dev channels prompt).
  # Falls back to direct claude if expect is unavailable.
  local launch_cmd
  if command -v expect >/dev/null 2>&1; then
    launch_cmd="expect ${_EXPECT_SCRIPT} claude"
  else
    log "WARNING: expect not found, dev channels prompt may block"
    launch_cmd="claude"
  fi
  LEAD_WINDOW_ID=$(tmux new-window -d -P -F '#{window_id}' \
    -t =flywheel \
    "${env_args[@]}" \
    -n "$window_name" \
    -c "$LEAD_WORKSPACE" \
    ${launch_cmd} "$@")

  # Enable remain-on-exit on this specific window so we can read exit code
  # (must be set-window-option on the window, not session-level, for tmux 3.5+)
  tmux set-window-option -t "$LEAD_WINDOW_ID" remain-on-exit on 2>/dev/null || true

  log "Claude launched in tmux window: flywheel:${LEAD_WINDOW_ID} (name: ${window_name})"
}

# Wait for tmux window to exit (pane_dead detection).
# Uses window_id for reliable targeting. Uses interruptible_sleep.
_wait_tmux_window() {
  CLAUDE_EXIT=0
  local target="${LEAD_WINDOW_ID}"

  while true; do
    if [ "$SHOULD_EXIT" -ne 0 ]; then return 0; fi

    # Check if window still exists (session or window killed externally)
    if ! tmux list-panes -t "$target" &>/dev/null; then
      # Window gone — treat as crash (unknown exit code)
      CLAUDE_EXIT=1
      return 0
    fi

    # Check pane_dead flag (requires remain-on-exit)
    local dead
    dead=$(tmux list-panes -t "$target" -F '#{pane_dead}' 2>/dev/null | head -1)
    if [ "$dead" = "1" ]; then
      # Get exit code from dead pane
      CLAUDE_EXIT=$(tmux list-panes -t "$target" -F '#{pane_dead_status}' 2>/dev/null | head -1)
      CLAUDE_EXIT="${CLAUDE_EXIT:-1}"
      # Kill the dead window to prevent accumulation
      tmux kill-window -t "$target" 2>/dev/null || true
      return 0
    fi

    interruptible_sleep 3
  done
}

cleanup() {
  SHOULD_EXIT=1
  log "Shutdown signal received..."

  # FLY-109: expect-dev-channels.exp lives under scripts/ now — nothing to clean up.

  # Graceful shutdown: send C-c to Claude in tmux
  if [ -n "${LEAD_WINDOW_ID:-}" ]; then
    tmux send-keys -t "$LEAD_WINDOW_ID" C-c 2>/dev/null || true
    # Wait briefly for graceful exit (check pane_dead to avoid over-waiting)
    local i=0
    while [ $i -lt 5 ]; do
      if ! tmux list-panes -t "$LEAD_WINDOW_ID" &>/dev/null; then break; fi
      local dead
      dead=$(tmux list-panes -t "$LEAD_WINDOW_ID" -F '#{pane_dead}' 2>/dev/null | head -1)
      if [ "$dead" = "1" ]; then break; fi
      sleep 1
      i=$((i + 1))
    done
    # Force kill if still alive
    tmux kill-window -t "$LEAD_WINDOW_ID" 2>/dev/null || true
  fi

  # Kill any background jobs (race window)
  local bg_pids
  bg_pids=$(jobs -pr 2>/dev/null) || true
  if [ -n "$bg_pids" ]; then
    kill -TERM $bg_pids 2>/dev/null || true
    wait $bg_pids 2>/dev/null || true
  fi

  # FLY-20: Remove PID file on graceful exit
  rm -f "${PID_FILE:-}" 2>/dev/null || true
  # FLY-109: Release MCP pre-seed lock only if THIS process holds it
  if [ "${_MCP_LOCK_HELD:-false}" = "true" ]; then
    rmdir "${HOME}/.claude.json.flywheel-lock" 2>/dev/null || true
  fi
  # Exit from trap to prevent main flow from continuing after signal
  exit 0
}
trap cleanup SIGINT SIGTERM

# ── Claude args ─────────────────────────────────────────────
cd "$LEAD_WORKSPACE"

# ── FLY-11 / FLY-102: MCP server config (jq-generated) ──────
# Build .mcp.json via jq so any token / path that contains " / \ / newline
# is escaped safely. Hand-rolled string concatenation (pre-FLY-102) broke
# the file when TEAMLEAD_API_TOKEN contained JSON-special characters.
TERMINAL_MCP_DIR="${SCRIPT_DIR}/../../terminal-mcp/dist"
INBOX_MCP_DIR="${SCRIPT_DIR}/../../inbox-mcp/dist"

if ! command -v jq >/dev/null 2>&1; then
  log "ERROR: jq is required for MCP config generation (FLY-102). Aborting."
  exit 1
fi

# FLY-90: bun global bin may not be in PATH when launched via launchd/tmux.
export PATH="$HOME/.bun/bin:$PATH"
GBRAIN_PATH="$(command -v gbrain 2>/dev/null || true)"

terminal_server='{}'
if [ -d "$TERMINAL_MCP_DIR" ]; then
  TERMINAL_MCP_BIN="$(cd "$TERMINAL_MCP_DIR" && pwd)/index.js"
  # FLY-102: inject BRIDGE_URL + TEAMLEAD_API_TOKEN so close_runner tool
  # can reach the Bridge /api/sessions/:id/close-runner endpoint.
  terminal_server=$(jq -n \
    --arg bin "$TERMINAL_MCP_BIN" \
    --arg projectName "$PROJECT_NAME" \
    --arg leadId "$LEAD_ID" \
    --arg bridgeUrl "${BRIDGE_URL:-}" \
    --arg apiToken "${TEAMLEAD_API_TOKEN:-}" \
    '{
      "flywheel-terminal": {
        command: "node",
        args: [$bin],
        env: {
          FLYWHEEL_PROJECT_NAME: $projectName,
          FLYWHEEL_LEAD_ID: $leadId,
          BRIDGE_URL: $bridgeUrl,
          TEAMLEAD_API_TOKEN: $apiToken
        }
      }
    }')
  log "Terminal MCP: enabled (with BRIDGE_URL + TEAMLEAD_API_TOKEN)"
else
  log "WARNING: terminal-mcp not built (${TERMINAL_MCP_DIR} missing)"
fi

# FLY-47: Inbox MCP for CommDB → Lead channel push delivery
INBOX_MCP_ENABLED=false
inbox_server='{}'
if [ -d "$INBOX_MCP_DIR" ]; then
  INBOX_MCP_BIN="$(cd "$INBOX_MCP_DIR" && pwd)/index.js"
  COMM_DB_PATH="${HOME}/.flywheel/comm/${PROJECT_NAME}/comm.db"
  inbox_server=$(jq -n \
    --arg bin "$INBOX_MCP_BIN" \
    --arg db "$COMM_DB_PATH" \
    --arg leadId "$LEAD_ID" \
    --arg projectName "$PROJECT_NAME" \
    '{
      "flywheel-inbox": {
        command: "node",
        args: [$bin],
        env: {
          FLYWHEEL_COMM_DB: $db,
          FLYWHEEL_LEAD_ID: $leadId,
          FLYWHEEL_PROJECT_NAME: $projectName
        }
      }
    }')
  INBOX_MCP_ENABLED=true
  log "Inbox MCP: enabled (CommDB push delivery)"
else
  log "WARNING: inbox-mcp not built (${INBOX_MCP_DIR} missing), CommDB push disabled"
fi

# FLY-90: gbrain MCP for project Wiki.
gbrain_server='{}'
if [ -n "$GBRAIN_PATH" ] && [ -f "$HOME/.gbrain/config.json" ]; then
  gbrain_server=$(jq -n --arg bin "$GBRAIN_PATH" \
    '{"gbrain": {command: $bin, args: ["serve"]}}')
  log "GBrain MCP: enabled (project Wiki)"
elif [ -n "$GBRAIN_PATH" ]; then
  log "GBrain MCP: skipped (installed but not configured — run 'gbrain init --supabase')"
else
  log "GBrain MCP: skipped (gbrain not installed)"
fi

MCP_CONFIG_FILE="${LEAD_WORKSPACE}/.mcp.json"
jq -n \
  --argjson terminal "$terminal_server" \
  --argjson inbox "$inbox_server" \
  --argjson gbrain "$gbrain_server" \
  '{mcpServers: ($terminal + $inbox + $gbrain)}' \
  > "$MCP_CONFIG_FILE"
log "MCP config: ${MCP_CONFIG_FILE}"

# FLY-109 (b): Pre-seed enableAllProjectMcpServers so project .mcp.json servers
# are auto-approved on resume (no interactive dialog dependency). Written to
# ~/.claude.json under projects[LEAD_WORKSPACE]. Uses mkdir-based lock to
# prevent read-modify-write race when multiple Leads start concurrently
# (restart-services.sh launches Leads in parallel).
CLAUDE_JSON="${HOME}/.claude.json"
_MCP_LOCK_HELD=false
if command -v jq >/dev/null 2>&1; then
  # mkdir is atomic on POSIX — serves as a spinlock for concurrent writers.
  # Stale lock detection: if lock dir is >60s old, a previous process was
  # killed mid-write. Remove it and retry. Uses -mmin +1 (integer, macOS
  # find does not support fractional minutes).
  _lock_dir="${CLAUDE_JSON}.flywheel-lock"
  _lock_acquired=false
  for _i in $(seq 1 50); do
    if mkdir "$_lock_dir" 2>/dev/null; then
      _lock_acquired=true
      _MCP_LOCK_HELD=true
      break
    fi
    # Stale lock check: dir older than 1 minute is definitely orphaned
    if find "$_lock_dir" -maxdepth 0 -mmin +1 -print 2>/dev/null | grep -q .; then
      rmdir "$_lock_dir" 2>/dev/null || true
      log "MCP approval: removed stale lock dir"
    fi
    sleep 0.2
  done

  if [ "$_lock_acquired" = "true" ]; then
    # Create minimal ~/.claude.json if missing (fresh machine / state reset).
    # Inside the lock to prevent concurrent creates from racing.
    if [ ! -f "$CLAUDE_JSON" ]; then
      echo '{"projects":{}}' > "$CLAUDE_JSON"
      log "MCP approval: created ${CLAUDE_JSON}"
    fi

    _abs_workspace="$(cd "$LEAD_WORKSPACE" && pwd)"
    _tmp_claude_json="$(mktemp "${CLAUDE_JSON}.tmp.XXXXXX")"
    if jq --arg proj "$_abs_workspace" \
       '.projects[$proj].enableAllProjectMcpServers = true' \
       "$CLAUDE_JSON" > "$_tmp_claude_json" 2>/dev/null; then
      mv "$_tmp_claude_json" "$CLAUDE_JSON"
      log "MCP approval: enableAllProjectMcpServers=true for ${_abs_workspace}"
    else
      rm -f "$_tmp_claude_json" 2>/dev/null || true
      log "WARNING: Failed to pre-seed enableAllProjectMcpServers (jq error)"
    fi
    rmdir "$_lock_dir" 2>/dev/null || true
    _MCP_LOCK_HELD=false
  else
    log "WARNING: Could not acquire lock on ${CLAUDE_JSON} after 10s, skipping MCP pre-seed"
  fi
fi

# Build claude args using bash array (avoids quoting/word-splitting issues)
CLAUDE_ARGS=(
  --agent "$LEAD_ID"
  --permission-mode bypassPermissions
)

# FLY-47: Channel configuration
# Discord plugin: approved via GrowthBook allowlist → --channels
# Inbox MCP server: not on allowlist → --dangerously-load-development-channels (sets dev:true, bypasses gate)
# These are SEPARATE flags — --channels for allowlisted plugins, dev flag for local MCP servers.
CLAUDE_ARGS+=(--channels "plugin:discord@claude-plugins-official")
if [ "$INBOX_MCP_ENABLED" = "true" ]; then
  CLAUDE_ARGS+=(--dangerously-load-development-channels "server:flywheel-inbox")
  log "Channels: Discord plugin + inbox server (dev channel)"

  # FLY-109: Tell the Lead model how + when to call flywheel_inbox_ack. The file
  # ships in scripts/ so it's always present when this launcher runs; no external
  # sync required. Only loaded when inbox-mcp is enabled — the tool doesn't exist
  # otherwise.
  INBOX_ACK_RULE="${SCRIPT_DIR}/inbox-ack-rule.md"
  if [ -f "$INBOX_ACK_RULE" ] && [ -r "$INBOX_ACK_RULE" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$INBOX_ACK_RULE")
    log "Appending inbox ack rule: ${INBOX_ACK_RULE}"
  else
    log "WARNING: inbox ack rule missing at ${INBOX_ACK_RULE} — Lead may not ack channel messages"
  fi
else
  log "Channels: Discord plugin only"
fi

# FLY-80: MCP servers are now in $LEAD_WORKSPACE/.mcp.json (auto-discovered by Claude from CWD).
# No --mcp-config flag needed — this also ensures server:flywheel-inbox resolves for channels.

# ── FLY-26: Append shared rule files to system prompt ──────────
# common-rules.md: loaded by ALL leads (communication style, memory, MCP, shared limits)
# department-lead-rules.md: loaded by department leads only (Peter/Oliver), NOT cos-lead (Simba)
# Fail-fast: if LEAD_RULES_DIR exists (meaning shared rules were synced), required files MUST be present.
if [ -d "$LEAD_RULES_DIR" ]; then
  COMMON_RULES="${LEAD_RULES_DIR}/common-rules.md"
  if [ ! -f "$COMMON_RULES" ] || [ ! -r "$COMMON_RULES" ]; then
    echo "[lead] ERROR: Required shared rule file missing or unreadable: ${COMMON_RULES}"
    echo "[lead] Source should be: ${SHARED_RULES_DIR}/common-rules.md"
    exit 1
  fi
  CLAUDE_ARGS+=(--append-system-prompt-file "$COMMON_RULES")
  log "Appending common rules: ${COMMON_RULES}"

  # Department lead rules — only for non-cos roles (Peter/Oliver manage Runners, Simba does not).
  # Role detection: production uses LEAD_ID=="cos-lead"; FLY-96 test slots use synthetic LEAD_ID
  # (flywheel-test-N) and set FLYWHEEL_LEAD_ROLE=cos|lead to drive the same gate.
  IS_COS_ROLE=false
  if [ "${FLYWHEEL_LEAD_ROLE:-}" = "cos" ] || [ "$LEAD_ID" = "cos-lead" ]; then
    IS_COS_ROLE=true
  fi
  if [ "$IS_COS_ROLE" = false ]; then
    DEPT_RULES="${LEAD_RULES_DIR}/department-lead-rules.md"
    if [ ! -f "$DEPT_RULES" ] || [ ! -r "$DEPT_RULES" ]; then
      echo "[lead] ERROR: Required department rule file missing or unreadable: ${DEPT_RULES}"
      echo "[lead] Source should be: ${SHARED_RULES_DIR}/department-lead-rules.md"
      exit 1
    fi
    CLAUDE_ARGS+=(--append-system-prompt-file "$DEPT_RULES")
    log "Appending department lead rules: ${DEPT_RULES}"
  fi
fi

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

# FLY-20: Write PID file for auto-restart process management
PID_DIR="${HOME}/.flywheel/pids"
PID_FILE="${PID_DIR}/${PROJECT_NAME}-${LEAD_ID}.pid"
mkdir -p "$PID_DIR"
echo $$ > "$PID_FILE"
log "PID file written: ${PID_FILE} (PID $$)"

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
    _launch_claude "${CLAUDE_ARGS[@]}" --resume "$SESSION_ID"
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
    # Launch in tmux window, write session file after — avoids orphan session ID if
    # SIGTERM arrives between gate and launch.
    _launch_claude "${CLAUDE_ARGS[@]}" --session-id "$SESSION_ID"
    # Write session file only after successful launch — no orphan on SIGTERM
    echo "$SESSION_ID" > "$SESSION_ID_FILE"
  fi

  # FLY-88: Wait for tmux window to complete (replaces `wait $CLAUDE_PID`).
  # Auto-confirm is handled by expect inside the tmux window (FLY-80).
  _wait_tmux_window

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

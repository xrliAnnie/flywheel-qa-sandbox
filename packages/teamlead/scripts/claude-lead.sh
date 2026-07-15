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
#   DISCORD_BOT_TOKEN=$YOUR_COS_BOT_TOKEN \
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

# Normalize `FLYWHEEL_COMM_BACKEND` for comparisons. Mirrors the lenient
# parse used by Bridge `plugin.ts:resolveCommBackend`:
#   - Default to `mailbox` when unset / empty.
#   - Strip leading/trailing whitespace (operator-typed `.env` quirks).
#   - Lowercase so `Commdb`, `COMMDB`, etc. compare correctly.
# Echoes the normalized value to stdout for `$(...)` capture.
#
# codex:rescue Round 2 MEDIUM: pre-helper code used inline
# `printf | tr` without the trim step, so `FLYWHEEL_COMM_BACKEND=" commdb "`
# (with whitespace) routed as mailbox and silently broke rollback.
normalize_comm_backend() {
  local raw="${FLYWHEEL_COMM_BACKEND:-mailbox}"
  # Trim leading whitespace via bash 3.2-compatible parameter expansion.
  raw="${raw#"${raw%%[![:space:]]*}"}"
  # Trim trailing whitespace.
  raw="${raw%"${raw##*[![:space:]]}"}"
  printf '%s' "$raw" | tr '[:upper:]' '[:lower:]'
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
# FLY-162 Layer 2: configured issue prefixes for the Discord plugin's reply
# guard. The plugin uses these for its local fail-closed scan when the Bridge
# guard call is unavailable (only blocks issue-bearing top-level posts during
# Bridge outages; free-form chat still fails open). Bridge owns the
# authoritative classification; this is the offline fallback list.
export TEAMLEAD_ISSUE_PREFIXES="${TEAMLEAD_ISSUE_PREFIXES:-FLY,GEO}"
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
# FLY-83: FLYWHEEL_ROOT for locating scripts/lead-alert.sh (independent alert path).
# SCRIPT_DIR is packages/teamlead/scripts; FLYWHEEL_ROOT is three levels up.
FLYWHEEL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
export FLYWHEEL_ROOT
# FLY-183: Discord adapter orphan reaper. Sourced here (after SCRIPT_DIR, before
# _launch_claude is defined) so `reap_orphan_adapters` is available in the launch
# path. The lib defines functions only; it does not change shell options.
# shellcheck source=lib/reap-orphan-adapters.sh
source "${SCRIPT_DIR}/lib/reap-orphan-adapters.sh"
# FLY-83: Ensure all alert-path directories exist before anything can fail.
# - blocked/  : marker files pausing supervisor until Annie clears them
# - alert-queue/ : LeadAlertNotifier spills here when Discord POST fails
# - alerts/   : claims.db (cross-process dedup) lives here
BLOCKED_DIR="${HOME}/.flywheel/blocked"
mkdir -p "$BLOCKED_DIR" "${HOME}/.flywheel/alert-queue" "${HOME}/.flywheel/alerts"
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

# FLY-173: resolve THIS project's core channel (generalChannel) for the Discord
# plugin's Bridge-unavailable core fail-open fallback. STRICT per-pane derivation
# (Codex design-review R1 #3): read it from the SAME project config the Bridge
# uses (loadProjects → honors FLYWHEEL_PROJECTS / projects.json identically),
# NEVER the inherited global $DISCORD_CORE_CHANNEL — that global may diverge from
# the project's generalChannel and would otherwise let the plugin allow a channel
# the Bridge does not classify as core. When the project has no generalChannel,
# LEAD_CORE_CHANNEL stays empty → the plugin applies no core exemption (and the
# Bridge, also lacking generalChannel, denies → consistent, no divergence).
LEAD_CORE_CHANNEL=$(node -e "
  import('file://${SCRIPT_DIR}/../dist/ProjectConfig.js').then(({ loadProjects }) => {
    try {
      const m = loadProjects().find(e => e.projectName === process.argv[1]);
      if (m && m.generalChannel) process.stdout.write(m.generalChannel);
    } catch {}
  }).catch(() => {});
" "$PROJECT_NAME" 2>/dev/null)

# ── FLY-231: companion role detection (single source of truth) ──────────────
# A companion Lead (Mufasa / Belle) is a non-engineering persona agent wrapped in
# Flywheel infra. The ONLY source of truth is `companion: true` on the lead in
# projects.json (Codex R3 BLOCKER-1). This MUST run here — after PROJECT_NAME is
# resolved but BEFORE any role-dependent side-effect (manifest write, agent/rule
# sync, Discord plugin check-update, global PostCompact hook install, .mcp.json
# construction, Agent Team transport, bootstrap) — so an inconclusive result
# fail-STOPs with zero side effects (Codex R4 HIGH-4).
#
# NO `FLYWHEEL_LEAD_ROLE` bypass (Codex R4 BLOCKER-1): always query; only an EXACT
# projectName+leadId match yields companion/noncompanion. `error`/`notfound`
# fail-STOP (non-zero exit) — never fall open to a wider role, because a
# fail-open companion would silently get eng rules + Bridge token + bootstrap, and
# a successfully-started noncompanion process is "healthy" so the supervisor would
# not self-heal it after config recovers. launchd KeepAlive retries on a transient
# read (Codex R3 corrected the earlier "supervisor self-heals" assumption).
_companion_query() {
  node -e "
    import('file://${SCRIPT_DIR}/../dist/ProjectConfig.js').then(({ loadProjects }) => {
      let projects;
      try { projects = loadProjects(); } catch { process.stdout.write('error'); return; }
      const p = projects.find(e => e.projectName === process.argv[1]);
      if (!p) { process.stdout.write('notfound'); return; }
      const lead = (p.leads || []).find(l => l.agentId === process.argv[2]);
      if (!lead) { process.stdout.write('notfound'); return; }
      process.stdout.write(lead.companion === true ? 'companion' : 'noncompanion');
    }).catch(() => { process.stdout.write('error'); });
  " "$PROJECT_NAME" "$LEAD_ID" 2>/dev/null
}

# fail-STOP alert: best-effort, dedup'd via lead-alert.sh claims.db daily
# signature (at most one alert/day per project+lead+kind → launchd KeepAlive 30s
# retries do not spam). Independent of the Bridge. In the 'notfound' case the lead
# may be unresolvable from projects.json (lead-alert.sh then exits 1) — we already
# logged loudly, so this is purely additive (Codex R6 HIGH-3).
_companion_failstop_alert() {
  local body="$1"
  local alert_sh="${FLYWHEEL_ROOT}/scripts/lead-alert.sh"
  if [ -x "$alert_sh" ]; then
    "$alert_sh" \
      --lead "$LEAD_ID" --project "$PROJECT_NAME" \
      --kind companion_config_error --severity severe \
      --title "Companion Lead failed to start" \
      --body "$body" \
      >/dev/null 2>&1 || true
  fi
}

COMPANION_STATE="$(_companion_query)"
if [ "$COMPANION_STATE" = "error" ]; then
  log "companion role query returned error; retrying once..."
  COMPANION_STATE="$(_companion_query)"
fi

IS_COMPANION_ROLE=false
case "$COMPANION_STATE" in
  companion)
    IS_COMPANION_ROLE=true
    log "Role: companion (projects.json companion:true) — skipping engineering-governance rules + capability"
    ;;
  noncompanion)
    : # standard Lead path — existing IS_COS_ROLE logic decides cos vs dept (unchanged)
    ;;
  *)
    log "ERROR: companion role detection inconclusive (state='${COMPANION_STATE:-empty}') for ${PROJECT_NAME}/${LEAD_ID}."
    log "Refusing to start (fail-STOP) so a companion is never silently mis-run as an engineering Lead, and an engineering Lead never silently mis-run as companion."
    _companion_failstop_alert "Role detection inconclusive (state='${COMPANION_STATE:-empty}') for ${PROJECT_NAME}/${LEAD_ID}; refusing to start (fail-STOP). Check ~/.flywheel/projects.json for this companion's entry."
    exit 1
    ;;
esac

# ── FLY-879: external (customer-facing) role detection (single source of truth) ──
# An external Lead (Anna the interviewer) is a customer-facing agent wrapped in
# Flywheel infra with a HARD-LOCKED surface: NO Runner spawning, NO Bridge/CommDB/
# internal MCP, and — unlike a companion — NONE of the internal engineering rules
# AND not even the cross-dept roundtable. Its ENTIRE rule surface is one
# external-agent-contract.md. The ONLY source of truth is `external: true` on the
# lead in projects.json (config validation guarantees external ⇒ canSpawnRunners:
# false AND external ⊕ companion, so the two role queries never both fire).
#
# This mirrors the companion query structurally (three-value: external /
# nonexternal / error) + fail-STOP, and runs ONLY on the noncompanion path — an
# error/notfound in that window (or a missing contract later) fail-STOPs with a
# NEW `external_config_error` kind so an external agent is never silently mis-run
# with an internal capability surface. Placed here (before any role-dependent
# side-effect) so a fail-STOP leaves zero side effects.
_external_query() {
  node -e "
    import('file://${SCRIPT_DIR}/../dist/ProjectConfig.js').then(({ loadProjects }) => {
      let projects;
      try { projects = loadProjects(); } catch { process.stdout.write('error'); return; }
      const p = projects.find(e => e.projectName === process.argv[1]);
      if (!p) { process.stdout.write('notfound'); return; }
      const lead = (p.leads || []).find(l => l.agentId === process.argv[2]);
      if (!lead) { process.stdout.write('notfound'); return; }
      process.stdout.write(lead.external === true ? 'external' : 'nonexternal');
    }).catch(() => { process.stdout.write('error'); });
  " "$PROJECT_NAME" "$LEAD_ID" 2>/dev/null
}

# fail-STOP alert for the external role (mirrors _companion_failstop_alert). Uses
# the NEW `external_config_error` kind (added to lead-alert.sh's allowlist). The
# alert token is resolved by lead-alert.sh from projects.json's alertBotTokenEnv
# (which must live in the launcher/wrapper env — see W3/W4).
_external_failstop_alert() {
  local body="$1"
  local alert_sh="${FLYWHEEL_ROOT}/scripts/lead-alert.sh"
  if [ -x "$alert_sh" ]; then
    "$alert_sh" \
      --lead "$LEAD_ID" --project "$PROJECT_NAME" \
      --kind external_config_error --severity severe \
      --title "External Lead failed to start" \
      --body "$body" \
      >/dev/null 2>&1 || true
  fi
}

IS_EXTERNAL_ROLE=false
EXTERNAL_STATE="nonexternal"
if [ "$IS_COMPANION_ROLE" != true ]; then
  EXTERNAL_STATE="$(_external_query)"
  if [ "$EXTERNAL_STATE" = "error" ]; then
    log "external role query returned error; retrying once..."
    EXTERNAL_STATE="$(_external_query)"
  fi
  case "$EXTERNAL_STATE" in
    external)
      IS_EXTERNAL_ROLE=true
      log "Role: external (projects.json external:true) — locked surface: contract-only rules, no internal MCP/creds/roundtable"
      ;;
    nonexternal)
      : # standard Lead path — existing IS_COS_ROLE logic decides cos vs dept (unchanged)
      ;;
    *)
      log "ERROR: external role detection inconclusive (state='${EXTERNAL_STATE:-empty}') for ${PROJECT_NAME}/${LEAD_ID}."
      log "Refusing to start (fail-STOP) so an external agent is never silently mis-run with an internal capability surface."
      _external_failstop_alert "External role detection inconclusive (state='${EXTERNAL_STATE:-empty}') for ${PROJECT_NAME}/${LEAD_ID}; refusing to start (fail-STOP). Check ~/.flywheel/projects.json for this external agent's entry."
      exit 1
      ;;
  esac
fi

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
  # FLY-143: preserve per-Lead MCP scope fields across manifest rewrites.
  # Source of truth: env (set by wrapper from prior manifest read). Falling
  # back to existing manifest values stops a launchd restart from silently
  # dropping `mcpExclude` / `chromeEnabled` and re-broadening MCP scope.
  _existing_mcp_exclude=""
  _existing_chrome_enabled="false"
  # FLY-247: preserve the fleet carrier fields (`model`, `leadBackend.backendId`)
  # across the boot-time rewrite. fleet apply is the authoritative writer; this
  # preserve only stops a launchd self-restart BETWEEN two applies from
  # silently dropping the fields (and with them the FLYWHEEL_LEAD_MODEL env on
  # the next `daemon install`). Absent fields stay absent — never injected.
  _existing_model=""
  _existing_lead_backend=""
  _existing_effort=""   # FLY-671: preserve the effort carrier across boot rewrites
  if [ -f "$MANIFEST_FILE" ]; then
    _existing_mcp_exclude=$(jq -r '.mcpExclude // ""' "$MANIFEST_FILE" 2>/dev/null || echo "")
    _existing_chrome_enabled=$(jq -r '.chromeEnabled // false' "$MANIFEST_FILE" 2>/dev/null || echo "false")
    _existing_model=$(jq -r '.model // ""' "$MANIFEST_FILE" 2>/dev/null || echo "")
    _existing_lead_backend=$(jq -r '.leadBackend.backendId // ""' "$MANIFEST_FILE" 2>/dev/null || echo "")
    _existing_effort=$(jq -r '.effort // ""' "$MANIFEST_FILE" 2>/dev/null || echo "")
  fi
  _final_mcp_exclude="${FLYWHEEL_LEAD_MCP_EXCLUDE-$_existing_mcp_exclude}"
  if [ "${FLYWHEEL_LEAD_CHROME_ENABLED:-}" = "true" ]; then
    _final_chrome_enabled=true
  elif [ "${FLYWHEEL_LEAD_CHROME_ENABLED:-}" = "false" ]; then
    _final_chrome_enabled=false
  else
    _final_chrome_enabled="$_existing_chrome_enabled"
  fi

  # FLY-247 R7#3: atomic self-write (temp + jq validate + rename). The old
  # direct `> "$MANIFEST_FILE"` redirect could leave a truncated canonical
  # manifest if boot was interrupted mid-write — breaking the hash premises
  # of the fleet transaction journal and rollback CAS.
  _manifest_tmp="${MANIFEST_FILE}.tmp.$$"
  jq -n \
    --arg leadId "$LEAD_ID" \
    --arg projectDir "$PROJECT_DIR" \
    --arg projectName "$PROJECT_NAME" \
    --arg subdir "${LEAD_SUBDIR:-}" \
    --arg workspace "$LEAD_WORKSPACE" \
    --arg botTokenEnv "${BOT_TOKEN_ENV_NAME:-DISCORD_BOT_TOKEN}" \
    --arg pid "$$" \
    --arg mcpExclude "$_final_mcp_exclude" \
    --argjson chromeEnabled "$_final_chrome_enabled" \
    --arg model "$_existing_model" \
    --arg leadBackendId "$_existing_lead_backend" \
    --arg effort "$_existing_effort" \
    '{
       leadId: $leadId, projectDir: $projectDir, projectName: $projectName,
       subdir: $subdir, workspace: $workspace, botTokenEnv: $botTokenEnv,
       mcpExclude: $mcpExclude, chromeEnabled: $chromeEnabled,
       pid: ($pid | tonumber)
     }
     | (if $model != "" then . + {model: $model} else . end)
     | (if $effort != "" then . + {effort: $effort} else . end)
     | (if $leadBackendId != "" then . + {leadBackend: {backendId: $leadBackendId}} else . end)' \
    > "$_manifest_tmp" \
    && jq empty "$_manifest_tmp" 2>/dev/null \
    && mv "$_manifest_tmp" "$MANIFEST_FILE" \
    || { rm -f "$_manifest_tmp"; log "WARNING: manifest write failed — keeping previous manifest"; }
  log "Manifest written: ${MANIFEST_FILE} (mcpExclude=\"${_final_mcp_exclude}\", chromeEnabled=${_final_chrome_enabled})"
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

if [ "$IS_EXTERNAL_ROLE" = true ]; then
  # FLY-879: an external (customer-facing) agent NEVER stages the project's
  # `.lead/shared` rules — its ONLY rule surface is external-agent-contract.md.
  # Staging internal Lead rules into an outward-facing agent is exactly the leak
  # this role class exists to prevent. Also clean any stale cache so a leftover
  # dir can't be appended downstream (the project-side append block is guarded too).
  if [ -d "$LEAD_RULES_DIR" ]; then
    rm -rf "$LEAD_RULES_DIR"
    log "External: cleaned stale shared rules cache: ${LEAD_RULES_DIR}"
  fi
  log "External: skipping project shared-rule sync (contract-only rule surface)"
elif [ -d "$SHARED_RULES_DIR" ]; then
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

# FLY-231 dry-run: the launch-plan test runs in an isolated HOME with no
# ~/.flywheel/bin scripts — skip the plugin fork check/update (it mutates the
# shared plugin cache and is irrelevant to argv/env assembly).
if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" = "1" ]; then
  log "DRY-RUN: skipping Discord plugin fork check"
elif [ ! -x "$CHECK_SCRIPT" ] || [ ! -x "$UPDATE_SCRIPT" ]; then
  log "ERROR: Discord plugin fork scripts not found or not executable:"
  log "  check:  $CHECK_SCRIPT"
  log "  update: $UPDATE_SCRIPT"
  log "Run GEO-296 setup first. Aborting."
  exit 1
fi

if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" != "1" ] && ! "$CHECK_SCRIPT"; then
  log "Discord plugin cache is not fork version, updating..."
  "$UPDATE_SCRIPT"
  # Re-check after update — hard fail if still not matching
  if ! "$CHECK_SCRIPT"; then
    log "ERROR: Discord plugin still not fork version after update. Aborting."
    exit 1
  fi
fi
[ "${FLYWHEEL_LEAD_DRY_RUN:-0}" = "1" ] || log "Discord plugin fork check: OK"

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

# ── FLY-387: Install discord-reply-enforcer Stop hook ─────────────────────
# Collects the (previously ad-hoc, machine-local, Lead-ineffective) Stop hook
# into Flywheel and installs it idempotently to a stable path. Fine-grained
# .hooks.Stop merge: removes ONLY discord-reply-enforcer.py commands from each
# Stop group (incl. a hand-installed ~/.claude/hooks/ one), PRESERVES sibling
# hooks in the same group, drops emptied groups, then adds the stable entry if
# absent. Fail-open: on malformed/invalid JSON, skip + WARN, never rewrite.
# Installed for EVERY role INCLUDING companion (Belle was the recurring victim).
install_discord_reply_enforcer_hook() {
  if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" = "1" ]; then
    log "DRY-RUN: skipping discord-reply-enforcer Stop hook install"
    return
  fi

  local src_script="${FLYWHEEL_ROOT}/scripts/hooks/discord-reply-enforcer.py"
  if [ ! -f "$src_script" ]; then
    log "WARNING: discord-reply-enforcer source not found: $src_script"
    return
  fi

  local hook_script="${HOME}/.flywheel/bin/discord-reply-enforcer.py"
  mkdir -p "$(dirname "$hook_script")"
  cp "$src_script" "$hook_script"
  chmod +x "$hook_script"
  local cmd="python3 ${hook_script}"

  local settings_file="${HOME}/.claude/settings.json"
  mkdir -p "$(dirname "$settings_file")"

  # NOTE: macOS ships jq 1.6, whose `jq empty` / filters return exit 0 even on a
  # parse error (only an empty stdout signals failure). So validity is checked by
  # OUTPUT non-emptiness, NOT exit code — otherwise a malformed settings.json
  # would slip through and an empty merge result could clobber the file.
  local existing="{}"
  if [ -f "$settings_file" ]; then
    existing=$(cat "$settings_file")
    if [ -z "$(printf '%s' "$existing" | jq -c . 2>/dev/null)" ]; then
      log "WARNING: $settings_file is not valid JSON. Skipping reply-enforcer hook install (file untouched)."
      return
    fi
  fi

  local merged
  merged=$(printf '%s' "$existing" | jq --arg cmd "$cmd" '
    .hooks = (.hooks // {}) |
    .hooks.Stop = (if (.hooks.Stop | type) == "array" then .hooks.Stop else [] end) |
    # Remove ONLY discord-reply-enforcer.py commands from each group; keep
    # sibling hooks; drop groups that become empty.
    .hooks.Stop = ([ .hooks.Stop[]
        | .hooks = ([ (.hooks // [])[]
            | select(((.command // "") | endswith("discord-reply-enforcer.py")) | not) ])
      ] | map(select(((.hooks // []) | length) > 0))) |
    # Add the stable-path entry if not already present.
    if ([ .hooks.Stop[] | select(any((.hooks // [])[]; (.command // "") == $cmd)) ] | length) == 0
    then .hooks.Stop += [{"hooks": [{"type": "command", "command": $cmd}]}]
    else .
    end
  ' 2>/dev/null)

  # Fail-open: a malformed input or failed merge yields empty/invalid output on
  # jq 1.6 — never write an empty/invalid result over settings.json.
  if [ -z "$merged" ] || [ -z "$(printf '%s' "$merged" | jq -c . 2>/dev/null)" ]; then
    log "WARNING: reply-enforcer settings merge produced empty/invalid JSON. Skipping (file untouched)."
    return
  fi

  local tmpfile
  tmpfile=$(mktemp "${settings_file}.XXXXXX")
  printf '%s\n' "$merged" > "$tmpfile"
  mv "$tmpfile" "$settings_file"
  log "discord-reply-enforcer Stop hook installed: $hook_script"
}

# ── FLY-913: Install flywheel-restart-guard PreToolUse hook ────────────────
# Deployment guardrail: hard-deny manual Bridge/Lead restarts (launchctl
# kickstart/bootout, kill+relaunch, bare-handed run-bridge) at the Bash
# boundary, pointing the agent at scripts/restart-services.sh. The merge
# logic lives in ONE place — scripts/hooks/install-restart-guard.sh — which
# this convergence step delegates to on every Lead start (anti-drift).
# Installed for EVERY role incl. companion: the guard protects a GLOBAL
# machine invariant (no manual flywheel service restarts from any session).
install_restart_guard_hook() {
  if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" = "1" ]; then
    log "DRY-RUN: skipping flywheel-restart-guard PreToolUse hook install"
    return
  fi

  local installer="${FLYWHEEL_ROOT}/scripts/hooks/install-restart-guard.sh"
  if [ ! -f "$installer" ]; then
    log "WARNING: install-restart-guard.sh not found: $installer"
    return
  fi

  if bash "$installer" >/dev/null 2>&1; then
    log "flywheel-restart-guard PreToolUse hook installed (converged)"
  else
    log "WARNING: flywheel-restart-guard hook install failed/skipped (non-fatal)"
  fi
}

# ── FLY-954: converge <state>/bin runtime scripts (anti-drift) ──────────────
# Incident 2026-07-06: 12-byte stubs sat in ~/.flywheel/bin for 8h, then a
# deploy kickstart took all 13 Leads down. Every Lead start now verifies
# installed-copy == repo-source and repairs + alerts on drift. Single source
# of truth: scripts/converge-flywheel-bin.sh (FLY-913 convergence pattern).
# NOTE this mount heals bridge-wrapper/restart-services copies and day-to-day
# drift only — a broken lead-wrapper cannot heal itself from here (this code
# runs AFTER the wrapper already worked); the updater + pre-kickstart mounts
# cover that case. Non-fatal: a Lead must still boot if convergence hiccups.
converge_flywheel_bin() {
  if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" = "1" ]; then
    log "DRY-RUN: skipping flywheel-bin convergence"
    return
  fi
  local converger="${FLYWHEEL_ROOT}/scripts/converge-flywheel-bin.sh"
  if [ ! -f "$converger" ]; then
    log "WARNING: converge-flywheel-bin.sh not found: $converger"
    return
  fi
  if bash "$converger" >/dev/null 2>&1; then
    log "flywheel-bin convergence OK"
  else
    log "WARNING: flywheel-bin convergence left unhealthy state (non-fatal; alert sent via lead-alert)"
  fi
}
# FLY-231: companion skips installing the PostCompact bootstrap hook (it doesn't
# want to (re)install the engineering bootstrap re-send). Note the hook is GLOBAL
# in ~/.claude/settings.json and may already be installed by other Leads — the
# real companion guard is the FLYWHEEL_LEAD_COMPANION=1 pane marker that makes the
# stable hook early-exit before any bootstrap curl (post-compact-bootstrap.sh).
# FLY-879: external Leads ALSO skip installing the PostCompact bootstrap hook —
# their pane carries FLYWHEEL_LEAD_EXTERNAL=1 and the global stable hook early-exits
# on it (post-compact-bootstrap.sh), same pattern as the companion marker.
if [ "$IS_COMPANION_ROLE" != true ] && [ "$IS_EXTERNAL_ROLE" != true ] && command -v jq >/dev/null 2>&1; then
  install_post_compact_hook
elif [ "$IS_COMPANION_ROLE" = true ]; then
  log "Companion: skipping PostCompact hook install (global hook honors FLYWHEEL_LEAD_COMPANION marker)"
elif [ "$IS_EXTERNAL_ROLE" = true ]; then
  log "External: skipping PostCompact hook install (global hook honors FLYWHEEL_LEAD_EXTERNAL marker)"
fi

# FLY-387: install the discord-reply-enforcer Stop hook for EVERY role —
# companion INCLUDED (unlike PostCompact). Belle (companion) was the recurring
# victim of the outbound reply-leak this hook guards against.
if command -v jq >/dev/null 2>&1; then
  install_discord_reply_enforcer_hook
else
  log "WARNING: jq not found. Skipping discord-reply-enforcer Stop hook install."
fi

# FLY-913: install the flywheel-restart-guard PreToolUse hook for EVERY role —
# manual Bridge/Lead restarts are denied machine-wide regardless of which Lead
# (or its Runners) types them; restart-services.sh stays the only path.
if command -v jq >/dev/null 2>&1; then
  install_restart_guard_hook
else
  log "WARNING: jq not found. Skipping flywheel-restart-guard PreToolUse hook install."
fi

# FLY-954: converge <state>/bin runtime scripts on every Lead start — global
# machine invariant (installed copy == repo source), same rationale as the
# restart guard above.
converge_flywheel_bin

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

# FLY-109: Dev-channels dialog auto-confirm via tmux capture-pane.
#
# Claude Code shows a TUI confirmation for --dangerously-load-development-channels.
# In daemon mode (launchd), no human can press Enter. We poll the tmux pane's
# rendered text (ANSI-stripped by capture-pane) and send "1" + Enter when we detect
# dialog markers.
#
# Previous approach (expect script) failed because Ink TUI inserts ANSI escape
# codes between words, breaking regex matching on the raw byte stream. capture-pane
# returns the rendered screen content without ANSI codes, making grep reliable.
#
# FLY-83 note: blocked-prompt classification (rate_limit / usage_limit /
# login_expired / permission_blocked) is owned by the Bridge-side LeadWatchdog
# (packages/teamlead/src/LeadWatchdog.ts), which uses the SAME capture-pane
# approach against the rendered screen and avoids the ANSI byte-stream
# mismatches that doomed the earlier expect-script sentinel-exit-code path.
#
# The poller runs in the background and auto-exits on confirm or timeout.

mkdir -p "${HOME}/.flywheel/logs" 2>/dev/null || true
FLYWHEEL_DIALOG_TIMEOUT_SEC="${FLYWHEEL_EXPECT_DIALOG_TIMEOUT_SEC:-90}"
FLYWHEEL_STARTUP_LOG="${FLYWHEEL_EXPECT_LOG:-${HOME}/.flywheel/logs/lead-${LEAD_ID}-startup.log}"

_log_startup() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%S') $*" >> "$FLYWHEEL_STARTUP_LOG"
}

# Poll tmux pane for dev-channels dialog and auto-confirm.
# Args: $1 = tmux window_id, $2 = timeout_sec
# Runs as a background job; exits on confirm, timeout, or window death.
_poll_dev_channels_dialog() {
  local window_id="$1"
  local timeout_sec="${2:-90}"
  local elapsed=0

  _log_startup "dialog-poller: start window=${window_id} timeout=${timeout_sec}s"

  while [ "$elapsed" -lt "$timeout_sec" ]; do
    # Check window still exists
    if ! tmux list-panes -t "$window_id" &>/dev/null; then
      _log_startup "dialog-poller: window gone, exiting"
      return 0
    fi

    local pane_text
    pane_text=$(tmux capture-pane -t "$window_id" -p 2>/dev/null || echo "")

    if echo "$pane_text" | grep -qE "Loading development channels|am using this for local development|development channels"; then
      _log_startup "dialog-poller: matched dev-channels dialog, sending '1' Enter"
      tmux send-keys -t "$window_id" "1" 2>/dev/null || true
      sleep 0.3
      tmux send-keys -t "$window_id" Enter 2>/dev/null || true
      _log_startup "dialog-poller: confirmed=1"
      return 0
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  _log_startup "dialog-poller: DEV_CHANNELS_DIALOG_NOT_SEEN after ${timeout_sec}s"
  return 0
}

# Ensure the shared flywheel tmux session exists (race-safe, idempotent).
# Called before every launch — handles session being killed externally.
ensure_tmux_session() {
  # -A: attach-or-create (atomic). -d: stay detached. -x/-y: default size.
  tmux new-session -Ad -s flywheel -x 200 -y 50 2>/dev/null || true
}

# FLY-231: structured dry-run launch plan (FLYWHEEL_LEAD_DRY_RUN=1). Emits the
# final argv + pane-env KEY+status (NEVER the value — Codex R3 BLOCKER-4 secret
# safety: bot/teamlead/openai tokens etc. must never be echoed) + the MCP server
# names actually written to .mcp.json + role/gates. Consumed by the reverse-compat
# sentinel + companion capability tests. Reads the caller's `env_args` array via
# bash dynamic scope (it is `local` in _launch_claude, the only caller).
_emit_launch_plan() {
  printf 'LAUNCH_PLAN_BEGIN\n'
  # FLY-879: three-value role — external wins over companion (they are config-level
  # mutually exclusive, so at most one of these is true).
  local _plan_role=standard
  if [ "$IS_EXTERNAL_ROLE" = true ]; then _plan_role=external
  elif [ "$IS_COMPANION_ROLE" = true ]; then _plan_role=companion
  fi
  printf 'ROLE\t%s\n' "$_plan_role"
  printf 'ROLE_SOURCE\tprojects-query\n'
  printf 'COMPANION_STATE\t%s\n' "${COMPANION_STATE:-}"
  printf 'EXTERNAL_STATE\t%s\n' "${EXTERNAL_STATE:-}"
  printf 'INBOX_MCP_ENABLED\t%s\n' "${INBOX_MCP_ENABLED:-false}"
  local a
  for a in "$@"; do printf 'ARG\t%s\n' "$a"; done
  local e key val
  for e in "${env_args[@]}"; do
    [ "$e" = "-e" ] && continue
    key="${e%%=*}"
    val="${e#*=}"
    if [ -z "$val" ]; then
      printf 'PANE_ENV\t%s\tempty\n' "$key"
    else
      printf 'PANE_ENV\t%s\tset\n' "$key"
    fi
  done
  if [ -f "${MCP_CONFIG_FILE:-}" ] && command -v jq >/dev/null 2>&1; then
    jq -r 'if has("mcpServers") then .mcpServers else . end | keys[]' "$MCP_CONFIG_FILE" 2>/dev/null \
      | while IFS= read -r s; do printf 'MCP_SERVER\t%s\n' "$s"; done
  fi
  printf 'LAUNCH_PLAN_END\n'
}

# Launch Claude in a tmux window within the flywheel session.
# Uses -P -F to capture window_id (like TmuxAdapter).
# Uses -e to inject per-window environment (no shell inheritance in shared session).
_launch_claude() {
  local window_name="${PROJECT_NAME}-${LEAD_ID}"

  # FLY-231 dry-run: a structured launch-plan test (byte-compat sentinel + companion
  # capability assertions) must NOT touch the shared `flywheel` tmux session, which
  # is NOT HOME-isolated. Skip all tmux side effects here; env_args still builds
  # below so the plan captures the real pane env. The emit+return is just before
  # the actual `tmux new-window`.
  if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" != "1" ]; then
    ensure_tmux_session

    # FLY-183: Reap orphaned Discord adapters before launching a new Claude.
    # Sequence matters (Codex design review #3): on a supervisor restart the stale
    # window below may still hold a LIVE old Claude (ppid!=1, skipped by reap);
    # killing it then creates exactly the orphan we must clean. So:
    #   pre-sweep (historical orphans) -> kill stale window -> bounded settle
    #   (let old Claude die + its adapter reparent to launchd) -> re-sweep.
    # `|| true` belt: reap is internally fail-open, but never let it abort launch.
    reap_orphan_adapters || true

    # Kill stale window with same name (from previous crash)
    tmux kill-window -t "=flywheel:=${window_name}" 2>/dev/null || true

    # FLY-183: bounded settle for the just-killed Claude to exit and its adapter
    # to reparent to launchd (ppid==1), then re-sweep to reap that fresh orphan
    # before the new Claude (and its new adapter) starts. One-shot, not periodic.
    sleep 0.5
    reap_orphan_adapters || true
  fi

  # Build env injection args (explicit per-window, match TmuxAdapter pattern).
  # FLY-60 W6 v2: ALSO override the un-prefixed LEAD_ID and PROJECT_NAME
  # vars per-window. Without these the new Lead window inherits the parent
  # shell's values (e.g. Annie's PROJECT_NAME=geoforge3d, LEAD_ID=ops-lead),
  # so any tool that reads the un-prefixed names sees the wrong slot
  # context — Bridge then 404s "No runtime for project: geoforge3d" while
  # the test slot's runtime is registered as "test-slot-N". The W6 v1 fix
  # was identity.md prompt-only, which could not override env-var leak.
  # In production this is a no-op (Annie's shell already has the right
  # values); in test slots it ensures the per-invocation slot values win.
  #
  # FLY-231: companion capability — explicitly EMPTY the high-privilege pane creds
  # (Codex R2 HIGH-5: emptied, not merely "not added"; the wrapper `set -a` sources
  # the whole ~/.flywheel/.env, so per-pane override is required). Acceptance = the
  # Bridge token is UNUSABLE in the companion pane (BRIDGE_URL is not a secret;
  # emptying it just removes the convenient localhost Bridge handle). For
  # non-companion these resolve to the exact prior values → byte-identical env.
  local _cz_teamlead_token="${TEAMLEAD_API_TOKEN:-}"
  local _cz_bridge_url="${BRIDGE_URL:-}"
  local _cz_comm_cli="${FLYWHEEL_COMM_CLI:-}"
  local _cz_comm_db="${FLYWHEEL_COMM_DB:-}"
  local _cz_openai_key="${OPENAI_API_KEY:-}"
  # FLY-879: an external (customer-facing) Lead gets the SAME high-privilege-cred
  # emptying as a companion — no Bridge token, no CommDB, no OpenAI key in its pane.
  # Anna reaches nothing internal (its whole world is the interviews repo + Discord).
  if [ "$IS_COMPANION_ROLE" = true ] || [ "$IS_EXTERNAL_ROLE" = true ]; then
    _cz_teamlead_token=""
    _cz_bridge_url=""
    _cz_comm_cli=""
    _cz_comm_db=""
    _cz_openai_key=""
  fi
  local env_args=(
    -e "DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN:-}"
    -e "DISCORD_STATE_DIR=${DISCORD_STATE_DIR:-}"
    -e "LEAD_ID=${LEAD_ID}"
    -e "FLYWHEEL_LEAD_ID=${LEAD_ID}"
    -e "FLYWHEEL_COMM_DB=${_cz_comm_db}"
    -e "FLYWHEEL_COMM_CLI=${_cz_comm_cli}"
    -e "PROJECT_NAME=${PROJECT_NAME}"
    -e "FLYWHEEL_PROJECT_NAME=${PROJECT_NAME}"
    # FLY-205: project root path for the doc-flow Lead rule's config self-check
    # (doc-flow-rules.md reads $FLYWHEEL_PROJECT_DIR/.flywheel/config.yaml).
    # tmux `new-window -e` does not inherit launcher env, and LEAD_WORKSPACE
    # isolation makes pwd useless — explicit pass is the ONLY reliable source
    # (Codex design R3 #1). Missing env in the pane → rule fails safe to
    # "doc-flow not enabled" (zero behavior change).
    -e "FLYWHEEL_PROJECT_DIR=${PROJECT_DIR}"
    -e "BRIDGE_URL=${_cz_bridge_url}"
    -e "TEAMLEAD_API_TOKEN=${_cz_teamlead_token}"
    # FLY-162 Layer 2: tmux panes do NOT inherit launcher env (see note below),
    # so the Discord plugin's reply-guard fallback prefix scan needs this
    # explicitly — otherwise a custom TEAMLEAD_ISSUE_PREFIXES silently degrades
    # to FLY,GEO during Bridge-unavailable fail-closed checks (Codex code-review MED).
    -e "TEAMLEAD_ISSUE_PREFIXES=${TEAMLEAD_ISSUE_PREFIXES:-FLY,GEO}"
    # FLY-173: project core channel for the Discord plugin's Bridge-unavailable
    # core fail-open. Set UNCONDITIONALLY (resolved value or empty) so it OVERRIDES
    # any inherited global DISCORD_CORE_CHANNEL in the pane — strict per-pane
    # derivation (Codex R1 #3). Empty when the project has no generalChannel →
    # plugin applies no core exemption. tmux `new-window -e` does not inherit env,
    # so this explicit pass is required (same barrier as TEAMLEAD_ISSUE_PREFIXES).
    -e "DISCORD_CORE_CHANNEL=${LEAD_CORE_CHANNEL:-}"
    -e "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:-70}"
    -e "OPENAI_API_KEY=${_cz_openai_key}"
    -e "HOME=${HOME}"
    -e "PATH=${PATH}"
    # GEO-151 QA cycle 1 fix: L3 screencapture skill prompt references
    # `$FLYWHEEL_TEAMLEAD_SCRIPT_DIR/find-window.sh`. Export at line ~1215
    # only sets it in the launcher shell — `tmux new-window -e` strips
    # anything not in this allowlist, so the Lead pane saw empty and the
    # skill fell back to a slow `find /` recursive scan. Same tmux env
    # barrier pattern FLY-142 fixed for CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS.
    -e "FLYWHEEL_TEAMLEAD_SCRIPT_DIR=${FLYWHEEL_TEAMLEAD_SCRIPT_DIR:-}"
  )

  # FLY-231: companion marker — only added for companion panes (non-companion env
  # is byte-identical, no such entry). Read by the GLOBAL stable
  # post-compact-bootstrap.sh hook to early-exit before any bootstrap curl.
  if [ "$IS_COMPANION_ROLE" = true ]; then
    env_args+=(-e "FLYWHEEL_LEAD_COMPANION=1")
  fi

  # FLY-879: external marker — only added for external panes (non-external env is
  # byte-identical, no such entry). Read by the GLOBAL stable post-compact-bootstrap.sh
  # hook to early-exit before any bootstrap curl (Anna gets no engineering bootstrap).
  if [ "$IS_EXTERNAL_ROLE" = true ]; then
    env_args+=(-e "FLYWHEEL_LEAD_EXTERNAL=1")
  fi

  # FLY-142 PR 1.2: Agent Team transport env vars. Set by
  # `eval "$(agent-team-transport lead-env ...)"` earlier in the script
  # (no-op if transport CLI not on PATH, vars stay unset). Propagate into
  # tmux pane so claude-code's useInboxPoller activates with the same paths
  # the launcher knows about (Codex r1 high #5: stock binary uses
  # CLAUDE_CONFIG_DIR; the legacy FLYWHEEL_TEAMS_* env namespace is banned).
  #
  # QA-found bug (2026-05-12, FLY-142 verify): empty propagation is NOT a
  # no-op. `tmux new-window -e CLAUDE_CONFIG_DIR=` sets the var to empty
  # string in the pane, which claude-code distinguishes from "unset" — empty
  # string sends it looking for trust state at the wrong path, retriggering
  # the Trust dialog even when ~/.claude.json:hasTrustDialogAccepted=true is
  # set. Only propagate when the launcher actually has a value.
  if [ -n "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-}" ]; then
    env_args+=(-e "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS}")
  fi
  if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    env_args+=(-e "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR}")
  fi
  if [ -n "${FLYWHEEL_AGENT_BACKEND:-}" ]; then
    env_args+=(-e "FLYWHEEL_AGENT_BACKEND=${FLYWHEEL_AGENT_BACKEND}")
  fi
  if [ -n "${FLYWHEEL_STATE_DIR:-}" ]; then
    env_args+=(-e "FLYWHEEL_STATE_DIR=${FLYWHEEL_STATE_DIR}")
  fi

  # FLY-314 Phase 2 (Part b) / FLY-535 / FLY-569: roundtable reply-in-thread
  # plugin flags. The Discord plugin (MCP server) reads these from process.env.
  # tmux `new-window -e` does NOT inherit the launcher env, so forward each
  # explicitly (same barrier as the vars above). Unset in the launcher means not
  # forwarded => env-overlay empty.
  #
  # FLY-569: reply-in-thread is now DEFAULT-ON in the plugin, resolved from the
  # SHARED NON-TOKEN file ~/.flywheel/roundtable.json (channelId only) when the
  # per-lead env does not set FLYWHEEL_ROUNDTABLE_CHANNEL_ID — env still WINS, so
  # forwarding these (when set) keeps wrapper-launched leads + the QA Room exact.
  # FLYWHEEL_ROUNDTABLE_CONFIG_FILE overrides the shared-file path (QA Room /
  # test isolation); unset => plugin uses the default path (byte-compatible).
  local _rt_var
  for _rt_var in FLYWHEEL_ROUNDTABLE_CHANNEL_ID FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD \
    FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE FLYWHEEL_ROUNDTABLE_THREAD_BUDGET \
    FLYWHEEL_ROUNDTABLE_CONFIG_FILE; do
    if [ -n "${!_rt_var:-}" ]; then
      env_args+=(-e "${_rt_var}=${!_rt_var}")
    fi
  done

  # FLY-143 (QA-found): tmux `new-window -e` does NOT inherit the launcher's
  # env, so any `${VAR}` referenced in the merged .mcp.json must be passed
  # explicitly or Claude marks the server "needs authentication".
  # Scan the final .mcp.json and append each required env var with its
  # current value (or empty if unset — empty preserves the variable name in
  # the Lead pane so `${VAR:-default}` semantics still work).
  if [ -n "${MCP_CONFIG_FILE:-}" ] && [ -f "${MCP_CONFIG_FILE}" ]; then
    local _req_var _added_count=0
    while IFS= read -r _req_var; do
      [ -z "$_req_var" ] && continue
      env_args+=(-e "${_req_var}=${!_req_var:-}")
      _added_count=$((_added_count + 1))
    done < <(list_required_envs "$MCP_CONFIG_FILE")
    if [ "$_added_count" -gt 0 ]; then
      log "MCP env propagation: forwarded ${_added_count} required env var(s) to tmux pane"
    fi
  fi

  # FLY-231 dry-run: env_args is now fully assembled (incl. MCP-required-env
  # propagation). Emit the structured launch-plan and return WITHOUT launching.
  if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" = "1" ]; then
    _emit_launch_plan "$@"
    return 0
  fi

  # FLY-109: Launch claude directly (no expect wrapper). Dev-channels dialog
  # is handled by background capture-pane poller started below.
  LEAD_WINDOW_ID=$(tmux new-window -d -P -F '#{window_id}' \
    -t =flywheel \
    "${env_args[@]}" \
    -n "$window_name" \
    -c "$LEAD_WORKSPACE" \
    claude "$@")

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

  # FLY-183: best-effort reap of this Lead's adapter on graceful shutdown.
  # Timing caveat (Codex design review #3): the just-killed Claude's adapter may
  # not have reparented to launchd (ppid==1) yet, so this is best-effort only --
  # a short settle improves the odds, but the durable guarantee is Layer 2
  # (in-adapter ppid self-clean) plus the next launch's pre/re-sweep. Never block
  # shutdown on it.
  sleep 0.5
  reap_orphan_adapters || true

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
  if [ "${_MCP_LOCK_HELD:-false}" = "true" ] && [ -n "${_SETTINGS_LOCAL_JSON:-}" ]; then
    rmdir "${_SETTINGS_LOCAL_JSON}.flywheel-lock" 2>/dev/null || true
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

# FLY-142 PR #186 Bug #5 amend: Bridge boot symlinks `agent-team-transport`
# into `~/.flywheel/bin/` (via `sync-flywheel-hooks.ts:syncFlywheelCliBin`)
# so the FATAL check below finds the CLI on PATH. Prepend the dir here so
# launchd / tmux launches inherit the path even when the operator's shell
# rc files don't add it.
#
# `FLYWHEEL_BIN_DIR` mirrors the override used by `syncFlywheelCliBin` for
# test slots; if unset, we use `~/.flywheel/bin` (the production default).
export PATH="${FLYWHEEL_BIN_DIR:-$HOME/.flywheel/bin}:$PATH"
GBRAIN_PATH="$(command -v gbrain 2>/dev/null || true)"

# FLY-879: locked-role label for MCP-skip log lines (companion + external share
# the "no internal MCP" surface). Empty for a standard Lead (this block is skipped).
_LOCKED_ROLE_LABEL="Locked"
[ "$IS_COMPANION_ROLE" = true ] && _LOCKED_ROLE_LABEL="Companion"
[ "$IS_EXTERNAL_ROLE" = true ] && _LOCKED_ROLE_LABEL="External"

terminal_server='{}'
if [ "$IS_COMPANION_ROLE" = true ] || [ "$IS_EXTERNAL_ROLE" = true ]; then
  # FLY-231/FLY-879: companion AND external have no Runner / Bridge-action surface
  # — do NOT register flywheel-terminal (it would inject BRIDGE_URL +
  # TEAMLEAD_API_TOKEN, the reserved-action handle a locked agent must not have).
  log "${_LOCKED_ROLE_LABEL}: flywheel-terminal MCP NOT registered"
elif [ -d "$TERMINAL_MCP_DIR" ]; then
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
if [ "$IS_COMPANION_ROLE" = true ] || [ "$IS_EXTERNAL_ROLE" = true ]; then
  # FLY-231/FLY-879: companion AND external have no Runner mailbox / inbox need —
  # leave disabled (also skips the inbox-ack rule + post-launch inbox poller).
  log "${_LOCKED_ROLE_LABEL}: flywheel-inbox MCP NOT registered"
elif [ -d "$INBOX_MCP_DIR" ]; then
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
if [ "$IS_COMPANION_ROLE" = true ] || [ "$IS_EXTERNAL_ROLE" = true ]; then
  # FLY-231/FLY-879: companion AND external have no project Wiki — reserved infra
  # MCP stays empty.
  log "${_LOCKED_ROLE_LABEL}: gbrain MCP NOT registered"
elif [ -n "$GBRAIN_PATH" ] && [ -f "$HOME/.gbrain/config.json" ]; then
  gbrain_server=$(jq -n --arg bin "$GBRAIN_PATH" \
    '{"gbrain": {command: $bin, args: ["serve"]}}')
  log "GBrain MCP: enabled (project Wiki)"
elif [ -n "$GBRAIN_PATH" ]; then
  log "GBrain MCP: skipped (installed but not configured — run 'gbrain init --supabase')"
else
  log "GBrain MCP: skipped (gbrain not installed)"
fi

MCP_CONFIG_FILE="${LEAD_WORKSPACE}/.mcp.json"

# FLY-143: Inherit user-scope MCP servers (default-inherit + class blacklist
# + per-Lead exclude + JSON-aware env gate + reserved-name collision warn).
# See doc/engineer/exploration/new/FLY-143-lead-mcp-scope-audit.md (v4).
#
# Trust model: Lead/Runner is Annie's alter ego. Reads only top-level
# `~/.claude.json.mcpServers` (NEVER `.projects[*].mcpServers`, where
# Annie's local-scope `slack` server carries her personal SLACK_BOT_TOKEN).
#
# Per-Lead exclude: wrapper exports FLYWHEEL_LEAD_MCP_EXCLUDE from manifest's
# `mcpExclude` field (e.g. Simba excludes "bambu-h2d,xiaohongshu-mcp,pencil"
# since cos-lead has no operational use for printer/publishing/design).
#
# Class blacklist: hardcoded "audible" today (personal media history).
# Future personal/account/desktop-control MCPs default-deny via this list.
LEAD_USER_MCP_BLACKLIST="${FLYWHEEL_LEAD_MCP_BLACKLIST:-audible}"
RESERVED_INFRA_NAMES="flywheel-terminal,flywheel-inbox,gbrain"

# shellcheck source=lib/mcp-inherit.sh
source "${SCRIPT_DIR}/lib/mcp-inherit.sh"

# FLY-231: companion gets NO user-scope MCP at all (project-scope default-deny in
# the generated .mcp.json). Note (per plan §2.4, Path A): this only controls the
# .mcp.json the launcher writes; enabled-plugin-bundled MCP still load at runtime —
# an accepted residual under the on-machine/Annie-only threat model (Codex R3).
if [ "$IS_COMPANION_ROLE" = true ] || [ "$IS_EXTERNAL_ROLE" = true ]; then
  # FLY-231/FLY-879: companion AND external inherit NO user-scope MCP (project-scope
  # default-deny in the generated .mcp.json). An external agent's only tool surface
  # is the Discord plugin adapter — no user/internal MCP.
  USER_MCP_FRAGMENT='{}'
  log "${_LOCKED_ROLE_LABEL}: no user-scope MCP inherited (.mcp.json user fragment empty)"
else
  USER_MCP_FRAGMENT=$(build_user_mcp_fragment \
    "${HOME}/.claude.json" \
    "$RESERVED_INFRA_NAMES" \
    "$LEAD_USER_MCP_BLACKLIST" \
    "${FLYWHEEL_LEAD_MCP_EXCLUDE:-}")
fi

# Atomic write — mktemp + chmod 600 + mv. Fixes prior 0644 mode that exposed
# TEAMLEAD_API_TOKEN inside flywheel-terminal env, and removes partial-read
# race during shell stdout redirect.
write_atomic_mcp_config "$MCP_CONFIG_FILE" \
  "$USER_MCP_FRAGMENT" \
  "$terminal_server" \
  "$inbox_server" \
  "$gbrain_server"
log "MCP config: ${MCP_CONFIG_FILE} (mode 0600, atomic)"

# FLY-109 (b): Pre-seed enableAllProjectMcpServers so project .mcp.json servers
# are auto-approved on resume (no interactive dialog dependency).
#
# Target: <LEAD_WORKSPACE>/.claude/settings.local.json (localSettings layer).
#
# Why this path, not ~/.claude.json:
# Upstream Claude Code reads enableAllProjectMcpServers via getSettings_DEPRECATED(),
# which returns the merged settings tree. It also runs
# migrateEnableAllProjectMcpServersToSettings() on startup: a value found at
# ~/.claude.json.projects[cwd].enableAllProjectMcpServers is copied to localSettings
# only when localSettings.enableAllProjectMcpServers is undefined, then deleted from
# ~/.claude.json regardless. Consequence: seeding ~/.claude.json is a noop whenever
# localSettings already has a decision (especially a prior `false`), and is wiped
# on every startup. Writing localSettings directly overrides prior decisions and
# survives restarts.
#
# Each Lead owns its own workspace dir, so a per-workspace lock is sufficient.
_SETTINGS_LOCAL_JSON="${LEAD_WORKSPACE}/.claude/settings.local.json"
_MCP_LOCK_HELD=false
if command -v jq >/dev/null 2>&1; then
  mkdir -p "$(dirname "$_SETTINGS_LOCAL_JSON")" 2>/dev/null || true

  # mkdir is atomic on POSIX — serves as a spinlock for concurrent writers.
  # Stale lock detection: if lock dir is >60s old, a previous process was
  # killed mid-write. Remove it and retry. Uses -mmin +1 (integer, macOS
  # find does not support fractional minutes).
  _lock_dir="${_SETTINGS_LOCAL_JSON}.flywheel-lock"
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
    # Create empty settings.local.json if missing (fresh workspace).
    # Inside the lock to prevent concurrent creates from racing.
    if [ ! -f "$_SETTINGS_LOCAL_JSON" ]; then
      echo '{}' > "$_SETTINGS_LOCAL_JSON"
      log "MCP approval: created ${_SETTINGS_LOCAL_JSON}"
    fi

    _tmp_settings="$(mktemp "${_SETTINGS_LOCAL_JSON}.tmp.XXXXXX")"
    if jq '.enableAllProjectMcpServers = true' \
       "$_SETTINGS_LOCAL_JSON" > "$_tmp_settings" 2>/dev/null; then
      mv "$_tmp_settings" "$_SETTINGS_LOCAL_JSON"
      log "MCP approval: enableAllProjectMcpServers=true in ${_SETTINGS_LOCAL_JSON}"
    else
      rm -f "$_tmp_settings" 2>/dev/null || true
      log "WARNING: Failed to pre-seed enableAllProjectMcpServers (jq error)"
    fi
    rmdir "$_lock_dir" 2>/dev/null || true
    _MCP_LOCK_HELD=false
  else
    log "WARNING: Could not acquire lock on ${_SETTINGS_LOCAL_JSON} after 10s, skipping MCP pre-seed"
  fi
fi

# Build claude args using bash array (avoids quoting/word-splitting issues)
CLAUDE_ARGS=(
  --agent "$LEAD_ID"
  --permission-mode bypassPermissions
)

# FLY-241: per-Lead model override. When `FLYWHEEL_LEAD_MODEL` is set (per-Lead
# via the launchd plist EnvironmentVariables), pass it through as `--model` so a
# coding-heavy Lead can run a different model (e.g. claude-fable-5) while every
# other Lead keeps the account default. UNSET (the default) appends NOTHING —
# argv stays byte-identical to pre-FLY-241, asserted by the FLY-231 reverse-compat
# sentinel (T8 golden has no `--model`).
#
# Trim surrounding whitespace before the empty check so a stray-space plist value
# (e.g. " ") is treated as UNSET rather than injecting `--model "  "` — which the
# claude CLI rejects and would crash the Lead at startup (failure-path hygiene).
# Do NOT lowercase: model ids can be case-sensitive.
_fly241_lead_model="${FLYWHEEL_LEAD_MODEL:-}"
_fly241_lead_model="${_fly241_lead_model#"${_fly241_lead_model%%[![:space:]]*}"}"
_fly241_lead_model="${_fly241_lead_model%"${_fly241_lead_model##*[![:space:]]}"}"
if [ -n "$_fly241_lead_model" ]; then
  CLAUDE_ARGS+=(--model "$_fly241_lead_model")
  log "Lead model override: --model ${_fly241_lead_model} (FLY-241)"
fi

# FLY-671: per-Lead effort override. When `FLYWHEEL_LEAD_EFFORT` is set (per-Lead
# via the launchd plist, carried from projects.json → manifest → generate_plist),
# pass it through as `--effort` so a cost-sensitive Lead can run lower effort
# (xhigh→high/medium) to save tokens. This GENERALIZES the FLY-231/FLY-583
# companion pin below: an explicit valid effort wins for ANY Lead (incl. companion).
#
# enum guard (Codex design review R2 MEDIUM-4): a bad value is treated as UNSET,
# never injected. Critically, a bad explicit env must NOT both crash the CLI AND
# strip a companion's FLY-583 xhigh fallback — so an invalid value falls through
# to the companion default below, identical to "unset".
#
# Trim surrounding whitespace (same as FLY-241 model) before the enum check.
_fly671_lead_effort="${FLYWHEEL_LEAD_EFFORT:-}"
_fly671_lead_effort="${_fly671_lead_effort#"${_fly671_lead_effort%%[![:space:]]*}"}"
_fly671_lead_effort="${_fly671_lead_effort%"${_fly671_lead_effort##*[![:space:]]}"}"
case "$_fly671_lead_effort" in
  low|medium|high|xhigh|max) _fly671_effort_valid=true ;;
  "") _fly671_effort_valid=false ;;
  *) _fly671_effort_valid=false; log "WARN: ignoring invalid FLYWHEEL_LEAD_EFFORT='${_fly671_lead_effort}' (treated as unset)" ;;
esac

# FLY-231 / FLY-583: companion effort. FLY-231 originally pinned `--effort medium`
# on the theory that default/high effort triggered the "drafts a reply but never
# calls the discord reply tool → goes silent" leak (FLY-306). FLY-583 disproved
# that hypothesis with evidence: Belle leaked the reply tool-call as plain text at
# `--effort xhigh` too, so medium did NOT prevent the leak — it only capped her
# capability against Annie's explicit "keep Belle on xhigh" requirement. The real,
# effort-independent leak defense is the discord-reply-enforcer Stop hook (FLY-387),
# which catches an unexecuted reply and nudges a resend (verified recovering Belle
# live). So pin companions to xhigh (capability), never medium.
#
# Precedence (FLY-671): a valid explicit FLYWHEEL_LEAD_EFFORT overrides everything;
# otherwise a companion still gets xhigh; otherwise (non-companion, no/bad env) NO
# `--effort` flag is appended — argv stays byte-identical to pre-FLY-671 (sentinel-asserted).
if [ "$_fly671_effort_valid" = true ]; then
  CLAUDE_ARGS+=(--effort "$_fly671_lead_effort")
  log "Lead effort override: --effort ${_fly671_lead_effort} (FLY-671)"
elif [ "$IS_COMPANION_ROLE" = true ]; then
  CLAUDE_ARGS+=(--effort xhigh)
  log "Companion: --effort xhigh (FLY-583; leak defense is the discord-reply-enforcer hook, not effort)"
fi

# FLY-143: claude-in-chrome — env-gated, default OFF.
# `--chrome` + `--permission-mode bypassPermissions` together set
# CLAUDE_CHROME_PERMISSION_MODE=skip_all_permission_checks (verified upstream
# in setup.ts:101-104). That gives an autonomous Lead access to Annie's
# logged-in Chrome session without per-site friction. Keep this opt-in.
#
# Wrapper reads `chromeEnabled: true` from manifest and exports the env var.
# To enable for one Lead: set "chromeEnabled": true in its manifest, restart.
if [ "${FLYWHEEL_LEAD_CHROME_ENABLED:-false}" = "true" ]; then
  CLAUDE_ARGS+=(--chrome)
  log "Claude in Chrome: ENABLED (--chrome flag set)"
  log "WARNING: Lead operates in Annie's logged-in Chrome session with skip_all_permission_checks"
else
  log "Claude in Chrome: disabled (set FLYWHEEL_LEAD_CHROME_ENABLED=true to enable)"
fi

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

# ── FLY-26 + FLY-127 R3: Append shared rule files to system prompt ──────────
# Two-layer extension model (FLY-127 R3):
#   1. flywheel BASE layer (this script's repo, lead-rules-base/) — abstract behavior
#      contracts, project-agnostic ("each dept Lead", "your dept", "the cos-lead role").
#   2. PROJECT layer (synced into LEAD_RULES_DIR from <project>/.lead/shared/) —
#      concrete instantiation: dept-name → Lead-name mapping, Bridge endpoints,
#      channel IDs, project-specific tone.
#
# Load order: BASE first, PROJECT second. Project rules sit "on top of" base
# (class extension semantics). Where both touch the same topic, the later
# (project) wins per Claude prompt-stacking — but project authors should
# treat that as a yellow flag and prefer extension over override.
#
# Files:
#   common-rules.md (project): loaded by ALL leads (style, memory, MCP, capability)
#   department-lead-rules.md (BASE + project): non-cos leads only
#                                              (FLY-127 Action Gate, Multi-Lead, Bridge rejection)
#   cos-lead-rules.md (BASE only, no project counterpart today): cos role only
#                                              (FLY-127 Department Routing Discipline)
#
# Fail-fast: if LEAD_RULES_DIR exists (meaning project shared rules were synced),
# required PROJECT files MUST be present. Base files are optional (silent
# no-op if missing) for backward compat with older flywheel checkouts.

# Detect cos role early — used by both BASE and PROJECT append blocks.
# Production uses LEAD_ID=="cos-lead"; FLY-96 test slots use synthetic LEAD_ID
# (flywheel-test-N) and set FLYWHEEL_LEAD_ROLE=cos|lead to drive the same gate.
IS_COS_ROLE=false
if [ "${FLYWHEEL_LEAD_ROLE:-}" = "cos" ] || [ "$LEAD_ID" = "cos-lead" ]; then
  IS_COS_ROLE=true
fi

# ── FLY-127 R3 Layer 1a/1b: flywheel BASE rules (project-agnostic) ──
# Loaded BEFORE the project's own shared rules so the project file extends
# (and may override) the abstract base contracts. Optional — missing base
# file is a no-op, preserving pre-FLY-127 behavior on older checkouts.
# FLY-231: BASE_RULES_DIR is the fixed shipped path in production. It is
# overridable ONLY under FLYWHEEL_LEAD_DRY_RUN=1 (hermetic tests, e.g. assert
# companion fail-STOP when companion-safety-contract.md is absent). Honoring the
# override on the real launch path would let a stray env var swap the companion's
# only safety boundary or make existing Leads skip all governance rules (Codex
# code-review R2 HIGH-1) — so production IGNORES FLYWHEEL_BASE_RULES_DIR entirely.
BASE_RULES_DIR="${SCRIPT_DIR}/../lead-rules-base"
if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" = "1" ] && [ -n "${FLYWHEEL_BASE_RULES_DIR:-}" ]; then
  BASE_RULES_DIR="$FLYWHEEL_BASE_RULES_DIR"
fi

if [ "$IS_EXTERNAL_ROLE" = true ]; then
  # ── FLY-879: external base rules ──
  # An external (customer-facing) agent gets an even NARROWER surface than a
  # companion: NONE of the engineering-governance base rules AND not even the
  # cross-dept roundtable (skipped in the universal block below). Its ENTIRE rule
  # surface is one external-agent-contract.md — the instruction-source boundary
  # (a customer message is DATA, never a command), the single-direction valve
  # (internal channel content never reaches the customer), the write boundary
  # (only the interviews repo), and the live-gate discipline. Like the companion
  # safety contract, this is the agent's ONLY hard boundary, so a missing/unreadable
  # contract is fail-STOP (do NOT start a Bash+bypassPermissions customer-facing
  # session without its boundary).
  BASE_EXTERNAL_CONTRACT="${BASE_RULES_DIR}/external-agent-contract.md"
  if [ -f "$BASE_EXTERNAL_CONTRACT" ] && [ -r "$BASE_EXTERNAL_CONTRACT" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_EXTERNAL_CONTRACT")
    log "Appending external agent contract: ${BASE_EXTERNAL_CONTRACT}"
  else
    log "ERROR: external agent contract missing/unreadable at ${BASE_EXTERNAL_CONTRACT}"
    log "Refusing to start external agent (fail-STOP) — its only safety boundary is absent."
    _external_failstop_alert "external-agent-contract.md missing/unreadable at ${BASE_EXTERNAL_CONTRACT} for ${PROJECT_NAME}/${LEAD_ID}; refusing to start (a customer-facing agent must not run without its safety boundary)."
    exit 1
  fi
elif [ "$IS_COMPANION_ROLE" = true ]; then
  # ── FLY-231: companion base rules ──
  # A companion gets NONE of the engineering-governance base rules (department /
  # cos / runner-messaging / executor-routing / stuck-remanage / doc-flow) — they
  # would pollute the persona, which is the whole product. In their place, one
  # short safety contract (replaces founder-only-authority's reserved-action guard
  # below, which is also skipped for companion). cross-dept rules still load
  # (companion is in #leads-roundtable) — see the universal block further down.
  BASE_COMPANION_SAFETY="${BASE_RULES_DIR}/companion-safety-contract.md"
  if [ -f "$BASE_COMPANION_SAFETY" ] && [ -r "$BASE_COMPANION_SAFETY" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_COMPANION_SAFETY")
    log "Appending companion safety contract: ${BASE_COMPANION_SAFETY}"
  else
    # FLY-231 (Codex code-review HIGH-2): fail-STOP, do NOT start. The companion
    # also skips founder-only-authority, so this contract is its ONLY hard
    # behavioral boundary. Starting a Bash + bypassPermissions session without it
    # is worse than not starting. (Dry-run still emits the plan + exits cleanly so
    # the test harness can observe; only a real launch is refused.)
    log "ERROR: companion safety contract missing/unreadable at ${BASE_COMPANION_SAFETY}"
    log "Refusing to start companion (fail-STOP) — its only safety boundary is absent."
    _companion_failstop_alert "companion-safety-contract.md missing/unreadable at ${BASE_COMPANION_SAFETY} for ${PROJECT_NAME}/${LEAD_ID}; refusing to start (a companion must not run without its safety boundary)."
    exit 1
  fi
elif [ "$IS_COS_ROLE" = false ]; then
  # Department Lead base: Action Gate + Multi-Lead Mentions + Bridge rejection diagnostics
  BASE_DEPT_RULES="${BASE_RULES_DIR}/department-lead-rules.md"
  if [ -f "$BASE_DEPT_RULES" ] && [ -r "$BASE_DEPT_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_DEPT_RULES")
    log "Appending base dept-lead rules: ${BASE_DEPT_RULES}"
  fi
  # FLY-142 PR #186 Codex Round 1 HIGH: dept leads spawn + DM Runners, so
  # they MUST be told to use `SendMessage` MCP for ordinary DM (mailbox
  # path) rather than `flywheel-comm send` (suppressed by sentinel once
  # mailbox cutover is active — silent message loss otherwise).
  #
  # FLY-142 PR #186 codex:rescue Bug B: ONLY load this rule on the mailbox
  # path. On the `FLYWHEEL_COMM_BACKEND=commdb` rollback path, `run-dispatcher.ts:buildAgentTeamIdentity`
  # returns `{}` so Runner spawns without Agent Team identity → Lead writes
  # mailbox via SendMessage but nobody polls it → silent message loss. Skip
  # the rule on rollback so Lead falls back to the legacy `flywheel-comm send`
  # CommDB path that the rolled-back Runner side actually reads.
  #
  # codex:rescue Round 2 MEDIUM: also trim leading/trailing whitespace —
  # an operator who writes `FLYWHEEL_COMM_BACKEND=" commdb "` in their
  # `.env` would otherwise be routed as mailbox because the raw value has
  # spaces. Mirror the lenient parse used by `plugin.ts:resolveCommBackend`.
  _runnermsg_backend=$(normalize_comm_backend)
  if [ "$_runnermsg_backend" != "commdb" ]; then
    BASE_RUNNER_MSG_RULES="${BASE_RULES_DIR}/runner-messaging-rules.md"
    if [ -f "$BASE_RUNNER_MSG_RULES" ] && [ -r "$BASE_RUNNER_MSG_RULES" ]; then
      CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_RUNNER_MSG_RULES")
      log "Appending base runner-messaging rules: ${BASE_RUNNER_MSG_RULES}"
    fi
  else
    log "FLYWHEEL_COMM_BACKEND=commdb (rollback): skipping runner-messaging-rules.md so Lead stays on legacy flywheel-comm path consistent with Runner spawn"
  fi
  unset _runnermsg_backend

  # ── FLY-178: Executor Routing by Work Type (non-cos dept leads only) ──
  # Leads route to the executor that owns the issue end to end, chosen by the
  # ACTUAL work type (pass agentName), not just the issue label. This is
  # spawn-only behavior, so only non-cos roles (which spawn Runners) load it.
  # Placed OUTSIDE the FLYWHEEL_COMM_BACKEND=commdb guard above on purpose:
  # executor routing is independent of the Runner messaging transport and must
  # load on both the mailbox and commdb-rollback paths. Optional — missing
  # base file is a no-op (backward compat with older flywheel checkouts).
  BASE_EXECUTOR_ROUTING_RULES="${BASE_RULES_DIR}/executor-routing.md"
  if [ -f "$BASE_EXECUTOR_ROUTING_RULES" ] && [ -r "$BASE_EXECUTOR_ROUTING_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_EXECUTOR_ROUTING_RULES")
    log "Appending base executor-routing rules: ${BASE_EXECUTOR_ROUTING_RULES}"
  fi

  # ── FLY-728: Model Routing by task difficulty (non-cos dept leads only) ──
  # The Lead is the difficulty sorter: at dispatch it judges an issue's
  # difficulty from signals (labels / title / description) and passes a model
  # tier on /api/runs/start (heavy→Fable / … / trivial→Haiku). A manual model
  # label wins; genuinely unsure → ask the founder. Only roles that spawn
  # Runners load it. Optional — missing base file is a no-op (backward compat).
  BASE_MODEL_ROUTING_RULES="${BASE_RULES_DIR}/model-routing.md"
  if [ -f "$BASE_MODEL_ROUTING_RULES" ] && [ -r "$BASE_MODEL_ROUTING_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_MODEL_ROUTING_RULES")
    log "Appending base model-routing rules: ${BASE_MODEL_ROUTING_RULES}"
  fi

  # ── FLY-195: Stuck-Runner Re-Manage (non-cos dept leads only) ──
  # Defines how a Lead judges + re-manages a runner_stuck_escalation event
  # (ladder: mailbox wake → restricted recovery nudge; disposition receipts;
  # Annie ping cadence). Only roles that manage Runners load it. Loaded on
  # BOTH messaging backends (the ladder references "your normal Runner
  # messaging path", which the runner-messaging rules define per backend).
  # Optional — missing base file is a no-op (backward compat).
  BASE_STUCK_REMANAGE_RULES="${BASE_RULES_DIR}/stuck-runner-remanage.md"
  if [ -f "$BASE_STUCK_REMANAGE_RULES" ] && [ -r "$BASE_STUCK_REMANAGE_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_STUCK_REMANAGE_RULES")
    log "Appending base stuck-runner-remanage rules: ${BASE_STUCK_REMANAGE_RULES}"
  fi

  # ── FLY-229: Runner Re-Engage vs Terminate (non-cos dept leads only) ──
  # Iteration-loop standard op: a parked-alive runner (finished one round, tmux +
  # agent still idle/alive) is RE-ENGAGEABLE via the normal Runner messaging path
  # — don't terminate + new-run. Only roles that manage Runners load it. Optional
  # — missing base file is a no-op (backward compat).
  BASE_REENGAGE_RULES="${BASE_RULES_DIR}/runner-reengage-rules.md"
  if [ -f "$BASE_REENGAGE_RULES" ] && [ -r "$BASE_REENGAGE_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_REENGAGE_RULES")
    log "Appending base runner-reengage rules: ${BASE_REENGAGE_RULES}"
  fi

  # ── FLY-369: Runner status relay + proactive patrol (dept leads that manage
  # Runners). RC-1 (relay every lifecycle event to the [FLY-XX] thread +
  # runner-done≠accepted), RC-2 (drive a parked Runner via a waking channel,
  # never `respond` for non-gate), RC-3 (proactively sweep your Runners via
  # runner_terminal_list), RC-6 (continuation Runner reads the committed plan
  # first). These are backend-INDEPENDENT, so — unlike runner-messaging-rules —
  # this loads on BOTH the mailbox and the commdb rollback path (its RC-2 section
  # is self-contained for commdb). Discipline only; the automation engine belongs
  # to FLY-271 / FLY-368. Optional — missing base file is a no-op (backward compat).
  BASE_PATROL_RULES="${BASE_RULES_DIR}/runner-patrol-rules.md"
  if [ -f "$BASE_PATROL_RULES" ] && [ -r "$BASE_PATROL_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_PATROL_RULES")
    log "Appending base runner-patrol rules: ${BASE_PATROL_RULES}"
  fi

  # ── FLY-205: Doc-Flow tier judgment + founder notification (non-cos dept
  # leads only). Judging the doc tier and passing `docTier` at spawn is
  # spawn-only behavior — cos-lead (canSpawnRunners: false) must not load it
  # (Codex design R1 #6). The rule text itself is conditional on the project
  # enabling doc_flow in .flywheel/config.yaml (self-check via
  # $FLYWHEEL_PROJECT_DIR); un-enabled projects see zero behavior change.
  # Optional — missing base file is a no-op (backward compat).
  BASE_DOC_FLOW_RULES="${BASE_RULES_DIR}/doc-flow-rules.md"
  if [ -f "$BASE_DOC_FLOW_RULES" ] && [ -r "$BASE_DOC_FLOW_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_DOC_FLOW_RULES")
    log "Appending base doc-flow rules: ${BASE_DOC_FLOW_RULES}"
  fi

  # ── FLY-579: auto-QA pipeline contract (non-cos dept leads only) ──
  # Describes the automatic code-review → independent-QA → founder-gate flow so a
  # Lead never has to remember to spawn QA and never surfaces the founder before
  # QA is green. INERT unless the project opts in (qa.auto in its config.yaml);
  # the prose is harmless on non-opted-in projects. Optional — missing base file
  # is a no-op (backward compat with older flywheel checkouts).
  BASE_AUTO_QA_RULES="${BASE_RULES_DIR}/auto-qa-pipeline.md"
  if [ -f "$BASE_AUTO_QA_RULES" ] && [ -r "$BASE_AUTO_QA_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_AUTO_QA_RULES")
    log "Appending base auto-QA pipeline rules: ${BASE_AUTO_QA_RULES}"
  fi

  # ── FLY-707 (FLY-698 epic): Default-Enable Policy (non-cos dept leads only) ──
  # Built features ship ENABLED for the project (config opt-ins like qa.auto /
  # doc_flow, default-off env flags), not left dormant behind an un-flipped
  # opt-in — with security/governance gates (founder_consent, founder_ux_gate,
  # branch protection) EXPLICITLY EXEMPT (flipping those blindly can wedge
  # merge/ship). Pure guidance prose; harmless everywhere. Optional — missing
  # base file is a no-op (backward compat with older flywheel checkouts).
  BASE_DEFAULT_ENABLE_RULES="${BASE_RULES_DIR}/default-enable-policy.md"
  if [ -f "$BASE_DEFAULT_ENABLE_RULES" ] && [ -r "$BASE_DEFAULT_ENABLE_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_DEFAULT_ENABLE_RULES")
    log "Appending base default-enable policy: ${BASE_DEFAULT_ENABLE_RULES}"
  fi

  # ── FLY-222: Xiaohongshu memory-write delegation (non-cos dept leads only) ──
  # A xiaohongshu-learning Runner holds NO Bridge /api/* token by design
  # (FLY-175 least-privilege), so it delegates its "things learned" → memory
  # write to its spawning Lead (path B): the Lead writes via /api/memory/add
  # with its own TEAMLEAD_API_TOKEN, idempotent on op_id/run_key, then acks.
  # Only roles that spawn Runners receive such requests, so cos-lead
  # (canSpawnRunners: false) does not load it. The rule is INERT unless a
  # [XHS-MEMORY-WRITE] request actually arrives (projects without
  # xiaohongshu_learning config never see it). Optional — missing base file is a
  # no-op (backward compat with older flywheel checkouts).
  BASE_XHS_MEMORY_RULES="${BASE_RULES_DIR}/xiaohongshu-memory-rules.md"
  if [ -f "$BASE_XHS_MEMORY_RULES" ] && [ -r "$BASE_XHS_MEMORY_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_XHS_MEMORY_RULES")
    log "Appending base xiaohongshu-memory rules: ${BASE_XHS_MEMORY_RULES}"
  fi
else
  # Cos-lead base: Department Routing Discipline (one Lead per spawn message)
  BASE_COS_RULES="${BASE_RULES_DIR}/cos-lead-rules.md"
  if [ -f "$BASE_COS_RULES" ] && [ -r "$BASE_COS_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_COS_RULES")
    log "Appending base cos-lead rules: ${BASE_COS_RULES}"
  fi
fi

# ── FLY-175: Founder-Only Authority (universal — both cos and dept roles) ──
# The two reserved actions (merge-to-main, stop-runner) are founder-only.
# This rule loads for EVERY Lead role, regardless of cos vs dept, because
# any Lead with Bridge action credentials could otherwise invoke them.
# Optional — missing base file is a no-op (pre-FLY-175 backward compat).
BASE_FOUNDER_AUTH_RULES="${BASE_RULES_DIR}/founder-only-authority.md"
if [ "$IS_COMPANION_ROLE" != true ] && [ "$IS_EXTERNAL_ROLE" != true ] && [ -f "$BASE_FOUNDER_AUTH_RULES" ] && [ -r "$BASE_FOUNDER_AUTH_RULES" ]; then
  # FLY-231/FLY-879: companion AND external skip this 20KB reserved-action contract
  # — the short companion-safety-contract.md / external-agent-contract.md (above)
  # covers each one's boundary in a non-engineering tone.
  CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_FOUNDER_AUTH_RULES")
  log "Appending base founder-only-authority rules: ${BASE_FOUNDER_AUTH_RULES}"
fi

# ── FLY-598 / FLY-869: Founder brainstorm-alignment gate (universal — cos + dept, NOT companion) ──
# Loads UNLESS this project EXPLICITLY disables the founder-UX gate
# (founder_ux_gate.mode: off in .flywheel/config.yaml). FLY-869 flips the
# default from opt-in to default-ON — an ABSENT founder_ux_gate block (or an
# absent config file entirely) now resolves to "enforce" (mirrors
# resolveEffectiveFounderUxConfig in flywheel-config), so this block is
# appended for the common case. Only an EXPLICIT `mode: off` keeps the
# pre-FLY-598 byte-compatible zero-prompt-change behavior (Codex R3-#3 / R2-#6
# byte-compat, preserved for that one escape hatch). Guides whoever
# writes/triages issues (cos + dept) that every substantial issue is gated by
# default and only the `brainstorm-exempt` label opts an issue OUT; judgment
# is model-driven loose guidance, the enforcement is the Bridge gate.
BASE_FOUNDER_UX_RULES="${BASE_RULES_DIR}/founder-ux-rules.md"
if [ "$IS_COMPANION_ROLE" != true ] && [ "$IS_EXTERNAL_ROLE" != true ] && [ -f "$BASE_FOUNDER_UX_RULES" ] && [ -r "$BASE_FOUNDER_UX_RULES" ]; then
  # Read founder_ux_gate.mode from the project config WITHOUT aborting under
  # `set -euo pipefail`: only awk when the config file exists, and `|| true` so a
  # missing/malformed config (awk exit != 0) never kills the launch. This is why
  # doc-flow-rules above self-checks inside the rule file instead — this block is
  # the one shell-side read.
  FOUNDER_UX_MODE=""
  _founder_ux_cfg="${PROJECT_DIR}/.flywheel/config.yaml"
  if [ -f "$_founder_ux_cfg" ]; then
    FOUNDER_UX_MODE="$(awk '
      /^founder_ux_gate:/ { inblk=1; next }
      inblk && /^[^[:space:]]/ { inblk=0 }
      inblk && $1 == "mode:" { v=$2; gsub(/["'"'"',]/, "", v); print v; exit }
    ' "$_founder_ux_cfg" 2>/dev/null || true)"
  fi
  # FLY-869: absent config (no file / no founder_ux_gate block / no mode key —
  # FOUNDER_UX_MODE still empty here) now DEFAULTS TO "enforce", mirroring
  # resolveEffectiveFounderUxConfig's absent → enforce resolution. Only an
  # EXPLICIT `mode: off` in the project config stays the byte-compatible
  # no-append kill-switch.
  if [ -z "$FOUNDER_UX_MODE" ]; then
    FOUNDER_UX_MODE="enforce"
  fi
  # FLY-900: fleet-wide kill-switch — the founder-UX signoff gate is retired by
  # default. Only append the founder-ux rules when the switch is explicitly
  # re-enabled (FLYWHEEL_FOUNDER_UX_GATE_ENABLED=1), matching the TS helper
  # isFounderUxGateEnabled (=== "1"). Disabled → the Lead is not handed the
  # founder-ux rules at all.
  if [ "${FLYWHEEL_FOUNDER_UX_GATE_ENABLED:-}" = "1" ] && [ "$FOUNDER_UX_MODE" != "off" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_FOUNDER_UX_RULES")
    log "Appending base founder-ux rules (founder_ux_gate.mode=${FOUNDER_UX_MODE}): ${BASE_FOUNDER_UX_RULES}"
  fi
fi

# ── FLY-203: Founder HTML delivery (universal — both roles) ──
# Any HTML artifact the founder asks to see must be delivered via
# `flywheel-comm publish-report` (one message: title + full-page image +
# link), never as a local file path. Loads for EVERY Lead role.
# Optional — missing base file is a no-op (pre-FLY-203 backward compat).
BASE_HTML_DELIVERY_RULES="${BASE_RULES_DIR}/founder-html-delivery.md"
if [ "$IS_COMPANION_ROLE" != true ] && [ "$IS_EXTERNAL_ROLE" != true ] && [ -f "$BASE_HTML_DELIVERY_RULES" ] && [ -r "$BASE_HTML_DELIVERY_RULES" ]; then
  # FLY-231/FLY-879: companion + external produce no founder HTML reports — skip.
  CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_HTML_DELIVERY_RULES")
  log "Appending base founder-html-delivery rules: ${BASE_HTML_DELIVERY_RULES}"
fi

# ── FLY-223: Cross-Department Lead Channel (universal — both roles) ──
# Behavior + five-Lead roster for the shared #leads-roundtable channel where all
# five Leads are present at once. Loads for EVERY Lead role (cos + dept) because
# every Lead participates. The rule is inert unless the Lead's identity.md also
# whitelists the cross-department channel ID (so older checkouts / projects that
# have not joined the channel see zero behavior change). Optional — missing base
# file is a no-op (pre-FLY-223 backward compat).
BASE_CROSS_DEPT_RULES="${BASE_RULES_DIR}/cross-dept-channel-rules.md"
# FLY-879: external agents (Anna) are NOT roundtable members and must never see the
# internal Lead roster / cross-dept coordination surface — skip (companion keeps it,
# it IS a roundtable member). This is why external ≠ "companion with a different name".
if [ "$IS_EXTERNAL_ROLE" != true ] && [ -f "$BASE_CROSS_DEPT_RULES" ] && [ -r "$BASE_CROSS_DEPT_RULES" ]; then
  CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_CROSS_DEPT_RULES")
  log "Appending base cross-dept-channel rules: ${BASE_CROSS_DEPT_RULES}"
fi

# ── FLY-387: Discord outbound reply output-contract (universal — ALL roles) ──
# Soft probability-reducer complementing the discord-reply-enforcer Stop hook
# (candidate 2): always EXECUTE the reply tool, never emit its <invoke> XML as
# plain text. Loads for EVERY Lead role INCLUDING companion (Belle was the
# recurring victim) — every Lead replies on Discord, so no companion guard.
# Optional — missing base file is a no-op (backward compat with older checkouts).
BASE_DISCORD_REPLY_CONTRACT="${BASE_RULES_DIR}/discord-reply-contract.md"
# FLY-879: external agents keep a deliberately minimal, auditable rule surface —
# EXACTLY one file (external-agent-contract.md). Skip this soft output-contract too
# (the discord-reply-enforcer Stop hook — installed for EVERY role incl. external —
# is the real, effort-independent reply-leak defense; the prose is redundant here).
if [ "$IS_EXTERNAL_ROLE" != true ] && [ -f "$BASE_DISCORD_REPLY_CONTRACT" ] && [ -r "$BASE_DISCORD_REPLY_CONTRACT" ]; then
  CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_DISCORD_REPLY_CONTRACT")
  log "Appending base discord-reply-contract rules: ${BASE_DISCORD_REPLY_CONTRACT}"
fi

# ── FLY-26: project-side shared rules (concrete data) ──
# FLY-879: external agents never append the project's common/department rules —
# their surface is contract-only, and those rules are internal engineering data.
# (The sync above already skipped staging them; this guard is belt-and-suspenders
# against a stale LEAD_RULES_DIR.)
if [ "$IS_EXTERNAL_ROLE" != true ] && [ -d "$LEAD_RULES_DIR" ]; then
  COMMON_RULES="${LEAD_RULES_DIR}/common-rules.md"
  if [ ! -f "$COMMON_RULES" ] || [ ! -r "$COMMON_RULES" ]; then
    echo "[lead] ERROR: Required shared rule file missing or unreadable: ${COMMON_RULES}"
    echo "[lead] Source should be: ${SHARED_RULES_DIR}/common-rules.md"
    exit 1
  fi
  CLAUDE_ARGS+=(--append-system-prompt-file "$COMMON_RULES")
  log "Appending common rules: ${COMMON_RULES}"

  # Department lead rules — only for non-cos roles (manage Runners). Cos-lead
  # (Simba role) does not load this file because it doesn't spawn Runners.
  # FLY-231: companion also skips the dept-rules requirement (R5 HIGH-5) — a
  # companion never manages Runners even if its project somehow has .lead/shared.
  if [ "$IS_COS_ROLE" = false ] && [ "$IS_COMPANION_ROLE" != true ]; then
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
# GEO-151 L3: macOS screencapture skill (Lead-side)
# ════════════════════════════════════════════════════════════════
#
# Append a small prompt that teaches the Lead model how to invoke
# `screencapture -l` via the find-window.sh helper when Annie explicitly
# asks for a window screenshot. The skill includes a narrow trigger
# contract so it doesn't false-fire on PR / code / discussion mentions.
#
# Env-gate: `LEAD_DISABLE_SCREENCAPTURE_SKILL=1` skips this entirely.
# Useful when iterating on the trigger contract or when Annie wants the
# skill off for a particular Lead. Export FLYWHEEL_TEAMLEAD_SCRIPT_DIR
# so the prompt can find `find-window.sh` by an explicit path.
export FLYWHEEL_TEAMLEAD_SCRIPT_DIR="$SCRIPT_DIR"

if [ "$IS_COMPANION_ROLE" = true ] || [ "$IS_EXTERNAL_ROLE" = true ]; then
  # FLY-231/FLY-879: companion + external have no screenshot duty — skip the L3
  # screencapture skill (an external agent must never read the founder's screen).
  log "${_LOCKED_ROLE_LABEL}: L3 screencapture skill skipped"
elif [ "${LEAD_DISABLE_SCREENCAPTURE_SKILL:-0}" != "1" ]; then
  SCREENCAP_SKILL="${SCRIPT_DIR}/screencapture-l3-skill.md"
  if [ -f "$SCREENCAP_SKILL" ] && [ -r "$SCREENCAP_SKILL" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$SCREENCAP_SKILL")
    log "Appending L3 screencapture skill: ${SCREENCAP_SKILL}"
  else
    log "WARNING: L3 screencapture skill missing at ${SCREENCAP_SKILL} — screencapture skill not loaded"
  fi
else
  log "L3 screencapture skill disabled via LEAD_DISABLE_SCREENCAPTURE_SKILL=1"
fi

# ════════════════════════════════════════════════════════════════
# FLY-142 PR 1.2: Vendor-neutral Agent Team transport wiring
# ════════════════════════════════════════════════════════════════
#
# Per plan v1.27.1 §2.0.4-bis (Codex r1 critical #2 + r2 high #4):
# - `agent-team-transport lead-env` emits `export KEY=$'value'` lines for
#   `eval` (bash 3.2+ compat — `declare -g` not supported on macOS).
# - `agent-team-transport lead-args` emits `FLYWHEEL_AGENT_TEAM_ARGS=( ... )`
#   array assignment, also for `eval`.
# - DOUBLE-quoted `eval "$(...)"` is safe vs word-splitting because the CLI
#   emits ANSI-C `$'...'`-quoted values that survive eval intact.
#
# Default `FLYWHEEL_AGENT_BACKEND=claude-code`. Set `FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT=1`
# to bypass preflight (for emergency / dev iteration).

if [ "$IS_COMPANION_ROLE" = true ] || [ "$IS_EXTERNAL_ROLE" = true ]; then
  # FLY-231/FLY-879: companion AND external have no Runner mailbox / Agent Team need
  # — skip the entire transport wiring (preflight, lead-env merge, lead-args). No
  # mailbox identity is injected; they talk via the Discord plugin only (an external
  # agent has no internal peers to message).
  log "${_LOCKED_ROLE_LABEL}: skipping Agent Team transport wiring (no Runner mailbox)"
elif command -v agent-team-transport >/dev/null 2>&1; then
  # Preflight gate: refuse to start Lead if backend is broken.
  if [ "${FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT:-0}" != "1" ]; then
    if ! agent-team-transport preflight >/dev/null 2>&1; then
      log "FATAL: agent-team-transport preflight failed — refusing to start Lead"
      log "(Set FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT=1 to bypass — emergency only)"
      agent-team-transport preflight 1>&2 || true
      exit 1
    fi
    log "Agent Team transport: preflight OK (vendor=$(agent-team-transport vendor 2>/dev/null || echo unknown))"
  else
    log "Agent Team transport: preflight SKIPPED (FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT=1)"
  fi

  # Source vendor-supplied env vars (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS etc.).
  # These are exported into the launcher shell; `_launch_claude` propagates
  # them into the tmux pane via env_args (see below).
  #
  # Codex r1 PR 1.2 MEDIUM: capture output FIRST and check exit status before
  # eval. `eval "$(false)"` does not propagate failure under `set -e`, so a
  # broken helper would silently continue with empty env → claude-code's
  # `isAgentSwarmsEnabled()` returns false even though identity flags were
  # added to CLAUDE_ARGS.
  if ! _lead_env_output=$(agent-team-transport lead-env --lead-id "${LEAD_ID}"); then
    log "FATAL: agent-team-transport lead-env failed — refusing to start Lead"
    exit 1
  fi
  eval "${_lead_env_output}"
  unset _lead_env_output

  # Same exit-status check for lead-args.
  if ! _lead_args_output=$(agent-team-transport lead-args --lead-id "${LEAD_ID}"); then
    log "FATAL: agent-team-transport lead-args failed — refusing to start Lead"
    exit 1
  fi
  eval "${_lead_args_output}"
  unset _lead_args_output

  # Post-eval assertion: env vars MUST be set after eval. Catches helper
  # regression where output is well-formed bash but doesn't set what we expect.
  if [ "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-}" != "1" ]; then
    log "FATAL: agent-team-transport lead-env did not set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"
    log "  (got: '${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-<unset>}')"
    exit 1
  fi

  # FLY-142 PR #186 codex:rescue Bug B: on the `FLYWHEEL_COMM_BACKEND=commdb`
  # rollback path the Runner is spawned WITHOUT Agent Team identity (per
  # `run-dispatcher.ts:buildAgentTeamIdentity`), so merging the Lead's own
  # `--agent-id @<team>` etc. into CLAUDE_ARGS would put Lead on a mailbox
  # path nobody polls. Skip the merge so Lead stays on legacy CommDB+hook
  # behavior consistent with the rolled-back Runner side.
  #
  # codex:rescue Round 2 MEDIUM: also trim leading/trailing whitespace via
  # the shared `normalize_comm_backend` helper.
  _agentteam_backend=$(normalize_comm_backend)
  if [ "$_agentteam_backend" = "commdb" ]; then
    log "FLYWHEEL_COMM_BACKEND=commdb (rollback): NOT merging FLYWHEEL_AGENT_TEAM_ARGS into CLAUDE_ARGS (Runner has no Agent Team identity in this mode)"
  elif [ "${#FLYWHEEL_AGENT_TEAM_ARGS[@]}" -gt 0 ]; then
    CLAUDE_ARGS+=( "${FLYWHEEL_AGENT_TEAM_ARGS[@]}" )
    log "Agent Team transport: merged ${#FLYWHEEL_AGENT_TEAM_ARGS[@]} identity flag(s) into CLAUDE_ARGS"
  fi
  unset _agentteam_backend
else
  # FLY-142 PR #186 Codex Round 1 HIGH: silently skipping wiring is fatal
  # when mailbox is the active backend — Bridge will still write to the
  # vendor mailbox, but Lead's claude-code won't load Agent Team identity,
  # `useInboxPoller` won't activate, and inbound DMs land in a file no one
  # reads. Refuse to start unless caller is explicitly on the commdb
  # rollback path (FLYWHEEL_COMM_BACKEND=commdb) — same env Bridge uses to
  # pick CommDBLeadRuntime, so the two stay consistent.
  # codex:rescue Round 2 MEDIUM: use the shared `normalize_comm_backend`
  # helper so whitespace-in-env-value (e.g. `=" commdb "`) also routes to
  # the rollback path consistently with the other two gates above.
  _commbackend_raw="${FLYWHEEL_COMM_BACKEND:-mailbox}"
  _commbackend_lc=$(normalize_comm_backend)
  if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" = "1" ]; then
    # FLY-231 dry-run: the isolated launch-plan test has no agent-team-transport
    # on PATH. Skip the wiring (and its mailbox-backend FATAL) — transport
    # contributes env + identity args that are out of scope for the rule/MCP/cred
    # byte-compat assertions and are unchanged by the companion edit.
    log "DRY-RUN: agent-team-transport CLI not on PATH — skipping wiring (no FATAL)"
  elif [ "$_commbackend_lc" = "commdb" ]; then
    log "Agent Team transport: agent-team-transport CLI not on PATH (skipping wiring — FLYWHEEL_COMM_BACKEND=commdb rollback path active)"
  else
    log "FATAL: agent-team-transport CLI not on PATH but FLYWHEEL_COMM_BACKEND='${_commbackend_raw}' selects the mailbox path"
    log "  (Lead must be a claude-code teammate to read inbound mailbox DMs; otherwise messages drop silently)"
    log "  Fix: install/build agent-team-transport in the launcher PATH, OR set FLYWHEEL_COMM_BACKEND=commdb to use the legacy CommDB+hook path"
    exit 1
  fi
  unset _commbackend_raw _commbackend_lc
fi

# ════════════════════════════════════════════════════════════════
# Layer 2: Recovery Loop
# ════════════════════════════════════════════════════════════════

# FLY-231 dry-run: CLAUDE_ARGS + env + MCP are now fully assembled. Emit the
# structured launch plan and exit BEFORE the supervisor loop, PID file, bootstrap,
# and any tmux launch — zero production side effects (tests isolate HOME so the
# manifest/identity/.mcp.json writes above land in a throwaway dir).
if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" = "1" ]; then
  log "DRY-RUN: emitting launch plan (no tmux / no bootstrap / no launch)"
  _launch_claude "${CLAUDE_ARGS[@]}" --session-id "DRY-RUN-SESSION"
  exit 0
fi

# ── FLY-282: self-healing roundtable allowBots provisioning ──────────────────
# The Discord plugin drops a bot-authored message unless the author's bot id is
# in this Lead's access.json `allowBots`. That whitelist was hand-maintained, so
# sibling Lead bots couldn't @-mention each other in #leads-roundtable
# (Cass→Simba, 2026-06-16). Here each Lead resolves its OWN authoritative bot id
# (token → Discord /users/@me), publishes it to a shared registry, and unions
# every registered peer id into its own allowBots — idempotent, atomic, and
# self-healing on every restart. Runs ONCE before the supervisor loop; the
# dry-run path above already exited, so the launch-plan sentinel stays byte-compat.
# Best-effort (`|| true`): a provisioning failure must never abort a Lead launch.
# No-op unless this Lead is a roundtable member AND the cross-dept channel env is
# set (reuses the FLY-267 env; no new hardcoded roster/channel constant).
if [ -n "${FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS:-}" ] && [ -n "${DISCORD_BOT_TOKEN:-}" ]; then
  _rt_cli="${SCRIPT_DIR}/../dist/roundtable-allowbots-cli.js"
  if [ -f "$_rt_cli" ]; then
    log "FLY-282: reconciling roundtable allowBots for ${LEAD_ID}"
    node "$_rt_cli" \
      --lead-id "$LEAD_ID" \
      --token-env DISCORD_BOT_TOKEN \
      --access-file "${DISCORD_STATE_DIR}/access.json" \
      --registry-dir "${FLYWHEEL_ROUNDTABLE_REGISTRY_DIR:-${HOME}/.flywheel/roundtable-registry}" \
      --channel-ids "$FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS" || true
  else
    log "FLY-282: roundtable-allowbots CLI not built ($_rt_cli) — skip (run: pnpm -F flywheel-teamlead build)"
  fi
fi

# ── FLY-898: fleet-wide core-room reply discipline (non-CoS Claude lead) ─────
# In a project's core room (generalChannel) a NON-CoS lead should hear a message
# only when genuinely addressed; a no-@ message goes to the CoS alone. Here we
# resolve whether THIS lead is such a non-CoS lead (resolveCoreRoomGate over the
# SAME projects.json the Bridge/fleet script use) and, if so, idempotently patch
# its access.json core group to requireMention:true (+ mentionPatterns:[] when
# the fork plugin supports per-group patterns). CoS / core-less / core-no-CoS
# (joycon) → gateNonCoS false → no-op (byte-compat). Best-effort (`|| true`): a
# provisioning failure must never abort a Lead launch. Runs after the FLY-282
# access.json seeding (access.json exists by now) and before the supervisor loop.
if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" != "1" ]; then
  _cg_cli="${SCRIPT_DIR}/../dist/core-room-gate-cli.js"
  _cg_apply="${SCRIPT_DIR}/apply-core-room-mention-gate.sh"
  if [ -f "$_cg_cli" ] && [ -x "$_cg_apply" ] && command -v jq >/dev/null 2>&1; then
    _cg_json="$(node "$_cg_cli" --lead-id "$LEAD_ID" --project "$PROJECT_NAME" 2>/dev/null || true)"
    _cg_gate="$(printf '%s' "$_cg_json" | jq -r '.gateNonCoS // false' 2>/dev/null || echo false)"
    _cg_core="$(printf '%s' "$_cg_json" | jq -r '.coreChannelId // empty' 2>/dev/null || true)"
    _cg_iscos="$(printf '%s' "$_cg_json" | jq -r '.isCoS // false' 2>/dev/null || echo false)"
    if [ "$_cg_gate" = "true" ] && [ -n "$_cg_core" ]; then
      log "FLY-898: applying core-room mention gate for ${LEAD_ID} (core ${_cg_core})"
      # FLY-944: the --id-only transform now ALSO clears the group's allowFrom
      # (sender whitelist retired in the same atomic patch — pile-on safe).
      "$_cg_apply" --access-file "${DISCORD_STATE_DIR}/access.json" \
        --channel-id "$_cg_core" --id-only || true
    elif [ "$_cg_iscos" = "true" ] && [ -n "$_cg_core" ]; then
      # FLY-944: a CoS keeps requireMention:false (it must hear its whole core)
      # but its stale allowFrom whitelist made it deaf to NEW sibling leads
      # (Cass missing HL). Clear allowFrom only.
      log "FLY-944: clearing CoS core allowFrom for ${LEAD_ID} (core ${_cg_core})"
      "$_cg_apply" --access-file "${DISCORD_STATE_DIR}/access.json" \
        --channel-id "$_cg_core" --allowfrom-only || true
    fi
    # FLY-944: roundtable sender whitelist retired for every lead (discipline
    # there is requireMention:true fleet-wide; plugin defaults a missing field
    # to true). Same guarded scope → same fail-closed behavior as core.
    _f944_rt=""
    if [ -n "${FLYWHEEL_ROUNDTABLE_CHANNEL_ID:-}" ]; then
      _f944_rt="$FLYWHEEL_ROUNDTABLE_CHANNEL_ID"
    elif [ -f "${HOME}/.flywheel/roundtable.json" ]; then
      _f944_rt="$(jq -r '.channelId // empty' "${HOME}/.flywheel/roundtable.json" 2>/dev/null || true)"
    fi
    if [ -n "$_f944_rt" ]; then
      log "FLY-944: clearing roundtable allowFrom for ${LEAD_ID} (channel ${_f944_rt})"
      "$_cg_apply" --access-file "${DISCORD_STATE_DIR}/access.json" \
        --channel-id "$_f944_rt" --allowfrom-only || true
    fi
  else
    log "FLY-898: core-room-gate CLI/helper not built or jq missing — skip"
  fi
fi

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

    # Bootstrap only on fresh start — resumed sessions already have context.
    # FLY-231: companion skips the engineering bootstrap (it carries
    # "## Bootstrap — Lead" / sessions / Runner questions — engineering-toned
    # content that pollutes a companion persona; the persona itself is injected via
    # --agent identity.md and survives compaction). The global PostCompact hook is
    # separately gated by the FLYWHEEL_LEAD_COMPANION pane marker.
    if [ "$IS_COMPANION_ROLE" != true ] && [ "$IS_EXTERNAL_ROLE" != true ]; then
      send_bootstrap
    elif [ "$IS_EXTERNAL_ROLE" = true ]; then
      log "External: skipping engineering bootstrap (persona via --agent agent.md; no Bridge access)"
    else
      log "Companion: skipping engineering bootstrap (persona via --agent identity.md)"
    fi

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

  # FLY-109: Start background dev-channels dialog poller. capture-pane is
  # ANSI-proof (unlike expect which fails on Ink TUI escape codes).
  # Only poll when dev-channels flag is active.
  if [ "$INBOX_MCP_ENABLED" = "true" ] && [ -n "${LEAD_WINDOW_ID:-}" ]; then
    _poll_dev_channels_dialog "$LEAD_WINDOW_ID" "$FLYWHEEL_DIALOG_TIMEOUT_SEC" &
    _DIALOG_POLLER_PID=$!
  fi

  # FLY-88: Wait for tmux window to complete.
  _wait_tmux_window

  # Clean up dialog poller if still running
  if [ -n "${_DIALOG_POLLER_PID:-}" ]; then
    kill "$_DIALOG_POLLER_PID" 2>/dev/null || true
    wait "$_DIALOG_POLLER_PID" 2>/dev/null || true
    _DIALOG_POLLER_PID=""
  fi

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

  # FLY-83: blocked-prompt classification (rate_limit / login_expired /
  # permission_blocked) used to live here as case statements driven by
  # expect-wrapper sentinel exit codes. After FLY-109 replaced expect with the
  # capture-pane dialog poller, Claude no longer exits with sentinel codes —
  # the Bridge-side LeadWatchdog (packages/teamlead/src/LeadWatchdog.ts)
  # now classifies blocked patterns directly from capture-pane output and
  # fires the same alerts via LeadAlertNotifier (which shares claims.db
  # with scripts/lead-alert.sh below for the crash-loop path).
  LEAD_ALERT_SH="${FLYWHEEL_ROOT}/scripts/lead-alert.sh"

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
    # FLY-83: Fire crash_loop alert once per day per (project, lead) via the
    # default daily signature in lead-alert.sh. Repeated escalations within
    # the same day collapse to one Discord notification (the body still
    # carries the up-to-date crash count for context).
    if [ -x "$LEAD_ALERT_SH" ]; then
      "$LEAD_ALERT_SH" \
        --lead "$LEAD_ID" --project "$PROJECT_NAME" \
        --kind crash_loop --severity severe \
        --title "Lead crash-looping" \
        --body "Claude CLI has crashed ${CRASH_COUNT} times today. Last exit code: ${CLAUDE_EXIT}. Check ~/.flywheel/logs/lead-${LEAD_ID}-startup.log + the Lead's tmux pane for the failure mode (rate-limit / login-expired / config error)." \
        || log "WARNING: lead-alert.sh returned non-zero"
    fi
  fi

  log "Waiting ${BACKOFF}s before restart..."
  interruptible_sleep "$BACKOFF"
done

log "Supervisor stopped. Total restarts: ${RESTART_COUNT}"

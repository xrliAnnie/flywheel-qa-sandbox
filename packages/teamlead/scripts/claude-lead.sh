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
# FLY-1285: one guarded tmux-socket implementation is shared by the Lead
# supervisor and Bridge/Runner callers. It defines functions only and never
# installs traps or mutates shell options.
# shellcheck source=../../../scripts/lib/tmux-server-rescue.sh
source "${FLYWHEEL_ROOT}/scripts/lib/tmux-server-rescue.sh"
# FLY-1285: generation-bound Lead pane archive + duplicate-process takeover.
# shellcheck source=lib/tmux-supervisor-guard.sh
source "${SCRIPT_DIR}/lib/tmux-supervisor-guard.sh"
# FLY-1671: optional body-provenance observation. The packaged and monorepo
# roots both expose this path through FLYWHEEL_ROOT. A missing/corrupt library
# must not affect Lead availability; restart reporting degrades to unknown.
_LEAD_BODY_EVIDENCE_LIB="${FLYWHEEL_ROOT}/scripts/lib/lead-body-evidence.sh"
if [ -f "$_LEAD_BODY_EVIDENCE_LIB" ]; then
  # shellcheck source=../../../scripts/lib/lead-body-evidence.sh
  if ! source "$_LEAD_BODY_EVIDENCE_LIB"; then
    log "DEBUG: body evidence library could not be sourced; provenance will be unknown"
  fi
fi

record_lead_body_evidence_best_effort() {
  local provenance="${1:-}" body_pid="${2:-}" body_start="${3:-}"
  local carrier_pid="" carrier_start=""
  if [ "$#" -ge 4 ]; then
    # v2 callers pass the captured tuple explicitly. Keep an invalid/empty
    # handoff invalid so reporting becomes unknown instead of inventing a
    # carrier identity from this body shell.
    carrier_pid="${4:-}"
    carrier_start="${5:-}"
  else
    # Legacy claude-lead.sh is itself the launchd carrier.
    carrier_pid="$$"
  fi
  declare -F lbe_record >/dev/null 2>&1 || return 0
  if [ "$#" -lt 4 ] && [ -z "$carrier_start" ]; then
    carrier_start="$(tmux_supervisor_process_start_identity "$carrier_pid" 2>/dev/null || true)"
  fi
  if ! lbe_record "$PROJECT_NAME" "$LEAD_ID" "$provenance" \
      "$body_pid" "$body_start" "$carrier_pid" "$carrier_start"; then
    log "DEBUG: body provenance evidence write failed; restart reporting will use unknown"
  fi
  return 0
}
# FLY-1309: canonical Lead lease orchestration + exact argv preflight. Source it
# after the tmux guard so the production guard can consume the shared matcher.
# shellcheck source=lib/lead-identity-preflight.sh
source "${SCRIPT_DIR}/lib/lead-identity-preflight.sh"
# FLY-1602: the restart lifecycle parser is the shared disk/launchd authority
# contract; body inventory is deliberately read-only before any hard clear.
# shellcheck source=../../../scripts/lib/lead-restart-lifecycle.sh
source "${FLYWHEEL_ROOT}/scripts/lib/lead-restart-lifecycle.sh"
# shellcheck source=lib/lead-launch-authority.sh
source "${SCRIPT_DIR}/lib/lead-launch-authority.sh"
# shellcheck source=../../../scripts/lib/lead-body-sweep.sh
source "${FLYWHEEL_ROOT}/scripts/lib/lead-body-sweep.sh"
# FLY-1389: resume-failure classification (pure functions) + resume transcript
# diagnostic. Deterministic resume failures (10-15s deaths on a stale
# session-id) must reach the fresh-start fallback instead of resetting it.
# shellcheck source=lib/resume-recovery.sh
source "${SCRIPT_DIR}/lib/resume-recovery.sh"
# FLY-1402: Claude CLI treats repeated --append-system-prompt-file flags as
# last-one-wins. Collect every selected rule and materialize one prompt bundle.
# shellcheck source=lead-rules-bundle.sh
source "${SCRIPT_DIR}/lead-rules-bundle.sh"

_rules_bundle_mode_raw="${FLYWHEEL_LEAD_RULES_BUNDLE:-bundle}"
_rules_bundle_mode_raw="${_rules_bundle_mode_raw#"${_rules_bundle_mode_raw%%[![:space:]]*}"}"
_rules_bundle_mode_raw="${_rules_bundle_mode_raw%"${_rules_bundle_mode_raw##*[![:space:]]}"}"
_rules_bundle_mode_raw="$(printf '%s' "$_rules_bundle_mode_raw" | tr '[:upper:]' '[:lower:]')"
case "$_rules_bundle_mode_raw" in
  ''|bundle) RULES_BUNDLE_MODE="bundle" ;;
  legacy) RULES_BUNDLE_MODE="legacy" ;;
  *)
    printf '[lead] WARNING: invalid FLYWHEEL_LEAD_RULES_BUNDLE=%s; defaulting to bundle\n' \
      "$_rules_bundle_mode_raw" >&2
    RULES_BUNDLE_MODE="bundle"
    ;;
esac
unset _rules_bundle_mode_raw
rules_bundle_reset
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
if [ "${FLYWHEEL_LEAD_BODY_V2:-0}" = "1" ]; then
  # The v2 wrapper owns the canonical manifest and publishes runtime identity
  # from inside the proven-live tmux server. Skipping the legacy writer here is
  # intentional and must not be reported as a missing-jq failure.
  :
elif command -v jq >/dev/null 2>&1; then
  # FLY-143: preserve per-Lead MCP scope fields across manifest rewrites.
  # Source of truth: env (set by wrapper from prior manifest read). Falling
  # back to existing manifest values stops a launchd restart from silently
  # dropping `mcpExclude` / `chromeEnabled` and re-broadening MCP scope.
  _existing_mcp_exclude=""
  _existing_chrome_enabled="false"
  # FLY-1496: model/effort are no longer preserved from this output file.
  # projects.json is re-read for every physical launch; the resolved launch
  # decision rewrites model/effort evidence later in _launch_claude.
  _existing_lead_backend=""
  if [ -f "$MANIFEST_FILE" ]; then
    _existing_mcp_exclude=$(jq -r '.mcpExclude // ""' "$MANIFEST_FILE" 2>/dev/null || echo "")
    _existing_chrome_enabled=$(jq -r '.chromeEnabled // false' "$MANIFEST_FILE" 2>/dev/null || echo "false")
    _existing_lead_backend=$(jq -r '.leadBackend.backendId // ""' "$MANIFEST_FILE" 2>/dev/null || echo "")
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
    --arg leadBackendId "$_existing_lead_backend" \
    '{
       leadId: $leadId, projectDir: $projectDir, projectName: $projectName,
       subdir: $subdir, workspace: $workspace, botTokenEnv: $botTokenEnv,
       mcpExclude: $mcpExclude, chromeEnabled: $chromeEnabled,
       pid: ($pid | tonumber)
     }
     | (if $leadBackendId != "" then . + {leadBackend: {backendId: $leadBackendId}} else . end)' \
    > "$_manifest_tmp" \
    && jq empty "$_manifest_tmp" 2>/dev/null \
    && mv "$_manifest_tmp" "$MANIFEST_FILE" \
    || { rm -f "$_manifest_tmp"; log "WARNING: manifest write failed — keeping previous manifest"; }
  log "Manifest written: ${MANIFEST_FILE} (mcpExclude=\"${_final_mcp_exclude}\", chromeEnabled=${_final_chrome_enabled})"
else
  log "WARNING: jq not found. Manifest not written — auto-restart will skip this Lead."
fi

# ── FLY-1439: validate an isolated-CLAUDE_CONFIG_DIR skip request ──
# Runs BEFORE the launcher's first CLAUDE_CONFIG_DIR-derived write. The
# agent-file copy below already resolves its target through CLAUDE_CONFIG_DIR,
# so validating only at the plugin fork-check block (further down) let a
# malformed request overwrite the PRODUCTION agents/<lead>.md and only then
# abort — the guard has to run before anything is written, not before the
# check/update scripts run.
#
# Comparing only the canonical config ROOT is not sufficient either: an
# isolated root whose `plugins` subtree symlinks back to ~/.claude/plugins
# passes a root-only comparison while Claude still reads and writes the
# PRODUCTION plugin cache — precisely the zero-write guarantee this seam
# exists to provide. So the real plugin surfaces are resolved too and must
# stay outside the production plugin tree.
#
# Pure + idempotent: the fork-check block calls it again rather than trusting
# a "already validated" shell variable, which an inherited env could preset.
validate_isolated_claude_config() {
  local qa_real="" prod_real="" detail=""

  if [ -z "${CLAUDE_CONFIG_DIR:-}" ] \
    || [ -z "${TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR:-}" ] \
    || [ "${CLAUDE_CONFIG_DIR}" != "${TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR}" ]; then
    log "ERROR: TEST_SKIP_PLUGIN_FORK_CHECK=1 requires a CLAUDE_CONFIG_DIR matching TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR. Aborting."
    exit 1
  fi

  # A relative CLAUDE_CONFIG_DIR is validated against THIS process's cwd but
  # consumed by a Lead that tmux starts with `-c "$LEAD_WORKSPACE"`, so the
  # same string can resolve to the isolated root here and to the production
  # root there. That is a time-of-check/time-of-use hole, not a style nit —
  # only an absolute path means the same directory in both places.
  case "${CLAUDE_CONFIG_DIR}" in
    /*) ;;
    *)
      log "ERROR: TEST_SKIP_PLUGIN_FORK_CHECK=1 requires an ABSOLUTE CLAUDE_CONFIG_DIR (got '${CLAUDE_CONFIG_DIR}'); a relative path resolves against the consumer's cwd. Aborting."
      exit 1
      ;;
  esac

  if [ ! -d "${CLAUDE_CONFIG_DIR}" ]; then
    log "ERROR: TEST_SKIP_PLUGIN_FORK_CHECK=1 requires an existing CLAUDE_CONFIG_DIR. Aborting."
    exit 1
  fi

  # Everything below is a CONTAINMENT INVARIANT rather than a list of known
  # escape routes: the isolated plugin tree must be entirely self-contained,
  # and identity is compared by (device, inode) rather than by path string.
  #
  # Path strings are the wrong instrument here. On a case-insensitive APFS
  # volume `~/.CLAUDE` and `~/.claude` are the SAME directory, but `pwd -P`
  # and realpath both preserve the caller's casing, so a string compare says
  # they differ. Likewise a blacklist of escape shapes (this symlink, that
  # subdirectory) keeps losing to the next shape — a dangling link, a link
  # via an innocent third directory, a hardlink that is not a link at all.
  # So instead: nothing under the isolated plugin tree may resolve outside
  # the isolated root, and no regular file in it may share an inode with the
  # production plugin tree.
  #
  # python3 is already a hard dependency of this launcher (the hook
  # installers shell out to it); if it is missing we fail closed rather than
  # grant an unverified skip.
  if ! command -v python3 >/dev/null 2>&1; then
    log "ERROR: TEST_SKIP_PLUGIN_FORK_CHECK=1 needs python3 to verify isolation. Aborting."
    exit 1
  fi

  if ! detail="$(python3 - "${CLAUDE_CONFIG_DIR}" "${HOME}/.claude" <<'PYEOF'
import json, os, sys

cfg, prod_root = sys.argv[1], sys.argv[2]
prod_plugins = os.path.join(prod_root, "plugins")


def ident(path):
    """(device, inode) — the only reliable identity on a case-insensitive fs."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_dev, st.st_ino)


problems = []
cfg_real = os.path.realpath(cfg)
cfg_id, prod_id = ident(cfg_real), ident(prod_root)

if cfg_id is not None and cfg_id == prod_id:
    problems.append("config root IS the production Claude config root (%s)" % prod_root)

# Nesting is also an identity question: walk ancestors comparing inodes.
if prod_id is not None and not problems:
    node = cfg_real
    while True:
        parent = os.path.dirname(node)
        if parent == node:
            break
        if ident(parent) == prod_id:
            problems.append("config root is nested inside the production Claude config root (%s)" % prod_root)
            break
        node = parent


def inside(real):
    return real == cfg_real or real.startswith(cfg_real + os.sep)


plugins = os.path.join(cfg, "plugins")
if not problems and os.path.lexists(plugins):
    if not os.path.exists(plugins):
        problems.append("plugins root is a dangling link (%s -> %s)" % (plugins, os.path.realpath(plugins)))
    elif not inside(os.path.realpath(plugins)):
        problems.append("plugins root escapes the isolated root (%s -> %s)" % (plugins, os.path.realpath(plugins)))
    else:
        linked = []
        for dirpath, dirnames, filenames in os.walk(plugins, followlinks=False):
            for name in dirnames + filenames:
                entry = os.path.join(dirpath, name)
                if os.path.islink(entry):
                    target = os.path.realpath(entry)
                    if not os.path.exists(entry):
                        problems.append("dangling link in plugin tree (%s -> %s)" % (entry, target))
                    elif not inside(target):
                        problems.append("link escapes the isolated root (%s -> %s)" % (entry, target))
                else:
                    try:
                        st = os.stat(entry)
                    except OSError:
                        continue
                    # Only a file with extra links can be a shared hardlink;
                    # this keeps the production-side walk off the hot path.
                    if os.path.isfile(entry) and st.st_nlink > 1:
                        linked.append(((st.st_dev, st.st_ino), entry))
                if len(problems) >= 5:
                    break
            if len(problems) >= 5:
                break

        if linked and not problems:
            shared = {}
            for dirpath, _dirnames, filenames in os.walk(prod_plugins, followlinks=False):
                for name in filenames:
                    pid = ident(os.path.join(dirpath, name))
                    if pid is not None:
                        shared[pid] = os.path.join(dirpath, name)
            for key, entry in linked:
                if key in shared:
                    problems.append("file is a hardlink to the production plugin tree (%s == %s)" % (entry, shared[key]))

# Filesystem containment says nothing about the LOGICAL paths recorded
# inside the plugin registry files.
# installed_plugins.json / known_marketplaces.json are ordinary files with
# st_nlink == 1, yet a single missed rewrite during QA setup can leave
# installPath / installLocation / source.path pointing straight at the
# production plugin tree — the skip is then granted while Claude loads
# production bytes. This is the ordinary operator-misconfiguration case the
# seam exists to catch, so it is checked here rather than after launch.
def registry_paths(path):
    """Yield (field, value) path-like entries from a plugin registry file."""
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("top level is not an object")
    for key, entry in (data.get("plugins") or {}).items() if "plugins" in data else []:
        for item in entry if isinstance(entry, list) else [entry]:
            if isinstance(item, dict) and isinstance(item.get("installPath"), str):
                yield ("plugins[%s].installPath" % key, item["installPath"])
    for name, entry in data.items():
        if name == "plugins" or not isinstance(entry, dict):
            continue
        if isinstance(entry.get("installLocation"), str):
            yield ("%s.installLocation" % name, entry["installLocation"])
        source = entry.get("source")
        if isinstance(source, dict) and isinstance(source.get("path"), str):
            yield ("%s.source.path" % name, source["path"])


if not problems:
    for registry in ("installed_plugins.json", "known_marketplaces.json"):
        target = os.path.join(plugins, registry)
        if not os.path.exists(target):
            continue
        try:
            entries = list(registry_paths(target))
        except Exception as exc:  # fail closed: unreadable registry is unverifiable
            problems.append("could not verify %s (%s)" % (registry, exc))
            continue
        for field, value in entries:
            if not inside(os.path.realpath(value)):
                problems.append(
                    "%s %s points outside the isolated root (%s)" % (registry, field, value)
                )

print("; ".join(problems[:5]))
sys.exit(1 if problems else 0)
PYEOF
  )"; then
    log "ERROR: TEST_SKIP_PLUGIN_FORK_CHECK=1 isolation check failed: ${detail}. Aborting."
    exit 1
  fi
}

if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" != "1" ] \
  && [ "${TEST_SKIP_PLUGIN_FORK_CHECK:-0}" = "1" ]; then
  validate_isolated_claude_config
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
CLAUDE_AGENT_ROOT="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
AGENT_TARGET="${CLAUDE_AGENT_ROOT}/agents/${LEAD_ID}.md"
mkdir -p "${CLAUDE_AGENT_ROOT}/agents"

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
DISCORD_PLUGIN_CONTRACT="discord@flywheel-plugins/v1"

alert_discord_plugin_integrity() {
  local reason="$1" body="$2"
  local alert_script="${FLYWHEEL_ROOT}/scripts/lead-alert.sh"
  if [ ! -x "$alert_script" ]; then
    log "WARNING: cannot emit Discord plugin integrity alert; missing ${alert_script}"
    return 0
  fi
  "$alert_script" \
    --lead "$LEAD_ID" \
    --project "$PROJECT_NAME" \
    --kind discord_plugin_integrity_failed \
    --severity severe \
    --title "Discord plugin integrity failed" \
    --body "$body" \
    --signature "${reason}-$(date -u +%Y%m%d)" \
    || log "WARNING: Discord plugin integrity alert delivery returned non-zero"
}

# FLY-231 dry-run: the launch-plan test runs in an isolated HOME with no
# ~/.flywheel/bin scripts — skip the plugin fork check/update (it mutates the
# shared plugin cache and is irrelevant to argv/env assembly).
if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" = "1" ]; then
  log "DRY-RUN: skipping Discord plugin fork check"
elif [ "${TEST_SKIP_PLUGIN_FORK_CHECK:-0}" = "1" ]; then
  # FLY-1439: a pinned-plugin QA Lead may use an isolated CLAUDE_CONFIG_DIR.
  # Never let a malformed skip request fall through to the production
  # ~/.claude plugin check/update scripts. The validation itself lives in
  # validate_isolated_claude_config (defined above and already run before the
  # first CLAUDE_CONFIG_DIR-derived write); re-run it here so this branch is
  # independently fail-closed rather than trusting an earlier side effect.
  validate_isolated_claude_config
  log "QA: skipping Discord plugin fork check for isolated CLAUDE_CONFIG_DIR: ${CLAUDE_CONFIG_DIR}"
else
  if [ ! -x "$CHECK_SCRIPT" ] || [ ! -x "$UPDATE_SCRIPT" ]; then
    log "ERROR: Discord plugin fork scripts not found or not executable:"
    log "  check:  $CHECK_SCRIPT"
    log "  update: $UPDATE_SCRIPT"
    log "Run scripts/install-discord-plugin-ops.sh from the deployed Flywheel checkout. Aborting."
    alert_discord_plugin_integrity "tools-missing" \
      "Lead ${LEAD_ID} refused to start because the managed Discord checker/updater is missing. Re-run the deployed Discord operations installer."
    exit 1
  fi

  _discord_contract="$($CHECK_SCRIPT --print-contract 2>/dev/null || true)"
  if [ "$_discord_contract" != "$DISCORD_PLUGIN_CONTRACT" ]; then
    log "ERROR: Discord plugin selector/checker contract mismatch. Aborting."
    alert_discord_plugin_integrity "contract-mismatch" \
      "Lead ${LEAD_ID} refused to start because the deployed launcher selects discord@flywheel-plugins but the live checker/updater is still the legacy overlay. Complete or roll back the guarded FLY-1676 cutover."
    exit 1
  fi

  if ! "$CHECK_SCRIPT"; then
    log "Discord plugin does not match fork main, updating through Claude CLI..."
    if ! "$UPDATE_SCRIPT"; then
      log "ERROR: Discord plugin update failed. Aborting."
      alert_discord_plugin_integrity "update-failed" \
        "Lead ${LEAD_ID} refused to start because discord@flywheel-plugins could not update to fork main. Inspect the CLI registry and fork availability."
      exit 1
    fi
    # Re-check after update — hard fail if still not matching
    if ! "$CHECK_SCRIPT"; then
      log "ERROR: Discord plugin still not fork version after update. Aborting."
      alert_discord_plugin_integrity "recheck-failed" \
        "Lead ${LEAD_ID} refused to start because discord@flywheel-plugins still failed SHA/marker verification after update. Vanilla bytes may be present."
      exit 1
    fi
  fi
  log "Discord plugin fork check: OK"
fi

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
  # Keep this function self-contained: the integration harness extracts and
  # evaluates it without the launcher's outer-scope variables.
  local settings_file="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/settings.json"
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

  # Keep this function self-contained: the integration harness extracts and
  # evaluates it without the launcher's outer-scope variables.
  local settings_file="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/settings.json"
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
LEAD_BODY_PROVENANCE=""
# FLY-1679: PID of the v2 carrier's dev-channels auto-confirm poller, if any.
_V2_DIALOG_POLLER_PID=""

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
TMUX_SERVER_PID=""
TMUX_HOLD_INCIDENT_ID=""
TMUX_HOLD_BRIDGE_ACKED=0
TMUX_HOLD_FIRST_LOCAL_TS=""
TMUX_HOLD_FALLBACK_SENT=0
TMUX_RELAUNCH_PROVEN=0
ENSURE_HOLD_KIND=""
ENSURE_HOLD_EVIDENCE=""

_hold_sleep_and_advance() {
  local delay
  delay=$((TMUX_HOLD_BACKOFF / 2 + RANDOM % (TMUX_HOLD_BACKOFF + 1)))
  interruptible_sleep "$delay"
  [ "$TMUX_HOLD_BACKOFF" -ge 30 ] \
    || TMUX_HOLD_BACKOFF=$((TMUX_HOLD_BACKOFF * 2))
  [ "$TMUX_HOLD_BACKOFF" -le 30 ] || TMUX_HOLD_BACKOFF=30
}

_log_startup() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%S') $*" >> "$FLYWHEEL_STARTUP_LOG"
}

_tmux_socket_path() {
  local requested parent
  if [ -n "${FLYWHEEL_TMUX_SOCKET_OVERRIDE:-}" ]; then
    requested="$FLYWHEEL_TMUX_SOCKET_OVERRIDE"
  else
    requested="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/default"
  fi
  parent="${requested%/*}"
  if [ ! -d "$parent" ] && [ -z "${FLYWHEEL_TMUX_SOCKET_OVERRIDE:-}" ]; then
    mkdir -p "$parent" 2>/dev/null || return 1
    chmod 700 "$parent" 2>/dev/null || return 1
  fi
  _tmux_rescue_normalize_socket "$requested"
}

# Default mode remains the historical plain `tmux ...` invocation. An explicit
# override is a QA/incident isolation seam and must cover every tmux operation.
_tmux() {
  if [ -n "${FLYWHEEL_TMUX_SOCKET_OVERRIDE:-}" ]; then
    command tmux -S "$FLYWHEEL_TMUX_SOCKET_OVERRIDE" "$@"
  else
    command tmux "$@"
  fi
}

_tmux_generation_is_current() {
  local expected_pid="$1" socket_path inspection
  socket_path="$(_tmux_socket_path)" || return 1
  inspection="$(tmux_socket_inspect "$socket_path")" || return 1
  [ "$(_tmux_rescue_json_field "$inspection" verdict)" = "reachable" ] \
    && [ "$(_tmux_rescue_json_field "$inspection" reachablePid)" = "$expected_pid" ]
}

# Cheap, operation-scoped read probe. rc 0 proves the expected generation is
# answering; rc 1 proves a different numeric generation; rc 2 is transport or
# format uncertainty. It performs no process-table scan and takes no lock.
_tmux_generation_probe() {
  local expected_pid="$1" socket_path timeout reported_pid="" rc=0
  case "$expected_pid" in ''|*[!0-9]*) return 2 ;; esac
  socket_path="$(_tmux_socket_path)" || return 2
  timeout="$(_tmux_rescue_effective_timeout command)" || return 2
  reported_pid="$(tmux_rescue_probe "$timeout" \
    tmux -S "$socket_path" display-message -p '#{pid}' 2>/dev/null)" || rc=$?
  [ "$rc" -eq 0 ] || return 2
  case "$reported_pid" in ''|*[!0-9]*) return 2 ;; esac
  [ "$reported_pid" = "$expected_pid" ] && return 0
  return 1
}

# Typed generation state for crash-durable launch ledgers. A different server
# generation, or an expected server PID that is positively gone after bounded
# IPC fails, proves every window in that frozen generation is absent. A live
# PID plus IPC noise remains indeterminate and must hold fail-closed.
_lead_tmux_generation_state() {
  local expected_pid="$1" generation_rc=0 presence_rc=0
  _tmux_generation_probe "$expected_pid" || generation_rc=$?
  case "$generation_rc" in
    0) return 0 ;;
    1) return 1 ;;
  esac
  _tmux_supervisor_process_presence_state "$expected_pid" || presence_rc=$?
  [ "$presence_rc" -eq 1 ] && return 1
  return 2
}

_tmux_target_matches_archive() {
  local target="$1" require_live="${2:-false}" pane_pid
  tmux_supervisor_archive_read "$TMUX_ARCHIVE_FILE" || return 1
  [ "$TMUX_ARCHIVE_WINDOW_ID" = "$target" ] || return 1
  _tmux_generation_is_current "$TMUX_ARCHIVE_SERVER_PID" || return 1
  pane_pid="$(_tmux list-panes -t "$target" -F '#{pane_pid}' 2>/dev/null | head -1)" || return 1
  [ "$pane_pid" = "$TMUX_ARCHIVE_PANE_PID" ] || return 1
  if [ "$require_live" = true ]; then
    tmux_supervisor_archived_process_state "$TMUX_ARCHIVE_FILE" "$LEAD_ID" \
      || return 1
  fi
}

# Read-only matcher for steady monitoring. A positive generation change fails
# immediately; transport uncertainty falls back to the full forensic matcher.
# The healthy path uses only bounded tmux IPC and never scans ps/lsof.
_tmux_target_matches_archive_fast() {
  local target="$1" require_live="${2:-false}" generation_rc=0
  local socket_path timeout pane_row pane_pid pane_dead
  tmux_supervisor_archive_read "$TMUX_ARCHIVE_FILE" || return 1
  [ "$TMUX_ARCHIVE_WINDOW_ID" = "$target" ] || return 1
  _tmux_generation_probe "$TMUX_ARCHIVE_SERVER_PID" || generation_rc=$?
  case "$generation_rc" in
    0) ;;
    1) return 1 ;;
    *) _tmux_target_matches_archive "$target" "$require_live"; return $? ;;
  esac
  socket_path="$(_tmux_socket_path)" || return 1
  timeout="$(_tmux_rescue_effective_timeout command)" || return 1
  pane_row="$(tmux_rescue_probe "$timeout" \
    tmux -S "$socket_path" list-panes -t "$target" \
      -F '#{pane_pid}	#{pane_dead}' 2>/dev/null | head -1)" || return 1
  pane_pid="${pane_row%%$'\t'*}"
  pane_dead="${pane_row#*$'\t'}"
  [ "$pane_pid" = "$TMUX_ARCHIVE_PANE_PID" ] || return 1
  [ "$require_live" != true ] || [ "$pane_dead" = 0 ]
}

_tmux_normalize_hold_kind() {
  case "${1:-}" in
    saturated|split_brain|ambiguous|unknown|rescue_failed|lock_unavailable)
      printf '%s\n' "$1"
      ;;
    *)
      # Helper action details such as marker_disabled/recovery_failed are
      # evidence, not durable correlation kinds.
      printf '%s\n' rescue_failed
      ;;
  esac
}

_tmux_report_hold() {
  local kind="$1" socket_path payload response now elapsed
  local evidence="${2:-}"
  [ -n "$evidence" ] || evidence='{}'
  kind="$(_tmux_normalize_hold_kind "$kind")"
  socket_path="$(_tmux_socket_path)" || return 1
  now="$(date +%s)"
  [ -n "$TMUX_HOLD_FIRST_LOCAL_TS" ] || TMUX_HOLD_FIRST_LOCAL_TS="$now"
  payload="$(jq -cn \
    --arg leadId "$LEAD_ID" --arg projectName "$PROJECT_NAME" \
    --arg socketPath "$socket_path" --arg kind "$kind" \
    --arg incidentId "$TMUX_HOLD_INCIDENT_ID" --arg evidence "$evidence" \
    --argjson heldSinceTs "$TMUX_HOLD_FIRST_LOCAL_TS" \
    '{leadId:$leadId,projectName:$projectName,socketPath:$socketPath,kind:$kind,
      heldSinceTs:$heldSinceTs,
      evidence:(try ($evidence|fromjson) catch {raw:$evidence})}
      + (if $incidentId == "" then {} else {incidentId:$incidentId} end)')" || return 1

  local -a curl_args=(-sfS --max-time 5 -X POST "${BRIDGE_URL}/api/tmux-hold-observation"
    -H "Content-Type: application/json" --data-binary "$payload")
  [ -n "${TEAMLEAD_API_TOKEN:-}" ] \
    && curl_args+=(-H "Authorization: Bearer ${TEAMLEAD_API_TOKEN}")
  if response="$(curl "${curl_args[@]}" 2>/dev/null)"; then
		local ack_incident_id
    ack_incident_id="$(printf '%s' "$response" | jq -r '.incidentId // empty' 2>/dev/null || true)"
		if [ -n "$ack_incident_id" ]; then
			TMUX_HOLD_INCIDENT_ID="$ack_incident_id"
			TMUX_HOLD_BRIDGE_ACKED=1
			return 0
		fi
  fi

  elapsed=$((now - TMUX_HOLD_FIRST_LOCAL_TS))
  if [ "$elapsed" -ge 600 ] && [ "$TMUX_HOLD_FALLBACK_SENT" -eq 0 ] \
    && [ "$TMUX_HOLD_BRIDGE_ACKED" -eq 0 ]; then
    TMUX_HOLD_FALLBACK_SENT=1
    if [ -x "${FLYWHEEL_ROOT}/scripts/lead-alert.sh" ]; then
      "${FLYWHEEL_ROOT}/scripts/lead-alert.sh" \
        --lead "$LEAD_ID" --project "$PROJECT_NAME" \
        --kind tmux_hold --severity severe \
        --title "Lead tmux hold could not reach Bridge" \
        --body "The Lead supervisor has held for ${elapsed}s on ${socket_path} (${kind}), but Bridge observation is unavailable. This fallback cannot auto-resolve; inspect Bridge health and the tmux socket." \
        || true
    fi
  fi
  return 1
}

_tmux_report_hold_resolved() {
  # Observation reporters do not own resolution. The Bridge coordinator will
  # reconcile targets and resolve the durable incident on positive evidence.
  TMUX_HOLD_INCIDENT_ID=""
  TMUX_HOLD_BRIDGE_ACKED=0
  TMUX_HOLD_FIRST_LOCAL_TS=""
  TMUX_HOLD_FALLBACK_SENT=0
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
    if ! _tmux_target_matches_archive_fast "$window_id" true; then
      _log_startup "dialog-poller: window gone, exiting"
      return 0
    fi

    local pane_text
    pane_text=$(_tmux capture-pane -t "$window_id" -p 2>/dev/null || echo "")

    if echo "$pane_text" | grep -qE "Loading development channels|am using this for local development|development channels"; then
      _tmux_target_matches_archive_fast "$window_id" true || return 0
      _log_startup "dialog-poller: matched dev-channels dialog, sending '1' Enter"
      _tmux send-keys -t "$window_id" "1" 2>/dev/null || true
      sleep 0.3
      _tmux_target_matches_archive_fast "$window_id" true || return 0
      _tmux send-keys -t "$window_id" Enter 2>/dev/null || true
      _log_startup "dialog-poller: confirmed=1"
      return 0
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  _log_startup "dialog-poller: DEV_CHANNELS_DIALOG_NOT_SEEN after ${timeout_sec}s"
  return 0
}

# FLY-1679: is Claude actually being launched with a development channel?
#
# The dialog appears if and only if `--dangerously-load-development-channels` is
# on the command line, so the poller must gate on THAT — the argv we are about
# to pass — and never on a proxy for it.
#
# The proxy this replaces was `INBOX_MCP_ENABLED`. It is exactly equivalent
# today because one site adds the flag and that site is gated on the same
# variable, which is why the original port copied it. But companion/external
# roles deliberately set `INBOX_MCP_ENABLED=false`, so the moment anything else
# contributes a development channel the proxy reads false while the dialog
# still renders: a companion Lead would park on it with no poller to answer,
# launchd still reporting healthy. That is the FLY-1672 fleet-outage shape, and
# FLY-1676 (an unconditional `plugin:discord@flywheel-plugins`) is precisely
# that trigger. Deriving from argv means any future contributor of a
# development channel gets the poller for free, with no second place to update.
_dev_channels_flag_active() {
  local arg
  for arg in ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}; do
    [ "$arg" = "--dangerously-load-development-channels" ] && return 0
  done
  return 1
}

# FLY-1679: the dev-channels dialog's own text, taken verbatim from the Claude
# source under test (DevChannelsDialog.tsx: the Dialog title, the standalone
# approved-channels line, and option 1's label). All three must be on screen at
# once. Any single fragment also appears in ordinary conversation about this
# flag, and interactiveHelpers.tsx legitimately skips the dialog when channels
# are gated off or there is no OAuth token — which would otherwise leave the
# poller scanning a restored transcript for its whole budget.
#
# Here-strings, not pipes: `set -o pipefail` is active in this launcher and a
# short-circuiting `grep -q` can SIGPIPE its producer.
_dev_channels_dialog_present() {
  local text="$1"
  grep -qF 'WARNING: Loading development channels' <<<"$text" || return 1
  grep -qF 'I am using this for local development' <<<"$text" || return 1
  grep -qF 'Please use --channels to run a list of approved channels.' <<<"$text" || return 1
  return 0
}

# FLY-1679: launchd-native (v2) carrier port of the FLY-109 auto-confirm.
# The v1 supervisor polls the shared session's Lead window; a v2 body has no
# such window — it IS the private server's pane and Claude is its direct child.
# Without this port every cold start parks on the dev-channels dialog until a
# human presses a key, while launchd still reports the job as running.
# Args: $1 = timeout_sec. Runs as a background job of the body shell.
#
# Every _log_startup call here is `|| true`. This function inherits errexit, and
# it is the thing standing between a cold start and a parked Lead: if an
# unwritable startup log (bad mode/owner, a misconfigured FLYWHEEL_EXPECT_LOG,
# a full disk) could abort it, observability failure would silently disable the
# safety mechanism and hand back exactly the incident this fixes — invisibly,
# because launchd would still report the job as running.
_poll_dev_channels_dialog_v2() {
  local timeout_sec="${1:-90}"
  local elapsed=0 socket pane pane_text send_rc verify capture_rc probe_rc probe_out send_out

  # Address the private server explicitly. FLYWHEEL_TMUX_SOCKET_OVERRIDE is a
  # shared-topology (v1) concept and must never retarget these keystrokes.
  if [ -z "${TMUX:-}" ]; then
    _log_startup "dialog-poller-v2: no tmux identity — auto-confirm skipped" || true
    return 0
  fi
  socket="${TMUX%%,*}"
  # %0 is guaranteed by the carrier: wrapper-v2 creates `-s main -n main` and
  # the generated tmux.conf's pane-exited hook keys on `#{hook_pane} = %0`.
  pane="${TMUX_PANE:-%0}"

  _log_startup "dialog-poller-v2: start pane=${pane} timeout=${timeout_sec}s" || true

  while [ "$elapsed" -lt "$timeout_sec" ]; do
    # Every tmux call here MUST run inside a command substitution.
    #
    # This function is a background job of the body shell, and the body shell
    # IS the pane process. A BARE external command in that position gets
    # exec-replaced by bash's subshell optimization: the tmux client takes over
    # the poller's process, runs, exits — and the rest of this loop never runs.
    # Measured on the real carrier: the poller logged `start`, probed once, and
    # vanished, leaving the Lead parked on the dialog it was there to dismiss.
    # `$( )` forks a child for the client, so this job survives to keep polling.
    probe_rc=0
    probe_out="$(command tmux -S "$socket" display-message -p -t "$pane" '#{pane_id}' 2>/dev/null)" \
      || probe_rc=$?
    if [ "$probe_rc" -ne 0 ] || [ -z "$probe_out" ]; then
      _log_startup "dialog-poller-v2: pane gone, exiting" || true
      return 0
    fi

    # A transient capture failure is not evidence of anything. Treat it as
    # "nothing matched this tick"; the pane probe at the top of the next
    # iteration remains the only authority on pane death.
    capture_rc=0
    pane_text="$(command tmux -S "$socket" capture-pane -t "$pane" -p 2>/dev/null)" || capture_rc=$?
    [ "$capture_rc" -eq 0 ] || pane_text=""

    if _dev_channels_dialog_present "$pane_text"; then
      _log_startup "dialog-poller-v2: matched dev-channels dialog, sending '1'" || true
      # '1' alone accepts: the dialog's Select leaves numeric selection enabled
      # (select.tsx resolves disableSelection to false), so the digit fires
      # onChange immediately. No Enter is ever sent — an unconditional Enter
      # would land on whatever renders next, and interactiveHelpers.tsx can
      # show Chrome onboarding the moment this dialog is accepted.
      # Command substitution here too — same exec-replacement hazard. send-keys
      # prints nothing; the substitution exists purely to fork.
      send_rc=0
      send_out="$(command tmux -S "$socket" send-keys -t "$pane" "1" 2>/dev/null)" || send_rc=$?
      : "${send_out:-}"
      if [ "$send_rc" -ne 0 ]; then
        _log_startup "dialog-poller-v2: DEV_CHANNELS_SEND_FAILED rc=${send_rc}" || true
        return 0
      fi

      # Confirmation is only claimed on evidence: a SUCCESSFUL capture that no
      # longer shows the dialog. A failed capture is transport loss, not proof
      # the dialog closed — swallowing it would let an offline Lead be logged
      # as confirmed and poison the production acceptance evidence.
      verify=0
      while [ "$verify" -lt 10 ]; do
        sleep 0.3
        capture_rc=0
        pane_text="$(command tmux -S "$socket" capture-pane -t "$pane" -p 2>/dev/null)" || capture_rc=$?
        if [ "$capture_rc" -ne 0 ]; then
          _log_startup "dialog-poller-v2: DEV_CHANNELS_VERIFY_FAILED rc=${capture_rc} (no confirmation evidence)" || true
          return 0
        fi
        if ! _dev_channels_dialog_present "$pane_text"; then
          _log_startup "dialog-poller-v2: confirmed=1" || true
          return 0
        fi
        verify=$((verify + 1))
      done
      _log_startup "dialog-poller-v2: DEV_CHANNELS_CONFIRM_UNVERIFIED (sent '1', dialog still present)" || true
      return 0
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  _log_startup "dialog-poller-v2: DEV_CHANNELS_DIALOG_NOT_SEEN after ${timeout_sec}s" || true
  return 0
}

# FLY-1679: is this PID still a RUNNING async job of THIS shell?
#
# The poller self-terminates within FLYWHEEL_DIALOG_TIMEOUT_SEC while
# _launch_claude stays blocked for the entire Claude lifetime — hours or days.
# At reap time the poller is therefore almost always long gone and its PID
# number is free for reuse; signalling the stored number unconditionally would
# eventually terminate an unrelated process.
#
# `jobs -pr` with NO argument, matched line-exact, is the only form that works
# here. Measured on the production platform (GNU bash 3.2.57, macOS):
# `jobs -pr <pid>` fails with "no such job" for a live job AND a finished one,
# so a PID-argument guard would silently degrade into "never signal anything".
_v2_dialog_poller_is_running() {
  local pid="$1" running
  running="$(jobs -pr 2>/dev/null || true)"
  grep -qxF -- "$pid" <<<"$running"
}

# FLY-1679: single reaping point, used by both the normal post-launch path and
# the signal path. Must run BEFORE the child is terminated so no keystroke can
# be delivered into a pane that is being torn down. Idempotent.
_v2_reap_dialog_poller() {
  local pid="${_V2_DIALOG_POLLER_PID:-}"
  [ -n "$pid" ] || return 0
  if _v2_dialog_poller_is_running "$pid"; then
    kill "$pid" 2>/dev/null || true
  fi
  # Consume the saved exit status either way; harmless if already reaped.
  wait "$pid" 2>/dev/null || true
  _V2_DIALOG_POLLER_PID=""
  return 0
}

# Ensure the shared flywheel tmux session exists (race-safe, idempotent).
# Called before every launch — handles session being killed externally.
ensure_tmux_session() {
  local socket_path result rc action timeout fast_pid="" fast_rc=0 option=""
  ENSURE_HOLD_KIND=""
  ENSURE_HOLD_EVIDENCE=""
  socket_path="$(_tmux_socket_path)" || {
    ENSURE_HOLD_KIND="unknown"
    ENSURE_HOLD_EVIDENCE='{"reason":"socket_path_unavailable"}'
    return 4
  }

  # Healthy shared-server path: mirror the locked ensure postconditions with
  # bounded read-only probes. Any drift or uncertainty falls through to the
  # existing socket-locked repair primitive.
  timeout="$(_tmux_rescue_effective_timeout command)" || timeout=5
  fast_pid="$(tmux_rescue_probe "$timeout" \
    tmux -S "$socket_path" display-message -p '#{pid}' 2>/dev/null)" || fast_rc=$?
  case "$fast_pid" in ''|*[!0-9]*) fast_rc=2 ;; esac
  if [ "$fast_rc" -eq 0 ] \
    && tmux_rescue_probe "$timeout" \
      tmux -S "$socket_path" has-session -t =flywheel >/dev/null 2>&1; then
    if _tmux_rescue_keepalive_enabled; then
      option="$(tmux_rescue_probe "$timeout" \
        tmux -S "$socket_path" show-options -sv exit-empty 2>/dev/null)" || option=""
      if [ "$option" = off ] \
        && tmux_rescue_probe "$timeout" \
          tmux -S "$socket_path" has-session -t =flywheel-keepalive >/dev/null 2>&1 \
        && _tmux_generation_probe "$fast_pid"; then
        TMUX_SERVER_PID="$fast_pid"
        return 0
      fi
    elif _tmux_generation_probe "$fast_pid"; then
      TMUX_SERVER_PID="$fast_pid"
      return 0
    fi
  fi
  if result="$(tmux_socket_ensure "$socket_path" \
    --verify tmux -S "$socket_path" has-session -t =flywheel \
    --create tmux -S "$socket_path" new-session -Ad -s flywheel -x 200 -y 50)"; then
    TMUX_SERVER_PID="$(_tmux_rescue_json_field "$result" reachablePid)"
    case "$TMUX_SERVER_PID" in ''|null|*[!0-9]*) return 4 ;; esac
    return 0
  else
    rc=$?
  fi
  action="$(_tmux_rescue_json_field "$result" action 2>/dev/null || echo hold_unknown)"
  ENSURE_HOLD_KIND="${action#hold_}"
  ENSURE_HOLD_EVIDENCE="$(printf '%s' "$result" | jq -c '.evidence // {}' 2>/dev/null || printf '{"reason":"invalid_helper_output"}')"
  return "$rc"
}

_prepare_lead_launch() {
  local window_name="${PROJECT_NAME}-${LEAD_ID}" target pane_row pane_dead
  local archived_state_rc=0 reap_rc=0
  target="=flywheel:=${window_name}"
  ENSURE_HOLD_KIND=""
  ENSURE_HOLD_EVIDENCE=""

  if [ -f "$TMUX_ARCHIVE_FILE" ]; then
    tmux_supervisor_archived_process_state "$TMUX_ARCHIVE_FILE" "$LEAD_ID" \
      || archived_state_rc=$?
    case "$archived_state_rc" in
      0)
        if [ "$TMUX_RELAUNCH_PROVEN" -eq 1 ] || [ "${LEAD_LEASE_FRESH:-0}" -eq 1 ]; then
          tmux_supervisor_reap_archived_process "$TMUX_ARCHIVE_FILE" "$LEAD_ID" \
            || reap_rc=$?
          if [ "$reap_rc" -ne 0 ]; then
            ENSURE_HOLD_KIND="unknown"
            ENSURE_HOLD_EVIDENCE='{"reason":"archived_process_reap_indeterminate"}'
            return 3
          fi
        else
          if [ "$TMUX_ARCHIVE_SERVER_PID" = "$TMUX_SERVER_PID" ]; then
            ENSURE_HOLD_KIND="ambiguous"
            ENSURE_HOLD_EVIDENCE="{\"reason\":\"existing_archived_lead_alive\",\"originalServerPid\":${TMUX_ARCHIVE_SERVER_PID}}"
          else
            ENSURE_HOLD_KIND="split_brain"
            ENSURE_HOLD_EVIDENCE="{\"reason\":\"archived_lead_on_other_generation\",\"originalServerPid\":${TMUX_ARCHIVE_SERVER_PID},\"reachablePid\":${TMUX_SERVER_PID}}"
          fi
          return 3
        fi
        ;;
      1)
        # Positive absence, zombie, PID reuse, or identity drift retires only
        # stale metadata. No live exact Lead body is signalled on this branch.
        rm -f "$TMUX_ARCHIVE_FILE" 2>/dev/null || true
        ;;
      *)
        ENSURE_HOLD_KIND="unknown"
        ENSURE_HOLD_EVIDENCE='{"reason":"archived_process_sensor_indeterminate"}'
        return 3
        ;;
    esac
  fi
  TMUX_RELAUNCH_PROVEN=0

  # Pre-FLY-1285 dead windows have no archive. A dead pane on the generation we
  # just verified is safe to remove; a live pane is held for human/takeover
  # evidence rather than killed by name.
  if _tmux_generation_is_current "$TMUX_SERVER_PID"; then
    pane_row="$(_tmux list-panes -t "$target" -F '#{pane_pid}	#{pane_dead}' 2>/dev/null | head -1 || true)"
    if [ -n "$pane_row" ]; then
      pane_dead="${pane_row#*$'\t'}"
      if [ "$pane_dead" = "1" ] && _tmux_generation_is_current "$TMUX_SERVER_PID"; then
        _tmux kill-window -t "$target" 2>/dev/null || true
      else
        ENSURE_HOLD_KIND="ambiguous"
        ENSURE_HOLD_EVIDENCE='{"reason":"unarchived_live_lead_window"}'
        return 3
      fi
    fi
  fi
  return 0
}

_lead_restore_orphan_session() {
  local command="" session_id="" tmp=""
  [ -f "$SESSION_ID_FILE" ] && return 0
  command="$(lead_body_process_command "$LEAD_LEASE_ORPHAN_HOLDER_PID")" || return 1
  _lead_body_command_proof "$command" "$PROJECT_NAME" "$LEAD_ID" claude-code \
    || return 1
  session_id="$(_lead_body_session_identity "$command")" || return 1
  mkdir -p "${SESSION_ID_FILE%/*}" 2>/dev/null || return 1
  tmp="${SESSION_ID_FILE}.tmp.$$"
  (umask 077 && printf '%s\n' "$session_id" > "$tmp") || return 1
  mv "$tmp" "$SESSION_ID_FILE"
}

_lead_clear_orphan_body() {
  if _lead_restore_orphan_session; then
    log "Recovered session identity before clearing orphan Lead body"
  else
    log "WARNING: orphan Lead body session identity was unavailable; clearing exact holder tuple"
  fi
  lead_body_hard_clear \
    "$PROJECT_NAME" "$LEAD_ID" claude-code \
    "$LEAD_LEASE_ORPHAN_HOLDER_PID" "$LEAD_LEASE_ORPHAN_HOLDER_START"
}

# Return 0 when another exact Lead body exists, 1 when the archived body is the
# only exact match, and 2 when the process table cannot be read. The exclusion
# is a frozen pane pid already proven by the archive tuple.
_lead_identity_conflict_excluding() {
  local lead_id="$1" excluded_pid="$2" snapshot="" rc=0 pid="" command=""
  snapshot="$(LC_ALL=C ps -axo pid=,command= 2>/dev/null)" || rc=$?
  [ "$rc" -eq 0 ] || return 2
  while read -r pid command; do
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    [ "$pid" = "$excluded_pid" ] && continue
    if lead_identity_command_matches "$command" "$lead_id"; then
      _lead_identity_conflict="${pid}"$'\t'"${command}"
      return 0
    fi
  done <<EOF
$snapshot
EOF
  return 1
}

# Store-authorized takeover of an already-bound body.
# rc 0 adopted; rc 1 positive tuple/identity mismatch; rc 2 positive second
# exact body; rc 3 sensor or TOCTOU indeterminate. Only rc 1 may flow to the
# existing evidence-gated replacement path.
_lead_try_adopt_body() {
  local holder_pid="$1" holder_start="$2"
  local a_server a_pane a_start a_window state_rc=0 conflict_rc=0
  tmux_supervisor_archive_read "$TMUX_ARCHIVE_FILE" || return 3
  a_server="$TMUX_ARCHIVE_SERVER_PID"
  a_pane="$TMUX_ARCHIVE_PANE_PID"
  a_start="$TMUX_ARCHIVE_PANE_START"
  a_window="$TMUX_ARCHIVE_WINDOW_ID"
  [ "$holder_pid" = "$a_pane" ] && [ "$holder_start" = "$a_start" ] || return 1

  tmux_supervisor_archived_process_state "$TMUX_ARCHIVE_FILE" "$LEAD_ID" || state_rc=$?
  case "$state_rc" in 1) return 1 ;; 2) return 3 ;; esac
  _tmux_target_matches_archive "$a_window" true || return 3
  [ "$TMUX_ARCHIVE_SERVER_PID" = "$a_server" ] \
    && [ "$TMUX_ARCHIVE_PANE_PID" = "$a_pane" ] \
    && [ "$TMUX_ARCHIVE_PANE_START" = "$a_start" ] \
    && [ "$TMUX_ARCHIVE_WINDOW_ID" = "$a_window" ] \
    || return 3

  _lead_identity_conflict_excluding "$LEAD_ID" "$a_pane" || conflict_rc=$?
  case "$conflict_rc" in 0) return 2 ;; 1) ;; *) return 3 ;; esac

  LEAD_WINDOW_ID="$a_window"
  TMUX_SERVER_PID="$a_server"
  LEAD_BODY_PROVENANCE=adopted
  record_lead_body_evidence_best_effort adopted "$a_pane" "$a_start"
  log "Adopted existing Lead body PID ${a_pane} (window ${LEAD_WINDOW_ID}); resuming KeepAlive monitoring"
  return 0
}

# rc 0: this supervisor's bound body and archived tmux window are the same
# executable tuple. rc 1: holder is dead/zombie. rc 2: process sensor failed.
# rc 3: a live holder exists, but its window/archive identity is not closed.
_lead_bound_body_ready() {
  local tuple_rc=0
  _lead_body_tuple_state \
    "$LEAD_LEASE_ORPHAN_HOLDER_PID" "$LEAD_LEASE_ORPHAN_HOLDER_START" \
    || tuple_rc=$?
  [ "$tuple_rc" -eq 0 ] || return "$tuple_rc"
  if [ -z "$LEAD_WINDOW_ID" ]; then
    tmux_supervisor_archive_read "$TMUX_ARCHIVE_FILE" || return 3
    LEAD_WINDOW_ID="$TMUX_ARCHIVE_WINDOW_ID"
  fi
  _tmux_target_matches_archive "$LEAD_WINDOW_ID" true || return 3
  [ "$TMUX_ARCHIVE_PANE_PID" = "$LEAD_LEASE_ORPHAN_HOLDER_PID" ] \
    && [ "$TMUX_ARCHIVE_PANE_START" = "$LEAD_LEASE_ORPHAN_HOLDER_START" ] \
    || return 3
  [ -n "${LEAD_BODY_PROVENANCE:-}" ] || LEAD_BODY_PROVENANCE=adopted
  if command -v record_lead_body_evidence_best_effort >/dev/null 2>&1; then
    record_lead_body_evidence_best_effort adopted \
      "$LEAD_LEASE_ORPHAN_HOLDER_PID" "$LEAD_LEASE_ORPHAN_HOLDER_START" \
      || true
  fi
  return 0
}

_lead_pending_file() {
  printf '%s.pending\n' "${TMUX_ARCHIVE_FILE%.tmux}"
}

_lead_fence_path() {
  local nonce="$1"
  case "$nonce" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
  printf '%s.client.%s\n' "${TMUX_ARCHIVE_FILE%.tmux}" "$nonce"
}

_lead_record_field_safe() {
  [ -n "$1" ] && [ "$1" != - ] || return 1
  case "$1" in *$'\t'*|*$'\n'*) return 1 ;; esac
}

# state, nonce, intent_ts, expected_server, creator tuple, client tuple,
# normalized socket, and optional completed window tuple. Missing fields use
# a literal '-' so Bash 3.2 IFS parsing cannot collapse evidence columns.
_lead_pending_write() {
  [ "$#" -eq 13 ] || return 1
  local state="$1" nonce="$2" intent_ts="$3" expected="$4"
  local creator_pid="$5" creator_start="$6" client_pid="$7" client_start="$8"
  local socket_path="$9" created_pid="${10}" window_id="${11}"
  local pane_pid="${12}" pane_start="${13}" file tmp
  case "$state" in prepared|client-recorded|complete) ;; *) return 1 ;; esac
  case "$nonce" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
  case "$intent_ts:$expected:$creator_pid" in *[!0-9:]*|:*|*:) return 1 ;; esac
  _lead_record_field_safe "$creator_start" && _lead_record_field_safe "$socket_path" \
    || return 1
  case "$state" in
    prepared)
      [ "$client_pid:$client_start:$created_pid:$window_id:$pane_pid:$pane_start" = '-:-:-:-:-:-' ] \
        || return 1
      ;;
    client-recorded)
      case "$client_pid" in ''|*[!0-9]*) return 1 ;; esac
      _lead_record_field_safe "$client_start" || return 1
      [ "$created_pid:$window_id:$pane_pid:$pane_start" = '-:-:-:-' ] || return 1
      ;;
    complete)
      case "$client_pid:$created_pid:$pane_pid" in *[!0-9:]*|:*|*:) return 1 ;; esac
      _lead_record_field_safe "$client_start" \
        && _lead_record_field_safe "$window_id" \
        && _lead_record_field_safe "$pane_start" || return 1
      ;;
  esac
  file="$(_lead_pending_file)" || return 1
  tmp="${file}.tmp.$$"
  (umask 077
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$state" "$nonce" "$intent_ts" "$expected" "$creator_pid" "$creator_start" \
      "$client_pid" "$client_start" "$socket_path" "$created_pid" "$window_id" \
      "$pane_pid" "$pane_start" > "$tmp" \
      && chmod 600 "$tmp" \
      && mv "$tmp" "$file")
}

_lead_pending_read() {
  local file extra=""
  file="$(_lead_pending_file)" || return 1
  LEAD_PENDING_STATE=""; LEAD_PENDING_NONCE=""; LEAD_PENDING_INTENT_TS=""
  LEAD_PENDING_EXPECTED_SERVER_PID=""; LEAD_PENDING_CREATOR_PID=""
  LEAD_PENDING_CREATOR_START=""; LEAD_PENDING_CLIENT_PID=""
  LEAD_PENDING_CLIENT_START=""; LEAD_PENDING_SOCKET=""
  LEAD_PENDING_CREATED_SERVER_PID=""; LEAD_PENDING_WINDOW_ID=""
  LEAD_PENDING_PANE_PID=""; LEAD_PENDING_PANE_START=""
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  IFS=$'\t' read -r LEAD_PENDING_STATE LEAD_PENDING_NONCE LEAD_PENDING_INTENT_TS \
    LEAD_PENDING_EXPECTED_SERVER_PID LEAD_PENDING_CREATOR_PID LEAD_PENDING_CREATOR_START \
    LEAD_PENDING_CLIENT_PID LEAD_PENDING_CLIENT_START LEAD_PENDING_SOCKET \
    LEAD_PENDING_CREATED_SERVER_PID LEAD_PENDING_WINDOW_ID LEAD_PENDING_PANE_PID \
    LEAD_PENDING_PANE_START extra < "$file" || return 1
  [ -z "$extra" ] || return 1
  case "$LEAD_PENDING_STATE" in prepared|client-recorded|complete) ;; *) return 1 ;; esac
  case "$LEAD_PENDING_NONCE" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
  case "$LEAD_PENDING_INTENT_TS:$LEAD_PENDING_EXPECTED_SERVER_PID:$LEAD_PENDING_CREATOR_PID" in
    *[!0-9:]*|:*|*:) return 1 ;;
  esac
  _lead_record_field_safe "$LEAD_PENDING_CREATOR_START" \
    && _lead_record_field_safe "$LEAD_PENDING_SOCKET" || return 1
  case "$LEAD_PENDING_STATE" in
    prepared)
      [ "$LEAD_PENDING_CLIENT_PID:$LEAD_PENDING_CLIENT_START:$LEAD_PENDING_CREATED_SERVER_PID:$LEAD_PENDING_WINDOW_ID:$LEAD_PENDING_PANE_PID:$LEAD_PENDING_PANE_START" = '-:-:-:-:-:-' ]
      ;;
    client-recorded)
      case "$LEAD_PENDING_CLIENT_PID" in ''|*[!0-9]*) return 1 ;; esac
      _lead_record_field_safe "$LEAD_PENDING_CLIENT_START" \
        && [ "$LEAD_PENDING_CREATED_SERVER_PID:$LEAD_PENDING_WINDOW_ID:$LEAD_PENDING_PANE_PID:$LEAD_PENDING_PANE_START" = '-:-:-:-' ]
      ;;
    complete)
      case "$LEAD_PENDING_CLIENT_PID:$LEAD_PENDING_CREATED_SERVER_PID:$LEAD_PENDING_PANE_PID" in
        *[!0-9:]*|:*|*:) return 1 ;;
      esac
      _lead_record_field_safe "$LEAD_PENDING_CLIENT_START" \
        && _lead_record_field_safe "$LEAD_PENDING_WINDOW_ID" \
        && _lead_record_field_safe "$LEAD_PENDING_PANE_START"
      ;;
  esac
}

_lead_fence_write() {
  [ "$#" -eq 8 ] || return 1
  local nonce="$1" intent_ts="$2" expected="$3" creator_pid="$4"
  local creator_start="$5" client_pid="$6" client_start="$7" socket_path="$8"
  local file tmp
  case "$nonce" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
  case "$intent_ts:$expected:$creator_pid:$client_pid" in *[!0-9:]*|:*|*:) return 1 ;; esac
  _lead_record_field_safe "$creator_start" \
    && _lead_record_field_safe "$client_start" \
    && _lead_record_field_safe "$socket_path" || return 1
  file="$(_lead_fence_path "$nonce")" || return 1
  # Keep the publication temp outside `${base}.client.*`: a crash between the
  # write and mv must not leave a malformed file that the independent fence
  # census mistakes for durable in-flight ownership evidence.
  tmp="${TMUX_ARCHIVE_FILE%.tmux}.tmp.client.${nonce}.$$"
  (umask 077
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$nonce" "$intent_ts" "$expected" "$creator_pid" "$creator_start" \
      "$client_pid" "$client_start" "$socket_path" > "$tmp" \
      && chmod 600 "$tmp" \
      && mv "$tmp" "$file")
}

_lead_fence_read() {
  local file="$1" extra=""
  LEAD_FENCE_NONCE=""; LEAD_FENCE_INTENT_TS=""; LEAD_FENCE_EXPECTED_SERVER_PID=""
  LEAD_FENCE_CREATOR_PID=""; LEAD_FENCE_CREATOR_START=""
  LEAD_FENCE_CLIENT_PID=""; LEAD_FENCE_CLIENT_START=""; LEAD_FENCE_SOCKET=""
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  IFS=$'\t' read -r LEAD_FENCE_NONCE LEAD_FENCE_INTENT_TS \
    LEAD_FENCE_EXPECTED_SERVER_PID LEAD_FENCE_CREATOR_PID LEAD_FENCE_CREATOR_START \
    LEAD_FENCE_CLIENT_PID LEAD_FENCE_CLIENT_START LEAD_FENCE_SOCKET extra \
    < "$file" || return 1
  [ -z "$extra" ] || return 1
  case "$LEAD_FENCE_NONCE" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
  case "$LEAD_FENCE_INTENT_TS:$LEAD_FENCE_EXPECTED_SERVER_PID:$LEAD_FENCE_CREATOR_PID:$LEAD_FENCE_CLIENT_PID" in
    *[!0-9:]*|:*|*:) return 1 ;;
  esac
  _lead_record_field_safe "$LEAD_FENCE_CREATOR_START" \
    && _lead_record_field_safe "$LEAD_FENCE_CLIENT_START" \
    && _lead_record_field_safe "$LEAD_FENCE_SOCKET"
}

_lead_pending_matches_archive() {
  [ "$LEAD_PENDING_STATE" = complete ] \
    && [ "$TMUX_ARCHIVE_SERVER_PID" = "$LEAD_PENDING_CREATED_SERVER_PID" ] \
    && [ "$TMUX_ARCHIVE_WINDOW_ID" = "$LEAD_PENDING_WINDOW_ID" ] \
    && [ "$TMUX_ARCHIVE_PANE_PID" = "$LEAD_PENDING_PANE_PID" ] \
    && [ "$TMUX_ARCHIVE_PANE_START" = "$LEAD_PENDING_PANE_START" ]
}

_lead_pending_fence_consistent() {
  [ "$LEAD_FENCE_NONCE" = "$LEAD_PENDING_NONCE" ] \
    && [ "$LEAD_FENCE_INTENT_TS" = "$LEAD_PENDING_INTENT_TS" ] \
    && [ "$LEAD_FENCE_EXPECTED_SERVER_PID" = "$LEAD_PENDING_EXPECTED_SERVER_PID" ] \
    && [ "$LEAD_FENCE_CREATOR_PID" = "$LEAD_PENDING_CREATOR_PID" ] \
    && [ "$LEAD_FENCE_CREATOR_START" = "$LEAD_PENDING_CREATOR_START" ] \
    && [ "$LEAD_FENCE_CLIENT_PID" = "$LEAD_PENDING_CLIENT_PID" ] \
    && [ "$LEAD_FENCE_CLIENT_START" = "$LEAD_PENDING_CLIENT_START" ] \
    && [ "$LEAD_FENCE_SOCKET" = "$LEAD_PENDING_SOCKET" ]
}

_lead_retire_pending_and_fence() {
  local pending_file fence_file
  pending_file="$(_lead_pending_file)" || return 3
  fence_file="$(_lead_fence_path "$LEAD_PENDING_NONCE")" || return 3
  rm -f "$fence_file" 2>/dev/null || return 3
  if ! rm -f "$pending_file" 2>/dev/null; then
    _lead_fence_write "$LEAD_PENDING_NONCE" "$LEAD_PENDING_INTENT_TS" \
      "$LEAD_PENDING_EXPECTED_SERVER_PID" "$LEAD_PENDING_CREATOR_PID" \
      "$LEAD_PENDING_CREATOR_START" "$LEAD_PENDING_CLIENT_PID" \
      "$LEAD_PENDING_CLIENT_START" "$LEAD_PENDING_SOCKET" || true
    return 3
  fi
  return 0
}

_lead_exact_process_state() {
  local pid="$1" expected_start="$2" lead_id="$3" rc=0 actual_start="" command=""
  _tmux_supervisor_process_presence_state "$pid" || rc=$?
  case "$rc" in 1) return 1 ;; 2) return 2 ;; esac
  actual_start="$(tmux_supervisor_process_start_identity "$pid")" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$actual_start" ]; then
    _tmux_supervisor_process_presence_state "$pid"
    rc=$?
    [ "$rc" -eq 1 ] && return 1
    return 2
  fi
  [ "$actual_start" = "$expected_start" ] || return 1
  rc=0
  command="$(_tmux_supervisor_process_command "$pid")" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$command" ]; then
    _tmux_supervisor_process_presence_state "$pid"
    rc=$?
    [ "$rc" -eq 1 ] && return 1
    return 2
  fi
  lead_identity_command_matches "$command" "$lead_id" || return 1
  return 0
}

_lead_process_tuple_state() {
  # rc 0 exact live tuple; rc 1 positive absence/PID reuse; rc 2 sensor error.
  local pid="$1" expected_start="$2" rc=0 actual_start=""
  _tmux_supervisor_process_presence_state "$pid" || rc=$?
  case "$rc" in 1) return 1 ;; 2) return 2 ;; esac
  actual_start="$(tmux_supervisor_process_start_identity "$pid")" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$actual_start" ]; then
    _tmux_supervisor_process_presence_state "$pid"
    rc=$?
    [ "$rc" -eq 1 ] && return 1
    return 2
  fi
  [ "$actual_start" = "$expected_start" ] && return 0
  return 1
}

_lead_reserved_snapshot() {
  local expected_pid="$1" socket_path timeout rc=0
  _lead_tmux_generation_state "$expected_pid" || rc=$?
  case "$rc" in
    0) ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
  socket_path="$(_tmux_socket_path)" || return 2
  timeout="$(_tmux_rescue_effective_timeout command)" || return 2
  tmux_rescue_probe "$timeout" tmux -S "$socket_path" \
    list-windows -t =flywheel \
    -F '#{window_id}	#{window_name}	#{pane_pid}	#{pid}' 2>/dev/null
}

_lead_reserved_window_probe() {
  # rc 0 exactly one matching reserved window; rc 1 none; rc 2 conflict/error.
  local nonce="$1" snapshot="" rc=0 extra window_id name pane_pid server_pid count=0
  LEAD_RESERVED_WINDOW_ID=""; LEAD_RESERVED_PANE_PID=""; LEAD_RESERVED_SERVER_PID=""
  snapshot="$(_lead_reserved_snapshot "$LEAD_PENDING_EXPECTED_SERVER_PID")" || rc=$?
  case "$rc" in
    0) ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
  while IFS=$'\t' read -r window_id name pane_pid server_pid extra; do
    [ -z "$extra" ] || return 2
    [ "$name" = "${PROJECT_NAME}-${LEAD_ID}.p-${nonce}" ] || continue
    case "$server_pid:$pane_pid" in *[!0-9:]*|:*|*:) return 2 ;; esac
    _lead_record_field_safe "$window_id" || return 2
    count=$((count + 1))
    LEAD_RESERVED_WINDOW_ID="$window_id"
    LEAD_RESERVED_PANE_PID="$pane_pid"
    LEAD_RESERVED_SERVER_PID="$server_pid"
  done <<EOF
$snapshot
EOF
  [ "$count" -eq 0 ] && return 1
  [ "$count" -eq 1 ] && return 0
  return 2
}

_lead_reserved_any_probe() {
  # rc 0 one-or-more reserved windows; rc 1 none; rc 2 sensor/error.
  local expected_pid="$1" snapshot="" rc=0 extra window_id name pane_pid server_pid
  snapshot="$(_lead_reserved_snapshot "$expected_pid")" || rc=$?
  case "$rc" in
    0) ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
  while IFS=$'\t' read -r window_id name pane_pid server_pid extra; do
    [ -z "$extra" ] || return 2
    case "$name" in "${PROJECT_NAME}-${LEAD_ID}.p-"*) return 0 ;; esac
  done <<EOF
$snapshot
EOF
  return 1
}

_lead_pending_tuple_live_exact() {
  local pane_pid rc=0 generation_rc=0
  [ "$LEAD_PENDING_STATE" = complete ] || return 2
  _lead_exact_process_state "$LEAD_PENDING_PANE_PID" \
    "$LEAD_PENDING_PANE_START" "$LEAD_ID" || return $?
  _lead_tmux_generation_state "$LEAD_PENDING_CREATED_SERVER_PID" \
    || generation_rc=$?
  case "$generation_rc" in
    0) ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
  pane_pid="$(_tmux list-panes -t "$LEAD_PENDING_WINDOW_ID" \
    -F '#{pane_pid}' 2>/dev/null | head -1)" || return 2
  [ "$pane_pid" = "$LEAD_PENDING_PANE_PID" ] || return 1
  _lead_exact_process_state "$LEAD_PENDING_PANE_PID" \
    "$LEAD_PENDING_PANE_START" "$LEAD_ID" || rc=$?
  return "$rc"
}

# Kill only a fully frozen server/window/pane/start tuple. Success means either
# the window is positively absent or the exact pane process is positively gone;
# uncertainty preserves every caller-owned evidence file.
_lead_cleanup_exact_tuple() {
  local server_pid="$1" window_id="$2" pane_pid="$3" pane_start="$4"
  local observed_pid process_rc=0 generation_rc=0 probe_err
  _lead_tmux_generation_state "$server_pid" || generation_rc=$?
  case "$generation_rc" in
    0) ;;
    1) return 0 ;;
    *) return 3 ;;
  esac
  observed_pid="$(_tmux list-panes -t "$window_id" -F '#{pane_pid}' 2>/dev/null | head -1)" \
    || return 3
  [ "$observed_pid" = "$pane_pid" ] || return 3
  _lead_exact_process_state "$pane_pid" "$pane_start" "$LEAD_ID" || process_rc=$?
  [ "$process_rc" -ne 2 ] || return 3
  generation_rc=0
  _lead_tmux_generation_state "$server_pid" || generation_rc=$?
  case "$generation_rc" in
    0) ;;
    1) return 0 ;;
    *) return 3 ;;
  esac
  _tmux kill-window -t "$window_id" 2>/dev/null || return 3
  probe_err="$(mktemp -t fly1659-cleanup.XXXXXX)" || return 3
  if _tmux list-panes -t "$window_id" >/dev/null 2> "$probe_err"; then
    rm -f "$probe_err"
    return 3
  fi
  if _tmux_window_absence_proven "$(cat "$probe_err" 2>/dev/null)"; then
    rm -f "$probe_err"
    return 0
  fi
  rm -f "$probe_err"
  process_rc=0
  _lead_exact_process_state "$pane_pid" "$pane_start" "$LEAD_ID" || process_rc=$?
  [ "$process_rc" -eq 1 ] && return 0
  return 3
}

# Cleanup after create produced a full tuple but archive or lease commit failed.
# Evidence is retired only after the exact window is positively absent. A
# matching archive is removed last among body evidence and before the transient
# ledgers; any malformed/conflicting record remains fail-closed for recovery.
_lead_cleanup_failed_create() {
  local server_pid="$1" window_id="$2" pane_pid="$3" pane_start="$4"
  local fence_file
  _lead_cleanup_exact_tuple "$server_pid" "$window_id" "$pane_pid" "$pane_start" \
    || return 3

  if [ -e "$TMUX_ARCHIVE_FILE" ]; then
    tmux_supervisor_archive_read "$TMUX_ARCHIVE_FILE" || return 3
    [ "$TMUX_ARCHIVE_SERVER_PID" = "$server_pid" ] \
      && [ "$TMUX_ARCHIVE_WINDOW_ID" = "$window_id" ] \
      && [ "$TMUX_ARCHIVE_PANE_PID" = "$pane_pid" ] \
      && [ "$TMUX_ARCHIVE_PANE_START" = "$pane_start" ] \
      || return 3
    rm -f "$TMUX_ARCHIVE_FILE" 2>/dev/null || return 3
  fi

  _lead_pending_read || return 3
  [ "$LEAD_PENDING_STATE" = complete ] \
    && [ "$LEAD_PENDING_CREATED_SERVER_PID" = "$server_pid" ] \
    && [ "$LEAD_PENDING_WINDOW_ID" = "$window_id" ] \
    && [ "$LEAD_PENDING_PANE_PID" = "$pane_pid" ] \
    && [ "$LEAD_PENDING_PANE_START" = "$pane_start" ] \
    || return 3
  fence_file="$(_lead_fence_path "$LEAD_PENDING_NONCE")" || return 3
  _lead_fence_read "$fence_file" || return 3
  _lead_pending_fence_consistent || return 3
  _lead_retire_pending_and_fence
}

# Reconcile one crash-durable create record after lease acquisition has
# produced a typed disposition. Malformed or conflicting evidence holds intact;
# degraded identity state may retire only on positive tuple absence, or rebuild
# the archive from a still-live exact tuple without killing it.
_lead_reconcile_pending_launch() {
  local lease_rc="$1" pending_file fence_file socket_path tuple_rc=0
  pending_file="$(_lead_pending_file)" || return 3
  [ -e "$pending_file" ] || return 0
  _lead_pending_read || return 3
  socket_path="$(_tmux_socket_path)" || return 3
  [ "$LEAD_PENDING_SOCKET" = "$socket_path" ] || return 3

  case "$LEAD_PENDING_STATE" in
    client-recorded|complete)
      fence_file="$(_lead_fence_path "$LEAD_PENDING_NONCE")" || return 3
      if [ -e "$fence_file" ]; then
        _lead_fence_read "$fence_file" || return 3
        _lead_pending_fence_consistent || return 3
      fi
      ;;
  esac

  if [ "$LEAD_PENDING_STATE" = complete ] && [ -e "$TMUX_ARCHIVE_FILE" ]; then
    tmux_supervisor_archive_read "$TMUX_ARCHIVE_FILE" || return 3
    _lead_pending_matches_archive || return 3
    case "$lease_rc" in
      4)
        [ "$LEAD_LEASE_ORPHAN_HOLDER_PID" = "$LEAD_PENDING_PANE_PID" ] \
          && [ "$LEAD_LEASE_ORPHAN_HOLDER_START" = "$LEAD_PENDING_PANE_START" ] \
          || return 3
        ;;
      5|6) ;;
      0) [ "${LEAD_LEASE_FRESH:-0}" -eq 1 ] || return 3 ;;
      *) return 3 ;;
    esac
    _lead_retire_pending_and_fence
    return $?
  fi
  if [ "$LEAD_PENDING_STATE" = complete ] && [ ! -e "$TMUX_ARCHIVE_FILE" ]; then
    case "$lease_rc" in
      4|5)
        [ "$LEAD_LEASE_ORPHAN_HOLDER_PID" = "$LEAD_PENDING_PANE_PID" ] \
          && [ "$LEAD_LEASE_ORPHAN_HOLDER_START" = "$LEAD_PENDING_PANE_START" ] \
          || return 3
        _lead_pending_tuple_live_exact || return 3
        tmux_supervisor_archive_write "$TMUX_ARCHIVE_FILE" \
          "$LEAD_PENDING_CREATED_SERVER_PID" "$LEAD_PENDING_PANE_PID" \
          "$LEAD_PENDING_PANE_START" "$LEAD_PENDING_WINDOW_ID" || return 3
        _lead_retire_pending_and_fence
        return $?
        ;;
      0)
        if [ "${LEAD_LEASE_FRESH:-0}" -eq 1 ]; then
          _lead_cleanup_exact_tuple "$LEAD_PENDING_CREATED_SERVER_PID" \
            "$LEAD_PENDING_WINDOW_ID" "$LEAD_PENDING_PANE_PID" \
            "$LEAD_PENDING_PANE_START" || return 3
        elif [ "${LEAD_LEASE_DEGRADED:-}" = store_error ]; then
          _lead_pending_tuple_live_exact || tuple_rc=$?
          case "$tuple_rc" in
            0)
              tmux_supervisor_archive_write "$TMUX_ARCHIVE_FILE" \
                "$LEAD_PENDING_CREATED_SERVER_PID" "$LEAD_PENDING_PANE_PID" \
                "$LEAD_PENDING_PANE_START" "$LEAD_PENDING_WINDOW_ID" || return 3
              ;;
            1) ;;
            *) return 3 ;;
          esac
        else
          return 3
        fi
        _lead_retire_pending_and_fence
        return $?
        ;;
      6)
        _lead_pending_tuple_live_exact || tuple_rc=$?
        case "$tuple_rc" in
          0)
            tmux_supervisor_archive_write "$TMUX_ARCHIVE_FILE" \
              "$LEAD_PENDING_CREATED_SERVER_PID" "$LEAD_PENDING_PANE_PID" \
              "$LEAD_PENDING_PANE_START" "$LEAD_PENDING_WINDOW_ID" || return 3
            ;;
          1) ;;
          *) return 3 ;;
        esac
        _lead_retire_pending_and_fence
        return $?
        ;;
    esac
  fi
  case "$LEAD_PENDING_STATE" in
    prepared|client-recorded)
      case "$lease_rc" in 0|4|5|6) ;; *) return 3 ;; esac
      local reserved_rc=0 creator_rc=0 client_rc=1 pane_start=""
      _lead_reserved_window_probe "$LEAD_PENDING_NONCE" || reserved_rc=$?
      case "$reserved_rc" in
        0)
          pane_start="$(tmux_supervisor_process_start_identity "$LEAD_RESERVED_PANE_PID")" \
            || return 3
          [ -n "$pane_start" ] || return 3
          _lead_pending_write complete "$LEAD_PENDING_NONCE" "$LEAD_PENDING_INTENT_TS" \
            "$LEAD_PENDING_EXPECTED_SERVER_PID" "$LEAD_PENDING_CREATOR_PID" \
            "$LEAD_PENDING_CREATOR_START" "$LEAD_PENDING_CLIENT_PID" \
            "$LEAD_PENDING_CLIENT_START" "$LEAD_PENDING_SOCKET" \
            "$LEAD_RESERVED_SERVER_PID" "$LEAD_RESERVED_WINDOW_ID" \
            "$LEAD_RESERVED_PANE_PID" "$pane_start" || return 3
          _lead_reconcile_pending_launch "$lease_rc"
          return $?
          ;;
        2) return 3 ;;
      esac

      if [ "$LEAD_PENDING_STATE" = client-recorded ]; then
        _lead_process_tuple_state "$LEAD_PENDING_CLIENT_PID" \
          "$LEAD_PENDING_CLIENT_START" || client_rc=$?
        [ "$client_rc" -eq 1 ] || return 3
      fi
      if [ "$LEAD_PENDING_CREATOR_PID" = "$$" ] \
        && [ "$LEAD_PENDING_CREATOR_START" = "${LEAD_LEASE_SUPERVISOR_START:-}" ]; then
        _lead_retire_pending_and_fence
        return $?
      fi
      _lead_process_tuple_state "$LEAD_PENDING_CREATOR_PID" \
        "$LEAD_PENDING_CREATOR_START" || creator_rc=$?
      [ "$creator_rc" -eq 1 ] || return 3
      sleep 0.1
      reserved_rc=0
      _lead_reserved_window_probe "$LEAD_PENDING_NONCE" || reserved_rc=$?
      [ "$reserved_rc" -eq 1 ] || return 3
      _lead_retire_pending_and_fence
      return $?
      ;;
  esac
  return 3
}

_lead_prelaunch_isolation_gate() {
  local pending_file base fence socket_path client_rc creator_rc reserved_rc
  pending_file="$(_lead_pending_file)" || return 3
  [ ! -e "$pending_file" ] || return 3
  socket_path="$(_tmux_socket_path)" || return 3
  base="${TMUX_ARCHIVE_FILE%.tmux}"
  for fence in "${base}.client."*; do
    [ -e "$fence" ] || continue
    _lead_fence_read "$fence" || return 3
    [ "$LEAD_FENCE_SOCKET" = "$socket_path" ] || return 3
    client_rc=0
    _lead_process_tuple_state "$LEAD_FENCE_CLIENT_PID" "$LEAD_FENCE_CLIENT_START" \
      || client_rc=$?
    [ "$client_rc" -eq 1 ] || return 3
    creator_rc=0
    _lead_process_tuple_state "$LEAD_FENCE_CREATOR_PID" "$LEAD_FENCE_CREATOR_START" \
      || creator_rc=$?
    [ "$creator_rc" -eq 1 ] || return 3
    LEAD_PENDING_EXPECTED_SERVER_PID="$LEAD_FENCE_EXPECTED_SERVER_PID"
    reserved_rc=0
    _lead_reserved_window_probe "$LEAD_FENCE_NONCE" || reserved_rc=$?
    [ "$reserved_rc" -eq 1 ] || return 3
    sleep 0.1
    reserved_rc=0
    _lead_reserved_window_probe "$LEAD_FENCE_NONCE" || reserved_rc=$?
    [ "$reserved_rc" -eq 1 ] || return 3
    rm -f "$fence" 2>/dev/null || return 3
  done

  reserved_rc=0
  _lead_reserved_any_probe "$TMUX_SERVER_PID" || reserved_rc=$?
  [ "$reserved_rc" -eq 1 ] || return 3
  sleep 0.1
  reserved_rc=0
  _lead_reserved_any_probe "$TMUX_SERVER_PID" || reserved_rc=$?
  [ "$reserved_rc" -eq 1 ] || return 3
  return 0
}

# Create one Lead window through a two-phase FIFO gate. The parent persists the
# exact tmux-client tuple in both the pending intent and an independent fence
# before releasing the client. The tmux format result is the acceptance
# evidence; forensic socket inspection is deliberately absent from this path.
# `env_args` is the caller-local array exposed through Bash dynamic scope.
_lead_create_tmux_window() {
  local window_name="$1"
  shift
  local -a launch_args=("$@")
  local nonce intent_ts expected_pid creator_start socket_path pending_file fence_file
  local gate_file out_file err_file client_pid client_start="" client_i=0 create_rc=0
  local result window_id pane_pid created_pid extra="" pane_start="" pane_i=0

  expected_pid="$TMUX_SERVER_PID"
  case "$expected_pid" in ''|*[!0-9]*) return 3 ;; esac
  socket_path="$(_tmux_socket_path)" || return 3
  creator_start="${LEAD_LEASE_SUPERVISOR_START:-}"
  [ -n "$creator_start" ] \
    || creator_start="$(tmux_supervisor_process_start_identity "$$")" \
    || return 3
  intent_ts="$(date +%s)" || return 3
  nonce="${intent_ts}-$$-${RANDOM}-${RANDOM}"
  pending_file="$(_lead_pending_file)" || return 3
  fence_file="$(_lead_fence_path "$nonce")" || return 3
  gate_file="${pending_file}.gate.${nonce}"
  out_file="${pending_file}.out.${nonce}"
  err_file="${pending_file}.err.${nonce}"

  _lead_pending_write prepared "$nonce" "$intent_ts" "$expected_pid" \
    "$$" "$creator_start" - - "$socket_path" - - - - || return 3
  (umask 077; : > "$out_file" && : > "$err_file") || return 3
  mkfifo "$gate_file" 2>/dev/null || return 3
  chmod 600 "$gate_file" 2>/dev/null || return 3
  exec 9<> "$gate_file" || return 3

  (
    exec 9>&-
    local gate_token=""
    IFS= read -r gate_token < "$gate_file" || exit 125
    [ "$gate_token" = go ] || exit 125
    exec tmux -S "$socket_path" -N new-window -d -P \
      -F '#{window_id}	#{pane_pid}	#{pid}' \
      -t =flywheel \
      "${env_args[@]}" \
      -n "${window_name}.p-${nonce}" \
      -c "$LEAD_WORKSPACE" \
      claude "${launch_args[@]}"
  ) > "$out_file" 2> "$err_file" &
  client_pid=$!

  while [ "$client_i" -lt 20 ] && [ -z "$client_start" ]; do
    client_start="$(tmux_supervisor_process_start_identity "$client_pid" || true)"
    [ -n "$client_start" ] || sleep 0.05
    client_i=$((client_i + 1))
  done
  if [ -z "$client_start" ] \
    || ! _lead_pending_write client-recorded "$nonce" "$intent_ts" "$expected_pid" \
      "$$" "$creator_start" "$client_pid" "$client_start" "$socket_path" - - - - \
    || ! _lead_fence_write "$nonce" "$intent_ts" "$expected_pid" \
      "$$" "$creator_start" "$client_pid" "$client_start" "$socket_path"; then
    # The child was never authorized to create. Keep our FIFO writer open
    # until it consumes an explicit stop token; closing first can race a child
    # that has not opened the FIFO yet and lose the only wakeup.
    if ! printf 'stop\n' >&9; then
      kill "$client_pid" 2>/dev/null || true
    fi
    wait "$client_pid" 2>/dev/null || true
    exec 9>&-
    if _lead_pending_read \
      && [ "$LEAD_PENDING_NONCE" = "$nonce" ] \
      && [ "$LEAD_PENDING_CREATOR_PID" = "$$" ] \
      && [ "$LEAD_PENDING_CREATOR_START" = "$creator_start" ]; then
      _lead_retire_pending_and_fence || true
    fi
    rm -f "$gate_file" "$out_file" "$err_file" 2>/dev/null || true
    return 3
  fi

  if ! printf 'go\n' >&9; then
    kill "$client_pid" 2>/dev/null || true
    wait "$client_pid" 2>/dev/null || true
    exec 9>&-
    if _lead_pending_read \
      && [ "$LEAD_PENDING_NONCE" = "$nonce" ] \
      && [ "$LEAD_PENDING_CREATOR_PID" = "$$" ] \
      && [ "$LEAD_PENDING_CREATOR_START" = "$creator_start" ]; then
      _lead_retire_pending_and_fence || true
    fi
    rm -f "$gate_file" "$out_file" "$err_file" 2>/dev/null || true
    return 3
  fi
  wait "$client_pid" || create_rc=$?
  exec 9>&-
  rm -f "$gate_file" 2>/dev/null || true
  result="$(cat "$out_file" 2>/dev/null || true)"
  if [ "$create_rc" -ne 0 ] \
    || ! IFS=$'\t' read -r window_id pane_pid created_pid extra <<EOF
$result
EOF
  then
    ENSURE_HOLD_KIND="unknown"
    ENSURE_HOLD_EVIDENCE="{\"reason\":\"tmux_create_result_indeterminate\",\"exitCode\":${create_rc}}"
    rm -f "$out_file" "$err_file" 2>/dev/null || true
    return 3
  fi
  case "$created_pid:$pane_pid" in
    *[!0-9:]*|:*|*:)
      rm -f "$out_file" "$err_file" 2>/dev/null || true
      return 3
      ;;
  esac
  if ! _lead_record_field_safe "$window_id" || [ -n "$extra" ]; then
    rm -f "$out_file" "$err_file" 2>/dev/null || true
    return 3
  fi

  while [ "$pane_i" -lt 20 ] && [ -z "$pane_start" ]; do
    pane_start="$(tmux_supervisor_process_start_identity "$pane_pid" || true)"
    [ -n "$pane_start" ] || sleep 0.05
    pane_i=$((pane_i + 1))
  done
  if [ -z "$pane_start" ]; then
    rm -f "$out_file" "$err_file" 2>/dev/null || true
    return 3
  fi
  if ! _lead_pending_write complete "$nonce" "$intent_ts" "$expected_pid" \
    "$$" "$creator_start" "$client_pid" "$client_start" "$socket_path" \
    "$created_pid" "$window_id" "$pane_pid" "$pane_start"; then
    rm -f "$out_file" "$err_file" 2>/dev/null || true
    return 3
  fi

  LEAD_WINDOW_ID="$window_id"
  if [ "$created_pid" != "$expected_pid" ]; then
    ENSURE_HOLD_KIND="split_brain"
    ENSURE_HOLD_EVIDENCE="{\"reason\":\"created_generation_changed\",\"expectedPid\":${expected_pid},\"createdPid\":${created_pid}}"
    rm -f "$out_file" "$err_file" 2>/dev/null || true
    return 3
  fi
  if ! tmux_supervisor_archive_write "$TMUX_ARCHIVE_FILE" "$created_pid" \
    "$pane_pid" "$pane_start" "$window_id"; then
    ENSURE_HOLD_KIND="unknown"
    ENSURE_HOLD_EVIDENCE='{"reason":"archive_commit_failed"}'
    rm -f "$out_file" "$err_file" 2>/dev/null || true
    if _lead_cleanup_failed_create \
      "$created_pid" "$window_id" "$pane_pid" "$pane_start"; then
      return 1
    fi
    return 3
  fi
  if [ -n "${LEAD_LEASE_KEY:-}" ] && [ -n "${LEAD_LEASE_GENERATION:-}" ]; then
    if ! lead_identity_bind_lease \
      "$LEAD_LEASE_KEY" "$LEAD_LEASE_GENERATION" \
      "$$" "$creator_start" "$pane_pid" "$pane_start"; then
      ENSURE_HOLD_KIND="ambiguous"
      ENSURE_HOLD_EVIDENCE="{\"reason\":\"lead_lease_bind_failed\",\"generation\":${LEAD_LEASE_GENERATION}}"
      rm -f "$out_file" "$err_file" 2>/dev/null || true
      if _lead_cleanup_failed_create \
        "$created_pid" "$window_id" "$pane_pid" "$pane_start"; then
        return 1
      fi
      return 3
    fi
  fi

  # Rename is cosmetic and guarded by the complete archive tuple. A failed or
  # indeterminate rename leaves the reserved name but monitoring continues by id.
  if _tmux_target_matches_archive "$window_id" true; then
    _tmux rename-window -t "$window_id" "$window_name" 2>/dev/null || true
  fi

  if ! rm -f "$fence_file" 2>/dev/null; then
    rm -f "$out_file" "$err_file" 2>/dev/null || true
    ENSURE_HOLD_KIND="unknown"
    ENSURE_HOLD_EVIDENCE='{"reason":"client_fence_retire_failed"}'
    return 3
  fi
  if ! rm -f "$pending_file" 2>/dev/null; then
    _lead_fence_write "$nonce" "$intent_ts" "$expected_pid" \
      "$$" "$creator_start" "$client_pid" "$client_start" "$socket_path" || true
    rm -f "$out_file" "$err_file" 2>/dev/null || true
    ENSURE_HOLD_KIND="unknown"
    ENSURE_HOLD_EVIDENCE='{"reason":"pending_retire_failed"}'
    return 3
  fi
  rm -f "$out_file" "$err_file" 2>/dev/null || true
  TMUX_SERVER_PID="$created_pid"
  LEAD_BODY_PROVENANCE=launched
  record_lead_body_evidence_best_effort launched "$pane_pid" "$pane_start"
  return 0
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
  local -a launch_args=("$@")
  local _fly1496_entry="${FLYWHEEL_ROOT}/packages/teamlead/dist/lead-model-launch.js"
  local _fly1496_result=""
  local _fly1496_model="claude-fable-5"
  local _fly1496_raw_model=""
  local _fly1496_effort=""
  local _fly1496_raw_effort=""
  # FLY-1650: FLY-583's companion fallback, narrowed by the resolver to what the
  # RESOLVED model accepts. Seeded with the historical literal for the
  # resolver-unavailable path below, which launches literal Fable — a model
  # that accepts xhigh, so that path is provably byte-identical.
  local _fly1496_companion_effort=xhigh
  local _fly1496_reason="resolver_unavailable"
  local _fly1496_substituted=true
  local _fly1496_arg _fly1496_skip
  local -a _fly1496_filtered=()

  # FLY-1496: every PHYSICAL launch re-reads projects.json through the validated
  # ProjectConfig path and resolves the same hot model snapshot. Manifest and
  # frozen launchd env values are evidence only — never inputs.
  if command -v jq >/dev/null 2>&1 && [ -f "$_fly1496_entry" ]; then
    _fly1496_result="$(
      FLY1496_ENTRY="$_fly1496_entry" \
      FLY1496_PROJECT="$PROJECT_NAME" \
      FLY1496_LEAD="$LEAD_ID" \
      node --input-type=module -e '
        try {
          const mod = await import(process.env.FLY1496_ENTRY);
          const decision = mod.resolveLeadModelLaunch(
            process.env.FLY1496_PROJECT ?? "",
            process.env.FLY1496_LEAD ?? "",
          );
          process.stdout.write(JSON.stringify({ ok: true, decision }));
        } catch (error) {
          process.stdout.write(JSON.stringify({
            ok: false,
            sourceFailure: error?.code === "MODEL_SOURCE_FAILURE",
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      '
    )" || _fly1496_result=""
  fi

  if [ -n "$_fly1496_result" ] && jq -e '.ok == true' >/dev/null 2>&1 <<<"$_fly1496_result"; then
    _fly1496_model=$(jq -r '.decision.model' <<<"$_fly1496_result")
    _fly1496_raw_model=$(jq -r '.decision.rawModel // ""' <<<"$_fly1496_result")
    _fly1496_effort=$(jq -r '.decision.effort // ""' <<<"$_fly1496_result")
    _fly1496_raw_effort=$(jq -r '.decision.rawEffort // ""' <<<"$_fly1496_result")
    _fly1496_reason=$(jq -r '.decision.reason' <<<"$_fly1496_result")
    # FLY-1650 (Codex R4/R5): ABSENT and explicit null are opposite signals and
    # jq's `//` collapses them, so branch on has() first.
    #
    # present ⇒ this resolver vetted the pair; use its answer verbatim (a null
    # means the resolved model accepts no fallback tier).
    #
    # absent ⇒ the dist predates this field while the launcher does not: a
    # build/deploy SKEW. The shell has no registry, so any literal it picks here
    # is a guess — and the guess is unsafe in both directions (keeping xhigh can
    # emit a pair the API rejects; dropping it silently downgrades a companion).
    # Refuse to guess: say so loudly and take the branch that cannot produce an
    # invalid launch. A companion then runs at its model's own default effort
    # until the dist is rebuilt, instead of failing to start.
    if jq -e '.decision | has("companionDefaultEffort")' >/dev/null 2>&1 <<<"$_fly1496_result"; then
      _fly1496_companion_effort=$(jq -r '.decision.companionDefaultEffort // ""' <<<"$_fly1496_result")
    else
      # Codex R6: the fallback is not the only unvalidated value here. A dist
      # this old also predates the effort narrowing itself, so `decision.effort`
      # — the projects.json override — reached us WITHOUT ever being checked
      # against the model. Keeping it emits exactly the pair this seam exists to
      # prevent (reproduced under bash 3.2 as `--model claude-opus-4-6 --effort
      # xhigh`). The refusal has to cover every effort this resolver produced,
      # not just the fallback, or it is not a refusal at all.
      _fly1496_companion_effort=""
      _fly1496_effort=""
      log "model_config WARNING: dist predates the FLY-1650 effort narrowing (build/deploy skew); dropping BOTH the configured effort (${_fly1496_raw_effort:-<absent>}) and the companion fallback rather than launching ${_fly1496_model} with an unvalidated tier"
    fi
    _fly1496_substituted=$(jq -r '.decision.substituted' <<<"$_fly1496_result")
  elif [ -n "$_fly1496_result" ] && jq -e '.sourceFailure == true' >/dev/null 2>&1 <<<"$_fly1496_result"; then
    log "FATAL: $(jq -r '.error // "projects.json model source failure"' <<<"$_fly1496_result")"
    return 1
  else
    # Resolver/runtime failure must not brick the fleet, but the frozen env is
    # not a safe fallback: it is a stale carrier that cannot be canonicalized
    # here, and the incident showed it holding a value the operator had already
    # moved away from. Literal Fable needs neither dist nor config to be read.
    log "model_config WARNING: resolver unavailable; using built-in ${_fly1496_model}; frozen env ignored"
  fi

  # Replace every earlier model/effort token only after all routing has settled.
  _fly1496_skip=false
  for _fly1496_arg in "${launch_args[@]}"; do
    if [ "$_fly1496_skip" = true ]; then _fly1496_skip=false; continue; fi
    case "$_fly1496_arg" in
      --model|--effort) _fly1496_skip=true; continue ;;
    esac
    _fly1496_filtered+=("$_fly1496_arg")
  done
  launch_args=("${_fly1496_filtered[@]}" --model "$_fly1496_model")
  if [ -n "$_fly1496_effort" ]; then
    launch_args+=(--effort "$_fly1496_effort")
  elif [ "${IS_COMPANION_ROLE:-false}" = true ] && [ -n "$_fly1496_companion_effort" ]; then
    # FLY-1650: use the resolver's narrowed value, never a hardcoded tier — the
    # shell has no registry and would otherwise re-add the very effort the
    # resolver just rejected for this model. Empty ⇒ the model accepts none of
    # it; omit the flag and let the model run at its own default.
    _fly1496_effort="$_fly1496_companion_effort"
    launch_args+=(--effort "$_fly1496_companion_effort")
    log "Companion: --effort ${_fly1496_companion_effort} (FLY-583; no projects.json effort override)"
  elif [ "${IS_COMPANION_ROLE:-false}" = true ]; then
    log "Companion: no --effort (FLY-1650; ${_fly1496_model} accepts no companion fallback tier)"
  fi

  if [ "$_fly1496_reason" = "resolver_unavailable" ]; then
    log "model source: resolver unavailable → using built-in ${_fly1496_model}; env=${FLYWHEEL_LEAD_MODEL:-<unset>} ignored"
  else
    log "model source: projects.json=${_fly1496_raw_model:-<absent>}→${_fly1496_model} env=${FLYWHEEL_LEAD_MODEL:-<unset>} → using projects.json"
  fi
  if [ -n "$_fly1496_effort" ]; then
    log "effort source: projects.json=${_fly1496_raw_effort:-<absent>}→${_fly1496_effort} env=${FLYWHEEL_LEAD_EFFORT:-<unset>} → using projects.json"
  fi
  if [ "$_fly1496_reason" = "model_invalid" ]; then
    log "model_config WARNING: projects.json model '${_fly1496_raw_model}' is not resolvable; substituted with '${_fly1496_model}'"
  fi

  # Manifest is now write-only launch evidence. Preserve unrelated fields,
  # publish raw SSOT spelling plus actual canonical argv, and never read it.
  if [ "${FLYWHEEL_LEAD_BODY_V2:-0}" != "1" ] \
    && command -v jq >/dev/null 2>&1 && [ -f "${MANIFEST_FILE:-}" ]; then
    local _fly1496_manifest_tmp="${MANIFEST_FILE}.tmp.$$"
    jq \
      --arg rawModel "$_fly1496_raw_model" \
      --arg resolvedModel "$_fly1496_model" \
      --arg rawEffort "$_fly1496_raw_effort" \
      --arg resolvedEffort "$_fly1496_effort" \
      'if $rawModel != "" then .model = $rawModel else del(.model) end
       | .resolvedModel = $resolvedModel
       | if $rawEffort != "" then .effort = $rawEffort else del(.effort) end
       | if $resolvedEffort != "" then .resolvedEffort = $resolvedEffort else del(.resolvedEffort) end' \
      "$MANIFEST_FILE" > "$_fly1496_manifest_tmp" \
      && jq empty "$_fly1496_manifest_tmp" 2>/dev/null \
      && mv "$_fly1496_manifest_tmp" "$MANIFEST_FILE" \
      || { rm -f "$_fly1496_manifest_tmp"; log "model_config WARNING: failed to write launch evidence manifest"; }
  fi

  if [ "$_fly1496_substituted" = true ] || [ "$_fly1496_reason" = "resolver_unavailable" ]; then
    if [ -x "${FLYWHEEL_ROOT}/scripts/lead-alert.sh" ]; then
      "${FLYWHEEL_ROOT}/scripts/lead-alert.sh" \
        --lead "$LEAD_ID" --project "$PROJECT_NAME" \
        --kind model_config --severity severe \
        --title "Lead model policy fallback" \
        --body "${PROJECT_NAME}/${LEAD_ID}: ${_fly1496_reason}; launched ${_fly1496_model}" \
        --signature "${_fly1496_reason}-${_fly1496_raw_model:-absent}" \
        >/dev/null 2>&1 || log "model_config WARNING: alert delivery failed"
    fi
  fi

  # FLY-231 dry-run: a structured launch-plan test (byte-compat sentinel + companion
  # capability assertions) must NOT touch the shared `flywheel` tmux session, which
  # is NOT HOME-isolated. Skip all tmux side effects here; env_args still builds
  # below so the plan captures the real pane env. The emit+return is just before
  # the actual `tmux new-window`.
  if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" != "1" ]; then
    # FLY-183: Reap orphaned Discord adapters before launching a new Claude.
    # Sequence matters (Codex design review #3): on a supervisor restart the stale
    # window below may still hold a LIVE old Claude (ppid!=1, skipped by reap);
    # killing it then creates exactly the orphan we must clean. So:
    #   pre-sweep (historical orphans) -> kill stale window -> bounded settle
    #   (let old Claude die + its adapter reparent to launchd) -> re-sweep.
    # `|| true` belt: reap is internally fail-open, but never let it abort launch.
    reap_orphan_adapters || true

    # Stale-window removal is generation-guarded in _prepare_lead_launch. Never
    # kill by name here: after a server replacement the same numeric window id
    # can belong to a different process.
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
  # Claude resolves its persisted login against the OS account named by USER.
  # Both v1 (tmux new-window) and v2 (direct child env -i) cross an explicit
  # environment boundary here, so derive the identity from the kernel account
  # instead of trusting caller-provided USER/LOGNAME values.
  local _lead_os_user
  _lead_os_user="$(/usr/bin/id -un 2>/dev/null)" || {
    log "ERROR: unable to resolve the Lead OS user"
    return 1
  }
  [ -n "$_lead_os_user" ] || {
    log "ERROR: resolved Lead OS user is empty"
    return 1
  }
  local env_args=(
    -e "DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN:-}"
    -e "DISCORD_STATE_DIR=${DISCORD_STATE_DIR:-}"
    -e "LEAD_ID=${LEAD_ID}"
    -e "FLYWHEEL_LEAD_ID=${LEAD_ID}"
    -e "FLYWHEEL_COMM_DB=${_cz_comm_db}"
    -e "FLYWHEEL_COMM_CLI=${_cz_comm_cli}"
    # FLY-1426: Discord inbound receipts and their priority windows must cross
    # tmux's explicit -e barrier. Keeping these values identical in the plugin
    # and CommDB activation path prevents delivery/expiry SLA drift.
    -e "FLYWHEEL_CHAT_RECEIPTS=${FLYWHEEL_CHAT_RECEIPTS:-}"
    -e "FLYWHEEL_RECEIPT_WINDOW_P0_MIN=${FLYWHEEL_RECEIPT_WINDOW_P0_MIN:-}"
    -e "FLYWHEEL_RECEIPT_WINDOW_P1_MIN=${FLYWHEEL_RECEIPT_WINDOW_P1_MIN:-}"
    -e "FLYWHEEL_RECEIPT_WINDOW_P2_MIN=${FLYWHEEL_RECEIPT_WINDOW_P2_MIN:-}"
    -e "FLYWHEEL_RECEIPT_WINDOW_P3_MIN=${FLYWHEEL_RECEIPT_WINDOW_P3_MIN:-}"
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
    -e "USER=${_lead_os_user}"
    -e "LOGNAME=${_lead_os_user}"
    -e "PATH=${PATH}"
    # GEO-151 QA cycle 1 fix: L3 screencapture skill prompt references
    # `$FLYWHEEL_TEAMLEAD_SCRIPT_DIR/find-window.sh`. Export at line ~1215
    # only sets it in the launcher shell — `tmux new-window -e` strips
    # anything not in this allowlist, so the Lead pane saw empty and the
    # skill fell back to a slow `find /` recursive scan. Same tmux env
    # barrier pattern FLY-142 fixed for CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS.
    -e "FLYWHEEL_TEAMLEAD_SCRIPT_DIR=${FLYWHEEL_TEAMLEAD_SCRIPT_DIR:-}"
    -e "FLYWHEEL_FOUNDER_TZ=${FLYWHEEL_FOUNDER_TZ:-}"
  )

  # FLY-1309: only a successfully acquired generation enters the pane. A store
  # fault starts without a claim and carries an explicit degraded marker; write
  # boundaries therefore remain fail-closed in enforce mode.
  if [ -n "${LEAD_LEASE_KEY:-}" ] && [ -n "${LEAD_LEASE_GENERATION:-}" ]; then
    env_args+=(
      -e "FLYWHEEL_LEAD_LEASE_KEY=${LEAD_LEASE_KEY}"
      -e "FLYWHEEL_LEAD_GENERATION=${LEAD_LEASE_GENERATION}"
    )
  elif [ -n "${LEAD_LEASE_DEGRADED:-}" ]; then
    env_args+=(-e "FLYWHEEL_LEAD_LEASE_DEGRADED=${LEAD_LEASE_DEGRADED}")
  fi

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
  if [ "${FLYWHEEL_LEAD_CARRIER:-}" = "v2" ]; then
    env_args+=(-e "FLYWHEEL_LEAD_CARRIER=v2")
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
  # propagation). Emit the structured launch-plan and return WITHOUT entering
  # any real-launch isolation/identity/authority gate. Those gates consume the
  # supervisor archive and lease state, which intentionally do not exist on
  # the dry-run path.
  if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" = "1" ]; then
    _emit_launch_plan "${launch_args[@]}"
    return 0
  fi

  # FLY-1663: in the launchd-native carrier this shell already IS the private
  # server's body pane. Launch Claude once as our child, preserving the pane's
  # tmux identity for flywheel-comm, and return its status to the one-shot
  # receipt path below. No shared-session creation or lifecycle gate is used.
  if [ "${FLYWHEEL_LEAD_BODY_V2:-0}" = "1" ]; then
    local -a child_env=()
    local _v2_env
    for _v2_env in "${env_args[@]}"; do
      [ "$_v2_env" = "-e" ] && continue
      child_env+=("$_v2_env")
    done
    [ -z "${TERM:-}" ] || child_env+=("TERM=${TERM}")
    [ -z "${TMPDIR:-}" ] || child_env+=("TMPDIR=${TMPDIR}")
    [ -z "${LANG:-}" ] || child_env+=("LANG=${LANG}")
    [ -z "${LC_ALL:-}" ] || child_env+=("LC_ALL=${LC_ALL}")
    [ -z "${LC_CTYPE:-}" ] || child_env+=("LC_CTYPE=${LC_CTYPE}")
    [ -z "${TMUX:-}" ] || child_env+=("TMUX=${TMUX}")
    [ -z "${TMUX_PANE:-}" ] || child_env+=("TMUX_PANE=${TMUX_PANE}")

    env -i "${child_env[@]}" claude "${launch_args[@]}" &
    CLAUDE_CHILD_PID=$!
    local _v2_child_start=""
    _v2_child_start="$(tmux_supervisor_process_start_identity "$CLAUDE_CHILD_PID" 2>/dev/null || true)"
    record_lead_body_evidence_best_effort launched \
      "$CLAUDE_CHILD_PID" "$_v2_child_start" \
      "${_FLYWHEEL_LEAD_CARRIER_PID_CAPTURED:-}" \
      "${_FLYWHEEL_LEAD_CARRIER_START_CAPTURED:-}"
    if wait "$CLAUDE_CHILD_PID"; then
      CLAUDE_EXIT=0
    else
      CLAUDE_EXIT=$?
    fi
    CLAUDE_CHILD_PID=""
    return 0
  fi

  # FLY-1659: close the create-client crash window after launch-plan
  # materialization. A pending intent, live client fence, or reserved
  # temporary window is launch ownership evidence; none may be bypassed by a
  # second create attempt.
  if ! _lead_prelaunch_isolation_gate; then
    ENSURE_HOLD_KIND="ambiguous"
    ENSURE_HOLD_EVIDENCE='{"reason":"prelaunch_isolation_conflict"}'
    return 3
  fi

  # Re-read the exact process identity at the final boundary. The earlier main
  # loop preflight protects expensive preparation; this second read closes the
  # gap between that check and the fork. Sensor failure remains fail-closed.
  local _fly1659_identity_conflict="" _fly1659_identity_rc=0
  _fly1659_identity_conflict="$(lead_identity_preflight_first_conflict "$LEAD_ID")" \
    || _fly1659_identity_rc=$?
  case "$_fly1659_identity_rc" in
    0)
      local _fly1659_identity_pid="${_fly1659_identity_conflict%%$'\t'*}"
      ENSURE_HOLD_KIND="ambiguous"
      ENSURE_HOLD_EVIDENCE="{\"reason\":\"prelaunch_identity_conflict\",\"pid\":${_fly1659_identity_pid}}"
      return 3
      ;;
    1) ;;
    *)
      ENSURE_HOLD_KIND="unknown"
      ENSURE_HOLD_EVIDENCE='{"reason":"prelaunch_identity_sensor_degraded"}'
      return 3
      ;;
  esac

  # FLY-1602: close the disk/launchd TOCTOU window after all launch-plan
  # materialization and immediately before a child could be created.
  if ! lead_launch_authority_recheck; then
    ENSURE_HOLD_KIND="unknown"
    ENSURE_HOLD_EVIDENCE="{\"reason\":\"${LEAD_LAUNCH_AUTHORITY_REASON}\"}"
    return 3
  fi

  # FLY-1659: the gated client persists crash evidence before create and returns
  # the window/pane/server tuple directly. Load-driven forensic verdict noise is
  # never an acceptance signal and can no longer kill a newly-created body.
  local _fly1659_create_rc=0
  _lead_create_tmux_window "$window_name" "${launch_args[@]}" \
    || _fly1659_create_rc=$?
  [ "$_fly1659_create_rc" -eq 0 ] || return "$_fly1659_create_rc"

  _tmux set-window-option -t "$LEAD_WINDOW_ID" remain-on-exit on 2>/dev/null || true

  log "Claude launched in tmux window: flywheel:${LEAD_WINDOW_ID} (name: ${window_name})"
}

# Wait for tmux window to exit (pane_dead detection).
# Uses window_id for reliable targeting. Uses interruptible_sleep.
_tmux_window_absence_proven() {
  printf '%s' "$1" | grep -Eqi \
    "can't find (window|session|pane)|no such (window|session|pane)|unknown (window|session|pane)"
}

_wait_tmux_window() {
  CLAUDE_EXIT=0
  local target="${LEAD_WINDOW_ID}"
  local pane_row pane_pid dead status recovery recovery_rc action recovered_pid
  local archived_state_rc generation_rc
  local probe_err
  TMUX_HOLD_BACKOFF=3

  while true; do
    if [ "$SHOULD_EXIT" -ne 0 ]; then return 0; fi

    if _tmux_target_matches_archive_fast "$target" false; then
      pane_row="$(_tmux list-panes -t "$target" \
        -F '#{pane_pid}	#{pane_dead}	#{pane_dead_status}' 2>/dev/null | head -1 || true)"
      pane_pid="${pane_row%%$'\t'*}"
      pane_row="${pane_row#*$'\t'}"
      dead="${pane_row%%$'\t'*}"
      status="${pane_row#*$'\t'}"
      if [ "$pane_pid" = "$TMUX_ARCHIVE_PANE_PID" ] \
        && _tmux_target_matches_archive_fast "$target" false; then
        if [ "$dead" = "1" ]; then
          CLAUDE_EXIT="${status:-1}"
          _tmux_target_matches_archive "$target" false \
            && _tmux kill-window -t "$target" 2>/dev/null || true
          TMUX_RELAUNCH_PROVEN=1
          tmux_supervisor_reap_archived_process "$TMUX_ARCHIVE_FILE" "$LEAD_ID" || true
          return 0
        fi
        _tmux_report_hold_resolved || true
        TMUX_HOLD_BACKOFF=3
        interruptible_sleep 3
        continue
      fi
    fi

    # The target could not be trusted. If the archived OS process is already
    # gone, that is positive process-level death evidence and no tmux action is
    # needed. Otherwise classify/recover the server without ever creating one.
    archived_state_rc=0
    tmux_supervisor_archived_process_state "$TMUX_ARCHIVE_FILE" "$LEAD_ID" \
      || archived_state_rc=$?
    case "$archived_state_rc" in
      1)
        CLAUDE_EXIT=1
        TMUX_RELAUNCH_PROVEN=1
        return 0
        ;;
      2)
        ENSURE_HOLD_KIND="unknown"
        ENSURE_HOLD_EVIDENCE='{"reason":"archived_process_sensor_indeterminate"}'
        _tmux_report_hold "$ENSURE_HOLD_KIND" "$ENSURE_HOLD_EVIDENCE" || true
        log "tmux hold (${ENSURE_HOLD_KIND}) while archived process state is indeterminate; retry base ${TMUX_HOLD_BACKOFF}s"
        _hold_sleep_and_advance
        continue
        ;;
    esac

    generation_rc=0
    _tmux_generation_probe "$TMUX_ARCHIVE_SERVER_PID" || generation_rc=$?
    if [ "$generation_rc" -eq 0 ]; then
      ENSURE_HOLD_KIND="unknown"
      ENSURE_HOLD_EVIDENCE='{"reason":"window_probe_indeterminate_server_reachable"}'
      _tmux_report_hold "$ENSURE_HOLD_KIND" "$ENSURE_HOLD_EVIDENCE" || true
      log "tmux hold (${ENSURE_HOLD_KIND}) while expected server remains reachable; retry base ${TMUX_HOLD_BACKOFF}s"
      _hold_sleep_and_advance
      continue
    fi

    if recovery="$(tmux_socket_recover "$(_tmux_socket_path)")"; then
      recovered_pid="$(_tmux_rescue_json_field "$recovery" reachablePid)"
      if tmux_supervisor_archive_read "$TMUX_ARCHIVE_FILE" \
        && [ "$recovered_pid" = "$TMUX_ARCHIVE_SERVER_PID" ]; then
        probe_err="$(mktemp -t fly1285-window-probe.XXXXXX)"
        if _tmux list-panes -t "$target" >/dev/null 2>"$probe_err"; then
          rm -f "$probe_err"
          # FLY-1598: this recover-succeeded + probe-succeeded path had NO sleep.
          # Under a legacy-grouped cmux topology the archive matcher at the loop
          # top keeps failing while the probe here keeps succeeding, so this
          # `continue` span at full speed (~130 rescue calls/min per Lead, 10
          # Leads spinning, 650 PIDs/s, load 16+, Bridge starved). Pace it
          # exactly like the healthy branch above.
          interruptible_sleep 3
          continue
        elif _tmux_window_absence_proven "$(cat "$probe_err" 2>/dev/null)"; then
          rm -f "$probe_err"
          CLAUDE_EXIT=1
          TMUX_RELAUNCH_PROVEN=1
          tmux_supervisor_reap_archived_process "$TMUX_ARCHIVE_FILE" "$LEAD_ID" || true
          return 0
        fi
        rm -f "$probe_err"
        ENSURE_HOLD_KIND="unknown"
        ENSURE_HOLD_EVIDENCE='{"reason":"window_probe_indeterminate"}'
      else
        ENSURE_HOLD_KIND="split_brain"
        ENSURE_HOLD_EVIDENCE="{\"reason\":\"reachable_generation_changed\",\"reachablePid\":${recovered_pid:-null}}"
      fi
    else
      recovery_rc=$?
      action="$(_tmux_rescue_json_field "$recovery" action 2>/dev/null || echo hold_unknown)"
      ENSURE_HOLD_KIND="${action#hold_}"
      ENSURE_HOLD_EVIDENCE="$(printf '%s' "$recovery" | jq -c '.evidence // {}' 2>/dev/null || printf '{"reason":"invalid_helper_output"}')"
      case "$recovery_rc" in 2|3|4|5) ;; *) ENSURE_HOLD_KIND="unknown" ;; esac
    fi
    _tmux_report_hold "$ENSURE_HOLD_KIND" "$ENSURE_HOLD_EVIDENCE" || true
    log "tmux hold (${ENSURE_HOLD_KIND}) while waiting for ${target}; retry base ${TMUX_HOLD_BACKOFF}s"
    _hold_sleep_and_advance
  done
}

cleanup() {
  SHOULD_EXIT=1
  log "Shutdown signal received..."

  if [ "${FLYWHEEL_LEAD_BODY_V2:-0}" = "1" ]; then
    # FLY-1679: stop the auto-confirm poller FIRST. This branch exits before
    # the normal post-launch reap, and a poller left alive here could deliver a
    # keystroke into a pane that is already being torn down.
    _v2_reap_dialog_poller
    if [ -n "${CLAUDE_CHILD_PID:-}" ] && kill -0 "$CLAUDE_CHILD_PID" 2>/dev/null; then
      kill -TERM "$CLAUDE_CHILD_PID" 2>/dev/null || true
      wait "$CLAUDE_CHILD_PID" 2>/dev/null || true
    fi
    exit 143
  fi

  # FLY-109: expect-dev-channels.exp lives under scripts/ now — nothing to clean up.

  # Graceful shutdown is generation-bound. If the archived generation cannot be
  # proven current, preserve the archive and never touch a same-numbered window
  # on a replacement server.
  if [ -n "${LEAD_WINDOW_ID:-}" ] && [ "$LEAD_BODY_PROVENANCE" = launched ]; then
    if _tmux_target_matches_archive "$LEAD_WINDOW_ID" true; then
      _tmux send-keys -t "$LEAD_WINDOW_ID" C-c 2>/dev/null || true
      local i=0
      while [ $i -lt 5 ]; do
        _tmux_target_matches_archive "$LEAD_WINDOW_ID" false || break
        local dead
        dead=$(_tmux list-panes -t "$LEAD_WINDOW_ID" -F '#{pane_dead}' 2>/dev/null | head -1)
        if [ "$dead" = "1" ]; then break; fi
        sleep 1
        i=$((i + 1))
      done
      if _tmux_target_matches_archive "$LEAD_WINDOW_ID" false; then
        _tmux kill-window -t "$LEAD_WINDOW_ID" 2>/dev/null || true
        TMUX_RELAUNCH_PROVEN=1
        tmux_supervisor_reap_archived_process "$TMUX_ARCHIVE_FILE" "$LEAD_ID" || true
      fi
    else
      log "tmux generation indeterminate during cleanup; preserving ${TMUX_ARCHIVE_FILE:-archive}"
    fi
  elif [ -n "${LEAD_WINDOW_ID:-}" ]; then
    log "Preserving adopted Lead body ${LEAD_WINDOW_ID}; this supervisor has no graceful teardown authority"
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
  if [ -n "${PID_FILE:-}" ] && [ "$(cat "$PID_FILE" 2>/dev/null || true)" = "$$" ]; then
    rm -f "$PID_FILE" 2>/dev/null || true
  fi
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

# FLY-1496: model and effort are deliberately absent from this supervisor-level
# array. _launch_claude derives both from projects.json on EVERY child launch,
# after all static args are built. Frozen launchd env remains carrier evidence
# for fleet tooling but has no runtime authority.

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
# The private pointer marketplace is not on Claude's approved-channel allowlist.
# Load it through the same development-channel path as the local inbox server;
# FLY-1679 must be deployed before cutover so v2 cold starts confirm this path
# without a human keypress.
CLAUDE_ARGS+=(--dangerously-load-development-channels "plugin:discord@flywheel-plugins")
if [ "$INBOX_MCP_ENABLED" = "true" ]; then
  CLAUDE_ARGS+=("server:flywheel-inbox")
  log "Channels: Discord plugin + inbox server (dev channel)"

  # FLY-109: Tell the Lead model how + when to call flywheel_inbox_ack. The file
  # ships in scripts/ so it's always present when this launcher runs; no external
  # sync required. Only loaded when inbox-mcp is enabled — the tool doesn't exist
  # otherwise.
  INBOX_ACK_RULE="${SCRIPT_DIR}/inbox-ack-rule.md"
  if [ -f "$INBOX_ACK_RULE" ] && [ -r "$INBOX_ACK_RULE" ]; then
    rules_bundle_add "$INBOX_ACK_RULE" launcher
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
    rules_bundle_add "$BASE_EXTERNAL_CONTRACT" base
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
    rules_bundle_add "$BASE_COMPANION_SAFETY" base
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
    rules_bundle_add "$BASE_DEPT_RULES" base
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
      rules_bundle_add "$BASE_RUNNER_MSG_RULES" base
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
    rules_bundle_add "$BASE_EXECUTOR_ROUTING_RULES" base
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
    rules_bundle_add "$BASE_MODEL_ROUTING_RULES" base
    log "Appending base model-routing rules: ${BASE_MODEL_ROUTING_RULES}"
  fi

	# ── Runner recovery safety (non-cos dept leads only) ──
	# Defines the evidence and authority boundaries for manual Runner recovery.
	# Only roles that manage Runners load it. Loaded on both messaging backends.
  # Optional — missing base file is a no-op (backward compat).
  BASE_STUCK_REMANAGE_RULES="${BASE_RULES_DIR}/stuck-runner-remanage.md"
  if [ -f "$BASE_STUCK_REMANAGE_RULES" ] && [ -r "$BASE_STUCK_REMANAGE_RULES" ]; then
    rules_bundle_add "$BASE_STUCK_REMANAGE_RULES" base
    log "Appending base stuck-runner-remanage rules: ${BASE_STUCK_REMANAGE_RULES}"
  fi

  # ── FLY-229: Runner Re-Engage vs Terminate (non-cos dept leads only) ──
  # Iteration-loop standard op: a parked-alive runner (finished one round, tmux +
  # agent still idle/alive) is RE-ENGAGEABLE via the normal Runner messaging path
  # — don't terminate + new-run. Only roles that manage Runners load it. Optional
  # — missing base file is a no-op (backward compat).
  BASE_REENGAGE_RULES="${BASE_RULES_DIR}/runner-reengage-rules.md"
  if [ -f "$BASE_REENGAGE_RULES" ] && [ -r "$BASE_REENGAGE_RULES" ]; then
    rules_bundle_add "$BASE_REENGAGE_RULES" base
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
    rules_bundle_add "$BASE_PATROL_RULES" base
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
    rules_bundle_add "$BASE_DOC_FLOW_RULES" base
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
    rules_bundle_add "$BASE_AUTO_QA_RULES" base
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
    rules_bundle_add "$BASE_DEFAULT_ENABLE_RULES" base
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
    rules_bundle_add "$BASE_XHS_MEMORY_RULES" base
    log "Appending base xiaohongshu-memory rules: ${BASE_XHS_MEMORY_RULES}"
  fi
else
  # Cos-lead base: Department Routing Discipline (one Lead per spawn message)
  BASE_COS_RULES="${BASE_RULES_DIR}/cos-lead-rules.md"
  if [ -f "$BASE_COS_RULES" ] && [ -r "$BASE_COS_RULES" ]; then
    rules_bundle_add "$BASE_COS_RULES" base
    log "Appending base cos-lead rules: ${BASE_COS_RULES}"
  fi
fi

# ── FLY-1319: founder-local time (universal companion + cos + dept) ──
# External customer-facing agents intentionally keep their narrower contract.
BASE_FOUNDER_LOCAL_TIME_RULES="${BASE_RULES_DIR}/founder-local-time.md"
if [ "$IS_EXTERNAL_ROLE" != true ] && [ -f "$BASE_FOUNDER_LOCAL_TIME_RULES" ] && [ -r "$BASE_FOUNDER_LOCAL_TIME_RULES" ]; then
  rules_bundle_add "$BASE_FOUNDER_LOCAL_TIME_RULES" base
  log "Appending founder-local time rules: ${BASE_FOUNDER_LOCAL_TIME_RULES}"
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
  rules_bundle_add "$BASE_FOUNDER_AUTH_RULES" base
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
    rules_bundle_add "$BASE_FOUNDER_UX_RULES" base
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
  rules_bundle_add "$BASE_HTML_DELIVERY_RULES" base
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
  rules_bundle_add "$BASE_CROSS_DEPT_RULES" base
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
  rules_bundle_add "$BASE_DISCORD_REPLY_CONTRACT" base
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
  rules_bundle_add "$COMMON_RULES" project
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
    rules_bundle_add "$DEPT_RULES" project
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
    rules_bundle_add "$SCREENCAP_SKILL" launcher
    log "Appending L3 screencapture skill: ${SCREENCAP_SKILL}"
  else
    log "WARNING: L3 screencapture skill missing at ${SCREENCAP_SKILL} — screencapture skill not loaded"
  fi
else
  log "L3 screencapture skill disabled via LEAD_DISABLE_SCREENCAPTURE_SKILL=1"
fi

# ── FLY-1402: one immutable per-supervisor rules bundle ─────────────────────
# The CLI currently keeps only the final repeated --append-system-prompt-file.
# Materialize after every role/project/launcher selection has run, then append
# exactly one target. Legacy mode remains a loud, explicit compatibility valve.
if [ "$IS_EXTERNAL_ROLE" = true ]; then
  RULES_BUNDLE_ROLE="external"
elif [ "$IS_COMPANION_ROLE" = true ]; then
  RULES_BUNDLE_ROLE="companion"
elif [ "$IS_COS_ROLE" = true ]; then
  RULES_BUNDLE_ROLE="cos"
else
  RULES_BUNDLE_ROLE="dept"
fi

_RULES_BUNDLE_COMMITTED=0
RULES_BUNDLE_PATH=""
RULES_BUNDLE_SHA=""
RULES_BUNDLE_GENERATION_NONCE=""
RULES_BUNDLE_STATE_DIR="${HOME}/.flywheel/lead-rules-bundles"
# Consumed by _rules_bundle_write_receipt in the sourced bundle library.
# shellcheck disable=SC2034
RULES_BUNDLE_RECEIPT_PATH="${RULES_BUNDLE_STATE_DIR}/${PROJECT_NAME}-${LEAD_ID}.active.json"

# Compute this once and reuse it for filename, receipt, cleanup, and FLY-1309.
if [ "${FLYWHEEL_LEAD_BODY_V2:-0}" = "1" ]; then
  LEAD_LEASE_SUPERVISOR_START="$(LC_ALL=C ps -p "$$" -o lstart= 2>/dev/null || true)"
else
  LEAD_LEASE_SUPERVISOR_START="$(tmux_supervisor_process_start_identity "$$" || true)"
fi
LEAD_LAUNCH_LABEL="com.flywheel.lead.${PROJECT_NAME}-${LEAD_ID}"
LEAD_LAUNCH_TARGET="gui/$(id -u)/${LEAD_LAUNCH_LABEL}"
LEAD_LAUNCH_PLIST="${HOME}/Library/LaunchAgents/${LEAD_LAUNCH_LABEL}.plist"
LEAD_LAUNCH_PROJECTS_FILE="${FLYWHEEL_PROJECTS_FILE:-${HOME}/.flywheel/projects.json}"
if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" != "1" ] \
  && [ "${FLYWHEEL_LEAD_BODY_V2:-0}" != "1" ]; then
  _lead_authority_backoff=3
  while ! lead_launch_authority_prepare \
    "$MANIFEST_FILE" "$LEAD_LAUNCH_PLIST" "$LEAD_LAUNCH_PROJECTS_FILE" \
    "$LEAD_LAUNCH_LABEL" "$LEAD_LAUNCH_TARGET" \
    "$$" "$LEAD_LEASE_SUPERVISOR_START"; do
    log "Managed launch authority HOLD (${LEAD_LAUNCH_AUTHORITY_REASON}); retrying in ${_lead_authority_backoff}s"
    if [ "${FLYWHEEL_LEAD_AUTHORITY_QA_EXIT:-0}" = "1" ]; then
      log "QA authority seam requested a clean no-mutation exit"
      exit 0
    fi
    interruptible_sleep "$_lead_authority_backoff"
    [ "$_lead_authority_backoff" -ge 30 ] \
      || _lead_authority_backoff=$((_lead_authority_backoff * 2))
    [ "$_lead_authority_backoff" -le 30 ] || _lead_authority_backoff=30
  done
  unset _lead_authority_backoff
fi
if [ -n "$LEAD_LEASE_SUPERVISOR_START" ]; then
  _rules_bundle_generation="$$-lstart-$(_rules_bundle_start_hash "$LEAD_LEASE_SUPERVISOR_START")"
else
  RULES_BUNDLE_GENERATION_NONCE="$(_rules_bundle_random_nonce)"
  if [ -z "$RULES_BUNDLE_GENERATION_NONCE" ]; then
    log "FATAL: could not generate rules-bundle generation nonce"
    exit 1
  fi
  _rules_bundle_generation="$$-nonce-${RULES_BUNDLE_GENERATION_NONCE}"
fi

if [ "$RULES_BUNDLE_MODE" = "bundle" ]; then
  RULES_BUNDLE_PATH="${RULES_BUNDLE_STATE_DIR}/${PROJECT_NAME}-${LEAD_ID}.${_rules_bundle_generation}.md"
  if ! _rules_bundle_result="$(rules_bundle_materialize \
    "$RULES_BUNDLE_PATH" "$RULES_BUNDLE_ROLE" "$LEAD_ID" "$PROJECT_NAME")" \
    || [ "$_rules_bundle_result" != "$RULES_BUNDLE_PATH" ]; then
    log "FATAL: failed to materialize Lead rules bundle at ${RULES_BUNDLE_PATH}"
    _rules_bundle_uncommitted_cleanup
    exit 1
  fi
  RULES_BUNDLE_SHA="$(sed -n 's/^RULES_BUNDLE_SHA=\([^ ]*\) FILES=.*/\1/p' "$RULES_BUNDLE_PATH" | head -1)"
  if [ -z "$RULES_BUNDLE_SHA" ]; then
    log "FATAL: materialized rules bundle is missing its sentinel"
    _rules_bundle_uncommitted_cleanup
    exit 1
  fi
  CLAUDE_ARGS+=(--append-system-prompt-file "$RULES_BUNDLE_PATH")
  log "Appending consolidated rules bundle: ${RULES_BUNDLE_PATH} (${#RULES_BUNDLE_FILES[@]} files)"
  if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" != "1" ]; then
    trap _rules_bundle_uncommitted_cleanup EXIT
  fi
else
  log "WARNING: running LEGACY last-one-wins mode, rules NOT bundled (FLYWHEEL_LEAD_RULES_BUNDLE=legacy)"
fi
unset _rules_bundle_generation _rules_bundle_result

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

# FLY-1663: launchd-native carrier. This is the complete lifecycle of one body
# invocation: choose resume/fresh once, run one Claude child, persist one exit
# receipt, then close this private server. launchd owns every later restart.
LEAD_LEASE_KEY=""
LEAD_LEASE_GENERATION=""
LEAD_LEASE_DEGRADED=""
LEAD_LEASE_HOLD_REASON=""
# FLY-1402 computed this once before rules materialization; the lease, bundle
# generation, receipt, and cleanup proof must all consume the identical value.
LEAD_ALERT_SH="${FLYWHEEL_ROOT}/scripts/lead-alert.sh"

_lead_identity_alert() {
  local kind="$1" title="$2" body="$3"
  [ -x "$LEAD_ALERT_SH" ] || return 0
  "$LEAD_ALERT_SH" \
    --lead "$LEAD_ID" --project "$PROJECT_NAME" \
    --kind "$kind" --severity severe --title "$title" --body "$body" \
    || true
}

if [ "${FLYWHEEL_LEAD_BODY_V2:-0}" = "1" ]; then
  # shellcheck source=lib/lead-body-receipt.sh
  source "${SCRIPT_DIR}/lib/lead-body-receipt.sh"

  # FLY-1697: establish the body generation before consuming a session
  # decision or launching Claude. Exiting on a HOLD would tear down the private
  # tmux server and churn cmux, so the body retries in place with bounded
  # backoff while the lease store remains the split-brain authority.
  _v2_identity_backoff=3
  _v2_identity_rc=0
  _v2_hold_streak=0
  _v2_prev_hold_reason=""
  while :; do
    _v2_identity_rc=0
    lead_identity_v2_acquire_bind \
      "$LEAD_ID" "$PROJECT_NAME" "$$" "$LEAD_LEASE_SUPERVISOR_START" \
      || _v2_identity_rc=$?
    [ "$_v2_identity_rc" -eq 2 ] || break
    if [ "$LEAD_LEASE_HOLD_REASON" = "$_v2_prev_hold_reason" ]; then
      _v2_hold_streak=$((_v2_hold_streak + 1))
    else
      _v2_hold_streak=1
      _v2_prev_hold_reason="$LEAD_LEASE_HOLD_REASON"
    fi
    _v2_alert_kind="$(lead_identity_v2_hold_alert_kind \
      "$LEAD_LEASE_HOLD_REASON" "$_v2_hold_streak")"
    if [ -n "$_v2_alert_kind" ]; then
      _lead_identity_alert "$_v2_alert_kind" \
        "Lead identity held before launch" \
        "${PROJECT_NAME}/${LEAD_ID} is held before launch: ${LEAD_LEASE_HOLD_REASON}."
    fi
    log "Lead identity HOLD (${LEAD_LEASE_HOLD_REASON}); retrying in ${_v2_identity_backoff}s"
    interruptible_sleep "$_v2_identity_backoff"
    if [ "$SHOULD_EXIT" -ne 0 ]; then
      log "Shutdown requested during identity hold — exiting body."
      exit 0
    fi
    [ "$_v2_identity_backoff" -ge 30 ] \
      || _v2_identity_backoff=$((_v2_identity_backoff * 2))
    [ "$_v2_identity_backoff" -le 30 ] || _v2_identity_backoff=30
  done
  if [ "$_v2_identity_rc" -eq 1 ]; then
    log "WARNING: Lead lease store unavailable; launching degraded without a generation claim"
    _lead_identity_alert lead_lease_store_broken \
      "Lead lease store unavailable" \
      "${PROJECT_NAME}/${LEAD_ID} could not acquire its identity lease; launch is degraded and receipt settlement remains fail-closed."
  fi

  _v2_is_resume=false
  _v2_session_id=""
  if [ -s "$SESSION_ID_FILE" ]; then
    _v2_session_id="$(head -1 "$SESSION_ID_FILE" 2>/dev/null || true)"
    [ -z "$_v2_session_id" ] || _v2_is_resume=true
  fi

  if [ "$_v2_is_resume" = true ]; then
    log "Resuming session ${_v2_session_id} (one-shot v2 body)"
    _v2_launch_args=("${CLAUDE_ARGS[@]}" --resume "$_v2_session_id")
  else
    _v2_session_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
    log "Fresh session ${_v2_session_id} (one-shot v2 body)"
    if [ "$IS_COMPANION_ROLE" != true ] && [ "$IS_EXTERNAL_ROLE" != true ]; then
      send_bootstrap
    elif [ "$IS_EXTERNAL_ROLE" = true ]; then
      log "External: skipping engineering bootstrap"
    else
      log "Companion: skipping engineering bootstrap"
    fi
    _v2_session_tmp="${SESSION_ID_FILE}.tmp.$$"
    (umask 077 && printf '%s\n' "$_v2_session_id" > "$_v2_session_tmp") \
      && mv "$_v2_session_tmp" "$SESSION_ID_FILE" \
      || { rm -f "$_v2_session_tmp"; log "FATAL: failed to persist session identity"; exit 1; }
    _v2_launch_args=("${CLAUDE_ARGS[@]}" --session-id "$_v2_session_id")
  fi

  if ! _rules_bundle_commit_once; then
    log "FATAL: failed to commit active Lead rules receipt"
    exit 1
  fi

  CLAUDE_EXIT=1
  _v2_started_at="$(date +%s)"
  _v2_launch_rc=0
  # FLY-1679: the v2 _launch_claude blocks in `wait` for the whole Claude
  # lifetime, so the dev-channels auto-confirm poller must already be running
  # when the child paints the dialog. Same INBOX_MCP_ENABLED gate as v1; no
  # LEAD_WINDOW_ID guard, which is the half of the gap that made a v1-shaped
  # copy of this call a no-op on the launchd-native carrier.
  _V2_DIALOG_POLLER_PID=""
  if _dev_channels_flag_active; then
    _poll_dev_channels_dialog_v2 "$FLYWHEEL_DIALOG_TIMEOUT_SEC" &
    _V2_DIALOG_POLLER_PID=$!
  fi
  _launch_claude "${_v2_launch_args[@]}" || _v2_launch_rc=$?
  _v2_reap_dialog_poller
  if [ "$_v2_launch_rc" -ne 0 ]; then
    CLAUDE_EXIT="$_v2_launch_rc"
  fi
  _v2_duration=$(( $(date +%s) - _v2_started_at ))
  _v2_receipt_dir="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state/lead-resume"
  _v2_receipt_file="${_v2_receipt_dir}/${PROJECT_NAME}-${LEAD_ID}.json"
  if ! lead_body_write_receipt \
    "$_v2_receipt_file" "${PROJECT_NAME}/${LEAD_ID}" "$_v2_session_id" \
    "$CLAUDE_EXIT" "$_v2_duration" "$_v2_is_resume" "$SESSION_ID_FILE"; then
    log "WARNING: failed to persist Lead exit receipt: $_v2_receipt_file"
  fi

  # Primary shutdown path. TMUX was injected by this private server into %0.
  # The pane-exited hook is an independent fallback if this body is SIGKILLed.
  _v2_exit="$CLAUDE_EXIT"
  tmux kill-server 2>/dev/null || true
  exit "$_v2_exit"
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
TMUX_ARCHIVE_FILE="${PID_DIR}/${PROJECT_NAME}-${LEAD_ID}.claude.tmux"
mkdir -p "$PID_DIR"

# The launchd wrapper has the same guard, but recovery/manual paths can invoke
# claude-lead.sh directly. Refuse a second supervisor when the PID still proves
# to be this exact Lead; PID reuse merely clears the stale file.
if [ -f "$PID_FILE" ]; then
  _fly1285_existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  case "$_fly1285_existing_pid" in
    ''|*[!0-9]*) ;;
    *)
      if [ "$_fly1285_existing_pid" != "$$" ] \
        && kill -0 "$_fly1285_existing_pid" 2>/dev/null; then
        _fly1285_existing_cmd="$(ps -p "$_fly1285_existing_pid" -o command= 2>/dev/null || true)"
        case "$_fly1285_existing_cmd" in
          *claude-lead.sh*" ${LEAD_ID} "*|*claude-lead.sh*" ${LEAD_ID}")
            log "Lead '${LEAD_ID}' supervisor already running (PID ${_fly1285_existing_pid}); refusing duplicate."
            exit 0
            ;;
        esac
      fi
      ;;
  esac
fi
echo $$ > "$PID_FILE"
log "PID file written: ${PID_FILE} (PID $$)"

log "Supervisor starting (recovery loop enabled)"
log "Session ID file: ${SESSION_ID_FILE}"
TMUX_HOLD_BACKOFF=3

while true; do
  # ── Check shutdown flag ───────────────────────────────────
  if [ "$SHOULD_EXIT" -ne 0 ]; then
    log "Shutdown flag set — exiting supervisor."
    break
  fi

  if [ "$LEAD_LAUNCH_MANAGED" = true ] && ! lead_launch_authority_refresh; then
    log "Managed launch authority HOLD (${LEAD_LAUNCH_AUTHORITY_REASON}); retrying in ${TMUX_HOLD_BACKOFF}s"
    _hold_sleep_and_advance
    continue
  fi

  # FLY-1309 order is deliberate: resolve → acquire, then the existing FLY-1285
  # generation guard, then the whole-process-table preflight immediately before
  # launch. Repeated HOLD passes are idempotent for this supervisor generation.
  _lead_lease_prepare_rc=0
  _lead_identity_ready=0
  if [ -z "$LEAD_LEASE_SUPERVISOR_START" ]; then
    LEAD_LEASE_KEY=""
    LEAD_LEASE_GENERATION=""
    LEAD_LEASE_DEGRADED="store_error"
    LEAD_LEASE_FRESH=0
    _lead_identity_alert lead_lease_store_broken \
      "Lead lease start identity unavailable" \
      "${PROJECT_NAME}/${LEAD_ID} could not prove its supervisor pid+lstart; launching degraded while write boundaries remain protected."
    _lead_pending_reconcile_rc=0
    _lead_reconcile_pending_launch 6 || _lead_pending_reconcile_rc=$?
    if [ "$_lead_pending_reconcile_rc" -eq 0 ]; then
      _lead_identity_ready=1
    else
      LEAD_LEASE_HOLD_REASON="denied_sensor_degraded"
    fi
  else
    lead_identity_prepare_lease \
      "$LEAD_ID" "$PROJECT_NAME" "$$" "$LEAD_LEASE_SUPERVISOR_START" \
      || _lead_lease_prepare_rc=$?
    _lead_pending_reconcile_rc=0
    _lead_reconcile_pending_launch "$_lead_lease_prepare_rc" \
      || _lead_pending_reconcile_rc=$?
    if [ "$_lead_pending_reconcile_rc" -ne 0 ]; then
      LEAD_LEASE_HOLD_REASON="denied_sensor_degraded"
      _lead_lease_prepare_rc=3
    fi
    case "$_lead_lease_prepare_rc" in
      0)
        _lead_identity_ready=1
        if [ "$LEAD_LEASE_DEGRADED" = "store_error" ]; then
          log "WARNING: Lead lease store unavailable; launching degraded without a generation claim"
          _lead_identity_alert lead_lease_store_broken \
            "Lead lease store unavailable" \
            "${PROJECT_NAME}/${LEAD_ID} could not acquire its identity lease; launch is degraded and enforce-mode writes remain fail-closed."
        fi
        ;;
      4)
        _lead_adopt_rc=0
        _lead_try_adopt_body \
          "$LEAD_LEASE_ORPHAN_HOLDER_PID" "$LEAD_LEASE_ORPHAN_HOLDER_START" \
          || _lead_adopt_rc=$?
        case "$_lead_adopt_rc" in
          0)
            if ! _lead_restore_orphan_session; then
              log "WARNING: adopted Lead body session identity was unavailable; monitoring continues without rewriting the resume file"
            fi
            TMUX_HOLD_BACKOFF=3
            _wait_tmux_window
            continue
            ;;
          1)
            if _lead_clear_orphan_body; then
              log "Cleared positively mismatched orphan Lead body; reacquiring a fresh lease generation"
              TMUX_HOLD_BACKOFF=3
              continue
            fi
            LEAD_LEASE_HOLD_REASON="denied_sensor_degraded"
            ;;
          2)
            LEAD_LEASE_HOLD_REASON="denied_holder_alive"
            ;;
          *)
            LEAD_LEASE_HOLD_REASON="denied_sensor_degraded"
            ;;
        esac
        ;;
      5)
        _lead_bound_body_rc=0
        _lead_bound_body_ready || _lead_bound_body_rc=$?
        if [ "$_lead_bound_body_rc" -eq 0 ]; then
          log "Monitoring existing bound Lead body PID ${LEAD_LEASE_ORPHAN_HOLDER_PID}"
          TMUX_HOLD_BACKOFF=3
          _wait_tmux_window
          continue
        elif [ "$_lead_bound_body_rc" -eq 1 ] && _lead_clear_orphan_body; then
          log "Cleared stale bound Lead body; reacquiring a fresh lease generation"
          TMUX_HOLD_BACKOFF=3
          continue
        fi
        LEAD_LEASE_HOLD_REASON="denied_sensor_degraded"
        ;;
    esac
  fi

  if [ "$_lead_identity_ready" -ne 1 ]; then
    log "Lead identity HOLD (${LEAD_LEASE_HOLD_REASON}); retrying in ${TMUX_HOLD_BACKOFF}s"
    case "$LEAD_LEASE_HOLD_REASON" in
      identity_source_error|identity_ambiguous|identity_project_mismatch|identity_cli_unavailable|identity_invalid_response)
        _lead_identity_alert lead_identity_source_broken \
          "Lead identity resolution blocked startup" \
          "${PROJECT_NAME}/${LEAD_ID} is held before launch: ${LEAD_LEASE_HOLD_REASON}."
        ;;
      denied_holder_alive)
        _lead_identity_alert lead_dual_active \
          "Lead identity already has a live holder" \
          "${PROJECT_NAME}/${LEAD_ID} refused a second writer-capable generation."
        ;;
      denied_sensor_degraded)
        _lead_identity_alert lead_dual_active_sensor_degraded \
          "Lead lease liveness sensor degraded" \
          "${PROJECT_NAME}/${LEAD_ID} could not safely classify the current supervisor/body tuple and is held before launch."
        ;;
    esac
    _hold_sleep_and_advance
    continue
  fi

  if ensure_tmux_session; then
    _tmux_report_hold_resolved || true
  else
    _fly1285_hold_rc=$?
    [ -n "$ENSURE_HOLD_KIND" ] || ENSURE_HOLD_KIND="unknown"
    [ -n "$ENSURE_HOLD_EVIDENCE" ] || ENSURE_HOLD_EVIDENCE="{\"reason\":\"ensure_failed\",\"exitCode\":${_fly1285_hold_rc}}"
    _tmux_report_hold "$ENSURE_HOLD_KIND" "$ENSURE_HOLD_EVIDENCE" || true
    log "tmux ensure hold (${ENSURE_HOLD_KIND}); retrying in ${TMUX_HOLD_BACKOFF}s"
    _hold_sleep_and_advance
    continue
  fi

  if _prepare_lead_launch; then
    TMUX_HOLD_BACKOFF=3
  else
    _fly1285_hold_rc=$?
    [ -n "$ENSURE_HOLD_KIND" ] || ENSURE_HOLD_KIND="unknown"
    [ -n "$ENSURE_HOLD_EVIDENCE" ] || ENSURE_HOLD_EVIDENCE="{\"reason\":\"takeover_guard_failed\",\"exitCode\":${_fly1285_hold_rc}}"
    _tmux_report_hold "$ENSURE_HOLD_KIND" "$ENSURE_HOLD_EVIDENCE" || true
    log "Lead takeover hold (${ENSURE_HOLD_KIND}); retrying in ${TMUX_HOLD_BACKOFF}s"
    _hold_sleep_and_advance
    continue
  fi

  _lead_identity_conflict=""
  _lead_identity_preflight_rc=0
  _lead_identity_conflict="$(lead_identity_preflight_first_conflict "$LEAD_ID")" \
    || _lead_identity_preflight_rc=$?
  if [ "$_lead_identity_preflight_rc" -eq 0 ]; then
    _lead_identity_conflict_pid="${_lead_identity_conflict%%$'\t'*}"
    log "Lead identity preflight HOLD: exact ${LEAD_ID} process already exists (PID ${_lead_identity_conflict_pid})"
    _lead_identity_alert lead_dual_active \
      "Lead identity preflight found a duplicate" \
      "${PROJECT_NAME}/${LEAD_ID} refused launch because exact process PID ${_lead_identity_conflict_pid} already carries this identity."
    _hold_sleep_and_advance
    continue
  elif [ "$_lead_identity_preflight_rc" -ne 1 ]; then
    log "Lead identity preflight sensor failed; holding before launch"
    _lead_identity_alert lead_dual_active_sensor_degraded \
      "Lead identity preflight sensor failed" \
      "${PROJECT_NAME}/${LEAD_ID} could not read the process table and is held before launch."
    _hold_sleep_and_advance
    continue
  fi

  # FLY-1402 launch-ownership commit point: lease acquisition, tmux takeover,
  # and exact-process preflight have all allowed this generation. Receipt write
  # is fail-STOP before any Claude child; the helper is idempotent across crash
  # recovery iterations, so neither receipt nor legacy alert repeats.
  if ! _rules_bundle_commit_once; then
    log "FATAL: failed to commit active Lead rules receipt; refusing child launch"
    exit 1
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
    # FLY-1389 P0-b: diagnostic ONLY — log whether the transcript this resume
    # needs exists. The slug rule is a Claude Code internal convention (no
    # stable contract), so nothing is ever deleted based on this; deletion
    # authority is the P0-c counter below + test-deploy's pre-delete.
    log "$(resume_transcript_diagnose "${CLAUDE_CONFIG_DIR:-}" "$LEAD_WORKSPACE" "$SESSION_ID")"

    # Final SIGTERM gate — must be right before fork to close the race window
    if [ "$SHOULD_EXIT" -ne 0 ]; then break; fi
    if _launch_claude "${CLAUDE_ARGS[@]}" --resume "$SESSION_ID"; then
      :
    else
      _fly1285_launch_rc=$?
      [ -n "$ENSURE_HOLD_KIND" ] || ENSURE_HOLD_KIND="unknown"
      [ -n "$ENSURE_HOLD_EVIDENCE" ] || ENSURE_HOLD_EVIDENCE="{\"reason\":\"launch_guard_failed\",\"exitCode\":${_fly1285_launch_rc}}"
      _tmux_report_hold "$ENSURE_HOLD_KIND" "$ENSURE_HOLD_EVIDENCE" || true
      _hold_sleep_and_advance
      continue
    fi
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
    if _launch_claude "${CLAUDE_ARGS[@]}" --session-id "$SESSION_ID"; then
      :
    else
      _fly1285_launch_rc=$?
      [ -n "$ENSURE_HOLD_KIND" ] || ENSURE_HOLD_KIND="unknown"
      [ -n "$ENSURE_HOLD_EVIDENCE" ] || ENSURE_HOLD_EVIDENCE="{\"reason\":\"launch_guard_failed\",\"exitCode\":${_fly1285_launch_rc}}"
      _tmux_report_hold "$ENSURE_HOLD_KIND" "$ENSURE_HOLD_EVIDENCE" || true
      _hold_sleep_and_advance
      continue
    fi
    # Write session file only after successful launch — no orphan on SIGTERM
    echo "$SESSION_ID" > "$SESSION_ID_FILE"
  fi

  # FLY-109: Start background dev-channels dialog poller. capture-pane is
  # ANSI-proof (unlike expect which fails on Ink TUI escape codes).
  # Only poll when dev-channels flag is active.
  # FLY-1679: that comment always stated the intent; the condition used to state
  # a proxy for it (`INBOX_MCP_ENABLED`). Now it reads the argv directly, so the
  # two agree. This is a no-op on today's tree — one site adds the flag and it
  # is gated on that same variable — and it keeps v1 from acquiring the
  # companion/external blind spot the moment a second contributor appears.
  if _dev_channels_flag_active && [ -n "${LEAD_WINDOW_ID:-}" ]; then
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

  # Resume failure heuristic: retry-before-delete (FLY-1389 P0-c).
  # Extracted to lib/resume-recovery.sh. Window is now <60s (was <10s): a
  # deterministic resume failure on a stale session-id dies in 10-15s, which
  # the old window classified as healthy and RESET the counter — the
  # fresh-start fallback never fired (529 Room incident: 9 resume crashes,
  # 0 successes). The >60s healthy-run crash-count reset lives in the same
  # decision (verbatim semantics).
  _rr_out="$(resume_recovery_decide "$IS_RESUME" "$DURATION" "$RESUME_FAIL_COUNT" "$RESUME_FAIL_THRESHOLD" "$CRASH_COUNT")"
  _rr_action="${_rr_out%% *}"
  _rr_rest="${_rr_out#* }"
  RESUME_FAIL_COUNT="${_rr_rest%% *}"
  CRASH_COUNT="${_rr_rest##* }"
  case "$_rr_action" in
    delete_session)
      log "Quick exit on resume (${DURATION}s < ${RESUME_FAIL_WINDOW_SECONDS}s) reached ${RESUME_FAIL_THRESHOLD} consecutive failures. Deleting session file for fresh start."
      rm -f "$SESSION_ID_FILE"
      ;;
    count_resume_fail)
      log "Quick exit on resume (${DURATION}s < ${RESUME_FAIL_WINDOW_SECONDS}s) — possible failure (${RESUME_FAIL_COUNT}/${RESUME_FAIL_THRESHOLD})."
      ;;
  esac

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

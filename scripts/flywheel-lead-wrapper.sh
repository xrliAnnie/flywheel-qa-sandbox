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
# FLY-650: honor host.json flywheelDir (core/host config). host_config_load
# exports FLYWHEEL_DIR only if not already set; with no host.json it derives the
# default == today's value, so the `${FLYWHEEL_DIR:-...}` below is byte-identical.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SELF_DIR/lib/host-config.sh" ]; then
  # shellcheck source=lib/host-config.sh
  source "$SELF_DIR/lib/host-config.sh"
  # FLY-650 (Codex R1 HIGH-2): FAIL-CLOSED on a malformed host.json (same as the
  # Bridge wrapper) — a broken core config must not silently fall back.
  if ! host_config_load >/dev/null; then
    echo "[wrapper] FATAL: host.json invalid (fail-closed) — fix it and restart" >&2
    exit 1
  fi
fi
# FLY-224: overridable defaults (testability seams). Unset in production launchd,
# so the resolved values — and therefore behavior — are byte-identical to before.
# FLY-650 (Codex R1 MED-1): .env/pids live under FLYWHEEL_STATE_DIR (the state
# ROOT) so Bridge + Leads share ONE state root; default == today's ~/.flywheel.
FLYWHEEL_DIR="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
FLYWHEEL_STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
ENV_FILE="${FLYWHEEL_WRAPPER_ENV_FILE:-${FLYWHEEL_STATE_DIR}/.env}"
PID_DIR="${FLYWHEEL_WRAPPER_PID_DIR:-${FLYWHEEL_STATE_DIR}/pids}"

log() {
  echo "[wrapper] $(date '+%H:%M:%S') $*"
}

# ── Source environment ─────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  log "ERROR: Environment file not found: ${ENV_FILE}"
  exit 1
fi
# FLY-142 PR #186 codex:rescue Bug A: `source $ENV_FILE` without `set -a`
# sets shell variables that are NOT exported into the subprocess env. When
# the wrapper `exec`s claude-lead.sh, the supervisor's `${FLYWHEEL_COMM_BACKEND:-mailbox}`
# read sees the default (mailbox) even when `.env` has `FLYWHEEL_COMM_BACKEND=commdb`,
# producing a split-brain rollback: Bridge picks CommDBLeadRuntime but Lead
# loads Agent Team identity flags → Lead writes mailbox, Bridge reads CommDB,
# messages are silently lost. `set -a` / `set +a` brackets the source so every
# assignment auto-exports into the process env that `exec` inherits.
#
# codex:rescue Round 2 LOW: capture the incoming `allexport` state and only
# turn it off after the source if WE were the one who turned it on. Without
# this, a caller that already had `set -a` enabled (rare but possible —
# e.g., a wrapping launchd job that pre-exports) would have it
# unintentionally disabled after this block.
if [[ "$-" == *a* ]]; then
  _wrapper_prev_allexport=on
else
  _wrapper_prev_allexport=off
fi
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
if [ "$_wrapper_prev_allexport" = "off" ]; then
  set +a
fi
unset _wrapper_prev_allexport

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
# FLY-143: optional fields for Lead MCP scope tuning.
# `mcpExclude`: comma-separated user-scope MCP servers this Lead should skip
#   (e.g. Simba excludes "bambu-h2d,xiaohongshu-mcp,pencil").
# `chromeEnabled`: opt-in to Claude in Chrome — see claude-lead.sh for the
#   security note about bypassPermissions + --chrome.
MCP_EXCLUDE=$(jq -r '.mcpExclude // ""' "$MANIFEST")
CHROME_ENABLED=$(jq -r '.chromeEnabled // false' "$MANIFEST")
# FLY-224 Phase 2: vendor-pluggable Lead backend. Absent / "claude-code" → the
# existing claude-lead.sh path (byte-identical). "codex-app-server" → codex-lead.sh.
# The single source of truth is .flywheel/config.yaml roles.lead.backend, resolved
# once and written into the manifest as leadBackend.backendId (Phase 0A §1).
LEAD_BACKEND=$(jq -r '.leadBackend.backendId // "claude-code"' "$MANIFEST")

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

# FLY-143: per-Lead MCP scope env vars — claude-lead.sh reads these.
# Empty MCP_EXCLUDE means "no per-Lead exclusion beyond the global blacklist".
# CHROME_ENABLED defaults to false (manifest must explicitly opt in).
export FLYWHEEL_LEAD_MCP_EXCLUDE="$MCP_EXCLUDE"
if [ "$CHROME_ENABLED" = "true" ]; then
  export FLYWHEEL_LEAD_CHROME_ENABLED=true
fi

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

# ── exec the backend launcher ─────────────────────────────────
# exec replaces this wrapper process, so launchd directly manages the Lead
# supervisor (correct PID tracking, signal delivery).
#
# FLY-224 Phase 2: dispatch by resolved backend. The codex branch is opt-in via
# the manifest; the claude branch is byte-identical to the pre-FLY-224 behavior
# (same script, same cd, same exec, same args) so existing Leads are unaffected.
case "$LEAD_BACKEND" in
  codex-app-server)
    LEAD_SCRIPT="${FLYWHEEL_DIR}/packages/teamlead/scripts/codex-lead.sh"
    if [ ! -x "$LEAD_SCRIPT" ]; then
      log "ERROR: codex-lead.sh not found or not executable: ${LEAD_SCRIPT}"
      exit 1
    fi
    log "Backend: codex-app-server → codex-lead.sh"
    cd "${FLYWHEEL_DIR}/packages/teamlead"
    exec "$LEAD_SCRIPT" "${ARGS[@]}"
    ;;
  claude-code | "" | null)
    LEAD_SCRIPT="${FLYWHEEL_DIR}/packages/teamlead/scripts/claude-lead.sh"
    if [ ! -x "$LEAD_SCRIPT" ]; then
      log "ERROR: claude-lead.sh not found or not executable: ${LEAD_SCRIPT}"
      exit 1
    fi
    cd "${FLYWHEEL_DIR}/packages/teamlead"
    exec "$LEAD_SCRIPT" "${ARGS[@]}"
    ;;
  *)
    log "ERROR: unknown lead backend '${LEAD_BACKEND}' (expected claude-code | codex-app-server)."
    exit 1
    ;;
esac

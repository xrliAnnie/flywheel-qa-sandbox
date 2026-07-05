#!/usr/bin/env bash
# Daily Standup — called by launchd at 3:00 AM Pacific
# GEO-288: Triggers Bridge standup API to generate system status report.
# FLY-64: Added Bridge auto-start — if Bridge is down at trigger time,
#         the script starts it, waits for health, then triggers standup.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FLYWHEEL_DIR="${SCRIPT_DIR%/scripts}"
LOG_PREFIX="[daily-standup]"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $LOG_PREFIX $*"; }
log_err() { echo "$(date '+%Y-%m-%d %H:%M:%S') $LOG_PREFIX $*" >&2; }

# Source environment (STANDUP_CHANNEL, bot tokens, etc.)
# set -a: auto-export all sourced vars so Bridge inherits them if we start it.
ENV_FILE="${HOME}/.flywheel/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

BRIDGE_URL="${BRIDGE_URL:-http://localhost:9876}"
BRIDGE_STARTUP_TIMEOUT=60  # seconds to wait for Bridge health
RESTART_LOCK_DIR="${HOME}/.flywheel/restart.lock.d"

# ── Bridge liveness check ──────────────────────────────────────

bridge_healthy() {
  curl -sf "$BRIDGE_URL/health" > /dev/null 2>&1
}

BRIDGE_STARTED_BY_US=false

if ! bridge_healthy; then
  # If restart-services.sh is currently deploying, wait for it instead of competing
  if [ -d "$RESTART_LOCK_DIR" ]; then
    log "Bridge down but restart.lock.d exists — restart-services.sh is deploying. Waiting..."
    elapsed=0
    while [ "$elapsed" -lt "$BRIDGE_STARTUP_TIMEOUT" ] && [ -d "$RESTART_LOCK_DIR" ]; do
      sleep 2
      elapsed=$((elapsed + 2))
    done
    # If lock is still held, a deploy is in progress — do not compete
    if [ -d "$RESTART_LOCK_DIR" ]; then
      log_err "restart.lock.d still held after ${elapsed}s — deploy in progress, skipping standup to avoid race."
      exit 1
    fi
    # Lock released — Bridge should be up now
    if bridge_healthy; then
      log "Bridge came up after deploy finished (${elapsed}s)"
    else
      log_err "Bridge still down after restart.lock released. Will attempt self-start."
    fi
  fi
fi

if ! bridge_healthy; then
  log "Bridge not running at $BRIDGE_URL — starting it..."

  # Preflight: ensure built artifacts exist
  if [ ! -f "$FLYWHEEL_DIR/packages/teamlead/dist/bridge/plugin.js" ]; then
    log_err "Bridge not built ($FLYWHEEL_DIR/packages/teamlead/dist/ missing). Run 'pnpm build' first."
    exit 1
  fi

  # cd to repo root — npx tsx resolves the local tsx dependency from node_modules
  cd "$FLYWHEEL_DIR"

  # Start Bridge in background (inherits our env, including sourced .env)
  nohup npx tsx "$FLYWHEEL_DIR/scripts/run-bridge.ts" >> /tmp/flywheel-bridge.log 2>&1 &
  BRIDGE_PID=$!
  log "Bridge starting (PID $BRIDGE_PID)..."

  # Wait for Bridge to become healthy
  elapsed=0
  while [ "$elapsed" -lt "$BRIDGE_STARTUP_TIMEOUT" ]; do
    if bridge_healthy; then
      log "Bridge healthy after ${elapsed}s"
      BRIDGE_STARTED_BY_US=true
      break
    fi
    # Check process is still alive
    if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
      log_err "Bridge process (PID $BRIDGE_PID) exited before becoming healthy. Check /tmp/flywheel-bridge.log"
      exit 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  if ! bridge_healthy; then
    log_err "Bridge failed to start within ${BRIDGE_STARTUP_TIMEOUT}s. Check /tmp/flywheel-bridge.log"
    exit 1
  fi
fi

# ── FLY-90: Daily gbrain doc reconciliation ───────────────────
# Best-effort: sync failure must NOT abort standup delivery

if [[ -x "$HOME/.flywheel/bin/sync-gbrain-docs.sh" ]]; then
  "$HOME/.flywheel/bin/sync-gbrain-docs.sh" || log "WARNING: gbrain doc sync failed (non-fatal)"
fi

# ── Trigger standup ────────────────────────────────────────────

log "Triggering standup at $BRIDGE_URL/api/standup/trigger"

CURL_ARGS=(-sf -X POST "$BRIDGE_URL/api/standup/trigger" -H "Content-Type: application/json" -d '{}')
if [ -n "${TEAMLEAD_API_TOKEN:-}" ]; then
  CURL_ARGS+=(-H "Authorization: Bearer $TEAMLEAD_API_TOKEN")
fi

RESPONSE=$(curl "${CURL_ARGS[@]}" 2>&1) || {
  code=$?
  log_err "Standup trigger failed (curl exit $code). Response: $RESPONSE"
  exit $code
}

log "Standup triggered successfully"

# Log delivery status if response is JSON
if command -v jq > /dev/null 2>&1; then
  delivered=$(echo "$RESPONSE" | jq -r '.delivered // "unknown"' 2>/dev/null || echo "unknown")
  log "Delivered: $delivered"
fi

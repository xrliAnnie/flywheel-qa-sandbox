#!/bin/bash
# FLY-545: launchd → run-voice-bridge.ts thin wrapper.
#
# Mirrors flywheel-bridge-wrapper.sh discipline line by line (Codex R1 #7):
# .env sourcing (set -a), launchd minimal-PATH expansion, single-instance
# guard (health-port preflight via scripts/lib/bridge-port.sh + PID file —
# a double voice-bridge = same tokens twice = duplicate gateways / duplicate
# slash handlers / conflicting voice connections, must be structurally
# blocked), exec PID handover, bounded restart via plist ThrottleInterval.
#
# Usage: flywheel-voice-bridge-wrapper.sh
#   Invoked by launchd plist ProgramArguments — not intended for manual use.
set -euo pipefail

# FLY-650 host-config resolution (fail-closed on a PRESENT-but-broken host.json).
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SELF_DIR/lib/host-config.sh" ]]; then
  # shellcheck source=lib/host-config.sh
  source "$SELF_DIR/lib/host-config.sh"
  if ! host_config_load >/dev/null; then
    echo "[voice-bridge-wrapper] FATAL: host.json invalid (fail-closed) — fix it and restart" >&2
    exit 1
  fi
fi
FLYWHEEL_DIR="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
FLYWHEEL_STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
ENV_FILE="${FLYWHEEL_STATE_DIR}/.env"
PID_FILE="${FLYWHEEL_STATE_DIR}/pids/voice-bridge.pid"

log() { echo "[voice-bridge-wrapper] $(date '+%H:%M:%S') $*"; }

# ── Source environment (fail-fast) ─────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  log "ERROR: Environment file not found: ${ENV_FILE}"
  exit 1
fi
# set -a: bare KEY=value lines in ~/.flywheel/.env must reach the exec'd
# Node process (mirrors flywheel-bridge-wrapper.sh).
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

# ── Expand PATH for launchd minimal env ────────────────────────
export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:${PATH}"

# ── Port preflight on the health port — single-instance guard #1 ──────────
# A healthy voice-bridge already serving /health → exit 0 (double-start guard);
# an orphan holding the port → reclaim or fail-loud (bridge-port.sh logic,
# hermetically tested there).
VOICE_BRIDGE_PORT="${FLYWHEEL_VOICE_BRIDGE_HEALTH_PORT:-9878}"
BRIDGE_PORT_LIB="${FLYWHEEL_DIR}/scripts/lib/bridge-port.sh"
if [[ -f "$BRIDGE_PORT_LIB" ]]; then
  # shellcheck source=lib/bridge-port.sh
  source "$BRIDGE_PORT_LIB"
  STATE_DIR="${FLYWHEEL_STATE_DIR}/state"
  START_MARKER="${STATE_DIR}/voice-bridge-wrapper-starts"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  PREFLIGHT_ACTION="$(bp_launcher_preflight "$VOICE_BRIDGE_PORT" "http://127.0.0.1:${VOICE_BRIDGE_PORT}" "$START_MARKER")"
  case "$PREFLIGHT_ACTION" in
    already-healthy)
      log "Healthy voice-bridge already serving :${VOICE_BRIDGE_PORT} — exit 0 (double-start guard)."
      exit 0
      ;;
    stuck)
      log "Port :${VOICE_BRIDGE_PORT} could not be reclaimed — refusing to start (alerted). Exit 1."
      exit 1
      ;;
    bind|*)
      : # port is ours — proceed.
      ;;
  esac
else
  log "WARNING: ${BRIDGE_PORT_LIB} not found — skipping port preflight (degraded)."
fi

# ── PID lock — single-instance guard #2 (pre-bind boot race) ───────────────
if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ -n "${EXISTING_PID:-}" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    log "voice-bridge already running (PID ${EXISTING_PID}). Exit 0 — launchd retries after ThrottleInterval."
    exit 0
  fi
fi
mkdir -p "$(dirname "$PID_FILE")"
echo $$ > "$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT

cd "$FLYWHEEL_DIR"
log "Starting voice-bridge (health :${VOICE_BRIDGE_PORT})"

# exec replaces this wrapper so launchd directly manages the daemon process.
exec npx tsx scripts/run-voice-bridge.ts

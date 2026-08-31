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

# FLY-2190: direct launchd KeepAlive births bypass updater/restart entry points,
# so this carrier checks the converged host tmux gate before consuming S1 PATH.
host_tmux_gate_fail_loud() {
  local rc="$1"
  local bounded_run="${FLYWHEEL_DIR}/scripts/lib/bounded-run.sh"
  local meta_alert="${FLYWHEEL_META_ALERT_BIN:-${FLYWHEEL_DIR}/scripts/meta-alert.sh}"
  local reason="host_tmux_selection_gate_unavailable_voice-bridge"
  local title="Voice Bridge host tmux selection gate unavailable"
  local body="Host tmux selection gate failed with exit ${rc}; refusing to launch voice-bridge until host selection authority is restored."
  log "FAIL-LOUD [${reason}] ${title} — ${body}" >&2
  if [ -x "$bounded_run" ] && [ -x "$meta_alert" ]; then
    "$bounded_run" "${FLYWHEEL_META_ALERT_TIMEOUT_S:-15}" \
      "$meta_alert" "$reason" "$title" "$body" >/dev/null 2>&1 || true
  else
    log "FAIL-LOUD notifier unavailable (bounded-run=${bounded_run}, meta-alert=${meta_alert})." >&2
  fi
}

HOST_TMUX_GATE_DEFAULT="${FLYWHEEL_STATE_DIR}/bin/host-tmux-selection-gate.sh"
HOST_TMUX_GATE_FALLBACK="${FLYWHEEL_DIR}/scripts/host-tmux-selection-gate.sh"
HOST_TMUX_GATE_OVERRIDE="${FLYWHEEL_HOST_TMUX_GATE_BIN:-}"
if [ -n "$HOST_TMUX_GATE_OVERRIDE" ]; then
  HOST_TMUX_GATE_BIN="$HOST_TMUX_GATE_OVERRIDE"
  case "$FLYWHEEL_STATE_DIR" in
    /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) : ;;
    *)
      log "Host tmux gate override is not allowed for the production state root — refusing to launch voice-bridge."
      host_tmux_gate_fail_loud 126
      exit 0
      ;;
  esac
elif [ -f "$HOST_TMUX_GATE_DEFAULT" ] && [ ! -L "$HOST_TMUX_GATE_DEFAULT" ] \
  && [ -x "$HOST_TMUX_GATE_DEFAULT" ]; then
  HOST_TMUX_GATE_BIN="$HOST_TMUX_GATE_DEFAULT"
else
  HOST_TMUX_GATE_BIN="$HOST_TMUX_GATE_FALLBACK"
fi
unset HOST_TMUX_GATE_OVERRIDE
unset FLYWHEEL_HOST_TMUX_GATE_TEST_MODE \
  FLYWHEEL_HOST_TMUX_POST_S1_PATH \
  FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH \
  FLYWHEEL_HOST_TMUX_FILE_BIN \
  FLYWHEEL_HOST_TMUX_HOST_ID \
  FLYWHEEL_HOST_TMUX_GATE_APPLICABILITY \
  FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH \
  FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS
HOST_TMUX_TARGET_SHA="$(/usr/bin/git -C "$FLYWHEEL_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
if [ -z "$HOST_TMUX_TARGET_SHA" ] && [ -f "${FLYWHEEL_STATE_DIR}/deployed-sha" ]; then
  HOST_TMUX_TARGET_SHA="$(/bin/cat "${FLYWHEEL_STATE_DIR}/deployed-sha" 2>/dev/null || true)"
fi
if [ -z "$HOST_TMUX_TARGET_SHA" ] && [ -f "${FLYWHEEL_DIR}/.flywheel-build-sha" ] \
  && [ ! -L "${FLYWHEEL_DIR}/.flywheel-build-sha" ]; then
  HOST_TMUX_TARGET_SHA="$(/bin/cat "${FLYWHEEL_DIR}/.flywheel-build-sha" 2>/dev/null || true)"
fi
HOST_TMUX_GATE_RC=0
FLYWHEEL_HOST_TMUX_TARGET_SHA="$HOST_TMUX_TARGET_SHA" \
FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:voice-bridge" \
FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-voice-bridge-wrapper.sh" \
  "$HOST_TMUX_GATE_BIN" gate voice-bridge || HOST_TMUX_GATE_RC=$?
if [ "$HOST_TMUX_GATE_RC" -eq 0 ]; then
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$HOST_TMUX_TARGET_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:voice-bridge" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-voice-bridge-wrapper.sh" \
    "$HOST_TMUX_GATE_BIN" verify voice-bridge || HOST_TMUX_GATE_RC=$?
fi
if [ "$HOST_TMUX_GATE_RC" -ne 0 ]; then
  log "Host tmux selection gate held or unavailable (exit ${HOST_TMUX_GATE_RC}) — refusing to launch voice-bridge."
  host_tmux_gate_fail_loud "$HOST_TMUX_GATE_RC"
  exit 0
fi

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

# ── FLY-1501: durable restart-storm ceiling ─────────────────────
# Run after both single-instance guards and before this launch writes a PID
# file, so a pre-bind no-op bounce does not burn the restart budget.
RESTART_STORM_GATE_BIN="${FLYWHEEL_RESTART_STORM_GATE_BIN:-${FLYWHEEL_DIR}/scripts/restart-storm-gate.py}"
# `set -e` aborts on a bare non-zero command, so the exit code must be
# captured in an errexit-exempt `||` list — otherwise a held brake would
# kill this wrapper with the gate's status and launchd would read the
# hold as a crash.
RESTART_STORM_RC=0
"$RESTART_STORM_GATE_BIN" gate voice-bridge || RESTART_STORM_RC=$?
if [ "$RESTART_STORM_RC" -ne 0 ]; then
  if [ "$RESTART_STORM_RC" -eq 126 ] || [ "$RESTART_STORM_RC" -eq 127 ]; then
    # Bounded and synchronous, via the shared helper. Unbounded would let a
    # hung osascript inside meta-alert.sh pin this launch path so launchd
    # never retries once the brake is restored; detached would let launchd
    # kill the notifier with the job's process group before it writes its
    # marker, restoring the silence this branch removes.
    "${FLYWHEEL_DIR}/scripts/lib/bounded-run.sh" \
      "${FLYWHEEL_META_ALERT_TIMEOUT_S:-15}" \
      "${FLYWHEEL_META_ALERT_BIN:-${FLYWHEEL_DIR}/scripts/meta-alert.sh}" \
      restart_storm_gate_unavailable_voice-bridge \
      "Restart brake unavailable" \
      "restart-storm-gate.py is missing or not executable (exit ${RESTART_STORM_RC}); voice-bridge will not launch until it is restored." \
      >/dev/null 2>&1 || true
    log "Restart brake missing or not executable (exit ${RESTART_STORM_RC}) — refusing to launch voice-bridge."
  else
    log "Restart-storm gate held or refused voice-bridge startup — not writing PID marker."
  fi
  exit 0
fi

mkdir -p "$(dirname "$PID_FILE")"
echo $$ > "$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT

cd "$FLYWHEEL_DIR"
log "Starting voice-bridge (health :${VOICE_BRIDGE_PORT})"

# exec replaces this wrapper so launchd directly manages the daemon process.
exec npx tsx scripts/run-voice-bridge.ts

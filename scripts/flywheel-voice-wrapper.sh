#!/bin/bash
# FLY-2446: launchd boundary for the standalone Codex realtime voice daemon.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "[voice-wrapper] $(date '+%H:%M:%S') $*"; }

fail_loud() {
  local reason="$1" title="$2" body="$3"
  local alert_root="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
  local bounded_run="${alert_root}/scripts/lib/bounded-run.sh"
  local meta_alert="${FLYWHEEL_META_ALERT_BIN:-${alert_root}/scripts/meta-alert.sh}"
  log "FAIL-LOUD [${reason}] ${title} — ${body}" >&2
  if [[ -x "$bounded_run" && -x "$meta_alert" ]]; then
    "$bounded_run" "${FLYWHEEL_META_ALERT_TIMEOUT_S:-15}" \
      "$meta_alert" "$reason" "$title" "$body" >/dev/null 2>&1 || true
  fi
}

if [[ ! -f "$SELF_DIR/lib/host-config.sh" ]]; then
  fail_loud voice_config_unavailable "Voice configuration unavailable" \
    "host-config.sh is missing; refusing to launch voice."
  exit 0
fi
# shellcheck source=lib/host-config.sh
source "$SELF_DIR/lib/host-config.sh"
if ! host_config_load >/dev/null; then
  fail_loud voice_config_invalid "Voice configuration invalid" \
    "host.json is invalid; refusing to launch voice."
  exit 0
fi

FLYWHEEL_DIR="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
FLYWHEEL_STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
ENV_FILE="${FLYWHEEL_STATE_DIR}/.env"
PID_FILE="${FLYWHEEL_STATE_DIR}/pids/voice.pid"
if [[ ! -f "$ENV_FILE" ]]; then
  fail_loud voice_config_invalid "Voice configuration invalid" \
    "Environment file is missing: ${ENV_FILE}"
  exit 0
fi
set -a
# shellcheck source=/dev/null
if ! source "$ENV_FILE"; then
  set +a
  fail_loud voice_config_invalid "Voice configuration invalid" \
    "Environment file could not be loaded: ${ENV_FILE}"
  exit 0
fi
set +a

export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
VOICE_ENTRY="${FLYWHEEL_DIR}/packages/voice-codex/dist/cli.js"
if [[ -z "${TEAMLEAD_API_TOKEN:-}" || ! -f "$VOICE_ENTRY" ]] || ! command -v node >/dev/null 2>&1; then
  fail_loud voice_config_invalid "Voice configuration invalid" \
    "TEAMLEAD_API_TOKEN, node, or the built voice entrypoint is unavailable."
  exit 0
fi

HOST_TMUX_GATE_DEFAULT="${FLYWHEEL_STATE_DIR}/bin/host-tmux-selection-gate.sh"
HOST_TMUX_GATE_FALLBACK="${FLYWHEEL_DIR}/scripts/host-tmux-selection-gate.sh"
HOST_TMUX_GATE_OVERRIDE="${FLYWHEEL_HOST_TMUX_GATE_BIN:-}"
if [[ -n "$HOST_TMUX_GATE_OVERRIDE" ]]; then
  HOST_TMUX_GATE_BIN="$HOST_TMUX_GATE_OVERRIDE"
  case "$FLYWHEEL_STATE_DIR" in
    /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) : ;;
    *)
      fail_loud host_tmux_selection_gate_unavailable_voice \
        "Voice host tmux selection gate unavailable" \
        "A production-state gate override was refused."
      exit 0
      ;;
  esac
elif [[ -f "$HOST_TMUX_GATE_DEFAULT" && ! -L "$HOST_TMUX_GATE_DEFAULT" && -x "$HOST_TMUX_GATE_DEFAULT" ]]; then
  HOST_TMUX_GATE_BIN="$HOST_TMUX_GATE_DEFAULT"
else
  HOST_TMUX_GATE_BIN="$HOST_TMUX_GATE_FALLBACK"
fi
unset HOST_TMUX_GATE_OVERRIDE FLYWHEEL_HOST_TMUX_GATE_TEST_MODE \
  FLYWHEEL_HOST_TMUX_POST_S1_PATH FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH \
  FLYWHEEL_HOST_TMUX_FILE_BIN FLYWHEEL_HOST_TMUX_HOST_ID \
  FLYWHEEL_HOST_TMUX_GATE_APPLICABILITY FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH \
  FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS

HOST_TMUX_TARGET_SHA="$(/usr/bin/git -C "$FLYWHEEL_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
if [[ -z "$HOST_TMUX_TARGET_SHA" && -f "${FLYWHEEL_STATE_DIR}/deployed-sha" ]]; then
  HOST_TMUX_TARGET_SHA="$(/bin/cat "${FLYWHEEL_STATE_DIR}/deployed-sha" 2>/dev/null || true)"
fi
HOST_TMUX_GATE_RC=0
FLYWHEEL_HOST_TMUX_TARGET_SHA="$HOST_TMUX_TARGET_SHA" \
FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:voice" \
FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-voice-wrapper.sh" \
  "$HOST_TMUX_GATE_BIN" gate voice || HOST_TMUX_GATE_RC=$?
if [[ "$HOST_TMUX_GATE_RC" -eq 0 ]]; then
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$HOST_TMUX_TARGET_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:voice" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-voice-wrapper.sh" \
    "$HOST_TMUX_GATE_BIN" verify voice || HOST_TMUX_GATE_RC=$?
fi
if [[ "$HOST_TMUX_GATE_RC" -ne 0 ]]; then
  fail_loud host_tmux_selection_gate_unavailable_voice \
    "Voice host tmux selection gate unavailable" \
    "Host tmux selection gate failed with exit ${HOST_TMUX_GATE_RC}; refusing to launch voice."
  exit 0
fi

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$EXISTING_PID" =~ ^[1-9][0-9]*$ ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    log "voice already running (PID ${EXISTING_PID}); exit 0."
    exit 0
  fi
fi

RESTART_STORM_GATE_BIN="${FLYWHEEL_RESTART_STORM_GATE_BIN:-${FLYWHEEL_DIR}/scripts/restart-storm-gate.py}"
RESTART_STORM_RC=0
"$RESTART_STORM_GATE_BIN" gate voice || RESTART_STORM_RC=$?
if [[ "$RESTART_STORM_RC" -ne 0 ]]; then
  if [[ "$RESTART_STORM_RC" -eq 126 || "$RESTART_STORM_RC" -eq 127 ]]; then
    "${FLYWHEEL_DIR}/scripts/lib/bounded-run.sh" \
      "${FLYWHEEL_META_ALERT_TIMEOUT_S:-15}" \
      "${FLYWHEEL_META_ALERT_BIN:-${FLYWHEEL_DIR}/scripts/meta-alert.sh}" \
      restart_storm_gate_unavailable_voice \
      "Voice restart brake unavailable" \
      "restart-storm-gate.py is unavailable (exit ${RESTART_STORM_RC}); voice will not launch until it is restored." \
      >/dev/null 2>&1 || true
    log "Restart brake unavailable (exit ${RESTART_STORM_RC}); refusing to launch voice."
  else
    log "Restart-storm gate held or refused voice startup."
  fi
  exit 0
fi

cd "$FLYWHEEL_DIR"
if ! node packages/voice-codex/dist/cli.js --check-config >/dev/null 2>&1; then
  fail_loud voice_config_invalid "Voice configuration invalid" \
    "The voice daemon rejected its startup configuration."
  exit 0
fi

mkdir -p "$(dirname "$PID_FILE")"
echo $$ > "$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT
log "Starting standalone voice daemon"
exec node packages/voice-codex/dist/cli.js

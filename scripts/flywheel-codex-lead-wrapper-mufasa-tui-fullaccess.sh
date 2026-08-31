#!/bin/bash
# FLY-398 / FLY-2190: launchd -> the windowed full-access Mufasa Codex Lead.
# This is the source of truth for the installed state-bin wrapper selected by
# com.flywheel.lead.growth-mufasa-lead.plist.
set -euo pipefail

FLYWHEEL_STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
ENV_FILE="${FLYWHEEL_STATE_DIR}/.env"
FLYWHEEL_DIR="${FLYWHEEL_DIR:-/Users/xiaorongli/Dev/flywheel}"
MAIN_REPO="$FLYWHEEL_DIR"
LAUNCHER="${MAIN_REPO}/packages/teamlead/scripts/run-codex-lead-mufasa-tui-fullaccess.sh"

log() { echo "[codex-tui-fullaccess-wrapper] $(date '+%H:%M:%S') $*"; }

if [ ! -f "$ENV_FILE" ]; then
  log "ERROR: Environment file not found: ${ENV_FILE}"
  exit 1
fi
if [[ "$-" == *a* ]]; then _wrapper_prev_allexport=on; else _wrapper_prev_allexport=off; fi
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
if [ "$_wrapper_prev_allexport" = "off" ]; then set +a; fi
unset _wrapper_prev_allexport

export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

# FLY-2190: this distinct launchd KeepAlive carrier needs its own mount.
host_tmux_gate_fail_loud() {
  local rc="$1"
  local bounded_run="${MAIN_REPO}/scripts/lib/bounded-run.sh"
  local meta_alert="${FLYWHEEL_META_ALERT_BIN:-${MAIN_REPO}/scripts/meta-alert.sh}"
  local reason="host_tmux_selection_gate_unavailable_codex-mufasa"
  local title="Mufasa host tmux selection gate unavailable"
  local body="Host tmux selection gate failed with exit ${rc}; refusing Mufasa birth until host selection authority is restored."
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
      log "Host tmux gate override is not allowed for the production state root — refusing Mufasa birth."
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
HOST_TMUX_TARGET_SHA="$(/usr/bin/git -C "$MAIN_REPO" rev-parse --verify HEAD 2>/dev/null || true)"
if [ -z "$HOST_TMUX_TARGET_SHA" ] && [ -f "${FLYWHEEL_STATE_DIR}/deployed-sha" ]; then
  HOST_TMUX_TARGET_SHA="$(/bin/cat "${FLYWHEEL_STATE_DIR}/deployed-sha" 2>/dev/null || true)"
fi
if [ -z "$HOST_TMUX_TARGET_SHA" ] && [ -f "${FLYWHEEL_DIR}/.flywheel-build-sha" ] \
  && [ ! -L "${FLYWHEEL_DIR}/.flywheel-build-sha" ]; then
  HOST_TMUX_TARGET_SHA="$(/bin/cat "${FLYWHEEL_DIR}/.flywheel-build-sha" 2>/dev/null || true)"
fi
HOST_TMUX_GATE_RC=0
FLYWHEEL_HOST_TMUX_TARGET_SHA="$HOST_TMUX_TARGET_SHA" \
FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:codex-mufasa" \
FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" \
  "$HOST_TMUX_GATE_BIN" gate codex-mufasa || HOST_TMUX_GATE_RC=$?
if [ "$HOST_TMUX_GATE_RC" -eq 0 ]; then
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$HOST_TMUX_TARGET_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:codex-mufasa" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" \
    "$HOST_TMUX_GATE_BIN" verify codex-mufasa || HOST_TMUX_GATE_RC=$?
fi
if [ "$HOST_TMUX_GATE_RC" -ne 0 ]; then
  log "Host tmux selection gate held or unavailable (exit ${HOST_TMUX_GATE_RC}) — refusing Mufasa birth."
  host_tmux_gate_fail_loud "$HOST_TMUX_GATE_RC"
  exit 0
fi

export FLYWHEEL_CODEX_LEAD_PROJECT_DIR="${HOME}/Dev/growth"

if [ ! -f "$LAUNCHER" ]; then
  log "ERROR: TUI full-access launcher not found: ${LAUNCHER}"
  exit 1
fi

log "Starting Codex Mufasa WINDOWED FULL-ACCESS (TUI) Lead (projectDir=${FLYWHEEL_CODEX_LEAD_PROJECT_DIR})"
exec /bin/bash "$LAUNCHER"

#!/bin/bash
# FLY-2444: shared host-tmux gate resolution for generalized Lead carriers.

[ -n "${LEAD_HOST_TMUX_GATE_SOURCED:-}" ] && return 0
LEAD_HOST_TMUX_GATE_SOURCED=1

lead_host_tmux_gate_resolve() {
  local installed="${FLYWHEEL_STATE_DIR}/bin/host-tmux-selection-gate.sh"
  local source="${FLYWHEEL_DIR}/scripts/host-tmux-selection-gate.sh"
  local override="${FLYWHEEL_HOST_TMUX_GATE_BIN:-}"
  if [ -n "$override" ]; then
    case "$FLYWHEEL_STATE_DIR" in
      /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) ;;
      *)
        echo "[flywheel-lead] ERROR: host tmux gate override is forbidden for the production state root" >&2
        return 126
        ;;
    esac
    HOST_TMUX_GATE_BIN="$override"
  elif [ -f "$installed" ] && [ ! -L "$installed" ] && [ -x "$installed" ]; then
    HOST_TMUX_GATE_BIN="$installed"
  else
    HOST_TMUX_GATE_BIN="$source"
  fi
  lead_host_tmux_gate_scrub
  export HOST_TMUX_GATE_BIN
}

lead_host_tmux_gate_scrub() {
  unset FLYWHEEL_HOST_TMUX_GATE_BIN \
    FLYWHEEL_HOST_TMUX_GATE_TEST_MODE \
    FLYWHEEL_HOST_TMUX_POST_S1_PATH \
    FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH \
    FLYWHEEL_HOST_TMUX_FILE_BIN \
    FLYWHEEL_HOST_TMUX_HOST_ID \
    FLYWHEEL_HOST_TMUX_GATE_APPLICABILITY \
    FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH \
    FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS
}

lead_host_tmux_target_sha() {
  local target_sha=""
  target_sha="$(/usr/bin/git -C "$FLYWHEEL_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
  if [ -z "$target_sha" ] && [ -f "${FLYWHEEL_STATE_DIR}/deployed-sha" ]; then
    target_sha="$(/bin/cat "${FLYWHEEL_STATE_DIR}/deployed-sha" 2>/dev/null || true)"
  fi
  if [ -z "$target_sha" ] && [ -f "${FLYWHEEL_DIR}/.flywheel-build-sha" ] \
    && [ ! -L "${FLYWHEEL_DIR}/.flywheel-build-sha" ]; then
    target_sha="$(/bin/cat "${FLYWHEEL_DIR}/.flywheel-build-sha" 2>/dev/null || true)"
  fi
  printf '%s\n' "$target_sha"
}

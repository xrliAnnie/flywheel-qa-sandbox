#!/bin/bash
# FLY-2301: launchd -> isolated windowed Codex Lead in a 529-room slot.
set -euo pipefail

FLYWHEEL_STATE_DIR="${FLYWHEEL_STATE_DIR:?}"
FLYWHEEL_DIR="${FLYWHEEL_DIR:?}"
ENV_FILE="${FLYWHEEL_STATE_DIR}/.env"

if [ ! -f "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
  echo "[qa-codex-lead-wrapper] ERROR: environment file unavailable" >&2
  exit 1
fi
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

HOST_TMUX_TARGET_SHA="$(/usr/bin/git -C "$FLYWHEEL_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
FLYWHEEL_HOST_TMUX_TARGET_SHA="$HOST_TMUX_TARGET_SHA" \
FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:qa-codex-tui" \
FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/lib/qa-codex-lead-wrapper.template.sh" \
  "${FLYWHEEL_DIR}/scripts/host-tmux-selection-gate.sh" gate codex-tui
FLYWHEEL_HOST_TMUX_TARGET_SHA="$HOST_TMUX_TARGET_SHA" \
FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:qa-codex-tui" \
FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/lib/qa-codex-lead-wrapper.template.sh" \
  "${FLYWHEEL_DIR}/scripts/host-tmux-selection-gate.sh" verify codex-tui

exec /bin/bash "${FLYWHEEL_DIR}/packages/teamlead/scripts/codex-lead.sh" @@LEAD_ID@@ @@PROJECT_DIR@@ @@PROJECT@@

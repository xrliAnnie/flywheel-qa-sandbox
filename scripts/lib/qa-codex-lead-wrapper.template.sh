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

while IFS= read -r host_tmux_env_name; do
  case "$host_tmux_env_name" in
    FLYWHEEL_HOST_TMUX_*) unset "$host_tmux_env_name" ;;
  esac
done < <(compgen -v)
unset host_tmux_env_name

FLYWHEEL_CODEX_TMUX_BIN="${FLYWHEEL_CODEX_TMUX_BIN:?}"
FLYWHEEL_CODEX_TMUX_VERSION="${FLYWHEEL_CODEX_TMUX_VERSION:?}"
if [[ "$FLYWHEEL_CODEX_TMUX_BIN" != /* || ! -x "$FLYWHEEL_CODEX_TMUX_BIN" ]]; then
  echo "[qa-codex-lead-wrapper] ERROR: tmux authority is not an absolute executable" >&2
  exit 1
fi
export PATH="$(dirname "$FLYWHEEL_CODEX_TMUX_BIN"):${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
resolved_tmux_bin=$(command -v tmux 2>/dev/null || true)
if [[ "$resolved_tmux_bin" != "$FLYWHEEL_CODEX_TMUX_BIN" ]]; then
  echo "[qa-codex-lead-wrapper] ERROR: tmux binary mismatch: expected=$FLYWHEEL_CODEX_TMUX_BIN resolved=${resolved_tmux_bin:-missing}" >&2
  exit 1
fi
pinned_tmux_version=$("$FLYWHEEL_CODEX_TMUX_BIN" -V 2>/dev/null || true)
runtime_tmux_version=$(tmux -V 2>/dev/null || true)
if [[ "$pinned_tmux_version" != "$FLYWHEEL_CODEX_TMUX_VERSION" \
    || "$runtime_tmux_version" != "$FLYWHEEL_CODEX_TMUX_VERSION" ]]; then
  echo "[qa-codex-lead-wrapper] ERROR: tmux version mismatch: expected=$FLYWHEEL_CODEX_TMUX_VERSION pinned=${pinned_tmux_version:-missing} runtime=${runtime_tmux_version:-missing}" >&2
  exit 1
fi

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

#!/bin/bash
# flywheel-cmux-install.sh — Install cmux workspace sync integration
# Idempotent: safe to run multiple times.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR="$HOME/.flywheel/bin"
INTEGRATION_FILE="$HOME/.flywheel/cmux-integration.zsh"
ZSHRC="$HOME/.zshrc"

MARKER_START="# >>> flywheel cmux integration >>>"
MARKER_END="# <<< flywheel cmux integration <<<"

echo "[install] Installing flywheel-cmux integration..."

# 1. Ensure install directory
mkdir -p "$INSTALL_DIR"

# 2. Symlink scripts (FLY-98: repo updates take effect immediately without re-install)
ln -sf "$REPO_DIR/scripts/flywheel-cmux-sync.sh" "$INSTALL_DIR/flywheel-cmux-sync"
ln -sf "$REPO_DIR/scripts/flywheel-cmux-autostart.sh" "$INSTALL_DIR/flywheel-cmux-autostart"

# 3. Write shell integration file
cat > "$INTEGRATION_FILE" << 'INTEGRATION'
# Flywheel cmux integration — auto-sync tmux agents to cmux workspace tabs
# Source: flywheel-cmux-install.sh
if [[ -n "${CMUX_WORKSPACE_ID:-}" ]]; then
  "$HOME/.flywheel/bin/flywheel-cmux-autostart" &!
fi
INTEGRATION

# 4. Add source line to .zshrc (idempotent)
if ! grep -qF "$MARKER_START" "$ZSHRC" 2>/dev/null; then
  echo "" >> "$ZSHRC"
  echo "$MARKER_START" >> "$ZSHRC"
  echo "source \"$INTEGRATION_FILE\"" >> "$ZSHRC"
  echo "$MARKER_END" >> "$ZSHRC"
  echo "[install] Added source line to ~/.zshrc"
else
  echo "[install] ~/.zshrc already has flywheel cmux integration"
fi

# 5. Configure cmux socket control mode (FLY-129)
# Watcher needs to talk to cmux from outside its process tree (the watcher
# orphans to launchd when its source pane closes). cmux's default
# `socketControlMode = cmuxOnly` rejects all non-descendant callers, so we
# need `allowAll`. Tradeoff: opens /tmp/cmux.sock to all local users (mode
# 0666). Acceptable for single-user dev box; NOT for shared/multi-user
# hosts.
echo "[install] Configuring cmux socket access..."
if ! command -v defaults >/dev/null 2>&1; then
  echo "[install] (Skipped: 'defaults' command not available — non-macOS host)"
elif [[ "${FLYWHEEL_CMUX_SOCKET_MODE:-}" == "allowAll" ]]; then
  defaults write com.cmuxterm.app socketControlMode -string allowAll
  echo "[install] ✓ Set socketControlMode = allowAll (via FLYWHEEL_CMUX_SOCKET_MODE env)"
  echo "[install] ⚠️  Restart cmux app for change to take effect."
elif [[ ! -t 0 ]]; then
  echo "[install] (Non-interactive stdin — skipping prompt.)"
  echo "[install]   To set automatically: FLYWHEEL_CMUX_SOCKET_MODE=allowAll bash $0"
  echo "[install]   To set manually:      defaults write com.cmuxterm.app socketControlMode -string allowAll"
else
  CURRENT_MODE=$(defaults read com.cmuxterm.app socketControlMode 2>/dev/null || echo "")
  if [[ "$CURRENT_MODE" == "allowAll" ]]; then
    echo "[install] socketControlMode already 'allowAll' ✓"
  else
    echo "[install] Current socketControlMode='${CURRENT_MODE:-unset}'"
    echo "[install] flywheel-cmux-sync needs 'allowAll' so the watcher can talk to cmux from"
    echo "[install] outside its process tree (the watcher orphans to launchd when source pane closes)."
    echo "[install] WARNING: 'allowAll' relaxes /tmp/cmux.sock to mode 0666 (any local user can connect)."
    echo "[install] Acceptable for single-user dev box; NOT for multi-user / shared hosts."
    echo ""
    resp="n"
    read -r -p "[install] Set socketControlMode to 'allowAll'? [y/N] " resp || resp="n"
    if [[ "$resp" =~ ^[Yy]$ ]]; then
      defaults write com.cmuxterm.app socketControlMode -string allowAll
      echo "[install] ✓ Set socketControlMode = allowAll"
      echo "[install] ⚠️  Restart cmux app for change to take effect."
    else
      echo "[install] Skipped. Watcher will WARN at startup and FATAL on access-denied."
    fi
  fi
fi

# 6. Note: watchers should be started ONLY through flywheel-cmux-autostart
# (which holds /tmp/flywheel-cmux-watcher.lock for single-instance gating).
# Direct `flywheel-cmux-sync --watch` skips the lock and may race with another
# watcher; reserve that for manual debugging.

echo "[install] Done. Restart cmux to activate."

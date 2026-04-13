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

echo "[install] Done. Restart cmux to activate."

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

# 6. Provision launchd supervision for the watcher (FLY-177).
# Without this the watcher is only started by the `.zshrc` path when a shell
# opens inside cmux — if it dies and no new cmux shell opens, it stays dead
# (the cmux Lead columns then go blank until manually restarted). A launchd
# KeepAlive job makes it auto-respawn. The plist sets FLYWHEEL_CMUX_SUPERVISED=1
# so the launchd instance BLOCK-WAITS for any `.zshrc`-started watcher to exit
# instead of fast-exit + KeepAlive respawn churn; the single-instance lock keeps
# the two start paths race-safe. Set FLYWHEEL_CMUX_INSTALL_SKIP_LAUNCHCTL=1 to
# render + lint the plist but skip the (side-effecting) load — used by tests/CI.
PLIST_TEMPLATE="$REPO_DIR/scripts/com.flywheel.cmux-watcher.plist.template"
PLIST_DEST="$HOME/Library/LaunchAgents/com.flywheel.cmux-watcher.plist"
WATCHER_LABEL="com.flywheel.cmux-watcher"
if [[ ! -f "$PLIST_TEMPLATE" ]]; then
  echo "[install] WARNING: plist template not found: $PLIST_TEMPLATE — skipping launchd provisioning"
elif ! command -v launchctl >/dev/null 2>&1; then
  echo "[install] (Skipped launchd watcher provisioning: 'launchctl' not available — non-macOS host)"
else
  echo "[install] Provisioning launchd watcher ($WATCHER_LABEL)..."
  mkdir -p "$HOME/Library/LaunchAgents"
  # Render __HOME__ → $HOME (no hard-coded user path checked into the repo).
  sed "s|__HOME__|$HOME|g" "$PLIST_TEMPLATE" > "$PLIST_DEST"
  # Validate before loading.
  if command -v plutil >/dev/null 2>&1; then
    if ! plutil -lint "$PLIST_DEST" >/dev/null; then
      echo "[install] ERROR: rendered plist failed plutil -lint: $PLIST_DEST"; exit 1
    fi
  fi
  if [[ "${FLYWHEEL_CMUX_INSTALL_SKIP_LAUNCHCTL:-0}" == "1" ]]; then
    echo "[install] (FLYWHEEL_CMUX_INSTALL_SKIP_LAUNCHCTL=1 — rendered + linted plist, skipped load)"
  else
    # Idempotent (re)load: bootout if already loaded, then bootstrap.
    launchctl bootout "gui/$(id -u)/$WATCHER_LABEL" 2>/dev/null || true
    # FLY-825: bootout is not guaranteed synchronous — give the old watcher
    # process a bounded chance to actually exit (see
    # flywheel-cmux-sync.sh:wait_for_watcher_exit for why bootout alone left a
    # production orphan, pid 64108, running for hours) before bootstrapping a
    # fresh instance.
    "$REPO_DIR/scripts/flywheel-cmux-sync.sh" --wait-for-watcher-exit
    if launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST" 2>/dev/null; then
      echo "[install] ✓ launchd watcher bootstrapped (KeepAlive)"
    else
      echo "[install] WARNING: launchctl bootstrap failed — check 'launchctl print gui/$(id -u)/$WATCHER_LABEL'"
    fi
  fi
fi

# 7. Note: start watchers ONLY via flywheel-cmux-autostart or the launchd job.
# Both paths funnel into `flywheel-cmux-sync --watch`, which holds the
# single-instance lock (FLY-129 pushed lock acquisition DOWN into the `--watch`
# dispatcher — so `--watch` does NOT skip the lock). Concurrent autostart +
# launchd starts are therefore race-safe and never double-run. launchd is the
# steady-state owner; the `.zshrc` autostart is the fallback.

echo "[install] Done. Restart cmux to activate."

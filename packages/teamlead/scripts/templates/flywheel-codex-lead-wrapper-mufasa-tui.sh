#!/bin/bash
# FLY-259 PR-F — launchd -> run-codex-lead-mufasa-tui.sh wrapper (Codex ③ TUI Lead).
#
# TEMPLATE — install to ~/.flywheel/bin/flywheel-codex-lead-wrapper-mufasa-tui.sh
# as part of the Mufasa ③ cutover (see the runbook). It is the TUI sibling of
# flywheel-codex-lead-wrapper-mufasa.sh (headless): launchd cannot source .bashrc
# or .env, so this wrapper sources ~/.flywheel/.env (MUFASA_BOT_TOKEN +
# FLYWHEEL_BRIDGE_URL + FLYWHEEL_API_TOKEN for bridge outbound + the FLY-267
# FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS), expands PATH, pins the runtime to the
# MAIN checkout, then execs the TUI launcher.
#
# Rollback: launchctl bootout the TUI job, restore the headless plist, bootstrap
# it (see rollback-codex-lead-mufasa-tui.sh).
set -euo pipefail

ENV_FILE="${HOME}/.flywheel/.env"
MAIN_REPO="/Users/xiaorongli/Dev/flywheel"
LAUNCHER="${MAIN_REPO}/packages/teamlead/scripts/run-codex-lead-mufasa-tui.sh"

log() { echo "[codex-tui-wrapper] $(date '+%H:%M:%S') $*"; }

# ── Source environment ─────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  log "ERROR: Environment file not found: ${ENV_FILE}"
  exit 1
fi
# `set -a` so every .env assignment auto-exports into the env that `exec`
# inherits (guarded so a caller that already had allexport keeps it).
if [[ "$-" == *a* ]]; then _wrapper_prev_allexport=on; else _wrapper_prev_allexport=off; fi
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
if [ "$_wrapper_prev_allexport" = "off" ]; then set +a; fi
unset _wrapper_prev_allexport

# ── Expand PATH for launchd (node, codex, jq live outside the launchd default) ─
export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:${PATH}"

# ── Pin the Codex runtime to the MAIN repo ────────────────────
export FLY224_WORKTREE="${MAIN_REPO}"

if [ ! -f "$LAUNCHER" ]; then
  log "ERROR: TUI launcher not found: ${LAUNCHER}"
  exit 1
fi

log "Starting Codex Mufasa ③ TUI Lead (FLY224_WORKTREE=${MAIN_REPO})"
# exec replaces this wrapper so launchd directly manages the launcher (which
# execs `node codex-lead-tui-runtime.js`) for correct PID/signal tracking.
exec /bin/bash "$LAUNCHER"

#!/bin/bash
# FLY-151: launchd → run-bridge.ts thin wrapper.
#
# launchd cannot source .bashrc or .env files, so this wrapper handles
# environment setup before exec-ing the real Bridge process. Mirrors the
# pattern established by scripts/flywheel-lead-wrapper.sh (FLY-74).
#
# Usage: flywheel-bridge-wrapper.sh
#   Invoked by launchd plist ProgramArguments — not intended for manual use.
#   For manual Bridge startup, use scripts/run-bridge.ts directly via tsx.
set -euo pipefail

FLYWHEEL_DIR="${HOME}/Dev/flywheel"
ENV_FILE="${HOME}/.flywheel/.env"
PID_FILE="${HOME}/.flywheel/pids/bridge.pid"

log() { echo "[bridge-wrapper] $(date '+%H:%M:%S') $*"; }

# ── Source environment (fail-fast) ─────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  log "ERROR: Environment file not found: ${ENV_FILE}"
  exit 1
fi
# `set -a` auto-exports every variable assigned while sourcing. Without it,
# bare `KEY=value` lines in ~/.flywheel/.env (the common case) would set
# shell-local vars only and never reach the exec'd Node process — defeating
# the whole purpose of this wrapper. Mirrors restart-services.sh:34-37.
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

# ── Expand PATH for launchd minimal env ────────────────────────
# launchd provides only /usr/bin:/bin:/usr/sbin:/sbin.
# tsx, npx, node, jq, brew tools live outside that.
export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:${PATH}"

# ── PID lock — prevent double-start ────────────────────────────
# When restart-services.sh races launchd KeepAlive (e.g., legacy nohup
# branch already started a Bridge), exit cleanly. launchd will retry
# after ThrottleInterval (30s) and take over if the prior instance dies.
if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ -n "${EXISTING_PID:-}" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    log "Bridge already running (PID ${EXISTING_PID}). Exit 0 — launchd retries after ThrottleInterval."
    exit 0
  fi
fi
mkdir -p "$(dirname "$PID_FILE")"
echo $$ > "$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT

cd "$FLYWHEEL_DIR"
log "Starting Bridge (TEAMLEAD_CHAT_THREADS_ENABLED=${TEAMLEAD_CHAT_THREADS_ENABLED:-unset})"

# exec replaces this wrapper process so launchd directly manages the
# Bridge process (correct PID tracking, signal delivery, KeepAlive).
exec npx tsx scripts/run-bridge.ts

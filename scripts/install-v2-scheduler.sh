#!/bin/bash
# FLY-1501: install the one allowed OS-timer backend for bounded scheduler-once.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/.." && pwd)"
DB_PATH="${HOME}/.flywheel/flywheel-v2.db"
PROJECT_NAME=""
CLI_PATH="$REPO_ROOT/packages/v2-scheduler/dist/cli.js"
GATE_BIN="$REPO_ROOT/scripts/restart-storm-gate.py"
LEDGER_ROOT=""
LOG_PATH="/tmp/flywheel-v2-scheduler.log"

usage() {
  echo "usage: install-v2-scheduler.sh --project <safe-id> [--db <abs>] [--cli <abs>] [--gate-bin <abs>] [--ledger-root <abs>] [--log <abs>]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT_NAME="${2:-}"; shift 2 ;;
    --db) DB_PATH="${2:-}"; shift 2 ;;
    --cli) CLI_PATH="${2:-}"; shift 2 ;;
    --gate-bin) GATE_BIN="${2:-}"; shift 2 ;;
    --ledger-root) LEDGER_ROOT="${2:-}"; shift 2 ;;
    --log) LOG_PATH="${2:-}"; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done

SAFE_ID='^[A-Za-z0-9][A-Za-z0-9._-]*$'
[[ "$PROJECT_NAME" =~ $SAFE_ID ]] || { echo "invalid --project" >&2; exit 2; }
for path in "$DB_PATH" "$CLI_PATH" "$GATE_BIN" "$LOG_PATH"; do
  [[ "$path" = /* && "$path" != *[[:space:]]* ]] || {
    echo "scheduler install paths must be absolute and whitespace-free: $path" >&2
    exit 2
  }
done
if [[ -n "$LEDGER_ROOT" ]]; then
  [[ "$LEDGER_ROOT" = /* && "$LEDGER_ROOT" != *[[:space:]]* ]] || {
    echo "--ledger-root must be absolute and whitespace-free" >&2
    exit 2
  }
fi
[[ -f "$CLI_PATH" ]] || { echo "scheduler CLI is not built: $CLI_PATH" >&2; exit 1; }
[[ -x "$GATE_BIN" ]] || { echo "restart gate is not executable: $GATE_BIN" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

# shellcheck source=lib/supervisor.sh
source "$SELF_DIR/lib/supervisor.sh"
BACKEND="$(supervisor_backend)"
[[ "$BACKEND" = "launchd" ]] || {
  echo "v2 scheduler supports exactly one installed backend (launchd); got ${BACKEND:-unknown}" >&2
  exit 1
}

UID_VALUE="$(id -u)"
EXEC_CMD="node $CLI_PATH --db $DB_PATH --project $PROJECT_NAME --backend launchd --gate-bin $GATE_BIN --uid $UID_VALUE"
if [[ -n "$LEDGER_ROOT" ]]; then
  EXEC_CMD="$EXEC_CMD --ledger-root $LEDGER_ROOT"
fi
SPEC="$(jq -nc \
  --arg exec "$EXEC_CMD" \
  --arg stdout "$LOG_PATH" \
  '{name:"v2-scheduler",kind:"timer",exec:$exec,intervalSeconds:60,timeoutSeconds:60,stdout:$stdout}')"

export FLYWHEEL_SUPERVISOR_BACKEND=launchd
export FLYWHEEL_SUPERVISOR_DARWIN_INSTALL=1
supervisor_install "$SPEC"
supervisor_is_loaded "v2-scheduler" "timer" >/dev/null

BEFORE="$(node -e 'process.stdout.write(new Date().toISOString())')"
supervisor_trigger "v2-scheduler" "timer"
for _ in $(seq 1 60); do
  if node "$CLI_PATH" --db "$DB_PATH" --check-receipt-after "$BEFORE" >/dev/null 2>&1; then
    echo "v2 scheduler installed and timer-trigger self-proof passed"
    exit 0
  fi
  sleep 1
done

echo "v2 scheduler timer was loaded but no successful bounded receipt appeared" >&2
exit 1

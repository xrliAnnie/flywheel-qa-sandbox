#!/bin/bash
# FLY-1502: install the single v2 authority host in held mode for final GO.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/.." && pwd)"
DB_PATH="${HOME}/.flywheel/v2/flywheel-v2.db"
MARKER_PATH=""
AUTHORITY_PATH="${HOME}/.flywheel/v2-cutover-authority.json"
ARMED_PATH="${HOME}/.flywheel/v2-cutover-armed"
WINDOW_ID=""
EPOCH=""
SOCKET_PATH="${HOME}/.flywheel/v2/host.sock"
SECRET_PATH="${HOME}/.flywheel/v2/host.secret"
SESSION_PROOF_ROOT="${HOME}/.flywheel/v2/session-proofs"
HOST_EPOCH=""
RUNTIME_CONFIG=""
HOST_CLI="$REPO_ROOT/packages/v2-host/dist/cli.js"
CLIENT_CLI="$REPO_ROOT/packages/v2-cli/dist/cli.js"
LOG_PATH="/tmp/flywheel-v2-engine.log"

usage() {
  echo "usage: install-v2-host.sh --window <id> --epoch <n> --host-epoch <id> --runtime-config <abs> [--db <abs>] [--marker <abs>] [--authority <abs>] [--armed <abs>] [--socket <abs>] [--secret <abs>] [--session-proof-root <abs>] [--host-cli <abs>] [--client-cli <abs>] [--log <abs>]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB_PATH="${2:-}"; shift 2 ;;
    --marker) MARKER_PATH="${2:-}"; shift 2 ;;
    --authority) AUTHORITY_PATH="${2:-}"; shift 2 ;;
    --armed) ARMED_PATH="${2:-}"; shift 2 ;;
    --window) WINDOW_ID="${2:-}"; shift 2 ;;
    --epoch) EPOCH="${2:-}"; shift 2 ;;
    --socket) SOCKET_PATH="${2:-}"; shift 2 ;;
    --secret) SECRET_PATH="${2:-}"; shift 2 ;;
    --session-proof-root) SESSION_PROOF_ROOT="${2:-}"; shift 2 ;;
    --host-epoch) HOST_EPOCH="${2:-}"; shift 2 ;;
    --runtime-config) RUNTIME_CONFIG="${2:-}"; shift 2 ;;
    --host-cli) HOST_CLI="${2:-}"; shift 2 ;;
    --client-cli) CLIENT_CLI="${2:-}"; shift 2 ;;
    --log) LOG_PATH="${2:-}"; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done

if [[ -z "$MARKER_PATH" ]]; then
  MARKER_PATH="${DB_PATH}.migration-complete.json"
fi
SAFE_ID='^[A-Za-z0-9][A-Za-z0-9._-]*$'
[[ "$WINDOW_ID" =~ $SAFE_ID ]] || { echo "invalid --window" >&2; exit 2; }
[[ "$HOST_EPOCH" =~ $SAFE_ID ]] || { echo "invalid --host-epoch" >&2; exit 2; }
[[ "$EPOCH" =~ ^[1-9][0-9]*$ ]] || { echo "invalid --epoch" >&2; exit 2; }
[[ -n "$RUNTIME_CONFIG" ]] || { echo "--runtime-config is required" >&2; exit 2; }
for path in \
  "$DB_PATH" "$MARKER_PATH" "$AUTHORITY_PATH" "$ARMED_PATH" "$SOCKET_PATH" \
  "$SECRET_PATH" "$SESSION_PROOF_ROOT" "$RUNTIME_CONFIG" "$HOST_CLI" \
  "$CLIENT_CLI" "$LOG_PATH"; do
  [[ "$path" = /* && "$path" != *[[:space:]]* ]] || {
    echo "host install paths must be absolute and whitespace-free: $path" >&2
    exit 2
  }
done
[[ -f "$HOST_CLI" ]] || { echo "host CLI is not built: $HOST_CLI" >&2; exit 1; }
[[ -f "$CLIENT_CLI" ]] || { echo "v2 client CLI is not built: $CLIENT_CLI" >&2; exit 1; }
[[ -f "$RUNTIME_CONFIG" ]] || { echo "runtime config is missing: $RUNTIME_CONFIG" >&2; exit 1; }
[[ -f "$SECRET_PATH" ]] || { echo "host secret is missing: $SECRET_PATH" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

[[ "$(file_mode "$SECRET_PATH")" = "600" ]] || {
  echo "host secret must have mode 0600 before installation" >&2
  exit 1
}
[[ "$(file_mode "$RUNTIME_CONFIG")" = "600" ]] || {
  echo "runtime config must have mode 0600 before installation" >&2
  exit 1
}
RUNTIME_BINS="$(jq -er '
  select(
    .v == 1 and
    .launcher.kind == "tmux" and
    ([.launcher.tmux_bin, .launcher.claude_bin, .launcher.codex_bin] |
      all(type == "string" and startswith("/"))) and
    (.launcher.client_cli | type == "string" and startswith("/")) and
    (.launcher.release_root | type == "string" and startswith("/")) and
    (.launcher.state_root | type == "string" and startswith("/"))
  ) |
  .launcher.tmux_bin,
  .launcher.claude_bin,
  .launcher.codex_bin
' "$RUNTIME_CONFIG")" || {
  echo "runtime config does not select the built-in tmux launcher with absolute paths" >&2
  exit 1
}
RUNTIME_BIN_COUNT=0
while IFS= read -r runtime_bin; do
  [[ -n "$runtime_bin" ]] || continue
  RUNTIME_BIN_COUNT=$((RUNTIME_BIN_COUNT + 1))
  [[ -x "$runtime_bin" ]] || {
    echo "runtime launcher dependency is not executable: $runtime_bin" >&2
    exit 1
  }
done <<< "$RUNTIME_BINS"
[[ "$RUNTIME_BIN_COUNT" -eq 3 ]] || {
  echo "runtime config did not yield the three required tmux/vendor binaries" >&2
  exit 1
}

# shellcheck source=lib/supervisor.sh
source "$SELF_DIR/lib/supervisor.sh"
BACKEND="$(supervisor_backend)"
[[ "$BACKEND" = "launchd" ]] || {
  echo "v2 host supports exactly one installed backend (launchd); got ${BACKEND:-unknown}" >&2
  exit 1
}

EXEC_CMD="node $HOST_CLI --db $DB_PATH --marker $MARKER_PATH --authority $AUTHORITY_PATH --armed $ARMED_PATH --window $WINDOW_ID --epoch $EPOCH --socket $SOCKET_PATH --secret $SECRET_PATH --session-proof-root $SESSION_PROOF_ROOT --host-epoch $HOST_EPOCH --runtime-config $RUNTIME_CONFIG"
SPEC="$(jq -nc \
  --arg exec "$EXEC_CMD" \
  --arg stdout "$LOG_PATH" \
  '{name:"v2-engine",kind:"service",exec:$exec,keepAlive:true,stdout:$stdout}')"

export FLYWHEEL_SUPERVISOR_BACKEND=launchd
export FLYWHEEL_SUPERVISOR_DARWIN_INSTALL=1
supervisor_install "$SPEC"
supervisor_is_loaded "v2-engine" "service" >/dev/null

for _ in $(seq 1 60); do
  if node "$CLIENT_CLI" health \
    --socket "$SOCKET_PATH" \
    --secret "$SECRET_PATH" >/dev/null 2>&1; then
    echo "v2 host installed and held/live health proof passed"
    exit 0
  fi
  sleep 1
done

echo "v2 host was loaded but authenticated health did not pass" >&2
exit 1

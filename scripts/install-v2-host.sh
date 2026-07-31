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
# FLY-1503 MEDIUM-1: let an operator prove a runtime config is acceptable BEFORE
# bouncing the host. Without this the only way to discover a rejected config was a
# launchd KeepAlive restart loop with the engine already down.
VALIDATE_ONLY=0
# FLY-1550: opt-in one-shot migration of a pre-FLY-1550 runtime config
# (drops the retired injection_root + launcher.claude_credentials keys).
MIGRATE_FLY1550=0

usage() {
  echo "usage: install-v2-host.sh --window <id> --epoch <n> --host-epoch <id> --runtime-config <abs> [--db <abs>] [--marker <abs>] [--authority <abs>] [--armed <abs>] [--socket <abs>] [--secret <abs>] [--session-proof-root <abs>] [--host-cli <abs>] [--client-cli <abs>] [--log <abs>] [--validate-only] [--migrate-fly1550]" >&2
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
    --validate-only) VALIDATE_ONLY=1; shift ;;
    --migrate-fly1550) MIGRATE_FLY1550=1; shift ;;
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
# FLY-1550: explicit, atomic migration for a pre-FLY-1550 runtime config.
# Write the migrated content to a private temp file first; every exact-key and
# real-parser gate below then validates the MIGRATED file before the host is
# ever bounced, and the original is only replaced when the rewrite itself
# succeeded. A config already in the new shape is a byte-identical no-op.
if [[ "$MIGRATE_FLY1550" == "1" ]]; then
  MIGRATED_TMP="$(mktemp "${RUNTIME_CONFIG}.fly1550.XXXXXX")"
  if ! jq 'del(.injection_root) | del(.launcher.claude_credentials)' "$RUNTIME_CONFIG" > "$MIGRATED_TMP"; then
    rm -f "$MIGRATED_TMP"
    echo "--migrate-fly1550: jq rewrite failed; runtime config left untouched" >&2
    exit 1
  fi
  chmod 600 "$MIGRATED_TMP"
  mv "$MIGRATED_TMP" "$RUNTIME_CONFIG"
fi

# FLY-1503 MEDIUM-1: the host validates the launcher section with an EXACT key set,
# so a config with a stray or missing key is rejected before the socket is even
# opened -- with launchd KeepAlive that means the engine is simply down. The
# installer must therefore reject exactly what the host rejects. Keep this key list
# in step with parseRuntimeConfig in packages/v2-host/src/cli.ts.
# FLY-1550: claude_credentials (and top-level injection_root) are GONE -- runners
# share the operator's ~/.claude; remove both keys from an existing config BEFORE
# restarting the host.
RUNTIME_LAUNCHER_KEYS="claude_bin client_cli codex_bin kind release_root state_root tmux_bin"
ACTUAL_LAUNCHER_KEYS="$(jq -r '.launcher | keys | join(" ")' "$RUNTIME_CONFIG" 2>/dev/null || echo "")"
if [[ "$ACTUAL_LAUNCHER_KEYS" != "$RUNTIME_LAUNCHER_KEYS" ]]; then
  echo "runtime launcher keys do not match what the host accepts" >&2
  echo "  expected: $RUNTIME_LAUNCHER_KEYS" >&2
  echo "  actual:   ${ACTUAL_LAUNCHER_KEYS:-<none>}" >&2
  echo "upgrading an existing install? remove launcher.claude_credentials and top-level injection_root (FLY-1550) BEFORE restarting the host" >&2
  exit 1
fi
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

# FLY-1550: no claude_credentials validation -- runners share the operator's
# ~/.claude (Keychain / shared credentials), exactly like a Lead.

# FLY-1503 MEDIUM-1: prove the REAL host parser accepts this config before anything
# is bounced. The installer's jq gate and the host's exact-key check can drift; this
# runs the host's own validation and nothing else.
if [[ -f "$HOST_CLI" ]]; then
  # Paths go through the environment, NOT argv: the module runs main() when
  # process.argv[1] equals its own path, so passing the cli path as an argument
  # would execute the host instead of just importing its parser.
  FLYWHEEL_V2_VALIDATE_HOST_CLI="$HOST_CLI" \
  FLYWHEEL_V2_VALIDATE_CONFIG="$RUNTIME_CONFIG" \
  node --input-type=module -e '
    const { readFileSync } = await import("node:fs");
    const { pathToFileURL } = await import("node:url");
    const mod = await import(
      pathToFileURL(process.env.FLYWHEEL_V2_VALIDATE_HOST_CLI).href
    );
    mod.parseRuntimeConfig(
      JSON.parse(readFileSync(process.env.FLYWHEEL_V2_VALIDATE_CONFIG, "utf8")),
    );
  ' || {
    echo "the host runtime-config parser rejected this config; fix it BEFORE restarting the host" >&2
    exit 1
  }
fi

if [[ "$VALIDATE_ONLY" -eq 1 ]]; then
  echo "runtime config validated: $RUNTIME_CONFIG"
  exit 0
fi

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

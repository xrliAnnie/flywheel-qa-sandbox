#!/bin/bash
# FLY-1663: launchd-native Claude Lead carrier.
# One launchd job owns one foreground tmux server and one body pane. There is
# deliberately no PID guard, lease, process-table preflight, adoption, rescue,
# restart loop, or pre-emptive socket destruction in this wrapper.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF_PATH="${SELF_DIR}/$(basename "${BASH_SOURCE[0]}")"

log() { printf '[wrapper-v2] %s %s\n' "$(date '+%H:%M:%S')" "$*"; }
fatal() { log "ERROR: $*" >&2; exit 1; }

# Publish runtime identity from inside the tmux server, after exec succeeded.
# Keeping this helper in the immutable wrapper avoids a second installed tool.
publish_runtime_fields() {
  local manifest="$1" socket_path="$2" server_pid="$3"
  local manifest_tmp="${manifest}.tmp.${server_pid}"
  [[ "$server_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [ -f "$manifest" ] || return 1
  umask 077
  if jq --arg socketPath "$socket_path" --argjson pid "$server_pid" \
      '. + {pid: $pid, socketPath: $socketPath}' "$manifest" > "$manifest_tmp" \
      && jq empty "$manifest_tmp" >/dev/null 2>&1 \
      && chmod 600 "$manifest_tmp" \
      && mv "$manifest_tmp" "$manifest"; then
    return 0
  fi
  rm -f "$manifest_tmp"
  return 1
}

if [ "${1:-}" = --publish-and-start ]; then
  [ "$#" -eq 6 ] || exit 64
  if publish_runtime_fields "$2" "$3" "$4"; then
    exec /bin/bash "$6" "$2"
  else
    publish_rc=$?
    printf '[wrapper-v2] ERROR: failed to publish tmux runtime identity (rc=%s)\n' "$publish_rc" >&2
    "$5" -S "$3" kill-server >/dev/null 2>&1 || true
    exit 1
  fi
fi

MANIFEST="${1:?Usage: flywheel-lead-wrapper-v2.sh <manifest-path>}"

if [ -f "$SELF_DIR/lib/host-config.sh" ]; then
  # shellcheck source=lib/host-config.sh
  source "$SELF_DIR/lib/host-config.sh"
  host_config_load >/dev/null || fatal "host.json invalid (fail-closed)"
fi

FLYWHEEL_DIR="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
FLYWHEEL_STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
ENV_FILE="${FLYWHEEL_WRAPPER_ENV_FILE:-${FLYWHEEL_STATE_DIR}/.env}"
PROJECTS_FILE="${FLYWHEEL_PROJECTS_FILE:-${FLYWHEEL_STATE_DIR}/projects.json}"
# launchd's default PATH omits Homebrew and user-local binaries. Expand the
# wrapper's own environment before resolving tmux, then pass that same proven
# search path through the env -i carrier boundary.
export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
ADDRESS_LIB="$SELF_DIR/lib/lead-address.sh"
[ -f "$ADDRESS_LIB" ] || fatal "Lead address helper missing: $ADDRESS_LIB"
# shellcheck source=lib/lead-address.sh
source "$ADDRESS_LIB"

command -v jq >/dev/null 2>&1 || fatal "jq is required"
[ -f "$MANIFEST" ] || fatal "Manifest not found: $MANIFEST"
[ -f "$PROJECTS_FILE" ] || fatal "projects.json not found: $PROJECTS_FILE"
[ -f "$ENV_FILE" ] || fatal "Environment file not found: $ENV_FILE"

# Load values for projection without exporting the file wholesale. The server
# starts below through env -i, so even explicitly-exported input is filtered.
_v2_allexport_was_on=false
[[ "$-" == *a* ]] && _v2_allexport_was_on=true
set +a
# shellcheck source=/dev/null
source "$ENV_FILE"
[ "$_v2_allexport_was_on" = false ] || set -a
unset _v2_allexport_was_on

LEAD_ID="$(jq -er '.leadId | select(type == "string" and length > 0)' "$MANIFEST")" \
  || fatal "Manifest has no valid leadId"
PROJECT_DIR="$(jq -er '.projectDir | select(type == "string" and length > 0)' "$MANIFEST")" \
  || fatal "Manifest has no valid projectDir"
PROJECT_NAME="$(jq -er '.projectName | select(type == "string" and length > 0)' "$MANIFEST")" \
  || fatal "Manifest has no valid projectName"
BOT_TOKEN_ENV="$(jq -r '.botTokenEnv // "DISCORD_BOT_TOKEN"' "$MANIFEST")"
[ -d "$PROJECT_DIR" ] || fatal "Project directory does not exist: $PROJECT_DIR"
[[ "$PROJECT_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
  || fatal "Invalid projectName: $PROJECT_NAME"
[[ "$LEAD_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
  || fatal "Invalid leadId: $LEAD_ID"

LEAD_ROW="$(jq -cer \
  --arg project "$PROJECT_NAME" --arg lead "$LEAD_ID" \
  '[.[] | select(.projectName == $project) | .leads[]? | select(.agentId == $lead)]
   | if length == 1 then .[0] else error("expected exactly one Lead row") end' \
  "$PROJECTS_FILE")" || fatal "Role lookup failed for ${PROJECT_NAME}/${LEAD_ID}"
BACKEND="$(jq -r '.backend // "claude-code"' <<<"$LEAD_ROW")"
[ "$BACKEND" = claude-code ] \
  || fatal "v2 carrier supports claude-code only (got $BACKEND)"
LAUNCH_ENVIRONMENT="$(jq -cer '
  (.launchEnvironment // {})
  | if type != "object" then error("launchEnvironment must be an object")
    elif all(to_entries[];
      (.key | test("^[A-Za-z_][A-Za-z0-9_]*$"))
      and (.value | type == "string")
      and ([.value | explode[] | select(. < 32 or . == 127)] | length == 0))
    then .
    else error("invalid launchEnvironment entry")
    end' "$MANIFEST")" || fatal "Manifest launchEnvironment is invalid"

ensure_lead_socket_dir "$FLYWHEEL_STATE_DIR" || fatal "Unsafe Lead socket directory"
LEAD_KEY="${PROJECT_NAME}-${LEAD_ID}"
SOCKET_KEY="${PROJECT_NAME}/${LEAD_ID}"
SOCKET_PATH="$(derive_lead_socket "$SOCKET_KEY" "$FLYWHEEL_STATE_DIR")" \
  || fatal "Unable to derive a safe socket path"

DRY_RUN="${FLYWHEEL_LEAD_V2_DRY_RUN:-0}"
TMUX_BIN="${FLYWHEEL_LEAD_V2_TMUX_BIN:-tmux}"
if [ "$DRY_RUN" != 1 ]; then
  if [[ "$TMUX_BIN" == */* ]]; then
    [ -x "$TMUX_BIN" ] || fatal "tmux binary is not executable: $TMUX_BIN"
  else
    resolved_tmux="$(command -v "$TMUX_BIN" 2>/dev/null)" \
      || fatal "tmux binary not found: $TMUX_BIN"
    TMUX_BIN="$resolved_tmux"
  fi

  socket_probe=""
  if socket_probe=$("$TMUX_BIN" -S "$SOCKET_PATH" has-session 2>&1); then
    fatal "private socket already has a live tmux server; refusing a second carrier body"
  else
    socket_probe_rc=$?
    [ "$socket_probe_rc" -eq 1 ] \
      || fatal "private socket occupancy probe failed (rc=$socket_probe_rc): $socket_probe"
  fi
fi

RUN_DIR="${FLYWHEEL_STATE_DIR}/run/leads/${LEAD_KEY}"
if [ -L "$RUN_DIR" ]; then fatal "Runtime directory must not be a symlink: $RUN_DIR"; fi
mkdir -p "$RUN_DIR"
chmod 700 "$RUN_DIR"
BODY_SCRIPT="${FLYWHEEL_DIR}/packages/teamlead/scripts/lead-body.sh"
if [ "${FLYWHEEL_LEAD_V2_TEST_MODE:-0}" = 1 ]; then
  BODY_SCRIPT="${FLYWHEEL_LEAD_V2_TEST_BODY_SCRIPT:?test body script required}"
fi
[ -f "$BODY_SCRIPT" ] || fatal "Lead body not found: $BODY_SCRIPT"

TMUX_CONF="${RUN_DIR}/tmux.conf"
TMUX_CONF_TMP="${TMUX_CONF}.tmp.$$"

# hook_pane is expanded by the hook event. run-shell must address the private
# socket explicitly because the server's global environment has no TMUX value.
if {
    # A Lead boot must not depend on the user's login shell or rc files. tmux
    # otherwise resolves default-shell from passwd and runs this command via
    # e.g. zsh -c, which puts ~/.zshenv (and arbitrary user tooling) on every
    # launchd/KeepAlive restart's critical path.
    printf 'set -g default-shell /bin/bash\n'
    printf 'set -g exit-empty on\n'
    printf 'set-hook -g pane-exited '\''run-shell "if [ #{hook_pane} = %%0 ]; then tmux -S %q kill-server; fi"'\''\n' "$SOCKET_PATH"
  } > "$TMUX_CONF_TMP" \
    && chmod 600 "$TMUX_CONF_TMP" \
    && mv "$TMUX_CONF_TMP" "$TMUX_CONF"; then
  :
else
  rm -f "$TMUX_CONF_TMP"
  fatal "Atomic tmux config update failed"
fi

SERVER_ENV=()
while IFS= read -r name; do
  SERVER_ENV+=("$name=$(jq -r --arg name "$name" '.[$name]' <<<"$LAUNCH_ENVIRONMENT")")
done < <(jq -r 'keys[]' <<<"$LAUNCH_ENVIRONMENT")
OS_USER="$(/usr/bin/id -un 2>/dev/null)" \
  || fatal "Unable to resolve the launchd job's OS user"
[ -n "$OS_USER" ] || fatal "Resolved OS user is empty"
SERVER_ENV+=(
  "HOME=$HOME"
  "USER=$OS_USER"
  "LOGNAME=$OS_USER"
  "PATH=$PATH"
  "TERM=${TERM:-xterm-256color}"
  "FLYWHEEL_DIR=$FLYWHEEL_DIR"
  "FLYWHEEL_STATE_DIR=$FLYWHEEL_STATE_DIR"
  "FLYWHEEL_PROJECTS_FILE=$PROJECTS_FILE"
  "FLYWHEEL_LEAD_ID=$LEAD_ID"
  "FLYWHEEL_LEAD_CARRIER=v2"
)
for name in TMPDIR LANG LC_ALL LC_CTYPE CLAUDE_CONFIG_DIR; do
  [ -z "${!name:-}" ] || SERVER_ENV+=("$name=${!name}")
done

# The server gets the Lead's own Discord credential, but no Bridge/OpenAI/MCP
# secrets. lead-body.sh reads .env locally and projects its second allowlist.
SERVER_ENV+=("DISCORD_BOT_TOKEN=${!BOT_TOKEN_ENV:-}")
if ! jq -e 'has("DISCORD_STATE_DIR")' <<<"$LAUNCH_ENVIRONMENT" >/dev/null; then
  SERVER_ENV+=("DISCORD_STATE_DIR=${HOME}/.claude/channels/discord-${LEAD_ID}")
fi

if [ "$DRY_RUN" = 1 ]; then
  publish_runtime_fields "$MANIFEST" "$SOCKET_PATH" "$$" \
    || fatal "Atomic manifest update failed"
  printf 'V2_SOCKET=%s\nV2_CONF=%s\n' "$SOCKET_PATH" "$TMUX_CONF"
  exit 0
fi

# tmux -D starts the server in the foreground but accepts no command. It also
# defers the commands in -f until the first client connects, so putting the
# body new-session in tmux.conf leaves an unattended launchd job permanently
# empty. A bounded one-shot client explicitly creates the body session after
# the foreground server owns the socket. -N is the critical fail-closed flag:
# an early retry may connect to an existing server, but may never daemonize a
# replacement server of its own.
printf -v BODY_COMMAND \
  'exec /bin/bash %q --publish-and-start %q %q %q %q %q' \
  "$SELF_PATH" "$MANIFEST" "$SOCKET_PATH" "$$" "$TMUX_BIN" "$BODY_SCRIPT"

bootstrap_main_session() {
  local server_pid="$1" attempts_remaining=100 bootstrap_error=""
  while [ "$attempts_remaining" -gt 0 ]; do
    if bootstrap_error=$(env -i "${SERVER_ENV[@]}" "$TMUX_BIN" -N -S "$SOCKET_PATH" \
        new-session -d -s main -n main -x 220 -y 50 "$BODY_COMMAND" 2>&1); then
      return 0
    fi
    kill -0 "$server_pid" 2>/dev/null || return 1
    attempts_remaining=$((attempts_remaining - 1))
    sleep 0.1
  done
  log "ERROR: foreground tmux server did not accept main session: $bootstrap_error" >&2
  kill "$server_pid" 2>/dev/null || true
  return 1
}

log "Starting ${PROJECT_NAME}/${LEAD_ID} as a private foreground tmux server"
bootstrap_main_session "$$" &
exec env -i "${SERVER_ENV[@]}" "$TMUX_BIN" -D -S "$SOCKET_PATH" -f "$TMUX_CONF"

#!/bin/bash
# FLY-1663: launchd-native Claude Lead carrier.
# One launchd job owns one foreground tmux server and one body pane. There is
# deliberately no PID guard, lease, process-table preflight, adoption, rescue,
# restart loop, or pre-emptive socket destruction in this wrapper.
set -euo pipefail

MANIFEST="${1:?Usage: flywheel-lead-wrapper-v2.sh <manifest-path>}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[wrapper-v2] %s %s\n' "$(date '+%H:%M:%S')" "$*"; }
fatal() { log "ERROR: $*" >&2; exit 1; }

if [ -f "$SELF_DIR/lib/host-config.sh" ]; then
  # shellcheck source=lib/host-config.sh
  source "$SELF_DIR/lib/host-config.sh"
  host_config_load >/dev/null || fatal "host.json invalid (fail-closed)"
fi

FLYWHEEL_DIR="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
FLYWHEEL_STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
ENV_FILE="${FLYWHEEL_WRAPPER_ENV_FILE:-${FLYWHEEL_STATE_DIR}/.env}"
PROJECTS_FILE="${FLYWHEEL_PROJECTS_FILE:-${FLYWHEEL_STATE_DIR}/projects.json}"
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

# Runtime fields are wrapper-owned. Preserve every static and future field.
manifest_tmp="${MANIFEST}.tmp.$$"
umask 077
jq --arg socketPath "$SOCKET_PATH" --argjson pid "$$" \
  '. + {pid: $pid, socketPath: $socketPath}' "$MANIFEST" > "$manifest_tmp" \
  && jq empty "$manifest_tmp" >/dev/null 2>&1 \
  && chmod 600 "$manifest_tmp" \
  && mv "$manifest_tmp" "$MANIFEST" \
  || { rm -f "$manifest_tmp"; fatal "Atomic manifest update failed"; }

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
{
  printf 'set -g exit-empty on\n'
  printf 'set-hook -g pane-exited '\''run-shell "if [ #{hook_pane} = %%0 ]; then tmux -S %q kill-server; fi"'\''\n' "$SOCKET_PATH"
  printf 'new-session -d -s main -n main -x 220 -y 50 "exec bash %q %q"\n' "$BODY_SCRIPT" "$MANIFEST"
} > "$TMUX_CONF_TMP" \
  && chmod 600 "$TMUX_CONF_TMP" \
  && mv "$TMUX_CONF_TMP" "$TMUX_CONF" \
  || { rm -f "$TMUX_CONF_TMP"; fatal "Atomic tmux config update failed"; }

SERVER_ENV=()
while IFS= read -r name; do
  SERVER_ENV+=("$name=$(jq -r --arg name "$name" '.[$name]' <<<"$LAUNCH_ENVIRONMENT")")
done < <(jq -r 'keys[]' <<<"$LAUNCH_ENVIRONMENT")
SERVER_ENV+=(
  "HOME=$HOME"
  "PATH=${HOME}/.local/bin:${HOME}/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
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
SERVER_ENV+=("DISCORD_STATE_DIR=${HOME}/.claude/channels/discord-${LEAD_ID}")

if [ "${FLYWHEEL_LEAD_V2_DRY_RUN:-0}" = 1 ]; then
  printf 'V2_SOCKET=%s\nV2_CONF=%s\n' "$SOCKET_PATH" "$TMUX_CONF"
  exit 0
fi

log "Starting ${PROJECT_NAME}/${LEAD_ID} as a private foreground tmux server"
exec env -i "${SERVER_ENV[@]}" tmux -D -S "$SOCKET_PATH" -f "$TMUX_CONF"

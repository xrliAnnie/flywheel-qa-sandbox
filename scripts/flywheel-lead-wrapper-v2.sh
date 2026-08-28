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

# Capture inherited identity before either .env or the manifest can shadow it.
# These values are comparison inputs only; the canonical registry resolution
# below is the only identity projected into the tmux server.
AMBIENT_LEAD_ID_SET="${LEAD_ID+x}"
AMBIENT_LEAD_ID="${LEAD_ID-}"
AMBIENT_FLYWHEEL_LEAD_ID_SET="${FLYWHEEL_LEAD_ID+x}"
AMBIENT_FLYWHEEL_LEAD_ID="${FLYWHEEL_LEAD_ID-}"
AMBIENT_PROJECT_NAME_SET="${PROJECT_NAME+x}"
AMBIENT_PROJECT_NAME="${PROJECT_NAME-}"
AMBIENT_FLYWHEEL_PROJECT_NAME_SET="${FLYWHEEL_PROJECT_NAME+x}"
AMBIENT_FLYWHEEL_PROJECT_NAME="${FLYWHEEL_PROJECT_NAME-}"
AMBIENT_DISCORD_STATE_DIR_SET="${DISCORD_STATE_DIR+x}"
AMBIENT_DISCORD_STATE_DIR="${DISCORD_STATE_DIR-}"

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
V2_SUMMARY_CONFIG_HOME="${FLYWHEEL_SUMMARY_CONFIG_HOME:-${HOME}}"
readonly V2_SUMMARY_CONFIG_HOME
case "$V2_SUMMARY_CONFIG_HOME" in
  /*) ;;
  *) fatal "FLYWHEEL_SUMMARY_CONFIG_HOME must be an absolute path" ;;
esac
[[ "$V2_SUMMARY_CONFIG_HOME" != *$'\n'* && "$V2_SUMMARY_CONFIG_HOME" != *$'\r'* ]] \
  || fatal "FLYWHEEL_SUMMARY_CONFIG_HOME contains a control character"
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

LOADED_LEAD_ID_SET="${LEAD_ID+x}"
LOADED_LEAD_ID="${LEAD_ID-}"
LOADED_FLYWHEEL_LEAD_ID_SET="${FLYWHEEL_LEAD_ID+x}"
LOADED_FLYWHEEL_LEAD_ID="${FLYWHEEL_LEAD_ID-}"
LOADED_PROJECT_NAME_SET="${PROJECT_NAME+x}"
LOADED_PROJECT_NAME="${PROJECT_NAME-}"
LOADED_FLYWHEEL_PROJECT_NAME_SET="${FLYWHEEL_PROJECT_NAME+x}"
LOADED_FLYWHEEL_PROJECT_NAME="${FLYWHEEL_PROJECT_NAME-}"
LOADED_DISCORD_STATE_DIR_SET="${DISCORD_STATE_DIR+x}"
LOADED_DISCORD_STATE_DIR="${DISCORD_STATE_DIR-}"

SELECTOR_LEAD_ID="$(jq -er '.leadId | select(type == "string" and length > 0)' "$MANIFEST")" \
  || fatal "Manifest has no valid leadId"
PROJECT_DIR="$(jq -er '.projectDir | select(type == "string" and length > 0)' "$MANIFEST")" \
  || fatal "Manifest has no valid projectDir"
SELECTOR_PROJECT_NAME="$(jq -er '.projectName | select(type == "string" and length > 0)' "$MANIFEST")" \
  || fatal "Manifest has no valid projectName"
PROJECTS_FILE="$(jq -er --arg fallback "$PROJECTS_FILE" \
  '.projectsFile // $fallback | select(type == "string" and length > 0)' "$MANIFEST")" \
  || fatal "Manifest has no valid projectsFile selector"
LEGACY_MANIFEST_BOT_TOKEN_ENV="$(jq -er '
  if has("botTokenEnv")
  then .botTokenEnv | select(type == "string" and length > 0)
  else ""
  end' "$MANIFEST")" \
  || fatal "identity_manifest_field_invalid: botTokenEnv"
LEGACY_MANIFEST_BACKEND="$(jq -er '
  if has("leadBackend")
  then .leadBackend
    | select(type == "object" and (keys == ["backendId"]))
    | .backendId | select(type == "string" and length > 0)
  else ""
  end' "$MANIFEST")" \
  || fatal "identity_manifest_field_invalid: leadBackend"
FORBIDDEN_MANIFEST_FIELDS="$(jq -r '
  ["botUserId", "discordStateDir", "identityDigest",
   "projectsDigest", "leadKey", "role", "backend", "summaryRole",
   "summaryGranularity", "hasSummaryDuty", "summaryAssignmentDigest"]
  | map(select(. as $key | $ARGS.named.manifest | has($key)))
  | join(",")' --argjson manifest "$(jq -c . "$MANIFEST")" <<< '{}')"
[ -z "$FORBIDDEN_MANIFEST_FIELDS" ] \
  || fatal "identity_manifest_field_forbidden: $FORBIDDEN_MANIFEST_FIELDS"
[ -f "$PROJECTS_FILE" ] || fatal "projects.json not found: $PROJECTS_FILE"
[ -d "$PROJECT_DIR" ] || fatal "Project directory does not exist: $PROJECT_DIR"
[[ "$SELECTOR_PROJECT_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
  || fatal "Invalid projectName: $SELECTOR_PROJECT_NAME"
[[ "$SELECTOR_LEAD_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
  || fatal "Invalid leadId: $SELECTOR_LEAD_ID"

IDENTITY_CLI="${FLYWHEEL_LEAD_IDENTITY_CLI:-${FLYWHEEL_DIR}/packages/flywheel-comm/dist/index.js}"
[ -f "$IDENTITY_CLI" ] || fatal "Canonical Lead identity CLI not found: $IDENTITY_CLI"

identity_fatal() {
  local code="$1"
  shift
  local message="$*"
  node "$IDENTITY_CLI" lead-identity record-failure \
    --projects-file "$PROJECTS_FILE" \
    --project "$SELECTOR_PROJECT_NAME" \
    --lead "$SELECTOR_LEAD_ID" \
    --code "$code" \
    --message "$message" >/dev/null 2>&1 || true
  fatal "${code}: ${message}"
}

IDENTITY_JSON="$(node "$IDENTITY_CLI" lead-identity resolve \
  --projects-file "$PROJECTS_FILE" \
  --project "$SELECTOR_PROJECT_NAME" \
  --lead "$SELECTOR_LEAD_ID" \
  --summary-config-home "$V2_SUMMARY_CONFIG_HOME" \
  --format json)" \
  || fatal "identity_source_error: canonical Lead identity resolution failed"
jq -e 'type == "object" and .schemaVersion == 1' <<<"$IDENTITY_JSON" >/dev/null \
  || fatal "identity_source_error: canonical Lead identity result is invalid"

LEAD_ID="$(jq -er '.leadId' <<<"$IDENTITY_JSON")"
PROJECT_NAME="$(jq -er '.projectName' <<<"$IDENTITY_JSON")"
LEAD_KEY="$(jq -er '.leadKey' <<<"$IDENTITY_JSON")"
LEAD_ROLE="$(jq -er '.role' <<<"$IDENTITY_JSON")"
SUMMARY_ROLE="$(jq -er '.summaryRole | select(. == "producer" or . == "aggregator" or . == "recipient" or . == "exempt")' <<<"$IDENTITY_JSON")" \
  || fatal "identity_summary_role_invalid: canonical summaryRole is invalid"
SUMMARY_GRANULARITY="$(jq -er '.summaryGranularity | select(. == "per-lead" or . == "per-project")' <<<"$IDENTITY_JSON")" \
  || fatal "identity_summary_granularity_invalid: canonical summaryGranularity is invalid"
HAS_SUMMARY_DUTY="$(jq -er '.hasSummaryDuty | if . == true then "1" elif . == false then "0" else error("hasSummaryDuty must be boolean") end' <<<"$IDENTITY_JSON")" \
  || fatal "identity_summary_duty_invalid: canonical hasSummaryDuty is invalid"
SUMMARY_ASSIGNMENT_DIGEST="$(jq -er '.summaryAssignmentDigest | select(test("^[a-f0-9]{64}$"))' <<<"$IDENTITY_JSON")" \
  || fatal "identity_summary_assignment_digest_invalid: canonical summaryAssignmentDigest is invalid"
BACKEND="$(jq -er '.backend' <<<"$IDENTITY_JSON")"
BOT_TOKEN_ENV="$(jq -er '.botTokenEnv | select(type == "string" and length > 0)' <<<"$IDENTITY_JSON")" \
  || fatal "identity_bot_token_env_missing: ${PROJECT_NAME}/${LEAD_ID} has no token selector"
BOT_USER_ID="$(jq -er '.botUserId | select(type == "string" and length > 0)' <<<"$IDENTITY_JSON")" \
  || fatal "identity_bot_user_id_missing: ${PROJECT_NAME}/${LEAD_ID} has no bot user id"
CANONICAL_DISCORD_STATE_DIR="$(jq -er '.discordStateDir' <<<"$IDENTITY_JSON")"
IDENTITY_DIGEST="$(jq -er '.identityDigest' <<<"$IDENTITY_JSON")"
PROJECTS_DIGEST="$(jq -er '.projectsDigest' <<<"$IDENTITY_JSON")"
[ -z "$LEGACY_MANIFEST_BOT_TOKEN_ENV" ] \
  || [ "$LEGACY_MANIFEST_BOT_TOKEN_ENV" = "$BOT_TOKEN_ENV" ] \
  || identity_fatal identity_manifest_field_conflict \
    "botTokenEnv expected '$BOT_TOKEN_ENV', got '$LEGACY_MANIFEST_BOT_TOKEN_ENV'"
[ -z "$LEGACY_MANIFEST_BACKEND" ] \
  || [ "$LEGACY_MANIFEST_BACKEND" = "$BACKEND" ] \
  || identity_fatal identity_manifest_field_conflict \
    "leadBackend.backendId expected '$BACKEND', got '$LEGACY_MANIFEST_BACKEND'"
[ "$BACKEND" = claude-code ] \
  || identity_fatal identity_backend_mismatch "v2 carrier supports claude-code only (got $BACKEND)"
BOT_TOKEN="${!BOT_TOKEN_ENV:-}"
[ -n "$BOT_TOKEN" ] \
  || identity_fatal identity_bot_token_missing "$BOT_TOKEN_ENV is unset or empty"

assert_identity_input() {
  local name="$1" was_set="$2" actual="$3" expected="$4"
  if [ "$was_set" = x ] && [ "$actual" != "$expected" ]; then
    identity_fatal identity_env_conflict "$name expected '$expected', got '$actual'"
  fi
}
assert_identity_input LEAD_ID "$AMBIENT_LEAD_ID_SET" "$AMBIENT_LEAD_ID" "$LEAD_ID"
assert_identity_input FLYWHEEL_LEAD_ID "$AMBIENT_FLYWHEEL_LEAD_ID_SET" "$AMBIENT_FLYWHEEL_LEAD_ID" "$LEAD_ID"
assert_identity_input PROJECT_NAME "$AMBIENT_PROJECT_NAME_SET" "$AMBIENT_PROJECT_NAME" "$PROJECT_NAME"
assert_identity_input FLYWHEEL_PROJECT_NAME "$AMBIENT_FLYWHEEL_PROJECT_NAME_SET" "$AMBIENT_FLYWHEEL_PROJECT_NAME" "$PROJECT_NAME"
assert_identity_input DISCORD_STATE_DIR "$AMBIENT_DISCORD_STATE_DIR_SET" "$AMBIENT_DISCORD_STATE_DIR" "$CANONICAL_DISCORD_STATE_DIR"
assert_identity_input LEAD_ID "$LOADED_LEAD_ID_SET" "$LOADED_LEAD_ID" "$LEAD_ID"
assert_identity_input FLYWHEEL_LEAD_ID "$LOADED_FLYWHEEL_LEAD_ID_SET" "$LOADED_FLYWHEEL_LEAD_ID" "$LEAD_ID"
assert_identity_input PROJECT_NAME "$LOADED_PROJECT_NAME_SET" "$LOADED_PROJECT_NAME" "$PROJECT_NAME"
assert_identity_input FLYWHEEL_PROJECT_NAME "$LOADED_FLYWHEEL_PROJECT_NAME_SET" "$LOADED_FLYWHEEL_PROJECT_NAME" "$PROJECT_NAME"
assert_identity_input DISCORD_STATE_DIR "$LOADED_DISCORD_STATE_DIR_SET" "$LOADED_DISCORD_STATE_DIR" "$CANONICAL_DISCORD_STATE_DIR"

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
  value="$(jq -r --arg name "$name" '.[$name]' <<<"$LAUNCH_ENVIRONMENT")"
  expected=""
  is_identity=true
  case "$name" in
    FLYWHEEL_LEAD_ID|LEAD_ID) expected="$LEAD_ID" ;;
    FLYWHEEL_PROJECT_NAME|PROJECT_NAME) expected="$PROJECT_NAME" ;;
    FLYWHEEL_LEAD_KEY) expected="$LEAD_KEY" ;;
    FLYWHEEL_LEAD_ROLE) expected="$LEAD_ROLE" ;;
    FLYWHEEL_LEAD_SUMMARY_ROLE) expected="$SUMMARY_ROLE" ;;
    FLYWHEEL_LEAD_HAS_SUMMARY_DUTY) expected="$HAS_SUMMARY_DUTY" ;;
    FLYWHEEL_SUMMARY_GRANULARITY) expected="$SUMMARY_GRANULARITY" ;;
    FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST) expected="$SUMMARY_ASSIGNMENT_DIGEST" ;;
    FLYWHEEL_LEAD_BACKEND) expected="$BACKEND" ;;
    DISCORD_STATE_DIR) expected="$CANONICAL_DISCORD_STATE_DIR" ;;
    DISCORD_EXPECTED_BOT_USER_ID) expected="$BOT_USER_ID" ;;
    FLYWHEEL_LEAD_IDENTITY_DIGEST) expected="$IDENTITY_DIGEST" ;;
    FLYWHEEL_LEAD_PROJECTS_DIGEST) expected="$PROJECTS_DIGEST" ;;
    FLYWHEEL_PROJECTS_FILE) expected="$PROJECTS_FILE" ;;
    FLYWHEEL_PROJECTS|FLYWHEEL_SUMMARY_CONFIG_HOME|DISCORD_BOT_TOKEN)
      identity_fatal identity_launch_env_conflict "$name may not be supplied by the manifest"
      ;;
    *) is_identity=false ;;
  esac
  if [ "$name" = "$BOT_TOKEN_ENV" ]; then
    identity_fatal identity_launch_env_conflict "$name may not be supplied by the manifest"
  fi
	# FLY-2076: this capability may cross the carrier only for the single Claw
	# duty seat. A stale manifest entry on any other Lead is ignored.
	if [ "$name" = "FLYWHEEL_ALERT_DUTY_TOKEN" ] \
	    && [ "$LEAD_ID" != "claude-infra-bot-lead" ]; then
		continue
	fi
  if [ "$is_identity" = true ]; then
    [ "$value" = "$expected" ] \
      || identity_fatal identity_launch_env_conflict "$name expected '$expected', got '$value'"
    continue
  fi
  SERVER_ENV+=("$name=$value")
done < <(jq -r 'keys[]' <<<"$LAUNCH_ENVIRONMENT")
OS_USER="$(/usr/bin/id -un 2>/dev/null)" \
  || fatal "Unable to resolve the launchd job's OS user"
[ -n "$OS_USER" ] || fatal "Resolved OS user is empty"
LEAD_CARRIER_PS_BIN="${FLYWHEEL_LEAD_V2_PS_BIN:-/bin/ps}"
CARRIER_START=""
CARRIER_PROBE_ERROR=""
if [ ! -x "$LEAD_CARRIER_PS_BIN" ]; then
  CARRIER_PROBE_ERROR="probe is not executable: $LEAD_CARRIER_PS_BIN"
elif ! CARRIER_START="$(LC_ALL=C "$LEAD_CARRIER_PS_BIN" -p "$$" -o lstart= 2>/dev/null \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"; then
  CARRIER_PROBE_ERROR="ps command failed"
elif [ -z "$CARRIER_START" ]; then
  CARRIER_PROBE_ERROR="start identity was empty"
elif [[ "$CARRIER_START" == *$'\t'* || "$CARRIER_START" == *$'\n'* ]]; then
  CARRIER_PROBE_ERROR="start identity was malformed"
fi
if [ -n "$CARRIER_PROBE_ERROR" ]; then
  log "WARNING: carrier identity probe unavailable ($CARRIER_PROBE_ERROR); body provenance will be reported as unknown"
  CARRIER_START=""
fi
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
  "LEAD_ID=$LEAD_ID"
  "FLYWHEEL_PROJECT_NAME=$PROJECT_NAME"
  "PROJECT_NAME=$PROJECT_NAME"
  "FLYWHEEL_LEAD_KEY=$LEAD_KEY"
  "FLYWHEEL_LEAD_ROLE=$LEAD_ROLE"
  "FLYWHEEL_LEAD_SUMMARY_ROLE=$SUMMARY_ROLE"
  "FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=$HAS_SUMMARY_DUTY"
  "FLYWHEEL_SUMMARY_GRANULARITY=$SUMMARY_GRANULARITY"
  "FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST=$SUMMARY_ASSIGNMENT_DIGEST"
  "FLYWHEEL_LEAD_BACKEND=$BACKEND"
  "DISCORD_STATE_DIR=$CANONICAL_DISCORD_STATE_DIR"
  "DISCORD_EXPECTED_BOT_USER_ID=$BOT_USER_ID"
  "DISCORD_IDENTITY_MODE=managed"
  "FLYWHEEL_LEAD_IDENTITY_DIGEST=$IDENTITY_DIGEST"
  "FLYWHEEL_LEAD_PROJECTS_DIGEST=$PROJECTS_DIGEST"
  "FLYWHEEL_LEAD_CARRIER=v2"
)
if [ -n "$CARRIER_START" ]; then
  SERVER_ENV+=(
    "FLYWHEEL_LEAD_CARRIER_PID=$$"
    "FLYWHEEL_LEAD_CARRIER_START=$CARRIER_START"
  )
fi
for name in TMPDIR LANG LC_ALL LC_CTYPE CLAUDE_CONFIG_DIR; do
  [ -z "${!name:-}" ] || SERVER_ENV+=("$name=${!name}")
done

# The server gets the Lead's own Discord credential, but no Bridge/OpenAI/MCP
# secrets. lead-body.sh reads .env locally and projects its second allowlist.
SERVER_ENV+=("DISCORD_BOT_TOKEN=$BOT_TOKEN")

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

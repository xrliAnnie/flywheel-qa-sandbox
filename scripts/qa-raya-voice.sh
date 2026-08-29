#!/usr/bin/env bash
# FLY-2126: thin Flywheel entrypoint for Raya's versioned voice-test scenario.
set -uo pipefail

CONTRACT_VERSION="raya-voice-529/v1"
HARNESS_ROOT="${HOME}/.flywheel/raya/code"
SUBJECT_ROOT=""
EMITTER_SLOT=1
VOICE_SLOT=2
FORWARD_ARGS=()

usage() {
  cat >&2 <<'EOF'
usage: scripts/qa-raya-voice.sh --subject-root <absolute-path> [options]
  --harness-root <absolute-path>  Raya checkout containing the harness
  --emitter-bot <slot>            TEST_BOT_TOKEN slot (default: 1)
  --voice-bot <slot>              distinct QA voice identity slot (default: 2)
  remaining options are passed to raya-voice-529.mjs
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --subject-root)
      [[ $# -ge 2 ]] || { usage; exit 64; }
      SUBJECT_ROOT="$2"
      shift 2
      ;;
    --harness-root)
      [[ $# -ge 2 ]] || { usage; exit 64; }
      HARNESS_ROOT="$2"
      shift 2
      ;;
    --emitter-bot)
      [[ $# -ge 2 ]] || { usage; exit 64; }
      EMITTER_SLOT="$2"
      shift 2
      ;;
    --voice-bot)
      [[ $# -ge 2 ]] || { usage; exit 64; }
      VOICE_SLOT="$2"
      shift 2
      ;;
    --contract-version|--contract-version=*|\
    --emitter-bot-env|--emitter-bot-env=*|\
    --emitter-bot-id|--emitter-bot-id=*|\
    --voice-bot-env|--voice-bot-env=*|\
    --voice-bot-id|--voice-bot-id=*)
      echo "ERROR: $1 is owned by the Flywheel wrapper" >&2
      exit 64
      ;;
    *)
      FORWARD_ARGS+=("$1")
      shift
      ;;
  esac
done

[[ -n "$SUBJECT_ROOT" && "$SUBJECT_ROOT" == /* ]] || { usage; exit 64; }
[[ "$HARNESS_ROOT" == /* ]] || { echo "ERROR: --harness-root must be absolute" >&2; exit 64; }
[[ "$EMITTER_SLOT" =~ ^[1-9][0-9]*$ && "$VOICE_SLOT" =~ ^[1-9][0-9]*$ ]] \
  || { echo "ERROR: bot slots must be positive integers" >&2; exit 64; }
[[ "$EMITTER_SLOT" != "$VOICE_SLOT" ]] \
  || { echo "ERROR: emitter and voice bot slots must be different" >&2; exit 64; }

ENV_FILE="${HOME}/.flywheel/.env"
SLOTS_FILE="${HOME}/.flywheel/test-slots.json"
HARNESS_CLI="${HARNESS_ROOT}/scripts/qa/raya-voice-529.mjs"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: ${ENV_FILE} missing" >&2; exit 78; }
[[ -f "$SLOTS_FILE" ]] || { echo "ERROR: ${SLOTS_FILE} missing" >&2; exit 78; }
[[ -f "$HARNESS_CLI" ]] || { echo "ERROR: Raya voice harness missing under ${HARNESS_ROOT}" >&2; exit 78; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required" >&2; exit 78; }

EMITTER_TOKEN_VAR="$(jq -er --argjson slot "$EMITTER_SLOT" \
  '.slots[] | select(.id == $slot) | .tokenEnvVar' "$SLOTS_FILE" 2>/dev/null || true)"
VOICE_TOKEN_VAR="$(jq -er --argjson slot "$VOICE_SLOT" \
  '.slots[] | select(.id == $slot) | .tokenEnvVar' "$SLOTS_FILE" 2>/dev/null || true)"
[[ "$EMITTER_TOKEN_VAR" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
  || { echo "ERROR: emitter slot has no valid tokenEnvVar" >&2; exit 78; }
[[ "$VOICE_TOKEN_VAR" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
  || { echo "ERROR: voice slot has no valid tokenEnvVar" >&2; exit 78; }

# Parse the operator-controlled shell env in a subshell. Only the two selected
# values cross back through command substitution; the harness never inherits
# the rest of ~/.flywheel/.env, and sourced assignments cannot clobber the
# wrapper's already-validated state.
read_env_value() {
  local variable_name="$1"
  (
    set +u
    set +a
    # shellcheck disable=SC1090
    source "$ENV_FILE" >/dev/null
    printf '%s' "${!variable_name:-}"
  )
}

EMITTER_TOKEN="$(read_env_value "$EMITTER_TOKEN_VAR")"
VOICE_TOKEN="$(read_env_value "$VOICE_TOKEN_VAR")"
[[ -n "$EMITTER_TOKEN" ]] \
  || { echo "ERROR: ${EMITTER_TOKEN_VAR} is missing" >&2; exit 78; }
[[ -n "$VOICE_TOKEN" ]] \
  || { echo "ERROR: ${VOICE_TOKEN_VAR} is missing" >&2; exit 78; }

EMITTER_ID="$(jq -er --argjson slot "$EMITTER_SLOT" '.slots[] | select(.id == $slot) | .botAppId' "$SLOTS_FILE" 2>/dev/null || true)"
VOICE_ID="$(jq -er --argjson slot "$VOICE_SLOT" '.slots[] | select(.id == $slot) | .botAppId' "$SLOTS_FILE" 2>/dev/null || true)"
[[ "$EMITTER_ID" =~ ^[0-9]{17,20}$ ]] \
  || { echo "ERROR: emitter slot has no valid bot id" >&2; exit 78; }
[[ "$VOICE_ID" =~ ^[0-9]{17,20}$ ]] \
  || { echo "ERROR: voice slot has no valid bot id" >&2; exit 78; }
[[ "$EMITTER_ID" != "$VOICE_ID" ]] \
  || { echo "ERROR: emitter and voice slots resolve to the same bot id" >&2; exit 64; }

HANDSHAKE="$(node "$HARNESS_CLI" --contract-version 2>/dev/null)" || {
  echo "ERROR: Raya harness contract handshake failed" >&2
  exit 78
}
[[ "$HANDSHAKE" == "$CONTRACT_VERSION" ]] || {
  echo "ERROR: Raya harness contract mismatch" >&2
  exit 78
}

EMITTER_ENV=""
VOICE_ENV=""
HARNESS_PID=""
cleanup_credentials() {
  [[ -z "$EMITTER_ENV" ]] || rm -f "$EMITTER_ENV"
  [[ -z "$VOICE_ENV" ]] || rm -f "$VOICE_ENV"
}
forward_signal() {
  local signal="$1"
  local code="$2"
  trap - INT TERM HUP
  if [[ -n "$HARNESS_PID" ]]; then
    kill -"$signal" "$HARNESS_PID" 2>/dev/null || true
    wait "$HARNESS_PID" 2>/dev/null || true
  fi
  cleanup_credentials
  exit "$code"
}
trap cleanup_credentials EXIT
trap 'forward_signal INT 130' INT
trap 'forward_signal TERM 143' TERM
trap 'forward_signal HUP 129' HUP

EMITTER_ENV="$(mktemp "${TMPDIR:-/tmp}/raya-voice-emitter.XXXXXX")" \
  || { echo "ERROR: could not allocate emitter credential" >&2; exit 78; }
VOICE_ENV="$(mktemp "${TMPDIR:-/tmp}/raya-voice-subject.XXXXXX")" \
  || { echo "ERROR: could not allocate voice credential" >&2; exit 78; }
chmod 600 "$EMITTER_ENV" "$VOICE_ENV"
printf 'DISCORD_BOT_TOKEN=%s\n' "$EMITTER_TOKEN" > "$EMITTER_ENV"
printf 'DISCORD_BOT_TOKEN=%s\n' "$VOICE_TOKEN" > "$VOICE_ENV"

HARNESS_ARGS=(
  --subject-root "$SUBJECT_ROOT" \
  --emitter-bot-env "$EMITTER_ENV" \
  --emitter-bot-id "$EMITTER_ID" \
  --voice-bot-env "$VOICE_ENV" \
  --voice-bot-id "$VOICE_ID"
)
if [[ "${#FORWARD_ARGS[@]}" -gt 0 ]]; then
  HARNESS_ARGS+=("${FORWARD_ARGS[@]}")
fi
node "$HARNESS_CLI" "${HARNESS_ARGS[@]}" &
HARNESS_PID=$!
wait "$HARNESS_PID"
RC=$?
HARNESS_PID=""
cleanup_credentials
trap - EXIT INT TERM HUP
exit "$RC"

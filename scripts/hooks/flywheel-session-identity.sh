#!/bin/bash
# FLY-2808: fail-closed Claude resume identity and first-turn gate.
set -euo pipefail

deny() {
  printf 'FLYWHEEL_RESUME_IDENTITY_DENIED %s\n' "$1" >&2
  exit 2
}

manifest="${FLYWHEEL_RESUME_IDENTITY_MANIFEST:-}"
[[ -n "$manifest" && -r "$manifest" ]] || deny "manifest_unavailable"
command -v jq >/dev/null 2>&1 || deny "jq_unavailable"

input="$(cat)"
event="$(jq -r '.hook_event_name // empty' <<<"$input")"
ack_path="$(jq -r '.ackPath // empty' "$manifest")"
launch_token="$(jq -r '.launchToken // empty' "$manifest")"
generation="$(jq -r '.generation // empty' "$manifest")"
expected_session="$(jq -r '.expectedSessionId // empty' "$manifest")"
expected_model="$(jq -r '.expectedModel // empty' "$manifest")"
expected_cwd="$(jq -r '.expectedCwd // empty' "$manifest")"

[[ -n "$ack_path" && -n "$launch_token" && -n "$generation" ]] || deny "manifest_invalid"

ack_matches() {
  [[ -r "$ack_path" ]] && jq -e \
    --arg token "$launch_token" \
    --arg generation "$generation" \
    --arg session "$expected_session" \
    '.launchToken == $token and (.generation | tostring) == $generation and .sessionId == $session' \
    "$ack_path" >/dev/null 2>&1
}

case "$event" in
  SessionStart)
    actual_session="$(jq -r '.session_id // empty' <<<"$input")"
    actual_model="$(jq -r '.model // empty' <<<"$input")"
    actual_cwd="$(jq -r '.cwd // empty' <<<"$input")"
    source="$(jq -r '.source // empty' <<<"$input")"
    [[ "$source" == "resume" ]] || deny "source_mismatch"
    [[ "$actual_session" == "$expected_session" ]] || deny "session_mismatch"
    if [[ -z "$actual_model" ]]; then
      transcript_path="$(jq -r '.transcript_path // empty' <<<"$input")"
      [[ -n "$transcript_path" && -f "$transcript_path" && -r "$transcript_path" ]] \
        || deny "model_evidence_unavailable"
      [[ "$(basename "$transcript_path")" == "${actual_session}.jsonl" ]] \
        || deny "transcript_session_mismatch"
      if ! actual_model="$(jq -r 'select(.type == "assistant") | .message.model // empty' "$transcript_path" 2>/dev/null | tail -n 1)"; then
        deny "transcript_model_invalid"
      fi
      [[ -n "$actual_model" ]] || deny "model_evidence_unavailable"
    fi
    [[ "$actual_model" == "$expected_model" ]] || deny "model_mismatch"
    [[ -d "$actual_cwd" ]] || deny "cwd_unavailable"
    actual_cwd="$(cd "$actual_cwd" && pwd -P)"
    [[ "$actual_cwd" == "$expected_cwd" ]] || deny "cwd_mismatch"
    [[ -n "${FLYWHEEL_CALLBACK_PORT:-}" && -n "${FLYWHEEL_CALLBACK_TOKEN:-}" ]] || deny "callback_unavailable"
    command -v curl >/dev/null 2>&1 || deny "curl_unavailable"
    # HookCallbackServer only accepts POST; --get only moves the fields into
    # the query string the server reads.
    curl --fail --silent --show-error --max-time 10 --get --request POST \
      --data-urlencode "token=${FLYWHEEL_CALLBACK_TOKEN}" \
      --data-urlencode "sessionId=${actual_session}" \
      --data-urlencode "issueId=${FLYWHEEL_ISSUE_ID:-unknown}" \
      --data-urlencode "eventType=SessionStart" \
      --data-urlencode "model=${actual_model}" \
      --data-urlencode "cwd=${actual_cwd}" \
      --data-urlencode "source=${source}" \
      "http://127.0.0.1:${FLYWHEEL_CALLBACK_PORT}/hook/complete" >/dev/null \
      || deny "callback_failed"
    for _ in $(seq 1 1800); do
      ack_matches && exit 0
      sleep 0.1
    done
    deny "durable_verification_timeout"
    ;;
  UserPromptSubmit|PreToolUse)
    ack_matches || deny "durable_verification_missing"
    ;;
  *)
    deny "unexpected_event"
    ;;
esac

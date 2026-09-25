#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
HOOK="$ROOT/scripts/hooks/flywheel-session-identity.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/worktree"
EXPECTED_CWD="$(cd "$TMP/worktree" && pwd -P)"
MANIFEST="$TMP/manifest.json"
ACK="$TMP/identity.verified"
CURL_LOG="$TMP/curl.log"
TOKEN="a1b2c3d4-e5f6-7890-abcd-ef1234567890"
TRANSCRIPT="$TMP/session-1.jsonl"

printf '%s\n' '{"type":"assistant","message":{"model":"claude-fable-5-1"}}' >"$TRANSCRIPT"

jq -n \
  --arg ack "$ACK" \
  --arg token "$TOKEN" \
  --arg cwd "$EXPECTED_CWD" \
  '{schemaVersion:1,generation:2,launchToken:$token,expectedSessionId:"session-1",expectedModel:"claude-fable-5-1",expectedCwd:$cwd,ackPath:$ack}' \
  >"$MANIFEST"

curl() {
  printf '%s\n' "$*" >"$CURL_LOG"
  return 0
}
export -f curl
export CURL_LOG
export FLYWHEEL_RESUME_IDENTITY_MANIFEST="$MANIFEST"
export FLYWHEEL_CALLBACK_PORT=9876
export FLYWHEEL_CALLBACK_TOKEN="$TOKEN"
export FLYWHEEL_ISSUE_ID=FLY-2808

(
  sleep 0.1
  jq -n \
    --arg token "$TOKEN" \
    '{schemaVersion:1,generation:2,launchToken:$token,sessionId:"session-1"}' \
    >"$ACK"
) &
session_start="$(jq -n --arg cwd "$EXPECTED_CWD" --arg transcript "$TRANSCRIPT" '{hook_event_name:"SessionStart",session_id:"session-1",transcript_path:$transcript,cwd:$cwd,source:"resume"}')"
printf '%s\n' "$session_start" | "$HOOK"
grep -q 'eventType=SessionStart' "$CURL_LOG"
grep -q 'model=claude-fable-5-1' "$CURL_LOG"
# The real server rejects GET with 405 (see HookCallbackServer
# session-identity-hook vitest); the request must stay a POST.
grep -q -- '--request POST' "$CURL_LOG"

rm -f "$ACK" "$CURL_LOG"
wrong_session="$(jq -n --arg cwd "$EXPECTED_CWD" --arg transcript "$TRANSCRIPT" '{hook_event_name:"SessionStart",session_id:"wrong-session",transcript_path:$transcript,cwd:$cwd,source:"resume"}')"
set +e
printf '%s\n' "$wrong_session" | "$HOOK" >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 2 ]]
[[ ! -e "$CURL_LOG" ]]

printf '%s\n' '{"type":"assistant","message":{"model":"claude-opus-5"}}' >"$TRANSCRIPT"
set +e
printf '%s\n' "$session_start" | "$HOOK" >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 2 ]]
[[ ! -e "$CURL_LOG" ]]
printf '%s\n' '{"type":"assistant","message":{"model":"claude-fable-5-1"}}' >"$TRANSCRIPT"

missing_transcript="$(jq -n --arg cwd "$EXPECTED_CWD" --arg transcript "$TMP/missing.jsonl" '{hook_event_name:"SessionStart",session_id:"session-1",transcript_path:$transcript,cwd:$cwd,source:"resume"}')"
set +e
printf '%s\n' "$missing_transcript" | "$HOOK" >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 2 ]]
[[ ! -e "$CURL_LOG" ]]

set +e
printf '%s\n' '{"hook_event_name":"PreToolUse"}' | "$HOOK" >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 2 ]]

jq -n \
  --arg token "$TOKEN" \
  '{schemaVersion:1,generation:2,launchToken:$token,sessionId:"session-1"}' \
  >"$ACK"
printf '%s\n' '{"hook_event_name":"UserPromptSubmit"}' | "$HOOK"
printf '%s\n' '{"hook_event_name":"PreToolUse"}' | "$HOOK"

echo "flywheel-session-identity hook tests passed"

#!/bin/bash
# FLY-1563 e2e stub lead — a REAL tmux pane process registered as the lead
# (register-lead with THIS pane's pid). It blocks on stdin exactly like the
# production lead TUI: the ONLY thing that moves it is the engine doorbell
# locating this pane by the registered pid and pasting the bell. On wake it
# drains its mailbox with its delivery credential, answers the runner_ask
# (enqueue ask_response FIRST, then settle — the leadSettlement contract),
# and read-settles every FYI. No polling loop exists in this script.
set -u

DIR="${FLY1563_E2E_DIR:?}"
LOG="${DIR}/logs/lead.log"
STATE="${DIR}/state"
CRED="${FLY1563_E2E_LEAD_CRED:?}"
LEAD_ID="${FLY1563_E2E_LEAD_ID:?}"
mkdir -p "${DIR}/logs" "${STATE}"

ts() { node -e 'console.log(new Date().toISOString())'; }
log() { printf '%s %s\n' "$(ts)" "$*" >> "$LOG"; }

vcli() {
  node "$FLYWHEEL_V2_CLIENT_CLI" "$@" \
    --socket "$FLYWHEEL_V2_SOCKET" --secret "$FLYWHEEL_V2_SECRET_PATH"
}

log "BOOT lead=$LEAD_ID pid=$$"

drain() {
  while :; do
    local envelope="${STATE}/lead-envelope.json"
    if ! vcli next --agent "$LEAD_ID" --delivery-credential-file "$CRED" \
        > "$envelope" 2>>"$LOG"; then
      log "NEXT_EMPTY"
      return 0
    fi
    local kind agent attempt message cap tok
    kind=$(jq -r '.message.kind' "$envelope")
    agent=$(jq -r '.handle.agent.agentId' "$envelope")
    attempt=$(jq -r '.handle.attemptUid' "$envelope")
    message=$(jq -r '.handle.messageUid' "$envelope")
    cap=$(jq -r '.authorization.capabilityId' "$envelope")
    tok=$(jq -r '.authorization.token' "$envelope")
    log "RECEIVED kind=$kind message=$message"
    if [ "$kind" = "runner_ask" ]; then
      local ask_kind uid session_ref
      ask_kind=$(jq -r '.message.payload | fromjson | .ask_kind' "$envelope")
      uid=$(jq -r '.message.payload | fromjson | .uid' "$envelope")
      session_ref=$(jq -r '.message.payload | fromjson | .session_ref' "$envelope")
      if [ "$ask_kind" = "ask" ]; then
        # Answer FIRST, settle after — an unanswered ask must stay pending.
        if vcli enqueue --source-kind mailbox_reply --source-id "reply:$uid" \
            --payload "{\"v\":1,\"uid\":\"$uid\",\"body\":\"bind port 4747\"}" \
            --to-agent "$session_ref" --kind ask_response \
            --retention business >>"$LOG" 2>&1; then
          log "REPLY_ENQUEUED uid=$uid to=$session_ref"
        else
          log "FATAL reply enqueue failed uid=$uid"
        fi
      fi
    fi
    vcli ack --agent "$agent" --attempt "$attempt" --message "$message" \
      --capability-id "$cap" --token "$tok" >>"$LOG" 2>&1
    log "SETTLED kind=$kind message=$message"
  done
}

while IFS= read -r line; do
  case "$line" in
    *"mailbox bell"*)
      log "BELL_SEEN"
      drain
      ;;
  esac
done
log "STDIN_CLOSED"
sleep 3600

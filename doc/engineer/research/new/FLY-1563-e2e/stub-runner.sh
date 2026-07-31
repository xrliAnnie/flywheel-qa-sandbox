#!/bin/bash
# FLY-1563 e2e stub runner — stands in for the vendor LLM process inside the
# REAL launcher-spawned tmux pane. Everything around it is real: the tmux
# session the launcher created, the engine doorbell paste that wakes it, and
# the v2 CLI it uses to ask / pull / settle against the harness host.
#
# Wake contract under test: the process BLOCKS on stdin (like a TUI) — on the
# WAKE PATH the only thing that ever moves it is the doorbell paste + Enter
# landing in the pane; it never polls its mailbox. (The marker wait below is
# test choreography — sequencing the scenario — not part of the wake path.)
set -u

PROMPT="${!#}"
VENDOR="${FLYWHEEL_V2_VENDOR:?}"
DIR="${FLY1563_E2E_DIR:?}"
LOG="${DIR}/logs/runner-${VENDOR}.log"
STATE="${DIR}/state"
mkdir -p "${DIR}/logs" "${STATE}"

ts() { node -e 'console.log(new Date().toISOString())'; }
log() { printf '%s %s\n' "$(ts)" "$*" >> "$LOG"; }

vcli() {
  node "$FLYWHEEL_V2_CLIENT_CLI" "$@" \
    --socket "$FLYWHEEL_V2_SOCKET" --secret "$FLYWHEEL_V2_SECRET_PATH"
}

log "BOOT session=$FLYWHEEL_V2_SESSION_REF vendor=$VENDOR pid=$$"

ASSIGNMENT="${STATE}/assignment-${VENDOR}.json"
printf '%s' "$PROMPT" | sed -n '/^FIRST ENVELOPE:$/,$p' | tail -n +2 > "$ASSIGNMENT"
if ! jq -e '.handle.attemptUid' "$ASSIGNMENT" >/dev/null 2>&1; then
  log "FATAL assignment envelope missing from spawn prompt"
  exec sleep 3600
fi
log "ASSIGNMENT_HELD attempt=$(jq -r '.handle.attemptUid' "$ASSIGNMENT") (deliberately NOT settled — mid-task shape)"

if [ "$VENDOR" = "claude" ]; then
  # Test choreography (not a wake path): hold the ask until the harness has
  # SEEN the lead drain to empty and fall back asleep on its pane stdin — so
  # step 2 proves the ask ALONE wakes an idle lead, not a leftover drain.
  while [ ! -f "${STATE}/lead-idle.marker" ]; do sleep 1; done
  log "LEAD_IDLE_OBSERVED — sending the ask now"
  if vcli ask --session "$FLYWHEEL_V2_SESSION_REF" --ask-kind ask \
      --payload "e2e: which port should the QA fixture bind?" \
      > "${STATE}/ask-result.json" 2>>"$LOG"; then
    log "ASK_SENT uid=$(jq -r '.uid' "${STATE}/ask-result.json")"
  else
    log "FATAL ask failed"
    exec sleep 3600
  fi
fi

drain() {
  while :; do
    local envelope="${STATE}/runner-${VENDOR}-envelope.json"
    if ! vcli next --session "$FLYWHEEL_V2_SESSION_REF" > "$envelope" 2>>"$LOG"; then
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
    log "RECEIVED kind=$kind message=$message payload=$(jq -c '.message.payload' "$envelope")"
    vcli ack --agent "$agent" --attempt "$attempt" --message "$message" \
      --capability-id "$cap" --token "$tok" >>"$LOG" 2>&1
    log "SETTLED kind=$kind message=$message"
    if [ "$kind" = "ask_response" ]; then
      log "REPLY_RECEIVED"
      finish_assignment
    fi
    if [ "$kind" = "instruction" ] && [ "$VENDOR" = "codex" ]; then
      log "CODEX_WAKE_COMPLETE"
    fi
  done
}

finish_assignment() {
  local effects="${STATE}/effects-${VENDOR}.json"
  printf '[{"kind":"event","eventKind":"e2e_runner_done","payload":"{\\"v\\":1,\\"vendor\\":\\"%s\\"}"}]\n' "$VENDOR" > "$effects"
  if vcli submit \
      --agent "$(jq -r '.handle.agent.agentId' "$ASSIGNMENT")" \
      --attempt "$(jq -r '.handle.attemptUid' "$ASSIGNMENT")" \
      --message "$(jq -r '.handle.messageUid' "$ASSIGNMENT")" \
      --capability-id "$(jq -r '.authorization.capabilityId' "$ASSIGNMENT")" \
      --token "$(jq -r '.authorization.token' "$ASSIGNMENT")" \
      --effects-file "$effects" >>"$LOG" 2>&1; then
    log "ASSIGNMENT_SETTLED"
  else
    log "FATAL assignment settle failed"
  fi
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

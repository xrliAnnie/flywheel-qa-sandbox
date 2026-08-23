#!/usr/bin/env bash
# FLY-1981: approve an exact legacy QA execution through the existing Bridge
# founder action. The request carries no Lead identity; Bridge writes the
# founder-attributed response, advances the legacy FSM, and wakes the Runner.
#
# Usage:
#   scripts/test-auto-approve.sh <slot> <execution-id> [--timeout 60] [--poll-interval 2]
#
# Exit codes:
#   0 — exact Bridge response + approved_to_ship reconciled durably
#   2 — Bridge /health unreachable
#   3 — timeout waiting for an answerable, fully-bound awaiting_review session
#   4 — approve endpoint failed without durable success, or durable proof invalid
#   5 — usage / argument error
set -euo pipefail

usage() {
  echo "Usage: $0 <slot> <execution-id> [--timeout SECONDS] [--poll-interval SECONDS]" >&2
  exit 5
}

[[ $# -lt 2 ]] && usage
SLOT="$1"
EXECUTION_ID="$2"
shift 2

if ! [[ "$SLOT" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: invalid slot '${SLOT}' — must be a positive integer" >&2
  exit 5
fi
[[ -n "$EXECUTION_ID" ]] || usage

TIMEOUT=60
POLL=2
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) TIMEOUT="${2:?--timeout requires a value}"; shift 2 ;;
    --poll-interval) POLL="${2:?--poll-interval requires a value}"; shift 2 ;;
    *) echo "ERROR: unknown arg '$1'" >&2; usage ;;
  esac
done

if ! [[ "$TIMEOUT" =~ ^[0-9]+$ ]] || (( TIMEOUT <= 0 )); then
  echo "ERROR: --timeout must be a positive integer (got '$TIMEOUT')" >&2
  exit 5
fi
if ! [[ "$POLL" =~ ^[0-9]+$ ]] || (( POLL <= 0 )); then
  echo "ERROR: --poll-interval must be a positive integer (got '$POLL')" >&2
  exit 5
fi

SLOTS_FILE="${HOME}/.flywheel/test-slots.json"
[[ -f "$SLOTS_FILE" ]] || { echo "ERROR: $SLOTS_FILE missing" >&2; exit 5; }

SLOT_IDX=$((SLOT - 1))
PORT=$(jq -r ".slots[${SLOT_IDX}].bridgePort // empty" "$SLOTS_FILE")
[[ -n "$PORT" ]] || {
  echo "ERROR: slot $SLOT not present in $SLOTS_FILE (need .bridgePort)" >&2
  exit 5
}

API="http://localhost:${PORT}"
PROJECT_NAME="test-slot-${SLOT}"
SLOT_ROOT="${TEST_AUTO_APPROVE_SLOT_ROOT:-/tmp}"
if [[ "$SLOT_ROOT" != /* ]]; then
  echo "ERROR: TEST_AUTO_APPROVE_SLOT_ROOT must be an absolute path" >&2
  exit 5
fi
SLOT_DIR="${SLOT_ROOT%/}/flywheel-test-slot-${SLOT}"
STATE_DB="${SLOT_DIR}/teamlead.db"
COMM_DB="${HOME}/.flywheel/comm/${PROJECT_NAME}/comm.db"
API_TOKEN_PATH="${SLOT_DIR}/state/api-token"
SQL_EXECUTION_ID=${EXECUTION_ID//\'/\'\'}

log() { echo "[test-auto-approve] $(date +%H:%M:%S) $*" >&2; }

[[ -f "$STATE_DB" ]] || { log "ERROR: StateStore missing at ${STATE_DB}"; exit 4; }
[[ -f "$COMM_DB" ]] || { log "ERROR: CommDB missing at ${COMM_DB}"; exit 4; }

if ! curl -fsS --max-time 5 "${API}/health" >/dev/null 2>&1; then
  log "Bridge unreachable at ${API}/health — is slot ${SLOT} deployed?"
  exit 2
fi

# Read only the exact execution row. A legacy approval is safe to submit only
# after complete --route needs_review persisted both the exact question and
# the reviewed head. `unbound` is an explicit refusal sentinel.
DEADLINE=$(( $(date +%s) + TIMEOUT ))
QUESTION_ID=""
PR_HEAD=""
while [[ $(date +%s) -lt $DEADLINE ]]; do
  STATE_ROW=$(sqlite3 -batch -cmd ".timeout 2000" -separator '|' "$STATE_DB" "
    SELECT status, COALESCE(review_question_id, ''), COALESCE(pr_head_sha, '')
      FROM sessions
     WHERE execution_id = '${SQL_EXECUTION_ID}'
     LIMIT 1;
  " 2>/dev/null || true)
  IFS='|' read -r STATUS QUESTION_ID PR_HEAD <<<"$STATE_ROW"

  if [[ "$STATUS" == "awaiting_review" \
        && -n "$QUESTION_ID" \
        && "$QUESTION_ID" != "unbound" \
        && "$PR_HEAD" =~ ^[0-9a-fA-F]{40}$ ]]; then
    SQL_QUESTION_ID=${QUESTION_ID//\'/\'\'}
    OPEN_GATE=$(sqlite3 -batch -cmd ".timeout 2000" -separator '|' "$COMM_DB" "
      SELECT q.id, q.from_agent, q.checkpoint
        FROM mailbox_message_projection q
       WHERE q.id = '${SQL_QUESTION_ID}'
         AND q.from_agent = '${SQL_EXECUTION_ID}'
         AND q.type = 'question'
         AND q.checkpoint = 'approve_to_ship'
         AND q.resolved_at IS NULL
         AND q.superseded_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM mailbox_message_projection response
            WHERE response.parent_id = q.id AND response.type = 'response'
         )
       LIMIT 1;
    " 2>/dev/null || true)
    if [[ "$OPEN_GATE" == "${QUESTION_ID}|${EXECUTION_ID}|approve_to_ship" ]]; then
      log "answerable review bound (question_id=${QUESTION_ID}, head=${PR_HEAD}); submitting founder action"
      break
    fi
  fi

  QUESTION_ID=""
  PR_HEAD=""
  sleep "$POLL"
done

if [[ -z "$QUESTION_ID" || -z "$PR_HEAD" ]]; then
  log "timeout after ${TIMEOUT}s waiting for exact awaiting_review + question/head binding for execution_id=${EXECUTION_ID}"
  exit 3
fi

reconcile_durable_approval() {
  local state_row status bound_question bound_head response_row
  state_row=$(sqlite3 -batch -cmd ".timeout 2000" -separator '|' "$STATE_DB" "
    SELECT status, COALESCE(review_question_id, ''), COALESCE(pr_head_sha, '')
      FROM sessions
     WHERE execution_id = '${SQL_EXECUTION_ID}'
     LIMIT 1;
  " 2>/dev/null || true)
  IFS='|' read -r status bound_question bound_head <<<"$state_row"
  response_row=$(sqlite3 -batch -cmd ".timeout 2000" -separator '|' "$COMM_DB" "
    SELECT r.from_agent, r.content
      FROM mailbox_message_projection r
     WHERE r.parent_id = '${SQL_QUESTION_ID}'
       AND r.type = 'response'
     ORDER BY r.created_at DESC
     LIMIT 1;
  " 2>/dev/null || true)
  [[ "$status" == "approved_to_ship" \
     && "$bound_question" == "$QUESTION_ID" \
     && "$bound_head" == "$PR_HEAD" \
     && "$response_row" == 'bridge|{"approved":true}' ]]
}

REQUEST_BODY=$(jq -cn --arg execution_id "$EXECUTION_ID" '{execution_id:$execution_id}')
HTTP_BODY=$(mktemp "${TMPDIR:-/tmp}/fly1981-approve-response.XXXXXX")
cleanup_http_body() { rm -f "$HTTP_BODY"; }
trap cleanup_http_body EXIT

CURL_ARGS=(
  --silent --show-error --max-time 15
  --request POST
  --header "Content-Type: application/json"
  --data-binary "$REQUEST_BODY"
  --output "$HTTP_BODY"
  --write-out '%{http_code}'
)
if [[ -s "$API_TOKEN_PATH" ]]; then
  API_TOKEN=$(tr -d '\r\n' < "$API_TOKEN_PATH")
  [[ -n "$API_TOKEN" ]] && CURL_ARGS+=(--header "Authorization: Bearer ${API_TOKEN}")
fi

set +e
HTTP_STATUS=$(curl "${CURL_ARGS[@]}" "${API}/api/actions/approve")
CURL_RC=$?
set -e

HTTP_SUCCESS=0
if [[ "$CURL_RC" -eq 0 && "$HTTP_STATUS" =~ ^2[0-9][0-9]$ ]] \
  && jq -e '.success == true' "$HTTP_BODY" >/dev/null 2>&1; then
  HTTP_SUCCESS=1
fi

if reconcile_durable_approval; then
  if [[ "$HTTP_SUCCESS" -eq 0 ]]; then
    log "reconciled durable approval after ambiguous HTTP result (curl=${CURL_RC}, status=${HTTP_STATUS:-none})"
  else
    log "approved durably via POST /api/actions/approve"
  fi
  echo "approved ${EXECUTION_ID}"
  exit 0
fi

if [[ "$HTTP_SUCCESS" -eq 1 ]]; then
  log "approve endpoint returned success without exact durable Bridge response + approved_to_ship"
else
  RESPONSE=$(tr '\n' ' ' < "$HTTP_BODY")
  log "approve endpoint failed (curl=${CURL_RC}, status=${HTTP_STATUS:-none}, body=${RESPONSE:-empty})"
fi
exit 4

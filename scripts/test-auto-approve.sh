#!/usr/bin/env bash
# FLY-115 v1.24.4 (replaces v1.24.2 implementation):
#   Unblock a sandbox Runner stuck at the flywheel-comm `approve_to_ship`
#   gate by writing the gate response directly into CommDB — the same path
#   the production Lead runtime uses today (see Codex architectural review
#   for FLY-115 v1.24.4 + qa-fly-108 Round 4 deadlock report).
#
# Usage:
#   scripts/test-auto-approve.sh <slot> <execution-id> [--timeout 60] [--poll-interval 2]
#
# Exit codes:
#   0 — gate response inserted (Runner can proceed)
#   2 — Bridge /health unreachable (slot not deployed)
#   3 — timeout: no pending approve_to_ship gate within --timeout seconds
#   4 — flywheel-comm respond failed (CLI missing, DB write error, etc.)
#   5 — usage / arg error
#
# ── Why this script no longer POSTs /api/actions/approve ──
# v1.24.2 used `POST /api/actions/approve` to drive Bridge's `approveExecution`,
# which strictly requires `session.status == "awaiting_review"`. But the FSM
# only flips to awaiting_review when a `session_completed` event arrives, and
# `session_completed` is only emitted by Blueprint when the Runner exits.
# When the Runner is correctly blocked on the `gate approve_to_ship` CLI
# (the whole point of the gate), Blueprint cannot fire session_completed, so
# the FSM stays at "running", `approveExecution` rejects with HTTP 400, and
# the auto-approve script times out forever. qa-fly-108 hit this dead-lock in
# Round 4 (timeline: 02:32:37 session_started → 02:33:24 Runner posted gate
# → 11+ min stuck on `Cannot approve …: status is "running", expected
# "awaiting_review"`).
#
# Production never hits this knot because the Lead runtime doesn't call the
# action endpoint either — when Annie posts ":cool:" the Lead runs:
#     flywheel-comm respond --lead <leadName> --db <comm-db> <question_id> "<answer>"
# which inserts the response row directly into CommDB, unblocks the Runner's
# polling loop, and lets the Runner reach session_completed naturally on its
# own exit. Codex's v1.24.4 architectural review confirmed this is the prod
# path and that aligning the test framework with it is a fidelity improvement,
# not a workaround. (Suspected production-side breakage of `/api/actions/approve`
# under the same gate is being tracked separately as a follow-up FLY issue —
# v1.24.4 deliberately stays scoped to the test framework.)
set -euo pipefail

usage() {
  echo "Usage: $0 <slot> <execution-id> [--timeout SECONDS] [--poll-interval SECONDS]" >&2
  exit 5
}

[[ $# -lt 2 ]] && usage
SLOT="$1"
EXECUTION_ID="$2"
shift 2

# FLY-115 v1.24.2: Slot must be a positive integer — same defense-in-depth as
# test-teardown.sh so a negative jq index (`.slots[-1]` → last slot) can't be
# triggered by a typo on the CLI.
if ! [[ "$SLOT" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: invalid slot '${SLOT}' — must be a positive integer" >&2
  exit 5
fi
if [[ -z "$EXECUTION_ID" ]]; then
  echo "ERROR: execution-id is required" >&2
  usage
fi

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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SLOTS_FILE="${HOME}/.flywheel/test-slots.json"
[[ -f "$SLOTS_FILE" ]] || { echo "ERROR: $SLOTS_FILE missing" >&2; exit 5; }

SLOT_IDX=$((SLOT - 1))
PORT=$(jq -r ".slots[${SLOT_IDX}].bridgePort // empty" "$SLOTS_FILE")
BOT_NAME=$(jq -r ".slots[${SLOT_IDX}].botName // empty" "$SLOTS_FILE")
[[ -n "$PORT" && -n "$BOT_NAME" ]] || {
  echo "ERROR: slot $SLOT not present in $SLOTS_FILE (need .bridgePort + .botName)" >&2
  exit 5
}

API="http://localhost:${PORT}"
PROJECT_NAME="test-slot-${SLOT}"
COMM_DB="${HOME}/.flywheel/comm/${PROJECT_NAME}/comm.db"

# flywheel-comm CLI lives at packages/flywheel-comm/dist/index.js after
# `pnpm -r --filter flywheel-comm build` (which test-deploy.sh's pre-flight
# already runs). Resolved relative to the script so worktree / sandbox runs
# both find it.
COMM_CLI="${REPO_ROOT}/packages/flywheel-comm/dist/index.js"

log() { echo "[test-auto-approve] $(date +%H:%M:%S) $*" >&2; }

if [[ ! -f "$COMM_CLI" ]]; then
  log "ERROR: flywheel-comm CLI not found at ${COMM_CLI}. Run 'pnpm -r --filter flywheel-comm build' (or rerun scripts/test-deploy.sh which builds it pre-flight)."
  exit 4
fi

# ── Phase 1: Bridge /health preflight ────────────────────────
# Sanity-check that the slot is actually deployed. We do not depend on Bridge
# for the approve write itself (that goes via flywheel-comm → CommDB), but a
# missing Bridge means GatePoller isn't running, so the Lead would never see
# the gate in production either — failing fast here matches prod expectation.
# /health (not /api/health) matches scripts/test-deploy.sh:488 wait loop.
if ! curl -fsS --max-time 5 "${API}/health" >/dev/null 2>&1; then
  log "Bridge unreachable at ${API}/health — is slot ${SLOT} deployed?"
  exit 2
fi

# ── Phase 2: poll until a pending approve_to_ship gate exists in CommDB ──
#
# We no longer gate on `session.status == awaiting_review` — that flag only
# flips on `session_completed` events, which Blueprint can't emit while the
# Runner is correctly blocked inside the gate's polling loop (see header
# comment for the Round 4 deadlock).
#
# Schema mirror (packages/flywheel-comm/src/db.ts:8-37, :82-99, :248-265):
#   messages(id, from_agent, to_agent, type, content, parent_id,
#            checkpoint, content_ref, content_type, expires_at, ...);
#   pending = from_agent=runner-execution-id, type='question',
#             checkpoint='approve_to_ship', no response child, not expired.
#
# We additionally fetch `id` (the question_id) because flywheel-comm respond
# requires it as the parent_id for the new response row.
DEADLINE=$(( $(date +%s) + TIMEOUT ))
QUESTION_ID=""
while [[ $(date +%s) -lt $DEADLINE ]]; do
  if [[ -f "$COMM_DB" ]]; then
    # `.timeout 2000` keeps the read short if the Runner-writer is mid-WAL.
    # Single-row LIMIT keeps shell-side parsing trivial — we want the most
    # recently created pending gate, which under normal Runner behaviour is
    # also the only one (gates are 1:1 with execution).
    QUESTION_ID=$(sqlite3 -batch -cmd ".timeout 2000" "$COMM_DB" "
      SELECT q.id FROM messages q
      WHERE q.from_agent = '${EXECUTION_ID}'
        AND q.type = 'question'
        AND q.checkpoint = 'approve_to_ship'
        AND NOT EXISTS (
          SELECT 1 FROM messages r
          WHERE r.parent_id = q.id AND r.type = 'response'
        )
        AND q.expires_at > datetime('now')
      ORDER BY q.created_at DESC
      LIMIT 1;
    " 2>/dev/null || echo "")
    if [[ -n "$QUESTION_ID" ]]; then
      log "pending approve_to_ship gate present (question_id=${QUESTION_ID}); responding"
      break
    fi
  fi
  sleep "$POLL"
done

if [[ -z "$QUESTION_ID" ]]; then
  log "timeout after ${TIMEOUT}s waiting for pending approve_to_ship gate from execution_id=${EXECUTION_ID}"
  exit 3
fi

# ── Phase 3: insert gate response via flywheel-comm respond ──
#
# This is the production path: Lead runtime today shells out to the same CLI
# (`flywheel-comm respond --lead <leadName> --db <comm-db> <question_id> "<answer>"`
# — see Lead identity prompts and packages/flywheel-comm/src/index.ts:203-235)
# whenever Annie says ":cool:" in Discord. We use the slot's bot name as
# `--lead` to mirror that wire format precisely.
#
# Response content is the structured `{"approved":true}` JSON that
# packages/flywheel-comm/src/commands/gate.ts:128-138 parses to populate
# GateResult.approved=true, so the Runner sees a typed "approved" gate result
# rather than a free-text reply.
RESPONSE_CONTENT='{"approved":true}'

if ! node "$COMM_CLI" respond \
      --lead "$BOT_NAME" \
      --db "$COMM_DB" \
      "$QUESTION_ID" \
      "$RESPONSE_CONTENT" \
      >/dev/null; then
  log "flywheel-comm respond failed for question_id=${QUESTION_ID}"
  exit 4
fi

log "approved: execution_id=${EXECUTION_ID} question_id=${QUESTION_ID} (via flywheel-comm respond, prod path)"
echo "approved ${EXECUTION_ID}"

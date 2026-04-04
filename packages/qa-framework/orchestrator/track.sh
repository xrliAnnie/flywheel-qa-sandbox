#!/usr/bin/env bash
set -euo pipefail

# track.sh — QA Framework step tracker
# Generic version: gate checks prerequisites from DB (agent_steps.prerequisite),
# not from hardcoded step ordering.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/state.sh"

AGENT_ID="${1:?Usage: track.sh <agent_id> <action> ...}"
ACTION="${2:?Usage: track.sh <agent_id> start|complete|artifact|artifact-critical|skip|status|gate ...}"

case "$ACTION" in
  start)
    STEP_KEY="${3:?Missing step_key}"; STEP_NAME="${4:-$STEP_KEY}"
    state_try start_step "$AGENT_ID" "$STEP_KEY" "$STEP_NAME"
    echo "[TRACK] $AGENT_ID: started step $STEP_KEY ($STEP_NAME)" ;;

  complete)
    STEP_KEY="${3:?Missing step_key}"
    state_try complete_step "$AGENT_ID" "$STEP_KEY"
    echo "[TRACK] $AGENT_ID: completed step $STEP_KEY" ;;

  skip)
    STEP_KEY="${3:?Missing step_key}"; NOTES="${4:-}"
    state_try skip_step "$AGENT_ID" "$STEP_KEY" "$NOTES"
    echo "[TRACK] $AGENT_ID: skipped step $STEP_KEY ($NOTES)" ;;

  artifact)
    TYPE="${3:?Missing artifact type}"; VALUE="${4:?Missing artifact value}"; METADATA="${5:-}"
    state_try add_artifact "$AGENT_ID" "$TYPE" "$VALUE" "$METADATA"
    echo "[TRACK] $AGENT_ID: recorded artifact $TYPE=$VALUE" ;;

  artifact-critical)
    TYPE="${3:?Missing artifact type}"; VALUE="${4:?Missing artifact value}"; METADATA="${5:-}"
    state_critical add_artifact "$AGENT_ID" "$TYPE" "$VALUE" "$METADATA"
    echo "[TRACK] $AGENT_ID: recorded critical artifact $TYPE=$VALUE" ;;

  status)
    echo "=== Steps ===" && get_agent_steps "$AGENT_ID"
    echo "" && echo "=== Current ===" && get_current_step "$AGENT_ID"
    echo "" && echo "=== Artifacts ===" && get_agent_artifacts "$AGENT_ID" ;;

  gate)
    STEP_KEY="${3:?Missing step_key}"
    # Fail-closed: step must exist in agent_steps. Unknown steps are rejected.
    STEP_EXISTS=$(_sql "SELECT count(*) FROM agent_steps
        WHERE agent_id='$(sql_escape "$AGENT_ID")' AND step_key='$(sql_escape "$STEP_KEY")';")
    if [ "$STEP_EXISTS" != "1" ]; then
        echo "[GATE] BLOCKED: Step $STEP_KEY not found for agent $AGENT_ID (fail-closed)"
        exit 1
    fi

    # Query prerequisite from DB — no hardcoded step ordering
    PREREQ=$(_sql "SELECT prerequisite FROM agent_steps
        WHERE agent_id='$(sql_escape "$AGENT_ID")' AND step_key='$(sql_escape "$STEP_KEY")';")

    if [ -z "$PREREQ" ] || [ "$PREREQ" = "" ]; then
        echo "[GATE] Step $STEP_KEY: no prerequisite — PASS"
        exit 0
    fi

    PREV_STATUS=$(_sql "SELECT status FROM agent_steps
        WHERE agent_id='$(sql_escape "$AGENT_ID")' AND step_key='$(sql_escape "$PREREQ")';")

    if [ "$PREV_STATUS" = "completed" ] || [ "$PREV_STATUS" = "skipped" ]; then
        echo "[GATE] Step $STEP_KEY: prerequisite step $PREREQ $PREV_STATUS — PASS"
        exit 0
    else
        echo "[GATE] BLOCKED: Step $STEP_KEY requires step $PREREQ (current: ${PREV_STATUS:-not_started})"
        exit 1
    fi ;;

  *) echo "Unknown action: $ACTION"; exit 1 ;;
esac

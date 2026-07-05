#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"
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
    # Only steps 2 (Brainstorm) and 3 (Research) can be skipped
    case "$STEP_KEY" in
      2|3) ;;
      *) echo "[TRACK] ERROR: Step $STEP_KEY cannot be skipped (only steps 2 and 3 are skippable)" >&2; exit 1 ;;
    esac
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
    case "$STEP_KEY" in
      1) PREV="" ;; 2) PREV="1" ;; 3) PREV="2" ;; 4) PREV="3" ;;
      5) PREV="4" ;; 5a) PREV="5" ;; 5b) PREV="5a" ;; 6) PREV="5b" ;;
      7) PREV="6" ;;
      *) PREV="" ;;
    esac
    if [ -z "$PREV" ]; then echo "[GATE] Step $STEP_KEY: no prerequisite — PASS"; exit 0; fi
    PREV_STATUS=$(_sql "SELECT status FROM agent_steps WHERE agent_id='$(sql_escape "$AGENT_ID")' AND step_key='$PREV';")
    if [ "$PREV_STATUS" = "completed" ] || [ "$PREV_STATUS" = "skipped" ]; then
      echo "[GATE] Step $STEP_KEY: prerequisite step $PREV $PREV_STATUS — PASS"; exit 0
    else
      echo "[GATE] BLOCKED: Step $STEP_KEY requires step $PREV (current: ${PREV_STATUS:-not_started})"; exit 1
    fi ;;
  *) echo "Unknown action: $ACTION"; exit 1 ;;
esac

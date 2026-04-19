#!/usr/bin/env bash
# FLY-115: Inject a Linear-shaped run request into a test slot, bypassing
# Linear webhook → Bridge routing. Triggers /api/runs/start directly so a
# real Runner spawns against the slot's sandbox clone.
#
# Usage:
#   scripts/inject-linear-issue.sh <slot> <linear-issue-id> [--role main|qa]
#
# Example:
#   scripts/inject-linear-issue.sh 2 FLY-108
set -euo pipefail

SLOT="${1:?Usage: inject-linear-issue.sh <slot> <issue-id> [--role main|qa]}"
ISSUE_ID="${2:?issue-id required}"
shift 2

ROLE="main"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="${2:?--role requires value}"; shift 2 ;;
    *) echo "ERROR: unknown arg '$1'" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SLOTS_FILE="${HOME}/.flywheel/test-slots.json"
[[ -f "$SLOTS_FILE" ]] || { echo "ERROR: ${SLOTS_FILE} missing — deploy slot first" >&2; exit 1; }

SLOT_IDX=$((SLOT - 1))
PORT=$(jq -r ".slots[${SLOT_IDX}].bridgePort" "$SLOTS_FILE")
PROJECT_NAME="test-slot-${SLOT}"
[[ -n "$PORT" && "$PORT" != "null" ]] || { echo "ERROR: slot ${SLOT} not in ${SLOTS_FILE}" >&2; exit 1; }

BRIDGE_URL="http://localhost:${PORT}"
SLOT_DIR="/tmp/flywheel-test-slot-${SLOT}"
BRIDGE_LOG="${SLOT_DIR}/bridge.log"
curl -sf "${BRIDGE_URL}/health" >/dev/null \
  || { echo "ERROR: Bridge ${BRIDGE_URL} not healthy — tail ${BRIDGE_LOG} and redeploy" >&2; exit 1; }

echo "[inject] slot=${SLOT} issue=${ISSUE_ID} project=${PROJECT_NAME} role=${ROLE}" >&2

# Per-invocation temp file so parallel slot injects don't clobber each other.
RESP_FILE="$(mktemp -t flywheel-inject.XXXXXX)"
trap 'rm -f "$RESP_FILE"' EXIT

# POST /api/runs/start — see packages/teamlead/src/bridge/runs-route.ts
HTTP_CODE=$(curl -s -o "$RESP_FILE" -w '%{http_code}' \
  -XPOST "${BRIDGE_URL}/api/runs/start" \
  -H 'content-type: application/json' \
  -d "{\"issueId\":\"${ISSUE_ID}\",\"projectName\":\"${PROJECT_NAME}\",\"sessionRole\":\"${ROLE}\"}" \
  || echo "000")

RESP_BODY="$(cat "$RESP_FILE" 2>/dev/null || echo '{}')"
echo "$RESP_BODY" | jq .

case "$HTTP_CODE" in
  200|201|202)
    echo "[inject] /api/runs/start accepted (HTTP ${HTTP_CODE})" >&2
    ;;
  404)
    echo "[inject] HTTP 404 — Linear reports issue ${ISSUE_ID} does not exist (PreHydrator client.issue() returned null). Check the ID spelling and that the issue is visible to the LINEAR_API_KEY's workspace." >&2
    exit 2
    ;;
  409)
    echo "[inject] HTTP 409 — a run for ${PROJECT_NAME}/${ROLE} is already active (per FLY-59 dedup). This is usually fine for QA re-runs; stop the existing run first if not." >&2
    exit 3
    ;;
  502)
    echo "[inject] HTTP 502 — /api/runs/start PreHydrator Linear API call failed (network / auth / Linear 5xx). Check: (a) LINEAR_API_KEY on the Bridge process, (b) network reachable to linear.app, (c) Linear status. Tail ${BRIDGE_LOG}." >&2
    exit 4
    ;;
  503)
    echo "[inject] HTTP 503 — Bridge reports it cannot initialize the PreHydrator (LINEAR_API_KEY missing on the Bridge env). Re-deploy the slot and confirm the key." >&2
    exit 5
    ;;
  *)
    echo "[inject] unexpected HTTP ${HTTP_CODE}. Tail ${BRIDGE_LOG}." >&2
    exit 6
    ;;
esac

#!/usr/bin/env bash
# FLY-115: Inject a Linear-shaped run request into a test slot, bypassing
# Linear webhook → Bridge routing. Triggers /api/runs/start directly so a
# real Runner spawns against the slot's sandbox clone.
#
# Usage:
#   scripts/inject-linear-issue.sh <slot> <linear-issue-id> [--role main|qa] [--allow-mirror]
#
# Example:
#   scripts/inject-linear-issue.sh 2 FLY-108
#
# SIDE EFFECTS:
#   Pre-accepts the derived Runner worktree in both vendor stores:
#   ~/.claude.json and the host/source ~/.codex/config.toml. This avoids either
#   headless CLI blocking on an interactive trust prompt. test-teardown prunes
#   the slot's Claude entries and helper-owned Codex marker blocks.
#
# FLY-153: Refuses mirror-mode slots by default. Mirror mode is intended for
# reply-discipline cascade testing only; spawning a real Runner under mirror
# topology is out of scope (chat-thread dedupe across Bridges is undefined).
# Pass --allow-mirror to override if you really know what you are doing.
set -euo pipefail

SLOT="${1:?Usage: inject-linear-issue.sh <slot> <issue-id> [--role main|qa] [--allow-mirror] [--allow-roundtable]}"
ISSUE_ID="${2:?issue-id required}"
shift 2

ROLE="main"
ALLOW_MIRROR="false"
ALLOW_ROUNDTABLE="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="${2:?--role requires value}"; shift 2 ;;
    --allow-mirror) ALLOW_MIRROR="true"; shift ;;
    --allow-roundtable) ALLOW_ROUNDTABLE="true"; shift ;;
    *) echo "ERROR: unknown arg '$1'" >&2; exit 1 ;;
  esac
done

# FLY-153: refuse mirror slot unless --allow-mirror is passed. Absent sidecar
# = legacy slot (pre-FLY-153 deploy), allowed. Present-but-malformed sidecar
# is fail-closed so a corrupted lock dir doesn't silently allow Runner spawn.
SLOT_MODE_FILE="/tmp/flywheel-test-slot-${SLOT}.lock/mode"
if [[ -f "$SLOT_MODE_FILE" ]]; then
  SLOT_MODE_VAL=$(cat "$SLOT_MODE_FILE" 2>/dev/null || echo "")
  case "$SLOT_MODE_VAL" in
    slot)
      : ;;  # legacy mode, proceed
    mirror)
      if [[ "$ALLOW_MIRROR" != "true" ]]; then
        echo "ERROR: slot ${SLOT} is in mirror mode (FLY-153 reply-discipline test topology)." >&2
        echo "  Runner E2E in mirror mode is intentionally out of scope — chat-thread dedupe across" >&2
        echo "  multiple Bridges sharing one channel is undefined behavior. Pass --allow-mirror to override." >&2
        exit 1
      fi
      ;;
    roundtable)
      # FLY-529: roundtable shares mirror's multi-Bridge shared-channel risk
      # class. Runner E2E in roundtable topology is intentionally out of scope
      # (the room is for roundtable auto-thread + alert mirror validation, not
      # spawning Runners). Refuse by default; --allow-roundtable escapes.
      if [[ "$ALLOW_ROUNDTABLE" != "true" ]]; then
        echo "ERROR: slot ${SLOT} is in roundtable mode (FLY-529 roundtable-mirror topology)." >&2
        echo "  Runner E2E in roundtable mode is intentionally out of scope — the test room exists to" >&2
        echo "  validate roundtable auto-threading + alert isolation, not to spawn Runners. Pass" >&2
        echo "  --allow-roundtable to override." >&2
        exit 1
      fi
      ;;
    *)
      echo "ERROR: slot ${SLOT} mode sidecar (${SLOT_MODE_FILE}) contains unknown value '${SLOT_MODE_VAL}'. Refusing to inject as a safety measure — run scripts/test-teardown.sh ${SLOT} and redeploy." >&2
      exit 1
      ;;
  esac
fi

# FLY-115 fix: `ROLE` is used to derive the Runner worktree path for the trust
# entry we write below. Unknown values would produce a path that doesn't match
# what Bridge actually spawns into — the trust entry would be for the wrong
# directory and the Runner would still hit the trust prompt. Whitelist matches
# the only two callsites today (qa-fly-108 / worker spawn).
case "$ROLE" in
  main|qa) ;;
  *) echo "ERROR: --role must be 'main' or 'qa' (got: '${ROLE}')" >&2; exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/runner-workspace-trust.sh
source "${SCRIPT_DIR}/lib/runner-workspace-trust.sh"
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

# FLY-1775: generalized rooms activate the menu/master boundary and require a
# full taskCategory + leadId request. The legacy inject body below cannot
# truthfully select that path, so fail before trust-file or run mutation and
# direct the operator to the dedicated driver.
ROOM_INFO="${SLOT_DIR}/room-info.json"
if [[ -f "$ROOM_INFO" ]]; then
  if ! jq -e . "$ROOM_INFO" >/dev/null 2>&1; then
    echo "ERROR: ${ROOM_INFO} is malformed; teardown and redeploy slot ${SLOT}." >&2
    exit 1
  fi
  if [[ "$(jq -r '.generalized // false' "$ROOM_INFO")" == "true" ]]; then
    echo "ERROR: slot ${SLOT} is a generalized room; inject-linear-issue.sh is intentionally disabled." >&2
    echo "  Use scripts/qa-529-generalized-e2e.mjs ${SLOT} --issue ${ISSUE_ID}." >&2
    exit 1
  fi
fi

# FLY-1775 pit 9: TEST_REPLY_BY_ISSUE turns /api/* auth on. test-deploy stores
# that slot-local token mode 0600; consume it automatically without logging a
# byte. A room with no token stays on the exact legacy curl path.
AUTH_ARGS=()
API_TOKEN_PATH="${SLOT_DIR}/state/api-token"
if [[ -f "$API_TOKEN_PATH" ]]; then
  API_TOKEN=$(tr -d '\r\n' < "$API_TOKEN_PATH")
  [[ -n "$API_TOKEN" ]] || { echo "ERROR: ${API_TOKEN_PATH} is empty" >&2; exit 1; }
  AUTH_ARGS=(-H "Authorization: Bearer ${API_TOKEN}")
fi

echo "[inject] slot=${SLOT} issue=${ISSUE_ID} project=${PROJECT_NAME} role=${ROLE}" >&2

# FLY-115 fix: Pre-accept workspace trust for the Runner worktree so Claude CLI
# doesn't hang on the interactive trust prompt when spawned headlessly. Path
# derivation mirrors FLY-95 WorktreeManager: `${repoSlug}-${issueId}[-${role}]`
# as a sibling of the host clone. We write the canonical path (pwd -P of the
# parent) because Claude CLI canonicalizes before looking up trust state.
HOST_REPO="${SLOT_DIR}/project-slot-${SLOT}"
if [[ "$ROLE" == "main" ]]; then
  WORKTREE_ISSUE_ID="$ISSUE_ID"
else
  WORKTREE_ISSUE_ID="${ISSUE_ID}-${ROLE}"
fi
RUNNER_WORKTREE="${HOST_REPO}-${WORKTREE_ISSUE_ID}"

pretrust_workspace_dual "$RUNNER_WORKTREE" \
  || { echo "[inject] FATAL: dual-vendor trust write failed — refusing to POST /api/runs/start" >&2; exit 7; }
echo "[inject] Claude + Codex trust accepted: ${RUNNER_WORKSPACE_TRUST_CANONICAL}" >&2

# Per-invocation temp file so parallel slot injects don't clobber each other.
RESP_FILE="$(mktemp -t flywheel-inject.XXXXXX)"
trap 'rm -f "$RESP_FILE"' EXIT

# POST /api/runs/start — see packages/teamlead/src/bridge/runs-route.ts
HTTP_CODE=$(curl -s -o "$RESP_FILE" -w '%{http_code}' \
  -XPOST "${BRIDGE_URL}/api/runs/start" \
  ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} \
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

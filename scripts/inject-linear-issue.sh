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
#   Modifies ~/.claude.json to pre-accept the workspace trust prompt for the
#   Runner worktree path derived from SLOT + ISSUE_ID + ROLE. This avoids the
#   silent hang when Claude CLI launches in a fresh worktree — the prompt is
#   non-interactive under headless spawn and blocks the whole run.
#   A teardown call (`scripts/test-teardown.sh <slot>`) prunes these entries.
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

# FLY-115 fix: mkdir(2) is atomic on all POSIX filesystems, so we use a lock
# directory as a portable mutex (macOS has no `flock`). Parallel slot injects
# previously raced on ~/.claude.json — the later writer's snapshot missed the
# earlier writer's trust key, silently dropping it and re-introducing the
# headless trust-prompt hang. Callers MUST pair acquire/release.
#
# Stale-lock detection steals a lock older than CLAUDE_LOCK_STALE_S seconds
# (covers the case where a previous holder crashed before release). Value is
# overridable via env for tests.
: "${CLAUDE_LOCK_STALE_S:=60}"
: "${CLAUDE_LOCK_WAIT_S:=30}"
acquire_claude_lock() {
  local lock="${HOME}/.claude.json.lock"
  local waited_ms=0 step_ms=100 max_ms=$((CLAUDE_LOCK_WAIT_S * 1000))
  while ! mkdir "$lock" 2>/dev/null; do
    # Stale-lock sweep: if the lockdir is older than the threshold, assume
    # the previous holder crashed and steal it. `stat -f %m` (BSD/macOS) vs
    # `stat -c %Y` (GNU); fall back to "now" on failure so we don't steal
    # prematurely.
    if [[ -d "$lock" ]]; then
      local mtime now age
      mtime=$(stat -f %m "$lock" 2>/dev/null \
              || stat -c %Y "$lock" 2>/dev/null \
              || echo "")
      now=$(date +%s)
      if [[ -n "$mtime" ]]; then
        age=$(( now - mtime ))
        if (( age > CLAUDE_LOCK_STALE_S )); then
          echo "[inject] WARN: stealing stale trust lock (age ${age}s)" >&2
          rmdir "$lock" 2>/dev/null || true
          continue
        fi
      fi
    fi
    if (( waited_ms >= max_ms )); then
      echo "[inject] ERROR: timed out waiting for ${lock} after ${CLAUDE_LOCK_WAIT_S}s" >&2
      return 1
    fi
    sleep 0.1
    waited_ms=$(( waited_ms + step_ms ))
  done
  return 0
}

release_claude_lock() {
  rmdir "${HOME}/.claude.json.lock" 2>/dev/null || true
}

# Atomically merge one trust entry into ~/.claude.json. Returns non-zero on any
# failure; caller MUST propagate to avoid running into the hang bug.
write_trust_entry() {
  local target="$1"
  local CLAUDE_JSON="$HOME/.claude.json"

  # Canonicalize via parent directory (target itself doesn't exist yet — Bridge
  # will create the Runner worktree shortly after we return).
  local parent basename canonical_parent CANONICAL
  parent="$(dirname "$target")"
  basename="$(basename "$target")"
  if [[ ! -d "$parent" ]]; then
    echo "[inject] ERROR: parent ${parent} missing — cannot resolve canonical path for ${target}" >&2
    return 1
  fi
  canonical_parent="$(cd "$parent" && pwd -P)" || return 1
  CANONICAL="${canonical_parent}/${basename}"

  # FLY-115 fix: serialize the entire read→merge→write with a mkdir mutex so
  # parallel slot injects don't stomp each other's trust keys.
  acquire_claude_lock || return 1

  # If ~/.claude.json already exists, refuse to overwrite on parse error —
  # silently stomping on user state is worse than hanging loudly.
  local input_source=""
  if [[ -s "$CLAUDE_JSON" ]]; then
    if jq -e . "$CLAUDE_JSON" >/dev/null 2>&1; then
      input_source="$CLAUDE_JSON"
    else
      echo "[inject] ERROR: ${CLAUDE_JSON} exists but is not valid JSON — refusing to overwrite user state" >&2
      release_claude_lock
      return 1
    fi
  fi

  # Same-filesystem tempfile so the final `mv` is an atomic rename(2).
  local tmp_json
  tmp_json="$(mktemp "${CLAUDE_JSON}.XXXXXX")" \
    || { echo "[inject] ERROR: mktemp failed near ${CLAUDE_JSON}" >&2; release_claude_lock; return 1; }

  # File-based input (avoids ARG_MAX if ~/.claude.json ever grows huge).
  if [[ -z "$input_source" ]]; then
    echo '{}' > "${tmp_json}.2" \
      || { rm -f "$tmp_json" "${tmp_json}.2"; release_claude_lock; return 1; }
    input_source="${tmp_json}.2"
  fi

  if ! jq --arg p "$CANONICAL" \
        '.projects = ((.projects // {}) | .[$p] |= ((. // {}) + {hasTrustDialogAccepted: true}))' \
        "$input_source" > "$tmp_json"; then
    rm -f "$tmp_json" "${tmp_json}.2"
    echo "[inject] ERROR: jq filter failed for ${CANONICAL}" >&2
    release_claude_lock
    return 1
  fi

  if ! mv "$tmp_json" "$CLAUDE_JSON"; then
    rm -f "$tmp_json" "${tmp_json}.2"
    echo "[inject] ERROR: mv failed replacing ${CLAUDE_JSON}" >&2
    release_claude_lock
    return 1
  fi
  rm -f "${tmp_json}.2"
  release_claude_lock
  echo "[inject] trust accepted: ${CANONICAL}" >&2
  return 0
}

write_trust_entry "$RUNNER_WORKTREE" \
  || { echo "[inject] FATAL: trust write failed — refusing to POST /api/runs/start (would hang on trust prompt)" >&2; exit 7; }

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

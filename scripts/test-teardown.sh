#!/usr/bin/env bash
# FLY-96: Teardown a test slot (or all slots).
#
# Usage: scripts/test-teardown.sh <slot-number | all>
#
# Teardown order (critical — see plan D7):
# 1. Kill Lead supervisor first (prevents recovery loop restart)
# 2. Wait for supervisor exit (SIGKILL fallback)
# 3. Kill Lead tmux window (cleanup fallback)
# 4. Delete session-id file (prevents --resume on slot reuse)
# 5. Kill Bridge process
# 6. Clean temp files + CommDB
# 7. Release slot lock
set -euo pipefail

log() { echo "[test-teardown] $(date +%H:%M:%S) $*" >&2; }

teardown_slot() {
  local SLOT="$1"
  local SLOT_DIR="/tmp/flywheel-test-slot-${SLOT}"
  local LOCK_FILE="/tmp/flywheel-test-slot-${SLOT}.lock"

  # Read slot config for agent ID. Schema matches ~/.flywheel/test-slots.json
  # (FLY-96): AGENT_ID is derived from .botName (1:1). Fallback to a predictable
  # name if the slots file is missing/unreadable so teardown still makes progress.
  SLOTS_FILE="${HOME}/.flywheel/test-slots.json"
  local SLOT_IDX=$((SLOT - 1))
  local AGENT_ID
  AGENT_ID=$(jq -r ".slots[${SLOT_IDX}].botName // empty" "$SLOTS_FILE" 2>/dev/null || true)
  if [[ -z "$AGENT_ID" ]]; then
    AGENT_ID="flywheel-test-${SLOT}"
  fi
  local PROJECT_NAME="test-slot-${SLOT}"

  log "Tearing down slot ${SLOT} (agent: ${AGENT_ID})"

  # ── Step 1b (FLY-115): Stop Runner tmux session if present ──
  # Runner tmux is killed BEFORE Bridge so that no process is actively
  # writing into the FLY-95 Runner worktree while we remove it.
  local RUNNER_TMUX="runner-test-slot-${SLOT}"
  if tmux has-session -t "$RUNNER_TMUX" 2>/dev/null; then
    log "Killing Runner tmux session: ${RUNNER_TMUX}"
    tmux kill-session -t "$RUNNER_TMUX" 2>/dev/null || true
  fi

  # ── Step 1: Kill Lead supervisor ──────────────────────
  local LEAD_PID_FILE="${HOME}/.flywheel/pids/${PROJECT_NAME}-${AGENT_ID}.pid"
  if [[ -f "$LEAD_PID_FILE" ]]; then
    local LEAD_PID
    LEAD_PID=$(cat "$LEAD_PID_FILE" 2>/dev/null || echo "")
    if [[ -n "$LEAD_PID" ]] && kill -0 "$LEAD_PID" 2>/dev/null; then
      log "Killing Lead supervisor PID ${LEAD_PID} (SIGTERM)"
      kill "$LEAD_PID" 2>/dev/null || true

      # ── Step 2: Wait for supervisor exit ────────────────
      local waited=0
      while kill -0 "$LEAD_PID" 2>/dev/null && (( waited < 10 )); do
        sleep 1
        waited=$((waited + 1))
      done

      if kill -0 "$LEAD_PID" 2>/dev/null; then
        log "Supervisor still alive after 10s, sending SIGKILL"
        kill -9 "$LEAD_PID" 2>/dev/null || true
        sleep 1
      fi
    fi
    rm -f "$LEAD_PID_FILE"
    log "Lead supervisor stopped"
  else
    log "No Lead PID file found at ${LEAD_PID_FILE}"
  fi

  # ── Step 3: Kill Lead tmux window (cleanup fallback) ──
  # Window name matches claude-lead.sh convention: ${PROJECT_NAME}-${LEAD_ID}
  local TMUX_WINDOW="${PROJECT_NAME}-${AGENT_ID}"
  if tmux has-session -t "flywheel" 2>/dev/null; then
    if tmux list-windows -t "flywheel" -F '#{window_name}' 2>/dev/null | grep -q "^${TMUX_WINDOW}$"; then
      log "Killing tmux window: ${TMUX_WINDOW}"
      tmux kill-window -t "flywheel:${TMUX_WINDOW}" 2>/dev/null || true
    fi
  fi

  # ── Step 4: Delete session-id file ────────────────────
  # Prevents --resume on slot reuse (claude-lead.sh:841-846)
  local SESSION_ID_FILE="${HOME}/.flywheel/claude-sessions/${PROJECT_NAME}-${AGENT_ID}.session-id"
  if [[ -f "$SESSION_ID_FILE" ]]; then
    log "Deleting session-id: ${SESSION_ID_FILE}"
    rm -f "$SESSION_ID_FILE"
  fi

  # ── Step 5: Kill Bridge process ───────────────────────
  local BRIDGE_PID_FILE="${SLOT_DIR}/bridge.pid"
  if [[ -f "$BRIDGE_PID_FILE" ]]; then
    local BRIDGE_PID
    BRIDGE_PID=$(cat "$BRIDGE_PID_FILE" 2>/dev/null || echo "")
    if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
      log "Killing Bridge PID ${BRIDGE_PID}"
      kill "$BRIDGE_PID" 2>/dev/null || true
      sleep 1
      if kill -0 "$BRIDGE_PID" 2>/dev/null; then
        kill -9 "$BRIDGE_PID" 2>/dev/null || true
      fi
    fi
  fi

  # ── Step 5b (FLY-115): Clean FLY-95 Runner worktrees + slot-local branches ──
  # Runner worktrees live as siblings of the host clone inside SLOT_DIR
  # (e.g. ${SLOT_DIR}/project-slot-${SLOT}-FLY-108). Host clone basename is
  # slot-unique to avoid branch-name collision on the sandbox remote when
  # multiple slots run the same issue concurrently (see test-deploy.sh §4.3).
  # Must run AFTER Bridge is killed (no new dispatch) and BEFORE `rm -rf
  # SLOT_DIR` (so git gets a chance to prune registry cleanly).
  local HOST_REPO="${SLOT_DIR}/project-slot-${SLOT}"
  if [[ -d "${HOST_REPO}/.git" ]]; then
    log "Removing FLY-95 Runner worktrees registered under ${SLOT_DIR}"
    mapfile -t SLOT_WORKTREES < <(
      git -C "$HOST_REPO" worktree list --porcelain 2>/dev/null \
        | awk '/^worktree /{print $2}' \
        | grep -F "$SLOT_DIR/" || true
    )
    local wt
    for wt in "${SLOT_WORKTREES[@]}"; do
      # Skip the host worktree itself — it is ${SLOT_DIR}/project-slot-${SLOT}
      # and is torn down when we rm -rf SLOT_DIR below.
      [[ "$wt" == "$HOST_REPO" ]] && continue
      log "  worktree remove --force ${wt}"
      git -C "$HOST_REPO" worktree remove --force "$wt" 2>/dev/null || true
      rm -rf "$wt"
    done

    # Delete slot-local branches: qa-slot-${SLOT}-* and any FLY-95 Runner
    # branches. It is a per-slot clone, so deletion has no cross-slot impact.
    log "Pruning local branches in ${HOST_REPO}"
    mapfile -t LOCAL_BRANCHES < <(
      git -C "$HOST_REPO" for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null || true
    )
    local b
    for b in "${LOCAL_BRANCHES[@]}"; do
      [[ "$b" == "main" || "$b" == "master" ]] && continue
      git -C "$HOST_REPO" branch -D "$b" 2>/dev/null || true
    done

    git -C "$HOST_REPO" worktree prune 2>/dev/null || true

    # Verification assertion — warn loud if anything survives inside SLOT_DIR
    local REMAINING
    REMAINING=$(git -C "$HOST_REPO" worktree list --porcelain 2>/dev/null \
      | awk '/^worktree /{print $2}' \
      | grep -F "$SLOT_DIR/" | grep -v "^${HOST_REPO}$" || true)
    if [[ -n "$REMAINING" ]]; then
      log "WARN: worktrees still registered in ${SLOT_DIR} after cleanup:"
      echo "$REMAINING" | sed 's/^/    /' >&2
    fi
  fi

  # ── Step 6: Clean temp files + CommDB ─────────────────
  if [[ -d "$SLOT_DIR" ]]; then
    log "Cleaning temp dir: ${SLOT_DIR}"
    rm -rf "$SLOT_DIR"
  fi

  local COMMDB_DIR="${HOME}/.flywheel/comm/${PROJECT_NAME}"
  if [[ -d "$COMMDB_DIR" ]]; then
    log "Cleaning CommDB: ${COMMDB_DIR}"
    rm -rf "$COMMDB_DIR"
  fi

  # Clean test lead workspace + agent files
  local LEAD_WORKSPACE="${HOME}/.flywheel/lead-workspace/${AGENT_ID}"
  if [[ -d "$LEAD_WORKSPACE" ]]; then
    rm -rf "$LEAD_WORKSPACE"
  fi

  # ── Step 7: Release slot lock ─────────────────────────
  if [[ -d "$LOCK_FILE" ]]; then
    rm -rf "$LOCK_FILE"
    log "Slot ${SLOT} released"
  fi

  log "Slot ${SLOT} teardown complete"
}

# ── Main ──────────────────────────────────────────────
TARGET="${1:?Usage: test-teardown.sh <slot-number | all>}"

if [[ "$TARGET" == "all" ]]; then
  SLOTS_FILE="${HOME}/.flywheel/test-slots.json"
  TOTAL_SLOTS=$(jq '.slots | length' "$SLOTS_FILE" 2>/dev/null || echo 4)
  for i in $(seq 1 "$TOTAL_SLOTS"); do
    teardown_slot "$i"
  done
  log "All slots torn down"
else
  teardown_slot "$TARGET"
fi

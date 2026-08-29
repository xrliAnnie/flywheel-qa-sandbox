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

# FLY-1189: multi-Lead campaign helpers — borrowed-lock guard + manifest-driven
# extra-Lead cleanup. Pure lib; sourcing changes nothing for legacy slots.
TEARDOWN_SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/qa-multilead.sh
source "${TEARDOWN_SCRIPT_DIR}/lib/qa-multilead.sh"

# FLY-115 fix: mkdir(2)-based mutex matches inject-linear-issue.sh's locking
# so teardown's prune doesn't race with a concurrent inject in another slot.
# Parallel slot operations previously could drop in-flight trust keys. Stale
# lock (>CLAUDE_LOCK_STALE_S seconds) is stolen — covers crashes mid-RMW.
: "${CLAUDE_LOCK_STALE_S:=60}"
: "${CLAUDE_LOCK_WAIT_S:=30}"
acquire_claude_lock() {
  local lock="${HOME}/.claude.json.lock"
  local waited_ms=0 step_ms=100 max_ms=$((CLAUDE_LOCK_WAIT_S * 1000))
  while ! mkdir "$lock" 2>/dev/null; do
    if [[ -d "$lock" ]]; then
      local mtime now age
      mtime=$(stat -f %m "$lock" 2>/dev/null \
              || stat -c %Y "$lock" 2>/dev/null \
              || echo "")
      now=$(date +%s)
      if [[ -n "$mtime" ]]; then
        age=$(( now - mtime ))
        if (( age > CLAUDE_LOCK_STALE_S )); then
          log "WARN: stealing stale trust lock (age ${age}s)"
          rmdir "$lock" 2>/dev/null || true
          continue
        fi
      fi
    fi
    if (( waited_ms >= max_ms )); then
      log "WARN: timed out waiting for ${lock} after ${CLAUDE_LOCK_WAIT_S}s"
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

# FLY-115 fix: Remove ~/.claude.json trust entries whose keys live under the
# given prefix. Best-effort; never aborts teardown under `set -e`. Atomic write
# via same-dir tempfile (POSIX rename(2) atomicity) so no partial JSON on crash.
prune_trust_entries() {
  local PREFIX="$1"
  local CLAUDE_JSON="${HOME}/.claude.json"
  [[ -f "$CLAUDE_JSON" ]] || return 0
  [[ -n "$PREFIX" ]] || return 0

  # Canonicalize the prefix so we match however the entries were written.
  # inject-linear-issue.sh's write_trust_entry() canonicalizes via parent pwd
  # -P — on macOS /tmp is a symlink to /private/tmp, so written keys look like
  # /private/tmp/flywheel-test-slot-N-FLY-108/. We MUST match that form here.
  # Resolve via PARENT (always exists) rather than `cd "$PREFIX"` which fails
  # after Step 6's `rm -rf "$SLOT_DIR"` and falls back to the raw /tmp path.
  local CANON parent basename canonical_parent
  parent="$(dirname "$PREFIX")"
  basename="$(basename "$PREFIX")"
  if canonical_parent="$(cd "$parent" 2>/dev/null && pwd -P)"; then
    CANON="${canonical_parent}/${basename}"
  else
    CANON="$PREFIX"
  fi
  # Ensure trailing slash so `/tmp/flywheel-test-slot-1` doesn't accidentally
  # match `/tmp/flywheel-test-slot-10/...`.
  [[ "${CANON}" != */ ]] && CANON="${CANON}/"

  # Serialize the RMW with the same mkdir mutex as inject-linear-issue.sh so
  # this prune can't drop a concurrent slot's just-written trust key.
  if ! acquire_claude_lock; then
    log "WARN: trust prune skipped (lock timeout); ~/.claude.json unchanged"
    return 0
  fi

  # Create tempfile in the SAME directory as ~/.claude.json so the final mv
  # is an atomic rename(2) (same filesystem guarantee).
  local TMP
  if ! TMP=$(mktemp "${CLAUDE_JSON}.XXXXXX"); then
    release_claude_lock
    return 0
  fi

  if jq --arg prefix "$CANON" \
    '.projects = ((.projects // {}) | with_entries(select((.key | startswith($prefix)) | not)))' \
    "$CLAUDE_JSON" > "$TMP" 2>/dev/null \
    && jq -e . "$TMP" >/dev/null 2>&1; then
    mv "$TMP" "$CLAUDE_JSON" 2>/dev/null || rm -f "$TMP"
    log "Pruned trust entries under ${CANON}"
  else
    rm -f "$TMP"
    log "WARN: trust prune skipped (jq/schema error); ~/.claude.json unchanged"
  fi
  release_claude_lock
}

teardown_slot() {
  local SLOT="$1"
  # FLY-115 fix (Codex R7 #1): Validate SLOT is a positive integer. Without
  # this, `SLOT_IDX=$((SLOT - 1))` would produce a negative index (e.g.
  # SLOT=0 → -1) that `jq '.slots[-1]'` resolves to the LAST slot — causing
  # this teardown to delete a different slot's lead workspace (line below).
  if ! [[ "$SLOT" =~ ^[1-9][0-9]*$ ]]; then
    log "ERROR: invalid slot '${SLOT}' — must be a positive integer"
    return 1
  fi
  local SLOT_DIR="/tmp/flywheel-test-slot-${SLOT}"
  local LOCK_FILE="/tmp/flywheel-test-slot-${SLOT}.lock"

  # FLY-1189: a BORROWED lock belongs to another slot's multi-Lead campaign —
  # its Lead resources live in the OWNER slot's SLOT_DIR. Tearing it down here
  # would kill a live campaign's extra Lead out from under it. Fail loud and
  # point at the only legal release path (owner teardown).
  local BORROW_OWNER
  if BORROW_OWNER=$(qa_multilead_lock_is_borrowed "$LOCK_FILE"); then
    log "ERROR: slot ${SLOT} lock is BORROWED by campaign owner slot ${BORROW_OWNER} — refusing."
    log "  Run: scripts/test-teardown.sh ${BORROW_OWNER}   (owner teardown releases this lock)"
    return 1
  fi

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

  # FLY-153: Surface mode in teardown log for observability. Mode sidecar
  # is written by test-deploy.sh; absent file means pre-FLY-153 deploy or
  # manual setup — log as 'unknown' rather than failing.
  local SLOT_MODE_VAL="unknown"
  if [[ -f "/tmp/flywheel-test-slot-${SLOT}.lock/mode" ]]; then
    SLOT_MODE_VAL=$(cat "/tmp/flywheel-test-slot-${SLOT}.lock/mode" 2>/dev/null || echo "unknown")
  fi
  log "Tearing down slot ${SLOT} (agent: ${AGENT_ID}, mode: ${SLOT_MODE_VAL})"

  # FLY-1189: owner-slot campaign cleanup — stop the extra Leads + release the
  # borrowed slot locks BEFORE the legacy single-Lead teardown below. Absent
  # manifest → no-op (legacy behavior verbatim).
  local CAMPAIGN_MANIFEST="${SLOT_DIR}/campaign-manifest.json"
  if [[ -f "$CAMPAIGN_MANIFEST" ]]; then
    log "Campaign manifest found — cleaning extra Leads + borrowed locks"
    qa_multilead_teardown_extra_leads "$CAMPAIGN_MANIFEST"
    qa_multilead_release_borrowed_locks "$CAMPAIGN_MANIFEST" "/tmp"
  fi

  # ── Step 1b (FLY-115): Stop Runner tmux + its cmux linked sessions ──
  # Runner tmux is killed BEFORE Bridge so that no process is actively
  # writing into the FLY-95 Runner worktree while we remove it.
  #
  # v1.24.2 Gap 3.2 (Codex R3 unified sweep): cmux viewer sessions are
  # named `cmux-<window_name>` and flywheel-cmux-sync.sh creates every
  # one of them via
  #   tmux new-session -d -t "$source_session" -s "cmux-<window_name>"
  # (scripts/flywheel-cmux-sync.sh:138-141), which records the source
  # session as the viewer's `#{session_group}`. That group name persists
  # on the viewer even after the source dies, giving us a reliable
  # ownership signal that a plain window-name match cannot provide.
  #
  # Killing the Runner session first is safe: cmux viewers are detached
  # linked sessions and outlive the source, so doing the unified cmux
  # sweep afterwards covers all three scenarios that the earlier
  # primary+secondary design leaked:
  #   (a) RUNNER_TMUX alive when teardown starts          → normal path
  #   (b) RUNNER_TMUX already dead when teardown starts   → crash recovery
  #   (c) two live slots colliding on the same window     → no false-kill
  local RUNNER_TMUX="runner-test-slot-${SLOT}"
  if tmux has-session -t "$RUNNER_TMUX" 2>/dev/null; then
    log "Killing Runner tmux session: ${RUNNER_TMUX}"
    tmux kill-session -t "$RUNNER_TMUX" 2>/dev/null || true
  fi

  # Unified cmux sweep, keyed on `#{session_group}` ownership.
  # Decision table:
  #   owner == RUNNER_TMUX            → ours         → kill
  #   owner is a live sibling session → still in use → skip
  #   owner names a dead session      → orphan       → kill (cleanup)
  #   owner is empty                  → not Flywheel → skip (don't touch
  #                                        sessions we didn't create —
  #                                        narrower than the pre-v1.24.2
  #                                        window-name sweep on purpose)
  #
  # Exact-match querying: `list-sessions -f '#{==:#{session_name},<s>}'`
  # is used instead of `display-message -t "=<s>"` because the latter
  # returns empty on macOS tmux when the target has no `:window` suffix,
  # and bare `-t <s>` risks prefix matching a differently-named session.
  local cmux_s owner
  while IFS= read -r cmux_s || [[ -n "$cmux_s" ]]; do
    [[ -z "$cmux_s" ]] && continue
    owner=$(tmux list-sessions -F '#{session_group}' \
      -f "#{==:#{session_name},${cmux_s}}" 2>/dev/null | head -1 || echo "")
    [[ -z "$owner" ]] && continue
    if [[ "$owner" != "$RUNNER_TMUX" ]] \
       && tmux has-session -t "=${owner}" 2>/dev/null; then
      log "Skip cmux kill ${cmux_s} — owned by live session '${owner}'"
      continue
    fi
    log "Killing cmux linked session: ${cmux_s} (owner=${owner})"
    tmux kill-session -t "=${cmux_s}" 2>/dev/null || true
  done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E '^cmux-' || true)

  # ── Step 1c (FLY-115 v1.24.2 Gap 3.3): Orphan `claude` CLI sweep ──
  # After killing the Runner tmux session, its child `claude` processes can
  # reparent to init (pid 1) and linger. `pgrep -f` matches by argv, which
  # both false-positives (Annie's host `claude` session debugging a slot
  # path) and false-negatives (`claude --print "hi"` has no path in argv).
  # Use `pgrep -x claude` for exact-name candidates, then `lsof -p $pid -d
  # cwd` to read the real cwd and match against a canonicalized slot prefix
  # with trailing slash so slot-1 does NOT match slot-10 / slot-1-old.
  local CANONICAL_SLOT_DIR
  CANONICAL_SLOT_DIR=$(cd "${SLOT_DIR}" 2>/dev/null && pwd -P || echo "")
  if [[ -n "$CANONICAL_SLOT_DIR" && "$CANONICAL_SLOT_DIR" != "/" ]]; then
    local CANDIDATES=()
    while IFS= read -r cpid || [[ -n "$cpid" ]]; do
      [[ -z "$cpid" ]] && continue
      CANDIDATES+=("$cpid")
    done < <(pgrep -x claude 2>/dev/null || true)

    local ORPHAN_PIDS=()
    if (( ${#CANDIDATES[@]} > 0 )); then
      local slot_prefix="${CANONICAL_SLOT_DIR%/}/"
      local cpid cwd cwd_norm
      for cpid in "${CANDIDATES[@]}"; do
        # lsof -a -p PID -d cwd -Fn → one-record-per-fd output, `n` field
        # holds the canonical path. On macOS /tmp is a symlink to /private/tmp,
        # so `lsof` typically resolves to /private/tmp/... already.
        cwd=$(lsof -a -p "$cpid" -d cwd -Fn 2>/dev/null \
          | awk '/^n/{print substr($0,2); exit}' \
          || echo "")
        [[ -z "$cwd" ]] && continue
        cwd_norm="${cwd%/}/"
        if [[ "$cwd_norm" == "$slot_prefix"* ]]; then
          ORPHAN_PIDS+=("$cpid")
        fi
      done
    fi

    if (( ${#ORPHAN_PIDS[@]} > 0 )); then
      log "Killing ${#ORPHAN_PIDS[@]} orphan claude pid(s) under ${CANONICAL_SLOT_DIR} (SIGTERM)"
      local opid
      for opid in "${ORPHAN_PIDS[@]}"; do
        kill -TERM "$opid" 2>/dev/null || true
      done
      sleep 2
      for opid in "${ORPHAN_PIDS[@]}"; do
        if kill -0 "$opid" 2>/dev/null; then
          log "  pid ${opid} survived SIGTERM; SIGKILL"
          kill -KILL "$opid" 2>/dev/null || true
        fi
      done
    fi
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

  # ── Step 4b (FLY-231): Delete this slot's manifest ────
  # claude-lead.sh writes ~/.flywheel/manifests/<project>-<lead>.json on start.
  # test-teardown never removed it, so stale test-slot manifests accumulated.
  # A production deploy's restart-services.sh iterates ALL manifests; with the
  # new always-query fail-STOP, a leftover test-slot manifest would otherwise be
  # hit on restart. restart-services.sh now skips flywheel-test-* manifests, but
  # we ALSO delete it here so it does not pile up (Codex R6 BLOCKER-1 hygiene).
  local SLOT_MANIFEST="${HOME}/.flywheel/manifests/${PROJECT_NAME}-${AGENT_ID}.json"
  if [[ -f "$SLOT_MANIFEST" ]]; then
    log "Deleting test-slot manifest: ${SLOT_MANIFEST}"
    rm -f "$SLOT_MANIFEST"
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

  # ── Step 5c (FLY-115 fix / Defect #3b): Port-based straggler kill ──
  # `test-deploy.sh` captures $! from `npx tsx ...`, which is the npm-exec
  # wrapper — NOT the real `node --import tsx/loader.mjs` grandchild that
  # actually binds the port. When the wrapper exits early or SIGTERM doesn't
  # cascade, the grandchild orphans and keeps holding SLOT_PORT. Belt-and-
  # suspenders: whoever is LISTENING on SLOT_PORT gets SIGTERM → 2s → SIGKILL.
  # Narrow to `-sTCP:LISTEN` so client connections that happen to have a
  # local-or-remote port == SLOT_PORT are NOT swept up (Codex R5 #1).
  local SLOT_PORT=""
  # Defense-in-depth: SLOT_IDX negative-index guard. Change 0 above already
  # fail-fast on invalid SLOT; this keeps the block independently safe if ever
  # reused outside teardown_slot().
  if (( SLOT_IDX >= 0 )); then
    SLOT_PORT=$(jq -r ".slots[${SLOT_IDX}].bridgePort // empty" "$SLOTS_FILE" 2>/dev/null || true)
  fi
  if [[ -n "$SLOT_PORT" ]]; then
    local STRAGGLERS
    STRAGGLERS=$(lsof -nP -t -iTCP:"$SLOT_PORT" -sTCP:LISTEN 2>/dev/null | sort -u || true)
    if [[ -n "$STRAGGLERS" ]]; then
      log "Killing port stragglers on :${SLOT_PORT} (pids: $(echo "$STRAGGLERS" | tr '\n' ' '))"
      echo "$STRAGGLERS" | xargs kill 2>/dev/null || true
      sleep 2
      STRAGGLERS=$(lsof -nP -t -iTCP:"$SLOT_PORT" -sTCP:LISTEN 2>/dev/null | sort -u || true)
      if [[ -n "$STRAGGLERS" ]]; then
        log "Port :${SLOT_PORT} still bound, sending SIGKILL"
        echo "$STRAGGLERS" | xargs kill -9 2>/dev/null || true
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
    # FLY-115 fix (Defect #3a): macOS /bin/bash 3.2 has no `mapfile`. Use the
    # portable `while read` pattern; `|| [[ -n "$line" ]]` keeps any trailing
    # line without a final newline; empty lines are filtered.
    local SLOT_WORKTREES=()
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" ]] && continue
      SLOT_WORKTREES+=("$line")
    done < <(
      git -C "$HOST_REPO" worktree list --porcelain 2>/dev/null \
        | awk '/^worktree /{print $2}' \
        | grep -F "$SLOT_DIR/" || true
    )
    # v1.24.2 Gap 3.1: macOS /bin/bash 3.2 + set -u barfs `unbound variable` on
    # `"${arr[@]}"` when arr is empty. Guard the loop with an explicit length
    # check so zero-state teardown (no FLY-95 worktrees yet) still exits 0.
    if (( ${#SLOT_WORKTREES[@]} > 0 )); then
      local wt
      for wt in "${SLOT_WORKTREES[@]}"; do
        # Skip the host worktree itself — it is ${SLOT_DIR}/project-slot-${SLOT}
        # and is torn down when we rm -rf SLOT_DIR below.
        [[ "$wt" == "$HOST_REPO" ]] && continue
        log "  worktree remove --force ${wt}"
        git -C "$HOST_REPO" worktree remove --force "$wt" 2>/dev/null || true
        rm -rf "$wt"
      done
    fi

    # Delete slot-local branches: qa-slot-${SLOT}-* and any FLY-95 Runner
    # branches. It is a per-slot clone, so deletion has no cross-slot impact.
    log "Pruning local branches in ${HOST_REPO}"
    # FLY-115 fix (Defect #3a): portable replacement for `mapfile -t`.
    local LOCAL_BRANCHES=()
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" ]] && continue
      LOCAL_BRANCHES+=("$line")
    done < <(
      git -C "$HOST_REPO" for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null || true
    )
    # v1.24.2 Gap 3.1: same empty-array guard as above.
    if (( ${#LOCAL_BRANCHES[@]} > 0 )); then
      local b
      for b in "${LOCAL_BRANCHES[@]}"; do
        [[ "$b" == "main" || "$b" == "master" ]] && continue
        git -C "$HOST_REPO" branch -D "$b" 2>/dev/null || true
      done
    fi

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

  # FLY-115 fix: Prune ~/.claude.json trust entries written by
  # inject-linear-issue.sh so they don't accumulate and don't cause the
  # race-window jq write corruption seen in qa-fly-108.
  prune_trust_entries "/tmp/flywheel-test-slot-${SLOT}"

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
    # FLY-1189: a borrowed slot returns non-zero (guard above) — its lock is
    # released when the loop reaches the OWNER slot's manifest. Don't let one
    # refusal abort the sweep of the remaining slots.
    teardown_slot "$i" || log "WARN: slot ${i} teardown returned non-zero (borrowed lock or invalid slot) — continuing"
  done
  log "All slots torn down"
else
  teardown_slot "$TARGET"
fi

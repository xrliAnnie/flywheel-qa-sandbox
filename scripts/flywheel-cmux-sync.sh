#!/bin/bash
# flywheel-cmux-sync.sh — Sync flywheel tmux windows to cmux workspaces
# --once: full sync (tmux + cmux workspace management, with aggressive cleanup). Manual use.
# --watch: event-signaled polling (15s event drain + 60s additive scan). Must run from inside cmux.
# --refresh: tmux-only linked session repair. Safe to call from anywhere (no cmux socket needed).
#
# FLY-102: --watch uses event-signaled polling architecture:
#   - tmux hooks (after-new-window, pane-exited, pane-died, session-created)
#     write events to $EVENT_FILE
#   - watcher drains events every 15s and performs cmux operations
#   - additive-only polling (60s) creates missing workspaces, conservative cleanup (5min)
#   - hooks themselves never call cmux CLI (they lack cmux socket context)
# FLY-110: pane-died is the production-dominant cleanup signal — see
#   register_session_hooks() for why both pane-exited AND pane-died are needed.
set -euo pipefail

FLYWHEEL_SESSION="flywheel"
VIEW_PREFIX="cmux-"  # Linked session naming: cmux-<window_name>

# FLY-102: Event-signaled polling state files.
# Paths are overridable for tests (${VAR:-default} preserves pre-set values).
EVENT_FILE="${EVENT_FILE:-/tmp/flywheel-cmux-events}"
CLEANUP_PENDING="${CLEANUP_PENDING:-/tmp/flywheel-cmux-cleanup-pending}"
STALE_STATE="${STALE_STATE:-/tmp/flywheel-cmux-stale.state}"
# FLY-169: heal-state file — transition-only logging for attach self-heal.
# Deliberately SEPARATE from STALE_STATE (which drives conservative cleanup and
# is drained by stale-session paths). Mixing heal markers into STALE_STATE would
# get them drained immediately for live panes or misread as cleanup state.
HEAL_STATE="${HEAL_STATE:-/tmp/flywheel-cmux-heal.state}"
CLEANUP_DELAY_SECONDS="${FLYWHEEL_CMUX_CLEANUP_DELAY:-30}"
CONSERVATIVE_CLEANUP_SECONDS="${FLYWHEEL_CMUX_CONSERVATIVE_CLEANUP:-300}"

# FLY-825: create-vs-create dedup. drain_events()'s event-driven "create" branch
# and sync_additive()'s 60s missing-workspace scan can, within the SAME watch_loop
# tick (ticks where tick % 4 == 0 run both), each independently decide a
# workspace is "missing" for the same (window_name, window_id) and both call
# create_workspace_for_window — producing two cmux tabs attached to the same
# linked view_session (production repro 2026-07-03: `growth-mufasa-lead (@1210)`
# created twice, 1s apart, IDENTICAL window_id). Keyed by window_name|window_id
# (not window_name alone) so a genuine restart — same name, FRESH window_id — is
# never suppressed by this guard; only a true repeat call for the exact same
# window instance is skipped. This state file is process-local ground truth,
# independent of cmux's own workspace-list read consistency (a second JSON read
# cannot fix this — it can observe the same stale snapshot).
CREATE_STATE="${CREATE_STATE:-/tmp/flywheel-cmux-create.state}"

# FLY-293: orphan cmux workspace-pin reaper — grace state file (ref-keyed).
# Overridable for tests (${VAR:-default} preserves pre-set values).
ORPHAN_PIN_STATE="${ORPHAN_PIN_STATE:-/tmp/flywheel-cmux-orphan-pin.state}"

# FLY-685: close-request marker file. close_runner (Bridge, no cmux socket)
# appends a runner's window_name here on a successful window kill; the watcher
# drains it every tick and closes the matching workspace pin IMMEDIATELY (no
# grace) via the FLY-293 revalidating chokepoint. This is the fast path for the
# close_runner case (the FLY-293 reaper's 5-min grace still backstops abnormal
# death). MUST match `DEFAULT_CLOSE_REQUEST_FILE` in
# packages/teamlead/src/bridge/cmux-close-request.ts. Overridable for tests.
CLOSE_REQUEST_FILE="${FLYWHEEL_CMUX_CLOSE_REQUEST_FILE:-/tmp/flywheel-cmux-close-requested}"

# FLY-254: cmux app-reopen one-shot re-attach sweep.
# Generation state file — single line `<identity>|<state>|<attempts>`,
# state ∈ pending|done. identity = the cmux socket's filesystem identity
# (device:inode:birthtime); a change means a NEW cmux app instance bound the
# socket path (= app reopen). Durable across watcher restarts so watcher churn
# can never replay a consumed generation (Codex R1 HIGH-2 / R2 HIGH-1).
CMUX_SOCK_IDENT_FILE="${CMUX_SOCK_IDENT_FILE:-/tmp/flywheel-cmux-sock-ident}"
# Durable attempt budget per generation: first attempt + bounded crash resumes.
# Fixed constant, deliberately NOT env-tunable — the bound is a safety property
# (caps total focus disturbance even if `done` can never be persisted), not a
# knob (Codex R3 HIGH-1).
REOPEN_ATTEMPT_LIMIT=3

# FLY-129 Phase 1: single-watcher lock pushed down from autostart into sync script.
# Any path that starts --watch goes through the same lock; double-mutex protects
# the stale-lock reap from race conditions.
# Env override: FLYWHEEL_CMUX_WATCHER_LOCK_DIR for tests.
WATCHER_LOCK_DIR="${FLYWHEEL_CMUX_WATCHER_LOCK_DIR:-/tmp/flywheel-cmux-watcher.lock}"
WATCHER_REAP_MUTEX="${WATCHER_LOCK_DIR}.reap"

# FLY-177: when launched under launchd (plist sets FLYWHEEL_CMUX_SUPERVISED=1),
# a watcher that finds the lock held by a LIVE watcher blocks-waits to take over
# instead of `exit 0`. With KeepAlive=true a fast exit would respawn-churn every
# ThrottleInterval (FLY-129 forbids new periodic load); blocking keeps launchd's
# process as the steady-state owner without churn. Wait interval overridable for
# tests. The `.zshrc` autostart path leaves this unset → keeps fast exit 0.
SUPERVISED_WAIT_SECONDS="${FLYWHEEL_CMUX_SUPERVISED_WAIT:-15}"

# ── Functions ──

# FLY-129: log to stderr so callers in pipelines (e.g. `cmux_call list-workspaces | sed`)
# don't get diagnostics mixed into the data stream. autostart redirects both
# stdout and stderr to the log file, so on-disk log output is unchanged.
log() { echo "[cmux-sync $(date '+%H:%M:%S')] $*" >&2; }

# Path of cmux IPC socket. Override via $CMUX_SOCKET_PATH env (cmux's own convention).
CMUX_SOCKET_PATH_DEFAULT="${CMUX_SOCKET_PATH:-/tmp/cmux.sock}"

# FLY-129: Health-check cmux IPC. Distinguish:
#   rc=0  healthy (PONG)
#   rc=1  cmux not running (socket missing — recoverable, just wait)
#   rc=2  config issue, fatal (Access denied OR socket exists but kernel-level
#         permission denied / operation not permitted — caller can't connect
#         and never will until config changes)
#   rc=3  other transient error (socket present, non-fatal — warn, retry)
cmux_health_check() {
  local socket="${CMUX_SOCKET_PATH:-$CMUX_SOCKET_PATH_DEFAULT}"
  if [[ ! -S "$socket" ]]; then
    return 1
  fi
  local err_file out rc=0
  err_file=$(mktemp)
  # Pass --socket explicitly so override env actually reaches cmux CLI.
  out=$(cmux --socket "$socket" ping 2>"$err_file") || rc=$?
  local err_text
  err_text=$(cat "$err_file" 2>/dev/null || true)
  rm -f "$err_file"
  if [[ $rc -eq 0 && "$out" == *PONG* ]]; then
    return 0
  fi
  # Match against combined stdout + stderr: cmux may write the access-denied
  # message to either stream depending on protocol stage.
  local combined="${out}${err_text}"
  if grep -q "Access denied" <<<"$combined"; then
    log "ERROR: cmux IPC rejected by app — caller is not a cmux descendant and socketControlMode != allowAll"
    log "ERROR: stderr: ${err_text:-<empty>}"
    log "ERROR: To fix: defaults write com.cmuxterm.app socketControlMode -string allowAll && quit cmux app + relaunch"
    return 2
  fi
  # FLY-129 R2: kernel-level permission denial means socket exists but caller
  # can't open() it (wrong owner / mode 0600 by another user / SIP / etc.).
  # No amount of retrying will fix this — surface as fatal so the lock
  # releases instead of looping forever.
  if grep -qE "Permission denied|Operation not permitted" <<<"$combined"; then
    log "ERROR: cmux socket present at $socket but kernel denied open()"
    log "ERROR: stderr: ${err_text:-<empty>}"
    log "ERROR: Likely cause: socket owned by a different user, or socketControlMode=cmuxOnly with file mode 0600"
    log "ERROR: To fix: ls -l $socket; defaults write com.cmuxterm.app socketControlMode -string allowAll && quit cmux app + relaunch"
    return 2
  fi
  # FLY-129 Phase 7 (R2-2): do NOT log here per-tick. Stash the diagnostic
  # so cmux_health_check_or_die can include it in the ONE transition log
  # when state actually flips.
  CMUX_HEALTH_LAST_DIAG="rc=$rc out='${out}' err='${err_text}'"
  return 3
}

# FLY-129 Phase 7: gate helper used both at startup and every tick in
# watch_loop. State-machine logging — emits at most ONE line per state
# transition, not per tick. Returns:
#   0 — healthy (caller can run cmux operations)
#   2 — auth rejected (this function exits 1; never returns)
#   non-zero (1/3) — recoverable; caller should SKIP cmux operations this tick
cmux_health_check_or_die() {
  local rc=0
  cmux_health_check || rc=$?
  # rc=2 fatal — always log immediately (immediate-log preserved per R2-2);
  # exit 1 so the autostart EXIT trap releases the lock for the next watcher.
  if [[ $rc -eq 2 ]]; then
    log "FATAL: cmux IPC auth rejected — exiting so autostart lock releases for next cmux-pane-spawned watcher"
    exit 1
  fi

  local last="$CMUX_HEALTH_LAST_RC"
  if [[ $rc -eq 0 ]]; then
    # Healthy. If we were previously unhealthy, log recovery once.
    if [[ "$last" != "0" ]]; then
      local since="$CMUX_HEALTH_FAIL_SINCE"
      local now; now=$(date +%s)
      local for_s=0
      [[ -n "$since" ]] && for_s=$((now - since))
      log "INFO: cmux recovered after ${for_s}s (was rc=$last, $CMUX_HEALTH_FAIL_COUNT consecutive ticks)"
      CMUX_HEALTH_FAIL_SINCE=""
      CMUX_HEALTH_FAIL_COUNT=0
      CMUX_HEALTH_LAST_DIAG=""
      # FLY-169: cmux just came back. A restart while this watcher stayed alive
      # produces no tmux create/register event and no re-bootstrap, so any
      # workspace that landed as bare zsh would stay broken. Flag a one-shot
      # heal sweep for watch_loop to consume on this healthy tick.
      CMUX_HEAL_ON_RECOVERY=1
    fi
    CMUX_HEALTH_LAST_RC=0
    return 0
  fi

  # Unhealthy (rc=1 or rc=3). Log once on transition; stay silent on repeats.
  if [[ "$last" != "$rc" ]]; then
    CMUX_HEALTH_FAIL_SINCE=$(date +%s)
    CMUX_HEALTH_FAIL_COUNT=1
    case $rc in
      1) log "WARN: cmux socket missing — skipping cmux ops (will retry)" ;;
      3) log "WARN: cmux unhealthy — diag=${CMUX_HEALTH_LAST_DIAG:-<empty>}" ;;
    esac
  else
    CMUX_HEALTH_FAIL_COUNT=$((CMUX_HEALTH_FAIL_COUNT + 1))
  fi
  CMUX_HEALTH_LAST_RC="$rc"
  return $rc
}

# FLY-129 Phase 7: backoff curve. Healthy ticks pay 15s; the longer we've
# been unhealthy, the longer the sleep. Capped at 300s so a long outage
# doesn't push us past a Lead-restart's "tick" expectation by an hour.
next_sleep_seconds() {
  local count="${1:-0}"
  if (( count <= 1 )); then
    echo 15
  elif (( count <= 5 )); then
    echo 30
  elif (( count <= 10 )); then
    echo 60
  else
    echo 300
  fi
}

# FLY-129: wrap cmux call so stderr goes to log (via stderr, not /dev/null).
# Returns cmux's exit code; **stdout passthrough preserved** for callers in
# pipelines (e.g. `cmux_call list-workspaces | sed`).
# Honors $CMUX_SOCKET_PATH override so health-check + sync ops talk to the
# same socket.
cmux_call() {
  local socket="${CMUX_SOCKET_PATH:-$CMUX_SOCKET_PATH_DEFAULT}"
  local err_file rc=0
  err_file=$(mktemp)
  cmux --socket "$socket" "$@" 2>"$err_file" || rc=$?
  if [[ $rc -ne 0 ]]; then
    local err_text
    err_text=$(cat "$err_file" 2>/dev/null || true)
    log "WARN: cmux $1 failed (rc=$rc): ${err_text:-<empty>}"
  fi
  rm -f "$err_file"
  return $rc
}

# FLY-254 (Codex CR R5 HIGH-1): guarded cmux wrapper for escalated mutations.
# cmux_call's first action is an external `mktemp` — caller-side final guards
# therefore left a bookkeeping window between the last check and the actual
# cmux invocation (a reopen or client-attach in that window crossed the
# generation budget or bypassed the final 0-client send guard). Here the temp
# file is prepared FIRST and the caller-supplied guard function runs as the
# GENUINE last operation before `cmux` — no subprocess, no bookkeeping in
# between. Guard contract: return 0 to proceed; non-zero blocks the call (set
# GUARD_BLOCK_RC for the caller's skip/healed distinction). Blocked-ness is
# signalled via the GUARD_WAS_BLOCKED side channel — NOT an exit-code
# sentinel, which a real cmux exit code could collide with (Codex CR R6 LOW).
# rc is cmux's own rc when the call ran; rc=1 + GUARD_WAS_BLOCKED=1 when the
# guard blocked. The plain cmux_call above is untouched (feature-off paths
# byte-identical).
GUARD_BLOCK_RC=0
GUARD_WAS_BLOCKED=0
cmux_call_guarded() {
  local guard_fn="$1"; shift
  local socket="${CMUX_SOCKET_PATH:-$CMUX_SOCKET_PATH_DEFAULT}"
  local err_file rc=0 guard_rc=0
  GUARD_WAS_BLOCKED=0
  err_file=$(mktemp) || return 1
  "$guard_fn" || guard_rc=$?
  if [[ $guard_rc -ne 0 ]]; then
    rm -f "$err_file"
    GUARD_WAS_BLOCKED=1
    return 1
  fi
  cmux --socket "$socket" "$@" 2>"$err_file" || rc=$?
  if [[ $rc -ne 0 ]]; then
    local err_text
    err_text=$(cat "$err_file" 2>/dev/null || true)
    log "WARN: cmux $1 failed (rc=$rc): ${err_text:-<empty>}"
  fi
  rm -f "$err_file"
  return $rc
}

# FLY-254 guard: generation pin only (focus/restore mutations). Sets the
# HEAL_GEN_CHANGED latch on mismatch. Runs inside cmux_call_guarded — the
# last operation before the select-workspace mutation.
_heal_focus_gen_guard() {
  GUARD_BLOCK_RC=0
  if [[ -n "${HEAL_SWEEP_GEN_IDENT:-}" ]]; then
    local gi
    gi=$(cmux_socket_identity)
    if [[ "$gi" != "$HEAL_SWEEP_GEN_IDENT" ]]; then
      HEAL_GEN_CHANGED=1
      GUARD_BLOCK_RC=1
      return 1
    fi
  fi
  return 0
}

# FLY-254 guard: generation pin + FINAL 0-client check (escalated send).
# Target view session is passed via _GUARD_VIEW_SESSION (bash has no
# closures). GUARD_BLOCK_RC: 1 = fail-closed; 2 = client appeared (healed).
_GUARD_VIEW_SESSION=""
_heal_send_final_guard() {
  GUARD_BLOCK_RC=0
  if [[ -n "${HEAL_SWEEP_GEN_IDENT:-}" ]]; then
    local gi
    gi=$(cmux_socket_identity)
    if [[ "$gi" != "$HEAL_SWEEP_GEN_IDENT" ]]; then
      HEAL_GEN_CHANGED=1
      GUARD_BLOCK_RC=1
      return 1
    fi
  fi
  local c
  if ! c=$(view_session_client_count "$_GUARD_VIEW_SESSION"); then
    GUARD_BLOCK_RC=1
    return 1
  fi
  if [[ "$c" -gt 0 ]]; then
    GUARD_BLOCK_RC=2
    return 1
  fi
  return 0
}

get_tmux_agent_windows() {
  # Returns: session_name|window_id|window_name per line
  # Scans both 'flywheel' (Leads) and 'runner-*' (Runners) sessions.
  # Excludes default shell windows (zsh/bash).
  local all_windows=""

  # 1. Flywheel session (Leads)
  all_windows+=$(tmux list-windows -t "$FLYWHEEL_SESSION" -F "#{session_name}|#{window_id}|#{window_name}" 2>/dev/null || true)

  # 2. Runner sessions: runner-<projectName> (e.g., runner-geoforge3d)
  local runner_sessions
  runner_sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^runner-' || true)
  if [[ -n "$runner_sessions" ]]; then
    while read -r rsess; do
      local rwindows
      rwindows=$(tmux list-windows -t "$rsess" -F "#{session_name}|#{window_id}|#{window_name}" 2>/dev/null || true)
      if [[ -n "$rwindows" ]]; then
        all_windows+=$'\n'"$rwindows"
      fi
    done <<< "$runner_sessions"
  fi

  # Filter out default shell windows
  echo "$all_windows" | grep -v '|zsh$' | grep -v '|bash$' | grep -v '^$' || true
}

get_cmux_workspaces() {
  # DEPRECATED (FLY-129 Phase 3): returns the legacy text format from cmux.
  # New code MUST use get_cmux_workspaces_json. This is retained only as a
  # safety net for any path that depends on the text parse. No new code paths
  # should reference this. FLY-129 follow-up: delete once Phase 3 has soaked.
  cmux_call list-workspaces || true
}

# FLY-129 Phase 3 (R2-1, R3-1): JSON-based cmux workspace state.
#
# Module-level state — track JSON-health transition so we emit ONE log line
# on first failure and ONE on recovery, instead of spamming every 15s tick
# while cmux is down. Reset per `source` (so unit tests start clean).
CMUX_JSON_LAST_STATE="${CMUX_JSON_LAST_STATE:-unknown}"  # unknown|ok|fail

# FLY-129 Phase 7 (scope #7, R2-2): cmux ping health-check transition log.
# cmux_health_check itself MUST NOT log rc=3 transients — the previous
# inline `log "WARN: cmux ping failed transiently..."` line printed once
# per 15s tick even while the rc=3 state was stable. Transition logging
# now lives ONLY in cmux_health_check_or_die's state machine below.
CMUX_HEALTH_LAST_RC="${CMUX_HEALTH_LAST_RC:-0}"     # 0/1/3 — last observed health rc
CMUX_HEALTH_FAIL_SINCE=""                            # epoch when state last entered non-zero
CMUX_HEALTH_FAIL_COUNT="${CMUX_HEALTH_FAIL_COUNT:-0}"  # consecutive non-zero ticks (for backoff)
CMUX_HEALTH_LAST_DIAG=""                             # last probe stderr (reported in transition log)

# FLY-169: set to 1 on the cmux unhealthy→healthy transition (in
# cmux_health_check_or_die); consumed ONCE by watch_loop to run a one-shot
# self_heal_sweep_all. Event-driven (on recovery), NOT an idle poll — covers
# a cmux restart while the same watcher process stays alive (no tmux event,
# no re-bootstrap).
CMUX_HEAL_ON_RECOVERY="${CMUX_HEAL_ON_RECOVERY:-0}"

# FLY-254: render-escalation + reopen-generation state (in-process).
# HEAL_RENDER_ESCALATE is set ONLY by consume_pending_reopen_sweep around the
# one escalated sweep — every other heal path keeps FLY-169 behavior verbatim.
HEAL_RENDER_ESCALATE="${HEAL_RENDER_ESCALATE:-0}"
HEAL_FOCUS_SNAPSHOT_OK=0    # 1 ⟺ exactly one legal selected ref was snapshotted
HEAL_FOCUS_CHANGED=0        # 1 ⟺ this sweep performed at least one select-workspace
HEAL_USER_INTERVENED=0      # 1 ⟺ user took focus mid-sweep → stop + never restore
HEAL_ORIG_SELECTED=""       # selected ref snapshotted before the first focus
HEAL_EXPECTED_SELECTED=""   # what selected SHOULD be now (orig, then last forced)
HEAL_LAST_FORCED_REF=""     # last ref WE focused (epilogue restore guard)
REOPEN_GEN_IDENT=""         # parsed generation file fields (read_generation_state)
REOPEN_GEN_STATE=""
REOPEN_GEN_ATTEMPTS=""
REOPEN_CONSUMED_THIS_TICK=0 # 1 ⟺ consume ran an escalated sweep this tick
# Codex CR R1 M6: in-process mirror of the generation file so the healthy
# steady state pays exactly ONE stat per tick (no per-tick file reads). Kept
# in sync by read_generation_state / write_generation_state; consume is only
# entered while the cache says pending.
REOPEN_CACHE_IDENT=""
REOPEN_CACHE_STATE=""
# Codex CR R1 HIGH-2: identity pinned for an escalated sweep's duration; every
# focus mutation re-verifies the app instance hasn't changed mid-sweep.
HEAL_SWEEP_GEN_IDENT=""
# Codex CR R2 HIGH-1: generation-changed latch. The pre-focus pin check alone
# leaves a window — the identity can flip DURING the render wait, after which
# gates run against the NEW app and the send/restore would land there,
# uncharged to its budget. The latch is set wherever a mismatch is observed
# (post-render-wait, immediately before send, epilogue) and blocks ALL
# remaining sends, focus mutations and the restore.
HEAL_GEN_CHANGED=0

get_cmux_workspaces_json() {
  # Returns raw `cmux --json list-workspaces` output on stdout, rc=0.
  # On any failure (rc!=0 OR invalid JSON) returns NON-ZERO with empty stdout
  # and emits a single transition log. Callers MUST distinguish rc=0 from
  # rc≠0 — they MUST NOT treat empty stdout as "no workspaces" because that
  # would race cmux mutations during JSON outages.
  #
  # Why not use cmux_call: cmux_call logs WARN on every failure. We want
  # transition-only logging to keep the watcher quiet during sustained
  # cmux-down windows.
  local socket="${CMUX_SOCKET_PATH:-$CMUX_SOCKET_PATH_DEFAULT}"
  local err_file raw rc=0
  err_file=$(mktemp)
  raw=$(cmux --socket "$socket" --json list-workspaces 2>"$err_file") || rc=$?
  local err_text
  err_text=$(cat "$err_file" 2>/dev/null || true)
  rm -f "$err_file"

  if [[ $rc -ne 0 ]]; then
    if [[ "$CMUX_JSON_LAST_STATE" != "fail" ]]; then
      log "WARN: cmux --json list-workspaces failed (rc=$rc): ${err_text:-<empty>} — cmux mutation skipped"
      CMUX_JSON_LAST_STATE="fail"
    fi
    return 1
  fi
  # Codex R1 MEDIUM: parse alone is not enough. A degenerate response like
  # `{}` or `{"error":"..."}` parses fine but lacks the `workspaces` array,
  # which would let downstream helpers treat "no workspaces" as truth and
  # blindly create workspaces. Require the schema shape we depend on.
  if ! printf '%s' "$raw" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not isinstance(d, dict) or not isinstance(d.get("workspaces"), list):
    sys.exit(1)
' >/dev/null 2>&1; then
    if [[ "$CMUX_JSON_LAST_STATE" != "fail" ]]; then
      log "WARN: cmux --json list-workspaces returned invalid JSON or missing 'workspaces' array — cmux mutation skipped"
      CMUX_JSON_LAST_STATE="fail"
    fi
    return 1
  fi
  if [[ "$CMUX_JSON_LAST_STATE" == "fail" ]]; then
    log "INFO: cmux --json list-workspaces recovered"
  fi
  CMUX_JSON_LAST_STATE="ok"
  printf '%s' "$raw"
}

workspace_refs_for() {
  # Tri-state (R3-1):
  #   rc=0 + stdout = one ref per line for workspaces whose title matches $1
  #     (empty stdout when no match — distinguishable from rc=2 by exit code)
  #   rc=2 + empty stdout = JSON unavailable. Callers MUST NOT treat this as
  #     "not found" — doing so would race a cmux mutation during a JSON outage.
  # The two-step form `raw=$(get_cmux_workspaces_json) || return 2` keeps
  # rc=2 visible to the caller; piping directly into python via `set -o
  # pipefail` would swallow the get_cmux_workspaces_json failure signal.
  local name="$1" raw
  raw=$(get_cmux_workspaces_json) || return 2
  printf '%s' "$raw" | python3 -c '
import sys, json
name = sys.argv[1]
for w in json.load(sys.stdin).get("workspaces", []):
    if w.get("title") == name:
        ref = w.get("ref", "")
        if ref:
            print(ref)
' "$name"
}

workspace_exists_for() {
  # Tri-state (R3-1):
  #   rc=0  workspace with title $1 exists
  #   rc=1  workspace with title $1 does NOT exist
  #   rc=2  JSON unavailable — caller MUST NOT treat as rc=1
  local name="$1" refs
  refs=$(workspace_refs_for "$name") || return 2
  [[ -n "$refs" ]] && return 0
  return 1
}

get_workspace_ref_for() {
  # Backward-compat shim — returns first matching ref. NOT safe as a
  # mutation gate because it cannot distinguish "not found" from "JSON
  # unavailable" (both produce empty stdout). Mutation callers (cleanup /
  # reconcile / create) MUST call workspace_refs_for directly and check $?.
  workspace_refs_for "$1" | head -1
}

get_all_workspace_refs() {
  # Tri-state — rc=2 on JSON failure, empty stdout. Read-only callers may
  # treat empty stdout as "no workspaces"; mutation callers must check rc.
  local raw
  raw=$(get_cmux_workspaces_json) || return 2
  printf '%s' "$raw" | python3 -c '
import sys, json
for w in json.load(sys.stdin).get("workspaces", []):
    ref = w.get("ref", "")
    if ref:
        print(ref)
' | sort
}

get_ghost_workspace_refs() {
  # Tri-state — rc=2 on JSON failure. Returns refs whose title is missing
  # (null / empty / legacy "~" tilde-placeholder). Phase 4 ghost reaper
  # uses this; mutation callers MUST check rc.
  local raw
  raw=$(get_cmux_workspaces_json) || return 2
  printf '%s' "$raw" | python3 -c '
import sys, json
for w in json.load(sys.stdin).get("workspaces", []):
    title = w.get("title")
    if title is None or title == "" or title == "~":
        ref = w.get("ref", "")
        if ref:
            print(ref)
'
}

close_workspace_by_ref() {
  # Single chokepoint for all cmux workspace closes. Audit log per call;
  # FLYWHEEL_CMUX_DRY_RUN=1 short-circuits the actual cmux call but still
  # logs (so a dry-run inspection still shows what would have happened).
  #
  # FLY-685 (Codex code R1 MED): records the actual cmux close rc in the global
  # LAST_WORKSPACE_CLOSE_RC (0 = closed / dry-run). The function itself still
  # ALWAYS returns 0 — the `|| true` semantics existing callers (ghost reaper,
  # dedup, cleanup_workspace_for) rely on under `set -euo pipefail` are
  # unchanged. Only close_orphan_workspace_pin_if_still_orphan reads the global,
  # so it can distinguish a swallowed cmux close FAILURE from a real close and
  # requeue the close-request marker instead of silently dropping it.
  local ws_ref="$1" reason="$2"
  local dry="${FLYWHEEL_CMUX_DRY_RUN:-0}"
  log "[audit] close workspace=$ws_ref reason=$reason dry_run=$dry"
  LAST_WORKSPACE_CLOSE_RC=0
  [[ "$dry" == "1" ]] && return 0
  cmux_call close-workspace --workspace "$ws_ref" || LAST_WORKSPACE_CLOSE_RC=$?
  return 0
}

# FLY-129 Phase 4 (scope #3): periodic ghost reaper.
# A "ghost" workspace is one whose title is null / empty / legacy "~".
# In production we've seen up to 26 of these accumulate. Reaping removes
# the visible clutter and frees Electron-side surface state.
# Fail-closed: rc=2 on the JSON gate → return 0 (next tick retries).
reap_ghost_workspaces() {
  local refs
  refs=$(get_ghost_workspace_refs) || return 0  # JSON unavailable → skip
  [[ -z "$refs" ]] && return 0
  while read -r ref; do
    [[ -z "$ref" ]] && continue
    close_workspace_by_ref "$ref" "ghost-reaper"
  done <<< "$refs"
}

# FLY-129 Phase 6 (scope #2, R2-6): periodic dedup of workspaces with the
# same title. Tie-breaker (highest priority kept):
#   1. pinned (if cmux JSON exposes the field)
#   2. selected
#   3. highest workspace:N number (cmux ID is monotonically increasing
#      and not reused, so the newest is the most likely live one — the
#      stale UI-cache copy is typically the older ID)
# Refs that don't match ^workspace:\d+$ are prefixed with "SKIP " on stdout
# so they're logged (not closed) — avoids taking a destructive action on
# a malformed entry.
dedup_workspaces_by_title() {
  local raw
  raw=$(get_cmux_workspaces_json) || return 0  # JSON unavailable → skip

  # Python emits two kinds of stdout lines:
  #   "SKIP <ref> <title>"  → malformed ref; log + skip
  #   "<ref>"               → close (loser in the dedup group)
  local plan
  plan=$(printf '%s' "$raw" | python3 -c '
import sys, json, re
data = json.load(sys.stdin)
ws = data.get("workspaces", [])
by_title = {}
for w in ws:
    title = w.get("title")
    ref = w.get("ref", "")
    if not title or not ref:
        continue
    by_title.setdefault(title, []).append(w)

REF_RE = re.compile(r"^workspace:(\d+)$")

for title, group in by_title.items():
    if len(group) < 2:
        continue
    valid = []
    for w in group:
        if REF_RE.match(w.get("ref", "")):
            valid.append(w)
        else:
            print("SKIP " + w.get("ref", "") + " " + title)
    if len(valid) < 2:
        continue
    def key(w):
        n = int(REF_RE.match(w["ref"]).group(1))
        return (
            1 if w.get("pinned") else 0,
            1 if w.get("selected") else 0,
            n,
        )
    valid.sort(key=key)
    for w in valid[:-1]:
        print(w["ref"])
') || return 0
  [[ -z "$plan" ]] && return 0
  while read -r line; do
    [[ -z "$line" ]] && continue
    if [[ "$line" == SKIP\ * ]]; then
      log "WARN: dedup skipping malformed ref: ${line#SKIP }"
      continue
    fi
    close_workspace_by_ref "$line" "dedup-newest-wins"
  done <<< "$plan"
}

# ── FLY-293: orphan cmux workspace-pin reaper ──
#
# Problem (root cause): `close_runner` (FLY-638) kills the per-runner
# `cmux-<window_name>` linked session AND the source tmux window on close, but
# never closes the cmux WORKSPACE object (the sidebar pin). The event-driven
# cleanup (`window-unlinked` → mark_for_cleanup → cleanup_workspace_for) is the
# ONLY thing that closes such a pin — and it is a fragile one-shot. Both periodic
# fallbacks are anchor-dependent: cleanup_stale_conservative iterates existing
# `cmux-*` linked sessions, reconcile_existing_workspaces iterates existing
# SOURCE windows. A pin whose linked session AND source window are BOTH gone is
# invisible to both → any missed event leaves it forever. Over time these
# accumulate (prod: 47 workspaces / 18 live sessions → ~29 orphaned pins).
#
# This reaper is the anchor-independent backstop: it closes a workspace pin whose
# tmux backing is FULLY gone — with a managed-title gate + strict-tmux fail-closed
# so it can NEVER close a live Lead, a live runner, a remain-on-exit dead-pin
# (FLY-720 owns those), or a founder's personal cmux tab.

# is_managed_runner_title <title> — rc 0 iff the title is a Flywheel runner
# window name the CURRENT producer can emit. Producer contract:
# `buildWindowLabel(issueId, runnerName, title)` = "{issueId}-{runner}-{title}"
# (packages/core/src/tmux-naming.ts). `runnerName` is `runnerDisplayName(sessionRole)`
# (packages/teamlead/src/bridge/run-dispatcher.ts): non-phase runs emit "claude"
# (every executor backend — claude/codex/antigravity/kimi — still emits "-claude-"),
# and FLY-793 three-stage PHASE runners emit their phase ("-design-"/"-implement-"/
# "-qa-") so the founder can see the live phase in cmux. So the producible runner
# label is EXACTLY one of `claude|design|implement|qa`.
# COUPLING: if runnerName ever gains another producible value, extend the
# alternation here (and test-cmux-sync.sh) in lockstep. Deliberately excludes
# vendor names (codex/gemini/cursor/kimi/agy — not producible today → not provably
# managed) and Lead windows ("<project>-<lead>", never a close_runner target).
is_managed_runner_title() {
  local re='^[A-Z][A-Z0-9]*-[0-9]+-(claude|design|implement|qa)(-|$)'
  [[ "$1" =~ $re ]]
}

# collect_agent_window_names_strict <sessions_snapshot> — print live agent window
# names (flywheel Leads + runner-* Runners, minus default zsh/bash windows).
# STRICT / fail-closed (FLY-293, Codex R1 HIGH-2): any `tmux list-windows`
# failure for a snapshot session → rc=2 (uncertain → caller MUST skip). Takes the
# already-captured session snapshot so we never re-issue `list-sessions`
# (single-snapshot consistency, Codex R2 LOW-1). Empty stdout + rc=0 = genuinely
# no agent windows (safe to act on).
collect_agent_window_names_strict() {
  local snapshot="$1"
  local out="" sess w
  while IFS= read -r sess; do
    [[ -z "$sess" ]] && continue
    case "$sess" in
      flywheel|runner-*) ;;
      *) continue ;;
    esac
    w=$(tmux list-windows -t "$sess" -F "#{session_name}|#{window_id}|#{window_name}" 2>/dev/null) || return 2
    [[ -n "$w" ]] && out+="$w"$'\n'
  done <<< "$snapshot"
  printf '%s' "$out" | grep -v '|zsh$' | grep -v '|bash$' | grep -v '^$' | cut -d'|' -f3 || true
  return 0
}

# orphan_pin_refs — print "<ref>\t<title>" for every cmux workspace that is a
# fully-orphaned managed runner pin. Tri-state fail-closed:
#   rc=2 (empty stdout) — cmux JSON OR tmux inventory unavailable. Callers MUST
#     NOT treat as "no orphans" (that would race a mutation on stale state).
#   rc=0 — stdout is the (possibly empty) orphan set.
# Predicate (all required): (a) title non-empty & not "~"; (b0) managed-runner
# title; (c) NO same-name live agent window (dead or alive — a remain-on-exit
# dead-pin window still counts as present, keeping FLY-720's boundary intact);
# (d) NO `cmux-<title>` linked session.
orphan_pin_refs() {
  local raw sessions agent_names pairs
  raw=$(get_cmux_workspaces_json) || return 2
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null) || return 2
  agent_names=$(collect_agent_window_names_strict "$sessions") || return 2
  pairs=$(printf '%s' "$raw" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for w in d.get("workspaces", []):
    ref = w.get("ref", "")
    title = w.get("title")
    if not ref or title is None:
        continue
    if "\t" in title or "\n" in title:
        continue
    sys.stdout.write(ref + "\t" + title + "\n")
') || return 2
  local ref title
  while IFS=$'\t' read -r ref title; do
    [[ -z "$ref" || -z "$title" ]] && continue
    [[ "$title" == "~" ]] && continue
    is_managed_runner_title "$title" || continue
    if printf '%s\n' "$agent_names" | grep -qxF "$title"; then continue; fi
    if printf '%s\n' "$sessions" | grep -qxF "cmux-${title}"; then continue; fi
    printf '%s\t%s\n' "$ref" "$title"
  done <<< "$pairs"
  return 0
}

# close_orphan_workspace_pin_if_still_orphan <ref> <title> — THE single close
# chokepoint for orphan pins (periodic AND one-shot). Re-reads cmux JSON + strict
# tmux inventory RIGHT BEFORE the close and re-checks the FULL predicate against
# the specific ref (Codex R1 MED-4 / R2: closes the derive→close TOCTOU without a
# global lock).
#   rc 0 = closed.
#   rc 1 = PREDICATE skip (ref malformed / gone / title drift / non-managed /
#          same-name live window / linked session still present) — a trustworthy
#          "do NOT close this ref" decision.
#   rc 2 = UNCERTAIN (FLY-685): cmux JSON / tmux inventory / parse read failed, so
#          the predicate could NOT be evaluated. Callers that requeue on transient
#          failure (process_close_requests) MUST distinguish this from rc 1 —
#          requeueing a predicate skip would let an old close marker outlive a
#          same-title restarted runner. Existing FLY-293 callers
#          (reap_orphan_workspace_pins / reap_orphan_pins_oneshot) branch only on
#          shell success vs non-zero, so rc 2 is behavior-compatible for them.
close_orphan_workspace_pin_if_still_orphan() {
  local ref="$1" want_title="$2"
  if [[ ! "$ref" =~ ^workspace:[0-9]+$ ]]; then
    log "WARN: orphan-pin skip malformed ref: $ref"
    return 1
  fi
  local raw sessions agent_names cur_title
  raw=$(get_cmux_workspaces_json) || return 2                        # FLY-685: uncertain
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null) || return 2  # FLY-685: uncertain
  agent_names=$(collect_agent_window_names_strict "$sessions") || return 2     # FLY-685: uncertain
  cur_title=$(printf '%s' "$raw" | python3 -c '
import sys, json
ref = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for w in d.get("workspaces", []):
    if w.get("ref") == ref:
        t = w.get("title")
        if t is not None:
            sys.stdout.write(t)
        break
' "$ref") || return 2                                                # FLY-685: parse uncertain
  [[ -z "$cur_title" ]] && return 1                # ref gone from cmux
  [[ "$cur_title" != "$want_title" ]] && return 1  # title drifted → not the pin we vetted
  is_managed_runner_title "$cur_title" || return 1
  if printf '%s\n' "$agent_names" | grep -qxF "$cur_title"; then return 1; fi
  if printf '%s\n' "$sessions" | grep -qxF "cmux-${cur_title}"; then return 1; fi
  close_workspace_by_ref "$ref" "orphan-pin-${cur_title}"
  # FLY-685 (Codex code R1 MED): close_workspace_by_ref swallows cmux close
  # failures (|| true) and records the real rc in LAST_WORKSPACE_CLOSE_RC. A
  # swallowed failure means the pin is NOT actually closed — return rc=2
  # (uncertain) so the close-request path REQUEUES (and the FLY-293 reaper keeps
  # its grace row) instead of dropping the marker and silently falling back to
  # the 5-min reaper. rc=0 only on a confirmed close.
  [[ "${LAST_WORKSPACE_CLOSE_RC:-0}" -ne 0 ]] && return 2
  return 0
}

# reap_orphan_workspace_pins — periodic reaper (called from sync_additive /
# sync_once). ref-keyed grace (Codex R1 HIGH-3): a pin must stay orphaned for
# FLYWHEEL_CMUX_ORPHAN_PIN_GRACE seconds before it is closed (guards against a
# just-created workspace whose linked session/rename momentarily lags). Every
# close goes through the revalidating chokepoint. Kill-switch
# FLYWHEEL_CMUX_ORPHAN_REAPER=0 → fully inert (Codex R1 MED-5, byte-compat).
reap_orphan_workspace_pins() {
  [[ "${FLYWHEEL_CMUX_ORPHAN_REAPER:-1}" == "0" ]] && return 0
  # Codex R1 (code) MED-1: validate grace is all-digits BEFORE arithmetic. Under
  # `set -euo pipefail`, a non-numeric operand in (( )) is treated as a variable
  # ref and `set -u` turns it into a fatal "unbound variable" that kills the
  # watcher. Non-numeric env / bad constant → fall back to a literal default.
  local grace="${FLYWHEEL_CMUX_ORPHAN_PIN_GRACE:-$CONSERVATIVE_CLEANUP_SECONDS}"
  case "$grace" in ''|*[!0-9]*) grace=300 ;; esac
  # Codex R2 (code) MED: lexical length cap BEFORE arithmetic (mirrors
  # validated_int_env). An all-digit but huge value overflows bash 3.2's 64-bit
  # arithmetic and can wrap to bypass grace. 5 digits (≤99999s ≈ 27h) is far more
  # than any sane grace and cannot overflow.
  [[ ${#grace} -gt 5 ]] && grace=300
  local refs
  refs=$(orphan_pin_refs) || return 0   # rc=2 (cmux/tmux unavailable) → skip this pass
  touch "$ORPHAN_PIN_STATE" 2>/dev/null || true
  local now; now=$(date +%s)
  local closed_any=0 keep="" ref title first tb64
  while IFS=$'\t' read -r ref title; do
    [[ -z "$ref" ]] && continue
    first=$(awk -F'|' -v r="$ref" '$1==r{print $2; exit}' "$ORPHAN_PIN_STATE" 2>/dev/null || true)
    # Codex R1 (code) MED-1: a corrupt state row (non-numeric first_seen) must not
    # reach arithmetic. Treat a missing/malformed clock as first-seen (self-heals
    # the row) — never feed it to (( )).
    case "$first" in ''|*[!0-9]*) first="" ;; esac
    # Codex R2 (code) MED: length cap — an all-digit but huge first_seen (e.g. a
    # corrupt/ms row) overflows 64-bit arithmetic and can wrap into the close
    # branch, defeating grace. A real epoch is ≤10 digits; >12 = implausible →
    # treat as first-seen (re-clock), never let it reach (( )).
    [[ -n "$first" && ${#first} -gt 12 ]] && first=""
    tb64=$(printf '%s' "$title" | base64 | tr -d '\n')
    if [[ -z "$first" ]]; then
      keep+="${ref}|${now}|${tb64}"$'\n'            # first seen orphaned → start grace clock
    elif (( now - 10#$first >= grace )); then       # 10# forces base-10 (no octal on leading-zero ts)
      if close_orphan_workspace_pin_if_still_orphan "$ref" "$title"; then
        closed_any=1                                # closed → drop from state
      else
        keep+="${ref}|${first}|${tb64}"$'\n'        # revalidation blocked → keep waiting
      fi
    else
      keep+="${ref}|${first}|${tb64}"$'\n'          # still within grace → keep original ts
    fi
  done <<< "$refs"
  # Codex R1 (code) MED-2: fail-closed on an unwritable state path. A bare
  # `printf > "$ORPHAN_PIN_STATE"` on an unwritable path (e.g. broken /tmp) exits
  # the watcher under `set -e`. This automatic path must degrade to "grace not
  # persisted this tick" (safe — nothing is wrongly closed), never kill --watch.
  printf '%s' "$keep" > "$ORPHAN_PIN_STATE" 2>/dev/null || true
  if [[ "$closed_any" == "1" ]]; then
    cmux_call refresh-surfaces || true             # best-effort repaint (not a safety condition)
  fi
  return 0
}

# gc_orphan_pin_state_file — watcher-startup GC: drop grace rows whose ref no
# longer exists in cmux (leaked by a previous watcher). Env-gated so the OFF path
# is byte-compatible (Codex R1 MED-5). JSON unavailable → skip (keep state).
gc_orphan_pin_state_file() {
  [[ "${FLYWHEEL_CMUX_ORPHAN_REAPER:-1}" == "0" ]] && return 0
  [[ -f "$ORPHAN_PIN_STATE" ]] || return 0
  local raw live_refs tmp ref ts tb64
  raw=$(get_cmux_workspaces_json) || return 0
  live_refs=$(printf '%s' "$raw" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for w in d.get("workspaces", []):
    r = w.get("ref", "")
    if r:
        print(r)
' 2>/dev/null || true)
  tmp=$(mktemp "${ORPHAN_PIN_STATE}.XXXX" 2>/dev/null) || return 0
  while IFS='|' read -r ref ts tb64; do
    [[ -z "$ref" ]] && continue
    if printf '%s\n' "$live_refs" | grep -qxF "$ref"; then
      printf '%s|%s|%s\n' "$ref" "$ts" "$tb64" >> "$tmp"
    fi
  done < "$ORPHAN_PIN_STATE"
  # Codex R1 (code) MED-2: best-effort atomic swap; an unwritable path must not
  # abort the watcher at startup under `set -e`.
  mv "$tmp" "$ORPHAN_PIN_STATE" 2>/dev/null || { rm -f "$tmp" 2>/dev/null || true; return 0; }
}

# list_orphan_pins — read-only operator preview (--list-orphan-pins). Prints the
# orphan set the reaper would target; NEVER closes anything. Q1 dry-run.
list_orphan_pins() {
  local refs
  if ! refs=$(orphan_pin_refs); then
    echo "orphan-pin list unavailable (cmux JSON or tmux inventory not ready)" >&2
    return 1
  fi
  if [[ -z "$refs" ]]; then
    echo "No orphan cmux runner pins."
    return 0
  fi
  echo "Orphan cmux runner pins (managed title, no live window, no cmux-<title> session):"
  local ref title
  while IFS=$'\t' read -r ref title; do
    [[ -z "$ref" ]] && continue
    printf '  %s\t%s\n' "$ref" "$title"
  done <<< "$refs"
  return 0
}

# reap_orphan_pins_oneshot — operator one-shot immediate cleanup
# (--reap-orphan-pins). Re-derives the orphan set NOW, closes each through the
# revalidating chokepoint (NO grace — explicit operator action, same immediacy as
# --once). Safe to run alongside a live --watch (narrow + idempotent + per-ref
# final revalidation), so it does NOT take the --once watcher-running guard.
reap_orphan_pins_oneshot() {
  local refs
  if ! refs=$(orphan_pin_refs); then
    echo "orphan-pin reap skipped (cmux JSON or tmux inventory not ready)" >&2
    return 1
  fi
  if [[ -z "$refs" ]]; then
    echo "No orphan cmux runner pins to reap."
    return 0
  fi
  local closed_any=0 ref title
  while IFS=$'\t' read -r ref title; do
    [[ -z "$ref" ]] && continue
    if close_orphan_workspace_pin_if_still_orphan "$ref" "$title"; then
      closed_any=1
      echo "reaped orphan pin: $ref ($title)"
    fi
  done <<< "$refs"
  if [[ "$closed_any" == "1" ]]; then
    cmux_call refresh-surfaces || true
  fi
  return 0
}

# ── FLY-685: close_runner fast-path pin removal ──
#
# close_runner (Bridge, no cmux socket) appends a runner's window_name to
# $CLOSE_REQUEST_FILE on a successful window kill (see
# packages/teamlead/src/bridge/cmux-close-request.ts). This drains that file
# every watcher tick and closes the matching workspace pin IMMEDIATELY through
# the FLY-293 revalidating chokepoint — NO grace, because the marker names a
# window close_runner already killed (not a guessed orphan). The chokepoint still
# re-verifies the window + linked session are gone before closing, so a
# same-title restarted runner is never mis-closed.
#
# Requeue is narrow: ONLY transient uncertainty (cmux JSON / tmux inventory
# unavailable — rc=2 from workspace_refs_for OR the chokepoint) is kept for the
# next tick. Predicate skips (rc=1: restarted / not-orphan / gone) are DROPPED
# and left to the FLY-293 reaper — requeueing them would let an old marker outlive
# a same-title restarted runner. Kill-switch FLYWHEEL_CMUX_CLOSE_REQUEST=0 → fully
# inert (byte-compat). Marker lines are untrusted local IPC (validated below).
process_close_requests() {
  [[ "${FLYWHEEL_CMUX_CLOSE_REQUEST:-1}" == "0" ]] && return 0
  local tmp="${CLOSE_REQUEST_FILE}.processing"
  # Crash recovery: fold a leftover .processing batch (a previous drain that was
  # interrupted) back into the live file so the drain below processes it exactly
  # once — no same-tick double-process (Codex design R2 watchpoint #4).
  if [[ -f "$tmp" ]]; then
    cat "$tmp" >> "$CLOSE_REQUEST_FILE" 2>/dev/null || true
    rm -f "$tmp" 2>/dev/null || true
  fi
  [[ -f "$CLOSE_REQUEST_FILE" ]] || return 0
  # Atomically take the current batch so concurrent close_runner appends land in
  # the NEXT batch (mirrors drain_events' mv-to-.processing TOCTOU handling).
  mv "$CLOSE_REQUEST_FILE" "$tmp" 2>/dev/null || return 0
  _drain_close_requests "$tmp"
  rm -f "$tmp" 2>/dev/null || true
  return 0
}

# _drain_close_requests <batch> — process one frozen batch of window_name lines.
# Uncertain (rc=2) lines are appended back to $CLOSE_REQUEST_FILE (append is
# concurrency-safe vs a live close_runner append); at most one requeue per line
# per batch even with multiple uncertain refs. rc-capture is explicit so a helper
# returning non-zero under `set -euo pipefail` never exits the watcher (Codex
# design R1 #2 / FLY-694).
_drain_close_requests() {
  local batch="$1"
  [[ -f "$batch" ]] || return 0
  local closed_any=0 wname refs rc ref crc requeue
  while IFS= read -r wname; do
    # Untrusted local IPC: reject empty / tab-containing / overlong lines BEFORE
    # the managed-title gate (mirrors orphan_pin_refs' tab/newline defense).
    [[ -z "$wname" ]] && continue
    case "$wname" in *$'\t'*) continue ;; esac
    [[ ${#wname} -gt 200 ]] && continue
    is_managed_runner_title "$wname" || continue
    rc=0
    refs=$(workspace_refs_for "$wname") || rc=$?
    if [[ $rc -eq 2 ]]; then
      # cmux JSON unavailable at initial lookup → transient; requeue for next tick.
      printf '%s\n' "$wname" >> "$CLOSE_REQUEST_FILE" 2>/dev/null || true
      continue
    fi
    # rc=0: refs = the (possibly empty) set of workspace refs for this title.
    [[ -z "$refs" ]] && continue   # pin already gone → nothing to close
    requeue=0
    while IFS= read -r ref; do
      [[ -z "$ref" ]] && continue
      crc=0
      close_orphan_workspace_pin_if_still_orphan "$ref" "$wname" || crc=$?
      if [[ $crc -eq 0 ]]; then
        closed_any=1
      elif [[ $crc -eq 2 ]]; then
        requeue=1   # final-gate uncertainty (JSON/tmux flap during revalidation)
      fi
      # crc=1 (predicate skip: restarted / not-orphan / gone) → drop; FLY-293 backstops.
    done <<< "$refs"
    [[ $requeue -eq 1 ]] && { printf '%s\n' "$wname" >> "$CLOSE_REQUEST_FILE" 2>/dev/null || true; }
  done < "$batch"
  if [[ "$closed_any" == "1" ]]; then
    cmux_call refresh-surfaces || true
  fi
  return 0
}

# gc_close_request_file — watcher-startup GC: drop marker lines whose title has no
# matching cmux workspace (leaked by a previous watcher, or the pin was already
# closed). Env-gated (OFF path byte-compatible). cmux JSON unavailable → skip
# (keep the file, retry next startup). Mirrors gc_orphan_pin_state_file.
gc_close_request_file() {
  [[ "${FLYWHEEL_CMUX_CLOSE_REQUEST:-1}" == "0" ]] && return 0
  [[ -f "$CLOSE_REQUEST_FILE" ]] || return 0
  local raw live_titles tmp wname
  raw=$(get_cmux_workspaces_json) || return 0   # JSON unavailable → keep file
  live_titles=$(printf '%s' "$raw" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for w in d.get("workspaces", []):
    t = w.get("title")
    if t:
        print(t)
' 2>/dev/null || true)
  tmp=$(mktemp "${CLOSE_REQUEST_FILE}.XXXX" 2>/dev/null) || return 0
  while IFS= read -r wname; do
    [[ -z "$wname" ]] && continue
    if printf '%s\n' "$live_titles" | grep -qxF "$wname"; then
      printf '%s\n' "$wname" >> "$tmp"
    fi
  done < "$CLOSE_REQUEST_FILE"
  # Best-effort atomic swap; an unwritable path must not abort the watcher at
  # startup under `set -e` (mirrors gc_orphan_pin_state_file).
  mv "$tmp" "$CLOSE_REQUEST_FILE" 2>/dev/null || { rm -f "$tmp" 2>/dev/null || true; return 0; }
}

linked_session_exists() {
  local session_name="$1"
  tmux has-session -t "=$session_name" 2>/dev/null
}

is_pane_alive() {
  # FLY-102: Check whether the source pane for a given window name is still alive.
  # Since Runner and Lead both set `remain-on-exit on`, the tmux window persists
  # after the pane process dies (displaying exit code). We therefore cannot rely on
  # window existence — we must check #{pane_dead} on the source pane itself.
  # Returns 0 (alive) if at least one matching window has a live pane.
  # Returns 1 (dead / missing) otherwise.
  local wname="$1"
  # FLY-129 Phase 5 (Codex R2 MEDIUM fix): use awk -F'|' literal field
  # compare instead of `grep "|name$"`. The grep form interprets `.`/`[`/
  # `]` in window names as regex (repro: `foo.bar[1]` was matched against
  # `foo-bar-1` etc), causing false-positive "alive" reads + false-positive
  # cleanups elsewhere via the inverted predicate at cleanup_stale_conservative.
  local sessions
  sessions=$(get_tmux_agent_windows | awk -F'|' -v n="$wname" '$3 == n' || true)
  [[ -z "$sessions" ]] && return 1

  while IFS='|' read -r sess wid name; do
    [[ -z "$sess" || -z "$name" ]] && continue
    local dead
    dead=$(tmux display-message -p -t "=${sess}:=${name}" "#{pane_dead}" 2>/dev/null || echo "1")
    if [[ "$dead" == "0" ]]; then
      return 0
    fi
  done <<< "$sessions"
  return 1
}

# FLY-867: ID-scoped source-pane liveness for ONE specific window. The
# name-scoped is_pane_alive above is the WRONG predicate for per-window
# decisions — with same-name siblings (retry/park leftovers) a live sibling
# makes a dead husk read "alive". Mirrors refresh_linked_sessions' FLY-177
# by-id probe. Probe failure (window just vanished, tmux error) reads as
# dead — fail-closed for the create path, where the bug IS creating a tab
# for a dead window; a missed create is retried by the next event/scan.
window_source_pane_alive() {
  local sess="$1" wid="$2" dead
  dead=$(tmux display-message -p -t "=${sess}:${wid}" "#{pane_dead}" 2>/dev/null || echo "1")
  [[ "$dead" == "0" ]]
}

cleanup_workspace_for() {
  # FLY-102: Clean up a single cmux workspace + linked session by window name.
  # FLY-129 Phase 3/5 (R3-1 + R4-1): hybrid fail-closed.
  #   - cmux close is gated by JSON availability (skip on rc=2 — would race a
  #     stale state if we tried to close blindly during a JSON outage).
  #   - tmux kill + STALE_STATE drain are UNCONDITIONAL because tmux state
  #     and the on-disk stale-state file are local; they don't depend on
  #     cmux JSON. Skipping them would leak a linked tmux session and let
  #     STALE_STATE grow unbounded across cmux outages.
  # FLY-129 Phase 3 (R2-6 dup handling): close ALL matching refs (dedup
  # convergence), not just the first one.
  local agent_name="$1" refs
  local view_session="${VIEW_PREFIX}${agent_name}"

  # 1. cmux close — gated by JSON availability (R4-1: only this is gated).
  if refs=$(workspace_refs_for "$agent_name"); then
    while read -r ref; do
      [[ -z "$ref" ]] && continue
      close_workspace_by_ref "$ref" "stale-${agent_name}"
    done <<< "$refs"
  else
    log "WARN: cmux JSON unavailable; skipping cmux close for $agent_name this tick"
  fi

  # 2. Local tmux kill — unconditional (cmux-independent state).
  tmux kill-session -t "=$view_session" 2>/dev/null || true

  # 3. STALE_STATE drain — unconditional (Phase 5).
  drain_stale_state_row "$agent_name"
}

# FLY-129 Phase 5 (scope #5, Codex R1 Issue 7): drain_stale_state_row.
# Uses `awk -F'|'` literal-field comparison (NOT sed regex) because
# agent_name may contain regex metacharacters (e.g. window names with
# brackets / dots that sed would treat as character classes / wildcards).
drain_stale_state_row() {
  local name="$1"
  [[ -f "$STALE_STATE" ]] || return 0
  local tmp
  tmp=$(mktemp "${STALE_STATE}.XXXX") || return 0
  awk -F'|' -v n="$name" '$1 != n { print }' "$STALE_STATE" > "$tmp"
  mv "$tmp" "$STALE_STATE"
}

# FLY-129 Phase 5: GC the STALE_STATE file at watcher startup. Removes any
# row whose agent_name no longer corresponds to a live linked session or
# active tmux window — those entries are leftover from a previous watcher
# instance that didn't finish its cleanup before dying.
gc_stale_state_file() {
  [[ -f "$STALE_STATE" ]] || return 0
  local current_agents linked_sessions tmp
  current_agents=$(get_tmux_agent_windows | cut -d'|' -f3)
  linked_sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "^${VIEW_PREFIX}" || true)
  tmp=$(mktemp "${STALE_STATE}.XXXX") || return 0
  while IFS='|' read -r name ts; do
    [[ -z "$name" ]] && continue
    # Keep if a tmux agent window exists OR a linked session exists for it.
    if echo "$current_agents" | grep -qx "$name" \
       || echo "$linked_sessions" | grep -qx "${VIEW_PREFIX}${name}"; then
      printf '%s|%s\n' "$name" "$ts" >> "$tmp"
    fi
  done < "$STALE_STATE"
  mv "$tmp" "$STALE_STATE"
}

# ── FLY-169: cmux workspace attach self-heal ──
#
# Problem: `cmux new-workspace --command "tmux attach -t '=<view>'"` can fail
# at create time (race / quoting); cmux falls back to a bare login shell with
# no retry/verify. The workspace stays bare zsh until manually re-attached.
#
# Design: EVENT-DRIVEN self-heal — NO new periodic scan (Annie vetoed polling;
# her machine crashes under load). Heal only fires at event boundaries where
# attach can actually fail: verify-at-create, create/register drain events,
# watcher bootstrap, cmux health-recovery, and `--once`. The existing FLY-129
# `sync_additive` 60s reconcile is intentionally left untouched (out of scope).
#
# Detection (never type into an attached Lead's Claude prompt):
#   MANAGED: workspace title == agent window name (enforced by callers via
#            workspace_refs_for(wname) + self-heal only running for agent
#            windows). This is the durable "managed attach workspace" signal —
#            NOT the surface title, which is the live foreground process and
#            becomes "~" once the failed attach drops to a bare shell.
#   STATE  : `tmux list-clients -t '=<view_session>'` succeeds AND count == 0.
#   SHELL  : the target surface's screen looks like a bare shell (prompt sigil),
#            proving it's not attached to some OTHER session's Claude.
# The re-attach is a SINGLE atomic `cmux send` (attach command + embedded
# newline) targeting the selected terminal --surface — no separate send-key
# Enter, so there is no two-injection gap. Any uncertainty (tmux/cmux/JSON/
# read-screen failure) fails closed → no send.

# tmux client count for a view session. rc!=0 on tmux command failure (target
# missing / session raced away) so callers fail closed. Empty output = 0
# clients = SUCCESS (tmux exits 0 with no lines).
view_session_client_count() {
  local view_session="$1" out
  out=$(tmux list-clients -t "=${view_session}" 2>/dev/null) || return 1
  printf '%s' "$out" | grep -c . || true
}

# Print the ref of the workspace's selected terminal surface (or the first
# terminal surface if none is marked selected). rc=1 (no stdout) if there is no
# terminal surface / bad JSON / cmux failure — defensive parse, no Python
# traceback leaks (fail closed).
#
# Why NOT match on surface title (spike finding, FLY-169): a cmux surface's
# title is the CURRENT foreground process, not the create-time --command. When
# the `tmux attach` command exits/fails (the bug state — bare shell), the title
# becomes "~" (the shell cwd), NOT "tmux attach …". So a title==attach gate is
# inverted: it would only match while ALREADY attached (clients>0, which we
# skip) and never in the detached bare-shell state we need to heal. The durable
# "this is a managed attach workspace" signal is the WORKSPACE title == agent
# window name (enforced by the caller via workspace_refs_for / agent-window
# sweeps), not the surface title. The send still targets the selected terminal
# surface for precision; the no-send-when-attached safety rests on the 0-client
# STATE check (0 clients ⟹ no tmux client ⟹ surface cannot be showing Claude).
workspace_terminal_surface_ref() {
  local ref="$1" raw
  raw=$(cmux_call --json list-pane-surfaces --workspace "$ref") || return 1
  printf '%s' "$raw" | python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
    surfaces = data.get("surfaces")
    if not isinstance(surfaces, list):
        sys.exit(1)
    terms = [s for s in surfaces
             if isinstance(s, dict) and s.get("type") == "terminal"
             and (s.get("ref") or s.get("id"))]
    if not terms:
        sys.exit(1)
    selected = [s for s in terms if s.get("selected")]
    pick = (selected or terms)[0]
    print(pick.get("ref") or pick.get("id"))
    sys.exit(0)
except Exception:
    sys.exit(1)
' || return 1
}

# Tri-state SHELL gate (FLY-254 upgraded; rc=1/2 both read as fail-closed by
# legacy `|| return 1` callers — byte-compatible):
#   rc=0  the surface's screen is a BARE SHELL (last non-empty line ends in a
#         shell prompt sigil: % / $ / #) — positive proof, safe to send.
#   rc=1  read-screen SUCCEEDED but the screen is NOT a bare shell (tmux status
#         bar = attached to some session, a TUI, anything unclassifiable) —
#         deterministic FAIL CLOSED. This is the gate that prevents typing into
#         a surface attached to a DIFFERENT tmux session's Claude prompt (Codex
#         CR R3 HIGH): an attached surface's bottom line is the tmux status bar,
#         never a lone prompt sigil.
#   rc=2  read-screen ITSELF failed (surface not rendered — the cmux tabbed-
#         terminal reopen state, `Terminal surface not found` — or cmux error).
#         Legacy callers fail closed; the FLY-254 render-escalation context
#         treats this as the "needs forced render" signal.
# arg3 quiet=1 (FLY-254): escalation retries probe read-screen repeatedly while
# a surface renders; per-failure WARNs via cmux_call would flood the log. The
# quiet probe suppresses them — the caller logs ONE summary per workspace.
# Runs only at a heal attempt (event-driven), not as a periodic scan.
surface_looks_like_bare_shell() {
  local ref="$1" surface_ref="$2" quiet="${3:-0}" screen last
  if [[ "$quiet" == "1" ]]; then
    local socket="${CMUX_SOCKET_PATH:-$CMUX_SOCKET_PATH_DEFAULT}"
    screen=$(cmux --socket "$socket" read-screen --workspace "$ref" --surface "$surface_ref" 2>/dev/null) || return 2
  else
    screen=$(cmux_call read-screen --workspace "$ref" --surface "$surface_ref") || return 2
  fi
  last=$(printf '%s\n' "$screen" | awk 'NF{l=$0} END{print l}')
  last=$(printf '%s' "$last" | sed 's/[[:space:]]*$//')   # strip trailing whitespace
  case "$last" in
    *'%'|*'$'|*'#') return 0 ;;   # shell prompt → bare shell → safe to send
    *) return 1 ;;                # status bar / TUI / unknown → fail closed
  esac
}

# Transition-only logging for self-heal (mirrors drain_stale_state_row's
# literal awk -F'|' compare — agent names may contain regex metachars). Log
# ONCE per window when it enters the "re-attaching" state; clear on recovery.
heal_state_log_once() {
  local name="$1" msg="$2"
  touch "$HEAL_STATE" 2>/dev/null || true
  if ! awk -F'|' -v n="$name" '$1 == n { found=1 } END { exit(found ? 0 : 1) }' "$HEAL_STATE" 2>/dev/null; then
    # FLY-254 (Codex CR R1 M3): best-effort append — an unwritable/directory
    # HEAL_STATE must degrade to repeated logging, never kill the watcher
    # under `set -euo pipefail` (the escalated consume path relies on this
    # bookkeeping right before the injection guard).
    printf '%s|%s\n' "$name" "$(date +%s)" >> "$HEAL_STATE" 2>/dev/null || true
    log "$msg"
  fi
}

heal_state_clear() {
  local name="$1"
  [[ -f "$HEAL_STATE" ]] || return 0
  local tmp
  tmp=$(mktemp "${HEAL_STATE}.XXXX" 2>/dev/null) || return 0
  # FLY-254 (Codex CR R1 M3): best-effort rewrite — failures clean up and
  # return success so heal-state hygiene can never abort a sweep.
  if ! awk -F'|' -v n="$name" '$1 != n { print }' "$HEAL_STATE" > "$tmp" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    return 0
  fi
  mv "$tmp" "$HEAL_STATE" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  return 0
}

# GC HEAL_STATE rows whose window no longer exists (watcher startup).
gc_heal_state_file() {
  [[ -f "$HEAL_STATE" ]] || return 0
  local current_agents tmp
  current_agents=$(get_tmux_agent_windows | cut -d'|' -f3)
  tmp=$(mktemp "${HEAL_STATE}.XXXX") || return 0
  while IFS='|' read -r name ts; do
    [[ -z "$name" ]] && continue
    if echo "$current_agents" | grep -qx "$name"; then
      printf '%s|%s\n' "$name" "$ts" >> "$tmp"
    fi
  done < "$HEAL_STATE"
  mv "$tmp" "$HEAL_STATE"
}

# FLY-825: validated TTL — called at each guard entry (not once at top-level,
# since env can't change mid-run anyway; this just keeps the validation next to
# its only two call sites and avoids a load-order dependency on
# validated_int_env, which is defined later in this file). Same three-step
# pattern as reap_orphan_workspace_pins's `grace`: digit-only check, length cap
# (4 digits ≤ 9999s is far more than this guard will ever need), then use.
_create_dedup_seconds() {
  local v="${FLYWHEEL_CMUX_CREATE_DEDUP_SECONDS:-30}"
  case "$v" in ''|*[!0-9]*) v=30 ;; esac
  [[ ${#v} -gt 4 ]] && v=30
  echo "$((10#$v))"
}

# FLY-825: true (rc=0) if THIS EXACT (window_name, window_id) pair was created
# within the last CREATE_DEDUP_SECONDS. Best-effort — an unreadable/missing
# state file, or a corrupt/non-numeric/future stored timestamp, reads as "not
# recently attempted" (fail-open on the guard itself: the guard is a hardening
# layer, not a safety-critical gate — worst case on guard failure is reverting
# to pre-fix duplicate-tab behavior, never a hang or a false suppression of a
# real create).
create_recently_attempted() {
  local wname="$1" wid="$2" now ts dedup_seconds
  [[ -f "$CREATE_STATE" ]] || return 1
  now=$(date +%s)
  dedup_seconds=$(_create_dedup_seconds)
  ts=$(awk -F'|' -v n="$wname" -v w="$wid" '$1 == n && $2 == w { print $3; exit }' "$CREATE_STATE" 2>/dev/null || true)
  case "$ts" in ''|*[!0-9]*) return 1 ;; esac
  [[ ${#ts} -gt 12 ]] && return 1   # implausible/corrupt epoch → treat as not-recent
  ts=$((10#$ts))
  (( ts > now )) && return 1        # future timestamp → corrupt, fail open (not recent)
  (( now - ts < dedup_seconds ))
}

# FLY-825: record (window_name, window_id) as just-attempted. Idempotent
# overwrite (mktemp + rewrite, matching heal_state_clear's pattern) so a retry
# for the same pair refreshes the timestamp instead of growing the file.
create_mark_attempted() {
  local wname="$1" wid="$2" now tmp
  now=$(date +%s)
  touch "$CREATE_STATE" 2>/dev/null || return 0
  tmp=$(mktemp "${CREATE_STATE}.XXXX" 2>/dev/null) || return 0
  if ! awk -F'|' -v n="$wname" -v w="$wid" '!($1 == n && $2 == w) { print }' "$CREATE_STATE" > "$tmp" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    return 0
  fi
  printf '%s|%s|%s\n' "$wname" "$wid" "$now" >> "$tmp"
  mv "$tmp" "$CREATE_STATE" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
}

# FLY-825: GC rows older than the TTL (watcher startup — mirrors gc_heal_state_file).
# Same digit/length guard on each stored timestamp before arithmetic; a corrupt
# or future row is dropped (self-heals) rather than risking `(( ))` on a bad value.
gc_create_state_file() {
  [[ -f "$CREATE_STATE" ]] || return 0
  local now tmp dedup_seconds
  now=$(date +%s)
  dedup_seconds=$(_create_dedup_seconds)
  tmp=$(mktemp "${CREATE_STATE}.XXXX") || return 0
  while IFS='|' read -r name wid ts; do
    [[ -z "$name" || -z "$wid" ]] && continue
    case "$ts" in ''|*[!0-9]*) continue ;; esac
    [[ ${#ts} -gt 12 ]] && continue
    ts=$((10#$ts))
    (( ts > now )) && continue
    (( now - ts < dedup_seconds )) && printf '%s|%s|%s\n' "$name" "$wid" "$ts" >> "$tmp"
  done < "$CREATE_STATE"
  mv "$tmp" "$CREATE_STATE"
}

# FLY-254: THE single atomic re-attach injection path — used by BOTH the plain
# heal and the render-escalated heal. There must never be a second injection
# path (Codex R1 HIGH-1). ATOMIC: the attach command is sent WITH a trailing
# newline in ONE `cmux send` — no separate `send-key Enter`, so there is no
# text→Enter gap for a client to attach into between two injections (Codex CR
# R1 + R4 HIGH). printf -v preserves the trailing newline (command substitution
# would strip it). Callers MUST have run every safety gate immediately before.
#
# FLY-756: `env -u TMUX` — the injected `tmux attach` runs in the surface's bare
# shell, which inherits the cmux process env. When cmux was launched from within
# a tmux session, `$TMUX` is set and `tmux attach` refuses with "sessions should
# be nested with care, unset $TMUX" (tmux keys nesting off `$TMUX`; `TMUX_PANE`
# is informational and not part of the check). Stripping `$TMUX` for this one
# invocation is the source-level cure for the nested-attach dead pane.
heal_send_attach() {
  local wname="$1" ref="$2" surface_ref="$3"
  local view_session="${VIEW_PREFIX}${wname}"
  local attach_cmd
  printf -v attach_cmd "env -u TMUX tmux attach -t '=%s'\n" "$view_session"
  heal_state_log_once "$wname" "Self-heal: re-attaching '$wname' (0 clients on $view_session, ws $ref surface $surface_ref)"
  # FLY-254 (Codex CR R1 HIGH-1 + R5 HIGH-1) + FLY-756: the FINAL guards
  # (generation pin + 0-client) run INSIDE cmux_call_guarded — after ALL
  # bookkeeping (heal-state touch/awk/append + log + the wrapper's own mktemp),
  # as the genuine last operation before the injection. A focus-triggered attach
  # can complete during ANY of that bookkeeping (the gate→send window); a client
  # then means healed — sending would inject `tmux attach` into a live pane
  # (nested-attach). FLY-756: this final guard now runs for BOTH plain and
  # escalated heal (previously plain mode had no guard — that unguarded window
  # was the nested-attach injection race). Single enforcement point, single
  # injection path (FLY-254 R1 HIGH-1 invariant preserved & strengthened).
  # Generation pin inside the guard is a no-op in plain mode (HEAL_SWEEP_GEN_IDENT
  # unset). rc: 0 = sent (best-effort); 1 = fail-closed / generation changed;
  # 2 = client appeared (do not send).
  _GUARD_VIEW_SESSION="$view_session"
  cmux_call_guarded _heal_send_final_guard send --workspace "$ref" --surface "$surface_ref" "$attach_cmd" || true
  if [[ "$GUARD_WAS_BLOCKED" == "1" ]]; then
    return "${GUARD_BLOCK_RC:-1}"
  fi
  return 0   # send attempted — cmux failure is best-effort (legacy || true)
}

# Ref-scoped self-heal primitive. Heals ONE known cmux workspace ref. Used by
# verify-at-create with the freshly-created new_ref (works BEFORE rename, since
# it doesn't resolve by title) and by self_heal_one_workspace per resolved ref.
# Returns: 0 = send attempted (best-effort; cmux send failure is not an error)
#          1 = skip (no attach-intent surface / cmux/JSON / tmux uncertainty)
#          2 = a client appeared (attached) — caller should stop sending
self_heal_workspace_ref() {
  local wname="$1" ref="$2"
  local view_session="${VIEW_PREFIX}${wname}"
  [[ -z "$ref" ]] && return 1
  # Target the workspace's selected terminal surface (see
  # workspace_terminal_surface_ref for why title-intent matching is wrong).
  local surface_ref
  surface_ref=$(workspace_terminal_surface_ref "$ref") || return 1
  [[ -z "$surface_ref" ]] && return 1
  # SAFETY GATE 1 — target view session has 0 clients. Necessary but NOT
  # sufficient: 0 clients on cmux-$wname does not prove the surface isn't
  # attached to a DIFFERENT tmux session showing Claude (Codex CR R3 HIGH).
  local clients
  clients=$(view_session_client_count "$view_session") || return 1   # tmux error → fail-closed
  [[ "$clients" -gt 0 ]] && return 2                                  # attached to target → stop
  # SAFETY GATE 2 — POSITIVELY confirm the surface is a BARE SHELL before
  # typing. rc=1 (positively not a shell) fails closed; rc=2 (surface not
  # readable/rendered) fails closed UNLESS this is an escalated sweep, where
  # it is the "needs forced render" signal (FLY-254). Quiet probe under
  # escalation — the storm of per-retry WARNs is replaced by one summary.
  local shell_rc=0
  surface_looks_like_bare_shell "$ref" "$surface_ref" "${HEAL_RENDER_ESCALATE:-0}" || shell_rc=$?
  if [[ $shell_rc -eq 2 && "${HEAL_RENDER_ESCALATE:-0}" == "1" ]]; then
    local esc_rc=0
    self_heal_render_escalate "$wname" "$ref" || esc_rc=$?
    return $esc_rc
  fi
  [[ $shell_rc -ne 0 ]] && return 1
  # Single injection helper. Its rc matters for BOTH plain and escalated heal
  # now (FLY-756): both hit the same final 0-client guard immediately before the
  # send, so rc 2 (a client raced in between GATE1 above and the send) → return 2
  # so the caller stops sending; rc 1 → fail-closed skip. (Was: plain mode always
  # returned 0 with no final guard — that unguarded gate→send window was the
  # nested-attach injection race.)
  local send_rc=0
  heal_send_attach "$wname" "$ref" "$surface_ref" || send_rc=$?
  [[ $send_rc -eq 2 ]] && return 2
  [[ $send_rc -ne 0 ]] && return 1
  return 0
}

# ── FLY-254: render escalation + reopen generation state machine ──
#
# Problem: cmux is a tabbed terminal — after a bulk app reopen only the ACTIVE
# tab's surface is rendered. Unrendered surfaces make read-screen fail
# (`Terminal surface not found`), so the FLY-169 sweep fail-closes for every
# inactive tab (production log 2026-06-11: 14 consecutive failures at 11:26;
# the same heal chain succeeded for 9 workspaces at 11:39 after the founder
# manually clicked through tabs = human-powered rendering).
#
# Fix (founder-prescribed): ONE intentional sweep per reopen that focuses each
# broken workspace (`cmux select-workspace` forces the render), re-runs EVERY
# FLY-169 safety gate, re-attaches, then restores the original focus. This is
# event-driven (reopen evidence = socket identity change), NOT periodic polling
# (vetoed). Steady state adds zero cmux IPC and zero tmux scans.

# FLY-254: feature gate. `FLYWHEEL_CMUX_REOPEN_SWEEP=0` reverts every FLY-254
# behavior to the FLY-169 status quo (kill switch; regression-sentinel-tested).
reopen_sweep_enabled() {
  [[ "${FLYWHEEL_CMUX_REOPEN_SWEEP:-1}" != "0" ]]
}

# FLY-254: validate a numeric env knob — positive integer within [1, max].
# Echoes the validated value; falls back to the default with ONE log line.
# `10#` forces base-10 so leading zeros can't trip octal arithmetic.
validated_int_env() {
  local name="$1" value="$2" default="$3" max="$4"
  case "$value" in
    ''|*[!0-9]*)
      log "WARN: $name='$value' is not a positive integer — using default $default"
      echo "$default"; return 0 ;;
  esac
  # Codex CR R1 M4: lexical length cap BEFORE arithmetic — a 20-digit string
  # wraps bash arithmetic (e.g. 18446744073709551617 → 1) and would be
  # silently accepted. All knobs have max ≤ 60, so >4 digits is never valid.
  if [[ ${#value} -gt 4 ]]; then
    log "WARN: $name='$value' out of range [1,$max] — using default $default"
    echo "$default"; return 0
  fi
  value=$((10#$value))
  if (( value < 1 || value > max )); then
    log "WARN: $name=$value out of range [1,$max] — using default $default"
    echo "$default"; return 0
  fi
  echo "$value"
}

# FLY-254: filesystem identity of the cmux socket (device:inode:birthtime).
# Changes exactly when a new cmux app instance binds the socket path. Pure
# stat — zero IPC. Empty output when the socket is missing/unreadable.
# Overridable in tests.
cmux_socket_identity() {
  local socket="${CMUX_SOCKET_PATH:-$CMUX_SOCKET_PATH_DEFAULT}"
  stat -f '%d:%i:%B' "$socket" 2>/dev/null || true
}

# FLY-254: socket presence probe (bash builtin test — one stat syscall, no
# subprocess). Wrapped as a function so tests can override it.
cmux_socket_present() {
  local socket="${CMUX_SOCKET_PATH:-$CMUX_SOCKET_PATH_DEFAULT}"
  [[ -S "$socket" ]]
}

# FLY-254: parse the generation state file into REOPEN_GEN_{IDENT,STATE,ATTEMPTS}.
# rc=0 parsed; rc=1 file missing; rc=2 malformed (callers fail closed).
read_generation_state() {
  REOPEN_GEN_IDENT=""; REOPEN_GEN_STATE=""; REOPEN_GEN_ATTEMPTS=""
  [[ -f "$CMUX_SOCK_IDENT_FILE" ]] || return 1
  local line
  line=$(head -1 "$CMUX_SOCK_IDENT_FILE" 2>/dev/null || true)
  case "$line" in
    *"|"*"|"*) ;;
    *) return 2 ;;
  esac
  local ident="${line%%|*}"
  local rest="${line#*|}"
  local state="${rest%%|*}"
  local attempts="${rest#*|}"
  [[ -z "$ident" ]] && return 2
  case "$state" in pending|done) ;; *) return 2 ;; esac
  # Codex CR R1 M4: lexical bound BEFORE any arithmetic — the writer can only
  # ever produce 0..REOPEN_ATTEMPT_LIMIT(3); a huge digit string overflows
  # bash arithmetic (observed parsing as -1, which would BYPASS the attempt
  # cap). Anything outside the representable set is malformed.
  case "$attempts" in 0|1|2|3) ;; *) return 2 ;; esac
  REOPEN_GEN_IDENT="$ident"
  REOPEN_GEN_STATE="$state"
  REOPEN_GEN_ATTEMPTS="$attempts"
  # Keep the in-process cache in sync (Codex CR R1 M6).
  REOPEN_CACHE_IDENT="$ident"
  REOPEN_CACHE_STATE="$state"
  return 0
}

# FLY-254: atomic generation-state write (same-dir temp + mv, matching the
# STALE_STATE pattern). rc!=0 on any failure — callers MUST fail closed.
write_generation_state() {
  local ident="$1" state="$2" attempts="$3"
  local tmp
  tmp=$(mktemp "${CMUX_SOCK_IDENT_FILE}.XXXX" 2>/dev/null) || return 1
  printf '%s|%s|%s\n' "$ident" "$state" "$attempts" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$CMUX_SOCK_IDENT_FILE" 2>/dev/null || { rm -f "$tmp"; return 1; }
  # Keep the in-process cache in sync (Codex CR R1 M6). write is never called
  # inside $(...), so this mutation persists.
  REOPEN_CACHE_IDENT="$ident"
  REOPEN_CACHE_STATE="$state"
  return 0
}

# FLY-254: reopen evidence collector — called at watcher bootstrap and on each
# healthy tick (one stat; zero IPC; no new periodic cmux/tmux load). Arms a
# new generation (`identity|pending|0`) when the socket identity differs from
# the persisted one. Fail-closed behaviors:
#   - socket missing/unreadable → no evidence, no action;
#   - malformed file → ONE log + reset to `done` (recover the file for FUTURE
#     generations WITHOUT escalating off corrupt state);
#   - arm write failure → ONE log, no arm (next tick retries).
reopen_detector_check() {
  reopen_sweep_enabled || return 0
  local ident
  ident=$(cmux_socket_identity)
  [[ -z "$ident" ]] && return 0
  # Steady-state fast path (Codex CR R1 M6): identity unchanged vs the
  # in-process cache → nothing to arm. The healthy tick pays exactly the ONE
  # stat above — zero file reads, zero subprocesses.
  if [[ -n "$REOPEN_CACHE_IDENT" && "$ident" == "$REOPEN_CACHE_IDENT" ]]; then
    return 0
  fi
  local rc=0
  read_generation_state || rc=$?
  if [[ $rc -eq 2 ]]; then
    log "WARN: malformed generation state file — resetting to done (fail-closed, no escalation this generation)"
    write_generation_state "$ident" done 0 || true
    return 0
  fi
  if [[ $rc -eq 1 || "$REOPEN_GEN_IDENT" != "$ident" ]]; then
    if write_generation_state "$ident" pending 0; then
      log "INFO: cmux reopen detected (generation $ident) — arming one-shot re-attach sweep"
    else
      log "WARN: cannot persist generation state — skipping arm (fail-closed)"
    fi
  fi
  return 0
}

# FLY-254: rc=0 ⟺ a pending generation matches the CURRENT socket identity and
# the durable attempt budget is not exhausted (consumable right now).
reopen_pending_ready() {
  reopen_sweep_enabled || return 1
  read_generation_state || return 1
  [[ "$REOPEN_GEN_STATE" == "pending" ]] || return 1
  local ident
  ident=$(cmux_socket_identity)
  [[ -n "$ident" && "$ident" == "$REOPEN_GEN_IDENT" ]] || return 1
  [[ "$REOPEN_GEN_ATTEMPTS" -lt "$REOPEN_ATTEMPT_LIMIT" ]]
}

# FLY-254: print managed tmux window names with NO matching cmux workspace yet
# (one per line; empty = everything restored). JSON unavailable → all names
# (treated as not-ready). Used only by the readiness wait below.
reopen_missing_workspaces() {
  local tmux_windows raw
  tmux_windows=$(get_tmux_agent_windows)
  [[ -z "$tmux_windows" ]] && return 0
  if ! raw=$(get_cmux_workspaces_json); then
    echo "$tmux_windows" | cut -d'|' -f3
    return 0
  fi
  local titles
  titles=$(printf '%s' "$raw" | python3 -c '
import sys, json
for w in json.load(sys.stdin).get("workspaces", []):
    t = w.get("title")
    if t:
        print(t)
')
  local _s _wid wname
  while IFS='|' read -r _s _wid wname; do
    [[ -z "$wname" ]] && continue
    echo "$titles" | grep -qx -- "$wname" || echo "$wname"
  done <<< "$tmux_windows"
  return 0
}

# FLY-254: bounded wait for cmux to finish restoring workspaces after reopen.
# Early exit when EVERY managed tmux window title has a matching workspace —
# the tmux side is the EXPECTED set. (NOT "two stable samples": a partially
# restored set can hold still for two samples and resume later — Codex R2 M4.)
# Budget exhausted → proceed with the current set + log the missing names.
reopen_readiness_wait() {
  local ticks
  ticks=$(validated_int_env FLYWHEEL_CMUX_READINESS_TICKS "${FLYWHEEL_CMUX_READINESS_TICKS:-5}" 5 60)
  local i missing=""
  for (( i = 0; i < ticks; i++ )); do
    missing=$(reopen_missing_workspaces)
    [[ -z "$missing" ]] && return 0
    sleep 1
  done
  missing=$(reopen_missing_workspaces)
  [[ -z "$missing" ]] && return 0
  log "WARN: readiness budget exhausted; sweeping current set (missing: $(echo "$missing" | tr '\n' ' '))"
  return 0
}

# FLY-254: THE single consumption point for a pending reopen generation.
# Semantics (Codex R2 HIGH-1 + R3 HIGH-1): one normal attempt per generation;
# bounded crash resume via the durable attempt counter (incremented BEFORE any
# focus side effect); no replay after done; total escalated sweeps per
# generation hard-capped at REOPEN_ATTEMPT_LIMIT even if `done` can never be
# persisted. Sets REOPEN_CONSUMED_THIS_TICK=1 when a sweep actually ran so the
# caller can coalesce the legacy recovery sweep (Codex R2 M3).
consume_pending_reopen_sweep() {
  REOPEN_CONSUMED_THIS_TICK=0
  reopen_sweep_enabled || return 0
  read_generation_state || return 0
  [[ "$REOPEN_GEN_STATE" == "pending" ]] || return 0
  local ident
  ident=$(cmux_socket_identity)
  [[ -n "$ident" && "$ident" == "$REOPEN_GEN_IDENT" ]] || return 0
  if [[ "$REOPEN_GEN_ATTEMPTS" -ge "$REOPEN_ATTEMPT_LIMIT" ]]; then
    log "WARN: generation $ident attempt budget exhausted — giving up escalation for this generation"
    # Codex CR R1 M6: even if the done write keeps failing, the in-process
    # cache flips to done so per-tick consumption (and this log) stops for
    # this watcher's lifetime; a restart re-tries once (bounded).
    if ! write_generation_state "$ident" done "$REOPEN_GEN_ATTEMPTS"; then
      REOPEN_CACHE_IDENT="$ident"
      REOPEN_CACHE_STATE="done"
    fi
    return 0
  fi
  # Durable attempt increment BEFORE any focus side effect (Codex R3 HIGH-1).
  # Write failure → fail closed: no escalation this round, next tick retries.
  local next_attempt=$((REOPEN_GEN_ATTEMPTS + 1))
  if ! write_generation_state "$ident" pending "$next_attempt"; then
    log "WARN: cannot persist attempt counter — skipping escalated sweep this tick (fail-closed)"
    return 0
  fi
  if [[ "$REOPEN_GEN_ATTEMPTS" -gt 0 ]]; then
    log "INFO: resuming pending re-attach sweep (generation $ident, attempt $next_attempt)"
  fi
  reopen_readiness_wait
  # Codex CR R1 HIGH-2: the readiness wait takes seconds — the app can quit
  # and reopen AGAIN during it. Sweeping then would mutate focus in a NEW
  # generation whose budget was never charged, and writing `done` for the old
  # identity would let the detector re-arm and sweep the new one a second
  # time. Re-check identity here and pin it for the sweep's duration (each
  # focus mutation re-verifies via HEAL_SWEEP_GEN_IDENT). On mismatch: abort
  # WITHOUT done — the old generation can never match again, and the next
  # detector tick arms the new identity cleanly.
  local now_ident
  now_ident=$(cmux_socket_identity)
  if [[ "$now_ident" != "$ident" ]]; then
    log "WARN: cmux generation changed during readiness wait — aborting consume (new generation will be armed)"
    return 0
  fi
  HEAL_SWEEP_GEN_IDENT="$ident"
  HEAL_RENDER_ESCALATE=1
  self_heal_sweep_all
  HEAL_RENDER_ESCALATE=0
  HEAL_SWEEP_GEN_IDENT=""
  REOPEN_CONSUMED_THIS_TICK=1
  # Normal completion → done. A failed write keeps the FILE pending (a watcher
  # restart re-consumes, bounded by the spent attempt counter), but the
  # in-process cache flips to done so THIS watcher stops re-consuming per tick
  # (Codex CR R1 M6).
  if ! write_generation_state "$ident" done "$next_attempt"; then
    log "WARN: cannot persist done state — generation stays pending on disk (bounded by attempt budget)"
    REOPEN_CACHE_IDENT="$ident"
    REOPEN_CACHE_STATE="done"
  fi
  return 0
}

# FLY-254: print the ref of THE selected workspace. rc!=0 unless exactly one
# legal selected ref exists (JSON down / 0 / >1 selected → fail closed; callers
# must not perform focus mutations without a restorable snapshot).
current_selected_ref() {
  local raw
  raw=$(get_cmux_workspaces_json) || return 1
  local refs
  refs=$(printf '%s' "$raw" | python3 -c '
import sys, json
for w in json.load(sys.stdin).get("workspaces", []):
    if w.get("selected") and w.get("ref"):
        print(w["ref"])
')
  [[ $(printf '%s' "$refs" | grep -c .) -eq 1 ]] || return 1
  # Codex CR R1 M5: the single selected ref must also be a LEGAL workspace
  # ref — a malformed value would be fed to select-workspace on restore.
  printf '%s' "$refs" | grep -qE '^workspace:[0-9]+$' || return 1
  printf '%s\n' "$refs"
}

# FLY-254: render escalation — focus the workspace to force its surface to
# render, then re-run EVERY safety gate before the single atomic send.
# Preconditions (set by the escalated sweep): HEAL_FOCUS_SNAPSHOT_OK=1 (we can
# restore focus afterwards) and HEAL_USER_INTERVENED=0 (the user hasn't taken
# over). Returns: 0 = send attempted; 1 = skip (fail-closed / timeout / user
# intervened); 2 = a client appeared (cmux re-ran the attach itself — healed).
self_heal_render_escalate() {
  local wname="$1" ref="$2"
  local view_session="${VIEW_PREFIX}${wname}"
  [[ "${HEAL_FOCUS_SNAPSHOT_OK:-0}" == "1" ]] || return 1
  [[ "${HEAL_USER_INTERVENED:-0}" == "1" ]] && return 1
  [[ "${HEAL_GEN_CHANGED:-0}" == "1" ]] && return 1
  # Malformed refs must never be fed to a focus mutation (REF_RE caution,
  # matching dedup_workspaces_by_title).
  printf '%s' "$ref" | grep -qE '^workspace:[0-9]+$' || return 1
  # GENERATION pin (Codex CR R1 HIGH-2): if the cmux app instance changed
  # since this sweep's generation was consumed (reopen mid-sweep), every
  # further focus mutation would land on a generation whose attempt budget
  # was never charged. Fail closed: stop ALL remaining focus escalation and
  # never restore (the new generation gets its own armed sweep).
  if [[ -n "${HEAL_SWEEP_GEN_IDENT:-}" ]]; then
    local now_ident
    now_ident=$(cmux_socket_identity)
    if [[ "$now_ident" != "$HEAL_SWEEP_GEN_IDENT" ]]; then
      HEAL_GEN_CHANGED=1
      log "Self-heal(render): cmux generation changed mid-sweep — aborting focus escalation"
      return 1
    fi
  fi
  # USER-INTERVENTION pre-check (Codex R2 M5): the current selected workspace
  # must still be what WE expect — the original snapshot before our first
  # focus, our last forced ref afterwards. Anything else = the user clicked a
  # tab mid-sweep → stop ALL remaining focus escalation, never restore.
  local cur
  if ! cur=$(current_selected_ref); then
    HEAL_USER_INTERVENED=1   # can't prove the user didn't take over → stop
    return 1
  fi
  if [[ "$cur" != "$HEAL_EXPECTED_SELECTED" ]]; then
    HEAL_USER_INTERVENED=1
    log "Self-heal(render): user switched tabs — stopping focus escalation, keeping user's selection"
    return 1
  fi
  # Codex CR R3 HIGH-1 + R5 HIGH-1: the selected-ref read above is a cmux
  # JSON IPC and the wrapper's own mktemp is another subprocess — the
  # generation can flip during EITHER. The generation re-check therefore
  # runs INSIDE cmux_call_guarded, as the genuine last operation before the
  # select-workspace mutation.
  local sel_rc=0
  cmux_call_guarded _heal_focus_gen_guard select-workspace --workspace "$ref" || sel_rc=$?
  if [[ "$GUARD_WAS_BLOCKED" == "1" ]]; then
    log "Self-heal(render): cmux generation changed mid-sweep — aborting focus escalation"
    return 1
  fi
  [[ $sel_rc -ne 0 ]] && return 1   # cmux select failure → fail closed
  HEAL_FOCUS_CHANGED=1
  HEAL_LAST_FORCED_REF="$ref"
  HEAL_EXPECTED_SELECTED="$ref"
  log "Self-heal(render): focusing '$wname' (ws $ref) to force surface render"
  local ticks
  ticks=$(validated_int_env FLYWHEEL_CMUX_RENDER_WAIT_TICKS "${FLYWHEEL_CMUX_RENDER_WAIT_TICKS:-6}" 6 60)
  local i surface_ref clients shell_rc refs send_rc now_ident
  for (( i = 0; i < ticks; i++ )); do
    sleep 0.5
    # ⓪ GENERATION re-check after EVERY render wait (Codex CR R2 HIGH-1): the
    #    identity can flip during the sleep; the gates below would otherwise
    #    run against the NEW app (restored refs match) and the send would land
    #    there, uncharged. Latch blocks all remaining sends/focus/restore.
    if [[ -n "${HEAL_SWEEP_GEN_IDENT:-}" ]]; then
      now_ident=$(cmux_socket_identity)
      if [[ "$now_ident" != "$HEAL_SWEEP_GEN_IDENT" ]]; then
        HEAL_GEN_CHANGED=1
        log "Self-heal(render): cmux generation changed mid-sweep — aborting focus escalation"
        return 1
      fi
    fi
    # Full gate re-run before send (Codex R1 HIGH-1) — fixed order:
    # ① fresh MANAGED: the ref must still resolve from this window name
    #    (title drift / dedup / close during the wait → out).
    refs=$(workspace_refs_for "$wname") || return 1   # JSON down → fail closed
    printf '%s\n' "$refs" | grep -qx -- "$ref" || return 1
    # ② fresh surface ref — rendering may have created a new surface.
    surface_ref=$(workspace_terminal_surface_ref "$ref") || continue
    [[ -z "$surface_ref" ]] && continue
    # ③ clients == 0.
    clients=$(view_session_client_count "$view_session") || return 1
    [[ "$clients" -gt 0 ]] && return 2   # cmux re-ran the attach itself
    # ④ bare-shell positive proof (quiet probe; summary logged on timeout).
    shell_rc=0
    surface_looks_like_bare_shell "$ref" "$surface_ref" 1 || shell_rc=$?
    case $shell_rc in
      0)
        # ⑤ The FINAL 0-client re-check lives INSIDE heal_send_attach — after
        #    all bookkeeping, immediately before the injection (Codex CR R1
        #    HIGH-1: a focus-triggered attach can complete during the heal-
        #    state bookkeeping). Single enforcement point for every escalated
        #    send path. rc=2 = client appeared (healed), rc=1 = fail-closed.
        send_rc=0
        heal_send_attach "$wname" "$ref" "$surface_ref" || send_rc=$?
        [[ $send_rc -eq 2 ]] && return 2
        [[ $send_rc -ne 0 ]] && return 1
        return 0
        ;;
      1) return 1 ;;   # positively NOT a shell → fail closed
      2) ;;            # not rendered yet → keep waiting
    esac
  done
  log "Self-heal(render): '$wname' render timeout — skipped"
  return 1
}

# FLY-280: select the LIVE same-name window in a view (linked) session, mirroring
# the FLY-177 fix in refresh_linked_sessions. The legacy `select-window -t =name`
# picks the LOWEST-index same-name window — which after a Lead crash/restart (with
# `remain-on-exit on`) can be a stale remain-on-exit DEAD window, so the cmux pane
# lands on a dead pane and renders frozen/blank. Resolve the live window_id by
# probing #{pane_dead} on each same-name SOURCE window and select THAT id (grouped
# sessions share the window object, so the id is a valid target-window in the view
# session). Among same-name LIVE windows the highest-index wins deterministically
# (matches refresh_linked_sessions). rc=0 ⟺ a live window was selected; rc=1 if
# none live / name not found (caller then leaves the view untouched).
select_live_view_window() {
  local wname="$1" view_session="$2"
  local src_sess wid w_name live_id="" dead
  while IFS='|' read -r src_sess wid w_name; do
    [[ "$w_name" != "$wname" ]] && continue
    dead=$(tmux display-message -p -t "=${src_sess}:${wid}" "#{pane_dead}" 2>/dev/null || echo "1")
    [[ "$dead" == "0" ]] && live_id="$wid"   # highest-index live wins (last assignment)
  done < <(get_tmux_agent_windows)
  [[ -z "$live_id" ]] && return 1
  tmux select-window -t "=${view_session}:${live_id}" 2>/dev/null || true
  return 0
}

# Heal one window by name: resolve all matching workspace refs (title), then
# heal each via the ref-scoped primitive. Attach-only — the "workspace exists
# but linked session is dead" case is reconcile_existing_workspaces' job.
self_heal_one_workspace() {
  local wname="$1"
  local view_session="${VIEW_PREFIX}${wname}"
  # Need a live linked session to attach to.
  linked_session_exists "$view_session" || return 0

  # Mutation path uses workspace_refs_for with rc=2 handling (NOT
  # get_workspace_ref_for, which is unsafe as a mutation gate).
  local refs rc=0
  refs=$(workspace_refs_for "$wname") || rc=$?
  [[ $rc -eq 2 ]] && return 0          # JSON unavailable → skip (event-time tradeoff)
  [[ -z "$refs" ]] && return 0

  # STATE: only "tmux succeeded AND count==0" = detached. Per view_session
  # (shared by all dup workspaces for this window name).
  local clients
  clients=$(view_session_client_count "$view_session") || return 0   # tmux error → fail-closed
  if [[ "$clients" -gt 0 ]]; then
    # FLY-280: the view is still attached, but after a Lead restart its
    # current-window can point at the just-killed (remain-on-exit DEAD) window —
    # the pane then renders frozen even though a client is attached. Re-point to
    # the LIVE same-name window (never the dead dup) and force an Electron surface
    # repaint. Was: select by =name (lowest-index → could be the dead window) with
    # no refresh-surfaces. refresh-surfaces only when a live window was actually
    # re-pointed (no-op churn avoided when nothing live to render).
    if select_live_view_window "$wname" "$view_session"; then
      cmux_call refresh-surfaces || true
    fi
    heal_state_clear "$wname"
    return 0
  fi

  # 0 clients → maybe detached. Don't guess the dedup winner; iterate ALL refs
  # and heal each via the ref-scoped primitive. rc=2 (client appeared mid-loop)
  # → stop sending to remaining refs. The `|| hr=$?` capture is REQUIRED under
  # `set -euo pipefail` — a bare `cmd; hr=$?` would abort on the rc=1/2 returns.
  local healed=0 ref hr
  while read -r ref; do
    [[ -z "$ref" ]] && continue
    hr=0
    self_heal_workspace_ref "$wname" "$ref" || hr=$?
    case "$hr" in
      0) healed=1 ;;
      1) ;;          # normal skip (no intent / fail-closed)
      2) break ;;    # client appeared mid-loop → stop sending
      *) log "WARN: unexpected self-heal rc=$hr for $wname ref=$ref" ;;
    esac
  done <<< "$refs"

  if [[ "$healed" -eq 1 ]]; then
    # FLY-280: re-point by LIVE window_id (not =name, which could land on a stale
    # dead dup after a restart); refresh-surfaces stays unconditional here.
    select_live_view_window "$wname" "$view_session" || true
    cmux_call refresh-surfaces || true
  fi
}

# One-shot sweep of ALL agent windows (bootstrap / health-recovery / --once /
# FLY-254 escalated reopen consume).
self_heal_sweep_all() {
  local tmux_windows
  tmux_windows=$(get_tmux_agent_windows)
  [[ -z "$tmux_windows" ]] && return 0

  # FLY-254: escalated sweep — snapshot the user's selected workspace BEFORE
  # any focus mutation. Fail-closed (Codex R1 M3): without exactly one legal
  # selected ref we cannot restore afterwards, so focus mutations are disabled
  # for this ENTIRE sweep (the plain non-escalated heal still runs).
  HEAL_FOCUS_SNAPSHOT_OK=0
  HEAL_FOCUS_CHANGED=0
  HEAL_USER_INTERVENED=0
  HEAL_GEN_CHANGED=0
  HEAL_LAST_FORCED_REF=""
  HEAL_ORIG_SELECTED=""
  HEAL_EXPECTED_SELECTED=""
  if [[ "${HEAL_RENDER_ESCALATE:-0}" == "1" ]]; then
    if HEAL_ORIG_SELECTED=$(current_selected_ref); then
      HEAL_FOCUS_SNAPSHOT_OK=1
      HEAL_EXPECTED_SELECTED="$HEAL_ORIG_SELECTED"
    else
      log "Self-heal(render): no unique selected workspace — focus mutations disabled this sweep (fail-closed)"
    fi
  fi

  local _s _wid wname
  while IFS='|' read -r _s _wid wname; do
    [[ -z "$wname" ]] && continue
    self_heal_one_workspace "$wname"
  done <<< "$tmux_windows"

  # FLY-254: single cleanup epilogue — the focus restore decision. Restore the
  # original tab ONLY when (a) we actually moved focus, (b) the user never
  # intervened, AND (c) a FINAL selected re-check (Codex R3 M2) proves the
  # current selection is still OUR last forced ref — after the LAST forced
  # focus there is no "next focus pre-check" left to detect a user switch, so
  # the epilogue must re-verify before restoring. Mismatch / read failure /
  # ambiguity → the user wins, no restore.
  if [[ "$HEAL_FOCUS_CHANGED" == "1" && "$HEAL_USER_INTERVENED" == "0" && "$HEAL_GEN_CHANGED" == "0" && -n "$HEAL_ORIG_SELECTED" ]]; then
    # Codex CR R2 HIGH-1: generation re-check before the restore too — a
    # reopen after the LAST render wait would otherwise have the restore
    # land in the new app instance. Mismatch SETS the latch (consistent
    # latch semantics, Codex CR R3).
    local _cur_ident=""
    if [[ -n "${HEAL_SWEEP_GEN_IDENT:-}" ]]; then
      _cur_ident=$(cmux_socket_identity)
    fi
    if [[ -n "${HEAL_SWEEP_GEN_IDENT:-}" && "$_cur_ident" != "$HEAL_SWEEP_GEN_IDENT" ]]; then
      HEAL_GEN_CHANGED=1
      log "Self-heal(render): cmux generation changed before restore — leaving focus as-is"
    else
      local _cur
      if _cur=$(current_selected_ref) && [[ "$_cur" == "$HEAL_LAST_FORCED_REF" ]]; then
        # Codex CR R3/R4/R5 HIGH-1: the selected-ref read above is a JSON
        # IPC, `log` runs `date`, and the wrapper's mktemp is one more
        # subprocess — so the generation re-check runs INSIDE
        # cmux_call_guarded (last op before the restore mutation), and the
        # success log comes AFTER the mutation.
        local rest_rc=0
        cmux_call_guarded _heal_focus_gen_guard select-workspace --workspace "$HEAL_ORIG_SELECTED" || rest_rc=$?
        if [[ "$GUARD_WAS_BLOCKED" == "1" ]]; then
          log "Self-heal(render): cmux generation changed before restore — leaving focus as-is"
        elif [[ $rest_rc -ne 0 ]]; then
          log "Self-heal(render): focus restore attempt failed (best-effort)"
        else
          log "Self-heal(render): restored focus to $HEAL_ORIG_SELECTED"
        fi
      else
        log "Self-heal(render): user switched tabs during sweep — keeping user's selection"
      fi
    fi
  fi

  # FLY-177: explicit success. Best-effort sweep — never let a stray non-zero
  # from the loop propagate. This function is the LAST statement of
  # sync_additive_bootstrap, which runs in watch_main's `if cmux_health_check_or_die;
  # then sync_additive_bootstrap; fi` then-branch under `set -euo pipefail`; a
  # non-zero return there would abort the watcher at startup (§8 zero-churn).
  return 0
}

# One-shot sweep of a single session's agent windows (register event). Catches
# windows that existed before the per-session hooks were registered.
self_heal_sweep_session() {
  local target="$1" tmux_windows
  tmux_windows=$(get_tmux_agent_windows)
  [[ -z "$tmux_windows" ]] && return 0
  local s _wid wname
  while IFS='|' read -r s _wid wname; do
    [[ "$s" == "$target" && -n "$wname" ]] && self_heal_one_workspace "$wname"
  done <<< "$tmux_windows"
  # FLY-177 (churn root cause): explicit success. The loop body's final
  # statement is `[[ cond ]] && self_heal_one_workspace`; whenever the LAST
  # agent window does NOT belong to $target, the `[[ ]]` is false and the
  # `while` loop's exit status is 1. This happens in the common production case:
  # a `register|<session>` drain event for a `cmux-*` linked session (fired by
  # session-created when the watcher creates a linked session — no agent window
  # is ever in a cmux-* session, so nothing matches) or for `flywheel` while a
  # `runner-*` window sorts last. self_heal_sweep_session is called bare in the
  # `register)` arm of _drain_file under `set -euo pipefail`, so that stray
  # non-zero aborted the watcher → launchd KeepAlive respawned it every ~30s
  # (the FLY-177 churn). Self-heal is best-effort; its status must never kill
  # the watcher. Verified: the churn started the instant runner-geoforge3d
  # appeared (linked-session creation began firing register events).
  return 0
}

create_workspace_for_window() {
  # FLY-129 Phase 3 (R3-1): fail-closed at function top.
  #   - Snapshot JSON ONCE for this create attempt and reuse it for both
  #     the existence check and the refs_before snapshot. Avoids two
  #     extra cmux JSON calls + closes the window where another tick's
  #     create could slip in between our reads.
  #   - rc=2 on the JSON gate → exit 0 (skip this create; next tick retries).
  local source_session="$1"
  local window_id="$2"
  local window_name="$3"
  local view_session="${VIEW_PREFIX}${window_name}"

  # FLY-867 (Fix B): dead-husk windows (remain-on-exit corpses, pane_dead=1)
  # must NEVER get a workspace. This breaks the CREATE↔CLEANUP oscillation:
  # cleanup_stale_conservative closes the tab after 5min of dead pane, but the
  # husk window stayed in get_tmux_agent_windows, so the 60s additive scan
  # re-created the tab forever (production: FLY-808, ~7min cycle for hours).
  # Silent skip — the additive scan re-hits every 60s and a log line per husk
  # per tick would flood the watcher log. Sits ABOVE the FLY-825 dedup mark so
  # a husk skip never burns the create TTL.
  window_source_pane_alive "$source_session" "$window_id" || return 0

  # FLY-825: skip if we already attempted a create for this EXACT
  # (window_name, window_id) within the dedup TTL — prevents drain_events +
  # sync_additive (same tick, tick % 4 == 0) from both creating a tab for the
  # same window. Keyed by window_id too, so a genuine restart (same name,
  # fresh window_id) is never suppressed.
  if create_recently_attempted "$window_name" "$window_id"; then
    log "Skipping duplicate create for: $window_name ($window_id) (attempted within last $(_create_dedup_seconds)s)"
    return 0
  fi

  local raw_before
  raw_before=$(get_cmux_workspaces_json) || return 0  # JSON unavailable → skip

  # Existence check against the snapshot — inline so we never read rc=2 as
  # "not found" (workspace_exists_for would do the right thing but it'd
  # re-fetch JSON; we already have it).
  if printf '%s' "$raw_before" | python3 -c '
import sys, json
name = sys.argv[1]
exists = any(w.get("title") == name for w in json.load(sys.stdin).get("workspaces", []))
sys.exit(0 if exists else 1)
' "$window_name"; then
    return 0  # already exists, nothing to create
  fi

  log "Creating workspace for: $window_name ($window_id) from session $source_session"

  # 1. Create linked session (shares windows with source session, independent current-window)
  if ! linked_session_exists "$view_session"; then
    tmux new-session -d -t "$source_session" -s "$view_session" 2>/dev/null || true
  fi

  # 2. (FLY-169 §2.6) Ready gate: require the linked session to exist AND the
  #    target window to select successfully before creating the cmux workspace.
  #    `tmux has-session` alone only proves new-session didn't fail; a failed
  #    select-window can still create a workspace pointing at the wrong window
  #    (window 0 zsh). On failure, defer — the next create event retries, and
  #    verify-at-create / bootstrap / health-recovery sweeps also cover it.
  #    FLY-867 (Fix A): select by window_id, NOT `=name`. tmux fails a `=name`
  #    target with "can't find window" when the name matches ≥2 windows
  #    (same-name siblings from retry/park — production: FLY-811/852 creates
  #    deferred every tick forever, so live runners never got a sidebar tab).
  #    Grouped sessions share window objects, so the id is a valid view-session
  #    target — same form FLY-177 already uses in refresh_linked_sessions.
  if ! linked_session_exists "$view_session" \
     || ! tmux select-window -t "=${view_session}:${window_id}" 2>/dev/null; then
    log "WARN: $view_session not ready (session/select-window) — deferring create for $window_name"
    return 0
  fi

  # FLY-825: mark AFTER the ready gate passes (this call site is truly
  # committing to a create attempt) and BEFORE the cmux mutation, so a
  # concurrent-tick duplicate call sees the mark even if the cmux IPC below is
  # slow. A deferred (not-ready) call above never reaches here — it does NOT
  # burn the TTL, so the next tick's retry is never suppressed.
  create_mark_attempted "$window_name" "$window_id"

  # 3. refs_before from the snapshot we already have (no extra cmux call).
  local refs_before
  refs_before=$(printf '%s' "$raw_before" | python3 -c '
import sys, json
for w in json.load(sys.stdin).get("workspaces", []):
    ref = w.get("ref", "")
    if ref:
        print(ref)
' | sort)

  # 4. Create cmux workspace attaching to the linked session
  # FLY-98: original `2>/dev/null` swallowed real errors (it does NOT prevent
  #   SIGPIPE — that's a kernel signal). FLY-129: cmux_call routes stderr to
  #   the log so we can see whether cmux is missing, rejecting auth, or just
  #   transiently broken.
  # FLY-756: `env -u TMUX` — the create-time surface shell inherits the cmux
  # process env; when cmux was launched from within tmux, `$TMUX` is set and
  # `tmux attach` nest-fails ("sessions should be nested with care"). Strip it
  # for this attach so the fresh surface attaches cleanly.
  if ! cmux_call new-workspace --command "env -u TMUX tmux attach -t '=${view_session}'"; then
    log "WARN: cmux new-workspace failed for $window_name (see prior log lines)"
    return 0
  fi

  # 5. Race protection: re-snapshot after create. If JSON is unavailable
  # here we can't rename — log + return; the window will be unnamed cmux-side
  # until next reconcile pass.
  local raw_after refs_after new_ref
  raw_after=$(get_cmux_workspaces_json) || {
    log "WARN: cmux JSON unavailable post-create; cannot rename or verify-attach $window_name this tick (deferred to later event / --once)"
    return 0
  }
  refs_after=$(printf '%s' "$raw_after" | python3 -c '
import sys, json
for w in json.load(sys.stdin).get("workspaces", []):
    ref = w.get("ref", "")
    if ref:
        print(ref)
' | sort)
  new_ref=$(grep -vFxf <(printf '%s' "$refs_before") <(printf '%s' "$refs_after") | head -1 || true)

  # 6. Rename using the exact ref — immune to user tab switching
  if [[ -n "$new_ref" ]]; then
    cmux_call rename-workspace --workspace "$new_ref" "$window_name" || true
  fi

  # 7. (FLY-169 §2.5) Verify-at-create + bounded retry — the primary fix.
  #    cmux falls back to a bare login shell when the attach fails at create;
  #    here we confirm a tmux client actually attached and, if not, re-drive the
  #    attach. Ref-scoped via new_ref so it works regardless of the rename above
  #    (a freshly created workspace is only title-addressable after rename).
  #    Bounded (<=3 attempts, <=3s).
  #    NOTE (Codex CR R1 MEDIUM): create_workspace_for_window is also invoked by
  #    sync_additive's missing-workspace branch (60s). This verify therefore can
  #    run from that path — but ONLY when a workspace is genuinely MISSING and
  #    being created (rare), NOT on every tick and NOT as an all-workspace scan.
  #    It is correct to verify on EVERY create path (event OR missing-create);
  #    gating it to event-only would reintroduce the bug for sync_additive-born
  #    workspaces. "Zero new idle load" holds: no create → no verify.
  if [[ -n "$new_ref" ]]; then
    local vc_attempt vc_clients
    for vc_attempt in 1 2 3; do
      vc_clients=$(view_session_client_count "$view_session") || break  # tmux error → stop (fail-closed)
      [[ "$vc_clients" -gt 0 ]] && break                                # attached — done
      self_heal_workspace_ref "$window_name" "$new_ref" || true         # re-drive attach (ref-scoped, gated)
      sleep 1
    done
  fi
}

cleanup_stale_workspaces() {
  # Get current tmux window names (exact list, field 3 in session|wid|wname format)
  local active_names
  active_names=$(get_tmux_agent_windows | cut -d'|' -f3)

  # Check each linked session — if its window no longer exists, clean up fully
  local linked_sessions
  linked_sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "^${VIEW_PREFIX}" || true)
  [[ -z "$linked_sessions" ]] && return 0

  while read -r sess; do
    local agent_name="${sess#${VIEW_PREFIX}}"
    # Exact match check (not substring)
    if ! echo "$active_names" | grep -qx "$agent_name"; then
      log "Cleaning stale: $sess (tmux window '$agent_name' gone)"
      cleanup_workspace_for "$agent_name"
    fi
  done <<< "$linked_sessions"
}

refresh_linked_sessions() {
  # FLY-98: tmux-only repair — re-select correct window in existing linked sessions.
  # Safe to call from outside cmux (no cmux CLI dependency).
  # Fixes stale current-window pointers after Lead restart (window ID changed, name unchanged).
  #
  # FLY-177 (④): select by LIVE window_id, not by name. The old `=name` exact
  # match picks the LOWEST-index same-name window, which can be a stale
  # remain-on-exit DEAD window left after a Lead restart (claude-lead.sh kills
  # the old window first, but kill can fail / linger) → the view would land on a
  # dead pane. We instead probe `#{pane_dead}` on the specific window_id and only
  # select live ones. Among same-name LIVE windows the highest-index (last
  # iterated) wins deterministically. Pure tmux, idempotent, no cmux IPC, no new
  # periodic load (FLY-129) — runs only inside the existing additive/bootstrap
  # passes, so it does not touch the FLY-102 high-frequency surface.
  local tmux_windows
  tmux_windows=$(get_tmux_agent_windows)
  [[ -z "$tmux_windows" ]] && return 0

  local src_sess wid wname
  while IFS='|' read -r src_sess wid wname; do
    [[ -z "$wname" || -z "$wid" ]] && continue
    local view_session="${VIEW_PREFIX}${wname}"
    linked_session_exists "$view_session" || continue
    # ID-scoped liveness (NOT the name-based is_pane_alive, which would report a
    # dead row as alive when a different same-name window is live).
    local dead
    dead=$(tmux display-message -p -t "=${src_sess}:${wid}" "#{pane_dead}" 2>/dev/null || echo "1")
    if [[ "$dead" == "0" ]]; then
      # Select by window_id — grouped sessions share the window object, so the
      # id is a valid target-window in the view session. Idempotent.
      tmux select-window -t "=${view_session}:${wid}" 2>/dev/null || true
    fi
  done <<< "$tmux_windows"
}

reconcile_existing_workspaces() {
  # FLY-129 Phase 3 (R3-1): for workspaces that exist but have no linked
  # session (e.g., after Lead restart or cmux reopen with stale workspace),
  # close the broken workspace and let the create phase rebuild it.
  #
  # Fail-closed gate: snapshot JSON ONCE at the top of this reconcile pass
  # (one call instead of per-candidate). rc=2 → return 0 — next tick retries.
  # All closes go through close_workspace_by_ref (single audit log path).
  local tmux_windows raw
  tmux_windows=$(get_tmux_agent_windows)
  [[ -z "$tmux_windows" ]] && return 0
  raw=$(get_cmux_workspaces_json) || return 0  # JSON unavailable → skip

  while IFS='|' read -r src_sess wid wname; do
    local view_session="${VIEW_PREFIX}${wname}"
    # Skip if the linked session is alive — nothing to reconcile.
    linked_session_exists "$view_session" && continue
    # Find ALL refs matching this window name (dup-tolerant; Phase 6 dedup
    # also runs later but we still close every matching ref here in case
    # dedup hasn't run this tick).
    local refs
    refs=$(printf '%s' "$raw" | python3 -c '
import sys, json
name = sys.argv[1]
for w in json.load(sys.stdin).get("workspaces", []):
    if w.get("title") == name:
        ref = w.get("ref", "")
        if ref:
            print(ref)
' "$wname")
    [[ -z "$refs" ]] && continue
    log "Reconciling: closing stale workspace(s) for '$wname' (linked session dead)"
    while read -r ref; do
      [[ -z "$ref" ]] && continue
      close_workspace_by_ref "$ref" "reconcile-${wname}-linked-dead"
    done <<< "$refs"
  done <<< "$tmux_windows"
}

# ── FLY-102: Event-Signaled Polling ──

register_session_hooks() {
  # Register per-session tmux hooks that write events to $EVENT_FILE.
  # Scope: flywheel (Leads) and runner-* (Runners) sessions only.
  # Idempotent: repeated registration overwrites the same array index [500].
  local session="$1"
  case "$session" in
    flywheel|runner-*) ;;
    *) return 0 ;;
  esac

  # after-new-window: fires when a new window is created in this session.
  # pane-exited:      fires when the pane process exits AND the pane has
  #                   actually closed (i.e. remain-on-exit is OFF, or the
  #                   pane is being torn down).
  #
  # NOTE on hook scope:
  #   `after-new-window` and `pane-exited` work correctly when registered
  #   per-session (`set-hook -t <session>`). However the related
  #   `pane-died` event does NOT fire for session-scoped registration in
  #   tmux 3.5a — empirically confirmed via isolated tmux server. The
  #   fix for FLY-110 therefore registers `pane-died` GLOBALLY in
  #   register_global_hooks(), with the same event payload, and lets
  #   drain_events() filter by session name on the consumer side.
  #
  # Array index [500] avoids overwriting other tools' hooks (unindexed set-hook
  # would clear the whole hook array in tmux 3.5a).
  # No $(date ...) inside the hook command string — it would be shell-expanded at
  # registration time. Timestamps are added when the watcher drains events.
  #
  # Variable names: use plain #{session_name} / #{window_id} / #{window_name}
  # rather than the #{hook_*} variants. In tmux 3.5a under `run-shell -b`, the
  # #{hook_session_name} / #{hook_window} / #{hook_window_name} vars expand to
  # EMPTY for after-new-window and pane-exited (even though the man page lists
  # them). The plain names correctly resolve to the session/window where the
  # hook fired. Empirically verified + enforced by integration test.
  #
  # FLY-129 Phase 2 (scope #6, Codex R1 Issue 6): silence the per-tick "Hooks
  # registered" log spam. Read current hooks once via show-hooks; if both
  # after-new-window[500] AND pane-exited[500] are present (exact name match,
  # anchored regex), return silently. Otherwise re-register the missing one
  # (set-hook is idempotent — overwriting the same hook at [500] is cheap)
  # and emit ONE log line per recovery, not per tick.
  local current_hooks have_create=0 have_exited=0
  current_hooks=$(tmux show-hooks -t "$session" 2>/dev/null || true)
  if grep -q '^after-new-window\[500\]' <<<"$current_hooks"; then
    have_create=1
  fi
  if grep -q '^pane-exited\[500\]' <<<"$current_hooks"; then
    have_exited=1
  fi
  if (( have_create == 1 && have_exited == 1 )); then
    return 0
  fi

  if (( have_create == 0 )); then
    tmux set-hook -t "$session" 'after-new-window[500]' \
      "run-shell -b 'echo \"create|#{session_name}|#{window_id}|#{window_name}\" >> $EVENT_FILE'" 2>/dev/null || true
  fi
  if (( have_exited == 0 )); then
    tmux set-hook -t "$session" 'pane-exited[500]' \
      "run-shell -b 'echo \"exited|#{session_name}|#{window_name}\" >> $EVENT_FILE'" 2>/dev/null || true
  fi
  local was=$((have_create + have_exited))
  log "Hooks (re-)registered on $session: was $was/2"
}

register_global_hooks() {
  # Global session-created hook fires for every new tmux session.
  # The watcher filters by name (only flywheel / runner-*) during event drain.
  # Use #{session_name} rather than #{hook_session_name} for consistency with
  # after-new-window / pane-exited (see register_session_hooks comment).
  tmux set-hook -g 'session-created[500]' \
    "run-shell -b 'echo \"register|#{session_name}\" >> $EVENT_FILE'" 2>/dev/null || true

  # FLY-110: pane-died MUST be registered globally.
  #
  # Production Runner sessions (packages/claude-runner/src/TmuxAdapter.ts:105)
  # and Lead sessions (packages/teamlead/scripts/claude-lead.sh) set
  # `remain-on-exit on` so the operator can read the exit code of a dead
  # pane. Under that configuration tmux 3.5a fires `pane-died` (NOT
  # `pane-exited`) when the pane process exits.
  #
  # FLY-102 originally only registered `pane-exited` — and only at session
  # scope — so the event-driven cleanup path silently never ran in
  # production. Bug found in FLY-110.
  #
  # Empirically: in tmux 3.5a, `set-hook -t <session> pane-died[N] ...`
  # registers the hook (show-hooks confirms it) but the hook NEVER fires
  # when a pane in that session dies. `set-hook -g pane-died[N] ...` does
  # fire correctly. Therefore pane-died is registered globally here.
  # `drain_events()` filters by session name (`flywheel|runner-*`) so the
  # global scope does not introduce noise from other tmux sessions.
  #
  # Reference: tmux 3.5a man page —
  #   pane-died:   "...program ... exits, but remain-on-exit is on so the
  #                pane has not closed."
  #   pane-exited: "...program ... exits."  (i.e. pane has actually closed)
  tmux set-hook -g 'pane-died[500]' \
    "run-shell -b 'echo \"exited|#{session_name}|#{window_name}\" >> $EVENT_FILE'" 2>/dev/null || true

  # FLY-60 W4b (per W4a empirical evidence
  # `doc/qa/reports/v1.25.0-FLY-60-evidence/w4a-tmux-hook-empirical-test.md`):
  # `pane-died` does NOT fire when a window is destroyed via
  # `tmux kill-window` (which is what Bridge's W3 force-kill path does
  # via `runPostShipFinalization → postMergeTmuxCleanup → killTmuxWindow`).
  # tmux 3.5a fires `window-unlinked` instead. Empirical test confirmed it
  # fires deterministically (3/3 trials) AND the format vars
  # `#{hook_session_name}` + `#{hook_window_name}` are both populated AND
  # identify the SOURCE session + DESTROYED window.
  #
  # Critical: must use `#{hook_window_name}` (NOT `#{window_name}`) —
  # window-unlinked's `#{window_name}` returns the session's CURRENT
  # window name (e.g. `zsh`/`tmux`), not the destroyed one.
  #
  # The format `unlinked|sn=<src>|wn=<destroyed>` differs from the
  # legacy positional `exited|<sess>|<window>` pane-died rows, so the
  # watcher's `drain_events` parses both formats (sniff for `|sn=`).
  tmux set-hook -g 'window-unlinked[500]' \
    "run-shell -b 'echo \"unlinked|sn=#{hook_session_name}|wn=#{hook_window_name}\" >> $EVENT_FILE'" 2>/dev/null || true
}

register_hooks_on_new_sessions() {
  # Scan live sessions and register hooks on any flywheel/runner-* that lack them.
  # Called at startup and during each 60s additive poll as a safety net for
  # sessions that existed before the watcher started, or whose hooks were cleared.
  local sessions
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
  [[ -z "$sessions" ]] && return 0

  while read -r sess; do
    case "$sess" in
      flywheel|runner-*) register_session_hooks "$sess" ;;
    esac
  done <<< "$sessions"
}

mark_for_cleanup() {
  # Record a window name as pending cleanup with the timestamp of the exit event.
  # Idempotent: only adds if no pending entry exists for this window name.
  local wname="$1" ts="$2"
  [[ -z "$wname" ]] && return 0
  touch "$CLEANUP_PENDING"
  grep -q "^${wname}|" "$CLEANUP_PENDING" 2>/dev/null || \
    echo "${wname}|${ts}" >> "$CLEANUP_PENDING"
}

process_pending_cleanups() {
  # Walk the cleanup-pending file. For each entry:
  #   - if the source pane is alive again → drop the entry (restart detected)
  #   - else if < CLEANUP_DELAY_SECONDS since exit → keep the entry
  #   - else → cleanup_workspace_for + drop the entry
  [[ ! -f "$CLEANUP_PENDING" ]] && return 0

  local now remaining=""
  now=$(date +%s)

  while IFS='|' read -r wname ts; do
    [[ -z "$wname" || -z "$ts" ]] && continue
    # Pane alive again → cancel cleanup. Uses #{pane_dead} (not window existence)
    # because `remain-on-exit on` means window lingers after pane dies.
    if is_pane_alive "$wname"; then
      continue
    fi
    # Still within delay window → keep entry for next tick
    if (( now - ts < CLEANUP_DELAY_SECONDS )); then
      remaining+="${wname}|${ts}"$'\n'
      continue
    fi
    # Delay elapsed + pane confirmed dead → clean up
    log "Event cleanup: '$wname' (exited $((now - ts))s ago)"
    cleanup_workspace_for "$wname"
  done < "$CLEANUP_PENDING"

  if [[ -n "$remaining" ]]; then
    printf '%s' "$remaining" > "$CLEANUP_PENDING"
  else
    rm -f "$CLEANUP_PENDING"
  fi
}

drain_events() {
  # Consume $EVENT_FILE: mv → read → process.
  # Hooks writing via `>>` are POSIX-atomic for writes smaller than PIPE_BUF,
  # so the worst a concurrent writer can do is put its event in the next batch.
  #
  # Crash recovery: if a previous drain was interrupted, $EVENT_FILE.processing
  # still holds unprocessed events. Replay it FIRST as its own batch, then do
  # the normal mv + drain for any current events. Processing leftover and live
  # events separately avoids the TOCTOU race where rebuilding $EVENT_FILE via
  # `cat ... > merged && mv merged $EVENT_FILE` would drop concurrent hook
  # appends that landed on the old inode between snapshot and mv (Codex Round 2).
  local tmp_events="${EVENT_FILE}.processing"

  # Phase 1 — crash recovery: drain the leftover .processing file if present.
  if [[ -f "$tmp_events" ]]; then
    _drain_file "$tmp_events"
    rm -f "$tmp_events"
  fi

  # Phase 2 — normal drain: atomically rename live event file, then drain it.
  [[ ! -f "$EVENT_FILE" ]] && return 0
  mv "$EVENT_FILE" "$tmp_events" 2>/dev/null || return 0
  _drain_file "$tmp_events"
  rm -f "$tmp_events"
}

_drain_file() {
  # Process every event line in a single frozen batch file. Factored out so
  # drain_events can reuse it for both crash-recovery replay and normal drain.
  local source_file="$1"
  [[ ! -f "$source_file" ]] && return 0

  # Generate the event timestamp at drain time. If we tried to embed $(date +%s)
  # in the hook command string, tmux/shell would evaluate it at registration
  # time, producing a fixed constant. Using drain-time ~ event-arrival-time is
  # acceptable: events drain within 15s of firing, and replay after crash still
  # assigns a meaningful (though slightly-late) timestamp.
  local now
  now=$(date +%s)

  while IFS='|' read -r etype arg1 arg2 arg3; do
    case "$etype" in
      create)
        local session="$arg1" wid="$arg2" wname="$arg3"
        [[ -z "$wname" ]] && continue
        # Skip default shell windows
        [[ "$wname" == "zsh" || "$wname" == "bash" ]] && continue
        # Only handle windows from flywheel/runner-* sessions
        case "$session" in
          flywheel|runner-*) ;;
          *) continue ;;
        esac
        # FLY-129 Phase 3 (R3-1): tri-state workspace_exists_for.
        #   rc=0 found → skip; rc=1 not found → create; rc=2 JSON
        #   unavailable → skip this tick (would race a stale state).
        local _exists_rc=0
        workspace_exists_for "$wname" || _exists_rc=$?
        if [[ $_exists_rc -eq 1 ]]; then
          create_workspace_for_window "$session" "$wid" "$wname"
        elif [[ $_exists_rc -eq 0 ]]; then
          # FLY-169: workspace already exists — event-driven attach self-heal.
          # A window-recreate event for an existing workspace can mean its
          # surface lost the attach (bare zsh). Heal that one workspace only;
          # no-op when already attached (it just re-selects the window).
          self_heal_one_workspace "$wname"
        fi
        ;;
      exited)
        local session="$arg1" wname="$arg2"
        [[ -z "$wname" ]] && continue
        [[ "$wname" == "zsh" || "$wname" == "bash" ]] && continue
        case "$session" in
          flywheel|runner-*) ;;
          *) continue ;;
        esac
        mark_for_cleanup "$wname" "$now"
        ;;
      register)
        local session="$arg1"
        [[ -z "$session" ]] && continue
        register_session_hooks "$session"
        # FLY-169: a new session appearing = Lead restart / Runner spawn. Sweep
        # that session's windows once to re-attach any that landed as bare zsh,
        # including windows created before these hooks were registered (the
        # registration race that periodic polling previously masked).
        self_heal_sweep_session "$session"
        ;;
      unlinked)
        # FLY-60 W4b: window-unlinked global hook fires on tmux kill-window
        # (the path Bridge takes via runPostShipFinalization →
        # postMergeTmuxCleanup → killTmuxWindow when W2's stage_changed=
        # completed branch fires). pane-died does NOT fire on kill-window
        # in tmux 3.5a (verified by W4a empirical test), so this is the
        # ONLY signal we get for the post-merge force-kill path.
        #
        # Format is keyed (sn=..., wn=...) — different from legacy
        # positional pane-died `exited|<sess>|<window>` rows. Legacy rows
        # already match the `exited)` arm above; we parse the keyed form
        # here and treat it the same as `exited` for cleanup purposes.
        #
        # Parser: arg1 is "sn=<src_session>" and arg2 is "wn=<win_name>".
        # Strip the `sn=` / `wn=` prefixes before applying the same filter.
        local session="${arg1#sn=}"
        local wname="${arg2#wn=}"
        [[ -z "$wname" ]] && continue
        [[ "$wname" == "zsh" || "$wname" == "bash" ]] && continue
        case "$session" in
          flywheel|runner-*) ;;
          *) continue ;;
        esac
        mark_for_cleanup "$wname" "$now"
        ;;
    esac
  done < "$source_file"
}

cleanup_stale_conservative() {
  # Polling fallback for cleanup. Cleans up a linked session after its source
  # pane has been dead (or its window missing) for CONSERVATIVE_CLEANUP_SECONDS
  # (default 5 minutes). This is belt-and-suspenders for event-drop scenarios.
  #
  # Uses is_pane_alive() rather than window-existence so it handles BOTH the
  # "window gone" case AND the "remain-on-exit on — window lingers with dead
  # pane" case. Without this, a lost `exited` event combined with remain-on-exit
  # would keep the corresponding cmux workspace / linked session alive forever.
  local linked_sessions
  linked_sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "^${VIEW_PREFIX}" || true)
  [[ -z "$linked_sessions" ]] && return 0

  local now
  now=$(date +%s)
  touch "$STALE_STATE"

  while read -r sess; do
    local agent_name="${sess#${VIEW_PREFIX}}"
    if ! is_pane_alive "$agent_name"; then
      # FLY-129 Phase 5 (Codex R1 MEDIUM fix): replace `grep "^name|"` with
      # awk -F'|' literal field compare so window names containing regex
      # metacharacters (`.` / `[` / `]` etc) match correctly and don't
      # accidentally consume neighbouring rows.
      local first_stale
      first_stale=$(awk -F'|' -v n="$agent_name" '$1 == n { print $2; exit }' "$STALE_STATE" 2>/dev/null || true)
      if [[ -z "$first_stale" ]]; then
        echo "${agent_name}|${now}" >> "$STALE_STATE"
      elif (( now - first_stale >= CONSERVATIVE_CLEANUP_SECONDS )); then
        log "Conservative cleanup: $sess (stale for $((now - first_stale))s)"
        cleanup_workspace_for "$agent_name"
        # drain_stale_state_row uses the same awk -F'|' literal compare
        # (Phase 5). Centralizes the "remove this agent from STALE_STATE"
        # operation so a future regex-safety fix only has to land there.
        drain_stale_state_row "$agent_name"
      fi
    else
      # Pane is alive again → clear stale marker (literal-compare drain).
      drain_stale_state_row "$agent_name"
    fi
  done <<< "$linked_sessions"
}

sync_additive_bootstrap() {
  # Run once at `--watch` startup. Additive-only: never performs aggressive
  # cleanup. This prevents a watcher restart from killing healthy Runner
  # workspaces while the event file is empty.
  local tmux_windows
  tmux_windows=$(get_tmux_agent_windows)
  [[ -z "$tmux_windows" ]] && return 0

  # 1. Preserve FLY-98 reconcile repair: close broken workspaces (workspace
  #    exists but linked session is dead) so the create phase can rebuild.
  reconcile_existing_workspaces

  # 2. Refresh linked sessions — fix stale current-window pointers (FLY-98).
  refresh_linked_sessions

  # 3. Create missing workspaces. No cleanup of existing ones.
  # FLY-129 Phase 3 (R3-1): tri-state — only act on rc=1 (not found).
  while IFS='|' read -r src_sess wid wname; do
    local _exists_rc=0
    workspace_exists_for "$wname" || _exists_rc=$?
    if [[ $_exists_rc -eq 1 ]]; then
      create_workspace_for_window "$src_sess" "$wid" "$wname"
    fi
  done <<< "$tmux_windows"

  # 4. (FLY-169) One-shot attach self-heal sweep — covers watcher startup /
  #    cmux restart (watcher re-spawns) / reboot. Re-attaches any pre-existing
  #    workspace that landed as bare zsh. Event boundary (startup), not a poll.
  #    FLY-254 (Codex R2 M3): skipped when a pending reopen generation is about
  #    to be consumed right after bootstrap — the escalated sweep is a SUPERSET
  #    of this one (same window iteration + render capability), so running both
  #    would only burn a wasted pass of read-screen failures.
  if [[ "${BOOTSTRAP_SKIP_HEAL_SWEEP:-0}" != "1" ]]; then
    self_heal_sweep_all
  fi
  return 0
}

sync_additive() {
  # Called every 60s. Mirrors bootstrap, plus conservative cleanup, hook
  # top-up, ghost reaping (Phase 4), and dedup (Phase 6).
  register_hooks_on_new_sessions

  local tmux_windows
  tmux_windows=$(get_tmux_agent_windows)
  if [[ -z "$tmux_windows" ]]; then
    cleanup_stale_conservative
    # Even with no agent windows, reap ghosts so cmux UI clutter doesn't
    # accumulate during quiet periods.
    reap_ghost_workspaces
    # FLY-293: the "all runners closed" quiet state is EXACTLY when orphan pins
    # linger — reap them here too, not only in the has-windows branch.
    reap_orphan_workspace_pins
    return 0
  fi

  reconcile_existing_workspaces
  refresh_linked_sessions

  # FLY-129 Phase 3 (R3-1): tri-state — only act on rc=1.
  while IFS='|' read -r src_sess wid wname; do
    local _exists_rc=0
    workspace_exists_for "$wname" || _exists_rc=$?
    if [[ $_exists_rc -eq 1 ]]; then
      create_workspace_for_window "$src_sess" "$wid" "$wname"
    fi
  done <<< "$tmux_windows"

  # FLY-129 Phase 4 + Phase 6: ghost reap + dedup. Both fail-closed on
  # JSON-unavailable — they no-op rather than mis-acting on stale state.
  reap_ghost_workspaces
  dedup_workspaces_by_title
  # FLY-293: anchor-independent orphan-pin reaper (closes fully-orphaned managed
  # runner pins whose linked session AND source window are both gone). Env-gated,
  # fail-closed, ref-keyed grace — see reap_orphan_workspace_pins.
  reap_orphan_workspace_pins

  cleanup_stale_conservative
}

# FLY-254 (gap a): unhealthy-state sleep with app-open edge detection.
# rc=0 (healthy) or feature off → plain sleep, BYTE-IDENTICAL cadence.
# rc=1 (socket missing): sleep in slices; wake early when the socket appears.
# rc=3 (socket present but ping failing — the stale socket a quit cmux app can
# leave behind, observed live in Codex R2): wake early when the socket's
# filesystem identity changes (a new app instance bound the path).
# Both probes are pure stat — zero IPC; total sleep duration is unchanged, so
# the backoff load curve is identical; nothing new runs while cmux is healthy.
reopen_aware_sleep() {
  local total="$1"
  if ! reopen_sweep_enabled \
     || [[ "$CMUX_HEALTH_LAST_RC" != "1" && "$CMUX_HEALTH_LAST_RC" != "3" ]]; then
    sleep "$total"
    return 0
  fi
  local slice
  slice=$(validated_int_env FLYWHEEL_CMUX_SOCKET_PROBE_SLICE "${FLYWHEEL_CMUX_SOCKET_PROBE_SLICE:-3}" 3 60)
  local ref_ident=""
  if [[ "$CMUX_HEALTH_LAST_RC" == "3" ]]; then
    # Reference identity for change detection: the persisted generation if
    # readable, else the identity observed right now (sleep start).
    if read_generation_state; then ref_ident="$REOPEN_GEN_IDENT"; fi
    [[ -z "$ref_ident" ]] && ref_ident=$(cmux_socket_identity)
  fi
  local elapsed=0 now_ident remain step
  while (( elapsed < total )); do
    # Codex CR R1 L8: never oversleep — the final step is min(slice, remain)
    # so a slice larger than the requested total cannot LENGTHEN the sleep.
    remain=$((total - elapsed))
    step=$slice
    (( step > remain )) && step=$remain
    sleep "$step"
    elapsed=$((elapsed + step))
    if [[ "$CMUX_HEALTH_LAST_RC" == "1" ]]; then
      if cmux_socket_present; then return 0; fi
    else
      now_ident=$(cmux_socket_identity)
      if [[ -n "$now_ident" && "$now_ident" != "$ref_ident" ]]; then return 0; fi
    fi
  done
  return 0
}

watch_loop() {
  # Polling loop for --watch mode. Wrapped in a function so `local` is legal.
  # FLY-129 Phase 7: backoff while unhealthy. Healthy ticks stay at 15s so
  # event drain latency is unchanged; degraded paths back off up to 300s.
  local tick=0 sleep_seconds=15
  while true; do
    # FLY-254 (gap a): unhealthy sleeps are sliced with a pure-stat app-open
    # edge probe so a reopen is noticed in seconds instead of a full backoff
    # window (up to 300s). Healthy sleeps are byte-identical plain sleeps.
    reopen_aware_sleep "$sleep_seconds"
    tick=$((tick + 1))

    # FLY-129 R2: gate ALL cmux-touching work behind the health check.
    # rc=2 (Access denied / kernel perm-denied) → cmux_health_check_or_die
    # exits 1 → autostart EXIT trap releases the lock.
    # rc=0 healthy → run drain + cleanup; every 4th tick also run sync_additive.
    # rc=1/3 recoverable → skip cmux-touching paths this tick. Events still
    # accumulate in $EVENT_FILE; sync_additive on the next healthy tick will
    # reconcile by creating any missing workspaces.
    local hc_rc=0
    cmux_health_check_or_die || hc_rc=$?
    if [[ $hc_rc -eq 0 ]]; then
      # FLY-254: collect reopen evidence (one stat) and consume a pending
      # generation — readiness wait + ONE escalated sweep, durably bounded.
      # consume is gated on the in-process cache (Codex CR R1 M6): a settled
      # `done` generation costs the healthy tick zero file IO.
      reopen_detector_check
      if [[ "$REOPEN_CACHE_STATE" == "pending" ]]; then
        consume_pending_reopen_sweep
      fi
      # FLY-169: consume the cmux recovery flag ONCE (set by the health check
      # above on an unhealthy→healthy transition). One-shot heal sweep — covers
      # a cmux restart while this watcher stayed alive (no tmux event, no
      # re-bootstrap). NOT a per-tick scan: the flag is only set on recovery.
      # FLY-254 (Codex R2 M3): coalesced — when the escalated sweep already ran
      # this tick it is a superset of this recovery sweep; don't run both.
      if [[ "$CMUX_HEAL_ON_RECOVERY" == "1" ]]; then
        CMUX_HEAL_ON_RECOVERY=0
        if [[ "$REOPEN_CONSUMED_THIS_TICK" != "1" ]]; then
          self_heal_sweep_all
        fi
      fi
      drain_events
      process_pending_cleanups
      # FLY-685: drain close_runner's close-request markers → immediate pin removal.
      process_close_requests
      if (( tick % 4 == 0 )); then
        sync_additive
      fi
      sleep_seconds=15
    else
      sleep_seconds=$(next_sleep_seconds "$CMUX_HEALTH_FAIL_COUNT")
    fi
  done
}

# FLY-129: --watch dispatcher body. Wrapped in a function so we can use `local`
# without falling foul of the case-statement scope.
watch_main() {
  log "Watch mode: event-signaled polling (${CLEANUP_DELAY_SECONDS}s cleanup delay, ${CONSERVATIVE_CLEANUP_SECONDS}s conservative cleanup)"

  # Advisory: warn if cmux app preference is the broken default. This catches
  # the case where the watcher will work today (we're inside cmux pane) but
  # will fail post-reparent.
  if command -v defaults >/dev/null 2>&1; then
    local mode
    mode=$(defaults read com.cmuxterm.app socketControlMode 2>/dev/null || echo "unset")
    if [[ "$mode" != "allowAll" ]]; then
      log "WARN: cmux socketControlMode='$mode' (expected: allowAll)"
      log "WARN: When watcher orphans to launchd, IPC will be rejected. To fix:"
      log "WARN:   defaults write com.cmuxterm.app socketControlMode -string allowAll && quit cmux + relaunch"
    fi
  fi

  # Hooks are tmux-only — register regardless of cmux health.
  register_global_hooks
  register_hooks_on_new_sessions

  # FLY-129 Phase 5: one-shot GC of any STALE_STATE rows whose agents no
  # longer have a tmux window or linked session. Cleans up rows leaked by
  # a previous watcher that crashed mid-cleanup.
  gc_stale_state_file

  # FLY-169: GC heal-state rows whose window no longer exists (leaked by a
  # previous watcher). Keeps transition-only heal logging accurate.
  gc_heal_state_file

  # FLY-825: GC create-dedup rows past their TTL (leaked by a previous
  # watcher / normal expiry). Keeps CREATE_STATE bounded.
  gc_create_state_file

  # FLY-293: GC orphan-pin grace rows whose ref no longer exists in cmux (leaked
  # by a previous watcher). Env-gated (byte-compat when reaper off).
  gc_orphan_pin_state_file

  # FLY-685: GC close-request marker lines whose title no longer has a cmux
  # workspace (leaked by a previous watcher / already-closed pin). Env-gated.
  gc_close_request_file

  # FLY-254: log effective reopen-sweep knobs ONCE at startup — the deployment
  # verification anchor (don't trust kickstart exit codes; read this line).
  # validated_int_env also emits its one-time fallback WARNs here.
  local _rw _rt _ps
  _rw=$(validated_int_env FLYWHEEL_CMUX_RENDER_WAIT_TICKS "${FLYWHEEL_CMUX_RENDER_WAIT_TICKS:-6}" 6 60)
  _rt=$(validated_int_env FLYWHEEL_CMUX_READINESS_TICKS "${FLYWHEEL_CMUX_READINESS_TICKS:-5}" 5 60)
  _ps=$(validated_int_env FLYWHEEL_CMUX_SOCKET_PROBE_SLICE "${FLYWHEEL_CMUX_SOCKET_PROBE_SLICE:-3}" 3 60)
  log "FLY-254 knobs: reopen-sweep=${FLYWHEEL_CMUX_REOPEN_SWEEP:-1} render-wait-ticks=${_rw} readiness-ticks=${_rt} probe-slice=${_ps}s attempt-limit=${REOPEN_ATTEMPT_LIMIT}"

  # Gate cmux-touching bootstrap: if cmux is broken (rc=2 already exited),
  # skip the full sync but still enter the watch loop. drain_events / loop
  # will retry health every minute.
  if cmux_health_check_or_die; then
    # FLY-254 (Codex R2 M3): collect reopen evidence at bootstrap. When a
    # pending generation is consumable, the escalated consume REPLACES the
    # legacy bootstrap heal sweep this round (superset) and runs BEFORE the
    # first watch_loop sleep — no wasted non-escalated pass, no extra 15s.
    reopen_detector_check
    if reopen_pending_ready; then
      BOOTSTRAP_SKIP_HEAL_SWEEP=1 sync_additive_bootstrap
      consume_pending_reopen_sweep
    else
      sync_additive_bootstrap
    fi
  fi
  watch_loop
}

sync_once() {
  # FLY-129 Phase 1 (research §3.3 Option b): if a --watch process is already
  # running, --once's aggressive cleanup_stale_workspaces would race with the
  # watcher's additive create + conservative cleanup. Detect and exit 0 with
  # a guidance line telling the operator to use --refresh instead (tmux-only,
  # cmux-socket-free, race-free).
  if pgrep -f "flywheel-cmux-sync(\.sh)? +--watch" >/dev/null 2>&1; then
    echo "flywheel-cmux-sync: --watch is already running" >&2
    echo "  → use 'flywheel-cmux-sync --refresh' for tmux-side repair (safe)" >&2
    exit 0
  fi

  local tmux_windows
  tmux_windows=$(get_tmux_agent_windows)

  if [[ -z "$tmux_windows" ]]; then
    # No agent windows in any session — just cleanup stale
    cleanup_stale_workspaces
    # FLY-293: quiet state (all runners closed) → reap orphan pins here too.
    reap_orphan_workspace_pins
    return 0
  fi

  # 1. Reconcile: close workspaces with dead linked sessions (create phase will rebuild)
  reconcile_existing_workspaces

  # 2. Refresh linked sessions — fix stale current-window pointers (FLY-98)
  refresh_linked_sessions

  # 3. Create missing workspaces
  # FLY-129 Phase 3 (R3-1): tri-state — only act on rc=1.
  while IFS='|' read -r src_sess wid wname; do
    local _exists_rc=0
    workspace_exists_for "$wname" || _exists_rc=$?
    if [[ $_exists_rc -eq 1 ]]; then
      create_workspace_for_window "$src_sess" "$wid" "$wname"
    fi
  done <<< "$tmux_windows"

  # 4. Cleanup stale (dead windows → close workspace + kill linked session)
  cleanup_stale_workspaces

  # 5. FLY-129 Phase 4 + Phase 6: ghost reap + dedup (manual full-sync mode
  #    benefits from the same hygiene the periodic watcher gives).
  reap_ghost_workspaces
  dedup_workspaces_by_title
  # FLY-293: orphan-pin reaper in manual full-sync too.
  reap_orphan_workspace_pins

  # 6. (FLY-169) Manual attach self-heal sweep. `--once` is an explicit
  #    operator action (not idle load), so it doubles as a zero-idle rescue
  #    path: re-attach any existing bare-zsh workspace on demand.
  self_heal_sweep_all
}

# FLY-129 Phase 8 (Path A): list cmux workspace refs that belong to Lead
# windows (i.e. windows in the FLYWHEEL_SESSION tmux session). Used by
# restart-services.sh trigger_cmux_refresh to scope refresh-surfaces to
# only the Leads (don't touch Runner workspaces).
# Output: one ref per line. Empty on JSON failure (rc=2 propagated).
list_lead_refs() {
  local windows raw
  windows=$(tmux list-windows -t "$FLYWHEEL_SESSION" -F "#{window_name}" 2>/dev/null || true)
  [[ -z "$windows" ]] && return 0
  raw=$(get_cmux_workspaces_json) || return 0
  while read -r wname; do
    [[ -z "$wname" ]] && continue
    [[ "$wname" == "zsh" || "$wname" == "bash" ]] && continue
    printf '%s' "$raw" | python3 -c '
import sys, json
name = sys.argv[1]
for w in json.load(sys.stdin).get("workspaces", []):
    if w.get("title") == name:
        ref = w.get("ref", "")
        if ref:
            print(ref)
' "$wname"
  done <<< "$windows"
}

# FLY-129 Phase 1: watcher lock acquire/release.
#
# Why double-mutex (main lock + reap mutex):
#   The stale-lock cleanup ("owner dead → remove dir → mkdir my own") is two
#   non-atomic steps. Without a serialization point, two contenders can both
#   observe `owner_pid` dead, both `rm -rf` the dir, then both `mkdir` —
#   the second mkdir fails but the first wrote its $$ over the second's view.
#   The reap mutex (a sibling directory) ensures only ONE process is doing
#   the rm+mkdir sequence at a time. The other process must wait, then
#   retry from step 1 (the dir may now be owned by a live process).
#
# Round 2 R2-3: explicit failure branch — if mkdir of the lock dir fails AFTER
# we released the reap mutex (because a contender slipped in), we retry from
# step 1 with bounded attempts (≤3). After exhaustion we exit 0 (already-running
# is the only safe interpretation).
# FLY-177: true if PID's command looks like a `flywheel-cmux-sync --watch`.
# Guards the supervised block-wait against PID reuse: a recycled PID belonging
# to some unrelated process must NOT make a launchd watcher wait forever — it is
# treated as a stale lock and reaped instead.
_pid_is_watcher() {
  local pid="$1" cmd
  [[ -z "$pid" ]] && return 1
  cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
  [[ "$cmd" == *flywheel-cmux-sync* && "$cmd" == *--watch* ]]
}

# FLY-825: bootout is not guaranteed synchronous — the old watcher process can
# outlive its launchd job record (production repro: pid 64108, no longer
# tracked by `launchctl list`, still alive + still the lock owner hours after
# a same-label bootout/bootstrap cycle). Poll for `flywheel-cmux-sync --watch`
# process(es) to actually disappear before the caller (flywheel-cmux-install.sh)
# bootstraps a fresh instance, so a new launchd-tracked instance never has to
# coexist with a not-fully-dead predecessor. Bounded ~5s real time (10 x 0.5s);
# falls through to an explicit, PID-targeted TERM-then-KILL (never a broad
# `pkill`) if bootout's own signal didn't land in time. Every PID killed is
# logged for audit. Exposed as its own function (not inlined in the install
# script, which has no BASH_SOURCE guard and top-level side effects) so it is
# covered by this file's existing bash-3.2 `source`-based test harness.
wait_for_watcher_exit() {
  local half_seconds=0 pids pid
  while true; do
    pids=$(pgrep -f "flywheel-cmux-sync(\.sh)? +--watch" 2>/dev/null || true)
    [[ -z "$pids" ]] && return 0
    if (( half_seconds >= 10 )); then
      log "wait_for_watcher_exit: still alive after 5s, escalating to TERM: $pids"
      for pid in $pids; do
        log "wait_for_watcher_exit: TERM pid=$pid"
        kill -TERM "$pid" 2>/dev/null || true
      done
      sleep 1
      pids=$(pgrep -f "flywheel-cmux-sync(\.sh)? +--watch" 2>/dev/null || true)
      for pid in $pids; do
        log "wait_for_watcher_exit: KILL pid=$pid (survived TERM)"
        kill -KILL "$pid" 2>/dev/null || true
      done
      return 0
    fi
    sleep 0.5
    half_seconds=$((half_seconds + 1))
  done
}

acquire_watcher_lock() {
  # FLY-177: supervised (launchd) mode blocks-waits for a live watcher to exit
  # rather than exiting itself (no KeepAlive respawn churn). Unsupervised
  # (.zshrc) mode keeps the original fast `exit 0` so it never competes with a
  # live launchd owner.
  local supervised=0
  [[ "${FLYWHEEL_CMUX_SUPERVISED:-}" == "1" ]] && supervised=1
  local attempt=0
  while true; do
    # Step 1 — lock dir exists + owner alive.
    if [[ -d "$WATCHER_LOCK_DIR" ]]; then
      local owner_pid
      owner_pid=$(cat "$WATCHER_LOCK_DIR/pid" 2>/dev/null || echo "")
      if [[ -n "$owner_pid" ]] && kill -0 "$owner_pid" 2>/dev/null; then
        if [[ "$supervised" == "1" ]] && _pid_is_watcher "$owner_pid"; then
          # Supervised: block-wait for the live watcher to exit, then take over.
          # Do NOT exit (avoids respawn churn) and do NOT consume reap attempts.
          # No lock is held during the wait, so a launchd TERM/bootout simply
          # terminates this process cleanly (no orphan, no stale lock).
          log "supervised: watcher already running (pid=$owner_pid), waiting ${SUPERVISED_WAIT_SECONDS}s to take over"
          sleep "$SUPERVISED_WAIT_SECONDS"
          continue
        fi
        if [[ "$supervised" != "1" ]]; then
          log "watcher already running (pid=$owner_pid), exiting"
          exit 0
        fi
        # Supervised but owner is alive yet NOT a watcher (PID reuse) → stale;
        # fall through to reap below.
        log "supervised: lock owner pid=$owner_pid is not a watcher (stale), reaping"
      fi
    fi
    attempt=$((attempt + 1))
    # Step 2 — lock dir missing OR owner dead ⇒ try to grab the reap mutex.
    if mkdir "$WATCHER_REAP_MUTEX" 2>/dev/null; then
      # We hold the reap mutex — serialize the stale-lock cleanup.
      # Step 3 — re-verify under mutex (TOCTOU defense).
      if [[ -d "$WATCHER_LOCK_DIR" ]]; then
        local owner_pid2
        owner_pid2=$(cat "$WATCHER_LOCK_DIR/pid" 2>/dev/null || echo "")
        if [[ -n "$owner_pid2" ]] && kill -0 "$owner_pid2" 2>/dev/null; then
          if [[ "$supervised" == "1" ]] && _pid_is_watcher "$owner_pid2"; then
            # A live watcher (re)appeared under the mutex → release + block-wait.
            rmdir "$WATCHER_REAP_MUTEX" 2>/dev/null || true
            log "supervised: watcher already running (pid=$owner_pid2, post-mutex), waiting ${SUPERVISED_WAIT_SECONDS}s to take over"
            sleep "$SUPERVISED_WAIT_SECONDS"
            attempt=0   # a supervised wait is not a reap-race attempt
            continue
          fi
          if [[ "$supervised" != "1" ]]; then
            rmdir "$WATCHER_REAP_MUTEX" 2>/dev/null || true
            log "watcher already running (pid=$owner_pid2, post-mutex), exiting"
            exit 0
          fi
          # Supervised + alive non-watcher → stale; reap below.
        fi
        rm -rf "$WATCHER_LOCK_DIR"  # truly stale (dead owner, or supervised non-watcher)
      fi
      # Step 4 — try to acquire the lock dir.
      if mkdir "$WATCHER_LOCK_DIR" 2>/dev/null; then
        echo "$$" > "$WATCHER_LOCK_DIR/pid"
        rmdir "$WATCHER_REAP_MUTEX" 2>/dev/null || true
        # FLY-129 Phase 1 (Codex R1 HIGH fix): split traps so TERM/INT
        # actually terminates the watcher. Previously `trap release_watcher_lock
        # EXIT INT TERM` released the lock then bash continued running the
        # watch_loop, leaving a lock-less but still-alive watcher — exactly
        # the double-watcher race the lock was meant to prevent.
        trap release_watcher_lock EXIT
        trap 'release_watcher_lock; exit 130' INT
        trap 'release_watcher_lock; exit 143' TERM
        return 0
      fi
      # mkdir failed — contender created the dir between our rm and mkdir.
      # Drop reap mutex and retry from step 1 (the new owner may be alive).
      rmdir "$WATCHER_REAP_MUTEX" 2>/dev/null || true
    else
      # Another process holds the reap mutex — back off then retry from step 1.
      sleep 1
    fi
    # Bounded retry for the reap-race livelock (unchanged for the unsupervised
    # path). Supervised block-waits reset `attempt`, so they never trip this.
    if [[ "$attempt" -ge 3 ]]; then
      log "watcher lock acquire exhausted retries after 3 attempts, exiting"
      exit 0
    fi
  done
}

release_watcher_lock() {
  # Only remove the lock dir if we still own it. Defensive against
  # "another process took over my PID" (rare but possible after a long crash).
  local owner_pid
  owner_pid=$(cat "$WATCHER_LOCK_DIR/pid" 2>/dev/null || echo "")
  if [[ "$owner_pid" == "$$" ]]; then
    rm -rf "$WATCHER_LOCK_DIR" 2>/dev/null || true
  fi
  # Always drop the reap mutex (no-op if not held).
  rmdir "$WATCHER_REAP_MUTEX" 2>/dev/null || true
}

# ── Main ──
# Guard: only run the case dispatcher when invoked directly (not sourced for tests).
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  return 0 2>/dev/null || true
fi

case "${1:-}" in
  --watch)
    # FLY-129 Phase 1: lock acquisition pushed down from autostart so EVERY
    # entry path to --watch is gated (autostart, manual invocation, supervisor
    # respawn, etc.). Lock release is wired via trap inside acquire_watcher_lock.
    acquire_watcher_lock
    # FLY-129: full --watch body lives in watch_main() so it can use `local`
    # and so health-check gating can wrap cmux ops cleanly.
    watch_main
    ;;
  --refresh)
    # FLY-98: tmux-only repair — safe to call from outside cmux
    refresh_linked_sessions
    ;;
  --wait-for-watcher-exit)
    # FLY-825: called by flywheel-cmux-install.sh between bootout and
    # bootstrap. Safe from outside cmux (no cmux socket needed — pure
    # tmux/process-table operation, same tier as --refresh).
    wait_for_watcher_exit
    ;;
  --once|"")
    sync_once
    ;;
  --list-lead-refs)
    # FLY-129 Phase 8 Path A: print cmux workspace refs for Lead windows.
    # Used by restart-services.sh trigger_cmux_refresh to scope
    # `cmux refresh-surfaces` to Leads (not Runners).
    list_lead_refs
    ;;
  --list-orphan-pins)
    # FLY-293: read-only preview of orphan cmux runner pins the reaper would
    # close (managed title, no live window, no cmux-<title> session). Never
    # closes anything — safe alongside a live --watch. Q1 dry-run.
    list_orphan_pins
    ;;
  --reap-orphan-pins)
    # FLY-293: operator one-shot immediate cleanup — re-derive the orphan set and
    # close each through the revalidating chokepoint (NO grace). Safe alongside a
    # live --watch (narrow + idempotent + per-ref final revalidation).
    reap_orphan_pins_oneshot
    ;;
  *)
    echo "Usage: flywheel-cmux-sync [--once|--watch|--refresh|--wait-for-watcher-exit|--list-lead-refs|--list-orphan-pins|--reap-orphan-pins]"
    echo "  --once              Full sync with aggressive cleanup (cmux + tmux). Manual use from inside cmux."
    echo "  --watch             Event-signaled polling (hooks + 15s drain + 60s additive). From inside cmux."
    echo "  --refresh           tmux-only linked session repair. Safe from anywhere."
    echo "  --wait-for-watcher-exit  FLY-825: poll+kill any lingering --watch process (install-script helper)."
    echo "  --list-lead-refs    Print Lead cmux workspace refs (Phase 8 Path A)."
    echo "  --list-orphan-pins  FLY-293: print orphan runner cmux pins (read-only preview)."
    echo "  --reap-orphan-pins  FLY-293: close orphan runner cmux pins now (one-shot, revalidated)."
    exit 1
    ;;
esac

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
  local ws_ref="$1" reason="$2"
  local dry="${FLYWHEEL_CMUX_DRY_RUN:-0}"
  log "[audit] close workspace=$ws_ref reason=$reason dry_run=$dry"
  [[ "$dry" == "1" ]] && return 0
  cmux_call close-workspace --workspace "$ws_ref" || true
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

# rc=0 only if the surface's screen looks like a BARE SHELL (its last non-empty
# line ends in a shell prompt sigil: % / $ / #). rc=1 otherwise (tmux status
# bar = attached to some session, a TUI, read-screen failure, or anything we
# can't positively classify) — FAIL CLOSED. This is the gate that prevents
# typing into a surface attached to a DIFFERENT tmux session's Claude prompt
# (Codex CR R3 HIGH): an attached surface's bottom line is the tmux status bar,
# never a lone prompt sigil, regardless of which session it's attached to.
# Runs only at a heal attempt (event-driven), not as a periodic scan.
surface_looks_like_bare_shell() {
  local ref="$1" surface_ref="$2" screen last
  screen=$(cmux_call read-screen --workspace "$ref" --surface "$surface_ref") || return 1
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
    printf '%s|%s\n' "$name" "$(date +%s)" >> "$HEAL_STATE"
    log "$msg"
  fi
}

heal_state_clear() {
  local name="$1"
  [[ -f "$HEAL_STATE" ]] || return 0
  local tmp
  tmp=$(mktemp "${HEAL_STATE}.XXXX") || return 0
  awk -F'|' -v n="$name" '$1 != n { print }' "$HEAL_STATE" > "$tmp"
  mv "$tmp" "$HEAL_STATE"
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
  # typing. surface_looks_like_bare_shell requires the screen's last non-empty
  # line to END in a shell prompt sigil (% / $ / #). This is a POSITIVE proof,
  # not a status-bar-absence check: a surface attached to ANY tmux session
  # shows either a status bar or a TUI (Claude) at the bottom — neither ends in
  # a lone prompt sigil — so the gate fails closed for attached-elsewhere
  # surfaces REGARDLESS of whether tmux's status bar is enabled (Codex CR
  # R3 HIGH + R4 MEDIUM). read-screen failure → fail closed.
  surface_looks_like_bare_shell "$ref" "$surface_ref" || return 1
  # ATOMIC re-attach: send the attach command WITH a trailing newline in ONE
  # `cmux send`. There is NO separate `send-key Enter`, so there is no
  # text→Enter gap for a client to attach into between two injections (Codex
  # CR R1 + R4 HIGH). Both gates above are checked immediately before this
  # single injection. printf -v preserves the trailing newline (command
  # substitution would strip it).
  local attach_cmd
  printf -v attach_cmd "tmux attach -t '=%s'\n" "$view_session"
  heal_state_log_once "$wname" "Self-heal: re-attaching '$wname' (0 clients on $view_session, ws $ref surface $surface_ref)"
  cmux_call send --workspace "$ref" --surface "$surface_ref" "$attach_cmd" || true
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
    tmux select-window -t "=${view_session}:=${wname}" 2>/dev/null || true   # safe, no surface input
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
    tmux select-window -t "=${view_session}:=${wname}" 2>/dev/null || true
    cmux_call refresh-surfaces || true
  fi
}

# One-shot sweep of ALL agent windows (bootstrap / health-recovery / --once).
self_heal_sweep_all() {
  local tmux_windows
  tmux_windows=$(get_tmux_agent_windows)
  [[ -z "$tmux_windows" ]] && return 0
  local _s _wid wname
  while IFS='|' read -r _s _wid wname; do
    [[ -z "$wname" ]] && continue
    self_heal_one_workspace "$wname"
  done <<< "$tmux_windows"
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
  #    FLY-98: =name exact match survives window ID changes across restarts.
  if ! linked_session_exists "$view_session" \
     || ! tmux select-window -t "=${view_session}:=${window_name}" 2>/dev/null; then
    log "WARN: $view_session not ready (session/select-window) — deferring create for $window_name"
    return 0
  fi

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
  if ! cmux_call new-workspace --command "tmux attach -t '=${view_session}'"; then
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
  self_heal_sweep_all
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

  cleanup_stale_conservative
}

watch_loop() {
  # Polling loop for --watch mode. Wrapped in a function so `local` is legal.
  # FLY-129 Phase 7: backoff while unhealthy. Healthy ticks stay at 15s so
  # event drain latency is unchanged; degraded paths back off up to 300s.
  local tick=0 sleep_seconds=15
  while true; do
    sleep "$sleep_seconds"
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
      # FLY-169: consume the cmux recovery flag ONCE (set by the health check
      # above on an unhealthy→healthy transition). One-shot heal sweep — covers
      # a cmux restart while this watcher stayed alive (no tmux event, no
      # re-bootstrap). NOT a per-tick scan: the flag is only set on recovery.
      if [[ "$CMUX_HEAL_ON_RECOVERY" == "1" ]]; then
        CMUX_HEAL_ON_RECOVERY=0
        self_heal_sweep_all
      fi
      drain_events
      process_pending_cleanups
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

  # Gate cmux-touching bootstrap: if cmux is broken (rc=2 already exited),
  # skip the full sync but still enter the watch loop. drain_events / loop
  # will retry health every minute.
  if cmux_health_check_or_die; then
    sync_additive_bootstrap
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
  --once|"")
    sync_once
    ;;
  --list-lead-refs)
    # FLY-129 Phase 8 Path A: print cmux workspace refs for Lead windows.
    # Used by restart-services.sh trigger_cmux_refresh to scope
    # `cmux refresh-surfaces` to Leads (not Runners).
    list_lead_refs
    ;;
  *)
    echo "Usage: flywheel-cmux-sync [--once|--watch|--refresh|--list-lead-refs]"
    echo "  --once             Full sync with aggressive cleanup (cmux + tmux). Manual use from inside cmux."
    echo "  --watch            Event-signaled polling (hooks + 15s drain + 60s additive). From inside cmux."
    echo "  --refresh          tmux-only linked session repair. Safe from anywhere."
    echo "  --list-lead-refs   Print Lead cmux workspace refs (Phase 8 Path A)."
    exit 1
    ;;
esac

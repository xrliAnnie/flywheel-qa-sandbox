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
CLEANUP_DELAY_SECONDS="${FLYWHEEL_CMUX_CLEANUP_DELAY:-30}"
CONSERVATIVE_CLEANUP_SECONDS="${FLYWHEEL_CMUX_CONSERVATIVE_CLEANUP:-300}"

# FLY-129 Phase 1: single-watcher lock pushed down from autostart into sync script.
# Any path that starts --watch goes through the same lock; double-mutex protects
# the stale-lock reap from race conditions.
# Env override: FLYWHEEL_CMUX_WATCHER_LOCK_DIR for tests.
WATCHER_LOCK_DIR="${FLYWHEEL_CMUX_WATCHER_LOCK_DIR:-/tmp/flywheel-cmux-watcher.lock}"
WATCHER_REAP_MUTEX="${WATCHER_LOCK_DIR}.reap"

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

  # 2. Select the target window in the linked session (by exact name, not ID)
  # FLY-98: use =name exact match to survive window ID changes across restarts
  tmux select-window -t "=${view_session}:=${window_name}" 2>/dev/null || true

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
    log "WARN: cmux JSON unavailable post-create; cannot rename $window_name this tick"
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
  # FLY-98: tmux-only repair — re-select correct window by name in existing linked sessions.
  # Safe to call from outside cmux (no cmux CLI dependency).
  # Fixes stale current-window pointers after Lead restart (window ID changed, name unchanged).
  local tmux_windows
  tmux_windows=$(get_tmux_agent_windows)
  [[ -z "$tmux_windows" ]] && return 0

  while IFS='|' read -r src_sess wid wname; do
    local view_session="${VIEW_PREFIX}${wname}"
    if linked_session_exists "$view_session"; then
      # Re-select window by exact name — idempotent, harmless if already correct
      tmux select-window -t "=${view_session}:=${wname}" 2>/dev/null || true
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
acquire_watcher_lock() {
  local attempt
  for attempt in 1 2 3; do
    # Step 1 — lock dir exists + owner alive ⇒ already-running, exit 0.
    if [[ -d "$WATCHER_LOCK_DIR" ]]; then
      local owner_pid
      owner_pid=$(cat "$WATCHER_LOCK_DIR/pid" 2>/dev/null || echo "")
      if [[ -n "$owner_pid" ]] && kill -0 "$owner_pid" 2>/dev/null; then
        log "watcher already running (pid=$owner_pid), exiting"
        exit 0
      fi
    fi
    # Step 2 — lock dir missing OR owner dead ⇒ try to grab the reap mutex.
    if mkdir "$WATCHER_REAP_MUTEX" 2>/dev/null; then
      # We hold the reap mutex — serialize the stale-lock cleanup.
      # Step 3 — re-verify under mutex (TOCTOU defense).
      if [[ -d "$WATCHER_LOCK_DIR" ]]; then
        local owner_pid2
        owner_pid2=$(cat "$WATCHER_LOCK_DIR/pid" 2>/dev/null || echo "")
        if [[ -n "$owner_pid2" ]] && kill -0 "$owner_pid2" 2>/dev/null; then
          rmdir "$WATCHER_REAP_MUTEX" 2>/dev/null || true
          log "watcher already running (pid=$owner_pid2, post-mutex), exiting"
          exit 0
        fi
        rm -rf "$WATCHER_LOCK_DIR"  # truly stale
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
  done
  log "watcher lock acquire exhausted retries after 3 attempts, exiting"
  exit 0
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

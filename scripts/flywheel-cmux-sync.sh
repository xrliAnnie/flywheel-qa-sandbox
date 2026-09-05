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

_cmux_sync_source_dir() {
  # The deployed entrypoint is normally ~/.flywheel/bin/flywheel-cmux-sync, a
  # symlink into the main checkout. Resolve the leaf symlink chain so required
  # repo libraries remain available immediately after git updates, before an
  # installer convergence pass has created any sibling links in global bin.
  local source="${BASH_SOURCE[0]}" directory target hops=0
  while [[ -L "$source" ]]; do
    hops=$((hops + 1))
    (( hops <= 32 )) || return 1
    directory="$(cd -P "$(dirname "$source")" && pwd)" || return 1
    target="$(readlink "$source")" || return 1
    case "$target" in
      /*) source="$target" ;;
      *) source="$directory/$target" ;;
    esac
  done
  cd -P "$(dirname "$source")" && pwd
}
if ! _CMUX_SYNC_SCRIPT_DIR="$(_cmux_sync_source_dir)"; then
  echo "[cmux-sync] ERROR: unable to resolve script source directory" >&2
  return 1 2>/dev/null || exit 1
fi
unset -f _cmux_sync_source_dir

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
ATTACH_HEAL_STATE="${ATTACH_HEAL_STATE:-${FLYWHEEL_CMUX_ATTACH_HEAL_STATE:-$HOME/.flywheel/state/cmux-attach-heal}}"
# FLY-1944: bounded external helper-tree reaping. REAP_STATE is the signal
# authority; ORPHAN_STATE is only a two-round observation latch and can never
# authorize a signal by itself.
ATTACH_REAP_STATE="${ATTACH_REAP_STATE:-${FLYWHEEL_CMUX_ATTACH_REAP_STATE:-$HOME/.flywheel/state/cmux-attach-reap}}"
ATTACH_ORPHAN_STATE="${ATTACH_ORPHAN_STATE:-${FLYWHEEL_CMUX_ATTACH_ORPHAN_STATE:-$HOME/.flywheel/state/cmux-attach-orphans}}"
CMUX_SESSION_STATE="${CMUX_SESSION_STATE:-${FLYWHEEL_CMUX_SESSION_STATE:-$HOME/Library/Application Support/cmux/session-com.cmuxterm.app.json}}"
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
# FLY-1364 R6: independent two-pass evidence for pre-ledger stock adoption.
# This must not share STALE_STATE/ORPHAN_PIN_STATE because their lifecycles and
# cleanup keys differ.
ADOPTION_STATE="${ADOPTION_STATE:-$HOME/.flywheel/state/cmux-stock-adoption}"
# FLY-1944: one process-local adoption budget spans private Leads and ordinary
# views in each additive pass. A current-user-owned file is the rollout valve
# (1..10); absence defaults to the safest useful wave, while malformed,
# foreign-owned, or symlinked state disables adoption entirely.
CMUX_ADOPT_CAP_STATE="${CMUX_ADOPT_CAP_STATE:-$HOME/.flywheel/state/cmux-adopt-cap}"
CMUX_ADOPTION_COUNT=0
# FLY-1596: durable transaction markers for adopting restored cmux rows. This
# state must remain separate from ADOPTION_STATE because the stock reaper owns
# a whole-file rewrite and intentionally does not preserve foreign schemas.
RESTORED_STATE="${RESTORED_STATE:-$HOME/.flywheel/state/cmux-restored-adoption}"
RESTORED_BOOTSTRAP_PASS=0

# FLY-685: close-request marker file. close_runner (Bridge, no cmux socket)
# appends a runner's window_name here on a successful window kill; the watcher
# drains it every tick and closes the matching workspace pin IMMEDIATELY (no
# grace) via the FLY-293 revalidating chokepoint. This is the fast path for the
# close_runner case (the FLY-293 reaper's 5-min grace still backstops abnormal
# death). MUST match `DEFAULT_CLOSE_REQUEST_FILE` in
# packages/teamlead/src/bridge/cmux-close-request.ts. Overridable for tests.
CLOSE_REQUEST_FILE="${FLYWHEEL_CMUX_CLOSE_REQUEST_FILE:-/tmp/flywheel-cmux-close-requested}"

# FLY-1272: durable authority for isolated cmux view sessions. VIEW_WAL_DIR
# records tmux mutations before/after each step; VIEW_LEDGER binds cmux refs to
# one socket generation. All paths are overridable so the state machines can be
# tested without touching the resident watcher's production state.
VIEW_WAL_DIR="${VIEW_WAL_DIR:-$HOME/.flywheel/state/cmux-view-wal}"
VIEW_LEDGER="${VIEW_LEDGER:-$HOME/.flywheel/state/cmux-view-ledger}"
KEEPER_INVENTORY="${KEEPER_INVENTORY:-$HOME/.flywheel/state/cmux-keeper-inventory}"
VIEW_ABSENT_STATE="${VIEW_ABSENT_STATE:-$HOME/.flywheel/state/cmux-view-absent}"
CMUX_MAINTENANCE_MARKER="${FLYWHEEL_CMUX_MAINTENANCE_MARKER:-$HOME/.flywheel/state/cmux-maintenance}"
WATCHER_HEARTBEAT_FILE="${FLYWHEEL_CMUX_WATCHER_HEARTBEAT:-$HOME/.flywheel/state/cmux-watcher-heartbeat}"
CMUX_QA_TEARDOWN_CLAIM="${CMUX_MAINTENANCE_MARKER}.qa-teardown"
CMUX_OPS_REBUILD_CLAIM="${CMUX_MAINTENANCE_MARKER}.ops-rebuild"
CMUX_REBUILD_REPORT_DIR="${FLYWHEEL_CMUX_REBUILD_REPORT_DIR:-$HOME/.flywheel/state/cmux-rebuild-reports}"
LEDGER_CONFLICT_STATE="${LEDGER_CONFLICT_STATE:-$HOME/.flywheel/state/cmux-ledger-conflicts}"
ROSTER_EPISODE_STATE="${ROSTER_EPISODE_STATE:-$HOME/.flywheel/state/cmux-roster-episodes}"
CMUX_LOG_EPISODE_STATE="${CMUX_LOG_EPISODE_STATE:-$HOME/.flywheel/state/cmux-log-episodes}"
PREPARED_STALL_STATE="${PREPARED_STALL_STATE:-$HOME/.flywheel/state/cmux-prepared-stall}"
CMUX_ADDITIVE_ROUND_STATE="${CMUX_ADDITIVE_ROUND_STATE:-$HOME/.flywheel/state/cmux-additive-round}"
CMUX_ADDITIVE_ROUND_ID="${CMUX_ADDITIVE_ROUND_ID:-}"
# FLY-1884: execution-scoped presence surfaces for runners that temporarily or
# permanently have no local tmux window. This namespace is intentionally
# separate from the view ledger: a node is keyed by execution_id, while a view
# is keyed by one tmux window title.
NODE_LEDGER="${NODE_LEDGER:-$HOME/.flywheel/state/cmux-node-ledger}"
NODE_REGISTRY="${NODE_REGISTRY:-$HOME/.flywheel/state/cmux-node-registry}"
NODE_STATUS_DIR="${NODE_STATUS_DIR:-${FLYWHEEL_CMUX_NODE_STATUS_DIR:-$HOME/.flywheel/state/cmux-node-status}}"
CLEANUP_SNAPSHOT="${CLEANUP_SNAPSHOT:-$HOME/.flywheel/state/cmux-cleanup-snapshot}"
CLEANUP_SNAPSHOT_EPISODE_STATE="${CLEANUP_SNAPSHOT_EPISODE_STATE:-$HOME/.flywheel/state/cmux-cleanup-snapshot-episode}"
TERMINAL_TEARDOWN_STATE="${TERMINAL_TEARDOWN_STATE:-$HOME/.flywheel/state/cmux-terminal-teardown}"
REBIND_EPISODE_STATE="${REBIND_EPISODE_STATE:-$HOME/.flywheel/state/cmux-view-rebind-episodes}"
REBIND_CONTROL_STATE="${REBIND_CONTROL_STATE:-$HOME/.flywheel/state/cmux-rebind-disabled}"
FLYWHEEL_ENV_FILE="${FLYWHEEL_ENV_FILE:-$HOME/.flywheel/.env}"
FLYWHEEL_LEAD_PLIST_DIR="${FLYWHEEL_LEAD_PLIST_DIR:-$HOME/Library/LaunchAgents}"
FLYWHEEL_MANIFEST_DIR="${FLYWHEEL_MANIFEST_DIR:-$HOME/.flywheel/manifests}"
# FLY-1446 E2: newline-delimited `view|source|window_id` identities whose
# well-formed construction WAL hit a proven canonical-name collision in the
# current reconciliation round. Bash 3.2 has no associative arrays.
CMUX_WAL_BLOCKED_VIEWS="${CMUX_WAL_BLOCKED_VIEWS:-}"
# FLY-1605: process-local transition latch for periodic title-topology
# refusals. Newline-delimited because macOS Bash 3.2 has no associative arrays.
# Inconclusive cmux inventory reads leave it untouched; a conclusive reconcile
# sweep replaces it with the refusals still present in that sweep.
CMUX_TITLE_TOPOLOGY_REFUSED_KEYS="${CMUX_TITLE_TOPOLOGY_REFUSED_KEYS:-}"
# FLY-2266: process-local consecutive missing-client passes for private Leads.
# Newline-delimited because macOS Bash 3.2 has no associative arrays.
V2_LEAD_ATTACH_MISSING_STREAKS=""

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

_CMUX_PROCESS_CENSUS_LIB=""
if [[ -r "$_CMUX_SYNC_SCRIPT_DIR/lib/cmux-mutator-process-census.sh" ]]; then
  _CMUX_PROCESS_CENSUS_LIB="$_CMUX_SYNC_SCRIPT_DIR/lib/cmux-mutator-process-census.sh"
elif [[ -r "$_CMUX_SYNC_SCRIPT_DIR/cmux-mutator-process-census.sh" ]]; then
  # Deployed binaries expose shared libraries as siblings.
  _CMUX_PROCESS_CENSUS_LIB="$_CMUX_SYNC_SCRIPT_DIR/cmux-mutator-process-census.sh"
fi
if [[ -z "$_CMUX_PROCESS_CENSUS_LIB" ]]; then
  log "ERROR: required cmux process census library unavailable"
  return 1 2>/dev/null || exit 1
fi
# shellcheck source=lib/cmux-mutator-process-census.sh
if ! source "$_CMUX_PROCESS_CENSUS_LIB"; then
  log "ERROR: required cmux process census library unavailable"
  return 1 2>/dev/null || exit 1
fi
unset _CMUX_PROCESS_CENSUS_LIB

CMUX_LEAD_ADDRESS_AVAILABLE=0
if [[ -r "$_CMUX_SYNC_SCRIPT_DIR/lib/lead-address.sh" ]]; then
  # shellcheck source=lib/lead-address.sh
  source "$_CMUX_SYNC_SCRIPT_DIR/lib/lead-address.sh"
  CMUX_LEAD_ADDRESS_AVAILABLE=1
elif [[ -r "$_CMUX_SYNC_SCRIPT_DIR/lead-address.sh" ]]; then
  # Deployed binaries expose shared libraries as siblings.
  # shellcheck source=lib/lead-address.sh
  source "$_CMUX_SYNC_SCRIPT_DIR/lead-address.sh"
  CMUX_LEAD_ADDRESS_AVAILABLE=1
fi

# FLY-1364: alerting is optional and fail-open. Repo executions find the
# library under scripts/lib; deployed binaries find its symlink as a sibling.
FLYWHEEL_ALERT_BIN="${FLYWHEEL_CMUX_ALERT_BIN:-$_CMUX_SYNC_SCRIPT_DIR/lead-alert.sh}"
if [[ -r "$_CMUX_SYNC_SCRIPT_DIR/lib/flywheel-alert-lib.sh" ]]; then
  # shellcheck source=lib/flywheel-alert-lib.sh
  source "$_CMUX_SYNC_SCRIPT_DIR/lib/flywheel-alert-lib.sh"
elif [[ -r "$_CMUX_SYNC_SCRIPT_DIR/flywheel-alert-lib.sh" ]]; then
  # shellcheck source=lib/flywheel-alert-lib.sh
  source "$_CMUX_SYNC_SCRIPT_DIR/flywheel-alert-lib.sh"
else
  log "WARN: optional alert library unavailable; alerts disabled"
  flywheel_alert() { return 0; }
fi

_cmux_alert_hash() {
  printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
}

CMUX_CLEANUP_ALERT_LATCH=""
CMUX_CLEANUP_ALERT_LATCH_COUNT=0
CMUX_CLEANUP_ALERT_LATCH_GENERATION=""
CMUX_CLEANUP_ALERT_SATURATION_WARNED=0
_alert_cmux_cleanup() {
  local title="$1" body="$2" signature="$3" key generation generation_key
  if [[ "$signature" == *'|generation='* ]]; then
    generation="${signature#*|generation=}"
    generation="${generation%%|*}"
  else
    generation=$(cmux_socket_identity 2>/dev/null || printf 'unavailable')
  fi
  generation_key=$(_cmux_alert_hash "$generation")
  if [[ "$CMUX_CLEANUP_ALERT_LATCH_GENERATION" != "$generation_key" ]]; then
    CMUX_CLEANUP_ALERT_LATCH=""
    CMUX_CLEANUP_ALERT_LATCH_COUNT=0
    CMUX_CLEANUP_ALERT_SATURATION_WARNED=0
    CMUX_CLEANUP_ALERT_LATCH_GENERATION="$generation_key"
  fi
  key=$(_cmux_alert_hash "$signature")
  if printf '%s\n' "$CMUX_CLEANUP_ALERT_LATCH" | grep -qxF "$key"; then
    return 0
  fi
  # Bound process memory and page volume even if corrupt input manufactures an
  # unbounded stream of distinct refusal signatures. A watcher restart resets
  # the latch, and a cmux generation transition re-arms it for the new app
  # instance, while the downstream alert sink retains its durable dedup.
  if (( CMUX_CLEANUP_ALERT_LATCH_COUNT >= 64 )); then
    if [[ "$CMUX_CLEANUP_ALERT_SATURATION_WARNED" == "0" ]]; then
      CMUX_CLEANUP_ALERT_SATURATION_WARNED=1
      log "WARN: cleanup alert latch saturated for cmux generation; later distinct signatures are locally suppressed until generation changes"
    fi
    return 0
  fi
  CMUX_CLEANUP_ALERT_LATCH+="${CMUX_CLEANUP_ALERT_LATCH:+$'\n'}${key}"
  CMUX_CLEANUP_ALERT_LATCH_COUNT=$((CMUX_CLEANUP_ALERT_LATCH_COUNT + 1))
  flywheel_alert cmux_cleanup warning "$title" "$body" "$signature" || true
  return 0
}

MALFORMED_LEASE_ALERTED_SIG=""
_alert_malformed_mutator_lease() {
  local owner_bytes owner_hash signature
  owner_bytes=$(cat "$WATCHER_LOCK_DIR/owner" 2>/dev/null || printf '<missing>')
  owner_hash=$(_cmux_alert_hash "$owner_bytes")
  signature="cmux_cleanup|lease-malformed|owner_sha256=$owner_hash"
  [[ "$MALFORMED_LEASE_ALERTED_SIG" == "$signature" ]] && return 0
  MALFORMED_LEASE_ALERTED_SIG="$signature"
  _alert_cmux_cleanup \
    "cmux mutator lease malformed" \
    "cmux-sync refused to steal an unverifiable mutator lease at $WATCHER_LOCK_DIR. Manual inspection is required; owner_sha256=$owner_hash." \
    "$signature"
}

# Path of cmux IPC socket. Override via $CMUX_SOCKET_PATH env (cmux's own convention).
CMUX_SOCKET_PATH_DEFAULT="${CMUX_SOCKET_PATH:-/tmp/cmux.sock}"

# FLY-1944: every watcher-side cmux IPC has a hard wall-clock bound. A cmux
# client can remain alive while its IPC loop is wedged; without a bound, one
# call pins the only resident scan loop forever and no later event can be
# observed. macOS ships Bash 3.2, so use job-control process groups instead of
# GNU timeout(1). The marker disambiguates our timeout from a native cmux 124.
CMUX_PING_TIMEOUT_SECONDS="${FLYWHEEL_CMUX_PING_TIMEOUT:-10}"
CMUX_CALL_TIMEOUT_SECONDS="${FLYWHEEL_CMUX_CALL_TIMEOUT:-20}"
CMUX_TIMEOUT_KILL_GRACE_SECONDS="${FLYWHEEL_CMUX_TIMEOUT_KILL_GRACE:-1}"
case "$CMUX_PING_TIMEOUT_SECONDS" in ''|*[!0-9]*|0) CMUX_PING_TIMEOUT_SECONDS=10 ;; esac
case "$CMUX_CALL_TIMEOUT_SECONDS" in ''|*[!0-9]*|0) CMUX_CALL_TIMEOUT_SECONDS=20 ;; esac
case "$CMUX_TIMEOUT_KILL_GRACE_SECONDS" in ''|*[!0-9]*|0) CMUX_TIMEOUT_KILL_GRACE_SECONDS=1 ;; esac
if (( CMUX_PING_TIMEOUT_SECONDS > 60 )); then
  log "WARN: FLYWHEEL_CMUX_PING_TIMEOUT=$CMUX_PING_TIMEOUT_SECONDS exceeds 60s; using default 10s"
  CMUX_PING_TIMEOUT_SECONDS=10
fi
if (( CMUX_CALL_TIMEOUT_SECONDS > 60 )); then
  log "WARN: FLYWHEEL_CMUX_CALL_TIMEOUT=$CMUX_CALL_TIMEOUT_SECONDS exceeds 60s; using default 20s"
  CMUX_CALL_TIMEOUT_SECONDS=20
fi

# Usage: _cmux_bounded_spawn <timeout-seconds> <timeout-marker> <cmux args...>
# The caller MUST create/truncate timeout-marker before entering this helper.
# Stdout/stderr are intentionally untouched, and a native exit status passes
# through. On deadline, the complete cmux process group receives TERM then
# KILL and rc=124 is returned. Keep `cmux ... &` as the first external spawn:
# cmux_call_guarded relies on its guard being the genuine final operation
# before the mutation process starts.
_cmux_bounded_spawn() {
  local timeout_seconds="$1" timeout_marker="$2"
  shift 2
  local command_pid watchdog_pid rc=0 monitor_was_enabled=0
  # The legacy behavioral harness models cmux as a shell function and asserts
  # its in-process mutation trace. Production always resolves an executable;
  # this explicit test seam preserves those assertions while timeout coverage
  # below the seam uses a real fixture process tree.
  if [[ "${FLYWHEEL_CMUX_TEST_SYNC_FUNCTIONS:-0}" == "1" ]] \
     && declare -F cmux >/dev/null 2>&1; then
    cmux "$@" || rc=$?
    [[ "${CMUX_WATCH_HEARTBEAT_ACTIVE:-0}" == "1" ]] \
      && watcher_write_heartbeat call bounded
    return "$rc"
  fi
  case "$-" in *m*) monitor_was_enabled=1 ;; esac
  set -m
  cmux "$@" &
  command_pid=$!
  (
    sleep "$timeout_seconds"
    if kill -0 "$command_pid" 2>/dev/null; then
      printf 'timeout\n' > "$timeout_marker"
      kill -TERM -- "-$command_pid" 2>/dev/null || true
      sleep "$CMUX_TIMEOUT_KILL_GRACE_SECONDS"
      kill -KILL -- "-$command_pid" 2>/dev/null || true
    fi
  ) >/dev/null 2>&1 &
  watchdog_pid=$!

  wait "$command_pid" || rc=$?
  kill -TERM -- "-$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  [[ $monitor_was_enabled -eq 1 ]] || set +m

  [[ "${CMUX_WATCH_HEARTBEAT_ACTIVE:-0}" == "1" ]] \
    && watcher_write_heartbeat call bounded
  [[ -s "$timeout_marker" ]] && return 124
  return "$rc"
}

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
  local err_file timeout_marker out rc=0
  err_file=$(mktemp)
  timeout_marker="${err_file}.timeout"
  : > "$timeout_marker"
  # Pass --socket explicitly so override env actually reaches cmux CLI.
  out=$(_cmux_bounded_spawn "$CMUX_PING_TIMEOUT_SECONDS" "$timeout_marker" --socket "$socket" ping 2>"$err_file") || rc=$?
  local err_text
  err_text=$(cat "$err_file" 2>/dev/null || true)
  rm -f "$err_file" "$timeout_marker"
  if [[ $rc -eq 0 && "$out" == *PONG* ]]; then
    return 0
  fi
  # Match against combined stdout + stderr: cmux may write the access-denied
  # message to either stream depending on protocol stage.
  local combined="${out}${err_text}"
  if printf '%s\n' "$combined" | grep -q "Access denied"; then
    log "ERROR: cmux IPC rejected by app — caller is not a cmux descendant and socketControlMode != allowAll"
    log "ERROR: stderr: ${err_text:-<empty>}"
    log "ERROR: To fix: defaults write com.cmuxterm.app socketControlMode -string allowAll && quit cmux app + relaunch"
    return 2
  fi
  # FLY-129 R2: kernel-level permission denial means socket exists but caller
  # can't open() it (wrong owner / mode 0600 by another user / SIP / etc.).
  # No amount of retrying will fix this — surface as fatal so the lock
  # releases instead of looping forever.
  if printf '%s\n' "$combined" | grep -qE "Permission denied|Operation not permitted"; then
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
  local err_file timeout_marker rc=0
  err_file=$(mktemp)
  timeout_marker="${err_file}.timeout"
  : > "$timeout_marker"
  _cmux_bounded_spawn "$CMUX_CALL_TIMEOUT_SECONDS" "$timeout_marker" --socket "$socket" "$@" 2>"$err_file" || rc=$?
  if [[ $rc -ne 0 ]]; then
    local err_text
    err_text=$(cat "$err_file" 2>/dev/null || true)
    log "WARN: cmux $1 failed (rc=$rc): ${err_text:-<empty>}"
  fi
  rm -f "$err_file" "$timeout_marker"
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
  local err_file timeout_marker rc=0 guard_rc=0
  GUARD_WAS_BLOCKED=0
  err_file=$(mktemp) || return 1
  timeout_marker="${err_file}.timeout"
  : > "$timeout_marker"
  "$guard_fn" || guard_rc=$?
  if [[ $guard_rc -ne 0 ]]; then
    rm -f "$err_file" "$timeout_marker"
    GUARD_WAS_BLOCKED=1
    return 1
  fi
  _cmux_bounded_spawn "$CMUX_CALL_TIMEOUT_SECONDS" "$timeout_marker" --socket "$socket" "$@" 2>"$err_file" || rc=$?
  if [[ $rc -ne 0 ]]; then
    local err_text
    err_text=$(cat "$err_file" 2>/dev/null || true)
    log "WARN: cmux $1 failed (rc=$rc): ${err_text:-<empty>}"
  fi
  rm -f "$err_file" "$timeout_marker"
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

get_tmux_agent_windows() {
  # Returns: session_name|window_id|window_name per line
  # Scans 'flywheel' (Leads) and 'runner-*' (Runners) sessions.
  # Excludes default shell windows (zsh/bash).
  local all_windows=""

  # 1. Flywheel session (Leads)
  all_windows+=$(tmux list-windows -t "$FLYWHEEL_SESSION" -F "#{session_name}|#{window_id}|#{window_name}" 2>/dev/null || true)

  # 2. Runner sessions: runner-<projectName>
  local runner_sessions
  runner_sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E '^runner-' || true)
  if [[ -n "$runner_sessions" ]]; then
    while read -r rsess; do
      local rwindows
      rwindows=$(tmux list-windows -t "$rsess" -F "#{session_name}|#{window_id}|#{window_name}" 2>/dev/null || true)
      if [[ -n "$rwindows" ]]; then
        all_windows+=$'\n'"$rwindows"
      fi
    done < <(printf '%s\n' "$runner_sessions")
  fi

  # Filter out default shell windows
  echo "$all_windows" | grep -v '|zsh$' | grep -v '|bash$' | grep -v '^$' || true
}

# ── FLY-1446: authoritative Lead/Runner roster read phase ──

classify_lead_carrier() {
  local wrapper="$1" backend="$2"
  case "$wrapper" in
    flywheel-lead-wrapper-v2.sh)
      [[ "$backend" == "claude-code" ]] \
        && printf 'claude-private\n' \
        || printf 'config-drift\n'
      ;;
    flywheel-codex-lead-wrapper-mufasa-tui.sh|\
    flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh|\
    flywheel-codex-lead-wrapper-codex-infra-bot.sh|\
    flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh)
      printf 'codex-tui-cmux\n'
      ;;
    *) printf 'config-drift\n' ;;
  esac
}

lead_job_loaded() {
  launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1
}

lead_plist_wrapper_basename() {
  plutil -convert json -o - "$1" 2>/dev/null | python3 -c '
import json,os,sys
d=json.load(sys.stdin)
args=d.get("ProgramArguments")
if not isinstance(args,list) or len(args) < 2 or not isinstance(args[1],str) or not args[1]:
    raise SystemExit(1)
print(os.path.basename(args[1]))
' 2>/dev/null
}

lead_manifest_fields() {
  python3 - "$1" <<'PY'
import json,re,sys
with open(sys.argv[1], encoding="utf-8") as f:
    d=json.load(f)
project=d.get("projectName")
lead=d.get("leadId")
backend=(d.get("leadBackend") or {}).get("backendId")
socket=d.get("socketPath")
safe=re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
if not isinstance(project,str) or not safe.fullmatch(project):
    raise SystemExit(1)
if not isinstance(lead,str) or not safe.fullmatch(lead):
    raise SystemExit(1)
if backend is None:
    backend=""
if not isinstance(backend,str) or "|" in backend or "\n" in backend:
    raise SystemExit(1)
if socket is None:
    socket=""
if not isinstance(socket,str) or "|" in socket or "\n" in socket:
    raise SystemExit(1)
print(f"{project}|{lead}|{backend}|{socket}")
PY
}

LEAD_ROSTER_STATE="indeterminate"
LEAD_ROSTER_ROWS=""
LEAD_ROSTER_REASONS=""
derive_lead_roster() {
  # Rows: carrier|launchd-label|expected-title|private-socket. No row is published until
  # every loaded job has been parsed and classified successfully.
  local plist label slug wrapper manifest fields project lead backend socket carrier title rows="" canonical_socket
  LEAD_ROSTER_STATE="indeterminate"
  LEAD_ROSTER_ROWS=""
  LEAD_ROSTER_REASONS=""
  for plist in "$FLYWHEEL_LEAD_PLIST_DIR"/com.flywheel.lead.*.plist; do
    [[ -f "$plist" ]] || continue
    label=$(basename "$plist" .plist)
    lead_job_loaded "$label" || continue
    slug=${label#com.flywheel.lead.}
    wrapper=$(lead_plist_wrapper_basename "$plist") || {
      LEAD_ROSTER_REASONS="roster-authority-unavailable: invalid plist $slug"
      return 1
    }
    manifest="$FLYWHEEL_MANIFEST_DIR/${slug}.json"
    [[ -f "$manifest" ]] || {
      LEAD_ROSTER_REASONS="roster-authority-unavailable: missing manifest $slug"
      return 1
    }
    fields=$(lead_manifest_fields "$manifest" 2>/dev/null) || {
      LEAD_ROSTER_REASONS="roster-authority-unavailable: invalid manifest $slug"
      return 1
    }
    IFS='|' read -r project lead backend socket < <(printf '%s\n' "$fields")
    title="${project}-${lead}"
    # The launchd label and manifest identity must describe the same slot.
    [[ "$slug" == "$title" ]] || {
      LEAD_ROSTER_REASONS="roster-authority-unavailable: manifest identity mismatch $slug"
      return 1
    }
    carrier=$(classify_lead_carrier "$wrapper" "$backend") || {
      LEAD_ROSTER_REASONS="roster-authority-unavailable: carrier classification failed $slug"
      return 1
    }
    if [[ "$carrier" == "claude-private" ]]; then
      [[ "$CMUX_LEAD_ADDRESS_AVAILABLE" == "1" ]] || {
        LEAD_ROSTER_REASONS="roster-authority-unavailable: Lead address helper missing"
        return 1
      }
      canonical_socket=$(derive_lead_socket "${project}/${lead}" "${FLYWHEEL_LEAD_STATE_DIR:-$HOME/.flywheel}") || {
        LEAD_ROSTER_REASONS="roster-authority-unavailable: cannot derive private socket $slug"
        return 1
      }
      [[ "$socket" == "$canonical_socket" ]] || {
        LEAD_ROSTER_REASONS="roster-authority-unavailable: noncanonical private socket $slug"
        return 1
      }
    else
      socket=""
    fi
    rows+="${rows:+$'\n'}${carrier}|${label}|${title}|${socket}"
  done
  LEAD_ROSTER_ROWS="$rows"
  LEAD_ROSTER_STATE="ok"
}

ROSTER_TMUX_STATE="indeterminate"
ROSTER_TMUX_WINDOWS=""
read_roster_tmux_inventory() {
  # Typed, atomic snapshot for the read-only roster phase. Unlike the legacy
  # get_tmux_agent_windows helper, one failed session read is never collapsed
  # into an apparently healthy empty inventory.
  local sessions relevant="" session rows tmp
  ROSTER_TMUX_STATE="indeterminate"
  ROSTER_TMUX_WINDOWS=""
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null) || return 1
  while IFS= read -r session; do
    [[ -n "$session" ]] || continue
    case "$session" in
      flywheel|runner-*) relevant+="${relevant:+$'\n'}${session}" ;;
    esac
  done < <(printf '%s\n' "$sessions")
  if [[ -z "$relevant" ]]; then
    ROSTER_TMUX_STATE="ok_empty"
    return 0
  fi
  tmp=$(mktemp) || return 1
  while IFS= read -r session; do
    rows=$(tmux list-windows -t "$session" \
      -F '#{session_name}|#{window_id}|#{window_name}' 2>/dev/null) || {
      rm -f "$tmp"; return 1;
    }
    while IFS='|' read -r observed_session wid title extra; do
      [[ -n "$observed_session$wid$title${extra:-}" ]] || continue
      if [[ -n "${extra:-}" || "$observed_session" != "$session" \
          || -z "$title" ]]; then
        rm -f "$tmp"
        return 1
      fi
      case "$wid" in
        @*) case "${wid#@}" in ''|*[!0-9]*) rm -f "$tmp"; return 1 ;; esac ;;
        *)
        rm -f "$tmp"
        return 1
        ;;
      esac
      case "$title" in zsh|bash) continue ;; esac
      printf '%s|%s|%s\n' "$observed_session" "$wid" "$title" >> "$tmp" || {
        rm -f "$tmp"; return 1;
      }
    done < <(printf '%s\n' "$rows")
  done < <(printf '%s\n' "$relevant")
  ROSTER_TMUX_WINDOWS=$(cat "$tmp") || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  [[ -n "$ROSTER_TMUX_WINDOWS" ]] \
    && ROSTER_TMUX_STATE="ok_nonempty" \
    || ROSTER_TMUX_STATE="ok_empty"
  return 0
}

ROSTER_EPISODE_CHANGED=0
ROSTER_EPISODE_NUMBER=0
roster_episode_transition() {
  # kind|subject|episode|state, with state healthy|unhealthy.
  local kind="$1" subject="$2" desired="$3" previous episode state dir tmp
  case "$kind$subject" in *'|'*|*$'\n'*) return 1 ;; esac
  case "$desired" in healthy|unhealthy) ;; *) return 1 ;; esac
  ROSTER_EPISODE_CHANGED=0
  ROSTER_EPISODE_NUMBER=0
  dir=$(dirname "$ROSTER_EPISODE_STATE")
  mkdir -p "$dir" 2>/dev/null || return 1
  touch "$ROSTER_EPISODE_STATE" 2>/dev/null || return 1
  previous=$(awk -F'|' -v k="$kind" -v s="$subject" \
    'NF == 4 && $1 == k && $2 == s { print $3 "|" $4; exit }' \
    "$ROSTER_EPISODE_STATE" 2>/dev/null || true)
  episode=${previous%%|*}
  state=${previous#*|}
  [[ "$previous" == *'|'* ]] || { episode=0; state=""; }
  ROSTER_EPISODE_NUMBER=$episode
  [[ "$state" == "$desired" ]] && return 0
  [[ "$desired" == "healthy" && -z "$state" ]] && return 0
  [[ "$desired" == "unhealthy" ]] && episode=$((10#${episode:-0} + 1))
  tmp=$(mktemp "${ROSTER_EPISODE_STATE}.XXXX" 2>/dev/null) || return 1
  awk -F'|' -v k="$kind" -v s="$subject" \
    '!($1 == k && $2 == s) { print }' "$ROSTER_EPISODE_STATE" > "$tmp" 2>/dev/null || {
    rm -f "$tmp"; return 1;
  }
  printf '%s|%s|%s|%s\n' "$kind" "$subject" "$episode" "$desired" >> "$tmp" || {
    rm -f "$tmp"; return 1;
  }
  mv "$tmp" "$ROSTER_EPISODE_STATE" 2>/dev/null || { rm -f "$tmp"; return 1; }
  ROSTER_EPISODE_CHANGED=1
  ROSTER_EPISODE_NUMBER=$episode
}

roster_alert_unhealthy() {
  local kind="$1" subject="$2" title="$3" body="$4" signature_subject="${5:-$2}"
  roster_episode_transition "$kind" "$subject" unhealthy || {
    log "WARN: cannot persist roster alert episode kind=$kind subject=$subject"
    return 0
  }
  [[ "$ROSTER_EPISODE_CHANGED" == "1" ]] || return 0
  _alert_cmux_cleanup "$title" "$body" \
    "cmux_cleanup|${kind}|${signature_subject}|e${ROSTER_EPISODE_NUMBER}"
}

roster_mark_healthy() {
  roster_episode_transition "$1" "$2" healthy || {
    log "WARN: cannot re-arm roster alert episode kind=$1 subject=$2"
    return 0
  }
}

roster_rearm_absent_subjects() {
  local kind="$1" current="$2" subject
  [[ -f "$ROSTER_EPISODE_STATE" ]] || return 0
  while IFS= read -r subject; do
    [[ -n "$subject" ]] || continue
    printf '%s\n' "$current" | grep -qxF "$subject" \
      || roster_mark_healthy "$kind" "$subject"
  done < <(printf '%s\n' "$(awk -F'|' -v k="$kind" 'NF == 4 && $1 == k { print $2 }' "$ROSTER_EPISODE_STATE")")
}

reconcile_lead_roster() {
  local carrier label title socket current_missing="" current_config="" legacy_expected=0
  if ! derive_lead_roster || [[ "$LEAD_ROSTER_STATE" != "ok" ]]; then
    roster_alert_unhealthy roster-derive-failed lead-roster \
      "cmux Lead roster derivation failed" \
      "At least one loaded Lead plist/manifest could not be parsed consistently. No partial roster conclusions were emitted."
    return 0
  fi
  roster_mark_healthy roster-derive-failed lead-roster
  while IFS='|' read -r carrier label title socket; do
    [[ -n "$carrier$title" ]] || continue
    if [[ "$carrier" == "config-drift" ]]; then
      current_config+="${current_config:+$'\n'}${label}"
      roster_alert_unhealthy config-drift "$label" \
        "cmux Lead carrier config drift" \
        "Loaded Lead $label is outside the closed windowed carrier matrix; wrapper/backend configuration must be repaired."
    else
      roster_mark_healthy config-drift "$label"
    fi
  done < <(printf '%s\n' "$LEAD_ROSTER_ROWS")
  roster_rearm_absent_subjects config-drift "$current_config"

  while IFS='|' read -r carrier label title socket; do
    if [[ "$carrier" == "claude-private" ]]; then
      if tmux -S "$socket" has-session -t '=main' >/dev/null 2>&1; then
        roster_mark_healthy lead-window-missing "$title"
      else
        current_missing+="${current_missing:+$'\n'}${title}"
        roster_alert_unhealthy lead-window-missing "$title" \
          "cmux private Lead terminal missing" \
          "Loaded Lead $label has no main session at its canonical private socket."
      fi
      continue
    fi
    if [[ "$carrier" == "claude-tmux" || "$carrier" == "codex-tui-cmux" ]]; then
      legacy_expected=1
    fi
  done < <(printf '%s\n' "$LEAD_ROSTER_ROWS")

  if [[ "$legacy_expected" == "1" ]]; then
    if ! read_roster_tmux_inventory \
        || [[ "$ROSTER_TMUX_STATE" == "indeterminate" ]]; then
      roster_alert_unhealthy roster-blind lead-tmux \
        "cmux Lead roster inventory unavailable" \
        "The typed shared-tmux inventory was inconclusive. Existing v1 Lead subject states were preserved."
      return 0
    fi
    roster_mark_healthy roster-blind lead-tmux
  else
    roster_mark_healthy roster-blind lead-tmux
  fi
  while IFS='|' read -r carrier label title socket; do
    [[ "$carrier" == "claude-tmux" || "$carrier" == "codex-tui-cmux" ]] || continue
    if printf '%s\n' "$ROSTER_TMUX_WINDOWS" \
        | awk -F'|' -v t="$title" '$1 == "flywheel" && $3 == t { found=1 } END { exit(found ? 0 : 1) }'; then
      roster_mark_healthy lead-window-missing "$title"
    else
      current_missing+="${current_missing:+$'\n'}${title}"
      roster_alert_unhealthy lead-window-missing "$title" \
        "cmux Lead window missing" \
        "Loaded Lead $label expects flywheel:=$title, but the conclusive tmux inventory contains no such window. The watcher will not silently infer a tab from titles."
    fi
  done < <(printf '%s\n' "$LEAD_ROSTER_ROWS")
  roster_rearm_absent_subjects lead-window-missing "$current_missing"
}

load_flywheel_env_value() {
  local name="$1" allow_inherited="${2:-1}" inherited="" raw=""
  FLYWHEEL_ENV_VALUE=""
  if [[ "$allow_inherited" == "1" ]]; then
    eval "inherited=\${${name}+set}"
    [[ "$inherited" == "set" ]] && eval "raw=\${${name}}"
  fi
  if [[ -z "$raw" && -f "$FLYWHEEL_ENV_FILE" ]]; then
    raw=$(awk -v key="$name" '
      /^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
        line=$0
        sub(/^[[:space:]]*export[[:space:]]+/, "", line)
        lhs=line; sub(/[[:space:]]*=.*/, "", lhs)
        if (lhs == key) {
          sub(/^[^=]*=[[:space:]]*/, "", line)
          sub(/[[:space:]]*#.*/, "", line)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
          if ((line ~ /^".*"$/) || (line ~ /^'\''.*'\''$/)) {
            line=substr(line, 2, length(line)-2)
          }
          value=line
        }
      }
      END { if (value != "") print value }
    ' "$FLYWHEEL_ENV_FILE") || return 1
  fi
  case "$raw" in *$'\n'*|*$'\r'*) return 1 ;; esac
  FLYWHEEL_ENV_VALUE="$raw"
}

# FLY-2281: cmux persists processTitle as immutable birth evidence, so the
# attach helper's tmux executable choice is part of the command identity. The
# watcher is launched with a minimal environment; resolve the same inherited-
# first .env contract as the helper and pin one validated value per pass.
CMUX_ATTACH_TMUX_BIN_CACHE_READY=0
CMUX_ATTACH_TMUX_BIN_CACHE_VALUE=""
CMUX_ATTACH_TMUX_BIN_READ_VALUE=""
CMUX_ATTACH_TMUX_BIN_READ_REASON=""
CMUX_ATTACH_TMUX_BIN_READ_RAW=""
CMUX_ATTACH_TMUX_BIN_ERROR_SIG=""
CMUX_ATTACH_TMUX_BIN_EPISODE=0

_read_cmux_attach_tmux_bin() {
  local value
  CMUX_ATTACH_TMUX_BIN_READ_VALUE=""
  CMUX_ATTACH_TMUX_BIN_READ_REASON=""
  CMUX_ATTACH_TMUX_BIN_READ_RAW=""
  if ! load_flywheel_env_value FLYWHEEL_CMUX_ATTACH_TMUX_BIN 1; then
    CMUX_ATTACH_TMUX_BIN_READ_REASON=env-read-failed
    return 1
  fi
  value="$FLYWHEEL_ENV_VALUE"
  FLYWHEEL_ENV_VALUE=""
  CMUX_ATTACH_TMUX_BIN_READ_RAW="$value"
  [[ -n "$value" ]] || return 0
  case "$value" in
    *"'"*|*$'\n'*|*$'\r'*)
      CMUX_ATTACH_TMUX_BIN_READ_REASON=unsafe-bytes
      return 1
      ;;
  esac
  case "$value" in
    /*) ;;
    *)
      CMUX_ATTACH_TMUX_BIN_READ_REASON=not-absolute
      return 1
      ;;
  esac
  if [[ ! -x "$value" ]]; then
    CMUX_ATTACH_TMUX_BIN_READ_REASON=not-executable
    return 1
  fi
  CMUX_ATTACH_TMUX_BIN_READ_VALUE="$value"
}

cmux_attach_tmux_bin_cache_prime() {
  local reason value_hash signature
  CMUX_ATTACH_TMUX_BIN_CACHE_READY=0
  CMUX_ATTACH_TMUX_BIN_CACHE_VALUE=""
  if _read_cmux_attach_tmux_bin; then
    CMUX_ATTACH_TMUX_BIN_CACHE_READY=1
    CMUX_ATTACH_TMUX_BIN_CACHE_VALUE="$CMUX_ATTACH_TMUX_BIN_READ_VALUE"
    CMUX_ATTACH_TMUX_BIN_ERROR_SIG=""
    return 0
  fi

  CMUX_ATTACH_TMUX_BIN_CACHE_READY=2
  reason="${CMUX_ATTACH_TMUX_BIN_READ_REASON:-unknown}"
  value_hash=$(_cmux_alert_hash "$CMUX_ATTACH_TMUX_BIN_READ_RAW")
  signature="$reason|$value_hash"
  if [[ "$CMUX_ATTACH_TMUX_BIN_ERROR_SIG" != "$signature" ]]; then
    CMUX_ATTACH_TMUX_BIN_EPISODE=$((CMUX_ATTACH_TMUX_BIN_EPISODE + 1))
    CMUX_ATTACH_TMUX_BIN_ERROR_SIG="$signature"
    log "WARN: invalid FLYWHEEL_CMUX_ATTACH_TMUX_BIN refused reason=$reason value_sha256=$value_hash"
    _alert_cmux_cleanup \
      "cmux attach tmux configuration refused" \
      "cmux-sync refused an invalid FLYWHEEL_CMUX_ATTACH_TMUX_BIN value; view creation is deferred until the configuration is repaired. reason=$reason value_sha256=$value_hash" \
      "cmux_cleanup|attach-tmux-bin-invalid|reason=$reason|value_sha256=$value_hash|episode=$CMUX_ATTACH_TMUX_BIN_EPISODE"
  fi
  return 1
}

resolve_cmux_attach_tmux_bin() {
  case "$CMUX_ATTACH_TMUX_BIN_CACHE_READY" in
    1)
      printf '%s' "$CMUX_ATTACH_TMUX_BIN_CACHE_VALUE"
      return 0
      ;;
    2) return 1 ;;
  esac
  _read_cmux_attach_tmux_bin || return 1
  printf '%s' "$CMUX_ATTACH_TMUX_BIN_READ_VALUE"
}

validate_loopback_bridge_url() {
  python3 - "$1" <<'PY' >/dev/null 2>&1
import sys,urllib.parse
raw=sys.argv[1]
if not raw or raw != raw.strip():
    raise SystemExit(1)
try:
    u=urllib.parse.urlsplit(raw)
    port=u.port
except ValueError:
    raise SystemExit(1)
if u.scheme != "http" or u.hostname not in {"127.0.0.1","localhost"}:
    raise SystemExit(1)
if u.username is not None or u.password is not None:
    raise SystemExit(1)
if u.path or u.query or u.fragment or "?" in raw or "#" in raw:
    raise SystemExit(1)
if port is not None and not (1 <= port <= 65535):
    raise SystemExit(1)
PY
}

RUNNER_BRIDGE_URL=""
resolve_runner_bridge_url() {
  local url port
  load_flywheel_env_value FLYWHEEL_BRIDGE_URL 1 || return 1
  url="$FLYWHEEL_ENV_VALUE"
  if [[ -z "$url" ]]; then
    load_flywheel_env_value TEAMLEAD_PORT 1 || return 1
    port="${FLYWHEEL_ENV_VALUE:-9876}"
    case "$port" in ''|*[!0-9]*) return 1 ;; esac
    (( 10#$port >= 1 && 10#$port <= 65535 )) || return 1
    url="http://127.0.0.1:${port}"
  fi
  validate_loopback_bridge_url "$url" || return 1
  RUNNER_BRIDGE_URL="$url"
}

RUNNER_EXPECTED_STATE="indeterminate"
RUNNER_EXPECTED_EXEC_IDS=""
RUNNER_ACTIVE_ROWS=""

_fetch_runner_roster_json() {
  local query="$1" token escaped
  resolve_runner_bridge_url || return 1
  load_flywheel_env_value TEAMLEAD_API_TOKEN 0 || return 1
  token="$FLYWHEEL_ENV_VALUE"
  [[ -n "$token" ]] || return 1
  escaped=${token//\\/\\\\}
  escaped=${escaped//\"/\\\"}
  printf 'header = "Authorization: Bearer %s"\n' "$escaped" \
    | curl --silent --show-error --fail --max-time 2 --config - \
      "${RUNNER_BRIDGE_URL}/api/sessions?${query}" 2>/dev/null
}

_parse_runner_roster_json() {
  local kind="$1"
  python3 -c '
import json,sys
kind=sys.argv[1]
d=json.load(sys.stdin)
rows=d.get("sessions")
count=d.get("count")
if not isinstance(rows,list) or type(count) is not int or count != len(rows):
    raise SystemExit(1)
live={"pending","running","ship_parked","awaiting_review","design_done","approved_to_ship"}
terminal={"completed","terminated","failed","blocked","timeout","canceled","cancelled","rejected","deferred","shelved","approved"}
allowed=live if kind == "live" else terminal
seen=set()
def field(row,name,limit=240):
    value=row.get(name)
    if value is None or value == "": return "-"
    if not isinstance(value,(str,int)): raise SystemExit(1)
    value=str(value).replace("|"," ").replace("\t"," ").replace("\r"," ").replace("\n"," ")
    return value[:limit] or "-"
out=[]
for row in rows:
    if not isinstance(row,dict): raise SystemExit(1)
    execution_id=row.get("execution_id")
    status=row.get("status")
    if not isinstance(execution_id,str) or not execution_id or any(c in execution_id for c in "|\t\r\n"):
        raise SystemExit(1)
    if execution_id in seen or status not in allowed: raise SystemExit(1)
    seen.add(execution_id)
    out.append("|".join([
        execution_id,
        field(row,"workflow_node_id",80), field(row,"identifier",80),
        field(row,"session_role",80), status, field(row,"adapter_type",80),
        field(row,"heartbeat_at",64), field(row,"issue_title"),
        field(row,"last_activity_at",64), field(row,"decision_route",80),
        field(row,"pr_number",20), field(row,"issue_url"),
    ]))
print("\n".join(sorted(out)))
' "$kind"
}

fetch_active_runner_roster() {
  local response parsed
  RUNNER_EXPECTED_STATE="indeterminate"
  RUNNER_EXPECTED_EXEC_IDS=""
  RUNNER_ACTIVE_ROWS=""
  response=$(_fetch_runner_roster_json 'mode=live') || return 1
  parsed=$(printf '%s' "$response" | _parse_runner_roster_json live) || return 1
  RUNNER_ACTIVE_ROWS="$parsed"
  RUNNER_EXPECTED_EXEC_IDS=$(printf '%s\n' "$parsed" | awk -F'|' 'NF { print $1 }')
  RUNNER_EXPECTED_STATE="ok"
}

RUNNER_TERMINAL_STATE="indeterminate"
RUNNER_TERMINAL_ROWS=""
fetch_recent_terminal_runner_roster() {
  local response parsed hours="${FLYWHEEL_CMUX_NODE_RECENT_HOURS:-48}"
  RUNNER_TERMINAL_STATE="indeterminate"
  RUNNER_TERMINAL_ROWS=""
  case "$hours" in ''|*[!0-9]*) hours=48 ;; esac
  (( ${#hours} <= 3 && 10#$hours >= 1 && 10#$hours <= 168 )) || hours=48
  response=$(_fetch_runner_roster_json "mode=recent_terminal&hours=${hours}") || return 1
  parsed=$(printf '%s' "$response" | _parse_runner_roster_json terminal) || return 1
  RUNNER_TERMINAL_ROWS="$parsed"
  RUNNER_TERMINAL_STATE="ok"
}

RUNNER_TMUX_STATE="indeterminate"
RUNNER_TMUX_EXEC_ROWS=""
read_runner_tmux_exec_inventory() {
  local raw parsed
  RUNNER_TMUX_STATE="indeterminate"
  RUNNER_TMUX_EXEC_ROWS=""
  raw=$(tmux list-windows -a \
    -F $'#{session_name}\t#{window_id}\t#{@flywheel_exec_id}' 2>/dev/null) || return 1
  parsed=$(printf '%s\n' "$raw" | python3 -c '
import re,sys
seen={}
for line in sys.stdin.read().splitlines():
    if not line:
        continue
    parts=line.split("\t")
    if len(parts) != 3:
        raise SystemExit(1)
    session,wid,execution_id=parts
    if not session or not re.fullmatch(r"@[0-9]+",wid):
        raise SystemExit(1)
    if not execution_id:
        continue
    if any(c in execution_id for c in "|\t\r\n"):
        raise SystemExit(1)
    seen.setdefault(execution_id,set()).add(wid)
for execution_id in sorted(seen):
    ids=sorted(seen[execution_id])
    if len(ids) == 1:
        print(f"{execution_id}|present|{ids[0]}")
    else:
        print(execution_id + "|indeterminate|" + ",".join(ids))
') || return 1
  RUNNER_TMUX_EXEC_ROWS="$parsed"
  RUNNER_TMUX_STATE="ok"
}

RUNNER_NODE_TMUX_STATE="indeterminate"
RUNNER_NODE_TMUX_ROWS=""
read_runner_tmux_node_inventory() {
  local raw parsed
  RUNNER_NODE_TMUX_STATE="indeterminate"
  RUNNER_NODE_TMUX_ROWS=""
  raw=$(tmux list-windows -a \
    -F $'#{session_name}\t#{window_id}\t#{window_name}\t#{@flywheel_exec_id}' 2>/dev/null) || return 1
  parsed=$(printf '%s\n' "$raw" | python3 -c '
import re,sys
seen={}
for line in sys.stdin.read().splitlines():
    if not line: continue
    parts=line.split("\t")
    if len(parts) != 4: raise SystemExit(1)
    session,wid,title,execution_id=parts
    if not session or not re.fullmatch(r"@[0-9]+",wid): raise SystemExit(1)
    if not execution_id: continue
    if any(c in execution_id+title+session for c in "|\t\r\n"): raise SystemExit(1)
    seen.setdefault(execution_id,[]).append((wid,title,session))
for execution_id in sorted(seen):
    rows=sorted(set(seen[execution_id]))
    sources=[row for row in rows if row[2] == "flywheel" or row[2].startswith("runner-")]
    identities={(wid,title) for wid,title,_ in rows}
    if len(sources) == 1 and len(identities) == 1:
        wid,title,session=sources[0]
        print(f"{execution_id}|present|{wid}|{title}|{session}")
    else:
        print(f"{execution_id}|indeterminate|-|-|-")
') || return 1
  RUNNER_NODE_TMUX_ROWS="$parsed"
  RUNNER_NODE_TMUX_STATE="ok"
}

_additive_round_id_valid() {
  local round="$1" epoch sequence
  case "$round" in *[!0-9-]*|*-*-*|-*|*-) return 1 ;; esac
  [[ "$round" == *-* ]] || return 1
  epoch="${round%%-*}"; sequence="${round#*-}"
  [[ ${#epoch} -le 12 && ${#sequence} -le 6 ]]
}

node_registry_valid() {
  [[ -e "$NODE_REGISTRY" ]] || return 0
  [[ -f "$NODE_REGISTRY" && -r "$NODE_REGISTRY" ]] || return 1
  python3 - "$NODE_REGISTRY" <<'PY' >/dev/null 2>&1
import re,sys
seen_exec=set(); seen_title=set()
states={"admitted","active-windowed","active-windowless","unresolved-summary","terminal-summary"}
round_id=re.compile(r"([0-9]{1,12})-([0-9]{1,6})")
for raw in open(sys.argv[1], encoding="utf-8"):
    line=raw.rstrip("\n")
    if not line: continue
    p=line.split("|")
    if len(p) != 13 or not p[0] or p[3] not in states: raise SystemExit(1)
    if p[0] in seen_exec or (p[1] != "-" and p[1] in seen_title): raise SystemExit(1)
    if any(not p[i].isdigit() or len(p[i]) > 18 for i in (4,6,7,8,9,12)): raise SystemExit(1)
    if any(not round_id.fullmatch(p[i]) for i in (5,11)): raise SystemExit(1)
    if any(any(c in value for c in "\t\r\n") for value in p): raise SystemExit(1)
    seen_exec.add(p[0])
    if p[1] != "-": seen_title.add(p[1])
PY
}

node_registry_row() {
  local exec_id="$1"
  [[ -f "$NODE_REGISTRY" ]] || return 1
  awk -F'|' -v e="$exec_id" '$1 == e { print; found=1; exit } END { exit(found ? 0 : 1) }' "$NODE_REGISTRY"
}

node_registry_upsert_row() {
  local row="$1" exec_id="${1%%|*}" dir tmp
  node_registry_valid || return 1
  dir=$(dirname "$NODE_REGISTRY")
  mkdir -p "$dir" || return 1
  [[ -f "$NODE_REGISTRY" ]] || : > "$NODE_REGISTRY"
  tmp=$(mktemp "${NODE_REGISTRY}.XXXX") || return 1
  awk -F'|' -v e="$exec_id" '$1 != e { print }' "$NODE_REGISTRY" > "$tmp" || {
    rm -f "$tmp"; return 1;
  }
  printf '%s\n' "$row" >> "$tmp" || { rm -f "$tmp"; return 1; }
  node_registry_valid_file() {
    local saved="$NODE_REGISTRY" rc
    NODE_REGISTRY="$1"; node_registry_valid; rc=$?; NODE_REGISTRY="$saved"
    return "$rc"
  }
  node_registry_valid_file "$tmp" || { unset -f node_registry_valid_file; rm -f "$tmp"; return 1; }
  unset -f node_registry_valid_file
  mv "$tmp" "$NODE_REGISTRY"
}

node_registry_remove_exec() {
  local exec_id="$1" tmp
  [[ -f "$NODE_REGISTRY" ]] || return 0
  node_registry_valid || return 1
  tmp=$(mktemp "${NODE_REGISTRY}.XXXX") || return 1
  awk -F'|' -v e="$exec_id" '$1 != e { print }' "$NODE_REGISTRY" > "$tmp" \
    && mv "$tmp" "$NODE_REGISTRY"
}

admit_node_identity_for_window() {
  local session="$1" wid="$2" mirror_title="$3" observed observed_wid observed_title exec_id old
  local title alias state last_seen last_ok windowed windowless missing summary last_mirror classification terminal_epoch
  local now round
  observed=$(tmux display-message -p -t "=${session}:${wid}" \
    '#{window_id}|#{window_name}|#{@flywheel_exec_id}' 2>/dev/null) || return 1
  IFS='|' read -r observed_wid observed_title exec_id < <(printf '%s\n' "$observed")
  [[ "$observed_wid" == "$wid" && "$observed_title" == "$mirror_title" && -n "$exec_id" ]] || return 1
  case "$exec_id" in *'|'*|*$'\t'*|*$'\n'*|*$'\r'*) return 1 ;; esac
  old=$(node_registry_row "$exec_id" 2>/dev/null || true)
  if [[ -n "$old" ]]; then
    IFS='|' read -r _ title alias state last_seen last_ok windowed windowless missing summary last_mirror classification terminal_epoch < <(printf '%s\n' "$old")
  else
    title=-; alias=-; state=admitted; windowed=0; windowless=0; missing=0; summary=0; terminal_epoch=0
  fi
  now=$(date +%s); round="${CMUX_ADDITIVE_ROUND_ID:-0-0}"
  _additive_round_id_valid "$round" || round=0-0
  # Re-read immediately before the durable identity write. A vanished or
  # reused @id gets no registration authority.
  [[ "$(tmux display-message -p -t "=${session}:${wid}" \
    '#{window_id}|#{window_name}|#{@flywheel_exec_id}' 2>/dev/null)" == "$observed" ]] || return 1
  node_registry_upsert_row "$exec_id|$title|$alias|admitted|$now|$round|$windowed|$windowless|0|0|$mirror_title|$round|0"
}

node_display_alias() {
  local identifier="$1" role="$2" fallback="$3" alias
  [[ "$identifier" == "-" ]] && identifier=""
  [[ "$role" == "-" ]] && role=""
  alias="${identifier}${identifier:+${role:+-}}${role}"
  [[ -n "$alias" ]] || alias="${fallback:0:16}"
  printf '%s' "$alias" | LC_ALL=C sed 's/[^A-Za-z0-9._-]/-/g; s/--*/-/g; s/^-//; s/-$//' | cut -c1-80
}

node_allocate_authority_title() {
  local exec_id="$1" identifier="$2" role="$3" existing alias digest width suffix candidate owner
  existing=$(node_registry_row "$exec_id" 2>/dev/null || true)
  if [[ -n "$existing" && "$(printf '%s' "$existing" | cut -d'|' -f2)" != "-" ]]; then
    printf '%s\n' "$(printf '%s' "$existing" | cut -d'|' -f2)"
    return 0
  fi
  digest=$(_cmux_alert_hash "$exec_id")
  alias=$(node_display_alias "$identifier" "$role" "$digest")
  width=16
  while (( width <= 64 )); do
    suffix="${digest:0:$width}"
    if [[ -n "$identifier" && "$identifier" != "-" || -n "$role" && "$role" != "-" ]]; then
      candidate="node:${alias}·${suffix}"
    else
      candidate="node:${suffix}"
    fi
    owner=""
    [[ -f "$NODE_REGISTRY" ]] \
      && owner=$(awk -F'|' -v t="$candidate" '$2 == t { print $1; exit }' "$NODE_REGISTRY" 2>/dev/null || true)
    if [[ -z "$owner" || "$owner" == "$exec_id" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
    width=$((width + 2))
  done
  return 1
}

node_status_path() {
  local digest
  digest=$(_cmux_alert_hash "$1")
  printf '%s/%s.status\n' "$NODE_STATUS_DIR" "$digest"
}

build_node_status_command() {
  local status_file="$1" helper="${FLYWHEEL_CMUX_NODE_STATUS_BIN:-$HOME/.flywheel/bin/flywheel-node-status.sh}"
  case "$status_file" in /*) ;; *) return 1 ;; esac
  case "$helper" in /*) ;; *) return 1 ;; esac
  case "$status_file$helper" in *"'"*|*$'\n'*|*$'\r'*) return 1 ;; esac
  [[ -x "$helper" ]] || {
    _alert_cmux_cleanup \
      "cmux node status helper unavailable" \
      "cmux-sync deferred node surfaces because the status helper is unavailable: helper=$helper." \
      "cmux_cleanup|helper-missing|node-status|helper=$helper"
    return 1
  }
  printf "env -u TMUX '%s' '%s'" "$helper" "$status_file"
}

node_status_label() {
  local lifecycle="$1" shape="$2" adapter="$3"
  if [[ "$shape" == "terminal-summary" ]]; then
    printf '已结束'
  elif [[ "$shape" == "unresolved-summary" ]]; then
    printf '失联 · 无法确认终态'
  elif [[ "$shape" == "active-windowed" ]]; then
    printf '运行中 · tmux 镜像可用'
  elif [[ "$adapter" == *remote* || "$adapter" == *headless* ]]; then
    printf 'remote/headless 形态 · 无本地窗'
  elif [[ "$lifecycle" == "ship_parked" || "$lifecycle" == "awaiting_review" || "$lifecycle" == "approved_to_ship" ]]; then
    printf '停驻中 · 等待后续动作'
  else
    printf '等待重生 · 当前无本地窗'
  fi
}

node_write_status_file() {
  local row="$1" shape="$2" terminal="${3:-0}"
  local exec_id node_id identifier role status adapter heartbeat issue_title last_activity route pr_number issue_url
  local path dir tmp label now
  IFS='|' read -r exec_id node_id identifier role status adapter heartbeat issue_title last_activity route pr_number issue_url < <(printf '%s\n' "$row")
  path=$(node_status_path "$exec_id") || return 1
  dir=$(dirname "$path"); mkdir -p "$dir" || return 1
  tmp=$(mktemp "${path}.XXXX") || return 1
  [[ "$terminal" == "1" ]] && shape=terminal-summary
  label=$(node_status_label "$status" "$shape" "$adapter")
  now=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
  {
    printf 'Flywheel 节点 · %s\n' "$identifier"
    printf '状态: %s\n' "$label"
    printf 'Execution: %s\n' "$exec_id"
    [[ "$node_id" == "-" ]] || printf 'Workflow node: %s\n' "$node_id"
    [[ "$issue_title" == "-" ]] || printf 'Issue: %s\n' "$issue_title"
    printf 'Lifecycle: %s\n' "$status"
    [[ "$heartbeat" == "-" ]] || printf 'Heartbeat: %s\n' "$heartbeat"
    if [[ "$terminal" == "1" ]]; then
      [[ "$route" == "-" ]] || printf 'Decision route: %s\n' "$route"
      [[ "$pr_number" == "-" ]] || printf 'PR: #%s\n' "$pr_number"
      [[ "$issue_url" == "-" ]] || printf 'Issue URL: %s\n' "$issue_url"
      [[ "$last_activity" == "-" ]] || printf 'Completed at: %s\n' "$last_activity"
    fi
    printf 'Updated: %s\n' "$now"
  } > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$path"
}

node_ledger_exact_state() {
  local generation="$1" ref="$2" exec_id="$3" title="$4"
  [[ -f "$NODE_LEDGER" ]] || return 1
  awk -F'|' -v g="$generation" -v r="$ref" -v e="$exec_id" -v t="$title" '
    NF == 5 && ($1 == "prepared" || $1 == "committed") && $2 == g && $3 == r && $4 == e && $5 == t {n++; s=$1}
    END {if (n == 1) print s; else exit 1}' "$NODE_LEDGER"
}

node_workspace_ready() {
  local exec_id="$1" title="$2" generation ref state workspace surface
  generation=$(cmux_socket_identity 2>/dev/null) || return 1
  [[ -f "$NODE_LEDGER" ]] || return 1
  ref=$(awk -F'|' -v g="$generation" -v e="$exec_id" -v t="$title" \
    '$1 == "committed" && $2 == g && $4 == e && $5 == t {n++; r=$3} END {if(n==1) print r}' "$NODE_LEDGER")
  [[ -n "$ref" ]] || return 1
  state=$(node_ledger_exact_state "$generation" "$ref" "$exec_id" "$title") || return 1
  [[ "$state" == "committed" ]] || return 1
  workspace=$(workspace_title_for_ref "$ref") || return 1
  surface=$(workspace_single_surface_title "$ref") || return 1
  [[ "$workspace" == "$title" && -n "$surface" ]]
}

node_mirror_surface_ready() {
  local mirror_title="$1" generation refs ref state workspace surface count=0
  [[ -n "$mirror_title" && "$mirror_title" != "-" ]] || return 1
  generation=$(cmux_socket_identity) || return 1
  refs=$(ledger_refs_for_title "$generation" "$mirror_title")
  while IFS= read -r ref; do
    [[ -n "$ref" ]] || continue
    state=$(ledger_exact_receipt_state "$generation" "$ref" "$mirror_title" 2>/dev/null || true)
    [[ "$state" == "committed" ]] || continue
    workspace=$(workspace_title_for_ref "$ref" 2>/dev/null || true)
    surface=$(workspace_single_surface_title "$ref" 2>/dev/null || true)
    [[ "$workspace" == "$mirror_title" && "$surface" == "$mirror_title" ]] || continue
    count=$((count + 1))
  done < <(printf '%s\n' "$refs")
  [[ "$count" == 1 ]]
}

node_cleanup_freshness_allows() {
  local mirror_title="$1" marker_epoch="$2" marker_round_epoch="${3:-}" marker_round_sequence="${4:-}"
  local header kind snapshot_round_epoch snapshot_round_sequence snapshot_epoch completeness
  local exec_id title alias state last_seen last_ok windowed windowless missing summary last_mirror classification terminal_epoch
  case "$marker_epoch" in ''|*[!0-9]*) return 1 ;; esac
  (( ${#marker_epoch} <= 18 )) || return 1
  node_registry_valid || return 1
  [[ -f "$CLEANUP_SNAPSHOT" && -r "$CLEANUP_SNAPSHOT" ]] || return 1
  header=$(head -1 "$CLEANUP_SNAPSHOT" 2>/dev/null || true)
  IFS='|' read -r kind snapshot_round_epoch snapshot_round_sequence snapshot_epoch completeness < <(printf '%s\n' "$header")
  [[ "$kind" == snapshot && "$completeness" == complete ]] || return 1
  case "$snapshot_round_epoch$snapshot_round_sequence$snapshot_epoch" in ''|*[!0-9]*) return 1 ;; esac
  (( ${#snapshot_round_epoch} <= 12 && ${#snapshot_round_sequence} <= 6 && ${#snapshot_epoch} <= 18 )) || return 1
  if [[ -n "$marker_round_epoch" || -n "$marker_round_sequence" ]]; then
    [[ -n "$marker_round_epoch" && -n "$marker_round_sequence" ]] || return 1
    case "$marker_round_epoch$marker_round_sequence" in *[!0-9]*) return 1 ;; esac
    (( ${#marker_round_epoch} <= 12 && ${#marker_round_sequence} <= 6 )) || return 1
    (( 10#$snapshot_epoch > 10#$marker_epoch \
       || (10#$snapshot_epoch == 10#$marker_epoch \
           && (10#$snapshot_round_epoch > 10#$marker_round_epoch \
               || (10#$snapshot_round_epoch == 10#$marker_round_epoch \
                   && 10#$snapshot_round_sequence > 10#$marker_round_sequence))) )) || return 1
  else
    (( 10#$snapshot_epoch > 10#$marker_epoch )) || return 1
  fi
  python3 - "$CLEANUP_SNAPSHOT" <<'PY' >/dev/null 2>&1 || return 1
import sys
for i,raw in enumerate(open(sys.argv[1], encoding="utf-8")):
    p=raw.rstrip("\n").split("|")
    if i == 0:
        if len(p) != 5: raise SystemExit(1)
    elif len(p) != 3 or p[0] not in {"active","protected"} or not p[1]:
        raise SystemExit(1)
PY
  while IFS='|' read -r exec_id title alias state last_seen last_ok windowed windowless missing summary last_mirror classification terminal_epoch; do
    [[ "$last_mirror" == "$mirror_title" ]] || continue
    case "$state" in
      active-windowless|unresolved-summary|terminal-summary)
        node_workspace_ready "$exec_id" "$title" || return 1
        ;;
      *) return 1 ;;
    esac
  done < "$NODE_REGISTRY"
  awk -F'|' -v t="$mirror_title" 'NR > 1 && $2 == t {found=1} END {exit(found ? 0 : 1)}' \
    "$CLEANUP_SNAPSHOT" 2>/dev/null && return 1
  return 0
}

_cleanup_snapshot_file_valid() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" && -r "$path" ]] || return 1
  python3 - "$path" <<'PY' >/dev/null 2>&1
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    rows = [line.rstrip("\n") for line in handle]
if not rows or not re.fullmatch(r"snapshot\|[0-9]{1,12}\|[0-9]{1,6}\|[0-9]{1,18}\|complete", rows[0]):
    raise SystemExit(1)
for row in rows[1:]:
    fields = row.split("|")
    if (len(fields) != 3 or fields[0] not in {"active", "protected"}
            or not fields[1] or not fields[2]
            or any(any(ord(char) < 32 or ord(char) == 127 for char in value) for value in fields)):
        raise SystemExit(1)
PY
}

_cleanup_snapshot_progress_key() {
  local header
  _cleanup_snapshot_file_valid "$CLEANUP_SNAPSHOT" || { printf 'invalid\n'; return 0; }
  header=$(head -1 "$CLEANUP_SNAPSHOT") || { printf 'invalid\n'; return 0; }
  _cmux_alert_hash "$header"
}

_cleanup_snapshot_progress_epoch() {
  local header kind round_epoch round_sequence snapshot_epoch completeness
  _cleanup_snapshot_file_valid "$CLEANUP_SNAPSHOT" || return 1
  header=$(head -1 "$CLEANUP_SNAPSHOT") || return 1
  IFS='|' read -r kind round_epoch round_sequence snapshot_epoch completeness < <(printf '%s\n' "$header")
  printf '%s\n' "$snapshot_epoch"
}

_write_cleanup_snapshot_episode() {
  local row="$1" dir tmp
  dir=$(dirname "$CLEANUP_SNAPSHOT_EPISODE_STATE")
  mkdir -p "$dir" || return 1
  tmp=$(mktemp "${CLEANUP_SNAPSHOT_EPISODE_STATE}.XXXX") || return 1
  printf '%s\n' "$row" > "$tmp" \
    && mv "$tmp" "$CLEANUP_SNAPSHOT_EPISODE_STATE" \
    || { rm -f "$tmp"; return 1; }
}

cleanup_snapshot_stall_observe() {
  local blocked_count="$1" oldest_marker_epoch="$2" key now state="" version state_key first_epoch alerted extra
  local progress_epoch age oldest_age
  case "$blocked_count$oldest_marker_epoch" in *[!0-9]*) return 1 ;; esac
  now=$(date +%s)
  key=$(_cleanup_snapshot_progress_key)
  if [[ -e "$CLEANUP_SNAPSHOT_EPISODE_STATE" || -L "$CLEANUP_SNAPSHOT_EPISODE_STATE" ]]; then
    [[ -f "$CLEANUP_SNAPSHOT_EPISODE_STATE" && ! -L "$CLEANUP_SNAPSHOT_EPISODE_STATE" \
        && -r "$CLEANUP_SNAPSHOT_EPISODE_STATE" ]] || return 1
    state=$(cat "$CLEANUP_SNAPSHOT_EPISODE_STATE" 2>/dev/null || true)
    IFS='|' read -r version state_key first_epoch alerted extra < <(printf '%s\n' "$state")
    if [[ "$version" != snapshotstallv1 || -n "$extra" || -z "$state_key" \
        || "$first_epoch$alerted" == *[!0-9]* || ${#first_epoch} -gt 18 \
        || ${#alerted} -gt 1 || "$alerted" -gt 1 ]]; then
      return 1
    fi
  fi
  if [[ -n "$state" && "$state_key" != "$key" ]]; then
    rm -f "$CLEANUP_SNAPSHOT_EPISODE_STATE"
    state=""
  fi
  (( blocked_count > 0 )) || return 0
  if [[ -z "$state" ]]; then
    progress_epoch=$(_cleanup_snapshot_progress_epoch 2>/dev/null || true)
    case "$progress_epoch" in ''|*[!0-9]*) first_epoch="$now" ;; *) first_epoch="$progress_epoch" ;; esac
    (( first_epoch <= now )) || first_epoch="$now"
    alerted=0
    _write_cleanup_snapshot_episode "snapshotstallv1|$key|$first_epoch|0" || return 1
  fi
  age=$((now - first_epoch))
  (( age >= 86400 && alerted == 0 )) || return 0
  oldest_age=$((now - oldest_marker_epoch)); (( oldest_age >= 0 )) || oldest_age=0
  _alert_cmux_cleanup \
    "cmux cleanup snapshot progress stalled" \
    "Cleanup has $blocked_count blocked marker(s), oldest ${oldest_age}s, while the authoritative snapshot tuple has not advanced for ${age}s." \
    "cmux_cleanup|snapshot-progress-stalled|episode=$key"
  _write_cleanup_snapshot_episode "snapshotstallv1|$key|$first_epoch|1"
}

node_write_cleanup_snapshot() {
  local round="${CMUX_ADDITIVE_ROUND_ID:-0-0}" round_epoch round_sequence epoch tmp dir generation bound exec_id title alias state
  local old_header old_kind old_round_epoch old_round_sequence old_epoch old_completeness
  local last_seen last_ok windowed windowless missing summary last_mirror classification terminal_epoch ledger_title ledger_exec
  node_registry_valid || return 1
  _additive_round_id_valid "$round" || return 1
  round_epoch="${round%%-*}"; round_sequence="${round#*-}"
  epoch=$(date +%s)
  if _cleanup_snapshot_file_valid "$CLEANUP_SNAPSHOT"; then
    old_header=$(head -1 "$CLEANUP_SNAPSHOT") || return 1
    IFS='|' read -r old_kind old_round_epoch old_round_sequence old_epoch old_completeness < <(printf '%s\n' "$old_header")
    (( 10#$epoch > 10#$old_epoch \
       || (10#$epoch == 10#$old_epoch \
           && (10#$round_epoch > 10#$old_round_epoch \
               || (10#$round_epoch == 10#$old_round_epoch \
                   && 10#$round_sequence > 10#$old_round_sequence))) )) || return 1
  fi
  dir=$(dirname "$CLEANUP_SNAPSHOT"); mkdir -p "$dir" || return 1
  tmp=$(mktemp "${CLEANUP_SNAPSHOT}.XXXX") || return 1
  printf 'snapshot|%s|%s|%s|complete\n' "$round_epoch" "$round_sequence" "$epoch" > "$tmp"
  while IFS='|' read -r exec_id title alias state last_seen last_ok windowed windowless missing summary last_mirror classification terminal_epoch; do
    [[ -n "$exec_id" && "$last_mirror" != "-" ]] || continue
    case "$state" in
      active-windowless|unresolved-summary|terminal-summary)
        node_workspace_ready "$exec_id" "$title" \
          || printf 'protected|%s|%s\n' "$last_mirror" "$exec_id" >> "$tmp"
        ;;
      *) printf 'protected|%s|%s\n' "$last_mirror" "$exec_id" >> "$tmp" ;;
    esac
  done < "$NODE_REGISTRY"
  generation=$(cmux_socket_identity 2>/dev/null || true)
  if [[ -n "$generation" && -f "$VIEW_LEDGER" ]]; then
    while IFS='|' read -r _ _ _ ledger_title _; do
      [[ -n "$ledger_title" ]] || continue
      bound=$(awk -F'|' -v t="$ledger_title" '$11 == t {print $1; exit}' "$NODE_REGISTRY")
      if [[ -z "$bound" ]]; then
        printf 'protected|%s|-\n' "$ledger_title" >> "$tmp"
        _alert_cmux_cleanup \
          "cmux mirror lacks execution identity" \
          "A current-generation mirror receipt cannot be bound to an execution and is preserved for manual review: title=$ledger_title generation=$generation." \
          "cmux_cleanup|unbound-mirror|generation=$generation|title=$ledger_title"
      fi
    done < <(awk -F'|' -v g="$generation" '($1 == "prepared" || $1 == "committed") && $2 == g {print}' "$VIEW_LEDGER")
  fi
  sort -u "$tmp" -o "$tmp"
  # sort would move the header; restore a typed header-first snapshot.
  { printf 'snapshot|%s|%s|%s|complete\n' "$round_epoch" "$round_sequence" "$epoch"; grep -v '^snapshot|' "$tmp" || true; } > "${tmp}.ordered"
  _cleanup_snapshot_file_valid "${tmp}.ordered" \
    && mv "${tmp}.ordered" "$CLEANUP_SNAPSHOT" \
    && rm -f "$tmp" \
    || { rm -f "$tmp" "${tmp}.ordered"; return 1; }
}

node_publish_cleanup_snapshot() {
  node_write_cleanup_snapshot && return 0
  _alert_cmux_cleanup \
    "cmux cleanup snapshot publish failed" \
    "The complete node roster was reconciled, but its authoritative cleanup snapshot could not be published; destructive cleanup remains fenced." \
    "cmux_cleanup|snapshot-publish-failed|round=${CMUX_ADDITIVE_ROUND_ID:-invalid}"
  return 1
}

terminal_teardown_state_valid() {
  [[ -e "$TERMINAL_TEARDOWN_STATE" || -L "$TERMINAL_TEARDOWN_STATE" ]] || return 0
  [[ -f "$TERMINAL_TEARDOWN_STATE" && ! -L "$TERMINAL_TEARDOWN_STATE" && -r "$TERMINAL_TEARDOWN_STATE" ]] || return 1
  python3 - "$TERMINAL_TEARDOWN_STATE" <<'PY' >/dev/null 2>&1
import re
import sys

seen = set()
for raw in open(sys.argv[1], encoding="utf-8"):
    row = raw.rstrip("\n").split("|")
    if len(row) != 13 or row[0] != "terminalv1" or not row[1] or row[1] in seen:
        raise SystemExit(1)
    if not re.fullmatch(r"[0-9a-f]{64}", row[2]) or not re.fullmatch(r"[0-9]{1,2}", row[3]) or int(row[3]) > 10:
        raise SystemExit(1)
    if not re.fullmatch(r"[0-9]{1,12}-[0-9]{1,6}", row[4]):
        raise SystemExit(1)
    if row[5] not in {"observing", "intent", "source-closed"} or not row[6]:
        raise SystemExit(1)
    if row[8] != "-" and not re.fullmatch(r"@[0-9]+", row[8]):
        raise SystemExit(1)
    for value in row[9:11]:
        if value != "-" and not re.fullmatch(r"[0-9a-f]{64}", value):
            raise SystemExit(1)
    if row[11] != "-" and not re.fullmatch(r"workspace:[0-9]+", row[11]):
        raise SystemExit(1)
    if row[12] != "-" and not re.fullmatch(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}", row[12]):
        raise SystemExit(1)
    if any(any(ord(char) < 32 or ord(char) == 127 for char in value) for value in row):
        raise SystemExit(1)
    seen.add(row[1])
PY
}

terminal_teardown_state_row() {
  local exec_id="$1"
  terminal_teardown_state_valid || return 1
  [[ -f "$TERMINAL_TEARDOWN_STATE" ]] || return 1
  awk -F'|' -v e="$exec_id" '$2 == e { print; found=1; exit } END { exit(found ? 0 : 1) }' \
    "$TERMINAL_TEARDOWN_STATE"
}

terminal_teardown_state_upsert() {
  local row="$1" exec_id dir tmp
  exec_id=$(printf '%s\n' "$row" | cut -d'|' -f2)
  terminal_teardown_state_valid || return 1
  dir=$(dirname "$TERMINAL_TEARDOWN_STATE"); mkdir -p "$dir" || return 1
  tmp=$(mktemp "${TERMINAL_TEARDOWN_STATE}.XXXX") || return 1
  if [[ -f "$TERMINAL_TEARDOWN_STATE" ]]; then
    awk -F'|' -v e="$exec_id" '$2 != e { print }' "$TERMINAL_TEARDOWN_STATE" > "$tmp" \
      || { rm -f "$tmp"; return 1; }
  fi
  printf '%s\n' "$row" >> "$tmp" || { rm -f "$tmp"; return 1; }
  local saved="$TERMINAL_TEARDOWN_STATE"
  TERMINAL_TEARDOWN_STATE="$tmp"
  terminal_teardown_state_valid || { TERMINAL_TEARDOWN_STATE="$saved"; rm -f "$tmp"; return 1; }
  TERMINAL_TEARDOWN_STATE="$saved"
  mv "$tmp" "$TERMINAL_TEARDOWN_STATE"
}

terminal_teardown_clear() {
  local exec_id="$1" tmp
  terminal_teardown_state_valid || return 1
  [[ -f "$TERMINAL_TEARDOWN_STATE" ]] || return 0
  tmp=$(mktemp "${TERMINAL_TEARDOWN_STATE}.XXXX") || return 1
  awk -F'|' -v e="$exec_id" '$2 != e { print }' "$TERMINAL_TEARDOWN_STATE" > "$tmp" \
    && mv "$tmp" "$TERMINAL_TEARDOWN_STATE" \
    || { rm -f "$tmp"; return 1; }
}

terminal_teardown_finish_source_closed() {
  local exec_id="$1" mirror_title="$2"
  is_managed_runner_title "$mirror_title" || return 1
  printf '%s\n' "$mirror_title" >> "$CLOSE_REQUEST_FILE" || return 1
  terminal_teardown_clear "$exec_id"
}

terminal_teardown_roster_still_exact() {
  local exec_id="$1" terminal_hash="$2" row
  fetch_active_runner_roster || return 1
  [[ "$RUNNER_EXPECTED_STATE" == ok ]] || return 1
  printf '%s\n' "$RUNNER_ACTIVE_ROWS" \
    | awk -F'|' -v e="$exec_id" '$1 == e { found=1 } END { exit(found ? 0 : 1) }' \
    && return 1
  fetch_recent_terminal_runner_roster || return 1
  [[ "$RUNNER_TERMINAL_STATE" == ok ]] || return 1
  row=$(printf '%s\n' "$RUNNER_TERMINAL_ROWS" | awk -F'|' -v e="$exec_id" '$1 == e { print; exit }')
  [[ -n "$row" && "$(_cmux_alert_hash "$row")" == "$terminal_hash" ]]
}

node_mirror_has_unique_execution_owner() {
  local exec_id="$1" mirror_title="$2"
  node_registry_valid || return 1
  [[ -f "$NODE_REGISTRY" ]] || return 1
  awk -F'|' -v e="$exec_id" -v t="$mirror_title" \
    '$11 == t { count++; owner=$1 } END { exit(count == 1 && owner == e ? 0 : 1) }' \
    "$NODE_REGISTRY"
}

terminal_teardown_crash_point() {
  [[ "${FLYWHEEL_CMUX_TERMINAL_CRASH_AT:-}" == "$1" ]] && kill -KILL "$$"
  return 0
}

terminal_teardown_source_transaction() {
  local exec_id="$1" terminal_hash="$2" count="$3" round="$4" mirror_title="$5" prior="${6:-}"
  local version prior_exec prior_hash prior_count prior_round phase prior_mirror prior_session prior_wid
  local prior_tmux_hash prior_cmux_hash prior_ref prior_uuid extra
  local inv session wid observed tmux_generation cmux_generation tmux_hash cmux_hash refs ref receipt uuid
  local current_inventory global_rows
  if [[ -n "$prior" ]]; then
    IFS='|' read -r version prior_exec prior_hash prior_count prior_round phase prior_mirror prior_session prior_wid \
      prior_tmux_hash prior_cmux_hash prior_ref prior_uuid extra < <(printf '%s\n' "$prior")
  else
    phase=observing
  fi
  if [[ "$phase" == source-closed ]]; then
    [[ "$prior_hash" == "$terminal_hash" && "$prior_mirror" == "$mirror_title" ]] || return 1
    terminal_teardown_finish_source_closed "$exec_id" "$mirror_title"
    return
  fi
  terminal_teardown_roster_still_exact "$exec_id" "$terminal_hash" || return 1
  node_mirror_has_unique_execution_owner "$exec_id" "$mirror_title" || return 1
  tmux_generation=$(tmux_server_generation) || return 1
  cmux_generation=$(cmux_socket_identity) || return 1
  tmux_hash=$(_cmux_alert_hash "$tmux_generation")
  cmux_hash=$(_cmux_alert_hash "$cmux_generation")
  read_runner_tmux_node_inventory || return 1
  [[ "$RUNNER_NODE_TMUX_STATE" == ok ]] || return 1
  inv=$(printf '%s\n' "$RUNNER_NODE_TMUX_ROWS" | awk -F'|' -v e="$exec_id" '$1 == e { print; exit }')
  if [[ -z "$inv" && "$phase" == intent ]]; then
    [[ "$prior_hash" == "$terminal_hash" && "$prior_mirror" == "$mirror_title" \
        && "$prior_tmux_hash" == "$tmux_hash" && "$prior_cmux_hash" == "$cmux_hash" ]] || return 1
    [[ "$(ledger_exact_receipt_state "$cmux_generation" "$prior_ref" "$mirror_title" 2>/dev/null || true)" == committed ]] || return 1
    [[ "$(ledger_exact_receipt_uuid "$cmux_generation" "$prior_ref" "$mirror_title" 2>/dev/null || true)" == "$prior_uuid" ]] || return 1
    workspace_identity_matches "$prior_ref" "$mirror_title" "$prior_uuid" || return 1
    terminal_teardown_state_upsert \
      "terminalv1|$exec_id|$terminal_hash|$count|$round|source-closed|$mirror_title|$prior_session|$prior_wid|$tmux_hash|$cmux_hash|$prior_ref|$prior_uuid" \
      || return 1
    terminal_teardown_crash_point after-source-close
    terminal_teardown_finish_source_closed "$exec_id" "$mirror_title"
    return
  fi
  [[ -n "$inv" ]] || return 1
  IFS='|' read -r _ _ wid _ session < <(printf '%s\n' "$inv")
  [[ "$inv" == "$exec_id|present|$wid|$mirror_title|$session" ]] || return 1
  if [[ "$phase" == intent ]]; then
    [[ "$prior_session" == "$session" && "$prior_wid" == "$wid" \
        && "$prior_tmux_hash" == "$tmux_hash" && "$prior_cmux_hash" == "$cmux_hash" ]] || return 1
  fi
  refs=$(ledger_refs_for_title "$cmux_generation" "$mirror_title") || return 1
  [[ "$(printf '%s\n' "$refs" | grep -c . || true)" == 1 ]] || return 1
  ref="$refs"
  receipt=$(ledger_exact_receipt_state "$cmux_generation" "$ref" "$mirror_title") || return 1
  [[ "$receipt" == committed ]] || return 1
  uuid=$(ledger_exact_receipt_uuid "$cmux_generation" "$ref" "$mirror_title") || return 1
  [[ "$uuid" != __LEGACY__ ]] || return 1
  workspace_identity_matches "$ref" "$mirror_title" "$uuid" || return 1
  observed=$(tmux display-message -p -t "=${session}:${wid}" \
    '#{session_name}|#{window_id}|#{window_name}|#{@flywheel_exec_id}|#{pane_dead}' 2>/dev/null) || return 1
  [[ "$observed" == "$session|$wid|$mirror_title|$exec_id|0" \
      || "$observed" == "$session|$wid|$mirror_title|$exec_id|1" ]] || return 1
  terminal_teardown_roster_still_exact "$exec_id" "$terminal_hash" || return 1
  node_mirror_has_unique_execution_owner "$exec_id" "$mirror_title" || return 1
  [[ "$(tmux_server_generation 2>/dev/null || true)" == "$tmux_generation" \
      && "$(cmux_socket_identity 2>/dev/null || true)" == "$cmux_generation" ]] || return 1
  read_runner_tmux_node_inventory || return 1
  [[ "$RUNNER_NODE_TMUX_STATE" == ok ]] || return 1
  current_inventory=$(printf '%s\n' "$RUNNER_NODE_TMUX_ROWS" | awk -F'|' -v e="$exec_id" '$1 == e { print; exit }')
  [[ "$current_inventory" == "$inv" ]] || return 1
  [[ "$(ledger_exact_receipt_state "$cmux_generation" "$ref" "$mirror_title" 2>/dev/null || true)" == committed \
      && "$(ledger_exact_receipt_uuid "$cmux_generation" "$ref" "$mirror_title" 2>/dev/null || true)" == "$uuid" ]] || return 1
  workspace_identity_matches "$ref" "$mirror_title" "$uuid" || return 1
  watcher_mutation_latch_clear || return 1
  terminal_teardown_state_upsert \
    "terminalv1|$exec_id|$terminal_hash|$count|$round|intent|$mirror_title|$session|$wid|$tmux_hash|$cmux_hash|$ref|$uuid" \
    || return 1
  tmux kill-window -t "=${session}:${wid}" 2>/dev/null || return 1
  tmux display-message -p -t "=${session}:${wid}" '#{window_id}' >/dev/null 2>&1 && return 1
  global_rows=$(tmux list-windows -a -F '#{session_name}|#{window_id}|#{window_name}|#{@flywheel_exec_id}' 2>/dev/null) || return 1
  printf '%s\n' "$global_rows" \
    | awk -F'|' -v w="$wid" -v e="$exec_id" '$2 == w && $4 == e { found=1 } END { exit(found ? 0 : 1) }' \
    && return 1
  terminal_teardown_state_upsert \
    "terminalv1|$exec_id|$terminal_hash|$count|$round|source-closed|$mirror_title|$session|$wid|$tmux_hash|$cmux_hash|$ref|$uuid" \
    || return 1
  terminal_teardown_crash_point after-source-close
  terminal_teardown_finish_source_closed "$exec_id" "$mirror_title"
}

terminal_teardown_observe() {
  local exec_id="$1" terminal_row="$2" mirror_title="$3" round="${CMUX_ADDITIVE_ROUND_ID:-}" threshold
  local terminal_hash prior="" version prior_exec prior_hash count prior_round phase prior_mirror rest
  _additive_round_id_valid "$round" || return 1
  is_managed_runner_title "$mirror_title" || return 1
  terminal_hash=$(_cmux_alert_hash "$terminal_row")
  prior=$(terminal_teardown_state_row "$exec_id" 2>/dev/null || true)
  if [[ -n "$prior" ]]; then
    IFS='|' read -r version prior_exec prior_hash count prior_round phase prior_mirror rest < <(printf '%s\n' "$prior")
    if [[ "$phase" == source-closed && "$prior_hash" == "$terminal_hash" && "$prior_mirror" == "$mirror_title" ]]; then
      terminal_teardown_source_transaction "$exec_id" "$terminal_hash" "$count" "$round" "$mirror_title" "$prior"
      return
    fi
    if [[ "$prior_hash" != "$terminal_hash" || "$prior_mirror" != "$mirror_title" ]]; then
      prior=""; count=0; prior_round=""
    fi
  else
    count=0; prior_round=""
  fi
  if [[ "$prior_round" != "$round" ]]; then count=$((10#${count:-0} + 1)); fi
  (( count <= 10 )) || count=10
  threshold="${FLYWHEEL_CMUX_TERMINAL_TEARDOWN_ROUNDS:-3}"
  case "$threshold" in ''|*[!0-9]*) threshold=3 ;; esac
  (( threshold >= 1 && threshold <= 10 )) || threshold=3
  if [[ -z "$prior" || "$phase" == observing ]]; then
    terminal_teardown_state_upsert \
      "terminalv1|$exec_id|$terminal_hash|$count|$round|observing|$mirror_title|-|-|-|-|-|-" \
      || return 1
  fi
  (( count >= threshold )) || return 0
  terminal_teardown_source_transaction "$exec_id" "$terminal_hash" "$count" "$round" "$mirror_title" "$prior"
}

_node_ledger_transaction() {
  local action="$1" state="$2" generation="$3" ref="$4" exec_id="$5" title="$6"
  local dir lock tmp conflict acquired=0
  assert_or_reuse_owned_lease || return 1
  case "$state" in prepared|committed) ;; *) return 1 ;; esac
  case "$generation$ref$exec_id$title" in *'|'*|*$'\t'*|*$'\n'*|*$'\r'*) return 1 ;; esac
  [[ "$ref" =~ ^workspace:[0-9]+$ && "$title" == node:* && -n "$exec_id" ]] || return 1
  dir=$(dirname "$NODE_LEDGER"); mkdir -p "$dir" || return 1
  [[ -f "$NODE_LEDGER" ]] || : > "$NODE_LEDGER"
  lock="${NODE_LEDGER}.lock"
  if mkdir "$lock" 2>/dev/null; then
    acquired=1
  else
    # The verified global mutator lease proves a residual node-ledger lock is
    # crash residue from this sole writer, matching the view-ledger discipline.
    rm -rf "$lock" 2>/dev/null && mkdir "$lock" 2>/dev/null && acquired=1
  fi
  [[ "$acquired" == 1 ]] || return 1
  conflict=$(awk -F'|' -v g="$generation" -v r="$ref" -v e="$exec_id" -v t="$title" '
    NF != 5 || ($2 == g && (($3 == r && ($4 != e || $5 != t)) || ($3 != r && ($4 == e || $5 == t)))) {n++}
    END {print n+0}' "$NODE_LEDGER")
  if [[ "$conflict" != 0 ]]; then
    rmdir "$lock" 2>/dev/null || true
    return 1
  fi
  tmp=$(mktemp "${NODE_LEDGER}.XXXX") || { rmdir "$lock" 2>/dev/null || true; return 1; }
  awk -F'|' -v g="$generation" -v r="$ref" '!($2 == g && $3 == r) {print}' "$NODE_LEDGER" > "$tmp" || {
    rm -f "$tmp"; rmdir "$lock" 2>/dev/null || true; return 1;
  }
  if [[ "$action" == upsert ]]; then
    printf '%s|%s|%s|%s|%s\n' "$state" "$generation" "$ref" "$exec_id" "$title" >> "$tmp" || {
      rm -f "$tmp"; rmdir "$lock" 2>/dev/null || true; return 1;
    }
  fi
  mv "$tmp" "$NODE_LEDGER" || { rm -f "$tmp"; rmdir "$lock" 2>/dev/null || true; return 1; }
  rmdir "$lock" 2>/dev/null || true
}

_node_ledger_upsert() { _node_ledger_transaction upsert "$@"; }
_node_ledger_remove() { _node_ledger_transaction remove prepared "$@"; }

_GUARD_NODE_GENERATION=""
_GUARD_NODE_REF=""
_GUARD_NODE_EXEC=""
_GUARD_NODE_TITLE=""
_GUARD_NODE_COMMAND=""
_GUARD_NODE_REQUIRE_ABSENT=0
_node_workspace_guard() {
  local current raw count workspace surface receipt registry
  current=$(cmux_socket_identity) || return 1
  [[ -n "$current" && "$current" == "$_GUARD_NODE_GENERATION" ]] || return 1
  registry=$(node_registry_row "$_GUARD_NODE_EXEC") || return 1
  [[ "$(printf '%s' "$registry" | cut -d'|' -f2)" == "$_GUARD_NODE_TITLE" ]] || return 1
  if [[ "$_GUARD_NODE_REQUIRE_ABSENT" == 1 ]]; then
    raw=$(get_cmux_workspaces_json) || return 1
    count=$(printf '%s' "$raw" | python3 -c '
import json,sys
t,c=sys.argv[1:3]
print(sum(1 for w in json.load(sys.stdin).get("workspaces", [])
          if w.get("title") in {t,c}))
' "$_GUARD_NODE_TITLE" "$_GUARD_NODE_COMMAND") || return 1
    [[ "$count" == 0 ]] || return 1
  else
    receipt=$(node_ledger_exact_state "$current" "$_GUARD_NODE_REF" \
      "$_GUARD_NODE_EXEC" "$_GUARD_NODE_TITLE") || return 1
    case "$receipt" in prepared|committed) ;; *) return 1 ;; esac
    workspace=$(workspace_title_for_ref "$_GUARD_NODE_REF") || return 1
    surface=$(workspace_single_surface_title "$_GUARD_NODE_REF") || return 1
    if [[ "$receipt" == committed ]]; then
      [[ "$workspace" == "$_GUARD_NODE_TITLE" && -n "$surface" ]] || return 1
    else
      [[ "$workspace" == "$_GUARD_NODE_TITLE" || "$workspace" == "$_GUARD_NODE_COMMAND" \
         || "$workspace" == '~' || "$workspace" =~ ^Terminal\ [0-9]+$ ]] || return 1
      [[ "$surface" == "$_GUARD_NODE_TITLE" || "$surface" == "$_GUARD_NODE_COMMAND" ]] || return 1
    fi
  fi
  current=$(cmux_socket_identity) || return 1
  [[ "$current" == "$_GUARD_NODE_GENERATION" ]]
}

complete_node_title_migration() {
  local generation="$1" ref="$2" exec_id="$3" title="$4" command="$5"
  local workspace surface rc=0
  _GUARD_NODE_GENERATION="$generation"
  _GUARD_NODE_REF="$ref"
  _GUARD_NODE_EXEC="$exec_id"
  _GUARD_NODE_TITLE="$title"
  _GUARD_NODE_COMMAND="$command"
  _GUARD_NODE_REQUIRE_ABSENT=0
  _node_workspace_guard || return 1
  workspace=$(workspace_title_for_ref "$ref") || return 1
  if [[ "$workspace" != "$title" ]]; then
    cmux_call_guarded _node_workspace_guard rename-workspace --workspace "$ref" "$title" || rc=$?
    [[ "$rc" == 0 && "$GUARD_WAS_BLOCKED" != 1 ]] || return 1
  fi
  surface=$(workspace_single_surface_title "$ref") || return 1
  if [[ "$surface" != "$title" ]]; then
    rc=0
    cmux_call_guarded _node_workspace_guard rename-tab --workspace "$ref" "$title" || rc=$?
    [[ "$rc" == 0 && "$GUARD_WAS_BLOCKED" != 1 ]] || return 1
  fi
  [[ "$(workspace_title_for_ref "$ref")" == "$title" ]] || return 1
  [[ "$(workspace_single_surface_title "$ref")" == "$title" ]] || return 1
  [[ "$(cmux_socket_identity)" == "$generation" ]] || return 1
  _node_ledger_upsert committed "$generation" "$ref" "$exec_id" "$title"
}

reconcile_node_ledger() {
  local generation raw refs state row_generation ref exec_id title command
  [[ -f "$NODE_LEDGER" ]] || return 0
  generation=$(cmux_socket_identity) || return 1
  raw=$(get_cmux_workspaces_json) || return 1
  refs=$(printf '%s' "$raw" | python3 -c '
import json,sys
for row in json.load(sys.stdin).get("workspaces", []):
    if isinstance(row,dict) and isinstance(row.get("ref"),str): print(row["ref"])
') || return 1
  while IFS='|' read -r state row_generation ref exec_id title; do
    [[ -n "$state" ]] || continue
    if [[ "$row_generation" != "$generation" ]]; then
      if ! printf '%s\n' "$refs" | grep -qxF "$ref"; then
        _node_ledger_remove "$row_generation" "$ref" "$exec_id" "$title" || return 1
      else
        _alert_cmux_cleanup "cmux stale node receipt preserved" \
          "A stale-generation node ref still exists and may have been reused; no workspace mutation was attempted: old_generation=$row_generation ref=$ref title=$title." \
          "cmux_cleanup|stale-node-receipt|generation=$row_generation|ref=$ref|title=$title"
      fi
      continue
    fi
    [[ "$state" == prepared ]] || continue
    command=$(build_node_status_command "$(node_status_path "$exec_id")") || continue
    complete_node_title_migration "$generation" "$ref" "$exec_id" "$title" "$command" || true
  done < "$NODE_LEDGER"
}

ensure_node_workspace() {
  local exec_id="$1" title="$2" status_file="$3" command generation raw refs_before refs_after new_refs ref count state
  local create_rc=0 workspace surface
  command=$(build_node_status_command "$status_file") || return 1
  generation=$(cmux_socket_identity) || return 1
  reconcile_node_ledger || return 1
  raw=$(get_cmux_workspaces_json) || return 1

  ref=$(awk -F'|' -v g="$generation" -v e="$exec_id" -v t="$title" \
    '$2 == g && $4 == e && $5 == t {n++; r=$3} END {if(n==1) print r}' "$NODE_LEDGER" 2>/dev/null || true)
  if [[ -n "$ref" ]]; then
    state=$(node_ledger_exact_state "$generation" "$ref" "$exec_id" "$title") || return 1
    if [[ "$state" == committed ]]; then
      node_workspace_ready "$exec_id" "$title" && return 0
      printf '%s' "$raw" | python3 -c 'import json,sys; r=sys.argv[1]; sys.exit(0 if any(w.get("ref")==r for w in json.load(sys.stdin).get("workspaces",[])) else 1)' "$ref" \
        && return 1
      _node_ledger_remove "$generation" "$ref" "$exec_id" "$title" || return 1
    else
      complete_node_title_migration "$generation" "$ref" "$exec_id" "$title" "$command" && return 0
      return 1
    fi
  fi

  count=$(printf '%s' "$raw" | python3 -c '
import json,sys
t,c=sys.argv[1:3]
print(sum(1 for w in json.load(sys.stdin).get("workspaces", []) if w.get("title") in {t,c}))
' "$title" "$command") || return 1
  if [[ "$count" != 0 ]]; then
    _alert_cmux_cleanup "cmux unreceipted node workspace preserved" \
      "A node-shaped workspace exists without an exact node receipt and was preserved: title=$title execution=$exec_id." \
      "cmux_cleanup|unreceipted-node|title=$title"
    return 1
  fi
  refs_before=$(printf '%s' "$raw" | python3 -c 'import json,sys; print("\n".join(sorted(w.get("ref") for w in json.load(sys.stdin).get("workspaces",[]) if isinstance(w.get("ref"),str))))') || return 1
  _GUARD_NODE_GENERATION="$generation"
  _GUARD_NODE_REF=""
  _GUARD_NODE_EXEC="$exec_id"
  _GUARD_NODE_TITLE="$title"
  _GUARD_NODE_COMMAND="$command"
  _GUARD_NODE_REQUIRE_ABSENT=1
  cmux_call_guarded _node_workspace_guard new-workspace --command "$command" || create_rc=$?
  [[ "$create_rc" == 0 && "$GUARD_WAS_BLOCKED" != 1 ]] || return 1
  raw=$(get_cmux_workspaces_json) || return 1
  [[ "$(cmux_socket_identity)" == "$generation" ]] || return 1
  refs_after=$(printf '%s' "$raw" | python3 -c 'import json,sys; print("\n".join(sorted(w.get("ref") for w in json.load(sys.stdin).get("workspaces",[]) if isinstance(w.get("ref"),str))))') || return 1
  new_refs=$(grep -vFxf <(printf '%s\n' "$refs_before") <(printf '%s\n' "$refs_after") || true)
  [[ "$(printf '%s\n' "$new_refs" | grep -c . || true)" == 1 ]] || return 1
  ref=$(printf '%s\n' "$new_refs" | head -1)
  [[ "$ref" =~ ^workspace:[0-9]+$ ]] || return 1
  _node_ledger_upsert prepared "$generation" "$ref" "$exec_id" "$title" || return 1
  complete_node_title_migration "$generation" "$ref" "$exec_id" "$title" "$command"
}

_GUARD_NODE_CLOSE_REASON=""
_node_close_guard() {
  local registry state current
  _node_workspace_guard || return 1
  registry=$(node_registry_row "$_GUARD_NODE_EXEC") || return 1
  state=$(printf '%s' "$registry" | cut -d'|' -f4)
  case "$_GUARD_NODE_CLOSE_REASON:$state" in
    superseded-by-mirror:active-windowed|summary-ttl:unresolved-summary|summary-cap:unresolved-summary|summary-ttl:terminal-summary|summary-cap:terminal-summary) ;;
    *) return 1 ;;
  esac
  current=$(cmux_socket_identity) || return 1
  [[ "$current" == "$_GUARD_NODE_GENERATION" ]]
}

close_node_workspace() {
  local exec_id="$1" title="$2" reason="$3" generation ref rc=0
  generation=$(cmux_socket_identity) || return 1
  [[ -f "$NODE_LEDGER" ]] || return 0
  ref=$(awk -F'|' -v g="$generation" -v e="$exec_id" -v t="$title" \
    '$1 == "committed" && $2 == g && $4 == e && $5 == t {n++; r=$3} END {if(n==1) print r}' "$NODE_LEDGER")
  [[ -n "$ref" ]] || return 0
  _GUARD_NODE_GENERATION="$generation"
  _GUARD_NODE_REF="$ref"
  _GUARD_NODE_EXEC="$exec_id"
  _GUARD_NODE_TITLE="$title"
  _GUARD_NODE_COMMAND=$(build_node_status_command "$(node_status_path "$exec_id")") || return 1
  _GUARD_NODE_REQUIRE_ABSENT=0
  _GUARD_NODE_CLOSE_REASON="$reason"
  cmux_call_guarded_close_with_attach_reap "$ref" "" _node_close_guard || rc=$?
  [[ "$rc" == 0 && "$GUARD_WAS_BLOCKED" != 1 ]] || return 1
  _node_ledger_remove "$generation" "$ref" "$exec_id" "$title"
}

node_terminal_workspace_was_closed() {
  local exec_id="$1" title="$2" generation ref raw
  generation=$(cmux_socket_identity) || return 2
  [[ -f "$NODE_LEDGER" ]] || return 1
  ref=$(awk -F'|' -v g="$generation" -v e="$exec_id" -v t="$title" \
    '$1 == "committed" && $2 == g && $4 == e && $5 == t {n++; r=$3} END {if(n==1) print r}' "$NODE_LEDGER")
  [[ -n "$ref" ]] || return 1
  raw=$(get_cmux_workspaces_json) || return 2
  printf '%s' "$raw" | python3 -c '
import json,sys
r=sys.argv[1]
sys.exit(1 if any(w.get("ref")==r for w in json.load(sys.stdin).get("workspaces",[])) else 0)
' "$ref"
}

gc_node_summary() {
  local exec_id="$1" title="$2" reason="$3" path
  close_node_workspace "$exec_id" "$title" "$reason" || return 1
  node_registry_remove_exec "$exec_id" || return 1
  path=$(node_status_path "$exec_id")
  rm -f "$path"
}

enforce_node_summary_limits() {
  local now="$1" ttl="${FLYWHEEL_CMUX_NODE_SUMMARY_TTL_HOURS:-24}" max="${FLYWHEEL_CMUX_NODE_TABS_MAX:-30}"
  local exec_id title terminal_epoch count victims victim
  case "$ttl" in ''|*[!0-9]*) ttl=24 ;; esac
  case "$max" in ''|*[!0-9]*) max=30 ;; esac
  (( ${#ttl} <= 3 && 10#$ttl >= 1 && 10#$ttl <= 168 )) || ttl=24
  (( ${#max} <= 3 && 10#$max >= 1 && 10#$max <= 200 )) || max=30
  while IFS='|' read -r exec_id title _ state _ _ _ _ _ _ _ _ terminal_epoch; do
    [[ "$state" == unresolved-summary || "$state" == terminal-summary ]] || continue
    if (( 10#$terminal_epoch > 0 && now - 10#$terminal_epoch >= 10#$ttl * 3600 )); then
      gc_node_summary "$exec_id" "$title" summary-ttl || true
    fi
  done < <(cat "$NODE_REGISTRY" 2>/dev/null || true)
  count=$(awk -F'|' '$4 == "unresolved-summary" || $4 == "terminal-summary" {n++} END {print n+0}' "$NODE_REGISTRY" 2>/dev/null || printf 0)
  (( count > 10#$max )) || return 0
  victims=$(awk -F'|' '$4 == "unresolved-summary" || $4 == "terminal-summary" {print $13 "|" $1 "|" $2}' "$NODE_REGISTRY" | sort -n | head -n $((count - 10#$max)))
  while IFS='|' read -r _ exec_id title; do
    [[ -n "$exec_id" ]] && gc_node_summary "$exec_id" "$title" summary-cap || true
  done < <(printf '%s\n' "$victims")
}

reconcile_node_presence() {
  local active_count now round row exec_id node_id identifier role status adapter heartbeat issue_title last_activity route pr_number issue_url
  local old title alias old_state last_seen last_ok windowed windowless missing summary last_mirror classification terminal_epoch
  local inv inv_state wid mirror_title source new_state status_path terminal_row terminal_seen
  [[ "$RUNNER_EXPECTED_STATE" == ok && "$RUNNER_NODE_TMUX_STATE" == ok ]] || return 0
  node_registry_valid || {
    _alert_cmux_cleanup "cmux node registry malformed" \
      "The node registry is unreadable or malformed; the node reconciliation round was frozen." \
      "cmux_cleanup|node-registry-malformed"
    return 0
  }
  build_node_status_command "$(node_status_path probe)" >/dev/null || return 0
  now=$(date +%s)
  round="${CMUX_ADDITIVE_ROUND_ID:-0-0}"
  _additive_round_id_valid "$round" || return 0
  active_count=$(printf '%s\n' "$RUNNER_ACTIVE_ROWS" | grep -c . || true)
  if (( active_count > 100 )); then
    _alert_cmux_cleanup "cmux active node count is unusually high" \
      "The active runner roster contains $active_count executions; every execution remains visible, but the roster may be unhealthy." \
      "cmux_cleanup|active-node-count|over-100"
  fi

  while IFS= read -r row; do
    [[ -n "$row" ]] || continue
    IFS='|' read -r exec_id node_id identifier role status adapter heartbeat issue_title last_activity route pr_number issue_url < <(printf '%s\n' "$row")
    terminal_teardown_clear "$exec_id" || {
      _alert_cmux_cleanup \
        "cmux terminal teardown episode state unavailable" \
        "An active runner could not clear its prior terminal teardown episode; destructive terminal teardown remains fenced: execution=$exec_id." \
        "cmux_cleanup|terminal-episode-state-unavailable|execution=$exec_id"
    }
    old=$(node_registry_row "$exec_id" 2>/dev/null || true)
    if [[ -n "$old" ]]; then
      IFS='|' read -r _ title alias old_state last_seen last_ok windowed windowless missing summary last_mirror classification terminal_epoch < <(printf '%s\n' "$old")
      if [[ "$old_state" == unresolved-summary || "$old_state" == terminal-summary ]]; then
        old_state=admitted; windowed=0; windowless=0; summary=0; terminal_epoch=0
      fi
    else
      title=$(node_allocate_authority_title "$exec_id" "$identifier" "$role") || continue
      alias=$(node_display_alias "$identifier" "$role" "$exec_id")
      old_state=admitted; windowed=0; windowless=0; summary=0; last_mirror=-; terminal_epoch=0
    fi
    inv=$(printf '%s\n' "$RUNNER_NODE_TMUX_ROWS" | awk -F'|' -v e="$exec_id" '$1 == e {print; exit}')
    if [[ -n "$inv" ]]; then
      IFS='|' read -r _ inv_state wid mirror_title source < <(printf '%s\n' "$inv")
    else
      inv_state=absent; wid=-; mirror_title=-; source=-
    fi
    [[ "$inv_state" == indeterminate ]] && continue
    new_state="$old_state"
    if [[ "$inv_state" == present ]]; then
      (( 10#${windowed:-0} < 2 )) && windowed=$((10#${windowed:-0} + 1)) || windowed=2
      windowless=0; last_mirror="$mirror_title"
      (( windowed >= 2 )) && new_state=active-windowed
    else
      (( 10#${windowless:-0} < 2 )) && windowless=$((10#${windowless:-0} + 1)) || windowless=2
      windowed=0
      (( windowless >= 2 )) && new_state=active-windowless
    fi
    node_registry_upsert_row "$exec_id|$title|$alias|$new_state|$now|$round|$windowed|$windowless|0|0|$last_mirror|$round|0" || continue
    node_write_status_file "$row" "$new_state" 0 || continue
    status_path=$(node_status_path "$exec_id")
    if [[ "$new_state" == active-windowed ]] && node_mirror_surface_ready "$last_mirror"; then
      close_node_workspace "$exec_id" "$title" superseded-by-mirror || true
    else
      ensure_node_workspace "$exec_id" "$title" "$status_path" || true
    fi
  done < <(printf '%s\n' "$RUNNER_ACTIVE_ROWS")

  # Missing active rows are never guessed terminal from one read. An exact
  # recent-terminal row settles immediately; otherwise two distinct complete
  # rounds retain a useful last-known summary.
  while IFS= read -r old; do
    [[ -n "$old" ]] || continue
    IFS='|' read -r exec_id title alias old_state last_seen last_ok windowed windowless missing summary last_mirror classification terminal_epoch < <(printf '%s\n' "$old")
    printf '%s\n' "$RUNNER_ACTIVE_ROWS" | awk -F'|' -v e="$exec_id" '$1 == e {found=1} END {exit(found ? 0 : 1)}' && continue
    [[ "$RUNNER_TERMINAL_STATE" == ok ]] || continue
    terminal_row=$(printf '%s\n' "$RUNNER_TERMINAL_ROWS" | awk -F'|' -v e="$exec_id" '$1 == e {print; exit}')
    terminal_seen=0; [[ -n "$terminal_row" ]] && terminal_seen=1
    (( 10#${missing:-0} < 2 )) && missing=$((10#${missing:-0} + 1)) || missing=2
    if [[ -z "$terminal_row" && "$missing" -lt 2 ]]; then
      node_registry_upsert_row "$exec_id|$title|$alias|$old_state|$last_seen|$round|$windowed|$windowless|$missing|$summary|$last_mirror|$round|$terminal_epoch" || true
      continue
    fi
    if [[ "$old_state" == unresolved-summary || "$old_state" == terminal-summary ]]; then
      local manual_rc=0
      node_terminal_workspace_was_closed "$exec_id" "$title" || manual_rc=$?
      if [[ "$manual_rc" == 0 ]]; then
        local manual_generation manual_ref manual_path
        manual_generation=$(cmux_socket_identity 2>/dev/null || true)
        manual_ref=$(awk -F'|' -v g="$manual_generation" -v e="$exec_id" -v t="$title" \
          '$1 == "committed" && $2 == g && $4 == e && $5 == t {print $3; exit}' "$NODE_LEDGER" 2>/dev/null || true)
        [[ -n "$manual_ref" ]] && _node_ledger_remove "$manual_generation" "$manual_ref" "$exec_id" "$title" || true
        node_registry_remove_exec "$exec_id" || true
        manual_path=$(node_status_path "$exec_id"); rm -f "$manual_path"
        continue
      elif [[ "$manual_rc" == 2 ]]; then
        continue
      fi
    fi
    local summary_state=terminal-summary terminal_flag=1
    if [[ -z "$terminal_row" ]]; then
      terminal_row="$exec_id|-|$alias|-|last-known|-|-|最后已知节点状态|$last_seen|-|-|-"
      summary_state=unresolved-summary
      terminal_flag=0
      terminal_teardown_clear "$exec_id" || true
    fi
    if [[ "$old_state" != "$summary_state" || "${terminal_epoch:-0}" == 0 ]]; then
      terminal_epoch="$now"
    fi
    node_registry_upsert_row "$exec_id|$title|$alias|$summary_state|$last_seen|$round|0|0|$missing|1|$last_mirror|$round|$terminal_epoch" || continue
    node_write_status_file "$terminal_row" "$summary_state" "$terminal_flag" || continue
    if [[ "$terminal_seen" == 1 && "$last_mirror" != - ]]; then
      terminal_teardown_observe "$exec_id" "$terminal_row" "$last_mirror" || {
        _alert_cmux_cleanup \
          "cmux terminal source teardown deferred" \
          "Exact terminal evidence was present, but the source-window teardown transaction could not prove every identity fence and was preserved for retry: execution=$exec_id title=$last_mirror." \
          "cmux_cleanup|terminal-teardown-deferred|execution=$exec_id"
      }
    fi
    status_path=$(node_status_path "$exec_id")
    ensure_node_workspace "$exec_id" "$title" "$status_path" || true
  done < <(cat "$NODE_REGISTRY" 2>/dev/null || true)

  enforce_node_summary_limits "$now"
  node_publish_cleanup_snapshot || true
  return 0
}

reconcile_runner_roster() {
  local exec_id row state _ids short current=""
  if ! fetch_active_runner_roster || [[ "$RUNNER_EXPECTED_STATE" != "ok" ]]; then
    roster_alert_unhealthy runner-roster-blind bridge \
      "cmux runner roster API unavailable" \
      "The authenticated loopback active-session inventory was unavailable or invalid. Existing runner orphan states were preserved."
    return 0
  fi
  if ! read_runner_tmux_exec_inventory || [[ "$RUNNER_TMUX_STATE" != "ok" ]]; then
    roster_alert_unhealthy runner-roster-blind tmux \
      "cmux runner window inventory unavailable" \
      "The global tmux execution-id inventory was unavailable or malformed. Existing runner orphan states were preserved."
    return 0
  fi
  roster_mark_healthy runner-roster-blind bridge
  roster_mark_healthy runner-roster-blind tmux
  while IFS= read -r exec_id; do
    [[ -n "$exec_id" ]] || continue
    current+="${current:+$'\n'}${exec_id}"
    row=$(printf '%s\n' "$RUNNER_TMUX_EXEC_ROWS" \
      | awk -F'|' -v e="$exec_id" '$1 == e { print; exit }')
    if [[ -z "$row" ]]; then
      short=${exec_id:0:12}
      roster_alert_unhealthy runner-orphan "$exec_id" \
        "cmux active runner window missing" \
        "Active execution $exec_id has no global tmux window carrying the exact @flywheel_exec_id option." \
        "$short"
      continue
    fi
    IFS='|' read -r _ state _ids < <(printf '%s\n' "$row")
    [[ "$state" == "present" ]] && roster_mark_healthy runner-orphan "$exec_id"
    # A multi-window execution identity is itself indeterminate. Preserve the
    # prior subject state; title or session aliases are never used to guess.
  done < <(printf '%s\n' "$RUNNER_EXPECTED_EXEC_IDS")
  roster_rearm_absent_subjects runner-orphan "$current"
}

reconcile_roster_read_phase() {
  maintenance_requested && return 0
  reconcile_lead_roster
  reconcile_runner_roster
  if ! read_runner_tmux_node_inventory; then
    roster_alert_unhealthy runner-node-presence tmux \
      "cmux node inventory unavailable" \
      "The execution-to-window inventory was unavailable; node presence mutations were frozen for this round."
  else
    roster_mark_healthy runner-node-presence tmux
  fi
  if ! fetch_recent_terminal_runner_roster; then
    roster_alert_unhealthy runner-node-terminal bridge \
      "cmux terminal runner inventory unavailable" \
      "The recent terminal inventory was unavailable; active nodes remain visible and terminal transitions are frozen."
  else
    roster_mark_healthy runner-node-terminal bridge
  fi
  return 0
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
  local err_file timeout_marker raw rc=0
  err_file=$(mktemp)
  timeout_marker="${err_file}.timeout"
  : > "$timeout_marker"
  raw=$(_cmux_bounded_spawn "$CMUX_CALL_TIMEOUT_SECONDS" "$timeout_marker" --socket "$socket" --json --id-format both list-workspaces 2>"$err_file") || rc=$?
  local err_text
  err_text=$(cat "$err_file" 2>/dev/null || true)
  rm -f "$err_file" "$timeout_marker"

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

close_workspace_by_ref() {
  # Single chokepoint for all cmux workspace closes. Audit log per call;
  # FLYWHEEL_CMUX_DRY_RUN=1 short-circuits the actual cmux call but still
  # logs (so a dry-run inspection still shows what would have happened).
  #
  # FLY-685 (Codex code R1 MED): records the actual cmux close rc in the global
  # LAST_WORKSPACE_CLOSE_RC (0 = closed / dry-run). The default mode itself
  # still ALWAYS returns 0 — the `|| true` semantics existing callers (ghost
  # reaper, dedup, cleanup_workspace_for) rely on under `set -euo pipefail` are
  # unchanged. FLY-1605's explicit --guarded mode instead propagates the guard
  # or cmux rc so title reconciliation cannot mistake a preserved duplicate for
  # a confirmed close.
  local guarded=0
  if [[ "${1:-}" == "--guarded" ]]; then
    guarded=1
    shift
  fi
  local ws_ref="$1" reason="$2"
  local dry="${FLYWHEEL_CMUX_DRY_RUN:-0}"
  log "[audit] close workspace=$ws_ref reason=$reason dry_run=$dry"
  LAST_WORKSPACE_CLOSE_RC=0
  [[ "$dry" == "1" ]] && return 0
  if [[ "$guarded" == "1" ]]; then
    cmux_call_guarded_close_with_attach_reap "$ws_ref" "" _fly1605_duplicate_close_guard \
      || LAST_WORKSPACE_CLOSE_RC=$?
    return "$LAST_WORKSPACE_CLOSE_RC"
  fi
  cmux_call_close_with_attach_reap "$ws_ref" "" || LAST_WORKSPACE_CLOSE_RC=$?
  return 0
}

# FLY-129 Phase 4 (scope #3): periodic ghost reaper.
# A "ghost" workspace is one whose title is null / empty / legacy "~".
# In production we've seen up to 26 of these accumulate. Reaping removes
# the visible clutter and frees Electron-side surface state.
# Fail-closed: rc=2 on the JSON gate → return 0 (next tick retries).
reap_ghost_workspaces() {
  reconcile_prepared_ledger || {
    # Durable-state reads are a fail-closed pass gate, not a daemon-fatal
    # error. The next additive tick retries once cmux/state IO recovers.
    log "WARN: prepared-ledger reconciliation skipped; deferring ghost pass"
    return 0
  }
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
# (packages/core/src/tmux-naming.ts). `runnerName` is composed by
# `runnerDisplayName(sessionRole, shareParentBranch, modelDisplay)`
# (packages/teamlead/src/bridge/run-dispatcher.ts): model-present non-phase runs
# emit `runner-<family>-<model>`; model-absent legacy runs emit `claude`; and
# FLY-793 DAG workflow runners keep their phase prefix (`design`/`implement`/
# `qa`) before any model label. The fixed `runner` namespace proves a model-bearing
# title is managed without trusting arbitrary direct vendor labels.
# COUPLING: if runnerName ever gains another producible value, extend the
# alternation here (and test-cmux-sync.sh) in lockstep. Deliberately excludes
# direct vendor names (codex/gemini/cursor/kimi/agy — not a managed namespace)
# and Lead windows ("<project>-<lead>", never a close_runner target).
is_managed_runner_title() {
  local re='^[A-Z][A-Z0-9]*-[0-9]+-(claude|runner|design|implement|qa)(-|$)'
  [[ "$1" =~ $re ]]
}

# Normalize either a normal managed title or the exact create-command title
# observed in production when cmux workspace rename failed. The raw grammar is
# deliberately a full-string match: no extra shell token, alternate command,
# or arbitrary target can cross this ownership boundary. Evidence provenance is
# committed in scripts/__tests__/fixtures/fly1364/fly-1402-closed-ghost.json.
normalize_stock_workspace_title() {
  local raw="$1" normalized
  case "$raw" in *'|'*|*$'\n'*|*$'\t'*) return 1 ;; esac
  if is_managed_runner_title "$raw"; then
    printf '%s\n' "$raw"
    return 0
  fi
  normalized=$(managed_view_command_parse "$raw") || return 1
  normalized="${normalized#${VIEW_PREFIX}}"
  is_managed_runner_title "$normalized" || return 1
  printf '%s\n' "$normalized"
}

# Emit tab-separated stock records from one authoritative cmux JSON snapshot:
#   C <ref> <raw-title-base64> <normalized-title> <raw-title-sha256>
#   R <reason> <ref-or-multiple> <normalized-or-unknown> <evidence-sha256>
# A normalized title is a candidate only when exactly one workspace maps to it.
stock_workspace_records() {
  local raw
  raw=$(get_cmux_workspaces_json) || return 2
  printf '%s' "$raw" | _cmux_carrier_classify stock || return 2
}

_stock_refusal_alert() {
  local generation="$1" reason="$2" ref="$3" normalized="$4" evidence="$5"
  local signature="cmux_cleanup|stock-adoption|generation=$generation|ref=$ref|normalized=$normalized|evidence_sha256=$evidence|reason=$reason"
  _alert_cmux_cleanup \
    "cmux stock cleanup refused" \
    "A pre-ledger cmux workspace was preserved because stock-adoption evidence was not unique and conclusive: generation=$generation ref=$ref normalized=$normalized reason=$reason evidence_sha256=$evidence." \
    "$signature"
}

# Print a stable topology fingerprint for an orphan candidate.
# rc=0: conclusively orphaned (stdout starts absent: or owned-dead:)
# rc=1: live source/view exists (expected preserve, no alert)
# rc=2: inventory unreadable (fail closed)
# rc=3: same-name view exists but is not provably Flywheel-owned/dead (alert)
stock_topology_fingerprint() {
  local title="$1" sessions rows="" sess current snapshot sid grouped active owner marker members observed dead
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null) || return 2
  while IFS= read -r sess; do
    [[ -z "$sess" ]] && continue
    case "$sess" in flywheel|runner-*) ;; *) continue ;; esac
    current=$(tmux list-windows -t "=$sess" \
      -F '#{session_name}|#{window_id}|#{window_name}|#{pane_dead}' 2>/dev/null) || return 2
    [[ -n "$current" ]] && rows+="${rows:+$'\n'}${current}"
  done < <(printf '%s\n' "$sessions")
  if printf '%s\n' "$rows" | awk -F'|' -v t="$title" '$3 == t { found=1 } END { exit(found ? 0 : 1) }'; then
    return 1
  fi

  if ! printf '%s\n' "$sessions" | grep -qxF "${VIEW_PREFIX}${title}"; then
    # The grace identity belongs to this candidate, not to the global tmux
    # inventory. A second pass re-runs the exact-title source/view probes above,
    # so unrelated runner/session churn must not restart an unchanged orphan's
    # clock forever.
    printf 'absent:%s\n' "$(_cmux_alert_hash "$title|source=absent|view=absent")"
    return 0
  fi
  snapshot=$(_view_session_snapshot "${VIEW_PREFIX}${title}") || return 2
  IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
  # A markerless grouped session has no immutable Flywheel ownership evidence.
  # Group name, title, and pane-dead are mutable topology, so they can preserve
  # a candidate but can never mint the first close receipt. Already-receipted
  # grouped views still migrate through repair_view_invariants.
  case "$owner" in
    flywheel|runner-*) ;;
    *)
      printf 'foreign-view:%s\n' "$(_cmux_alert_hash "$snapshot")"
      return 3
      ;;
  esac
  if [[ "$grouped" != "0" || -z "$sid" || -z "$active" \
      || "$marker" != "0" || "$members" != "$active" ]]; then
    printf 'foreign-view:%s\n' "$(_cmux_alert_hash "$snapshot")"
    return 3
  fi
  observed=$(tmux display-message -p -t "=${VIEW_PREFIX}${title}:${active}" \
    '#{window_name}|#{pane_dead}' 2>/dev/null) || return 2
  IFS='|' read -r current dead < <(printf '%s\n' "$observed")
  if [[ "$current" != "$title" ]]; then
    printf 'foreign-view:%s\n' "$(_cmux_alert_hash "$snapshot|observed=$observed")"
    return 3
  fi
  [[ "$dead" == "0" ]] && return 1
  if [[ "$dead" != "1" ]]; then
    return 2
  fi
  printf 'owned-dead:%s\n' "$(_cmux_alert_hash "$snapshot|dead=$dead")"
  return 0
}

_decode_stock_title() {
  printf '%s' "$1" | python3 -c 'import base64,sys; sys.stdout.write(base64.b64decode(sys.stdin.read(), validate=True).decode())'
}

_stock_candidate_still_matches() {
  local generation="$1" ref="$2" encoded="$3" normalized="$4" evidence="$5" fingerprint="$6"
  local current records count topology rc=0
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$generation" ]] || return 1
  records=$(stock_workspace_records) || return 1
  count=$(printf '%s\n' "$records" | awk -F'\t' -v r="$ref" -v b="$encoded" -v n="$normalized" -v e="$evidence" \
    '$1 == "C" && $2 == r && $3 == b && $4 == n && $5 == e { c++ } END { print c+0 }')
  [[ "$count" == "1" ]] || return 1
  topology=$(stock_topology_fingerprint "$normalized") || rc=$?
  [[ "$rc" == "0" && "$topology" == "$fingerprint" ]] || return 1
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$generation" ]] || return 1
  return 0
}

_GUARD_STOCK_GENERATION=""
_GUARD_STOCK_REF=""
_GUARD_STOCK_ENCODED=""
_GUARD_STOCK_NORMALIZED=""
_GUARD_STOCK_EVIDENCE=""
_GUARD_STOCK_FINGERPRINT=""
_stock_final_close_guard() {
  _stock_candidate_still_matches \
    "$_GUARD_STOCK_GENERATION" "$_GUARD_STOCK_REF" "$_GUARD_STOCK_ENCODED" \
    "$_GUARD_STOCK_NORMALIZED" "$_GUARD_STOCK_EVIDENCE" "$_GUARD_STOCK_FINGERPRINT"
}

CMUX_STOCK_SWEEP_CONCLUSIVE=0
reap_unledgered_stock_workspaces() {
  CMUX_STOCK_SWEEP_CONCLUSIVE=0
  assert_or_reuse_owned_lease || return 0

  local generation records rc=0 grace now dir tmp keep=""
  generation=$(cmux_socket_identity)
  [[ -n "$generation" ]] || return 0
  records=$(stock_workspace_records) || rc=$?
  [[ "$rc" == "0" ]] || return 0

  grace="${FLYWHEEL_CMUX_ADOPTION_GRACE:-$CONSERVATIVE_CLEANUP_SECONDS}"
  case "$grace" in ''|*[!0-9]*) grace=300 ;; esac
  [[ ${#grace} -gt 5 ]] && grace=300
  now=$(date +%s)
  dir=$(dirname "$ADOPTION_STATE")
  mkdir -p "$dir" 2>/dev/null || return 0
  touch "$ADOPTION_STATE" 2>/dev/null || return 0
  tmp=$(mktemp "${ADOPTION_STATE}.XXXX" 2>/dev/null) || return 0

  local kind a b c d ref encoded normalized evidence fingerprint topology_rc key first raw_title ready closed view_kind
  while IFS=$'\t' read -r kind a b c d; do
    [[ -z "$kind" ]] && continue
    if [[ "$kind" == "R" ]]; then
      _stock_refusal_alert "$generation" "$a" "$b" "$c" "$d"
      continue
    fi
    [[ "$kind" == "C" ]] || continue
    ref="$a"; encoded="$b"; normalized="$c"; evidence="$d"
    fingerprint=""; topology_rc=0
    fingerprint=$(stock_topology_fingerprint "$normalized") || topology_rc=$?
    if [[ "$topology_rc" == "1" ]]; then
      continue
    elif [[ "$topology_rc" == "2" ]]; then
      _stock_refusal_alert "$generation" "topology-inventory-unreadable" "$ref" "$normalized" "$evidence"
      continue
    elif [[ "$topology_rc" == "3" ]]; then
      _stock_refusal_alert "$generation" "foreign-or-unproven-view" "$ref" "$normalized" "$(_cmux_alert_hash "$fingerprint")"
      continue
    fi

    view_kind="${fingerprint%%:*}"
    key=$(_cmux_alert_hash "$generation|$ref|$evidence|$normalized|$fingerprint")
    first=$(awk -F'|' -v k="$key" '$1 == k { print $2; exit }' "$ADOPTION_STATE" 2>/dev/null || true)
    case "$first" in ''|*[!0-9]*) first="" ;; esac
    [[ -n "$first" && ${#first} -gt 12 ]] && first=""
    raw_title=$(_decode_stock_title "$encoded" 2>/dev/null || true)
    [[ -n "$raw_title" ]] || continue

    ready=0
    if ledger_committed_ref "$generation" "$ref" "$raw_title"; then
      # Retry only a receipt written by a prior adoption attempt, proven by its
      # matching durable adoption fingerprint. A pre-existing normal ledger row
      # belongs to the established orphan-reaper grace path and must not be
      # accelerated here.
      if [[ -n "$first" ]]; then
        ready=1
      else
        continue
      fi
    elif [[ "${FLYWHEEL_CMUX_STOCK_ALLOW_LEGACY_PREPARED:-0}" == 1 \
        && "$(ledger_exact_receipt_state "$generation" "$ref" "$raw_title" 2>/dev/null || true)" == prepared \
        && "$(ledger_exact_receipt_uuid "$generation" "$ref" "$raw_title" 2>/dev/null || true)" == __LEGACY__ ]]; then
      if [[ -z "$first" ]]; then
        keep+="$key|$now|$generation|$ref|$encoded|$normalized|$fingerprint"$'\n'
        continue
      elif (( now - 10#$first >= grace )); then
        ready=1
      else
        keep+="$key|$first|$generation|$ref|$encoded|$normalized|$fingerprint"$'\n'
        continue
      fi
    elif [[ -f "$VIEW_LEDGER" ]] && awk -F'|' -v r="$ref" '$3 == r { found=1 } END { exit(found ? 0 : 1) }' "$VIEW_LEDGER"; then
      _stock_refusal_alert "$generation" "existing-ledger-authority" "$ref" "$normalized" "$evidence"
      continue
    elif [[ -z "$first" ]]; then
      keep+="$key|$now|$generation|$ref|$encoded|$normalized|$fingerprint"$'\n'
      continue
    elif (( now - 10#$first >= grace )); then
      ready=1
    else
      keep+="$key|$first|$generation|$ref|$encoded|$normalized|$fingerprint"$'\n'
      continue
    fi

    if [[ "$ready" == "1" ]] \
        && _stock_candidate_still_matches "$generation" "$ref" "$encoded" "$normalized" "$evidence" "$fingerprint"; then
      if ! ledger_committed_ref "$generation" "$ref" "$raw_title"; then
        _ledger_upsert committed "$generation" "$ref" "$raw_title" || {
          keep+="$key|${first:-$now}|$generation|$ref|$encoded|$normalized|$fingerprint"$'\n'
          continue
        }
      fi
      closed=0
      _GUARD_STOCK_GENERATION="$generation"
      _GUARD_STOCK_REF="$ref"
      _GUARD_STOCK_ENCODED="$encoded"
      _GUARD_STOCK_NORMALIZED="$normalized"
      _GUARD_STOCK_EVIDENCE="$evidence"
      _GUARD_STOCK_FINGERPRINT="$fingerprint"
      close_ledger_workspace_ref "$generation" "$ref" "$raw_title" \
        "stock-adoption-${normalized}" _stock_final_close_guard && closed=1
      if [[ "$closed" == "1" ]]; then
        if [[ "$view_kind" == "owned-dead" ]]; then
          dismantle_view_display "$normalized" "stock-adoption-owned-dead" || true
        fi
      else
        keep+="$key|${first:-$now}|$generation|$ref|$encoded|$normalized|$fingerprint"$'\n'
      fi
    else
      # Evidence changed between observation and the final under-lease read.
      # Drop the old fingerprint; a future conclusive pass starts a new grace.
      continue
    fi
  done < <(printf '%s\n' "$records")

  if ! printf '%s' "$keep" > "$tmp" 2>/dev/null || ! mv "$tmp" "$ADOPTION_STATE" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    return 0
  fi
  CMUX_STOCK_SWEEP_CONCLUSIVE=1
  return 0
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
  done < <(printf '%s\n' "$snapshot")
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
  local raw sessions agent_names pairs ledger_generation=""
  raw=$(get_cmux_workspaces_json) || return 2
  ledger_generation=$(cmux_socket_identity)
  [[ -n "$ledger_generation" ]] || return 2
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
    workspace_uuid = w.get("id")
    if not isinstance(workspace_uuid, str) or not workspace_uuid:
        workspace_uuid = "-"
    sys.stdout.write(ref + "\t" + workspace_uuid + "\t" + title + "\n")
') || return 2
  local ref workspace_uuid title receipt_state receipt_uuid
  while IFS=$'\t' read -r ref workspace_uuid title; do
    [[ -z "$ref" || -z "$title" ]] && continue
    [[ "$title" == "~" ]] && continue
    is_managed_runner_title "$title" || continue
    receipt_state=$(ledger_exact_receipt_state \
      "$ledger_generation" "$ref" "$title") || continue
    receipt_uuid=$(ledger_exact_receipt_uuid \
      "$ledger_generation" "$ref" "$title") || continue
    case "$receipt_state" in
      committed)
        [[ "$receipt_uuid" == __LEGACY__ || "$receipt_uuid" == "$workspace_uuid" ]] || continue
        ;;
      prepared)
        [[ "$receipt_uuid" != __LEGACY__ && "$receipt_uuid" == "$workspace_uuid" ]] || continue
        ;;
      *) continue ;;
    esac
    if printf '%s\n' "$agent_names" | grep -qxF "$title"; then continue; fi
    if printf '%s\n' "$sessions" | grep -qxF "cmux-${title}"; then continue; fi
    printf '%s\t%s\n' "$ref" "$title"
  done < <(printf '%s\n' "$pairs")
  return 0
}

_GUARD_ORPHAN_TITLE=""
_orphan_pin_close_guard() {
  local sessions agent_names
  is_managed_runner_title "$_GUARD_ORPHAN_TITLE" || return 1
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null) || return 1
  agent_names=$(collect_agent_window_names_strict "$sessions") || return 1
  printf '%s\n' "$agent_names" | grep -qxF "$_GUARD_ORPHAN_TITLE" && return 1
  printf '%s\n' "$sessions" | grep -qxF "cmux-${_GUARD_ORPHAN_TITLE}" && return 1
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
  local raw sessions agent_names cur_row cur_title cur_uuid receipt_state receipt_uuid ledger_generation=""
  ledger_generation=$(cmux_socket_identity)
  [[ -n "$ledger_generation" ]] || return 2
  receipt_state=$(ledger_exact_receipt_state \
    "$ledger_generation" "$ref" "$want_title") || return 1
  receipt_uuid=$(ledger_exact_receipt_uuid \
    "$ledger_generation" "$ref" "$want_title") || return 1
  case "$receipt_state:$receipt_uuid" in
    committed:*) ;;
    prepared:__LEGACY__) return 1 ;;
    prepared:*) ;;
    *) return 1 ;;
  esac
  raw=$(get_cmux_workspaces_json) || return 2                        # FLY-685: uncertain
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null) || return 2  # FLY-685: uncertain
  agent_names=$(collect_agent_window_names_strict "$sessions") || return 2     # FLY-685: uncertain
  cur_row=$(printf '%s' "$raw" | python3 -c '
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
            u = w.get("id")
            if not isinstance(u, str) or not u:
                u = "-"
            sys.stdout.write(u + "\t" + t + "\n")
        break
' "$ref") || return 2                                                # FLY-685: parse uncertain
  IFS=$'\t' read -r cur_uuid cur_title < <(printf '%s\n' "$cur_row") || return 2
  [[ -z "$cur_title" ]] && return 1                # ref gone from cmux
  [[ "$cur_title" != "$want_title" ]] && return 1  # title drifted → not the pin we vetted
  [[ "$receipt_uuid" == __LEGACY__ || "$receipt_uuid" == "$cur_uuid" ]] || return 1
  is_managed_runner_title "$cur_title" || return 1
  if printf '%s\n' "$agent_names" | grep -qxF "$cur_title"; then return 1; fi
  if printf '%s\n' "$sessions" | grep -qxF "cmux-${cur_title}"; then return 1; fi
  if [[ -n "$ledger_generation" ]]; then
    _GUARD_ORPHAN_TITLE="$cur_title"
    close_ledger_workspace_ref "$ledger_generation" "$ref" "$cur_title" \
      "orphan-pin-${cur_title}" _orphan_pin_close_guard "$receipt_state" || return 2
    LAST_WORKSPACE_CLOSE_RC=0
  else
    close_workspace_by_ref "$ref" "orphan-pin-${cur_title}"
  fi
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
# close goes through the revalidating chokepoint.
reap_orphan_workspace_pins() {
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
  done < <(printf '%s\n' "$refs")
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
# longer exists in cmux (leaked by a previous watcher). JSON unavailable → skip
# (keep state).
gc_orphan_pin_state_file() {
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
  done < <(printf '%s\n' "$refs")
  return 0
}

# reap_orphan_pins_oneshot — operator one-shot immediate cleanup
# (--reap-orphan-pins). Re-derives the orphan set NOW, closes each through the
# revalidating chokepoint (NO grace — explicit operator action, same immediacy as
# --once). It takes the shared mutator lease; a live watcher therefore makes
# the strict operator entry fail and point to the handover convergence path.
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
  local closed_any=0 uncertain=0 close_rc ref title
  while IFS=$'\t' read -r ref title; do
    [[ -z "$ref" ]] && continue
    if close_orphan_workspace_pin_if_still_orphan "$ref" "$title"; then
      closed_any=1
      echo "reaped orphan pin: $ref ($title)"
    else
      close_rc=$?
      [[ "$close_rc" == 2 ]] && uncertain=1
    fi
  done < <(printf '%s\n' "$refs")
  if [[ "$closed_any" == "1" ]]; then
    cmux_call refresh-surfaces || true
  fi
  [[ "$uncertain" == 0 ]] || return 2
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
# a same-title restarted runner. Marker lines are untrusted local IPC (validated below).
process_close_requests() {
  local tmp="${CLOSE_REQUEST_FILE}.processing" drain_rc=0
  # Crash recovery: fold a leftover .processing batch (a previous drain that was
  # interrupted) back into the live file so the drain below processes it exactly
  # once — no same-tick double-process (Codex design R2 watchpoint #4).
  if [[ -f "$tmp" ]]; then
    if cat "$tmp" >> "$CLOSE_REQUEST_FILE" 2>/dev/null; then
      rm -f "$tmp" 2>/dev/null || true
    else
      log "WARN: close-request recovery could not requeue retained batch; preserving $tmp"
      return 0
    fi
  fi
  [[ -f "$CLOSE_REQUEST_FILE" ]] || return 0
  # Atomically take the current batch so concurrent close_runner appends land in
  # the NEXT batch (mirrors drain_events' mv-to-.processing TOCTOU handling).
  mv "$CLOSE_REQUEST_FILE" "$tmp" 2>/dev/null || return 0
  _drain_close_requests "$tmp" || drain_rc=$?
  if [[ "$drain_rc" -eq 0 ]]; then
    rm -f "$tmp" 2>/dev/null || true
  else
    log "WARN: close-request drain interrupted; retained unprocessed batch for replay (rc=$drain_rc)"
  fi
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
  local closed_any=0 wname refs rc ref crc requeue raw
  local interrupted=0 inner_interrupted=0 remainder="${batch}.remaining.$$"
  rm -f "$remainder" 2>/dev/null || true
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    if [[ "$interrupted" -eq 1 ]]; then
      printf '%s\n' "$raw" >> "$remainder" || { rm -f "$remainder"; return 2; }
      continue
    fi
    if ! watcher_mutation_latch_clear; then
      interrupted=1
      printf '%s\n' "$raw" >> "$remainder" || { rm -f "$remainder"; return 2; }
      continue
    fi
    wname="$raw"
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
    inner_interrupted=0
    while IFS= read -r ref; do
      if ! watcher_mutation_latch_clear; then
        inner_interrupted=1
        break
      fi
      [[ -z "$ref" ]] && continue
      crc=0
      close_orphan_workspace_pin_if_still_orphan "$ref" "$wname" || crc=$?
      if [[ $crc -eq 0 ]]; then
        closed_any=1
      elif [[ $crc -eq 2 ]]; then
        requeue=1   # final-gate uncertainty (JSON/tmux flap during revalidation)
      fi
      # crc=1 (predicate skip: restarted / not-orphan / gone) → drop; FLY-293 backstops.
    done < <(printf '%s\n' "$refs")
    watcher_mutation_latch_clear || inner_interrupted=1
    if [[ "$inner_interrupted" -eq 1 ]]; then
      interrupted=1
      printf '%s\n' "$raw" >> "$remainder" || { rm -f "$remainder"; return 2; }
      continue
    fi
    [[ $requeue -eq 1 ]] && { printf '%s\n' "$wname" >> "$CLOSE_REQUEST_FILE" 2>/dev/null || true; }
  done < "$batch"
  if [[ "$interrupted" -eq 1 ]]; then
    mv -f "$remainder" "$batch" 2>/dev/null || { rm -f "$remainder"; return 2; }
    return 75
  fi
  rm -f "$remainder" 2>/dev/null || true
  if [[ "$closed_any" == "1" ]]; then
    cmux_call refresh-surfaces || true
  fi
  return 0
}

# gc_close_request_file — watcher-startup GC: drop marker lines whose title has no
# matching cmux workspace (leaked by a previous watcher, or the pin was already
# closed). cmux JSON unavailable → skip
# (keep the file, retry next startup). Mirrors gc_orphan_pin_state_file.
gc_close_request_file() {
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
  # Returns 0 (alive), 1 (conclusively dead / missing), or 2 (tmux truth is
  # unavailable). Cleanup callers MUST preserve on rc=2.
  local wname="$1" sessions rows="" sess current dead
  # FLY-129 Phase 5 (Codex R2 MEDIUM fix): use awk -F'|' literal field
  # compare instead of `grep "|name$"`. The grep form interprets `.`/`[`/
  # `]` in window names as regex (repro: `foo.bar[1]` was matched against
  # `foo-bar-1` etc), causing false-positive "alive" reads + false-positive
  # cleanups elsewhere via the inverted predicate at cleanup_stale_conservative.
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null) || return 2
  while IFS= read -r sess; do
    case "$sess" in flywheel|runner-*) ;; *) continue ;; esac
    current=$(tmux list-windows -t "$sess" \
      -F '#{session_name}|#{window_id}|#{window_name}' 2>/dev/null) || return 2
    [[ -n "$current" ]] && rows+="${rows:+$'\n'}${current}"
  done < <(printf '%s\n' "$sessions")

  while IFS='|' read -r sess wid name; do
    [[ -z "$sess" || -z "$name" ]] && continue
    [[ "$name" == "$wname" ]] || continue
    dead=$(tmux display-message -p -t "=${sess}:${wid}" "#{pane_dead}" 2>/dev/null) || return 2
    case "$dead" in 0) return 0 ;; 1) ;; *) return 2 ;; esac
  done < <(printf '%s\n' "$rows")

  # R6 view-lifetime rule: in strict A0B1 the independent cmux view may be the
  # window's only remaining reference after the runner's spawning session is
  # retired. Its live pane is still the watched workload, so source-session
  # disappearance alone must not authorize cleanup. This is preservation-only:
  # any lookup uncertainty returns rc=2 and authorizes zero cleanup mutation.
  local strict_view_session="${VIEW_PREFIX}${wname}" strict_view_dead
  if printf '%s\n' "$sessions" | grep -qxF "$strict_view_session"; then
    strict_view_dead=$(tmux display-message -p -t "=${strict_view_session}:=${wname}" "#{pane_dead}" 2>/dev/null) || return 2
    case "$strict_view_dead" in 0) return 0 ;; 1) ;; *) return 2 ;; esac
  fi
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
  # tmux 3.5a silently falls back to the session's current window when wid is
  # gone, so pane_dead alone can report a different window as alive.
  local sess="$1" wid="$2" observed
  observed=$(tmux display-message -p -t "=${sess}:${wid}" \
    '#{window_id}|#{pane_dead}' 2>/dev/null) || return 1
  [[ "$observed" == "$wid|0" ]]
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
  local agent_name="$1" marker="${2:-}" marker_title marker_epoch marker_round_epoch marker_round_sequence marker_extra
  [[ -n "$marker" ]] || {
    log "WARN: cleanup refused without a node-freshness marker: $agent_name"
    return 1
  }
  IFS='|' read -r marker_title marker_epoch marker_round_epoch marker_round_sequence marker_extra < <(printf '%s\n' "$marker")
  [[ "$marker_title" == "$agent_name" && -z "$marker_extra" ]] || return 1
  node_cleanup_freshness_allows "$agent_name" "$marker_epoch" "$marker_round_epoch" "$marker_round_sequence" || {
    log "Node-presence fence deferred cleanup for: $agent_name"
    return 1
  }
  dismantle_view_display "$agent_name" "stale-${agent_name}" || true
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
# Design: bounded self-heal at attach-sensitive event boundaries plus the
# existing FLY-129 60s additive reconcile. The 15s watch loop does not run a
# heal scan, so steady-state work remains capped at one managed-window sweep per
# minute. Every injection still passes the exact-ref, zero-client, bare-shell,
# and final TOCTOU guards below.
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
# Runs only at a bounded heal attempt (event-driven or the 60s additive tick).
surface_looks_like_bare_shell() {
  local ref="$1" surface_ref="$2" quiet="${3:-0}" screen last
  if [[ "$quiet" == "1" ]]; then
    local socket="${CMUX_SOCKET_PATH:-$CMUX_SOCKET_PATH_DEFAULT}"
    local timeout_marker
    timeout_marker=$(mktemp) || return 2
    : > "$timeout_marker"
    local read_rc=0
    screen=$(_cmux_bounded_spawn "$CMUX_CALL_TIMEOUT_SECONDS" "$timeout_marker" --socket "$socket" read-screen --workspace "$ref" --surface "$surface_ref" 2>/dev/null) || read_rc=$?
    rm -f "$timeout_marker"
    [[ $read_rc -eq 0 ]] || return 2
  else
    screen=$(cmux_call read-screen --workspace "$ref" --surface "$surface_ref") || return 2
  fi
  SURFACE_LAST_SCREEN="$screen"
  last=$(printf '%s\n' "$screen" | awk 'NF{l=$0} END{print l}')
  last=$(printf '%s' "$last" | sed 's/[[:space:]]*$//')   # strip trailing whitespace
  case "$last" in
    *'%'|*'$'|*'#') return 0 ;;   # shell prompt → bare shell → safe to send
    *) return 1 ;;                # status bar / TUI / unknown → fail closed
  esac
}

SURFACE_LAST_SCREEN=""

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

_attach_retry_limit() {
  local value="${FLYWHEEL_CMUX_ATTACH_RETRIES:-3}"
  case "$value" in ''|*[!0-9]*) value=3 ;; esac
  (( ${#value} <= 2 && 10#$value >= 1 && 10#$value <= 10 )) || value=3
  printf '%s\n' "$value"
}

_attach_state_valid() {
  [[ -e "$ATTACH_HEAL_STATE" || -L "$ATTACH_HEAL_STATE" ]] || return 0
  [[ -f "$ATTACH_HEAL_STATE" && ! -L "$ATTACH_HEAL_STATE" ]] || return 1
  python3 - "$ATTACH_HEAL_STATE" <<'PY' >/dev/null 2>&1
import re,sys
seen=set()
for raw in open(sys.argv[1], encoding="utf-8"):
    p=raw.rstrip("\n").split("|")
    if len(p) != 9 or p[3] not in {"view","v2"} or p[5] not in {
        "retrying","unclassified","observing-exited","observing-empty",
        "observing-no-pty","dead-exited","dead-empty","dead-no-pty",
        "rebuild-issued","rebuilt","dead"
    }:
        raise SystemExit(1)
    if not p[0] or not p[1].startswith("workspace:") or not p[1][10:].isdigit() or not p[2]:
        raise SystemExit(1)
    if not all(v.isdigit() and len(v) <= 18 for v in (p[4],p[6],p[7])):
        raise SystemExit(1)
    if not re.fullmatch(r"[0-9]+-[0-9]+", p[8]):
        raise SystemExit(1)
    key=tuple(p[:4])
    if key in seen or any(c in "\t\r\n" for value in p for c in value):
        raise SystemExit(1)
    seen.add(key)
PY
}

_attach_state_row() {
  local generation="$1" ref="$2" title="$3" kind="$4"
  [[ -f "$ATTACH_HEAL_STATE" ]] || return 1
  awk -F'|' -v g="$generation" -v r="$ref" -v t="$title" -v k="$kind" \
    '$1 == g && $2 == r && $3 == t && $4 == k {print; found=1; exit} END {exit(found ? 0 : 1)}' \
    "$ATTACH_HEAL_STATE"
}

_attach_state_write() {
  local generation="$1" ref="$2" title="$3" kind="$4" replacement="${5:-}"
  local dir source tmp
  _attach_state_valid || return 1
  dir=$(dirname "$ATTACH_HEAL_STATE")
  mkdir -p "$dir" || return 1
  source=/dev/null
  [[ -f "$ATTACH_HEAL_STATE" ]] && source="$ATTACH_HEAL_STATE"
  tmp=$(mktemp "${ATTACH_HEAL_STATE}.XXXX") || return 1
  awk -F'|' -v g="$generation" -v r="$ref" -v t="$title" -v k="$kind" \
    '!($1 == g && $2 == r && $3 == t && $4 == k) {print}' \
    "$source" > "$tmp" || { rm -f "$tmp"; return 1; }
  [[ -z "$replacement" ]] || printf '%s\n' "$replacement" >> "$tmp" \
    || { rm -f "$tmp"; return 1; }
  if [[ -s "$tmp" ]]; then
    mv "$tmp" "$ATTACH_HEAL_STATE"
  else
    rm -f "$tmp" "$ATTACH_HEAL_STATE"
  fi
}

_attach_state_upsert() {
  _attach_state_write "$1" "$2" "$3" "$4" \
    "$1|$2|$3|$4|$5|$6|$7|$8|$9"
}

# D1: only literal, positive death evidence may authorize durable RED status
# and reporting. Unknown non-empty content is deliberately preservation-only.
classify_dead_view_screen() {
  local screen="$1"
  if [[ "$screen" == *'open terminal failed: not a terminal'* ]]; then
    printf 'no-pty\n'
  elif [[ -z "$(printf '%s' "$screen" | tr -d '[:space:]')" ]]; then
    printf 'empty\n'
  elif printf '%s' "$screen" | grep -Fq \
      -e "can't find session" \
      -e '[server exited]' \
      -e 'no server running' \
      -e '[exited]' \
      -e 'server exited'; then
    printf 'exited\n'
  else
    printf 'unclassified\n'
  fi
}

_private_session_client_count() {
  local socket="$1" output
  tmux -S "$socket" has-session -t '=main' >/dev/null 2>&1 || return 1
  output=$(tmux -S "$socket" list-clients -t '=main' -F '#{client_name}' 2>/dev/null) || return 1
  if [[ -z "$output" ]]; then
    printf '0\n'
  else
    printf '%s\n' "$output" | grep -c . || true
  fi
}

_GUARD_ATTACH_KIND=""
_GUARD_ATTACH_GENERATION=""
_GUARD_ATTACH_REF=""
_GUARD_ATTACH_TITLE=""
_GUARD_ATTACH_SURFACE=""
_GUARD_ATTACH_TARGET=""
_GUARD_ATTACH_ACTION=""
_attach_mutation_guard() {
  local current workspace surface clients
  GUARD_BLOCK_RC=0
  if [[ "${REBIND_GUARD_ACTIVE:-0}" == 1 ]]; then
    rebind_mutation_authority_current || { GUARD_BLOCK_RC=1; return 1; }
  fi
  current=$(cmux_socket_identity) || { GUARD_BLOCK_RC=1; return 1; }
  [[ "$current" == "$_GUARD_ATTACH_GENERATION" ]] || { GUARD_BLOCK_RC=1; return 1; }
  ledger_committed_ref "$current" "$_GUARD_ATTACH_REF" "$_GUARD_ATTACH_TITLE" \
    || { GUARD_BLOCK_RC=1; return 1; }
  workspace=$(workspace_title_for_ref "$_GUARD_ATTACH_REF") \
    || { GUARD_BLOCK_RC=1; return 1; }
  surface=$(workspace_terminal_surface_ref "$_GUARD_ATTACH_REF") \
    || { GUARD_BLOCK_RC=1; return 1; }
  [[ "$workspace" == "$_GUARD_ATTACH_TITLE" && "$surface" == "$_GUARD_ATTACH_SURFACE" ]] \
    || { GUARD_BLOCK_RC=1; return 1; }
  if [[ "$_GUARD_ATTACH_KIND" == view ]]; then
    if [[ "$_GUARD_ATTACH_ACTION" == missing ]]; then
      linked_session_exists "$_GUARD_ATTACH_TARGET" && { GUARD_BLOCK_RC=1; return 1; }
      current=$(cmux_socket_identity) || { GUARD_BLOCK_RC=1; return 1; }
      [[ "$current" == "$_GUARD_ATTACH_GENERATION" ]] || { GUARD_BLOCK_RC=1; return 1; }
      return 0
    fi
    _view_shell_owned_for_title "$_GUARD_ATTACH_TARGET" "$_GUARD_ATTACH_TITLE" 0 1 1 \
      || { GUARD_BLOCK_RC=1; return 1; }
    clients=$(view_session_client_count "$_GUARD_ATTACH_TARGET") \
      || { GUARD_BLOCK_RC=1; return 1; }
  else
    _v2_lead_roster_row_current "$_GUARD_ATTACH_TITLE" "$_GUARD_ATTACH_TARGET" \
      || { GUARD_BLOCK_RC=1; return 1; }
    if [[ "$_GUARD_ATTACH_ACTION" == missing ]]; then
      tmux -S "$_GUARD_ATTACH_TARGET" has-session -t '=main' >/dev/null 2>&1 \
        && { GUARD_BLOCK_RC=1; return 1; }
      current=$(cmux_socket_identity) || { GUARD_BLOCK_RC=1; return 1; }
      [[ "$current" == "$_GUARD_ATTACH_GENERATION" ]] || { GUARD_BLOCK_RC=1; return 1; }
      return 0
    fi
    clients=$(_private_session_client_count "$_GUARD_ATTACH_TARGET") \
      || { GUARD_BLOCK_RC=1; return 1; }
  fi
  if [[ "$_GUARD_ATTACH_ACTION" == clear ]]; then
    [[ "$clients" -gt 0 ]] || { GUARD_BLOCK_RC=1; return 1; }
    current=$(cmux_socket_identity) || { GUARD_BLOCK_RC=1; return 1; }
    [[ "$current" == "$_GUARD_ATTACH_GENERATION" ]] || { GUARD_BLOCK_RC=1; return 1; }
    return 0
  fi
  [[ "$clients" == 0 ]] || { GUARD_BLOCK_RC=2; return 1; }
  case "$_GUARD_ATTACH_ACTION" in
    send)
      surface_looks_like_bare_shell "$_GUARD_ATTACH_REF" "$_GUARD_ATTACH_SURFACE" 1 \
        || { GUARD_BLOCK_RC=1; return 1; }
      ;;
  esac
  if [[ "$_GUARD_ATTACH_ACTION" == send ]]; then
    ledger_committed_ref "$_GUARD_ATTACH_GENERATION" "$_GUARD_ATTACH_REF" "$_GUARD_ATTACH_TITLE" \
      || { GUARD_BLOCK_RC=1; return 1; }
    workspace=$(workspace_title_for_ref "$_GUARD_ATTACH_REF") \
      || { GUARD_BLOCK_RC=1; return 1; }
    surface=$(workspace_terminal_surface_ref "$_GUARD_ATTACH_REF") \
      || { GUARD_BLOCK_RC=1; return 1; }
    [[ "$workspace" == "$_GUARD_ATTACH_TITLE" && "$surface" == "$_GUARD_ATTACH_SURFACE" ]] \
      || { GUARD_BLOCK_RC=1; return 1; }
    if [[ "$_GUARD_ATTACH_KIND" == view ]]; then
      _view_shell_owned_for_title "$_GUARD_ATTACH_TARGET" "$_GUARD_ATTACH_TITLE" 0 1 1 \
        || { GUARD_BLOCK_RC=1; return 1; }
      clients=$(view_session_client_count "$_GUARD_ATTACH_TARGET") \
        || { GUARD_BLOCK_RC=1; return 1; }
    else
      _v2_lead_roster_row_current "$_GUARD_ATTACH_TITLE" "$_GUARD_ATTACH_TARGET" \
        || { GUARD_BLOCK_RC=1; return 1; }
      clients=$(_private_session_client_count "$_GUARD_ATTACH_TARGET") \
        || { GUARD_BLOCK_RC=1; return 1; }
    fi
    [[ "$clients" == 0 ]] || { GUARD_BLOCK_RC=2; return 1; }
  fi
  current=$(cmux_socket_identity) || { GUARD_BLOCK_RC=1; return 1; }
  [[ "$current" == "$_GUARD_ATTACH_GENERATION" ]] || { GUARD_BLOCK_RC=1; return 1; }
}

_attach_cmux_mutation() {
  local kind="$1" generation="$2" ref="$3" title="$4" surface="$5" target="$6" action="$7"
  shift 7
  _GUARD_ATTACH_KIND="$kind"
  _GUARD_ATTACH_GENERATION="$generation"
  _GUARD_ATTACH_REF="$ref"
  _GUARD_ATTACH_TITLE="$title"
  _GUARD_ATTACH_SURFACE="$surface"
  _GUARD_ATTACH_TARGET="$target"
  _GUARD_ATTACH_ACTION="$action"
  cmux_call_guarded _attach_mutation_guard "$@"
}

_attach_set_status() {
  local color='#8e8e93'
  case "$8" in
    连接失效*|底层\ session\ 不存在*) color='#ff3b30' ;;
    正在重连*|已重建*) color='#ff9500' ;;
  esac
  _attach_cmux_mutation "$1" "$2" "$3" "$4" "$5" "$6" "$7" \
    set-status flywheel.attach "$8" --color "$color" --workspace "$3" || true
}

_report_dead_attach_surface() {
  local kind="$1" generation="$2" ref="$3" title="$4" classification="$5"
  _alert_cmux_cleanup \
    "cmux managed surface is dead" \
    "A managed cmux surface has positive dead-screen evidence but automatic replacement is intentionally disabled until command-birth authority can be preserved: generation=$generation ref=$ref title=$title kind=$kind class=$classification." \
    "cmux_cleanup|attach-dead|generation=$generation|ref=$ref|title=$title|class=$classification"
}

# Durable A/B/C recovery shared by ordinary runner/raw views and private-v2 Leads.
# classification: bare | exited | empty | no-pty | unclassified | missing |
# healthy. The three positive death classes are report-only until cmux exposes
# a replacement primitive that preserves immutable command-birth evidence.
recover_attach_surface() {
  local kind="$1" generation="$2" ref="$3" title="$4" surface="$5" command="$6" target="$7" classification="$8"
  local row attempts=0 phase="" first_epoch=0 _last_epoch=0 last_round=0-0 now round max min_age rc=0 observation_phase final_phase
  if ! _attach_state_valid; then
    _attach_set_status "$kind" "$generation" "$ref" "$title" "$surface" "$target" \
      "$([[ "$classification" == missing ]] && printf missing || printf status)" \
      '连接失效 · 恢复状态损坏'
    return 1
  fi
  now=$(date +%s) || return 1
  round="${CMUX_ADDITIVE_ROUND_ID:-0-0}"
  max=$(_attach_retry_limit)
  row=$(_attach_state_row "$generation" "$ref" "$title" "$kind" 2>/dev/null || true)
  if [[ -n "$row" ]]; then
    IFS='|' read -r _ _ _ _ attempts phase first_epoch _last_epoch last_round < <(printf '%s\n' "$row")
  fi
  case "$classification" in
    healthy)
      [[ -n "$row" ]] || return 0
      _attach_state_write "$generation" "$ref" "$title" "$kind" || return 1
      _attach_cmux_mutation "$kind" "$generation" "$ref" "$title" "$surface" "$target" clear \
        clear-status flywheel.attach --workspace "$ref" || true
      return 0
      ;;
    missing)
      _attach_state_upsert "$generation" "$ref" "$title" "$kind" 0 dead "$now" "$now" "$round" || return 1
      _attach_set_status "$kind" "$generation" "$ref" "$title" "$surface" "$target" missing \
        '底层 session 不存在 · 等待重建'
      return 0
      ;;
    exited|empty|no-pty)
      final_phase="dead-$classification"
      if [[ "$phase" == "$final_phase" && "$attempts" -ge 1 ]]; then
        _report_dead_attach_surface "$kind" "$generation" "$ref" "$title" "$classification"
        return 0
      fi
      observation_phase="observing-$classification"
      if [[ "$phase" != "$observation_phase" ]]; then
        _attach_state_upsert "$generation" "$ref" "$title" "$kind" 1 "$observation_phase" \
          "$now" "$now" "$round" || return 1
        _attach_set_status "$kind" "$generation" "$ref" "$title" "$surface" "$target" status \
          "连接异常 · $classification · 继续观察"
        return 0
      fi
      min_age=$(validated_int_env FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS \
        "${FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS:-120}" 1 3600 | tail -1)
      [[ "$round" != 0-0 && "$round" != "$last_round" ]] || return 0
      (( 10#$now - 10#$first_epoch >= 10#$min_age )) || return 0
      _attach_state_upsert "$generation" "$ref" "$title" "$kind" 2 "$final_phase" \
        "$first_epoch" "$now" "$round" || return 1
      _attach_set_status "$kind" "$generation" "$ref" "$title" "$surface" "$target" status \
        "连接失效 · $classification · 仅上报"
      _report_dead_attach_surface "$kind" "$generation" "$ref" "$title" "$classification"
      return 0
      ;;
    bare)
      if [[ "$phase" == rebuild-issued ]]; then
        _attach_state_upsert "$generation" "$ref" "$title" "$kind" "$attempts" dead \
          "$first_epoch" "$now" "$round" || return 1
        _attach_set_status "$kind" "$generation" "$ref" "$title" "$surface" "$target" status \
          '连接失效 · 点击重连'
        return 0
      fi
      if [[ "$phase" == rebuilt || "$phase" == dead && "$attempts" -ge "$max" ]]; then
        return 0
      fi
      [[ "$phase" == retrying ]] || { attempts=0; first_epoch="$now"; }
      if (( 10#$attempts < 10#$max )); then
        attempts=$((10#$attempts + 1))
        _attach_state_upsert "$generation" "$ref" "$title" "$kind" "$attempts" retrying \
          "$first_epoch" "$now" "$round" || return 1
        printf -v row '%s\n' "$command"
        rc=0
        _attach_cmux_mutation "$kind" "$generation" "$ref" "$title" "$surface" "$target" send \
          send --workspace "$ref" --surface "$surface" "$row" || rc=$?
        if [[ "$GUARD_WAS_BLOCKED" == 1 && "$GUARD_BLOCK_RC" == 2 ]]; then
          return 2
        fi
        [[ "$rc" == 0 && "$GUARD_WAS_BLOCKED" != 1 ]] || return 1
        _attach_set_status "$kind" "$generation" "$ref" "$title" "$surface" "$target" status \
          "正在重连 · ${attempts}/${max}"
        return 0
      fi
      # A bare shell remains safe for bounded command injection, but failure
      # to attach is not positive proof that the whole workspace is dead.
      # Never escalate it to destructive replacement.
      phase=dead; row='连接失效 · 点击重连'
      _attach_state_upsert "$generation" "$ref" "$title" "$kind" "$attempts" "$phase" \
        "$first_epoch" "$now" "$round" || return 1
      _attach_set_status "$kind" "$generation" "$ref" "$title" "$surface" "$target" status "$row"
      if [[ "$kind" == v2 ]]; then
        roster_alert_unhealthy lead-attach-missing "$title" \
          "cmux v2 Lead surface detached" \
          "The v2 Lead pane $title did not attach after $max guarded attempts."
      fi
      return 0
      ;;
    unclassified)
      if [[ "$phase" == dead && "$attempts" -ge 2 ]]; then
        return 0
      fi
      if [[ "$phase" != unclassified ]]; then
        attempts=1; first_epoch="$now"; last_round="$round"
        _attach_state_upsert "$generation" "$ref" "$title" "$kind" "$attempts" unclassified \
          "$first_epoch" "$now" "$round" || return 1
        _attach_set_status "$kind" "$generation" "$ref" "$title" "$surface" "$target" status \
          '连接未就绪 · 继续观察'
        return 0
      fi
      min_age=$(validated_int_env FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS \
        "${FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS:-120}" 1 3600 | tail -1)
      if [[ "$round" != 0-0 && "$round" != "$last_round" ]] \
          && (( 10#$now - 10#$first_epoch >= 10#$min_age )); then
        attempts=$((10#$attempts + 1))
      fi
      if (( 10#$attempts >= 2 )); then
        _attach_state_upsert "$generation" "$ref" "$title" "$kind" "$attempts" dead \
          "$first_epoch" "$now" "$round" || return 1
        _attach_set_status "$kind" "$generation" "$ref" "$title" "$surface" "$target" status \
          '连接失效 · 点击重连'
        _alert_cmux_cleanup \
          "cmux attach state unresolved" \
          "A managed cmux surface remained unreadable or non-shell across distinct recovery rounds: generation=$generation ref=$ref title=$title kind=$kind." \
          "cmux_cleanup|attach-unclassified|generation=$generation|ref=$ref|title=$title"
      else
        _attach_state_upsert "$generation" "$ref" "$title" "$kind" "$attempts" unclassified \
          "$first_epoch" "$now" "$round" || return 1
      fi
      return 0
      ;;
    *) return 1 ;;
  esac
}

# FLY-756: `env -u TMUX` — the injected `tmux attach` runs in the surface's bare
# shell, which inherits the cmux process env. When cmux was launched from within
# a tmux session, `$TMUX` is set and `tmux attach` refuses with "sessions should
# be nested with care, unset $TMUX" (tmux keys nesting off `$TMUX`; `TMUX_PANE`
# is informational and not part of the check). Stripping `$TMUX` for this one
# invocation is the source-level cure for the nested-attach dead pane.
_managed_view_session_safe() {
  case "$1" in cmux-*) ;; *) return 1 ;; esac
  case "$1" in *"'"*|*$'\n'*|*$'\r'*) return 1 ;; esac
}

managed_attach_token_valid() {
  local re='^fwtok1-[0-9a-f]{32}$'
  [[ "$1" =~ $re ]]
}

# Tokens are instance identifiers, not secrets.  Generation lives outside the
# command builders so one create/recovery transaction can reuse the exact same
# value without a hidden retry-time rotation.
new_managed_attach_token() {
  local token
  token=$(python3 -c 'import secrets; print("fwtok1-" + secrets.token_hex(16))') || return 1
  managed_attach_token_valid "$token" || return 1
  printf '%s\n' "$token"
}

cmux_adoption_limit() {
  local value owner_uid current_uid
  if [[ ! -e "$CMUX_ADOPT_CAP_STATE" && ! -L "$CMUX_ADOPT_CAP_STATE" ]]; then
    printf '1\n'
    return 0
  fi
  [[ -f "$CMUX_ADOPT_CAP_STATE" && ! -L "$CMUX_ADOPT_CAP_STATE" ]] || return 1
  current_uid=$(id -u 2>/dev/null) || return 1
  owner_uid=$(stat -c '%u' "$CMUX_ADOPT_CAP_STATE" 2>/dev/null \
    || stat -f '%u' "$CMUX_ADOPT_CAP_STATE" 2>/dev/null) || return 1
  [[ "$owner_uid" == "$current_uid" ]] || return 1
  value=$(awk 'NR==1 {value=$0} END {if(NR!=1) exit 1; print value}' \
    "$CMUX_ADOPT_CAP_STATE") || return 1
  case "$value" in 1|2|3|4|5|6|7|8|9|10) printf '%s\n' "$value" ;; *) return 1 ;; esac
}

cmux_adoption_slot_claim() {
  local limit
  limit=$(cmux_adoption_limit) || return 1
  (( CMUX_ADOPTION_COUNT < limit )) || return 1
  CMUX_ADOPTION_COUNT=$((CMUX_ADOPTION_COUNT + 1))
}

managed_view_command_variants() {
  local view_session="$1" attach_tmux_bin
  local helper="${FLYWHEEL_CMUX_VIEW_HELPER_BIN:-$HOME/.flywheel/bin/flywheel-view-attach.sh}"
  attach_tmux_bin=$(resolve_cmux_attach_tmux_bin) || return 1
  _managed_view_session_safe "$view_session" || return 1
  case "$helper" in /*) ;; *) return 1 ;; esac
  case "$helper$attach_tmux_bin" in *"'"*|*$'\n'*|*$'\r'*) return 1 ;; esac
  printf "env -u TMUX tmux attach -t '=%s'\n" "$view_session"
  printf "env -u TMUX '%s' '%s'\n" "$helper" "$view_session"
  if [[ -n "$attach_tmux_bin" ]]; then
    case "$attach_tmux_bin" in /*) ;; *) return 1 ;; esac
    printf "env -u TMUX '%s' attach -t '=%s'\n" "$attach_tmux_bin" "$view_session"
    printf "env -u TMUX FLYWHEEL_CMUX_ATTACH_TMUX_BIN='%s' '%s' '%s'\n" \
      "$attach_tmux_bin" "$helper" "$view_session"
  fi
}

_cmux_carrier_classify() {
  local mode="$1"
  shift
  local helper="${FLYWHEEL_CMUX_VIEW_HELPER_BIN:-$HOME/.flywheel/bin/flywheel-view-attach.sh}"
  local lead_helper="${FLYWHEEL_CMUX_LEAD_ATTACH_BIN:-$HOME/.flywheel/bin/flywheel-lead-attach.sh}"
  local attach_tmux_bin
  attach_tmux_bin=$(resolve_cmux_attach_tmux_bin) || attach_tmux_bin=""
  python3 -c '
import base64, hashlib, json, re, shlex, sys

mode, helper, lead_helper, tmux_bin, *args = sys.argv[1:]

def parse_command(command):
    try:
        words = shlex.split(command)
    except ValueError:
        return None
    kind = target = token = ""
    if len(words) == 7 and words[:4] == ["env", "-u", "TMUX", "tmux"] and words[4:6] == ["attach", "-t"] and words[6].startswith("="):
        kind, target = "view", words[6][1:]
    elif len(words) in (5, 6) and words[:3] == ["env", "-u", "TMUX"] and words[3] in (helper, lead_helper):
        kind = "view" if words[3] == helper else "lead"
        target = words[4]
        token = words[5] if len(words) == 6 else ""
    elif tmux_bin and len(words) == 7 and words[:3] == ["env", "-u", "TMUX"] and words[3:6] == [tmux_bin, "attach", "-t"] and words[6].startswith("="):
        kind, target = "view", words[6][1:]
    elif tmux_bin and len(words) in (6, 7) and words[:3] == ["env", "-u", "TMUX"] and words[3:5] == ["FLYWHEEL_CMUX_ATTACH_TMUX_BIN=" + tmux_bin, helper]:
        kind, target = "view", words[5]
        token = words[6] if len(words) == 7 else ""
    if token and not re.fullmatch(r"fwtok1-[0-9a-f]{32}", token):
        return None
    if kind == "view":
        if not target.startswith("cmux-") or any(c in target for c in "\x27\r\n"):
            return None
    elif kind == "lead":
        if not target.startswith("/") or any(c in target for c in "\x27\r\n"):
            return None
    else:
        return None
    return kind, target, token

def identity(command):
    parsed = parse_command(command)
    return parsed[:2] if parsed else None

if mode == "parse":
    if len(args) != 1 or args[0] not in ("target", "kind", "token", "record"):
        raise SystemExit(1)
    parsed = parse_command(sys.stdin.read())
    if not parsed:
        raise SystemExit(1)
    kind, target, token = parsed
    values = {"target": target, "kind": kind, "token": token,
              "record": kind + "|" + target + "|" + token}
    print(values[args[0]])
elif mode == "equivalent":
    if len(args) != 2:
        raise SystemExit(1)
    observed, variants = args
    if observed in variants.splitlines():
        raise SystemExit(0)
    observed_identity = identity(observed)
    if observed_identity and any(identity(candidate) == observed_identity
                                 for candidate in variants.splitlines()):
        raise SystemExit(0)
    raise SystemExit(1)
elif mode == "candidates":
    if len(args) != 2:
        raise SystemExit(1)
    title, canonical = args
    expected = None
    for candidate in canonical.splitlines():
        expected = identity(candidate)
        if expected:
            break
    if not expected:
        raise SystemExit(1)
    try:
        workspaces = json.load(sys.stdin).get("workspaces", [])
    except Exception:
        raise SystemExit(1)
    for workspace in workspaces:
        if not isinstance(workspace, dict):
            continue
        ref = workspace.get("ref")
        match = re.fullmatch(r"workspace:([0-9]+)", ref or "")
        observed = workspace.get("title")
        if not match or len(match.group(1)) > 18 or not isinstance(observed, str):
            continue
        kind = "named" if observed == title else "raw" if identity(observed) == expected else ""
        if kind:
            print(kind, ref, int(bool(workspace.get("pinned"))),
                  int(bool(workspace.get("selected"))), match.group(1), sep="|")
elif mode == "stock":
    if args:
        raise SystemExit(1)
    try:
        workspaces = json.load(sys.stdin).get("workspaces", [])
    except Exception:
        raise SystemExit(2)
    managed = re.compile(r"^[A-Z][A-Z0-9]*-[0-9]+-(claude|runner|design|implement|qa)(-|$)")
    groups = {}
    blocked = set()
    refusals = []
    for workspace in workspaces:
        if not isinstance(workspace, dict):
            continue
        ref = workspace.get("ref", "")
        title = workspace.get("title")
        if not isinstance(title, str):
            continue
        safe_ref = ref if isinstance(ref, str) and not any(ord(c) < 32 or ord(c) == 127 for c in ref) else "missing"
        safe_ref = safe_ref or "missing"
        evidence = hashlib.sha256(title.encode()).hexdigest()
        if any(ch in title for ch in ("|", "\t", "\n")):
            refusals.append(("invalid-title-bytes", safe_ref, "unknown", evidence))
            continue
        normalized = title if managed.match(title) else ""
        if not normalized:
            parsed = parse_command(title)
            if parsed and parsed[0] == "view":
                candidate = parsed[1][len("cmux-"):]
                if managed.match(candidate):
                    normalized = candidate
        if not normalized:
            if title.startswith("env -u TMUX"):
                refusals.append(("invalid-raw-attach", safe_ref, "unknown", evidence))
            continue
        if not isinstance(ref, str) or not re.fullmatch(r"workspace:[0-9]+", ref):
            refusals.append(("malformed-ref", safe_ref, normalized, evidence))
            blocked.add(normalized)
            continue
        encoded = base64.b64encode(title.encode()).decode()
        groups.setdefault(normalized, []).append((ref, title, encoded, evidence))
    for normalized, items in sorted(groups.items()):
        if len(items) != 1 or normalized in blocked:
            digest = hashlib.sha256("\n".join(sorted(ref + "|" + title for ref, title, _, _ in items)).encode()).hexdigest()
            refusals.append(("ambiguous-normalized-title", "multiple", normalized, digest))
            continue
        ref, _title, encoded, evidence = items[0]
        print("C", ref, encoded, normalized, evidence, sep="\t")
    for reason, ref, normalized, evidence in sorted(refusals):
        print("R", reason, ref, normalized, evidence, sep="\t")
else:
    raise SystemExit(1)
' "$mode" "$helper" "$lead_helper" "$attach_tmux_bin" "$@"
}

managed_view_command_parse() {
  local command="$1" output="${2:-target}"
  case "$output" in target|kind|token|record) ;; *) return 1 ;; esac
  printf '%s' "$command" | _cmux_carrier_classify parse "$output"
}

_managed_view_command_in_variants() {
  local observed="$1" variants="$2" expected
  while IFS= read -r expected; do
    [[ "$observed" == "$expected" ]] && return 0
  done < <(printf '%s\n' "$variants")
  _cmux_carrier_classify equivalent "$observed" "$variants" </dev/null
}

build_attach_command() {
  local view_session="$1" token="${2:-}" attach_tmux_bin
  local helper="${FLYWHEEL_CMUX_VIEW_HELPER_BIN:-$HOME/.flywheel/bin/flywheel-view-attach.sh}"
  attach_tmux_bin=$(resolve_cmux_attach_tmux_bin) || return 1
  _managed_view_session_safe "$view_session" || return 1
  [[ -z "$token" ]] || managed_attach_token_valid "$token" || return 1
  case "$helper" in /*) ;; *) log "WARN: FLYWHEEL_CMUX_VIEW_HELPER_BIN must be absolute"; return 1 ;; esac
  case "$helper" in *"'"*|*$'\n'*|*$'\r'*) log "WARN: unsafe FLYWHEEL_CMUX_VIEW_HELPER_BIN refused"; return 1 ;; esac
  if [[ ! -x "$helper" ]]; then
    log "WARN: reconnect helper missing or not executable: $helper"
    _alert_cmux_cleanup \
      "cmux reconnect helper unavailable" \
      "cmux-sync deferred a view workspace because the reconnect helper is unavailable: helper=$helper view=$view_session." \
      "cmux_cleanup|helper-missing|view-attach|helper=$helper"
    return 1
  fi
  if [[ -n "$attach_tmux_bin" ]]; then
    printf "env -u TMUX FLYWHEEL_CMUX_ATTACH_TMUX_BIN='%s' '%s' '%s'" \
      "$attach_tmux_bin" "$helper" "$view_session"
  else
    printf "env -u TMUX '%s' '%s'" "$helper" "$view_session"
  fi
  [[ -z "$token" ]] || printf " '%s'" "$token"
}

# FLY-1663: direct per-Lead socket command. The helper owns persistent
# reconnect; this watcher owns only the cmux workspace/ref receipt.
build_lead_attach_command() {
  local socket="$1" token="${2:-}" helper="${FLYWHEEL_CMUX_LEAD_ATTACH_BIN:-$HOME/.flywheel/bin/flywheel-lead-attach.sh}"
  case "$socket" in /*) ;; *) return 1 ;; esac
  case "$helper" in /*) ;; *) return 1 ;; esac
  case "$socket$helper" in *"'"*|*$'\n'*|*$'\r'*) return 1 ;; esac
  [[ -z "$token" ]] || managed_attach_token_valid "$token" || return 1
  printf "env -u TMUX '%s' '%s'" "$helper" "$socket"
  [[ -z "$token" ]] || printf " '%s'" "$token"
}

_attach_b64_decode() {
  printf '%s' "$1" | python3 -c \
    'import base64,sys; sys.stdout.write(base64.b64decode(sys.stdin.read(),validate=True).decode())'
}

# Join current cmux ref/workspace UUID/surface UUID to the persisted
# processTitle snapshot. processTitle is birth evidence only: it proves which
# managed carrier created the workspace, never what the terminal runs now.
_cmux_attach_birth_records_uncached() {
  local raw="${1:-}" current_rows ref workspace_uuid surface_json surface_b64 surface_rows=""
  local helper="${FLYWHEEL_CMUX_VIEW_HELPER_BIN:-$HOME/.flywheel/bin/flywheel-view-attach.sh}"
  local lead_helper="${FLYWHEEL_CMUX_LEAD_ATTACH_BIN:-$HOME/.flywheel/bin/flywheel-lead-attach.sh}"
  local attach_tmux_bin
  attach_tmux_bin=$(resolve_cmux_attach_tmux_bin) || attach_tmux_bin=""
  [[ -f "$CMUX_SESSION_STATE" && ! -L "$CMUX_SESSION_STATE" ]] || return 2
  [[ -n "$raw" ]] || raw=$(get_cmux_workspaces_json) || return 2
  current_rows=$(printf '%s' "$raw" | python3 -c '
import json,re,sys
try: rows=json.load(sys.stdin).get("workspaces", [])
except Exception: raise SystemExit(2)
seen=set()
for w in rows:
    if not isinstance(w,dict): continue
    ref=w.get("ref"); uuid=w.get("id")
    if not isinstance(ref,str) or not re.fullmatch(r"workspace:[0-9]+",ref): continue
    if ref in seen or not isinstance(uuid,str): raise SystemExit(2)
    seen.add(ref)
    print(ref,uuid,sep="|")
') || return 2
  while IFS='|' read -r ref workspace_uuid; do
    [[ -n "$ref" ]] || continue
    surface_json=$(cmux_call --json --id-format both list-pane-surfaces --workspace "$ref") || return 2
    surface_b64=$(printf '%s' "$surface_json" | base64 | tr -d '\n') || return 2
    surface_rows+="${surface_rows:+$'\n'}$ref|$workspace_uuid|$surface_b64"
  done < <(printf '%s\n' "$current_rows")
  python3 - "$CMUX_SESSION_STATE" "$raw" "$surface_rows" \
    "$helper" "$lead_helper" "$attach_tmux_bin" <<'PY' || return 2
import base64,json,re,shlex,sys

state_path,raw_json,surface_lines,helper,lead_helper,tmux_bin=sys.argv[1:]
uuid_re=re.compile(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")

def parse_command(command):
    try: words=shlex.split(command)
    except ValueError: return None
    kind=target=token=""
    if len(words)==7 and words[:4]==["env","-u","TMUX","tmux"] and words[4:6]==["attach","-t"] and words[6].startswith("="):
        kind,target="view",words[6][1:]
    elif len(words) in (5,6) and words[:3]==["env","-u","TMUX"] and words[3] in (helper,lead_helper):
        kind="view" if words[3]==helper else "lead"
        target=words[4]; token=words[5] if len(words)==6 else ""
    elif tmux_bin and len(words)==7 and words[:3]==["env","-u","TMUX"] and words[3:6]==[tmux_bin,"attach","-t"] and words[6].startswith("="):
        kind,target="view",words[6][1:]
    elif tmux_bin and len(words) in (6,7) and words[:3]==["env","-u","TMUX"] and words[3:5]==["FLYWHEEL_CMUX_ATTACH_TMUX_BIN="+tmux_bin,helper]:
        kind,target="view",words[5]
        token=words[6] if len(words)==7 else ""
    if token and not re.fullmatch(r"fwtok1-[0-9a-f]{32}",token): return None
    if kind=="view":
        if not target.startswith("cmux-") or any(c in target for c in "\x27\r\n"): return None
    elif kind=="lead":
        if not target.startswith("/") or any(c in target for c in "\x27\r\n"): return None
    else: return None
    return kind,target,token

try:
    workspaces=json.loads(raw_json).get("workspaces",[])
    persisted=json.load(open(state_path,encoding="utf-8"))
except Exception: raise SystemExit(2)
if not isinstance(workspaces,list): raise SystemExit(2)
current={}; order=[]
for row in workspaces:
    if not isinstance(row,dict): continue
    ref=row.get("ref"); uuid=row.get("id"); title=row.get("title")
    if not isinstance(ref,str) or not re.fullmatch(r"workspace:[0-9]+",ref): continue
    if ref in current or not isinstance(uuid,str) or not uuid_re.fullmatch(uuid) or not isinstance(title,str): raise SystemExit(2)
    current[ref]=(uuid,title); order.append(ref)

commands={}
for window in persisted.get("windows",[]):
    if not isinstance(window,dict): continue
    manager=window.get("tabManager",{})
    if not isinstance(manager,dict): continue
    for ws in manager.get("workspaces",[]):
        if not isinstance(ws,dict): continue
        surface=ws.get("focusedPanelId"); command=ws.get("processTitle"); panels=ws.get("panels",[])
        if not isinstance(surface,str) or not isinstance(command,str) or not isinstance(panels,list): continue
        terms=[p for p in panels if isinstance(p,dict) and p.get("type")=="terminal" and p.get("id")==surface]
        if len(terms)!=1 or not uuid_re.fullmatch(surface): continue
        if surface in commands and commands[surface]!=command: raise SystemExit(2)
        commands[surface]=command

surfaces={}
for raw_line in surface_lines.splitlines():
    fields=raw_line.split("|")
    if len(fields)!=3: raise SystemExit(2)
    ref,uuid,encoded=fields
    if ref in surfaces or ref not in current or current[ref][0]!=uuid: raise SystemExit(2)
    try: data=json.loads(base64.b64decode(encoded,validate=True).decode())
    except Exception: raise SystemExit(2)
    rows=data.get("surfaces",[])
    if data.get("workspace_id")!=uuid or not isinstance(rows,list): raise SystemExit(2)
    terms=[row for row in rows if isinstance(row,dict) and row.get("type")=="terminal"
           and isinstance(row.get("id"),str) and uuid_re.fullmatch(row["id"])]
    # A non-standard workspace is localized: it contributes no birth
    # authority but cannot poison every unrelated workspace in the snapshot.
    if len(terms)!=1: continue
    surfaces[ref]=terms[0]["id"]

for ref in order:
    if ref not in surfaces: continue
    uuid,title=current[ref]; surface=surfaces[ref]
    command=commands.get(surface)
    if command is None: continue
    parsed=parse_command(command)
    if parsed is None: continue
    kind,target,token=parsed
    print(ref,uuid,base64.b64encode(title.encode()).decode(),surface,kind,
          base64.b64encode(target.encode()).decode(),token,sep="|")
PY
}

# One immutable birth-authority snapshot per additive pass.  Command
# substitutions inherit these globals, so nested Lead/liveness/close helpers
# read the same rows without repeating the fleet-wide surface RPC sweep.
CMUX_ATTACH_BIRTH_CACHE_READY=0
CMUX_ATTACH_BIRTH_CACHE_ROUND=""
CMUX_ATTACH_BIRTH_CACHE_ROWS=""
cmux_attach_birth_cache_prime() {
  local raw="${1:-}" rows rc=0
  CMUX_ATTACH_BIRTH_CACHE_READY=0
  CMUX_ATTACH_BIRTH_CACHE_ROUND="${CMUX_ADDITIVE_ROUND_ID:-}"
  CMUX_ATTACH_BIRTH_CACHE_ROWS=""
  [[ -n "$raw" ]] || raw=$(get_cmux_workspaces_json) || {
    CMUX_ATTACH_BIRTH_CACHE_READY=2
    return 2
  }
  rows=$(_cmux_attach_birth_records_uncached "$raw") || rc=$?
  if [[ "$rc" != 0 ]]; then
    CMUX_ATTACH_BIRTH_CACHE_READY=2
    return "$rc"
  fi
  CMUX_ATTACH_BIRTH_CACHE_ROWS="$rows"
  CMUX_ATTACH_BIRTH_CACHE_READY=1
  return 0
}

cmux_attach_birth_records() {
  case "$CMUX_ATTACH_BIRTH_CACHE_READY" in
    1) [[ -z "$CMUX_ATTACH_BIRTH_CACHE_ROWS" ]] || printf '%s\n' "$CMUX_ATTACH_BIRTH_CACHE_ROWS"; return 0 ;;
    2) return 2 ;;
  esac
  _cmux_attach_birth_records_uncached "${1:-}"
}

_cmux_workspace_birth_record_uncached() {
  local ref="$1" expected_uuid="${2:-}" raw subset rows
  raw=$(get_cmux_workspaces_json) || return 2
  subset=$(printf '%s' "$raw" | python3 -c '
import json,sys
ref,expected=sys.argv[1:3]
try: data=json.load(sys.stdin); rows=data.get("workspaces",[])
except Exception: raise SystemExit(2)
matches=[row for row in rows if isinstance(row,dict) and row.get("ref")==ref
         and (not expected or row.get("id")==expected)]
if len(matches)!=1: raise SystemExit(1 if not matches else 2)
print(json.dumps({"workspaces":matches},separators=(",",":")))
' "$ref" "$expected_uuid") || return $?
  rows=$(_cmux_attach_birth_records_uncached "$subset") || return $?
  [[ -n "$rows" ]] || return 1
  printf '%s\n' "$rows"
}

cmux_workspace_birth_record() {
  local ref="$1" expected_uuid="${2:-}" rows="" row row_ref remainder row_uuid count=0 match=""
  if [[ "$CMUX_ATTACH_BIRTH_CACHE_READY" == 1 ]]; then
    rows="$CMUX_ATTACH_BIRTH_CACHE_ROWS"
    while IFS= read -r row; do
      [[ -n "$row" ]] || continue
      row_ref="${row%%|*}"
      remainder="${row#*|}"; row_uuid="${remainder%%|*}"
      if [[ "$row_ref" == "$ref" && ( -z "$expected_uuid" || "$row_uuid" == "$expected_uuid" ) ]]; then
        count=$((count + 1)); match="$row"
      fi
    done < <(printf '%s\n' "$rows")
    [[ "$count" -le 1 ]] || return 2
    if [[ "$count" == 1 ]]; then
      printf '%s\n' "$match"
      return 0
    fi
  fi
  # New workspaces created after the pass snapshot and close paths outside a
  # pass pay for one ref-scoped join, never a second fleet-wide sweep.
  _cmux_workspace_birth_record_uncached "$ref" "$expected_uuid"
}

workspace_birth_attach_token() {
  local ref="$1" expected_kind="$2" expected_target_b64="$3"
  local birth _ref _uuid _title _surface kind target_b64 token
  birth=$(cmux_workspace_birth_record "$ref") || return 1
  IFS='|' read -r _ref _uuid _title _surface kind target_b64 token \
    < <(printf '%s\n' "$birth")
  [[ "$_ref" == "$ref" && "$kind" == "$expected_kind" \
      && "$target_b64" == "$expected_target_b64" ]] || return 1
  managed_attach_token_valid "$token" || return 1
  printf '%s\n' "$token"
}

attach_reap_limits() {
  local max="${FLYWHEEL_CMUX_ATTACH_MAX_TREE_PROCESSES:-4}"
  local deliveries="${FLYWHEEL_CMUX_ATTACH_MAX_TREE_DELIVERIES:-8}"
  case "$max" in ''|*[!0-9]*) max=4 ;; esac
  case "$deliveries" in ''|*[!0-9]*) deliveries=8 ;; esac
  if [[ ${#max} -gt 2 || ${#deliveries} -gt 3 ]] \
      || (( 10#$max < 1 || 10#$max > 32 || 10#$deliveries < 2 * 10#$max || 10#$deliveries > 128 )); then
    max=4; deliveries=8
  fi
  printf '%s|%s\n' "$((10#$max))" "$((10#$deliveries))"
}

_attach_reap_state_valid() {
  [[ -e "$ATTACH_REAP_STATE" || -L "$ATTACH_REAP_STATE" ]] || return 0
  [[ -f "$ATTACH_REAP_STATE" && ! -L "$ATTACH_REAP_STATE" ]] || return 1
  local limits max deliveries
  limits=$(attach_reap_limits) || return 1
  IFS='|' read -r max deliveries < <(printf '%s\n' "$limits")
  python3 - "$ATTACH_REAP_STATE" "$max" "$deliveries" <<'PY' >/dev/null 2>&1
import base64,json,re,sys
path,max_size,max_deliveries=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
seen=set()
for raw in open(path,encoding="utf-8"):
    p=raw.rstrip("\n").split("|")
    if len(p)!=14 or p[0]!="reapv1": raise SystemExit(1)
    _,tree,kind,target,token,phase,term,deadline,delivery,attempts,ref,uuid,root,tuples=p
    if tree in seen or not re.fullmatch(r"[0-9a-f]{64}",tree): raise SystemExit(1)
    seen.add(tree)
    if kind not in {"view","lead"} or phase not in {"term-issued","kill-pending","terminal-hold"}: raise SystemExit(1)
    if token!="-" and not re.fullmatch(r"fwtok1-[0-9a-f]{32}",token): raise SystemExit(1)
    if not ((re.fullmatch(r"workspace:[0-9]+",ref) and re.fullmatch(r"[0-9A-Fa-f-]{36}",uuid))
            or (ref=="-" and uuid=="-")): raise SystemExit(1)
    if not all(x.isdigit() and len(x)<=18 for x in (term,deadline,delivery,attempts,root)): raise SystemExit(1)
    if int(delivery)>max_deliveries or int(attempts)>2: raise SystemExit(1)
    try:
        decoded=base64.b64decode(target,validate=True).decode()
        rows=json.loads(base64.b64decode(tuples,validate=True).decode())
    except Exception: raise SystemExit(1)
    if not decoded or any(ord(c)<32 or ord(c)==127 for c in decoded): raise SystemExit(1)
    if not isinstance(rows,list) or not 1<=len(rows)<=max_size: raise SystemExit(1)
    pids=set(); roots=0; prior=None
    for row in rows:
        if not isinstance(row,dict) or set(row)!={"pid","ppid","start","depth"}: raise SystemExit(1)
        pid,ppid,depth=row["pid"],row["ppid"],row["depth"]
        if not all(isinstance(v,int) and 0<=v<=999999999999 for v in (pid,ppid,depth)): raise SystemExit(1)
        if pid<1 or pid in pids: raise SystemExit(1)
        pids.add(pid); roots += depth==0
        if prior is not None and depth>prior: raise SystemExit(1)
        prior=depth
        try: start=base64.b64decode(row["start"],validate=True).decode()
        except Exception: raise SystemExit(1)
        if not start or any(ord(c)<32 or ord(c)==127 for c in start): raise SystemExit(1)
    if roots!=1 or int(root) not in pids: raise SystemExit(1)
PY
}

_attach_reap_state_write() {
  local tree="$1" replacement="${2:-}" dir source tmp
  _attach_reap_state_valid || return 1
  dir=$(dirname "$ATTACH_REAP_STATE")
  mkdir -p "$dir" || return 1
  source=/dev/null; [[ -f "$ATTACH_REAP_STATE" ]] && source="$ATTACH_REAP_STATE"
  tmp=$(mktemp "${ATTACH_REAP_STATE}.XXXX") || return 1
  awk -F'|' -v t="$tree" '!($1=="reapv1" && $2==t) {print}' "$source" > "$tmp" \
    || { rm -f "$tmp"; return 1; }
  [[ -z "$replacement" ]] || printf '%s\n' "$replacement" >> "$tmp" \
    || { rm -f "$tmp"; return 1; }
  if [[ -s "$tmp" ]]; then mv "$tmp" "$ATTACH_REAP_STATE"; else rm -f "$tmp" "$ATTACH_REAP_STATE"; fi
}

_attach_reap_state_upsert() {
  local tree="$1" row="$2"
  [[ "$row" == "reapv1|$tree|"* ]] || return 1
  _attach_reap_state_write "$tree" "$row" || return 1
  _attach_reap_state_valid
}

_attach_reap_tree_payload() {
  local snapshot="$1" root="$2" max="$3"
  printf '%s\n' "$snapshot" | python3 -c '
import base64,json,sys
root,max_size=int(sys.argv[1]),int(sys.argv[2])
rows={}
for raw in sys.stdin:
    p=raw.rstrip("\n").split("|")
    if len(p)!=4: raise SystemExit(2)
    pid,ppid=int(p[0]),int(p[1])
    if pid in rows: raise SystemExit(2)
    rows[pid]={"pid":pid,"ppid":ppid,"start":p[2]}
if root not in rows: raise SystemExit(1)
depth={root:0}; changed=True
while changed:
    changed=False
    for pid,row in rows.items():
        if pid not in depth and row["ppid"] in depth:
            depth[pid]=depth[row["ppid"]]+1; changed=True
tree=[dict(rows[pid],depth=d) for pid,d in depth.items()]
if len(tree)>max_size: raise SystemExit(3)
tree.sort(key=lambda row:(-row["depth"],row["pid"]))
payload=base64.b64encode(json.dumps(tree,separators=(",",":"),sort_keys=True).encode()).decode()
print(payload)
' "$root" "$max"
}

_ATTACH_REAP_PREPARED_ROW=""
_ATTACH_REAP_PREPARED_TREE=""
attach_reap_prepare_workspace() {
  local ref="$1" expected_uuid="${2:-}" birth birth_rows workspace_uuid kind target_b64 token target
  local snapshot helpers roots root_count root_pid payload payload_rc=0 limits max deliveries now tree workspace_count
  _ATTACH_REAP_PREPARED_ROW=""; _ATTACH_REAP_PREPARED_TREE=""
  _attach_reap_state_valid || return 2
  birth=$(cmux_workspace_birth_record "$ref" "$expected_uuid") || return $?
  IFS='|' read -r _ workspace_uuid _ _ kind target_b64 token < <(printf '%s\n' "$birth")
  snapshot=$(cmux_process_snapshot_records) || return 2
  helpers=$(cmux_attach_helper_records_from_snapshot "$snapshot") || return 2
  if [[ -n "$token" ]]; then
    roots=$(printf '%s\n' "$helpers" | awk -F'|' -v k="$kind" -v t="$target_b64" -v n="$token" \
      '$4==k && $5==t && $6==n {print $1}')
  else
    # Legacy carrier: any second incarnation for the same target makes the
    # close cardinality ambiguous, regardless of that incarnation's token.
    roots=$(printf '%s\n' "$helpers" | awk -F'|' -v k="$kind" -v t="$target_b64" '$4==k && $5==t {print $1"|"$6}')
    root_count=$(printf '%s\n' "$roots" | grep -c . || true)
    [[ "$root_count" == 1 && "$roots" == *'|' ]] || return 1
    root_pid="${roots%%|*}"
    birth_rows=$(cmux_attach_birth_records) || return 2
    workspace_count=$(printf '%s\n' "$birth_rows" | awk -F'|' -v k="$kind" -v t="$target_b64" '$5==k && $6==t {n++} END {print n+0}')
    [[ "$workspace_count" == 1 ]] || return 1
    roots="$root_pid"
  fi
  root_count=$(printf '%s\n' "$roots" | grep -c . || true)
  [[ "$root_count" == 1 ]] || return 1
  root_pid=$(printf '%s\n' "$roots" | head -1)
  limits=$(attach_reap_limits) || return 2
  IFS='|' read -r max deliveries < <(printf '%s\n' "$limits")
  payload=$(_attach_reap_tree_payload "$snapshot" "$root_pid" "$max") || payload_rc=$?
  [[ "$payload_rc" == 0 ]] || return 1
  now=$(date +%s) || return 2
  target=$(_attach_b64_decode "$target_b64") || return 2
  tree=$(_cmux_alert_hash "$ref|$workspace_uuid|$kind|$target|${token:--}|$root_pid|$payload")
  _ATTACH_REAP_PREPARED_TREE="$tree"
  _ATTACH_REAP_PREPARED_ROW="reapv1|$tree|$kind|$target_b64|${token:--}|term-issued|$now|$now|0|0|$ref|$workspace_uuid|$root_pid|$payload"
  return 0
}

_attach_reap_ref_absent() {
  local ref="$1" raw count
  raw=$(get_cmux_workspaces_json) || return 2
  count=$(printf '%s' "$raw" | python3 -c '
import json,sys
r=sys.argv[1]
try: rows=json.load(sys.stdin).get("workspaces",[])
except Exception: raise SystemExit(2)
print(sum(1 for row in rows if isinstance(row,dict) and row.get("ref")==r))
' "$ref") || return 2
  [[ "$count" == 0 ]]
}

attach_reap_commit_prepared() {
  local ref="$1"
  [[ -n "$_ATTACH_REAP_PREPARED_TREE" && -n "$_ATTACH_REAP_PREPARED_ROW" ]] || return 1
  _attach_reap_ref_absent "$ref" || return $?
  _attach_reap_state_upsert "$_ATTACH_REAP_PREPARED_TREE" "$_ATTACH_REAP_PREPARED_ROW"
}

_attach_reap_tuples() {
  printf '%s' "$1" | python3 -c '
import base64,json,sys
rows=json.loads(base64.b64decode(sys.stdin.read(),validate=True).decode())
for row in rows: print(row["pid"],row["start"],row["depth"],sep="|")
'
}

_attach_reap_signal() {
  local signal="$1" pid="$2"
  [[ "${FLYWHEEL_CMUX_DRY_RUN:-0}" != 1 ]] || return 1
  kill "-$signal" "$pid" 2>/dev/null
}

_attach_reap_row() {
  printf 'reapv1|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}" "${12}" "${13}"
}

_attach_reap_any_current() {
  local tuples="$1" pid start _ current_rc any=1
  while IFS='|' read -r pid start _; do
    [[ -n "$pid" ]] || continue
    current_rc=0; cmux_process_tuple_current "$pid" "$start" || current_rc=$?
    case "$current_rc" in 0) any=0 ;; 1) ;; *) return 2 ;; esac
  done < <(_attach_reap_tuples "$tuples")
  return "$any"
}

advance_attach_reap_state() {
  _attach_reap_state_valid || { log "WARN: attach reap state invalid; all helper signals frozen"; return 2; }
  [[ -f "$ATTACH_REAP_STATE" ]] || return 0
  assert_or_reuse_owned_lease || return 0
  local rows tree kind target token phase term deadline delivery attempts ref uuid root tuples
  local now limits _max max_deliveries pid start _ tuple_rc signal hold replacement
  rows=$(cat "$ATTACH_REAP_STATE") || return 2
  now=$(date +%s) || return 2
  limits=$(attach_reap_limits) || return 2
  IFS='|' read -r _max max_deliveries < <(printf '%s\n' "$limits")
  while IFS='|' read -r _ tree kind target token phase term deadline delivery attempts ref uuid root tuples; do
    [[ -n "$tree" ]] || continue
    if [[ "$phase" == terminal-hold ]]; then
      tuple_rc=0; _attach_reap_any_current "$tuples" || tuple_rc=$?
      [[ "$tuple_rc" == 1 ]] && _attach_reap_state_write "$tree"
      [[ "$tuple_rc" == 2 ]] && return 2
      continue
    fi
    [[ "$phase" != kill-pending || 10#$now -ge 10#$deadline ]] || continue
    [[ "${FLYWHEEL_CMUX_DRY_RUN:-0}" != 1 ]] || continue
    signal=TERM; [[ "$phase" == kill-pending ]] && signal=KILL
    hold=0
    while IFS='|' read -r pid start _; do
      [[ -n "$pid" ]] || continue
      tuple_rc=0; cmux_process_tuple_current "$pid" "$start" || tuple_rc=$?
      case "$tuple_rc" in
        1) continue ;;
        2) return 2 ;;
      esac
      if (( 10#$delivery >= 10#$max_deliveries )); then hold=1; break; fi
      delivery=$((10#$delivery + 1))
      replacement=$(_attach_reap_row "$tree" "$kind" "$target" "$token" "$phase" \
        "$term" "$deadline" "$delivery" "$attempts" "$ref" "$uuid" "$root" "$tuples")
      _attach_reap_state_upsert "$tree" "$replacement" || return 2
      _attach_reap_signal "$signal" "$pid" || true
    done < <(_attach_reap_tuples "$tuples")
    if [[ "$hold" == 1 ]]; then
      replacement=$(_attach_reap_row "$tree" "$kind" "$target" "$token" terminal-hold \
        "$term" "$deadline" "$delivery" 2 "$ref" "$uuid" "$root" "$tuples")
      _attach_reap_state_upsert "$tree" "$replacement" || return 2
      continue
    fi
    if [[ "$phase" == term-issued ]]; then
      replacement=$(_attach_reap_row "$tree" "$kind" "$target" "$token" kill-pending \
        "$term" "$((now + 15))" "$delivery" 1 "$ref" "$uuid" "$root" "$tuples")
      _attach_reap_state_upsert "$tree" "$replacement" || return 2
    else
      tuple_rc=0; _attach_reap_any_current "$tuples" || tuple_rc=$?
      if [[ "$tuple_rc" == 1 ]]; then
        _attach_reap_state_write "$tree" || return 2
      elif [[ "$tuple_rc" == 0 ]]; then
        replacement=$(_attach_reap_row "$tree" "$kind" "$target" "$token" terminal-hold \
          "$term" "$deadline" "$delivery" 2 "$ref" "$uuid" "$root" "$tuples")
        _attach_reap_state_upsert "$tree" "$replacement" || return 2
      else
        return 2
      fi
    fi
  done < <(printf '%s\n' "$rows")
  return 0
}

cmux_call_guarded_close_with_attach_reap() {
  local ref="$1" expected_uuid="$2" guard="$3" prep_rc=0 close_rc=0
  shift 3
  attach_reap_prepare_workspace "$ref" "$expected_uuid" || prep_rc=$?
  [[ "$prep_rc" != 2 ]] \
    || log "WARN: helper pre-close census inconclusive ref=$ref; close proceeds without signal authority"
  cmux_call_guarded "$guard" close-workspace --workspace "$ref" "$@" || close_rc=$?
  if [[ "$close_rc" == 0 && "$GUARD_WAS_BLOCKED" != 1 && "$prep_rc" == 0 ]]; then
    attach_reap_commit_prepared "$ref" \
      || log "WARN: helper reap receipt could not be committed after close ref=$ref"
  fi
  return "$close_rc"
}

cmux_call_close_with_attach_reap() {
  local ref="$1" expected_uuid="$2" prep_rc=0 close_rc=0
  shift 2
  attach_reap_prepare_workspace "$ref" "$expected_uuid" || prep_rc=$?
  [[ "$prep_rc" != 2 ]] \
    || log "WARN: helper pre-close census inconclusive ref=$ref; close proceeds without signal authority"
  cmux_call close-workspace --workspace "$ref" "$@" || close_rc=$?
  if [[ "$close_rc" == 0 && "$prep_rc" == 0 ]]; then
    attach_reap_commit_prepared "$ref" \
      || log "WARN: helper reap receipt could not be committed after close ref=$ref"
  fi
  return "$close_rc"
}

_attach_orphan_state_valid() {
  [[ -e "$ATTACH_ORPHAN_STATE" || -L "$ATTACH_ORPHAN_STATE" ]] || return 0
  [[ -f "$ATTACH_ORPHAN_STATE" && ! -L "$ATTACH_ORPHAN_STATE" ]] || return 1
  python3 - "$ATTACH_ORPHAN_STATE" <<'PY' >/dev/null 2>&1
import base64,re,sys
seen=set()
for raw in open(sys.argv[1],encoding="utf-8"):
    p=raw.rstrip("\n").split("|")
    if len(p)!=8 or p[0]!="orphanv1": raise SystemExit(1)
    _,fingerprint,kind,target,token,pid,start,round_id=p
    if fingerprint in seen or not re.fullmatch(r"[0-9a-f]{64}",fingerprint): raise SystemExit(1)
    seen.add(fingerprint)
    if kind not in {"view","lead"}: raise SystemExit(1)
    if token!="-" and not re.fullmatch(r"fwtok1-[0-9a-f]{32}",token): raise SystemExit(1)
    if not pid.isdigit() or len(pid)>12 or not re.fullmatch(r"[0-9]+-[0-9]+",round_id): raise SystemExit(1)
    round_epoch,round_sequence=round_id.split("-")
    if len(round_epoch)>12 or len(round_sequence)>6: raise SystemExit(1)
    try:
        decoded=base64.b64decode(target,validate=True).decode()
        born=base64.b64decode(start,validate=True).decode()
    except Exception: raise SystemExit(1)
    if not decoded or not born or any(ord(c)<32 or ord(c)==127 for c in decoded+born): raise SystemExit(1)
PY
}

_attach_orphan_state_replace() {
  local rows="$1" dir tmp
  _attach_orphan_state_valid || return 1
  dir=$(dirname "$ATTACH_ORPHAN_STATE")
  mkdir -p "$dir" || return 1
  tmp=$(mktemp "${ATTACH_ORPHAN_STATE}.XXXX") || return 1
  printf '%s' "$rows" > "$tmp" || { rm -f "$tmp"; return 1; }
  if [[ -s "$tmp" ]]; then mv "$tmp" "$ATTACH_ORPHAN_STATE"; else rm -f "$tmp" "$ATTACH_ORPHAN_STATE"; fi
}

_attach_reap_state_covers_tuple() {
  local pid="$1" start="$2"
  _attach_reap_state_valid || return 2
  [[ -f "$ATTACH_REAP_STATE" ]] || return 1
  python3 - "$ATTACH_REAP_STATE" "$pid" "$start" <<'PY' >/dev/null
import base64,json,sys
pid=int(sys.argv[2]); start=sys.argv[3]
for raw in open(sys.argv[1],encoding="utf-8"):
    p=raw.rstrip("\n").split("|")
    rows=json.loads(base64.b64decode(p[13],validate=True).decode())
    if any(row["pid"]==pid and row["start"]==start for row in rows): raise SystemExit(0)
raise SystemExit(1)
PY
}

_attach_target_presence() {
  # rc=0 present, rc=1 conclusively absent, rc=2 inventory error.
  local kind="$1" target="$2" rc=0 output bounded timeout
  bounded="${_CMUX_SYNC_SCRIPT_DIR}/lib/bounded-run.sh"
  [[ -x "$bounded" ]] || return 2
  timeout=$(validated_int_env FLYWHEEL_CMUX_TMUX_PROBE_TIMEOUT_SECONDS \
    "${FLYWHEEL_CMUX_TMUX_PROBE_TIMEOUT_SECONDS:-3}" 3 10)
  if [[ "$kind" == view ]]; then
    output=$("$bounded" "$timeout" tmux has-session -t "=$target" 2>&1) || rc=$?
  else
    output=$("$bounded" "$timeout" tmux -S "$target" has-session -t '=main' 2>&1) || rc=$?
  fi
  [[ "$rc" == 0 ]] && return 0
  [[ "$rc" == 1 ]] || return 2
  case "$kind:$output" in
    view:*"can't find session: $target"*|lead:*"can't find session: main"*|\
    *:*"no server running on "*|*:*"error connecting to "*"(No such file or directory)"*|\
    *:*"error connecting to "*"(Connection refused)"*) return 1 ;;
  esac
  return 2
}

_attach_workspace_claim_count() {
  local raw="$1" births="$2" kind="$3" target="$4" target_b64="$5"
  local title canonical candidates roster_count
  case "$kind" in
    view)
      [[ "$target" == "$VIEW_PREFIX"* ]] || return 2
      title="${target#"$VIEW_PREFIX"}"
      [[ -n "$title" ]] || return 2
      canonical=$(managed_view_command_variants "$target") || return 2
      ;;
    lead)
      canonical=$(build_lead_attach_command "$target") || return 2
      [[ "$LEAD_ROSTER_STATE" == ok ]] || derive_lead_roster || return 2
      [[ "$LEAD_ROSTER_STATE" == ok ]] || return 2
      roster_count=$(printf '%s\n' "$LEAD_ROSTER_ROWS" | awk -F'|' -v s="$target" \
        '$1=="claude-private" && $4==s {n++; t=$3} END {if(n==1) print t; else if(n>1) exit 2}') || return 2
      # A retired socket can still be claimed by its exact raw helper command.
      # Use an impossible managed title when no current roster row names it.
      title="${roster_count:-__flywheel_no_roster_title__}"
      ;;
    *) return 2 ;;
  esac
  candidates=$(workspace_title_candidates "$raw" "$title" "$canonical") || return 2
  {
    printf '%s\n' "$candidates" | awk -F'|' 'NF==5 && $2!="" {print $2}'
    printf '%s\n' "$births" | awk -F'|' -v k="$kind" -v t="$target_b64" \
      'NF==7 && $5==k && $6==t {print $1}'
  } | awk 'NF && !seen[$0]++ {n++} END {print n+0}'
}

CMUX_HELPER_DISCOVERY_CONCLUSIVE=0
discover_orphan_attach_helpers() {
  CMUX_HELPER_DISCOVERY_CONCLUSIVE=0
  _attach_reap_state_valid || { log "WARN: attach reap state invalid; orphan mint frozen"; return 2; }
  _attach_orphan_state_valid || { log "WARN: attach orphan state invalid; orphan mint frozen"; return 2; }
  assert_or_reuse_owned_lease || return 0
  local snapshot helpers births raw old="" keep="" round round_epoch budget minted=0
  local pid _ppid start kind target_b64 token target presence_rc workspace_count fingerprint prior
  local prior_epoch limits max _deliveries payload payload_rc tree row now
  snapshot=$(cmux_process_snapshot_records) || return 2
  helpers=$(cmux_attach_helper_records_from_snapshot "$snapshot") || return 2
  births=$(cmux_attach_birth_records) || return 2
  raw=$(get_cmux_workspaces_json) || return 2
  [[ -f "$ATTACH_ORPHAN_STATE" ]] && old=$(cat "$ATTACH_ORPHAN_STATE") || true
  round="${CMUX_ADDITIVE_ROUND_ID:-}"
  _additive_round_id_valid "$round" || return 2
  round_epoch="${round%%-*}"
  budget="${FLYWHEEL_CMUX_ATTACH_REAP_BUDGET:-4}"
  case "$budget" in ''|*[!0-9]*) budget=4 ;; esac
  (( ${#budget} <= 2 && 10#$budget >= 1 && 10#$budget <= 32 )) || budget=4
  while IFS='|' read -r pid _ppid start kind target_b64 token; do
    [[ -n "$pid" ]] || continue
    token="${token:--}"
    if _attach_reap_state_covers_tuple "$pid" "$start"; then continue; else
      [[ $? == 1 ]] || return 2
    fi
    target=$(_attach_b64_decode "$target_b64") || return 2
    presence_rc=0; _attach_target_presence "$kind" "$target" || presence_rc=$?
    [[ "$presence_rc" == 1 ]] || { [[ "$presence_rc" == 2 ]] && return 2; continue; }
    workspace_count=$(_attach_workspace_claim_count "$raw" "$births" \
      "$kind" "$target" "$target_b64") || return 2
    [[ "$workspace_count" == 0 ]] || continue
    fingerprint=$(_cmux_alert_hash "$pid|$start|$kind|$target_b64|$token")
    prior=$(printf '%s\n' "$old" | awk -F'|' -v f="$fingerprint" '$1=="orphanv1" && $2==f {print $8; exit}')
    if [[ -z "$prior" ]]; then
      keep+="${keep:+$'\n'}orphanv1|$fingerprint|$kind|$target_b64|$token|$pid|$start|$round"
      continue
    fi
    prior_epoch="${prior%%-*}"
    # Distinct rounds can occur in the same second. Preserve the first proof
    # until the promised 60-second observation separation has elapsed.
    if [[ "$prior" == "$round" ]] \
        || (( 10#$round_epoch - 10#$prior_epoch < 60 )) \
        || (( 10#$minted >= 10#$budget )); then
      keep+="${keep:+$'\n'}orphanv1|$fingerprint|$kind|$target_b64|$token|$pid|$start|$prior"
      continue
    fi
    limits=$(attach_reap_limits) || return 2
    IFS='|' read -r max _deliveries < <(printf '%s\n' "$limits")
    payload_rc=0
    payload=$(_attach_reap_tree_payload "$snapshot" "$pid" "$max") || payload_rc=$?
    if [[ "$payload_rc" != 0 ]]; then
      _alert_cmux_cleanup "cmux helper orphan reap deferred" \
        "An exact orphan attach helper could not enter the bounded reap state machine: pid=$pid kind=$kind target=$target tree_rc=$payload_rc." \
        "cmux_cleanup|attach-orphan-reap-deferred|pid=$pid|start=$start|kind=$kind|target=$target_b64|rc=$payload_rc"
      keep+="${keep:+$'\n'}orphanv1|$fingerprint|$kind|$target_b64|$token|$pid|$start|$prior"
      continue
    fi
    now=$(date +%s) || return 2
    tree=$(_cmux_alert_hash "$fingerprint|$pid|$payload")
    row=$(_attach_reap_row "$tree" "$kind" "$target_b64" "$token" term-issued \
      "$now" "$now" 0 0 - - "$pid" "$payload")
    if _attach_reap_state_upsert "$tree" "$row"; then
      minted=$((minted + 1))
    else
      return 2
    fi
  done < <(printf '%s\n' "$helpers")
  [[ -z "$keep" ]] || keep+=$'\n'
  _attach_orphan_state_replace "$keep" || return 2
  CMUX_HELPER_DISCOVERY_CONCLUSIVE=1
  return 0
}

_v2_lead_roster_row_current() {
  local title="$1" socket="$2" count
  derive_lead_roster || return 1
  [[ "$LEAD_ROSTER_STATE" == "ok" ]] || return 1
  count=$(printf '%s\n' "$LEAD_ROSTER_ROWS" | awk -F'|' \
    -v t="$title" -v s="$socket" \
    '$1 == "claude-private" && $3 == t && $4 == s { n++ } END { print n+0 }')
  [[ "$count" == "1" ]]
}

_GUARD_V2_GENERATION=""
_GUARD_V2_TITLE=""
_GUARD_V2_SOCKET=""
_GUARD_V2_RAW=""
_GUARD_V2_REF=""
_GUARD_V2_REQUIRE_ABSENT=0
_v2_lead_workspace_guard() {
  local current raw candidates workspace surface
  current=$(cmux_socket_identity) || return 1
  [[ -n "$current" && "$current" == "$_GUARD_V2_GENERATION" ]] || return 1
  _v2_lead_roster_row_current "$_GUARD_V2_TITLE" "$_GUARD_V2_SOCKET" || return 1
  if [[ "$_GUARD_V2_REQUIRE_ABSENT" == "1" ]]; then
    raw=$(get_cmux_workspaces_json) || return 1
    candidates=$(workspace_title_candidates "$raw" "$_GUARD_V2_TITLE" "$_GUARD_V2_RAW") || return 1
    [[ -z "$candidates" ]] || return 1
  else
    workspace=$(workspace_title_for_ref "$_GUARD_V2_REF") || return 1
    surface=$(workspace_single_surface_title "$_GUARD_V2_REF") || return 1
    [[ "$workspace" == "$_GUARD_V2_TITLE" ]] \
      || _managed_view_command_in_variants "$workspace" "$_GUARD_V2_RAW" || return 1
    [[ "$surface" == "$_GUARD_V2_TITLE" ]] \
      || _managed_view_command_in_variants "$surface" "$_GUARD_V2_RAW" || return 1
  fi
  current=$(cmux_socket_identity) || return 1
  [[ "$current" == "$_GUARD_V2_GENERATION" ]]
}

_v2_lead_prepare_and_name() {
  local generation="$1" ref="$2" title="$3" socket="$4" canonical="$5"
  local workspace_uuid="${6:-}" state receipt_uuid workspace surface rc=0 legacy_upgrade=0 birth_proven=0
  local birth _birth_ref _birth_uuid _birth_title _birth_surface birth_kind birth_target _birth_token expected_target
  if [[ -n "$workspace_uuid" ]]; then
    _workspace_uuid_valid "$workspace_uuid" || return 1
    birth=$(cmux_workspace_birth_record "$ref" "$workspace_uuid") || return 1
  else
    birth=$(cmux_workspace_birth_record "$ref" 2>/dev/null || true)
    if [[ -n "$birth" ]]; then
      workspace_uuid=$(printf '%s\n' "$birth" | awk -F'|' 'NF==7 {print $2; exit}')
      _workspace_uuid_valid "$workspace_uuid" || return 1
    fi
  fi
  if [[ -n "$birth" ]]; then
    IFS='|' read -r _birth_ref _birth_uuid _birth_title _birth_surface \
      birth_kind birth_target _birth_token < <(printf '%s\n' "$birth")
    expected_target=$(printf '%s' "$socket" | base64 | tr -d '\n') || return 1
    [[ "$_birth_ref" == "$ref" && "$_birth_uuid" == "$workspace_uuid" \
        && "$birth_kind" == lead && "$birth_target" == "$expected_target" ]] || return 1
    birth_proven=1
  fi
  state=$(ledger_candidate_receipt_state "$generation" "$ref" "$title") || return 1
  case "$state" in
    none)
      if [[ "$birth_proven" == 1 ]]; then
        _ledger_upsert prepared "$generation" "$ref" "$title" "$workspace_uuid" || return 1
      else
        _ledger_upsert prepared "$generation" "$ref" "$title" || return 1
      fi
      ;;
    prepared)
      receipt_uuid=$(ledger_exact_receipt_uuid "$generation" "$ref" "$title") || return 1
      if [[ "$birth_proven" == 1 && "$receipt_uuid" != __LEGACY__ ]]; then
        [[ "$receipt_uuid" == "$workspace_uuid" ]] || return 1
      fi
      ;;
    committed)
      receipt_uuid=$(ledger_exact_receipt_uuid "$generation" "$ref" "$title") || return 1
      if [[ "$birth_proven" == 1 ]]; then
        if [[ "$receipt_uuid" == __LEGACY__ ]]; then
          legacy_upgrade=1
        else
          [[ "$receipt_uuid" == "$workspace_uuid" ]] || return 1
        fi
      fi
      ;;
    *) return 1 ;;
  esac

  workspace=$(workspace_title_for_ref "$ref") || return 1
  surface=$(workspace_single_surface_title "$ref") || return 1
  if [[ "$state" == committed && "$workspace" == "$title" && -n "$surface" ]]; then
    if [[ "$birth_proven" == 1 ]]; then
      workspace_identity_matches "$ref" "$title" "$workspace_uuid" || return 1
    fi
    [[ "$(cmux_socket_identity)" == "$generation" ]] || return 1
    if [[ "$legacy_upgrade" == 1 ]]; then
      _ledger_upgrade_legacy_uuid "$generation" "$ref" "$title" "$workspace_uuid" || return 1
    fi
    return 0
  fi
  if _managed_view_command_in_variants "$workspace" "$canonical" \
      || _managed_view_command_in_variants "$surface" "$canonical"; then
    _GUARD_V2_GENERATION="$generation"
    _GUARD_V2_TITLE="$title"
    _GUARD_V2_SOCKET="$socket"
    _GUARD_V2_RAW="$canonical"
    _GUARD_V2_REF="$ref"
    _GUARD_V2_REQUIRE_ABSENT=0
    cmux_call_guarded _v2_lead_workspace_guard \
      rename-workspace --workspace "$ref" "$title" || rc=$?
    [[ "$rc" -eq 0 && "$GUARD_WAS_BLOCKED" != "1" ]] || return 1
    cmux_call_guarded _v2_lead_workspace_guard \
      rename-tab --workspace "$ref" "$title" || rc=$?
    [[ "$rc" -eq 0 && "$GUARD_WAS_BLOCKED" != "1" ]] || return 1
  fi
  [[ "$(workspace_title_for_ref "$ref")" == "$title" ]] || return 1
  [[ "$(workspace_single_surface_title "$ref")" == "$title" ]] || return 1
  if [[ "$birth_proven" == 1 ]]; then
    workspace_identity_matches "$ref" "$title" "$workspace_uuid" || return 1
  fi
  [[ "$(cmux_socket_identity)" == "$generation" ]] || return 1
  if [[ "$legacy_upgrade" == 1 ]]; then
    _ledger_upgrade_legacy_uuid "$generation" "$ref" "$title" "$workspace_uuid"
  elif [[ "$birth_proven" == 1 ]]; then
    _ledger_upsert committed "$generation" "$ref" "$title" "$workspace_uuid"
  elif [[ "$state" == committed ]]; then
    return 0
  elif [[ "${receipt_uuid:-__LEGACY__}" != __LEGACY__ ]]; then
    _ledger_upsert committed "$generation" "$ref" "$title" "$receipt_uuid"
  else
    _ledger_upsert committed "$generation" "$ref" "$title"
  fi
}

_v2_lead_heal_surface() {
  local generation="$1" ref="$2" title="$3" socket="$4" canonical="$5"
  local surface shell_rc=0 clients classification recovery_rc=0 attach_token target_b64 heal_command="$canonical"
  surface=$(workspace_terminal_surface_ref "$ref") || return 0
  [[ -n "$surface" ]] || return 0
  if ! tmux -S "$socket" has-session -t '=main' >/dev/null 2>&1; then
    recover_attach_surface v2 "$generation" "$ref" "$title" "$surface" \
      "$canonical" "$socket" missing || true
    return 0
  fi
  clients=$(_private_session_client_count "$socket") || return 0
  if [[ "$clients" -gt 0 ]]; then
    recover_attach_surface v2 "$generation" "$ref" "$title" "$surface" \
      "$canonical" "$socket" healthy || true
    return 0
  fi
  surface_looks_like_bare_shell "$ref" "$surface" 0 || shell_rc=$?
  case "$shell_rc:$SURFACE_LAST_SCREEN" in
    0:*) classification=bare ;;
    1:*) classification=$(classify_dead_view_screen "$SURFACE_LAST_SCREEN") ;;
    *) classification=unclassified ;;
  esac
  if [[ "$classification" == bare ]]; then
    target_b64=$(printf '%s' "$socket" | base64 | tr -d '\n') || return 1
    attach_token=$(workspace_birth_attach_token "$ref" lead "$target_b64" 2>/dev/null || true)
    [[ -n "$attach_token" ]] || attach_token=$(new_managed_attach_token) || return 1
    heal_command=$(build_lead_attach_command "$socket" "$attach_token") || return 1
  fi
  recover_attach_surface v2 "$generation" "$ref" "$title" "$surface" \
    "$heal_command" "$socket" "$classification" || recovery_rc=$?
  [[ "$recovery_rc" == 0 || "$recovery_rc" == 2 ]]
}

_GUARD_V2_KEEPER_REF=""
_GUARD_V2_LOSER_REF=""
_GUARD_V2_TARGET_B64=""
_GUARD_V2_FLIP_GENERATION=""
_GUARD_V2_FLIP_KEEPER_REF=""
_GUARD_V2_FLIP_LOSER_REF=""
_GUARD_V2_FLIP_TITLE=""
_GUARD_V2_FLIP_SOCKET=""
_GUARD_V2_FLIP_TARGET_B64=""
_GUARD_V2_BIRTHS=""
V2_LEAD_PROMOTED_REF=""
_v2_lead_flip_close_guard() {
  local current keeper_liveness loser_liveness
  current=$(cmux_socket_identity) || return 1
  [[ "$current" == "$_GUARD_V2_FLIP_GENERATION" ]] || return 1
  _v2_lead_roster_row_current "$_GUARD_V2_FLIP_TITLE" \
    "$_GUARD_V2_FLIP_SOCKET" || return 1
  [[ "$(ledger_candidate_receipt_state "$current" \
    "$_GUARD_V2_FLIP_KEEPER_REF" "$_GUARD_V2_FLIP_TITLE")" == committed ]] || return 1
  [[ "$(ledger_candidate_receipt_state "$current" \
    "$_GUARD_V2_FLIP_LOSER_REF" "$_GUARD_V2_FLIP_TITLE")" == none ]] || return 1
  keeper_liveness=$(workspace_attach_liveness "$_GUARD_V2_FLIP_KEEPER_REF" lead \
    "$_GUARD_V2_FLIP_TARGET_B64" "$_GUARD_V2_BIRTHS") || return 1
  loser_liveness=$(workspace_attach_liveness "$_GUARD_V2_FLIP_LOSER_REF" lead \
    "$_GUARD_V2_FLIP_TARGET_B64" "$_GUARD_V2_BIRTHS") || return 1
  [[ "$keeper_liveness" == dead && "$loser_liveness" == live ]] || return 1
  current=$(cmux_socket_identity) || return 1
  [[ "$current" == "$_GUARD_V2_FLIP_GENERATION" ]]
}

_v2_lead_promote_live_duplicate() {
  local generation="$1" keeper_ref="$2" title="$3" socket="$4" loser_ref="$5" target_b64="$6" births="${7:-}"
  : "$generation" "$socket" "$target_b64" "$births"
  _alert_cmux_cleanup "cmux v2 Lead duplicate preserved (report-only)" \
    "A single render sample classified the committed keeper dead and a sibling live. Automatic close/promotion is disabled until a distinct-round activity proof exists: title=$title keeper=$keeper_ref sibling=$loser_ref." \
    "cmux_cleanup|v2-duplicate-report-only|title=$title|keeper=$keeper_ref|sibling=$loser_ref"
  return 1
}

_v2_lead_duplicate_close_guard() {
  local current keeper_title keeper_liveness loser_liveness
  current=$(cmux_socket_identity) || return 1
  [[ -n "$current" && "$current" == "$_GUARD_V2_GENERATION" ]] || return 1
  _v2_lead_roster_row_current "$_GUARD_V2_TITLE" "$_GUARD_V2_SOCKET" || return 1
  [[ "$(ledger_candidate_receipt_state "$current" \
    "$_GUARD_V2_KEEPER_REF" "$_GUARD_V2_TITLE")" == "committed" ]] || return 1
  [[ "$(ledger_candidate_receipt_state "$current" \
    "$_GUARD_V2_LOSER_REF" "$_GUARD_V2_TITLE")" == "none" ]] || return 1
  tmux -S "$_GUARD_V2_SOCKET" has-session -t '=main' >/dev/null 2>&1 || return 1
  keeper_title=$(workspace_title_for_ref "$_GUARD_V2_KEEPER_REF") || return 1
  [[ "$keeper_title" == "$_GUARD_V2_TITLE" ]] || return 1
  keeper_liveness=$(workspace_attach_liveness "$_GUARD_V2_KEEPER_REF" lead "$_GUARD_V2_TARGET_B64" "$_GUARD_V2_BIRTHS") || return 1
  loser_liveness=$(workspace_attach_liveness "$_GUARD_V2_LOSER_REF" lead "$_GUARD_V2_TARGET_B64" "$_GUARD_V2_BIRTHS") || return 1
  [[ "$keeper_liveness" == live && "$loser_liveness" == dead ]] || return 1
  current=$(cmux_socket_identity) || return 1
  [[ "$current" == "$_GUARD_V2_GENERATION" ]]
}

_v2_lead_cleanup_duplicates() {
  local generation="$1" keeper_ref="$2" title="$3" socket="$4" canonical="$5"
  local raw candidates births birth_candidates target_b64 kind loser_ref _pinned _selected _number keeper_liveness loser_liveness
  raw=$(get_cmux_workspaces_json) || return 1
  candidates=$(workspace_title_candidates "$raw" "$title" "$canonical") || return 1
  births=$(cmux_attach_birth_records "$raw" 2>/dev/null || true)
  target_b64=$(printf '%s' "$socket" | base64 | tr -d '\n') || return 1
  birth_candidates=$(workspace_birth_candidate_rows "$raw" "$births" lead "$target_b64" "$candidates") || return 1
  candidates+="${birth_candidates:+${candidates:+$'\n'}${birth_candidates}}"
  _GUARD_V2_BIRTHS="$births"
  V2_LEAD_PROMOTED_REF=""
  while IFS='|' read -r kind loser_ref _pinned _selected _number; do
    [[ "$kind" == raw || "$kind" == birth ]] || continue
    [[ -n "$loser_ref" && "$loser_ref" != "$keeper_ref" ]] || continue
    keeper_liveness=$(workspace_attach_liveness "$keeper_ref" lead "$target_b64" "$births")
    loser_liveness=$(workspace_attach_liveness "$loser_ref" lead "$target_b64" "$births")
    if [[ "$keeper_liveness" == dead && "$loser_liveness" == live ]]; then
      _v2_lead_promote_live_duplicate "$generation" "$keeper_ref" "$title" \
        "$socket" "$loser_ref" "$target_b64" "$births" || true
      continue
    fi
    if [[ "$keeper_liveness" != live || "$loser_liveness" != dead ]]; then
      log "WARN: duplicate v2 Lead preserved pending liveness title=$title keeper=$keeper_ref:$keeper_liveness loser=$loser_ref:$loser_liveness"
      continue
    fi
    _alert_cmux_cleanup "cmux v2 Lead duplicate preserved (report-only)" \
      "A single render sample classified a sibling dead. Automatic duplicate close is disabled until a distinct-round activity proof exists: title=$title keeper=$keeper_ref sibling=$loser_ref." \
      "cmux_cleanup|v2-duplicate-report-only|title=$title|keeper=$keeper_ref|sibling=$loser_ref"
  done < <(printf '%s\n' "$candidates")
  return 0
}

_GUARD_V2_BIRTH_RECORD=""
_GUARD_V2_BIRTH_UUID=""
_v2_lead_birth_guard() {
  local current receipt receipt_uuid observed
  current=$(cmux_socket_identity) || return 1
  [[ "$current" == "$_GUARD_V2_GENERATION" ]] || return 1
  _v2_lead_roster_row_current "$_GUARD_V2_TITLE" "$_GUARD_V2_SOCKET" || return 1
  receipt=$(ledger_exact_receipt_state "$current" "$_GUARD_V2_REF" \
    "$_GUARD_V2_TITLE" 2>/dev/null) || return 1
  case "$receipt" in prepared|committed) ;; *) return 1 ;; esac
  receipt_uuid=$(ledger_exact_receipt_uuid "$current" "$_GUARD_V2_REF" \
    "$_GUARD_V2_TITLE") || return 1
  [[ "$receipt_uuid" == "$_GUARD_V2_BIRTH_UUID" ]] || return 1
  observed=$(cmux_workspace_birth_record "$_GUARD_V2_REF" "$_GUARD_V2_BIRTH_UUID") || return 1
  [[ "$observed" == "$_GUARD_V2_BIRTH_RECORD" ]] || return 1
  current=$(cmux_socket_identity) || return 1
  [[ "$current" == "$_GUARD_V2_GENERATION" ]]
}

_v2_lead_adopt_birth() {
  local generation="$1" ref="$2" title="$3" socket="$4"
  local birth uuid title_b64 _surface kind target_b64 _token expected_target state workspace surface rc=0
  expected_target=$(printf '%s' "$socket" | base64 | tr -d '\n') || return 1
  birth=$(cmux_workspace_birth_record "$ref") || return 1
  IFS='|' read -r _ uuid title_b64 _surface kind target_b64 _token < <(printf '%s\n' "$birth")
  [[ "$kind" == lead && "$target_b64" == "$expected_target" ]] || return 1
  state=$(ledger_candidate_receipt_state "$generation" "$ref" "$title") || return 1
  cmux_adoption_slot_claim || {
    log "WARN: v2 Lead birth adoption deferred by per-pass cap title=$title ref=$ref"
    return 3
  }
  case "$state" in
    none) _ledger_upsert prepared "$generation" "$ref" "$title" "$uuid" || return 1 ;;
    prepared) [[ "$(ledger_exact_receipt_uuid "$generation" "$ref" "$title" 2>/dev/null || true)" == "$uuid" ]] || return 1 ;;
    committed) [[ "$(ledger_exact_receipt_uuid "$generation" "$ref" "$title" 2>/dev/null || true)" == "$uuid" ]] || return 1 ;;
    *) return 1 ;;
  esac
  _GUARD_V2_GENERATION="$generation"; _GUARD_V2_REF="$ref"
  _GUARD_V2_TITLE="$title"; _GUARD_V2_SOCKET="$socket"
  _GUARD_V2_BIRTH_UUID="$uuid"; _GUARD_V2_BIRTH_RECORD="$birth"
  workspace=$(workspace_title_for_ref "$ref") || return 1
  if [[ "$workspace" != "$title" ]]; then
    cmux_call_guarded _v2_lead_birth_guard rename-workspace --workspace "$ref" "$title" || rc=$?
    [[ "$rc" == 0 && "$GUARD_WAS_BLOCKED" != 1 ]] || return 1
  fi
  birth=$(cmux_workspace_birth_record "$ref" "$uuid") || return 1
  IFS='|' read -r _ _ title_b64 _ kind target_b64 _token < <(printf '%s\n' "$birth")
  [[ "$kind" == lead && "$target_b64" == "$expected_target" \
      && "$(_attach_b64_decode "$title_b64")" == "$title" ]] || return 1
  _GUARD_V2_BIRTH_RECORD="$birth"
  surface=$(workspace_single_surface_title "$ref") || return 1
  if [[ "$surface" != "$title" ]]; then
    rc=0
    cmux_call_guarded _v2_lead_birth_guard rename-tab --workspace "$ref" "$title" || rc=$?
    [[ "$rc" == 0 && "$GUARD_WAS_BLOCKED" != 1 ]] || return 1
  fi
  [[ "$(workspace_title_for_ref "$ref")" == "$title" \
      && "$(workspace_single_surface_title "$ref")" == "$title" ]] || return 1
  _ledger_upsert committed "$generation" "$ref" "$title" "$uuid"
}

ensure_v2_lead_workspace() {
  local title="$1" socket="$2" generation raw canonical create_command attach_token candidates count keeper kind ref state observed_record
  local births birth_candidates target_b64 birth_owned adoption_rc adoption_count_before
  local before_refs after_refs new_refs create_rc=0
  canonical=$(build_lead_attach_command "$socket") || return 1
  generation=$(cmux_socket_identity) || return 1
  [[ -n "$generation" ]] || return 1
  raw=$(get_cmux_workspaces_json) || return 1
  candidates=$(workspace_title_candidates "$raw" "$title" "$canonical") || return 1
  births=$(cmux_attach_birth_records "$raw" 2>/dev/null || true)
  target_b64=$(printf '%s' "$socket" | base64 | tr -d '\n') || return 1
  birth_candidates=$(workspace_birth_candidate_rows "$raw" "$births" lead "$target_b64" "$candidates") || return 1
  candidates+="${birth_candidates:+${candidates:+$'\n'}${birth_candidates}}"
  count=$(printf '%s\n' "$candidates" | grep -c . || true)
  if (( count > 0 )); then
    keeper=$(select_title_keeper "$generation" "$title" "$candidates") || return 1
    IFS='|' read -r kind ref < <(printf '%s\n' "$keeper")
    state=$(ledger_candidate_receipt_state "$generation" "$ref" "$title") || return 1
    birth_owned=0
    if printf '%s\n' "$births" | awk -F'|' -v r="$ref" -v t="$target_b64" \
        '$1==r && $5=="lead" && $6==t {found=1} END {exit(found?0:1)}'; then
      birth_owned=1
    fi
    # A named, unreceipted row may be a founder workspace. Exact raw helper
    # syntax is the only stock form strong enough to mint ownership.
    if [[ "$kind" == "named" && "$state" == "none" && "$birth_owned" != 1 ]]; then
      log "WARN: unreceipted same-title workspace preserved for v2 Lead $title"
      return 0
    fi
    if [[ "$birth_owned" == 1 && ( "$state" == none || "$state" == prepared || "$kind" == birth ) ]]; then
      adoption_count_before="$CMUX_ADOPTION_COUNT"
      adoption_rc=0
      _v2_lead_adopt_birth "$generation" "$ref" "$title" "$socket" || adoption_rc=$?
      if [[ "$adoption_rc" == 3 ]]; then
        # The rollout valve controls authority mutation, not availability.
        # Existing surfaces remain eligible for exact-ref repair while their
        # birth adoption waits for a later pass.
        _v2_lead_heal_surface "$generation" "$ref" "$title" "$socket" "$canonical" || return 1
        return 0
      fi
      if [[ "$adoption_rc" != 0 ]]; then
        # A failed attempt must not consume the whole fleet budget forever.
        # Any partially persisted receipt remains fail-closed and retryable.
        CMUX_ADOPTION_COUNT="$adoption_count_before"
        return 1
      fi
      canonical=$(build_lead_attach_command "$socket") || return 1
    fi
    if [[ "$kind" == raw ]]; then
      canonical=$(workspace_title_for_ref "$ref") || return 1
      observed_record=$(managed_view_command_parse "$canonical" record 2>/dev/null) || return 1
      [[ "${observed_record%|*}" == "lead|$socket" ]] || return 1
    fi
    _v2_lead_prepare_and_name "$generation" "$ref" "$title" "$socket" "$canonical" || return 1
    _v2_lead_cleanup_duplicates "$generation" "$ref" "$title" "$socket" "$canonical" || true
    [[ -z "$V2_LEAD_PROMOTED_REF" ]] || ref="$V2_LEAD_PROMOTED_REF"
    _v2_lead_heal_surface "$generation" "$ref" "$title" "$socket" "$canonical" || return 1
    return 0
  fi

  before_refs=$(printf '%s' "$raw" | python3 -c '
import json,sys
for w in json.load(sys.stdin).get("workspaces", []):
    ref=w.get("ref", "")
    if ref: print(ref)
' | sort) || return 1
  attach_token=$(new_managed_attach_token) || return 1
  create_command=$(build_lead_attach_command "$socket" "$attach_token") || return 1
  _GUARD_V2_GENERATION="$generation"
  _GUARD_V2_TITLE="$title"
  _GUARD_V2_SOCKET="$socket"
  _GUARD_V2_RAW="$create_command"
  _GUARD_V2_REF=""
  _GUARD_V2_REQUIRE_ABSENT=1
  cmux_call_guarded _v2_lead_workspace_guard \
    new-workspace --command "$create_command" || create_rc=$?
  [[ "$create_rc" -eq 0 && "$GUARD_WAS_BLOCKED" != "1" ]] || return 1
  raw=$(get_cmux_workspaces_json) || return 1
  [[ "$(cmux_socket_identity)" == "$generation" ]] || return 1
  after_refs=$(printf '%s' "$raw" | python3 -c '
import json,sys
for w in json.load(sys.stdin).get("workspaces", []):
    ref=w.get("ref", "")
    if ref: print(ref)
' | sort) || return 1
  new_refs=$(grep -vFxf <(printf '%s\n' "$before_refs") <(printf '%s\n' "$after_refs") || true)
  [[ "$(printf '%s\n' "$new_refs" | grep -c . || true)" == "1" ]] || return 1
  ref=$(printf '%s\n' "$new_refs" | head -1)
  [[ "$ref" =~ ^workspace:[0-9]+$ ]] || return 1
  _v2_lead_prepare_and_name "$generation" "$ref" "$title" "$socket" "$create_command" || return 1
  _v2_lead_cleanup_duplicates "$generation" "$ref" "$title" "$socket" "$create_command" || true
  [[ -z "$V2_LEAD_PROMOTED_REF" ]] || ref="$V2_LEAD_PROMOTED_REF"
  _v2_lead_heal_surface "$generation" "$ref" "$title" "$socket" "$create_command" || return 1
}

reconcile_v2_lead_workspaces() {
  local carrier _label title socket count previous streak retry_limit threshold
  local expected=0 attached=0 current="" missing="" next_streaks="" alert_subjects=""
  [[ "$LEAD_ROSTER_STATE" == "ok" ]] || return 0

  retry_limit=$(_attach_retry_limit)
  threshold=$((10#$retry_limit + 1))
  while IFS='|' read -r carrier _label title socket; do
    [[ "$carrier" == "claude-private" ]] || continue
    expected=$((expected + 1))
    current+="${current:+$'\n'}${title}"
    count=$(_private_session_client_count "$socket") || count=""
    if [[ "$count" =~ ^[1-9][0-9]*$ ]]; then
      attached=$((attached + 1))
      roster_mark_healthy lead-attach-missing "$title"
      continue
    fi
    missing+="${missing:+,}${title}"
    previous=$(printf '%s\n' "$V2_LEAD_ATTACH_MISSING_STREAKS" \
      | awk -F'|' -v subject="$title" '$1 == subject { print $2; exit }' || true)
    case "$previous" in ''|*[!0-9]*) previous=0 ;; esac
    if (( 10#$previous < threshold )); then
      streak=$((10#$previous + 1))
    else
      streak=$threshold
    fi
    next_streaks+="${next_streaks:+$'\n'}${title}|${streak}"
    if (( streak >= threshold )); then
      alert_subjects+="${alert_subjects:+$'\n'}${title}"
    fi
  done < <(printf '%s\n' "$LEAD_ROSTER_ROWS")
  V2_LEAD_ATTACH_MISSING_STREAKS="$next_streaks"
  roster_rearm_absent_subjects lead-attach-missing "$current"
  [[ -n "$missing" ]] || missing=none
  log "INFO: lead-attach census expected=$expected attached=$attached missing=$missing"
  while IFS= read -r title; do
    [[ -n "$title" ]] || continue
    roster_alert_unhealthy lead-attach-missing "$title" \
      "cmux v2 Lead surface detached" \
      "The v2 Lead pane is not attached to a live private tmux server: expected=$expected attached=$attached missing=$missing."
  done < <(printf '%s\n' "$alert_subjects")

  while IFS='|' read -r carrier _label title socket; do
    [[ "$carrier" == "claude-private" ]] || continue
    watcher_mutation_latch_clear || return 0
    ensure_v2_lead_workspace "$title" "$socket" \
      || log "WARN: v2 Lead workspace reconcile deferred title=$title"
  done < <(printf '%s\n' "$LEAD_ROSTER_ROWS")
  return 0
}

# Ref-scoped self-heal primitive. Heals ONE known cmux workspace ref. Used by
# verify-at-create with the freshly-created new_ref (works BEFORE rename, since
# it doesn't resolve by title) and by self_heal_one_workspace per resolved ref.
# Returns: 0 = send attempted (best-effort; cmux send failure is not an error)
#          1 = skip (no attach-intent surface / cmux/JSON / tmux uncertainty)
#          2 = a client appeared (attached) — caller should stop sending
self_heal_workspace_ref() {
  local wname="$1" ref="$2" expected_generation="${3:-}"
  local view_session="${VIEW_PREFIX}${wname}"
  local attach_cmd attach_token classification recovery_rc=0
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
  local target_b64
  target_b64=$(printf '%s' "$view_session" | base64 | tr -d '\n') || return 1
  attach_token=$(workspace_birth_attach_token "$ref" view "$target_b64" 2>/dev/null || true)
  [[ -n "$attach_token" ]] || attach_token=$(new_managed_attach_token) || return 1
  attach_cmd=$(build_attach_command "$view_session" "$attach_token") || return 1
  if [[ "$clients" -gt 0 ]]; then
    recover_attach_surface view "$expected_generation" "$ref" "$wname" "$surface_ref" \
      "$attach_cmd" "$view_session" healthy || true
    return 2
  fi
  # SAFETY GATE 2 — POSITIVELY confirm the surface is a BARE SHELL before
  # typing. rc=1 (positively not a shell) fails closed; rc=2 (surface not
  # readable/rendered) fails closed UNLESS this is an escalated sweep, where
  # it is the "needs forced render" signal (FLY-254). Quiet probe under
  # escalation — the storm of per-retry WARNs is replaced by one summary.
  local shell_rc=0
  surface_looks_like_bare_shell "$ref" "$surface_ref" "${HEAL_RENDER_ESCALATE:-0}" || shell_rc=$?
  if [[ $shell_rc -eq 2 && "${HEAL_RENDER_ESCALATE:-0}" == "1" ]]; then
    local esc_rc=0
    self_heal_render_escalate "$wname" "$ref" "$expected_generation" || esc_rc=$?
    [[ "$esc_rc" -eq 1 ]] || return "$esc_rc"
  fi
  case "$shell_rc:$SURFACE_LAST_SCREEN" in
    0:*) classification=bare ;;
    1:*) classification=$(classify_dead_view_screen "$SURFACE_LAST_SCREEN") ;;
    *) classification=unclassified ;;
  esac
  [[ "$classification" != bare ]] \
    || heal_state_log_once "$wname" "Self-heal: re-attaching '$wname' (0 clients on $view_session, ws $ref surface $surface_ref)"
  recover_attach_surface view "$expected_generation" "$ref" "$wname" "$surface_ref" \
    "$attach_cmd" "$view_session" "$classification" || recovery_rc=$?
  return "$recovery_rc"
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

# FLY-254 reopen recovery is now canonical.
reopen_sweep_enabled() {
  return 0
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
  done < <(printf '%s\n' "$tmux_windows")
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
  local wname="$1" ref="$2" expected_generation="${3:-}"
  local view_session="${VIEW_PREFIX}${wname}"
  [[ "${HEAL_FOCUS_SNAPSHOT_OK:-0}" == "1" ]] || return 1
  [[ "${HEAL_USER_INTERVENED:-0}" == "1" ]] && return 1
  [[ "${HEAL_GEN_CHANGED:-0}" == "1" ]] && return 1
  # Malformed refs must never be fed to a focus mutation (REF_RE caution,
  # matching the current exact-ref workspace set).
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
        # ⑤ recover_attach_surface performs the final 0-client re-check inside
        #    its guarded mutation. rc=2 means a client appeared; rc=1 fails
        #    closed.
        local render_attach_cmd render_attach_token render_target_b64
        render_target_b64=$(printf '%s' "$view_session" | base64 | tr -d '\n') || return 1
        render_attach_token=$(workspace_birth_attach_token "$ref" view \
          "$render_target_b64" 2>/dev/null || true)
        [[ -n "$render_attach_token" ]] \
          || render_attach_token=$(new_managed_attach_token) || return 1
        render_attach_cmd=$(build_attach_command "$view_session" "$render_attach_token") || return 1
        heal_state_log_once "$wname" "Self-heal: re-attaching '$wname' (0 clients on $view_session, ws $ref surface $surface_ref)"
        send_rc=0
        recover_attach_surface view "$expected_generation" "$ref" "$wname" "$surface_ref" \
          "$render_attach_cmd" "$view_session" bare || send_rc=$?
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
  local src_sess wid w_name live_id=""
  while IFS='|' read -r src_sess wid w_name; do
    [[ "$w_name" != "$wname" ]] && continue
    window_source_pane_alive "$src_sess" "$wid" \
      && live_id="$wid"   # highest-index live wins (last assignment)
  done < <(get_tmux_agent_windows)
  [[ -z "$live_id" ]] && return 1
  tmux select-window -t "=${view_session}:${live_id}" 2>/dev/null || true
  return 0
}

# Heal one window by name: resolve all matching workspace refs (title), then
# heal each via the ref-scoped primitive. Attach-only — the "workspace exists
# but linked session is dead" case is reconcile_existing_workspaces' job.
self_heal_one_workspace() {
  local wname="$1" receipt_generation=""
  local view_session="${VIEW_PREFIX}${wname}"
  # Every strict-view heal is exact-ref authorized, regardless of whether this
  # title was discovered from a live source window or a sole-holder view. The
  # source-discovery distinction is topology, not workspace ownership.
  # Mutation path uses workspace_refs_for with rc=2 handling (NOT
  # get_workspace_ref_for, which is unsafe as a mutation gate).
  local refs rc=0
  refs=$(workspace_refs_for "$wname") || rc=$?
  [[ $rc -eq 2 ]] && return 0          # JSON unavailable → skip (event-time tradeoff)
  [[ -z "$refs" ]] && return 0
  receipt_generation=$(cmux_socket_identity)
  [[ -n "$receipt_generation" ]] || return 0

  if ! linked_session_exists "$view_session"; then
    local missing_ref missing_surface missing_command
    missing_command=$(build_attach_command "$view_session") || return 0
    while IFS= read -r missing_ref; do
      [[ -n "$missing_ref" ]] || continue
      ledger_committed_ref "$receipt_generation" "$missing_ref" "$wname" || continue
      missing_surface=$(workspace_terminal_surface_ref "$missing_ref") || continue
      recover_attach_surface view "$receipt_generation" "$missing_ref" "$wname" "$missing_surface" \
        "$missing_command" "$view_session" missing || true
    done < <(printf '%s\n' "$refs")
    return 0
  fi
  # A receipt proves the cmux workspace, not the tmux destination. Re-prove
  # that the canonical name still resolves to the exact live Flywheel view
  # before injecting an attach command into its detached surface.
  _view_shell_owned_for_title "$view_session" "$wname" 0 1 1 || return 0

  # STATE: only "tmux succeeded AND count==0" = detached. Per view_session
  # (shared by all dup workspaces for this window name).
  local clients
  clients=$(view_session_client_count "$view_session") || return 0   # tmux error → fail-closed
  if [[ "$clients" -gt 0 ]]; then
    local healthy_ref healthy_surface healthy_command
    healthy_command=$(build_attach_command "$view_session") || return 0
    while IFS= read -r healthy_ref; do
      [[ -n "$healthy_ref" ]] || continue
      ledger_committed_ref "$receipt_generation" "$healthy_ref" "$wname" || continue
      healthy_surface=$(workspace_terminal_surface_ref "$healthy_ref") || continue
      recover_attach_surface view "$receipt_generation" "$healthy_ref" "$wname" "$healthy_surface" \
        "$healthy_command" "$view_session" healthy || true
    done < <(printf '%s\n' "$refs")
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
    if ! ledger_committed_ref "$receipt_generation" "$ref" "$wname"; then
      _alert_cmux_cleanup \
        "cmux attach heal refused" \
        "Periodic strict-view healing preserved an unreceipted same-title workspace: generation=$receipt_generation ref=$ref title=$wname." \
        "cmux_cleanup|self-heal|generation=$receipt_generation|ref=$ref|title=$wname|reason=missing-exact-receipt"
      continue
    fi
    hr=0
    self_heal_workspace_ref "$wname" "$ref" "$receipt_generation" || hr=$?
    case "$hr" in
      0) healed=1 ;;
      1) ;;          # normal skip (no intent / fail-closed)
      2) break ;;    # client appeared mid-loop → stop sending
      *) log "WARN: unexpected self-heal rc=$hr for $wname ref=$ref" ;;
    esac
  done < <(printf '%s\n' "$refs")

  if [[ "$healed" -eq 1 ]]; then
    # FLY-280: re-point by LIVE window_id (not =name, which could land on a stale
    # dead dup after a restart); refresh-surfaces stays unconditional here.
    select_live_view_window "$wname" "$view_session" || true
    cmux_call refresh-surfaces || true
  fi
  return 0
}

# Print titles of conclusive, Flywheel-owned strict views. These are additional
# heal anchors only when the spawning source session is already gone; ordinary
# source-window discovery remains the primary path. Every field is re-read from
# tmux so a user-created cmux-* session cannot opt itself into command injection.
strict_view_heal_titles() {
  local sessions session title snapshot sid grouped active owner marker members observed dead
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null) || return 1
  while IFS= read -r session; do
    case "$session" in "${VIEW_PREFIX}"*) ;; *) continue ;; esac
    title="${session#"${VIEW_PREFIX}"}"
    is_managed_runner_title "$title" || continue
    snapshot=$(_view_session_snapshot "$session") || continue
    IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
    case "$owner" in flywheel|runner-*) ;; *) continue ;; esac
    [[ -n "$sid" && "$grouped" == "0" && -n "$active" \
        && "$marker" == "0" && "$members" == "$active" ]] || continue
    observed=$(tmux display-message -p -t "=${session}:${active}" '#{window_name}' 2>/dev/null) || continue
    dead=$(tmux display-message -p -t "=${session}:${active}" '#{pane_dead}' 2>/dev/null) || continue
    [[ "$observed" == "$title" && "$dead" == "0" ]] || continue
    printf '%s\n' "$title"
  done < <(printf '%s\n' "$sessions")
}

# Bounded sweep of ALL agent windows plus conclusive strict sole-holder views
# (bootstrap / health-recovery / --once / FLY-254 escalated reopen consume /
# one call per 60s additive tick).
self_heal_sweep_all() {
  local tmux_windows heal_names strict_names=""
  tmux_windows=$(get_tmux_agent_windows)
  heal_names=$(printf '%s\n' "$tmux_windows" | awk -F'|' 'NF >= 3 && $3 != "" { print $3 }')
  strict_names=$(strict_view_heal_titles) || return 0
  [[ -n "$strict_names" ]] && heal_names="${heal_names}${heal_names:+$'\n'}${strict_names}"
  heal_names=$(printf '%s\n' "$heal_names" | awk 'NF && !seen[$0]++')
  [[ -z "$heal_names" ]] && return 0

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

  local wname
  while IFS= read -r wname; do
    [[ -z "$wname" ]] && continue
    self_heal_one_workspace "$wname"
  done < <(printf '%s\n' "$heal_names")

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
  done < <(printf '%s\n' "$tmux_windows")
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

# ── FLY-1272: isolated linked-view construction ──

cmux_wal_block_view() {
  local view="$1" source="$2" wid="$3" row="${1}|${2}|${3}"
  case "$row" in *$'\n'*) return 1 ;; esac
  if ! printf '%s\n' "$CMUX_WAL_BLOCKED_VIEWS" | grep -qxF "$row"; then
    CMUX_WAL_BLOCKED_VIEWS+="${CMUX_WAL_BLOCKED_VIEWS:+$'\n'}${row}"
  fi
}

cmux_wal_view_blocked() {
  local view="$1"
  [[ -n "$CMUX_WAL_BLOCKED_VIEWS" ]] || return 1
  printf '%s\n' "$CMUX_WAL_BLOCKED_VIEWS" \
    | awk -F'|' -v v="$view" '$1 == v { found=1 } END { exit(found ? 0 : 1) }'
}

cmux_wal_title_blocked() {
  cmux_wal_view_blocked "${VIEW_PREFIX}${1}"
}

cmux_wal_keeper_blocked() {
  local owner="$1" members="$2" row view source wid
  [[ -n "$CMUX_WAL_BLOCKED_VIEWS" ]] || return 1
  while IFS='|' read -r view source wid; do
    [[ -n "$view" && "$source" == "$owner" ]] || continue
    case ",$members," in *",$wid,"*) return 0 ;; esac
  done < <(printf '%s\n' "$CMUX_WAL_BLOCKED_VIEWS")
  return 1
}

tmux_server_generation() {
  if [[ -n "${FLYWHEEL_CMUX_TMUX_GENERATION:-}" ]]; then
    printf '%s\n' "$FLYWHEEL_CMUX_TMUX_GENERATION"
    return 0
  fi
  # PID alone is insufficient across reuse; socket path + server start_time is
  # stable for one server lifetime and changes after a restart. Unreadable means
  # no authority to mutate.
  local server_pid socket started
  server_pid=$(tmux display-message -p '#{pid}' 2>/dev/null) || return 1
  socket=$(tmux display-message -p '#{socket_path}' 2>/dev/null) || return 1
  [[ -n "$server_pid" && -n "$socket" ]] || return 1
  # FLY-1605: `ps lstart` renders in the caller's ambient timezone. Persisting
  # that rendering as process identity made the same live tmux server appear to
  # restart whenever the host crossed a timezone boundary. Pin both locale and
  # timezone so one process lifetime has one stable generation string.
  # Preserve the legacy persisted generation byte shape. Unlike mutator-owner
  # incarnations, this value has no separately-normalizing reader; changing its
  # trailing padding would strand an in-flight construction WAL at cutover.
  started=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$server_pid" 2>/dev/null | sed 's/^[[:space:]]*//' || true)
  [[ -n "$started" ]] || return 1
  printf '%s|%s|%s\n' "$socket" "$server_pid" "$started"
}

# Legacy generations used the same socket|pid|started shape but rendered
# `started` in the watcher's ambient timezone. When socket and pid still match,
# a differing third field is indistinguishable from PID reuse after a real
# restart. The only safe compatibility action is preserve-and-block: neither
# explanation authorizes WAL GC or recovery mutation.
tmux_generations_share_ambiguous_endpoint() {
  local old="$1" current="$2" old_endpoint current_endpoint
  case "$old" in *'|'*'|'*) ;; *) return 1 ;; esac
  case "$current" in *'|'*'|'*) ;; *) return 1 ;; esac
  old_endpoint=${old%|*}
  current_endpoint=${current%|*}
  [[ -n "$old_endpoint" && "$old_endpoint" == "$current_endpoint" && "$old" != "$current" ]]
}

_view_state_key() {
  printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
}

_view_wal_path() {
  printf '%s/%s.wal\n' "$VIEW_WAL_DIR" "$(_view_state_key "$1")"
}

_write_view_wal() {
  # v1|generation|state|nonce|view|source|window_id|stage_session_id|placeholder_id
  local path="$1" generation="$2" state="$3" nonce="$4" view="$5"
  local source="$6" wid="$7" stage_sid="$8" placeholder_id="$9" tmp
  mkdir -p "$VIEW_WAL_DIR" 2>/dev/null || return 1
  tmp=$(mktemp "${path}.XXXX" 2>/dev/null) || return 1
  if ! printf 'v1|%s|%s|%s|%s|%s|%s|%s|%s\n' \
      "$generation" "$state" "$nonce" "$view" "$source" "$wid" \
      "$stage_sid" "$placeholder_id" > "$tmp" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
  mv "$tmp" "$path" 2>/dev/null || { rm -f "$tmp" 2>/dev/null || true; return 1; }
}

_view_session_snapshot() {
  # Output: session_id|grouped|active_window_id|owner|placeholder_marker|members
  # where members is a sorted comma list. Every component must be conclusive.
  local session="$1" meta members
  meta=$(tmux display-message -p -t "=${session}:" \
    '#{session_id}|#{session_grouped}|#{window_id}|#{@flywheel_cmux_owner}|#{@flywheel_cmux_placeholder}' \
    2>/dev/null) || return 1
  members=$(tmux list-windows -t "=${session}" -F '#{window_id}' 2>/dev/null | sort | paste -sd, -) || return 1
  [[ -n "$meta" && -n "$members" ]] || return 1
  printf '%s|%s\n' "$meta" "$members"
}

# tmux mutation equivalent of cmux_call_guarded: the supplied proof is the
# genuine last operation before the tmux client is invoked. The proof binds a
# mutable canonical name to one server generation and one complete session
# snapshot, so a restarted server or a same-name/session-id replacement cannot
# inherit teardown authority observed earlier in the pass.
_GUARD_TMUX_GENERATION=""
_GUARD_TMUX_SESSION=""
_GUARD_TMUX_SNAPSHOT=""
_GUARD_TMUX_GROUP=""
_tmux_session_snapshot_guard() {
  local current observed group
  current=$(tmux_server_generation) || return 1
  [[ -n "$current" && "$current" == "$_GUARD_TMUX_GENERATION" ]] || return 1
  observed=$(_view_session_snapshot "$_GUARD_TMUX_SESSION") || return 1
  [[ "$observed" == "$_GUARD_TMUX_SNAPSHOT" ]] || return 1
  if [[ -n "${_GUARD_TMUX_GROUP:-}" ]]; then
    group=$(tmux display-message -p -t "=$_GUARD_TMUX_SESSION:" \
      '#{session_group}' 2>/dev/null) || return 1
    [[ "$group" == "$_GUARD_TMUX_GROUP" ]] || return 1
  fi
  current=$(tmux_server_generation) || return 1
  [[ -n "$current" && "$current" == "$_GUARD_TMUX_GENERATION" ]]
}

tmux_call_guarded() {
  local guard_fn="$1"
  shift
  "$guard_fn" || return 1
  tmux "$@"
}

# Normal strict-view construction binds every tmux mutation to the generation
# and exact source topology captured before the WAL was opened. Once a staging
# session exists, its complete snapshot is part of the same last-operation
# proof. This prevents a restarted server or a source-window replacement from
# inheriting an in-flight build's authority.
_GUARD_VIEW_BUILD_GENERATION=""
_GUARD_VIEW_BUILD_SOURCE=""
_GUARD_VIEW_BUILD_SOURCE_SNAPSHOT=""
_GUARD_VIEW_BUILD_WINDOW_ID=""
_GUARD_VIEW_BUILD_WINDOW_NAME=""
_GUARD_VIEW_BUILD_STAGE=""
_GUARD_VIEW_BUILD_STAGE_SNAPSHOT=""
_GUARD_VIEW_BUILD_CANONICAL_ABSENT=""
_tmux_view_build_guard() {
  local current observed source_name source_dead
  [[ "${REBIND_GUARD_ACTIVE:-0}" != 1 ]] || rebind_mutation_authority_current || return 1
  current=$(tmux_server_generation) || return 1
  [[ -n "$current" && "$current" == "$_GUARD_VIEW_BUILD_GENERATION" ]] || return 1
  observed=$(_view_session_snapshot "$_GUARD_VIEW_BUILD_SOURCE") || return 1
  [[ "$observed" == "$_GUARD_VIEW_BUILD_SOURCE_SNAPSHOT" ]] || return 1
  observed=$(tmux display-message -p \
    -t "=$_GUARD_VIEW_BUILD_SOURCE:$_GUARD_VIEW_BUILD_WINDOW_ID" \
    '#{window_name}|#{pane_dead}' 2>/dev/null) || return 1
  IFS='|' read -r source_name source_dead < <(printf '%s\n' "$observed")
  [[ "$source_name" == "$_GUARD_VIEW_BUILD_WINDOW_NAME" && "$source_dead" == "0" ]] || return 1
  if [[ -n "$_GUARD_VIEW_BUILD_STAGE" ]]; then
    observed=$(_view_session_snapshot "$_GUARD_VIEW_BUILD_STAGE") || return 1
    [[ "$observed" == "$_GUARD_VIEW_BUILD_STAGE_SNAPSHOT" ]] || return 1
  fi
  if [[ -n "$_GUARD_VIEW_BUILD_CANONICAL_ABSENT" ]]; then
    linked_session_exists "$_GUARD_VIEW_BUILD_CANONICAL_ABSENT" && return 1
  fi
  current=$(tmux_server_generation) || return 1
  [[ -n "$current" && "$current" == "$_GUARD_VIEW_BUILD_GENERATION" ]]
}

OWNED_VIEW_SNAPSHOT=""
_view_shell_owned_for_title() {
  # Independently prove the tmux shell addressed by a mutable canonical name.
  # allow_grouped=1 accepts only a legacy Flywheel/runner group; require_live=1
  # requires its sole pane to be alive. When verify_source=1 and a same-title
  # source still exists, the view must hold that exact live window object. A
  # source-less sole-holder remains valid under the FLY-1272 lifetime ruling.
  local session="$1" title="$2" allow_grouped="${3:-0}"
  local require_live="${4:-0}" verify_source="${5:-0}"
  local snapshot sid grouped active owner marker members observed current dead group
  local source_rows source_session source_wid source_title source_dead
  local saw_source=0 matched_source=0
  OWNED_VIEW_SNAPSHOT=""
  snapshot=$(_view_session_snapshot "$session") || return 1
  IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
  [[ -n "$sid" && -n "$active" ]] || return 1

  if [[ "$grouped" == "0" ]]; then
    case "$owner" in flywheel|runner-*) ;; *) return 1 ;; esac
    [[ "$marker" == "0" && "$members" == "$active" ]] || return 1
    observed=$(tmux display-message -p -t "=${session}:${active}" \
      '#{window_name}|#{pane_dead}' 2>/dev/null) || return 1
    IFS='|' read -r current dead < <(printf '%s\n' "$observed")
    [[ "$current" == "$title" ]] || return 1
    case "$dead" in 0|1) ;; *) return 1 ;; esac
    [[ "$require_live" != "1" || "$dead" == "0" ]] || return 1
  elif [[ "$allow_grouped" == "1" && "$grouped" == "1" ]]; then
    group=$(tmux display-message -p -t "=${session}:" '#{session_group}' 2>/dev/null) || return 1
    case "$group" in flywheel|runner-*) ;; *) return 1 ;; esac
    [[ -z "$owner" || "$owner" == "$group" ]] || return 1
    [[ -z "$marker" || "$marker" == "0" ]] || return 1
  else
    return 1
  fi

  if [[ "$verify_source" == "1" ]]; then
    source_rows=$(get_tmux_agent_windows) || return 1
    while IFS='|' read -r source_session source_wid source_title; do
      [[ "$source_title" == "$title" ]] || continue
      saw_source=1
      [[ "$source_wid" == "$active" ]] || continue
      source_dead=$(tmux display-message -p -t "=${source_session}:${source_wid}" \
        '#{pane_dead}' 2>/dev/null) || return 1
      [[ "$source_dead" == "0" ]] || return 1
      matched_source=1
    done < <(printf '%s\n' "$source_rows")
    [[ "$saw_source" == "0" || "$matched_source" == "1" ]] || return 1
  fi

  OWNED_VIEW_SNAPSHOT="$snapshot"
  return 0
}

_linked_view_matches() {
  local session="$1" expected_wid="$2" expected_owner="$3" expected_sid="${4:-}"
  local expected_title="${5:-}" expected_generation="${6:-}"
  local snapshot sid grouped active owner marker members observed title dead current
  if [[ -n "$expected_generation" ]]; then
    current=$(tmux_server_generation) || return 1
    [[ "$current" == "$expected_generation" ]] || return 1
  fi
  snapshot=$(_view_session_snapshot "$session") || return 1
  IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
  [[ "$grouped" == "0" && "$active" == "$expected_wid" \
     && "$owner" == "$expected_owner" && "$marker" == "0" \
     && "$members" == "$expected_wid" ]] || return 1
  [[ -z "$expected_sid" || "$sid" == "$expected_sid" ]] || return 1
  if [[ -n "$expected_title" ]]; then
    observed=$(tmux display-message -p -t "=${session}:${expected_wid}" \
      '#{window_name}|#{pane_dead}' 2>/dev/null) || return 1
    IFS='|' read -r title dead < <(printf '%s\n' "$observed")
    [[ "$title" == "$expected_title" ]] || return 1
    case "$dead" in 0|1) ;; *) return 1 ;; esac
  fi
  if [[ -n "$expected_generation" ]]; then
    current=$(tmux_server_generation) || return 1
    [[ "$current" == "$expected_generation" ]] || return 1
  fi
  OWNED_VIEW_SNAPSHOT="$snapshot"
  return 0
}

_new_view_nonce() {
  if [[ -n "${FLYWHEEL_CMUX_TEST_NONCE:-}" ]]; then
    printf '%s\n' "$FLYWHEEL_CMUX_TEST_NONCE"
  else
    printf '%s-%s-%s\n' "$(date +%s)" "$$" "$RANDOM"
  fi
}

_retire_owned_stage() {
  # Remove only a WAL-proven staging session. A linked target is first
  # unlinked while the source reference is positively present; tmux then
  # atomically refuses the operation if it would destroy the last reference.
  local stage="$1" expected_sid="$2" owner="$3" source="$4" wid="$5" placeholder="$6"
  local expected_generation="$7"
  local snapshot sid grouped active observed_owner marker members source_id
  linked_session_exists "$stage" || return 0
  snapshot=$(_view_session_snapshot "$stage") || return 1
  IFS='|' read -r sid grouped active observed_owner marker members < <(printf '%s\n' "$snapshot")
  [[ -n "$expected_sid" && "$sid" == "$expected_sid" && "$grouped" == "0" \
     && "$observed_owner" == "$owner" ]] || return 1
  case ",$members," in
    *,"$wid",*)
      source_id=$(tmux display-message -p -t "=${source}:${wid}" '#{window_id}' 2>/dev/null) || {
        # The stage may now be the only holder. Never unlink/kill the shared
        # window on an unprovable source; escrow only the exact generation,
        # session id, and topology already authorized by this WAL.
        escrow_view_session "$stage" 1 "$expected_generation" "$expected_sid" \
          "$snapshot" >/dev/null || return 1
        return 0
      }
      [[ "$source_id" == "$wid" ]] || return 1
      _GUARD_TMUX_GENERATION="$expected_generation"
      _GUARD_TMUX_SESSION="$stage"
      _GUARD_TMUX_SNAPSHOT="$snapshot"
      _GUARD_TMUX_GROUP=""
      tmux_call_guarded _tmux_session_snapshot_guard \
        unlink-window -t "=${stage}:${wid}" 2>/dev/null || return 1
      ;;
  esac
  linked_session_exists "$stage" || return 0
  snapshot=$(_view_session_snapshot "$stage") || return 1
  IFS='|' read -r sid grouped active observed_owner marker members < <(printf '%s\n' "$snapshot")
  [[ "$sid" == "$expected_sid" && "$grouped" == "0" \
     && "$observed_owner" == "$owner" && "$marker" == "1" \
     && "$members" == "$placeholder" ]] || return 1
  # Only our marked initial window remains, so whole-session removal cannot
  # touch the source or another linked window.
  _GUARD_TMUX_GENERATION="$expected_generation"
  _GUARD_TMUX_SESSION="$stage"
  _GUARD_TMUX_SNAPSHOT="$snapshot"
  _GUARD_TMUX_GROUP=""
  tmux_call_guarded _tmux_session_snapshot_guard \
    kill-session -t "=$stage" 2>/dev/null || return 1
  linked_session_exists "$stage" && return 1
  return 0
}

_retire_create_intent_stage() {
  # create_intent may have crashed after new-session but before recording the
  # session id/options. The deterministic nonce name plus an independent
  # one-window placeholder topology is the complete ownership proof.
  local stage="$1" expected_generation="$2"
  local snapshot sid grouped active owner marker members name
  linked_session_exists "$stage" || return 0
  snapshot=$(_view_session_snapshot "$stage") || return 1
  IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
  [[ -n "$sid" && "$grouped" == "0" && "$members" == "$active" ]] || return 1
  name=$(tmux display-message -p -t "=${stage}:${active}" '#{window_name}' 2>/dev/null) || return 1
  [[ "$name" == "__flywheel_placeholder__" ]] || return 1
  _GUARD_TMUX_GENERATION="$expected_generation"
  _GUARD_TMUX_SESSION="$stage"
  _GUARD_TMUX_SNAPSHOT="$snapshot"
  _GUARD_TMUX_GROUP=""
  tmux_call_guarded _tmux_session_snapshot_guard \
    kill-session -t "=$stage" 2>/dev/null || return 1
  linked_session_exists "$stage" && return 1
  return 0
}

recover_view_construction() {
  # Reconcile one WAL against the current tmux generation and topology. Any
  # malformed/ambiguous record is preserved and authorizes zero mutation.
  # A stale-generation record is safe to retire: tmux sessions cannot survive
  # the server generation encoded in the WAL, so its stage is impossible in
  # the current server. A same-name current-generation object remains foreign
  # and is never mutated by this cleanup.
  local requested_view="$1" wal line fields
  local version generation state nonce view source wid stage_sid placeholder stage current_generation expected_title
  local generation_socket generation_pid generation_started
  wal=$(_view_wal_path "$requested_view")
  [[ -f "$wal" ]] || return 0
  [[ "$(wc -l < "$wal" 2>/dev/null | tr -d ' ')" == "1" ]] || { log "WARN: malformed view WAL: $wal"; return 1; }
  line=$(cat "$wal" 2>/dev/null) || return 1
  fields=$(printf '%s\n' "$line" | awk -F'|' '{print NF}')
  case "$fields" in
    9)
      IFS='|' read -r version generation state nonce view source wid stage_sid placeholder < <(printf '%s\n' "$line")
      ;;
    11)
      # Production tmux generations are the historical socket|pid|started
      # tuple. Test seams use an opaque one-field generation, so recovery must
      # accept both durable shapes without rewriting either one.
      IFS='|' read -r version generation_socket generation_pid generation_started \
        state nonce view source wid stage_sid placeholder < <(printf '%s\n' "$line")
      generation="${generation_socket}|${generation_pid}|${generation_started}"
      ;;
    *) log "WARN: malformed view WAL fields: $wal"; return 1 ;;
  esac
  [[ "$version" == "v1" && "$view" == "$requested_view" ]] || return 1
  expected_title=${view#"$VIEW_PREFIX"}
  [[ -n "$expected_title" && "$expected_title" != "$view" ]] || return 1
  case "$state" in create_intent|created|link_intent|linked|claim_intent|claimed_complete) ;; *) return 1 ;; esac
  case "$nonce" in ''|*[!A-Za-z0-9_.-]*) return 1 ;; esac
  case "$view$source$wid$stage_sid$placeholder" in *$'\n'*) return 1 ;; esac
  current_generation=$(tmux_server_generation) || return 1
  [[ "$generation" == "$current_generation" ]] || {
    if tmux_generations_share_ambiguous_endpoint "$generation" "$current_generation"; then
      cmux_wal_block_view "$view" "$source" "$wid" || return 1
      log "WARN: preserving ambiguous legacy-generation view WAL for $requested_view old_generation=$generation current_generation=$current_generation"
      return 2
    fi
    log "GC stale-generation view WAL for $requested_view"
    rm -f "$wal" 2>/dev/null || return 1
    return 0
  }
  stage="fwstage-${nonce}"

  if [[ "$state" == "claimed_complete" ]]; then
    rm -f "$wal" 2>/dev/null || return 1
    return 0
  fi

  if [[ "$state" == "claim_intent" ]]; then
    if linked_session_exists "$view"; then
      if _linked_view_matches "$view" "$wid" "$source" "$stage_sid" \
          "$expected_title" "$generation" \
          && ! linked_session_exists "$stage"; then
        _write_view_wal "$wal" "$generation" claimed_complete "$nonce" "$view" \
          "$source" "$wid" "$stage_sid" "$placeholder" || return 1
        rm -f "$wal" 2>/dev/null || return 1
        return 0
      fi
      # A different canonical owns the name. We may retire our separately
      # proven stage, but the conflict record stays for operator visibility.
      if linked_session_exists "$stage"; then
        _retire_owned_stage "$stage" "$stage_sid" "$source" \
          "$source" "$wid" "$placeholder" "$generation" || return 1
      fi
      log "WARN: canonical view collision for $view; preserving WAL"
      return 2
    fi
    if _linked_view_matches "$stage" "$wid" "$source" "$stage_sid" \
        "$expected_title" "$generation"; then
      _GUARD_TMUX_GENERATION="$generation"
      _GUARD_TMUX_SESSION="$stage"
      _GUARD_TMUX_SNAPSHOT="$OWNED_VIEW_SNAPSHOT"
      _GUARD_TMUX_GROUP=""
      tmux_call_guarded _tmux_session_snapshot_guard \
        rename-session -t "=$stage" "$view" 2>/dev/null || return 1
      _linked_view_matches "$view" "$wid" "$source" "$stage_sid" \
        "$expected_title" "$generation" || return 1
      linked_session_exists "$stage" && return 1
      _write_view_wal "$wal" "$generation" claimed_complete "$nonce" "$view" \
        "$source" "$wid" "$stage_sid" "$placeholder" || return 1
      rm -f "$wal" 2>/dev/null || return 1
      return 0
    fi
    return 1
  fi

  if [[ "$state" == "create_intent" ]]; then
    if linked_session_exists "$stage"; then
      _retire_create_intent_stage "$stage" "$generation" || return 1
    fi
    rm -f "$wal" 2>/dev/null || return 1
    return 0
  fi

  # Before claim_intent, rename is impossible. A missing stage therefore has
  # no live residue and the record can be safely retired.
  if ! linked_session_exists "$stage"; then
    rm -f "$wal" 2>/dev/null || return 1
    return 0
  fi
  [[ -n "$stage_sid" && -n "$placeholder" ]] || return 1
  _retire_owned_stage "$stage" "$stage_sid" "$source" \
    "$source" "$wid" "$placeholder" "$generation" || return 1
  rm -f "$wal" 2>/dev/null || return 1
  return 0
}

_ledger_release_inner_lock() {
  local lock="$1"
  rm -f "$lock/owner" 2>/dev/null || true
  _ledger_maybe_crash after-lock-owner-remove
  rmdir "$lock" 2>/dev/null || true
}

_ledger_maybe_crash() {
  # Deterministic fault-injection seam for the ledger durability matrix. This
  # variable is unset in production; tests run the writer in a disposable child
  # process so SIGKILL faithfully leaves each possible crash residue behind.
  [[ "${FLYWHEEL_CMUX_LEDGER_CRASH_AT:-}" == "$1" ]] || return 0
  kill -KILL "$$"
  return 137
}

_ledger_conflict_state_transition() {
  # key|generation|title|episode|state
  local generation="$1" title="$2" desired="$3" key previous episode state dir tmp
  case "$desired" in healthy|unhealthy) ;; *) return 1 ;; esac
  key=$(_cmux_alert_hash "${generation}|${title}")
  dir=$(dirname "$LEDGER_CONFLICT_STATE")
  mkdir -p "$dir" 2>/dev/null || return 1
  touch "$LEDGER_CONFLICT_STATE" 2>/dev/null || return 1
  previous=$(awk -F'|' -v k="$key" \
    '$1 == k && NF == 5 { print $4 "|" $5; exit }' "$LEDGER_CONFLICT_STATE" 2>/dev/null || true)
  episode=${previous%%|*}
  state=${previous#*|}
  [[ "$previous" == *'|'* ]] || { episode=0; state=""; }
  if [[ "$desired" == "$state" ]]; then
    printf '%s\n' "$episode"
    return 0
  fi
  if [[ "$desired" == "healthy" && -z "$state" ]]; then
    printf '0\n'
    return 0
  fi
  [[ "$desired" == "unhealthy" ]] && episode=$((10#${episode:-0} + 1))
  tmp=$(mktemp "${LEDGER_CONFLICT_STATE}.XXXX" 2>/dev/null) || return 1
  awk -F'|' -v k="$key" '$1 != k { print }' "$LEDGER_CONFLICT_STATE" > "$tmp" 2>/dev/null || {
    rm -f "$tmp"; return 1;
  }
  printf '%s|%s|%s|%s|%s\n' "$key" "$generation" "$title" "$episode" "$desired" >> "$tmp" || {
    rm -f "$tmp"; return 1;
  }
  mv "$tmp" "$LEDGER_CONFLICT_STATE" 2>/dev/null || { rm -f "$tmp"; return 1; }
  printf '%s\n' "$episode"
}

_alert_ledger_title_conflict() {
  local generation="$1" title="$2" refs="$3" episode
  episode=$(_ledger_conflict_state_transition "$generation" "$title" unhealthy) || {
    log "WARN: cannot persist ledger title-conflict episode state generation=$generation title=$title"
    return 0
  }
  # An already-unhealthy subject returns its existing episode. The in-process
  # alert latch suppresses repeats during one watcher lifetime; the durable
  # episode suffix lets a recovered-then-regressed subject page again.
  _alert_cmux_cleanup \
    "cmux ledger title authority conflict" \
    "Multiple exact refs claim one logical cmux slot and were preserved without guessing a winner: generation=$generation title=$title refs=$refs episode=$episode." \
    "cmux_cleanup|ledger-title-conflict|$title|e$episode|generation=$generation"
}

_ledger_title_conflict_healthy() {
  _ledger_conflict_state_transition "$1" "$2" healthy >/dev/null || {
    log "WARN: cannot re-arm ledger title-conflict episode generation=$1 title=$2"
    return 0
  }
}

_workspace_uuid_valid() {
  [[ "$1" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]]
}

_workspace_title_is_default() {
  [[ "$1" =~ ^Terminal\ [0-9]+$ ]]
}

_ledger_transaction() {
  # The global incarnation-bound mutator lease is the authority that excludes
  # every legitimate ledger writer. The small inner lock only protects the
  # file replacement itself and may be reaped by that verified sole writer
  # after a crash. Without the global lease, even a missing/malformed inner
  # owner authorizes zero mutation.
  local action="$1" state="$2" generation="$3" ref="$4" title="$5" workspace_uuid="${6:-}"
  local dir lock owner_tmp="" tmp="" acquired=0 lock_owner="<missing>" conflict_refs=""
  case "$action" in upsert|remove|upgrade-legacy-uuid) ;; *) return 1 ;; esac
  if ! assert_or_reuse_owned_lease; then
    log "WARN: ledger $action refused: current process does not hold the verified mutator lease"
    [[ "$MUTATOR_LEASE_MODE" == "watch" && "$WATCHER_AUTHORITY_LOST" == "1" ]] && return 75
    return 1
  fi

  dir=$(dirname "$VIEW_LEDGER")
  mkdir -p "$dir" 2>/dev/null || return 1
  lock="${VIEW_LEDGER}.lock"
  if mkdir "$lock" 2>/dev/null; then
    acquired=1
  else
    # The verified global lease proves there is no second legitimate writer.
    # Therefore any residual inner lock belongs to an interrupted operation
    # and is safe for this sole writer to reap. This is deliberately after the
    # lease assertion above; an unleased caller can never reach this branch.
    lock_owner=$(cat "$lock/owner" 2>/dev/null || printf '<missing>')
    log "[audit] reaping residual ledger inner lock under verified mutator lease: $lock"
    if ! rm -rf "$lock" 2>/dev/null; then
      _alert_cmux_cleanup \
        "cmux ledger inner lock cannot be recovered" \
        "The verified global mutator lease could not remove residual ledger lock $lock; owner=$lock_owner. Ledger mutation remains fail-closed." \
        "cmux_cleanup|ledger-inner-lock|owner=$lock_owner"
      return 1
    fi
    if mkdir "$lock" 2>/dev/null; then
      acquired=1
    fi
  fi
  if [[ "$acquired" != "1" ]]; then
    _alert_cmux_cleanup \
      "cmux ledger inner lock remains unavailable" \
      "The verified global mutator lease could not reacquire residual ledger lock $lock; owner=$lock_owner. Ledger mutation remains fail-closed." \
      "cmux_cleanup|ledger-inner-lock|owner=$lock_owner"
    return 1
  fi
  _ledger_maybe_crash after-inner-mkdir

  owner_tmp=$(mktemp "${lock}.owner.XXXX" 2>/dev/null) || {
    _ledger_release_inner_lock "$lock"; return 1;
  }
  printf '%s|%s\n' "$$" "$MUTATOR_LEASE_INCARNATION" > "$owner_tmp" 2>/dev/null || {
    rm -f "$owner_tmp"; _ledger_release_inner_lock "$lock"; return 1;
  }
  _ledger_maybe_crash after-owner-tmp-write
  mv "$owner_tmp" "$lock/owner" 2>/dev/null || {
    rm -f "$owner_tmp"; _ledger_release_inner_lock "$lock"; return 1;
  }
  owner_tmp=""
  _ledger_maybe_crash after-owner-mv

  if [[ "$action" == "remove" && ! -f "$VIEW_LEDGER" ]]; then
    _ledger_release_inner_lock "$lock"
    return 0
  fi
  touch "$VIEW_LEDGER" 2>/dev/null || {
    _ledger_release_inner_lock "$lock"; return 1;
  }
  if [[ "$action" == "upsert" ]]; then
    # FLY-1446 E1: the uniqueness decision belongs inside the same inner-lock
    # transaction as the replace. An outer preflight would recreate the
    # rename-lag TOCTOU that produced two committed refs for one logical slot.
    conflict_refs=$(awk -F'|' -v g="$generation" -v r="$ref" -v t="$title" \
      '(NF == 4 || NF == 5) && ($1 == "prepared" || $1 == "committed") \
        && $2 == g && $4 == t && $3 != r { print $3 }' \
      "$VIEW_LEDGER" 2>/dev/null) || {
      _ledger_release_inner_lock "$lock"; return 1;
    }
    if [[ -n "$conflict_refs" ]]; then
      _ledger_release_inner_lock "$lock"
      _alert_ledger_title_conflict "$generation" "$title" \
        "$(printf '%s\n%s\n' "$conflict_refs" "$ref" | sort -u | paste -sd, -)"
      return 1
    fi
  elif [[ "$action" == "upgrade-legacy-uuid" ]]; then
    # Compare-and-replace under the same inner lock.  A changed/duplicated row
    # is never overwritten by stale four-field upgrade evidence.
    if ! awk -F'|' -v s="$state" -v g="$generation" -v r="$ref" -v t="$title" '
      $2 == g && $3 == r {
        rows++
        if (NF == 4 && $1 == s && $2 == g && $4 == t) exact++
      }
      END { exit(rows == 1 && exact == 1 ? 0 : 1) }
    ' "$VIEW_LEDGER" 2>/dev/null; then
      _ledger_release_inner_lock "$lock"
      return 1
    fi
  fi
  tmp=$(mktemp "${VIEW_LEDGER}.XXXX" 2>/dev/null) || {
    _ledger_release_inner_lock "$lock"; return 1;
  }
  if [[ "$action" == "upsert" ]]; then
    if ! awk -F'|' -v r="$ref" '$3 != r { print }' "$VIEW_LEDGER" > "$tmp" 2>/dev/null; then
      rm -f "$tmp"; _ledger_release_inner_lock "$lock"; return 1
    fi
    if [[ -n "$workspace_uuid" ]]; then
      printf '%s|%s|%s|%s|%s\n' "$state" "$generation" "$ref" "$title" "$workspace_uuid" >> "$tmp"
    else
      printf '%s|%s|%s|%s\n' "$state" "$generation" "$ref" "$title" >> "$tmp"
    fi || {
      rm -f "$tmp"; _ledger_release_inner_lock "$lock"; return 1;
    }
  elif [[ "$action" == "upgrade-legacy-uuid" ]]; then
    if ! awk -F'|' -v OFS='|' -v s="$state" -v g="$generation" \
        -v r="$ref" -v t="$title" -v u="$workspace_uuid" '
        NF == 4 && $1 == s && $2 == g && $3 == r && $4 == t {
          print $1,$2,$3,$4,u
          next
        }
        { print }
      ' "$VIEW_LEDGER" > "$tmp" 2>/dev/null; then
      rm -f "$tmp"; _ledger_release_inner_lock "$lock"; return 1
    fi
  else
    if ! awk -F'|' -v g="$generation" -v r="$ref" \
        '!($2 == g && $3 == r) { print }' "$VIEW_LEDGER" > "$tmp" 2>/dev/null; then
      rm -f "$tmp"; _ledger_release_inner_lock "$lock"; return 1
    fi
  fi
  _ledger_maybe_crash after-ledger-tmp-write
  if ! mv "$tmp" "$VIEW_LEDGER" 2>/dev/null; then
    rm -f "$tmp"; _ledger_release_inner_lock "$lock"; return 1
  fi
  _ledger_maybe_crash after-ledger-mv
  _ledger_release_inner_lock "$lock"
  return 0
}

_ledger_upsert() {
  local state="$1" generation="$2" ref="$3" title="$4" workspace_uuid="${5:-}"
  case "$state" in prepared|committed) ;; *) return 1 ;; esac
  case "$generation$ref$title$workspace_uuid" in *'|'*|*$'\n'*) return 1 ;; esac
  [[ -n "$generation" && -n "$ref" && -n "$title" ]] || return 1
  [[ -z "$workspace_uuid" ]] || _workspace_uuid_valid "$workspace_uuid" || return 1
  if cmux_wal_title_blocked "$title"; then
    log "WARN: ledger upsert blocked by preserved construction collision: title=$title ref=$ref"
    return 1
  fi
  _ledger_transaction upsert "$state" "$generation" "$ref" "$title" "$workspace_uuid"
}

_ledger_upgrade_legacy_uuid() {
  local generation="$1" ref="$2" title="$3" workspace_uuid="$4"
  case "$generation$ref$title$workspace_uuid" in *'|'*|*$'\n'*) return 1 ;; esac
  [[ -n "$generation" && -n "$ref" && -n "$title" ]] || return 1
  _workspace_uuid_valid "$workspace_uuid" || return 1
  _ledger_transaction upgrade-legacy-uuid committed "$generation" "$ref" "$title" "$workspace_uuid"
}

_ledger_remove() {
  local generation="$1" ref="$2"
  case "$generation$ref" in *'|'*|*$'\n'*) return 1 ;; esac
  [[ -n "$generation" && -n "$ref" ]] || return 1
  _ledger_transaction remove "" "$generation" "$ref" ""
}

ledger_committed_ref() {
  local generation="$1" ref="$2" title="$3"
  [[ -f "$VIEW_LEDGER" ]] || return 1
  awk -F'|' -v g="$generation" -v r="$ref" -v t="$title" \
    '$1 == "committed" && $2 == g && $3 == r && $4 == t { n++ } END { exit(n == 1 ? 0 : 1) }' \
    "$VIEW_LEDGER"
}

ledger_refs_for_title() {
  local generation="$1" title="$2"
  [[ -f "$VIEW_LEDGER" ]] || return 0
  awk -F'|' -v g="$generation" -v t="$title" \
    '$1 == "committed" && $2 == g && $4 == t { print $3 }' "$VIEW_LEDGER"
}

ledger_rows_for_title() {
  local generation="$1" title="$2"
  [[ -f "$VIEW_LEDGER" ]] || return 0
  awk -F'|' -v g="$generation" -v t="$title" \
    '(NF == 4 || NF == 5) && ($1 == "prepared" || $1 == "committed") && $2 == g && $4 == t { print }' \
    "$VIEW_LEDGER"
}

CMUX_LEDGER_DUPLICATE_TITLES=""
_ledger_title_duplicate_blocked() {
  local generation="$1" title="$2"
  [[ -n "$CMUX_LEDGER_DUPLICATE_TITLES" ]] || return 1
  printf '%s\n' "$CMUX_LEDGER_DUPLICATE_TITLES" \
    | awk -F'|' -v g="$generation" -v t="$title" \
      '$1 == g && $2 == t { found=1 } END { exit(found ? 0 : 1) }'
}

_detect_historical_ledger_title_conflicts() {
  local groups all_subjects generation title refs
  CMUX_LEDGER_DUPLICATE_TITLES=""
  [[ -f "$VIEW_LEDGER" ]] || return 0
  groups=$(awk -F'|' \
    '(NF == 4 || NF == 5) && $1 == "committed" { print $2 "|" $4 "|" $3 }' \
    "$VIEW_LEDGER" 2>/dev/null \
    | sort -u \
    | awk -F'|' '
function emit() {
  if (count > 1) print previous_generation "|" previous_title "|" refs
}
{
  key=$1 "|" $2
  if (NR > 1 && key != previous_key) {
    emit()
    count=0
    refs=""
  }
  previous_key=key
  previous_generation=$1
  previous_title=$2
  count++
  refs=refs (refs ? "," : "") $3
}
END { if (NR > 0) emit() }
') || return 1
  while IFS='|' read -r generation title refs; do
    [[ -n "$generation" && -n "$title" && -n "$refs" ]] || continue
    CMUX_LEDGER_DUPLICATE_TITLES+="${CMUX_LEDGER_DUPLICATE_TITLES:+$'\n'}${generation}|${title}"
    _alert_ledger_title_conflict "$generation" "$title" "$refs"
  done < <(printf '%s\n' "$groups")

  all_subjects=$(awk -F'|' \
    '(NF == 4 || NF == 5) && ($1 == "prepared" || $1 == "committed") { print $2 "|" $4 }' \
    "$VIEW_LEDGER" 2>/dev/null | sort -u) || return 1
  while IFS='|' read -r generation title; do
    [[ -n "$generation" && -n "$title" ]] || continue
    _ledger_title_duplicate_blocked "$generation" "$title" \
      || _ledger_title_conflict_healthy "$generation" "$title"
  done < <(printf '%s\n' "$all_subjects")
  return 0
}

# Print validated restored markers as tab-separated decoded records:
# kind, generation, ref, title, original receipt state, fingerprint, epoch.
# Any malformed byte in the file invalidates the entire authority namespace.
_restored_parse_records() {
  [[ -e "$RESTORED_STATE" || -L "$RESTORED_STATE" ]] || return 0
  [[ -f "$RESTORED_STATE" && ! -L "$RESTORED_STATE" ]] || return 2
  [[ -s "$RESTORED_STATE" ]] || return 0
  python3 - "$RESTORED_STATE" <<'PY' || return 2
import base64
import os
import re
import sys
import time

path = sys.argv[1]
try:
    with open(path, "rb") as handle:
        payload = handle.read()
except OSError:
    raise SystemExit(2)
try:
    text = payload.decode("utf-8")
except UnicodeDecodeError:
    raise SystemExit(2)

def decode_canonical(value):
    try:
        raw = base64.b64decode(value, validate=True)
        if base64.b64encode(raw).decode("ascii") != value:
            raise ValueError()
        return raw.decode("utf-8")
    except Exception:
        raise SystemExit(2)

records = []
seen = set()
now = int(time.time())
for line in text.splitlines():
    if not line:
        raise SystemExit(2)
    fields = line.split("|")
    if len(fields) != 8:
        raise SystemExit(2)
    version, kind, generation, ref, title_b64, orig_b64, fingerprint, epoch_raw = fields
    if version != "restoredv1" or kind not in {"W1", "W1p", "W1dead"}:
        raise SystemExit(2)
    if not generation or any(ord(ch) < 32 or ord(ch) == 127 for ch in generation):
        raise SystemExit(2)
    if not re.fullmatch(r"workspace:[0-9]+", ref):
        raise SystemExit(2)
    if not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
        raise SystemExit(2)
    if not re.fullmatch(r"[0-9]+", epoch_raw):
        raise SystemExit(2)
    epoch = int(epoch_raw)
    if epoch > now:
        raise SystemExit(2)
    title = decode_canonical(title_b64)
    if not title or "|" in title or any(ord(ch) < 32 or ord(ch) == 127 for ch in title):
        raise SystemExit(2)
    original = decode_canonical(orig_b64)
    orig = original.split("|", 3)
    if len(orig) != 4:
        raise SystemExit(2)
    orig_state, orig_generation, orig_ref, orig_title = orig
    if orig_state not in {"none", "prepared", "committed"}:
        raise SystemExit(2)
    if (orig_generation, orig_ref, orig_title) != (generation, ref, title):
        raise SystemExit(2)
    if kind in {"W1", "W1dead"} and orig_state != "none":
        raise SystemExit(2)
    if kind == "W1p" and orig_state != "prepared":
        raise SystemExit(2)
    key = (generation, ref, title)
    if key in seen:
        raise SystemExit(2)
    seen.add(key)
    records.append((kind, generation, ref, title, orig_state, fingerprint, str(epoch)))

if payload and not text.endswith("\n"):
    raise SystemExit(2)
for record in records:
    print("\t".join(record))
PY
}

# rc=0 exact in-flight marker; rc=1 no marker; rc=2 unreadable/malformed
# namespace. rc=2 is deliberately global fail-closed, not tuple-local.
restored_inflight_state() {
  local generation="$1" ref="$2" title="$3" records rc=0 count
  records=$(_restored_parse_records) || rc=$?
  [[ "$rc" -eq 0 ]] || return 2
  count=$(printf '%s\n' "$records" | awk -F'\t' -v g="$generation" -v r="$ref" -v t="$title" \
    '$2 == g && $3 == r && $4 == t { n++ } END { print n+0 }')
  case "$count" in
    0) return 1 ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
}

_restored_marker_exact() {
  local kind="$1" generation="$2" ref="$3" title="$4" fingerprint="$5"
  local records rc=0 count
  records=$(_restored_parse_records) || rc=$?
  [[ "$rc" -eq 0 ]] || return 2
  count=$(printf '%s\n' "$records" | awk -F'\t' \
    -v k="$kind" -v g="$generation" -v r="$ref" -v t="$title" -v f="$fingerprint" \
    '$1 == k && $2 == g && $3 == r && $4 == t && $6 == f { n++ } END { print n+0 }')
  [[ "$count" == "1" ]]
}

RESTORED_CAP_KIND=""
RESTORED_CAP_GENERATION=""
RESTORED_CAP_REF=""
RESTORED_CAP_TITLE=""
RESTORED_CAP_FINGERPRINT=""

_restored_recovery_cap_clear() {
  RESTORED_CAP_KIND=""
  RESTORED_CAP_GENERATION=""
  RESTORED_CAP_REF=""
  RESTORED_CAP_TITLE=""
  RESTORED_CAP_FINGERPRINT=""
}

_restored_recovery_cap_enter() {
  local kind="$1" generation="$2" ref="$3" title="$4" fingerprint="$5"
  _restored_recovery_cap_clear
  _restored_marker_exact "$kind" "$generation" "$ref" "$title" "$fingerprint" || return 1
  restored_inflight_state "$generation" "$ref" "$title" || return 1
  RESTORED_CAP_KIND="$kind"
  RESTORED_CAP_GENERATION="$generation"
  RESTORED_CAP_REF="$ref"
  RESTORED_CAP_TITLE="$title"
  RESTORED_CAP_FINGERPRINT="$fingerprint"
}

_restored_recovery_cap_valid() {
  local generation="$1" ref="$2" title="$3"
  [[ -n "$RESTORED_CAP_KIND" && "$RESTORED_CAP_GENERATION" == "$generation" \
      && "$RESTORED_CAP_REF" == "$ref" && "$RESTORED_CAP_TITLE" == "$title" \
      && -n "$RESTORED_CAP_FINGERPRINT" ]] || return 1
  _restored_marker_exact "$RESTORED_CAP_KIND" "$generation" "$ref" "$title" \
    "$RESTORED_CAP_FINGERPRINT"
}

# Marker-authorized, generation-scoped CAS used only by restored settlement.
# It never uses _ledger_upsert because that primitive replaces rows by ref
# across generations and could erase a current-generation ref reuse.
_restored_ledger_cas() {
  local action="$1" kind="$2" generation="$3" ref="$4" title="$5" fingerprint="$6"
  local records rc=0 marker_state summary committed prepared other dir lock tmp
  case "$action" in delete|restore-prepared) ;; *) return 1 ;; esac
  _restored_marker_exact "$kind" "$generation" "$ref" "$title" "$fingerprint" || return 1
  records=$(_restored_parse_records) || rc=$?
  [[ "$rc" -eq 0 ]] || return 1
  marker_state=$(printf '%s\n' "$records" | awk -F'\t' \
    -v k="$kind" -v g="$generation" -v r="$ref" -v t="$title" -v f="$fingerprint" \
    '$1 == k && $2 == g && $3 == r && $4 == t && $6 == f { print $5; exit }')
  if [[ "$action" == "delete" ]]; then
    [[ "$marker_state" == "none" ]] || return 1
  else
    [[ "$kind" == "W1p" && "$marker_state" == "prepared" ]] || return 1
  fi
  assert_or_reuse_owned_lease || return 1
  dir=$(dirname "$VIEW_LEDGER")
  mkdir -p "$dir" 2>/dev/null || return 1
  lock="${VIEW_LEDGER}.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    log "[audit] reaping residual ledger inner lock for restored CAS under verified mutator lease: $lock"
    rm -rf "$lock" 2>/dev/null || return 1
    mkdir "$lock" 2>/dev/null || return 1
  fi
  touch "$VIEW_LEDGER" 2>/dev/null || { _ledger_release_inner_lock "$lock"; return 1; }
  summary=$(awk -F'|' -v g="$generation" -v r="$ref" -v t="$title" '
    $2 == g && $3 == r {
      if ((NF == 4 || NF == 5) && $4 == t && $1 == "committed") committed++
      else if ((NF == 4 || NF == 5) && $4 == t && $1 == "prepared") prepared++
      else other++
    }
    END { print committed+0 "|" prepared+0 "|" other+0 }
  ' "$VIEW_LEDGER") || { _ledger_release_inner_lock "$lock"; return 1; }
  IFS='|' read -r committed prepared other < <(printf '%s\n' "$summary")
  if [[ "$action" == "delete" ]]; then
    if [[ "$committed" == "0" && "$prepared" == "0" && "$other" == "0" ]]; then
      _ledger_release_inner_lock "$lock"
      return 0
    fi
    [[ "$committed" == "1" && "$prepared" == "0" && "$other" == "0" ]] || {
      _ledger_release_inner_lock "$lock"; return 1;
    }
  else
    if [[ "$committed" == "0" && "$prepared" == "1" && "$other" == "0" ]]; then
      _ledger_release_inner_lock "$lock"
      return 0
    fi
    [[ "$committed" == "1" && "$prepared" == "0" && "$other" == "0" ]] || {
      _ledger_release_inner_lock "$lock"; return 1;
    }
  fi
  tmp=$(mktemp "${VIEW_LEDGER}.XXXX" 2>/dev/null) || {
    _ledger_release_inner_lock "$lock"; return 1;
  }
  if [[ "$action" == "delete" ]]; then
    awk -F'|' -v g="$generation" -v r="$ref" -v t="$title" \
      '!((NF == 4 || NF == 5) && $1 == "committed" && $2 == g && $3 == r && $4 == t) { print }' \
      "$VIEW_LEDGER" > "$tmp" 2>/dev/null || {
      rm -f "$tmp"; _ledger_release_inner_lock "$lock"; return 1;
    }
  else
    awk -F'|' -v g="$generation" -v r="$ref" -v t="$title" '
      (NF == 4 || NF == 5) && $1 == "committed" && $2 == g && $3 == r && $4 == t {
        print "prepared|" g "|" r "|" t (NF == 5 ? "|" $5 : ""); next
      }
      { print }
    ' "$VIEW_LEDGER" > "$tmp" 2>/dev/null || {
      rm -f "$tmp"; _ledger_release_inner_lock "$lock"; return 1;
    }
  fi
  mv "$tmp" "$VIEW_LEDGER" 2>/dev/null || {
    rm -f "$tmp"; _ledger_release_inner_lock "$lock"; return 1;
  }
  _ledger_release_inner_lock "$lock"
}

restored_adoption_enabled() {
  return 0
}

_restored_b64() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

_restored_marker_upsert() {
  local kind="$1" generation="$2" ref="$3" title="$4" orig_state="$5" fingerprint="$6"
  local title_b64 orig_b64 epoch dir tmp records rc=0
  case "$kind" in W1|W1p|W1dead) ;; *) return 1 ;; esac
  case "$orig_state" in none|prepared) ;; *) return 1 ;; esac
  [[ "$kind" == "W1p" && "$orig_state" == "prepared" \
      || "$kind" != "W1p" && "$orig_state" == "none" ]] || return 1
  case "$ref" in workspace:[0-9]*) case "${ref#workspace:}" in ''|*[!0-9]*) return 1 ;; esac ;; *) return 1 ;; esac
  case "$fingerprint" in *[!0-9a-f]*|"") return 1 ;; esac
  [[ ${#fingerprint} -eq 64 ]] || return 1
  case "$generation$title" in *'|'*|*$'\t'*|*$'\n'*) return 1 ;; esac
  assert_or_reuse_owned_lease || return 1
  records=$(_restored_parse_records) || rc=$?
  [[ "$rc" -eq 0 ]] || return 2
  title_b64=$(_restored_b64 "$title") || return 1
  orig_b64=$(_restored_b64 "$orig_state|$generation|$ref|$title") || return 1
  epoch=$(date +%s) || return 1
  dir=$(dirname "$RESTORED_STATE")
  mkdir -p "$dir" 2>/dev/null || return 1
  touch "$RESTORED_STATE" 2>/dev/null || return 1
  tmp=$(mktemp "${RESTORED_STATE}.XXXX" 2>/dev/null) || return 1
  awk -F'|' -v g="$generation" -v r="$ref" -v b="$title_b64" \
    '!(NF == 8 && $1 == "restoredv1" && $3 == g && $4 == r && $5 == b) { print }' \
    "$RESTORED_STATE" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  printf 'restoredv1|%s|%s|%s|%s|%s|%s|%s\n' \
    "$kind" "$generation" "$ref" "$title_b64" "$orig_b64" "$fingerprint" "$epoch" \
    >> "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$RESTORED_STATE" 2>/dev/null || { rm -f "$tmp"; return 1; }
  _restored_parse_records >/dev/null || return 2
  log "[audit] persisted restored adoption marker kind=$kind generation=$generation ref=$ref title=$title fingerprint=$fingerprint"
}

_restored_marker_remove_exact() {
  local generation="$1" ref="$2" title="$3" fingerprint="$4" title_b64 tmp rc=0
  assert_or_reuse_owned_lease || return 1
  _restored_parse_records >/dev/null || rc=$?
  [[ "$rc" -eq 0 ]] || return 2
  [[ -f "$RESTORED_STATE" ]] || return 0
  title_b64=$(_restored_b64 "$title") || return 1
  tmp=$(mktemp "${RESTORED_STATE}.XXXX" 2>/dev/null) || return 1
  awk -F'|' -v g="$generation" -v r="$ref" -v b="$title_b64" -v f="$fingerprint" \
    '!(NF == 8 && $1 == "restoredv1" && $3 == g && $4 == r && $5 == b && $7 == f) { print }' \
    "$RESTORED_STATE" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$RESTORED_STATE" 2>/dev/null || { rm -f "$tmp"; return 1; }
  log "[audit] cleared restored adoption marker generation=$generation ref=$ref title=$title fingerprint=$fingerprint"
}

# Strict typed snapshot. rc=2 means no conclusion may be drawn from presence
# or absence; rc=0 with empty output is a conclusive empty inventory.
strict_agent_window_snapshot() {
  local sessions session rows observed_session wid title dead extra out=""
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null) || return 2
  while IFS= read -r session; do
    [[ -n "$session" ]] || continue
    case "$session" in flywheel|runner-*) ;; *) continue ;; esac
    rows=$(tmux list-windows -t "=$session" \
      -F '#{session_name}|#{window_id}|#{window_name}|#{pane_dead}' 2>/dev/null) || return 2
    while IFS='|' read -r observed_session wid title dead extra; do
      [[ -n "$observed_session$wid$title$dead${extra:-}" ]] || continue
      [[ -z "${extra:-}" && "$observed_session" == "$session" ]] || return 2
      case "$wid" in @*) case "${wid#@}" in ''|*[!0-9]*) return 2 ;; esac ;; *) return 2 ;; esac
      case "$dead" in 0|1) ;; *) return 2 ;; esac
      case "$title" in ''|zsh|bash) continue ;; *'|'*|*$'\t'*|*$'\n'*) return 2 ;; esac
      out+="${out:+$'\n'}${observed_session}|${wid}|${title}|${dead}"
    done < <(printf '%s\n' "$rows")
  done < <(printf '%s\n' "$sessions")
  printf '%s\n' "$out" | grep -v '^$' || true
  return 0
}

_restored_title_in_lead_roster() {
  local title="$1" count
  derive_lead_roster || return 2
  [[ "$LEAD_ROSTER_STATE" == "ok" ]] || return 2
  count=$(printf '%s\n' "$LEAD_ROSTER_ROWS" | awk -F'|' -v t="$title" \
    '$1 != "claude-private" && $3 == t { n++ } END { print n+0 }')
  [[ "$count" == "1" ]]
}

RESTORED_PROBE_FINGERPRINT=""
RESTORED_PROBE_SOURCE=""
RESTORED_PROBE_WID=""
RESTORED_PROBE_RAW_TITLE=""
RESTORED_PROBE_SURFACE=""

# Shared resident/ops evidence probe. rc=0 exact evidence, rc=1 conclusive
# drift/refusal, rc=2 inventory uncertainty.
_restored_candidate_probe() {
  local kind="$1" generation="$2" ref="$3" title="$4" expected="${5:-}"
  local current raw canonical candidates candidate_count candidate_kind candidate_ref pinned selected number
  local evidence raw_title surface snapshot live_rows live_count any_count
  RESTORED_PROBE_FINGERPRINT="" RESTORED_PROBE_SOURCE="" RESTORED_PROBE_WID=""
  RESTORED_PROBE_RAW_TITLE="" RESTORED_PROBE_SURFACE=""
  current=$(cmux_socket_identity) || return 2
  [[ -n "$current" && "$current" == "$generation" ]] || return 1
  raw=$(get_cmux_workspaces_json) || return 2
  canonical=$(managed_view_command_variants "${VIEW_PREFIX}${title}") || return 2
  candidates=$(workspace_title_candidates "$raw" "$title" "$canonical") || return 2
  candidate_count=$(printf '%s\n' "$candidates" | grep -c . || true)
  [[ "$candidate_count" == "1" ]] || return 1
  IFS='|' read -r candidate_kind candidate_ref pinned selected number < <(printf '%s\n' "$candidates")
  [[ "$candidate_ref" == "$ref" ]] || return 1
  case "$candidate_kind" in
    named) raw_title="$title" ;;
    raw)
      raw_title=$(workspace_title_for_ref "$ref") || return 2
      _managed_view_command_in_variants "$raw_title" "$canonical" || return 1
      ;;
    *) return 2 ;;
  esac
  # A restored receipt follows the row identity, not transient presentation
  # state. Focus and pin changes must not reset the two-pass stability latch.
  evidence="$candidate_kind|$candidate_ref|$number"
  surface=$(workspace_single_surface_title "$ref") || return 2
  linked_session_exists "${VIEW_PREFIX}${title}" && return 1
  snapshot=$(strict_agent_window_snapshot) || return 2
  live_rows=$(printf '%s\n' "$snapshot" | awk -F'|' -v t="$title" '$3 == t && $4 == "0" { print }')
  live_count=$(printf '%s\n' "$live_rows" | grep -c . || true)
  any_count=$(printf '%s\n' "$snapshot" | awk -F'|' -v t="$title" '$3 == t { n++ } END { print n+0 }')
  case "$kind" in
    W1|W1p)
      [[ "$live_count" == "1" ]] || return 1
      IFS='|' read -r RESTORED_PROBE_SOURCE RESTORED_PROBE_WID _ _ < <(printf '%s\n' "$(printf '%s\n' "$live_rows" | head -1)")
      ;;
    W1dead)
      [[ "$any_count" == "0" ]] || return 1
      _restored_title_in_lead_roster "$title" || { [[ $? -eq 2 ]] && return 2 || return 1; }
      RESTORED_PROBE_SOURCE="absent"
      RESTORED_PROBE_WID="absent"
      ;;
    *) return 1 ;;
  esac
  if [[ "$kind" == "W1p" ]]; then
    [[ "$surface" != "$title" && "$surface" != "$raw_title" ]] || return 1
  else
    [[ "$surface" == "$title" || "$surface" == "$raw_title" || "$surface" == "~" ]] || return 1
  fi
  current=$(cmux_socket_identity) || return 2
  [[ "$current" == "$generation" ]] || return 1
  RESTORED_PROBE_RAW_TITLE="$raw_title"
  RESTORED_PROBE_SURFACE="$surface"
  RESTORED_PROBE_FINGERPRINT=$(_cmux_alert_hash \
    "$kind|$generation|$ref|$title|$raw_title|$surface|$RESTORED_PROBE_SOURCE|$RESTORED_PROBE_WID|$evidence")
  [[ -z "$expected" || "$RESTORED_PROBE_FINGERPRINT" == "$expected" ]]
}

_restored_ref_presence() {
  local ref="$1" raw
  raw=$(get_cmux_workspaces_json) || return 2
  printf '%s' "$raw" | python3 -c '
import json,sys
r=sys.argv[1]
try:
    matches=[w for w in json.load(sys.stdin).get("workspaces", [])
             if isinstance(w,dict) and w.get("ref") == r]
except Exception:
    raise SystemExit(2)
if not matches:
    print("absent")
elif len(matches) == 1:
    print("present")
else:
    print("ambiguous")
' "$ref" || return 2
}

_GUARD_RESTORED_KIND=""
_GUARD_RESTORED_GENERATION=""
_GUARD_RESTORED_REF=""
_GUARD_RESTORED_TITLE=""
_GUARD_RESTORED_FINGERPRINT=""
_restored_final_close_guard() {
  _restored_marker_exact "$_GUARD_RESTORED_KIND" "$_GUARD_RESTORED_GENERATION" \
    "$_GUARD_RESTORED_REF" "$_GUARD_RESTORED_TITLE" "$_GUARD_RESTORED_FINGERPRINT" || return 1
  _restored_candidate_probe "$_GUARD_RESTORED_KIND" "$_GUARD_RESTORED_GENERATION" \
    "$_GUARD_RESTORED_REF" "$_GUARD_RESTORED_TITLE" "$_GUARD_RESTORED_FINGERPRINT"
}

_restored_abort_marker() {
  local kind="$1" generation="$2" ref="$3" title="$4" fingerprint="$5" ledger_state="$6"
  case "$kind:$ledger_state" in
    W1:committed|W1dead:committed)
      _restored_ledger_cas delete "$kind" "$generation" "$ref" "$title" "$fingerprint" || return 1
      ;;
    W1p:committed)
      _restored_ledger_cas restore-prepared "$kind" "$generation" "$ref" "$title" "$fingerprint" || return 1
      ;;
    W1:none|W1dead:none|W1p:prepared) ;;
    *) return 1 ;;
  esac
  _restored_marker_remove_exact "$generation" "$ref" "$title" "$fingerprint"
}

# Pure, ordered implementation of plan §3.1's recovery table. Inputs are
# already typed observations; output is exactly one `row|action` decision.
_restored_recovery_decision() {
  local generation_relation="$1" kind="$2" ledger_state="$3" presence="$4"
  local flag="$5" evidence="$6" readiness="$7"
  if [[ "$generation_relation" == "inconclusive" || "$presence" == "inconclusive" \
      || "$evidence" == "inconclusive" ]]; then
    printf '0|quarantine\n'; return 0
  fi
  if [[ "$generation_relation" == "unknown" ]]; then
    printf '1|wait\n'; return 0
  fi
  if [[ "$ledger_state" == "conflict" ]]; then
    printf '20|quarantine\n'; return 0
  fi
  if [[ "$generation_relation" == "stale" ]]; then
    case "$kind:$ledger_state" in
      W1:none|W1dead:none|W1p:none) printf '2|marker-delete\n' ;;
      W1:committed|W1dead:committed) printf '3|cas-delete-marker\n' ;;
      W1p:committed) printf '4|cas-restore-marker\n' ;;
      W1p:prepared) printf '5|marker-delete\n' ;;
      *) printf '6|quarantine\n' ;;
    esac
    return 0
  fi
  [[ "$generation_relation" == "current" ]] || { printf '0|quarantine\n'; return 0; }
  case "$kind" in
    W1|W1dead)
      case "$ledger_state:$presence" in
        none:absent) printf '9|marker-delete\n' ;;
        none:present)
          if [[ "$flag" == "off" || "$evidence" == "drift" ]]; then
            printf '8|marker-delete\n'
          elif [[ "$readiness" != "ready" ]]; then
            printf '6.5|wait\n'
          else
            printf '7|advance\n'
          fi
          ;;
        committed:absent) printf '12|gc-wait\n' ;;
        committed:present)
          if [[ "$flag" == "on" && "$evidence" == "stable" ]]; then
            printf '10|recovery-close\n'
          else
            printf '11|cas-delete-marker\n'
          fi
          ;;
        *) printf '20|quarantine\n' ;;
      esac
      ;;
    W1p)
      case "$ledger_state:$presence" in
        prepared:present)
          if [[ "$flag" == "off" || "$evidence" == "drift" ]]; then
            printf '14|marker-delete\n'
          elif [[ "$readiness" != "ready" ]]; then
            printf '6.5|wait\n'
          else
            printf '13|advance\n'
          fi
          ;;
        prepared:absent) printf '14|marker-delete\n' ;;
        committed:absent) printf '17|gc-wait\n' ;;
        committed:present)
          if [[ "$flag" == "on" && "$evidence" == "stable" ]]; then
            printf '15|recovery-close\n'
          else
            printf '16|cas-restore-marker\n'
          fi
          ;;
        none:absent) printf '18|marker-delete\n' ;;
        none:present) printf '19|quarantine\n' ;;
        *) printf '20|quarantine\n' ;;
      esac
      ;;
    *) printf '0|quarantine\n' ;;
  esac
}

restored_action_budget() {
  local count="$1" bootstrap="${2:-0}" configured="${FLYWHEEL_CMUX_ADOPTION_BUDGET:-}" budget
  case "$count" in ''|*[!0-9]*) return 1 ;; esac
  if [[ -n "$configured" ]]; then
    case "$configured" in ''|*[!0-9]*) return 1 ;; esac
    budget=$((10#$configured))
    (( budget >= 1 && budget <= 1000 )) || return 1
  else
    budget=$(((10#$count + 2) / 3))
    (( budget < 4 )) && budget=4
  fi
  [[ "$bootstrap" == "1" ]] && budget=$((budget * 2))
  printf '%s\n' "$budget"
}

recover_restored_transactions() {
  local target_scope="${1:-}"
  local records rc=0 kind generation ref title orig_state fingerprint epoch current state presence probe_rc now grace
  local relation flag evidence readiness decision row action marker_count budget actions=0
  records=$(_restored_parse_records) || rc=$?
  [[ "$rc" -eq 0 ]] || return 2
  [[ -n "$records" ]] || return 0
  current=$(cmux_socket_identity) || return 2
  [[ -n "$current" ]] || return 2
  now=$(date +%s) || return 2
  grace="${FLYWHEEL_CMUX_ADOPTION_GRACE:-$CONSERVATIVE_CLEANUP_SECONDS}"
  case "$grace" in ''|*[!0-9]*) grace=300 ;; esac
  marker_count=$(printf '%s\n' "$records" | grep -c . || true)
  budget=$(restored_action_budget "$marker_count" "${RESTORED_BOOTSTRAP_PASS:-0}") || return 2
  while IFS=$'\t' read -r kind generation ref title orig_state fingerprint epoch; do
    [[ -n "$kind" ]] || continue
    if [[ -n "$target_scope" ]] \
        && ! printf '%s\n' "$target_scope" | grep -qxF "$title"; then
      log "[audit] restored transaction outside ops scope preserved title=$title ref=$ref"
      continue
    fi
    state=$(ledger_candidate_receipt_state "$generation" "$ref" "$title") || state=conflict
    relation=current
    [[ "$generation" == "$current" ]] || relation=stale
    presence=present
    if [[ "$relation" == "current" ]]; then
      presence=$(_restored_ref_presence "$ref") || presence=inconclusive
    fi
    restored_adoption_enabled && flag=on || flag=off
    evidence=stable
    readiness=ready
    if [[ "$relation" == "current" && "$presence" == "present" && "$flag" == "on" ]]; then
      probe_rc=0
      _restored_candidate_probe "$kind" "$generation" "$ref" "$title" "$fingerprint" || probe_rc=$?
      case "$probe_rc" in 0) evidence=stable ;; 1) evidence=drift ;; *) evidence=inconclusive ;; esac
    elif [[ "$flag" == "off" ]]; then
      evidence=drift
    fi
    if [[ "$kind" == "W1dead" ]] && (( now - 10#$epoch < grace )); then
      readiness=not-ready
    fi
    decision=$(_restored_recovery_decision "$relation" "$kind" "$state" "$presence" \
      "$flag" "$evidence" "$readiness") || return 2
    IFS='|' read -r row action < <(printf '%s\n' "$decision")
    case "$action" in
      wait|gc-wait) continue ;;
      quarantine)
        log "WARN: restored transaction quarantined decision=$row kind=$kind generation=$generation ref=$ref title=$title state=$state presence=$presence evidence=$evidence"
        continue
        ;;
    esac
    (( actions < budget )) || break
    case "$action" in
      marker-delete)
        if ! _restored_marker_remove_exact "$generation" "$ref" "$title" "$fingerprint"; then
          log "WARN: restored transaction action failed; marker preserved decision=$row action=$action generation=$generation ref=$ref title=$title"
          continue
        fi
        actions=$((actions + 1))
        ;;
      cas-delete-marker)
        if ! _restored_ledger_cas delete "$kind" "$generation" "$ref" "$title" "$fingerprint"; then
          log "WARN: restored transaction action failed; marker preserved decision=$row action=cas-delete generation=$generation ref=$ref title=$title"
          continue
        fi
        if ! _restored_marker_remove_exact "$generation" "$ref" "$title" "$fingerprint"; then
          log "WARN: restored transaction action incomplete; marker preserved decision=$row action=marker-delete generation=$generation ref=$ref title=$title"
          continue
        fi
        actions=$((actions + 1))
        ;;
      cas-restore-marker)
        if ! _restored_ledger_cas restore-prepared "$kind" "$generation" "$ref" "$title" "$fingerprint"; then
          log "WARN: restored transaction action failed; marker preserved decision=$row action=cas-restore generation=$generation ref=$ref title=$title"
          continue
        fi
        if ! _restored_marker_remove_exact "$generation" "$ref" "$title" "$fingerprint"; then
          log "WARN: restored transaction action incomplete; marker preserved decision=$row action=marker-delete generation=$generation ref=$ref title=$title"
          continue
        fi
        actions=$((actions + 1))
        ;;
      advance)
        if ! _ledger_upsert committed "$generation" "$ref" "$title"; then
          log "WARN: restored transaction action failed; marker preserved decision=$row action=advance generation=$generation ref=$ref title=$title"
          continue
        fi
        state=committed
        log "[audit] restored adoption minted synthetic committed receipt decision=$row kind=$kind generation=$generation ref=$ref title=$title"
        # Advance and close are one per-title transaction and consume one
        # action budget only after the final close succeeds.
        action=recovery-close
        ;;
      recovery-close) ;;
      *) return 2 ;;
    esac
    if [[ "$action" == "recovery-close" ]]; then
        if ! _restored_recovery_cap_enter "$kind" "$generation" "$ref" "$title" "$fingerprint"; then
          log "WARN: restored transaction action failed; marker preserved decision=$row action=cap-enter generation=$generation ref=$ref title=$title"
          continue
        fi
        _GUARD_RESTORED_KIND="$kind"
        _GUARD_RESTORED_GENERATION="$generation"
        _GUARD_RESTORED_REF="$ref"
        _GUARD_RESTORED_TITLE="$title"
        _GUARD_RESTORED_FINGERPRINT="$fingerprint"
        if close_ledger_workspace_ref "$generation" "$ref" "$title" \
            "restored-adoption-${kind}-${title}" _restored_final_close_guard; then
          if _restored_marker_remove_exact "$generation" "$ref" "$title" "$fingerprint"; then
            actions=$((actions + 1))
            log "[audit] restored adoption closed row decision=$row kind=$kind generation=$generation ref=$ref title=$title"
          else
            log "WARN: restored transaction close completed but marker clear failed; marker preserved decision=$row generation=$generation ref=$ref title=$title"
          fi
        else
          log "WARN: restored transaction close failed; marker preserved decision=$row generation=$generation ref=$ref title=$title"
        fi
        _restored_recovery_cap_clear
    fi
  done < <(printf '%s\n' "$records")
  return 0
}

adopt_restored_workspaces() {
  local mode="${1:-live}" recovery_mode="${2:-recover}"
  local generation raw snapshot candidate_titles="" title dead canonical candidates candidate_count candidate_kind ref
  local pinned selected number rc=0 state kind probe_rc
  local roster_adapter roster_label roster_title
  # Direct read-only sync fixtures and a watcher that just lost authority must
  # not turn this optional discovery phase into a hard pass failure. The lease
  # verifier marks watcher authority loss; the caller's latch check then stops
  # every later mutation in production.
  assert_or_reuse_owned_lease || return 0
  if [[ "$recovery_mode" != "discover-only" ]]; then
    recover_restored_transactions || rc=$?
    [[ "$rc" -eq 0 ]] || return "$rc"
  fi
  restored_adoption_enabled || return 0
  generation=$(cmux_socket_identity) || return 2
  [[ -n "$generation" ]] || return 2
  raw=$(get_cmux_workspaces_json) || return 2
  case "$mode" in
    live)
      snapshot=$(strict_agent_window_snapshot) || return 2
      while IFS='|' read -r _ _ title dead; do
        [[ -n "$title" && "$dead" == "0" ]] || continue
        if is_managed_runner_title "$title"; then
          candidate_titles+="${candidate_titles:+$'\n'}${title}"
        fi
      done < <(printf '%s\n' "$snapshot")
      if derive_lead_roster && [[ "$LEAD_ROSTER_STATE" == "ok" ]]; then
        while IFS='|' read -r roster_adapter roster_label roster_title _roster_socket; do
          [[ -n "$roster_adapter$roster_label$roster_title" && -n "$roster_title" ]] || continue
          [[ "$roster_adapter" != "claude-private" ]] || continue
          if printf '%s\n' "$snapshot" | awk -F'|' -v t="$roster_title" \
              '$3 == t && $4 == "0" { found=1 } END { exit(found ? 0 : 1) }'; then
            candidate_titles+="${candidate_titles:+$'\n'}${roster_title}"
          fi
        done < <(printf '%s\n' "$LEAD_ROSTER_ROWS")
      fi
      candidate_titles=$(printf '%s\n' "$candidate_titles" | sed '/^$/d' | sort -u)
      ;;
    dead)
      if derive_lead_roster && [[ "$LEAD_ROSTER_STATE" == "ok" ]]; then
        candidate_titles=$(printf '%s\n' "$LEAD_ROSTER_ROWS" | awk -F'|' \
          '$1 != "claude-private" && NF >= 3 { print $3 }' | sort -u)
      else
        # Dead-title discovery is optional. A partial Lead manifest must not
        # defer reconciliation for every unrelated title on every pass.
        candidate_titles=""
      fi
      ;;
    *) return 2 ;;
  esac
  while IFS= read -r title; do
    [[ -n "$title" ]] || continue
    canonical=$(managed_view_command_variants "${VIEW_PREFIX}${title}") || return 2
    candidates=$(workspace_title_candidates "$raw" "$title" "$canonical") || return 2
    candidate_count=$(printf '%s\n' "$candidates" | grep -c . || true)
    [[ "$candidate_count" == "1" ]] || continue
    IFS='|' read -r candidate_kind ref pinned selected number < <(printf '%s\n' "$candidates")
    case "$candidate_kind" in
      named) ;;
      raw) continue ;;
      *) return 2 ;;
    esac
    restored_inflight_state "$generation" "$ref" "$title" && continue
    rc=$?
    [[ "$rc" -eq 1 ]] || return 2
    state=$(ledger_candidate_receipt_state "$generation" "$ref" "$title") || continue
    kind=""
    case "$mode:$state" in
      live:none) kind=W1 ;;
      live:prepared) kind=W1p ;;
      dead:none) kind=W1dead ;;
      *) continue ;;
    esac
    probe_rc=0
    _restored_candidate_probe "$kind" "$generation" "$ref" "$title" || probe_rc=$?
    [[ "$probe_rc" -eq 0 ]] || continue
    _restored_marker_upsert "$kind" "$generation" "$ref" "$title" "$state" \
      "$RESTORED_PROBE_FINGERPRINT" || return 1
  done < <(printf '%s\n' "$candidate_titles")
  return 0
}

_GUARD_LEDGER_GENERATION=""
_GUARD_LEDGER_REF=""
_GUARD_LEDGER_TITLE=""
_GUARD_LEDGER_UUID=""
_GUARD_LEDGER_STATE="committed"
_GUARD_LEDGER_EXTRA_GUARD=""
_ledger_close_guard() {
  local current receipt_state receipt_uuid raw matches
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$_GUARD_LEDGER_GENERATION" ]] || return 1
  receipt_state=$(ledger_exact_receipt_state \
    "$current" "$_GUARD_LEDGER_REF" "$_GUARD_LEDGER_TITLE") || return 1
  [[ "$receipt_state" == "$_GUARD_LEDGER_STATE" ]] || return 1
  receipt_uuid=$(ledger_exact_receipt_uuid \
    "$current" "$_GUARD_LEDGER_REF" "$_GUARD_LEDGER_TITLE") || return 1
  if [[ -n "$_GUARD_LEDGER_UUID" ]]; then
    [[ "$receipt_uuid" == "$_GUARD_LEDGER_UUID" ]] || return 1
  else
    [[ "$receipt_uuid" == "__LEGACY__" ]] || return 1
  fi
  raw=$(get_cmux_workspaces_json) || return 1
  matches=$(printf '%s' "$raw" | python3 -c '
import json,sys
r,t,u=sys.argv[1:4]
print(sum(1 for w in json.load(sys.stdin).get("workspaces", [])
          if w.get("ref") == r and w.get("title") == t
          and (not u or w.get("id") == u)))
' "$_GUARD_LEDGER_REF" "$_GUARD_LEDGER_TITLE" "$_GUARD_LEDGER_UUID") || return 1
  [[ "$matches" == "1" ]] || return 1
  if [[ -n "${_GUARD_LEDGER_EXTRA_GUARD:-}" ]]; then
    "$_GUARD_LEDGER_EXTRA_GUARD" || return 1
    # The extra guard may perform multiple JSON/tmux IPCs. Re-read the exact
    # object afterwards so neither title drift nor ref reuse during that probe
    # can inherit the receipt.
    raw=$(get_cmux_workspaces_json) || return 1
    matches=$(printf '%s' "$raw" | python3 -c '
import json,sys
r,t,u=sys.argv[1:4]
print(sum(1 for w in json.load(sys.stdin).get("workspaces", [])
          if w.get("ref") == r and w.get("title") == t
          and (not u or w.get("id") == u)))
' "$_GUARD_LEDGER_REF" "$_GUARD_LEDGER_TITLE" "$_GUARD_LEDGER_UUID") || return 1
    [[ "$matches" == "1" ]] || return 1
  fi
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$_GUARD_LEDGER_GENERATION" ]]
}

close_ledger_workspace_ref() {
  local generation="$1" ref="$2" title="$3" reason="$4" extra_guard="${5:-}" \
    expected_state="${6:-committed}" rc=0 restored_rc=0 receipt_uuid
  case "$expected_state" in prepared|committed) ;; *) return 1 ;; esac
  if cmux_wal_title_blocked "$title"; then
    _restored_recovery_cap_clear
    log "WARN: workspace close blocked by preserved construction collision: title=$title ref=$ref"
    return 1
  fi
  restored_inflight_state "$generation" "$ref" "$title" || restored_rc=$?
  case "$restored_rc" in
    0)
      if ! _restored_recovery_cap_valid "$generation" "$ref" "$title"; then
        _restored_recovery_cap_clear
        log "WARN: workspace close blocked by restored in-flight transaction: title=$title ref=$ref"
        return 1
      fi
      ;;
    1)
      _restored_recovery_cap_clear
      ;;
    *)
      _restored_recovery_cap_clear
      log "WARN: workspace close blocked by malformed/unreadable restored transaction state: title=$title ref=$ref"
      return 1
      ;;
  esac
  _GUARD_LEDGER_GENERATION="$generation"
  _GUARD_LEDGER_REF="$ref"
  _GUARD_LEDGER_TITLE="$title"
  _GUARD_LEDGER_STATE="$expected_state"
  receipt_uuid=$(ledger_exact_receipt_uuid "$generation" "$ref" "$title") || return 1
  _GUARD_LEDGER_UUID=""
  [[ "$receipt_uuid" == "__LEGACY__" ]] || _GUARD_LEDGER_UUID="$receipt_uuid"
  _GUARD_LEDGER_EXTRA_GUARD="$extra_guard"
  log "[audit] guarded close workspace=$ref title=$title reason=$reason"
  cmux_call_guarded_close_with_attach_reap "$ref" "$_GUARD_LEDGER_UUID" \
    _ledger_close_guard || rc=$?
  _GUARD_LEDGER_EXTRA_GUARD=""
  if [[ "$GUARD_WAS_BLOCKED" == "1" || "$rc" -ne 0 ]]; then
    _restored_recovery_cap_clear
    return 1
  fi
  if ! _ledger_remove "$generation" "$ref"; then
    _restored_recovery_cap_clear
    return 1
  fi
  _restored_recovery_cap_clear
  return 0
}

_GUARD_ROLLBACK_GENERATION=""
_GUARD_ROLLBACK_REF=""
_GUARD_ROLLBACK_PROVISIONAL_TITLE=""
_GUARD_ROLLBACK_UUID=""
_rollback_unreceipted_guard() {
  local current raw matches
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$_GUARD_ROLLBACK_GENERATION" ]] || return 1
  raw=$(get_cmux_workspaces_json) || return 1
  matches=$(printf '%s' "$raw" | python3 -c '
import json,re,sys
r,p,u=sys.argv[1:4]
variants=set(p.splitlines())
default=re.compile(r"^Terminal [0-9]+$")
print(sum(1 for w in json.load(sys.stdin).get("workspaces", [])
          if w.get("ref") == r
          and (not u or w.get("id") == u)
          and (w.get("title") in (None, "", "~")
               or w.get("title") in variants
               or (u and isinstance(w.get("title"), str) and default.fullmatch(w["title"])))))
' "$_GUARD_ROLLBACK_REF" "$_GUARD_ROLLBACK_PROVISIONAL_TITLE" "$_GUARD_ROLLBACK_UUID") || return 1
  [[ "$matches" == "1" ]] || return 1
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$_GUARD_ROLLBACK_GENERATION" ]]
}

_GUARD_CREATE_GENERATION=""
_create_generation_guard() {
  local current
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$_GUARD_CREATE_GENERATION" ]]
}

_GUARD_RENAME_GENERATION=""
_GUARD_RENAME_REF=""
_GUARD_RENAME_TITLE=""
_GUARD_RENAME_PROVISIONAL_TITLE=""
_GUARD_RENAME_UUID=""
_prepared_rename_guard() {
  local current raw matches
  GUARD_BLOCK_RC=0
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$_GUARD_RENAME_GENERATION" ]] \
    || { GUARD_BLOCK_RC=1; return 1; }
  [[ -f "$VIEW_LEDGER" ]] || { GUARD_BLOCK_RC=1; return 1; }
  awk -F'|' -v g="$_GUARD_RENAME_GENERATION" -v r="$_GUARD_RENAME_REF" \
    -v t="$_GUARD_RENAME_TITLE" -v u="$_GUARD_RENAME_UUID" '
    $1 == "prepared" && $2 == g && $3 == r && $4 == t \
      && ((u == "" && NF == 4) || (u != "" && NF == 5 && $5 == u)) { n++ }
    END { exit(n == 1 ? 0 : 1) }
  ' \
    "$VIEW_LEDGER" || { GUARD_BLOCK_RC=1; return 1; }
  raw=$(get_cmux_workspaces_json) || { GUARD_BLOCK_RC=1; return 1; }
  matches=$(printf '%s' "$raw" | python3 -c '
import json,re,sys
r,p,u=sys.argv[1:4]
variants=set(p.splitlines())
default=re.compile(r"^Terminal [0-9]+$")
print(sum(1 for w in json.load(sys.stdin).get("workspaces", [])
          if w.get("ref") == r
          and (not u or w.get("id") == u)
          and (w.get("title") in (None, "", "~")
               or w.get("title") in variants
               or (u and isinstance(w.get("title"), str) and default.fullmatch(w["title"])))))
' "$_GUARD_RENAME_REF" "$_GUARD_RENAME_PROVISIONAL_TITLE" "$_GUARD_RENAME_UUID") \
    || { GUARD_BLOCK_RC=1; return 1; }
  [[ "$matches" == "1" ]] || { GUARD_BLOCK_RC=3; return 1; }
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$_GUARD_RENAME_GENERATION" ]] \
    || { GUARD_BLOCK_RC=1; return 1; }
}

rollback_unreceipted_workspace() {
  # Called synchronously after one exact refs_before/refs_after diff. The ref is
  # still unnamed and was created by this attempt, so the generation + exact-ref
  # readback is sufficient same-authority rollback; title is never authority.
  local generation="$1" ref="$2" provisional_title="${3:-}" workspace_uuid="${4:-}" rc=0 view variants
  [[ -z "$workspace_uuid" ]] || _workspace_uuid_valid "$workspace_uuid" || return 1
  _GUARD_ROLLBACK_GENERATION="$generation"
  _GUARD_ROLLBACK_REF="$ref"
  view=$(managed_view_command_parse "$provisional_title" 2>/dev/null || true)
  if [[ -n "$view" ]]; then
    variants=$(managed_view_command_variants "$view") || return 1
    # v2 commands carry an incarnation token that the legacy variant list
    # intentionally cannot predict. Keep the exact command signed by this
    # create transaction alongside the target-normalized migration variants.
    _GUARD_ROLLBACK_PROVISIONAL_TITLE="${provisional_title}"$'\n'"${variants}"
  else
    _GUARD_ROLLBACK_PROVISIONAL_TITLE="$provisional_title"
  fi
  _GUARD_ROLLBACK_UUID="$workspace_uuid"
  log "[audit] rolling back unreceipted workspace generation=$generation ref=$ref"
  cmux_call_guarded_close_with_attach_reap "$ref" "$_GUARD_ROLLBACK_UUID" \
    _rollback_unreceipted_guard || rc=$?
  [[ "$GUARD_WAS_BLOCKED" == "0" && "$rc" -eq 0 ]]
}

_GUARD_PREPARED_LOSER_GENERATION=""
_GUARD_PREPARED_LOSER_REF=""
_GUARD_PREPARED_LOSER_OWNER_REF=""
_GUARD_PREPARED_LOSER_TITLE=""
_GUARD_PREPARED_LOSER_PROVISIONAL=""
_prepared_loser_close_guard() {
  local current observed
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$_GUARD_PREPARED_LOSER_GENERATION" ]] || return 1
  awk -F'|' -v g="$current" -v r="$_GUARD_PREPARED_LOSER_REF" -v t="$_GUARD_PREPARED_LOSER_TITLE" \
    '(NF == 4 || NF == 5) && $1 == "prepared" && $2 == g && $3 == r && $4 == t { n++ } END { exit(n == 1 ? 0 : 1) }' \
    "$VIEW_LEDGER" || return 1
  awk -F'|' -v g="$current" -v r="$_GUARD_PREPARED_LOSER_OWNER_REF" -v t="$_GUARD_PREPARED_LOSER_TITLE" \
    '(NF == 4 || NF == 5) && $1 == "committed" && $2 == g && $3 == r && $4 == t { n++ } END { exit(n == 1 ? 0 : 1) }' \
    "$VIEW_LEDGER" || return 1
  observed=$(workspace_title_for_ref "$_GUARD_PREPARED_LOSER_REF") || return 1
  [[ "$observed" == "$_GUARD_PREPARED_LOSER_TITLE" ]] \
    || _managed_view_command_in_variants "$observed" "$_GUARD_PREPARED_LOSER_PROVISIONAL" || return 1
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$_GUARD_PREPARED_LOSER_GENERATION" ]]
}

close_prepared_loser_ref() {
  local generation="$1" loser_ref="$2" owner_ref="$3" title="$4" provisional rc=0 restored_rc=0
  restored_inflight_state "$generation" "$loser_ref" "$title" || restored_rc=$?
  if [[ "$restored_rc" -eq 0 || "$restored_rc" -eq 2 ]]; then
    log "WARN: prepared loser close blocked by restored transaction state title=$title ref=$loser_ref rc=$restored_rc"
    return 1
  fi
  provisional=$(managed_view_command_variants "${VIEW_PREFIX}${title}") || return 1
  _GUARD_PREPARED_LOSER_GENERATION="$generation"
  _GUARD_PREPARED_LOSER_REF="$loser_ref"
  _GUARD_PREPARED_LOSER_OWNER_REF="$owner_ref"
  _GUARD_PREPARED_LOSER_TITLE="$title"
  _GUARD_PREPARED_LOSER_PROVISIONAL="$provisional"
  cmux_call_guarded_close_with_attach_reap "$loser_ref" "" \
    _prepared_loser_close_guard || rc=$?
  [[ "$GUARD_WAS_BLOCKED" == "0" && "$rc" -eq 0 ]] || return 1
  _ledger_remove "$generation" "$loser_ref" || return 1
  _alert_cmux_cleanup \
    "cmux rename-lag loser closed" \
    "A historical prepared workspace lost the exact generation/title claim to a committed ref and was closed by exact ref: generation=$generation title=$title loser=$loser_ref owner=$owner_ref." \
    "cmux_cleanup|ledger-prepared-loser-closed|$title|$loser_ref"
}

# FLY-1605: read one exact workspace title. A ref that is absent, duplicated,
# malformed, or whose title is not a string is not mutation authority.
workspace_title_for_ref() {
  local ref="$1" raw
  raw=$(get_cmux_workspaces_json) || return 1
  printf '%s' "$raw" | python3 -c '
import json,sys
r=sys.argv[1]
matches=[w for w in json.load(sys.stdin).get("workspaces", [])
         if isinstance(w, dict) and w.get("ref") == r]
if len(matches) != 1 or not isinstance(matches[0].get("title"), str):
    sys.exit(1)
title=matches[0]["title"]
if not title or "\n" in title or "\r" in title:
    sys.exit(1)
print(title)
' "$ref" || return 1
}

workspace_identity_matches() {
  local ref="$1" title="$2" workspace_uuid="$3" raw matches
  _workspace_uuid_valid "$workspace_uuid" || return 1
  raw=$(get_cmux_workspaces_json) || return 1
  matches=$(printf '%s' "$raw" | python3 -c '
import json,sys
r,t,u=sys.argv[1:4]
print(sum(1 for w in json.load(sys.stdin).get("workspaces", [])
          if w.get("ref") == r and w.get("title") == t and w.get("id") == u))
' "$ref" "$title" "$workspace_uuid") || return 1
  [[ "$matches" == "1" ]]
}

# Immutable ref/UUID join when the workspace is intentionally still on its
# staging title. Title is excluded here and must be fenced independently by
# the caller before any mutation.
workspace_ref_uuid_matches() {
  local ref="$1" workspace_uuid="$2" raw matches
  _workspace_uuid_valid "$workspace_uuid" || return 1
  raw=$(get_cmux_workspaces_json) || return 1
  matches=$(printf '%s' "$raw" | python3 -c '
import json,sys
r,u=sys.argv[1:3]
print(sum(1 for w in json.load(sys.stdin).get("workspaces", [])
          if isinstance(w,dict) and w.get("ref") == r and w.get("id") == u))
' "$ref" "$workspace_uuid") || return 1
  [[ "$matches" == 1 ]]
}

# FLY-1605: title migration is defined only for the ordinary one-surface cmux
# workspace shape observed in production. Multiple/zero surfaces, bad schema,
# or a non-string title fail closed rather than guessing which tab to rename.
workspace_single_surface_title() {
  local ref="$1" raw
  raw=$(cmux_call --json list-pane-surfaces --workspace "$ref") || return 1
  printf '%s' "$raw" | python3 -c '
import json,sys
try:
    data=json.load(sys.stdin)
    surfaces=data.get("surfaces")
    if not isinstance(surfaces, list) or len(surfaces) != 1:
        sys.exit(1)
    title=surfaces[0].get("title") if isinstance(surfaces[0], dict) else None
    if not isinstance(title, str) or not title or "\n" in title or "\r" in title:
        sys.exit(1)
    print(title)
except Exception:
    sys.exit(1)
' || return 1
}

# Print the unique current-generation receipt state for one exact logical
# workspace. Duplicate/conflicting rows are deliberately non-authoritative.
ledger_exact_receipt_state() {
  local generation="$1" ref="$2" title="$3"
  [[ -f "$VIEW_LEDGER" ]] || return 1
  awk -F'|' -v g="$generation" -v r="$ref" -v t="$title" '
    (NF == 4 || NF == 5) && ($1 == "prepared" || $1 == "committed") \
      && $2 == g && $3 == r && $4 == t { n++; state=$1 }
    END { if (n == 1) print state; else exit 1 }
  ' "$VIEW_LEDGER"
}

ledger_exact_receipt_uuid() {
  local generation="$1" ref="$2" title="$3" workspace_uuid
  [[ -f "$VIEW_LEDGER" ]] || return 1
  workspace_uuid=$(awk -F'|' -v g="$generation" -v r="$ref" -v t="$title" '
    (NF == 4 || NF == 5) && ($1 == "prepared" || $1 == "committed") \
      && $2 == g && $3 == r && $4 == t { n++; fields=NF; uuid=$5 }
    END {
      if (n != 1) exit 1
      if (fields == 4) print "__LEGACY__"
      else print uuid
    }
  ' "$VIEW_LEDGER") || return 1
  [[ "$workspace_uuid" == "__LEGACY__" ]] || _workspace_uuid_valid "$workspace_uuid" || return 1
  printf '%s\n' "$workspace_uuid"
}

_GUARD_TITLE_GENERATION=""
_GUARD_TITLE_REF=""
_GUARD_TITLE=""
_GUARD_TITLE_RAW=""
_GUARD_TITLE_UUID=""
_title_tab_rename_guard() {
  local current receipt receipt_uuid workspace surface
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$_GUARD_TITLE_GENERATION" ]] || return 1
  receipt=$(ledger_exact_receipt_state "$current" "$_GUARD_TITLE_REF" "$_GUARD_TITLE") || return 1
  case "$receipt" in prepared|committed) ;; *) return 1 ;; esac
  receipt_uuid=$(ledger_exact_receipt_uuid "$current" "$_GUARD_TITLE_REF" "$_GUARD_TITLE") || return 1
  if [[ -n "$_GUARD_TITLE_UUID" ]]; then
    [[ "$receipt_uuid" == "$_GUARD_TITLE_UUID" ]] || return 1
    workspace_identity_matches \
      "$_GUARD_TITLE_REF" "$_GUARD_TITLE" "$_GUARD_TITLE_UUID" || return 1
  else
    [[ "$receipt_uuid" == "__LEGACY__" ]] || return 1
    workspace=$(workspace_title_for_ref "$_GUARD_TITLE_REF") || return 1
    [[ "$workspace" == "$_GUARD_TITLE" ]] || return 1
  fi
  surface=$(workspace_single_surface_title "$_GUARD_TITLE_REF") || return 1
  _managed_view_command_in_variants "$surface" "$_GUARD_TITLE_RAW" || return 1
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$_GUARD_TITLE_GENERATION" ]]
}

# FLY-1605 shared completion state machine. The caller must already own one
# exact prepared/committed receipt; this helper never mints a receipt and never
# demotes committed authority. It commits only after both founder-visible title
# surfaces read back as the canonical tmux window name.
complete_title_migration() {
  local ref="$1" title="$2" generation="$3" canonical_raw="$4"
  local receipt receipt_uuid workspace_uuid="" workspace surface current rc=0 restored_rc=0
  restored_inflight_state "$generation" "$ref" "$title" || restored_rc=$?
  if [[ "$restored_rc" -eq 0 || "$restored_rc" -eq 2 ]]; then
    log "WARN: title migration blocked by restored transaction state generation=$generation ref=$ref title=$title rc=$restored_rc"
    return 1
  fi
  receipt=$(ledger_exact_receipt_state "$generation" "$ref" "$title") || {
    log "WARN: title migration lacks unique receipt generation=$generation ref=$ref title=$title"
    return 1
  }
  receipt_uuid=$(ledger_exact_receipt_uuid "$generation" "$ref" "$title") || {
    log "WARN: title migration has malformed receipt identity generation=$generation ref=$ref title=$title"
    return 1
  }
  [[ "$receipt_uuid" == "__LEGACY__" ]] || workspace_uuid="$receipt_uuid"
  if [[ -n "$workspace_uuid" ]]; then
    workspace_identity_matches "$ref" "$title" "$workspace_uuid" || {
      log "WARN: title migration workspace identity drift ref=$ref title=$title"
      return 1
    }
  else
    workspace=$(workspace_title_for_ref "$ref") || {
      log "WARN: title migration cannot read exact workspace ref=$ref title=$title"
      return 1
    }
    [[ "$workspace" == "$title" ]] || {
      log "WARN: title migration workspace drift ref=$ref expected=$title observed=$workspace"
      return 1
    }
  fi
  surface=$(workspace_single_surface_title "$ref") || {
    log "WARN: title migration cannot prove one surface ref=$ref title=$title"
    return 1
  }
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$generation" ]] || return 1

  if [[ "$surface" == "$title" ]]; then
    if [[ "$receipt" == "prepared" ]]; then
      current=$(cmux_socket_identity)
      [[ -n "$current" && "$current" == "$generation" ]] || return 1
      [[ -z "$workspace_uuid" ]] \
        || workspace_identity_matches "$ref" "$title" "$workspace_uuid" || return 1
      current=$(cmux_socket_identity)
      [[ -n "$current" && "$current" == "$generation" ]] || return 1
      _ledger_upsert committed "$generation" "$ref" "$title" "$workspace_uuid" || return 1
    fi
    return 0
  fi
  if ! _managed_view_command_in_variants "$surface" "$canonical_raw"; then
    log "WARN: title migration surface drift ref=$ref expected_raw=$canonical_raw observed=$surface; preserving receipt"
    return 1
  fi

  _GUARD_TITLE_GENERATION="$generation"
  _GUARD_TITLE_REF="$ref"
  _GUARD_TITLE="$title"
  _GUARD_TITLE_RAW="$canonical_raw"
  _GUARD_TITLE_UUID="$workspace_uuid"
  cmux_call_guarded _title_tab_rename_guard \
    rename-tab --workspace "$ref" "$title" || rc=$?
  if [[ "$GUARD_WAS_BLOCKED" == "1" || "$rc" -ne 0 ]]; then
    log "WARN: guarded rename-tab deferred ref=$ref title=$title"
    return 1
  fi
  surface=$(workspace_single_surface_title "$ref") || return 1
  current=$(cmux_socket_identity)
  [[ "$current" == "$generation" && "$surface" == "$title" ]] || {
    log "WARN: rename-tab readback mismatch ref=$ref title=$title observed=$surface; preserving receipt"
    return 1
  }
  if [[ "$receipt" == "prepared" ]]; then
    [[ -z "$_GUARD_TITLE_UUID" ]] \
      || workspace_identity_matches "$ref" "$title" "$_GUARD_TITLE_UUID" || return 1
    current=$(cmux_socket_identity)
    [[ -n "$current" && "$current" == "$generation" ]] || return 1
    _ledger_upsert committed "$generation" "$ref" "$title" "$_GUARD_TITLE_UUID" || return 1
  fi
  return 0
}

# Prove that one roster row is still the exact live source of its canonical
# cmux view. The strict A0B1 shape uses the existing exact matcher; the legacy
# grouped shape is accepted for preservation only and must still contain the
# same live window object. This function is read-only.
title_source_authorized() {
  local source="$1" wid="$2" title="$3" view="${VIEW_PREFIX}${title}"
  local snapshot sid grouped active owner marker members observed name dead group
  case "$source" in
    "$FLYWHEEL_SESSION"|runner-*) ;;
    *) return 1 ;;
  esac
  window_source_pane_alive "$source" "$wid" || return 1
  if _linked_view_matches "$view" "$wid" "$source" "" "$title"; then
    return 0
  fi

  snapshot=$(_view_session_snapshot "$view") || return 1
  IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
  [[ "$grouped" == "1" ]] || return 1
  case ",$members," in *,"$wid",*) ;; *) return 1 ;; esac
  group=$(tmux display-message -p -t "=${view}:" '#{session_group}' 2>/dev/null) || return 1
  [[ "$group" == "$source" ]] || return 1
  [[ -z "$owner" || "$owner" == "$source" ]] || return 1
  [[ -z "$marker" || "$marker" == "0" ]] || return 1
  observed=$(tmux display-message -p -t "=${view}:${wid}" \
    '#{window_name}|#{pane_dead}' 2>/dev/null) || return 1
  IFS='|' read -r name dead < <(printf '%s\n' "$observed")
  [[ "$name" == "$title" && "$dead" == "0" ]]
}

# Unlike ledger_exact_receipt_state, this distinguishes an absent receipt from
# a conflicting current-generation claim. Conflicts must never be treated as
# unowned stock because minting a new prepared row would convert ambiguity into
# mutation authority.
ledger_candidate_receipt_state() {
  local generation="$1" ref="$2" title="$3"
  [[ -f "$VIEW_LEDGER" ]] || { printf 'none\n'; return 0; }
  awk -F'|' -v g="$generation" -v r="$ref" -v t="$title" '
    (NF == 4 || NF == 5) && ($1 == "prepared" || $1 == "committed") && $2 == g && $3 == r {
      n++; state=$1; observed=$4
    }
    END {
      if (n == 0) print "none"
      else if (n == 1 && observed == t) print state
      else print "conflict"
    }
  ' "$VIEW_LEDGER"
}

# Read-only stock authorization. A receipt is deliberately minted only after
# all topology and both cmux title faces have been proved under one generation.
authorize_stock_candidate() {
  local source="$1" wid="$2" title="$3" generation="$4" ref="$5" raw="$6"
  local current workspace surface
  title_source_authorized "$source" "$wid" "$title" || return 1
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$generation" ]] || return 1
  workspace=$(workspace_title_for_ref "$ref") || return 1
  [[ "$workspace" == "$title" ]] \
    || _managed_view_command_in_variants "$workspace" "$raw" || return 1
  surface=$(workspace_single_surface_title "$ref") || return 1
  [[ "$surface" == "$title" ]] \
    || _managed_view_command_in_variants "$surface" "$raw" || return 1
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$generation" ]]
}

_GUARD_BIRTH_SOURCE=""
_GUARD_BIRTH_WID=""
_GUARD_BIRTH_GENERATION=""
_GUARD_BIRTH_REF=""
_GUARD_BIRTH_TITLE=""
_GUARD_BIRTH_UUID=""
_GUARD_BIRTH_RECORD=""
_birth_adoption_guard() {
  local current receipt receipt_uuid observed
  [[ "${REBIND_GUARD_ACTIVE:-0}" != 1 ]] || rebind_mutation_authority_current || return 1
  title_source_authorized "$_GUARD_BIRTH_SOURCE" "$_GUARD_BIRTH_WID" \
    "$_GUARD_BIRTH_TITLE" || return 1
  current=$(cmux_socket_identity) || return 1
  [[ "$current" == "$_GUARD_BIRTH_GENERATION" ]] || return 1
  receipt=$(ledger_exact_receipt_state "$current" "$_GUARD_BIRTH_REF" \
    "$_GUARD_BIRTH_TITLE" 2>/dev/null) || return 1
  case "$receipt" in prepared|committed) ;; *) return 1 ;; esac
  receipt_uuid=$(ledger_exact_receipt_uuid "$current" "$_GUARD_BIRTH_REF" \
    "$_GUARD_BIRTH_TITLE") || return 1
  [[ "$receipt_uuid" == "$_GUARD_BIRTH_UUID" ]] || return 1
  observed=$(cmux_workspace_birth_record "$_GUARD_BIRTH_REF" "$_GUARD_BIRTH_UUID") || return 1
  [[ "$observed" == "$_GUARD_BIRTH_RECORD" ]] || return 1
  current=$(cmux_socket_identity) || return 1
  [[ "$current" == "$_GUARD_BIRTH_GENERATION" ]]
}

adopt_birth_candidate() {
  local source="$1" wid="$2" title="$3" generation="$4" ref="$5" expected_kind="$6" expected_target_b64="$7"
  local birth workspace_uuid title_b64 _surface kind target_b64 _token state receipt_uuid workspace surface rc=0 current legacy_upgrade=0
  birth=$(cmux_workspace_birth_record "$ref") || return 1
  IFS='|' read -r _ workspace_uuid title_b64 _surface kind target_b64 _token < <(printf '%s\n' "$birth")
  [[ "$kind" == "$expected_kind" && "$target_b64" == "$expected_target_b64" ]] || return 1
  title_source_authorized "$source" "$wid" "$title" || return 1
  state=$(ledger_candidate_receipt_state "$generation" "$ref" "$title") || return 1
  cmux_adoption_slot_claim || {
    log "WARN: view birth adoption deferred by per-pass cap title=$title ref=$ref"
    return 1
  }
  case "$state" in
    none) _ledger_upsert prepared "$generation" "$ref" "$title" "$workspace_uuid" || return 1 ;;
    prepared)
      [[ "$(ledger_exact_receipt_uuid "$generation" "$ref" "$title" 2>/dev/null || true)" == "$workspace_uuid" ]] || return 1
      ;;
    committed)
      receipt_uuid=$(ledger_exact_receipt_uuid "$generation" "$ref" "$title") || return 1
      if [[ "$receipt_uuid" == __LEGACY__ ]]; then
        legacy_upgrade=1
      else
        [[ "$receipt_uuid" == "$workspace_uuid" ]] || return 1
      fi
      ;;
    *) return 1 ;;
  esac
  _GUARD_BIRTH_SOURCE="$source"; _GUARD_BIRTH_WID="$wid"
  _GUARD_BIRTH_GENERATION="$generation"; _GUARD_BIRTH_REF="$ref"
  _GUARD_BIRTH_TITLE="$title"; _GUARD_BIRTH_UUID="$workspace_uuid"
  _GUARD_BIRTH_RECORD="$birth"
  workspace=$(workspace_title_for_ref "$ref") || return 1
  surface=$(workspace_single_surface_title "$ref") || return 1
  if [[ "$legacy_upgrade" == 1 ]]; then
    if [[ "$workspace" == "$title" ]]; then
      workspace_identity_matches "$ref" "$title" "$workspace_uuid" || return 1
    else
      workspace_ref_uuid_matches "$ref" "$workspace_uuid" || return 1
    fi
    current=$(cmux_socket_identity) || return 1
    [[ "$current" == "$generation" ]] || return 1
    _ledger_upgrade_legacy_uuid "$generation" "$ref" "$title" "$workspace_uuid" || return 1
    legacy_upgrade=0
  fi
  if [[ "$state" == committed && "$workspace" == "$title" && "$surface" == "$title" ]]; then
    return 0
  fi
  if [[ "$workspace" != "$title" ]]; then
    cmux_call_guarded _birth_adoption_guard rename-workspace --workspace "$ref" "$title" || rc=$?
    [[ "$rc" == 0 && "$GUARD_WAS_BLOCKED" != 1 ]] || return 1
  fi
  birth=$(cmux_workspace_birth_record "$ref" "$workspace_uuid") || return 1
  IFS='|' read -r _ _ title_b64 _ kind target_b64 _token < <(printf '%s\n' "$birth")
  [[ "$kind" == "$expected_kind" && "$target_b64" == "$expected_target_b64" \
      && "$(_attach_b64_decode "$title_b64")" == "$title" ]] || return 1
  _GUARD_BIRTH_RECORD="$birth"
  surface=$(workspace_single_surface_title "$ref") || return 1
  if [[ "$surface" != "$title" ]]; then
    rc=0
    cmux_call_guarded _birth_adoption_guard rename-tab --workspace "$ref" "$title" || rc=$?
    [[ "$rc" == 0 && "$GUARD_WAS_BLOCKED" != 1 ]] || return 1
  fi
  [[ "$(workspace_title_for_ref "$ref")" == "$title" \
      && "$(workspace_single_surface_title "$ref")" == "$title" ]] || return 1
  current=$(cmux_socket_identity) || return 1
  [[ "$current" == "$generation" ]] || return 1
  _ledger_upsert committed "$generation" "$ref" "$title" "$workspace_uuid"
}

_GUARD_STOCK_SOURCE=""
_GUARD_STOCK_WID=""
_GUARD_STOCK_GENERATION=""
_GUARD_STOCK_REF=""
_GUARD_STOCK_TITLE=""
_GUARD_STOCK_RAW=""
_stock_workspace_rename_guard() {
  local current receipt workspace surface
  title_source_authorized "$_GUARD_STOCK_SOURCE" "$_GUARD_STOCK_WID" \
    "$_GUARD_STOCK_TITLE" || return 1
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$_GUARD_STOCK_GENERATION" ]] || return 1
  receipt=$(ledger_candidate_receipt_state "$current" "$_GUARD_STOCK_REF" \
    "$_GUARD_STOCK_TITLE") || return 1
  case "$receipt" in prepared|committed) ;; *) return 1 ;; esac
  workspace=$(workspace_title_for_ref "$_GUARD_STOCK_REF") || return 1
  _managed_view_command_in_variants "$workspace" "$_GUARD_STOCK_RAW" || return 1
  surface=$(workspace_single_surface_title "$_GUARD_STOCK_REF") || return 1
  [[ "$surface" == "$_GUARD_STOCK_TITLE" ]] \
    || _managed_view_command_in_variants "$surface" "$_GUARD_STOCK_RAW" || return 1
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$_GUARD_STOCK_GENERATION" ]]
}

rename_stock_workspace() {
  local source="$1" wid="$2" title="$3" generation="$4" ref="$5" raw="$6"
  local observed current rc=0
  _GUARD_STOCK_SOURCE="$source"
  _GUARD_STOCK_WID="$wid"
  _GUARD_STOCK_GENERATION="$generation"
  _GUARD_STOCK_REF="$ref"
  _GUARD_STOCK_TITLE="$title"
  _GUARD_STOCK_RAW="$raw"
  cmux_call_guarded _stock_workspace_rename_guard \
    rename-workspace --workspace "$ref" "$title" || rc=$?
  if [[ "$GUARD_WAS_BLOCKED" == "1" || "$rc" -ne 0 ]]; then
    log "WARN: guarded stock rename-workspace deferred ref=$ref title=$title"
    return 1
  fi
  observed=$(workspace_title_for_ref "$ref") || return 1
  current=$(cmux_socket_identity)
  [[ "$current" == "$generation" && "$observed" == "$title" ]] || {
    log "WARN: stock rename-workspace readback mismatch ref=$ref title=$title observed=$observed"
    return 1
  }
}

title_keeper_ready() {
  local generation="$1" ref="$2" title="$3" current workspace surface
  [[ "$(ledger_candidate_receipt_state "$generation" "$ref" "$title")" == "committed" ]] || return 1
  workspace=$(workspace_title_for_ref "$ref") || return 1
  [[ "$workspace" == "$title" ]] || return 1
  surface=$(workspace_single_surface_title "$ref") || return 1
  [[ "$surface" == "$title" ]] || return 1
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$generation" ]]
}

_GUARD_DUP_SOURCE=""
_GUARD_DUP_WID=""
_GUARD_DUP_GENERATION=""
_GUARD_DUP_KEEPER_REF=""
_GUARD_DUP_EXTRA_REF=""
_GUARD_DUP_TITLE=""
_GUARD_DUP_RAW=""
_GUARD_DUP_TARGET_B64=""
_GUARD_DUP_BIRTHS=""
_fly1605_duplicate_close_guard() {
  local current keeper_liveness extra_liveness
  title_source_authorized "$_GUARD_DUP_SOURCE" "$_GUARD_DUP_WID" \
    "$_GUARD_DUP_TITLE" || return 1
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$_GUARD_DUP_GENERATION" ]] || return 1
  title_keeper_ready "$current" "$_GUARD_DUP_KEEPER_REF" "$_GUARD_DUP_TITLE" || return 1
  keeper_liveness=$(workspace_attach_liveness "$_GUARD_DUP_KEEPER_REF" view "$_GUARD_DUP_TARGET_B64" "$_GUARD_DUP_BIRTHS") || return 1
  extra_liveness=$(workspace_attach_liveness "$_GUARD_DUP_EXTRA_REF" view "$_GUARD_DUP_TARGET_B64" "$_GUARD_DUP_BIRTHS") || return 1
  [[ "$keeper_liveness" == live && "$extra_liveness" == dead ]] || return 1
  current=$(cmux_socket_identity)
  [[ -n "$current" && "$current" == "$_GUARD_DUP_GENERATION" ]]
}

_GUARD_FLIP_SOURCE=""
_GUARD_FLIP_WID=""
_GUARD_FLIP_GENERATION=""
_GUARD_FLIP_KEEPER_REF=""
_GUARD_FLIP_EXTRA_REF=""
_GUARD_FLIP_TITLE=""
_GUARD_FLIP_TARGET_B64=""
_GUARD_FLIP_BIRTHS=""
_duplicate_flip_close_guard() {
  local current keeper_liveness extra_liveness
  title_source_authorized "$_GUARD_FLIP_SOURCE" "$_GUARD_FLIP_WID" \
    "$_GUARD_FLIP_TITLE" || return 1
  current=$(cmux_socket_identity) || return 1
  [[ "$current" == "$_GUARD_FLIP_GENERATION" ]] || return 1
  keeper_liveness=$(workspace_attach_liveness "$_GUARD_FLIP_KEEPER_REF" view \
    "$_GUARD_FLIP_TARGET_B64" "$_GUARD_FLIP_BIRTHS") || return 1
  extra_liveness=$(workspace_attach_liveness "$_GUARD_FLIP_EXTRA_REF" view \
    "$_GUARD_FLIP_TARGET_B64" "$_GUARD_FLIP_BIRTHS") || return 1
  [[ "$keeper_liveness" == dead && "$extra_liveness" == live ]] || return 1
  current=$(cmux_socket_identity) || return 1
  [[ "$current" == "$_GUARD_FLIP_GENERATION" ]]
}

promote_live_duplicate() {
  local source="$1" wid="$2" title="$3" generation="$4" keeper_ref="$5" extra_ref="$6" target_b64="$7" births="${8:-}"
  : "$source" "$wid" "$generation" "$target_b64" "$births"
  _alert_cmux_cleanup "cmux view duplicate preserved (report-only)" \
    "A single render sample classified the committed keeper dead and a sibling live. Automatic close/promotion is disabled until a distinct-round activity proof exists: title=$title keeper=$keeper_ref sibling=$extra_ref." \
    "cmux_cleanup|view-duplicate-report-only|title=$title|keeper=$keeper_ref|sibling=$extra_ref"
  return 1
}

# Select one deterministic candidate. Input rows are
# kind|ref|pinned(0/1)|selected(0/1)|numeric-ref. The current generation's
# receipt rank leads the ordering; stale-generation rows are intentionally
# invisible. Prints kind|ref or returns 1 when every candidate is conflicted.
select_title_keeper() {
  local generation="$1" title="$2" rows="$3"
  local kind ref pinned selected number state receipt_rank
  local best_kind="" best_ref="" best_receipt=-1 best_pinned=-1 best_selected=-1 best_number=0
  while IFS='|' read -r kind ref pinned selected number; do
    [[ -n "$ref" ]] || continue
    state=$(ledger_candidate_receipt_state "$generation" "$ref" "$title") || continue
    case "$state" in
      committed) receipt_rank=2 ;;
      prepared) receipt_rank=1 ;;
      none) receipt_rank=0 ;;
      *) log "WARN: title stock candidate has conflicting receipt ref=$ref title=$title"; continue ;;
    esac
    if [[ -z "$best_ref" ]] \
        || (( receipt_rank > best_receipt )) \
        || (( receipt_rank == best_receipt && pinned > best_pinned )) \
        || (( receipt_rank == best_receipt && pinned == best_pinned && selected > best_selected )) \
        || (( receipt_rank == best_receipt && pinned == best_pinned && selected == best_selected && number < best_number )); then
      best_kind="$kind"; best_ref="$ref"; best_receipt=$receipt_rank
      best_pinned=$pinned; best_selected=$selected; best_number=$number
    fi
  done < <(printf '%s\n' "$rows")
  [[ -n "$best_ref" ]] || return 1
  printf '%s|%s\n' "$best_kind" "$best_ref"
}

workspace_title_candidates() {
  local raw_json="$1" title="$2" canonical_raw="$3"
  printf '%s' "$raw_json" | _cmux_carrier_classify candidates "$title" "$canonical_raw"
}

# Summarize the strict-parser-backed candidate set for read-only judges.
# Output: named-count|mapped-count|sole-named-ref-or-empty.
workspace_candidate_shape() {
  local raw_json="$1" title="$2" canonical_raw="$3" births="${4:-}" birth_kind="${5:-}" birth_target_b64="${6:-}"
  local rows birth_rows named mapped ref=""
  rows=$(workspace_title_candidates "$raw_json" "$title" "$canonical_raw") || return 1
  if [[ -n "$births" && -n "$birth_kind" && -n "$birth_target_b64" ]]; then
    birth_rows=$(workspace_birth_candidate_rows "$raw_json" "$births" \
      "$birth_kind" "$birth_target_b64" "$rows") || return 1
    rows+="${birth_rows:+${rows:+$'\n'}${birth_rows}}"
  fi
  mapped=$(printf '%s\n' "$rows" | grep -c . || true)
  named=$(printf '%s\n' "$rows" | awk -F'|' '$1 == "named" { n++ } END { print n+0 }')
  if [[ "$named" == 1 ]]; then
    ref=$(printf '%s\n' "$rows" | awk -F'|' '$1 == "named" { print $2; exit }')
  fi
  printf '%s|%s|%s\n' "$named" "$mapped" "$ref"
}

workspace_birth_candidate_rows() {
  local raw_json="$1" births="$2" kind="$3" target_b64="$4" existing="${5:-}"
  printf '%s' "$raw_json" | python3 -c '
import json,re,sys
births,kind,target,existing=sys.argv[1:5]
already={line.split("|")[1] for line in existing.splitlines() if len(line.split("|"))>=2}
refs={}
for line in births.splitlines():
    p=line.split("|")
    if len(p)==7 and p[4]==kind and p[5]==target:
        refs[p[0]]=p[1]
try: rows=json.load(sys.stdin).get("workspaces",[])
except Exception: raise SystemExit(2)
for w in rows:
    if not isinstance(w,dict): continue
    ref=w.get("ref",""); m=re.fullmatch(r"workspace:([0-9]+)",ref)
    if ref in refs and ref not in already and m and len(m.group(1))<=18:
        print("birth",ref,int(bool(w.get("pinned"))),int(bool(w.get("selected"))),m.group(1),sep="|")
' "$births" "$kind" "$target_b64" "$existing" || return 2
}

workspace_attach_liveness() {
  # stdout live|dead|bare|inconclusive. Ownership is always re-proved from the
  # birth command before screen content is interpreted; title shape alone is
  # never liveness evidence.
  local ref="$1" expected_kind="$2" expected_target_b64="$3" births="${4:-}"
  local birth kind target_b64 surface probe_rc=0 class row row_ref matches=0
  if [[ -n "$births" ]]; then
    while IFS= read -r row; do
      [[ -n "$row" ]] || continue
      row_ref="${row%%|*}"
      if [[ "$row_ref" == "$ref" ]]; then
        matches=$((matches + 1))
        birth="$row"
      fi
    done < <(printf '%s\n' "$births")
    [[ "$matches" == 1 ]] || { printf 'inconclusive\n'; return 0; }
  else
    birth=$(cmux_workspace_birth_record "$ref") || { printf 'inconclusive\n'; return 0; }
  fi
  IFS='|' read -r _ _ _ _ kind target_b64 _ < <(printf '%s\n' "$birth")
  [[ "$kind" == "$expected_kind" && "$target_b64" == "$expected_target_b64" ]] \
    || { printf 'inconclusive\n'; return 0; }
  surface=$(workspace_terminal_surface_ref "$ref") \
    || { printf 'inconclusive\n'; return 0; }
  surface_looks_like_bare_shell "$ref" "$surface" 1 || probe_rc=$?
  case "$probe_rc" in
    0) printf 'bare\n' ;;
    1)
      class=$(classify_dead_view_screen "$SURFACE_LAST_SCREEN") || class=unclassified
      case "$class" in exited|empty|no-pty) printf 'dead\n' ;; *) printf 'live\n' ;; esac
      ;;
    *) printf 'inconclusive\n' ;;
  esac
}

# Adopt and converge pre-existing cmux workspaces whose command/title exactly
# maps to a live managed tmux window. The caller-provided roster is the only
# candidate inventory for this pass; every mutation re-proves topology and cmux
# generation, and unrecognized founder surfaces stay untouched.
reconcile_workspace_titles() {
  local tmux_windows="$1" generation raw_json births="" source wid title canonical_raw candidates
  local named_rows raw_rows birth_rows candidate_births named_count keeper keeper_kind keeper_ref state
  local extra_rows extra_ref rc expected_target expected_target_b64 birth_owned receipt_uuid keeper_liveness extra_liveness
  local current_refusals="" refusal_key
  generation=$(cmux_socket_identity)
  [[ -n "$generation" ]] || return 0
  raw_json=$(get_cmux_workspaces_json) || return 0
  births=$(cmux_attach_birth_records "$raw_json" 2>/dev/null || true)

  while IFS='|' read -r source wid title; do
    [[ -n "$source" && -n "$wid" && -n "$title" ]] || continue
    title_source_authorized "$source" "$wid" "$title" || {
      refusal_key="$source|$wid|$title"
      if ! printf '%s\n' "$CMUX_TITLE_TOPOLOGY_REFUSED_KEYS" | grep -qxF "$refusal_key" \
          && ! printf '%s\n' "$current_refusals" | grep -qxF "$refusal_key"; then
        log "WARN: title stock topology proof refused source=$source wid=$wid title=$title"
      fi
      current_refusals+="${current_refusals:+$'\n'}${refusal_key}"
      continue
    }
    canonical_raw=$(managed_view_command_variants "${VIEW_PREFIX}${title}") || continue
    expected_target="${VIEW_PREFIX}${title}"
    expected_target_b64=$(printf '%s' "$expected_target" | base64 | tr -d '\n') || continue
    candidates=$(workspace_title_candidates "$raw_json" "$title" "$canonical_raw") || continue
    candidate_births=$(workspace_birth_candidate_rows "$raw_json" "$births" view \
      "$expected_target_b64" "$candidates") || continue
    candidates+="${candidate_births:+${candidates:+$'\n'}${candidate_births}}"
    [[ -n "$candidates" ]] || continue
    named_rows=$(printf '%s\n' "$candidates" | awk -F'|' '$1 == "named"')
    raw_rows=$(printf '%s\n' "$candidates" | awk -F'|' '$1 == "raw"')
    birth_rows=$(printf '%s\n' "$candidates" | awk -F'|' '$1 == "birth"')
    named_count=$(printf '%s\n' "$named_rows" | grep -c . || true)
    if (( named_count > 1 )); then
      log "WARN: multiple named workspaces preserved title=$title count=$named_count"
      continue
    fi
    if [[ -n "$named_rows" ]]; then
      keeper=$(select_title_keeper "$generation" "$title" "$named_rows") || continue
    else
      keeper=$(select_title_keeper "$generation" "$title" \
        "${raw_rows}${birth_rows:+${raw_rows:+$'\n'}${birth_rows}}") || continue
    fi
    IFS='|' read -r keeper_kind keeper_ref < <(printf '%s\n' "$keeper")
    state=$(ledger_candidate_receipt_state "$generation" "$keeper_ref" "$title") || continue
    rc=0
    restored_inflight_state "$generation" "$keeper_ref" "$title" || rc=$?
    if [[ "$rc" -eq 0 || "$rc" -eq 2 ]]; then
      log "WARN: title reconciliation skipped restored in-flight tuple ref=$keeper_ref title=$title rc=$rc"
      continue
    fi
    birth_owned=0
    if printf '%s\n' "$births" | awk -F'|' -v r="$keeper_ref" -v t="$expected_target_b64" \
        '$1==r && $5=="view" && $6==t {found=1} END {exit(found?0:1)}'; then
      birth_owned=1
    fi
    if [[ "$birth_owned" == 1 && "$keeper_kind" == birth ]]; then
      adopt_birth_candidate "$source" "$wid" "$title" "$generation" "$keeper_ref" \
        view "$expected_target_b64" || continue
      state=committed
      keeper_kind=named
    fi
    case "$state" in
      none)
        if [[ "$birth_owned" == 1 ]]; then
          adopt_birth_candidate "$source" "$wid" "$title" "$generation" "$keeper_ref" \
            view "$expected_target_b64" || continue
          state=committed; keeper_kind=named
        else
          authorize_stock_candidate "$source" "$wid" "$title" "$generation" \
            "$keeper_ref" "$canonical_raw" || {
            log "WARN: unreceipted title stock preserved ref=$keeper_ref title=$title"
            continue
          }
          _ledger_upsert prepared "$generation" "$keeper_ref" "$title" || continue
        fi
        ;;
      prepared)
        if [[ "$birth_owned" == 1 ]]; then
          adopt_birth_candidate "$source" "$wid" "$title" "$generation" "$keeper_ref" \
            view "$expected_target_b64" || continue
          state=committed; keeper_kind=named
        fi
        ;;
      committed)
        if [[ "$birth_owned" == 1 ]]; then
          receipt_uuid=$(ledger_exact_receipt_uuid "$generation" "$keeper_ref" "$title" 2>/dev/null || true)
          if [[ "$receipt_uuid" == __LEGACY__ ]]; then
            adopt_birth_candidate "$source" "$wid" "$title" "$generation" "$keeper_ref" \
              view "$expected_target_b64" || continue
            keeper_kind=named
          fi
        fi
        ;;
      *) continue ;;
    esac

    # keeper_kind came from this sweep's single list-workspaces snapshot. It is
    # selection evidence only: raw mutations still re-read inside their final
    # guard, while complete_title_migration re-reads a named keeper before it
    # can commit. Avoiding a read here removes a back-to-back duplicate without
    # weakening either mutation boundary.
    if [[ "$keeper_kind" == "raw" ]]; then
      rename_stock_workspace "$source" "$wid" "$title" "$generation" \
        "$keeper_ref" "$canonical_raw" || continue
    elif [[ "$keeper_kind" != "named" ]]; then
      continue
    fi
    complete_title_migration "$keeper_ref" "$title" "$generation" "$canonical_raw" || continue

    # A ready proof exists solely to authorize destructive duplicate cleanup.
    # Do not pay for it on the overwhelmingly common no-extra steady-state
    # path; every actual close also re-proves keeper readiness in its guard.
    extra_rows=$(printf '%s\n%s\n' "$raw_rows" "$birth_rows" | awk -F'|' -v keep="$keeper_ref" \
      '$2 != "" && $2 != keep')
    [[ -n "$extra_rows" ]] || continue
    title_keeper_ready "$generation" "$keeper_ref" "$title" || continue

    while IFS='|' read -r _ extra_ref _; do
      [[ -n "$extra_ref" ]] || continue
      rc=0
      restored_inflight_state "$generation" "$extra_ref" "$title" || rc=$?
      if [[ "$rc" -eq 0 || "$rc" -eq 2 ]]; then
        log "WARN: duplicate cleanup skipped restored in-flight tuple ref=$extra_ref title=$title rc=$rc"
        continue
      fi
      keeper_liveness=$(workspace_attach_liveness "$keeper_ref" view "$expected_target_b64" "$births")
      extra_liveness=$(workspace_attach_liveness "$extra_ref" view "$expected_target_b64" "$births")
      if [[ "$keeper_liveness" == dead && "$extra_liveness" == live ]]; then
        promote_live_duplicate "$source" "$wid" "$title" "$generation" \
          "$keeper_ref" "$extra_ref" "$expected_target_b64" "$births" || true
        continue
      fi
      if [[ "$keeper_liveness" != live || "$extra_liveness" != dead ]]; then
        log "WARN: duplicate workspace preserved pending liveness proof title=$title keeper=$keeper_ref:$keeper_liveness extra=$extra_ref:$extra_liveness"
        continue
      fi
      _alert_cmux_cleanup "cmux view duplicate preserved (report-only)" \
        "A single render sample classified a sibling dead. Automatic duplicate close is disabled until a distinct-round activity proof exists: title=$title keeper=$keeper_ref sibling=$extra_ref." \
        "cmux_cleanup|view-duplicate-report-only|title=$title|keeper=$keeper_ref|sibling=$extra_ref"
    done < <(printf '%s\n' "$extra_rows")
  done < <(printf '%s\n' "$tmux_windows")
  CMUX_TITLE_TOPOLOGY_REFUSED_KEYS="$current_refusals"
  return 0
}

_additive_round_state_valid() {
  local line epoch sequence extra bytes
  [[ -e "$CMUX_ADDITIVE_ROUND_STATE" || -L "$CMUX_ADDITIVE_ROUND_STATE" ]] || return 0
  [[ -f "$CMUX_ADDITIVE_ROUND_STATE" && ! -L "$CMUX_ADDITIVE_ROUND_STATE" ]] || return 1
  bytes=$(wc -c < "$CMUX_ADDITIVE_ROUND_STATE" 2>/dev/null | tr -d ' ') || return 1
  case "$bytes" in ''|*[!0-9]*) return 1 ;; esac
  (( bytes <= 64 )) || return 1
  IFS='|' read -r epoch sequence extra < "$CMUX_ADDITIVE_ROUND_STATE" || return 1
  [[ -n "$epoch" && -n "$sequence" && -z "${extra:-}" ]] || return 1
  case "$epoch$sequence" in *[!0-9]*) return 1 ;; esac
  [[ ${#epoch} -le 12 && ${#sequence} -le 6 ]] || return 1
  [[ "$(wc -l < "$CMUX_ADDITIVE_ROUND_STATE" 2>/dev/null | tr -d ' ')" == "1" ]]
}

begin_cmux_additive_round() {
  local now epoch sequence tmp dir
  mutator_lease_owned_by_self || return 1
  _additive_round_state_valid || return 1
  now=$(date +%s) || return 1
  case "$now" in ''|*[!0-9]*) return 1 ;; esac
  epoch="$now"; sequence=1
  if [[ -f "$CMUX_ADDITIVE_ROUND_STATE" ]]; then
    IFS='|' read -r epoch sequence < "$CMUX_ADDITIVE_ROUND_STATE" || return 1
    if (( 10#$now > 10#$epoch )); then
      epoch="$now"; sequence=1
    elif (( 10#$sequence < 999999 )); then
      sequence=$((10#$sequence + 1))
    else
      epoch=$((10#$epoch + 1)); sequence=1
    fi
  fi
  dir=$(dirname "$CMUX_ADDITIVE_ROUND_STATE")
  mkdir -p "$dir" 2>/dev/null || return 1
  tmp=$(mktemp "${CMUX_ADDITIVE_ROUND_STATE}.XXXX" 2>/dev/null) || return 1
  printf '%s|%s\n' "$epoch" "$sequence" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$CMUX_ADDITIVE_ROUND_STATE" 2>/dev/null || { rm -f "$tmp"; return 1; }
  CMUX_ADDITIVE_ROUND_ID="${epoch}-${sequence}"
}

_prepared_stall_state_valid() {
  local kind generation ref title count first_epoch last_round extra bytes now keys
  [[ -e "$PREPARED_STALL_STATE" || -L "$PREPARED_STALL_STATE" ]] || return 0
  [[ -f "$PREPARED_STALL_STATE" && ! -L "$PREPARED_STALL_STATE" ]] || return 1
  bytes=$(wc -c < "$PREPARED_STALL_STATE" 2>/dev/null | tr -d ' ') || return 1
  case "$bytes" in ''|*[!0-9]*) return 1 ;; esac
  (( bytes <= 1048576 )) || return 1
  now=$(date +%s) || return 1
  while IFS='|' read -r kind generation ref title count first_epoch last_round extra \
      || [[ -n "$kind$generation$ref$title$count$first_epoch$last_round${extra:-}" ]]; do
    [[ -n "$kind$generation$ref$title$count$first_epoch$last_round" && -z "${extra:-}" ]] || return 1
    case "$kind" in absent|drift|authority|node-absent|node-drift) ;; *) return 1 ;; esac
    case "$generation$title" in *$'\t'*|*$'\n'*|*$'\r'*) return 1 ;; esac
    [[ ${#generation} -le 1024 && ${#title} -le 255 ]] || return 1
    case "$ref" in workspace:[0-9]*) case "${ref#workspace:}" in ''|*[!0-9]*) return 1 ;; esac ;; *) return 1 ;; esac
    case "$count$first_epoch" in *[!0-9]*) return 1 ;; esac
    [[ ${#count} -le 4 && ${#first_epoch} -le 12 ]] || return 1
    (( 10#$count <= 1000 && 10#$first_epoch <= 10#$now )) || return 1
    case "$last_round" in
      *[!0-9-]*|*-*-*|-*|*-) return 1 ;;
    esac
    [[ ${last_round%%-*} != "$last_round" \
        && ${#last_round} -le 32 ]] || return 1
  done < "$PREPARED_STALL_STATE"
  keys=$(awk -F'|' 'NF == 7 { print $1 FS $2 FS $3 FS $4 }' "$PREPARED_STALL_STATE" | sort | uniq -d)
  [[ -z "$keys" ]]
}

_prepared_stall_commit() {
  local kind="$1" generation="$2" ref="$3" title="$4" replacement="${5:-}" dir tmp source
  mutator_lease_owned_by_self || return 1
  _prepared_stall_state_valid || return 1
  dir=$(dirname "$PREPARED_STALL_STATE")
  mkdir -p "$dir" 2>/dev/null || return 1
  source="/dev/null"
  [[ -f "$PREPARED_STALL_STATE" ]] && source="$PREPARED_STALL_STATE"
  tmp=$(mktemp "${PREPARED_STALL_STATE}.XXXX" 2>/dev/null) || return 1
  awk -F'|' -v k="$kind" -v g="$generation" -v r="$ref" -v t="$title" \
    '!($1 == k && $2 == g && $3 == r && $4 == t) { print }' "$source" > "$tmp" 2>/dev/null \
    || { rm -f "$tmp"; return 1; }
  [[ -z "$replacement" ]] || printf '%s\n' "$replacement" >> "$tmp" \
    || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$PREPARED_STALL_STATE" 2>/dev/null || { rm -f "$tmp"; return 1; }
}

_prepared_stall_clear() {
  [[ -f "$PREPARED_STALL_STATE" ]] || return 0
  _prepared_stall_commit "$1" "$2" "$3" "$4"
}

_prepared_stall_observe() {
  local kind="$1" generation="$2" ref="$3" title="$4" previous count first_epoch last_round
  local now min_age replacement
  case "$kind" in absent|drift|authority|node-absent|node-drift) ;; *) return 1 ;; esac
  case "$CMUX_ADDITIVE_ROUND_ID" in
    *[!0-9-]*|*-*-*|-*|*-) return 1 ;;
  esac
  [[ ${CMUX_ADDITIVE_ROUND_ID%%-*} != "$CMUX_ADDITIVE_ROUND_ID" ]] || return 1
  mutator_lease_owned_by_self || return 1
  _prepared_stall_state_valid || return 1
  now=$(date +%s) || return 1
  min_age=$(validated_int_env FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS \
    "${FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS:-120}" 120 3600 | tail -1)
  previous=$(awk -F'|' -v k="$kind" -v g="$generation" -v r="$ref" -v t="$title" \
    '$1 == k && $2 == g && $3 == r && $4 == t { print $5 "|" $6 "|" $7; exit }' \
    "$PREPARED_STALL_STATE" 2>/dev/null || true)
  if [[ -z "$previous" ]]; then
    count=0; first_epoch="$now"; last_round="$CMUX_ADDITIVE_ROUND_ID"
  else
    IFS='|' read -r count first_epoch last_round < <(printf '%s\n' "$previous")
    if [[ "$last_round" != "$CMUX_ADDITIVE_ROUND_ID" ]]; then
      if (( 10#$now - 10#$first_epoch >= 10#$min_age )); then
        count=$((10#$count + 1))
      fi
      last_round="$CMUX_ADDITIVE_ROUND_ID"
    fi
  fi
  replacement="${kind}|${generation}|${ref}|${title}|${count}|${first_epoch}|${last_round}"
  _prepared_stall_commit "$kind" "$generation" "$ref" "$title" "$replacement" || return 1
  printf '%s\n' "$count"
}

reconcile_prepared_ledger() {
  [[ -f "$VIEW_LEDGER" ]] || return 0
  local generation raw rows ref title workspace_uuid observed confirm current state old_generation provisional canonical_raw
  local had_current_prepared=0 stall_count absent_passes drift_passes legacy_default
  generation=$(cmux_socket_identity)
  [[ -n "$generation" ]] || return 1
  raw=$(get_cmux_workspaces_json) || return 1
  _detect_historical_ledger_title_conflicts || return 1
  rows=$(awk -F'|' -v g="$generation" \
    '(NF == 4 || NF == 5) && $1 == "prepared" && $2 == g { print $3 "|" $4 "|" $5 }' \
    "$VIEW_LEDGER")
  if [[ -n "$rows" ]]; then
    had_current_prepared=1
    if [[ -z "$CMUX_ADDITIVE_ROUND_ID" ]] && ! begin_cmux_additive_round; then
      log "WARN: additive round state unavailable; prepared stall counters frozen"
    fi
    absent_passes=$(validated_int_env FLYWHEEL_CMUX_PREPARED_ABSENT_PASSES \
      "${FLYWHEEL_CMUX_PREPARED_ABSENT_PASSES:-3}" 3 100 | tail -1)
    drift_passes=$(validated_int_env FLYWHEEL_CMUX_PREPARED_DRIFT_PASSES \
      "${FLYWHEEL_CMUX_PREPARED_DRIFT_PASSES:-5}" 5 100 | tail -1)
    while IFS='|' read -r ref title workspace_uuid; do
      [[ -z "$ref" || -z "$title" ]] && continue
      local restored_rc=0
      restored_inflight_state "$generation" "$ref" "$title" || restored_rc=$?
      if [[ "$restored_rc" -eq 0 || "$restored_rc" -eq 2 ]]; then
        log "WARN: prepared ledger reconciliation skipped restored transaction state title=$title ref=$ref rc=$restored_rc"
        continue
      fi
      if cmux_wal_title_blocked "$title"; then
        log "WARN: prepared ledger reconciliation blocked by construction collision: title=$title ref=$ref"
        continue
      fi
      if _ledger_title_duplicate_blocked "$generation" "$title"; then
        log "WARN: prepared ledger reconciliation blocked by multiple committed owners: title=$title ref=$ref"
        continue
      fi
      local owner_refs owner_ref owner_count
      owner_refs=$(awk -F'|' -v g="$generation" -v r="$ref" -v t="$title" \
        '(NF == 4 || NF == 5) && $1 == "committed" && $2 == g && $4 == t && $3 != r { print $3 }' \
        "$VIEW_LEDGER" 2>/dev/null | sort -u) || return 1
      owner_count=$(printf '%s\n' "$owner_refs" | grep -c . || true)
      if [[ "$owner_count" == "1" ]]; then
        owner_ref=$(printf '%s\n' "$owner_refs" | head -1)
        if close_prepared_loser_ref "$generation" "$ref" "$owner_ref" "$title"; then
          continue
        fi
        log "WARN: prepared loser cleanup deferred for title=$title ref=$ref owner=$owner_ref"
        continue
      elif [[ "$owner_count" -gt 1 ]]; then
        log "WARN: prepared ledger row preserved beside ambiguous committed owners: title=$title ref=$ref"
        continue
      fi
      provisional=$(managed_view_command_variants "${VIEW_PREFIX}${title}" 2>/dev/null || true)
      observed=$(printf '%s' "$raw" | python3 -c '
import json,sys
r=sys.argv[1]
for w in json.load(sys.stdin).get("workspaces", []):
    if w.get("ref") == r:
        t=w.get("title")
        print("__NULL__" if t is None or t == "" or t == "~" else t)
        break
else:
    print("__ABSENT__")
' "$ref") || return 1
      canonical_raw="$provisional"
      legacy_default=0
      if [[ "$observed" != "__ABSENT__" ]]; then
        _prepared_stall_clear absent "$generation" "$ref" "$title" \
          || log "WARN: prepared absent evidence could not be reset ref=$ref title=$title"
      fi
      if _workspace_title_is_default "$observed"; then
        if ! _workspace_uuid_valid "$workspace_uuid"; then
          legacy_default=1
        else
          canonical_raw="${provisional}${provisional:+$'\n'}${observed}"
          observed="__DEFAULT__"
        fi
      elif _managed_view_command_in_variants "$observed" "$provisional"; then
        canonical_raw="${provisional}${provisional:+$'\n'}${observed}"
        observed="__PROVISIONAL__"
      fi
      case "$observed" in
        __ABSENT__)
          _prepared_stall_clear drift "$generation" "$ref" "$title" || true
          _prepared_stall_clear authority "$generation" "$ref" "$title" || true
          stall_count=$(_prepared_stall_observe absent "$generation" "$ref" "$title") || {
            log "WARN: prepared ledger ref absent but stall state is unavailable ref=$ref title=$title; preserving"
            continue
          }
          if (( 10#$stall_count >= 10#$absent_passes )); then
            _prepared_stall_clear absent "$generation" "$ref" "$title" || {
              log "WARN: prepared absent evidence could not be cleared ref=$ref title=$title; preserving receipt"
              continue
            }
            _ledger_remove "$generation" "$ref" || return 1
            log "GC prepared(absent-confirmed) generation=$generation ref=$ref title=$title passes=$stall_count"
          else
            log "WARN: prepared ledger ref absent ref=$ref title=$title pass=$stall_count/$absent_passes; preserving"
          fi
          ;;
        __NULL__|__PROVISIONAL__|__DEFAULT__)
          _prepared_stall_clear drift "$generation" "$ref" "$title" || true
          _GUARD_RENAME_GENERATION="$generation"
          _GUARD_RENAME_REF="$ref"
          _GUARD_RENAME_TITLE="$title"
          _GUARD_RENAME_PROVISIONAL_TITLE="$canonical_raw"
          _GUARD_RENAME_UUID="$workspace_uuid"
          # Recovery has the same authority boundary as first-create rename:
          # the prepared row, exact unnamed ref, and cmux generation must all
          # still match at cmux_call_guarded's last pre-mutation operation.
          local rename_rc=0
          cmux_call_guarded _prepared_rename_guard \
            rename-workspace --workspace "$ref" "$title" || rename_rc=$?
          if [[ "$rename_rc" -ne 0 || "$GUARD_WAS_BLOCKED" == 1 ]]; then
            if [[ "$GUARD_WAS_BLOCKED" == 1 && "$GUARD_BLOCK_RC" == 3 ]]; then
              stall_count=$(_prepared_stall_observe authority "$generation" "$ref" "$title") || {
                log "WARN: prepared authority mismatch evidence unavailable ref=$ref title=$title; preserving"
                continue
              }
              if (( 10#$stall_count >= 10#$drift_passes )); then
                _prepared_stall_clear authority "$generation" "$ref" "$title" || continue
                _ledger_remove "$generation" "$ref" || return 1
                _alert_cmux_cleanup \
                  "cmux prepared authority mismatch released" \
                  "A prepared receipt was released without touching its replacement workspace after persistent immutable-identity mismatch: generation=$generation ref=$ref title=$title passes=$stall_count." \
                  "cmux_cleanup|prepared-authority-mismatch-released|generation=$generation|ref=$ref|title=$title"
              else
                log "WARN: prepared authority mismatch ref=$ref title=$title pass=$stall_count/$drift_passes; preserving"
              fi
            fi
            continue
          fi
          _prepared_stall_clear authority "$generation" "$ref" "$title" || true
          confirm=$(get_cmux_workspaces_json) || return 1
          current=$(cmux_socket_identity)
          [[ "$current" == "$generation" ]] || return 1
          observed=$(printf '%s' "$confirm" | python3 -c '
import json,sys
r,t=sys.argv[1:3]
print(sum(1 for w in json.load(sys.stdin).get("workspaces", [])
          if w.get("ref") == r and w.get("title") == t))
' "$ref" "$title") || return 1
          [[ "$observed" == "1" ]] || return 1
          # FLY-1605: recovery and stock migration share one guarded tab-title
          # completion path. It re-proves the receipt/ref/workspace/surface at
          # the actual mutation boundary and reads the tab title back before
          # committing, so a foreign surface or success-without-effect can
          # never become durable authority.
          if ! complete_title_migration "$ref" "$title" "$generation" "$canonical_raw"; then
            log "WARN: prepared title migration deferred ref=$ref title=$title; preserving receipt"
            continue
          fi
          ;;
        "$title")
          _prepared_stall_clear drift "$generation" "$ref" "$title" || true
          _prepared_stall_clear authority "$generation" "$ref" "$title" || true
          # Already-named workspace (crash landed between the two renames or
          # after the tab rename): the same helper either performs the guarded
          # raw→canonical tab rename or completes receipt-only when both faces
          # already read back correctly.
          if ! complete_title_migration "$ref" "$title" "$generation" "$provisional"; then
            log "WARN: prepared title migration deferred ref=$ref title=$title; preserving receipt"
            continue
          fi
          ;;
        *)
          _prepared_stall_clear authority "$generation" "$ref" "$title" || true
          stall_count=$(_prepared_stall_observe drift "$generation" "$ref" "$title") || {
            log "WARN: prepared ledger title drift ref=$ref expected=$title observed=$observed; stall state unavailable, preserving"
            continue
          }
          if (( 10#$stall_count >= 10#$drift_passes )); then
            _prepared_stall_clear drift "$generation" "$ref" "$title" || {
              log "WARN: prepared drift evidence could not be cleared ref=$ref title=$title; preserving receipt"
              continue
            }
            _ledger_remove "$generation" "$ref" || return 1
            log "GC prepared(drift-confirmed) generation=$generation ref=$ref expected=$title observed=$observed passes=$stall_count"
            _alert_cmux_cleanup \
              "cmux prepared receipt released after persistent drift" \
              "A prepared receipt was released without touching its workspace after persistent title drift: generation=$generation ref=$ref expected=$title observed=$observed passes=$stall_count." \
              "cmux_cleanup|prepared-drift-released|generation=$generation|ref=$ref|expected=$title|observed=$observed"
          elif [[ "$legacy_default" == "1" ]]; then
            log "WARN: prepared ledger default title lacks UUID authority ref=$ref expected=$title observed=$observed pass=$stall_count/$drift_passes; preserving"
          else
            log "WARN: prepared ledger title drift ref=$ref expected=$title observed=$observed pass=$stall_count/$drift_passes; preserving"
          fi
          ;;
      esac
    done < <(printf '%s\n' "$rows")
  fi

  # Refresh only when current-generation prepared reconciliation may have
  # renamed an unnamed ref. A ledger containing only stale generations still
  # proceeds to the independent stale pass below.
  if [[ "$had_current_prepared" == "1" ]]; then
    raw=$(get_cmux_workspaces_json) || return 1
  fi
  # GC only committed rows whose exact ref is conclusively gone or renamed.
  rows=$(awk -F'|' -v g="$generation" '$1 == "committed" && $2 == g { print $3 "|" $4 }' "$VIEW_LEDGER" 2>/dev/null || true)
  while IFS='|' read -r ref title; do
    [[ -z "$ref" || -z "$title" ]] && continue
    cmux_wal_title_blocked "$title" && continue
    _ledger_title_duplicate_blocked "$generation" "$title" && continue
    observed=$(printf '%s' "$raw" | python3 -c '
import json,sys
r=sys.argv[1]
for w in json.load(sys.stdin).get("workspaces", []):
    if w.get("ref") == r:
        t=w.get("title")
        print("__NULL__" if t is None or t == "" or t == "~" else t)
        break
else:
    print("__ABSENT__")
' "$ref") || return 1
    if [[ "$observed" == "__ABSENT__" || "$observed" != "$title" ]]; then
      current=$(cmux_socket_identity)
      [[ "$current" == "$generation" ]] || return 1
      _ledger_remove "$generation" "$ref" || return 1
      log "GC committed ledger ref=$ref expected=$title observed=$observed"
    fi
  done < <(printf '%s\n' "$rows")

  # Stale generations are hygiene-only, never authority migration. A ref that
  # is conclusively absent can be collected; any present ref (same title,
  # different title, or unnamed) is preserved for operator review. In
  # particular, an old prepared row can never rename a current object.
  current=$(cmux_socket_identity)
  [[ "$current" == "$generation" ]] || return 1
  rows=$(awk -F'|' -v g="$generation" \
    '(NF == 4 || NF == 5) && ($1 == "prepared" || $1 == "committed") && $2 != g { print $1 "|" $2 "|" $3 "|" $4 }' \
    "$VIEW_LEDGER" 2>/dev/null || true)
  while IFS='|' read -r state old_generation ref title; do
    [[ -z "$state" || -z "$old_generation" || -z "$ref" || -z "$title" ]] && continue
    cmux_wal_title_blocked "$title" && continue
    _ledger_title_duplicate_blocked "$old_generation" "$title" && continue
    observed=$(printf '%s' "$raw" | python3 -c '
import json,sys
r=sys.argv[1]
for w in json.load(sys.stdin).get("workspaces", []):
    if w.get("ref") == r:
        t=w.get("title")
        print("__NULL__" if t is None or t == "" or t == "~" else t)
        break
else:
    print("__ABSENT__")
' "$ref") || return 1
    current=$(cmux_socket_identity)
    [[ "$current" == "$generation" ]] || return 1
    if [[ "$observed" == "__ABSENT__" ]]; then
      _ledger_remove "$old_generation" "$ref" || return 1
      log "GC stale-generation ledger state=$state old_generation=$old_generation current_generation=$generation ref=$ref title=$title"
    else
      log "WARN: preserving stale-generation ledger state=$state old_generation=$old_generation current_generation=$generation ref=$ref title=$title observed=$observed; manual resolution required"
      _alert_cmux_cleanup \
        "cmux stale-generation receipt preserved" \
        "A stale cmux receipt still resolves and was preserved without rename or migration: state=$state old_generation=$old_generation current_generation=$generation ref=$ref title=$title observed=$observed." \
        "cmux_cleanup|stale-generation|old=$old_generation|current=$generation|ref=$ref|observed=$observed"
    fi
  done < <(printf '%s\n' "$rows")
  return 0
}

_inventory_fail() {
  local stage="$1" reason="$2"
  log "WARN: keeper inventory transaction failed stage=$stage reason=$reason path=$KEEPER_INVENTORY"
  return 1
}

_inventory_acquire_inner_lock() {
  # The global incarnation-bound mutator lease excludes every legitimate
  # inventory writer. The inner directory is only an atomic file-replacement
  # guard, so the verified sole writer may reap an empty crash residue. A
  # non-empty or non-directory path remains fail-closed for inspection.
  local dir lock="${KEEPER_INVENTORY}.lock"
  if ! assert_or_reuse_owned_lease; then
    log "WARN: keeper inventory mutation refused: current process does not hold the verified mutator lease"
    [[ "$MUTATOR_LEASE_MODE" == "watch" && "$WATCHER_AUTHORITY_LOST" == "1" ]] && return 75
    return 1
  fi
  dir=$(dirname "$KEEPER_INVENTORY")
  mkdir -p "$dir" 2>/dev/null || { _inventory_fail preflight state-directory-unavailable; return 1; }
  if mkdir "$lock" 2>/dev/null; then
    return 0
  fi
  [[ -d "$lock" && ! -L "$lock" ]] || {
    _inventory_fail inner-lock residual-path-not-directory; return 1;
  }
  if ! rmdir "$lock" 2>/dev/null; then
    log "WARN: keeper inventory residual lock is not empty; preserving fail-closed: $lock"
    return 1
  fi
  log "[audit] reaped stale keeper inventory lock under verified mutator lease: $lock"
  mkdir "$lock" 2>/dev/null || { _inventory_fail inner-lock reacquire-failed; return 1; }
}

_inventory_maybe_crash() {
  # Deterministic test seam. Production leaves this variable unset; tests run
  # the writer in a disposable child so SIGKILL leaves the real filesystem
  # residue produced at each transaction boundary.
  [[ "${FLYWHEEL_CMUX_INVENTORY_CRASH_AT:-}" == "$1" ]] || return 0
  kill -KILL "$$"
  return 137
}

_inventory_release_inner_lock() {
  local lock="$1"
  rmdir "$lock" 2>/dev/null || return 1
  _inventory_maybe_crash after-lock-rmdir
}

_inventory_generation_token() {
  # tmux_server_generation is historically persisted as socket|pid|started in
  # construction WALs. Keeper inventory is itself pipe-delimited, so that raw
  # production identity cannot cross this boundary. Preserve already-safe
  # opaque generations for compatibility and digest only delimiter-bearing
  # production identities.
  local generation="$1" digest
  [[ -n "$generation" ]] || return 1
  case "$generation" in *$'\n'*|*$'\r'*) return 1 ;; esac
  case "$generation" in
    *'|'*)
      digest=$(printf '%s' "$generation" | shasum -a 256 2>/dev/null | awk '{print $1}') || return 1
      case "$digest" in ''|*[!0-9a-f]*) return 1 ;; esac
      [[ ${#digest} -eq 64 ]] || return 1
      printf 'sha256:%s\n' "$digest"
      ;;
    *)
      printf '%s\n' "$generation"
      ;;
  esac
}

_inventory_upsert() {
  # generation|session_id|exact_name|owner|window_ids|state|epoch
  local generation="$1" sid="$2" exact_name="$3" owner="$4" members="$5" state="$6"
  local lock tmp now
  case "$state" in prepared|committed) ;; *) return 1 ;; esac
  case "$generation$sid$exact_name$owner$members" in *'|'*|*$'\n'*) return 1 ;; esac
  lock="${KEEPER_INVENTORY}.lock"
  _inventory_acquire_inner_lock || return $?
  _inventory_maybe_crash after-inner-mkdir
  touch "$KEEPER_INVENTORY" 2>/dev/null || {
    rmdir "$lock" 2>/dev/null || true; _inventory_fail upsert inventory-touch-failed; return 1;
  }
  tmp=$(mktemp "${KEEPER_INVENTORY}.XXXX" 2>/dev/null) || {
    rmdir "$lock" 2>/dev/null || true; _inventory_fail upsert temp-create-failed; return 1;
  }
  awk -F'|' -v s="$sid" '$2 != s { print }' "$KEEPER_INVENTORY" > "$tmp" 2>/dev/null || {
    rm -f "$tmp"; rmdir "$lock" 2>/dev/null || true; _inventory_fail upsert inventory-read-failed; return 1;
  }
  now=$(date +%s)
  printf '%s|%s|%s|%s|%s|%s|%s\n' "$generation" "$sid" "$exact_name" \
    "$owner" "$members" "$state" "$now" >> "$tmp" || {
    rm -f "$tmp"; rmdir "$lock" 2>/dev/null || true; _inventory_fail upsert temp-write-failed; return 1;
  }
  _inventory_maybe_crash after-inventory-tmp-write
  mv "$tmp" "$KEEPER_INVENTORY" 2>/dev/null || {
    rm -f "$tmp"; rmdir "$lock" 2>/dev/null || true; _inventory_fail upsert atomic-replace-failed; return 1;
  }
  _inventory_maybe_crash after-inventory-mv
  _inventory_release_inner_lock "$lock" || { _inventory_fail upsert lock-release-failed; return 1; }
}

_inventory_remove_sid() {
  local generation="$1" sid="$2" tmp lock="${KEEPER_INVENTORY}.lock"
  if ! assert_or_reuse_owned_lease; then
    log "WARN: keeper inventory removal refused: current process does not hold the verified mutator lease"
    [[ "$MUTATOR_LEASE_MODE" == "watch" && "$WATCHER_AUTHORITY_LOST" == "1" ]] && return 75
    return 1
  fi
  [[ -f "$KEEPER_INVENTORY" ]] || return 0
  _inventory_acquire_inner_lock || return $?
  _inventory_maybe_crash after-inner-mkdir
  tmp=$(mktemp "${KEEPER_INVENTORY}.XXXX" 2>/dev/null) || {
    rmdir "$lock" 2>/dev/null || true; _inventory_fail remove temp-create-failed; return 1;
  }
  # Malformed rows and other generations are preserved verbatim and never
  # authorize a mutation. Only the exact well-formed identity is removed.
  awk -F'|' -v g="$generation" -v s="$sid" \
    'NF != 7 || !($1 == g && $2 == s) { print }' "$KEEPER_INVENTORY" > "$tmp" 2>/dev/null || {
    rm -f "$tmp"; rmdir "$lock" 2>/dev/null || true; _inventory_fail remove inventory-read-failed; return 1;
  }
  _inventory_maybe_crash after-inventory-tmp-write
  mv "$tmp" "$KEEPER_INVENTORY" 2>/dev/null || {
    rm -f "$tmp"; rmdir "$lock" 2>/dev/null || true; _inventory_fail remove atomic-replace-failed; return 1;
  }
  _inventory_maybe_crash after-inventory-mv
  _inventory_release_inner_lock "$lock" || { _inventory_fail remove lock-release-failed; return 1; }
}

reconcile_keeper_inventory() {
  # The inventory is the operator-facing authority for escrowed sessions.
  # Rebuild missing rows from live, self-identifying keepers; promote a
  # prepared row only after exact identity/topology readback; GC only a
  # committed row whose exact session is conclusively absent.
  local raw_generation generation sessions rows line fields row_generation sid exact owner members state _epoch
  local snapshot observed_sid grouped active observed_owner marker observed_members original
  raw_generation=$(tmux_server_generation) || return 1
  generation=$(_inventory_generation_token "$raw_generation") || return 1
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null) || return 1
  rows=$(cat "$KEEPER_INVENTORY" 2>/dev/null || true)

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    fields=$(printf '%s\n' "$line" | awk -F'|' '{print NF}')
    if [[ "$fields" != "7" ]]; then
      log "WARN: malformed keeper inventory row preserved"
      continue
    fi
    IFS='|' read -r row_generation sid exact owner members state _epoch < <(printf '%s\n' "$line")
    case "$state" in prepared|committed) ;; *) log "WARN: invalid keeper inventory state preserved: $state"; continue ;; esac
    [[ "$row_generation" == "$generation" ]] || continue
    if cmux_wal_keeper_blocked "$owner" "$members"; then
      log "WARN: keeper inventory reconciliation blocked by construction collision: session=$exact owner=$owner"
      continue
    fi
    if printf '%s\n' "$sessions" | grep -qxF "$exact"; then
      snapshot=$(_view_session_snapshot "$exact") || return 1
      IFS='|' read -r observed_sid grouped active observed_owner marker observed_members < <(printf '%s\n' "$snapshot")
      if [[ "$observed_sid" == "$sid" && "$observed_owner" == "$owner" \
          && "$observed_members" == "$members" ]]; then
        [[ "$state" == "committed" ]] || _inventory_upsert "$generation" "$sid" "$exact" "$owner" "$members" committed || return 1
      else
        log "WARN: keeper inventory identity mismatch for $exact; preserving without mutation"
      fi
    elif [[ "$state" == "committed" ]]; then
      _inventory_remove_sid "$generation" "$sid" || return 1
    else
      # A prepared row may have been persisted immediately before rename. If
      # the original exact session still has the same session_id, leave it
      # pending; otherwise preserve the row for operator diagnosis.
      original="${exact#fwkeeper-"${sid#\$}"-}"
      if printf '%s\n' "$sessions" | grep -qxF "$original"; then
        observed_sid=$(tmux list-sessions -F '#{session_id}' \
          -f "#{==:#{session_name},${original}}" 2>/dev/null | head -1 || true)
        [[ "$observed_sid" == "$sid" ]] || log "WARN: prepared keeper source identity drift for $original"
      fi
    fi
  done < <(printf '%s\n' "$rows")

  # A crash can rename the session before the prepared inventory write is
  # observed. Reconstruct only live fwkeeper sessions with a non-empty source
  # owner and an exact, conclusive snapshot.
  while IFS= read -r exact; do
    [[ "$exact" == fwkeeper-* ]] || continue
    snapshot=$(_view_session_snapshot "$exact") || return 1
    IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
    [[ -n "$sid" && -n "$owner" && -n "$members" ]] || continue
    cmux_wal_keeper_blocked "$owner" "$members" && continue
    if ! awk -F'|' -v g="$generation" -v s="$sid" \
        'NF == 7 && $1 == g && $2 == s { found=1 } END { exit(found ? 0 : 1) }' \
        "$KEEPER_INVENTORY" 2>/dev/null; then
      _inventory_upsert "$generation" "$sid" "$exact" "$owner" "$members" committed || return 1
      log "Rebuilt missing keeper inventory row for $exact"
    fi
  done < <(printf '%s\n' "$sessions")
  return 0
}

_quarantine_malformed_view_wal() {
  local wal="$1" reason="$2" base sha sha8 quarantine target
  base=$(basename "$wal")
  sha=$(shasum -a 256 "$wal" 2>/dev/null | awk '{print $1}') || return 1
  [[ -n "$sha" ]] || return 1
  sha8=${sha:0:8}
  quarantine="$VIEW_WAL_DIR/quarantine"
  mkdir -p "$quarantine" 2>/dev/null || return 1
  target="$quarantine/${base}.$(date +%s).$$"
  mv "$wal" "$target" 2>/dev/null || {
    log "WARN: malformed view WAL quarantine move failed: $wal reason=$reason"
    return 1
  }
  log "WARN: quarantined malformed view WAL: $wal -> $target reason=$reason sha256=$sha"
  _alert_cmux_cleanup \
    "cmux malformed construction WAL quarantined" \
    "A syntactically malformed cmux construction WAL was quarantined so unrelated views can reconcile: file=$base reason=$reason sha256=$sha quarantine=$target." \
    "cmux_cleanup|wal-quarantined|$base|$sha8"
  return 0
}

recover_all_view_constructions() {
  local wal line line_count fields view source wid expected recover_rc
  CMUX_WAL_BLOCKED_VIEWS=""
  [[ -d "$VIEW_WAL_DIR" ]] || return 0
  for wal in "$VIEW_WAL_DIR"/*.wal; do
    [[ -f "$wal" ]] || continue
    line=$(cat "$wal" 2>/dev/null) || return 1
    line_count=$(awk 'END { print NR }' "$wal" 2>/dev/null) || return 1
    if [[ "$line_count" != "1" ]]; then
      _quarantine_malformed_view_wal "$wal" "line-count" || return 1
      continue
    fi
    fields=$(printf '%s\n' "$line" | awk -F'|' '{print NF}')
    case "$fields" in
      9)
        view=$(printf '%s\n' "$line" | cut -d'|' -f5)
        source=$(printf '%s\n' "$line" | cut -d'|' -f6)
        wid=$(printf '%s\n' "$line" | cut -d'|' -f7)
        ;;
      11)
        view=$(printf '%s\n' "$line" | cut -d'|' -f7)
        source=$(printf '%s\n' "$line" | cut -d'|' -f8)
        wid=$(printf '%s\n' "$line" | cut -d'|' -f9)
        ;;
      *)
        _quarantine_malformed_view_wal "$wal" "field-count" || return 1
        continue
        ;;
    esac
    if [[ "$view" != "${VIEW_PREFIX}"* ]]; then
      _quarantine_malformed_view_wal "$wal" "view-prefix" || return 1
      continue
    fi
    expected=$(_view_wal_path "$view")
    if [[ "$expected" != "$wal" ]]; then
      _quarantine_malformed_view_wal "$wal" "filename-identity" || return 1
      continue
    fi
    recover_rc=0
    recover_view_construction "$view" || recover_rc=$?
    case "$recover_rc" in
      0) ;;
      2)
        cmux_wal_block_view "$view" "$source" "$wid" || return 1
        ;;
      *) return 1 ;;
    esac
  done
}

prepare_linked_view_state() {
  local phase="${1:-all}"
  case "$phase" in
    pre|all)
      tmux_server_generation >/dev/null || return 1
      recover_all_view_constructions || return 1
      # Keeper recovery consumes no cmux receipt and must precede restored
      # recovery so an escrow residue is visible without letting prepared
      # ledger consumers run first.
      reconcile_keeper_inventory || return 1
      ;;
  esac
  case "$phase" in
    post|all)
      reconcile_prepared_ledger || return 1
      ;;
  esac
}

_view_mismatch_key() {
  printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
}

clear_view_mismatch_latch() {
  local title="$1" key tmp
  [[ -f "$VIEW_ABSENT_STATE" ]] || return 0
  key=$(_view_mismatch_key "$title")
  tmp=$(mktemp "${VIEW_ABSENT_STATE}.XXXX" 2>/dev/null) || return 1
  awk -F'|' -v k="$key" '$1 != k { print }' "$VIEW_ABSENT_STATE" > "$tmp" 2>/dev/null || {
    rm -f "$tmp"; return 1;
  }
  mv "$tmp" "$VIEW_ABSENT_STATE" 2>/dev/null || { rm -f "$tmp"; return 1; }
}

_cmux_log_episode_state_valid() {
  local line kind title evidence last suppressed extra bytes now
  [[ -e "$CMUX_LOG_EPISODE_STATE" || -L "$CMUX_LOG_EPISODE_STATE" ]] || return 0
  [[ -f "$CMUX_LOG_EPISODE_STATE" && ! -L "$CMUX_LOG_EPISODE_STATE" ]] || return 1
  bytes=$(wc -c < "$CMUX_LOG_EPISODE_STATE" 2>/dev/null | tr -d ' ') || return 1
  case "$bytes" in ''|*[!0-9]*) return 1 ;; esac
  (( bytes <= 1048576 )) || return 1
  now=$(date +%s) || return 1
  while IFS='|' read -r kind title evidence last suppressed extra || [[ -n "$kind$title$evidence$last$suppressed${extra:-}" ]]; do
    [[ -n "$kind$title$evidence$last$suppressed" && -z "${extra:-}" ]] || return 1
    case "$kind" in
      view-invariant-mismatch|view-mismatch-pending|legacy-grouped-refused|invariant-repair-deferred) ;;
      *) return 1 ;;
    esac
    case "$title" in *'|'*|*$'\t'*|*$'\n'*|*$'\r'*) return 1 ;; esac
    [[ -n "$title" && ${#title} -le 255 ]] || return 1
    case "$evidence" in *[!0-9a-f]*|"") return 1 ;; esac
    [[ ${#evidence} -eq 64 ]] || return 1
    case "$last$suppressed" in *[!0-9]*) return 1 ;; esac
    [[ ${#last} -le 12 && ${#suppressed} -le 12 ]] || return 1
    (( 10#$last <= 10#$now )) || return 1
  done < "$CMUX_LOG_EPISODE_STATE"
}

_cmux_log_episode_commit() {
  local kind="$1" title="$2" evidence="$3" last="$4" suppressed="$5" tmp dir
  mutator_lease_owned_by_self || return 1
  _cmux_log_episode_state_valid || return 1
  dir=$(dirname "$CMUX_LOG_EPISODE_STATE")
  mkdir -p "$dir" 2>/dev/null || return 1
  touch "$CMUX_LOG_EPISODE_STATE" 2>/dev/null || return 1
  tmp=$(mktemp "${CMUX_LOG_EPISODE_STATE}.XXXX" 2>/dev/null) || return 1
  awk -F'|' -v k="$kind" -v t="$title" '!($1 == k && $2 == t) { print }' \
    "$CMUX_LOG_EPISODE_STATE" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  printf '%s|%s|%s|%s|%s\n' "$kind" "$title" "$evidence" "$last" "$suppressed" \
    >> "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$CMUX_LOG_EPISODE_STATE" 2>/dev/null || { rm -f "$tmp"; return 1; }
}

log_cmux_episode() {
  local kind="$1" title="$2" evidence_raw="$3" message="$4"
  local repeat now evidence previous previous_hash last suppressed elapsed summary=""
  repeat="${FLYWHEEL_CMUX_LOG_REPEAT_SECONDS:-3600}"
  case "$repeat" in ''|*[!0-9]*) repeat=3600 ;; esac
  [[ ${#repeat} -le 7 ]] || repeat=3600
  repeat=$((10#$repeat))
  if (( repeat == 0 )); then
    log "$message"
    return 0
  fi
  case "$kind" in
    view-invariant-mismatch|view-mismatch-pending|legacy-grouped-refused|invariant-repair-deferred) ;;
    *) log "$message"; return 0 ;;
  esac
  case "$title" in ''|*'|'*|*$'\t'*|*$'\n'*|*$'\r'*) log "$message"; return 0 ;; esac
  if ! mutator_lease_owned_by_self; then
    log "$message"
    return 0
  fi
  if ! _cmux_log_episode_state_valid; then
    log "$message"
    log "WARN: cmux log episode state malformed; suppression disabled path=$CMUX_LOG_EPISODE_STATE"
    return 0
  fi
  now=$(date +%s) || { log "$message"; return 0; }
  evidence=$(_cmux_alert_hash "$evidence_raw")
  previous=$(awk -F'|' -v k="$kind" -v t="$title" '$1 == k && $2 == t { print $3 "|" $4 "|" $5; exit }' \
    "$CMUX_LOG_EPISODE_STATE" 2>/dev/null || true)
  if [[ -z "$previous" ]]; then
    _cmux_log_episode_commit "$kind" "$title" "$evidence" "$now" 0 || true
    log "$message"
    return 0
  fi
  IFS='|' read -r previous_hash last suppressed < <(printf '%s\n' "$previous")
  if [[ "$previous_hash" != "$evidence" ]]; then
    _cmux_log_episode_commit "$kind" "$title" "$evidence" "$now" 0 || true
    log "$message"
    return 0
  fi
  elapsed=$((10#$now - 10#$last))
  if (( elapsed < repeat )); then
    suppressed=$((10#$suppressed + 1))
    if ! _cmux_log_episode_commit "$kind" "$title" "$evidence" "$last" "$suppressed"; then
      log "$message"
    fi
    return 0
  fi
  (( suppressed > 0 )) && summary=" (suppressed ${suppressed} repeats)"
  _cmux_log_episode_commit "$kind" "$title" "$evidence" "$now" 0 || true
  log "${message}${summary}"
}

clear_cmux_log_episodes_for_title() {
  local title="$1" tmp
  mutator_lease_owned_by_self || return 0
  [[ -f "$CMUX_LOG_EPISODE_STATE" ]] || return 0
  _cmux_log_episode_state_valid || return 1
  tmp=$(mktemp "${CMUX_LOG_EPISODE_STATE}.XXXX" 2>/dev/null) || return 1
  awk -F'|' -v t="$title" '$2 != t { print }' "$CMUX_LOG_EPISODE_STATE" > "$tmp" 2>/dev/null \
    || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$CMUX_LOG_EPISODE_STATE" 2>/dev/null || { rm -f "$tmp"; return 1; }
}

gc_cmux_log_episodes() {
  local active_titles="$1" tmp active
  mutator_lease_owned_by_self || return 0
  [[ -f "$CMUX_LOG_EPISODE_STATE" ]] || return 0
  _cmux_log_episode_state_valid || return 1
  tmp=$(mktemp "${CMUX_LOG_EPISODE_STATE}.XXXX" 2>/dev/null) || return 1
  active=$(mktemp "${CMUX_LOG_EPISODE_STATE}.active.XXXX" 2>/dev/null) || { rm -f "$tmp"; return 1; }
  printf '%s\n' "$active_titles" | sed '/^$/d' | sort -u > "$active" || { rm -f "$tmp" "$active"; return 1; }
  awk -F'|' 'NR == FNR { live[$1]=1; next } ($2 in live) { print }' "$active" \
    "$CMUX_LOG_EPISODE_STATE" > "$tmp" 2>/dev/null || { rm -f "$tmp" "$active"; return 1; }
  rm -f "$active"
  mv "$tmp" "$CMUX_LOG_EPISODE_STATE" 2>/dev/null || { rm -f "$tmp"; return 1; }
}

view_mismatch_confirmed() {
  # Two identical, conclusive passes are required before a display mutation.
  # Any topology/source/generation change changes the signature and restarts
  # the latch, preventing transient reads from authorizing teardown.
  local title="$1" signature="$2" key sig_hash previous tmp
  key=$(_view_mismatch_key "$title")
  sig_hash=$(_view_mismatch_key "$signature")
  mkdir -p "$(dirname "$VIEW_ABSENT_STATE")" 2>/dev/null || return 1
  touch "$VIEW_ABSENT_STATE" 2>/dev/null || return 1
  previous=$(awk -F'|' -v k="$key" '$1 == k { print $2; exit }' "$VIEW_ABSENT_STATE" 2>/dev/null || true)
  if [[ "$previous" == "$sig_hash" ]]; then
    clear_view_mismatch_latch "$title" || return 1
    return 0
  fi
  tmp=$(mktemp "${VIEW_ABSENT_STATE}.XXXX" 2>/dev/null) || return 1
  awk -F'|' -v k="$key" '$1 != k { print }' "$VIEW_ABSENT_STATE" > "$tmp" 2>/dev/null || {
    rm -f "$tmp"; return 1;
  }
  printf '%s|%s\n' "$key" "$sig_hash" >> "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$VIEW_ABSENT_STATE" 2>/dev/null || { rm -f "$tmp"; return 1; }
  return 1
}

_escrow_fail() {
  local session="$1" stage="$2" reason="$3"
  log "WARN: view escrow failed view=$session stage=$stage reason=$reason"
  return 1
}

escrow_view_session() {
  local session="$1" allow_placeholder="${2:-0}"
  local expected_generation="${3:-}" expected_sid="${4:-}" expected_snapshot="${5:-}"
  local generation inventory_generation snapshot sid grouped active owner marker members group
  local keeper post current
  generation=$(tmux_server_generation) || {
    _escrow_fail "$session" preflight generation-unavailable; return 1;
  }
  inventory_generation=$(_inventory_generation_token "$generation") || {
    _escrow_fail "$session" preflight inventory-generation-token-unavailable; return 1;
  }
  if [[ -n "$expected_generation$expected_sid$expected_snapshot" ]]; then
    [[ -n "$expected_generation" && -n "$expected_sid" && -n "$expected_snapshot" ]] || {
      _escrow_fail "$session" preflight incomplete-expected-proof; return 1;
    }
    [[ "$generation" == "$expected_generation" ]] || {
      _escrow_fail "$session" preflight expected-generation-mismatch; return 1;
    }
  fi
  snapshot=$(_view_session_snapshot "$session") || {
    _escrow_fail "$session" preflight snapshot-unavailable; return 1;
  }
  [[ -z "$expected_snapshot" || "$snapshot" == "$expected_snapshot" ]] || {
    _escrow_fail "$session" preflight expected-snapshot-mismatch; return 1;
  }
  current=$(tmux_server_generation) || {
    _escrow_fail "$session" preflight generation-recheck-unavailable; return 1;
  }
  [[ "$current" == "$generation" ]] || {
    _escrow_fail "$session" preflight generation-changed; return 1;
  }
  IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
  [[ -z "$expected_sid" || "$sid" == "$expected_sid" ]] || {
    _escrow_fail "$session" preflight expected-session-id-mismatch; return 1;
  }
  if [[ "$grouped" == "0" ]]; then
    [[ -n "$owner" ]] || { _escrow_fail "$session" preflight owner-missing; return 1; }
    [[ "$marker" == "0" || "$allow_placeholder" == "1" ]] || {
      _escrow_fail "$session" preflight placeholder-not-authorized; return 1;
    }
  elif [[ "$grouped" == "1" ]]; then
    group=$(tmux display-message -p -t "=$session:" '#{session_group}' 2>/dev/null) || {
      _escrow_fail "$session" owner-publication group-unavailable; return 1;
    }
    [[ -n "$group" ]] || { _escrow_fail "$session" owner-publication group-empty; return 1; }
    owner="$group"
    # Persist the source identity before the grouped name changes; teardown
    # can then prove slot ownership even after the source session disappears.
    _GUARD_TMUX_GENERATION="$generation"
    _GUARD_TMUX_SESSION="$session"
    _GUARD_TMUX_SNAPSHOT="$snapshot"
    _GUARD_TMUX_GROUP="$group"
    tmux_call_guarded _tmux_session_snapshot_guard \
      set-option -t "=$session:" @flywheel_cmux_owner "$owner" \
      2>/dev/null || { _escrow_fail "$session" owner-publication guarded-set-failed; return 1; }
    [[ "$(tmux show-options -v -t "=$session:" @flywheel_cmux_owner 2>/dev/null || true)" == "$owner" ]] || {
      _escrow_fail "$session" owner-publication readback-mismatch; return 1;
    }
    snapshot=$(_view_session_snapshot "$session") || {
      _escrow_fail "$session" owner-publication snapshot-readback-failed; return 1;
    }
    IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
    [[ "$grouped" == "1" && "$owner" == "$group" ]] || {
      _escrow_fail "$session" owner-publication topology-readback-mismatch; return 1;
    }
  else
    _escrow_fail "$session" preflight invalid-grouped-state
    return 1
  fi
  keeper="fwkeeper-${sid#\$}-${session}"
  _inventory_upsert "$inventory_generation" "$sid" "$keeper" "$owner" "$members" prepared || {
    _escrow_fail "$session" inventory-prepared prepared-write-failed; return 1;
  }
  _GUARD_TMUX_GENERATION="$generation"
  _GUARD_TMUX_SESSION="$session"
  _GUARD_TMUX_SNAPSHOT="$snapshot"
  _GUARD_TMUX_GROUP="${group:-}"
  tmux_call_guarded _tmux_session_snapshot_guard \
    rename-session -t "=$session" "$keeper" 2>/dev/null || {
      _escrow_fail "$session" rename guarded-rename-failed; return 1;
    }
  post=$(_view_session_snapshot "$keeper") || {
    _escrow_fail "$session" rename keeper-readback-failed; return 1;
  }
  IFS='|' read -r post _ < <(printf '%s\n' "$post")
  [[ "$post" == "$sid" ]] || { _escrow_fail "$session" rename session-id-readback-mismatch; return 1; }
  current=$(tmux_server_generation) || {
    _escrow_fail "$session" inventory-commit generation-recheck-unavailable; return 1;
  }
  [[ "$current" == "$generation" ]] || {
    _escrow_fail "$session" inventory-commit generation-changed; return 1;
  }
  if linked_session_exists "$session"; then
    _escrow_fail "$session" inventory-commit canonical-name-still-present
    return 1
  fi
  _inventory_upsert "$inventory_generation" "$sid" "$keeper" "$owner" "$members" committed || {
    _escrow_fail "$session" inventory-commit committed-write-failed; return 1;
  }
  printf '%s\n' "$keeper"
}

DISMANTLE_OUTCOME=""
DISMANTLE_REASON=""

_dismantle_fail() {
  local outcome="$1" detail="$2" title="$3" trigger_reason="$4"
  DISMANTLE_OUTCOME="$outcome"
  DISMANTLE_REASON="$detail"
  log "WARN: view dismantle failed title=$title trigger=$trigger_reason outcome=$outcome reason=$detail"
  return 1
}

dismantle_view_display() {
  # Prove and dismantle the independently addressed tmux shell before
  # consuming any cmux receipt. A tmux refusal therefore leaves the visible
  # workspace and its exact ledger authority intact for a later retry.
  local title="$1" trigger_reason="$2" generation refs ref view snapshot sid grouped active owner marker members wid
  local raw same_title_candidates same_title_refs refs_csv variants view_exists=0 source_window=0 stale_state=0
  local tmux_generation tmux_current guard_snapshot guard_sid guard_grouped guard_active guard_owner guard_marker guard_members
  local tmux_started=0 restored_rc=0
  DISMANTLE_OUTCOME=""
  DISMANTLE_REASON=""
  if cmux_wal_title_blocked "$title"; then
    _dismantle_fail preflight-refused construction-collision "$title" "$trigger_reason"
    return 1
  fi
  generation=$(cmux_socket_identity) || {
    _dismantle_fail preflight-refused cmux-generation-unavailable "$title" "$trigger_reason"
    return 1
  }
  if [[ -z "$generation" ]]; then
    _dismantle_fail preflight-refused cmux-generation-empty "$title" "$trigger_reason"
    return 1
  fi
  refs=$(ledger_refs_for_title "$generation" "$title")
  _restored_parse_records >/dev/null || restored_rc=$?
  if [[ "$restored_rc" -ne 0 ]]; then
    _dismantle_fail preflight-refused restored-state-invalid "$title" "$trigger_reason"
    return 1
  fi
  while IFS= read -r ref; do
    [[ -z "$ref" ]] && continue
    restored_rc=0
    restored_inflight_state "$generation" "$ref" "$title" || restored_rc=$?
    case "$restored_rc" in
      0)
        _dismantle_fail preflight-refused restored-inflight "$title" "$trigger_reason"
        return 1
        ;;
      1) ;;
      *)
        _dismantle_fail preflight-refused restored-state-invalid "$title" "$trigger_reason"
        return 1
        ;;
    esac
  done < <(printf '%s\n' "$refs")
  if [[ -z "$refs" ]]; then
    if ! raw=$(get_cmux_workspaces_json); then
      log "WARN: unledgered cleanup refused generation=$generation title=$title reason=workspace-json-unavailable"
      _alert_cmux_cleanup \
        "cmux cleanup refused: workspace inventory unavailable" \
        "An unledgered cleanup candidate was preserved because workspace JSON was unavailable: generation=$generation title=$title reason=$trigger_reason." \
        "cmux_cleanup|generation=$generation|title=$title|refs_sha256=$(_cmux_alert_hash '__unavailable__')|reason=workspace-json-unavailable"
      _dismantle_fail preflight-refused workspace-json-unavailable "$title" "$trigger_reason"
      return 1
    fi
    variants=$(managed_view_command_variants "${VIEW_PREFIX}${title}") || variants=""
    same_title_candidates=$(workspace_title_candidates "$raw" "$title" "$variants") || {
      log "WARN: unledgered cleanup refused generation=$generation title=$title reason=workspace-json-unparseable"
      _alert_cmux_cleanup \
        "cmux cleanup refused: workspace inventory unparseable" \
        "An unledgered cleanup candidate was preserved because workspace JSON could not be parsed: generation=$generation title=$title reason=$trigger_reason." \
        "cmux_cleanup|generation=$generation|title=$title|refs_sha256=$(_cmux_alert_hash '__unparseable__')|reason=workspace-json-unparseable"
      _dismantle_fail preflight-refused workspace-json-unparseable "$title" "$trigger_reason"
      return 1
    }
    same_title_refs=$(printf '%s\n' "$same_title_candidates" \
      | awk -F'|' 'NF == 5 { print $2 }') || return 1
    if [[ -n "$same_title_refs" ]]; then
      view="${VIEW_PREFIX}${title}"
      grouped="unknown"; owner="unknown"
      if linked_session_exists "$view"; then
        view_exists=1
        snapshot=$(_view_session_snapshot "$view" 2>/dev/null || true)
        if [[ -n "$snapshot" ]]; then
          IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
          [[ -n "$owner" ]] || owner="none"
        fi
      fi
      if get_tmux_agent_windows | awk -F'|' -v t="$title" '$3 == t { found=1 } END { exit(found ? 0 : 1) }'; then
        source_window=1
      fi
      if [[ -f "$STALE_STATE" ]] && awk -F'|' -v t="$title" '$1 == t { found=1 } END { exit(found ? 0 : 1) }' "$STALE_STATE"; then
        stale_state=1
      fi
      refs_csv=$(printf '%s\n' "$same_title_refs" | sort | paste -sd, -)
      log "WARN: unledgered cleanup refused generation=$generation title=$title refs=$refs_csv view_exists=$view_exists grouped=$grouped owner=$owner source_window=$source_window stale_state=$stale_state reason=present-same-title-ref manual resolution required"
      _alert_cmux_cleanup \
        "cmux cleanup refused: unledgered workspace present" \
        "A same-title cmux workspace has no current-generation receipt and was preserved: generation=$generation title=$title refs=$refs_csv view_exists=$view_exists grouped=$grouped owner=$owner source_window=$source_window stale_state=$stale_state." \
        "cmux_cleanup|generation=$generation|title=$title|refs_sha256=$(_cmux_alert_hash "$(printf '%s\n' "$same_title_refs" | sort)")|reason=present-same-title-ref"
      _dismantle_fail preflight-refused present-same-title-ref "$title" "$trigger_reason"
      return 1
    fi
  fi

  view="${VIEW_PREFIX}${title}"
  if linked_session_exists "$view"; then
    tmux_generation=$(tmux_server_generation) || {
      _dismantle_fail preflight-refused tmux-generation-unavailable "$title" "$trigger_reason"
      return 1
    }
    if ! _view_shell_owned_for_title "$view" "$title" 1 0 0; then
      _dismantle_fail preflight-refused tmux-ownership-unproven "$title" "$trigger_reason"
      return 1
    fi
    tmux_current=$(tmux_server_generation) || {
      _dismantle_fail preflight-refused tmux-generation-recheck-unavailable "$title" "$trigger_reason"
      return 1
    }
    if [[ "$tmux_current" != "$tmux_generation" ]]; then
      _dismantle_fail preflight-refused tmux-generation-changed "$title" "$trigger_reason"
      return 1
    fi
    snapshot="$OWNED_VIEW_SNAPSHOT"
    IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
    if [[ "$grouped" == "1" ]]; then
      tmux_started=1
      if ! escrow_view_session "$view" >/dev/null; then
        _dismantle_fail tmux-partial-recoverable grouped-escrow-failed "$title" "$trigger_reason"
        return 1
      fi
    else
      if [[ "$grouped" != "0" || -z "$owner" || "$marker" != "0" ]]; then
        _dismantle_fail preflight-refused independent-shape-unproven "$title" "$trigger_reason"
        return 1
      fi
      while IFS= read -r wid; do
        [[ -z "$wid" ]] && continue
        if ! guard_snapshot=$(_view_session_snapshot "$view"); then
          if [[ "$tmux_started" == "1" ]]; then
            _dismantle_fail tmux-partial-recoverable tmux-snapshot-unavailable "$title" "$trigger_reason"
          else
            _dismantle_fail preflight-refused tmux-snapshot-unavailable "$title" "$trigger_reason"
          fi
          return 1
        fi
        IFS='|' read -r guard_sid guard_grouped guard_active guard_owner guard_marker guard_members < <(printf '%s\n' "$guard_snapshot")
        if [[ "$guard_sid" != "$sid" || "$guard_grouped" != "0" \
            || "$guard_owner" != "$owner" || "$guard_marker" != "0" ]]; then
          if [[ "$tmux_started" == "1" ]]; then
            _dismantle_fail tmux-partial-recoverable tmux-snapshot-changed "$title" "$trigger_reason"
          else
            _dismantle_fail preflight-refused tmux-snapshot-changed "$title" "$trigger_reason"
          fi
          return 1
        fi
        case ",$guard_members," in
          *",$wid,"*) ;;
          *)
            if [[ "$tmux_started" == "1" ]]; then
              _dismantle_fail tmux-partial-recoverable tmux-member-disappeared "$title" "$trigger_reason"
            else
              _dismantle_fail preflight-refused tmux-member-disappeared "$title" "$trigger_reason"
            fi
            return 1
            ;;
        esac
        _GUARD_TMUX_GENERATION="$tmux_generation"
        _GUARD_TMUX_SESSION="$view"
        _GUARD_TMUX_SNAPSHOT="$guard_snapshot"
        _GUARD_TMUX_GROUP=""
        tmux_started=1
        if ! tmux_call_guarded _tmux_session_snapshot_guard \
            unlink-window -t "=${view}:${wid}" 2>/dev/null; then
          # Atomic last-reference refusal means this view is now the sole
          # holder; preserve it by escrow rename instead of killing a window.
          if ! escrow_view_session "$view" >/dev/null; then
            _dismantle_fail tmux-partial-recoverable independent-escrow-failed "$title" "$trigger_reason"
            return 1
          fi
          break
        fi
        linked_session_exists "$view" || break
      done < <(printf '%s\n' "$(printf '%s' "$members" | tr ',' '\n')")
      if linked_session_exists "$view"; then
        _dismantle_fail tmux-partial-recoverable tmux-shell-still-present "$title" "$trigger_reason"
        return 1
      fi
    fi
  fi

  while IFS= read -r ref; do
    [[ -z "$ref" ]] && continue
    if ! close_ledger_workspace_ref "$generation" "$ref" "$title" "$trigger_reason"; then
      _dismantle_fail tmux-complete-cmux-pending "cmux-close-failed:$ref" "$title" "$trigger_reason"
      return 1
    fi
  done < <(printf '%s\n' "$refs")
  DISMANTLE_OUTCOME="complete"
  DISMANTLE_REASON=""
  log "[audit] view dismantle complete title=$title trigger=$trigger_reason"
  return 0
}

VIEW_BUILD_OUTCOME=""
create_or_replace_view_session() {
  # Build under a private name, then atomically claim cmux-<title>. A canonical
  # view is never visible while it contains the placeholder or a wrong window.
  local source_session="$1" window_id="$2" window_name="$3"
  local view_session="${VIEW_PREFIX}${window_name}" nonce stage generation wal
  local stage_sid="" placeholder_id="" snapshot source_snapshot sid grouped active owner marker members
  local observed source_name source_dead
  VIEW_BUILD_OUTCOME=""
  case "$source_session$window_id$window_name" in *'|'*|*$'\n'*) return 1 ;; esac
  if cmux_wal_view_blocked "$view_session"; then
    log "WARN: linked-view build blocked by preserved construction collision: view=$view_session"
    return 1
  fi
  generation=$(tmux_server_generation) || { log "WARN: tmux generation unreadable; refusing linked-view build for $window_name"; return 1; }
  source_snapshot=$(_view_session_snapshot "$source_session") || return 1
  observed=$(tmux display-message -p -t "=${source_session}:${window_id}" \
    '#{window_name}|#{pane_dead}' 2>/dev/null) || return 1
  IFS='|' read -r source_name source_dead < <(printf '%s\n' "$observed")
  [[ "$source_name" == "$window_name" && "$source_dead" == "0" ]] || return 1
  nonce=$(_new_view_nonce)
  case "$nonce" in ''|*[!A-Za-z0-9_.-]*) log "WARN: invalid view nonce"; return 1 ;; esac
  stage="fwstage-${nonce}"
  wal=$(_view_wal_path "$view_session")

  # Never overwrite an unresolved construction record. Recovery owns it.
  if [[ -e "$wal" ]]; then
    log "WARN: unresolved view WAL for $view_session; refusing a second build"
    return 1
  fi
  _write_view_wal "$wal" "$generation" create_intent "$nonce" "$view_session" \
    "$source_session" "$window_id" "" "" || return 1

  _GUARD_VIEW_BUILD_GENERATION="$generation"
  _GUARD_VIEW_BUILD_SOURCE="$source_session"
  _GUARD_VIEW_BUILD_SOURCE_SNAPSHOT="$source_snapshot"
  _GUARD_VIEW_BUILD_WINDOW_ID="$window_id"
  _GUARD_VIEW_BUILD_WINDOW_NAME="$window_name"
  _GUARD_VIEW_BUILD_STAGE=""
  _GUARD_VIEW_BUILD_STAGE_SNAPSHOT=""
  _GUARD_VIEW_BUILD_CANONICAL_ABSENT=""
  if ! tmux_call_guarded _tmux_view_build_guard \
      new-session -d -s "$stage" -n '__flywheel_placeholder__' 2>/dev/null; then
    log "WARN: staging session create failed for $view_session"
    return 1
  fi
  snapshot=$(_view_session_snapshot "$stage") || return 1
  IFS='|' read -r stage_sid grouped placeholder_id owner marker members < <(printf '%s\n' "$snapshot")
  [[ -n "$stage_sid" && "$grouped" == "0" && -n "$placeholder_id" \
      && -z "$owner" && -z "$marker" && "$members" == "$placeholder_id" ]] || return 1
  observed=$(tmux display-message -p -t "=${stage}:${placeholder_id}" \
    '#{window_name}' 2>/dev/null) || return 1
  [[ "$observed" == "__flywheel_placeholder__" ]] || return 1

  _GUARD_VIEW_BUILD_STAGE="$stage"
  _GUARD_VIEW_BUILD_STAGE_SNAPSHOT="$snapshot"
  tmux_call_guarded _tmux_view_build_guard \
    set-option -t "=$stage:" @flywheel_cmux_owner "$source_session" 2>/dev/null || return 1
  snapshot=$(_view_session_snapshot "$stage") || return 1
  IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
  [[ "$sid" == "$stage_sid" && "$grouped" == "0" && "$owner" == "$source_session" \
      && -z "$marker" && "$members" == "$placeholder_id" ]] || return 1
  _GUARD_VIEW_BUILD_STAGE_SNAPSHOT="$snapshot"
  tmux_call_guarded _tmux_view_build_guard \
    set-option -t "=$stage:" @flywheel_cmux_placeholder 1 2>/dev/null || return 1
  snapshot=$(_view_session_snapshot "$stage") || return 1
  IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
  [[ "$sid" == "$stage_sid" && "$grouped" == "0" && "$owner" == "$source_session" \
      && "$marker" == "1" && "$members" == "$placeholder_id" ]] || return 1
  _write_view_wal "$wal" "$generation" created "$nonce" "$view_session" \
    "$source_session" "$window_id" "$stage_sid" "$placeholder_id" || return 1

  _write_view_wal "$wal" "$generation" link_intent "$nonce" "$view_session" \
    "$source_session" "$window_id" "$stage_sid" "$placeholder_id" || return 1
  _GUARD_VIEW_BUILD_STAGE_SNAPSHOT="$snapshot"
  tmux_call_guarded _tmux_view_build_guard \
    link-window -s "=${source_session}:${window_id}" -t "=${stage}:" 2>/dev/null || return 1
  snapshot=$(_view_session_snapshot "$stage") || return 1
  IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
  if [[ "$sid" != "$stage_sid" || "$grouped" != "0" || "$owner" != "$source_session" \
     || "$marker" != "1" || "$members" != "$placeholder_id,$window_id" && "$members" != "$window_id,$placeholder_id" ]]; then
    log "WARN: staging topology mismatch for $view_session; leaving WAL for recovery"
    return 1
  fi
  _write_view_wal "$wal" "$generation" linked "$nonce" "$view_session" \
    "$source_session" "$window_id" "$stage_sid" "$placeholder_id" || return 1

  # The marker and exact id prove this is our disposable initial window.
  _GUARD_VIEW_BUILD_STAGE_SNAPSHOT="$snapshot"
  tmux_call_guarded _tmux_view_build_guard \
    kill-window -t "=${stage}:${placeholder_id}" 2>/dev/null || return 1
  snapshot=$(_view_session_snapshot "$stage") || return 1
  IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
  [[ "$sid" == "$stage_sid" && "$grouped" == "0" && "$owner" == "$source_session" \
      && "$marker" == "1" && "$members" == "$window_id" ]] || return 1
  _GUARD_VIEW_BUILD_STAGE_SNAPSHOT="$snapshot"
  tmux_call_guarded _tmux_view_build_guard \
    select-window -t "=${stage}:${window_id}" 2>/dev/null || return 1
  snapshot=$(_view_session_snapshot "$stage") || return 1
  IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
  [[ "$sid" == "$stage_sid" && "$grouped" == "0" && "$active" == "$window_id" \
      && "$owner" == "$source_session" && "$marker" == "1" \
      && "$members" == "$window_id" ]] || return 1
  _GUARD_VIEW_BUILD_STAGE_SNAPSHOT="$snapshot"
  tmux_call_guarded _tmux_view_build_guard \
    set-option -t "=$stage:" @flywheel_cmux_placeholder 0 2>/dev/null || return 1
  _linked_view_matches "$stage" "$window_id" "$source_session" "$stage_sid" \
    "$window_name" "$generation" || return 1
  snapshot="$OWNED_VIEW_SNAPSHOT"

  _write_view_wal "$wal" "$generation" claim_intent "$nonce" "$view_session" \
    "$source_session" "$window_id" "$stage_sid" "$placeholder_id" || return 1
  if linked_session_exists "$view_session"; then
    log "WARN: canonical view name already occupied: $view_session"
    return 1
  fi
  _GUARD_VIEW_BUILD_STAGE_SNAPSHOT="$snapshot"
  _GUARD_VIEW_BUILD_CANONICAL_ABSENT="$view_session"
  tmux_call_guarded _tmux_view_build_guard \
    rename-session -t "=$stage" "$view_session" 2>/dev/null || return 1
  _GUARD_VIEW_BUILD_CANONICAL_ABSENT=""
  _linked_view_matches "$view_session" "$window_id" "$source_session" "$stage_sid" \
    "$window_name" "$generation" || return 1
  if linked_session_exists "$stage"; then
    log "WARN: canonical claim left staging name alive: $stage"
    return 1
  fi
  _write_view_wal "$wal" "$generation" claimed_complete "$nonce" "$view_session" \
    "$source_session" "$window_id" "$stage_sid" "$placeholder_id" || return 1
  _GUARD_VIEW_BUILD_STAGE="$view_session"
  _GUARD_VIEW_BUILD_STAGE_SNAPSHOT="$OWNED_VIEW_SNAPSHOT"
  _GUARD_VIEW_BUILD_CANONICAL_ABSENT=""
  _tmux_view_build_guard || return 1
  rm -f "$wal" 2>/dev/null || return 1
  VIEW_BUILD_OUTCOME="staging_ready"
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

  # Persist exact execution identity before the workspace-exists branch and
  # before any cmux mutation. This closes the event→additive crash window where
  # a short-lived mirror could otherwise die without ever entering the cleanup
  # classifier.
  admit_node_identity_for_window "$source_session" "$window_id" "$window_name" || true

  if cmux_wal_view_blocked "$view_session"; then
    log "WARN: workspace create blocked by preserved construction collision: view=$view_session"
    return 0
  fi

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
  if create_recently_attempted "$window_name" "$window_id" \
      && ! ops_rebuild_authorizes_create "$source_session" "$window_id" "$window_name"; then
    log "Skipping duplicate create for: $window_name ($window_id) (attempted within last $(_create_dedup_seconds)s)"
    return 0
  fi

  local raw_before cmux_generation="" clients_before="" attachment_unverified=0 snapshot_generation=""
  cmux_generation=$(cmux_socket_identity)
  if [[ -z "$cmux_generation" ]]; then
    log "WARN: cmux generation unreadable; refusing unledgered create for $window_name"
    return 0
  fi
  raw_before=$(get_cmux_workspaces_json) || return 0  # JSON unavailable → skip
  snapshot_generation=$(cmux_socket_identity)
  if [[ "$snapshot_generation" != "$cmux_generation" ]]; then
    log "WARN: cmux generation changed during pre-create snapshot for $window_name; refusing create"
    return 0
  fi

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

  if [[ -n "$cmux_generation" ]] \
      && [[ -n "$(ledger_rows_for_title "$cmux_generation" "$window_name")" ]]; then
    log "Rename-lag receipt already owns logical slot; create deferred: generation=$cmux_generation title=$window_name"
    return 0
  fi

  log "Creating workspace for: $window_name ($window_id) from session $source_session"

  # 1. Create the independent exact-one-window tmux view through the staging WAL.
  recover_view_construction "$view_session" || return 0
  if ! linked_session_exists "$view_session"; then
    create_or_replace_view_session "$source_session" "$window_id" "$window_name" || {
      log "WARN: isolated view build deferred for $window_name"
      return 0
    }
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
  if ! _linked_view_matches "$view_session" "$window_id" "$source_session"; then
    log "WARN: $view_session failed isolated topology ready gate — deferring create for $window_name"
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
  clients_before=$(view_session_client_count "$view_session") || attachment_unverified=1
  local attach_cmd attach_token
  attach_token=$(new_managed_attach_token) || {
    log "WARN: attach token generation failed for $window_name; deferring workspace create"
    return 0
  }
  attach_cmd=$(build_attach_command "$view_session" "$attach_token") || {
    log "WARN: attach command rejected for $window_name; deferring workspace create"
    return 0
  }
  local create_rc=0
  _GUARD_CREATE_GENERATION="$cmux_generation"
  cmux_call_guarded _create_generation_guard new-workspace --command "$attach_cmd" || create_rc=$?
  if [[ "$create_rc" -ne 0 ]]; then
    log "WARN: cmux new-workspace failed for $window_name (see prior log lines)"
    return 0
  fi

  # 5. Race protection: re-snapshot after create. If JSON is unavailable
  # here we can't rename — log + return; the window will be unnamed cmux-side
  # until next reconcile pass.
  local raw_after refs_after new_ref new_uuid
  raw_after=$(get_cmux_workspaces_json) || {
    log "WARN: attachment_unverified generation=$cmux_generation ref=unknown title=$window_name reason=post-create-read-failed"
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
  local new_refs new_ref_count
  new_refs=$(grep -vFxf <(printf '%s' "$refs_before") <(printf '%s' "$refs_after") || true)
  new_ref_count=$(printf '%s\n' "$new_refs" | grep -c . || true)
  new_ref=$(printf '%s\n' "$new_refs" | head -1 || true)
  new_uuid=$(printf '%s' "$raw_after" | python3 -c '
import json,sys
r=sys.argv[1]
matches=[w.get("id") for w in json.load(sys.stdin).get("workspaces", [])
         if isinstance(w, dict) and w.get("ref") == r and isinstance(w.get("id"), str)]
if len(matches) != 1:
    sys.exit(1)
print(matches[0])
' "$new_ref" 2>/dev/null || true)

  # 6. Rename using the exact ref — immune to user tab switching
  local current_generation confirm_raw confirm_count post_clients
    current_generation=$(cmux_socket_identity)
    if [[ "$current_generation" != "$cmux_generation" || "$new_ref_count" != "1" || -z "$new_ref" ]]; then
      log "WARN: create ref diff/generation ambiguous for $window_name; leaving workspace unledgered and unnamed"
      return 0
    fi
    if ! _workspace_uuid_valid "$new_uuid"; then
      log "WARN: created workspace lacks a stable UUID for $window_name; rolling back exact unnamed ref"
      rollback_unreceipted_workspace "$cmux_generation" "$new_ref" "$attach_cmd" || true
      return 0
    fi
    local prepared_rc=0
    _ledger_upsert prepared "$cmux_generation" "$new_ref" "$window_name" "$new_uuid" || prepared_rc=$?
    if [[ "$prepared_rc" -ne 0 ]]; then
      if [[ "$prepared_rc" -eq 75 || "$WATCHER_AUTHORITY_LOST" == "1" ]]; then
        log "ERROR: prepared ledger write lost mutator authority for $new_ref; preserving exact unreceipted workspace and aborting pass"
        return 0
      fi
      log "WARN: cannot persist prepared ledger row for $new_ref; rolling back exact unnamed ref"
      if ! rollback_unreceipted_workspace "$cmux_generation" "$new_ref" "$attach_cmd" "$new_uuid"; then
        log "WARN: rollback failed for unreceipted workspace generation=$cmux_generation ref=$new_ref; manual resolution required"
        _alert_cmux_cleanup \
          "cmux unreceipted workspace rollback failed" \
          "The exact unnamed workspace created by this attempt could not be rolled back and was preserved for manual resolution: generation=$cmux_generation ref=$new_ref." \
          "cmux_cleanup|rollback|generation=$cmux_generation|ref=$new_ref"
      fi
      return 0
    fi
    _GUARD_RENAME_GENERATION="$cmux_generation"
    _GUARD_RENAME_REF="$new_ref"
    _GUARD_RENAME_TITLE="$window_name"
    _GUARD_RENAME_PROVISIONAL_TITLE="$attach_cmd"
    _GUARD_RENAME_UUID="$new_uuid"
    if ! cmux_call_guarded _prepared_rename_guard rename-workspace --workspace "$new_ref" "$window_name"; then
      log "WARN: rename failed for prepared workspace $new_ref; recovery will reconcile it"
      return 0
    fi
    confirm_raw=$(get_cmux_workspaces_json) || {
      log "WARN: attachment_unverified generation=$cmux_generation ref=$new_ref title=$window_name reason=post-rename-read-failed"
      return 0
    }
    current_generation=$(cmux_socket_identity)
    [[ "$current_generation" == "$cmux_generation" ]] || {
      log "WARN: cmux generation changed after rename for $new_ref; preserving prepared row"
      return 0
    }
    confirm_count=$(printf '%s' "$confirm_raw" | python3 -c '
import json,sys
r,t=sys.argv[1:3]
print(sum(1 for w in json.load(sys.stdin).get("workspaces", [])
          if w.get("ref") == r and w.get("title") == t))
' "$new_ref" "$window_name") || return 0
    [[ "$confirm_count" == "1" ]] || {
      log "WARN: rename readback mismatch for $new_ref; preserving prepared row"
      return 0
    }
    # The shared migration helper UUID-fences the tab rename and preserves the
    # receipt through commit. Failure leaves `prepared` for the next reconcile.
    complete_title_migration "$new_ref" "$window_name" "$cmux_generation" "$attach_cmd" || {
      log "WARN: cannot complete title migration for prepared workspace $new_ref"
      return 0
    }
  post_clients=$(view_session_client_count "$view_session") || attachment_unverified=1
  if [[ "$attachment_unverified" == "1" \
     || -z "$clients_before" || "$clients_before" -gt 0 ]]; then
    log "WARN: attachment_unverified generation=$cmux_generation ref=$new_ref title=$window_name reason=client-baseline-ambiguous"
  elif [[ -z "$post_clients" || "$post_clients" -le 0 ]]; then
    log "WARN: attachment_unverified generation=$cmux_generation ref=$new_ref title=$window_name reason=no-post-create-client"
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
    local vc_attempt vc_clients vc_generation="$cmux_generation" vc_limit
    vc_limit=$(_attach_retry_limit)
    for ((vc_attempt=1; vc_attempt<=vc_limit + 1; vc_attempt++)); do
      vc_clients=$(view_session_client_count "$view_session") || break  # tmux error → stop (fail-closed)
      [[ "$vc_clients" -gt 0 ]] && break                                # attached — done
      self_heal_workspace_ref "$window_name" "$new_ref" "$vc_generation" || true # re-drive attach (ref-scoped, gated)
      (( vc_attempt <= vc_limit )) && sleep 1
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
    watcher_mutation_latch_clear || break
    local agent_name="${sess#"${VIEW_PREFIX}"}" pane_rc=0
    # Exact match check (not substring)
    if echo "$active_names" | grep -qx "$agent_name"; then
      continue
    fi
    is_pane_alive "$agent_name" || pane_rc=$?
    if [[ "$pane_rc" == "1" ]]; then
      log "Cleaning stale: $sess (tmux window '$agent_name' gone)"
      mark_for_cleanup "$agent_name" "$(date +%s)"
    elif [[ "$pane_rc" != "0" ]]; then
      log "WARN: liveness unavailable for $agent_name; stale cleanup deferred"
    fi
  done < <(printf '%s\n' "$linked_sessions")
}

repair_view_invariants() {
  # Strict two-phase pass: first read every source and candidate view. A single
  # inconclusive read returns before any mutation. Only then repair mismatches.
  local sessions source_rows="" session rows winners plan repair_generation
  repair_generation=$(tmux_server_generation) || return 1
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null) || {
    log "WARN: tmux source inventory unavailable; invariant pass skipped"
    return 1
  }
  while IFS= read -r session; do
    case "$session" in flywheel|runner-*) ;; *) continue ;; esac
    rows=$(tmux list-windows -t "$session" \
      -F '#{session_name}|#{window_id}|#{window_name}|#{pane_dead}' 2>/dev/null) || {
      log "WARN: tmux window inventory unavailable for $session; invariant pass skipped"
      return 1
    }
    [[ -n "$rows" ]] && source_rows="${source_rows}${source_rows:+$'\n'}${rows}"
  done < <(printf '%s\n' "$sessions")
  [[ -z "$source_rows" ]] && return 0
  winners=$(printf '%s\n' "$source_rows" | awk -F'|' '
$4 == "0" && $3 != "zsh" && $3 != "bash" {
  id=$2; sub(/^@/, "", id); name=$3
  if (!(name in max) || id+0 > max[name]) {
    max[name]=id+0; row[name]=$1 "|" $2 "|" $3
  }
}
END { for (name in row) print row[name] }
')
  [[ -z "$winners" ]] && return 0
  plan=$(mktemp) || return 1
  local source wid title view snapshot
  while IFS='|' read -r source wid title; do
    [[ -z "$source" || -z "$wid" || -z "$title" ]] && continue
    case "$title" in *$'\t'*|*$'\n'*) rm -f "$plan"; return 1 ;; esac
    view="${VIEW_PREFIX}${title}"
    if printf '%s\n' "$sessions" | grep -qxF "$view"; then
      snapshot=$(_view_session_snapshot "$view") || { rm -f "$plan"; return 1; }
      printf '%s\t%s\t%s\t%s\n' "$source" "$wid" "$title" "$snapshot" >> "$plan"
    else
      printf '%s\t%s\t%s\tabsent\n' "$source" "$wid" "$title" >> "$plan"
    fi
  done < <(printf '%s\n' "$winners")

  local sid grouped active owner marker members cmux_generation current_refs mismatch_signature active_titles
  while IFS=$'\t' read -r source wid title snapshot; do
    if cmux_wal_title_blocked "$title"; then
      log "WARN: invariant repair blocked by preserved construction collision: title=$title"
      continue
    fi
    if [[ "$snapshot" == "absent" ]]; then
      clear_cmux_log_episodes_for_title "$title" || true
      continue
    fi
    IFS='|' read -r sid grouped active owner marker members < <(printf '%s\n' "$snapshot")
    if [[ "$grouped" == "0" && "$active" == "$wid" && "$owner" == "$source" \
         && "$marker" == "0" && "$members" == "$wid" ]]; then
      clear_view_mismatch_latch "$title" || { rm -f "$plan"; return 1; }
      clear_cmux_log_episodes_for_title "$title" || true
      continue
    fi
    mismatch_signature="$repair_generation|$source|$wid|$sid|$grouped|$active|$owner|$marker|$members"
    log_cmux_episode view-invariant-mismatch "$title" "$mismatch_signature" \
      "Invariant mismatch: ${VIEW_PREFIX}${title} grouped=$grouped active=$active members=$members expected=$wid"
    if ! view_mismatch_confirmed "$title" \
        "$mismatch_signature"; then
      log_cmux_episode view-mismatch-pending "$title" "$mismatch_signature" \
        "Invariant mismatch pending second conclusive pass: ${VIEW_PREFIX}${title}"
      continue
    fi
    if [[ "$grouped" == "1" && -z "$owner" && -z "$marker" ]]; then
      cmux_generation=$(cmux_socket_identity) || {
        log "WARN: legacy grouped backfill deferred for $title; cmux generation unavailable"
        continue
      }
      current_refs=$(ledger_refs_for_title "$cmux_generation" "$title")
      if [[ -z "$current_refs" ]]; then
        _alert_cmux_cleanup \
          "cmux legacy grouped migration refused" \
          "A legacy grouped view was preserved because no current-generation exact workspace receipt authorizes migration: generation=$cmux_generation title=$title view=${VIEW_PREFIX}${title}." \
          "cmux_cleanup|legacy-grouped|generation=$cmux_generation|title=$title|reason=missing-exact-receipt"
        log_cmux_episode legacy-grouped-refused "$title" \
          "$cmux_generation|missing-exact-receipt|$mismatch_signature" \
          "WARN: legacy grouped migration refused for $title; no exact receipt"
        continue
      fi
    fi
    if dismantle_view_display "$title" "view-invariant-mismatch"; then
      create_or_replace_view_session "$source" "$wid" "$title" || {
        rm -f "$plan"; return 1;
      }
      clear_view_mismatch_latch "$title" || { rm -f "$plan"; return 1; }
      clear_cmux_log_episodes_for_title "$title" || true
    else
      # Most commonly an unledgered founder/pre-upgrade collision. The
      # alert/manual contract forbids inventing authority or touching it.
      log_cmux_episode invariant-repair-deferred "$title" \
        "$mismatch_signature|${DISMANTLE_OUTCOME:-preflight-refused}|${DISMANTLE_REASON:-unknown}" \
        "WARN: invariant repair deferred for $title outcome=${DISMANTLE_OUTCOME:-preflight-refused} reason=${DISMANTLE_REASON:-unknown}"
    fi
  done < "$plan"
  rm -f "$plan"
  active_titles=$(printf '%s\n' "$winners" | awk -F'|' 'NF == 3 { print $3 }' | sort -u)
  gc_cmux_log_episodes "$active_titles" || \
    log "WARN: cannot GC cmux log episode state at $CMUX_LOG_EPISODE_STATE"
  return 0
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
  prepare_linked_view_state pre || {
    log "WARN: linked-view durable state reconciliation failed; refresh skipped"
    return 1
  }
  refresh_linked_sessions_tail
}

refresh_linked_sessions_tail() {
  recover_restored_transactions || {
    log "WARN: restored transaction recovery failed; refresh skipped"
    return 1
  }
  prepare_linked_view_state post || {
    log "WARN: linked-view ledger reconciliation failed; refresh skipped"
    return 1
  }
  repair_view_invariants
}

rebind_episode_state_valid() {
  [[ -e "$REBIND_EPISODE_STATE" || -L "$REBIND_EPISODE_STATE" ]] || return 0
  [[ -f "$REBIND_EPISODE_STATE" && ! -L "$REBIND_EPISODE_STATE" && -r "$REBIND_EPISODE_STATE" ]] || return 1
  python3 - "$REBIND_EPISODE_STATE" <<'PY' >/dev/null 2>&1
import re
import sys

seen = set()
uuid = re.compile(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")
for raw in open(sys.argv[1], encoding="utf-8"):
    row = raw.rstrip("\n").split("|")
    if len(row) != 11 or row[0] != "rebindv1": raise SystemExit(1)
    if not re.fullmatch(r"[0-9a-f]{64}", row[1]) or not uuid.fullmatch(row[2]): raise SystemExit(1)
    if not re.fullmatch(r"workspace:[0-9]+", row[3]) or not re.fullmatch(r"[0-9a-f]{64}", row[4]): raise SystemExit(1)
    if not row[5] or not row[6] or not row[7].startswith("runner-") or not re.fullmatch(r"@[0-9]+", row[8]): raise SystemExit(1)
    if row[9] not in {"intent", "viewer-ready", "receipt-ready", "attached", "failed"} or row[10] not in {"0", "1"}: raise SystemExit(1)
    if row[6] in seen or any(any(ord(char) < 32 or ord(char) == 127 for char in value) for value in row): raise SystemExit(1)
    seen.add(row[6])
PY
}

rebind_episode_row() {
  local title="$1"
  rebind_episode_state_valid || return 1
  [[ -f "$REBIND_EPISODE_STATE" ]] || return 1
  awk -F'|' -v t="$title" '$7 == t { print; found=1; exit } END { exit(found ? 0 : 1) }' \
    "$REBIND_EPISODE_STATE"
}

rebind_episode_state_upsert() {
  local row="$1" title dir tmp source=/dev/null saved
  title=$(printf '%s\n' "$row" | cut -d'|' -f7)
  rebind_episode_state_valid || return 1
  dir=$(dirname "$REBIND_EPISODE_STATE"); mkdir -p "$dir" || return 1
  [[ -f "$REBIND_EPISODE_STATE" ]] && source="$REBIND_EPISODE_STATE"
  tmp=$(mktemp "${REBIND_EPISODE_STATE}.XXXX") || return 1
  awk -F'|' -v t="$title" '$7 != t { print }' "$source" > "$tmp" \
    || { rm -f "$tmp"; return 1; }
  printf '%s\n' "$row" >> "$tmp" || { rm -f "$tmp"; return 1; }
  saved="$REBIND_EPISODE_STATE"; REBIND_EPISODE_STATE="$tmp"
  rebind_episode_state_valid || { REBIND_EPISODE_STATE="$saved"; rm -f "$tmp"; return 1; }
  REBIND_EPISODE_STATE="$saved"
  mv "$tmp" "$REBIND_EPISODE_STATE"
}

rebind_episode_clear() {
  local title="$1" tmp
  rebind_episode_state_valid || return 1
  [[ -f "$REBIND_EPISODE_STATE" ]] || return 0
  tmp=$(mktemp "${REBIND_EPISODE_STATE}.XXXX") || return 1
  awk -F'|' -v t="$title" '$7 != t { print }' "$REBIND_EPISODE_STATE" > "$tmp" \
    || { rm -f "$tmp"; return 1; }
  if [[ -s "$tmp" ]]; then mv "$tmp" "$REBIND_EPISODE_STATE"; else rm -f "$tmp" "$REBIND_EPISODE_STATE"; fi
}

rebind_source_candidate_for_title() {
  local title="$1" registry_exec active_count source_count source_row exec_id state wid observed_title session
  fetch_active_runner_roster || return 1
  [[ "$RUNNER_EXPECTED_STATE" == ok ]] || return 1
  read_runner_tmux_node_inventory || return 1
  [[ "$RUNNER_NODE_TMUX_STATE" == ok ]] || return 1
  node_registry_valid || return 1
  [[ -f "$NODE_REGISTRY" ]] || return 1
  registry_exec=$(awk -F'|' -v t="$title" '$11 == t { n++; e=$1 } END { if(n == 1) print e }' "$NODE_REGISTRY")
  [[ -n "$registry_exec" ]] || return 1
  active_count=$(printf '%s\n' "$RUNNER_ACTIVE_ROWS" \
    | awk -F'|' -v e="$registry_exec" '$1 == e { n++ } END { print n+0 }')
  [[ "$active_count" == 1 ]] || return 1
  source_count=$(printf '%s\n' "$RUNNER_NODE_TMUX_ROWS" \
    | awk -F'|' -v t="$title" '$2 == "present" && $4 == t { n++ } END { print n+0 }')
  [[ "$source_count" == 1 ]] || return 1
  source_row=$(printf '%s\n' "$RUNNER_NODE_TMUX_ROWS" \
    | awk -F'|' -v t="$title" '$2 == "present" && $4 == t { print; exit }')
  IFS='|' read -r exec_id state wid observed_title session < <(printf '%s\n' "$source_row")
  [[ "$exec_id" == "$registry_exec" && "$state" == present && "$observed_title" == "$title" ]] || return 1
  case "$session" in runner-*) ;; *) return 1 ;; esac
  window_source_pane_alive "$session" "$wid" || return 1
  printf '%s|%s|%s\n' "$exec_id" "$session" "$wid"
}

rebind_workspace_identity_for_title() {
  local title="$1" raw
  raw=$(get_cmux_workspaces_json) || return 1
  printf '%s' "$raw" | python3 -c '
import json,re,sys
title=sys.argv[1]
rows=[row for row in json.load(sys.stdin).get("workspaces", [])
      if isinstance(row,dict) and row.get("title") == title]
if len(rows) != 1: raise SystemExit(1)
ref=rows[0].get("ref"); uuid=rows[0].get("id")
if not isinstance(ref,str) or not re.fullmatch(r"workspace:[0-9]+",ref): raise SystemExit(1)
if not isinstance(uuid,str) or not re.fullmatch(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}",uuid): raise SystemExit(1)
print(ref,uuid,sep="|")
' "$title"
}

rebind_workspace_authority() {
  local source="$1" wid="$2" title="$3" generation="$4" ref="$5" uuid="$6" allow_recovery="${7:-0}"
  local birth birth_ref birth_uuid title_b64 _surface kind target_b64 _token expected_target expected_title
  local claims count current_count old_count old_generation
  workspace_identity_matches "$ref" "$title" "$uuid" || return 1
  expected_target=$(printf 'cmux-%s' "$title" | base64 | tr -d '\n') || return 1
  birth=$(cmux_workspace_birth_record "$ref" "$uuid" 2>/dev/null || true)
  if [[ -n "$birth" ]]; then
    IFS='|' read -r birth_ref birth_uuid title_b64 _surface kind target_b64 _token < <(printf '%s\n' "$birth")
    expected_title=$(_attach_b64_decode "$title_b64" 2>/dev/null || true)
    [[ "$birth_ref" == "$ref" && "$birth_uuid" == "$uuid" && "$expected_title" == "$title" \
        && "$kind" == view && "$target_b64" == "$expected_target" ]] || return 1
    printf 'birth|-\n'
    return 0
  fi
  [[ -f "$VIEW_LEDGER" ]] || return 1
  claims=$(awk -F'|' -v r="$ref" -v t="$title" \
    '($1 == "prepared" || $1 == "committed") && ($3 == r || $4 == t) { print }' "$VIEW_LEDGER")
  count=$(printf '%s\n' "$claims" | grep -c . || true)
  current_count=$(printf '%s\n' "$claims" | awk -F'|' -v g="$generation" -v r="$ref" -v t="$title" -v u="$uuid" \
    '$1 == "committed" && $2 == g && $3 == r && $4 == t && NF == 5 && $5 == u { n++ } END { print n+0 }')
  old_count=$(printf '%s\n' "$claims" | awk -F'|' -v g="$generation" -v r="$ref" -v t="$title" -v u="$uuid" \
    '$1 == "committed" && $2 != g && $3 == r && $4 == t && NF == 5 && $5 == u { n++ } END { print n+0 }')
  old_generation=$(printf '%s\n' "$claims" | awk -F'|' -v g="$generation" -v r="$ref" -v t="$title" -v u="$uuid" \
    '$1 == "committed" && $2 != g && $3 == r && $4 == t && NF == 5 && $5 == u { print $2; exit }')
  if [[ "$count" == 1 && "$old_count" == 1 && "$current_count" == 0 ]]; then
    printf 'stale|%s\n' "$old_generation"
  elif [[ "$allow_recovery" == 1 && "$count" == 1 && "$current_count" == 1 ]]; then
    printf 'current|-\n'
  elif [[ "$allow_recovery" == 1 && "$count" == 2 && "$current_count" == 1 && "$old_count" == 1 ]]; then
    printf 'stale|%s\n' "$old_generation"
  else
    return 1
  fi
}

REBIND_GUARD_ACTIVE=0
REBIND_GUARD_CMUX_HASH=""
REBIND_GUARD_TMUX_HASH=""
REBIND_GUARD_EXEC=""
REBIND_GUARD_TITLE=""
REBIND_GUARD_SESSION=""
REBIND_GUARD_WID=""
REBIND_GUARD_REF=""
REBIND_GUARD_UUID=""

rebind_mutation_authority_current() {
	[[ ! -e "$REBIND_CONTROL_STATE" && ! -L "$REBIND_CONTROL_STATE" ]] || return 1
  local candidate current_cmux current_tmux
  watcher_mutation_latch_clear || return 1
  candidate=$(rebind_source_candidate_for_title "$REBIND_GUARD_TITLE") || return 1
  [[ "$candidate" == "$REBIND_GUARD_EXEC|$REBIND_GUARD_SESSION|$REBIND_GUARD_WID" ]] || return 1
  current_cmux=$(cmux_socket_identity) || return 1
  current_tmux=$(tmux_server_generation) || return 1
  [[ "$(_cmux_alert_hash "$current_cmux")" == "$REBIND_GUARD_CMUX_HASH" \
      && "$(_cmux_alert_hash "$current_tmux")" == "$REBIND_GUARD_TMUX_HASH" ]] || return 1
  workspace_identity_matches "$REBIND_GUARD_REF" "$REBIND_GUARD_TITLE" "$REBIND_GUARD_UUID"
}

rebind_guard_arm() {
  REBIND_GUARD_CMUX_HASH="$1"; REBIND_GUARD_TMUX_HASH="$2"; REBIND_GUARD_EXEC="$3"
  REBIND_GUARD_TITLE="$4"; REBIND_GUARD_SESSION="$5"; REBIND_GUARD_WID="$6"
  REBIND_GUARD_REF="$7"; REBIND_GUARD_UUID="$8"; REBIND_GUARD_ACTIVE=1
}

rebind_guard_disarm() { REBIND_GUARD_ACTIVE=0; }

rebind_crash_point() {
  [[ "${FLYWHEEL_CMUX_REBIND_CRASH_AT:-}" == "$1" ]] && kill -KILL "$$"
  return 0
}

rebind_adopt_stale_receipt() {
  local generation="$1" old_generation="$2" ref="$3" title="$4" uuid="$5" state receipt_uuid
  rebind_mutation_authority_current || return 1
  state=$(ledger_candidate_receipt_state "$generation" "$ref" "$title") || return 1
  case "$state" in
    none)
      _ledger_upsert prepared "$generation" "$ref" "$title" "$uuid" || return 1
      rebind_crash_point after-receipt-prepare
      ;;
    prepared|committed)
      receipt_uuid=$(ledger_exact_receipt_uuid "$generation" "$ref" "$title") || return 1
      [[ "$receipt_uuid" == "$uuid" ]] || return 1
      ;;
    *) return 1 ;;
  esac
  rebind_mutation_authority_current || return 1
  _ledger_upsert committed "$generation" "$ref" "$title" "$uuid" || return 1
  rebind_crash_point after-receipt-commit
  rebind_mutation_authority_current || return 1
  if [[ -f "$VIEW_LEDGER" ]] && awk -F'|' -v g="$old_generation" -v r="$ref" -v t="$title" \
      '$2 == g && $3 == r && $4 == t { found=1 } END { exit(found ? 0 : 1) }' "$VIEW_LEDGER"; then
    _ledger_remove "$old_generation" "$ref" || return 1
  fi
}

rebind_refuse() {
  local title="$1" reason="$2"
  _alert_cmux_cleanup \
    "cmux viewer rebind refused" \
    "A missing runner viewer was preserved because dual positive identity was not complete: title=$title reason=$reason." \
    "cmux_cleanup|viewer-rebind-refused|title=$title|reason=$reason"
}

rebind_latch_failure() {
  local base="$1" title="$2" reason="$3"
  rebind_episode_state_upsert "$base|failed|1" || true
  rebind_guard_disarm
  _alert_cmux_cleanup \
    "cmux viewer rebind failed after mutation" \
    "A runner viewer rebind crossed its first mutation and then failed closed; the exact key stays latched until identity changes: title=$title reason=$reason." \
    "cmux_cleanup|viewer-rebind-failed|key=$(_cmux_alert_hash "$base")|reason=$reason"
}

rebind_missing_runner_view() {
  local title="$1" candidate exec_id source wid identity ref uuid cmux_generation tmux_generation cmux_hash tmux_hash
  local prior="" version prior_cmux prior_uuid prior_ref prior_tmux prior_exec prior_title prior_source prior_wid phase mutated extra
  local authority mode old_generation base view wal target_b64 receipt receipt_uuid heal_rc=0 clients surface
	[[ ! -e "$REBIND_CONTROL_STATE" && ! -L "$REBIND_CONTROL_STATE" ]] || return 0
  is_managed_runner_title "$title" || return 0
  candidate=$(rebind_source_candidate_for_title "$title") || { rebind_refuse "$title" source-identity; return 0; }
  IFS='|' read -r exec_id source wid < <(printf '%s\n' "$candidate")
  identity=$(rebind_workspace_identity_for_title "$title") || { rebind_refuse "$title" workspace-identity; return 0; }
  IFS='|' read -r ref uuid < <(printf '%s\n' "$identity")
  cmux_generation=$(cmux_socket_identity) || { rebind_refuse "$title" cmux-generation; return 0; }
  tmux_generation=$(tmux_server_generation) || { rebind_refuse "$title" tmux-generation; return 0; }
  cmux_hash=$(_cmux_alert_hash "$cmux_generation"); tmux_hash=$(_cmux_alert_hash "$tmux_generation")
  base="rebindv1|$cmux_hash|$uuid|$ref|$tmux_hash|$exec_id|$title|$source|$wid"
  prior=$(rebind_episode_row "$title" 2>/dev/null || true)
  if [[ -n "$prior" ]]; then
    IFS='|' read -r version prior_cmux prior_uuid prior_ref prior_tmux prior_exec prior_title prior_source prior_wid phase mutated extra \
      < <(printf '%s\n' "$prior")
    if [[ "$prior" != "$base|$phase|$mutated" ]]; then
      rebind_episode_clear "$title" || { rebind_refuse "$title" episode-state; return 0; }
      prior=""; phase=""; mutated=0
    fi
  else
    phase=""; mutated=0
  fi
  authority=$(rebind_workspace_authority "$source" "$wid" "$title" "$cmux_generation" "$ref" "$uuid" \
    "$([[ -n "$prior" ]] && printf 1 || printf 0)") \
    || { rebind_refuse "$title" workspace-authority; return 0; }
  IFS='|' read -r mode old_generation < <(printf '%s\n' "$authority")
  if [[ "$phase" == failed ]]; then
    rebind_latch_failure "$base" "$title" replay
    return 0
  fi
  if [[ -z "$prior" ]]; then
    rebind_episode_state_upsert "$base|intent|0" || { rebind_refuse "$title" episode-state; return 0; }
    phase=intent; mutated=0
  fi
  rebind_crash_point after-intent
  rebind_guard_arm "$cmux_hash" "$tmux_hash" "$exec_id" "$title" "$source" "$wid" "$ref" "$uuid"
  rebind_mutation_authority_current || { rebind_guard_disarm; rebind_refuse "$title" pre-mutation-drift; return 0; }
  view="${VIEW_PREFIX}${title}"
  if [[ "$phase" == attached ]]; then
    _attach_state_write "$cmux_generation" "$ref" "$title" view || true
    rebind_episode_clear "$title" || true
    rebind_guard_disarm
    return 0
  fi
  if [[ "$phase" == intent ]]; then
    if ! _linked_view_matches "$view" "$wid" "$source" "" "$title" "$tmux_generation"; then
      if ! create_or_replace_view_session "$source" "$wid" "$title"; then
        wal=$(_view_wal_path "$view")
        if [[ -e "$wal" ]] || _linked_view_matches "$view" "$wid" "$source" "" "$title" "$tmux_generation"; then
          rebind_latch_failure "$base" "$title" viewer-build
        else
          rebind_guard_disarm
        fi
        return 0
      fi
    fi
    rebind_mutation_authority_current \
      && _linked_view_matches "$view" "$wid" "$source" "" "$title" "$tmux_generation" \
      || { rebind_latch_failure "$base" "$title" viewer-readback; return 0; }
    rebind_episode_state_upsert "$base|viewer-ready|1" \
      || { rebind_latch_failure "$base" "$title" viewer-episode; return 0; }
    phase=viewer-ready; mutated=1
    rebind_crash_point after-viewer-ready
  else
    _linked_view_matches "$view" "$wid" "$source" "" "$title" "$tmux_generation" \
      || { rebind_latch_failure "$base" "$title" viewer-drift; return 0; }
  fi
  if [[ "$phase" == viewer-ready ]]; then
    rebind_mutation_authority_current || { rebind_latch_failure "$base" "$title" receipt-preflight; return 0; }
    target_b64=$(printf '%s' "$view" | base64 | tr -d '\n') || { rebind_latch_failure "$base" "$title" target-encode; return 0; }
    case "$mode" in
      birth) adopt_birth_candidate "$source" "$wid" "$title" "$cmux_generation" "$ref" view "$target_b64" \
        || { rebind_latch_failure "$base" "$title" birth-adoption; return 0; } ;;
      stale) rebind_adopt_stale_receipt "$cmux_generation" "$old_generation" "$ref" "$title" "$uuid" \
        || { rebind_latch_failure "$base" "$title" stale-adoption; return 0; } ;;
      current) ;;
      *) rebind_latch_failure "$base" "$title" authority-mode; return 0 ;;
    esac
    receipt=$(ledger_exact_receipt_state "$cmux_generation" "$ref" "$title" 2>/dev/null || true)
    receipt_uuid=$(ledger_exact_receipt_uuid "$cmux_generation" "$ref" "$title" 2>/dev/null || true)
    [[ "$receipt" == committed && "$receipt_uuid" == "$uuid" ]] \
      || { rebind_latch_failure "$base" "$title" receipt-readback; return 0; }
    rebind_mutation_authority_current || { rebind_latch_failure "$base" "$title" receipt-drift; return 0; }
    rebind_episode_state_upsert "$base|receipt-ready|1" \
      || { rebind_latch_failure "$base" "$title" receipt-episode; return 0; }
    phase=receipt-ready
    rebind_crash_point after-receipt-ready
  fi
  if [[ "$phase" == receipt-ready ]]; then
    self_heal_workspace_ref "$title" "$ref" "$cmux_generation" || heal_rc=$?
    [[ "$heal_rc" != 1 ]] || { rebind_latch_failure "$base" "$title" attach-heal; return 0; }
    clients=$(view_session_client_count "$view" 2>/dev/null || true)
    case "$clients" in ''|*[!0-9]*) rebind_latch_failure "$base" "$title" attach-readback; return 0 ;; esac
    if (( clients == 0 )); then
      rebind_guard_disarm
      return 0
    fi
    rebind_crash_point after-attach
    rebind_mutation_authority_current \
      && _linked_view_matches "$view" "$wid" "$source" "" "$title" "$tmux_generation" \
      || { rebind_latch_failure "$base" "$title" attach-drift; return 0; }
    surface=$(workspace_terminal_surface_ref "$ref" 2>/dev/null || true)
    [[ -n "$surface" ]] || { rebind_latch_failure "$base" "$title" surface-readback; return 0; }
    rebind_episode_state_upsert "$base|attached|1" \
      || { rebind_latch_failure "$base" "$title" attach-episode; return 0; }
    rebind_crash_point after-attached-episode
  fi
  _attach_state_write "$cmux_generation" "$ref" "$title" view || true
  rebind_episode_clear "$title" || true
  rebind_guard_disarm
  return 0
}

reconcile_existing_workspaces() {
  # FLY-129 Phase 3 (R3-1): for workspaces that exist but have no linked
  # session (e.g., after Lead restart or cmux reopen with stale workspace),
  # close the broken workspace and let the create phase rebuild it.
  #
  # Fail-closed gate: verify workspace JSON ONCE at the top of this pass.
  # Unreadable inventory means zero reconcile actions; the next tick retries.
  local tmux_windows raw
  tmux_windows=$(get_tmux_agent_windows)
  [[ -z "$tmux_windows" ]] && return 0
  raw=$(get_cmux_workspaces_json) || return 0

  while IFS='|' read -r src_sess wid wname; do
    [[ -z "$wname" ]] && continue
    local strict_view="${VIEW_PREFIX}${wname}"
    linked_session_exists "$strict_view" && continue
    if [[ "$src_sess" == runner-* ]] && is_managed_runner_title "$wname"; then
      rebind_missing_runner_view "$wname"
      continue
    fi
    # Exact-ref ledger authority closes only the Flywheel-owned broken tab;
    # unledgered same-title workspaces remain visible for manual resolution.
    dismantle_view_display "$wname" "reconcile-${wname}-view-dead" || true
  done < <(printf '%s\n' "$tmux_windows")
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
  if printf '%s\n' "$current_hooks" | grep -q '^after-new-window\[500\]'; then
    have_create=1
  fi
  if printf '%s\n' "$current_hooks" | grep -q '^pane-exited\[500\]'; then
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
  done < <(printf '%s\n' "$sessions")
}

mark_for_cleanup() {
  # Record a window name as pending cleanup with the timestamp of the exit event.
  # Idempotent: only adds if no pending entry exists for this window name.
  local wname="$1" ts="$2" round="${CMUX_ADDITIVE_ROUND_ID:-0-0}" round_epoch round_sequence
  [[ -z "$wname" ]] && return 0
  touch "$CLEANUP_PENDING"
  awk -F'|' -v n="$wname" '$1 == n {found=1} END {exit(found ? 0 : 1)}' "$CLEANUP_PENDING" 2>/dev/null || {
    _additive_round_id_valid "$round" || round=0-0
    round_epoch="${round%%-*}"; round_sequence="${round#*-}"
    printf '%s|%s|%s|%s\n' "$wname" "$ts" "$round_epoch" "$round_sequence" >> "$CLEANUP_PENDING"
  }
}

cleanup_event_source_allowed() {
  local session="$1" wname="$2"
  case "$session" in
    flywheel|runner-*) return 0 ;;
  esac
  # A strict independent view can outlive the runner session that spawned it.
  # Its pane-died event is then the only prompt signal that the watched window
  # itself ended. Exact namespace equality prevents unrelated cmux sessions
  # from manufacturing cleanup candidates; exact-ref ledger authority still
  # gates the later workspace close.
  if [[ "$session" == "${VIEW_PREFIX}${wname}" ]]; then
    return 0
  fi
  return 1
}

process_pending_cleanups() {
  # Walk the cleanup-pending file. For each entry:
  #   - if the source pane is alive again → drop the entry (restart detected)
  #   - else if < CLEANUP_DELAY_SECONDS since exit → keep the entry
  #   - else → cleanup_workspace_for + drop the entry
  if [[ ! -f "$CLEANUP_PENDING" ]]; then
    cleanup_snapshot_stall_observe 0 0 || true
    return 0
  fi

  local now remaining="" raw preserve_rest=0 blocked_count=0 oldest_blocked_epoch=0
  now=$(date +%s)

  while IFS= read -r raw || [[ -n "$raw" ]]; do
    if [[ "$preserve_rest" -eq 1 ]]; then
      remaining+="${raw}"$'\n'
      continue
    fi
    if ! watcher_mutation_latch_clear; then
      preserve_rest=1
      remaining+="${raw}"$'\n'
      continue
    fi
    local wname ts marker_round_epoch marker_round_sequence marker_extra
    IFS='|' read -r wname ts marker_round_epoch marker_round_sequence marker_extra < <(printf '%s\n' "$raw")
    [[ -z "$wname" || -z "$ts" ]] && continue
    case "$ts" in *[!0-9]*) remaining+="${raw}"$'\n'; continue ;; esac
    if (( ${#ts} > 18 )); then remaining+="${raw}"$'\n'; continue; fi
    if [[ -n "$marker_extra" ]] \
        || [[ -n "$marker_round_epoch" && -z "$marker_round_sequence" ]] \
        || [[ -z "$marker_round_epoch" && -n "$marker_round_sequence" ]] \
        || [[ "$marker_round_epoch$marker_round_sequence" == *[!0-9]* ]]; then
      remaining+="${raw}"$'\n'
      log "WARN: malformed cleanup marker preserved for $wname"
      continue
    fi
    # Pane alive again → cancel cleanup. Uses #{pane_dead} (not window existence)
    # because `remain-on-exit on` means window lingers after pane dies.
    local pane_rc=0
    is_pane_alive "$wname" || pane_rc=$?
    if [[ "$pane_rc" == "0" ]]; then
      continue
    fi
    if [[ "$pane_rc" != "1" ]]; then
      remaining+="${raw}"$'\n'
      log "WARN: liveness unavailable for $wname; pending cleanup preserved"
      continue
    fi
    # Still within delay window → keep entry for next tick
    if (( now - ts < CLEANUP_DELAY_SECONDS )); then
      remaining+="${raw}"$'\n'
      continue
    fi
    if ! node_cleanup_freshness_allows "$wname" "$ts" "$marker_round_epoch" "$marker_round_sequence"; then
      remaining+="${raw}"$'\n'
      blocked_count=$((blocked_count + 1))
      if (( oldest_blocked_epoch == 0 || ts < oldest_blocked_epoch )); then
        oldest_blocked_epoch="$ts"
      fi
      log "Node-presence fence waiting for a newer complete classification: $wname"
      continue
    fi
    # Delay elapsed + pane confirmed dead → clean up
    log "Event cleanup: '$wname' (exited $((now - ts))s ago)"
    if ! cleanup_workspace_for "$wname" "$raw"; then
      remaining+="${raw}"$'\n'
      log "WARN: cleanup refused; pending marker preserved for $wname"
      continue
    fi
    if ! watcher_mutation_latch_clear; then
      # Cleanup lost authority part-way through this row. Retain the current
      # item as well as the unread tail so the replacement lease holder can
      # revalidate and finish it; retrying is safer than guessing which
      # sub-step completed.
      preserve_rest=1
      remaining+="${raw}"$'\n'
    fi
  done < "$CLEANUP_PENDING"

  [[ "$preserve_rest" -eq 1 ]] \
    && log "WARN: cleanup-pending drain interrupted; retained current item and queue tail for replay"

  if [[ -n "$remaining" ]]; then
    printf '%s' "$remaining" > "$CLEANUP_PENDING"
  else
    rm -f "$CLEANUP_PENDING"
  fi
  cleanup_snapshot_stall_observe "$blocked_count" "$oldest_blocked_epoch" || {
    _alert_cmux_cleanup \
      "cmux cleanup snapshot episode state unavailable" \
      "The watcher could not persist cleanup snapshot stall state; destructive cleanup remains fenced." \
      "cmux_cleanup|snapshot-episode-state-unavailable"
  }
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
  local tmp_events="${EVENT_FILE}.processing" drain_rc=0

  # Phase 1 — crash recovery: drain the leftover .processing file if present.
  if [[ -f "$tmp_events" ]]; then
    drain_rc=0; _drain_file "$tmp_events" || drain_rc=$?
    if [[ "$drain_rc" -eq 0 ]]; then
      rm -f "$tmp_events"
    else
      log "WARN: event replay interrupted; retained unprocessed batch (rc=$drain_rc)"
      return 0
    fi
  fi

  # Phase 2 — normal drain: atomically rename live event file, then drain it.
  [[ ! -f "$EVENT_FILE" ]] && return 0
  mv "$EVENT_FILE" "$tmp_events" 2>/dev/null || return 0
  drain_rc=0; _drain_file "$tmp_events" || drain_rc=$?
  if [[ "$drain_rc" -eq 0 ]]; then
    rm -f "$tmp_events"
  else
    log "WARN: event drain interrupted; retained unprocessed batch for replay (rc=$drain_rc)"
  fi
  return 0
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
  local now raw remainder="${source_file}.remaining.$$" interrupted=0
  now=$(date +%s)
  rm -f "$remainder" 2>/dev/null || true

  while IFS= read -r raw || [[ -n "$raw" ]]; do
    if [[ "$interrupted" -eq 1 ]]; then
      printf '%s\n' "$raw" >> "$remainder" || { rm -f "$remainder"; return 2; }
      continue
    fi
    if ! watcher_mutation_latch_clear; then
      interrupted=1
      printf '%s\n' "$raw" >> "$remainder" || { rm -f "$remainder"; return 2; }
      continue
    fi
    local etype arg1 arg2 arg3
    IFS='|' read -r etype arg1 arg2 arg3 < <(printf '%s\n' "$raw")
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
        admit_node_identity_for_window "$session" "$wid" "$wname" || true
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
        cleanup_event_source_allowed "$session" "$wname" || continue
        mark_for_cleanup "$wname" "$now"
        ;;
      register)
        local session="$arg1"
        [[ -z "$session" ]] && continue
        register_session_hooks "$session"
        watcher_mutation_latch_clear || continue
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
        cleanup_event_source_allowed "$session" "$wname" || continue
        mark_for_cleanup "$wname" "$now"
        ;;
    esac
  done < "$source_file"
  if [[ "$interrupted" -eq 1 ]]; then
    mv -f "$remainder" "$source_file" 2>/dev/null || { rm -f "$remainder"; return 2; }
    return 75
  fi
  rm -f "$remainder" 2>/dev/null || true
  return 0
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
    local agent_name="${sess#"${VIEW_PREFIX}"}" pane_rc=0
    is_pane_alive "$agent_name" || pane_rc=$?
    if [[ "$pane_rc" == "1" ]]; then
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
        mark_for_cleanup "$agent_name" "$first_stale"
        # drain_stale_state_row uses the same awk -F'|' literal compare
        # (Phase 5). Centralizes the "remove this agent from STALE_STATE"
        # operation so a future regex-safety fix only has to land there.
        drain_stale_state_row "$agent_name"
      fi
    elif [[ "$pane_rc" == "0" ]]; then
      # Pane is alive again → clear stale marker (literal-compare drain).
      drain_stale_state_row "$agent_name"
    else
      log "WARN: liveness unavailable for $agent_name; conservative cleanup state preserved"
    fi
  done < <(printf '%s\n' "$linked_sessions")
}

sync_additive_bootstrap() {
  # Run once at `--watch` startup. Cleanup remains proof-bound and preserves
  # healthy Runner workspaces while also converging historical orphan state.
  maintenance_requested && return 0
  CMUX_ADDITIVE_ROUND_ID=""
  CMUX_ADOPTION_COUNT=0
  begin_cmux_additive_round \
    || log "WARN: additive round state unavailable; prepared stall counters frozen"
  cmux_attach_tmux_bin_cache_prime || :
  reconcile_roster_read_phase
  cmux_attach_birth_cache_prime \
    || log "WARN: additive birth-authority snapshot unavailable; birth-owned actions frozen"
  watcher_mutation_latch_clear || return 0
  reconcile_v2_lead_workspaces
  watcher_mutation_latch_clear || return 0
  local tmux_windows
  tmux_windows=$(get_tmux_agent_windows)

  # Durable WAL/ledger recovery precedes every mutation, including the
  # conclusive-empty branch.
  RESTORED_BOOTSTRAP_PASS=1
  if ! prepare_linked_view_state pre; then
    RESTORED_BOOTSTRAP_PASS=0
    # A transient durable-state/topology read failure means this pass is
    # inconclusive. Defer the whole pass before create/heal, but keep the
    # long-running watcher alive under `set -e`.
    log "WARN: bootstrap linked-view refresh inconclusive; pass deferred"
    return 0
  fi
  watcher_mutation_latch_clear || { RESTORED_BOOTSTRAP_PASS=0; return 0; }
  advance_attach_reap_state \
    || log "WARN: helper reap advancement deferred; signal authority preserved"
  watcher_mutation_latch_clear || { RESTORED_BOOTSTRAP_PASS=0; return 0; }
  discover_orphan_attach_helpers \
    || log "WARN: orphan attach-helper census inconclusive; no reap tree minted"
  watcher_mutation_latch_clear || { RESTORED_BOOTSTRAP_PASS=0; return 0; }
  reap_orphan_workspace_pins
  watcher_mutation_latch_clear || { RESTORED_BOOTSTRAP_PASS=0; return 0; }
  if ! refresh_linked_sessions_tail; then
    RESTORED_BOOTSTRAP_PASS=0
    log "WARN: bootstrap linked-view refresh tail inconclusive; pass deferred"
    return 0
  fi
  RESTORED_BOOTSTRAP_PASS=0
  watcher_mutation_latch_clear || return 0
  if ! adopt_restored_workspaces dead discover-only; then
    log "WARN: bootstrap restored dead-title discovery inconclusive; pass deferred"
    return 0
  fi
  watcher_mutation_latch_clear || return 0
  if [[ -z "$tmux_windows" ]]; then
    reconcile_node_presence
    return 0
  fi

  # Preserve FLY-98 reconcile repair only after WAL recovery has populated the
  # current round's collision blocked set.
  reconcile_existing_workspaces
  watcher_mutation_latch_clear || return 0
  reconcile_workspace_titles "$tmux_windows"
  watcher_mutation_latch_clear || return 0
  if ! adopt_restored_workspaces live discover-only; then
    log "WARN: bootstrap restored live-title discovery inconclusive; pass deferred"
    return 0
  fi
  watcher_mutation_latch_clear || return 0

  # 3. Create missing workspaces. No cleanup of existing ones.
  # FLY-129 Phase 3 (R3-1): tri-state — only act on rc=1 (not found).
  while IFS='|' read -r src_sess wid wname; do
    watcher_mutation_latch_clear || break
    local _exists_rc=0
    workspace_exists_for "$wname" || _exists_rc=$?
    if [[ $_exists_rc -eq 1 ]]; then
      create_workspace_for_window "$src_sess" "$wid" "$wname"
    fi
  done < <(printf '%s\n' "$tmux_windows")
  watcher_mutation_latch_clear || return 0
  reconcile_node_presence
  watcher_mutation_latch_clear || return 0

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
  # top-up, receipt reconciliation, and conservative cleanup.
  # The marker is the first operation: maintenance preserves existing episode
  # state and authorizes neither derivation/alerting nor mutation.
  maintenance_requested && return 0
  CMUX_ADDITIVE_ROUND_ID=""
  CMUX_ADOPTION_COUNT=0
  begin_cmux_additive_round \
    || log "WARN: additive round state unavailable; prepared stall counters frozen"
  cmux_attach_tmux_bin_cache_prime || :
  reconcile_roster_read_phase
  cmux_attach_birth_cache_prime \
    || log "WARN: additive birth-authority snapshot unavailable; birth-owned actions frozen"
  watcher_mutation_latch_clear || return 0
  reconcile_v2_lead_workspaces
  watcher_mutation_latch_clear || return 0
  register_hooks_on_new_sessions
  watcher_mutation_latch_clear || return 0

  local tmux_windows
  tmux_windows=$(get_tmux_agent_windows)
  RESTORED_BOOTSTRAP_PASS=0
  if ! prepare_linked_view_state pre; then
    log "WARN: periodic linked-view refresh inconclusive; pass deferred"
    return 0
  fi
  watcher_mutation_latch_clear || return 0
  advance_attach_reap_state \
    || log "WARN: helper reap advancement deferred; signal authority preserved"
  watcher_mutation_latch_clear || return 0
  discover_orphan_attach_helpers \
    || log "WARN: orphan attach-helper census inconclusive; no reap tree minted"
  watcher_mutation_latch_clear || return 0
  reap_orphan_workspace_pins
  watcher_mutation_latch_clear || return 0
  if ! refresh_linked_sessions_tail; then
    log "WARN: periodic linked-view refresh tail inconclusive; pass deferred"
    return 0
  fi
  watcher_mutation_latch_clear || return 0
  if ! adopt_restored_workspaces dead discover-only; then
    log "WARN: periodic restored dead-title discovery inconclusive; pass deferred"
    return 0
  fi
  watcher_mutation_latch_clear || return 0
  if [[ -z "$tmux_windows" ]]; then
    # A strict independent view may be the watched window's sole holder after
    # its source runner retires. It still needs the ordinary 60s attach-heal.
    self_heal_sweep_all
    watcher_mutation_latch_clear || return 0
    reconcile_node_presence
    watcher_mutation_latch_clear || return 0
    cleanup_stale_conservative
    watcher_mutation_latch_clear || return 0
    # Even with no agent windows, reap ghosts so cmux UI clutter doesn't
    # accumulate during quiet periods.
    reap_ghost_workspaces
    watcher_mutation_latch_clear || return 0
    # R6 stock adoption is anchor-independent by design; the quiet state is
    # where already-closed runner tabs most commonly remain visible.
    reap_unledgered_stock_workspaces
    watcher_mutation_latch_clear || return 0
    return 0
  fi

  # WAL recovery above owns the round's collision blocked set. Only now may
  # exact-ref workspace reconciliation enter the mutation phase.
  reconcile_existing_workspaces
  watcher_mutation_latch_clear || return 0
  reconcile_workspace_titles "$tmux_windows"
  watcher_mutation_latch_clear || return 0
  if ! adopt_restored_workspaces live discover-only; then
    log "WARN: periodic restored live-title discovery inconclusive; pass deferred"
    return 0
  fi
  watcher_mutation_latch_clear || return 0

  # FLY-129 Phase 3 (R3-1): tri-state — only act on rc=1.
  while IFS='|' read -r src_sess wid wname; do
    watcher_mutation_latch_clear || break
    local _exists_rc=0
    workspace_exists_for "$wname" || _exists_rc=$?
    if [[ $_exists_rc -eq 1 ]]; then
      create_workspace_for_window "$src_sess" "$wid" "$wname"
    fi
  done < <(printf '%s\n' "$tmux_windows")
  watcher_mutation_latch_clear || return 0
  reconcile_node_presence
  watcher_mutation_latch_clear || return 0

  # FLY-1364 R6: recover killed/exited attach clients even when no create or
  # register hook fires. This function is reached only by the existing 60s
  # additive cadence; self_heal_sweep_all is best-effort and its ref-scoped
  # primitive performs a final zero-client check immediately before any send.
  self_heal_sweep_all
  watcher_mutation_latch_clear || return 0

  # FLY-129 Phase 4 + Phase 6: ghost reap + dedup. Both fail-closed on
  # JSON-unavailable — they no-op rather than mis-acting on stale state.
  reap_ghost_workspaces
  watcher_mutation_latch_clear || return 0
  reap_unledgered_stock_workspaces
  watcher_mutation_latch_clear || return 0
cleanup_stale_conservative
}

# FLY-1596: audited operator-only convergence path. Argument parsing is kept
# deliberately separate from semantic reads so malformed argv performs zero
# tmux/cmux/roster IPC and publishes no handover claim.
OPS_REBUILD_ALL_LEADS=0
OPS_REBUILD_EXECUTE=0
OPS_REBUILD_HANDOVER=0
OPS_REBUILD_TARGET_SPECS=""
OPS_REBUILD_TARGETS=""
OPS_REBUILD_ACTIVE_TARGET=""
OPS_REBUILD_RESULTS=""

_ops_title_valid() {
  local title="$1"
  [[ -n "$title" && ${#title} -le 255 ]] || return 1
  case "$title" in *'|'*|*'='*|*$'\t'*|*$'\n'*|*$'\r'*) return 1 ;; esac
  LC_ALL=C printf '%s' "$title" | grep -q '^[[:print:]]\{1,255\}$'
}

parse_rebuild_views_args() {
  local all=0 execute=0 handover=0 specs="" arg value title ref duplicate
  while [[ $# -gt 0 ]]; do
    arg="$1"; shift
    case "$arg" in
      --all-leads) [[ "$all" == 0 ]] || return 1; all=1 ;;
      --execute) [[ "$execute" == 0 ]] || return 1; execute=1 ;;
      --handover) [[ "$handover" == 0 ]] || return 1; handover=1 ;;
      --target)
        [[ $# -gt 0 ]] || return 1
        value="$1"; shift
        title="$value"; ref=""
        if [[ "$value" == *'='* ]]; then
          title="${value%%=*}"
          ref="${value#*=}"
        fi
        _ops_title_valid "$title" || return 1
        if [[ -n "$ref" ]]; then
          case "$ref" in workspace:[0-9]*) case "${ref#workspace:}" in ''|*[!0-9]*) return 1 ;; esac ;; *) return 1 ;; esac
        fi
        duplicate=$(printf '%s\n' "$specs" | awk -F'|' -v t="$title" '$1 == t { n++ } END { print n+0 }')
        [[ "$duplicate" == 0 ]] || return 1
        specs+="${specs:+$'\n'}${title}|${ref}"
        ;;
      *) return 1 ;;
    esac
  done
  [[ "$handover" == 0 || "$execute" == 1 ]] || return 1
  if [[ "$all" == 1 ]]; then
    [[ -z "$specs" ]] || return 1
  else
    [[ -n "$specs" ]] || return 1
  fi
  OPS_REBUILD_ALL_LEADS="$all"
  OPS_REBUILD_EXECUTE="$execute"
  OPS_REBUILD_HANDOVER="$handover"
  OPS_REBUILD_TARGET_SPECS=$(printf '%s\n' "$specs" | sed '/^$/d' | sort)
}

OPS_VERIFY_JSON=0
OPS_VERIFY_TARGETS=""
VERIFY_SIDEBAR_REASONS=""
VERIFY_SIDEBAR_CAVEATS=""
SIDEBAR_TARGET_ROSTER_ROWS=""
SIDEBAR_TARGET_AUTHORITY=""

_verify_sidebar_append_unique() {
  local variable="$1" value="$2" current
  [[ -n "$value" ]] || return 0
  eval "current=\${$variable:-}"
  printf '%s\n' "$current" | grep -qxF "$value" && return 0
  current+="${current:+$'\n'}${value}"
  printf -v "$variable" '%s' "$current"
}

_verify_sidebar_inconclusive() {
  _verify_sidebar_append_unique VERIFY_SIDEBAR_REASONS "$1"
  return 2
}

_derive_sidebar_target_authority() {
  local targets="$1" agent_snapshot="${2:-}" title label plist manifest wrapper fields project lead backend socket carrier canonical_socket
  local plist_hash manifest_hash rows="" authority=""
  local window_evidence ledger_evidence keeper_evidence evidence_sources evidence_hash evidence_bundle
  SIDEBAR_TARGET_ROSTER_ROWS=""
  SIDEBAR_TARGET_AUTHORITY=""
  while IFS= read -r title; do
    [[ -n "$title" ]] || continue
    if is_managed_runner_title "$title"; then
      window_evidence=$(printf '%s\n' "$agent_snapshot" \
        | awk -F'|' -v t="$title" 'NF == 4 && $3 == t { print }' | sort)
      ledger_evidence=""
      if [[ -f "$VIEW_LEDGER" && ! -L "$VIEW_LEDGER" ]]; then
        ledger_evidence=$(awk -F'|' -v t="$title" \
          '(NF == 4 || NF == 5) && ($1 == "prepared" || $1 == "committed") && $3 ~ /^workspace:[0-9]+$/ && $4 == t { print }' \
          "$VIEW_LEDGER" 2>/dev/null | sort) || return 2
      fi
      keeper_evidence=""
      if [[ -f "$KEEPER_INVENTORY" && ! -L "$KEEPER_INVENTORY" ]]; then
        keeper_evidence=$(awk -F'|' -v t="$title" \
          'NF == 7 && ($6 == "prepared" || $6 == "committed") && $2 ~ /^\$[0-9]+$/ \
            && $3 == "fwkeeper-" substr($2, 2) "-cmux-" t { print }' \
          "$KEEPER_INVENTORY" 2>/dev/null | sort) || return 2
      fi
      if [[ -z "$window_evidence$ledger_evidence$keeper_evidence" ]]; then
        _verify_sidebar_inconclusive "target-unknown: no independent runner evidence $title"
        return 2
      fi
      evidence_sources=""
      [[ -n "$window_evidence" ]] && evidence_sources="window"
      [[ -n "$ledger_evidence" ]] && evidence_sources+="${evidence_sources:+,}ledger"
      [[ -n "$keeper_evidence" ]] && evidence_sources+="${evidence_sources:+,}keeper"
      evidence_bundle="window
$window_evidence
ledger
$ledger_evidence
keeper
$keeper_evidence"
      evidence_hash=$(printf '%s' "$evidence_bundle" | shasum -a 256 | awk '{print $1}') || return 2
      authority+="${authority:+$'\n'}runner|${title}|${evidence_sources}|${evidence_hash}"
      continue
    fi
    label="com.flywheel.lead.${title}"
    plist="$FLYWHEEL_LEAD_PLIST_DIR/${label}.plist"
    manifest="$FLYWHEEL_MANIFEST_DIR/${title}.json"
    [[ -f "$plist" ]] || {
      _verify_sidebar_inconclusive "target-authority-unavailable: missing loaded plist $title"
      return 2
    }
    lead_job_loaded "$label" || {
      _verify_sidebar_inconclusive "target-authority-unavailable: plist not loaded $title"
      return 2
    }
    wrapper=$(lead_plist_wrapper_basename "$plist") || {
      _verify_sidebar_inconclusive "target-authority-unavailable: invalid plist $title"
      return 2
    }
    [[ -f "$manifest" ]] || {
      _verify_sidebar_inconclusive "target-authority-unavailable: missing manifest $title"
      return 2
    }
    fields=$(lead_manifest_fields "$manifest" 2>/dev/null) || {
      _verify_sidebar_inconclusive "target-authority-unavailable: invalid manifest $title"
      return 2
    }
    IFS='|' read -r project lead backend socket < <(printf '%s\n' "$fields")
    [[ "${project}-${lead}" == "$title" ]] || {
      _verify_sidebar_inconclusive "target-authority-unavailable: manifest identity mismatch $title"
      return 2
    }
    carrier=$(classify_lead_carrier "$wrapper" "$backend") || {
      _verify_sidebar_inconclusive "target-authority-unavailable: carrier classification failed $title"
      return 2
    }
    if [[ "$carrier" == "claude-private" ]]; then
      canonical_socket=$(derive_lead_socket "${project}/${lead}" "${FLYWHEEL_LEAD_STATE_DIR:-$HOME/.flywheel}") || return 2
      [[ "$socket" == "$canonical_socket" ]] || {
        _verify_sidebar_inconclusive "target-authority-unavailable: noncanonical private socket $title"
        return 2
      }
    else
      socket=""
    fi
    plist_hash=$(shasum -a 256 "$plist" | awk '{print $1}') || return 2
    manifest_hash=$(shasum -a 256 "$manifest" | awk '{print $1}') || return 2
    rows+="${rows:+$'\n'}${carrier}|${label}|${title}|${socket}"
    authority+="${authority:+$'\n'}lead|${label}|${title}|${wrapper}|${fields}|${plist_hash}|${manifest_hash}"
  done < <(printf '%s\n' "$targets")
  SIDEBAR_TARGET_ROSTER_ROWS=$(printf '%s\n' "$rows" | sed '/^$/d' | sort)
  SIDEBAR_TARGET_AUTHORITY=$(printf '%s\n' "$authority" | sed '/^$/d' | sort)
}

parse_verify_sidebar_args() {
  local json=0 targets="" arg title duplicate
  while [[ $# -gt 0 ]]; do
    arg="$1"; shift
    case "$arg" in
      --json) [[ "$json" == 0 ]] || return 1; json=1 ;;
      --target)
        [[ $# -gt 0 ]] || return 1
        title="$1"; shift
        _ops_title_valid "$title" || return 1
        duplicate=$(printf '%s\n' "$targets" | grep -cxF "$title" || true)
        [[ "$duplicate" == 0 ]] || return 1
        targets+="${targets:+$'\n'}${title}"
        ;;
      *) return 1 ;;
    esac
  done
  OPS_VERIFY_JSON="$json"
  OPS_VERIFY_TARGETS=$(printf '%s\n' "$targets" | sed '/^$/d' | sort)
}

_resolve_sidebar_subjects() {
  local snapshot roster_titles live_titles known title
  snapshot=$(strict_agent_window_snapshot) || {
    _verify_sidebar_inconclusive "subject-inventory-unavailable: tmux snapshot unavailable"
    return 2
  }
  if [[ -n "$OPS_VERIFY_TARGETS" ]]; then
    _derive_sidebar_target_authority "$OPS_VERIFY_TARGETS" "$snapshot" || return 2
    if ! derive_lead_roster || [[ "$LEAD_ROSTER_STATE" != "ok" ]]; then
      _verify_sidebar_append_unique VERIFY_SIDEBAR_CAVEATS \
        "${LEAD_ROSTER_REASONS:-roster-authority-unavailable: roster derivation failed}"
    fi
    return 0
  fi
  derive_lead_roster || {
    _verify_sidebar_inconclusive "${LEAD_ROSTER_REASONS:-roster-authority-unavailable: roster derivation failed}"
    return 2
  }
  [[ "$LEAD_ROSTER_STATE" == "ok" ]] || {
    _verify_sidebar_inconclusive "${LEAD_ROSTER_REASONS:-roster-authority-unavailable: roster derivation failed}"
    return 2
  }
  roster_titles=$(printf '%s\n' "$LEAD_ROSTER_ROWS" | awk -F'|' 'NF >= 3 && $3 != "" { print $3 }' | sort -u)
  live_titles=$(printf '%s\n' "$snapshot" | awk -F'|' 'NF == 4 && $3 != "" { print $3 }' | sort -u)
  known=$(printf '%s\n%s\n' "$roster_titles" "$live_titles" | sed '/^$/d' | sort -u)
  [[ -n "$known" ]] || return 1
  OPS_VERIFY_TARGETS="$known"
}

OPS_REBUILD_RESOLVED=""
resolve_rebuild_targets() {
  local snapshot raw births generation specs roster_titles live_titles known resolved=""
  local title requested source_rows live_count any_count source wid canonical candidate_rows mapped_count observed_ref state
  local roster_row roster_carrier roster_socket birth_candidates target_b64
  local marker_rc class clients=0 roster_count fallback_leads
  snapshot=$(strict_agent_window_snapshot) || return 2
  raw=$(get_cmux_workspaces_json) || return 2
  births=$(cmux_attach_birth_records "$raw") || return 2
  generation=$(cmux_socket_identity) || return 2
  [[ -n "$generation" ]] || return 2
  _restored_parse_records >/dev/null || return 2
  roster_titles=""
  if derive_lead_roster && [[ "$LEAD_ROSTER_STATE" == "ok" ]]; then
    roster_titles=$(printf '%s\n' "$LEAD_ROSTER_ROWS" | awk -F'|' 'NF >= 3 && $3 != "" { print $3 }' | sort -u)
  fi
  live_titles=$(printf '%s\n' "$snapshot" | awk -F'|' 'NF == 4 && $3 != "" { print $3 }' | sort -u)
  known=$(printf '%s\n%s\n' "$roster_titles" "$live_titles" | sed '/^$/d' | sort -u)
  specs="$OPS_REBUILD_TARGET_SPECS"
  if [[ "$OPS_REBUILD_ALL_LEADS" == 1 ]]; then
    if [[ -n "$roster_titles" ]]; then
      specs=$(printf '%s\n' "$roster_titles" | sed 's/$/|/')
    else
      fallback_leads=$(printf '%s\n' "$live_titles" | awk '/-lead$/')
      [[ -n "$fallback_leads" ]] || return 1
      specs=$(printf '%s\n' "$fallback_leads" | sed 's/$/|/')
    fi
  fi

  while IFS='|' read -r title requested; do
    [[ -n "$title" ]] || continue
    printf '%s\n' "$known" | grep -qxF "$title" || return 1
    roster_row=$(printf '%s\n' "$LEAD_ROSTER_ROWS" | awk -F'|' -v t="$title" '$3 == t { print; exit }')
    IFS='|' read -r roster_carrier _ _ roster_socket < <(printf '%s\n' "$roster_row")
    if [[ "$roster_carrier" == "claude-private" ]]; then
      canonical=$(build_lead_attach_command "$roster_socket") || return 2
      candidate_rows=$(workspace_title_candidates "$raw" "$title" "$canonical") || return 2
      target_b64=$(printf '%s' "$roster_socket" | base64 | tr -d '\n') || return 2
      birth_candidates=$(workspace_birth_candidate_rows "$raw" "$births" lead \
        "$target_b64" "$candidate_rows") || return 2
      candidate_rows+="${birth_candidates:+${candidate_rows:+$'\n'}${birth_candidates}}"
      mapped_count=$(printf '%s\n' "$candidate_rows" | grep -c . || true)
      (( mapped_count <= 1 )) || return 1
      observed_ref=$(printf '%s\n' "$candidate_rows" | awk -F'|' 'NF == 5 { print $2 }')
      [[ -z "$requested" || "$observed_ref" == "$requested" ]] || return 1
      [[ -z "$requested" || "$mapped_count" == 1 ]] || return 1
      resolved+="${resolved:+$'\n'}${title}|${requested}|private|${roster_socket}|${observed_ref}|V2|${generation}"
      continue
    fi
    source_rows=$(printf '%s\n' "$snapshot" | awk -F'|' -v t="$title" '$3 == t && $4 == "0" { print }')
    live_count=$(printf '%s\n' "$source_rows" | grep -c . || true)
    any_count=$(printf '%s\n' "$snapshot" | awk -F'|' -v t="$title" '$3 == t { n++ } END { print n+0 }')
    (( live_count <= 1 && any_count <= 1 )) || return 1
    source="absent"; wid="absent"
    if [[ "$live_count" == 1 ]]; then
      IFS='|' read -r source wid _ _ < <(printf '%s\n' "$(printf '%s\n' "$source_rows" | head -1)")
    fi
    canonical=$(managed_view_command_variants "${VIEW_PREFIX}${title}") || return 2
    candidate_rows=$(workspace_title_candidates "$raw" "$title" "$canonical") || return 2
    target_b64=$(printf '%s' "${VIEW_PREFIX}${title}" | base64 | tr -d '\n') || return 2
    birth_candidates=$(workspace_birth_candidate_rows "$raw" "$births" view \
      "$target_b64" "$candidate_rows") || return 2
    candidate_rows+="${birth_candidates:+${candidate_rows:+$'\n'}${birth_candidates}}"
    mapped_count=$(printf '%s\n' "$candidate_rows" | grep -c . || true)
    (( mapped_count <= 1 )) || return 1
    observed_ref=$(printf '%s\n' "$candidate_rows" | awk -F'|' 'NF == 5 { print $2 }')
    [[ -z "$requested" || "$observed_ref" == "$requested" ]] || return 1
    [[ -z "$requested" || "$mapped_count" == 1 ]] || return 1
    class=""
    if [[ "$mapped_count" == 0 ]]; then
      if linked_session_exists "${VIEW_PREFIX}${title}"; then class=W2; else class=absent; fi
    else
      state=$(ledger_candidate_receipt_state "$generation" "$observed_ref" "$title") || state=conflict
      marker_rc=0
      restored_inflight_state "$generation" "$observed_ref" "$title" || marker_rc=$?
      [[ "$marker_rc" -ne 2 ]] || return 2
      if [[ "$marker_rc" == 0 ]]; then
        class=restored
      else
        case "$state" in
          none) [[ "$live_count" == 1 ]] && class=W1 || class=W1dead ;;
          prepared) [[ "$live_count" == 1 ]] || return 1; class=W1p ;;
          committed)
            if [[ "$live_count" == 1 ]] \
                && _linked_view_matches "${VIEW_PREFIX}${title}" "$wid" "$source" "" "$title"; then
              clients=$(view_session_client_count "${VIEW_PREFIX}${title}") || return 2
              (( clients >= 1 )) && class=healthy || class=W2
            else
              class=W2
            fi
            ;;
          *) return 1 ;;
        esac
      fi
    fi
    roster_count=$(printf '%s\n' "$roster_titles" | grep -cxF "$title" || true)
    [[ "$class" != W1dead || "$roster_count" == 1 ]] || return 1
    resolved+="${resolved:+$'\n'}${title}|${requested}|${source}|${wid}|${observed_ref}|${class}|${generation}"
  done < <(printf '%s\n' "$specs")
  [[ -n "$resolved" ]] || return 1
  OPS_REBUILD_RESOLVED=$(printf '%s\n' "$resolved" | sort)
}

ops_rebuild_authorizes_create() {
  local source="$1" wid="$2" title="$3" active_title active_source active_wid
  [[ "$MUTATOR_LEASE_MODE" == "ops_rebuild" ]] || return 1
  mutator_lease_owned_by_self || return 1
  IFS='|' read -r active_title _ active_source active_wid _ < <(printf '%s\n' "$OPS_REBUILD_ACTIVE_TARGET")
  [[ "$active_title" == "$title" && "$active_source" == "$source" && "$active_wid" == "$wid" ]] || return 1
  printf '%s\n' "$OPS_REBUILD_TARGETS" | awk -F'|' -v t="$title" -v s="$source" -v w="$wid" \
    '$1 == t && $3 == s && $4 == w { found=1 } END { exit(found ? 0 : 1) }'
}

VERIFY_SIDEBAR_REPORT=""
VERIFY_SIDEBAR_EVIDENCE=""

_verify_sidebar_once() {
  local targets="$1" authority_mode="${2:-global}" cmux_generation tmux_generation raw canonical_json
  local agent_snapshot restored_snapshot roster_snapshot authority_snapshot="" births birth_target_b64
  local ledger_bytes="" title source_rows live_count source wid canonical_raw row_shape named_count mapped_count ref
  local report="" evidence="" failures=0 view pane_source pane_view source_name source_dead view_name view_dead view_matches
  local source_pid view_pid clients receipt receipt_uuid birth_uuid rows_count marker_count current_cmux current_tmux
  local surface_ref screen screen_last render_state title_failures_before roster_count
  local roster_row roster_carrier roster_socket pane_private private_client_rows
  cmux_generation=$(cmux_socket_identity) || return 2
  [[ -n "$cmux_generation" ]] || return 2
  tmux_generation=$(tmux_server_generation) || return 2
  raw=$(get_cmux_workspaces_json) || return 2
  canonical_json=$(printf '%s' "$raw" | python3 -c '
import json,sys
try:
    data=json.load(sys.stdin)
except Exception:
    raise SystemExit(2)
if isinstance(data,dict) and isinstance(data.get("workspaces"),list):
    data["workspaces"]=sorted(data["workspaces"],key=lambda item:json.dumps(item,sort_keys=True,separators=(",",":")))
print(json.dumps(data, sort_keys=True, separators=(",", ":")))
') || return 2
  births=$(cmux_attach_birth_records "$canonical_json") || {
    _verify_sidebar_inconclusive "birth-authority-unavailable: cmux session ownership join failed"
    return 2
  }
  agent_snapshot=$(strict_agent_window_snapshot | sort) || return 2
  restored_snapshot=$(_restored_parse_records | sort) || return 2
  if [[ "$authority_mode" == "target" ]]; then
    VERIFY_SIDEBAR_CAVEATS=""
    _derive_sidebar_target_authority "$targets" "$agent_snapshot" || return 2
    roster_snapshot="$SIDEBAR_TARGET_ROSTER_ROWS"
    authority_snapshot="$SIDEBAR_TARGET_AUTHORITY"
    if ! derive_lead_roster || [[ "$LEAD_ROSTER_STATE" != "ok" ]]; then
      _verify_sidebar_append_unique VERIFY_SIDEBAR_CAVEATS \
        "${LEAD_ROSTER_REASONS:-roster-authority-unavailable: roster derivation failed}"
    fi
  else
    derive_lead_roster || {
      _verify_sidebar_inconclusive "${LEAD_ROSTER_REASONS:-roster-authority-unavailable: roster derivation failed}"
      return 2
    }
    [[ "$LEAD_ROSTER_STATE" == "ok" ]] || {
      _verify_sidebar_inconclusive "${LEAD_ROSTER_REASONS:-roster-authority-unavailable: roster derivation failed}"
      return 2
    }
    roster_snapshot=$(printf '%s\n' "$LEAD_ROSTER_ROWS" | sed '/^$/d' | sort)
  fi
  [[ ! -e "$VIEW_LEDGER" || (-f "$VIEW_LEDGER" && ! -L "$VIEW_LEDGER") ]] || return 2
  [[ -f "$VIEW_LEDGER" ]] && ledger_bytes=$(cat "$VIEW_LEDGER") || true

  while IFS= read -r title; do
    [[ -n "$title" ]] || continue
    case "$title" in *'|'*|*$'\t'*|*$'\n'*) return 2 ;; esac
    title_failures_before=$failures
    roster_count=$(printf '%s\n' "$roster_snapshot" | awk -F'|' -v t="$title" '$3 == t { n++ } END { print n+0 }')
    roster_row=$(printf '%s\n' "$roster_snapshot" | awk -F'|' -v t="$title" '$3 == t { print; exit }')
    IFS='|' read -r roster_carrier _ _ roster_socket < <(printf '%s\n' "$roster_row")
    if [[ "$roster_carrier" == "claude-private" ]]; then
      canonical_raw=$(build_lead_attach_command "$roster_socket") || return 2
      birth_target_b64=$(printf '%s' "$roster_socket" | base64 | tr -d '\n') || return 2
      row_shape=$(workspace_candidate_shape "$canonical_json" "$title" "$canonical_raw" \
        "$births" lead "$birth_target_b64") || return 2
      IFS='|' read -r named_count mapped_count ref < <(printf '%s\n' "$row_shape")
      if [[ "$named_count" != "1" || "$mapped_count" != "1" || "$ref" != workspace:* ]]; then
        report+="${report:+$'\n'}FAIL $title rule=v2-row expected=one-named observed=named:$named_count,mapped:$mapped_count"
        failures=$((failures + 1))
      fi
      pane_private="unavailable"
      if pane_private=$(tmux -S "$roster_socket" list-panes -t '%0' \
          -F '#{pane_id}|#{session_name}|#{pane_dead}|#{pane_pid}' 2>/dev/null); then
        if [[ "$pane_private" != '%0|main|0|'* ]]; then
          report+="${report:+$'\n'}FAIL $title rule=v2-pane observed=$pane_private"
          failures=$((failures + 1))
        fi
      else
        report+="${report:+$'\n'}FAIL $title rule=v2-pane observed=unavailable"
        failures=$((failures + 1))
      fi
      clients=0
      if private_client_rows=$(tmux -S "$roster_socket" list-clients -t '=main' \
          -F '#{client_pid}' 2>/dev/null); then
        clients=$(printf '%s\n' "$private_client_rows" | grep -c . || true)
      fi
      if (( clients < 1 )); then
        report+="${report:+$'\n'}FAIL $title rule=v2-client-count observed=$clients"
        failures=$((failures + 1))
      fi
      surface_ref="unavailable"; render_state="unavailable"
      if [[ "$named_count" == "1" && "$mapped_count" == "1" && "$ref" == workspace:* ]]; then
        surface_ref=$(workspace_terminal_surface_ref "$ref") || return 2
        if screen=$(cmux_call read-screen --workspace "$ref" --surface "$surface_ref"); then
          screen_last=$(printf '%s\n' "$screen" | awk 'NF{line=$0} END{print line}' | sed 's/[[:space:]]*$//')
          render_state="nonbare"
          case "$screen_last" in
            ''|*'%'|*'$'|*'#') render_state="bare" ;;
          esac
        fi
      fi
      if [[ "$render_state" != "nonbare" ]]; then
        report+="${report:+$'\n'}FAIL $title rule=v2-render observed=$render_state"
        failures=$((failures + 1))
      fi
      receipt=$(ledger_candidate_receipt_state "$cmux_generation" "$ref" "$title") || receipt=conflict
      receipt_uuid=$(ledger_exact_receipt_uuid "$cmux_generation" "$ref" "$title" 2>/dev/null || true)
      birth_uuid=$(printf '%s\n' "$births" | awk -F'|' -v r="$ref" -v t="$birth_target_b64" \
        '$1==r && $5=="lead" && $6==t {n++; u=$2} END {if(n==1) print u}')
      rows_count=$(printf '%s\n' "$(ledger_rows_for_title "$cmux_generation" "$title")" | grep -c . || true)
      if [[ "$receipt" != "committed" || "$rows_count" != "1" ]]; then
        report+="${report:+$'\n'}FAIL $title rule=v2-receipt observed=$receipt,count:$rows_count"
        failures=$((failures + 1))
      fi
      if [[ -z "$birth_uuid" ]]; then
        report+="${report:+$'\n'}WARN $title rule=receipt-uuid-unattributable observed=${receipt_uuid:-missing},birth:missing"
      elif [[ "$receipt_uuid" == __LEGACY__ || "$receipt_uuid" != "$birth_uuid" ]]; then
        report+="${report:+$'\n'}FAIL $title rule=v2-receipt-uuid observed=${receipt_uuid:-missing},birth:${birth_uuid:-missing}"
        failures=$((failures + 1))
      fi
      marker_count=$(printf '%s\n' "$restored_snapshot" | awk -F'\t' -v t="$title" '$4 == t { n++ } END { print n+0 }')
      if (( marker_count > 0 )); then
        report+="${report:+$'\n'}FAIL $title rule=v2-restored-marker observed=$marker_count"
        failures=$((failures + 1))
      fi
      if [[ "$failures" -eq "$title_failures_before" ]]; then
        report+="${report:+$'\n'}PASS $title live-v2 ref=$ref socket=$roster_socket"
      fi
      evidence+="${evidence:+$'\n'}$title|live-v2|$row_shape|$pane_private|$clients|$receipt|$rows_count|$marker_count|$surface_ref|render:$render_state"
      continue
    fi
    source_rows=$(printf '%s\n' "$agent_snapshot" | awk -F'|' -v t="$title" '$3 == t && $4 == "0" { print }')
    live_count=$(printf '%s\n' "$source_rows" | grep -c . || true)
    canonical_raw=$(managed_view_command_variants "${VIEW_PREFIX}${title}") || return 2
    birth_target_b64=$(printf '%s' "${VIEW_PREFIX}${title}" | base64 | tr -d '\n') || return 2
    row_shape=$(workspace_candidate_shape "$canonical_json" "$title" "$canonical_raw" \
      "$births" view "$birth_target_b64") || return 2
    IFS='|' read -r named_count mapped_count ref < <(printf '%s\n' "$row_shape")
    view="${VIEW_PREFIX}${title}"
    if [[ "$live_count" == "1" ]]; then
      IFS='|' read -r source wid _ _ < <(printf '%s\n' "$(printf '%s\n' "$source_rows" | head -1)")
      if [[ "$named_count" != "1" || "$mapped_count" != "1" \
          || "$ref" != workspace:* ]]; then
        report+="${report:+$'\n'}FAIL $title rule=row-live expected=one-named observed=named:$named_count,mapped:$mapped_count"
        failures=$((failures + 1))
      fi
      view_matches=0
      if _linked_view_matches "$view" "$wid" "$source" "" "$title"; then
        view_matches=1
      else
        report+="${report:+$'\n'}FAIL $title rule=a1-topology"
        failures=$((failures + 1))
      fi
      pane_source=$(tmux display-message -p -t "=${source}:${wid}" '#{window_name}|#{pane_dead}' 2>/dev/null) || return 2
      source_pid=$(tmux display-message -p -t "=${source}:${wid}" '#{pane_pid}' 2>/dev/null) || return 2
      IFS='|' read -r source_name source_dead < <(printf '%s\n' "$pane_source")
      pane_view="unavailable"; view_name=""; view_dead=""; view_pid=""; clients="not-measured"
      if [[ "$view_matches" == 1 ]]; then
        pane_view=$(tmux display-message -p -t "=${view}:${wid}" '#{window_name}|#{pane_dead}' 2>/dev/null) || return 2
        view_pid=$(tmux display-message -p -t "=${view}:${wid}" '#{pane_pid}' 2>/dev/null) || return 2
        IFS='|' read -r view_name view_dead < <(printf '%s\n' "$pane_view")
        clients=$(view_session_client_count "$view") || return 2
      fi
      if [[ "$source_name" != "$title" || "$source_dead" != "0" || -z "$source_pid" \
          || "$view_matches" != 1 || "$view_name" != "$title" || "$view_dead" != "0" \
          || "$source_pid" != "$view_pid" ]]; then
        report+="${report:+$'\n'}FAIL $title rule=pane-identity"
        failures=$((failures + 1))
      fi
      if [[ "$clients" == "not-measured" ]]; then
        report+="${report:+$'\n'}FAIL $title rule=client-count observed=not-measured"
        failures=$((failures + 1))
      elif (( clients < 1 )); then
        report+="${report:+$'\n'}FAIL $title rule=client-count observed=$clients"
        failures=$((failures + 1))
      fi
      surface_ref="not-applicable"; screen=""; render_state="unavailable"
      if [[ "$named_count" == "1" && "$mapped_count" == "1" && "$ref" == workspace:* ]]; then
        surface_ref=$(workspace_terminal_surface_ref "$ref") || return 2
        if screen=$(cmux_call read-screen --workspace "$ref" --surface "$surface_ref"); then
          screen_last=$(printf '%s\n' "$screen" | awk 'NF{line=$0} END{print line}' | sed 's/[[:space:]]*$//')
          render_state="nonbare"
          case "$screen_last" in
            ''|*'%'|*'$'|*'#')
              render_state="bare"
              report+="${report:+$'\n'}FAIL $title rule=render observed=bare-or-empty"
              failures=$((failures + 1))
              ;;
          esac
        else
          report+="${report:+$'\n'}FAIL $title rule=render observed=unavailable"
          failures=$((failures + 1))
        fi
      fi
      receipt=$(ledger_candidate_receipt_state "$cmux_generation" "$ref" "$title") || receipt=conflict
      receipt_uuid=$(ledger_exact_receipt_uuid "$cmux_generation" "$ref" "$title" 2>/dev/null || true)
      birth_uuid=$(printf '%s\n' "$births" | awk -F'|' -v r="$ref" -v t="$birth_target_b64" \
        '$1==r && $5=="view" && $6==t {n++; u=$2} END {if(n==1) print u}')
      rows_count=$(printf '%s\n' "$(ledger_rows_for_title "$cmux_generation" "$title")" | grep -c . || true)
      if [[ "$receipt" != "committed" || "$rows_count" != "1" ]]; then
        report+="${report:+$'\n'}FAIL $title rule=receipt observed=$receipt,count:$rows_count"
        failures=$((failures + 1))
      fi
      if [[ -z "$birth_uuid" ]]; then
        report+="${report:+$'\n'}WARN $title rule=receipt-uuid-unattributable observed=${receipt_uuid:-missing},birth:missing"
      elif [[ "$receipt_uuid" == __LEGACY__ || "$receipt_uuid" != "$birth_uuid" ]]; then
        report+="${report:+$'\n'}FAIL $title rule=receipt-uuid observed=${receipt_uuid:-missing},birth:${birth_uuid:-missing}"
        failures=$((failures + 1))
      fi
      marker_count=$(printf '%s\n' "$restored_snapshot" | awk -F'\t' -v t="$title" '$4 == t { n++ } END { print n+0 }')
      if (( marker_count > 0 )); then
        report+="${report:+$'\n'}FAIL $title rule=restored-marker observed=$marker_count"
        failures=$((failures + 1))
      fi
      if [[ "$failures" -eq "$title_failures_before" ]]; then
        report+="${report:+$'\n'}PASS $title live ref=$ref source=$source:$wid"
      fi
      evidence+="${evidence:+$'\n'}$title|live|$source|$wid|$row_shape|$pane_source|$pane_view|$source_pid|$view_pid|$clients|$receipt|$rows_count|$marker_count|$surface_ref|render:$render_state"
    elif [[ "$live_count" == "0" ]]; then
      if (( roster_count > 0 )); then
        report+="${report:+$'\n'}FAIL $title rule=roster-lead-absent"
        failures=$((failures + 1))
      fi
      if [[ "$mapped_count" != "0" ]]; then
        report+="${report:+$'\n'}FAIL $title rule=row-dead observed=$mapped_count"
        failures=$((failures + 1))
      fi
      if linked_session_exists "$view"; then
        report+="${report:+$'\n'}FAIL $title rule=view-dead-present"
        failures=$((failures + 1))
      fi
      rows_count=$(printf '%s\n' "$(ledger_rows_for_title "$cmux_generation" "$title")" | grep -c . || true)
      if [[ "$rows_count" != "0" ]]; then
        report+="${report:+$'\n'}FAIL $title rule=receipt-dead observed=$rows_count"
        failures=$((failures + 1))
      fi
      marker_count=$(printf '%s\n' "$restored_snapshot" | awk -F'\t' -v t="$title" '$4 == t { n++ } END { print n+0 }')
      if (( marker_count > 0 )); then
        report+="${report:+$'\n'}FAIL $title rule=restored-marker-dead observed=$marker_count"
        failures=$((failures + 1))
      fi
      if [[ "$failures" -eq "$title_failures_before" ]]; then
        report+="${report:+$'\n'}PASS $title absent"
      fi
      evidence+="${evidence:+$'\n'}$title|absent|$row_shape|$rows_count|$marker_count"
    else
      report+="${report:+$'\n'}FAIL $title rule=source-unique observed=$live_count"
      failures=$((failures + 1))
      evidence+="${evidence:+$'\n'}$title|ambiguous-source|$live_count|$row_shape"
    fi
  done < <(printf '%s\n' "$targets")
  current_cmux=$(cmux_socket_identity) || return 2
  current_tmux=$(tmux_server_generation) || return 2
  [[ "$current_cmux" == "$cmux_generation" && "$current_tmux" == "$tmux_generation" ]] || return 2
  VERIFY_SIDEBAR_REPORT="$report"
  VERIFY_SIDEBAR_EVIDENCE="$cmux_generation
$tmux_generation
$canonical_json
$agent_snapshot
$roster_snapshot
$authority_snapshot
$VERIFY_SIDEBAR_CAVEATS
$ledger_bytes
$restored_snapshot
$evidence"
  [[ "$failures" -eq 0 ]] && return 0
  return 1
}

verify_sidebar_targets() {
  local targets="$1" authority_mode="${2:-global}" first_rc=0 second_rc=0
  local first_evidence second_report second_evidence
  VERIFY_SIDEBAR_REPORT=""
  VERIFY_SIDEBAR_EVIDENCE=""
  # Both stability samples must parse the same immutable processTitle grammar.
  cmux_attach_tmux_bin_cache_prime || :
  _verify_sidebar_once "$targets" "$authority_mode" || first_rc=$?
  first_evidence="$VERIFY_SIDEBAR_EVIDENCE"
  if [[ "$first_rc" -eq 2 ]]; then
    [[ -n "$VERIFY_SIDEBAR_REASONS" ]] \
      || _verify_sidebar_append_unique VERIFY_SIDEBAR_REASONS \
        "sidebar-snapshot-unavailable: first snapshot could not be proven"
    return 2
  fi
  _verify_sidebar_once "$targets" "$authority_mode" || second_rc=$?
  second_report="$VERIFY_SIDEBAR_REPORT"
  second_evidence="$VERIFY_SIDEBAR_EVIDENCE"
  if [[ "$second_rc" -eq 2 ]]; then
    [[ -n "$VERIFY_SIDEBAR_REASONS" ]] \
      || _verify_sidebar_append_unique VERIFY_SIDEBAR_REASONS \
        "sidebar-snapshot-unavailable: second snapshot could not be proven"
    return 2
  fi
  if [[ "$first_rc" != "$second_rc" || "$first_evidence" != "$second_evidence" ]]; then
    VERIFY_SIDEBAR_REPORT="INCONCLUSIVE snapshot-drift"
    _verify_sidebar_append_unique VERIFY_SIDEBAR_REASONS \
      "snapshot-drift: composite authority changed between reads"
    return 2
  fi
  VERIFY_SIDEBAR_REPORT="$second_report"
  VERIFY_SIDEBAR_EVIDENCE="$second_evidence"
  return "$second_rc"
}

_ops_adopt_restored_candidate() {
  local kind="$1" generation="$2" ref="$3" title="$4" expected_state="$5"
  local first_fingerprint first_source first_wid second_fingerprint probe_rc=0 interval
  _restored_candidate_probe "$kind" "$generation" "$ref" "$title" || probe_rc=$?
  [[ "$probe_rc" -eq 0 ]] || return "$probe_rc"
  [[ "$RESTORED_PROBE_RAW_TITLE" == "$title" ]] || return 1
  first_fingerprint="$RESTORED_PROBE_FINGERPRINT"
  first_source="$RESTORED_PROBE_SOURCE"
  first_wid="$RESTORED_PROBE_WID"
  interval="${FLYWHEEL_CMUX_OPS_REPROBE_SECONDS:-1}"
  case "$interval" in ''|*[!0-9]*) interval=1 ;; esac
  (( interval > 5 )) && interval=5
  sleep "$interval"
  probe_rc=0
  _restored_candidate_probe "$kind" "$generation" "$ref" "$title" "$first_fingerprint" || probe_rc=$?
  [[ "$probe_rc" -eq 0 ]] || return "$probe_rc"
  second_fingerprint="$RESTORED_PROBE_FINGERPRINT"
  [[ "$second_fingerprint" == "$first_fingerprint" \
      && "$RESTORED_PROBE_SOURCE" == "$first_source" \
      && "$RESTORED_PROBE_WID" == "$first_wid" \
      && "$RESTORED_PROBE_RAW_TITLE" == "$title" ]] || return 1
  [[ "$(ledger_candidate_receipt_state "$generation" "$ref" "$title")" == "$expected_state" ]] || return 1
  _restored_marker_upsert "$kind" "$generation" "$ref" "$title" "$expected_state" \
    "$first_fingerprint" || return $?
  local FLYWHEEL_CMUX_ADOPTION_GRACE=0
  recover_restored_transactions "$title"
}

_ops_refresh_resolved_line() {
  local title="$1" line
  resolve_rebuild_targets || return $?
  line=$(printf '%s\n' "$OPS_REBUILD_RESOLVED" | awk -F'|' -v t="$title" '$1 == t { print; exit }')
  [[ -n "$line" ]] || return 1
  printf '%s\n' "$line"
}

execute_ops_rebuild_targets() {
  local targets="$1" line title requested source wid ref class generation action rc=0 refreshed before_rc before_hash
  OPS_REBUILD_RESULTS=""
  OPS_REBUILD_TARGETS="$targets"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    IFS='|' read -r title requested source wid ref class generation < <(printf '%s\n' "$line")
    OPS_REBUILD_ACTIVE_TARGET="$line"
    action="$class"
    log "[audit] ops rebuild title start title=$title class=$class ref=${ref:-none} source=$source wid=$wid"
    before_rc=0
    verify_sidebar_targets "$title" target || before_rc=$?
    [[ "$before_rc" -ne 2 ]] || {
      OPS_REBUILD_RESULTS+="${OPS_REBUILD_RESULTS:+$'\n'}${title}|${class}|pre-verify-inconclusive|FAILED:2"
      return 2
    }
    before_hash=$(_cmux_alert_hash "$VERIFY_SIDEBAR_REPORT")
    log "[audit] ops rebuild pre-verify title=$title rc=$before_rc report_sha256=$before_hash"
    case "$class" in
      V2)
        ensure_v2_lead_workspace "$title" "$wid" || rc=$?
        action="direct-v2-reconcile"
        ;;
      healthy) action=noop-healthy ;;
      restored)
        local FLYWHEEL_CMUX_ADOPTION_GRACE=0
        recover_restored_transactions "$title" || rc=$?
        if [[ "$rc" -eq 0 ]]; then
          refreshed=$(_ops_refresh_resolved_line "$title") || rc=$?
        fi
        if [[ "$rc" -eq 0 ]]; then
          IFS='|' read -r title requested source wid ref class generation < <(printf '%s\n' "$refreshed")
          OPS_REBUILD_ACTIVE_TARGET="$refreshed"
          case "$class" in
            healthy) action=recovered-healthy ;;
            absent) action=recovered-absent ;;
            *) rc=1 ;;
          esac
        fi
        ;;
      W1|W1p|W1dead)
        local kind expected_state
        kind="$class"; expected_state=none
        [[ "$class" == W1p ]] && expected_state=prepared
        _ops_adopt_restored_candidate "$kind" "$generation" "$ref" "$title" "$expected_state" || rc=$?
        action="adopt-${class}"
        ;;
      W2)
        dismantle_view_display "$title" ops-rebuild || rc=$?
        action="dismantle-${DISMANTLE_OUTCOME:-failed}"
        ;;
      absent) action=already-absent ;;
      *) rc=2 ;;
    esac
    if [[ "$rc" -eq 0 && "$source" != "absent" && "$source" != "private" && "$class" != healthy \
        && "$class" != restored ]]; then
      create_workspace_for_window "$source" "$wid" "$title" || rc=$?
      action="${action}+create"
    elif [[ "$rc" -eq 0 && "$source" != "absent" && "$class" == restored \
        && "$action" == recovered-absent ]]; then
      create_workspace_for_window "$source" "$wid" "$title" || rc=$?
      action="${action}+create"
    fi
    if [[ "$rc" -eq 0 ]]; then
      verify_sidebar_targets "$title" target || rc=$?
    fi
    if [[ "$rc" -eq 0 ]]; then
      OPS_REBUILD_RESULTS+="${OPS_REBUILD_RESULTS:+$'\n'}${title}|${class}|before:${before_rc}:${before_hash}|${action}|PASS"
      log "[audit] ops rebuild title complete title=$title action=$action"
    else
      OPS_REBUILD_RESULTS+="${OPS_REBUILD_RESULTS:+$'\n'}${title}|${class}|before:${before_rc}:${before_hash}|${action}|FAILED:${rc}"
      log "ERROR: ops rebuild stopped title=$title class=$class action=$action rc=$rc report=${VERIFY_SIDEBAR_REPORT:-none}"
      OPS_REBUILD_ACTIVE_TARGET=""
      return "$rc"
    fi
  done < <(printf '%s\n' "$targets")
  OPS_REBUILD_ACTIVE_TARGET=""
  return 0
}

OPS_REBUILD_REPORT_PATH=""
write_ops_rebuild_report() {
  local preflight="$1" result_rc="$2" timestamp nonce tmp
  timestamp=$(date -u '+%Y%m%dT%H%M%SZ') || return 1
  nonce="${MUTATOR_LEASE_NONCE:-${OPS_CLAIM_NONCE:-$$}}"
  case "$nonce" in ''|*[!A-Za-z0-9_.-]*) nonce="$$" ;; esac
  mkdir -p "$CMUX_REBUILD_REPORT_DIR" 2>/dev/null || return 1
  OPS_REBUILD_REPORT_PATH="$CMUX_REBUILD_REPORT_DIR/${timestamp}-${nonce}.txt"
  tmp=$(mktemp "${OPS_REBUILD_REPORT_PATH}.XXXXXX" 2>/dev/null) || return 1
  {
    printf 'FLY-1596 cmux ops rebuild\n'
    printf 'timestamp_utc=%s\n' "$timestamp"
    printf 'pid=%s\n' "$$"
    printf 'result_rc=%s\n' "$result_rc"
    printf 'preflight:\n%s\n' "$preflight"
    printf 'results:\n%s\n' "${OPS_REBUILD_RESULTS:-none}"
    printf 'verify:\n%s\n' "${VERIFY_SIDEBAR_REPORT:-not-run}"
  } > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$OPS_REBUILD_REPORT_PATH" 2>/dev/null || { rm -f "$tmp"; return 1; }
  printf 'report=%s\n' "$OPS_REBUILD_REPORT_PATH"
}

run_rebuild_views() {
  local preflight refreshed rc=0 lease_rc=0 waited=0 wait_limit
  parse_rebuild_views_args "$@" || {
    log "ERROR: invalid --rebuild-views arguments"
    return 2
  }
  resolve_rebuild_targets || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    log "ERROR: rebuild semantic preflight refused rc=$rc"
    return "$rc"
  fi
  preflight="$OPS_REBUILD_RESOLVED"
  printf 'cmux rebuild plan:\n%s\n' "$preflight"
  [[ "$OPS_REBUILD_EXECUTE" == 1 ]] || return 0

  if [[ "$OPS_REBUILD_HANDOVER" == 1 ]]; then
    publish_ops_rebuild_claim || {
      log "ERROR: unable to publish ops_rebuild handover claim"
      return 1
    }
  fi
  trap 'release_mutator_lease; release_ops_rebuild_claim' EXIT
  trap 'release_mutator_lease; release_ops_rebuild_claim; exit 130' INT
  trap 'release_mutator_lease; release_ops_rebuild_claim; exit 143' TERM
  wait_limit="${FLYWHEEL_CMUX_OPS_HANDOVER_SECONDS:-90}"
  case "$wait_limit" in ''|*[!0-9]*) wait_limit=90 ;; esac
  (( wait_limit > 300 )) && wait_limit=300
  while true; do
    lease_rc=0; acquire_mutator_lease ops_rebuild || lease_rc=$?
    [[ "$lease_rc" -eq 0 ]] && break
    if [[ "$lease_rc" -eq 2 || "$OPS_REBUILD_HANDOVER" != 1 || "$waited" -ge "$wait_limit" ]]; then
      log "ERROR: ops rebuild could not acquire mutator lease rc=$lease_rc waited=${waited}s"
      release_ops_rebuild_claim
      trap - EXIT INT TERM
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if ! maintenance_entry_allowed ops_rebuild; then
    rc=1
  else
    resolve_rebuild_targets || rc=$?
    refreshed="$OPS_REBUILD_RESOLVED"
    if [[ "$rc" -eq 0 && "$refreshed" != "$preflight" ]]; then
      log "ERROR: ops rebuild preflight drifted during handoff; zero target mutation performed"
      rc=1
    fi
  fi
  if [[ "$rc" -eq 0 ]]; then
    execute_ops_rebuild_targets "$refreshed" || rc=$?
  fi
  write_ops_rebuild_report "$preflight" "$rc" || {
    log "ERROR: unable to persist ops rebuild audit report"
    [[ "$rc" -ne 0 ]] || rc=1
  }
  _alert_cmux_cleanup \
    "cmux ops rebuild completed" \
    "FLY-1596 audited rebuild finished rc=$rc report=${OPS_REBUILD_REPORT_PATH:-unavailable}." \
    "cmux_cleanup|ops-rebuild|pid=$$|rc=$rc"
  release_mutator_lease
  release_ops_rebuild_claim
  trap - EXIT INT TERM
  return "$rc"
}

parse_converge_runners_args() {
  [[ "$#" == 1 && "$1" == --handover ]]
}

run_converge_runners() {
  parse_converge_runners_args "$@" || {
    log "ERROR: --converge-runners requires exactly one --handover argument"
    return 2
  }
  if [[ "${FLYWHEEL_CMUX_DRY_RUN:-0}" == 1 ]]; then
    log "DRY RUN: runner convergence skipped before handover; no claim, lease, state, signal, or cmux mutation performed"
    return 0
  fi

  publish_ops_rebuild_claim || {
    log "ERROR: unable to publish runner-convergence handover claim"
    return 1
  }
  trap 'release_mutator_lease; release_ops_rebuild_claim' EXIT
  trap 'release_mutator_lease; release_ops_rebuild_claim; exit 130' INT
  trap 'release_mutator_lease; release_ops_rebuild_claim; exit 143' TERM

  local wait_limit waited=0 lease_rc=0 rc=0 observation round
  wait_limit=$(validated_int_env FLYWHEEL_CMUX_CONVERGE_HANDOVER_SECONDS \
    "${FLYWHEEL_CMUX_CONVERGE_HANDOVER_SECONDS:-600}" 600 900)
  while true; do
    lease_rc=0
    acquire_mutator_lease ops_rebuild || lease_rc=$?
    [[ "$lease_rc" == 0 ]] && break
    if [[ "$lease_rc" == 2 || "$waited" -ge "$wait_limit" ]]; then
      log "ERROR: runner convergence could not acquire mutator lease rc=$lease_rc waited=${waited}s; inspect watcher heartbeat and lease owner, then retry"
      release_ops_rebuild_claim
      trap - EXIT INT TERM
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if ! maintenance_entry_allowed ops_rebuild; then
    log "ERROR: runner convergence maintenance authority refused; inspect maintenance marker and QA/ops claims"
    rc=1
  fi
  observation=$(validated_int_env FLYWHEEL_CMUX_CONVERGE_OBSERVATION_SECONDS \
    "${FLYWHEEL_CMUX_CONVERGE_OBSERVATION_SECONDS:-60}" 60 300)
  (( observation < 60 )) && observation=60
  if [[ "$rc" == 0 ]]; then
    advance_attach_reap_state || rc=$?
  fi
  for round in 1 2; do
    [[ "$rc" == 0 ]] || break
    CMUX_ADDITIVE_ROUND_ID=""
    CMUX_ADOPTION_COUNT=0
    begin_cmux_additive_round || { rc=2; break; }
    cmux_attach_tmux_bin_cache_prime || :
    cmux_attach_birth_cache_prime || { rc=2; break; }
    prepare_linked_view_state pre || { rc=2; break; }
    reap_orphan_pins_oneshot || { rc=$?; break; }
    CMUX_HELPER_DISCOVERY_CONCLUSIVE=0
    discover_orphan_attach_helpers || { rc=$?; break; }
    if [[ "$CMUX_HELPER_DISCOVERY_CONCLUSIVE" != 1 ]]; then
      log "ERROR: runner convergence helper discovery returned without a conclusive receipt"
      rc=2
      break
    fi
    CMUX_STOCK_SWEEP_CONCLUSIVE=0
    FLYWHEEL_CMUX_ADOPTION_GRACE="$observation" \
      FLYWHEEL_CMUX_STOCK_ALLOW_LEGACY_PREPARED=1 \
      reap_unledgered_stock_workspaces || { rc=$?; break; }
    if [[ "$CMUX_STOCK_SWEEP_CONCLUSIVE" != 1 ]]; then
      log "ERROR: runner convergence stock sweep returned without a conclusive receipt"
      rc=2
      break
    fi
    if [[ "$round" != 2 ]]; then
      for (( waited=0; waited<observation; waited++ )); do sleep 1; done
    fi
  done
  if [[ "$rc" == 0 ]]; then
    advance_attach_reap_state || rc=$?
  fi
  release_mutator_lease
  release_ops_rebuild_claim
  trap - EXIT INT TERM
  return "$rc"
}

run_verify_sidebar() {
  local rc=0 status reason caveat authority_mode=global
  VERIFY_SIDEBAR_REPORT=""
  VERIFY_SIDEBAR_REASONS=""
  VERIFY_SIDEBAR_CAVEATS=""
  if ! parse_verify_sidebar_args "$@"; then
    rc=2
    _verify_sidebar_append_unique VERIFY_SIDEBAR_REASONS \
      "invalid-arguments: expected repeated --target TITLE and optional --json"
  else
    [[ -n "$OPS_VERIFY_TARGETS" ]] && authority_mode=target
    _resolve_sidebar_subjects || rc=$?
    if [[ "$rc" -eq 0 ]]; then
      verify_sidebar_targets "$OPS_VERIFY_TARGETS" "$authority_mode" || rc=$?
    fi
  fi
  if [[ "$rc" -eq 2 && -z "$VERIFY_SIDEBAR_REASONS" ]]; then
    _verify_sidebar_append_unique VERIFY_SIDEBAR_REASONS \
      "sidebar-authority-unavailable: conclusive verification was not possible"
  fi
  if [[ "$OPS_VERIFY_JSON" == 1 ]]; then
    [[ "$rc" == 0 ]] && status=pass || { [[ "$rc" == 1 ]] && status=fail || status=inconclusive; }
    python3 -c 'import json,sys; print(json.dumps({"status":sys.argv[1],"exit_code":int(sys.argv[2]),"report":sys.argv[3].splitlines(),"reasons":sys.argv[4].splitlines(),"caveats":sys.argv[5].splitlines()},sort_keys=True))' \
      "$status" "$rc" "$VERIFY_SIDEBAR_REPORT" "$VERIFY_SIDEBAR_REASONS" "$VERIFY_SIDEBAR_CAVEATS"
  else
    [[ -n "$VERIFY_SIDEBAR_REPORT" ]] && printf '%s\n' "$VERIFY_SIDEBAR_REPORT"
    if [[ "$rc" -eq 2 ]]; then
      while IFS= read -r reason; do
        [[ -n "$reason" ]] && printf 'INCONCLUSIVE %s\n' "$reason"
      done < <(printf '%s\n' "$VERIFY_SIDEBAR_REASONS")
    fi
    while IFS= read -r caveat; do
      [[ -n "$caveat" ]] && printf 'CAVEAT %s\n' "$caveat"
    done < <(printf '%s\n' "$VERIFY_SIDEBAR_CAVEATS")
  fi
  return "$rc"
}

# FLY-254 (gap a): unhealthy-state sleep with app-open edge detection.
# FLY-1944: a healthy watcher also probes the event marker in <=3s slices so a
# newly created tmux window reaches a cmux mirror well inside the one-minute
# SLA. An unhealthy watcher cannot drain events, so event backlog must not
# collapse its recovery backoff.
# rc=1 (socket missing): sleep in slices; wake early when the socket appears.
# rc=3 (socket present but ping failing — the stale socket a quit cmux app can
# leave behind, observed live in Codex R2): wake early when the socket's
# filesystem identity changes (a new app instance bound the path).
# Both probes are pure shell/file tests — zero IPC; total sleep duration is
# unchanged when no edge arrives.
REOPEN_SLEEP_EDGE=""
reopen_aware_sleep() {
  local total="$1"
  local slice reopen_probe=0 reopen_slice
  REOPEN_SLEEP_EDGE=""
  slice=$(validated_int_env FLYWHEEL_CMUX_EVENT_PROBE_SLICE "${FLYWHEEL_CMUX_EVENT_PROBE_SLICE:-3}" 3 3)
  if reopen_sweep_enabled \
     && [[ "$CMUX_HEALTH_LAST_RC" == "1" || "$CMUX_HEALTH_LAST_RC" == "3" ]]; then
    reopen_probe=1
    reopen_slice=$(validated_int_env FLYWHEEL_CMUX_SOCKET_PROBE_SLICE "${FLYWHEEL_CMUX_SOCKET_PROBE_SLICE:-3}" 3 60)
    (( reopen_slice < slice )) && slice=$reopen_slice
  fi
  local ref_ident=""
  if [[ "$reopen_probe" == "1" && "$CMUX_HEALTH_LAST_RC" == "3" ]]; then
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
    if [[ "$CMUX_HEALTH_LAST_RC" == "0" && "${WATCHER_AUTHORITY_LOST:-0}" != "1" \
       && -s "$EVENT_FILE" ]]; then
      REOPEN_SLEEP_EDGE="event"
      return 0
    fi
    [[ "$reopen_probe" == "1" ]] || continue
    if [[ "$CMUX_HEALTH_LAST_RC" == "1" ]]; then
      if cmux_socket_present; then
        REOPEN_SLEEP_EDGE="socket"
        return 0
      fi
    else
      now_ident=$(cmux_socket_identity)
      if [[ -n "$now_ident" && "$now_ident" != "$ref_ident" ]]; then
        REOPEN_SLEEP_EDGE="socket"
        return 0
      fi
    fi
  done
  return 0
}

watcher_backoff_sleep() {
  local total="$1" elapsed=0 step=5 remain next_heartbeat=15
  if (( total <= 15 )) \
      || [[ "$CMUX_HEALTH_LAST_RC" != "1" && "$CMUX_HEALTH_LAST_RC" != "3" ]]; then
    reopen_aware_sleep "$total"
    return 0
  fi
  while (( elapsed < total )); do
    remain=$((total - elapsed))
    (( step > remain )) && step=$remain
    reopen_aware_sleep "$step"
    elapsed=$((elapsed + step))
    [[ "$REOPEN_SLEEP_EDGE" == "socket" ]] && return 0
    if (( elapsed >= next_heartbeat )); then
      watcher_write_heartbeat backoff sleep
      next_heartbeat=$((next_heartbeat + 15))
    fi
    maintenance_requested && return 0
  done
}

watch_loop() {
  # Polling loop for --watch mode. Wrapped in a function so `local` is legal.
  # FLY-129 Phase 7: backoff while unhealthy. Healthy ticks stay at 15s so
  # event drain latency is unchanged; degraded paths back off up to 300s.
  local tick=0 sleep_seconds=15
  while true; do
    # FLY-254 (gap a): unhealthy sleeps are sliced with a pure-stat app-open
    # edge probe so a reopen is noticed in seconds instead of a full backoff
    # window (up to 300s). Healthy sleeps are event-aware 3s slices so a hook
    # delivery cannot wait behind the ordinary 15s cadence.
    watcher_backoff_sleep "$sleep_seconds"
    tick=$((tick + 1))
    # Heartbeat means a scan tick actually began; the watchdog therefore does
    # not confuse a live-but-stuck loop with ordinary process liveness.
    watcher_write_heartbeat "$tick" scan

    watcher_maintenance_checkpoint
    if [[ "$WATCHER_RESYNC_REQUIRED" == "1" ]]; then
      WATCHER_RESYNC_REQUIRED=0
      if watcher_begin_pass; then
        sync_additive_bootstrap
      fi
      watcher_finish_pass
    fi

    if ! watcher_begin_pass; then
      watcher_finish_pass
      continue
    fi

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
      # FLY-1944: already-issued helper reaps advance on every healthy 15s
      # tick. This reuses the existing cadence; no extra timer or polling loop.
      advance_attach_reap_state \
        || log "WARN: helper reap advancement deferred; signal authority preserved"
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
      [[ "$WATCHER_AUTHORITY_LOST" == "1" ]] || drain_events
      [[ "$WATCHER_AUTHORITY_LOST" == "1" ]] || process_pending_cleanups
      # FLY-685: drain close_runner's close-request markers → immediate pin removal.
      [[ "$WATCHER_AUTHORITY_LOST" == "1" ]] || process_close_requests
      if [[ "$WATCHER_AUTHORITY_LOST" != "1" ]] && (( tick % 4 == 0 )); then
        sync_additive
      fi
      sleep_seconds=15
    else
      sleep_seconds=$(next_sleep_seconds "$CMUX_HEALTH_FAIL_COUNT")
    fi
    watcher_finish_pass
  done
}

# FLY-129: --watch dispatcher body. Wrapped in a function so we can use `local`
# without falling foul of the case-statement scope.
watch_main() {
  log "Watch mode: event-signaled polling (${CLEANUP_DELAY_SECONDS}s cleanup delay, ${CONSERVATIVE_CLEANUP_SECONDS}s conservative cleanup)"
  # Publish new-generation evidence immediately so restart/recovery can prove
  # the bootstrapped owner is scanning without waiting through the first 15s.
  watcher_write_heartbeat bootstrap scan
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
  log "FLY-254 knobs: reopen-sweep=1 render-wait-ticks=${_rw} readiness-ticks=${_rt} probe-slice=${_ps}s attempt-limit=${REOPEN_ATTEMPT_LIMIT}"

  # Gate cmux-touching bootstrap: if cmux is broken (rc=2 already exited),
  # skip the full sync but still enter the watch loop. drain_events / loop
  # will retry health every minute.
  if cmux_health_check_or_die; then
    # FLY-254 (Codex R2 M3): collect reopen evidence at bootstrap. When a
    # pending generation is consumable, the escalated consume REPLACES the
    # legacy bootstrap heal sweep this round (superset) and runs BEFORE the
    # first watch_loop sleep — no wasted non-escalated pass, no extra 15s.
    if watcher_begin_pass; then
      reopen_detector_check
      if reopen_pending_ready; then
        BOOTSTRAP_SKIP_HEAL_SWEEP=1 sync_additive_bootstrap
        [[ "$WATCHER_AUTHORITY_LOST" == "1" ]] || consume_pending_reopen_sweep
      else
        sync_additive_bootstrap
      fi
    fi
    watcher_finish_pass
  fi
  watch_loop
}

sync_once() {
  # FLY-129 Phase 1 (research §3.3 Option b): if a --watch process is already
  # running, --once's aggressive cleanup_stale_workspaces would race with the
  # watcher's additive create + conservative cleanup. Fail loud and direct the
  # operator to the lease-handover convergence path.
  if pgrep -f "flywheel-cmux-sync(\.sh)? +--watch" >/dev/null 2>&1; then
    echo "flywheel-cmux-sync: --watch is already running" >&2
    echo "  → use 'flywheel-cmux-sync --converge-runners --handover' for full cleanup" >&2
    return 1
  fi

  CMUX_ADDITIVE_ROUND_ID=""
  CMUX_ADOPTION_COUNT=0
  begin_cmux_additive_round \
    || log "WARN: additive round state unavailable; prepared stall counters frozen"

  cmux_attach_tmux_bin_cache_prime || :
  reconcile_roster_read_phase

  if ! prepare_linked_view_state pre; then
    log "WARN: once linked-view durable state reconciliation inconclusive; pass deferred"
    return 2
  fi

  local tmux_windows
  tmux_windows=$(get_tmux_agent_windows)

  if [[ -z "$tmux_windows" ]]; then
    # A strict view may be the watched window's sole holder after its source
    # runner retires. Preserve --once as a complete manual recovery path even
    # in that quiet topology, then apply the ordinary cleanup gates.
    self_heal_sweep_all
    reconcile_node_presence
    cleanup_stale_workspaces
    reap_unledgered_stock_workspaces
    # FLY-293: quiet state (all runners closed) → reap orphan pins here too.
    reap_orphan_workspace_pins
    return 0
  fi

  # 1. Reconcile: close workspaces with dead linked sessions (create phase will rebuild)
  reconcile_existing_workspaces

  # 2. Refresh linked sessions — fix stale current-window pointers (FLY-98).
  # Durable-state/topology uncertainty authorizes neither title migration nor
  # missing-workspace creation during this pass.
  if ! refresh_linked_sessions_tail; then
    log "WARN: once linked-view refresh inconclusive; pass deferred"
    return 2
  fi
  reconcile_workspace_titles "$tmux_windows"

  # 3. Create missing workspaces
  # FLY-129 Phase 3 (R3-1): tri-state — only act on rc=1.
  while IFS='|' read -r src_sess wid wname; do
    local _exists_rc=0
    workspace_exists_for "$wname" || _exists_rc=$?
    if [[ $_exists_rc -eq 1 ]]; then
      create_workspace_for_window "$src_sess" "$wid" "$wname"
    fi
  done < <(printf '%s\n' "$tmux_windows")

  reconcile_node_presence

  # 4. Cleanup stale (dead windows → close workspace + kill linked session)
  cleanup_stale_workspaces

  # 5. FLY-129 Phase 4 + Phase 6: ghost reap + dedup (manual full-sync mode
  #    benefits from the same hygiene the periodic watcher gives).
  reap_ghost_workspaces
  reap_unledgered_stock_workspaces
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
  local windows raw roster_titles
  windows=$(tmux list-windows -t "$FLYWHEEL_SESSION" -F "#{window_name}" 2>/dev/null || true)
  if derive_lead_roster && [[ "$LEAD_ROSTER_STATE" == "ok" ]]; then
    roster_titles=$(printf '%s\n' "$LEAD_ROSTER_ROWS" | awk -F'|' '$3 != "" { print $3 }')
    windows=$(printf '%s\n%s\n' "$windows" "$roster_titles" | sed '/^$/d' | sort -u)
  fi
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
  done < <(printf '%s\n' "$windows")
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
# FLY-1272: all shell mutators share one incarnation-bound lease. The legacy
# watcher lock directory stays the namespace so old/new processes cannot race.
MUTATOR_LEASE_NONCE=""
MUTATOR_LEASE_INCARNATION=""
MUTATOR_LEASE_MODE=""
WATCHER_AUTHORITY_LOST=0
WATCHER_AUTHORITY_FAILURE_STREAK=0
WATCHER_PASS_ACTIVE=0
WATCHER_RESYNC_REQUIRED=0
WATCHER_MAINTENANCE_STOP=0
QA_CLAIM_DEAD_SIGNATURE=""
QA_CLAIM_DEAD_OBSERVATIONS=0
OPS_CLAIM_DEAD_SIGNATURE=""
OPS_CLAIM_DEAD_OBSERVATIONS=0

_process_incarnation() {
  local pid="$1" started
  [[ -n "$pid" ]] || return 1
  # Deterministic harness seam: the managed test sandbox denies process-table
  # reads even for our own PID. Production never sets this value and therefore
  # still binds the lease to the kernel-reported process start time.
  if [[ -n "${FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE:-}" ]]; then
    printf '%s\n' "$FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE"
    return 0
  fi
  # FLY-1605: process identity must not depend on the host's current timezone.
  # This value is persisted in the mutator lease and re-read on every ledger
  # mutation, so ambient rendering would make a live owner reject itself.
  started=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)
  [[ -n "$started" ]] || return 1
  printf '%s\n' "$started"
}

_read_mutator_owner() {
  local file="$WATCHER_LOCK_DIR/owner" line fields bytes
  [[ -e "$file" || -L "$file" ]] || return 1
  [[ -f "$file" && ! -L "$file" ]] || return 2
  bytes=$(wc -c < "$file" 2>/dev/null | tr -d ' ') || return 2
  case "$bytes" in ''|*[!0-9]*) return 2 ;; esac
  (( bytes <= 4096 )) || return 2
  [[ "$(wc -l < "$file" 2>/dev/null | tr -d ' ')" == "1" ]] || return 2
  line=$(cat "$file" 2>/dev/null) || return 2
  fields=$(printf '%s\n' "$line" | awk -F'|' '{print NF}')
  [[ "$fields" == "4" ]] || return 2
  IFS='|' read -r MUTATOR_OWNER_PID MUTATOR_OWNER_INCARNATION MUTATOR_OWNER_MODE MUTATOR_OWNER_NONCE < <(printf '%s\n' "$line")
  case "$MUTATOR_OWNER_PID" in ''|*[!0-9]*) return 2 ;; esac
  case "$MUTATOR_OWNER_MODE" in watch|bootstrap|once|refresh|reaper|qa_teardown|ops_rebuild) ;; *) return 2 ;; esac
  case "$MUTATOR_OWNER_NONCE" in ''|*[!A-Za-z0-9_.-]*) return 2 ;; esac
  MUTATOR_OWNER_INCARNATION=$(printf '%s' "$MUTATOR_OWNER_INCARNATION" \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [[ -n "$MUTATOR_OWNER_INCARNATION" ]] || return 2
}

_owner_process_matches() {
  local observed
  kill -0 "$MUTATOR_OWNER_PID" 2>/dev/null || return 1
  observed=$(_process_incarnation "$MUTATOR_OWNER_PID") || return 1
  [[ "$observed" == "$MUTATOR_OWNER_INCARNATION" ]]
}

_mutator_command_matches() {
  cmux_mutator_command_matches "$@"
}

_read_qa_teardown_claim() {
  local file="$CMUX_QA_TEARDOWN_CLAIM" line fields bytes
  [[ -e "$file" || -L "$file" ]] || return 1
  [[ -f "$file" && ! -L "$file" ]] || return 2
  bytes=$(wc -c < "$file" 2>/dev/null | tr -d ' ') || return 2
  case "$bytes" in ''|*[!0-9]*) return 2 ;; esac
  (( bytes <= 4096 )) || return 2
  [[ "$(wc -l < "$file" 2>/dev/null | tr -d ' ')" == "1" ]] || return 2
  line=$(cat "$file" 2>/dev/null) || return 2
  fields=$(printf '%s\n' "$line" | awk -F'|' '{print NF}')
  [[ "$fields" == "4" ]] || return 2
  IFS='|' read -r QA_CLAIM_PID QA_CLAIM_INCARNATION QA_CLAIM_MODE QA_CLAIM_NONCE < <(printf '%s\n' "$line")
  case "$QA_CLAIM_PID" in ''|*[!0-9]*) return 2 ;; esac
  [[ "$QA_CLAIM_MODE" == "qa_teardown" ]] || return 2
  case "$QA_CLAIM_NONCE" in ''|*[!A-Za-z0-9_.-]*) return 2 ;; esac
  QA_CLAIM_INCARNATION=$(printf '%s' "$QA_CLAIM_INCARNATION" \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [[ -n "$QA_CLAIM_INCARNATION" ]] || return 2
  QA_CLAIM_LINE="$line"
}

_qa_claim_owner_matches() {
  local observed
  kill -0 "$QA_CLAIM_PID" 2>/dev/null || return 1
  observed=$(_process_incarnation "$QA_CLAIM_PID") || return 1
  [[ "$observed" == "$QA_CLAIM_INCARNATION" ]]
}

OPS_REBUILD_CLAIM_LINE=""
_read_ops_rebuild_claim() {
  local file="$CMUX_OPS_REBUILD_CLAIM" line fields bytes
  [[ -e "$file" || -L "$file" ]] || return 1
  [[ -f "$file" && ! -L "$file" ]] || return 2
  bytes=$(wc -c < "$file" 2>/dev/null | tr -d ' ') || return 2
  case "$bytes" in ''|*[!0-9]*) return 2 ;; esac
  (( bytes <= 4096 )) || return 2
  [[ "$(wc -l < "$file" 2>/dev/null | tr -d ' ')" == "1" ]] || return 2
  line=$(cat "$file" 2>/dev/null) || return 2
  fields=$(printf '%s\n' "$line" | awk -F'|' '{print NF}')
  [[ "$fields" == "4" ]] || return 2
  IFS='|' read -r OPS_CLAIM_PID OPS_CLAIM_INCARNATION OPS_CLAIM_MODE OPS_CLAIM_NONCE < <(printf '%s\n' "$line")
  case "$OPS_CLAIM_PID" in ''|*[!0-9]*) return 2 ;; esac
  [[ "$OPS_CLAIM_MODE" == "ops_rebuild" ]] || return 2
  case "$OPS_CLAIM_NONCE" in ''|*[!A-Za-z0-9_.-]*) return 2 ;; esac
  OPS_CLAIM_INCARNATION=$(printf '%s' "$OPS_CLAIM_INCARNATION" \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [[ -n "$OPS_CLAIM_INCARNATION" ]] || return 2
  OPS_CLAIM_LINE="$line"
}

_ops_claim_owner_matches() {
  local observed
  kill -0 "$OPS_CLAIM_PID" 2>/dev/null || return 1
  observed=$(_process_incarnation "$OPS_CLAIM_PID") || return 1
  [[ "$observed" == "$OPS_CLAIM_INCARNATION" ]]
}

maintenance_requested() {
  [[ -e "$CMUX_MAINTENANCE_MARKER" || -L "$CMUX_MAINTENANCE_MARKER" \
     || -e "$CMUX_QA_TEARDOWN_CLAIM" || -L "$CMUX_QA_TEARDOWN_CLAIM" \
     || -e "$CMUX_OPS_REBUILD_CLAIM" || -L "$CMUX_OPS_REBUILD_CLAIM" ]]
}

_alert_malformed_qa_teardown_claim() {
  local bytes hash signature
  bytes=$(cat "$CMUX_QA_TEARDOWN_CLAIM" 2>/dev/null || printf '<unreadable>')
  hash=$(_cmux_alert_hash "$bytes")
  signature="cmux_cleanup|qa-teardown-claim-malformed|sha256=$hash"
  log "ERROR: malformed qa_teardown claim preserved fail-closed path=$CMUX_QA_TEARDOWN_CLAIM sha256=$hash"
  _alert_cmux_cleanup \
    "cmux QA teardown claim malformed" \
    "cmux-sync parked fail-closed because $CMUX_QA_TEARDOWN_CLAIM is malformed or unsafe; sha256=$hash." \
    "$signature"
}

_alert_malformed_ops_rebuild_claim() {
  local bytes hash signature
  bytes=$(cat "$CMUX_OPS_REBUILD_CLAIM" 2>/dev/null || printf '<unreadable>')
  hash=$(_cmux_alert_hash "$bytes")
  signature="cmux_cleanup|ops-rebuild-claim-malformed|sha256=$hash"
  log "ERROR: malformed ops_rebuild claim preserved fail-closed path=$CMUX_OPS_REBUILD_CLAIM sha256=$hash"
  _alert_cmux_cleanup \
    "cmux ops rebuild claim malformed" \
    "cmux-sync parked fail-closed because $CMUX_OPS_REBUILD_CLAIM is malformed or unsafe; sha256=$hash." \
    "$signature"
}

_snapshot_live_mutator_processes() {
  # Print sorted "pid|command" rows. rc=2 means process-table truth is
  # unavailable and therefore authorizes zero lease mutation.
  # The function is normally called through command substitution. Bash keeps
  # $$ equal to the top-level shell there, while the forked child has a new PID
  # and identical argv. Build the complete descendant set rooted at $$ so that
  # census plumbing can never masquerade as an independent mutator.
  local rows pid ppid command matches="" own_tree=" $$ " changed=1
  rows=$(ps -axo pid=,ppid=,command= 2>/dev/null) || return 2
  while [[ "$changed" == "1" ]]; do
    changed=0
    while read -r pid ppid command; do
      case "$pid" in ''|*[!0-9]*) continue ;; esac
      case "$ppid" in ''|*[!0-9]*) continue ;; esac
      if [[ "$own_tree" == *" $ppid "* && "$own_tree" != *" $pid "* ]]; then
        own_tree+="$pid "
        changed=1
      fi
    done < <(printf '%s\n' "$rows")
  done
  while read -r pid ppid command; do
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    [[ "$own_tree" == *" $pid "* ]] && continue
    _mutator_command_matches "$command" || continue
    matches+="${pid}|${command}"$'\n'
  done < <(printf '%s\n' "$rows")
  printf '%s' "$matches" | sort -n
}

_process_command_for_pid() {
  cmux_process_command_for_pid "$@"
}

_bounded_candidate_pid() {
  # Read a candidate pid without trusting an unbounded/crafted stale file.
  local file="$1" kind="$2" bytes raw pid
  [[ -e "$file" ]] || return 1
  [[ -f "$file" && ! -L "$file" ]] || return 2
  bytes=$(wc -c < "$file" 2>/dev/null | tr -d ' ') || return 2
  case "$bytes" in ''|*[!0-9]*) return 2 ;; esac
  (( bytes <= 4096 )) || return 2
  raw=$(cat "$file" 2>/dev/null) || return 2
  if [[ "$kind" == "owner" ]]; then
    pid="${raw%%|*}"
  else
    [[ "$(printf '%s\n' "$raw" | wc -l | tr -d ' ')" == "1" ]] || return 2
    pid="$raw"
  fi
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$pid"
}

LEASE_REBUILD_REASON=""
_lease_maybe_crash() {
  # Hermetic crash seam for the global lease state machine. Production never
  # sets this variable; tests launch the writer in a disposable process so the
  # kernel reap mutex is released exactly as it would be after a real SIGKILL.
  [[ "${FLYWHEEL_CMUX_LEASE_CRASH_AT:-}" == "$1" ]] || return 0
  kill -KILL "$$"
  return 137
}

_classify_mutator_lease_for_rebuild() {
  # Called only while WATCHER_REAP_MUTEX is held.
  # rc=0 rebuildable; rc=1 busy; rc=2 unverifiable/fail-closed.
  local owner_rc=0 owner_pid="" legacy_pid="" candidate_rc=0
  local first_snapshot second_snapshot pid command
  LEASE_REBUILD_REASON=""
  MUTATOR_OWNER_PID=""; MUTATOR_OWNER_INCARNATION=""; MUTATOR_OWNER_MODE=""; MUTATOR_OWNER_NONCE=""
  _read_mutator_owner || owner_rc=$?
  if [[ "$owner_rc" -eq 0 ]]; then
    if _owner_process_matches; then
      LEASE_REBUILD_REASON="verified-live-owner"
      return 1
    fi
    owner_pid="$MUTATOR_OWNER_PID"
  else
    candidate_rc=0
    owner_pid=$(_bounded_candidate_pid "$WATCHER_LOCK_DIR/owner" owner) || candidate_rc=$?
    if [[ "$candidate_rc" -eq 2 ]]; then
      LEASE_REBUILD_REASON="owner-file-unreadable"
      return 2
    fi
  fi

  candidate_rc=0
  legacy_pid=$(_bounded_candidate_pid "$WATCHER_LOCK_DIR/pid" pid) || candidate_rc=$?
  if [[ "$candidate_rc" -eq 2 ]]; then
    LEASE_REBUILD_REASON="pid-file-unreadable"
    return 2
  fi

  first_snapshot=$(_snapshot_live_mutator_processes) || {
    LEASE_REBUILD_REASON="process-census-unavailable"
    return 2
  }
  second_snapshot=$(_snapshot_live_mutator_processes) || {
    LEASE_REBUILD_REASON="process-census-unavailable"
    return 2
  }
  if [[ "$first_snapshot" != "$second_snapshot" ]]; then
    LEASE_REBUILD_REASON="process-census-changed"
    return 2
  fi
  if [[ -n "$first_snapshot" ]]; then
    LEASE_REBUILD_REASON="live-mutator-census"
    return 1
  fi

  for pid in $owner_pid $legacy_pid; do
    [[ -n "$pid" && "$pid" != "$$" ]] || continue
    kill -0 "$pid" 2>/dev/null || continue
    command=$(_process_command_for_pid "$pid") || {
      LEASE_REBUILD_REASON="candidate-command-unavailable"
      return 2
    }
    if _mutator_command_matches "$command"; then
      LEASE_REBUILD_REASON="live-candidate-mutator"
      return 1
    fi
  done

  if [[ "$owner_rc" -eq 2 ]]; then
    LEASE_REBUILD_REASON="malformed-owner-no-live-mutator"
  elif [[ "$owner_rc" -eq 1 ]]; then
    LEASE_REBUILD_REASON="missing-owner-no-live-mutator"
  else
    LEASE_REBUILD_REASON="stale-owner-no-live-mutator"
  fi
  return 0
}

_create_mutator_lease_dir() {
  local mode="$1" owner_tmp pid_tmp rc=0
  mkdir "$WATCHER_LOCK_DIR" 2>/dev/null || return 1
  _lease_maybe_crash after-lease-dir-create
  MUTATOR_LEASE_MODE="$mode"
  MUTATOR_LEASE_INCARNATION=$(_process_incarnation "$$") || rc=$?
  if [[ "$rc" -ne 0 ]]; then rm -rf "$WATCHER_LOCK_DIR"; return 2; fi
  MUTATOR_LEASE_NONCE="$(date +%s)-$$-$RANDOM"
  owner_tmp="$WATCHER_LOCK_DIR/owner.tmp.$$.$RANDOM"
  pid_tmp="$WATCHER_LOCK_DIR/pid.tmp.$$.$RANDOM"
  if ! printf '%s|%s|%s|%s\n' "$$" "$MUTATOR_LEASE_INCARNATION" "$mode" "$MUTATOR_LEASE_NONCE" > "$owner_tmp" \
      || ! printf '%s\n' "$$" > "$pid_tmp" \
      || ! mv "$pid_tmp" "$WATCHER_LOCK_DIR/pid" \
      || ! mv "$owner_tmp" "$WATCHER_LOCK_DIR/owner"; then
    rm -rf "$WATCHER_LOCK_DIR"
    return 2
  fi
  _lease_maybe_crash after-owner-publication
  rc=0; _read_mutator_owner || rc=$?
  if [[ "$rc" -ne 0 || "$MUTATOR_OWNER_PID" != "$$" \
      || "$MUTATOR_OWNER_INCARNATION" != "$MUTATOR_LEASE_INCARNATION" \
      || "$MUTATOR_OWNER_MODE" != "$mode" \
      || "$MUTATOR_OWNER_NONCE" != "$MUTATOR_LEASE_NONCE" ]]; then
    rm -rf "$WATCHER_LOCK_DIR"
    return 2
  fi
  _lease_maybe_crash after-owner-readback
  return 0
}

_prune_stale_lease_quarantines() {
  # A process can die after atomically moving a conclusively stale lease out of
  # the canonical name. While the retained kernel reap mutex is held, repeat
  # the same two-snapshot no-mutator proof before removing only those exact
  # non-symlink quarantine directories. Unknown nodes remain fail-closed.
  local candidate found=0 first_snapshot second_snapshot
  for candidate in "${WATCHER_LOCK_DIR}.stale."*; do
    [[ -e "$candidate" || -L "$candidate" ]] || continue
    found=1
    [[ -d "$candidate" && ! -L "$candidate" ]] || return 2
  done
  [[ "$found" == "1" ]] || return 0
  first_snapshot=$(_snapshot_live_mutator_processes) || return 2
  second_snapshot=$(_snapshot_live_mutator_processes) || return 2
  [[ "$first_snapshot" == "$second_snapshot" ]] || return 2
  [[ -z "$first_snapshot" ]] || return 1
  for candidate in "${WATCHER_LOCK_DIR}.stale."*; do
    [[ -e "$candidate" || -L "$candidate" ]] || continue
    [[ -d "$candidate" && ! -L "$candidate" ]] || return 2
    rm -rf "$candidate" 2>/dev/null || return 2
  done
  return 0
}

# Lease reconstruction is serialized by a kernel-managed advisory lock on a
# retained file. The kernel releases it when the holder exits or crashes, so
# there is no stale-owner file to compare and unlink (and therefore no
# compare->unlink window in which one contender can delete another's claim).
# FD 9 is reserved for this short reconstruction critical section.
REAP_MUTEX_HELD=0
_acquire_reap_mutex() {
  local first_snapshot second_snapshot lock_rc=0
  mkdir -p "$(dirname "$WATCHER_REAP_MUTEX")" 2>/dev/null || return 2

  # Upgrade the only historical shape: an empty mkdir-style mutex. Its removal
  # is authorized only by the same stable, conclusive no-mutator census used to
  # rebuild the main lease. Unknown node types remain fail-closed.
  if [[ -d "$WATCHER_REAP_MUTEX" && ! -L "$WATCHER_REAP_MUTEX" ]]; then
    first_snapshot=$(_snapshot_live_mutator_processes) || return 2
    second_snapshot=$(_snapshot_live_mutator_processes) || return 2
    [[ "$first_snapshot" == "$second_snapshot" ]] || return 2
    [[ -z "$first_snapshot" ]] || return 1
    if ! rmdir "$WATCHER_REAP_MUTEX" 2>/dev/null; then
      [[ -f "$WATCHER_REAP_MUTEX" && ! -L "$WATCHER_REAP_MUTEX" ]] || return 1
    fi
  elif [[ -L "$WATCHER_REAP_MUTEX" \
      || (-e "$WATCHER_REAP_MUTEX" && ! -f "$WATCHER_REAP_MUTEX") ]]; then
    return 2
  fi

  exec 9>>"$WATCHER_REAP_MUTEX" || return 2
  if command -v lockf >/dev/null 2>&1; then
    command lockf -s -t 0 9 || lock_rc=$?
    case "$lock_rc" in
      0) ;;
      75) exec 9>&-; return 1 ;;
      *) exec 9>&-; return 2 ;;
    esac
  elif command -v flock >/dev/null 2>&1; then
    command flock -n 9 || lock_rc=$?
    case "$lock_rc" in
      0) ;;
      1) exec 9>&-; return 1 ;;
      *) exec 9>&-; return 2 ;;
    esac
  else
    exec 9>&-
    return 2
  fi
  REAP_MUTEX_HELD=1
  return 0
}

_release_reap_mutex() {
  [[ "$REAP_MUTEX_HELD" == "1" ]] || return 0
  exec 9>&- || true
  REAP_MUTEX_HELD=0
}

_lock_claim_fence_fd() {
  local fd="$1" lock_rc=0
  if command -v lockf >/dev/null 2>&1; then
    command lockf -s -t 0 "$fd" || lock_rc=$?
    case "$lock_rc" in 0) return 0 ;; 75) return 1 ;; *) return 2 ;; esac
  elif command -v flock >/dev/null 2>&1; then
    command flock -n "$fd" || lock_rc=$?
    case "$lock_rc" in 0) return 0 ;; 1) return 1 ;; *) return 2 ;; esac
  fi
  return 2
}

publish_ops_rebuild_claim() {
  local dir incarnation nonce line temp mutex_rc=0 fence_rc=0 readback
  [[ ! -e "$CMUX_MAINTENANCE_MARKER" && ! -L "$CMUX_MAINTENANCE_MARKER" \
      && ! -e "$CMUX_QA_TEARDOWN_CLAIM" && ! -L "$CMUX_QA_TEARDOWN_CLAIM" \
      && ! -e "$CMUX_OPS_REBUILD_CLAIM" && ! -L "$CMUX_OPS_REBUILD_CLAIM" ]] || return 1
  dir=$(dirname "$CMUX_OPS_REBUILD_CLAIM")
  mkdir -p "$dir" 2>/dev/null || return 1
  incarnation=$(_process_incarnation "$$") || return 1
  nonce="$(date +%s)-$$-$RANDOM"
  line="$$|${incarnation}|ops_rebuild|${nonce}"
  temp=$(mktemp "${CMUX_OPS_REBUILD_CLAIM}.tmp.XXXXXX" 2>/dev/null) || return 1
  exec 6>"$temp" || { rm -f "$temp"; return 1; }
  printf '%s\n' "$line" >&6 || { exec 6>&-; rm -f "$temp"; return 1; }
  _lock_claim_fence_fd 6 || fence_rc=$?
  if [[ "$fence_rc" -ne 0 ]]; then
    exec 6>&-; rm -f "$temp"; return 1
  fi
  _acquire_reap_mutex || mutex_rc=$?
  if [[ "$mutex_rc" -ne 0 ]]; then
    exec 6>&-; rm -f "$temp"; return 1
  fi
  if [[ -e "$CMUX_MAINTENANCE_MARKER" || -L "$CMUX_MAINTENANCE_MARKER" \
      || -e "$CMUX_QA_TEARDOWN_CLAIM" || -L "$CMUX_QA_TEARDOWN_CLAIM" \
      || -e "$CMUX_OPS_REBUILD_CLAIM" || -L "$CMUX_OPS_REBUILD_CLAIM" ]] \
      || ! ln "$temp" "$CMUX_OPS_REBUILD_CLAIM" 2>/dev/null; then
    _release_reap_mutex; exec 6>&-; rm -f "$temp"; return 1
  fi
  readback=$(cat "$CMUX_OPS_REBUILD_CLAIM" 2>/dev/null || true)
  if [[ "$readback" != "$line" ]]; then
    [[ "$(cat "$CMUX_OPS_REBUILD_CLAIM" 2>/dev/null || true)" == "$line" ]] \
      && rm -f "$CMUX_OPS_REBUILD_CLAIM" 2>/dev/null || true
    _release_reap_mutex; exec 6>&-; rm -f "$temp"; return 1
  fi
  rm -f "$temp"
  OPS_REBUILD_CLAIM_LINE="$line"
  _release_reap_mutex
  log "[audit] ops_rebuild handover claim published pid=$$ path=$CMUX_OPS_REBUILD_CLAIM"
}

release_ops_rebuild_claim() {
  local observed
  if [[ -n "$OPS_REBUILD_CLAIM_LINE" ]]; then
    observed=$(cat "$CMUX_OPS_REBUILD_CLAIM" 2>/dev/null || true)
    if [[ "$observed" == "$OPS_REBUILD_CLAIM_LINE" ]]; then
      rm -f "$CMUX_OPS_REBUILD_CLAIM" 2>/dev/null \
        || log "WARN: unable to remove owned ops_rebuild claim at $CMUX_OPS_REBUILD_CLAIM"
    fi
  fi
  exec 6>&- 2>/dev/null || true
  OPS_REBUILD_CLAIM_LINE=""
}

_reap_stale_qa_teardown_claim() {
  local mutex_rc=0 claim_rc=0 fence_rc=0 signature observed
  [[ -e "$CMUX_QA_TEARDOWN_CLAIM" || -L "$CMUX_QA_TEARDOWN_CLAIM" ]] || {
    QA_CLAIM_DEAD_SIGNATURE=""
    QA_CLAIM_DEAD_OBSERVATIONS=0
    return 0
  }
  _acquire_reap_mutex || mutex_rc=$?
  if [[ "$mutex_rc" -ne 0 ]]; then
    [[ "$mutex_rc" -eq 2 ]] \
      && log "ERROR: qa_teardown claim reap mutex unavailable; claim preserved fail-closed"
    return "$mutex_rc"
  fi
  _read_qa_teardown_claim || claim_rc=$?
  if [[ "$claim_rc" -ne 0 ]]; then
    _release_reap_mutex
    _alert_malformed_qa_teardown_claim
    return 2
  fi
  if _qa_claim_owner_matches; then
    QA_CLAIM_DEAD_SIGNATURE=""
    QA_CLAIM_DEAD_OBSERVATIONS=0
    _release_reap_mutex
    return 1
  fi
  signature=$(_cmux_alert_hash "$QA_CLAIM_LINE")
  if [[ "$QA_CLAIM_DEAD_SIGNATURE" != "$signature" ]]; then
    QA_CLAIM_DEAD_SIGNATURE="$signature"
    QA_CLAIM_DEAD_OBSERVATIONS=1
    _release_reap_mutex
    return 1
  fi
  QA_CLAIM_DEAD_OBSERVATIONS=$((QA_CLAIM_DEAD_OBSERVATIONS + 1))
  if (( QA_CLAIM_DEAD_OBSERVATIONS < 2 )); then
    _release_reap_mutex
    return 1
  fi
  # Read-only open is deliberate: unlike <>, it cannot recreate a claim that
  # disappeared between classification and the fence probe.
  exec 7<"$CMUX_QA_TEARDOWN_CLAIM" || {
    _release_reap_mutex
    return 1
  }
  _lock_claim_fence_fd 7 || fence_rc=$?
  if [[ "$fence_rc" -ne 0 ]]; then
    exec 7>&-
    _release_reap_mutex
    [[ "$fence_rc" -eq 2 ]] \
      && log "ERROR: qa_teardown claim activity fence unavailable; claim preserved fail-closed"
    return "$fence_rc"
  fi
  observed=$(cat "$CMUX_QA_TEARDOWN_CLAIM" 2>/dev/null || true)
  if [[ "$observed" != "$QA_CLAIM_LINE" ]] \
      || ! rm -f "$CMUX_QA_TEARDOWN_CLAIM" 2>/dev/null; then
    exec 7>&-
    _release_reap_mutex
    return 1
  fi
  exec 7>&-
  _release_reap_mutex
  log "[audit] reaped dead qa_teardown claim pid=$QA_CLAIM_PID path=$CMUX_QA_TEARDOWN_CLAIM"
  QA_CLAIM_DEAD_SIGNATURE=""
  QA_CLAIM_DEAD_OBSERVATIONS=0
}

_reap_stale_ops_rebuild_claim() {
  local mutex_rc=0 claim_rc=0 fence_rc=0 signature observed
  [[ -e "$CMUX_OPS_REBUILD_CLAIM" || -L "$CMUX_OPS_REBUILD_CLAIM" ]] || {
    OPS_CLAIM_DEAD_SIGNATURE=""
    OPS_CLAIM_DEAD_OBSERVATIONS=0
    return 0
  }
  _acquire_reap_mutex || mutex_rc=$?
  if [[ "$mutex_rc" -ne 0 ]]; then
    [[ "$mutex_rc" -eq 2 ]] \
      && log "ERROR: ops_rebuild claim reap mutex unavailable; claim preserved fail-closed"
    return "$mutex_rc"
  fi
  _read_ops_rebuild_claim || claim_rc=$?
  if [[ "$claim_rc" -ne 0 ]]; then
    _release_reap_mutex
    _alert_malformed_ops_rebuild_claim
    return 2
  fi
  if _ops_claim_owner_matches; then
    OPS_CLAIM_DEAD_SIGNATURE=""
    OPS_CLAIM_DEAD_OBSERVATIONS=0
    _release_reap_mutex
    return 1
  fi
  signature=$(_cmux_alert_hash "$OPS_CLAIM_LINE")
  if [[ "$OPS_CLAIM_DEAD_SIGNATURE" != "$signature" ]]; then
    OPS_CLAIM_DEAD_SIGNATURE="$signature"
    OPS_CLAIM_DEAD_OBSERVATIONS=1
    _release_reap_mutex
    return 1
  fi
  OPS_CLAIM_DEAD_OBSERVATIONS=$((OPS_CLAIM_DEAD_OBSERVATIONS + 1))
  if (( OPS_CLAIM_DEAD_OBSERVATIONS < 2 )); then
    _release_reap_mutex
    return 1
  fi
  exec 7<"$CMUX_OPS_REBUILD_CLAIM" || { _release_reap_mutex; return 1; }
  _lock_claim_fence_fd 7 || fence_rc=$?
  if [[ "$fence_rc" -ne 0 ]]; then
    exec 7>&-; _release_reap_mutex
    [[ "$fence_rc" -eq 2 ]] \
      && log "ERROR: ops_rebuild claim activity fence unavailable; claim preserved fail-closed"
    return "$fence_rc"
  fi
  observed=$(cat "$CMUX_OPS_REBUILD_CLAIM" 2>/dev/null || true)
  if [[ "$observed" != "$OPS_CLAIM_LINE" ]] \
      || ! rm -f "$CMUX_OPS_REBUILD_CLAIM" 2>/dev/null; then
    exec 7>&-; _release_reap_mutex; return 1
  fi
  exec 7>&-
  _release_reap_mutex
  log "[audit] reaped dead ops_rebuild claim pid=$OPS_CLAIM_PID path=$CMUX_OPS_REBUILD_CLAIM"
  OPS_CLAIM_DEAD_SIGNATURE=""
  OPS_CLAIM_DEAD_OBSERVATIONS=0
}

acquire_mutator_lease() {
  local mode="$1" read_rc=0 attempt=0 class_rc=0 create_rc=0
  local quarantine="" rebuild_reason="" had_old=0 restore_rc=0 prune_rc=0
  case "$mode" in watch|bootstrap|once|refresh|reaper|qa_teardown|ops_rebuild) ;; *) return 2 ;; esac
  while (( attempt < 3 )); do
    attempt=$((attempt + 1))
    if [[ -L "$WATCHER_LOCK_DIR" \
        || (-e "$WATCHER_LOCK_DIR" && ! -d "$WATCHER_LOCK_DIR") ]]; then
      log "WARN: mutator lease path is not a directory; refusing mutation path=$WATCHER_LOCK_DIR"
      return 2
    fi
    if [[ -d "$WATCHER_LOCK_DIR" ]]; then
      read_rc=0; _read_mutator_owner || read_rc=$?
      if [[ $read_rc -eq 0 ]] && _owner_process_matches; then return 1; fi
    fi
    class_rc=0
    _acquire_reap_mutex || class_rc=$?
    if [[ "$class_rc" -eq 0 ]]; then
      prune_rc=0; _prune_stale_lease_quarantines || prune_rc=$?
      if [[ "$prune_rc" -ne 0 ]]; then
        _release_reap_mutex
        [[ "$prune_rc" -eq 1 ]] && return 1
        return 2
      fi
      had_old=0; quarantine=""; rebuild_reason=""
      if [[ -L "$WATCHER_LOCK_DIR" \
          || (-e "$WATCHER_LOCK_DIR" && ! -d "$WATCHER_LOCK_DIR") ]]; then
        log "WARN: mutator lease path changed to a non-directory; refusing mutation path=$WATCHER_LOCK_DIR"
        _release_reap_mutex
        return 2
      fi
      if [[ -d "$WATCHER_LOCK_DIR" ]]; then
        class_rc=0; _classify_mutator_lease_for_rebuild || class_rc=$?
        if [[ "$class_rc" -eq 1 ]]; then
          _release_reap_mutex
          return 1
        fi
        if [[ "$class_rc" -eq 2 ]]; then
          log "WARN: mutator lease unverifiable; refusing rebuild reason=${LEASE_REBUILD_REASON:-unknown} path=$WATCHER_LOCK_DIR"
          _release_reap_mutex
          return 2
        fi
        rebuild_reason="$LEASE_REBUILD_REASON"
        quarantine="${WATCHER_LOCK_DIR}.stale.$$.$RANDOM"
        if [[ -e "$quarantine" ]] || ! mv "$WATCHER_LOCK_DIR" "$quarantine" 2>/dev/null; then
          _release_reap_mutex
          return 2
        fi
        had_old=1
        _lease_maybe_crash after-quarantine-rename
      fi
      create_rc=0; _create_mutator_lease_dir "$mode" || create_rc=$?
      if [[ "$create_rc" -eq 0 ]]; then
        if [[ "$had_old" -eq 1 ]]; then
          rm -rf "$quarantine" 2>/dev/null || true
          log "[audit] rebuilt stale/unverifiable mutator lease reason=$rebuild_reason path=$WATCHER_LOCK_DIR"
        fi
        _release_reap_mutex
        return 0
      fi
      # A failed mkdir can mean another actor published the path. Never delete
      # that path. Restore our quarantined stale lease only when the canonical
      # name is conclusively absent; otherwise preserve the quarantine for
      # diagnosis instead of overwriting newer state.
      restore_rc=0
      if [[ "$had_old" -eq 1 && -d "$quarantine" && ! -L "$quarantine" ]]; then
        if [[ ! -e "$WATCHER_LOCK_DIR" && ! -L "$WATCHER_LOCK_DIR" ]]; then
          mv "$quarantine" "$WATCHER_LOCK_DIR" 2>/dev/null || restore_rc=$?
        else
          restore_rc=1
          log "WARN: failed lease rebuild left stale lease quarantined path=$quarantine canonical=$WATCHER_LOCK_DIR"
        fi
      fi
      _release_reap_mutex
      [[ "$create_rc" -eq 2 || "$restore_rc" -ne 0 ]] && return 2
    elif [[ "$class_rc" -eq 2 ]]; then
      return 2
    fi
    sleep 1
  done
  return 1
}

mutator_lease_owned_by_self() {
  local rc=0
  _read_mutator_owner || rc=$?
  [[ $rc -eq 0 && "$MUTATOR_OWNER_PID" == "$$" \
     && "$MUTATOR_OWNER_INCARNATION" == "$MUTATOR_LEASE_INCARNATION" \
     && "$MUTATOR_OWNER_MODE" == "$MUTATOR_LEASE_MODE" \
     && "$MUTATOR_OWNER_NONCE" == "$MUTATOR_LEASE_NONCE" ]] || return 1
  _owner_process_matches
}

mark_watcher_authority_lost() {
  local context="${1:-unknown}"
  [[ "$MUTATOR_LEASE_MODE" == "watch" && "$WATCHER_PASS_ACTIVE" == "1" ]] || return 0
  if [[ "$WATCHER_AUTHORITY_LOST" != "1" ]]; then
    WATCHER_AUTHORITY_LOST=1
    log "ERROR: watcher mutator authority lost during $context; aborting remaining pass mutation"
  fi
}

watcher_mutation_latch_clear() {
  [[ "${WATCHER_AUTHORITY_LOST:-0}" != "1" ]] || return 1
  if [[ "$MUTATOR_LEASE_MODE" == "watch" && "$WATCHER_PASS_ACTIVE" == "1" ]] \
      && maintenance_requested; then
    WATCHER_AUTHORITY_LOST=1
    WATCHER_MAINTENANCE_STOP=1
    log "maintenance requested during watcher pass; aborting remaining mutation at safe boundary"
    return 1
  fi
  return 0
}

assert_or_reuse_owned_lease() {
  if mutator_lease_owned_by_self; then
    return 0
  fi
  mark_watcher_authority_lost lease-verification
  return 1
}

release_mutator_lease() {
  if mutator_lease_owned_by_self; then
    rm -rf "$WATCHER_LOCK_DIR" 2>/dev/null || true
  fi
}

watcher_begin_pass() {
  WATCHER_PASS_ACTIVE=1
  WATCHER_AUTHORITY_LOST=0
  WATCHER_MAINTENANCE_STOP=0
  if mutator_lease_owned_by_self; then
    return 0
  fi
  mark_watcher_authority_lost pass-start
  return 1
}

watcher_finish_pass() {
  WATCHER_PASS_ACTIVE=0
  if [[ "$WATCHER_MAINTENANCE_STOP" == 1 ]]; then
    WATCHER_MAINTENANCE_STOP=0
    mutator_lease_owned_by_self && WATCHER_AUTHORITY_LOST=0
  fi
  if [[ "$WATCHER_AUTHORITY_LOST" == "1" ]]; then
    WATCHER_AUTHORITY_FAILURE_STREAK=$((WATCHER_AUTHORITY_FAILURE_STREAK + 1))
    log "ERROR: watcher lease verification failed for pass (${WATCHER_AUTHORITY_FAILURE_STREAK}/3)"
    if (( WATCHER_AUTHORITY_FAILURE_STREAK >= 3 )); then
      _alert_cmux_cleanup \
        "cmux watcher lost mutator authority" \
        "The watcher failed its owned-lease verification for 3 consecutive passes and is exiting for supervised replacement." \
        "cmux_cleanup|watcher-authority-lost|pid=$$"
      log "FATAL: watcher mutator authority failed 3 consecutive passes; exiting for supervisor recovery"
      release_mutator_lease
      exit 1
    fi
  else
    WATCHER_AUTHORITY_FAILURE_STREAK=0
  fi
  if [[ "$MUTATOR_LEASE_MODE" == "watch" ]] && maintenance_requested; then
    watcher_maintenance_checkpoint
    return $?
  fi
}

probe_mutator_lease() {
  local polls="${FLYWHEEL_CMUX_PROBE_POLLS:-40}" wait_s="${FLYWHEEL_CMUX_PROBE_WAIT:-1}" rc=0
  case "$polls" in ''|*[!0-9]*) polls=40 ;; esac
  while [[ -d "$WATCHER_LOCK_DIR" ]]; do
    rc=0; _read_mutator_owner || rc=$?
    [[ $rc -eq 0 ]] || return 2
    _owner_process_matches || return 2
    (( polls > 0 )) || return 1
    sleep "$wait_s"
    polls=$((polls - 1))
  done
}

_maintenance_poll_seconds() {
  local value="${FLYWHEEL_CMUX_MAINTENANCE_POLL_SECONDS:-1}"
  case "$value" in ''|*[!0-9]*) value=1 ;; esac
  (( value < 1 )) && value=1
  printf '%s\n' "$value"
}

# FLY-1944 watcher liveness evidence. Keep the hot-path write to Bash builtins
# only (printf + redirection): no fork tax is added to every scan. The rider
# uses file mtime for age and content only for operator diagnostics.
WATCHER_MAINTENANCE_HEARTBEAT_POLLS=0
watcher_write_heartbeat() {
  local sequence="${1:-unknown}" state="${2:-scan}"
  printf '%s|%s|%s\n' "$$" "$sequence" "$state" > "$WATCHER_HEARTBEAT_FILE" 2>/dev/null || true
}

watcher_maintenance_heartbeat_tick() {
  WATCHER_MAINTENANCE_HEARTBEAT_POLLS=$((WATCHER_MAINTENANCE_HEARTBEAT_POLLS + 1))
  if (( WATCHER_MAINTENANCE_HEARTBEAT_POLLS >= 15 )); then
    WATCHER_MAINTENANCE_HEARTBEAT_POLLS=0
    watcher_write_heartbeat maintenance park
  fi
}

maintenance_entry_allowed() {
  local mode="$1" logged=0 wait_s claim_rc=0
  wait_s=$(_maintenance_poll_seconds)
  if [[ "$mode" == "watch" ]]; then
    [[ -e "$CMUX_MAINTENANCE_MARKER" || -L "$CMUX_MAINTENANCE_MARKER" ]] || return 0
  elif [[ "$mode" == "ops_rebuild" ]]; then
    if [[ ! -e "$CMUX_MAINTENANCE_MARKER" && ! -L "$CMUX_MAINTENANCE_MARKER" \
        && ! -e "$CMUX_QA_TEARDOWN_CLAIM" && ! -L "$CMUX_QA_TEARDOWN_CLAIM" \
        && ! -e "$CMUX_OPS_REBUILD_CLAIM" && ! -L "$CMUX_OPS_REBUILD_CLAIM" ]]; then
      return 0
    fi
    [[ ! -e "$CMUX_MAINTENANCE_MARKER" && ! -L "$CMUX_MAINTENANCE_MARKER" \
        && ! -e "$CMUX_QA_TEARDOWN_CLAIM" && ! -L "$CMUX_QA_TEARDOWN_CLAIM" ]] || return 1
    _read_ops_rebuild_claim || claim_rc=$?
    [[ "$claim_rc" -eq 0 && -n "$OPS_REBUILD_CLAIM_LINE" \
        && "$OPS_CLAIM_LINE" == "$OPS_REBUILD_CLAIM_LINE" \
        && "$OPS_CLAIM_PID" == "$$" ]] || return 1
    _ops_claim_owner_matches
    return $?
  else
    maintenance_requested || return 0
  fi
  if [[ "$mode" == "watch" && "${FLYWHEEL_CMUX_SUPERVISED:-0}" == "1" ]]; then
    while [[ -e "$CMUX_MAINTENANCE_MARKER" || -L "$CMUX_MAINTENANCE_MARKER" ]]; do
      if [[ "$logged" == "0" ]]; then
        log "maintenance marker present; supervised watcher waiting without lease"
        logged=1
      fi
      sleep "$wait_s"
    done
    log "maintenance marker cleared; supervised watcher resuming"
    return 0
  fi
  log "maintenance marker present; $mode mutator not started"
  return 1
}

watcher_maintenance_checkpoint() {
  # Keep one operational cadence and one default for both maintenance entry
  # and the yielded/parked watcher state. One second preserves the stale-claim
  # two-observation recovery bound (~2s) while teardown has a 60s handoff budget.
  local poll_s release_logged=0
  poll_s=$(_maintenance_poll_seconds)
  while maintenance_requested; do
    watcher_maintenance_heartbeat_tick
    if mutator_lease_owned_by_self; then
      [[ "$release_logged" == "1" ]] || log "maintenance requested; watcher yielding mutator lease"
      release_logged=1
      release_mutator_lease
      if mutator_lease_owned_by_self; then
        _alert_cmux_cleanup \
          "cmux watcher could not yield mutator lease" \
          "The watcher remains holding its verified lease while maintenance is requested; all watcher mutation is paused and release will be retried." \
          "cmux_cleanup|watcher-yield-failed|pid=$$"
        sleep "$poll_s"
        continue
      fi
      WATCHER_RESYNC_REQUIRED=1
    fi
    if [[ -e "$CMUX_QA_TEARDOWN_CLAIM" || -L "$CMUX_QA_TEARDOWN_CLAIM" ]]; then
      _reap_stale_qa_teardown_claim || true
    fi
    if [[ -e "$CMUX_OPS_REBUILD_CLAIM" || -L "$CMUX_OPS_REBUILD_CLAIM" ]]; then
      _reap_stale_ops_rebuild_claim || true
    fi
    maintenance_requested && sleep "$poll_s"
  done
  if ! mutator_lease_owned_by_self; then
    acquire_watcher_lock
  fi
  # A claim can appear between reacquisition and this read. Never bootstrap
  # through that window: immediately yield again and repeat.
  if maintenance_requested; then
    watcher_maintenance_checkpoint
    return $?
  fi
  [[ "$release_logged" == "1" ]] && log "maintenance cleared; watcher reacquired mutator lease"
  return 0
}

run_mutator_once() {
  local mode="$1" fn="$2" strict="${3:-best-effort}" rc=0 lease_rc=0 owner_pid owner_mode
  acquire_mutator_lease "$mode" || lease_rc=$?
  if [[ "$lease_rc" -ne 0 ]]; then
    owner_pid="${MUTATOR_OWNER_PID:-unknown}"
    owner_mode="${MUTATOR_OWNER_MODE:-unknown}"
    if [[ "$lease_rc" -eq 1 ]]; then
      log "$mode mutator already running (owner pid=$owner_pid mode=$owner_mode); skipping"
    else
      log "$mode mutator lease MALFORMED at $WATCHER_LOCK_DIR; manual inspection required; skipping"
      _alert_malformed_mutator_lease
    fi
    if [[ "$strict" == strict ]]; then
      log "ERROR: no cleanup ran; use 'flywheel-cmux-sync --converge-runners --handover' for full cleanup"
      return "$lease_rc"
    fi
    return 0
  fi
  trap release_mutator_lease EXIT
  trap 'release_mutator_lease; exit 130' INT
  trap 'release_mutator_lease; exit 143' TERM
  if ! maintenance_entry_allowed "$mode"; then
    release_mutator_lease
    trap - EXIT INT TERM
    if [[ "$strict" == strict ]]; then
      log "ERROR: no cleanup ran; use 'flywheel-cmux-sync --converge-runners --handover' for full cleanup"
      return 1
    fi
    return 0
  fi
  "$fn" || rc=$?
  release_mutator_lease
  trap - EXIT INT TERM
  return $rc
}

# FLY-177: true if PID's command looks like a `flywheel-cmux-sync --watch`,
# or if FLY-1272's externally-verifiable lease proves it is any live mutator.
# Guards the supervised block-wait against PID reuse: a recycled PID belonging
# to some unrelated process must NOT make a launchd watcher wait forever — it is
# treated as a stale lock and reaped instead.
_pid_is_watcher() {
  local pid="$1" cmd
  [[ -z "$pid" ]] && return 1
  local owner_rc=0
  _read_mutator_owner || owner_rc=$?
  if [[ $owner_rc -eq 0 && "$MUTATOR_OWNER_PID" == "$pid" ]] && _owner_process_matches; then
    return 0
  fi
  cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
  [[ "$cmd" == *flywheel-cmux-sync* && "$cmd" == *--watch* ]]
}

# FLY-825: bootout is not guaranteed synchronous — the old watcher process can
# outlive its launchd job record (production repro: pid 64108, no longer
# tracked by `launchctl list`, still alive + still the lock owner hours after
# a same-label bootout/bootstrap cycle). Poll for `flywheel-cmux-sync --watch`
# process(es) to actually disappear before the caller (flywheel-cmux-install.sh)
# bootstraps a fresh instance, so a new launchd-tracked instance never has to
# coexist with a not-fully-dead predecessor. Bounded ~5s before an explicit,
# PID-targeted TERM-then-KILL (never a broad `pkill`), followed by a bounded
# conclusive-absence read-back. Every PID killed is logged for audit. Exposed
# as its own function (not inlined in the install
# script, which has no BASH_SOURCE guard and top-level side effects) so it is
# covered by this file's existing bash-3.2 `source`-based test harness.
_watcher_process_pids() {
  cmux_watcher_process_pids "$@"
}

wait_for_watcher_exit() {
  local half_seconds=0 pids pid pids_rc=0 confirm_polls confirm_interval confirm_i
  confirm_polls="${FLYWHEEL_CMUX_EXIT_CONFIRM_POLLS:-10}"
  confirm_interval="${FLYWHEEL_CMUX_EXIT_CONFIRM_INTERVAL:-0.1}"
  case "$confirm_polls" in ''|*[!0-9]*) confirm_polls=10 ;; esac
  (( confirm_polls >= 1 && confirm_polls <= 100 )) || confirm_polls=10
  [[ "$confirm_interval" =~ ^([0-9]+([.][0-9]+)?|[.][0-9]+)$ ]] || confirm_interval=0.1
  while true; do
    pids_rc=0; pids=$(_watcher_process_pids) || pids_rc=$?
    [[ "$pids_rc" -eq 1 ]] && return 0
    if [[ "$pids_rc" -ne 0 ]]; then
      log "ERROR: wait_for_watcher_exit: process census unavailable"
      return 2
    fi
    if (( half_seconds >= 10 )); then
      log "wait_for_watcher_exit: still alive after 5s, escalating to TERM: $pids"
      for pid in $pids; do
        log "wait_for_watcher_exit: TERM pid=$pid"
        kill -TERM "$pid" 2>/dev/null || true
      done
      sleep 1
      pids_rc=0; pids=$(_watcher_process_pids) || pids_rc=$?
      [[ "$pids_rc" -eq 1 ]] && return 0
      [[ "$pids_rc" -eq 0 ]] || return 2
      for pid in $pids; do
        log "wait_for_watcher_exit: KILL pid=$pid (survived TERM)"
        kill -KILL "$pid" 2>/dev/null || true
      done
      # Signal delivery is not proof of death. Conclusively observe absence
      # before a caller is allowed to bootstrap a replacement watcher.
      for ((confirm_i = 1; confirm_i <= confirm_polls; confirm_i++)); do
        pids_rc=0; pids=$(_watcher_process_pids) || pids_rc=$?
        [[ "$pids_rc" -eq 1 ]] && return 0
        if [[ "$pids_rc" -eq 2 ]]; then
          log "ERROR: wait_for_watcher_exit: post-KILL process census unavailable"
          return 2
        fi
        (( confirm_i < confirm_polls )) && sleep "$confirm_interval"
      done
      log "ERROR: wait_for_watcher_exit: watcher survived TERM/KILL: $pids"
      return 1
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
  # Every format, including legacy pid-only directories, goes through the same
  # tri-state census/rebuild state machine. A missing/malformed pid can no
  # longer bypass live-mutator discovery and create a second writer.
  local lease_rc=0
  while true; do
    lease_rc=0
    acquire_mutator_lease watch || lease_rc=$?
    if [[ "$lease_rc" -eq 0 ]]; then
      trap release_watcher_lock EXIT
      trap 'release_watcher_lock; exit 130' INT
      trap 'release_watcher_lock; exit 143' TERM
      return 0
    fi
    if [[ "$supervised" == "1" ]]; then
      if [[ "$lease_rc" -eq 1 ]]; then
        log "supervised: cmux mutator already running (owner pid=${MUTATOR_OWNER_PID:-unknown} mode=${MUTATOR_OWNER_MODE:-unknown}), waiting ${SUPERVISED_WAIT_SECONDS}s"
      else
        log "supervised: cmux mutator lease unverifiable at $WATCHER_LOCK_DIR, waiting ${SUPERVISED_WAIT_SECONDS}s"
        _alert_malformed_mutator_lease
      fi
      sleep "$SUPERVISED_WAIT_SECONDS"
      continue
    fi
    if [[ "$lease_rc" -eq 1 ]]; then
      log "cmux mutator already running (owner pid=${MUTATOR_OWNER_PID:-unknown} mode=${MUTATOR_OWNER_MODE:-unknown}), exiting"
    else
      log "cmux mutator lease unverifiable at $WATCHER_LOCK_DIR; manual inspection required; exiting"
      _alert_malformed_mutator_lease
    fi
    exit 0
  done
}

release_watcher_lock() {
  # PID equality alone is not ownership after reuse. The generalized release
  # requires the exact pid + incarnation + nonce written by this process.
  release_mutator_lease
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
    maintenance_entry_allowed watch || exit 0
    acquire_watcher_lock
    # A QA claim intentionally does not block cold-start acquisition: once the
    # lease is held, this checkpoint can safely reap a stale claim or yield to
    # a live teardown before watch_main performs any side effect.
    watcher_maintenance_checkpoint
    CMUX_WATCH_HEARTBEAT_ACTIVE=1
    # FLY-129: full --watch body lives in watch_main() so it can use `local`
    # and so health-check gating can wrap cmux ops cleanly.
    watch_main
    ;;
  --refresh)
    # FLY-98: tmux-only repair — safe to call from outside cmux
    run_mutator_once refresh refresh_linked_sessions
    ;;
  --wait-for-watcher-exit)
    # FLY-825: called by flywheel-cmux-install.sh between bootout and
    # bootstrap. Safe from outside cmux (no cmux socket needed — pure
    # tmux/process-table operation, same tier as --refresh).
    wait_for_watcher_exit
    ;;
  --once|"")
    run_mutator_once once sync_once strict
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
    run_mutator_once reaper reap_orphan_pins_oneshot strict
    ;;
  --converge-runners)
    shift
    run_converge_runners "$@"
    ;;
  --rebuild-views)
    shift
    run_rebuild_views "$@"
    ;;
  --verify-sidebar)
    shift
    run_verify_sidebar "$@"
    ;;
  --probe-lease)
    # Read-only migration gate: absent passes; a live owner waits within the
    # configured budget; malformed/stale-present state fails closed and is
    # never stolen or removed.
    probe_mutator_lease
    ;;
  *)
    echo "Usage: flywheel-cmux-sync [--once|--watch|--refresh|--probe-lease|--wait-for-watcher-exit|--list-lead-refs|--list-orphan-pins|--reap-orphan-pins|--converge-runners|--rebuild-views|--verify-sidebar]"
    echo "  --once              Full sync with aggressive cleanup; fails if another mutator is active."
    echo "  --watch             Event-signaled polling (hooks + 15s drain + 60s additive). From inside cmux."
    echo "  --refresh           tmux-only linked session repair. Safe from anywhere."
    echo "  --probe-lease       Read-only maintenance gate for the shared mutator lease."
    echo "  --wait-for-watcher-exit  FLY-825: poll+kill any lingering --watch process (install-script helper)."
    echo "  --list-lead-refs    Print Lead cmux workspace refs (Phase 8 Path A)."
    echo "  --list-orphan-pins  FLY-293: print orphan runner cmux pins (read-only preview)."
    echo "  --reap-orphan-pins  FLY-293: close orphan pins; fails if another mutator is active."
    echo "  --converge-runners  FLY-2048: full runner cleanup; requires --handover."
    echo "  --rebuild-views     FLY-1596: audited rebuild; requires --all-leads or repeated --target T[=workspace:N]."
    echo "                      Add --execute to mutate; add --handover to make the resident watcher yield."
    echo "  --verify-sidebar    FLY-1596: read-only terminal-state judge; accepts repeated --target T and --json."
    exit 1
    ;;
esac

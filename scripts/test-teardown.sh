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
TEARDOWN_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/qa-multilead.sh
source "${TEARDOWN_SCRIPT_DIR}/lib/qa-multilead.sh"
# shellcheck source=lib/qa-launchd-lead.sh
source "${TEARDOWN_SCRIPT_DIR}/lib/qa-launchd-lead.sh"
# shellcheck source=lib/qa-generalized.sh
source "${TEARDOWN_SCRIPT_DIR}/lib/qa-generalized.sh"
# shellcheck source=lib/runner-workspace-trust.sh
source "${TEARDOWN_SCRIPT_DIR}/lib/runner-workspace-trust.sh"
_CMUX_PROCESS_CENSUS_LIB="${TEARDOWN_SCRIPT_DIR}/lib/cmux-mutator-process-census.sh"
if [[ ! -r "$_CMUX_PROCESS_CENSUS_LIB" ]]; then
  log "ERROR: required cmux process census library unavailable"
  return 1 2>/dev/null || exit 1
fi
# shellcheck source=lib/cmux-mutator-process-census.sh
if ! source "$_CMUX_PROCESS_CENSUS_LIB"; then
  log "ERROR: required cmux process census library unavailable"
  return 1 2>/dev/null || exit 1
fi
unset _CMUX_PROCESS_CENSUS_LIB

# FLY-1272: test teardown is a full cmux/tmux mutator. It participates in the
# same incarnation-bound lease as the watcher and one-shots, and holds that
# lease through every process, tmux, worktree, and slot mutation below.
CMUX_MUTATOR_LOCK_DIR="${FLYWHEEL_CMUX_WATCHER_LOCK_DIR:-/tmp/flywheel-cmux-watcher.lock}"
CMUX_MUTATOR_REAP_MUTEX="${CMUX_MUTATOR_LOCK_DIR}.reap"
CMUX_MAINTENANCE_MARKER="${FLYWHEEL_CMUX_MAINTENANCE_MARKER:-$HOME/.flywheel/state/cmux-maintenance}"
CMUX_QA_TEARDOWN_CLAIM="${CMUX_MAINTENANCE_MARKER}.qa-teardown"
CMUX_OPS_REBUILD_CLAIM="${CMUX_MAINTENANCE_MARKER}.ops-rebuild"
CMUX_VIEW_WAL_DIR="${FLYWHEEL_CMUX_VIEW_WAL_DIR:-$HOME/.flywheel/state/cmux-view-wal}"
CMUX_LEASE_NONCE=""
CMUX_LEASE_INCARNATION=""
CMUX_REAP_MUTEX_HELD=0
CMUX_CLAIM_HELD=0
CMUX_CLAIM_LINE=""
CMUX_CLAIM_TEMP=""

cmux_process_incarnation() {
  local pid="$1" started
  [[ -n "$pid" ]] || return 1
  if [[ -n "${FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE:-}" ]]; then
    printf '%s\n' "$FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE"
    return 0
  fi
  started=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)
  [[ -n "$started" ]] || return 1
  printf '%s\n' "$started"
}

read_cmux_mutator_owner() {
  local file="$CMUX_MUTATOR_LOCK_DIR/owner" line fields bytes
  [[ -e "$file" || -L "$file" ]] || return 1
  [[ -f "$file" && ! -L "$file" ]] || return 2
  bytes=$(wc -c < "$file" 2>/dev/null | tr -d ' ') || return 2
  case "$bytes" in ''|*[!0-9]*) return 2 ;; esac
  (( bytes <= 4096 )) || return 2
  [[ "$(wc -l < "$file" 2>/dev/null | tr -d ' ')" == "1" ]] || return 2
  line=$(cat "$file" 2>/dev/null) || return 2
  fields=$(printf '%s\n' "$line" | awk -F'|' '{print NF}')
  [[ "$fields" == "4" ]] || return 2
  IFS='|' read -r CMUX_OWNER_PID CMUX_OWNER_INCARNATION CMUX_OWNER_MODE CMUX_OWNER_NONCE <<< "$line"
  case "$CMUX_OWNER_PID" in ''|*[!0-9]*) return 2 ;; esac
  case "$CMUX_OWNER_MODE" in watch|bootstrap|once|refresh|reaper|qa_teardown|ops_rebuild) ;; *) return 2 ;; esac
  case "$CMUX_OWNER_NONCE" in ''|*[!A-Za-z0-9_.-]*) return 2 ;; esac
  CMUX_OWNER_INCARNATION=$(printf '%s' "$CMUX_OWNER_INCARNATION" \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [[ -n "$CMUX_OWNER_INCARNATION" ]] || return 2
}

cmux_owner_process_matches() {
  local observed
  kill -0 "$CMUX_OWNER_PID" 2>/dev/null || return 1
  observed=$(cmux_process_incarnation "$CMUX_OWNER_PID") || return 1
  [[ "$observed" == "$CMUX_OWNER_INCARNATION" ]]
}

cmux_snapshot_live_mutator_processes() {
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
    done <<< "$rows"
  done
  while read -r pid ppid command; do
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    [[ "$own_tree" == *" $pid "* ]] && continue
    cmux_mutator_command_matches "$command" || continue
    matches+="${pid}|${command}"$'\n'
  done <<< "$rows"
  printf '%s' "$matches" | sort -n
}

cmux_bounded_candidate_pid() {
  local file="$1" kind="$2" bytes raw pid
  [[ -e "$file" || -L "$file" ]] || return 1
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

cmux_acquire_reap_mutex() {
  local first_snapshot second_snapshot lock_rc=0
  mkdir -p "$(dirname "$CMUX_MUTATOR_REAP_MUTEX")" 2>/dev/null || return 2
  if [[ -d "$CMUX_MUTATOR_REAP_MUTEX" && ! -L "$CMUX_MUTATOR_REAP_MUTEX" ]]; then
    first_snapshot=$(cmux_snapshot_live_mutator_processes) || return 2
    second_snapshot=$(cmux_snapshot_live_mutator_processes) || return 2
    [[ "$first_snapshot" == "$second_snapshot" ]] || return 2
    [[ -z "$first_snapshot" ]] || return 1
    if ! rmdir "$CMUX_MUTATOR_REAP_MUTEX" 2>/dev/null; then
      [[ -f "$CMUX_MUTATOR_REAP_MUTEX" && ! -L "$CMUX_MUTATOR_REAP_MUTEX" ]] || return 1
    fi
  elif [[ -L "$CMUX_MUTATOR_REAP_MUTEX" \
      || (-e "$CMUX_MUTATOR_REAP_MUTEX" && ! -f "$CMUX_MUTATOR_REAP_MUTEX") ]]; then
    return 2
  fi
  exec 9>>"$CMUX_MUTATOR_REAP_MUTEX" || return 2
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
  CMUX_REAP_MUTEX_HELD=1
}

cmux_release_reap_mutex() {
  [[ "$CMUX_REAP_MUTEX_HELD" == "1" ]] || return 0
  exec 9>&- || true
  CMUX_REAP_MUTEX_HELD=0
}

cmux_prune_stale_lease_quarantines() {
  local candidate found=0 first_snapshot second_snapshot
  for candidate in "${CMUX_MUTATOR_LOCK_DIR}.stale."*; do
    [[ -e "$candidate" || -L "$candidate" ]] || continue
    found=1
    [[ -d "$candidate" && ! -L "$candidate" ]] || return 2
  done
  [[ "$found" == "1" ]] || return 0
  first_snapshot=$(cmux_snapshot_live_mutator_processes) || return 2
  second_snapshot=$(cmux_snapshot_live_mutator_processes) || return 2
  [[ "$first_snapshot" == "$second_snapshot" ]] || return 2
  [[ -z "$first_snapshot" ]] || return 1
  for candidate in "${CMUX_MUTATOR_LOCK_DIR}.stale."*; do
    [[ -e "$candidate" || -L "$candidate" ]] || continue
    [[ -d "$candidate" && ! -L "$candidate" ]] || return 2
    rm -rf "$candidate" 2>/dev/null || return 2
  done
}

CMUX_LEASE_REBUILD_REASON=""
cmux_classify_lease_for_rebuild() {
  local owner_rc=0 owner_pid="" legacy_pid="" candidate_rc=0
  local first_snapshot second_snapshot pid command
  CMUX_LEASE_REBUILD_REASON=""
  read_cmux_mutator_owner || owner_rc=$?
  if [[ "$owner_rc" -eq 0 ]]; then
    if cmux_owner_process_matches; then
      CMUX_LEASE_REBUILD_REASON="verified-live-owner"
      return 1
    fi
    owner_pid="$CMUX_OWNER_PID"
  else
    candidate_rc=0
    owner_pid=$(cmux_bounded_candidate_pid "$CMUX_MUTATOR_LOCK_DIR/owner" owner) || candidate_rc=$?
    if [[ "$candidate_rc" -eq 2 ]]; then
      CMUX_LEASE_REBUILD_REASON="owner-file-unreadable"
      return 2
    fi
  fi
  candidate_rc=0
  legacy_pid=$(cmux_bounded_candidate_pid "$CMUX_MUTATOR_LOCK_DIR/pid" pid) || candidate_rc=$?
  if [[ "$candidate_rc" -eq 2 ]]; then
    CMUX_LEASE_REBUILD_REASON="pid-file-unreadable"
    return 2
  fi
  first_snapshot=$(cmux_snapshot_live_mutator_processes) || {
    CMUX_LEASE_REBUILD_REASON="process-census-unavailable"; return 2;
  }
  second_snapshot=$(cmux_snapshot_live_mutator_processes) || {
    CMUX_LEASE_REBUILD_REASON="process-census-unavailable"; return 2;
  }
  if [[ "$first_snapshot" != "$second_snapshot" ]]; then
    CMUX_LEASE_REBUILD_REASON="process-census-changed"
    return 2
  fi
  if [[ -n "$first_snapshot" ]]; then
    CMUX_LEASE_REBUILD_REASON="live-mutator-census"
    return 1
  fi
  for pid in $owner_pid $legacy_pid; do
    [[ -n "$pid" && "$pid" != "$$" ]] || continue
    kill -0 "$pid" 2>/dev/null || continue
    command=$(cmux_process_command_for_pid "$pid") || {
      CMUX_LEASE_REBUILD_REASON="candidate-command-unavailable"; return 2;
    }
    if cmux_mutator_command_matches "$command"; then
      CMUX_LEASE_REBUILD_REASON="live-candidate-mutator"
      return 1
    fi
  done
  case "$owner_rc" in
    2) CMUX_LEASE_REBUILD_REASON="malformed-owner-no-live-mutator" ;;
    1) CMUX_LEASE_REBUILD_REASON="missing-owner-no-live-mutator" ;;
    *) CMUX_LEASE_REBUILD_REASON="stale-owner-no-live-mutator" ;;
  esac
}

cmux_create_teardown_lease_dir() {
  local owner_tmp pid_tmp rc=0
  mkdir "$CMUX_MUTATOR_LOCK_DIR" 2>/dev/null || return 1
  CMUX_LEASE_INCARNATION=$(cmux_process_incarnation "$$") || rc=$?
  if [[ "$rc" -ne 0 ]]; then rm -rf "$CMUX_MUTATOR_LOCK_DIR"; return 2; fi
  CMUX_LEASE_NONCE="$(date +%s)-$$-$RANDOM"
  owner_tmp="$CMUX_MUTATOR_LOCK_DIR/owner.tmp.$$.$RANDOM"
  pid_tmp="$CMUX_MUTATOR_LOCK_DIR/pid.tmp.$$.$RANDOM"
  if ! printf '%s|%s|qa_teardown|%s\n' "$$" "$CMUX_LEASE_INCARNATION" "$CMUX_LEASE_NONCE" > "$owner_tmp" \
      || ! printf '%s\n' "$$" > "$pid_tmp" \
      || ! mv "$pid_tmp" "$CMUX_MUTATOR_LOCK_DIR/pid" \
      || ! mv "$owner_tmp" "$CMUX_MUTATOR_LOCK_DIR/owner"; then
    rm -rf "$CMUX_MUTATOR_LOCK_DIR"
    return 2
  fi
  rc=0; read_cmux_mutator_owner || rc=$?
  if [[ "$rc" -ne 0 || "$CMUX_OWNER_PID" != "$$" \
      || "$CMUX_OWNER_INCARNATION" != "$CMUX_LEASE_INCARNATION" \
      || "$CMUX_OWNER_MODE" != "qa_teardown" \
      || "$CMUX_OWNER_NONCE" != "$CMUX_LEASE_NONCE" ]]; then
    rm -rf "$CMUX_MUTATOR_LOCK_DIR"
    return 2
  fi
}

acquire_cmux_teardown_lease_once() {
  local read_rc=0 mutex_rc=0 prune_rc=0 class_rc=0 create_rc=0
  local quarantine="" rebuild_reason="" had_old=0 restore_rc=0
  if [[ -L "$CMUX_MUTATOR_LOCK_DIR" \
      || (-e "$CMUX_MUTATOR_LOCK_DIR" && ! -d "$CMUX_MUTATOR_LOCK_DIR") ]]; then
    return 2
  fi
  if [[ -d "$CMUX_MUTATOR_LOCK_DIR" ]]; then
    read_cmux_mutator_owner || read_rc=$?
    if [[ "$read_rc" -eq 0 ]] && cmux_owner_process_matches; then return 1; fi
  fi
  cmux_acquire_reap_mutex || mutex_rc=$?
  [[ "$mutex_rc" -eq 0 ]] || return "$mutex_rc"
  cmux_prune_stale_lease_quarantines || prune_rc=$?
  if [[ "$prune_rc" -ne 0 ]]; then
    cmux_release_reap_mutex
    return "$prune_rc"
  fi
  if [[ -L "$CMUX_MUTATOR_LOCK_DIR" \
      || (-e "$CMUX_MUTATOR_LOCK_DIR" && ! -d "$CMUX_MUTATOR_LOCK_DIR") ]]; then
    cmux_release_reap_mutex
    return 2
  fi
  if [[ -d "$CMUX_MUTATOR_LOCK_DIR" ]]; then
    cmux_classify_lease_for_rebuild || class_rc=$?
    if [[ "$class_rc" -ne 0 ]]; then
      cmux_release_reap_mutex
      return "$class_rc"
    fi
    rebuild_reason="$CMUX_LEASE_REBUILD_REASON"
    quarantine="${CMUX_MUTATOR_LOCK_DIR}.stale.$$.$RANDOM"
    if [[ -e "$quarantine" || -L "$quarantine" ]] \
        || ! mv "$CMUX_MUTATOR_LOCK_DIR" "$quarantine" 2>/dev/null; then
      cmux_release_reap_mutex
      return 2
    fi
    had_old=1
  fi
  cmux_create_teardown_lease_dir || create_rc=$?
  if [[ "$create_rc" -eq 0 ]]; then
    if [[ "$had_old" -eq 1 ]]; then
      rm -rf "$quarantine" 2>/dev/null || true
      log "[audit] rebuilt stale/unverifiable mutator lease reason=$rebuild_reason path=$CMUX_MUTATOR_LOCK_DIR"
    fi
    cmux_release_reap_mutex
    return 0
  fi
  if [[ "$had_old" -eq 1 && -d "$quarantine" && ! -L "$quarantine" ]]; then
    if [[ ! -e "$CMUX_MUTATOR_LOCK_DIR" && ! -L "$CMUX_MUTATOR_LOCK_DIR" ]]; then
      mv "$quarantine" "$CMUX_MUTATOR_LOCK_DIR" 2>/dev/null || restore_rc=$?
    else
      restore_rc=1
    fi
  fi
  cmux_release_reap_mutex
  [[ "$create_rc" -eq 2 || "$restore_rc" -ne 0 ]] && return 2
  return 1
}

acquire_cmux_teardown_lease() {
  local wait_s="${FLYWHEEL_QA_TEARDOWN_LEASE_WAIT_S:-60}" start now rc=0 last_rc=0
  case "$wait_s" in ''|*[!0-9]*) wait_s=60 ;; esac
  (( wait_s > 3600 )) && wait_s=3600
  start=$(date +%s)
  while true; do
    rc=0; acquire_cmux_teardown_lease_once || rc=$?
    [[ "$rc" -eq 0 ]] && return 0
    last_rc="$rc"
    now=$(date +%s)
    if (( now - start >= wait_s )); then
      if [[ "$last_rc" -eq 2 ]]; then
        log "ERROR: cmux mutator lease remained unverifiable for ${wait_s}s; refusing teardown"
        return 1
      fi
      log "ERROR: timed out after ${wait_s}s waiting for cmux mutator lease (owner mode=${CMUX_OWNER_MODE:-unknown} pid=${CMUX_OWNER_PID:-unknown})"
      return 1
    fi
    sleep 1
  done
}

# FLY-1775 pit 11: an entire lease wait can lose a handoff race even though a
# fresh attempt succeeds immediately. Retry one complete acquisition budget;
# never loop indefinitely or let teardown mutate anything without the lease.
acquire_cmux_teardown_lease_with_retry() {
  if acquire_cmux_teardown_lease; then
    return 0
  fi
  log "WARN: cmux mutator lease acquisition timed out; retrying once after the handoff settles"
  sleep 1
  if acquire_cmux_teardown_lease; then
    return 0
  fi
  log "ERROR: cmux mutator lease failed twice; rerun teardown after the watcher/maintenance handoff settles"
  return 1
}

cmux_teardown_lease_owned_by_self() {
  local read_rc=0
  read_cmux_mutator_owner || read_rc=$?
  [[ "$read_rc" -eq 0 && "$CMUX_OWNER_PID" == "$$" \
      && "$CMUX_OWNER_INCARNATION" == "$CMUX_LEASE_INCARNATION" \
      && "$CMUX_OWNER_MODE" == "qa_teardown" \
      && "$CMUX_OWNER_NONCE" == "$CMUX_LEASE_NONCE" ]] || return 1
  cmux_owner_process_matches
}

release_cmux_teardown_lease() {
  if cmux_teardown_lease_owned_by_self; then
    rm -rf "$CMUX_MUTATOR_LOCK_DIR" 2>/dev/null || true
  fi
}

read_cmux_qa_teardown_claim() {
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
  IFS='|' read -r CMUX_CLAIM_PID CMUX_CLAIM_INCARNATION CMUX_CLAIM_MODE CMUX_CLAIM_NONCE <<< "$line"
  case "$CMUX_CLAIM_PID" in ''|*[!0-9]*) return 2 ;; esac
  [[ "$CMUX_CLAIM_MODE" == "qa_teardown" ]] || return 2
  case "$CMUX_CLAIM_NONCE" in ''|*[!A-Za-z0-9_.-]*) return 2 ;; esac
  CMUX_CLAIM_INCARNATION=$(printf '%s' "$CMUX_CLAIM_INCARNATION" \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [[ -n "$CMUX_CLAIM_INCARNATION" ]] || return 2
  CMUX_CLAIM_LINE="$line"
}

cmux_claim_owner_matches() {
  local observed
  kill -0 "$CMUX_CLAIM_PID" 2>/dev/null || return 1
  observed=$(cmux_process_incarnation "$CMUX_CLAIM_PID") || return 1
  [[ "$observed" == "$CMUX_CLAIM_INCARNATION" ]]
}

cmux_lock_claim_fence_fd() {
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

acquire_cmux_qa_teardown_claim() {
  local dir incarnation nonce line temp mutex_rc=0 claim_rc=0 fence_rc=0 readback=""
  [[ ! -e "$CMUX_MAINTENANCE_MARKER" && ! -L "$CMUX_MAINTENANCE_MARKER" ]] || {
    log "ERROR: cmux maintenance marker present at ${CMUX_MAINTENANCE_MARKER}; refusing teardown"
    return 1
  }
  [[ ! -e "$CMUX_OPS_REBUILD_CLAIM" && ! -L "$CMUX_OPS_REBUILD_CLAIM" ]] || {
    log "ERROR: cmux ops_rebuild claim present at ${CMUX_OPS_REBUILD_CLAIM}; refusing teardown"
    return 1
  }
  dir=$(dirname "$CMUX_QA_TEARDOWN_CLAIM")
  mkdir -p "$dir" 2>/dev/null || return 1
  incarnation=$(cmux_process_incarnation "$$") || return 1
  nonce="$(date +%s)-$$-$RANDOM"
  line="$$|${incarnation}|qa_teardown|${nonce}"
  temp=$(mktemp "${CMUX_QA_TEARDOWN_CLAIM}.tmp.XXXXXX" 2>/dev/null) || return 1
  exec 8>"$temp" || { rm -f "$temp"; return 1; }
  if ! printf '%s\n' "$line" >&8; then
    exec 8>&-; rm -f "$temp"; return 1
  fi
  cmux_lock_claim_fence_fd 8 || fence_rc=$?
  if [[ "$fence_rc" -ne 0 ]]; then
    exec 8>&-; rm -f "$temp"
    log "ERROR: unable to establish qa_teardown activity fence"
    return 1
  fi
  cmux_acquire_reap_mutex || mutex_rc=$?
  if [[ "$mutex_rc" -ne 0 ]]; then
    exec 8>&-; rm -f "$temp"
    log "ERROR: cmux mutator lease transition is busy; refusing teardown"
    return 1
  fi
  if [[ -e "$CMUX_QA_TEARDOWN_CLAIM" || -L "$CMUX_QA_TEARDOWN_CLAIM" ]]; then
    read_cmux_qa_teardown_claim || claim_rc=$?
    if [[ "$claim_rc" -ne 0 ]]; then
      cmux_release_reap_mutex; exec 8>&-; rm -f "$temp"
      log "ERROR: existing qa_teardown claim is malformed; refusing teardown"
      return 1
    fi
    if cmux_claim_owner_matches; then
      cmux_release_reap_mutex; exec 8>&-; rm -f "$temp"
      log "ERROR: qa_teardown claim is held by live pid=${CMUX_CLAIM_PID}; refusing teardown"
      return 1
    fi
    exec 7<"$CMUX_QA_TEARDOWN_CLAIM" || {
      cmux_release_reap_mutex; exec 8>&-; rm -f "$temp"; return 1;
    }
    fence_rc=0; cmux_lock_claim_fence_fd 7 || fence_rc=$?
    if [[ "$fence_rc" -ne 0 ]]; then
      exec 7>&-; cmux_release_reap_mutex; exec 8>&-; rm -f "$temp"
      log "ERROR: stale-looking qa_teardown claim still has active work; refusing takeover"
      return 1
    fi
    readback=$(cat "$CMUX_QA_TEARDOWN_CLAIM" 2>/dev/null || true)
    if [[ "$readback" != "$CMUX_CLAIM_LINE" ]] || ! rm -f "$CMUX_QA_TEARDOWN_CLAIM" 2>/dev/null; then
      exec 7>&-; cmux_release_reap_mutex; exec 8>&-; rm -f "$temp"
      return 1
    fi
    exec 7>&-
  fi
  if [[ -e "$CMUX_OPS_REBUILD_CLAIM" || -L "$CMUX_OPS_REBUILD_CLAIM" ]]; then
    cmux_release_reap_mutex; exec 8>&-; rm -f "$temp"
    log "ERROR: cmux ops_rebuild claim appeared during QA claim publication; refusing teardown"
    return 1
  fi
  if ! ln "$temp" "$CMUX_QA_TEARDOWN_CLAIM" 2>/dev/null; then
    cmux_release_reap_mutex; exec 8>&-; rm -f "$temp"
    return 1
  fi
  readback=$(cat "$CMUX_QA_TEARDOWN_CLAIM" 2>/dev/null || true)
  if [[ "$readback" != "$line" ]]; then
    [[ "$(cat "$CMUX_QA_TEARDOWN_CLAIM" 2>/dev/null || true)" == "$line" ]] \
      && rm -f "$CMUX_QA_TEARDOWN_CLAIM" 2>/dev/null || true
    cmux_release_reap_mutex; exec 8>&-; rm -f "$temp"
    return 1
  fi
  rm -f "$temp"
  CMUX_CLAIM_TEMP=""
  CMUX_CLAIM_LINE="$line"
  CMUX_CLAIM_HELD=1
  cmux_release_reap_mutex
  log "qa_teardown yield claim published; waiting for watcher lease handoff"
}

release_cmux_qa_teardown_claim() {
  local mutex_rc=0 observed=""
  [[ "$CMUX_CLAIM_HELD" == "1" ]] || { exec 8>&- 2>/dev/null || true; return 0; }
  cmux_acquire_reap_mutex || mutex_rc=$?
  if [[ "$mutex_rc" -eq 0 ]]; then
    observed=$(cat "$CMUX_QA_TEARDOWN_CLAIM" 2>/dev/null || true)
    if [[ "$observed" == "$CMUX_CLAIM_LINE" ]]; then
      rm -f "$CMUX_QA_TEARDOWN_CLAIM" 2>/dev/null || \
        log "WARN: unable to remove owned qa_teardown claim at $CMUX_QA_TEARDOWN_CLAIM"
    fi
    cmux_release_reap_mutex
  else
    log "WARN: unable to enter claim-release mutex; stale claim will be reaped after the activity fence closes"
  fi
  exec 8>&- 2>/dev/null || true
  CMUX_CLAIM_HELD=0
}

release_cmux_teardown_resources() {
  release_cmux_teardown_lease
  release_cmux_qa_teardown_claim
}

cmux_tmux_generation() {
  if [[ -n "${FLYWHEEL_CMUX_TMUX_GENERATION:-}" ]]; then
    printf '%s\n' "$FLYWHEEL_CMUX_TMUX_GENERATION"
    return 0
  fi
  local pid socket started
  pid=$(tmux display-message -p '#{pid}' 2>/dev/null) || return 1
  socket=$(tmux display-message -p '#{socket_path}' 2>/dev/null) || return 1
  [[ -n "$pid" && -n "$socket" ]] || return 1
  started=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)
  [[ -n "$started" ]] || return 1
  printf '%s|%s|%s\n' "$socket" "$pid" "$started"
}

wal_authorizes_stage_for_slot() {
  local stage="$1" source="$2" generation file line fields
  local version wal_generation state nonce view wal_source wid stage_sid placeholder observed_sid
  generation=$(cmux_tmux_generation) || return 1
  [[ -d "$CMUX_VIEW_WAL_DIR" ]] || return 1
  for file in "$CMUX_VIEW_WAL_DIR"/*.wal; do
    [[ -f "$file" ]] || continue
    [[ "$(wc -l < "$file" 2>/dev/null | tr -d ' ')" == "1" ]] || continue
    line=$(cat "$file" 2>/dev/null) || continue
    fields=$(printf '%s\n' "$line" | awk -F'|' '{print NF}')
    [[ "$fields" == "9" ]] || continue
    IFS='|' read -r version wal_generation state nonce view wal_source wid stage_sid placeholder <<< "$line"
    [[ "$version" == "v1" && "$wal_generation" == "$generation" \
       && "$wal_source" == "$source" && "$stage" == "fwstage-${nonce}" \
       && -n "$stage_sid" ]] || continue
    case "$state" in created|link_intent|linked|claim_intent) ;; *) continue ;; esac
    observed_sid=$(tmux list-sessions -F '#{session_id}' \
      -f "#{==:#{session_name},${stage}}" 2>/dev/null | head -1 || true)
    [[ -n "$observed_sid" && "$observed_sid" == "$stage_sid" ]] && return 0
  done
  return 1
}

# FLY-1961: use the same env-aware lock resolver + stale bare-lock protocol as
# every production/test writer. This keeps scratch FLYWHEEL_CLAUDE_JSON paths
# off the founder's real HOME and preserves cross-process exclusion.
acquire_claude_lock() {
  local claude_json="${FLYWHEEL_CLAUDE_JSON:-${HOME}/.claude.json}"
  local lock="${FLYWHEEL_CLAUDE_JSON_LOCK:-${claude_json}.lock}"
  runner_workspace_trust_acquire_lock "$lock" "Claude JSON"
}

release_claude_lock() {
  local claude_json="${FLYWHEEL_CLAUDE_JSON:-${HOME}/.claude.json}"
  local lock="${FLYWHEEL_CLAUDE_JSON_LOCK:-${claude_json}.lock}"
  runner_workspace_trust_release_lock "$lock" || true
}

# FLY-115 fix: Remove ~/.claude.json trust entries whose keys live under the
# given prefix. Best-effort; never aborts teardown under `set -e`. Atomic write
# via same-dir tempfile (POSIX rename(2) atomicity) so no partial JSON on crash.
prune_trust_entries() {
  local PREFIX="$1"
  local CLAUDE_JSON="${FLYWHEEL_CLAUDE_JSON:-${HOME}/.claude.json}"
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
  local TMP MODE
  if ! TMP=$(mktemp "${CLAUDE_JSON}.XXXXXX"); then
    release_claude_lock
    return 0
  fi
  MODE=$(runner_workspace_trust_file_mode "$CLAUDE_JSON" 600) || MODE=600

  if jq --arg prefix "$CANON" \
    '.projects = ((.projects // {}) | with_entries(select((.key | startswith($prefix)) | not)))' \
    "$CLAUDE_JSON" > "$TMP" 2>/dev/null \
    && jq -e . "$TMP" >/dev/null 2>&1; then
    chmod "$MODE" "$TMP" 2>/dev/null || true
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
  local SLOT_TMUX_SOCKET="${SLOT_DIR}/tmux-$(id -u)/default"
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

  # A signal cannot stop a KeepAlive service; launchd would immediately pull
  # it back up. Boot out every slot-owned label before any legacy PID/socket
  # cleanup. Missing registry remains compatible with pre-FLY-1663 slots.
  qa_launchd_stop_registry "${SLOT_DIR}/launchd-leads.json" \
    || { log "ERROR: failed to bootout one or more slot launchd Leads"; return 1; }

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
  if tmux -S "$SLOT_TMUX_SOCKET" has-session -t "$RUNNER_TMUX" 2>/dev/null; then
    log "Killing Runner tmux session: ${RUNNER_TMUX}"
    tmux -S "$SLOT_TMUX_SOCKET" kill-session -t "$RUNNER_TMUX" 2>/dev/null || true
  fi

  # Unified display-session sweep. New isolated views and keepers persist the
  # exact source session in @flywheel_cmux_owner; legacy grouped views fall
  # back to their session_group. A foreign owner is foreign even when dead —
  # teardown never turns liveness into ownership. Stages without an owner are
  # accepted only by a current-generation WAL row plus exact session_id.
  # Decision table:
  #   owner == RUNNER_TMUX            → ours         → kill
  #   owner is a live sibling session → still in use → skip
  #   owner/group names another slot  → foreign      → skip (live or dead)
  #   stage owner empty + WAL proof   → ours         → kill
  #   ownership unprovable            → skip (fail-closed)
  #
  # Exact-match querying: `list-sessions -f '#{==:#{session_name},<s>}'`
  # is used instead of `display-message -t "=<s>"` because the latter
  # returns empty on macOS tmux when the target has no `:window` suffix,
  # and bare `-t <s>` risks prefix matching a differently-named session.
  local cmux_s owner group
  while IFS= read -r cmux_s || [[ -n "$cmux_s" ]]; do
    [[ -z "$cmux_s" ]] && continue
    owner=$(tmux show-options -v -t "=${cmux_s}:" @flywheel_cmux_owner 2>/dev/null | head -1 || true)
    group=$(tmux list-sessions -F '#{session_group}' \
      -f "#{==:#{session_name},${cmux_s}}" 2>/dev/null | head -1 || echo "")
    if [[ -n "$owner" ]]; then
      if [[ "$owner" != "$RUNNER_TMUX" ]]; then
        log "Skip display session ${cmux_s} — foreign owner '${owner}'"
        continue
      fi
    elif [[ -n "$group" ]]; then
      if [[ "$group" != "$RUNNER_TMUX" ]]; then
        log "Skip grouped display session ${cmux_s} — foreign group '${group}'"
        continue
      fi
    elif [[ "$cmux_s" == fwstage-* ]]; then
      if ! wal_authorizes_stage_for_slot "$cmux_s" "$RUNNER_TMUX"; then
        log "Skip stage ${cmux_s} — no current-generation ownership proof"
        continue
      fi
    else
      log "Skip display session ${cmux_s} — ownership unprovable"
      continue
    fi
    log "Killing owned display session: ${cmux_s} (owner=${owner:-${group:-wal}})"
    tmux kill-session -t "=${cmux_s}" 2>/dev/null || true
  done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null \
    | grep -E '^(cmux-|fwkeeper-|fwstage-)' || true)

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
  # The QA materializer/wrapper owns ~/.flywheel/manifests/<project>-<lead>.json.
  # test-teardown must remove it so stale test-slot manifests do not accumulate.
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

  # FLY-1999: test-deploy binds its Bridge and runners to this native per-slot
  # default socket. Retire that server after the Bridge is down; never sweep by
  # name on the resident default server.
  if tmux -S "$SLOT_TMUX_SOCKET" has-session 2>/dev/null; then
    log "Killing slot tmux server: ${SLOT_TMUX_SOCKET}"
    tmux -S "$SLOT_TMUX_SOCKET" kill-server 2>/dev/null || true
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

  # FLY-1775: the deterministic Codex app-server stub is a Bridge child but not
  # a tmux child. The Bridge supervises its workflow actors, so reaping the stub
  # before shutting down Lead/Bridge creates a restart race and can orphan the
  # replacement under launchd. Break the supervision chain first, then reap by
  # exact stub argv plus a live socket derived from this slot's executions.
  if [[ -n "$CANONICAL_SLOT_DIR" && "$CANONICAL_SLOT_DIR" != "/" ]]; then
    qa_generalized_reap_codex_stub_orphans "$CANONICAL_SLOT_DIR"

    # FLY-2174: a real codex-tmux app-server is detached from Bridge and can
    # survive Bridge's bounded shutdown. Reuse claude-runner's hardened
    # ledger + live socket-holder proof to reap only this slot's process
    # groups. Unknown/residual live sockets retain the slot and its lock;
    # deleting their ledger/socket roots would destroy the only safe proof.
    if ! node "${TEARDOWN_SCRIPT_DIR}/lib/qa-reap-codex-slot-daemons.mjs" \
      "$SLOT_DIR"; then
      log "ERROR: slot-owned Codex daemon teardown is unverified; retaining slot ${SLOT}"
      return 1
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
  if ! prune_codex_workspace_trust_prefix "/tmp/flywheel-test-slot-${SLOT}"; then
    log "WARN: Codex trust prune failed; managed entries retained for inspection"
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
test_teardown_main() {
  local target="${1:?Usage: test-teardown.sh <slot-number | all>}"

  # The migration marker remains foreign, read-only authority. QA publishes a
  # separate owner-bound claim so a live watcher can yield without teardown
  # ever replacing or deleting the migration marker.
  if [[ -e "$CMUX_MAINTENANCE_MARKER" || -L "$CMUX_MAINTENANCE_MARKER" ]]; then
    log "ERROR: cmux maintenance marker present at ${CMUX_MAINTENANCE_MARKER}; refusing whole teardown"
    return 1
  fi
  if [[ -e "$CMUX_OPS_REBUILD_CLAIM" || -L "$CMUX_OPS_REBUILD_CLAIM" ]]; then
    log "ERROR: cmux ops_rebuild claim present at ${CMUX_OPS_REBUILD_CLAIM}; refusing whole teardown"
    return 1
  fi
  if ! acquire_cmux_qa_teardown_claim; then
    log "ERROR: unable to publish qa_teardown yield claim; no teardown action taken"
    return 1
  fi
  trap release_cmux_teardown_resources EXIT
  trap 'release_cmux_teardown_resources; exit 130' INT
  trap 'release_cmux_teardown_resources; exit 143' TERM

  if ! acquire_cmux_teardown_lease_with_retry; then
    log "ERROR: unable to acquire qa_teardown mutator lease; no teardown action taken"
    return 1
  fi

  # Recheck after lease handoff: a foreign migration can begin while teardown
  # waits. In that case release both owned resources and mutate nothing.
  if [[ -e "$CMUX_MAINTENANCE_MARKER" || -L "$CMUX_MAINTENANCE_MARKER" \
      || -e "$CMUX_OPS_REBUILD_CLAIM" || -L "$CMUX_OPS_REBUILD_CLAIM" ]]; then
    log "ERROR: foreign cmux maintenance authority appeared after QA handoff; refusing whole teardown"
    return 1
  fi

  if [[ "$target" == "all" ]]; then
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
    teardown_slot "$target"
  fi
}

# Source-safe seam for lock/claim contract tests.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0 2>/dev/null || true
fi

test_teardown_main "$@"

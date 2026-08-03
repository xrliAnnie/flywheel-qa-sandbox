#!/bin/bash
# FLY-1507: launchd/carrier authority and fleet-candidate lifecycle helpers.
# Source-only; bash 3.2 safe; installs no traps or shell options.

lead_restart_launchctl_print() {
  launchctl print "$1" 2>&1
}

lead_restart_launchd_probe() {
  # stdout: loaded<TAB>pid | unloaded | error
  local target="$1" out="" rc=0 pid=""
  out="$(lead_restart_launchctl_print "$target")" || rc=$?
  if [ "$rc" -eq 0 ]; then
    pid="$(printf '%s\n' "$out" | grep -m1 'pid =' | awk '{print $NF}' || true)"
    case "$pid" in ''|*[!0-9]*) pid=0 ;; esac
    printf 'loaded\t%s\n' "$pid"
    return 0
  fi
  if printf '%s\n' "$out" | grep -qiE 'could not find service|no such process'; then
    printf 'unloaded\n'
    return 0
  fi
  printf 'error\n'
  return 0
}

lead_restart_file_digest() {
  local path="$1"
  [ -f "$path" ] && [ ! -L "$path" ] || return 1
  shasum -a 256 "$path" 2>/dev/null | awk '{print $1}'
}

lead_restart_process_start_identity() {
  LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

lead_restart_process_alive() {
  kill -0 "$1" 2>/dev/null
}

lead_restart_process_table() {
  LC_ALL=C ps -axo pid=,command= 2>/dev/null
}

LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON=""

_lead_restart_file_mode() {
  local value
  if value="$(stat -c %a "$1" 2>/dev/null)"; then
    printf '%s\n' "$value"
    return 0
  fi
  stat -f %Lp "$1" 2>/dev/null
}

_lead_restart_file_inode() {
  local value
  if value="$(stat -c %i "$1" 2>/dev/null)"; then
    printf '%s\n' "$value"
    return 0
  fi
  stat -f %i "$1" 2>/dev/null
}

# The full restart owns ~/.flywheel/restart.lock.d before calling this helper.
# Wait for the scheduler's subordinate signal-only mutex. A live exact
# PID+lstart owner is never deleted; a dead/mismatched exact owner may be
# reclaimed with an identity recheck. Malformed evidence fails closed.
lead_restart_wait_scheduler_mutation() {
  local lock_dir="$1" timeout="${2:-15}"
  local deadline now owner_file raw fields pid lstart created actual
  local before_inode after_raw after_inode
  LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON=""
  case "$timeout" in ''|*[!0-9]*)
    LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON="timeout_invalid"
    return 2
    ;;
  esac
  deadline=$(( $(date +%s) + timeout ))

  while [ -e "$lock_dir" ] || [ -L "$lock_dir" ]; do
    if [ ! -d "$lock_dir" ] || [ -L "$lock_dir" ] \
      || [ "$(_lead_restart_file_mode "$lock_dir")" != 700 ]; then
      LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON="lock_not_real_directory"
      return 2
    fi
    owner_file="${lock_dir}/owner.json"
    if [ ! -e "$owner_file" ] && [ ! -L "$owner_file" ]; then
      now="$(date +%s)"
      if [ "$now" -ge "$deadline" ]; then
        LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON="owner_missing_timeout"
        return 1
      fi
      sleep 0.1
      continue
    fi
    if [ ! -f "$owner_file" ] || [ -L "$owner_file" ] \
      || [ "$(_lead_restart_file_mode "$owner_file")" != "600" ]; then
      LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON="owner_malformed"
      return 2
    fi
    raw="$(cat "$owner_file" 2>/dev/null)" || {
      LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON="owner_unreadable"
      return 2
    }
    fields="$(printf '%s' "$raw" | jq -er '
      select(type == "object" and (keys == ["created_at","pid","pid_lstart"]))
      | select(.pid | type == "number" and floor == . and . > 0)
      | select(.pid_lstart | type == "string" and length > 0 and . == gsub("^[[:space:]]+|[[:space:]]+$"; ""))
      | select(.created_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"))
      | [.pid, .pid_lstart, .created_at] | @tsv
    ' 2>/dev/null)" || {
      LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON="owner_malformed"
      return 2
    }
    pid="${fields%%$'\t'*}"
    fields="${fields#*$'\t'}"
    lstart="${fields%%$'\t'*}"
    created="${fields#*$'\t'}"
    [ -n "$created" ] || {
      LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON="owner_malformed"
      return 2
    }
    actual="$(lead_restart_process_start_identity "$pid" 2>/dev/null || true)"
    if [ "$actual" != "$lstart" ]; then
      before_inode="$(_lead_restart_file_inode "$owner_file")" || {
        LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON="owner_recheck_failed"
        return 2
      }
      after_raw="$(cat "$owner_file" 2>/dev/null)" || {
        LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON="owner_recheck_failed"
        return 2
      }
      after_inode="$(_lead_restart_file_inode "$owner_file")" || {
        LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON="owner_recheck_failed"
        return 2
      }
      if [ "$after_raw" != "$raw" ] || [ "$after_inode" != "$before_inode" ]; then
        LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON="owner_changed"
        return 2
      fi
      rm -f -- "$owner_file" || {
        LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON="stale_cleanup_failed"
        return 2
      }
      rmdir "$lock_dir" 2>/dev/null || {
        LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON="stale_cleanup_failed"
        return 2
      }
      continue
    fi

    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      LEAD_RESTART_SCHEDULER_LOCK_FAILURE_REASON="live_owner_timeout"
      return 1
    fi
    sleep 0.1
  done
  return 0
}

LEAD_RESTART_GATE_FAILURE_REASON=""
LEAD_RESTART_GATE_LAST_STATE=""
LEAD_RESTART_GATE_LAST_SEQ=""

lead_restart_gate_exec() {
  local timeout="$1"
  shift
  local flywheel_root="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
  local bounded="${FLYWHEEL_RESTART_BOUNDED_RUN_BIN:-${flywheel_root}/scripts/lib/bounded-run.sh}"
  local gate="${FLYWHEEL_RESTART_STORM_GATE_BIN:-${flywheel_root}/scripts/restart-storm-gate.py}"
  "$bounded" "$timeout" "$gate" "$@"
}

_lead_restart_gate_snapshot() {
  local deadline="$1" root="$2" child="$3"
  local now remaining output="" rc=0 state seq
  now="$(date +%s)"
  remaining=$((deadline - now))
  if (( remaining <= 0 )); then
    LEAD_RESTART_GATE_FAILURE_REASON="gate_timeout"
    return 1
  fi
  output="$(lead_restart_gate_exec \
    "$remaining" status --with-seq --root "$root" "$child")" || rc=$?
  if (( rc != 0 )); then
    LEAD_RESTART_GATE_FAILURE_REASON="status_rc_${rc}"
    return 1
  fi
  state="$(printf '%s' "$output" | jq -er \
    'select(type == "object") | .state | select(. == "active" or . == "resumed" or . == "held_alert_pending" or . == "held_alert_attempted")' \
    2>/dev/null)" || {
      LEAD_RESTART_GATE_FAILURE_REASON="status_invalid_json"
      return 1
    }
  seq="$(printf '%s' "$output" | jq -er \
    '.ledger_seq | select(type == "number" and floor == . and . >= 0)' \
    2>/dev/null)" || {
      LEAD_RESTART_GATE_FAILURE_REASON="status_invalid_json"
      return 1
    }
  LEAD_RESTART_GATE_LAST_STATE="$state"
  LEAD_RESTART_GATE_LAST_SEQ="$seq"
  return 0
}

# Opens one fresh storm-counting window for a marker-fenced launchd Lead
# replacement. A seq race may be resampled at most three times and the whole
# exchange shares one 15-second wall-clock budget.
lead_restart_arm_controlled_wave() {
  local daemon_key="$1" marker="$2" attempt_id="$3" root="$4"
  local child="lead.${daemon_key}" marker_digest deadline try now remaining
  local output="" rc=0 status reason armed_attempt armed_seq
  LEAD_RESTART_GATE_FAILURE_REASON=""
  LEAD_RESTART_GATE_LAST_STATE=""
  LEAD_RESTART_GATE_LAST_SEQ=""
  marker_digest="$(lead_restart_file_digest "$marker")" || {
    LEAD_RESTART_GATE_FAILURE_REASON="marker_unreadable"
    return 1
  }
  deadline=$(($(date +%s) + 15))

  for try in 1 2 3; do
    _lead_restart_gate_snapshot "$deadline" "$root" "$child" || return 1
    lead_restart_authority_unchanged || {
      LEAD_RESTART_GATE_FAILURE_REASON="authority_changed"
      return 1
    }
    now="$(date +%s)"
    remaining=$((deadline - now))
    if (( remaining <= 0 )); then
      LEAD_RESTART_GATE_FAILURE_REASON="gate_timeout"
      return 1
    fi
    output=""
    rc=0
    output="$(lead_restart_gate_exec \
      "$remaining" arm-controlled-wave \
      --expected-seq "$LEAD_RESTART_GATE_LAST_SEQ" \
      --intent-marker "$marker" --attempt-id "$attempt_id" \
      --root "$root" "$child")" || rc=$?
    if (( rc == 0 )); then
      status="$(printf '%s' "$output" | jq -er '.status' 2>/dev/null || true)"
      armed_attempt="$(printf '%s' "$output" | jq -er '.attemptId' 2>/dev/null || true)"
      armed_seq="$(printf '%s' "$output" | jq -er \
        '.ledgerSeq | select(type == "number" and floor == . and . >= 0)' \
        2>/dev/null || true)"
      if [[ "$status" == armed && "$armed_attempt" == "$attempt_id" \
        && "$armed_seq" == "$LEAD_RESTART_GATE_LAST_SEQ" ]]; then
        return 0
      fi
      LEAD_RESTART_GATE_FAILURE_REASON="arm_invalid_json"
      return 1
    fi
    if (( rc != 3 )); then
      LEAD_RESTART_GATE_FAILURE_REASON="arm_rc_${rc}"
      return 1
    fi
    status="$(printf '%s' "$output" | jq -er '.status' 2>/dev/null || true)"
    reason="$(printf '%s' "$output" | jq -er '.reason' 2>/dev/null || true)"
    if [[ "$status" != not_armed || "$reason" != seq_changed ]]; then
      LEAD_RESTART_GATE_FAILURE_REASON="arm_invalid_json"
      return 1
    fi
    if [[ "$(lead_restart_file_digest "$marker" 2>/dev/null || true)" != "$marker_digest" ]] \
      || [[ "$(jq -er '.attempt_id' "$marker" 2>/dev/null || true)" != "$attempt_id" ]]; then
      LEAD_RESTART_GATE_FAILURE_REASON="marker_changed"
      return 1
    fi
    lead_restart_authority_unchanged || {
      LEAD_RESTART_GATE_FAILURE_REASON="authority_changed"
      return 1
    }
  done
  LEAD_RESTART_GATE_FAILURE_REASON="seq_changed_exhausted"
  return 1
}

LEAD_RESTART_GATE_ATTRIBUTION=""

# Post-wave attribution after quick verification is exhausted.
# 0 = a wrapper gate event advanced the ledger and left the gate active;
# 2 = gate control/sensor failure; 3 = gate held; 4 = no wrapper event proven.
lead_restart_classify_wave_gate() {
  local root="$1" child="$2" expected_seq="$3" deadline rc=0
  LEAD_RESTART_GATE_ATTRIBUTION=""
  case "$expected_seq" in ''|*[!0-9]*)
    LEAD_RESTART_GATE_ATTRIBUTION="gate_control_failure"
    return 2
    ;;
  esac
  deadline=$(( $(date +%s) + 15 ))
  _lead_restart_gate_snapshot "$deadline" "$root" "$child" || rc=$?
  if (( rc != 0 )); then
    LEAD_RESTART_GATE_ATTRIBUTION="gate_control_failure"
    return 2
  fi
  if [[ "$LEAD_RESTART_GATE_LAST_STATE" == held_* ]]; then
    LEAD_RESTART_GATE_ATTRIBUTION="gate_held"
    return 3
  fi
  if (( LEAD_RESTART_GATE_LAST_SEQ < expected_seq )); then
    LEAD_RESTART_GATE_ATTRIBUTION="gate_control_failure"
    return 2
  fi
  if (( LEAD_RESTART_GATE_LAST_SEQ == expected_seq )); then
    LEAD_RESTART_GATE_ATTRIBUTION="wrapper_event_unproven"
    return 4
  fi
  if [[ "$LEAD_RESTART_GATE_LAST_STATE" == active ]]; then
    LEAD_RESTART_GATE_ATTRIBUTION="gate_executed"
    return 0
  fi
  LEAD_RESTART_GATE_ATTRIBUTION="gate_control_failure"
  return 2
}

LEAD_RESTART_VERIFY_REASON=""
LEAD_RESTART_VERIFIED_GENERATION=""

lead_restart_verify_exec() {
  local flywheel_root="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
  local bounded="${FLYWHEEL_RESTART_BOUNDED_RUN_BIN:-${flywheel_root}/scripts/lib/bounded-run.sh}"
  local cli="${FLYWHEEL_LEAD_LEASE_CLI:-${flywheel_root}/packages/flywheel-comm/dist/index.js}"
  "$bounded" 15 node "$cli" lead-lease verify-bound "$@"
}

lead_restart_verify_bound() {
  local lead_key="$1" supervisor_pid="$2" supervisor_start="$3"
  local holder_pid="$4" holder_start="$5" output="" rc=0 reason="" generation=""
  LEAD_RESTART_VERIFY_REASON=""
  LEAD_RESTART_VERIFIED_GENERATION=""
  output="$(lead_restart_verify_exec \
    --lead-key "$lead_key" \
    --supervisor-pid "$supervisor_pid" \
    --supervisor-start "$supervisor_start" \
    --holder-pid "$holder_pid" \
    --holder-start "$holder_start" --json)" || rc=$?
  if (( rc == 0 )); then
    generation="$(printf '%s' "$output" | jq -er \
      'select(type == "object" and keys == ["generation","status"] and .status == "verified")
       | .generation | select(type == "number" and floor == . and . > 0)' \
      2>/dev/null)" || {
        LEAD_RESTART_VERIFY_REASON="lease_control_failure"
        return 2
      }
    LEAD_RESTART_VERIFIED_GENERATION="$generation"
    return 0
  fi
  if (( rc == 3 )); then
    reason="$(printf '%s' "$output" | jq -er \
      'select(type == "object" and keys == ["reason","status"] and .status == "mismatch")
       | .reason
       | select(. == "missing_lease" or . == "unbound" or . == "supervisor_mismatch"
         or . == "holder_mismatch" or . == "supervisor_generation_mismatch"
         or . == "missing_history")' 2>/dev/null)" || {
        LEAD_RESTART_VERIFY_REASON="lease_control_failure"
        return 2
      }
    LEAD_RESTART_VERIFY_REASON="$reason"
    return 3
  fi
  LEAD_RESTART_VERIFY_REASON="lease_control_failure"
  return 2
}

LEAD_RESTART_BASELINE_REASON=""
LEAD_RESTART_LEASE_BASELINE=""

lead_restart_progress_exec() {
  local flywheel_root="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
  local bounded="${FLYWHEEL_RESTART_BOUNDED_RUN_BIN:-${flywheel_root}/scripts/lib/bounded-run.sh}"
  local cli="${FLYWHEEL_LEAD_LEASE_CLI:-${flywheel_root}/packages/flywheel-comm/dist/index.js}"
  "$bounded" 15 node "$cli" lead-lease progress-snapshot "$@"
}

lead_restart_progress_snapshot() {
  local lead_id="$1" project="$2" output="" rc=0 normalized="" row_format=""
  LEAD_RESTART_BASELINE_REASON=""
  LEAD_RESTART_LEASE_BASELINE=""
  output="$(lead_restart_progress_exec \
    --lead "$lead_id" --project "$project" --json)" || rc=$?
  if (( rc != 0 )); then
    LEAD_RESTART_BASELINE_REASON="lease_control_failure"
    return 2
  fi
  normalized="$(printf '%s' "$output" | jq -ce '
    if type != "object" then error("not object")
    elif .status == "absent" and keys == ["status"] then .
    elif .status == "present"
      and keys == ["acquiredAt","boundAt","generation","holderPid","holderStart","rowFormat","status","supervisorGeneration","supervisorPid","supervisorStart"]
      and (.rowFormat == "version_valid" or .rowFormat == "legacy" or .rowFormat == "malformed")
      and (.generation | type == "number" and floor == . and . > 0)
      and (.holderPid | type == "number" and floor == . and . > 0)
      and (.holderStart | type == "string" and length > 0)
      and (.acquiredAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"))
      and (.boundAt == null or (.boundAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$")))
      and (.supervisorPid == null or (.supervisorPid | type == "number" and floor == . and . > 0))
      and (.supervisorStart == null or (.supervisorStart | type == "string" and length > 0))
      and (.supervisorGeneration == null or (.supervisorGeneration | type == "number" and floor == . and . > 0))
    then .
    else error("invalid progress snapshot")
    end' 2>/dev/null)" || {
      LEAD_RESTART_BASELINE_REASON="lease_control_failure"
      return 2
    }
  row_format="$(printf '%s' "$normalized" | jq -r '.rowFormat // "absent"')"
  if [[ "$row_format" == malformed ]]; then
    LEAD_RESTART_BASELINE_REASON="lease_data_malformed"
    return 3
  fi
  LEAD_RESTART_LEASE_BASELINE="$normalized"
  return 0
}

LEAD_RESTART_PROGRESS_REASON=""

lead_restart_replacement_progressed() {
  local baseline="$1" commit_ts="$2" lead_id="$3" project="$4"
  local supervisor_pid="$5" supervisor_start="$6" snapshot_rc=0 current=""
  LEAD_RESTART_PROGRESS_REASON=""
  lead_restart_progress_snapshot "$lead_id" "$project" || snapshot_rc=$?
  if (( snapshot_rc != 0 )); then
    LEAD_RESTART_PROGRESS_REASON="${LEAD_RESTART_BASELINE_REASON:-lease_control_failure}"
    return 2
  fi
  current="$LEAD_RESTART_LEASE_BASELINE"
  if jq -en \
      --argjson baseline "$baseline" --argjson current "$current" \
      --arg commit "$commit_ts" --argjson supervisor_pid "$supervisor_pid" \
      --arg supervisor_start "$supervisor_start" '
      ($current.status == "present")
      and ($current.rowFormat == "version_valid")
      and ($current.supervisorPid == $supervisor_pid)
      and ($current.supervisorStart == $supervisor_start)
      and ($current.supervisorGeneration == $current.generation)
      and (
        ($baseline.status == "present" and $current.generation > $baseline.generation)
        or ($current.acquiredAt > $commit)
      )' >/dev/null 2>&1; then
    LEAD_RESTART_PROGRESS_REASON="replacement_progress"
    return 0
  fi
  LEAD_RESTART_PROGRESS_REASON="no_replacement_progress"
  return 1
}

LEAD_RESTART_ATTEMPT_ID=""
LEAD_RESTART_MARKER_FILE=""
LEAD_RESTART_MARKER_LOAD_REASON=""
LEAD_RESTART_LOADED_MARKER_DAEMON_KEY=""
LEAD_RESTART_LOADED_MARKER_LABEL=""
LEAD_RESTART_LOADED_MARKER_PHASE=""
LEAD_RESTART_LOADED_MARKER_ATTEMPT=""
LEAD_RESTART_LOADED_MARKER_PROJECT=""
LEAD_RESTART_LOADED_MARKER_LEAD_ID=""
LEAD_RESTART_LOADED_MARKER_BACKEND=""
LEAD_RESTART_LOADED_MARKER_OLD_PID=""
LEAD_RESTART_LOADED_MARKER_OLD_START=""
LEAD_RESTART_LOADED_MARKER_BASELINE=""
LEAD_RESTART_LOADED_MARKER_TS=""

lead_restart_write_replacement_marker() {
  local daemon_key="$1" expected_label="$2" old_pid="$3" old_start="$4"
  local marker_dir="${FLYWHEEL_LEAD_REPLACEMENT_DIR:-${HOME}/.flywheel/state/lead-replacements}"
  local marker temp semantic old_tuple now attempt
  LEAD_RESTART_ATTEMPT_ID=""
  LEAD_RESTART_MARKER_FILE=""
  case "$daemon_key" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
  case "$marker_dir" in /*) ;; *) return 1 ;; esac
  [[ ! -L "$marker_dir" ]] || return 1
  mkdir -p "$marker_dir" || return 1
  chmod 700 "$marker_dir" 2>/dev/null || return 1

  semantic="$(jq -ce '
    {
      leadId: .leadId,
      projectDir: .projectDir,
      projectName: .projectName,
      botTokenEnv: .botTokenEnv,
      leadBackend: {backendId: (.leadBackend.backendId // "claude-code")}
    }
    | select(
        (.leadId | type == "string" and length > 0)
        and (.projectDir | type == "string" and length > 0)
        and (.projectName | type == "string" and length > 0)
        and (.botTokenEnv | type == "string" and length > 0)
        and (.leadBackend.backendId | type == "string" and length > 0)
      )' "$LEAD_RESTART_MANIFEST_FILE" 2>/dev/null)" || return 1
  [[ "$LEAD_RESTART_PLIST_DIGEST" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$LEAD_RESTART_PROJECTS_DIGEST" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$LEAD_RESTART_LEASE_BASELINE" | jq -e . >/dev/null 2>&1 || return 1
  if [[ "$old_pid" =~ ^[1-9][0-9]*$ && -n "$old_start" ]]; then
    old_tuple="$(jq -cn --argjson pid "$old_pid" --arg start "$old_start" \
      '{pid:$pid,start:$start}')" || return 1
  elif [[ -z "$old_pid" && -z "$old_start" ]]; then
    old_tuple='{"pid":null,"start":null}'
  else
    return 1
  fi
  attempt="$(python3 -c 'import uuid; print(uuid.uuid4())' 2>/dev/null)" || return 1
  [[ "$attempt" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || return 1
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  marker="${marker_dir}/${daemon_key}.json"
  temp="$(mktemp "${marker_dir}/.${daemon_key}.XXXXXX")" || return 1
  if ! jq -n \
      --arg attempt "$attempt" --arg daemon "$daemon_key" \
      --arg label "$expected_label" --arg manifest "$LEAD_RESTART_MANIFEST_FILE" \
      --arg plist "$LEAD_RESTART_PLIST_FILE" --arg plist_digest "$LEAD_RESTART_PLIST_DIGEST" \
      --arg projects "$LEAD_RESTART_PROJECTS_FILE" --arg projects_digest "$LEAD_RESTART_PROJECTS_DIGEST" \
      --arg ts "$now" --argjson semantic "$semantic" --argjson old "$old_tuple" \
      --argjson baseline "$LEAD_RESTART_LEASE_BASELINE" \
      '{schema_version:1,attempt_id:$attempt,daemon_key:$daemon,expected_label:$label,
        phase:"bootout",old_supervisor_tuple:$old,
        authority:{manifest:{path:$manifest,semantic_identity:$semantic},
          plist:{path:$plist,digest:$plist_digest},
          projects:{path:$projects,digest:$projects_digest}},
        lease_baseline:$baseline,ts:$ts}' > "$temp"; then
    rm -f "$temp"
    return 1
  fi
  chmod 600 "$temp" || { rm -f "$temp"; return 1; }
  mv -f "$temp" "$marker" || { rm -f "$temp"; return 1; }
  python3 - "$marker_dir" 2>/dev/null <<'PY' || return 1
import os, sys
flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
fd = os.open(sys.argv[1], flags)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
  LEAD_RESTART_ATTEMPT_ID="$attempt"
  LEAD_RESTART_MARKER_FILE="$marker"
  return 0
}

lead_restart_update_marker_phase() {
  local marker="$1" attempt_id="$2" phase="$3" marker_dir temp
  local expected_dir="${FLYWHEEL_LEAD_REPLACEMENT_DIR:-${HOME}/.flywheel/state/lead-replacements}"
  [[ "$phase" == bootout || "$phase" == bootstrap ]] || return 1
  [[ "$expected_dir" == /* && "$(dirname "$marker")" == "$expected_dir" ]] || return 1
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  [[ "$(_lead_restart_file_mode "$marker")" == 600 ]] \
    || return 1
  [[ "$(jq -er '.attempt_id' "$marker" 2>/dev/null || true)" == "$attempt_id" ]] || return 1
  marker_dir="$(dirname "$marker")"
  temp="$(mktemp "${marker_dir}/.${marker##*/}.XXXXXX")" || return 1
  if ! jq --arg phase "$phase" '.phase = $phase' "$marker" > "$temp"; then
    rm -f "$temp"
    return 1
  fi
  chmod 600 "$temp" || { rm -f "$temp"; return 1; }
  mv -f "$temp" "$marker" || { rm -f "$temp"; return 1; }
  python3 - "$marker_dir" 2>/dev/null <<'PY'
import os, sys
flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
fd = os.open(sys.argv[1], flags)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

lead_restart_remove_marker() {
  local marker="$1" attempt_id="$2" marker_dir
  local expected_dir="${FLYWHEEL_LEAD_REPLACEMENT_DIR:-${HOME}/.flywheel/state/lead-replacements}"
  [[ "$expected_dir" == /* && "$(dirname "$marker")" == "$expected_dir" ]] || return 1
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  [[ "$(_lead_restart_file_mode "$marker")" == 600 ]] || return 1
  [[ "$(jq -er '.attempt_id' "$marker" 2>/dev/null || true)" == "$attempt_id" ]] || return 1
  marker_dir="$(dirname "$marker")"
  rm -f "$marker" || return 1
  python3 - "$marker_dir" 2>/dev/null <<'PY'
import os, sys
flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
fd = os.open(sys.argv[1], flags)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

# Strictly load one durable replacement intent and restore current carrier
# authority into the LEAD_RESTART_* globals. Manifest comparison is semantic:
# runtime-written pid/model/effort evidence cannot create false drift.
lead_restart_load_replacement_marker() {
  local marker="$1"
  local marker_dir="${FLYWHEEL_LEAD_REPLACEMENT_DIR:-${HOME}/.flywheel/state/lead-replacements}"
  local normalized daemon_key label phase attempt manifest plist projects
  local expected_semantic current_semantic plist_digest projects_digest
  local old_pid old_start baseline ts
  LEAD_RESTART_MARKER_LOAD_REASON=""
  LEAD_RESTART_LOADED_MARKER_DAEMON_KEY=""
  LEAD_RESTART_LOADED_MARKER_LABEL=""
  LEAD_RESTART_LOADED_MARKER_PHASE=""
  LEAD_RESTART_LOADED_MARKER_ATTEMPT=""
  LEAD_RESTART_LOADED_MARKER_PROJECT=""
  LEAD_RESTART_LOADED_MARKER_LEAD_ID=""
  LEAD_RESTART_LOADED_MARKER_BACKEND=""
  LEAD_RESTART_LOADED_MARKER_OLD_PID=""
  LEAD_RESTART_LOADED_MARKER_OLD_START=""
  LEAD_RESTART_LOADED_MARKER_BASELINE=""
  LEAD_RESTART_LOADED_MARKER_TS=""

  if [[ "$marker_dir" != /* || "$marker" != "${marker_dir}/"* \
    || "$(dirname "$marker")" != "$marker_dir" \
    || ! -f "$marker" || -L "$marker" \
    || "$(_lead_restart_file_mode "$marker")" != 600 ]]; then
    LEAD_RESTART_MARKER_LOAD_REASON="marker_invalid"
    return 2
  fi
  normalized="$(jq -ce '
    select(type == "object" and keys == ["attempt_id","authority","daemon_key","expected_label","lease_baseline","old_supervisor_tuple","phase","schema_version","ts"])
    | select(.schema_version == 1)
    | select(.attempt_id | type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"))
    | select(.daemon_key | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]*$"))
    | select(.expected_label == ("com.flywheel.lead." + .daemon_key))
    | select(.phase == "bootout" or .phase == "bootstrap")
    | select(.old_supervisor_tuple | type == "object" and keys == ["pid","start"])
    | select((.old_supervisor_tuple.pid == null and .old_supervisor_tuple.start == null)
      or ((.old_supervisor_tuple.pid | type == "number" and floor == . and . > 0)
        and (.old_supervisor_tuple.start | type == "string" and length > 0)))
    | select(.authority | type == "object" and keys == ["manifest","plist","projects"])
    | select(.authority.manifest | type == "object" and keys == ["path","semantic_identity"])
    | select(.authority.manifest.path | type == "string" and startswith("/"))
    | select(.authority.manifest.semantic_identity | type == "object" and keys == ["botTokenEnv","leadBackend","leadId","projectDir","projectName"])
    | select(.authority.manifest.semantic_identity.leadBackend | type == "object" and keys == ["backendId"])
    | select([.authority.manifest.semantic_identity.leadId,
              .authority.manifest.semantic_identity.projectDir,
              .authority.manifest.semantic_identity.projectName,
              .authority.manifest.semantic_identity.botTokenEnv,
              .authority.manifest.semantic_identity.leadBackend.backendId]
      | all(type == "string" and length > 0))
    | select(.authority.plist | type == "object" and keys == ["digest","path"])
    | select(.authority.projects | type == "object" and keys == ["digest","path"])
    | select(.authority.plist.path | type == "string" and startswith("/"))
    | select(.authority.projects.path | type == "string" and startswith("/"))
    | select(.authority.plist.digest | type == "string" and test("^[0-9a-f]{64}$"))
    | select(.authority.projects.digest | type == "string" and test("^[0-9a-f]{64}$"))
    | select(.lease_baseline | type == "object")
    | select((.lease_baseline.status == "absent" and (.lease_baseline | keys == ["status"]))
      or (.lease_baseline.status == "present"
        and (.lease_baseline | keys == ["acquiredAt","boundAt","generation","holderPid","holderStart","rowFormat","status","supervisorGeneration","supervisorPid","supervisorStart"])
        and (.lease_baseline.rowFormat == "version_valid" or .lease_baseline.rowFormat == "legacy")))
    | select(.ts | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"))
  ' "$marker" 2>/dev/null)" || {
    LEAD_RESTART_MARKER_LOAD_REASON="marker_invalid"
    return 2
  }
  daemon_key="$(printf '%s' "$normalized" | jq -er '.daemon_key')"
  [[ "$(basename "$marker")" == "${daemon_key}.json" ]] || {
    LEAD_RESTART_MARKER_LOAD_REASON="marker_invalid"
    return 2
  }
  label="$(printf '%s' "$normalized" | jq -er '.expected_label')"
  phase="$(printf '%s' "$normalized" | jq -er '.phase')"
  attempt="$(printf '%s' "$normalized" | jq -er '.attempt_id')"
  manifest="$(printf '%s' "$normalized" | jq -er '.authority.manifest.path')"
  plist="$(printf '%s' "$normalized" | jq -er '.authority.plist.path')"
  projects="$(printf '%s' "$normalized" | jq -er '.authority.projects.path')"
  expected_semantic="$(printf '%s' "$normalized" | jq -c '.authority.manifest.semantic_identity')"
  plist_digest="$(printf '%s' "$normalized" | jq -er '.authority.plist.digest')"
  projects_digest="$(printf '%s' "$normalized" | jq -er '.authority.projects.digest')"
  if ! lead_restart_validate_authority "$manifest" "$plist" "$projects" "$label"; then
    LEAD_RESTART_MARKER_LOAD_REASON="authority_changed"
    return 3
  fi
  current_semantic="$(jq -ce '
    {leadId:.leadId,projectDir:.projectDir,projectName:.projectName,
     botTokenEnv:.botTokenEnv,
     leadBackend:{backendId:(.leadBackend.backendId // "claude-code")}}
    | select([.leadId,.projectDir,.projectName,.botTokenEnv,.leadBackend.backendId]
      | all(type == "string" and length > 0))
  ' "$manifest" 2>/dev/null)" || {
    LEAD_RESTART_MARKER_LOAD_REASON="authority_changed"
    return 3
  }
  if [[ "$current_semantic" != "$expected_semantic" \
    || "$LEAD_RESTART_PLIST_DIGEST" != "$plist_digest" \
    || "$LEAD_RESTART_PROJECTS_DIGEST" != "$projects_digest" ]]; then
    LEAD_RESTART_MARKER_LOAD_REASON="authority_changed"
    return 3
  fi
  old_pid="$(printf '%s' "$normalized" | jq -r '.old_supervisor_tuple.pid // ""')"
  old_start="$(printf '%s' "$normalized" | jq -r '.old_supervisor_tuple.start // ""')"
  baseline="$(printf '%s' "$normalized" | jq -c '.lease_baseline')"
  ts="$(printf '%s' "$normalized" | jq -er '.ts')"
  LEAD_RESTART_LOADED_MARKER_DAEMON_KEY="$daemon_key"
  LEAD_RESTART_LOADED_MARKER_LABEL="$label"
  LEAD_RESTART_LOADED_MARKER_PHASE="$phase"
  LEAD_RESTART_LOADED_MARKER_ATTEMPT="$attempt"
  LEAD_RESTART_LOADED_MARKER_PROJECT="$LEAD_RESTART_PROJECT"
  LEAD_RESTART_LOADED_MARKER_LEAD_ID="$LEAD_RESTART_LEAD_ID"
  LEAD_RESTART_LOADED_MARKER_BACKEND="$LEAD_RESTART_BACKEND"
  LEAD_RESTART_LOADED_MARKER_OLD_PID="$old_pid"
  LEAD_RESTART_LOADED_MARKER_OLD_START="$old_start"
  LEAD_RESTART_LOADED_MARKER_BASELINE="$baseline"
  LEAD_RESTART_LOADED_MARKER_TS="$ts"
  return 0
}

# Positive retirement proof for the only authority-drift case that may resolve
# without bootstrap: both carrier files are gone and canonical projects.json
# is readable and contains no exact project/Lead identity.
lead_restart_marker_retired() {
  local marker="$1"
  local marker_dir="${FLYWHEEL_LEAD_REPLACEMENT_DIR:-${HOME}/.flywheel/state/lead-replacements}"
  local fields manifest plist projects project lead_id
  [[ "$marker_dir" == /* && "$(dirname "$marker")" == "$marker_dir" ]] || return 1
  [[ -f "$marker" && ! -L "$marker" \
    && "$(_lead_restart_file_mode "$marker")" == 600 ]] || return 1
  fields="$(jq -er '
    select(type == "object" and .schema_version == 1)
    | [.authority.manifest.path,
       .authority.plist.path,
       .authority.projects.path,
       .authority.manifest.semantic_identity.projectName,
       .authority.manifest.semantic_identity.leadId]
    | select(all(.[]; type == "string" and length > 0
        and (contains("\t") | not) and (contains("\n") | not)))
    | @tsv
  ' "$marker" 2>/dev/null)" || return 1
  manifest="${fields%%$'\t'*}"; fields="${fields#*$'\t'}"
  plist="${fields%%$'\t'*}"; fields="${fields#*$'\t'}"
  projects="${fields%%$'\t'*}"; fields="${fields#*$'\t'}"
  project="${fields%%$'\t'*}"; lead_id="${fields#*$'\t'}"
  [[ "$manifest" == /* && "$plist" == /* && "$projects" == /* ]] || return 1
  [[ ! -e "$manifest" && ! -L "$manifest" \
    && ! -e "$plist" && ! -L "$plist" ]] || return 1
  [[ -f "$projects" && ! -L "$projects" ]] || return 1
  jq -e --arg project "$project" --arg lead "$lead_id" '
    type == "array"
    and ([.[] | select(.projectName == $project) | (.leads // [])[]
          | select(.agentId == $lead)] | length == 0)
  ' "$projects" >/dev/null 2>&1
}

lead_restart_sleep() {
  sleep "$1"
}

_lead_restart_plist_json() {
  local plist="$1"
  [ -f "$plist" ] && [ ! -L "$plist" ] || return 1
  python3 - "$plist" 2>/dev/null <<'PY'
import json
import plistlib
import sys

with open(sys.argv[1], "rb") as handle:
    value = plistlib.load(handle)
label = value.get("Label")
argv = value.get("ProgramArguments")
if not isinstance(label, str) or not label or "\n" in label or "\t" in label:
    raise SystemExit(1)
if not isinstance(argv, list) or not argv:
    raise SystemExit(1)
if any(not isinstance(arg, str) or not arg or "\n" in arg or "\t" in arg for arg in argv):
    raise SystemExit(1)
print(json.dumps({"label": label, "argv": argv}, separators=(",", ":")))
PY
}

_lead_restart_manifest_identity() {
  local manifest="$1"
  jq -er '
    (.projectName // "") as $project |
    (.leadId // "") as $lead |
    if ($project|type) == "string" and ($project|length) > 0
       and ($lead|type) == "string" and ($lead|length) > 0
       and ($project|contains("\t")|not) and ($project|contains("\n")|not)
       and ($lead|contains("\t")|not) and ($lead|contains("\n")|not)
    then [$project,$lead] | @tsv
    else error("invalid manifest identity")
    end
  ' "$manifest" 2>/dev/null
}

lead_restart_project_backend() {
  local projects_file="$1" project="$2" lead_id="$3"
  jq -er --arg project "$project" --arg lead "$lead_id" '
    [
      .[] |
      select(.projectName == $project) |
      (.leads // [])[] |
      select(.agentId == $lead)
    ] |
    if length == 1
    then (.[0].backend // "claude-code")
    else error("project lead identity is missing or ambiguous")
    end
  ' "$projects_file" 2>/dev/null
}

_lead_restart_config_identity_for_key() {
  local projects_file="$1" key="$2"
  jq -er --arg key "$key" '
    [
      .[] as $project |
      ($project.leads // [])[] |
      select(($project.projectName + "-" + .agentId) == $key) |
      [$project.projectName, .agentId]
    ] |
    if length == 1 then .[0] | @tsv
    else error("candidate identity is missing or ambiguous")
    end
  ' "$projects_file" 2>/dev/null
}

LEAD_RESTART_BACKEND=""
LEAD_RESTART_PROJECT=""
LEAD_RESTART_LEAD_ID=""
LEAD_RESTART_LABEL=""
LEAD_RESTART_MANIFEST_FILE=""
LEAD_RESTART_PLIST_FILE=""
LEAD_RESTART_PROJECTS_FILE=""
LEAD_RESTART_MANIFEST_DIGEST=""
LEAD_RESTART_PLIST_DIGEST=""
LEAD_RESTART_PROJECTS_DIGEST=""

_lead_restart_validate_authority_once() {
  local manifest="$1" plist="$2" projects_file="$3" expected_label="$4"
  local identity project lead_id plist_json label argc arg0 wrapper arg2=""
  local wrapper_base manifest_backend project_backend backend
  identity="$(_lead_restart_manifest_identity "$manifest")" || return 1
  project="${identity%%$'\t'*}"
  lead_id="${identity#*$'\t'}"
  plist_json="$(_lead_restart_plist_json "$plist")" || return 1
  label="$(printf '%s' "$plist_json" | jq -er '.label')" || return 1
  [ "$label" = "$expected_label" ] || return 1
  [ "$label" = "com.flywheel.lead.${project}-${lead_id}" ] || return 1
  argc="$(printf '%s' "$plist_json" | jq -er '.argv | length')" || return 1
  arg0="$(printf '%s' "$plist_json" | jq -er '.argv[0]')" || return 1
  wrapper="$(printf '%s' "$plist_json" | jq -er '.argv[1]')" || return 1
  [ "$arg0" = "/bin/bash" ] || return 1
  wrapper_base="${wrapper##*/}"
  manifest_backend="$(jq -er '.leadBackend.backendId // ""' "$manifest" 2>/dev/null)" || return 1
  project_backend="$(lead_restart_project_backend "$projects_file" "$project" "$lead_id")" || return 1

  case "$wrapper_base" in
    flywheel-lead-wrapper.sh)
      [ "$argc" -eq 3 ] || return 1
      arg2="$(printf '%s' "$plist_json" | jq -er '.argv[2]')" || return 1
      [ "$arg2" = "$manifest" ] || return 1
      [ "$project_backend" = "claude-code" ] || return 1
      case "$manifest_backend" in ""|claude-code) ;; *) return 1 ;; esac
      backend="claude-code"
      ;;
    flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh)
      [ "$argc" -eq 2 ] || return 1
      [ "$project" = "growth" ] && [ "$lead_id" = "mufasa-lead" ] || return 1
      [ "$project_backend" = "codex-app-server" ] || return 1
      case "$manifest_backend" in ""|codex-app-server) ;; *) return 1 ;; esac
      backend="codex-app-server"
      ;;
    flywheel-codex-lead-wrapper-codex-infra-bot.sh)
      [ "$argc" -eq 2 ] || return 1
      [ "$project" = "flywheel" ] && [ "$lead_id" = "codex-infra-bot-lead" ] || return 1
      [ "$project_backend" = "codex-app-server" ] || return 1
      case "$manifest_backend" in ""|codex-app-server) ;; *) return 1 ;; esac
      backend="codex-app-server"
      ;;
    *)
      # Includes the retired mufasa-tui.sh carrier and any future carrier not
      # explicitly reviewed for destructive restart authority.
      return 1
      ;;
  esac

  LEAD_RESTART_BACKEND="$backend"
  LEAD_RESTART_PROJECT="$project"
  LEAD_RESTART_LEAD_ID="$lead_id"
  LEAD_RESTART_LABEL="$label"
  return 0
}

lead_restart_validate_authority() {
  local manifest="$1" plist="$2" projects_file="$3" expected_label="$4"
  local manifest_digest plist_digest projects_digest
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || return 1
  [ -f "$projects_file" ] && [ ! -L "$projects_file" ] || return 1
  manifest_digest="$(lead_restart_file_digest "$manifest")" || return 1
  plist_digest="$(lead_restart_file_digest "$plist")" || return 1
  projects_digest="$(lead_restart_file_digest "$projects_file")" || return 1
  _lead_restart_validate_authority_once "$manifest" "$plist" "$projects_file" "$expected_label" || return 1
  LEAD_RESTART_MANIFEST_FILE="$manifest"
  LEAD_RESTART_PLIST_FILE="$plist"
  LEAD_RESTART_PROJECTS_FILE="$projects_file"
  LEAD_RESTART_MANIFEST_DIGEST="$manifest_digest"
  LEAD_RESTART_PLIST_DIGEST="$plist_digest"
  LEAD_RESTART_PROJECTS_DIGEST="$projects_digest"
  return 0
}

lead_restart_authority_unchanged() {
  local backend="$LEAD_RESTART_BACKEND" project="$LEAD_RESTART_PROJECT"
  local lead_id="$LEAD_RESTART_LEAD_ID" label="$LEAD_RESTART_LABEL"
  local manifest_digest plist_digest projects_digest
  [ -n "$LEAD_RESTART_MANIFEST_FILE" ] && [ -n "$LEAD_RESTART_PLIST_FILE" ] \
    && [ -n "$LEAD_RESTART_PROJECTS_FILE" ] || return 1
  manifest_digest="$(lead_restart_file_digest "$LEAD_RESTART_MANIFEST_FILE")" || return 1
  plist_digest="$(lead_restart_file_digest "$LEAD_RESTART_PLIST_FILE")" || return 1
  projects_digest="$(lead_restart_file_digest "$LEAD_RESTART_PROJECTS_FILE")" || return 1
  [ "$manifest_digest" = "$LEAD_RESTART_MANIFEST_DIGEST" ] || return 1
  [ "$plist_digest" = "$LEAD_RESTART_PLIST_DIGEST" ] || return 1
  [ "$projects_digest" = "$LEAD_RESTART_PROJECTS_DIGEST" ] || return 1
  _lead_restart_validate_authority_once \
    "$LEAD_RESTART_MANIFEST_FILE" "$LEAD_RESTART_PLIST_FILE" \
    "$LEAD_RESTART_PROJECTS_FILE" "$label" || return 1
  [ "$LEAD_RESTART_BACKEND" = "$backend" ] \
    && [ "$LEAD_RESTART_PROJECT" = "$project" ] \
    && [ "$LEAD_RESTART_LEAD_ID" = "$lead_id" ] \
    && [ "$LEAD_RESTART_LABEL" = "$label" ]
}

lead_restart_old_tuple_dead() {
  local pid="$1" expected_start="$2" actual_start
  case "$pid" in ""|0) return 0 ;; *[!0-9]*) return 1 ;; esac
  lead_restart_process_alive "$pid" || return 0
  actual_start="$(lead_restart_process_start_identity "$pid")" || return 1
  [ "$actual_start" != "$expected_start" ]
}

_lead_restart_claude_supervisor_present() {
  local project="$1" lead_id="$2" snapshot line_pid command had_noglob token
  snapshot="$(lead_restart_process_table)" || return 2
  while read -r line_pid command; do
    case "$line_pid" in ""|*[!0-9]*) continue ;; esac
    had_noglob=0
    case "$-" in *f*) had_noglob=1 ;; *) set -f ;; esac
    # shellcheck disable=SC2086
    set -- $command
    [ "$had_noglob" -eq 1 ] || set +f
    while [ "$#" -gt 0 ]; do
      token="${1##*/}"
      shift
      if [ "$token" = "claude-lead.sh" ]; then
        [ "${1:-}" = "$lead_id" ] && [ "${3:-}" = "$project" ] && return 0
        break
      fi
    done
  done <<EOF
$snapshot
EOF
  return 1
}

_lead_restart_codex_assertion_quiet() {
  local assertion_file="$1" key="$2" pid lstart actual
  [ -e "$assertion_file" ] || return 0
  [ -f "$assertion_file" ] && [ ! -L "$assertion_file" ] || return 2
  pid="$(jq -er --arg key "$key" '
    select(.schemaVersion == 1 and .leadKey == $key)
    | .pid | select(type == "number" and . > 0 and (floor == .))
  ' "$assertion_file" 2>/dev/null)" || return 2
  lstart="$(jq -er '.lstart | select(type == "string" and length > 0)' "$assertion_file" 2>/dev/null)" || return 2
  lead_restart_process_alive "$pid" || return 0
  actual="$(lead_restart_process_start_identity "$pid")" || return 2
  [ "$actual" != "$lstart" ]
}

lead_restart_wait_quiescent() {
  local target="$1" old_pid="$2" old_start="$3" backend="$4"
  local project="$5" lead_id="$6" assertion_file="$7"
  local attempts="${LEAD_RESTART_QUIESCENCE_ATTEMPTS:-${LEAD_QUIESCENCE_ATTEMPTS:-30}}"
  local interval="${LEAD_RESTART_QUIESCENCE_INTERVAL:-${LEAD_QUIESCENCE_INTERVAL:-1}}"
  local count=0 probe supervisor_rc assertion_rc
  while [ "$count" -lt "$attempts" ]; do
    probe="$(lead_restart_launchd_probe "$target")"
    [ "$probe" = "error" ] && return 2
    if [ "$probe" = "unloaded" ] && lead_restart_old_tuple_dead "$old_pid" "$old_start"; then
      if [ "$backend" = "claude-code" ]; then
        supervisor_rc=0
        _lead_restart_claude_supervisor_present "$project" "$lead_id" || supervisor_rc=$?
        [ "$supervisor_rc" -eq 2 ] && return 2
        [ "$supervisor_rc" -eq 1 ] && return 0
      else
        assertion_rc=0
        _lead_restart_codex_assertion_quiet "$assertion_file" "${project}-${lead_id}" || assertion_rc=$?
        [ "$assertion_rc" -eq 2 ] && return 2
        [ "$assertion_rc" -eq 0 ] && return 0
      fi
    fi
    lead_restart_sleep "$interval"
    count=$((count + 1))
  done
  return 1
}

lead_restart_recovery_bootstrap_allowed() {
  local backend="$1" old_tuple_dead="$2" sweep_safe="$3"
  [ "$old_tuple_dead" = "true" ] || return 1
  case "$backend" in
    claude-code) return 0 ;;
    codex-app-server) [ "$sweep_safe" = "true" ] ;;
    *) return 1 ;;
  esac
}

_lead_restart_candidate_add() {
  local file="$1" key="$2" project="$3" lead_id="$4" manifest="$5" classification="$6" source="$7"
  [ -n "$project" ] || project="-"
  [ -n "$lead_id" ] || lead_id="-"
  [ -n "$manifest" ] || manifest="-"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$key" "$project" "$lead_id" "$manifest" "$classification" "$source" >> "$file"
}

_lead_restart_plist_key_and_manifest() {
  local plist="$1" json label argc manifest="-"
  json="$(_lead_restart_plist_json "$plist")" || return 1
  label="$(printf '%s' "$json" | jq -er '.label')" || return 1
  case "$label" in com.flywheel.lead.*) ;; *) return 1 ;; esac
  argc="$(printf '%s' "$json" | jq -er '.argv | length')" || return 1
  if [ "$argc" -ge 3 ]; then
    manifest="$(printf '%s' "$json" | jq -er '.argv[2]')" || return 1
  fi
  printf '%s\t%s\n' "${label#com.flywheel.lead.}" "$manifest"
}

_lead_restart_parse_legacy_identity() {
  local command="$1" token had_noglob=0
  case "$-" in *f*) had_noglob=1 ;; *) set -f ;; esac
  # shellcheck disable=SC2086
  set -- $command
  [ "$had_noglob" -eq 1 ] || set +f
  while [ "$#" -gt 0 ]; do
    token="${1##*/}"
    shift
    if [ "$token" = "claude-lead.sh" ]; then
      [ "$#" -ge 3 ] || return 1
      printf '%s\t%s\n' "$3" "$1"
      return 0
    fi
  done
  return 1
}

_lead_restart_normalize_candidates() {
  local raw="$1" out="$2"
  awk -F '\t' '
    function priority(c) {
      if (c == "probe-error" || c == "config-drift") return 5
      if (c == "restart") return 4
      if (c == "manifestless") return 3
      if (c == "skip-test") return 1
      return 0
    }
    NF >= 6 {
      key=$1
      if (!(key in seen)) {
        seen[key]=++count; order[count]=key
        project[key]=$2; lead[key]=$3; manifest[key]=$4
        class[key]=$5; sources[key]=$6
      } else {
        if (manifest[key] == "-" && $4 != "-") manifest[key]=$4
        if (project[key] == "-" && $2 != "-") project[key]=$2
        if (lead[key] == "-" && $3 != "-") lead[key]=$3
        if (sources[key] !~ ("(^|,)" $6 "(,|$)")) sources[key]=sources[key] "," $6
        if (priority($5) > priority(class[key])) class[key]=$5
      }
      if ($3 ~ /^flywheel-test-/ || $5 == "skip-test") isqa[key]=1
    }
    END {
      for (i=1; i<=count; i++) {
        key=order[i]
        if (isqa[key]) class[key]="skip-test"
        print key "\t" project[key] "\t" lead[key] "\t" manifest[key] "\t" class[key] "\t" sources[key]
      }
    }
  ' "$raw" | sort > "$out"
}

lead_restart_collect_candidates() {
  local manifest_dir="$1" plist_dir="$2" projects_file="$3" out_file="$4"
  local raw="${out_file}.raw.$$" manifest identity project lead_id key class
  : > "$raw" || return 2
  if [ ! -f "$projects_file" ] || [ -L "$projects_file" ] \
    || ! jq -e 'type == "array"' "$projects_file" >/dev/null 2>&1; then
    rm -f "$raw"
    return 2
  fi

  local old_nullglob
  old_nullglob="$(shopt -p nullglob || true)"
  shopt -s nullglob
  local manifests=("$manifest_dir"/*.json)
  local plists=("$plist_dir"/com.flywheel.lead.*.plist)
  eval "$old_nullglob"

  for manifest in ${manifests[@]+"${manifests[@]}"}; do
    identity="$(_lead_restart_manifest_identity "$manifest")" || {
      key="${manifest##*/}"; key="${key%.json}"
      _lead_restart_candidate_add "$raw" "$key" "-" "-" "$manifest" "config-drift" "manifest"
      continue
    }
    project="${identity%%$'\t'*}"
    lead_id="${identity#*$'\t'}"
    key="${project}-${lead_id}"
    case "$lead_id" in
      flywheel-test-*) class="skip-test" ;;
      *) lead_restart_project_backend "$projects_file" "$project" "$lead_id" >/dev/null 2>&1 \
           && class="restart" || class="config-drift" ;;
    esac
    _lead_restart_candidate_add "$raw" "$key" "$project" "$lead_id" "$manifest" "$class" "manifest"
  done

  local plist pair target probe candidate_manifest
  for plist in ${plists[@]+"${plists[@]}"}; do
    pair="$(_lead_restart_plist_key_and_manifest "$plist")" || {
      key="${plist##*/}"; key="${key#com.flywheel.lead.}"; key="${key%.plist}"
      target="gui/$(id -u)/com.flywheel.lead.${key}"
      probe="$(lead_restart_launchd_probe "$target")"
      [ "$probe" = "unloaded" ] && continue
      class="config-drift"
      [ "$probe" = "error" ] && class="probe-error"
      _lead_restart_candidate_add "$raw" "$key" "-" "-" "-" "$class" "plist"
      continue
    }
    key="${pair%%$'\t'*}"
    candidate_manifest="${pair#*$'\t'}"
    target="gui/$(id -u)/com.flywheel.lead.${key}"
    probe="$(lead_restart_launchd_probe "$target")"
    [ "$probe" = "unloaded" ] && continue
    if [ "$probe" = "error" ]; then
      _lead_restart_candidate_add "$raw" "$key" "-" "-" "-" "probe-error" "plist"
      continue
    fi
    identity=""
    if [ "$candidate_manifest" != "-" ] && [ -f "$candidate_manifest" ]; then
      identity="$(_lead_restart_manifest_identity "$candidate_manifest" 2>/dev/null || true)"
    fi
    [ -n "$identity" ] || identity="$(_lead_restart_config_identity_for_key "$projects_file" "$key" 2>/dev/null || true)"
    if [ -z "$identity" ]; then
      _lead_restart_candidate_add "$raw" "$key" "-" "-" "-" "config-drift" "plist"
      continue
    fi
    project="${identity%%$'\t'*}"
    lead_id="${identity#*$'\t'}"
    case "$lead_id" in
      flywheel-test-*) class="skip-test" ;;
      *)
        if [ "$candidate_manifest" != "-" ] && [ -f "$candidate_manifest" ]; then
          class="restart"
        else
          class="manifestless"
        fi
        ;;
    esac
    _lead_restart_candidate_add "$raw" "$key" "$project" "$lead_id" \
      "$([ -f "$candidate_manifest" ] && printf '%s' "$candidate_manifest" || printf '-')" \
      "$class" "plist"
  done

  local snapshot="" snapshot_rc=0 line_pid command legacy_identity
  snapshot="$(lead_restart_process_table)" || snapshot_rc=$?
  if [ "$snapshot_rc" -ne 0 ]; then
    rm -f "$raw"
    return 2
  fi
  while read -r line_pid command; do
    case "$line_pid" in ""|*[!0-9]*) continue ;; esac
    legacy_identity="$(_lead_restart_parse_legacy_identity "$command" 2>/dev/null || true)"
    [ -n "$legacy_identity" ] || continue
    project="${legacy_identity%%$'\t'*}"
    lead_id="${legacy_identity#*$'\t'}"
    key="${project}-${lead_id}"
    case "$lead_id" in
      flywheel-test-*) class="skip-test" ;;
      *) lead_restart_project_backend "$projects_file" "$project" "$lead_id" >/dev/null 2>&1 \
           && class="manifestless" || class="config-drift" ;;
    esac
    _lead_restart_candidate_add "$raw" "$key" "$project" "$lead_id" "-" "$class" "process"
  done <<EOF
$snapshot
EOF

  _lead_restart_normalize_candidates "$raw" "$out_file"
  rm -f "$raw"
  return 0
}

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
    'select(type == "object") | .state | select(. == "active" or . == "resumed" or . == "held_alert_pending" or . == "held_alert_attempted" or . == "terminal_hold")' \
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

LEAD_RESTART_ATTEMPT_ID=""
LEAD_RESTART_MARKER_FILE=""

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

  [[ -n "$LEAD_RESTART_PROJECTS_FILE" && -n "$LEAD_RESTART_BACKEND" ]] || return 1
  semantic="$(jq -ce --arg projects_file "$LEAD_RESTART_PROJECTS_FILE" \
    --arg canonical_backend "$LEAD_RESTART_BACKEND" '
    {
      leadId: .leadId,
      projectDir: .projectDir,
      projectName: .projectName,
      projectsFile: $projects_file,
      leadBackend: {backendId: $canonical_backend}
    }
    | select(
        (.leadId | type == "string" and length > 0)
        and (.projectDir | type == "string" and length > 0)
        and (.projectName | type == "string" and length > 0)
        and (.projectsFile | type == "string" and length > 0)
        and (.leadBackend.backendId | type == "string" and length > 0)
      )' "$LEAD_RESTART_MANIFEST_FILE" 2>/dev/null)" || return 1
  [[ "$LEAD_RESTART_PLIST_DIGEST" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$LEAD_RESTART_PROJECTS_DIGEST" =~ ^[0-9a-f]{64}$ ]] || return 1
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
      '{schema_version:1,attempt_id:$attempt,daemon_key:$daemon,expected_label:$label,
        phase:"bootout",old_supervisor_tuple:$old,
        authority:{manifest:{path:$manifest,semantic_identity:$semantic},
          plist:{path:$plist,digest:$plist_digest},
          projects:{path:$projects,digest:$projects_digest}},
        ts:$ts}' > "$temp"; then
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
  local row backend project_root legacy=""
  row="$(jq -cer --arg project "$project" --arg lead "$lead_id" '
    [
      .[] as $project_row |
      select($project_row.projectName == $project) |
      ($project_row.leads // [])[] |
      select(.agentId == $lead) |
      {backend: (.backend // ""), projectRoot: ($project_row.projectRoot // "")}
    ] |
    if length == 1
       and (.[0].backend | type) == "string"
       and (.[0].projectRoot | type) == "string"
    then .[0]
    else error("project lead identity is missing or ambiguous")
    end' "$projects_file" 2>/dev/null)" || return 1

  backend="$(jq -r '.backend' <<<"$row")"
  if [ -n "$backend" ]; then
    printf '%s\n' "$backend"
    return 0
  fi

  project_root="$(jq -r '.projectRoot' <<<"$row")"
  case "$project_root" in
    /*) ;;
    "") project_root="" ;;
    *) project_root="${HOME:-}/$project_root" ;;
  esac
  if [ -n "$project_root" ] && [ -f "$project_root/.flywheel/config.yaml" ]; then
    legacy="$(awk '/^roles:/{r=1;next} r&&/^[^ ]/{r=0} r&&/^  lead:/{l=1;next} l&&/^  [^ ]/{l=0} l&&/^    backend:/{print $2; exit}' \
      "$project_root/.flywheel/config.yaml" 2>/dev/null | tr -d '"' || true)"
  fi
  [ -n "$legacy" ] || legacy="${FLYWHEEL_LEAD_BACKEND:-}"
  case "$legacy" in
    codex-app-server|codex-tmux|codex) printf 'codex-app-server\n' ;;
    *) printf 'claude-code\n' ;;
  esac
}

lead_restart_project_carrier() {
  local projects_file="$1" project="$2" lead_id="$3"
  jq -er --arg project "$project" --arg lead "$lead_id" '
    [
      .[] |
      select(.projectName == $project) |
      (.leads // [])[] |
      select(.agentId == $lead)
    ] |
    if length == 1
    then (.[0].carrier // "v2")
    else error("project lead identity is missing or ambiguous")
    end |
    select(. == "v2")
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
  local wrapper_base manifest_backend project_backend project_carrier backend
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
    flywheel-lead-wrapper-v2.sh)
      [ "$argc" -eq 3 ] || return 1
      arg2="$(printf '%s' "$plist_json" | jq -er '.argv[2]')" || return 1
      [ "$arg2" = "$manifest" ] || return 1
      [ "$project_backend" = "claude-code" ] || return 1
      project_carrier="$(lead_restart_project_carrier "$projects_file" "$project" "$lead_id")" || return 1
      [ "$project_carrier" = "v2" ] || return 1
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
    flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh)
      [ "$argc" -eq 2 ] || return 1
      [ "$project" = "raya" ] && [ "$lead_id" = "raya" ] || return 1
      [ "$project_backend" = "codex-app-server" ] || return 1
      case "$manifest_backend" in ""|codex-app-server) ;; *) return 1 ;; esac
      jq -e --arg project "$project" --arg lead "$lead_id" '
        [.[] | select(.projectName == $project) | (.leads // [])[] | select(.agentId == $lead)] as $matches |
        ($matches | length) == 1 and
        $matches[0].codexProfile == "full-access" and
        $matches[0].canSpawnRunners == false and
        ($matches[0].companion // false) == false
      ' "$projects_file" >/dev/null 2>&1 || return 1
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
  local count=0 probe assertion_rc
  [ "$backend" = "codex-app-server" ] || return 2
  while [ "$count" -lt "$attempts" ]; do
    probe="$(lead_restart_launchd_probe "$target")"
    [ "$probe" = "error" ] && return 2
    if [ "$probe" = "unloaded" ] && lead_restart_old_tuple_dead "$old_pid" "$old_start"; then
      assertion_rc=0
      _lead_restart_codex_assertion_quiet "$assertion_file" "${project}-${lead_id}" || assertion_rc=$?
      [ "$assertion_rc" -eq 2 ] && return 2
      [ "$assertion_rc" -eq 0 ] && return 0
    fi
    lead_restart_sleep "$interval"
    count=$((count + 1))
  done
  return 1
}

lead_restart_recovery_bootstrap_allowed() {
  local backend="$1" old_tuple_dead="$2" sweep_safe="$3"
  [ "$backend" = "codex-app-server" ] \
    && [ "$old_tuple_dead" = "true" ] \
    && [ "$sweep_safe" = "true" ]
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


  _lead_restart_normalize_candidates "$raw" "$out_file"
  rm -f "$raw"
  return 0
}

#!/usr/bin/env bash
# Source-only process identity/census helpers shared by cmux mutators and the
# fleet restart path (FLY-1482). Compatible with macOS Bash 3.2.

# Parse the exact argv presentation of one managed cmux attach helper.
# stdout: <kind>|<target>|<token>, where token is empty for the legacy v1
# grammar.  This consumes `ps -o command=` output, so shlex is required; a
# substring match could otherwise turn shell prose into signal authority.
cmux_attach_helper_command_parse() {
  local cmd="$1"
  printf '%s' "$cmd" | python3 -c '
import os,re,shlex,sys
try:
    words=shlex.split(sys.stdin.read())
except ValueError:
    raise SystemExit(1)
if not words:
    raise SystemExit(1)
if os.path.basename(words[0]) in ("bash", "sh"):
    if len(words) < 2 or words[1].startswith(("-", "+")):
        raise SystemExit(1)
    words=words[1:]
if len(words) not in (2, 3):
    raise SystemExit(1)
helper=os.path.basename(words[0])
target=words[1]
token=words[2] if len(words) == 3 else ""
if token and not re.fullmatch(r"fwtok1-[0-9a-f]{32}", token):
    raise SystemExit(1)
if helper == "flywheel-view-attach.sh":
    if not target.startswith("cmux-") or any(c in target for c in "\x27\r\n"):
        raise SystemExit(1)
    kind="view"
elif helper == "flywheel-lead-attach.sh":
    if not target.startswith("/") or any(c in target for c in "\x27\r\n"):
        raise SystemExit(1)
    kind="lead"
else:
    raise SystemExit(1)
print(kind + "|" + target + "|" + token)
'
}

cmux_attach_helper_command_matches() {
  cmux_attach_helper_command_parse "$1" >/dev/null 2>&1
}

cmux_process_snapshot_records() {
  # One conclusive process-table snapshot. Output fields are deliberately
  # delimiter-safe: pid|ppid|base64(lstart)|base64(command).
  local raw rc=0
  raw=$(TZ=UTC LC_ALL=C ps -axo pid=,ppid=,lstart=,command= 2>/dev/null) || rc=$?
  [[ "$rc" -eq 0 ]] || return 2
  printf '%s\n' "$raw" | python3 -c '
import base64,re,sys
seen=set()
pattern=re.compile(r"^\s*([0-9]+)\s+([0-9]+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+?)\s*$")
for raw in sys.stdin:
    if not raw.strip(): continue
    m=pattern.fullmatch(raw.rstrip("\n"))
    # ps renders embedded argv newlines as continuation rows without pid/lstart
    # fields. Localize those rows: they contribute no signalling authority but
    # cannot disable every unrelated, well-formed process record on the host.
    if not m: continue
    pid,ppid,start,command=m.groups()
    if pid in seen or len(pid)>12 or len(ppid)>12: raise SystemExit(2)
    seen.add(pid)
    b64=lambda value: base64.b64encode(value.encode()).decode()
    print(pid,ppid,b64(start),b64(command),sep="|")
' || return 2
}

cmux_attach_helper_records_from_snapshot() {
  # Derive helper roots from the exact snapshot used for ancestry, avoiding a
  # second ps read that could join different process incarnations. Parse the
  # whole host snapshot in ONE interpreter: a per-row python fan-out makes the
  # 60s watcher pass take minutes on a four-digit process table.
  local snapshot="$1"
  printf '%s\n' "$snapshot" | python3 -c '
import base64,os,re,shlex,sys

def parse(command):
    try:
        words=shlex.split(command)
    except ValueError:
        return None
    if not words:
        return None
    if os.path.basename(words[0]) in ("bash", "sh"):
        if len(words) < 2 or words[1].startswith(("-", "+")):
            return None
        words=words[1:]
    if len(words) not in (2, 3):
        return None
    helper=os.path.basename(words[0])
    target=words[1]
    token=words[2] if len(words) == 3 else ""
    if token and not re.fullmatch(r"fwtok1-[0-9a-f]{32}", token):
        return None
    if helper == "flywheel-view-attach.sh":
        if not target.startswith("cmux-") or any(c in target for c in "\x27\r\n"):
            return None
        kind="view"
    elif helper == "flywheel-lead-attach.sh":
        if not target.startswith("/") or any(c in target for c in "\x27\r\n"):
            return None
        kind="lead"
    else:
        return None
    return kind,target,token

for raw in sys.stdin:
    if not raw.strip():
        continue
    fields=raw.rstrip("\n").split("|")
    if len(fields) != 4:
        raise SystemExit(2)
    pid,ppid,start,encoded=fields
    if not pid.isdigit() or not ppid.isdigit():
        raise SystemExit(2)
    try:
        command=base64.b64decode(encoded,validate=True).decode()
    except Exception:
        raise SystemExit(2)
    parsed=parse(command)
    if parsed is None:
        continue
    kind,target,token=parsed
    target_b64=base64.b64encode(target.encode()).decode()
    print(pid,ppid,start,kind,target_b64,token,sep="|")
' || return 2
}

cmux_attach_helper_process_records() {
  local snapshot
  snapshot=$(cmux_process_snapshot_records) || return $?
  cmux_attach_helper_records_from_snapshot "$snapshot"
}

cmux_process_tuple_current() {
  # rc=0 same PID incarnation, rc=1 absent/reused, rc=2 process table unknown.
  local pid="$1" expected_start="$2" start rc=0 encoded
  case "$pid" in ''|*[!0-9]*) return 2 ;; esac
  start=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null) || rc=$?
  [[ "$rc" -eq 1 ]] && return 1
  [[ "$rc" -eq 0 ]] || return 2
  start=$(printf '%s' "$start" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [[ -n "$start" ]] || return 1
  encoded=$(printf '%s' "$start" | base64 | tr -d '\n') || return 2
  [[ "$encoded" == "$expected_start" ]]
}

cmux_mutator_command_matches() {
  # Match the executed argv shape, not a substring anywhere in shell prose.
  # Production exposes either the script directly or through its bash shebang.
  local cmd="$1" first="" token="" verb="" saw_script=0 i
  local -a argv=()
  read -ra argv <<< "$cmd"
  [[ ${#argv[@]} -gt 0 ]] || return 1
  first="${argv[0]}"
  case "${first##*/}" in
    flywheel-cmux-sync|flywheel-cmux-sync.sh)
      verb="${argv[1]:-}"
      ;;
    test-teardown.sh)
      return 0
      ;;
    bash|sh)
      for ((i = 1; i < ${#argv[@]}; i++)); do
        token="${argv[$i]}"
        case "$token" in
          -c|+c) return 1 ;;
          --*) ;;
          -?*|+?*)
            case "${token:1}" in *c*) return 1 ;; esac
            ;;
        esac
        case "${token##*/}" in
          flywheel-cmux-sync|flywheel-cmux-sync.sh)
            verb="${argv[$((i + 1))]:-}"
            saw_script=1
            break
            ;;
          test-teardown.sh)
            return 0
            ;;
        esac
      done
      [[ "$saw_script" == "1" ]] || return 1
      ;;
    *) return 1 ;;
  esac
  case "$verb" in
    ""|--watch|--once|--refresh|--reap-orphan-pins|--qa-teardown|--rebuild-views|--converge-runners) return 0 ;;
    *) return 1 ;;
  esac
}

cmux_process_command_for_pid() {
  # rc=0 verified command, rc=1 PID vanished, rc=2 process table unavailable.
  local pid="$1" command rc=0
  command=$(ps -o command= -p "$pid" 2>/dev/null) || rc=$?
  [[ "$rc" -eq 1 ]] && return 1
  [[ "$rc" -eq 0 ]] || return 2
  command=$(printf '%s' "$command" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [[ -n "$command" ]] || return 1
  printf '%s\n' "$command"
}

cmux_watcher_process_pids() {
  # pgrep is candidate discovery only. Signal/restart authority comes from the
  # shared argv-shape predicate above. rc=1 means no verified watcher; rc=2
  # means the census itself could not be trusted.
  local out rc=0 pid command command_rc normalized=""
  if out=$(pgrep -f 'flywheel-cmux-sync(\.sh)? +--watch' 2>/dev/null); then
    :
  else
    rc=$?
    [[ "$rc" -eq 1 ]] && return 1
    return 2
  fi
  while IFS= read -r pid; do
    case "$pid" in ''|*[!0-9]*) return 2 ;; esac
    command_rc=0
    command=$(cmux_process_command_for_pid "$pid") || command_rc=$?
    [[ "$command_rc" -eq 1 ]] && continue
    [[ "$command_rc" -eq 0 ]] || return 2
    cmux_mutator_command_matches "$command" || continue
    normalized+="${normalized:+$'\n'}${pid}"
  done <<< "$out"
  [[ -n "$normalized" ]] || return 1
  printf '%s\n' "$normalized"
}

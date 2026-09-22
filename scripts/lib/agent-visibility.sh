#!/bin/bash
# FLY-2643: read-only Lead/Runner carrier and cmux visibility evidence.

av_safe_key() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]
}

# QA5 measured successful real-host cmux proofs at 84, 88, 91, 121, and
# 158 seconds. Nearest-rank p95 is therefore 158s; the default child budget is
# rounded above p95 x 1.5 (237s), with a distinct outer verifier allowance.
AV_CMUX_TIMEOUT_MIN_SECONDS=240
AV_CMUX_TIMEOUT_DEFAULT_SECONDS=240
AV_VISIBLE_TIMEOUT_DEFAULT_SECONDS=250
av_configure_visibility_budgets() {
  local inner="${FLYWHEEL_VISIBILITY_CMUX_TIMEOUT_SECONDS:-$AV_CMUX_TIMEOUT_DEFAULT_SECONDS}"
  local outer="${FLYWHEEL_VISIBILITY_TIMEOUT_SECONDS:-$AV_VISIBLE_TIMEOUT_DEFAULT_SECONDS}"
  case "$inner:$outer" in *[!0-9:]*|:*|*:) return 1 ;; esac
  [[ "${inner:0:1}" != 0 && "${outer:0:1}" != 0 ]] || return 1
  (( inner >= AV_CMUX_TIMEOUT_MIN_SECONDS && inner <= 3600 )) || return 1
  (( outer > inner && outer <= 3600 )) || return 1
  AV_CMUX_TIMEOUT_SECONDS="$inner"
  AV_VISIBLE_TIMEOUT_SECONDS="$outer"
}

av_run() {
  "$AV_BOUNDED_RUN" 5 "$@"
}

av_run_shared_tmux() (
  unset TMUX TMUX_TMPDIR
  av_run "$AV_TMUX" "$@"
)

# flywheel-cmux-sync performs its own two-sample stability proof. Keep generic
# leaf probes at 5s while this composite probe consumes the shared measured
# real-host budget configured above.
av_run_cmux() (
  # Bridge patrol intentionally launches under env -i with a scratch HOME and
  # TMUX_TMPDIR. The state root already resolved AV_HOME authoritatively; pin
  # that identity for cmux-sync and clear inherited client/socket selectors so
  # the read-only visibility half observes the host's real cmux/tmux surfaces.
  unset TMUX TMUX_TMPDIR
  export HOME="$AV_HOME"
  export FLYWHEEL_STATE_DIR="$AV_STATE_DIR"
  "$AV_BOUNDED_RUN" "$AV_CMUX_TIMEOUT_SECONDS" "$@"
)

av_json_sample() {
  local status="$1" reason="$2" carrier_pid="$3" carrier_start="$4" socket="$5"
  local session="$6" window_id="$7" pane_id="$8" pane_pid="$9" thread_id="${10}"
  local authority="${11}" pane="${12}" body="${13}"
  jq -cn \
    --arg status "$status" --arg reason "$reason" \
    --arg carrierPid "$carrier_pid" --arg carrierStart "$carrier_start" \
    --arg socket "$socket" --arg session "$session" --arg windowId "$window_id" \
    --arg paneId "$pane_id" --arg panePid "$pane_pid" --arg threadId "$thread_id" \
    --arg authority "$authority" --arg pane "$pane" --arg body "$body" '
      {status:$status,reason:$reason,
       identity:{
         carrierPid:(if $carrierPid=="" then null else ($carrierPid|tonumber) end),
         carrierStart:(if $carrierStart=="" then null else $carrierStart end),
         socket:(if $socket=="" then null else $socket end),
         session:(if $session=="" then null else $session end),
         windowId:(if $windowId=="" then null else $windowId end),
         paneId:(if $paneId=="" then null else $paneId end),
         panePid:(if $panePid=="" then null else ($panePid|tonumber) end),
         threadId:(if $threadId=="" then null else $threadId end)},
       checks:{authority:$authority,pane:$pane,body:$body}}'
}

av_lead_authority() {
  local manifest="$AV_STATE_DIR/manifests/${AV_PROJECT}-${AV_LEAD}.json"
  local plist="$AV_HOME/Library/LaunchAgents/com.flywheel.lead.${AV_PROJECT}-${AV_LEAD}.plist"
  [[ -f "$AV_PROJECTS_FILE" && ! -L "$AV_PROJECTS_FILE" \
      && -f "$manifest" && ! -L "$manifest" \
      && -f "$plist" && ! -L "$plist" ]] || return 1
  local registry manifest_row plist_row registry_backend manifest_backend
  local wrapper wrapper_base argc arg2 effective_backend
  registry=$(av_run jq -cer --arg project "$AV_PROJECT" --arg lead "$AV_LEAD" '
    [.[] | select(.projectName==$project) | (.leads // [])[] | select(.agentId==$lead)] as $m |
    select(($m|length)==1) | $m[0] |
    {backend:(.backend // "claude-code"),profile:(.codexProfile // ""),project:$project,lead:$lead}' \
    "$AV_PROJECTS_FILE") || return 1
  manifest_row=$(av_run jq -cer --arg project "$AV_PROJECT" --arg lead "$AV_LEAD" '
    select(.projectName==$project and .leadId==$lead) |
    {backend:(.leadBackend.backendId // ""),workspace:(.workspace // .projectDir // ""),socket:(.socketPath // ""),
     capabilityVersion:(.launchEnvironment.FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION // ""),
     stateDirMap:(.launchEnvironment.FLYWHEEL_CODEX_LEAD_STATE_DIRS // "")}' \
    "$manifest") || return 1
  plist_row=$(av_run python3 -c '
import json,plistlib,sys
with open(sys.argv[1],"rb") as f: p=plistlib.load(f)
a=p.get("ProgramArguments")
if p.get("Label") != sys.argv[2] or not isinstance(a,list) or len(a)<2: raise SystemExit(1)
print(json.dumps({"wrapper":a[1],"argv":a},separators=(",",":")))' \
    "$plist" "com.flywheel.lead.${AV_PROJECT}-${AV_LEAD}") || return 1
  registry_backend=$(jq -r .backend <<<"$registry") || return 1
  manifest_backend=$(jq -r .backend <<<"$manifest_row") || return 1
  wrapper=$(jq -r .wrapper <<<"$plist_row") || return 1
  wrapper_base="${wrapper##*/}"
  argc=$(jq -r '.argv | length' <<<"$plist_row") || return 1
  case "$wrapper_base" in
    flywheel-lead-wrapper-v2.sh)
      [[ "$argc" == 3 && "$registry_backend" == claude-code ]] || return 1
      arg2=$(jq -r '.argv[2]' <<<"$plist_row") || return 1
      [[ "$arg2" == "$manifest" ]] || return 1
      effective_backend=claude-code
      ;;
    flywheel-lead.sh)
      [[ "$argc" == 3 && "$registry_backend" == codex-app-server ]] || return 1
      arg2=$(jq -r '.argv[2]' <<<"$plist_row") || return 1
      [[ "$arg2" == "$manifest" ]] || return 1
      effective_backend=codex-app-server
      ;;
    flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh)
      [[ "$argc" == 2 && "$AV_PROJECT" == growth && "$AV_LEAD" == mufasa-lead \
        && "$registry_backend" == codex-app-server ]] || return 1
      effective_backend=codex-app-server
      ;;
    flywheel-codex-lead-wrapper-codex-infra-bot.sh)
      [[ "$argc" == 2 && "$AV_PROJECT" == flywheel && "$AV_LEAD" == codex-infra-bot-lead \
        && "$registry_backend" == codex-app-server ]] || return 1
      effective_backend=codex-app-server
      ;;
    *) return 1 ;;
  esac
  [[ -z "$manifest_backend" || "$manifest_backend" == "$effective_backend" ]] || return 1
  manifest_row=$(jq -c --arg backend "$effective_backend" '.backend=$backend' <<<"$manifest_row") || return 1
  jq -cn --arg manifest "$manifest" --arg plist "$plist" \
    --argjson registry "$registry" --argjson runtime "$manifest_row" --argjson launch "$plist_row" \
    '{manifest:$manifest,plist:$plist,registry:$registry,runtime:$runtime,launch:$launch}'
}

av_launchd_pid() {
  local label="$1" out pid count rc=0
  out=$(av_run "$AV_LAUNCHCTL" print "gui/$(id -u)/$label") || rc=$?
  if [[ "$rc" != 0 ]]; then
    [[ "$rc" == 113 ]] && return 1
    return 2
  fi
  count=$(printf '%s\n' "$out" | grep -c '^[[:space:]]*pid = [1-9][0-9]*[[:space:]]*$' || true)
  [[ "$count" == 1 ]] || return 1
  pid=$(printf '%s\n' "$out" | awk '/^[[:space:]]*pid = [1-9][0-9]*[[:space:]]*$/ {print $3}')
  printf '%s\n' "$pid"
}

av_process_start() {
  local value
  value=$(LC_ALL=C av_run "$AV_PS" -p "$1" -o lstart=) || return 1
  value=$(printf '%s' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [[ -n "$value" && ${#value} -le 128 ]] || return 1
  printf '%s\n' "$value"
}

av_codex_runtime_exact() {
  local command
  command=$(av_run "$AV_PS" -p "$1" -o command=) || return 1
  av_run python3 -c '
import os,shlex,sys
try: a=shlex.split(sys.argv[1])
except ValueError: raise SystemExit(1)
suffix=os.path.normpath("/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js")
hits=[x for x in a if os.path.isabs(x) and os.path.normpath(x).endswith(suffix)]
if len(hits)!=1: raise SystemExit(1)
i=a.index(hits[0])
if i<1 or os.path.basename(a[i-1]) not in ("node","nodejs"): raise SystemExit(1)' "$command" >/dev/null
}

av_codex_state_dir() {
  local authority="$1" mapping state_dir
  [[ -n "${AV_CODEX_LAUNCHER:-}" && -f "$AV_CODEX_LAUNCHER" && ! -L "$AV_CODEX_LAUNCHER" ]] \
    || return 1
  mapping=$(jq -r '.runtime.stateDirMap | select(type == "string")' <<<"$authority") || return 1
  if [[ -n "$mapping" ]]; then
    state_dir=$(FLYWHEEL_STATE_DIR="$AV_STATE_DIR" FLYWHEEL_CODEX_LEAD_STATE_DIRS="$mapping" \
      av_run /bin/bash "$AV_CODEX_LAUNCHER" --print-state-dir "$AV_LEAD" "$AV_PROJECT") || return 1
  else
    state_dir=$(unset FLYWHEEL_CODEX_LEAD_STATE_DIRS; FLYWHEEL_STATE_DIR="$AV_STATE_DIR" \
      av_run /bin/bash "$AV_CODEX_LAUNCHER" --print-state-dir "$AV_LEAD" "$AV_PROJECT") || return 1
  fi
  av_run python3 -c '
import os,sys
p=sys.argv[1]
if not os.path.isabs(p) or "\n" in p or "\r" in p or len(os.fsencode(p))>1024: raise SystemExit(1)
print(os.path.normpath(p))' "$state_dir"
}

av_capability_app_socket() {
  local root_pid="$1" codex_bin="$2" table
  table=$(av_run "$AV_PS" -axo pid=,ppid=,command=) || return 2
  printf '%s\n' "$table" | av_run python3 -c '
import os,shlex,sys
root=int(sys.argv[1]); expected=sys.argv[2]; rows={}; children={}
for line in sys.stdin:
 p=line.strip().split(None,2)
 if len(p)!=3 or not p[0].isdigit() or not p[1].isdigit(): continue
 pid,ppid,cmd=int(p[0]),int(p[1]),p[2]
 rows[pid]=cmd; children.setdefault(ppid,[]).append(pid)
seen=set(); stack=[root]
while stack:
 parent=stack.pop()
 for child in children.get(parent,[]):
  if child not in seen: seen.add(child); stack.append(child)
matches=[]
for pid in seen:
 try: argv=shlex.split(rows.get(pid,""))
 except ValueError: continue
 if len(argv)<4 or argv[0]!=expected or argv[1]!="app-server": continue
 positions=[i for i,value in enumerate(argv) if value=="--listen"]
 if len(positions)!=1 or positions[0]+1>=len(argv): continue
 listen=argv[positions[0]+1]
 if not listen.startswith("unix:///"): continue
 socket=listen[len("unix://"):]
 if not os.path.isabs(socket) or ".." in socket.split(os.sep) or len(os.fsencode(socket))>103: continue
 matches.append(socket)
if len(matches)!=1: raise SystemExit(1)
print(matches[0])' "$root_pid" "$codex_bin" || return 1
}

av_private_body() {
  local root_pid="$1" table tuple pid
  table=$(av_run "$AV_PS" -axo pid=,ppid=,command=) || return 2
  tuple=$(printf '%s\n' "$table" | av_run python3 -c '
import os,shlex,sys
root=int(sys.argv[1]); rows=[]; children={}
for line in sys.stdin:
 p=line.strip().split(None,2)
 if len(p)!=3 or not p[0].isdigit() or not p[1].isdigit(): continue
 pid,ppid,cmd=int(p[0]),int(p[1]),p[2]; rows.append((pid,cmd)); children.setdefault(ppid,[]).append(pid)
seen=set(); stack=[root]
while stack:
 p=stack.pop()
 for child in children.get(p,[]):
  if child not in seen: seen.add(child); stack.append(child)
matches=[]
for pid,cmd in rows:
 if pid not in seen: continue
 try: argv=shlex.split(cmd)
 except ValueError: continue
 if argv and os.path.basename(argv[0]) in ("claude","claude-code"): matches.append(pid)
if len(matches)!=1: raise SystemExit(1)
print(matches[0])' "$root_pid") || return 1
  pid="$tuple"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$pid"
}

av_codex_home_for_wrapper() {
  local wrapper="$1" key
  case "${wrapper##*/}" in
    flywheel-lead.sh) key="$AV_LEAD" ;;
    flywheel-codex-lead-wrapper-mufasa-tui.sh|flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh) key=mufasa ;;
    flywheel-codex-lead-wrapper-codex-infra-bot.sh) key=infra-bot ;;
    *) return 1 ;;
  esac
  derive_codex_lead_home "$key" "$AV_HOME"
}

av_capture_lead() {
  local authority="$1" label="com.flywheel.lead.${AV_PROJECT}-${AV_LEAD}"
  local pid pid_rc=0 start backend wrapper workspace socket row pane_id pane_pid pane_start pane_start_rc=0
  pid=$(av_launchd_pid "$label") || pid_rc=$?
  if [[ "$pid_rc" == 1 ]]; then
    av_json_sample fail carrier_not_running "" "" "" "" "" "" "" "" authority_ok missing missing
    return 0
  elif [[ "$pid_rc" != 0 ]]; then
    av_json_sample inconclusive probe_unavailable "" "" "" "" "" "" "" "" authority_ok unavailable unavailable
    return 0
  fi
  start=$(av_process_start "$pid") || {
    av_json_sample inconclusive probe_unavailable "$pid" "" "" "" "" "" "" "" authority_ok unavailable unavailable
    return 0
  }
  backend=$(jq -r '.runtime.backend' <<<"$authority")
  wrapper=$(jq -r '.launch.wrapper' <<<"$authority")
  workspace=$(jq -r '.runtime.workspace' <<<"$authority")
  if [[ "$backend" == claude-code ]]; then
    socket=$(jq -r '.runtime.socket' <<<"$authority")
    local canonical body_pid body_rc=0
    canonical=$(derive_lead_socket "${AV_PROJECT}/${AV_LEAD}" "$AV_STATE_DIR") || {
      av_json_sample inconclusive authority_unavailable "$pid" "$start" "" "" "" "" "" "" unavailable unavailable unavailable
      return 0
    }
    if [[ -z "$socket" || "$socket" != "$canonical" ]]; then
      av_json_sample fail identity_mismatch "$pid" "$start" "$socket" main "" "" "" "" authority_mismatch missing missing
      return 0
    fi
    row=$(av_run "$AV_TMUX" -S "$socket" list-panes -t '%0' \
      -F '#{session_name}|#{window_id}|#{window_name}|#{pane_id}|#{pane_dead}|#{pane_pid}') || {
      av_json_sample fail missing_window "$pid" "$start" "$socket" main "" "" "" "" authority_ok missing missing
      return 0
    }
    [[ "$(printf '%s\n' "$row" | grep -c . || true)" == 1 ]] || {
      av_json_sample fail identity_mismatch "$pid" "$start" "$socket" main "" "" "" "" authority_ok ambiguous missing
      return 0
    }
    IFS='|' read -r session window_id window_name pane_id dead pane_pid < <(printf '%s\n' "$row")
    if [[ "$session" != main || "$window_name" != main || "$pane_id" != %0 || "$dead" != 0 || ! "$pane_pid" =~ ^[1-9][0-9]*$ ]]; then
      av_json_sample fail dead_pane "$pid" "$start" "$socket" "$session" "$window_id" "$pane_id" "" "" authority_ok dead missing
      return 0
    fi
    body_pid=$(av_private_body "$pane_pid") || body_rc=$?
    if [[ "$body_rc" == 1 ]]; then
      av_json_sample fail body_missing "$pid" "$start" "$socket" "$session" "$window_id" "$pane_id" "$pane_pid" "" authority_ok live missing
    elif [[ "$body_rc" != 0 ]]; then
      av_json_sample inconclusive probe_unavailable "$pid" "$start" "$socket" "$session" "$window_id" "$pane_id" "$pane_pid" "" authority_ok live unavailable
    else
      av_json_sample pass "" "$pid" "$start" "$socket" "$session" "$window_id" "$pane_id" "$pane_pid" "" authority_ok live "claude_body:$body_pid"
    fi
    return 0
  fi

  [[ "$backend" == codex-app-server ]] || {
    av_json_sample fail identity_mismatch "$pid" "$start" "" "" "" "" "" "" authority_mismatch missing missing
    return 0
  }
  av_codex_runtime_exact "$pid" || {
    av_json_sample fail identity_mismatch "$pid" "$start" "" flywheel "" "" "" "" authority_ok missing missing
    return 0
  }
  local title="${AV_PROJECT}-${AV_LEAD}" codex_home state_dir thread_file thread codex_bin capability_version capability_socket="" socket_rc=0 binding_input binding verdict binding_rc=0
  codex_home=$(av_codex_home_for_wrapper "$wrapper") || {
    av_json_sample inconclusive authority_unavailable "$pid" "$start" "" flywheel "" "" "" "" unavailable missing missing
    return 0
  }
  state_dir=$(av_codex_state_dir "$authority") || {
    av_json_sample inconclusive authority_unavailable "$pid" "$start" "" flywheel "" "" "" "" unavailable missing missing
    return 0
  }
  thread_file="$state_dir/thread-id"
  [[ -f "$thread_file" && ! -L "$thread_file" ]] || {
    av_json_sample fail identity_mismatch "$pid" "$start" "" flywheel "" "" "" "" authority_mismatch missing missing
    return 0
  }
  thread=$(av_run python3 -c '
import sys
with open(sys.argv[1],encoding="utf-8") as f: value=f.read()
value=value.strip()
if not value or len(value)>256 or not all(c.isalnum() or c=="-" for c in value): raise SystemExit(1)
print(value)' "$thread_file") || {
    av_json_sample fail identity_mismatch "$pid" "$start" "" flywheel "" "" "" "" authority_mismatch missing missing
    return 0
  }
  row=$(av_run_shared_tmux list-panes -t "=flywheel:=${title}" \
    -F '#{session_name}|#{window_id}|#{window_name}|#{pane_id}|#{pane_dead}|#{pane_pid}') || {
    av_json_sample fail missing_window "$pid" "$start" "" flywheel "" "" "" "$thread" authority_ok missing missing
    return 0
  }
  [[ "$(printf '%s\n' "$row" | grep -c . || true)" == 1 ]] || {
    av_json_sample fail identity_mismatch "$pid" "$start" "" flywheel "" "" "" "$thread" authority_ok ambiguous missing
    return 0
  }
  IFS='|' read -r session window_id window_name pane_id dead pane_pid < <(printf '%s\n' "$row")
  if [[ "$session" != flywheel || "$window_name" != "$title" || "$dead" != 0 || ! "$pane_id" =~ ^%[0-9]+$ || ! "$pane_pid" =~ ^[1-9][0-9]*$ ]]; then
    av_json_sample fail dead_pane "$pid" "$start" "" "$session" "$window_id" "$pane_id" "" "$thread" authority_ok dead missing
    return 0
  fi
  pane_start=$(av_run_shared_tmux display-message -p -t "=flywheel:=${title}" '#{pane_start_command}') || pane_start_rc=$?
  if [[ "$pane_start_rc" != 0 || -z "$pane_start" ]]; then
    av_json_sample inconclusive probe_unavailable "$pid" "$start" "" "$session" "$window_id" "$pane_id" "$pane_pid" "$thread" authority_ok live unavailable
    return 0
  fi
  codex_bin="$codex_home/packages/standalone/current/codex"
  capability_version=$(jq -r '.runtime.capabilityVersion' <<<"$authority")
  if [[ "$capability_version" == 2 ]]; then
    codex_bin=$(av_run python3 -c '
import os,sys
path=os.path.realpath(sys.argv[1])
if not os.path.isabs(path) or not os.path.isfile(path): raise SystemExit(1)
print(path)' "$codex_bin") || {
      av_json_sample inconclusive probe_unavailable "$pid" "$start" "" "$session" "$window_id" "$pane_id" "$pane_pid" "$thread" authority_ok live unavailable
      return 0
    }
    capability_socket=$(av_capability_app_socket "$pid" "$codex_bin") || socket_rc=$?
    if [[ "$socket_rc" == 2 ]]; then
      av_json_sample inconclusive probe_unavailable "$pid" "$start" "" "$session" "$window_id" "$pane_id" "$pane_pid" "$thread" authority_ok live unavailable
      return 0
    elif [[ "$socket_rc" != 0 ]]; then
      av_json_sample fail body_missing "$pid" "$start" "" "$session" "$window_id" "$pane_id" "$pane_pid" "$thread" authority_ok live missing
      return 0
    fi
    binding_input=$(jq -cn --arg observed "$pane_start" --arg home "$codex_home" --arg cwd "$workspace" \
      --arg thread "$thread" --arg bin "$codex_bin" --arg project "$AV_PROJECT" --arg lead "$AV_LEAD" --arg remote "$capability_socket" \
      '{observed:$observed,grammar:"capability-v2",capability:{codexHome:$home,cwd:$cwd,threadId:$thread,codexBin:$bin,projectName:$project,leadId:$lead,remoteSocket:$remote}}') || return 1
  else
    binding_input=$(jq -cn --arg observed "$pane_start" --arg home "$codex_home" --arg cwd "$workspace" \
      --arg thread "$thread" --arg bin "$codex_bin" \
      '{observed:$observed,grammar:"legacy",legacy:{codexHome:$home,cwd:$cwd,threadId:$thread,codexBin:$bin}}') || return 1
  fi
  [[ -f "$AV_BINDING_CLI" ]] || {
    av_json_sample inconclusive probe_unavailable "$pid" "$start" "$capability_socket" "$session" "$window_id" "$pane_id" "$pane_pid" "$thread" authority_ok live unavailable
    return 0
  }
  binding=$(printf '%s\n' "$binding_input" | av_run "$AV_NODE" "$AV_BINDING_CLI") || binding_rc=$?
  if [[ "$binding_rc" != 0 ]]; then
    verdict=$(printf '%s\n' "${binding:-}" | jq -er \
      '.reason | select(. == "identity_mismatch" or . == "unsafe_command")' \
      2>/dev/null || true)
    if [[ "$binding_rc" == 1 && -n "$verdict" ]]; then
      av_json_sample fail "$verdict" "$pid" "$start" "$capability_socket" "$session" "$window_id" "$pane_id" "$pane_pid" "$thread" authority_ok live mismatch
    else
      av_json_sample inconclusive probe_unavailable "$pid" "$start" "$capability_socket" "$session" "$window_id" "$pane_id" "$pane_pid" "$thread" authority_ok live unavailable
    fi
    return 0
  fi
  printf '%s\n' "$binding" | jq -e --arg thread "$thread" \
    'select(.ok == true and .threadId == $thread and (.grammar == "legacy" or .grammar == "capability-v2"))' \
    >/dev/null 2>&1 || {
      av_json_sample inconclusive probe_unavailable "$pid" "$start" "$capability_socket" "$session" "$window_id" "$pane_id" "$pane_pid" "$thread" authority_ok live unavailable
      return 0
    }
  av_json_sample pass "" "$pid" "$start" "$capability_socket" "$session" "$window_id" "$pane_id" "$pane_pid" "$thread" authority_ok live codex_tui
}

av_runner_row() {
  [[ -f "$AV_COMM_DB" && ! -L "$AV_COMM_DB" ]] || return 1
  av_run python3 -c '
import json,sqlite3,sys,urllib.parse
p=sys.argv[1]; eid=sys.argv[2]
db=sqlite3.connect("file:"+urllib.parse.quote(p)+"?mode=ro",uri=True)
rows=db.execute("SELECT execution_id,tmux_window,project_name,status,phase_keep_alive FROM sessions WHERE execution_id = ?",(eid,)).fetchall()
if len(rows)!=1: raise SystemExit(1)
r=rows[0]
if r[2] != sys.argv[3] or r[3] not in ("running","blocked"): raise SystemExit(1)
print(json.dumps({"executionId":r[0],"target":r[1],"project":r[2],"status":r[3],"phaseHeld":bool(r[4])},separators=(",",":")))' \
    "$AV_COMM_DB" "$AV_EXEC_ID" "$AV_PROJECT"
}

av_capture_runner() {
  local authority="$1" target target_session target_window session window_id row window_name pane_id dead pane_pid pane_exec_id start
  target=$(jq -r .target <<<"$authority")
  target_session="${target%%:*}"
  target_window="${target#*:}"
  if [[ "$target_session" == "runner-$AV_PROJECT" && "$target_window" == pending ]]; then
    av_json_sample fail missing_window "" "" "" "$target_session" "" "" "" "" authority_ok missing missing
    return 0
  fi
  if [[ "$target_session" != "runner-$AV_PROJECT" \
    || "$target_window" == "$target" \
    || ! "$target_window" =~ ^@([1-9][0-9]*)$ ]]; then
    av_json_sample fail identity_mismatch "" "" "" "" "" "" "" "" authority_mismatch missing missing
    return 0
  fi
  session="${target%%:*}"; window_id="${target#*:}"
  row=$(av_run_shared_tmux list-panes -t "$target" \
    -F '#{session_name}|#{window_id}|#{window_name}|#{pane_id}|#{pane_dead}|#{pane_pid}|#{@flywheel_exec_id}') || {
    av_json_sample fail missing_window "" "" "" "$session" "$window_id" "" "" "" authority_ok missing missing
    return 0
  }
  [[ "$(printf '%s\n' "$row" | grep -c . || true)" == 1 ]] || {
    av_json_sample fail identity_mismatch "" "" "" "$session" "$window_id" "" "" "" authority_ok ambiguous missing
    return 0
  }
  IFS='|' read -r observed_session observed_window window_name pane_id dead pane_pid pane_exec_id < <(printf '%s\n' "$row")
  if [[ "$observed_session" != "$session" || "$observed_window" != "$window_id" \
    || "$dead" != 0 || ! "$pane_pid" =~ ^[1-9][0-9]*$ ]]; then
    av_json_sample fail dead_pane "" "" "" "$session" "$window_id" "$pane_id" "" "" authority_ok dead missing
    return 0
  fi
  if [[ "$pane_exec_id" != "$AV_EXEC_ID" ]]; then
    av_json_sample fail identity_mismatch "" "" "" "$session" "$window_id" "$pane_id" "$pane_pid" "" authority_ok live mismatch
    return 0
  fi
  start=$(av_process_start "$pane_pid") || {
    av_json_sample inconclusive probe_unavailable "$pane_pid" "" "" "$session" "$window_id" "$pane_id" "$pane_pid" "" authority_ok live unavailable
    return 0
  }
  av_json_sample pass "" "$pane_pid" "$start" "" "$session" "$window_id" "$pane_id" "$pane_pid" "" authority_ok live runner_body
}

av_finish() {
  local sample1="$1" sample2="$2" cmux_status="$3" cmux_reason="$4"
  local status reason identity checks
  local first_status second_status
  first_status=$(jq -r .status <<<"$sample1"); second_status=$(jq -r .status <<<"$sample2")
  if [[ "$first_status" == fail ]]; then status=fail; reason=$(jq -r .reason <<<"$sample1")
  elif [[ "$second_status" == fail ]]; then status=fail; reason=$(jq -r .reason <<<"$sample2")
  elif [[ "$first_status" != pass || "$second_status" != pass ]]; then status=inconclusive; reason=probe_unavailable
  elif [[ "$(jq -c .identity <<<"$sample1")" != "$(jq -c .identity <<<"$sample2")" ]]; then status=inconclusive; reason=identity_drift
  elif [[ "$AV_LEVEL" == visible && "$cmux_status" != pass ]]; then status="$cmux_status"; reason="$cmux_reason"
  else status=pass; reason=""
  fi
  identity=$(jq -c .identity <<<"$sample2")
  checks=$(jq -c --arg cmux "$cmux_status" '.checks + {cmux:$cmux}' <<<"$sample2")
  jq -cn --arg kind "$AV_KIND" --arg project "$AV_PROJECT" --arg lead "$AV_LEAD" --arg exec "$AV_EXEC_ID" \
    --arg level "$AV_LEVEL" --arg status "$status" --arg reason "$reason" --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson identity "$identity" --argjson checks "$checks" '
    {schemaVersion:1,
     subject:({kind:$kind,project:$project} + (if $kind=="lead" then {leadId:$lead} else {executionId:$exec} end)),
     level:$level,status:$status,reasons:(if $reason=="" then [] else [$reason] end),observedAt:$observedAt,
     identity:$identity,checks:$checks}'
  case "$status" in pass) return 0 ;; fail) return 1 ;; *) return 2 ;; esac
}

agent_visibility_main() {
  AV_PROJECT=""; AV_LEAD=""; AV_EXEC_ID=""; AV_LEVEL=""; AV_JSON=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project|--lead|--exec-id|--level)
        [[ $# -ge 2 ]] || return 64
        case "$1" in --project) AV_PROJECT="$2" ;; --lead) AV_LEAD="$2" ;; --exec-id) AV_EXEC_ID="$2" ;; --level) AV_LEVEL="$2" ;; esac
        shift 2 ;;
      --json) [[ "$AV_JSON" == 0 ]] || return 64; AV_JSON=1; shift ;;
      *) return 64 ;;
    esac
  done
  av_safe_key "$AV_PROJECT" || return 64
  case "$AV_LEVEL" in carrier|visible) ;; *) return 64 ;; esac
  if [[ -n "$AV_LEAD" && -z "$AV_EXEC_ID" ]]; then
    av_safe_key "$AV_LEAD" || return 64; AV_KIND=lead
  elif [[ -z "$AV_LEAD" && "$AV_EXEC_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
    AV_KIND=runner
  else return 64
  fi

  AV_HOME="${HOME:?}"; AV_STATE_DIR="${FLYWHEEL_STATE_DIR:-$AV_HOME/.flywheel}"
  case "$AV_STATE_DIR" in
    /*/.flywheel) AV_HOME="${AV_STATE_DIR%/.flywheel}" ;;
  esac
  AV_PROJECTS_FILE="$AV_STATE_DIR/projects.json"
  AV_COMM_DB="${FLYWHEEL_COMM_DB:-$AV_STATE_DIR/comm/$AV_PROJECT/comm.db}"
  AV_BOUNDED_RUN="${FLYWHEEL_VISIBILITY_BOUNDED_RUN:-$AV_SCRIPT_DIR/lib/bounded-run.sh}"
  AV_TMUX="${FLYWHEEL_VISIBILITY_TMUX:-tmux}"
  AV_PS="${FLYWHEEL_VISIBILITY_PS:-ps}"
  AV_LAUNCHCTL="${FLYWHEEL_VISIBILITY_LAUNCHCTL:-launchctl}"
  AV_NODE="${FLYWHEEL_VISIBILITY_NODE:-node}"
  local binding_default="$AV_STATE_DIR/bin/verify-agent-tui-binding" codex_launcher_default=""
  local host_root="" env_root="${FLYWHEEL_DIR:-}"
  case "$env_root" in /*) ;; *) env_root="" ;; esac
  if [[ -f "$AV_STATE_DIR/host.json" && ! -L "$AV_STATE_DIR/host.json" ]]; then
    host_root=$(jq -er '.flywheelDir | select(type=="string")' "$AV_STATE_DIR/host.json" 2>/dev/null || true)
    case "$host_root" in
      /*) ;;
      '~/'*) host_root="$AV_HOME/${host_root#\~/}" ;;
      *) host_root="" ;;
    esac
  fi
  for candidate in \
    "$AV_SCRIPT_DIR/../packages/teamlead/dist/bin/verify-agent-tui-binding.js" \
    "$AV_SCRIPT_DIR/../node_modules/flywheel-teamlead/dist/bin/verify-agent-tui-binding.js" \
    "${env_root:+$env_root/packages/teamlead/dist/bin/verify-agent-tui-binding.js}" \
    "${env_root:+$env_root/node_modules/flywheel-teamlead/dist/bin/verify-agent-tui-binding.js}" \
    "${host_root:+$host_root/packages/teamlead/dist/bin/verify-agent-tui-binding.js}" \
    "${host_root:+$host_root/node_modules/flywheel-teamlead/dist/bin/verify-agent-tui-binding.js}" \
    "$AV_HOME/Dev/flywheel/packages/teamlead/dist/bin/verify-agent-tui-binding.js"; do
    [[ -n "$candidate" && -f "$candidate" ]] && { binding_default="$candidate"; break; }
  done
  AV_BINDING_CLI="${FLYWHEEL_VISIBILITY_BINDING_CLI:-$binding_default}"
  for candidate in \
    "$AV_SCRIPT_DIR/../packages/teamlead/scripts/codex-lead.sh" \
    "$AV_SCRIPT_DIR/../node_modules/flywheel-teamlead/scripts/codex-lead.sh" \
    "${env_root:+$env_root/packages/teamlead/scripts/codex-lead.sh}" \
    "${env_root:+$env_root/node_modules/flywheel-teamlead/scripts/codex-lead.sh}" \
    "${host_root:+$host_root/packages/teamlead/scripts/codex-lead.sh}" \
    "${host_root:+$host_root/node_modules/flywheel-teamlead/scripts/codex-lead.sh}" \
    "$AV_HOME/Dev/flywheel/packages/teamlead/scripts/codex-lead.sh"; do
    [[ -n "$candidate" && -f "$candidate" && ! -L "$candidate" ]] \
      && { codex_launcher_default="$candidate"; break; }
  done
  AV_CODEX_LAUNCHER="${FLYWHEEL_VISIBILITY_CODEX_LAUNCHER:-$codex_launcher_default}"
  AV_CMUX_SYNC="${FLYWHEEL_VISIBILITY_CMUX_SYNC:-$AV_STATE_DIR/bin/flywheel-cmux-sync}"
  [[ -x "$AV_BOUNDED_RUN" ]] || return 2
  av_configure_visibility_budgets || return 2
  # shellcheck source=lead-address.sh
  source "$AV_SCRIPT_DIR/lib/lead-address.sh" || return 2

  local authority sample1 sample2 sample_seconds=5 cmux_status=not_requested cmux_reason="" cmux_json cmux_rc=0 output rc=0 visible_target
  if [[ "$AV_KIND" == lead ]]; then
    authority=$(av_lead_authority) || {
      sample1=$(av_json_sample inconclusive authority_unavailable "" "" "" "" "" "" "" "" unavailable unavailable unavailable)
      sample2="$sample1"
    }
    if [[ -n "${authority:-}" ]]; then sample1=$(av_capture_lead "$authority"); fi
  else
    authority=$(av_runner_row) || {
      sample1=$(av_json_sample fail inactive_or_unknown_execution "" "" "" "" "" "" "" "" missing missing missing)
      sample2="$sample1"
    }
    if [[ -n "${authority:-}" ]]; then sample1=$(av_capture_runner "$authority"); fi
  fi
  if [[ -z "${sample2:-}" ]]; then
    if [[ -n "${FLYWHEEL_VISIBILITY_SAMPLE_SECONDS:-}" && "$AV_STATE_DIR" == /tmp/* ]]; then
      case "$FLYWHEEL_VISIBILITY_SAMPLE_SECONDS" in [0-5]) sample_seconds="$FLYWHEEL_VISIBILITY_SAMPLE_SECONDS" ;; esac
    fi
    sleep "$sample_seconds"
    if [[ "$AV_KIND" == lead ]]; then sample2=$(av_capture_lead "$authority"); else sample2=$(av_capture_runner "$authority"); fi
  fi
  if [[ "$AV_LEVEL" == visible && "$(jq -r .status <<<"$sample1")" == pass && "$(jq -r .status <<<"$sample2")" == pass ]]; then
    if [[ "$AV_KIND" == lead ]]; then
      visible_target="${AV_PROJECT}-${AV_LEAD}"
    else
      visible_target=$(av_run_shared_tmux display-message -p -t "$(jq -r .target <<<"$authority")" '#{window_name}') || visible_target=""
      av_safe_key "$visible_target" || {
        cmux_status=inconclusive; cmux_reason=probe_unavailable; visible_target=""
      }
    fi
    if [[ -n "$visible_target" ]]; then
      cmux_json=$(av_run_cmux "$AV_CMUX_SYNC" --verify-agent-visible --target "$visible_target" --json) || cmux_rc=$?
    else
      cmux_rc=2; cmux_json='{"reasons":["probe_unavailable"]}'
    fi
    case "$cmux_rc" in
      0) cmux_status=pass; cmux_reason="" ;;
      124) cmux_status=fail; cmux_reason=visibility_timeout ;;
      1)
        if jq -e '.status == "fail" and (.reasons | type == "array") and (.reasons[0] | type == "string" and length > 0)' \
          <<<"$cmux_json" >/dev/null 2>&1; then
          cmux_status=fail
          cmux_reason=$(jq -r '.reasons[0]' <<<"$cmux_json")
        else
          cmux_status=inconclusive
          cmux_reason=probe_unavailable
        fi
        ;;
      *)
        cmux_status=inconclusive
        cmux_reason=$(printf '%s\n' "${cmux_json:-}" | jq -r '.reasons[0] // empty' 2>/dev/null || true)
        [[ -n "$cmux_reason" ]] || cmux_reason=probe_unavailable
        ;;
    esac
  elif [[ "$AV_LEVEL" == visible ]]; then cmux_status=not_reached
  fi
  output=$(av_finish "$sample1" "$sample2" "$cmux_status" "$cmux_reason") || rc=$?
  if [[ "$AV_JSON" == 1 ]]; then printf '%s\n' "$output"; else jq -r '"\(.status | ascii_upcase) \(.subject.kind) \(.subject.project) reasons=\(.reasons|join(","))"' <<<"$output"; fi
  return "$rc"
}

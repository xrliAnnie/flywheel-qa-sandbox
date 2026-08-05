#!/bin/bash
# FLY-1634: bounded Lead body hard-clear. Source-only, bash 3.2 safe.
#
# There is deliberately one verdict: after TERM/KILL, no executable body owned
# by the target identity remains. Transient sensor failures are retried and do
# not latch a failed result. A persistent sensor failure still fails closed.

lead_body_process_start_identity() {
  tmux_supervisor_process_start_identity "$1"
}

lead_body_process_command() {
  ps -p "$1" -o command= 2>/dev/null
}

lead_body_process_state() {
  ps -p "$1" -o state= 2>/dev/null
}

lead_body_process_table() {
  LC_ALL=C ps -axo pid=,command= 2>/dev/null
}

lead_body_process_parent_table() {
  LC_ALL=C ps -axo pid=,ppid= 2>/dev/null
}

lead_body_process_alive() {
  kill -0 "$1" 2>/dev/null
}

lead_body_signal() {
  kill "-$1" "$2" 2>/dev/null
}

lead_body_sleep() {
  sleep "$1"
}

_sweep_tmux() {
  if [ -n "${FLYWHEEL_TMUX_SOCKET_OVERRIDE:-}" ]; then
    tmux -S "$FLYWHEEL_TMUX_SOCKET_OVERRIDE" "$@"
  else
    tmux "$@"
  fi
}

# Inventory stays session-scoped. `list-panes -a` would admit QA/Runner
# sessions with a same-named window into a production restart.
lead_body_pane_inventory() {
  local raw="" raw_rc=0
  local window_id window_name pane_id pane_pid pane_dead
  raw="$(_sweep_tmux list-panes -s -t =flywheel \
    -F '#{window_id}|#{window_name}|#{pane_id}|#{pane_pid}|#{pane_dead}' 2>/dev/null)" \
    || raw_rc=$?
  [ "$raw_rc" -eq 0 ] || return "$raw_rc"
  while IFS='|' read -r window_id window_name pane_id pane_pid pane_dead; do
    [ -n "$window_id$window_name$pane_id$pane_pid$pane_dead" ] || continue
    case "$window_id" in @|@*[!0-9]*|"") return 2 ;; @*) ;; *) return 2 ;; esac
    [ -n "$window_name" ] || return 2
    case "$pane_id" in %|%*[!0-9]*|"") return 2 ;; %*) ;; *) return 2 ;; esac
    case "$pane_pid" in ''|0|*[!0-9]*) return 2 ;; esac
    case "$pane_dead" in 0|1) ;; *) return 2 ;; esac
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "$window_id" "$window_name" "$pane_id" "$pane_pid" "$pane_dead"
  done <<EOF
$raw
EOF
}

# rc: 0 exact executable tuple; 1 dead/reused/zombie; 2 sensor failure.
_lead_body_tuple_state() {
  local pid="$1" expected_start="$2" actual_start="" raw_state="" state=""
  case "$pid" in ''|0|*[!0-9]*) return 1 ;; esac
  lead_body_process_alive "$pid" || return 1
  actual_start="$(lead_body_process_start_identity "$pid")" || {
    lead_body_process_alive "$pid" || return 1
    return 2
  }
  [ -n "$actual_start" ] || {
    lead_body_process_alive "$pid" || return 1
    return 2
  }
  raw_state="$(lead_body_process_state "$pid")" || {
    lead_body_process_alive "$pid" || return 1
    return 2
  }
  state="$(printf '%s\n' "$raw_state" | awk 'NF { print substr($1, 1, 1); exit }')"
  [ -n "$state" ] || {
    lead_body_process_alive "$pid" || return 1
    return 2
  }
  [ "$state" = Z ] && return 1
  [ "$actual_start" = "$expected_start" ] && return 0
  return 1
}

lead_body_rules_receipt_path() {
  local project="$1" lead_id="$2"
  local state_dir="${LEAD_BODY_RULES_STATE_DIR:-${HOME}/.flywheel/lead-rules-bundles}"
  printf '%s/%s-%s.active.json\n' "$state_dir" "$project" "$lead_id"
}

_lead_body_claude_append_targets() {
  local command="$1" token="" target="" targets="" had_noglob=0
  case "$-" in *f*) had_noglob=1 ;; *) set -f ;; esac
  # shellcheck disable=SC2086
  set -- $command
  [ "$had_noglob" -eq 1 ] || set +f
  while [ "$#" -gt 0 ]; do
    token="$1"; shift
    case "$token" in
      --append-system-prompt-file)
        [ "$#" -gt 0 ] || return 1
        target="$1"; shift
        ;;
      --append-system-prompt-file=*) target="${token#--append-system-prompt-file=}" ;;
      *) continue ;;
    esac
    [ -n "$target" ] || return 1
    case "$target" in *$'\n'*|*$'\t'*|*" "*) return 1 ;; esac
    targets="${targets}${target}"$'\n'
  done
  [ -n "$targets" ] || return 1
  printf '%s' "$targets"
}

_lead_body_legacy_receipt_matches() {
  local actual_targets="$1" project="$2" lead_id="$3" receipt expected_targets
  receipt="$(lead_body_rules_receipt_path "$project" "$lead_id")" || return 1
  [ -f "$receipt" ] && [ ! -L "$receipt" ] || return 1
  expected_targets="$(jq -er '
    if .mode == "legacy"
      and (.pid | type == "number" and . > 0 and floor == .)
      and (.supervisorStart | type == "string" and length > 0)
      and (.role | type == "string" and length > 0)
      and (.appendTargets | type == "array" and length > 0)
      and all(.appendTargets[]; type == "string" and test("^[A-Za-z0-9._/-]+$"))
      and (.selectedSources | type == "array")
      and (.files == (.appendTargets | length))
      and ([.selectedSources[] | .path] == .appendTargets)
    then .appendTargets[] else error("invalid legacy rules receipt") end
  ' "$receipt" 2>/dev/null)" || return 1
  [ "$actual_targets" = "$expected_targets" ]
}

_lead_body_claude_project_matches() {
  local command="$1" project="$2" lead_id="$3" targets target base
  lead_identity_command_matches "$command" "$lead_id" || return 1
  targets="$(_lead_body_claude_append_targets "$command")" || return 1
  while IFS= read -r target; do
    [ -n "$target" ] || return 1
    base="${target##*/}"
    case "$base" in "${project}-${lead_id}."*) return 0 ;; esac
  done <<EOF
$targets
EOF
  _lead_body_legacy_receipt_matches "$targets" "$project" "$lead_id"
}

lead_body_codex_command_matches() {
  local command="$1" executable token value
  local seen_remote=0 seen_cwd=0 seen_sandbox=0 seen_policy=0 seen_thread=0
  local had_noglob=0
  case "$-" in *f*) had_noglob=1 ;; *) set -f ;; esac
  # shellcheck disable=SC2086
  set -- $command
  [ "$had_noglob" -eq 1 ] || set +f
  [ "$#" -ge 2 ] || return 1
  executable="${1##*/}"; [ "$executable" = codex ] || return 1; shift
  [ "${1:-}" = resume ] || return 1; shift
  while [ "$#" -gt 0 ]; do
    token="$1"; shift
    case "$token" in
      --remote)
        [ "$#" -gt 0 ] || return 1
        value="$1"; shift
        case "$value" in unix://*/app-server-control/app-server-control.sock) seen_remote=1 ;; *) return 1 ;; esac
        ;;
      --remote=unix://*/app-server-control/app-server-control.sock) seen_remote=1 ;;
      -C) [ "$#" -gt 0 ] && [ -n "$1" ] || return 1; shift; seen_cwd=1 ;;
      -s)
        [ "$#" -gt 0 ] || return 1
        case "$1" in read-only|workspace-write) seen_sandbox=1 ;; *) return 1 ;; esac
        shift
        ;;
      -c)
        [ "$#" -gt 0 ] || return 1
        value="$1"; shift
        value="${value#\'}"; value="${value%\'}"
        value="${value#\"}"; value="${value%\"}"; value="${value//\"/}"
        [ "$value" = approval_policy=never ] || return 1
        seen_policy=1
        ;;
      -*) return 1 ;;
      *) [ -n "$token" ] && [ "$#" -eq 0 ] || return 1; seen_thread=1 ;;
    esac
  done
  [ "$seen_remote" -eq 1 ] && [ "$seen_cwd" -eq 1 ] \
    && [ "$seen_sandbox" -eq 1 ] && [ "$seen_policy" -eq 1 ] \
    && [ "$seen_thread" -eq 1 ]
}

_lead_body_command_proof() {
  local command="$1" project="$2" lead_id="$3" backend="$4"
  case "$backend" in
    claude-code) _lead_body_claude_project_matches "$command" "$project" "$lead_id" ;;
    codex-app-server) lead_body_codex_command_matches "$command" ;;
    *) return 1 ;;
  esac
}

_lead_body_session_identity() {
  local command="$1" token session_id="" seen=0 had_noglob=0
  case "$-" in *f*) had_noglob=1 ;; *) set -f ;; esac
  # shellcheck disable=SC2086
  set -- $command
  [ "$had_noglob" -eq 1 ] || set +f
  while [ "$#" -gt 0 ]; do
    token="$1"; shift
    case "$token" in
      --session-id|--resume) [ "$#" -gt 0 ] || return 1; session_id="$1"; shift; seen=$((seen + 1)) ;;
      --session-id=*|--resume=*) session_id="${token#*=}"; seen=$((seen + 1)) ;;
    esac
  done
  [ "$seen" -eq 1 ] && [ -n "$session_id" ] || return 1
  case "$session_id" in *[!A-Za-z0-9-]*) return 1 ;; esac
  printf '%s\n' "$session_id"
}

_lead_body_target_windows() {
  local project="$1" lead_id="$2" inventory="" rc=0
  local window_id window_name pane_id pane_pid pane_dead
  inventory="$(lead_body_pane_inventory)" || rc=$?
  [ "$rc" -eq 0 ] || return 2
  while IFS=$'\t' read -r window_id window_name pane_id pane_pid pane_dead; do
    [ "$window_name" = "${project}-${lead_id}" ] || continue
    printf '%s\t%s\t%s\n' "$window_id" "$pane_pid" "$pane_dead"
  done <<EOF
$inventory
EOF
  return 0
}

_lead_body_claude_tuples() {
  local project="$1" lead_id="$2" snapshot="" rc=0 pid command start tuple_rc
  snapshot="$(lead_body_process_table)" || rc=$?
  [ "$rc" -eq 0 ] || return 2
  while read -r pid command; do
    case "$pid" in ''|0|*[!0-9]*) continue ;; esac
    _lead_body_claude_project_matches "$command" "$project" "$lead_id" || continue
    start="$(lead_body_process_start_identity "$pid")" || {
      lead_body_process_alive "$pid" && return 2
      continue
    }
    tuple_rc=0
    _lead_body_tuple_state "$pid" "$start" || tuple_rc=$?
    [ "$tuple_rc" -eq 2 ] && return 2
    [ "$tuple_rc" -eq 0 ] && printf '%s\t%s\n' "$pid" "$start"
  done <<EOF
$snapshot
EOF
  return 0
}

_lead_body_codex_tuples() {
  local windows="$1" parents="" rc=0 pids="" changed=1
  local window_id pane_pid pane_dead pid ppid _rest start
  while IFS=$'\t' read -r window_id pane_pid pane_dead; do
    [ -n "$window_id" ] || continue
    [ "$pane_dead" = 0 ] || continue
    case " $pids " in *" $pane_pid "*) ;; *) pids="${pids} ${pane_pid}" ;; esac
  done <<EOF
$windows
EOF
  parents="$(lead_body_process_parent_table)" || rc=$?
  [ "$rc" -eq 0 ] || return 2
  while [ "$changed" -eq 1 ]; do
    changed=0
    while read -r pid ppid _rest; do
      case "$pid:$ppid" in *[!0-9:]*) continue ;; esac
      case " $pids " in
        *" $pid "*) ;;
        *)
          case " $pids " in *" $ppid "*) pids="${pids} ${pid}"; changed=1 ;; esac
          ;;
      esac
    done <<EOF
$parents
EOF
  done
  for pid in $pids; do
    start="$(lead_body_process_start_identity "$pid")" || {
      lead_body_process_alive "$pid" && return 2
      continue
    }
    printf '%s\t%s\n' "$pid" "$start"
  done
  return 0
}

_lead_body_signal_tuples() {
  local tuples="$1" signal="$2" pid start tuple_rc
  while IFS=$'\t' read -r pid start; do
    [ -n "$pid" ] || continue
    tuple_rc=0
    _lead_body_tuple_state "$pid" "$start" || tuple_rc=$?
    case "$tuple_rc" in
      0) lead_body_signal "$signal" "$pid" || true ;;
      1) ;;
      *) return 2 ;;
    esac
  done <<EOF
$tuples
EOF
}

_lead_body_kill_windows() {
  local windows="$1" seen="" window_id pane_pid pane_dead
  while IFS=$'\t' read -r window_id pane_pid pane_dead; do
    [ -n "$window_id" ] || continue
    case " $seen " in *" $window_id "*) continue ;; esac
    seen="${seen} ${window_id}"
    _sweep_tmux kill-window -t "=${window_id}" >/dev/null 2>&1 || true
  done <<EOF
$windows
EOF
}

# rc: 0 clear, 1 executable target remains, 2 sensor failure.
_lead_body_restart_observe() {
  local project="$1" lead_id="$2" backend="$3" codex_tuples="$4"
  local windows="" tuples="" rc=0 pid start tuple_rc saw_alive=0
  windows="$(_lead_body_target_windows "$project" "$lead_id")" || rc=$?
  [ "$rc" -eq 0 ] || return 2
  [ -z "$windows" ] || saw_alive=1
  if [ "$backend" = claude-code ]; then
    tuples="$(_lead_body_claude_tuples "$project" "$lead_id")" || rc=$?
    [ "$rc" -eq 0 ] || return 2
    [ -z "$tuples" ] || saw_alive=1
  else
    while IFS=$'\t' read -r pid start; do
      [ -n "$pid" ] || continue
      tuple_rc=0
      _lead_body_tuple_state "$pid" "$start" || tuple_rc=$?
      [ "$tuple_rc" -eq 2 ] && return 2
      [ "$tuple_rc" -eq 0 ] && saw_alive=1
    done <<EOF
$codex_tuples
EOF
  fi
  [ "$saw_alive" -eq 0 ]
}

_lead_body_clear_archive() {
  local project="$1" lead_id="$2"
  local archive="${HOME}/.flywheel/pids/${project}-${lead_id}.claude.tmux"
  rm -f "$archive" 2>/dev/null
}

_lead_body_hard_clear_exact() {
  local project="$1" lead_id="$2" backend="$3" pid="$4" start="$5"
  local command="" tuple_rc=0 attempt=0
  local term_attempts="${LEAD_BODY_CLEAR_TERM_ATTEMPTS:-10}"
  local kill_attempts="${LEAD_BODY_CLEAR_KILL_ATTEMPTS:-10}"
  local interval="${LEAD_BODY_CLEAR_INTERVAL:-0.5}"
  _lead_body_tuple_state "$pid" "$start" || tuple_rc=$?
  [ "$tuple_rc" -eq 1 ] && { _lead_body_clear_archive "$project" "$lead_id"; return; }
  [ "$tuple_rc" -eq 0 ] || return 2
  command="$(lead_body_process_command "$pid")" || return 2
  case "$backend" in
    claude-code) lead_identity_command_matches "$command" "$lead_id" || return 2 ;;
    codex-app-server) lead_body_codex_command_matches "$command" || return 2 ;;
    *) return 2 ;;
  esac
  lead_body_signal TERM "$pid" || true
  while [ "$attempt" -lt "$term_attempts" ]; do
    tuple_rc=0
    _lead_body_tuple_state "$pid" "$start" || tuple_rc=$?
    [ "$tuple_rc" -eq 1 ] && { _lead_body_clear_archive "$project" "$lead_id"; return; }
    lead_body_sleep "$interval"
    attempt=$((attempt + 1))
  done
  lead_body_signal KILL "$pid" || true
  attempt=0
  while [ "$attempt" -lt "$kill_attempts" ]; do
    tuple_rc=0
    _lead_body_tuple_state "$pid" "$start" || tuple_rc=$?
    [ "$tuple_rc" -eq 1 ] && { _lead_body_clear_archive "$project" "$lead_id"; return; }
    lead_body_sleep "$interval"
    attempt=$((attempt + 1))
  done
  return 1
}

# Usage: lead_body_hard_clear <project> <lead_id> <backend> [pid lstart]
lead_body_hard_clear() {
  local project="$1" lead_id="$2" backend="$3"
  local expected_pid="${4:-}" expected_start="${5:-}"
  local windows="" tuples="" codex_tuples="" rc=0 attempt=0 observe_rc=0
  local term_attempts="${LEAD_BODY_CLEAR_TERM_ATTEMPTS:-10}"
  local kill_attempts="${LEAD_BODY_CLEAR_KILL_ATTEMPTS:-10}"
  local interval="${LEAD_BODY_CLEAR_INTERVAL:-0.5}"
  case "$backend" in claude-code|codex-app-server) ;; *) return 2 ;; esac
  if [ -n "$expected_pid$expected_start" ]; then
    [ -n "$expected_pid" ] && [ -n "$expected_start" ] || return 2
    _lead_body_hard_clear_exact \
      "$project" "$lead_id" "$backend" "$expected_pid" "$expected_start"
    return
  fi

  # No mutation until a complete initial target census succeeds.
  while [ "$attempt" -lt "$((term_attempts + kill_attempts))" ]; do
    rc=0
    windows="$(_lead_body_target_windows "$project" "$lead_id")" || rc=$?
    if [ "$rc" -eq 0 ]; then
      if [ "$backend" = claude-code ]; then
        tuples="$(_lead_body_claude_tuples "$project" "$lead_id")" || rc=$?
      else
        codex_tuples="$(_lead_body_codex_tuples "$windows")" || rc=$?
        tuples="$codex_tuples"
      fi
    fi
    [ "$rc" -eq 0 ] && break
    lead_body_sleep "$interval"
    attempt=$((attempt + 1))
  done
  [ "$rc" -eq 0 ] || return 2
  _lead_body_kill_windows "$windows"
  _lead_body_signal_tuples "$tuples" TERM || true

  attempt=0
  while [ "$attempt" -lt "$term_attempts" ]; do
    observe_rc=0
    _lead_body_restart_observe "$project" "$lead_id" "$backend" "$codex_tuples" \
      || observe_rc=$?
    [ "$observe_rc" -eq 0 ] && { _lead_body_clear_archive "$project" "$lead_id"; return; }
    lead_body_sleep "$interval"
    attempt=$((attempt + 1))
  done

  rc=0
  windows="$(_lead_body_target_windows "$project" "$lead_id")" || rc=$?
  if [ "$backend" = claude-code ]; then
    tuples="$(_lead_body_claude_tuples "$project" "$lead_id")" || rc=$?
  else
    tuples="$codex_tuples"
  fi
  [ "$rc" -eq 0 ] || return 2
  _lead_body_kill_windows "$windows"
  _lead_body_signal_tuples "$tuples" KILL || true

  attempt=0
  while [ "$attempt" -lt "$kill_attempts" ]; do
    observe_rc=0
    _lead_body_restart_observe "$project" "$lead_id" "$backend" "$codex_tuples" \
      || observe_rc=$?
    [ "$observe_rc" -eq 0 ] && { _lead_body_clear_archive "$project" "$lead_id"; return; }
    lead_body_sleep "$interval"
    attempt=$((attempt + 1))
  done
  [ "$observe_rc" -eq 2 ] && return 2
  return 1
}

#!/bin/bash
# FLY-1507: identity-proven Lead body inventory, termination, and newborn
# verification. Source-only; bash 3.2 safe; installs no traps or shell options.

lead_body_process_start_identity() {
  tmux_supervisor_process_start_identity "$1"
}

lead_body_process_command() {
  ps -p "$1" -o command= 2>/dev/null
}

lead_body_process_table() {
  LC_ALL=C ps -axo pid=,command= 2>/dev/null
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

# Inventory is deliberately session-scoped. `list-panes -a` ignores its target
# and would let a QA/Runner session with the same window name enter the sweep.
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

_lead_body_header_value() {
  local file="$1" key="$2"
  sed -n "s/^#${key}=//p" "$file" 2>/dev/null | head -1
}

_lead_body_status_complete() {
  [ "$(_lead_body_header_value "$1" status)" = "complete" ]
}

_lead_body_tuple_state() {
  # rc 0 = exact tuple alive; 1 = determined dead/reused; 2 = sensor failure.
  local pid="$1" expected_start="$2" actual_start
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  lead_body_process_alive "$pid" || return 1
  actual_start="$(lead_body_process_start_identity "$pid")" || {
    lead_body_process_alive "$pid" || return 1
    return 2
  }
  if [ -z "$actual_start" ]; then
    lead_body_process_alive "$pid" || return 1
    return 2
  fi
  [ "$actual_start" = "$expected_start" ] && return 0
  return 1
}

lead_body_rules_receipt_path() {
  local project="$1" lead_id="$2"
  local state_dir="${LEAD_BODY_RULES_STATE_DIR:-${HOME}/.flywheel/lead-rules-bundles}"
  printf '%s/%s-%s.active.json\n' "$state_dir" "$project" "$lead_id"
}

_lead_body_claude_append_targets() {
  local command="$1" token="" target="" targets=""
  local had_noglob=0
  case "$-" in *f*) had_noglob=1 ;; *) set -f ;; esac
  # shellcheck disable=SC2086
  set -- $command
  [ "$had_noglob" -eq 1 ] || set +f
  while [ "$#" -gt 0 ]; do
    token="$1"
    shift
    case "$token" in
      --append-system-prompt-file)
        [ "$#" -gt 0 ] || return 1
        target="$1"
        shift
        ;;
      --append-system-prompt-file=*)
        target="${token#--append-system-prompt-file=}"
        ;;
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
  local actual_targets="$1" project="$2" lead_id="$3"
  local receipt expected_targets
  receipt="$(lead_body_rules_receipt_path "$project" "$lead_id")" || return 1
  [ -f "$receipt" ] && [ ! -L "$receipt" ] || return 1
  expected_targets="$(jq -er '
    if .mode == "legacy"
      and (.pid | type == "number" and . > 0 and floor == .)
      and (.supervisorStart | type == "string" and length > 0)
      and (.role | type == "string" and length > 0)
      and (.appendTargets | type == "array" and length > 0)
      and all(.appendTargets[];
        type == "string" and test("^[A-Za-z0-9._/-]+$"))
      and (.selectedSources | type == "array")
      and (.files == (.appendTargets | length))
      and ([.selectedSources[] | .path] == .appendTargets)
    then .appendTargets[]
    else error("invalid legacy rules receipt")
    end
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
  # Full proof for the production windowed Codex TUI only. A bare `codex`
  # process is not enough authority to signal or clear a whole tmux window.
  local command="$1" executable token value
  local seen_remote=0 seen_cwd=0 seen_sandbox=0 seen_policy=0 seen_thread=0
  local had_noglob=0
  case "$-" in *f*) had_noglob=1 ;; *) set -f ;; esac
  # shellcheck disable=SC2086
  set -- $command
  [ "$had_noglob" -eq 1 ] || set +f
  [ "$#" -ge 2 ] || return 1
  executable="${1##*/}"
  [ "$executable" = "codex" ] || return 1
  shift
  [ "${1:-}" = "resume" ] || return 1
  shift
  while [ "$#" -gt 0 ]; do
    token="$1"
    shift
    case "$token" in
      --remote)
        [ "$#" -gt 0 ] || return 1
        value="$1"; shift
        case "$value" in unix://*/app-server-control/app-server-control.sock) seen_remote=1 ;; *) return 1 ;; esac
        ;;
      --remote=unix://*/app-server-control/app-server-control.sock) seen_remote=1 ;;
      -C)
        [ "$#" -gt 0 ] && [ -n "$1" ] || return 1
        shift
        seen_cwd=1
        ;;
      -s)
        [ "$#" -gt 0 ] || return 1
        case "$1" in read-only|workspace-write) seen_sandbox=1 ;; *) return 1 ;; esac
        shift
        ;;
      -c)
        [ "$#" -gt 0 ] || return 1
        value="$1"; shift
        value="${value#\'}"; value="${value%\'}"
        value="${value#\"}"; value="${value%\"}"
        value="${value//\"/}"
        [ "$value" = "approval_policy=never" ] || return 1
        seen_policy=1
        ;;
      -*)
        return 1
        ;;
      *)
        [ -n "$token" ] || return 1
        seen_thread=1
        [ "$#" -eq 0 ] || return 1
        ;;
    esac
  done
  [ "$seen_remote" -eq 1 ] && [ "$seen_cwd" -eq 1 ] \
    && [ "$seen_sandbox" -eq 1 ] && [ "$seen_policy" -eq 1 ] \
    && [ "$seen_thread" -eq 1 ]
}

_lead_body_command_proof() {
  local command="$1" project="$2" lead_id="$3" backend="$4"
  case "$backend" in
    claude-code)
      _lead_body_claude_project_matches "$command" "$project" "$lead_id"
      ;;
    codex-app-server)
      lead_body_codex_command_matches "$command"
      ;;
    *)
      return 1
      ;;
  esac
}

_lead_body_add_row() {
  local file="$1" pid="$2" start="$3" proof="$4" source="$5" window_id="$6" pane_id="$7"
  [ -n "$pid" ] || pid="-"
  [ -n "$start" ] || start="-"
  [ -n "$window_id" ] || window_id="-"
  [ -n "$pane_id" ] || pane_id="-"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$pid" "$start" "$proof" "$source" "$window_id" "$pane_id" >> "$file"
}

_lead_body_normalize_rows() {
  local raw="$1" out="$2"
  awk -F '\t' '
    NF >= 6 {
      key = ($1 == "-" ? "pane:" $5 ":" $6 : "pid:" $1)
      if (!(key in seen)) {
        seen[key] = ++count
        order[count] = key
        row[key] = $0
        proof[key] = $3
      } else if ($3 == "detect" && proof[key] != "detect") {
        row[key] = $0
        proof[key] = "detect"
      }
    }
    END {
      for (i = 1; i <= count; i++) print row[order[i]]
    }
  ' "$raw" >> "$out"
}

# Output format:
#   metadata headers, then:
#   pid<TAB>lstart<TAB>proof<TAB>source<TAB>window_id<TAB>pane_id
# Empty values are encoded as "-" so bash 3.2 IFS parsing cannot collapse them.
lead_body_collect_targets() {
  local project="$1" lead_id="$2" backend="$3" archive_file="$4" out_file="$5"
  local raw_file="${out_file}.raw.$$" status="complete" inventory="" inventory_rc=0
  local window_id window_name pane_id pane_pid pane_dead start command proof
  : > "$raw_file" || return 2

  inventory="$(lead_body_pane_inventory)" || inventory_rc=$?
  if [ "$inventory_rc" -ne 0 ]; then
    status="indeterminate"
  else
    while IFS=$'\t' read -r window_id window_name pane_id pane_pid pane_dead; do
      [ -n "$window_id$window_name$pane_id$pane_pid$pane_dead" ] || continue
      [ "$window_name" = "${project}-${lead_id}" ] || continue
      if [ "$pane_dead" = "1" ]; then
        _lead_body_add_row "$raw_file" "-" "-" "full" "window" "$window_id" "$pane_id"
        continue
      fi
      case "$pane_pid:$pane_dead" in
        *[!0-9:]*|:*|*:) status="indeterminate"; continue ;;
      esac
      start="$(lead_body_process_start_identity "$pane_pid")" || {
        status="indeterminate"
        _lead_body_add_row "$raw_file" "$pane_pid" "-" "detect" "window" "$window_id" "$pane_id"
        continue
      }
      command="$(lead_body_process_command "$pane_pid")" || {
        status="indeterminate"
        _lead_body_add_row "$raw_file" "$pane_pid" "$start" "detect" "window" "$window_id" "$pane_id"
        continue
      }
      proof="detect"
      _lead_body_command_proof "$command" "$project" "$lead_id" "$backend" && proof="full"
      _lead_body_add_row "$raw_file" "$pane_pid" "$start" "$proof" "window" "$window_id" "$pane_id"
    done <<EOF
$inventory
EOF
  fi

  if [ -e "$archive_file" ]; then
    if ! tmux_supervisor_archive_read "$archive_file"; then
      status="indeterminate"
    else
      pane_pid="$TMUX_ARCHIVE_PANE_PID"
      start="$TMUX_ARCHIVE_PANE_START"
      window_id="$TMUX_ARCHIVE_WINDOW_ID"
      if ! lead_body_process_alive "$pane_pid"; then
        rm -f "$archive_file" 2>/dev/null || status="indeterminate"
      else
        local actual_start=""
        actual_start="$(lead_body_process_start_identity "$pane_pid")" || {
          status="indeterminate"
          _lead_body_add_row "$raw_file" "$pane_pid" "$start" "detect" "archive" "$window_id" "-"
          actual_start=""
        }
        if [ -n "$actual_start" ]; then
          if [ "$actual_start" != "$start" ]; then
            rm -f "$archive_file" 2>/dev/null || status="indeterminate"
          else
            proof="detect"
            if [ "$backend" = "claude-code" ]; then
              command="$(lead_body_process_command "$pane_pid")" || {
                status="indeterminate"
                command=""
              }
              if [ -n "$command" ]; then
                _lead_body_claude_project_matches "$command" "$project" "$lead_id" && proof="full"
              fi
            fi
            _lead_body_add_row "$raw_file" "$pane_pid" "$start" "$proof" "archive" "$window_id" "-"
          fi
        fi
      fi
    fi
  fi

  if [ "$backend" = "claude-code" ]; then
    local snapshot="" snapshot_rc=0 line_pid line_command
    snapshot="$(lead_body_process_table)" || snapshot_rc=$?
    if [ "$snapshot_rc" -ne 0 ]; then
      status="indeterminate"
    else
      while read -r line_pid line_command; do
        case "$line_pid" in ''|*[!0-9]*) continue ;; esac
        lead_identity_command_matches "$line_command" "$lead_id" || continue
        start="$(lead_body_process_start_identity "$line_pid")" || {
          status="indeterminate"
          _lead_body_add_row "$raw_file" "$line_pid" "-" "detect" "proctable" "-" "-"
          continue
        }
        proof="detect"
        _lead_body_claude_project_matches "$line_command" "$project" "$lead_id" && proof="full"
        _lead_body_add_row "$raw_file" "$line_pid" "$start" "$proof" "proctable" "-" "-"
      done <<EOF
$snapshot
EOF
    fi
  fi

  {
    printf '#status=%s\n' "$status"
    printf '#project=%s\n' "$project"
    printf '#lead=%s\n' "$lead_id"
    printf '#backend=%s\n' "$backend"
  } > "$out_file" || {
    rm -f "$raw_file"
    return 2
  }
  _lead_body_normalize_rows "$raw_file" "$out_file"
  rm -f "$raw_file"
  [ "$status" = "complete" ] && return 0
  return 2
}

_lead_body_session_identity() {
  local command="$1" token session_id="" seen=0 had_noglob=0
  case "$-" in *f*) had_noglob=1 ;; *) set -f ;; esac
  # shellcheck disable=SC2086
  set -- $command
  [ "$had_noglob" -eq 1 ] || set +f
  while [ "$#" -gt 0 ]; do
    token="$1"
    shift
    case "$token" in
      --session-id|--resume)
        [ "$#" -gt 0 ] || return 1
        session_id="$1"
        shift
        seen=$((seen + 1))
        ;;
      --session-id=*|--resume=*)
        session_id="${token#*=}"
        seen=$((seen + 1))
        ;;
    esac
  done
  [ "$seen" -eq 1 ] && [ -n "$session_id" ] || return 1
  case "$session_id" in *[!A-Za-z0-9-]*) return 1 ;; esac
  printf '%s\n' "$session_id"
}

lead_body_adoption_hold_evidence() {
  local evidence="${1:-}"
  [ -n "$evidence" ] || evidence='{"reason":"adoption_hold"}'
  printf '%s\n' "$evidence"
}

# Read-only evidence closure for adopting a live Claude body after its
# supervisor died. It never calls the sweep collector because that collector is
# allowed to remove stale archives. stdout is a snapshot whose only successful
# row is:
# pid<TAB>lstart<TAB>full<TAB>window<TAB>window_id<TAB>pane_id<TAB>session_id
lead_body_adoption_evidence() {
  local project="$1" lead_id="$2" backend="$3" archive_file="$4"
  local holder_pid="$5" holder_start="$6"
  local status="complete" inventory="" inventory_rc=0 tuple_rc=0
  local window_ids="" window_count=0 live_count=0 target_window="" target_pane=""
  local window_id window_name pane_id pane_pid pane_dead start command=""
  local snapshot="" snapshot_rc=0 line_pid line_command matching_processes=0
  local session_id="" archive_state=0

  if [ "$backend" != "claude-code" ]; then
    printf '#status=unsafe\n'
    return 1
  fi
  tuple_rc=0
  _lead_body_tuple_state "$holder_pid" "$holder_start" || tuple_rc=$?
  if [ "$tuple_rc" -eq 2 ]; then
    printf '#status=indeterminate\n'
    return 2
  elif [ "$tuple_rc" -ne 0 ]; then
    printf '#status=unsafe\n'
    return 1
  fi

  inventory="$(lead_body_pane_inventory)" || inventory_rc=$?
  if [ "$inventory_rc" -ne 0 ]; then
    printf '#status=indeterminate\n'
    return 2
  fi
  while IFS=$'\t' read -r window_id window_name pane_id pane_pid pane_dead; do
    [ -n "$window_id$window_name$pane_id$pane_pid$pane_dead" ] || continue
    [ "$window_name" = "${project}-${lead_id}" ] || continue
    case " $window_ids " in
      *" $window_id "*) ;;
      *)
        window_ids="${window_ids} ${window_id}"
        window_count=$((window_count + 1))
        ;;
    esac
    [ "$pane_dead" = "0" ] || continue
    live_count=$((live_count + 1))
    if [ "$pane_pid" != "$holder_pid" ]; then
      status="unsafe"
      continue
    fi
    start="$(lead_body_process_start_identity "$pane_pid")" || {
      status="indeterminate"
      continue
    }
    if [ "$start" != "$holder_start" ]; then
      status="unsafe"
      continue
    fi
    command="$(lead_body_process_command "$pane_pid")" || {
      status="indeterminate"
      continue
    }
    if ! _lead_body_command_proof "$command" "$project" "$lead_id" "$backend"; then
      status="unsafe"
      continue
    fi
    target_window="$window_id"
    target_pane="$pane_id"
  done <<EOF
$inventory
EOF
  if [ "$window_count" -ne 1 ] || [ "$live_count" -ne 1 ] \
    || [ -z "$target_window" ] || [ -z "$target_pane" ]; then
    [ "$status" = "indeterminate" ] || status="unsafe"
  fi

  # A stale archive is ignored only after its exact tuple is positively dead or
  # reused. A live/sensor-uncertain archive must agree with the target closure.
  if [ -e "$archive_file" ] || [ -L "$archive_file" ]; then
    if ! tmux_supervisor_archive_read "$archive_file"; then
      status="indeterminate"
    else
      archive_state=0
      _lead_body_tuple_state "$TMUX_ARCHIVE_PANE_PID" "$TMUX_ARCHIVE_PANE_START" \
        || archive_state=$?
      if [ "$archive_state" -eq 0 ]; then
        if [ "$TMUX_ARCHIVE_PANE_PID" != "$holder_pid" ] \
          || [ "$TMUX_ARCHIVE_PANE_START" != "$holder_start" ] \
          || [ "$TMUX_ARCHIVE_WINDOW_ID" != "$target_window" ]; then
          status="unsafe"
        fi
      elif [ "$archive_state" -eq 2 ]; then
        status="indeterminate"
      fi
    fi
  fi

  snapshot="$(lead_body_process_table)" || snapshot_rc=$?
  if [ "$snapshot_rc" -ne 0 ]; then
    status="indeterminate"
  else
    while read -r line_pid line_command; do
      case "$line_pid" in ''|*[!0-9]*) continue ;; esac
      lead_identity_command_matches "$line_command" "$lead_id" || continue
      matching_processes=$((matching_processes + 1))
      start="$(lead_body_process_start_identity "$line_pid")" || {
        status="indeterminate"
        continue
      }
      if [ "$line_pid" != "$holder_pid" ] || [ "$start" != "$holder_start" ] \
        || ! _lead_body_command_proof "$line_command" "$project" "$lead_id" "$backend"; then
        status="unsafe"
        continue
      fi
      command="$line_command"
    done <<EOF
$snapshot
EOF
  fi
  [ "$matching_processes" -eq 1 ] || {
    [ "$status" = "indeterminate" ] || status="unsafe"
  }
  if [ "$status" = "complete" ]; then
    session_id="$(_lead_body_session_identity "$command")" || status="unsafe"
  fi

  printf '#status=%s\n' "$status"
  printf '#project=%s\n' "$project"
  printf '#lead=%s\n' "$lead_id"
  printf '#backend=%s\n' "$backend"
  if [ "$status" = "complete" ]; then
    printf '%s\t%s\tfull\twindow\t%s\t%s\t%s\n' \
      "$holder_pid" "$holder_start" "$target_window" "$target_pane" "$session_id"
    return 0
  fi
  [ "$status" = "indeterminate" ] && return 2
  return 1
}

LEAD_ADOPTION_WINDOW_ID=""
LEAD_ADOPTION_PANE_ID=""
LEAD_ADOPTION_PANE_PID=""
LEAD_ADOPTION_PANE_START=""
LEAD_ADOPTION_SESSION_ID=""
LEAD_ADOPTION_MODEL_OBSERVATION=""

# Post-CAS attachment may repair missing metadata, but never overwrites
# conflicting archive/session evidence. The pre-CAS snapshot is re-proved
# against live tmux/process state before any metadata write.
lead_body_attach_adopted() {
  local snapshot="$1" server_pid="$2" archive_file="$3" session_file="$4"
  local manifest_file="$5" status project lead_id backend row row_count
  local pid start proof source window_id pane_id session_id
  local inventory inventory_rc=0 match_count=0
  local current_window current_name current_pane current_pid current_dead
  local actual_start command session_actual temp_file

  LEAD_ADOPTION_WINDOW_ID=""
  LEAD_ADOPTION_PANE_ID=""
  LEAD_ADOPTION_PANE_PID=""
  LEAD_ADOPTION_PANE_START=""
  LEAD_ADOPTION_SESSION_ID=""
  LEAD_ADOPTION_MODEL_OBSERVATION=""
  case "$server_pid" in ''|0|*[!0-9]*) return 2 ;; esac

  status="$(printf '%s\n' "$snapshot" | sed -n 's/^#status=//p' | head -1)"
  project="$(printf '%s\n' "$snapshot" | sed -n 's/^#project=//p' | head -1)"
  lead_id="$(printf '%s\n' "$snapshot" | sed -n 's/^#lead=//p' | head -1)"
  backend="$(printf '%s\n' "$snapshot" | sed -n 's/^#backend=//p' | head -1)"
  [ "$status" = "complete" ] && [ -n "$project" ] && [ -n "$lead_id" ] \
    && [ "$backend" = "claude-code" ] || return 2
  row_count="$(printf '%s\n' "$snapshot" | awk -F '\t' '$1 !~ /^#/ && NF {n++} END {print n+0}')"
  [ "$row_count" -eq 1 ] || return 2
  row="$(printf '%s\n' "$snapshot" | awk -F '\t' '$1 !~ /^#/ && NF {print; exit}')"
  IFS=$'\t' read -r pid start proof source window_id pane_id session_id <<EOF
$row
EOF
  case "$pid" in ''|0|*[!0-9]*) return 2 ;; esac
  [ -n "$start" ] && [ "$proof" = "full" ] && [ "$source" = "window" ] \
    && [ -n "$window_id" ] && [ -n "$pane_id" ] && [ -n "$session_id" ] \
    || return 2

  inventory="$(lead_body_pane_inventory)" || inventory_rc=$?
  [ "$inventory_rc" -eq 0 ] || return 2
  while IFS=$'\t' read -r current_window current_name current_pane current_pid current_dead; do
    [ "$current_name" = "${project}-${lead_id}" ] || continue
    [ "$current_dead" = "0" ] || continue
    match_count=$((match_count + 1))
    [ "$current_window" = "$window_id" ] && [ "$current_pane" = "$pane_id" ] \
      && [ "$current_pid" = "$pid" ] || return 2
  done <<EOF
$inventory
EOF
  [ "$match_count" -eq 1 ] || return 2
  actual_start="$(lead_body_process_start_identity "$pid")" || return 2
  [ "$actual_start" = "$start" ] || return 2
  command="$(lead_body_process_command "$pid")" || return 2
  _lead_body_command_proof "$command" "$project" "$lead_id" "$backend" || return 2
  [ "$(_lead_body_session_identity "$command")" = "$session_id" ] || return 2

  if [ -e "$archive_file" ] || [ -L "$archive_file" ]; then
    tmux_supervisor_archive_read "$archive_file" || return 2
    [ "$TMUX_ARCHIVE_SERVER_PID" = "$server_pid" ] \
      && [ "$TMUX_ARCHIVE_PANE_PID" = "$pid" ] \
      && [ "$TMUX_ARCHIVE_PANE_START" = "$start" ] \
      && [ "$TMUX_ARCHIVE_WINDOW_ID" = "$window_id" ] || return 2
  else
    tmux_supervisor_archive_write \
      "$archive_file" "$server_pid" "$pid" "$start" "$window_id" || return 2
  fi

  _sweep_tmux set-window-option -t "$window_id" remain-on-exit on \
    >/dev/null 2>&1 || return 2

  if [ -e "$session_file" ] || [ -L "$session_file" ]; then
    [ -f "$session_file" ] && [ ! -L "$session_file" ] && [ -r "$session_file" ] \
      || return 2
    session_actual="$(cat "$session_file" 2>/dev/null)" || return 2
    [ -n "$session_actual" ] && [ "$session_actual" = "$session_id" ] || return 2
  else
    mkdir -p "${session_file%/*}" 2>/dev/null || return 2
    temp_file="${session_file}.tmp.$$"
    if ! (umask 077; printf '%s\n' "$session_id" > "$temp_file") \
      || ! mv "$temp_file" "$session_file"; then
      rm -f "$temp_file" 2>/dev/null || true
      return 2
    fi
  fi

  if ! lead_body_model_evidence "$pid" "$manifest_file" >/dev/null 2>&1; then
    LEAD_ADOPTION_MODEL_OBSERVATION="mismatch"
  else
    LEAD_ADOPTION_MODEL_OBSERVATION="match"
  fi
  LEAD_ADOPTION_WINDOW_ID="$window_id"
  LEAD_ADOPTION_PANE_ID="$pane_id"
  LEAD_ADOPTION_PANE_PID="$pid"
  LEAD_ADOPTION_PANE_START="$start"
  LEAD_ADOPTION_SESSION_ID="$session_id"
  return 0
}

_lead_body_target_identity_matches() {
  local pid="$1" start="$2" project="$3" lead_id="$4" backend="$5"
  local tuple_rc=0 command
  _lead_body_tuple_state "$pid" "$start" || tuple_rc=$?
  [ "$tuple_rc" -eq 0 ] || return "$tuple_rc"
  command="$(lead_body_process_command "$pid")" || return 2
  _lead_body_command_proof "$command" "$project" "$lead_id" "$backend" || return 2
  return 0
}

_lead_body_snapshot_has_full_tuple() {
  local file="$1" wanted_pid="$2" wanted_start="$3"
  local pid start proof source window_id pane_id
  while IFS=$'\t' read -r pid start proof source window_id pane_id; do
    case "$pid" in \#*|"") continue ;; esac
    [ "$pid" = "$wanted_pid" ] && [ "$start" = "$wanted_start" ] && [ "$proof" = "full" ] && return 0
  done < "$file"
  return 1
}

_lead_body_send_interrupts() {
  local file="$1" project="$2" lead_id="$3" backend="$4"
  local pid start proof source window_id pane_id inventory row
  while IFS=$'\t' read -r pid start proof source window_id pane_id; do
    case "$pid" in \#*|"-"|"") continue ;; esac
    [ "$proof" = "full" ] && [ "$pane_id" != "-" ] || continue
    _lead_body_target_identity_matches "$pid" "$start" "$project" "$lead_id" "$backend" || continue
    inventory="$(lead_body_pane_inventory)" || continue
    row="$(printf '%s\n' "$inventory" | awk -F '\t' -v p="$pane_id" '$3 == p { print; exit }')"
    [ -n "$row" ] || continue
    local current_window _current_name _current_pane current_pid current_dead current_start
    IFS=$'\t' read -r current_window _current_name _current_pane current_pid current_dead <<EOF
$row
EOF
    [ "$current_window" = "$window_id" ] && [ "$current_pid" = "$pid" ] && [ "$current_dead" = "0" ] || continue
    current_start="$(lead_body_process_start_identity "$current_pid")" || continue
    [ "$current_start" = "$start" ] || continue
    _sweep_tmux send-keys -t "$pane_id" C-c 2>/dev/null || true
  done < "$file"
}

_lead_body_signal_full_targets() {
  local file="$1" signal="$2" project="$3" lead_id="$4" backend="$5"
  local pid start proof source window_id pane_id identity_rc=0 rc=0
  while IFS=$'\t' read -r pid start proof source window_id pane_id; do
    case "$pid" in \#*|"-"|"") continue ;; esac
    [ "$proof" = "full" ] || continue
    identity_rc=0
    _lead_body_target_identity_matches "$pid" "$start" "$project" "$lead_id" "$backend" || identity_rc=$?
    case "$identity_rc" in
      0) lead_body_signal "$signal" "$pid" || rc=2 ;;
      1) ;;
      *) rc=2 ;;
    esac
  done < "$file"
  return "$rc"
}

_lead_body_any_full_alive() {
  local file="$1" project="$2" lead_id="$3" backend="$4"
  local pid start proof source window_id pane_id identity_rc=0 saw_sensor_error=0
  while IFS=$'\t' read -r pid start proof source window_id pane_id; do
    case "$pid" in \#*|"-"|"") continue ;; esac
    [ "$proof" = "full" ] || continue
    identity_rc=0
    _lead_body_target_identity_matches "$pid" "$start" "$project" "$lead_id" "$backend" || identity_rc=$?
    [ "$identity_rc" -eq 0 ] && return 0
    [ "$identity_rc" -eq 2 ] && saw_sensor_error=1
  done < "$file"
  [ "$saw_sensor_error" -eq 1 ] && return 2
  return 1
}

_lead_body_wait_stage() {
  local file="$1" project="$2" lead_id="$3" backend="$4" attempts="$5" interval="$6"
  local count=0 alive_rc=0
  while [ "$count" -lt "$attempts" ]; do
    alive_rc=0
    _lead_body_any_full_alive "$file" "$project" "$lead_id" "$backend" || alive_rc=$?
    [ "$alive_rc" -eq 1 ] && return 0
    [ "$alive_rc" -eq 2 ] && return 2
    lead_body_sleep "$interval"
    count=$((count + 1))
  done
  return 0
}

_lead_body_cleanup_windows() {
  local file="$1" project="$2" lead_id="$3"
  local inventory inventory_rc=0 unsafe=0 window_ids=""
  inventory="$(lead_body_pane_inventory)" || inventory_rc=$?
  [ "$inventory_rc" -eq 0 ] || return 2
  local window_id window_name pane_id pane_pid pane_dead
  while IFS=$'\t' read -r window_id window_name pane_id pane_pid pane_dead; do
    [ "$window_name" = "${project}-${lead_id}" ] || continue
    case " $window_ids " in *" $window_id "*) ;; *) window_ids="${window_ids} ${window_id}" ;; esac
  done <<EOF
$inventory
EOF

  local wid eligible current_start tuple_rc
  for wid in $window_ids; do
    eligible=1
    while IFS=$'\t' read -r window_id window_name pane_id pane_pid pane_dead; do
      [ "$window_id" = "$wid" ] || continue
      [ "$pane_dead" = "1" ] && continue
      current_start="$(lead_body_process_start_identity "$pane_pid")" || {
        eligible=0
        unsafe=1
        continue
      }
      if ! _lead_body_snapshot_has_full_tuple "$file" "$pane_pid" "$current_start"; then
        eligible=0
        unsafe=1
        continue
      fi
      tuple_rc=0
      _lead_body_tuple_state "$pane_pid" "$current_start" || tuple_rc=$?
      if [ "$tuple_rc" -eq 0 ]; then
        eligible=0
      elif [ "$tuple_rc" -eq 2 ]; then
        eligible=0
        unsafe=1
      fi
    done <<EOF
$inventory
EOF
    [ "$eligible" -eq 1 ] && _sweep_tmux kill-window -t "=$wid" >/dev/null 2>&1 || true
  done
  [ "$unsafe" -eq 0 ]
}

_lead_body_has_live_detect() {
  local file="$1" pid start proof source window_id pane_id tuple_rc=0
  while IFS=$'\t' read -r pid start proof source window_id pane_id; do
    case "$pid" in \#*|"-"|"") continue ;; esac
    [ "$proof" = "detect" ] || continue
    tuple_rc=0
    _lead_body_tuple_state "$pid" "$start" || tuple_rc=$?
    [ "$tuple_rc" -eq 0 ] && return 0
    [ "$tuple_rc" -eq 2 ] && return 0
  done < "$file"
  return 1
}

_lead_body_cleanup_archive() {
  local archive="$1" actual_start
  [ -e "$archive" ] || return 0
  tmux_supervisor_archive_read "$archive" || return 2
  if ! lead_body_process_alive "$TMUX_ARCHIVE_PANE_PID"; then
    rm -f "$archive" 2>/dev/null || return 2
    return 0
  fi
  actual_start="$(lead_body_process_start_identity "$TMUX_ARCHIVE_PANE_PID")" || return 2
  if [ "$actual_start" != "$TMUX_ARCHIVE_PANE_START" ]; then
    rm -f "$archive" 2>/dev/null || return 2
  fi
  return 0
}

lead_body_terminate() {
  local targets_file="$1" lead_id="$2" archive_file="$3"
  local project backend rc=0 stage_rc=0 alive_rc=0 cleanup_rc=0
  project="$(_lead_body_header_value "$targets_file" project)"
  backend="$(_lead_body_header_value "$targets_file" backend)"
  [ -n "$project" ] && [ -n "$backend" ] || return 2
  _lead_body_status_complete "$targets_file" || rc=2

  _lead_body_send_interrupts "$targets_file" "$project" "$lead_id" "$backend"
  _lead_body_wait_stage "$targets_file" "$project" "$lead_id" "$backend" \
    "${LEAD_BODY_INTERRUPT_ATTEMPTS:-10}" "${LEAD_BODY_INTERRUPT_INTERVAL:-0.5}" || rc=2

  stage_rc=0
  _lead_body_signal_full_targets "$targets_file" TERM "$project" "$lead_id" "$backend" || stage_rc=$?
  [ "$stage_rc" -eq 0 ] || rc=2
  _lead_body_wait_stage "$targets_file" "$project" "$lead_id" "$backend" \
    "${LEAD_BODY_TERM_ATTEMPTS:-10}" "${LEAD_BODY_TERM_INTERVAL:-0.5}" || rc=2

  stage_rc=0
  _lead_body_signal_full_targets "$targets_file" KILL "$project" "$lead_id" "$backend" || stage_rc=$?
  [ "$stage_rc" -eq 0 ] || rc=2
  _lead_body_wait_stage "$targets_file" "$project" "$lead_id" "$backend" \
    "${LEAD_BODY_KILL_ATTEMPTS:-4}" "${LEAD_BODY_KILL_INTERVAL:-0.5}" || rc=2

  alive_rc=0
  _lead_body_any_full_alive "$targets_file" "$project" "$lead_id" "$backend" || alive_rc=$?
  [ "$alive_rc" -eq 0 ] && return 1
  [ "$alive_rc" -eq 2 ] && rc=2
  _lead_body_has_live_detect "$targets_file" && rc=2

  cleanup_rc=0
  _lead_body_cleanup_windows "$targets_file" "$project" "$lead_id" || cleanup_rc=$?
  [ "$cleanup_rc" -eq 0 ] || rc=2
  cleanup_rc=0
  _lead_body_cleanup_archive "$archive_file" || cleanup_rc=$?
  [ "$cleanup_rc" -eq 0 ] || rc=2
  return "$rc"
}

lead_body_swept_all_dead() {
  local targets_file="$1" pid start proof source window_id pane_id tuple_rc=0
  _lead_body_status_complete "$targets_file" || return 1
  while IFS=$'\t' read -r pid start proof source window_id pane_id; do
    case "$pid" in \#*|"-"|"") continue ;; esac
    tuple_rc=0
    _lead_body_tuple_state "$pid" "$start" || tuple_rc=$?
    [ "$tuple_rc" -eq 0 ] && return 1
    [ "$tuple_rc" -eq 2 ] && return 1
  done < "$targets_file"
  return 0
}

lead_body_newborn_ok() {
  local project="$1" lead_id="$2" targets_file="$3"
  local backend inventory="" inventory_rc=0
  local window_ids="" live_count=0 body_pid="" body_start="" command=""
  local window_id window_name pane_id pane_pid pane_dead
  _lead_body_status_complete "$targets_file" || return 1
  lead_body_swept_all_dead "$targets_file" || return 1
  backend="$(_lead_body_header_value "$targets_file" backend)"
  inventory="$(lead_body_pane_inventory)" || inventory_rc=$?
  [ "$inventory_rc" -eq 0 ] || return 1
  while IFS=$'\t' read -r window_id window_name pane_id pane_pid pane_dead; do
    [ "$window_name" = "${project}-${lead_id}" ] || continue
    case " $window_ids " in *" $window_id "*) ;; *) window_ids="${window_ids} ${window_id}" ;; esac
    [ "$pane_dead" = "0" ] || continue
    live_count=$((live_count + 1))
    body_pid="$pane_pid"
  done <<EOF
$inventory
EOF
  [ "$(printf '%s\n' "$window_ids" | awk '{print NF}')" -eq 1 ] || return 1
  [ "$live_count" -eq 1 ] || return 1
  body_start="$(lead_body_process_start_identity "$body_pid")" || return 1
  command="$(lead_body_process_command "$body_pid")" || return 1
  _lead_body_command_proof "$command" "$project" "$lead_id" "$backend" || return 1
  local pid start proof source _old_window _old_pane
  while IFS=$'\t' read -r pid start proof source _old_window _old_pane; do
    case "$pid" in \#*|"-"|"") continue ;; esac
    [ "$pid" = "$body_pid" ] && [ "$start" = "$body_start" ] && return 1
  done < "$targets_file"
  printf '%s\t%s\n' "$body_pid" "$body_start"
}

lead_body_model_evidence() {
  local pane_pid="$1" manifest_file="$2" command actual="" expected="" token
  command="$(lead_body_process_command "$pane_pid")" || return 1
  local had_noglob=0
  case "$-" in *f*) had_noglob=1 ;; *) set -f ;; esac
  # shellcheck disable=SC2086
  set -- $command
  [ "$had_noglob" -eq 1 ] || set +f
  while [ "$#" -gt 0 ]; do
    token="$1"; shift
    case "$token" in
      --model)
        [ "$#" -gt 0 ] || return 1
        actual="$1"; shift
        ;;
      --model=*) actual="${token#--model=}" ;;
    esac
  done
  [ -n "$actual" ] || actual="default"
  expected="$(jq -r '.resolvedModel // empty' "$manifest_file" 2>/dev/null)" || return 1
  if [ -z "$expected" ]; then
    echo "[lead-body-sweep] WARNING: manifest has no resolvedModel; observed body model=$actual" >&2
    printf '%s\n' "$actual"
    return 0
  fi
  if [ "$actual" != "$expected" ]; then
    echo "[lead-body-sweep] WARNING: body model $actual does not match manifest resolvedModel $expected" >&2
    return 1
  fi
  printf '%s\n' "$actual"
}

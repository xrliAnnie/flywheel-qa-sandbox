#!/usr/bin/env bash
# Source-only process identity/census helpers shared by cmux mutators and the
# fleet restart path (FLY-1482). Compatible with macOS Bash 3.2.

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
    ""|--watch|--once|--refresh|--reap-orphan-pins|--qa-teardown) return 0 ;;
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

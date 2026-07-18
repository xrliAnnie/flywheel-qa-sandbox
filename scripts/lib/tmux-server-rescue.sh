#!/bin/bash
# FLY-1285: inspect and safely recover a Flywheel tmux server socket.
# Sourceable by launchers and executable as a small runtime CLI.

_tmux_rescue_stat_owner_mode() {
  stat -f '%u %Lp' "$1" 2>/dev/null || stat -c '%u %a' "$1" 2>/dev/null
}

_tmux_rescue_mode_is_safe() {
  local mode="$1" group_digit other_digit
  while [ "${mode#0}" != "$mode" ]; do mode="${mode#0}"; done
  [ -n "$mode" ] || mode=0
  case "$mode" in *[!0-9]*) return 1 ;; esac
  group_digit=$(( (mode / 10) % 10 ))
  other_digit=$(( mode % 10 ))
  case "$group_digit:$other_digit" in
    2:*|3:*|6:*|7:*|*:2|*:3|*:6|*:7) return 1 ;;
  esac
  return 0
}

tmux_rescue_activation_enabled() {
  local marker="${HOME}/.flywheel/flags/tmux-auto-rescue.on"
  local parent owner mode current_uid
  [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
  parent="${marker%/*}"
  [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
  current_uid="$(id -u 2>/dev/null)" || return 1

  read -r owner mode <<EOF
$(_tmux_rescue_stat_owner_mode "$marker")
EOF
  [ "$owner" = "$current_uid" ] && _tmux_rescue_mode_is_safe "$mode" || return 1
  read -r owner mode <<EOF
$(_tmux_rescue_stat_owner_mode "$parent")
EOF
  [ "$owner" = "$current_uid" ] && _tmux_rescue_mode_is_safe "$mode"
}

_tmux_rescue_total_budget() {
  local raw="${FLYWHEEL_TMUX_RESCUE_TOTAL_BUDGET_SEC:-}"
  awk -v raw="$raw" 'BEGIN {
    if (raw ~ /^[0-9]+$/ && (raw + 0) >= 1) print raw
    else print 60
  }'
}

_tmux_rescue_load_factor_max() {
  local raw="${FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR_MAX:-}"
  awk -v raw="$raw" 'BEGIN {
    if (raw ~ /^[0-9]+$/ && (raw + 0) >= 1) printf "%.0f\n", raw + 0
    else print 4
  }'
}

_tmux_rescue_sample_load() {
  local platform load1 load_row ncpu
  platform="$(uname -s 2>/dev/null)" || return 1
  case "$platform" in
    Darwin)
      load_row="$(sysctl -n vm.loadavg 2>/dev/null)" || return 1
      read -r load1 _ <<EOF
${load_row#*\{}
EOF
      ncpu="$(sysctl -n hw.ncpu 2>/dev/null)" || return 1
      ;;
    Linux)
      load_row="$(cat /proc/loadavg 2>/dev/null)" || return 1
      read -r load1 _ <<EOF
$load_row
EOF
      ncpu="$(nproc 2>/dev/null)" || return 1
      ;;
    *) return 1 ;;
  esac
  printf '%s %s\n' "$load1" "$ncpu"
}

_tmux_rescue_load_factor() {
  if [ -n "${_TMUX_RESCUE_CACHED_LOAD_FACTOR:-}" ]; then
    printf '%s\n' "$_TMUX_RESCUE_CACHED_LOAD_FACTOR"
    return 0
  fi

  command -v awk >/dev/null 2>&1 || {
    printf '1\n'
    return 0
  }

  local max override sampled load1 ncpu
  max="$(_tmux_rescue_load_factor_max)"
  override="${FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR:-}"
  case "$override" in
    ''|*[!0-9]*) override="" ;;
    *)
      if ! awk -v value="$override" 'BEGIN { exit !((value + 0) >= 1) }'; then
        override=""
      fi
      ;;
  esac

  if [ -n "$override" ]; then
    awk -v value="$override" -v max="$max" 'BEGIN {
      factor = value + 0
      if (factor < 1) factor = 1
      if (factor > max) factor = max
      printf "%.0f\n", factor
    }'
    return 0
  fi

  sampled="$(_tmux_rescue_sample_load 2>/dev/null)" || {
    printf '1\n'
    return 0
  }
  read -r load1 ncpu <<EOF
$sampled
EOF
  awk -v load="$load1" -v cores="$ncpu" -v max="$max" 'BEGIN {
    if (load !~ /^[0-9]+([.][0-9]+)?$/ || cores !~ /^[0-9]+([.][0-9]+)?$/ || cores + 0 <= 0) {
      print 1
      exit
    }
    factor = int((load + 0) / (cores + 0))
    if (factor * (cores + 0) < (load + 0)) factor++
    if (factor < 1) factor = 1
    if (factor > max) factor = max
    printf "%.0f\n", factor
  }'
}

_tmux_rescue_prepare_load_factor() {
  [ -n "${_TMUX_RESCUE_CACHED_LOAD_FACTOR:-}" ] \
    || _TMUX_RESCUE_CACHED_LOAD_FACTOR="$(_tmux_rescue_load_factor)"
}

_tmux_rescue_prepare_runtime() {
  _tmux_rescue_prepare_load_factor
  [ -n "${_TMUX_RESCUE_TOTAL_BUDGET:-}" ] \
    || _TMUX_RESCUE_TOTAL_BUDGET="$(_tmux_rescue_total_budget)"
  [ -n "${_TMUX_RESCUE_BUDGET_ANCHOR:-}" ] \
    || _TMUX_RESCUE_BUDGET_ANCHOR=$SECONDS
}

_tmux_rescue_remaining_budget() {
  _tmux_rescue_prepare_runtime
  local elapsed=$((SECONDS - _TMUX_RESCUE_BUDGET_ANCHOR))
  awk -v total="$_TMUX_RESCUE_TOTAL_BUDGET" -v elapsed="$elapsed" 'BEGIN {
    remaining = (total + 0) - (elapsed + 0)
    if (remaining <= 0) print 0
    else printf "%.10g\n", remaining
  }'
}

_tmux_rescue_budget_exhausted() {
  local remaining
  remaining="$(_tmux_rescue_remaining_budget)"
  awk -v remaining="$remaining" 'BEGIN { exit !((remaining + 0) <= 0) }'
}

_tmux_rescue_effective_timeout() {
  local kind="$1" raw fallback factor
  case "$kind" in
    inspect)
      raw="${FLYWHEEL_TMUX_RESCUE_INSPECT_TIMEOUT_SEC:-}"
      fallback=6
      ;;
    command)
      raw="${FLYWHEEL_TMUX_RESCUE_COMMAND_TIMEOUT_SEC:-}"
      fallback=5
      ;;
    lock)
      raw="${FLYWHEEL_TMUX_RESCUE_LOCK_TIMEOUT_SEC:-}"
      fallback=5
      ;;
    *) return 64 ;;
  esac
  factor="$(_tmux_rescue_load_factor)"
  awk -v raw="$raw" -v fallback="$fallback" -v factor="$factor" 'BEGIN {
    base = fallback
    if (raw ~ /^[0-9]+([.][0-9]+)?$/ && raw + 0 > 0) base = raw + 0
    value = base * (factor + 0)
    printf "%.10g\n", value
  }'
}

_tmux_rescue_bounded_exec() {
  local timeout_sec="$1" remaining
  shift
  [ "$#" -gt 0 ] || return 64
  [ -x /usr/bin/python3 ] || return 125
  remaining="$(_tmux_rescue_remaining_budget)"
  timeout_sec="$(awk -v requested="$timeout_sec" -v remaining="$remaining" 'BEGIN {
    if (remaining + 0 <= 0) {
      print 0
      exit
    }
    effective = requested + 0
    if (effective <= 0 || effective > remaining + 0) effective = remaining + 0
    printf "%.10g\n", effective
  }')"
  awk -v timeout="$timeout_sec" 'BEGIN { exit !((timeout + 0) <= 0) }' && return 124
  /usr/bin/python3 - "$timeout_sec" "$@" <<'PY'
import os
import signal
import subprocess
import sys

timeout = float(sys.argv[1])
argv = sys.argv[2:]
proc = subprocess.Popen(
    argv,
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    start_new_session=True,
)
try:
    stdout, stderr = proc.communicate(timeout=timeout)
except subprocess.TimeoutExpired:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    stdout, stderr = proc.communicate()
    sys.stdout.buffer.write(stdout)
    sys.stderr.buffer.write(stderr)
    raise SystemExit(124)
sys.stdout.buffer.write(stdout)
sys.stderr.buffer.write(stderr)
code = proc.returncode
raise SystemExit(code if code >= 0 else 128 + (-code))
PY
}

_tmux_rescue_normalize_socket() {
  local socket_path="$1" parent base
  case "$socket_path" in
    /*) ;;
    *) return 1 ;;
  esac
  parent="${socket_path%/*}"
  base="${socket_path##*/}"
  [ -n "$parent" ] || parent="/"
  parent="$(cd -P "$parent" 2>/dev/null && pwd)" || return 1
  if [ "$parent" = "/" ]; then
    printf '/%s' "$base"
  else
    printf '%s/%s' "$parent" "$base"
  fi
}

_tmux_rescue_pid_has_socket() {
  local pid="$1" socket_path="$2" output rc line reported normalized timeout
  command -v lsof >/dev/null 2>&1 || return 2
  timeout="$(_tmux_rescue_effective_timeout inspect)"
  output="$(_tmux_rescue_bounded_exec "$timeout" \
    lsof -a -p "$pid" -U -Fn 2>/dev/null)"
  rc=$?
	if [ "$rc" -ne 0 ]; then
		if [ "$rc" -eq 124 ] || [ "$rc" -eq 125 ]; then return 3; fi
		# lsof uses 1 for a complete "no matching descriptor" result. Accept it
		# only while the candidate identity still exists; permission/tool errors
		# remain incomplete evidence.
		if [ "$rc" -eq 1 ] && kill -0 "$pid" 2>/dev/null; then return 1; fi
		return 2
	fi
  while IFS= read -r line; do
    case "$line" in
      n/*)
        reported="${line#n}"
        normalized="$(_tmux_rescue_normalize_socket "$reported")" || continue
        [ "$normalized" = "$socket_path" ] && return 0
        ;;
    esac
  done <<EOF
$output
EOF
  return 1
}

_tmux_rescue_server_pids() {
  local output rc current_uid argv0 timeout
  command -v ps >/dev/null 2>&1 || return 1
	current_uid="$(id -u 2>/dev/null)" || return 1
  timeout="$(_tmux_rescue_effective_timeout inspect)"
  output="$(_tmux_rescue_bounded_exec "$timeout" \
    ps axww -o uid= -o pid= -o ppid= -o command= 2>/dev/null)"
  rc=$?
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 125 ]; then return 3; fi
  [ "$rc" -eq 0 ] || return 1
  printf '%s\n' "$output" | while read -r uid pid ppid command; do
		[ "$uid" = "$current_uid" ] || continue
        case "$pid" in ''|*[!0-9]*) continue ;; esac
        [ "$ppid" = "1" ] || continue
        argv0="${command%% *}"
        case "$argv0" in
          tmux|*/tmux) printf '%s\n' "$pid" ;;
          *)
            case "$command" in
              *"tmux: server"*|*"tmux server"*) printf '%s\n' "$pid" ;;
            esac
            ;;
        esac
      done
}

tmux_socket_inspect() {
  local requested="$1" socket_path socket_present=false reachable_pid="null"
  local scan_complete=true timed_out=false candidates="" pid rc inspect_timeout

  _tmux_rescue_prepare_runtime
  inspect_timeout="$(_tmux_rescue_effective_timeout inspect)"

  socket_path="$(_tmux_rescue_normalize_socket "$requested")" || {
    printf '{"verdict":"unknown","socketPresent":false,"socketPath":"","reachablePid":null,"candidatePids":[],"scanComplete":false,"timedOut":false}\n'
    return 0
  }
  [ -e "$socket_path" ] && socket_present=true

  pid="$(_tmux_rescue_bounded_exec "$inspect_timeout" \
    tmux -S "$socket_path" display-message -p '#{pid}' 2>/dev/null)"
  rc=$?
  [ "$rc" -eq 0 ] || {
    pid=""
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 125 ]; then
      scan_complete=false
      timed_out=true
    fi
  }
  case "$pid" in
    ''|*[!0-9]*) ;;
    *) reachable_pid="$pid" ;;
  esac

  local server_pids
  server_pids="$(_tmux_rescue_server_pids)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    scan_complete=false
    [ "$rc" -eq 3 ] && timed_out=true
  fi
  for pid in $server_pids; do
    [ "$reachable_pid" != "null" ] && [ "$pid" = "$reachable_pid" ] && continue
    _tmux_rescue_pid_has_socket "$pid" "$socket_path"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      [ -n "$candidates" ] && candidates="${candidates},"
      candidates="${candidates}${pid}"
    elif [ "$rc" -eq 2 ]; then
      scan_complete=false
    elif [ "$rc" -eq 3 ]; then
      scan_complete=false
      timed_out=true
    fi
  done

  local verdict="unknown"
  if [ "$scan_complete" = true ]; then
    if [ "$reachable_pid" != "null" ]; then
      if [ -n "$candidates" ]; then
        verdict="split_brain"
      else
        verdict="reachable"
      fi
    elif [ -z "$candidates" ]; then
      # A stale socket inode is not evidence of a live server. Once the full
      # same-uid server scan proves there is no owner, creation is safe even if
      # the dead server left its filesystem entry behind.
      verdict="dead"
    elif [ "${candidates#*,}" != "$candidates" ]; then
      verdict="ambiguous"
    elif [ "$socket_present" = true ]; then
      verdict="saturated"
    else
      verdict="missing_single_orphan"
    fi
  fi
  printf '{"verdict":"%s","socketPresent":%s,"socketPath":"%s","reachablePid":%s,"candidatePids":[%s],"scanComplete":%s,"timedOut":%s}\n' \
    "$verdict" "$socket_present" "$socket_path" "$reachable_pid" "$candidates" "$scan_complete" "$timed_out"
}

_tmux_rescue_json_field() {
  local json="$1" field="$2" rest
  rest="${json#*\""${field}"\":}"
  [ "$rest" != "$json" ] || return 1
  case "$rest" in
    \"*) rest="${rest#\"}"; printf '%s' "${rest%%\"*}" ;;
    *) rest="${rest%%,*}"; printf '%s' "${rest%%\}*}" ;;
  esac
}

_tmux_rescue_json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  printf '%s' "$value"
}

_tmux_rescue_single_candidate() {
  local json="$1" rest value
  rest="${json#*\"candidatePids\":[}"
  [ "$rest" != "$json" ] || return 1
  value="${rest%%]*}"
  case "$value" in ''|*,*|*[!0-9]*) return 1 ;; esac
  printf '%s' "$value"
}

_tmux_rescue_signal_candidate() {
  builtin kill -USR1 "$1"
}

_tmux_rescue_validate_argv() {
  local expected_socket="$1"
  shift
  [ "$#" -ge 4 ] || return 1
  case "$1" in tmux|*/tmux) ;; *) return 1 ;; esac
  shift
  local saw_socket=false arg normalized
  while [ "$#" -gt 0 ]; do
    arg="$1"
    shift
    if [ "$arg" = "-S" ]; then
      [ "$#" -gt 0 ] || return 1
      normalized="$(_tmux_rescue_normalize_socket "$1")" || return 1
      [ "$normalized" = "$expected_socket" ] || return 1
      saw_socket=true
      shift
      break
    fi
  done
  [ "$saw_socket" = true ]
}

_tmux_socket_ensure_locked() {
  local socket_path="$1"
  shift
  local section="" arg
  local -a verify_argv=()
  local -a create_argv=()
  while [ "$#" -gt 0 ]; do
    arg="$1"
    shift
    case "$arg" in
      --verify) section="verify"; continue ;;
      --create) section="create"; continue ;;
    esac
    case "$section" in
      verify) verify_argv+=("$arg") ;;
      create) create_argv+=("$arg") ;;
      *) return 64 ;;
    esac
  done
  _tmux_rescue_validate_argv "$socket_path" "${verify_argv[@]}" || return 64
  _tmux_rescue_validate_argv "$socket_path" "${create_argv[@]}" || return 64
	_tmux_rescue_write_owner_metadata "$socket_path" || true
	_tmux_rescue_prepare_runtime

  local before before_timed_out verdict server_pid after after_verdict after_pid create_stdout recovery recovery_rc command_rc command_timeout reason
  local -a guarded_create=()
  command_timeout="$(_tmux_rescue_effective_timeout command)"
  before="$(tmux_socket_inspect "$socket_path")"
  verdict="$(_tmux_rescue_json_field "$before" verdict)"
  before_timed_out="$(_tmux_rescue_json_field "$before" timedOut)"
  server_pid="$(_tmux_rescue_json_field "$before" reachablePid)"
  if [ "$verdict" = "reachable" ]; then
    _tmux_rescue_bounded_exec "$command_timeout" \
      "${verify_argv[@]}" >/dev/null 2>&1
    command_rc=$?
    if [ "$command_rc" -eq 124 ] || [ "$command_rc" -eq 125 ]; then
      printf '{"action":"hold_unknown","evidence":{"reason":"command_timeout"}}\n'
      return 4
    fi
    if [ "$command_rc" -eq 0 ]; then
      after="$(tmux_socket_inspect "$socket_path")"
      after_verdict="$(_tmux_rescue_json_field "$after" verdict)"
      after_pid="$(_tmux_rescue_json_field "$after" reachablePid)"
      if [ "$after_verdict" = "reachable" ] && [ "$after_pid" = "$server_pid" ]; then
        printf '{"action":"verified","createStdout":"","reachablePid":%s}\n' "$after_pid"
        return 0
      fi
    fi
		if [ "${FLY1285_RESCUE_DRY_RUN:-0}" = "1" ]; then
			printf '{"action":"hold_unknown","evidence":{"reason":"dry_run_create_suppressed"}}\n'
			return 4
		fi
    guarded_create=("${create_argv[0]}" -N "${create_argv[@]:1}")
    create_stdout="$(_tmux_rescue_bounded_exec "$command_timeout" \
      "${guarded_create[@]}" 2>/dev/null)"
    command_rc=$?
    if [ "$command_rc" -eq 124 ] || [ "$command_rc" -eq 125 ]; then
      printf '{"action":"hold_unknown","evidence":{"reason":"command_timeout"}}\n'
      return 4
    fi
    if [ "$command_rc" -eq 0 ]; then
      after="$(tmux_socket_inspect "$socket_path")"
      after_verdict="$(_tmux_rescue_json_field "$after" verdict)"
      after_pid="$(_tmux_rescue_json_field "$after" reachablePid)"
      if [ "$after_verdict" = "reachable" ] && [ "$after_pid" = "$server_pid" ]; then
        printf '{"action":"created","createStdout":"%s","reachablePid":%s}\n' \
          "$(_tmux_rescue_json_escape "$create_stdout")" "$after_pid"
        return 0
      fi
    else
      # A racing creator may have made the target after our first verify. Only
      # accept that duplicate when the same server generation now verifies it.
      after="$(tmux_socket_inspect "$socket_path")"
      after_verdict="$(_tmux_rescue_json_field "$after" verdict)"
      after_pid="$(_tmux_rescue_json_field "$after" reachablePid)"
      _tmux_rescue_bounded_exec "$command_timeout" \
        "${verify_argv[@]}" >/dev/null 2>&1
      command_rc=$?
      if [ "$after_verdict" = "reachable" ] && [ "$after_pid" = "$server_pid" ] \
        && [ "$command_rc" -eq 0 ]; then
        printf '{"action":"verified","createStdout":"","reachablePid":%s}\n' "$after_pid"
        return 0
      fi
    fi
  elif [ "$verdict" = "dead" ]; then
		if [ "${FLY1285_RESCUE_DRY_RUN:-0}" = "1" ]; then
			printf '{"action":"hold_unknown","evidence":{"reason":"dry_run_create_suppressed"}}\n'
			return 4
		fi
    create_stdout="$(_tmux_rescue_bounded_exec "$command_timeout" \
      "${create_argv[@]}" 2>/dev/null)"
    command_rc=$?
    if [ "$command_rc" -eq 124 ] || [ "$command_rc" -eq 125 ]; then
      printf '{"action":"hold_unknown","evidence":{"reason":"command_timeout"}}\n'
      return 4
    fi
    if [ "$command_rc" -eq 0 ]; then
      after="$(tmux_socket_inspect "$socket_path")"
      after_verdict="$(_tmux_rescue_json_field "$after" verdict)"
      after_pid="$(_tmux_rescue_json_field "$after" reachablePid)"
      if [ "$after_verdict" = "reachable" ] && [ -n "$after_pid" ] && [ "$after_pid" != "null" ]; then
        printf '{"action":"created","createStdout":"%s","reachablePid":%s}\n' \
          "$(_tmux_rescue_json_escape "$create_stdout")" "$after_pid"
        return 0
      fi
    fi
  elif [ "$verdict" = "missing_single_orphan" ]; then
    recovery="$(_tmux_socket_recover_locked "$socket_path")"
    recovery_rc=$?
    if [ "$recovery_rc" -ne 0 ]; then
      printf '%s\n' "$recovery"
      return "$recovery_rc"
    fi
    server_pid="$(_tmux_rescue_json_field "$recovery" reachablePid)"
    _tmux_rescue_bounded_exec "$command_timeout" \
      "${verify_argv[@]}" >/dev/null 2>&1
    command_rc=$?
    if [ "$command_rc" -eq 124 ] || [ "$command_rc" -eq 125 ]; then
      printf '{"action":"hold_unknown","evidence":{"reason":"command_timeout"}}\n'
      return 4
    fi
    if [ "$command_rc" -eq 0 ]; then
      after="$(tmux_socket_inspect "$socket_path")"
      after_verdict="$(_tmux_rescue_json_field "$after" verdict)"
      after_pid="$(_tmux_rescue_json_field "$after" reachablePid)"
      if [ "$after_verdict" = "reachable" ] && [ "$after_pid" = "$server_pid" ]; then
        printf '{"action":"rescued_then_verified","createStdout":"","reachablePid":%s}\n' "$after_pid"
        return 0
      fi
    fi
		if [ "${FLY1285_RESCUE_DRY_RUN:-0}" = "1" ]; then
			printf '{"action":"hold_unknown","evidence":{"reason":"dry_run_create_suppressed"}}\n'
			return 4
		fi
    guarded_create=("${create_argv[0]}" -N "${create_argv[@]:1}")
    create_stdout="$(_tmux_rescue_bounded_exec "$command_timeout" \
      "${guarded_create[@]}" 2>/dev/null)"
    command_rc=$?
    if [ "$command_rc" -eq 124 ] || [ "$command_rc" -eq 125 ]; then
      printf '{"action":"hold_unknown","evidence":{"reason":"command_timeout"}}\n'
      return 4
    fi
    if [ "$command_rc" -eq 0 ]; then
      after="$(tmux_socket_inspect "$socket_path")"
      after_verdict="$(_tmux_rescue_json_field "$after" verdict)"
      after_pid="$(_tmux_rescue_json_field "$after" reachablePid)"
      if [ "$after_verdict" = "reachable" ] && [ "$after_pid" = "$server_pid" ]; then
        printf '{"action":"rescued_then_created","createStdout":"%s","reachablePid":%s}\n' \
          "$(_tmux_rescue_json_escape "$create_stdout")" "$after_pid"
        return 0
      fi
    fi
  fi
  case "$verdict" in
    saturated)
      printf '{"action":"hold_saturated","evidence":{"reason":"socket_present_unreachable"}}\n'
      return 2
      ;;
    split_brain|ambiguous)
      printf '{"action":"hold_%s","evidence":{"reason":"multiple_server_candidates"}}\n' "$verdict"
      return 3
      ;;
    *)
      reason="$verdict"
      [ "$before_timed_out" = "true" ] && reason="inspect_timeout"
      printf '{"action":"hold_unknown","evidence":{"reason":"%s"}}\n' "$reason"
      return 4
      ;;
  esac
}

_tmux_socket_recover_locked() {
  local socket_path="$1" inspection timed_out verdict server_pid candidate before_signal reason
	_tmux_rescue_write_owner_metadata "$socket_path" || true
  _tmux_rescue_prepare_runtime
  if _tmux_rescue_budget_exhausted; then
    printf '{"action":"hold_unknown","evidence":{"reason":"rescue_failed"}}\n'
    return 4
  fi
  inspection="$(tmux_socket_inspect "$socket_path")"
  timed_out="$(_tmux_rescue_json_field "$inspection" timedOut)"
  verdict="$(_tmux_rescue_json_field "$inspection" verdict)"
  server_pid="$(_tmux_rescue_json_field "$inspection" reachablePid)"
  case "$verdict" in
    reachable)
      printf '{"action":"reachable","reachablePid":%s}\n' "$server_pid"
      return 0
      ;;
    saturated)
      printf '{"action":"hold_saturated","evidence":{"reason":"socket_present_unreachable"}}\n'
      return 2
      ;;
    split_brain|ambiguous)
      printf '{"action":"hold_%s","evidence":{"reason":"multiple_server_candidates"}}\n' "$verdict"
      return 3
      ;;
    missing_single_orphan)
      if ! tmux_rescue_activation_enabled; then
        printf '{"action":"hold_unknown","evidence":{"reason":"marker_disabled"}}\n'
        return 4
      fi
      candidate="$(_tmux_rescue_single_candidate "$inspection")" || {
        printf '{"action":"hold_unknown","evidence":{"reason":"candidate_parse_failed"}}\n'
        return 4
      }
      # Signal-time revalidation: repeat the full ps+lsof scan immediately
      # before the destructive signal and require the exact same sole orphan.
      if _tmux_rescue_budget_exhausted; then
        printf '{"action":"hold_unknown","evidence":{"reason":"rescue_failed"}}\n'
        return 4
      fi
      before_signal="$(tmux_socket_inspect "$socket_path")"
      if _tmux_rescue_budget_exhausted; then
        printf '{"action":"hold_unknown","evidence":{"reason":"rescue_failed"}}\n'
        return 4
      fi
      [ "$(_tmux_rescue_json_field "$before_signal" verdict)" = "missing_single_orphan" ] \
        && [ "$(_tmux_rescue_single_candidate "$before_signal")" = "$candidate" ] || {
          printf '{"action":"hold_unknown","evidence":{"reason":"candidate_changed_before_signal"}}\n'
          return 4
        }
		if [ "${FLY1285_RESCUE_DRY_RUN:-0}" = "1" ]; then
			printf '{"action":"hold_unknown","evidence":{"reason":"dry_run_signal_suppressed"}}\n'
			return 4
		fi
      _tmux_rescue_signal_candidate "$candidate" 2>/dev/null || {
        printf '{"action":"hold_unknown","evidence":{"reason":"signal_failed"}}\n'
        return 4
      }

      local attempt=0 max_attempts="${FLYWHEEL_TMUX_RESCUE_RECOVER_ATTEMPTS:-20}"
      while [ "$attempt" -lt "$max_attempts" ]; do
        if _tmux_rescue_budget_exhausted; then
          printf '{"action":"hold_unknown","evidence":{"reason":"rescue_failed"}}\n'
          return 4
        fi
        inspection="$(tmux_socket_inspect "$socket_path")"
        if _tmux_rescue_budget_exhausted; then
          printf '{"action":"hold_unknown","evidence":{"reason":"rescue_failed"}}\n'
          return 4
        fi
        verdict="$(_tmux_rescue_json_field "$inspection" verdict)"
        server_pid="$(_tmux_rescue_json_field "$inspection" reachablePid)"
        if [ "$verdict" = "reachable" ] && [ "$server_pid" = "$candidate" ]; then
          printf '{"action":"rescued","reachablePid":%s}\n' "$server_pid"
          return 0
        fi
        attempt=$((attempt + 1))
        [ "$attempt" -lt "$max_attempts" ] && sleep 0.25
      done
      printf '{"action":"hold_unknown","evidence":{"reason":"rescue_failed"}}\n'
      return 4
      ;;
  esac
  reason="$verdict"
  [ "$timed_out" = "true" ] && reason="inspect_timeout"
  printf '{"action":"hold_unknown","evidence":{"reason":"%s"}}\n' "$reason"
  return 4
}

_tmux_rescue_lock_hash() {
  local value="$1"
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$value" | shasum -a 256 | awk '{print substr($1,1,16)}'
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$value" | sha256sum | awk '{print substr($1,1,16)}'
    return
  fi
  return 1
}

_tmux_rescue_write_owner_metadata() {
	local socket_path="$1" lock_hash lock_dir owner_file tmp start_identity token ps_bin
	lock_hash="$(_tmux_rescue_lock_hash "$socket_path")" || return 1
	lock_dir="${HOME}/.flywheel/locks"
	owner_file="${lock_dir}/tmux-${lock_hash}.owner"
	umask 077
	mkdir -p "$lock_dir" 2>/dev/null || return 1
	ps_bin="$(command -v ps 2>/dev/null || true)"
	[ -x /bin/ps ] && ps_bin=/bin/ps
	start_identity="$($ps_bin -p $$ -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//' || true)"
	[ -n "$start_identity" ] || start_identity="unknown-$(date +%s)"
	token="$(uuidgen 2>/dev/null || printf '%s-%s-%s' "$(date +%s)" "$$" "${RANDOM:-0}")"
	tmp="${owner_file}.$$.$token.tmp"
	{
		printf 'pid=%s\n' "$$"
		printf 'startIdentity=%s\n' "$start_identity"
		printf 'token=%s\n' "$token"
	} > "$tmp" || return 1
	chmod 600 "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
	mv -f "$tmp" "$owner_file"
}

_tmux_rescue_has_flock() {
  command -v flock >/dev/null 2>&1
}

_tmux_rescue_has_lockf() {
  command -v lockf >/dev/null 2>&1
}

_tmux_rescue_has_python_fcntl() {
  [ -x /usr/bin/python3 ] && /usr/bin/python3 -c 'import fcntl' >/dev/null 2>&1
}

_tmux_rescue_select_lock_backend() {
  if _tmux_rescue_has_flock; then printf 'flock'; return 0; fi
  if _tmux_rescue_has_lockf; then printf 'lockf'; return 0; fi
  if _tmux_rescue_has_python_fcntl; then printf 'python'; return 0; fi
  return 1
}

_tmux_rescue_python_lock() {
  local timeout="$1" lock_file="$2"
  shift 2
  /usr/bin/python3 - "$timeout" "$lock_file" "$@" <<'PY'
import fcntl
import os
import sys
import time

timeout = float(sys.argv[1])
lock_path = sys.argv[2]
argv = sys.argv[3:]
fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
deadline = time.monotonic() + timeout
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= deadline:
            raise SystemExit(75)
        time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
# The command itself becomes the kernel lock owner. This matters for SIGKILL:
# there must not be a surviving Python parent/child split that keeps the lock
# alive after the PID reported as the owner has died. The fd is deliberately
# inherited across exec; bounded children inherit it too, so the lock cannot be
# released while a previously-started critical action is still completing.
os.set_inheritable(fd, True)
os.execvp(argv[0], argv)
PY
}

_tmux_rescue_run_with_lock() {
  local dispatch="$1" requested="$2"
  shift 2
  local socket_path script lock_dir lock_hash lock_file timeout rc backend
  socket_path="$(_tmux_rescue_normalize_socket "$requested")" || return 64
  script="${BASH_SOURCE[0]}"
  lock_dir="${HOME}/.flywheel/locks"
  umask 077
  mkdir -p "$lock_dir" 2>/dev/null || {
    printf '{"action":"hold_lock_unavailable","evidence":{"reason":"backend_error"}}\n'
    return 5
  }
  lock_hash="$(_tmux_rescue_lock_hash "$socket_path")" || {
    printf '{"action":"hold_lock_unavailable","evidence":{"reason":"capability_missing"}}\n'
    return 5
  }
  lock_file="${lock_dir}/tmux-${lock_hash}.lockf"
  _tmux_rescue_prepare_load_factor
  export _TMUX_RESCUE_CACHED_LOAD_FACTOR
  timeout="$(_tmux_rescue_effective_timeout lock)"
  backend="$(_tmux_rescue_select_lock_backend)" || {
    printf '{"action":"hold_lock_unavailable","evidence":{"reason":"capability_missing"}}\n'
    return 5
  }
  case "$backend" in
    flock)
      flock -w "$timeout" "$lock_file" /bin/bash "$script" "$dispatch" "$socket_path" "$@"
      rc=$?
      ;;
    lockf)
      lockf -t "$timeout" "$lock_file" /bin/bash "$script" "$dispatch" "$socket_path" "$@"
      rc=$?
      ;;
    python)
      _tmux_rescue_python_lock "$timeout" "$lock_file" /bin/bash "$script" "$dispatch" "$socket_path" "$@"
      rc=$?
      ;;
  esac
  case "$rc" in 0|2|3|4|5|64) return "$rc" ;; esac
  printf '{"action":"hold_lock_unavailable","evidence":{"reason":"acquire_timeout"}}\n'
  return 5
}

tmux_socket_ensure() {
  local requested="$1"
  shift
  _tmux_rescue_run_with_lock _ensure_locked "$requested" "$@"
}

tmux_socket_recover() {
  _tmux_rescue_run_with_lock _recover_locked "$1"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    inspect)
      shift
      [ "$#" -eq 1 ] || { echo "usage: tmux-server-rescue inspect <socket>" >&2; exit 64; }
      tmux_socket_inspect "$1"
      ;;
    recover)
      shift
      [ "$#" -eq 1 ] || { echo "usage: tmux-server-rescue recover <socket>" >&2; exit 64; }
      tmux_socket_recover "$1"
      ;;
    ensure)
      shift
      [ "$#" -gt 1 ] || {
        echo "usage: tmux-server-rescue ensure <socket> --verify <argv...> --create <argv...>" >&2
        exit 64
      }
      tmux_socket_ensure "$@"
      ;;
    _ensure_locked)
      shift
      _tmux_socket_ensure_locked "$@"
      ;;
    _recover_locked)
      shift
      _tmux_socket_recover_locked "$@"
      ;;
    *)
      echo "usage: tmux-server-rescue inspect|recover|ensure ..." >&2
      exit 64
      ;;
  esac
fi

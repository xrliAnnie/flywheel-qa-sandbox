#!/bin/bash
# FLY-1285: inspect and safely recover a Flywheel tmux server socket.
# Sourceable by launchers and executable as a small runtime CLI.

_TMUX_RESCUE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -r "$_TMUX_RESCUE_LIB_DIR/flywheel-log.sh" ]; then
  # shellcheck source=flywheel-log.sh
  source "$_TMUX_RESCUE_LIB_DIR/flywheel-log.sh"
else
  flywheel_log_rotate_if_needed() { return 0; }
fi
if [ -x "$_TMUX_RESCUE_LIB_DIR/../lead-alert.sh" ]; then
  _TMUX_RESCUE_DEFAULT_ALERT_BIN="$_TMUX_RESCUE_LIB_DIR/../lead-alert.sh"
else
  _TMUX_RESCUE_DEFAULT_ALERT_BIN="$_TMUX_RESCUE_LIB_DIR/lead-alert.sh"
fi
FLYWHEEL_ALERT_BIN="${FLYWHEEL_TMUX_RESCUE_ALERT_BIN:-${FLYWHEEL_ALERT_BIN:-$_TMUX_RESCUE_DEFAULT_ALERT_BIN}}"
if [ -r "$_TMUX_RESCUE_LIB_DIR/flywheel-alert-lib.sh" ]; then
  # shellcheck source=flywheel-alert-lib.sh
  source "$_TMUX_RESCUE_LIB_DIR/flywheel-alert-lib.sh"
else
  printf '[tmux-rescue] WARN: optional alert library unavailable; alerts disabled\n' >&2
  flywheel_alert() { return 0; }
fi

_tmux_rescue_stat_owner_mode() {
  # GNU stat accepts `-f` but interprets it as filesystem output, so a BSD-first
  # fallback can succeed with unusable data. GNU `-c` fails cleanly on BSD stat.
  stat -c '%u %a' "$1" 2>/dev/null || stat -f '%u %Lp' "$1" 2>/dev/null
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
  awk -v load_value="$load1" -v cores="$ncpu" -v max="$max" 'BEGIN {
    if (load_value !~ /^[0-9]+([.][0-9]+)?$/ || cores !~ /^[0-9]+([.][0-9]+)?$/ || cores + 0 <= 0) {
      print 1
      exit
    }
    factor = int((load_value + 0) / (cores + 0))
    if (factor * (cores + 0) < (load_value + 0)) factor++
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

# Run one read-only probe with an operation-local timeout budget. Long-lived
# supervisors source this library once, so inheriting the enclosing rescue
# anchor would make every probe time out after the first 60 seconds of uptime.
# A subshell both refreshes that budget and preserves the caller's rescue state.
tmux_rescue_probe() (
  unset _TMUX_RESCUE_BUDGET_ANCHOR _TMUX_RESCUE_TOTAL_BUDGET
  unset _TMUX_RESCUE_CACHED_LOAD_FACTOR
  _tmux_rescue_bounded_exec "$@"
)

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
  local pid="$1" socket_path="$2" output probe rc line reported normalized timeout err_file
  command -v lsof >/dev/null 2>&1 || return 2
  timeout="$(_tmux_rescue_effective_timeout inspect)"
  err_file="$(mktemp "${TMPDIR:-/tmp}/flywheel-tmux-lsof.XXXXXX" 2>/dev/null)" || return 2
  output="$(_tmux_rescue_bounded_exec "$timeout" \
    lsof -a -p "$pid" -U -Fn 2>"$err_file")"
  rc=$?
	if [ "$rc" -eq 124 ] || [ "$rc" -eq 125 ]; then
		rm -f "$err_file"
		return 3
	fi
	# Any diagnostic means lsof itself says the descriptor scan was not clean.
	# Never use its partial/empty stdout as ownership evidence in that case.
	if [ -s "$err_file" ]; then
		rm -f "$err_file"
		return 2
	fi
	if [ "$rc" -ne 0 ]; then
		# lsof uses 1 both for a complete filtered-empty result and for generic
		# failures. The diagnostic-free requirement above rejects the latter.
		# Also require a second bounded exact-PID enumeration before accepting
		# "no Unix socket" as complete evidence.
		if [ "$rc" -eq 1 ] && kill -0 "$pid" 2>/dev/null; then
			: > "$err_file" || {
				rm -f "$err_file"
				return 2
			}
			probe="$(_tmux_rescue_bounded_exec "$timeout" \
				lsof -a -p "$pid" -Fp 2>"$err_file")"
			rc=$?
			if [ "$rc" -eq 124 ] || [ "$rc" -eq 125 ]; then
				rm -f "$err_file"
				return 3
			fi
			if [ "$rc" -ne 0 ] || [ -s "$err_file" ]; then
				rm -f "$err_file"
				return 2
			fi
			rm -f "$err_file"
			while IFS= read -r line; do
				[ "$line" = "p$pid" ] && return 1
			done <<EOF
$probe
EOF
			return 2
		fi
		rm -f "$err_file"
		return 2
	fi
  rm -f "$err_file"
  while IFS= read -r line; do
    case "$line" in
      n/*)
        reported="${line#n}"
        # Linux lsof appends socket metadata to -Fn output (for example,
        # " type=STREAM"); macOS reports only the pathname.
        case "$reported" in
          *' type=STREAM') reported="${reported% type=STREAM}" ;;
        esac
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
  local scan_complete=true reachability_timed_out=false timed_out=false candidates="" pid rc inspect_timeout

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
      # Client reachability and process ownership are independent evidence.
      # Preserve a complete exact ps+lsof proof collected below.
      reachability_timed_out=true
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
    elif [ "$reachability_timed_out" = true ]; then
      if [ -z "$candidates" ] || [ "$socket_present" != true ]; then
        # A client timeout without an exact live owner remains fail-closed.
        scan_complete=false
        verdict="unknown"
      elif [ "${candidates#*,}" != "$candidates" ]; then
        verdict="ambiguous"
      else
        # One exact live owner plus the socket inode proves saturation even
        # when the client probe itself cannot connect.
        verdict="saturated"
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

_tmux_rescue_clean_create() {
  # Keep rescue controls in this shell, but never let them (or caller secrets)
  # become the environment snapshot of a newly born tmux server.
  local timeout="$1" binary canonical_path
  shift
  case "${HOME:-}" in /*) ;; *) return 64 ;; esac
  binary="$(command -v "$1" 2>/dev/null)" || return 127
  case "$binary" in /*) ;; *) return 127 ;; esac
  shift
  canonical_path="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  local -a clean_env=(/usr/bin/env -i "PATH=$canonical_path")
  [ "${HOME+x}" = x ] && clean_env+=("HOME=$HOME")
  [ "${SHELL+x}" = x ] && clean_env+=("SHELL=$SHELL")
  [ "${USER+x}" = x ] && clean_env+=("USER=$USER")
  [ "${LOGNAME+x}" = x ] && clean_env+=("LOGNAME=$LOGNAME")
  [ "${LANG+x}" = x ] && clean_env+=("LANG=$LANG")
  [ "${TERM+x}" = x ] && clean_env+=("TERM=$TERM")
  [ "${TMPDIR+x}" = x ] && clean_env+=("TMPDIR=$TMPDIR")
  _tmux_rescue_bounded_exec "$timeout" "${clean_env[@]}" "$binary" "$@"
}

_tmux_rescue_policy_alert() {
  local socket_path="$1" reason="$2" lock_hash
  lock_hash="$(_tmux_rescue_lock_hash "$socket_path" 2>/dev/null || printf unknown)"
  flywheel_alert tmux_policy_postcondition critical \
    "tmux keepalive policy enforcement failed" \
    "The socket-locked tmux server policy could not be established: socket=$socket_path reason=$reason. Runner creation must hold until the server generation is rechecked." \
    "tmux_policy_postcondition|sockhash=$lock_hash|reason=$reason" \
    >/dev/null 2>&1 || true
  _tmux_rescue_audit "policy_postcondition_failed socket=$socket_path reason=$reason"
}

_tmux_rescue_policy_fail() {
  local socket_path="$1" reason="$2"
  _TMUX_RESCUE_POLICY_FAILURE_REASON="$reason"
  _tmux_rescue_policy_alert "$socket_path" "$reason"
  return 4
}

_tmux_rescue_policy_postcondition() {
  # This function is called only while the caller owns the normalized socket
  # lock. Prove the server generation before any mutation, make the policy
  # idempotent, then prove the same generation and both postconditions.
  local socket_path="$1" before verdict before_pid after after_verdict after_pid
  local command_timeout output rc reason
  _TMUX_RESCUE_POLICY_FAILURE_REASON=""
  _TMUX_RESCUE_POLICY_REACHABLE_PID=""
  _tmux_rescue_prepare_runtime
  command_timeout="$(_tmux_rescue_effective_timeout command)"

  before="$(tmux_socket_inspect "$socket_path")"
  verdict="$(_tmux_rescue_json_field "$before" verdict)"
  before_pid="$(_tmux_rescue_json_field "$before" reachablePid)"
  if [ "$verdict" != "reachable" ] || [ -z "$before_pid" ] \
      || [ "$before_pid" = "null" ]; then
    _tmux_rescue_policy_fail "$socket_path" policy_server_unreachable
    return $?
  fi

  _tmux_rescue_bounded_exec "$command_timeout" \
    tmux -S "$socket_path" set-option -s exit-empty off >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$rc" in 124|125) reason=policy_command_timeout ;; *) reason=policy_set_option_failed ;; esac
    _tmux_rescue_policy_fail "$socket_path" "$reason"
    return $?
  fi

  output="$(_tmux_rescue_bounded_exec "$command_timeout" \
    tmux -S "$socket_path" show-options -sv exit-empty 2>/dev/null)"
  rc=$?
  if [ "$rc" -ne 0 ] || [ "$output" != "off" ]; then
    case "$rc" in 124|125) reason=policy_command_timeout ;; *) reason=policy_option_verify_failed ;; esac
    _tmux_rescue_policy_fail "$socket_path" "$reason"
    return $?
  fi

  _tmux_rescue_bounded_exec "$command_timeout" \
    tmux -S "$socket_path" has-session -t =flywheel-keepalive >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$rc" in
      124|125)
        _tmux_rescue_policy_fail "$socket_path" policy_command_timeout
        return $?
        ;;
    esac
    # -N physically prevents a server-starting create if the proven generation
    # exits between the read and mutation.
    _tmux_rescue_bounded_exec "$command_timeout" \
      tmux -N -S "$socket_path" new-session -d -s flywheel-keepalive \
      >/dev/null 2>&1
    rc=$?
    if [ "$rc" -ne 0 ]; then
      case "$rc" in 124|125) reason=policy_command_timeout ;; *) reason=policy_keepalive_create_failed ;; esac
      _tmux_rescue_policy_fail "$socket_path" "$reason"
      return $?
    fi
  fi

  after="$(tmux_socket_inspect "$socket_path")"
  after_verdict="$(_tmux_rescue_json_field "$after" verdict)"
  after_pid="$(_tmux_rescue_json_field "$after" reachablePid)"
  if [ "$after_verdict" != "reachable" ] || [ "$after_pid" != "$before_pid" ]; then
    _tmux_rescue_policy_fail "$socket_path" policy_server_generation_changed
    return $?
  fi

  output="$(_tmux_rescue_bounded_exec "$command_timeout" \
    tmux -S "$socket_path" show-options -sv exit-empty 2>/dev/null)"
  rc=$?
  if [ "$rc" -ne 0 ] || [ "$output" != "off" ]; then
    case "$rc" in 124|125) reason=policy_command_timeout ;; *) reason=policy_option_verify_failed ;; esac
    _tmux_rescue_policy_fail "$socket_path" "$reason"
    return $?
  fi
  _tmux_rescue_bounded_exec "$command_timeout" \
    tmux -S "$socket_path" has-session -t =flywheel-keepalive >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$rc" in 124|125) reason=policy_command_timeout ;; *) reason=policy_keepalive_verify_failed ;; esac
    _tmux_rescue_policy_fail "$socket_path" "$reason"
    return $?
  fi

  _TMUX_RESCUE_POLICY_REACHABLE_PID="$after_pid"
  return 0
}

_tmux_rescue_ensure_success() {
  local socket_path="$1" action="$2" create_stdout="$3" reachable_pid="$4" rc
  _tmux_rescue_policy_postcondition "$socket_path"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '{"action":"hold_unknown","evidence":{"reason":"policy_postcondition_failed","policyReason":"%s"}}\n' \
      "$(_tmux_rescue_json_escape "${_TMUX_RESCUE_POLICY_FAILURE_REASON:-unknown}")"
    return "$rc"
  fi
  printf '{"action":"%s","createStdout":"%s","reachablePid":%s}\n' \
    "$action" "$(_tmux_rescue_json_escape "$create_stdout")" "$reachable_pid"
}

_tmux_socket_policy_enforce_locked() {
  local socket_path="$1" rc
  _tmux_rescue_write_owner_metadata "$socket_path" || true
  _tmux_rescue_prepare_runtime
  _tmux_rescue_policy_postcondition "$socket_path"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '{"action":"hold_unknown","evidence":{"reason":"%s"}}\n' \
      "$(_tmux_rescue_json_escape "${_TMUX_RESCUE_POLICY_FAILURE_REASON:-policy_postcondition_failed}")"
    return "$rc"
  fi
  printf '{"action":"policy_enforced","reachablePid":%s}\n' "$_TMUX_RESCUE_POLICY_REACHABLE_PID"
  return 0
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
        _tmux_rescue_ensure_success "$socket_path" verified "" "$after_pid"
        return $?
      fi
    fi
		if [ "${FLY1285_RESCUE_DRY_RUN:-0}" = "1" ]; then
			printf '{"action":"hold_unknown","evidence":{"reason":"dry_run_create_suppressed"}}\n'
			return 4
		fi
    guarded_create=("${create_argv[0]}" -N "${create_argv[@]:1}")
    create_stdout="$(_tmux_rescue_clean_create "$command_timeout" \
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
        _tmux_rescue_ensure_success "$socket_path" created "$create_stdout" "$after_pid"
        return $?
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
        _tmux_rescue_ensure_success "$socket_path" verified "" "$after_pid"
        return $?
      fi
    fi
  elif [ "$verdict" = "dead" ]; then
		if [ "${FLY1285_RESCUE_DRY_RUN:-0}" = "1" ]; then
			printf '{"action":"hold_unknown","evidence":{"reason":"dry_run_create_suppressed"}}\n'
			return 4
		fi
    create_stdout="$(_tmux_rescue_clean_create "$command_timeout" \
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
        _tmux_rescue_ensure_success "$socket_path" created "$create_stdout" "$after_pid"
        return $?
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
        _tmux_rescue_ensure_success "$socket_path" rescued_then_verified "" "$after_pid"
        return $?
      fi
    fi
		if [ "${FLY1285_RESCUE_DRY_RUN:-0}" = "1" ]; then
			printf '{"action":"hold_unknown","evidence":{"reason":"dry_run_create_suppressed"}}\n'
			return 4
		fi
    guarded_create=("${create_argv[0]}" -N "${create_argv[@]:1}")
    create_stdout="$(_tmux_rescue_clean_create "$command_timeout" \
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
        _tmux_rescue_ensure_success "$socket_path" rescued_then_created "$create_stdout" "$after_pid"
        return $?
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

_tmux_rescue_now() {
  if [ -x /usr/bin/python3 ]; then
    /usr/bin/python3 -c 'import time; print(f"{time.time():.6f}")'
  else
    date +%s
  fi
}

_tmux_rescue_release_now() {
  # Separate seam for the first instruction after the backend returns. Tests
  # inject this clock independently from the in-lock clock so lock-release
  # accounting never depends on host load or scheduler timing.
  _tmux_rescue_now
}

_tmux_rescue_audit() {
  local log_dir="${HOME}/.flywheel/logs"
  mkdir -p "$log_dir" 2>/dev/null || return 0
  flywheel_log_rotate_if_needed "$log_dir/tmux-rescue-audit.log"
  printf '%s %s\n' "$(_tmux_rescue_now 2>/dev/null || date +%s)" "$*" \
    >> "$log_dir/tmux-rescue-audit.log" 2>/dev/null || true
  return 0
}

_tmux_rescue_new_token() {
  local token
  token="$(uuidgen 2>/dev/null || printf '%s-%s-%s' "$(date +%s)" "$$" "${RANDOM:-0}")"
  printf '%s' "$token" | tr -cd 'A-Za-z0-9_.-'
}

_tmux_rescue_probe_mtime() {
  stat -c '%Y' "$1" 2>/dev/null || stat -f '%m' "$1" 2>/dev/null
}

_tmux_rescue_sweep_outer_pid_probes() {
  # A SIGKILL after the Bash 3.2 direct child publishes its parent PID can
  # strand a token-specific probe. Sweep only old, regular, tightly named
  # files, and cap work per invocation so cleanup cannot become lock latency.
  local lock_dir="${HOME}/.flywheel/locks" probe base token mtime now age swept=0
  now=$(date +%s) || return 0
  for probe in "$lock_dir"/.tmux-*.outer-pid; do
    [[ -e "$probe" ]] || continue
    [[ -f "$probe" && ! -L "$probe" ]] || continue
    base=${probe##*/}
    token=${base#.tmux-}
    token=${token%.outer-pid}
    case "$token" in ''|*[!A-Za-z0-9_.-]*) continue ;; esac
    mtime=$(_tmux_rescue_probe_mtime "$probe" 2>/dev/null || true)
    case "$mtime" in ''|*[!0-9]*) continue ;; esac
    age=$((now - mtime))
    [[ "$age" -ge 600 ]] || continue
    rm -f "$probe" 2>/dev/null || continue
    swept=$((swept + 1))
    [[ "$swept" -ge 32 ]] && break
  done
  return 0
}

_tmux_rescue_prepare_lock_instrumentation() {
  # Called by the outer process before it waits for the kernel lock. The child
  # inherits this immutable acquisition identity; nested recovery reuses it.
  local socket_path="$1" verb="$2" caller="$3" lock_file="$4"
  local lock_hash caller_hash state_dir token outer_pid outer_start_identity pid_probe
  case "$verb" in ensure|recover|policy-enforce) ;; *) return 1 ;; esac
  case "$caller" in ''|*[!A-Za-z0-9_.:-]*) caller="unknown" ;; esac
  lock_hash="$(_tmux_rescue_lock_hash "$socket_path")" || return 1
  caller_hash="$(_tmux_rescue_lock_hash "$caller")" || return 1
  token="$(_tmux_rescue_new_token)"
  [ -n "$token" ] || return 1
  state_dir="${HOME}/.flywheel/state/tmux-rescue-episodes"
  mkdir -p "$state_dir" "${HOME}/.flywheel/locks" 2>/dev/null || return 1
  _tmux_rescue_sweep_outer_pid_probes
  # The post-lock decision belongs to this outer invocation, not the backend
  # child that will inherit the instrumentation environment. A later holder
  # may replay the decision only after this exact process incarnation is gone;
  # otherwise two live contenders can both attempt the same alert.
  outer_pid="${BASHPID:-}"
  if [ -z "$outer_pid" ]; then
    # Bash 3.2 has no BASHPID and keeps $$ equal to the top-level shell inside
    # background subshells. A direct child writes its parent without command
    # substitution; command substitution would insert another shell and leave
    # us recording that already-dead intermediate process instead.
    pid_probe="${HOME}/.flywheel/locks/.tmux-${token}.outer-pid"
    /bin/sh -c 'umask 077; set -C; printf "%s\n" "$PPID" > "$1"' \
      _ "$pid_probe" 2>/dev/null || return 1
    chmod 600 "$pid_probe" 2>/dev/null || { rm -f "$pid_probe"; return 1; }
    IFS= read -r outer_pid < "$pid_probe" || { rm -f "$pid_probe"; return 1; }
    rm -f "$pid_probe" 2>/dev/null || return 1
  fi
  case "$outer_pid" in ''|*[!0-9]*) return 1 ;; esac
  outer_start_identity="$(_tmux_rescue_process_start_identity "$outer_pid" || true)"
  _TMUX_RESCUE_TOKEN="$token"
  _TMUX_RESCUE_VERB="$verb"
  _TMUX_RESCUE_CALLER="$caller"
  _TMUX_RESCUE_SOCKET="$socket_path"
  _TMUX_RESCUE_LOCK_FILE="$lock_file"
  _TMUX_RESCUE_ACQUISITION_FILE="${HOME}/.flywheel/locks/tmux-${lock_hash}.${token}.acquired"
  _TMUX_RESCUE_DECISION_FILE="${HOME}/.flywheel/locks/tmux-${lock_hash}.${token}.decision"
  _TMUX_RESCUE_EPISODE_FILE="${state_dir}/${lock_hash}-${verb}-${caller_hash}.state"
  _TMUX_RESCUE_TAIL_FILE="${state_dir}/${lock_hash}-${verb}-${caller_hash}.release-tail.state"
  _TMUX_RESCUE_OUTER_PID="$outer_pid"
  _TMUX_RESCUE_OUTER_START_IDENTITY="$outer_start_identity"
  export _TMUX_RESCUE_TOKEN _TMUX_RESCUE_VERB _TMUX_RESCUE_CALLER
  export _TMUX_RESCUE_SOCKET _TMUX_RESCUE_LOCK_FILE
  export _TMUX_RESCUE_ACQUISITION_FILE _TMUX_RESCUE_DECISION_FILE
  export _TMUX_RESCUE_EPISODE_FILE _TMUX_RESCUE_TAIL_FILE
  export _TMUX_RESCUE_OUTER_PID _TMUX_RESCUE_OUTER_START_IDENTITY
}

_tmux_rescue_begin_acquisition() {
  # First controlled action after the backend child owns the kernel lock.
  local socket_path="$1" acquired_at tmp
  [ "${_TMUX_RESCUE_SOCKET:-}" = "$socket_path" ] || return 1
  [ -n "${_TMUX_RESCUE_ACQUISITION_FILE:-}" ] || return 1
  acquired_at="$(_tmux_rescue_now)" || return 1
  tmp="${_TMUX_RESCUE_ACQUISITION_FILE}.$$.$RANDOM.tmp"
  {
    printf 'token=%s\n' "$_TMUX_RESCUE_TOKEN"
    printf 'acquiredAt=%s\n' "$acquired_at"
    printf 'verb=%s\n' "$_TMUX_RESCUE_VERB"
    printf 'caller=%s\n' "$_TMUX_RESCUE_CALLER"
    printf 'outerPid=%s\n' "$_TMUX_RESCUE_OUTER_PID"
    printf 'outerStartIdentity=%s\n' "$_TMUX_RESCUE_OUTER_START_IDENTITY"
  } > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null || true; return 1; }
  chmod 600 "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$_TMUX_RESCUE_ACQUISITION_FILE" || return 1
  _TMUX_RESCUE_ACQUIRED_AT="$acquired_at"
  export _TMUX_RESCUE_ACQUIRED_AT
  _tmux_rescue_write_owner_metadata "$socket_path" || true
  return 0
}

_tmux_rescue_state_value() {
  local file="$1" key="$2"
  awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$file" 2>/dev/null
}

_tmux_rescue_after_decision_prepare() {
  # Test seam: production callers keep this as a no-op.
  return 0
}

_tmux_rescue_after_state_commit() {
  # Test seam: production callers keep this as a no-op.
  return 0
}

_tmux_rescue_write_decision() {
  local state_committed="$1" hold="$2" should_alert="$3" counter="$4" backend_rc="$5"
  local tail_should_alert="$6" tail_counter="$7" episode_state="$8"
  local tmp
  tmp="${_TMUX_RESCUE_DECISION_FILE}.$$.$RANDOM.tmp"
  {
    printf 'token=%s\n' "$_TMUX_RESCUE_TOKEN"
    printf 'holdSec=%s\n' "$hold"
    printf 'shouldAlert=%s\n' "$should_alert"
    printf 'episodeCounter=%s\n' "$counter"
    printf 'backendRc=%s\n' "$backend_rc"
    printf 'stateCommitted=%s\n' "$state_committed"
    printf 'tailShouldAlert=%s\n' "$tail_should_alert"
    printf 'tailEpisodeCounter=%s\n' "$tail_counter"
    printf 'episodeState=%s\n' "$episode_state"
  } > "$tmp" 2>/dev/null && chmod 600 "$tmp" 2>/dev/null \
    && mv -f "$tmp" "$_TMUX_RESCUE_DECISION_FILE" 2>/dev/null \
    || { rm -f "$tmp" 2>/dev/null || true; return 1; }
}

_tmux_rescue_finish_acquisition() {
  # Runs inside the kernel lock. Episode RMW and the token-scoped decision are
  # completed before the backend process exits and releases the lock.
  local socket_path="$1" backend_rc="$2" acquired_at now hold threshold
  local last_state="normal" normal_streak=0 counter=0 cooldown_until=0 state_token=""
  local required_streak cooldown_sec is_long=0 should_alert=0 tmp line
  local tail_should_alert=0 tail_counter=0
  [ "${_TMUX_RESCUE_SOCKET:-}" = "$socket_path" ] || return 0
  [ -f "${_TMUX_RESCUE_ACQUISITION_FILE:-}" ] || return 0
  acquired_at="$(_tmux_rescue_state_value "$_TMUX_RESCUE_ACQUISITION_FILE" acquiredAt)"
  case "$acquired_at" in ''|*[!0-9.]*) return 0 ;; esac
  threshold="${FLYWHEEL_TMUX_RESCUE_HOLD_WARN_SEC:-5}"
  awk -v v="$threshold" 'BEGIN { exit !(v ~ /^[0-9]+([.][0-9]+)?$/) }' \
    || threshold=5
  required_streak="${FLYWHEEL_TMUX_RESCUE_NORMAL_STREAK:-2}"
  case "$required_streak" in ''|*[!0-9]*) required_streak=2 ;; esac
  [ "$required_streak" -ge 1 ] 2>/dev/null || required_streak=2
  cooldown_sec="${FLYWHEEL_TMUX_RESCUE_ALERT_COOLDOWN_SEC:-0}"
  awk -v v="$cooldown_sec" 'BEGIN { exit !(v ~ /^[0-9]+([.][0-9]+)?$/) }' \
    || cooldown_sec=0
  if [ -f "$_TMUX_RESCUE_EPISODE_FILE" ]; then
    line="$(cat "$_TMUX_RESCUE_EPISODE_FILE" 2>/dev/null || true)"
    IFS='|' read -r last_state normal_streak counter cooldown_until state_token <<EOF
$line
EOF
    case "$last_state" in normal|long) ;; *) last_state="normal" ;; esac
    case "$normal_streak" in ''|*[!0-9]*) normal_streak=0 ;; esac
    case "$counter" in ''|*[!0-9]*) counter=0 ;; esac
    case "$cooldown_until" in ''|*[!0-9.]*) cooldown_until=0 ;; esac
  fi
  # Read-side instrumentation belongs to the critical section too. Take the
  # decision clock only after the episode state is fully available.
  now="$(_tmux_rescue_now)" || return 0
  hold="$(awk -v n="$now" -v a="$acquired_at" 'BEGIN { v=n-a; if (v<0) v=0; printf "%.6f", v }')"
  tail_counter="$counter"
  if [ "$last_state" != "long" ] \
      && awk -v n="$now" -v c="$cooldown_until" 'BEGIN { exit !((n+0) >= (c+0)) }'; then
    tail_should_alert=1
    tail_counter=$((counter + 1))
  fi
  awk -v h="$hold" -v t="$threshold" 'BEGIN { exit !((h+0) > (t+0)) }' \
    && is_long=1
  if [ "$is_long" = "1" ]; then
    normal_streak=0
    if [ "$last_state" != "long" ]; then
      if awk -v n="$now" -v c="$cooldown_until" 'BEGIN { exit !((n+0) >= (c+0)) }'; then
        counter=$((counter + 1))
        should_alert=1
        last_state="long"
        cooldown_until="$(awk -v n="$now" -v c="$cooldown_sec" 'BEGIN { printf "%.6f", n+c }')"
      fi
    fi
  else
    if [ "$last_state" = "long" ]; then
      normal_streak=$((normal_streak + 1))
      if [ "$normal_streak" -ge "$required_streak" ]; then
        last_state="normal"
        normal_streak=0
      fi
    else
      normal_streak=0
    fi
  fi
  # Publish an immutable prepared decision before changing persistent episode
  # state. If the child dies now, the outer process can prove no state commit
  # occurred; if it dies after the state rename, the token in that state proves
  # this exact decision committed and is safe to consume after lock release.
  _tmux_rescue_write_decision 0 "$hold" "$should_alert" "$counter" "$backend_rc" \
    "$tail_should_alert" "$tail_counter" "$last_state" \
    || return 0
  _tmux_rescue_after_decision_prepare
  tmp="${_TMUX_RESCUE_EPISODE_FILE}.$$.$RANDOM.tmp"
  printf '%s|%s|%s|%s|%s\n' "$last_state" "$normal_streak" "$counter" "$cooldown_until" "$_TMUX_RESCUE_TOKEN" \
    > "$tmp" 2>/dev/null && chmod 600 "$tmp" 2>/dev/null \
    && mv -f "$tmp" "$_TMUX_RESCUE_EPISODE_FILE" 2>/dev/null \
    || { rm -f "$tmp" 2>/dev/null || true; return 0; }
  _tmux_rescue_after_state_commit
  _tmux_rescue_write_decision 1 "$hold" "$should_alert" "$counter" "$backend_rc" \
    "$tail_should_alert" "$tail_counter" "$last_state" \
    || true
  return 0
}

_tmux_rescue_tail_transition() {
  # The true hold duration is knowable only after the main kernel lock has
  # released. Serialize that post-release classification in an independent
  # state file so tail-only overruns have durable, monotonic episodes without
  # extending the rescue critical section around alert I/O.
  local hold="$1" threshold="$2" required_streak="$3" suppress_new_alert="${4:-0}"
  [ -n "${_TMUX_RESCUE_TAIL_FILE:-}" ] || return 1
  [ -x /usr/bin/python3 ] || return 1
  /usr/bin/python3 - "$_TMUX_RESCUE_TAIL_FILE" "$hold" "$threshold" "$required_streak" "$suppress_new_alert" <<'PY'
import fcntl
import os
import signal
import sys
import tempfile

state_path, hold_raw, threshold_raw, streak_raw, suppress_raw = sys.argv[1:]
try:
    hold = float(hold_raw)
    threshold = float(threshold_raw)
    required = max(1, int(streak_raw))
    suppress_new_alert = suppress_raw == "1"
except (TypeError, ValueError):
    raise SystemExit(1)

lock_path = state_path + ".lock"
fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX)
    last = "normal"
    streak = 0
    counter = 0
    pending = 0
    try:
        with open(state_path, encoding="utf-8") as src:
            parts = src.readline().strip().split("|")
        if len(parts) in {3, 4} and parts[0] in {"normal", "long"}:
            last = parts[0]
            streak = max(0, int(parts[1]))
            counter = max(0, int(parts[2]))
            pending = max(0, int(parts[3])) if len(parts) == 4 else 0
            if pending > counter:
                raise ValueError
    except (OSError, TypeError, ValueError):
        last, streak, counter, pending = "normal", 0, 0, 0

    should = 1 if pending else 0
    alert_counter = pending
    if hold > threshold:
        streak = 0
        if last != "long":
            last = "long"
            counter += 1
            if not suppress_new_alert:
                pending = counter
                should = 1
                alert_counter = counter
    elif last == "long":
        streak += 1
        if streak >= required:
            last, streak = "normal", 0
    else:
        streak = 0

    directory = os.path.dirname(state_path)
    tmp_fd, tmp_path = tempfile.mkstemp(prefix=".release-tail.", dir=directory, text=True)
    try:
        os.fchmod(tmp_fd, 0o600)
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as out:
            out.write(f"{last}|{streak}|{counter}|{pending}\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp_path, state_path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    # Hermetic crash seam: prove the durable pending decision survives the
    # exact state-commit -> stdout/alert gap. Unset in production.
    if os.environ.get("FLYWHEEL_TEST_TAIL_CRASH_AFTER_COMMIT") == "1":
        os.kill(os.getpid(), signal.SIGKILL)
    print(f"{should}|{alert_counter or counter}|{pending}")
finally:
    os.close(fd)
PY
}

_tmux_rescue_tail_ack() {
  # Clear only the exact episode whose alert attempt completed. A crash before
  # this acknowledgement leaves `pending` replayable; a crash after delivery
  # may retry the same stable signature, which downstream dedup suppresses.
  local episode="$1"
  [ -n "${_TMUX_RESCUE_TAIL_FILE:-}" ] || return 1
  [ -x /usr/bin/python3 ] || return 1
  /usr/bin/python3 - "$_TMUX_RESCUE_TAIL_FILE" "$episode" <<'PY'
import fcntl
import os
import sys
import tempfile

state_path, episode_raw = sys.argv[1:]
try:
    episode = int(episode_raw)
except (TypeError, ValueError):
    raise SystemExit(1)
lock_path = state_path + ".lock"
fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX)
    with open(state_path, encoding="utf-8") as src:
        parts = src.readline().strip().split("|")
    if len(parts) != 4 or parts[0] not in {"normal", "long"}:
        raise SystemExit(1)
    last, streak_raw, counter_raw, pending_raw = parts
    streak, counter, pending = int(streak_raw), int(counter_raw), int(pending_raw)
    if pending != episode:
        raise SystemExit(0)
    directory = os.path.dirname(state_path)
    tmp_fd, tmp_path = tempfile.mkstemp(prefix=".release-tail.", dir=directory, text=True)
    try:
        os.fchmod(tmp_fd, 0o600)
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as out:
            out.write(f"{last}|{streak}|{counter}|0\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp_path, state_path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
finally:
    os.close(fd)
PY
}

_tmux_rescue_replay_pending_decisions() {
  # A backend child commits its decision while it still owns the kernel lock,
  # but alert I/O intentionally runs only after release. If the outer process
  # dies in that gap, a later acquisition proves the prior lock is no longer
  # held and may replay the immutable token pair. Stable alert signatures make
  # a crash after delivery but before unlink safe through downstream dedup.
  local socket_path="$1" exclude_decision="${2:-}" lock_hash lock_dir decision acquisition
  local token acquired_token verb caller committed caller_hash episode_file state_token
  local outer_pid outer_start_identity observed_start process_state is_zombie
  local should hold counter expected
  lock_hash="$(_tmux_rescue_lock_hash "$socket_path")" || return 0
  lock_dir="${HOME}/.flywheel/locks"
  for decision in "$lock_dir"/tmux-"$lock_hash".*.decision; do
    [ -f "$decision" ] || continue
    [ ! -L "$decision" ] || continue
    [ "$decision" != "$exclude_decision" ] || continue
    acquisition="${decision%.decision}.acquired"
    [ -f "$acquisition" ] && [ ! -L "$acquisition" ] || continue
    token="$(_tmux_rescue_state_value "$decision" token)"
    acquired_token="$(_tmux_rescue_state_value "$acquisition" token)"
    case "$token" in ''|*[!A-Za-z0-9_.-]*) continue ;; esac
    expected="$lock_dir/tmux-${lock_hash}.${token}.decision"
    [ "$decision" = "$expected" ] && [ "$acquired_token" = "$token" ] || continue
    verb="$(_tmux_rescue_state_value "$acquisition" verb)"
    caller="$(_tmux_rescue_state_value "$acquisition" caller)"
    case "$verb" in ensure|recover|policy-enforce) ;; *) continue ;; esac
    case "$caller" in ''|*[!A-Za-z0-9_.:-]*) continue ;; esac
    outer_pid="$(_tmux_rescue_state_value "$acquisition" outerPid)"
    outer_start_identity="$(_tmux_rescue_state_value "$acquisition" outerStartIdentity)"
    if [ -n "$outer_pid" ] || [ -n "$outer_start_identity" ]; then
      case "$outer_pid" in ''|*[!0-9]*) continue ;; esac
      observed_start="$(_tmux_rescue_process_start_identity "$outer_pid" || true)"
      process_state="$(_tmux_rescue_process_state "$outer_pid" || true)"
      is_zombie=0
      case "$process_state" in Z*|z*) is_zombie=1 ;; esac
      if kill -0 "$outer_pid" 2>/dev/null \
          && [ "$is_zombie" = "0" ] \
          && { [ -z "$outer_start_identity" ] || [ -z "$observed_start" ] \
            || [ "$observed_start" = "$outer_start_identity" ]; }; then
        _tmux_rescue_audit "token=$token verb=$verb caller=$caller pending_decision_owner_alive"
        continue
      fi
    fi
    committed="$(_tmux_rescue_state_value "$decision" stateCommitted)"
    if [ "$committed" != "1" ]; then
      # The child may have committed episode state and died before rewriting
      # stateCommitted=1. Recover only while that exact token is still the
      # episode's committed token; otherwise it was merely a prepared decision.
      caller_hash="$(_tmux_rescue_lock_hash "$caller")" || continue
      episode_file="${HOME}/.flywheel/state/tmux-rescue-episodes/${lock_hash}-${verb}-${caller_hash}.state"
      state_token="$(awk -F'|' 'NF >= 5 { print $5; exit }' "$episode_file" 2>/dev/null)"
      if [ "$committed" != "0" ] || [ "$state_token" != "$token" ]; then
        rm -f "$acquisition" "$decision" 2>/dev/null || true
        continue
      fi
    fi
    should="$(_tmux_rescue_state_value "$decision" shouldAlert)"
    hold="$(_tmux_rescue_state_value "$decision" holdSec)"
    counter="$(_tmux_rescue_state_value "$decision" episodeCounter)"
    case "$should" in 0|1) ;; *) continue ;; esac
    case "$counter" in ''|*[!0-9]*) continue ;; esac
    awk -v v="$hold" 'BEGIN { exit !(v ~ /^[0-9]+([.][0-9]+)?$/) }' 2>/dev/null || continue
    if [ "$should" = "1" ]; then
      flywheel_alert tmux_rescue_hold warning \
        "tmux rescue lock held ${hold}s" \
        "A tmux rescue critical section exceeded its hold threshold after acquisition: socket=$socket_path verb=$verb caller=$caller holdSec=$hold episode=$counter." \
        "tmux_rescue_hold|sockhash=$lock_hash|verb=$verb|caller=$caller|episode=$counter"
      _tmux_rescue_audit "token=$token verb=$verb caller=$caller holdSec=$hold episode=$counter pending_decision_replayed"
    else
      _tmux_rescue_audit "token=$token verb=$verb caller=$caller pending_decision_no_alert"
    fi
    rm -f "$acquisition" "$decision" 2>/dev/null || true
  done
  return 0
}

_tmux_rescue_after_lock() {
  # The backend has returned, so the kernel lock is released before any
  # network-capable alert executable runs.
  local socket_path="$1" backend_rc="$2" end acquired_at hold should counter committed state_token
  local threshold tail_should=0 tail_counter=0 tail_pending=0 tail_override=0 tail_result="" required_streak tail_signature="" episode_state suppress_tail=0
  end="${3:-}"
  awk -v v="$end" 'BEGIN { exit !(v ~ /^[0-9]+([.][0-9]+)?$/) }' 2>/dev/null \
    || end="$(_tmux_rescue_release_now 2>/dev/null || date +%s)"
  if [ ! -f "${_TMUX_RESCUE_ACQUISITION_FILE:-}" ]; then
    _tmux_rescue_audit "token=${_TMUX_RESCUE_TOKEN:-unknown} verb=${_TMUX_RESCUE_VERB:-unknown} caller=${_TMUX_RESCUE_CALLER:-unknown} rc=$backend_rc acquisition_missing_wait_only"
    return 0
  fi
  if [ ! -f "${_TMUX_RESCUE_DECISION_FILE:-}" ]; then
    _tmux_rescue_audit "token=${_TMUX_RESCUE_TOKEN:-unknown} acquiredAt=$(_tmux_rescue_state_value "$_TMUX_RESCUE_ACQUISITION_FILE" acquiredAt) end=$end verb=${_TMUX_RESCUE_VERB:-unknown} caller=${_TMUX_RESCUE_CALLER:-unknown} rc=$backend_rc decision_missing_due_to_abnormal_exit"
    rm -f "$_TMUX_RESCUE_ACQUISITION_FILE" 2>/dev/null || true
    return 0
  fi
  committed="$(_tmux_rescue_state_value "$_TMUX_RESCUE_DECISION_FILE" stateCommitted)"
  if [ "$committed" != "1" ]; then
    state_token="$(awk -F'|' 'NF >= 5 { print $5; exit }' "${_TMUX_RESCUE_EPISODE_FILE:-/dev/null}" 2>/dev/null)"
    if [ "$committed" != "0" ] || [ "$state_token" != "${_TMUX_RESCUE_TOKEN:-}" ]; then
      _tmux_rescue_audit "token=${_TMUX_RESCUE_TOKEN:-unknown} acquiredAt=$(_tmux_rescue_state_value "$_TMUX_RESCUE_ACQUISITION_FILE" acquiredAt) end=$end verb=${_TMUX_RESCUE_VERB:-unknown} caller=${_TMUX_RESCUE_CALLER:-unknown} rc=$backend_rc decision_uncommitted_before_state"
      rm -f "$_TMUX_RESCUE_ACQUISITION_FILE" "$_TMUX_RESCUE_DECISION_FILE" 2>/dev/null || true
      return 0
    fi
    _tmux_rescue_audit "token=$_TMUX_RESCUE_TOKEN acquiredAt=$(_tmux_rescue_state_value "$_TMUX_RESCUE_ACQUISITION_FILE" acquiredAt) end=$end verb=$_TMUX_RESCUE_VERB caller=$_TMUX_RESCUE_CALLER rc=$backend_rc decision_commit_recovered"
  fi
  acquired_at="$(_tmux_rescue_state_value "$_TMUX_RESCUE_ACQUISITION_FILE" acquiredAt)"
  case "$acquired_at" in
    ''|*[!0-9.]*) hold="$(_tmux_rescue_state_value "$_TMUX_RESCUE_DECISION_FILE" holdSec)" ;;
    *) hold="$(awk -v n="$end" -v a="$acquired_at" 'BEGIN { v=n-a; if (v<0) v=0; printf "%.6f", v }')" ;;
  esac
  should="$(_tmux_rescue_state_value "$_TMUX_RESCUE_DECISION_FILE" shouldAlert)"
  counter="$(_tmux_rescue_state_value "$_TMUX_RESCUE_DECISION_FILE" episodeCounter)"
  episode_state="$(_tmux_rescue_state_value "$_TMUX_RESCUE_DECISION_FILE" episodeState)"
  [ "$episode_state" = "long" ] && suppress_tail=1
  threshold="${FLYWHEEL_TMUX_RESCUE_HOLD_WARN_SEC:-5}"
  awk -v v="$threshold" 'BEGIN { exit !(v ~ /^[0-9]+([.][0-9]+)?$/) }' 2>/dev/null \
    || threshold=5
  required_streak="${FLYWHEEL_TMUX_RESCUE_NORMAL_STREAK:-2}"
  case "$required_streak" in ''|*[!0-9]*) required_streak=2 ;; esac
  [ "$required_streak" -ge 1 ] 2>/dev/null || required_streak=2
  tail_result="$(_tmux_rescue_tail_transition "$hold" "$threshold" "$required_streak" "$suppress_tail" 2>/dev/null || true)"
  IFS='|' read -r tail_should tail_counter tail_pending <<EOF
$tail_result
EOF
  if [ "$should" != "1" ] && [ "$tail_should" = "1" ]; then
    should=1
    counter="$tail_counter"
    tail_override=1
    tail_signature="|tail=1"
  fi
  _tmux_rescue_audit "token=$_TMUX_RESCUE_TOKEN acquiredAt=$acquired_at end=$end holdSec=$hold verb=$_TMUX_RESCUE_VERB caller=$_TMUX_RESCUE_CALLER rc=$backend_rc shouldAlert=$should episode=$counter tailOverride=$tail_override"
  if [ "$should" = "1" ]; then
    flywheel_alert tmux_rescue_hold warning \
      "tmux rescue lock held ${hold}s" \
      "A tmux rescue critical section exceeded its hold threshold after acquisition: socket=$socket_path verb=$_TMUX_RESCUE_VERB caller=$_TMUX_RESCUE_CALLER holdSec=$hold episode=$counter." \
      "tmux_rescue_hold|sockhash=$(_tmux_rescue_lock_hash "$socket_path")|verb=$_TMUX_RESCUE_VERB|caller=$_TMUX_RESCUE_CALLER${tail_signature}|episode=$counter"
    # A main in-lock alert is a different delivery attempt/signature. Only a
    # selected tail override may acknowledge the durable tail episode.
    if [ "$tail_override" = "1" ] && [ -n "$tail_pending" ] && [ "$tail_pending" != "0" ]; then
      _tmux_rescue_tail_ack "$tail_pending" || \
        _tmux_rescue_audit "token=$_TMUX_RESCUE_TOKEN tail_alert_ack_failed episode=$tail_pending"
    fi
  fi
  rm -f "$_TMUX_RESCUE_ACQUISITION_FILE" "$_TMUX_RESCUE_DECISION_FILE" 2>/dev/null || true
  return 0
}

_tmux_rescue_locked_dispatch() {
  local verb="$1" socket_path="$2" fn="$3" rc=0
  shift 3
  _tmux_rescue_begin_acquisition "$socket_path" || true
  "$fn" "$@" || rc=$?
  _tmux_rescue_finish_acquisition "$socket_path" "$rc" || true
  return "$rc"
}

_tmux_rescue_process_start_identity() {
  local pid="$1" ps_bin
  ps_bin="$(command -v ps 2>/dev/null || true)"
  [ -x /bin/ps ] && ps_bin=/bin/ps
  [ -n "$ps_bin" ] || return 1
  "$ps_bin" -p "$pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//'
}

_tmux_rescue_process_state() {
  local pid="$1" ps_bin
  ps_bin="$(command -v ps 2>/dev/null || true)"
  [ -x /bin/ps ] && ps_bin=/bin/ps
  [ -n "$ps_bin" ] || return 1
  "$ps_bin" -p "$pid" -o stat= 2>/dev/null | sed 's/^[[:space:]]*//'
}

_tmux_rescue_write_owner_metadata() {
	local socket_path="$1" lock_hash lock_dir owner_file tmp start_identity token
	lock_hash="$(_tmux_rescue_lock_hash "$socket_path")" || return 1
	lock_dir="${HOME}/.flywheel/locks"
	owner_file="${lock_dir}/tmux-${lock_hash}.owner"
	umask 077
	mkdir -p "$lock_dir" 2>/dev/null || return 1
	start_identity="$(_tmux_rescue_process_start_identity "$$" || true)"
	[ -n "$start_identity" ] || start_identity="unknown-$(date +%s)"
	token="${_TMUX_RESCUE_TOKEN:-}"
	[ -n "$token" ] || token="$(uuidgen 2>/dev/null || printf '%s-%s-%s' "$(date +%s)" "$$" "${RANDOM:-0}")"
	tmp="${owner_file}.$$.$token.tmp"
	{
		printf 'pid=%s\n' "$$"
		printf 'startIdentity=%s\n' "$start_identity"
		printf 'token=%s\n' "$token"
		if [ -n "${_TMUX_RESCUE_VERB:-}" ]; then printf 'verb=%s\n' "$_TMUX_RESCUE_VERB"; fi
		if [ -n "${_TMUX_RESCUE_ACQUIRED_AT:-}" ]; then printf 'acquiredAt=%s\n' "$_TMUX_RESCUE_ACQUIRED_AT"; fi
		if [ -n "${_TMUX_RESCUE_CALLER:-}" ]; then printf 'caller=%s\n' "$_TMUX_RESCUE_CALLER"; fi
	} > "$tmp" || return 1
	chmod 600 "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
	mv -f "$tmp" "$owner_file"
}

_tmux_rescue_timeout_owner_json() {
  # Advisory evidence only: emit an owner object iff every field is bounded,
  # syntactically valid, and still matches the live process incarnation.
  local socket_path="$1" lock_hash owner_file size pid start token verb acquired caller
  local observed held now
  lock_hash="$(_tmux_rescue_lock_hash "$socket_path")" || return 0
  owner_file="${HOME}/.flywheel/locks/tmux-${lock_hash}.owner"
  if [ ! -f "$owner_file" ] || [ -L "$owner_file" ]; then
    _tmux_rescue_audit "owner_evidence_omitted reason=not_regular socket=$socket_path"
    return 0
  fi
  size="$(wc -c < "$owner_file" 2>/dev/null | tr -d ' ')"
  case "$size" in ''|*[!0-9]*) return 0 ;; esac
  if [ "$size" -gt 4096 ]; then
    _tmux_rescue_audit "owner_evidence_omitted reason=oversize socket=$socket_path size=$size"
    return 0
  fi
  pid="$(_tmux_rescue_state_value "$owner_file" pid)"
  start="$(_tmux_rescue_state_value "$owner_file" startIdentity)"
  token="$(_tmux_rescue_state_value "$owner_file" token)"
  verb="$(_tmux_rescue_state_value "$owner_file" verb)"
  acquired="$(_tmux_rescue_state_value "$owner_file" acquiredAt)"
  caller="$(_tmux_rescue_state_value "$owner_file" caller)"
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  case "$token" in ''|*[!A-Za-z0-9_.-]*) return 0 ;; esac
  case "$verb" in ensure|recover|policy-enforce) ;; *) return 0 ;; esac
  case "$caller" in ''|*[!A-Za-z0-9_.:-]*) return 0 ;; esac
  case "$acquired" in
    ''|*[!0-9.]*|.*|*.)
      _tmux_rescue_audit "owner_evidence_omitted reason=invalid_acquired_at socket=$socket_path"
      return 0
      ;;
  esac
  case "${acquired#*.}" in
    *.*)
      _tmux_rescue_audit "owner_evidence_omitted reason=invalid_acquired_at socket=$socket_path"
      return 0
      ;;
  esac
  [ -n "$start" ] || return 0
  kill -0 "$pid" 2>/dev/null || {
    _tmux_rescue_audit "owner_evidence_omitted reason=pid_dead socket=$socket_path pid=$pid"
    return 0
  }
  observed="$(_tmux_rescue_process_start_identity "$pid" || true)"
  if [ -z "$observed" ] || [ "$observed" != "$start" ]; then
    _tmux_rescue_audit "owner_evidence_omitted reason=incarnation_mismatch socket=$socket_path pid=$pid"
    return 0
  fi
  now="$(_tmux_rescue_now)"
  held="$(awk -v n="$now" -v a="$acquired" 'BEGIN { v=n-a; if (v<0) v=0; printf "%.6f", v }')"
  printf ',"owner":{"pid":%s,"startIdentity":"%s","token":"%s","verb":"%s","acquiredAt":%s,"caller":"%s","heldSec":%s}' \
    "$pid" "$(_tmux_rescue_json_escape "$start")" "$(_tmux_rescue_json_escape "$token")" \
    "$verb" "$acquired" "$(_tmux_rescue_json_escape "$caller")" "$held"
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
  local socket_path script lock_dir lock_hash lock_file timeout rc release_end backend verb caller owner_json
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
  case "$dispatch" in
    _ensure_locked) verb="ensure" ;;
    _recover_locked) verb="recover" ;;
    _policy_enforce_locked) verb="policy-enforce" ;;
    *) return 64 ;;
  esac
  caller="${FLYWHEEL_TMUX_RESCUE_CALLER:-${FUNCNAME[2]:-cli}}"
  unset _TMUX_RESCUE_TOKEN _TMUX_RESCUE_VERB _TMUX_RESCUE_CALLER
  unset _TMUX_RESCUE_SOCKET _TMUX_RESCUE_LOCK_FILE
  unset _TMUX_RESCUE_ACQUISITION_FILE _TMUX_RESCUE_DECISION_FILE
  unset _TMUX_RESCUE_EPISODE_FILE _TMUX_RESCUE_TAIL_FILE _TMUX_RESCUE_ACQUIRED_AT
  unset _TMUX_RESCUE_OUTER_PID _TMUX_RESCUE_OUTER_START_IDENTITY
  _tmux_rescue_prepare_lock_instrumentation "$socket_path" "$verb" "$caller" "$lock_file" || true
  case "$backend" in
    flock)
      flock -w "$timeout" "$lock_file" /bin/bash "$script" "$dispatch" "$socket_path" "$@"
      rc=$?
      release_end="$(_tmux_rescue_release_now 2>/dev/null || date +%s)"
      ;;
    lockf)
      lockf -t "$timeout" "$lock_file" /bin/bash "$script" "$dispatch" "$socket_path" "$@"
      rc=$?
      release_end="$(_tmux_rescue_release_now 2>/dev/null || date +%s)"
      ;;
    python)
      _tmux_rescue_python_lock "$timeout" "$lock_file" /bin/bash "$script" "$dispatch" "$socket_path" "$@"
      rc=$?
      release_end="$(_tmux_rescue_release_now 2>/dev/null || date +%s)"
      ;;
  esac
  # Replaying only after this invocation produced an acquisition receipt proves
  # it reached and released the same kernel lock. Never scan while a previous
  # holder may still be active, and exclude the current decision because its
  # release-tail classification belongs to _tmux_rescue_after_lock below.
  if [ -f "${_TMUX_RESCUE_ACQUISITION_FILE:-}" ]; then
    _tmux_rescue_replay_pending_decisions \
      "$socket_path" "${_TMUX_RESCUE_DECISION_FILE:-}" || true
  fi
  _tmux_rescue_after_lock "$socket_path" "$rc" "$release_end" || true
  case "$rc" in 0|2|3|4|5|64) return "$rc" ;; esac
  owner_json="$(_tmux_rescue_timeout_owner_json "$socket_path")"
  printf '{"action":"hold_lock_unavailable","evidence":{"reason":"acquire_timeout"%s}}\n' "$owner_json"
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

tmux_socket_policy_enforce() {
  _tmux_rescue_run_with_lock _policy_enforce_locked "$1"
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
    policy-enforce)
      shift
      [ "$#" -eq 1 ] || {
        echo "usage: tmux-server-rescue policy-enforce <socket>" >&2
        exit 64
      }
      tmux_socket_policy_enforce "$1"
      ;;
    _ensure_locked)
      shift
      _tmux_rescue_locked_dispatch ensure "$1" _tmux_socket_ensure_locked "$@"
      ;;
    _recover_locked)
      shift
      _tmux_rescue_locked_dispatch recover "$1" _tmux_socket_recover_locked "$@"
      ;;
    _policy_enforce_locked)
      shift
      _tmux_rescue_locked_dispatch policy-enforce "$1" _tmux_socket_policy_enforce_locked "$@"
      ;;
    *)
      echo "usage: tmux-server-rescue inspect|recover|ensure|policy-enforce ..." >&2
      exit 64
      ;;
  esac
fi

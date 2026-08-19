#!/usr/bin/env bash
# FLY-1887: hard bound for one-shot Codex invocations. Source-only.
# macOS Bash 3.2 compatible; never assumes Homebrew coreutils is healthy.

CODEX_GUARD_TIMEOUT_MARKER="[codex-guard] TIMEOUT"

codex_guard_state_dir() {
  printf '%s\n' "${FLYWHEEL_CODEX_GUARD_STATE_DIR:-$HOME/.flywheel/state/codex-oneshot}"
}

CODEX_GUARD_ACTIVE_ENTRY=""

_codex_guard_safe_label() {
  local value
  value="$(printf '%s' "$1" | tr -cd 'A-Za-z0-9_.-')"
  printf '%s\n' "${value:-codex}"
}

_codex_guard_write_entry() {
  local pid="$1" pgid="$2" start="$3" deadline="$4" label="$5"
  local state_dir entry tmp
  state_dir="$(codex_guard_state_dir)"
  mkdir -p "$state_dir" 2>/dev/null || return 1
  chmod 700 "$state_dir" 2>/dev/null || true
  entry="$state_dir/$pid.json"
  [[ ! -L "$entry" ]] || return 1
  tmp="$state_dir/.${pid}.json.tmp.${BASHPID:-$$}.${RANDOM:-0}"
  ( umask 077; printf '{"pid":%s,"pgid":%s,"start":"%s","deadline":%s,"label":"%s"}\n' \
      "$pid" "$pgid" "$start" "$deadline" "$(_codex_guard_safe_label "$label")" > "$tmp" ) \
    2>/dev/null || { rm -f "$tmp" 2>/dev/null || true; return 1; }
  mv -f "$tmp" "$entry" 2>/dev/null || { rm -f "$tmp" 2>/dev/null || true; return 1; }
  printf '%s\n' "$entry"
}

_codex_guard_register_pid() {
  local pid="$1" deadline="$2" label="$3" start pgid
  start="$(_codex_guard_lstart "$pid" 2>/dev/null)" || return 1
  pgid="$(_codex_guard_pgid "$pid" 2>/dev/null)" || return 1
  _codex_guard_write_entry "$pid" "$pgid" "$start" "$deadline" "$label"
}

_codex_guard_forget_entry() {
  local entry="${1:-}"
  [[ -n "$entry" ]] || return 0
  rm -f "$entry" 2>/dev/null || true
  [[ "$CODEX_GUARD_ACTIVE_ENTRY" == "$entry" ]] && CODEX_GUARD_ACTIVE_ENTRY=""
}

codex_guard_forget_active() {
  _codex_guard_forget_entry "$CODEX_GUARD_ACTIVE_ENTRY"
}

_codex_guard_ps() {
  local ps_bin="${FLYWHEEL_CODEX_PS_BIN:-ps}"
  LC_ALL=C "$ps_bin" "$@"
}

_codex_guard_lstart() {
  local value
  value="$(_codex_guard_ps -o lstart= -p "$1" 2>/dev/null)" || return 1
  # ps pads this field; normalize padding only. LC_ALL=C pins the value itself.
  value="$(printf '%s\n' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [[ -n "$value" ]] || return 1
  printf '%s\n' "$value"
}

_codex_guard_pgid() {
  local value
  value="$(_codex_guard_ps -o pgid= -p "$1" 2>/dev/null)" || return 1
  value="$(printf '%s\n' "$value" | tr -d '[:space:]')"
  case "$value" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$value"
}

_codex_guard_json_number() {
  printf '%s\n' "$1" | sed -n -E "s/.*\"$2\":([0-9]+).*/\\1/p"
}

_codex_guard_json_string() {
  printf '%s\n' "$1" | sed -n -E "s/.*\"$2\":\"([^\"]*)\".*/\\1/p"
}

_codex_guard_identity_matches() {
  local pid="$1" expected_start="$2" observed
  kill -0 "$pid" 2>/dev/null || return 1
  observed="$(_codex_guard_lstart "$pid")" || return 1
  [[ "$observed" == "$expected_start" ]]
}

# Opportunistic cleanup: only our own regular JSON records are candidates.
# Every signal is preceded by a start-identity recheck under an entry lock.
codex_guard_sweep() {
  local state_dir entry raw pid pgid start deadline now lock current_pgid target
  state_dir="$(codex_guard_state_dir)"
  mkdir -p "$state_dir" 2>/dev/null || return 0
  chmod 700 "$state_dir" 2>/dev/null || true
  now="$(date +%s)"

  for entry in "$state_dir"/*.json; do
    [[ -e "$entry" ]] || continue
    [[ -f "$entry" && ! -L "$entry" ]] || continue
    raw="$(cat "$entry" 2>/dev/null || true)"
    pid="$(_codex_guard_json_number "$raw" pid)"
    pgid="$(_codex_guard_json_number "$raw" pgid)"
    start="$(_codex_guard_json_string "$raw" start)"
    deadline="$(_codex_guard_json_number "$raw" deadline)"
    case "$pid:$pgid:$deadline" in
      *[!0-9:]*) rm -f "$entry" 2>/dev/null || true; continue ;;
      ::|:*|*:) rm -f "$entry" 2>/dev/null || true; continue ;;
    esac
    [[ -n "$start" ]] || { rm -f "$entry" 2>/dev/null || true; continue; }
    (( deadline <= now )) || continue

    if ! _codex_guard_identity_matches "$pid" "$start"; then
      rm -f "$entry" 2>/dev/null || true
      continue
    fi
    lock="${entry}.lock"
    mkdir "$lock" 2>/dev/null || continue
    if _codex_guard_identity_matches "$pid" "$start"; then
      current_pgid="$(_codex_guard_pgid "$pid" 2>/dev/null || true)"
      target="$pid"
      if [[ "$pgid" == "$pid" && "$current_pgid" == "$pid" ]]; then
        target="-$pid"
      fi
      kill -TERM -- "$target" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      if _codex_guard_identity_matches "$pid" "$start"; then
        current_pgid="$(_codex_guard_pgid "$pid" 2>/dev/null || true)"
        target="$pid"
        if [[ "$pgid" == "$pid" && "$current_pgid" == "$pid" ]]; then
          target="-$pid"
        fi
        kill -KILL -- "$target" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$entry" 2>/dev/null || true
    rmdir "$lock" 2>/dev/null || true
  done
  return 0
}

codex_guard_positive_integer() {
  case "${1:-}" in
    ''|*[!0-9]*|0) return 1 ;;
    *) return 0 ;;
  esac
}

codex_guard_timeout_binary() {
  local candidate path
  for candidate in timeout gtimeout; do
    path="$(command -v "$candidate" 2>/dev/null || true)"
    [[ -n "$path" ]] || continue
    # FLY-1887 incident invariant: X_OK is not proof that a binary can run.
    if "$path" 1 /usr/bin/true >/dev/null 2>&1; then
      printf '%s\n' "$path"
      return 0
    fi
  done
  return 1
}

_codex_guard_run_bash() {
  local timeout_seconds="$1" label="$2"
  shift 2
  local marker child_pid watchdog_pid status deadline pre_entry child_entry
  marker="$(mktemp "${TMPDIR:-/tmp}/codex-guard-timeout.XXXXXX")" || return 125
  rm -f "$marker"

  deadline=$(( $(date +%s) + timeout_seconds ))
  pre_entry="$(_codex_guard_register_pid "${BASHPID:-$$}" "$deadline" "$label" 2>/dev/null || true)"
  CODEX_GUARD_ACTIVE_ENTRY="$pre_entry"

  # Each background job leads its own process group. The timeout may therefore
  # signal the command tree without touching the caller's shell/pane group.
  set -m
  "$@" &
  child_pid=$!
  child_entry="$(_codex_guard_register_pid "$child_pid" "$deadline" "$label" 2>/dev/null || true)"
  if [[ -n "$child_entry" ]]; then
    _codex_guard_forget_entry "$pre_entry"
    CODEX_GUARD_ACTIVE_ENTRY="$child_entry"
  fi
  (
    sleep "$timeout_seconds"
    if kill -0 "$child_pid" 2>/dev/null; then
      : > "$marker"
      kill -TERM -- "-$child_pid" 2>/dev/null || kill -TERM "$child_pid" 2>/dev/null || true
      sleep 1
      kill -KILL -- "-$child_pid" 2>/dev/null || kill -KILL "$child_pid" 2>/dev/null || true
    fi
  ) >/dev/null 2>&1 &
  watchdog_pid=$!

  wait "$child_pid" 2>/dev/null
  status=$?
  kill -TERM -- "-$watchdog_pid" 2>/dev/null || kill -TERM "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  set +m
  codex_guard_forget_active

  if [[ -e "$marker" ]]; then
    rm -f "$marker"
    printf '%s label=%s budget_seconds=%s\n' "$CODEX_GUARD_TIMEOUT_MARKER" "$label" "$timeout_seconds" >&2
    return 124
  fi
  rm -f "$marker"
  return "$status"
}

_codex_guard_run_external() {
  local timeout_bin="$1" timeout_seconds="$2" label="$3"
  shift 3
  local deadline pre_entry child_entry child_pid status
  deadline=$(( $(date +%s) + timeout_seconds ))
  pre_entry="$(_codex_guard_register_pid "${BASHPID:-$$}" "$deadline" "$label" 2>/dev/null || true)"
  CODEX_GUARD_ACTIVE_ENTRY="$pre_entry"
  set -m
  "$timeout_bin" --signal=TERM --kill-after=1 "$timeout_seconds" "$@" &
  child_pid=$!
  child_entry="$(_codex_guard_register_pid "$child_pid" "$deadline" "$label" 2>/dev/null || true)"
  if [[ -n "$child_entry" ]]; then
    _codex_guard_forget_entry "$pre_entry"
    CODEX_GUARD_ACTIVE_ENTRY="$child_entry"
  fi
  wait "$child_pid" 2>/dev/null
  status=$?
  set +m
  codex_guard_forget_active
  return "$status"
}

# codex_guard_run <seconds> <label> <command> [args...]
codex_guard_run() {
  local timeout_seconds="$1" label="$2" timeout_bin status
  shift 2
  codex_guard_positive_integer "$timeout_seconds" || {
    printf '[codex-guard] CONFIG_ERROR invalid timeout: %s\n' "$timeout_seconds" >&2
    return 125
  }

  timeout_bin="$(codex_guard_timeout_binary 2>/dev/null || true)"
  if [[ -n "$timeout_bin" ]]; then
    _codex_guard_run_external "$timeout_bin" "$timeout_seconds" "$label" "$@"
    status=$?
    if [[ "$status" -eq 124 || "$status" -eq 137 ]]; then
      printf '%s label=%s budget_seconds=%s\n' "$CODEX_GUARD_TIMEOUT_MARKER" "$label" "$timeout_seconds" >&2
      return 124
    fi
    return "$status"
  fi

  _codex_guard_run_bash "$timeout_seconds" "$label" "$@"
}

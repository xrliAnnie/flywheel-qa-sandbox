#!/bin/bash
# FLY-2274: source-only launchd window primitives (Bash 3.2 compatible).

fly2264_file_mode() {
  local value=""
  if value="$(stat -c %a "$1" 2>/dev/null)" && [[ "$value" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  stat -f %Lp "$1" 2>/dev/null
}

fly2264_file_owner() {
  local value=""
  if value="$(stat -c %u "$1" 2>/dev/null)" && [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  stat -f %u "$1" 2>/dev/null
}

fly2264_plist_label() {
  python3 - "$1" <<'PY'
import plistlib, sys
try:
    with open(sys.argv[1], "rb") as handle:
        value = plistlib.load(handle).get("Label")
except Exception:
    raise SystemExit(1)
if not isinstance(value, str) or not value or "\n" in value or "\r" in value:
    raise SystemExit(1)
print(value)
PY
}

fly2264_allowed_label() {
  case "$1" in
    com.flywheel.bridge|com.flywheel.bridge-liveness-probe|com.flywheel.cmux-watcher|com.flywheel.lead.*) return 0 ;;
    *) return 1 ;;
  esac
}

# stdout: loaded | absent. Unknown transport/diagnostic returns nonzero.
fly2264_launchd_state() {
  local label="$1" uid="$2" out="" rc=0
  out="$(launchctl print "gui/${uid}/${label}" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'loaded\n'
    return 0
  fi
  case "$out" in
    *"Could not find service \"${label}\""*|*"No such process: ${label}"*)
      printf 'absent\n'
      return 0
      ;;
  esac
  printf 'launchctl state unknown for %s (rc=%s)\n' "$label" "$rc" >&2
  return 1
}

fly2264_assert_empty_updater_queue() {
  local path="$1" entry=""
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return 0
  fi
  [ -d "$path" ] && [ ! -L "$path" ] || {
    printf 'updater queue path is not a real directory: %s\n' "$path" >&2
    return 1
  }
  entry="$(find "$path" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" || {
    printf 'cannot inspect updater queue: %s\n' "$path" >&2
    return 1
  }
  [ -z "$entry" ] || {
    printf 'updater queue is not empty: %s\n' "$path" >&2
    return 1
  }
}

fly2264_assert_updater_queues_empty() {
  fly2264_assert_empty_updater_queue "${HOME}/.flywheel/self-ship-urgent.d"
}

fly2264_assert_updater_state_safe() {
  local uid="$1" label="com.flywheel.updater" state="" out="" rc=0 lines=""
  state="$(fly2264_launchd_state "$label" "$uid")" || return 1
  [ "$state" = loaded ] || return 0
  out="$(launchctl print-disabled "gui/${uid}" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'cannot determine updater enabled state (rc=%s)\n' "$rc" >&2
    return 1
  fi
  lines="$(printf '%s\n' "$out" | grep -F "\"${label}\"" || true)"
  if [ -z "$lines" ]; then
    return 0
  fi
  [ "$(printf '%s\n' "$lines" | awk 'NF {n++} END {print n+0}')" -eq 1 ] || {
    printf 'updater enabled state is ambiguous\n' >&2
    return 1
  }
  case "$lines" in
    *'=> false'*|*'=> enabled'*) return 0 ;;
    *'=> true'*|*'=> disabled'*) printf 'updater is disabled\n' >&2; return 1 ;;
    *) printf 'updater enabled state is unparseable\n' >&2; return 1 ;;
  esac
}

fly2264_assert_updater_safe() {
  fly2264_assert_updater_queues_empty && fly2264_assert_updater_state_safe "$1"
}

fly2264_validate_plist() {
  local path="$1" expected="$2" actual=""
  [ -f "$path" ] && [ ! -L "$path" ] || {
    printf 'invalid plist path for %s: %s\n' "$expected" "$path" >&2
    return 1
  }
  actual="$(fly2264_plist_label "$path")" || {
    printf 'cannot parse plist Label for %s\n' "$expected" >&2
    return 1
  }
  [ "$actual" = "$expected" ] || {
    printf 'plist Label mismatch for %s: %s\n' "$expected" "$actual" >&2
    return 1
  }
}

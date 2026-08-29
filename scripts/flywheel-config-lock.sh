#!/usr/bin/env bash
# FLY-247 inc2a (§2.1): dedicated projects-config WRITE lock.
#
# A brand-new, short-held kernel advisory lock (flock via python3 fcntl, which
# IS available on macOS — sidestepping the historical reason the restart lock
# used mkdir). It is SEPARATE from the shared restart.lock.d (kept as inc1 mkdir;
# the shared-lock unification is FLY-266). It guards the read-check-write
# critical section of every projects.json mutation (forward write, conditional
# restore, recovery write, Mufasa migration).
#
# Properties (plan §2.1):
#   - Short, synchronous hold by the currently-executing process only; the lock
#     does NOT span the cutover and is NOT inherited by detached children, so the
#     R9 #1 FD-leak class is structurally absent (the python helper holds the fd
#     for exactly the critical section and the kernel releases it on exit).
#   - Acquisition is NON-BLOCKING with a bounded deadline (R10 #2). On deadline
#     timeout the caller gets exit 75 (EX_TEMPFAIL) and decides the
#     context-specific outcome (rejected / unapplied / config-restore-conflict /
#     no-op recovery / abort migration) — this helper does NOT pick one.
#   - Recovery is automatic: the kernel releases the lock when the holder dies.
#
# Usage:
#   config_write_locked <lockfile> <deadline_secs> <cmd> [args...]
#     Runs <cmd args...> while holding an exclusive flock on <lockfile>.
#     Returns the command's exit code, or 75 if the lock could not be acquired
#     within <deadline_secs>.
#
# Source-guard so the test harness can source without executing.
# Exit code the python helper returns when the lock can't be acquired in time.
export CONFIG_LOCK_EX_TEMPFAIL=75

config_write_locked() {
  local lockfile="$1" deadline="$2"
  shift 2
  if [ "$#" -eq 0 ]; then
    echo "config_write_locked: missing command" >&2
    return 64 # EX_USAGE
  fi
  CONFIG_LOCK_FILE="$lockfile" CONFIG_LOCK_DEADLINE="$deadline" \
    python3 "${FLYWHEEL_CONFIG_LOCK_PY:-$(_config_lock_py_path)}" "$@"
}

# Resolve the bundled python helper next to this script (overridable for tests).
_config_lock_py_path() {
  local self_dir
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s/flywheel-config-lock.py' "$self_dir"
}

# When executed directly: `flywheel-config-lock.sh <lockfile> <deadline> cmd...`
if [ "${FLYWHEEL_CONFIG_LOCK_SOURCED:-0}" != "1" ] && \
   [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  config_write_locked "$@"
  exit $?
fi

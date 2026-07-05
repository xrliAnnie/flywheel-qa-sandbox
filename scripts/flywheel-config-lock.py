#!/usr/bin/env python3
"""FLY-247 inc2a (§2.1): config-write flock helper.

Holds an exclusive kernel advisory lock (fcntl.flock) on CONFIG_LOCK_FILE for
exactly the duration of the given command, then releases it. Non-blocking with a
bounded deadline: if the lock cannot be acquired within CONFIG_LOCK_DEADLINE
seconds, exit 75 (EX_TEMPFAIL) WITHOUT running the command — the caller picks the
context-specific outcome.

Env:
  CONFIG_LOCK_FILE      path to the lock file (created if absent, mode 0600)
  CONFIG_LOCK_DEADLINE  seconds to keep retrying acquisition (float)

argv[1:] is the command to run while holding the lock.

The lock fd is held only by THIS process for the critical section; the command
is a child that does NOT inherit the fd (Python sets FD_CLOEXEC by default), so
the lock can never leak into a long-lived descendant — exactly the inc2a
config-lock contract (short, synchronous, non-inherited).
"""

import os
import subprocess
import sys
import time

try:
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX
    sys.stderr.write("config-lock: fcntl unavailable on this platform\n")
    sys.exit(70)  # EX_SOFTWARE

EX_TEMPFAIL = 75
EX_USAGE = 64


def main(argv: list[str]) -> int:
    cmd = argv[1:]
    if not cmd:
        sys.stderr.write("config-lock: missing command\n")
        return EX_USAGE

    lockfile = os.environ.get("CONFIG_LOCK_FILE")
    if not lockfile:
        sys.stderr.write("config-lock: CONFIG_LOCK_FILE not set\n")
        return EX_USAGE
    try:
        deadline = float(os.environ.get("CONFIG_LOCK_DEADLINE", "5"))
    except ValueError:
        sys.stderr.write("config-lock: CONFIG_LOCK_DEADLINE must be numeric\n")
        return EX_USAGE

    fd = os.open(lockfile, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        if not _acquire(fd, deadline):
            sys.stderr.write(
                f"config-lock: could not acquire {lockfile} within {deadline}s\n"
            )
            return EX_TEMPFAIL
        try:
            # FD_CLOEXEC is on by default for os.open in CPython, so the child
            # does NOT inherit the lock fd — the hold is strictly this process.
            return subprocess.call(cmd)
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _acquire(fd: int, deadline: float) -> bool:
    # Non-blocking acquisition with a bounded retry deadline. Uses a wall-clock
    # poll loop (deadline is short — sub-second to a few seconds).
    end = time.monotonic() + max(0.0, deadline)
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            if time.monotonic() >= end:
                return False
            time.sleep(0.02)


if __name__ == "__main__":
    sys.exit(main(sys.argv))

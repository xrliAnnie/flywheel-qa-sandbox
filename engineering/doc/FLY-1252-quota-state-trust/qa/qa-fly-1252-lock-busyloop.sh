#!/usr/bin/env bash
# FLY-1252 QA — watchdog for the lock busy-loop regression (advisory ③).
#
# Runs qa-fly-1252-lock-busyloop.mjs (which asks withMkdirLock to acquire a lock
# whose PARENT dir is missing, with timeoutMs=500). BOUNDED lock logic settles
# within ~1s; a busy-loop pins a CPU forever. We give it a generous wall-clock
# budget, then declare:
#   PASS  — child settled (printed SETTLED=...) within the budget  → bounded.
#   FAIL  — child still alive after the budget                     → busy-loop.
#
# macOS has no coreutils `timeout` and this harness must not rely on it. We poll
# for the child's exit with a portable perl-based 1s tick.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
DIST="$REPO_DIR/packages/teamlead/dist"
PROBE="$SCRIPT_DIR/qa-fly-1252-lock-busyloop.mjs"
BUDGET_S="${FLY1252_LOCK_BUDGET_S:-6}"
OUT="$(mktemp "${TMPDIR:-/tmp}/fly1252-lock-busyloop.XXXXXX.out")"

log() { echo "[FLY-1252 QA lock ③] $*"; }

[[ -d "$DIST" ]] || { log "building teamlead dist"; ( cd "$REPO_DIR/packages/teamlead" && pnpm build >/dev/null ); }

node "$PROBE" "$DIST" >"$OUT" 2>&1 &
PID=$!

i=0
while [ "$i" -lt "$BUDGET_S" ]; do
  kill -0 "$PID" 2>/dev/null || break        # child exited → settled
  [ -s "$OUT" ] && break                      # child printed → settled
  perl -e 'my $t=time; 1 while (time-$t)<1;'  # portable 1s tick (no foreground sleep)
  i=$((i+1))
done

if kill -0 "$PID" 2>/dev/null && [ ! -s "$OUT" ]; then
  CPU="$(ps -o %cpu= -p "$PID" 2>/dev/null | tr -d ' ')"
  kill -9 "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  log "FAIL: withMkdirLock did NOT settle within ${BUDGET_S}s (child %cpu=${CPU:-?}) — unbounded busy-loop on missing parent dir (advisory ③)."
  log "      Regression site: packages/teamlead/src/account-heal/mkdir-lock.ts — ENOENT 'continue' bypasses the deadline check + retry backoff."
  rm -f "$OUT"
  exit 1
fi

wait "$PID" 2>/dev/null || true
log "PASS: withMkdirLock settled on a missing parent dir — $(cat "$OUT")"
rm -f "$OUT"
exit 0

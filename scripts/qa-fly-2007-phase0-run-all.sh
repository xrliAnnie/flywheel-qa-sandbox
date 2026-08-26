#!/usr/bin/env bash
# FLY-2007 — run the three Phase-0 windows in one inter-shuttle interval.
#
# WHY THIS EXISTS
#   Four separate times, a check that could not fail was mistaken for good news:
#   an `npx` package that was not the linter reporting files clean; a `[ a \> b ]`
#   comparison that errored instead of comparing, so a wait loop never fired; a
#   relative path that failed while the trailing echo returned 0; and a monitor
#   watching chain.log while the run wrote chain2.log, so the chain died at 16:54
#   and the watcher stayed green for three and a half hours.
#
#   Every one of them was ABSENCE OF BAD NEWS read as good news. So:
#     - ONE canonical log path, derived from one variable, used by runner and
#       watcher alike. Two names for the same thing is what caused the last one.
#     - the runner proves progress from ARTIFACTS (attempt dir, block lines),
#       never from an exit code
#     - a heartbeat line every loop, so a stalled chain is visibly stalled rather
#       than merely quiet
set -uo pipefail

R="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EV="${EV:-$R/engineering/doc/FLY-2007-capacity-stress-execution/evidence/phase0}"
LOGDIR="${LOGDIR:-$EV/../run-logs}"
GAP="${GAP:-600}"          # settling seconds between windows
# ⚠ `${WINDOWS:-...}` treats an EMPTY value as unset, so `WINDOWS="" ./run-all`
# silently ran the full default set - a "dry run" that launched a real 2.5-hour
# collection against production. Use `-` not `:-` so an explicit empty value is
# honoured, and offer a real --self-check that runs nothing.
WINDOWS="${WINDOWS-1 2 3}"
SELF_CHECK=0
for a in "$@"; do case "$a" in --self-check) SELF_CHECK=1 ;; esac; done

mkdir -p "$LOGDIR" || { echo "FATAL: cannot create $LOGDIR" >&2; exit 1; }
CHAIN_LOG="$LOGDIR/chain.log"
say() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$CHAIN_LOG"; }

FZ="$(git -C "$R" rev-parse HEAD)" || { say "FATAL: cannot resolve freeze commit"; exit 1; }
TOK="$(grep -E '^TEAMLEAD_API_TOKEN=' "$HOME/.flywheel/.env" | head -1 | cut -d= -f2- | tr -d '"')"
[ -n "$TOK" ] || { say "FATAL: no API token"; exit 1; }

say "chain start — freeze=$FZ evidence=$EV"
say "watch this file: $CHAIN_LOG   (window logs: $LOGDIR/window-N.log)"

if [ "$SELF_CHECK" -eq 1 ]; then
  say "self-check only: resolved freeze, token and paths; starting NO windows"
  say "CHAIN DONE (self-check)"
  exit 0
fi

for w in $WINDOWS; do
  WLOG="$LOGDIR/window-$w.log"
  say "window $w: starting"
  TEAMLEAD_API_TOKEN="$TOK" bash "$R/scripts/qa-fly-2007-phase0-run-window.sh" \
    --evidence "$EV" --window "$w" --freeze-commit "$FZ" > "$WLOG" 2>&1
  rc=$?

  # ⚠ Prove it from artifacts. rc alone has lied before.
  blocks="$(grep -c 'block b' "$WLOG" 2>/dev/null || echo 0)"
  dir="$(ls -d "$EV"/attempt-* 2>/dev/null | tail -1)"
  state="$(sed -n 's/.*"disposition":"\([a-z_]*\)".*/\1/p' "$dir/state.json" 2>/dev/null)"
  reason="$(sed -n 's/.*"reason":"\([a-z_0-9]*\)".*/\1/p' "$dir/state.json" 2>/dev/null)"
  say "window $w: rc=$rc blocks=$blocks dir=$(basename "${dir:-none}") disposition=${state:-unknown} reason=${reason:-none}"

  if [ "$rc" -ne 0 ] || [ "$state" != "completed" ]; then
    say "window $w did NOT complete (disposition=${state:-unknown}, reason=${reason:-none})"
    say "STOPPING — a service/host abort is not replaceable under the frozen rules,"
    say "so continuing would only add windows to a round that cannot certify."
    say "CHAIN STOPPED"
    exit 1
  fi
  [ "$blocks" -ge 30 ] || { say "window $w reported completed but only $blocks block lines — refusing to trust it"; say "CHAIN STOPPED"; exit 1; }

  case " $WINDOWS " in *" $w "*) ;; esac
  [ "$w" = "${WINDOWS##* }" ] || { say "settling ${GAP}s"; sleep "$GAP"; }
done

say "CHAIN DONE — all requested windows completed"

#!/bin/bash
# FLY-2829 C9: production observation watchdog for the marker-lift gate.
#
# Samples `total|managed-husks` every --interval seconds for --minutes minutes.
# A managed husk is a default `Terminal N` title or an exact managed attach /
# legacy node-status command that never received its canonical name. The slope
# judge uses only the husk count; legitimate backlog catch-up may raise the
# total. The total still has an independent hard ceiling.
# Observation itself is fail-closed: more than two consecutive failed samples,
# or a gap of more than 3×interval between valid samples, is blindness and
# trips the same protection.
#
# Usage: fly2829-prod-watchdog.sh --minutes <N≥35> [--interval 60] [--slope-max 3] [--ceiling 150]
#                                 [--marker <path>] [--out <dir>]
# Last line:
#   FLY2829-PRODGATE PASS minutes=<N> samples=<valid>/<expected> max_slope=<v>
#   FLY2829-PRODGATE TRIPPED slope=<v> samples=<a,b,c> marker=written|unwritten
#   FLY2829-PRODGATE INVALID reason=blind|coverage ... marker=written|unwritten
# Exit: 0 PASS, 1 TRIPPED, 3 INVALID.
#
# Test seams (never set in production): FLY2829_PRODGATE_SAMPLER (command
# string replacing the cmux sampler), FLY2829_PRODGATE_NOW_FILE (epoch read
# from a file instead of date), FLY2829_PRODGATE_SLEEP (sleep seconds per
# tick), FLY2829_PRODGATE_MIN_MINUTES (lower bound override).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MINUTES=""; INTERVAL=60; SLOPE_MAX=3; CEILING=150
MARKER="${FLYWHEEL_CMUX_MAINTENANCE_MARKER:-$HOME/.flywheel/state/cmux-maintenance}"
OUT=""
MIN_MINUTES="${FLY2829_PRODGATE_MIN_MINUTES:-35}"
usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --minutes) MINUTES="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --slope-max) SLOPE_MAX="${2:-}"; shift 2 ;;
    --ceiling) CEILING="${2:-}"; shift 2 ;;
    --marker) MARKER="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
for v in "$MINUTES" "$INTERVAL" "$CEILING" "$MIN_MINUTES"; do
  case "$v" in ''|*[!0-9]*) echo "--minutes/--interval/--ceiling must be positive integers" >&2; usage ;; esac
done
case "$SLOPE_MAX" in ''|*[!0-9.]*) echo "--slope-max must be numeric" >&2; usage ;; esac
(( MINUTES >= MIN_MINUTES )) || { echo "--minutes must be >= $MIN_MINUTES" >&2; usage; }
(( INTERVAL >= 1 )) || { echo "--interval must be >= 1" >&2; usage; }
case "$MARKER" in /*) ;; *) echo "--marker must be an absolute path" >&2; usage ;; esac

[[ -n "$OUT" ]] || OUT="$HOME/.flywheel/state/fly2829-prodgate/$(date -u '+%Y%m%dT%H%M%SZ')"
mkdir -p "$OUT" || { echo "cannot create $OUT" >&2; exit 2; }
echo "out=$OUT"
SAMPLES="$OUT/prod-samples.tsv"; HEARTBEAT="$OUT/watchdog.heartbeat"
printf 'epoch\ttotal\tmanaged_husks\n' > "$SAMPLES"

# shellcheck source=../lib/flywheel-alert-lib.sh
FLYWHEEL_ALERT_BIN="${FLYWHEEL_ALERT_BIN:-$ROOT/scripts/lead-alert.sh}"
source "$ROOT/scripts/lib/flywheel-alert-lib.sh"

pg_now() {
  if [[ -n "${FLY2829_PRODGATE_NOW_FILE:-}" ]]; then cat "$FLY2829_PRODGATE_NOW_FILE"; else date +%s; fi
}
pg_sleep() { sleep "${FLY2829_PRODGATE_SLEEP:-$INTERVAL}"; }
pg_sample_command() {
  if [[ -n "${FLY2829_PRODGATE_SAMPLER:-}" ]]; then
    eval "$FLY2829_PRODGATE_SAMPLER"
    return
  fi
  cmux --json --id-format both list-workspaces | python3 -c '
import json,re,shlex,sys

def managed_raw(title):
    try: words=shlex.split(title)
    except ValueError: return False
    if len(words) < 5 or words[:3] != ["env","-u","TMUX"]: return False
    command=words[3]
    base=command.rsplit("/",1)[-1]
    if base in {"flywheel-view-attach.sh","flywheel-lead-attach.sh","flywheel-node-status.sh"}:
        return True
    if command == "tmux" and words[4:6] == ["attach","-t"] and len(words) == 7:
        return words[6].startswith("=cmux-")
    if command.startswith("FLYWHEEL_CMUX_ATTACH_TMUX_BIN=") and len(words) >= 6:
        return words[4].rsplit("/",1)[-1] == "flywheel-view-attach.sh"
    return False

rows=json.load(sys.stdin).get("workspaces",[])
titles=[row.get("title","") for row in rows if isinstance(row,dict)]
husks=sum(1 for title in titles if isinstance(title,str) and
          (re.fullmatch(r"Terminal [0-9]+",title) or managed_raw(title)))
print(f"{len(rows)}|{husks}")
'
}
pg_sample() {
  # Bounded 20s sampler; prints total|managed-husks or NA.
  local tmp pid i out total husks
  tmp=$(mktemp) || { echo NA; return; }
  ( pg_sample_command ) > "$tmp" 2>/dev/null &
  pid=$!
  for i in $(seq 1 200); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; rm -f "$tmp"; echo NA; return; fi
  wait "$pid" 2>/dev/null || { rm -f "$tmp"; echo NA; return; }
  out=$(tr -d '[:space:]' < "$tmp"); rm -f "$tmp"
  case "$out" in *'|'*) total="${out%%|*}"; husks="${out#*|}" ;; *) echo NA; return ;; esac
  case "$total$husks" in ''|*[!0-9]*) echo NA; return ;; esac
  (( 10#$husks <= 10#$total )) || { echo NA; return; }
  printf '%s|%s\n' "$((10#$total))" "$((10#$husks))"
}

TRIPPED=0; TRIP_SLOPE=""; TRIP_SAMPLES=""; MARKER_STATE=unwritten; BLIND=0; BLIND_REASON=""
MAX_SLOPE=0; MAX_TOTAL=0
trip() {
  local reason="$1" detail="$2" attempt line
  [[ "$TRIPPED" == 0 ]] || return 0
  TRIPPED=1
  line="watchdog-hold: FLY-2829 prod gate tripped $reason $detail $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  for attempt in 1 2 3; do
    if mkdir -p "$(dirname "$MARKER")" 2>/dev/null && printf '%s\n' "$line" >> "$MARKER" 2>/dev/null; then
      MARKER_STATE=written; break
    fi
    sleep 2
  done
  if [[ "$MARKER_STATE" == written ]]; then
    flywheel_alert cmux_cleanup severe "cmux workspace runaway during FLY-2829 prod gate" \
      "The FLY-2829 production observation watchdog tripped ($reason $detail). The maintenance marker was written back at $MARKER; the resident watcher stops creating within one row. Samples: $SAMPLES" \
      "cmux_cleanup|fly2829-prodgate-tripped|$(date +%s)" || true
  else
    flywheel_alert cmux_cleanup severe "cmux runaway: automatic protection NOT established" \
      "The FLY-2829 watchdog tripped ($reason $detail) but could not write the maintenance marker at $MARKER after 3 attempts. Manual action required now: write the marker by hand. Samples: $SAMPLES" \
      "cmux_cleanup|fly2829-prodgate-marker-unwritten|$(date +%s)" || true
  fi
  echo "TRIP $reason $detail marker=$MARKER_STATE"
}

START=$(pg_now); END=$((START + MINUTES * 60))
EXPECTED=$((MINUTES * 60 / INTERVAL + 1))
VALID=0; NA_STREAK=0; LAST_VALID_EPOCH=""
V1=""; V2=""; V3=""; T1=""; T2=""; T3=""
while :; do
  now=$(pg_now)
  value=$(pg_sample)
  touch "$HEARTBEAT"
  if [[ "$value" == NA ]]; then
    printf '%s\tNA\tNA\n' "$now" >> "$SAMPLES"
    NA_STREAK=$((NA_STREAK + 1))
    if (( NA_STREAK > 2 )) && [[ "$BLIND" == 0 ]]; then
      BLIND=1; BLIND_REASON="blind"; trip blind "na_streak=$NA_STREAK"
    fi
  else
    total="${value%%|*}"; husks="${value#*|}"
    printf '%s\t%s\t%s\n' "$now" "$total" "$husks" >> "$SAMPLES"
    if [[ -n "$LAST_VALID_EPOCH" ]] && (( now - LAST_VALID_EPOCH > 3 * INTERVAL )) && [[ "$BLIND" == 0 ]]; then
      BLIND=1; BLIND_REASON="blind"; trip blind "gap=$((now - LAST_VALID_EPOCH))s"
    fi
    NA_STREAK=0; LAST_VALID_EPOCH="$now"; VALID=$((VALID + 1))
    (( total > MAX_TOTAL )) && MAX_TOTAL="$total"
    V1="$V2"; T1="$T2"; V2="$V3"; T2="$T3"; V3="$husks"; T3="$now"
    if (( total >= CEILING )) && [[ "$TRIPPED" == 0 ]]; then
      trip ceiling "total=$total ceiling=$CEILING"; TRIP_SLOPE="ceiling"; TRIP_SAMPLES="$total"
    fi
    if [[ -n "$V1" ]]; then
      slope=$(awk -v t1="$T1" -v t2="$T2" -v t3="$T3" -v v1="$V1" -v v2="$V2" -v v3="$V3" 'BEGIN {
        n=3; st=t1+t2+t3; sv=v1+v2+v3; stv=t1*v1+t2*v2+t3*v3; stt=t1*t1+t2*t2+t3*t3
        d=n*stt-st*st; if (d==0) { print "0"; exit }
        printf "%.3f", 60*(n*stv-st*sv)/d }')
      if awk -v s="$slope" -v m="$MAX_SLOPE" 'BEGIN{exit !(s>m)}'; then MAX_SLOPE="$slope"; fi
      if awk -v s="$slope" -v m="$SLOPE_MAX" 'BEGIN{exit !(s>m)}' && [[ "$TRIPPED" == 0 ]]; then
        TRIP_SLOPE="$slope"; TRIP_SAMPLES="$V1,$V2,$V3"; trip husks "slope=$slope/min samples=$V1,$V2,$V3"
      fi
    fi
  fi
  now=$(pg_now)
  (( now >= END )) && break
  pg_sleep
  (( $(pg_now) >= END )) && break
done
touch "$HEARTBEAT"

need=$((EXPECTED - 2)); (( need < 3 )) && need=3
if [[ "$BLIND" == 1 ]]; then
  echo "FLY2829-PRODGATE INVALID reason=blind samples=$VALID/$EXPECTED marker=$MARKER_STATE"; exit 3
elif [[ "$TRIPPED" == 1 ]]; then
  echo "FLY2829-PRODGATE TRIPPED slope=${TRIP_SLOPE:-ceiling} samples=${TRIP_SAMPLES} marker=$MARKER_STATE"; exit 1
elif (( VALID < need )); then
  echo "FLY2829-PRODGATE INVALID reason=coverage samples=$VALID/$EXPECTED marker=$MARKER_STATE"; exit 3
else
  echo "FLY2829-PRODGATE PASS minutes=$MINUTES samples=$VALID/$EXPECTED max_slope=$MAX_SLOPE max_total=$MAX_TOTAL"; exit 0
fi

#!/usr/bin/env bash
set -uo pipefail

misconfigured() {
  printf 'TRIPWIRE MISCONFIGURED (FLY-1870): %s\n' "$1" >&2
  exit 1
}

cap_minutes=""
threshold_pct=""
start_file=""
now_epoch=""
seen_cap=0
seen_threshold=0
seen_start=0
seen_now=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --cap-minutes)
      [ "$seen_cap" -eq 0 ] || misconfigured "duplicate --cap-minutes"
      [ "$#" -ge 2 ] || misconfigured "--cap-minutes requires a value"
      cap_minutes="$2"; seen_cap=1; shift 2
      ;;
    --threshold-pct)
      [ "$seen_threshold" -eq 0 ] || misconfigured "duplicate --threshold-pct"
      [ "$#" -ge 2 ] || misconfigured "--threshold-pct requires a value"
      threshold_pct="$2"; seen_threshold=1; shift 2
      ;;
    --start-file)
      [ "$seen_start" -eq 0 ] || misconfigured "duplicate --start-file"
      [ "$#" -ge 2 ] || misconfigured "--start-file requires a value"
      start_file="$2"; seen_start=1; shift 2
      ;;
    --now-epoch)
      [ "$seen_now" -eq 0 ] || misconfigured "duplicate --now-epoch"
      [ "$#" -ge 2 ] || misconfigured "--now-epoch requires a value"
      now_epoch="$2"; seen_now=1; shift 2
      ;;
    *)
      misconfigured "unknown argument: $1"
      ;;
  esac
done

[ "$seen_cap" -eq 1 ] || misconfigured "missing --cap-minutes"
[ "$seen_threshold" -eq 1 ] || misconfigured "missing --threshold-pct"
[ "$seen_start" -eq 1 ] || misconfigured "missing --start-file"
[[ "$cap_minutes" =~ ^[1-9][0-9]*$ ]] || misconfigured "--cap-minutes must be a positive integer"
[[ "$threshold_pct" =~ ^[1-9][0-9]*$ ]] || misconfigured "--threshold-pct must be an integer from 1 to 100"
[ "$threshold_pct" -le 100 ] || misconfigured "--threshold-pct must be an integer from 1 to 100"
[ -f "$start_file" ] || misconfigured "start file does not exist: $start_file"

start_epoch="$(<"$start_file")"
[[ "$start_epoch" =~ ^[1-9][0-9]*$ ]] || misconfigured "start file must contain one positive integer epoch"

if [ "$seen_now" -eq 0 ]; then
  now_epoch="$(date +%s)" || misconfigured "date +%s failed"
fi
[[ "$now_epoch" =~ ^[1-9][0-9]*$ ]] || misconfigured "--now-epoch/date must be a positive integer epoch"
[ "$start_epoch" -le "$now_epoch" ] || misconfigured "start epoch is in the future"

cap_seconds=$((cap_minutes * 60))
budget_seconds=$((cap_seconds * threshold_pct / 100))
elapsed_seconds=$((now_epoch - start_epoch))
usage_pct=$((elapsed_seconds * 100 / cap_seconds))

printf '[tripwire] elapsed=%ss budget=%ss cap=%ss usage=%s%%\n' \
  "$elapsed_seconds" "$budget_seconds" "$cap_seconds" "$usage_pct"

if [ "$elapsed_seconds" -ge "$budget_seconds" ]; then
  cat >&2 <<'EOF'
CAPACITY TRIPWIRE (FLY-1870)
This is NOT flakiness — this shard is approaching its timeout cliff.
Rebalance whole suite steps between the script-tests shards, or add a shard;
see ci.yml and engineering/doc/FLY-1870-script-tests-timeout-cliff/plan.md §5.
Raise the timeout cap only as a last resort.
EOF
  exit 1
fi

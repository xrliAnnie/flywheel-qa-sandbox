#!/usr/bin/env bash
# read-only baseline sampler: load + /health latency
OUT="$1"; N="${2:-360}"
echo "ts,load1,http,secs" > "$OUT"
for i in $(seq 1 "$N"); do
  L=$(sysctl -n vm.loadavg | awk '{print $2}')
  R=$(curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time 60 http://localhost:9876/health 2>/dev/null)
  echo "$(date +%s),$L,${R// /,}" >> "$OUT"
  sleep 0.5
done

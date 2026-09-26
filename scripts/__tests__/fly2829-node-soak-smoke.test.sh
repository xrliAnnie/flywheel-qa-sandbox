#!/bin/bash
# FLY-2829 C8: CI smoke of the hermetic soak harness — a 200-row stale node
# registry (one PRUNE_BATCH_MAX round, above the 100-row backup threshold),
# 3 live executions, 3 minutes of the real --watch loop. Founder A removed
# node cards, so live fixtures remain registry-only and create zero workspaces.
# Nothing here touches production cmux, tmux or state: the harness redirects
# HOME and every state path into its own temp root.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SB="$(mktemp -d -t fly2829-soak-smoke-XXXXXX)"
trap 'rm -rf "$SB"' EXIT
pass=0 fail=0
ok() { pass=$((pass + 1)); printf 'PASS: %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# Synthetic production-shaped registry: the event path admitted these rows
# with title `-` and no authority title; the sessions ended long ago.
python3 - "$SB/registry" <<'PY'
import sys, time
now = int(time.time()); old = now - 40 * 3600
with open(sys.argv[1], "w") as f:
    for i in range(1, 201):
        state = ["admitted", "unresolved-summary", "active-windowless"][i % 3]
        missing = 2 if state == "unresolved-summary" else 0
        summary = 1 if state == "unresolved-summary" else 0
        f.write("stale-exec-%d|-|-|%s|%d|1-1|0|0|%d|%d|-|1-1|%d\n" % (i, state, old, missing, summary, old if summary else 0))
PY

OUT="$SB/out"
rc=0
FLY2829_SOAK_SAMPLE_INTERVAL=30 bash "$ROOT/scripts/qa/fly2829-node-soak.sh" \
  --registry "$SB/registry" --smoke --minutes 3 --live-fixture 3 --out "$OUT" > "$SB/harness.log" 2>&1 || rc=$?
last=$(grep '^FLY2829-SOAK ' "$SB/harness.log" | tail -1)
echo "harness: $last (rc=$rc)"

samples=$(printf '%s\n' "$last" | sed -n 's/.* samples=\([0-9]*\).*/\1/p')
creates=$(printf '%s\n' "$last" | sed -n 's/.* creates=\([0-9]*\).*/\1/p')
end=$(printf '%s\n' "$last" | sed -n 's/.* end=\([0-9]*\).*/\1/p')
if [[ "$rc" == 0 && "$last" == "FLY2829-SOAK smoke PASS "* && "${samples:-0}" -ge 3 \
   && "$creates" == 0 && "$end" == 0 ]]; then
  ok "smoke soak passes with samples>=3 and live fixtures creating no node cards"
else
  bad "smoke soak did not pass: rc=$rc last=[$last]"
  echo "--- harness log ---"; sed -n '1,80p' "$SB/harness.log"
  echo "--- samples ---"; cat "$OUT/samples.tsv" 2>/dev/null
  echo "--- watcher log (tail) ---"; tail -60 "$OUT"/watcher-1.log 2>/dev/null
fi
if grep -q 'node presence round=' "$OUT"/watcher-1.log 2>/dev/null \
   && grep -q '\[audit\] node prune ' "$OUT"/watcher-1.log 2>/dev/null; then
  ok "the real watcher ran node presence rounds and pruned stale rows"
else
  bad "watcher log shows no node presence round or no prune audit line"
  tail -40 "$OUT"/watcher-1.log 2>/dev/null
fi
final_registry=$(grep -c . "$OUT/registry-final" 2>/dev/null || true)
if (( final_registry < 200 )) && [[ -f "$OUT/registry-final.pre-FLY-2829" || -f "$OUT/registry-backup" ]] ; then
  ok "final registry shrank to $final_registry rows and the one-time backup exists"
elif (( final_registry < 200 )); then
  ok "final registry shrank to $final_registry rows"
else
  bad "final registry did not shrink: $final_registry rows"
fi

printf '\nFLY-2829 soak smoke: %s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]

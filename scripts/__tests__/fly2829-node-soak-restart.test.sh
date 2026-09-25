#!/bin/bash
# FLY-2829 C8 restart-budget mode: the create budget is a rolling window in a
# durable ledger. Founder A removed node cards, so a watcher killed and
# relaunched every 30s must create no workspaces at all across instances.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SB="$(mktemp -d -t fly2829-soak-restart-XXXXXX)"
trap 'rm -rf "$SB"' EXIT
pass=0 fail=0
ok() { pass=$((pass + 1)); printf 'PASS: %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL: %s\n' "$1" >&2; }

OUT="$SB/out"
rc=0
FLYWHEEL_CMUX_CREATE_BURST_MAX=20 FLYWHEEL_CMUX_CREATE_BURST_SECONDS=60 FLY2829_SOAK_SAMPLE_INTERVAL=30 \
  bash "$ROOT/scripts/qa/fly2829-node-soak.sh" \
  --registry /dev/null --smoke --minutes 3 --restart-every 30 --live-fixture 25 --out "$OUT" > "$SB/harness.log" 2>&1 || rc=$?
last=$(grep '^FLY2829-SOAK ' "$SB/harness.log" | tail -1)
echo "harness: $last (rc=$rc)"

instances=$(printf '%s\n' "$last" | sed -n 's/.* instances=\([0-9]*\).*/\1/p')
creates=$(printf '%s\n' "$last" | sed -n 's/.* creates=\([0-9]*\).*/\1/p')
max_burst=$(printf '%s\n' "$last" | sed -n 's/.* max_burst=\([0-9]*\)\/60s.*/\1/p')
terms=$(printf '%s\n' "$last" | sed -n 's/.* terms_ok=\([0-9]*\/[0-9]*\).*/\1/p')
if [[ "$rc" == 0 && "$last" == "FLY2829-SOAK restart PASS "* ]]; then
  ok "restart-budget soak passes"
else
  bad "restart-budget soak did not pass: rc=$rc last=[$last]"
  echo "--- harness log ---"; sed -n '1,80p' "$SB/harness.log"
  echo "--- samples ---"; cat "$OUT/samples.tsv" 2>/dev/null
  for f in "$OUT"/watcher-*.log; do echo "--- $f (tail) ---"; tail -30 "$f"; done
fi
if [[ "${instances:-0}" -ge 2 && "${max_burst:-99}" == 0 && "${creates:-99}" == 0 && "${terms%/*}" == "${terms#*/}" && -n "$terms" ]]; then
  ok "instances>=2, max_burst=0, creates=0, every planned TERM exited 143 ($terms)"
else
  bad "verdict fields wrong: instances=$instances max_burst=$max_burst creates=$creates terms_ok=$terms"
fi

printf '\nFLY-2829 soak restart: %s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]

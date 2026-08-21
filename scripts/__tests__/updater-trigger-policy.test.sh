#!/usr/bin/env bash
# FLY-1959: updater has exactly two triggers and no live legacy self-ship route.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST="$ROOT/scripts/launchd/com.flywheel.updater.plist"
MANIFEST="$ROOT/scripts/launchd/units.manifest"

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

if python3 - "$PLIST" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "rb") as handle:
    plist = plistlib.load(handle)

assert plist.get("QueueDirectories") == [
    "/Users/xiaorongli/.flywheel/self-ship-urgent.d"
]
calendar = sorted(
    (entry.get("Hour"), entry.get("Minute"))
    for entry in plist.get("StartCalendarInterval", [])
)
assert calendar == [(0, 0), (12, 0)]
assert plist.get("ThrottleInterval") == 60
PY
then
  pass "plist is urgent-only with 00/12 shuttles and 60s throttle"
else
  fail "plist trigger contract drifted"
fi

manifest_row="$(awk -F '\t' '$1 == "com.flywheel.updater" { print $4 "|" $5 }' "$MANIFEST")"
if [ "$manifest_row" = "0,1,2,3,127,130|handled updater outcomes alert independently; signal cleanup exits 130" ]; then
  pass "launchd census accepts the updater's handled exit contract"
else
  fail "launchd updater allowed-exit contract drifted ($manifest_row)"
fi

legacy_paths=(
  "$ROOT/scripts/self-ship-"'restart.sh'
  "$ROOT/scripts/lib/self-ship-"'queue.sh'
  "$ROOT/scripts/__tests__/self-ship-"'restart.test.sh'
  "$ROOT/scripts/__tests__/self-ship-"'queue.test.sh'
  "$ROOT/scripts/__tests__/update-flywheel-"'queue.test.sh'
  "$ROOT/scripts/__tests__/restart-"'stabilization.test.sh'
)
missing=0
for path in "${legacy_paths[@]}"; do
  if [ -e "$path" ]; then
    printf '[TEST] legacy path remains: %s\n' "${path#"$ROOT/"}" >&2
    missing=1
  fi
done
if [ "$missing" -eq 0 ]; then
  pass "legacy producer, queue, and route-specific suites are deleted"
else
  fail "legacy route files still exist"
fi

legacy_pattern='self-ship-''pending|SELF_SHIP_''PENDING_DIR|self-ship-''restart|self-ship-''queue'
matches="$(
  git -C "$ROOT" grep -n -E "$legacy_pattern" -- . \
    ':(exclude)engineering/doc/**' \
    ':(exclude)doc/engineer/exploration/**' \
    ':(exclude)doc/engineer/research/**' \
    ':(exclude)doc/engineer/plan/**' \
    ':(exclude)doc/engineer/deep-research/**' \
    ':(exclude)doc/architecture/archive/**' \
    ':(exclude)doc/retro/**' \
    ':(exclude)product/doc/**' \
    ':(exclude).claude/skills/linear-issue-context/SKILL.md' \
    2>&1
)"
grep_rc=$?
if [ "$grep_rc" -eq 1 ]; then
  pass "tracked active tree has zero legacy route references"
elif [ "$grep_rc" -eq 0 ]; then
  printf '%s\n' "$matches" >&2
  fail "tracked active tree still references the legacy route"
else
  printf '%s\n' "$matches" >&2
  fail "git grep contract failed with rc=$grep_rc"
fi

printf 'Results: %s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]

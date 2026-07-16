#!/usr/bin/env bash
# FLY-1066 QA — refined kill-switch mutations.
# M1 (first pass) only removed ONE of two redundant guards, so the other still
# enforced and the test stayed green. These defeat the load-bearing guard(s).
set -uo pipefail

REPO=/Users/xiaorongli/Dev/flywheel-FLY-1066
TL=$REPO/packages/teamlead
SYNC=$TL/src/bridge/terminal-commdb-sync.ts
T=src/__tests__/terminal-commdb-sync.test.ts

restore() { cd "$REPO" && git checkout -- "$SYNC" 2>/dev/null; }
trap restore EXIT

run_case() {
  local name="$1"
  cd "$REPO"
  if git diff --quiet -- "$SYNC"; then
    echo "  ⚠️  HARNESS-BUG [$name] → mutation did NOT apply; verdict INVALID"
    restore; return
  fi
  cd "$TL"
  local out; out=$(npx vitest run "$T" 2>&1 | tail -6)
  if echo "$out" | grep -qE "[0-9]+ failed"; then
    echo "  ✅ CAUGHT  [$name] → $(echo "$out" | grep -oE '[0-9]+ failed' | head -1)"
  else
    echo "  ❌ VACUOUS [$name] → guard broken but suite still GREEN!"
  fi
  restore
}

echo "--- M1a: warmProjects kill-switch removed (warm runs when flag=0) ---"
perl -0pi -e 's/\t\t\tif \(!deps\.enabled\) return;\n//' "$SYNC"
run_case "flag=0 must not warm projects"

echo ""
echo "--- M1b: BOTH kill-switch guards removed (full defeat) ---"
perl -0pi -e 's/\t\t\tif \(!deps\.enabled\) return;\n//' "$SYNC"
perl -0pi -e 's/!deps\.enabled \|\|\s*\n\s*closing \|\|/closing ||/' "$SYNC"
run_case "flag=0 must produce zero enqueue (both guards)"

echo ""
restore
cd "$REPO"
git diff --quiet -- "$SYNC" && echo "sources restored clean ✅" || echo "WARNING dirty ❌"

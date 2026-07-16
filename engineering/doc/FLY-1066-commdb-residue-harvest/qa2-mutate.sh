#!/usr/bin/env bash
# FLY-1066 QA mutation harness.
# Each mutation breaks ONE safety guard the plan claims is enforced.
# Expected: the suite goes RED. A mutation that stays GREEN = vacuous test.
# CRITICAL: every mutation is verified to have ACTUALLY applied (git diff non-empty)
# before its verdict counts — an unapplied edit would fake a "vacuous" finding.
set -uo pipefail

REPO=/Users/xiaorongli/Dev/flywheel-FLY-1066
TL=$REPO/packages/teamlead
SYNC=$TL/src/bridge/terminal-commdb-sync.ts
PRUNE=$TL/src/bridge/commdb-session-prune.ts

restore() { cd "$REPO" && git checkout -- "$SYNC" "$PRUNE" 2>/dev/null; }
trap restore EXIT

# run_case <name> <mutated-file> <testfile>
run_case() {
  local name="$1" mutfile="$2" testfile="$3"
  cd "$REPO"
  # GATE: prove the mutation actually landed.
  if git diff --quiet -- "$mutfile"; then
    echo "  ⚠️  HARNESS-BUG [$name] → mutation did NOT apply; verdict INVALID"
    restore; return
  fi
  cd "$TL"
  local out
  out=$(npx vitest run "$testfile" 2>&1 | tail -6)
  if echo "$out" | grep -qE "[0-9]+ failed"; then
    echo "  ✅ CAUGHT  [$name] → $(echo "$out" | grep -oE '[0-9]+ failed' | head -1)"
  else
    echo "  ❌ VACUOUS [$name] → guard broken but suite still GREEN!"
  fi
  restore
}

echo "=============================================="
echo "FLY-1066 mutation harness"
echo "=============================================="

echo ""
echo "--- M1: kill-switch ignored (enqueue runs when flag=0) ---"
perl -0pi -e 's/!deps\.enabled \|\|\s*\n\s*closing \|\|/closing ||/' "$SYNC"
run_case "flag=0 must produce zero enqueue" "$SYNC" "src/__tests__/terminal-commdb-sync.test.ts"

echo ""
echo "--- M2: non-terminal filter removed (any status enqueues) ---"
perl -0pi -e 's/!isTerminalStatus\(targetStatus\) \|\|\s*\n//' "$SYNC"
run_case "non-CRASH_PRESERVE must not enqueue" "$SYNC" "src/__tests__/terminal-commdb-sync.test.ts"

echo ""
echo "--- M3: stale re-read defeated (writes stale status) ---"
perl -0pi -e 's/if \(authoritative !== targetStatus\) \{/if (false) {/' "$SYNC"
run_case "drain must skip stale authority" "$SYNC" "src/__tests__/terminal-commdb-sync.test.ts"

echo ""
echo "--- M4: harvest flag ignored (scan always expanded) ---"
perl -0pi -e 's/: \["completed", "timeout"\],/: ["completed", "timeout", "failed", "blocked"],/' "$PRUNE"
run_case "harvest flag=0 must keep legacy scan" "$PRUNE" "src/__tests__/commdb-session-prune.test.ts"

echo ""
echo "--- M5: probe gate defeated (delete regardless of liveness) ---"
perl -0pi -e 's/if \(state !== "dead"\) \{/if (false) {/' "$PRUNE"
run_case "alive/indeterminate must be KEPT" "$PRUNE" "src/__tests__/commdb-session-prune.test.ts"

echo ""
echo "=============================================="
restore
cd "$REPO"
if git diff --quiet -- "$SYNC" "$PRUNE"; then echo "sources restored clean ✅"; else echo "WARNING: sources dirty ❌"; fi

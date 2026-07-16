#!/usr/bin/env bash
# FLY-1066 QA — Lead directive ① : independently verify the TWO HIGH fixes
# (review R2) really block false-kill of parked / founder-pending sessions.
# Each mutation RE-INTRODUCES the original HIGH. Expected: suite goes RED.
# Every mutation is gated on git-diff proof that it actually applied.
set -uo pipefail

REPO=/Users/xiaorongli/Dev/flywheel-FLY-1066
TL=$REPO/packages/teamlead
G=$TL/src/bridge/statestore-ghost-reconcile.ts
CLEAN=/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-1066/12968481-0b02-4794-b734-ff2f50e51490/scratchpad/cleantmp
T1=src/__tests__/statestore-ghost-reconcile.test.ts
T2=src/bridge/__tests__/commdb-residue-layer-interaction.test.ts

restore() { cd "$REPO" && git checkout -- "$G" 2>/dev/null; }
trap restore EXIT

run_case() {
  local name="$1"
  cd "$REPO"
  if git diff --quiet -- "$G"; then
    echo "  ⚠️  HARNESS-BUG [$name] → mutation did NOT apply; verdict INVALID"
    restore; return
  fi
  cd "$TL"
  local out
  out=$(env -u FLYWHEEL_RUNNER_BACKEND TMPDIR=$CLEAN npx vitest run "$T1" "$T2" 2>&1 | tail -6)
  if echo "$out" | grep -qE "[0-9]+ failed"; then
    echo "  ✅ CAUGHT  [$name] → $(echo "$out" | grep -oE '[0-9]+ failed' | head -1)"
  else
    echo "  ❌ VACUOUS [$name] → HIGH re-introduced but suite still GREEN!"
  fi
  restore
}

echo "=================================================================="
echo "HIGH-1: parked / founder-pending must NOT be ghost candidates"
echo "=================================================================="
echo ""
echo "--- MG1: re-add awaiting_review/approved_to_ship/design_done to the scan set ---"
perl -0pi -e 's/(export const STATESTORE_GHOST_SOURCE_STATUSES: ReadonlySet<string> = new Set\(\[\n\t"pending",\n\t"running",\n)/$1\t"awaiting_review",\n\t"approved_to_ship",\n\t"design_done",\n/' "$G"
run_case "parked statuses must be structurally excluded"

echo ""
echo "=================================================================="
echo "HIGH-2: only same-pass AUTHORITATIVE dead-window proof may terminalize"
echo "=================================================================="
echo ""
echo "--- MG2: accept a MISSING authoritative target (the 'no row == dead' bug) ---"
perl -0pi -e 's/\tif \(!tmuxWindow\) return "kept_no_authoritative_target";/\tif (false) return "kept_no_authoritative_target";/' "$G"
run_case "missing evidence must never mean dead"

echo ""
echo "--- MG3: accept a NON-exact (bare-session) target → shared-session scope kill ---"
perl -0pi -e 's/\tif \(!isExactTmuxWindowTarget\(tmuxWindow\)\) \{/\tif (false) {/' "$G"
run_case "bare-session target must be rejected"

echo ""
echo "--- MG4: treat non-dead probe as dead (alive window gets reaped) ---"
perl -0pi -e 's/\tif \(probe !== "dead"\) return "kept_target_not_dead";/\tif (false) return "kept_target_not_dead";/' "$G"
run_case "alive/indeterminate probe must be KEPT"

echo ""
echo "=================================================================="
restore
cd "$REPO"
git diff --quiet -- "$G" && echo "source restored clean ✅" || echo "WARNING: dirty ❌"

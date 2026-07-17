#!/usr/bin/env bash
# FLY-1329 QA mutation battery (hardened per Codex incremental review of PR #632).
#
# For each critical guard: prove the guard's test is NON-VACUOUS by (1) confirming a
# GREEN baseline, (2) applying a precise 1-occurrence mutation to PRODUCTION code, and
# (3) confirming the target test goes RED *specifically because a test assertion
# failed* — not merely because the process exited non-zero.
#
# Three properties this harness enforces (each a real failure mode a looser harness
# would silently pass):
#   A. GREEN BASELINE — before mutating, the target test must PASS. Without this, a
#      test that was already red would be mis-credited to the mutation.
#   B. SPECIFIC-FAILURE, not any-non-zero — a mutation that made the file fail to
#      COMPILE (tsc/transform error) also exits non-zero, but proves nothing about the
#      assertion. We require vitest's per-test "Tests … failed" summary AND the absence
#      of collection/transform-error markers, so only a real assertion failure counts.
#   C. INTERRUPT-SAFE RESTORE — a `trap` restores the mutated file on EXIT/INT/TERM and
#      the run FAILS LOUD if any restore leaves the tree dirty. (An earlier version
#      swallowed restore errors; a SIGTERM mid-run left 7 production files mutated —
#      this trap makes that impossible.)
#
# It only ever mutates the LOCAL worktree and always restores; it is QA evidence, not
# shipped code. Anchor uniqueness (exactly 1 match) means a stale anchor fails the
# harness rather than masquerading as a pass.
set -uo pipefail
cd /Users/xiaorongli/Dev/flywheel-FLY-1329/packages/teamlead

PASS=0; FAIL=0
declare -a RESULTS
MUTATED_FILE=""   # the file currently mutated (for the trap)

# --- C. interrupt-safe restore -------------------------------------------------
restore_current() {
  if [ -n "$MUTATED_FILE" ]; then
    git checkout -- "$MUTATED_FILE" || echo "  ‼ RESTORE FAILED for $MUTATED_FILE" >&2
    MUTATED_FILE=""
  fi
}
trap 'restore_current' EXIT INT TERM

mutate() {  # file  old  new  → exit 2 if anchor count != 1
  python3 - "$1" "$2" "$3" <<'PY'
import sys
f, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(f).read()
n = s.count(old)
if n != 1:
    print(f"ANCHOR_ERROR: {n} matches for anchor in {f}", file=sys.stderr)
    sys.exit(2)
open(f, "w").write(s.replace(old, new))
PY
}

# B. classify a vitest run: "red-assertion" | "green" | "inconclusive"
classify_run() {  # outfile  rc
  local out="$1" rc="$2"
  # A real assertion failure prints the per-test summary line "Tests  N failed | …".
  # A compile/transform/collection error does NOT run tests → no such line.
  if grep -qiE "failed to (load|parse|collect|transform)|No test (files )?found|SyntaxError|Transform failed|Cannot find (module|name)|is not defined" "$out"; then
    echo "inconclusive"; return
  fi
  if [ "$rc" -eq 0 ]; then echo "green"; return; fi
  if grep -qE "Tests[[:space:]]+[0-9]+ failed" "$out"; then echo "red-assertion"; return; fi
  echo "inconclusive"
}

run_mut() {  # name  file  old  new  testfile  [name-filter]
  local name="$1" file="$2" old="$3" new="$4" testf="$5" filter="${6:-}"
  local vargs=(run "$testf"); [ -n "$filter" ] && vargs+=(-t "$filter")
  echo "───── MUT: $name ($file${filter:+  -t \"$filter\"}) ─────"

  # A. GREEN BASELINE — the test must pass before we mutate anything.
  if ! npx vitest "${vargs[@]}" >/tmp/mut-base.txt 2>&1; then
    echo "  ✗ HARNESS ERROR: baseline is NOT green (cannot attribute a red to the mutation)"
    RESULTS+=("BASELINE-RED  $name"); FAIL=$((FAIL+1)); return
  fi

  # apply mutation (assert exactly one occurrence)
  if ! mutate "$file" "$old" "$new"; then
    echo "  ✗ HARNESS ERROR: anchor did not match uniquely"
    RESULTS+=("ANCHOR-ERR   $name"); FAIL=$((FAIL+1)); return
  fi
  MUTATED_FILE="$file"

  # run target under mutation
  local rc verdict
  npx vitest "${vargs[@]}" >/tmp/mut-out.txt 2>&1 && rc=0 || rc=$?
  verdict=$(classify_run /tmp/mut-out.txt "$rc")

  restore_current   # C. restore immediately + trap-backed

  case "$verdict" in
    green)
      echo "  ✗ VACUOUS: test stayed GREEN under mutation (coverage does not defend this guard!)"
      RESULTS+=("VACUOUS!!!   $name"); FAIL=$((FAIL+1)) ;;
    red-assertion)
      local failed; failed=$(grep -oE "Tests[[:space:]]+[0-9]+ failed" /tmp/mut-out.txt | head -1)
      echo "  ✓ CAUGHT by a real assertion failure ($failed)"
      RESULTS+=("CAUGHT       $name  ($failed)"); PASS=$((PASS+1)) ;;
    *)
      echo "  ✗ INCONCLUSIVE: non-zero exit but not a clean assertion failure (compile/collection error?) — NOT counted as caught"
      RESULTS+=("INCONCLUSIVE $name"); FAIL=$((FAIL+1)) ;;
  esac
}

# M1 — R-1319: handoff absent→close (the exact FLY-1319 bug)
run_mut "M1 handoff absent-closes" \
  src/bridge/phase-orchestrator.ts \
  'const closeAuthorized = parkBiased ? verdict.allowed : liveness !== "alive";' \
  'const closeAuthorized = liveness !== "alive";' \
  src/bridge/__tests__/phase-orchestrator.fly1329-park-alive.test.ts

# M2 — A4 commdb-fsm-reconcile parked veto removed
run_mut "M2 A4 fsm-reconcile veto" \
  src/bridge/commdb-fsm-reconcile.ts \
  'if (parked) {' 'if (false) {' \
  src/bridge/__tests__/commdb-fsm-reconcile.fly1329-parked-veto.test.ts

# M3 — A4 commdb-session-prune parked veto removed
run_mut "M3 A4 session-prune veto" \
  src/bridge/commdb-session-prune.ts \
  'if (parked) {' 'if (false) {' \
  src/bridge/__tests__/commdb-session-prune.fly1329-parked-veto.test.ts

# M4 — A5 done-running-reconciler (FLY-324 boot sweep) parked veto removed
run_mut "M4 A5 boot-sweep veto" \
  src/bridge/done-running-reconciler.ts \
  'if (parked) {' 'if (false) {' \
  src/bridge/__tests__/done-running-reconciler.fly1329-parked-veto.test.ts

# M5 — A5 event-route LIVE FLY-324 veto neutralized (helper always "not parked").
# Name-filtered to the A5 group so we do not re-run the whole 64-test suite.
run_mut "M5 A5 live-handler veto" \
  src/bridge/event-route.ts \
  'if (process.env.FLYWHEEL_PRUNE_PARK_GUARD === "0") return false;' \
  'if (true) return false;' \
  src/__tests__/event-route.test.ts \
  "A5"

# M6 — A3 re-adopt candidate query narrowed back to running-only
run_mut "M6 A3 readopt all-roles" \
  src/StateStore.ts \
  "SELECT * FROM sessions WHERE status IN ('running', 'awaiting_review', 'design_done', 'approved_to_ship')" \
  "SELECT * FROM sessions WHERE status IN ('running')" \
  src/__tests__/statestore.fly1329-readopt-candidates.test.ts

# M7 — A1 core verdict: absent re-authorizes destruction (pure module)
run_mut "M7 A1 verdict absent-authorizes" \
  src/bridge/destructive-verdict.ts \
  'if (liveness === "dead_pin" && DEAD_PIN_AUTHORIZES.has(action)) {' \
  'if ((liveness === "dead_pin" || liveness === "absent") && DEAD_PIN_AUTHORIZES.has(action)) {' \
  src/bridge/__tests__/destructive-verdict.test.ts

echo ""
echo "════════ MUTATION BATTERY SUMMARY ════════"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "  caught=$PASS  problems=$FAIL"
# C. final safety: the tree MUST be clean (no mutation left behind).
DIRTY=$(git status --porcelain src/ | head)
if [ -n "$DIRTY" ]; then
  echo "  ‼ TREE NOT CLEAN after run — restore failed:"; echo "$DIRTY"
  exit 1
fi
echo "  tree clean ✓"
exit $FAIL

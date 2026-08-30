#!/bin/bash
# FLY-880 / FLY-1089: Guard test for the creative executor role .md files.
#
# Role .md files are injected verbatim into the Runner system prompt (readAgentFile,
# truncated at 40k CHARS — Blueprint.ts). They are prompt text, not runtime code, so
# there is no vitest surface: this is a CHEAP SMOKE SENTINEL, not a contract test —
# grep anchors can't prove behavior, only that the byte budget and the process
# semantic anchors survive an edit. The REAL routing behavior is proven by the
# edge-worker dispatch tests (pm-prototype-agent-dispatch.test.ts +
# designer-agent-dispatch.test.ts + AgentDispatcher.test.ts).
#
# FLY-1089 split the three creative work-types into three role files:
#   - pm.md               (Product Manager / product co-creation, ex-"Mode A")
#   - proto.md            (Prototype Engineer / feasibility-first prototype)
#   - product_designer.md (docs / UX-spec / design-production only)
# This guard defends: (1) each file stays under the 40k byte budget; (2) each role's
# process semantics + required section headings survive; (3) Mode A did not leak back
# into product-designer.
# Run: bash scripts/__tests__/test-pm-executor-contract.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_DIR="${SCRIPT_DIR}/../../.flywheel/agents/nodes"
PM_MD="${AGENTS_DIR}/pm.md"
PROTO_MD="${AGENTS_DIR}/proto.md"
PD_MD="${AGENTS_DIR}/product_designer.md"

PASS=0; FAIL=0
assert_file_exists() {
  if [ -f "$1" ]; then
    PASS=$((PASS+1)); echo "  PASS: $2"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $2 (file not found: $1)"
  fi
}
assert_contains() {
  # $1 file, $2 needle, $3 label
  if grep -qF -- "$2" "$1"; then
    PASS=$((PASS+1)); echo "  PASS: $3"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (missing: '$2')"
  fi
}
assert_max_bytes() {
  # $1 file, $2 max, $3 label. wc -c (bytes) is a deliberately-stricter byte-budget
  # SENTINEL for the runtime 40000-CHAR slice — multi-byte Chinese makes bytes >
  # chars, so passing the byte check guarantees the char check.
  local n; n=$(wc -c < "$1" | tr -d ' ')
  if [ "$n" -lt "$2" ]; then
    PASS=$((PASS+1)); echo "  PASS: $3 (${n} < $2 bytes)"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (${n} >= $2 bytes — past injection-truncation red line)"
  fi
}
assert_not_contains() {
  # $1 file, $2 needle, $3 label
  if grep -qF -- "$2" "$1"; then
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (should be absent but found: '$2')"
  else
    PASS=$((PASS+1)); echo "  PASS: $3"
  fi
}

echo "Test: creative executor role .md contracts (FLY-1089)"

# ── all three exist, under the byte-budget sentinel, keep the reporting rule ──
for f in "$PM_MD" "$PROTO_MD" "$PD_MD"; do
  assert_file_exists "$f" "role .md exists: $(basename "$f")"
  assert_max_bytes "$f" 40000 "under 40k byte-budget sentinel: $(basename "$f")"
  assert_contains "$f" "flywheel-comm ask" "reporting via flywheel-comm ask: $(basename "$f")"
done

# ════════════════════════════════════════════════════════════════════════════
# pm node — product co-creation (FLY-880 Mode A, extracted) + v5 additions
# ════════════════════════════════════════════════════════════════════════════
echo "--- pm.md ---"
assert_contains "$PM_MD" "产品共创"        "PM anchor: 产品共创 (product co-creation)"
assert_contains "$PM_MD" "有定见"          "探定见 protocol: 有定见 / 发挥 (opinion vs run-with-it)"
assert_contains "$PM_MD" "gate question"   "interaction primitive: gate question (one-question-per-round)"
# The interaction loop is the BLOCKING gate, DISTINCT from the non-blocking
# `flywheel-comm ask` reporting channel. Assert BOTH sides of the contrast (needles
# carry no backticks — zsh command-substitution footgun, FLY-372).
assert_contains "$PM_MD" "BLOCKING gate"    "interaction primitive named as the BLOCKING gate"
assert_contains "$PM_MD" "non-blocking"     "the ask reporting channel is called out as non-blocking"
assert_contains "$PM_MD" "different* primitive from" \
                "gate named a DIFFERENT primitive from ask (loop-is-gate-not-ask)"
assert_contains "$PM_MD" "the interaction loop is the blocking" \
                "loop is explicitly the blocking gate (not the ask channel)"
assert_contains "$PM_MD" "prd.md"          "PRD output location: prd.md"
assert_not_contains "$PM_MD" "no-three-stage" "old label-based routing removed from PM"
assert_contains "$PM_MD" "FLY-1436 work-kind routing" "cutover probe sentinel: PM"
assert_contains "$PM_MD" 'taskCategory":"prd"' "work-kind routing: PM uses canonical prd"
assert_contains "$PM_MD" "pipeline.work_kind" "work-kind routing: PM names the project switch"
assert_contains "$PM_MD" "create-issue"    "handoff: create-issue (break PRD into build issues)"
assert_contains "$PM_MD" "FLY-830"         "boundary: PM acceptance = FLY-830 (not here)"
# ── v5 additions (FLY-1089): the two steps Mode A was missing ──
assert_contains "$PM_MD" "explainer"       "v5 step: research + explainer page"
assert_contains "$PM_MD" "co-eval"         "v5 step: co-eval with the founder"
assert_contains "$PM_MD" "WITHOUT \`--channel\`" "explainer hosted WITHOUT --channel (Lead delivers)"
# ── structural section headings (harder to satisfy accidentally than a bare grep) ──
assert_contains "$PM_MD" "One session"     "structural: one-session heading"
assert_contains "$PM_MD" "founder门"        "structural: founder gate heading"
assert_contains "$PM_MD" "build issue"     "structural: output = build issues"
assert_contains "$PM_MD" "交工程"           "structural: handoff (交工程) heading"
# ── founder gate is fail-closed by discipline (Codex R1 post-rebase #2) ──
assert_contains "$PM_MD" "fail-closed by discipline" "no-answer gate => BLOCKED, don't proceed on a guess"
assert_contains "$PM_MD" "BLOCKED"         "reports BLOCKED on an un-answered decision round"

# ════════════════════════════════════════════════════════════════════════════
# proto node — feasibility-first (new, FLY-1089)
# ════════════════════════════════════════════════════════════════════════════
echo "--- proto.md ---"
assert_contains "$PROTO_MD" "可行性"         "prototype anchor: 可行性 (feasibility)"
assert_contains "$PROTO_MD" "drop"           "verdict: not-doable -> drop (a success)"
assert_contains "$PROTO_MD" "不是生产级"      "boundary: prototype is NOT production-grade"
assert_contains "$PROTO_MD" "cheapest"       "cheapest-real-prototype ladder"
assert_not_contains "$PROTO_MD" "no-three-stage" "old label-based routing removed from prototype"
assert_contains "$PROTO_MD" "FLY-1436 work-kind routing" "cutover probe sentinel: prototype"
assert_contains "$PROTO_MD" 'taskCategory":"prototype"' "work-kind routing: prototype uses canonical category"
assert_contains "$PROTO_MD" "pipeline.work_kind" "work-kind routing: prototype names the project switch"
assert_contains "$PROTO_MD" "create-issue"   "handoff (4a doable): create-issue -> productionize"
assert_contains "$PROTO_MD" "proofshot"      "founder experience: proofshot"
# ── boundary with designer must be explicit (Annie required it) ──
assert_contains "$PROTO_MD" "Designer"       "explicit boundary vs the visual Designer role"
# ── iterate loop (Annie's v3 ask) + its bounded exits (Codex R1 post-rebase #3) ──
assert_contains "$PROTO_MD" "iterate"        "Annie's ask: founder-feedback iterate loop"
assert_contains "$PROTO_MD" "Step 3.5"       "iterate loop is a real step (3.5) between show and verdict"
assert_contains "$PROTO_MD" "Bounded escalation" "iterate loop has a bounded third exit (no infinite loop)"
assert_contains "$PROTO_MD" "Cost is not evidence of infeasibility" "cost exhaustion != 4b (no false drop)"
# ── the overview diagram + worked walkthrough must NOT keep the stale two-exit loop
#    (Codex R2 #1: conflicting duplicate procedures) ──
assert_not_contains "$PROTO_MD" "loop until she's satisfied OR explicitly says drop" \
                "no stale two-exit loop text left in the overview"
assert_contains "$PROTO_MD" "三个出口"        "walkthrough states THREE exits (not the old two)"
assert_contains "$PROTO_MD" "iteration budget" "iteration budget named in overview/walkthrough, not only Step 3.5"
# ── founder gate is fail-closed by discipline (Codex R1 post-rebase #2) ──
assert_contains "$PROTO_MD" "fail-closed by discipline" "no-answer gate => BLOCKED, not a verdict"
assert_contains "$PROTO_MD" "BLOCKED"        "reports BLOCKED on an un-answered decision gate"
# ── structural section headings ──
assert_contains "$PROTO_MD" "One session"    "structural: one-session heading"
assert_contains "$PROTO_MD" "founder门"       "structural: founder gate heading"
assert_contains "$PROTO_MD" "verdict"        "structural: doable/not-doable verdict"
assert_contains "$PROTO_MD" "交工程"          "structural: handoff (交工程) / drop"

# ════════════════════════════════════════════════════════════════════════════
# product_designer node — docs / design-production ONLY (Mode A removed)
# ════════════════════════════════════════════════════════════════════════════
echo "--- product_designer.md ---"
assert_contains "$PD_MD" "codex-design-review" "docs/design survives: codex-design-review"
assert_contains "$PD_MD" "design"          "docs/design survives: design labels"
assert_contains "$PD_MD" "FLY-1089"        "boundary: references the FLY-1089 split"
# Mode A (product co-creation) must NOT have leaked back — the sentinel is the
# Chinese 产品共创; the boundary text points to the pm node instead.
assert_not_contains "$PD_MD" "产品共创"     "Mode A removed: no 产品共创 co-creation body"
assert_not_contains "$PD_MD" "有定见"       "Mode A removed: no 有定见 probe protocol"
assert_contains "$PD_MD" "the pm node"     "routes PM co-creation to the pm node"

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

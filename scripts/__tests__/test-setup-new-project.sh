#!/bin/bash
# FLY-284: Tests for scripts/setup-new-project.sh — the single, reusable,
# idempotent, FILESYSTEM-ONLY zero-to-one scaffolder for a brand-new Flywheel
# project. Mechanism consistency (idempotency + identical structure for any
# project) + zero live side effects are the primary acceptance criteria.
# Run: bash scripts/__tests__/test-setup-new-project.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP="${SCRIPT_DIR}/../setup-new-project.sh"
[ -x "$SETUP" ] || { echo "FATAL: $SETUP not found or not executable"; exit 1; }

PASS=0; FAIL=0
assert_eq() {
  if [ "$1" = "$2" ]; then PASS=$((PASS+1)); echo "  PASS: $3"
  else FAIL=$((FAIL+1)); echo "  FAIL: $3 (expected '$2', got '$1')"; fi
}
assert_file_exists() {
  if [ -f "$1" ]; then PASS=$((PASS+1)); echo "  PASS: $2"
  else FAIL=$((FAIL+1)); echo "  FAIL: $2 (file not found: $1)"; fi
}
assert_no_file() {
  if [ ! -e "$1" ]; then PASS=$((PASS+1)); echo "  PASS: $2"
  else FAIL=$((FAIL+1)); echo "  FAIL: $2 (unexpected: $1)"; fi
}
assert_contains_file() {
  if grep -qF "$2" "$1"; then PASS=$((PASS+1)); echo "  PASS: $3"
  else FAIL=$((FAIL+1)); echo "  FAIL: $3 (file $1 missing '$2')"; fi
}
assert_not_contains_file() {
  if ! grep -qF "$2" "$1"; then PASS=$((PASS+1)); echo "  PASS: $3"
  else FAIL=$((FAIL+1)); echo "  FAIL: $3 (file $1 unexpectedly contains '$2')"; fi
}
assert_in() {
  if printf '%s' "$1" | grep -qF "$2"; then PASS=$((PASS+1)); echo "  PASS: $3"
  else FAIL=$((FAIL+1)); echo "  FAIL: $3 (output missing '$2')"; fi
}
assert_executable() {
  if [ -x "$1" ]; then PASS=$((PASS+1)); echo "  PASS: $2"
  else FAIL=$((FAIL+1)); echo "  FAIL: $2 (not executable: $1)"; fi
}

TMP_BASE="$(mktemp -d /tmp/fly284-setup-test.XXXXXX)"
trap 'rm -rf "$TMP_BASE"' EXIT

# ── Test 1: fresh two-layer content project — full structure ──
echo "Test 1: fresh --two-layer content project — full scaffold structure"
T1="${TMP_BASE}/tidal-demo"
git init -q "$T1"
T1_OUT="$("$SETUP" tidal-demo content --target "$T1" --team TIDE --two-layer \
  --cos-persona Triton --dept-persona Ariel)"
assert_file_exists "${T1}/.gitignore" ".gitignore created"
assert_file_exists "${T1}/README.md" "README created"
assert_file_exists "${T1}/AGENTS.md" "AGENTS placeholder created"
assert_file_exists "${T1}/.flywheel/config.yaml" "config.yaml created"
assert_file_exists "${T1}/.flywheel/agents/content/content-executor.md" "content-executor created"
assert_file_exists "${T1}/.lead/tidal-demo-cos-lead/identity.md" "CoS identity skeleton created (two-layer)"
assert_file_exists "${T1}/.lead/tidal-demo-content-lead/identity.md" "dept (content) identity skeleton created"
assert_file_exists "${T1}/content/doc/README.md" "doc-flow README created (reused setup-doc-flow.sh)"
assert_file_exists "${T1}/content/doc/retro/.gitkeep" "doc-flow retro/.gitkeep created"
assert_contains_file "${T1}/.flywheel/config.yaml" "project: tidal-demo" "config has project name"
assert_contains_file "${T1}/.flywheel/config.yaml" "team_id: TIDE" "config has parameterized team_id"
assert_contains_file "${T1}/.flywheel/config.yaml" "default_agent: content" "config has default_agent"
assert_contains_file "${T1}/.flywheel/config.yaml" "doc_flow:" "config has doc_flow block"
assert_not_contains_file "${T1}/.flywheel/config.yaml" "enabled: true" "config emits no retired enabled key"
assert_in "$T1_OUT" "feature-flags set --name doc_flow --to on --project tidal-demo" "cutover prints scoped doc_flow row command"
assert_contains_file "${T1}/.gitignore" "worktrees/" ".gitignore ignores worktrees/ (Runner isolation)"
assert_contains_file "${T1}/.lead/tidal-demo-cos-lead/identity.md" "Triton" "CoS identity carries persona"
assert_contains_file "${T1}/.lead/tidal-demo-content-lead/identity.md" "Ariel" "dept identity carries persona"
# FLY-727: deploy-report hook (auto-onboard this project to the daily digest)
assert_file_exists "${T1}/.flywheel/hooks/report-deployment.sh" "FLY-727 deploy-report hook scaffolded"
assert_executable "${T1}/.flywheel/hooks/report-deployment.sh" "deploy-report hook is executable"
assert_contains_file "${T1}/.flywheel/hooks/report-deployment.sh" 'report-deployed --project "tidal-demo"' "hook calls report-deployed with the project name filled"

# ── Test 2: idempotency — re-run produces zero changes ──
echo "Test 2: re-run idempotency (two runs diff empty)"
SNAP_BEFORE="$(cd "$T1" && find . -path ./.git -prune -o -type f -exec md5 -q {} + 2>/dev/null | sort)"
"$SETUP" tidal-demo content --target "$T1" --team TIDE --two-layer \
  --cos-persona Triton --dept-persona Ariel > /dev/null
SNAP_AFTER="$(cd "$T1" && find . -path ./.git -prune -o -type f -exec md5 -q {} + 2>/dev/null | sort)"
assert_eq "$SNAP_AFTER" "$SNAP_BEFORE" "re-run produced zero file changes"

# ── Test 3: single-layer (default) — no CoS identity ──
echo "Test 3: single-layer default — only the dept Lead, no CoS"
T3="${TMP_BASE}/solo"
git init -q "$T3"
"$SETUP" solo content --target "$T3" --team SOLO > /dev/null
assert_file_exists "${T3}/.lead/solo-content-lead/identity.md" "single dept identity created"
assert_no_file "${T3}/.lead/solo-cos-lead" "no CoS identity in single-layer mode"

# ── Test 4: rejections — bad names / non-git-root target ──
echo "Test 4: rejections (bad project-name / bad department / target not git root)"
if ! "$SETUP" "Bad Name" content --target "${TMP_BASE}/x" > /dev/null 2>&1; then
  PASS=$((PASS+1)); echo "  PASS: rejects project-name with spaces/uppercase"
else FAIL=$((FAIL+1)); echo "  FAIL: accepted bad project-name"; fi
T4="${TMP_BASE}/t4"; git init -q "$T4"
if ! "$SETUP" t4 "Bad Dept" --target "$T4" > /dev/null 2>&1; then
  PASS=$((PASS+1)); echo "  PASS: rejects department with spaces/uppercase"
else FAIL=$((FAIL+1)); echo "  FAIL: accepted bad department"; fi
NONGIT="${TMP_BASE}/nongit"; mkdir -p "$NONGIT"
if ! "$SETUP" nongit content --target "$NONGIT" > /dev/null 2>&1; then
  PASS=$((PASS+1)); echo "  PASS: rejects target that exists but is not a git repo root"
else FAIL=$((FAIL+1)); echo "  FAIL: accepted non-git-root target"; fi

# ── Test 5: zero live side effects + cutover checklist printed ──
echo "Test 5: zero live side effects + gated cutover checklist printed"
T5="${TMP_BASE}/echo5"; git init -q "$T5"
CANARY="${TMP_BASE}/canary.txt"; echo "untouched" > "$CANARY"
CANARY_BEFORE="$(md5 -q "$CANARY")"
T5_OUT="$("$SETUP" echo5 content --target "$T5" --team TIDE --two-layer)"
CANARY_AFTER="$(md5 -q "$CANARY")"
assert_eq "$CANARY_AFTER" "$CANARY_BEFORE" "writes nothing outside --target (canary untouched)"
assert_in "$T5_OUT" "gh repo create" "checklist prints gh repo create (gated, not executed)"
assert_in "$T5_OUT" "FLYWHEEL_LEAD_ROLE=cos" "checklist prints CoS launchd env requirement"
assert_in "$T5_OUT" "flywheel-daemon.sh install" "v2 checklist names the canonical install path"
assert_in "$T5_OUT" "projects.json" "checklist prints live projects.json edit (gated)"
assert_in "$T5_OUT" "Digest onboarding" "checklist prints FLY-727 digest-onboarding step (wire report-deployment hook)"
assert_in "$T5_OUT" "materialize-lead-manifests.sh" "checklist prints canonical manifest materialization step"
# the script itself must not execute live writes — static guard
if grep -Eq '^[[:space:]]*(launchctl|gh repo create)' "$SETUP"; then
  FAIL=$((FAIL+1)); echo "  FAIL: script body executes a live command (launchctl/gh repo create)"
else PASS=$((PASS+1)); echo "  PASS: script body has no executed live command"; fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]

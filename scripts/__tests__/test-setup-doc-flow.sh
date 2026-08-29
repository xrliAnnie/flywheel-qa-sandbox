#!/bin/bash
# FLY-205: Tests for scripts/setup-doc-flow.sh — the single mechanism entry
# point for the doc-flow baseline. Mechanism consistency (idempotency, identical
# output for any project) is the primary acceptance criterion.
# Run: bash scripts/__tests__/test-setup-doc-flow.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP="${SCRIPT_DIR}/../setup-doc-flow.sh"
[ -x "$SETUP" ] || { echo "FATAL: $SETUP not found or not executable"; exit 1; }

PASS=0; FAIL=0
assert_eq() {
  if [ "$1" = "$2" ]; then
    PASS=$((PASS+1)); echo "  PASS: $3"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (expected '$2', got '$1')"
  fi
}
assert_file_exists() {
  if [ -f "$1" ]; then
    PASS=$((PASS+1)); echo "  PASS: $2"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $2 (file not found: $1)"
  fi
}
assert_contains_file() {
  if grep -qF "$2" "$1"; then
    PASS=$((PASS+1)); echo "  PASS: $3"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (file $1 missing '$2')"
  fi
}

TMP_BASE="$(mktemp -d /tmp/fly205-setup-test.XXXXXX)"
trap 'rm -rf "$TMP_BASE"' EXIT

# ── Test 1: fresh project WITH .flywheel/config.yaml — full output structure ──
echo "Test 1: fresh project with config — full structure + config append"
T1="${TMP_BASE}/t1"
mkdir -p "${T1}/.flywheel"
git -C "$T1" init -q 2>/dev/null || git init -q "$T1"
cat > "${T1}/.flywheel/config.yaml" << 'EOF'
project: t1
linear:
  team_id: T1
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: dev
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5.0
decision_layer:
  autonomy_level: observer
  escalation_channel: "#dev"
EOF
"$SETUP" "$T1" content > /dev/null
assert_file_exists "${T1}/content/doc/README.md" "README created"
assert_file_exists "${T1}/content/doc/retro/.gitkeep" "retro/.gitkeep created (tracked skeleton)"
assert_contains_file "${T1}/.flywheel/config.yaml" "doc_flow:" "doc_flow block appended to config"
assert_contains_file "${T1}/.flywheel/config.yaml" "default_department: content" "default_department wired"
assert_contains_file "${T1}/content/doc/README.md" "一个 issue 一个文件夹" "README carries conventions"
# git status shows the full skeleton (PR face completeness — Codex design R2 #3)
T1_STATUS="$(git -C "$T1" status --porcelain)"
if echo "$T1_STATUS" | grep -q "content/"; then
  PASS=$((PASS+1)); echo "  PASS: git sees the skeleton"
else
  FAIL=$((FAIL+1)); echo "  FAIL: git does not see the skeleton: $T1_STATUS"
fi

# ── Test 2: re-run idempotency — two runs diff empty ──
echo "Test 2: re-run idempotency (two runs diff empty)"
SNAP_BEFORE="$(cd "$T1" && find . -path ./.git -prune -o -type f -exec md5 -q {} + 2>/dev/null | sort)"
"$SETUP" "$T1" content > /dev/null
SNAP_AFTER="$(cd "$T1" && find . -path ./.git -prune -o -type f -exec md5 -q {} + 2>/dev/null | sort)"
assert_eq "$SNAP_AFTER" "$SNAP_BEFORE" "re-run produced zero file changes"

# ── Test 3: existing doc_flow block — no duplicate injection ──
echo "Test 3: existing doc_flow block not duplicated"
T3="${TMP_BASE}/t3"
mkdir -p "${T3}/.flywheel"
git init -q "$T3"
cat > "${T3}/.flywheel/config.yaml" << 'EOF'
project: t3
doc_flow:
  enabled: false
  default_department: product
EOF
"$SETUP" "$T3" product > /dev/null
DOC_FLOW_COUNT="$(grep -Ec '^[[:space:]]*doc_flow:' "${T3}/.flywheel/config.yaml")"
assert_eq "$DOC_FLOW_COUNT" "1" "doc_flow block count stays 1 (anchored-grep idempotency)"

# ── Test 4: no .flywheel — SKELETON-ONLY mode (deliberate, supported) ──
echo "Test 4: skeleton-only mode (no .flywheel — the joycon-main path)"
T4="${TMP_BASE}/t4"
mkdir -p "$T4"
git init -q "$T4"
T4_OUT="$("$SETUP" "$T4" product)"
assert_file_exists "${T4}/product/doc/README.md" "skeleton README created without config"
assert_file_exists "${T4}/product/doc/retro/.gitkeep" "skeleton retro/.gitkeep created without config"
if echo "$T4_OUT" | grep -q "SKELETON-ONLY"; then
  PASS=$((PASS+1)); echo "  PASS: skeleton-only mode announced with config guidance"
else
  FAIL=$((FAIL+1)); echo "  FAIL: skeleton-only mode not announced"
fi
if [ ! -d "${T4}/.flywheel" ]; then
  PASS=$((PASS+1)); echo "  PASS: did not fabricate .flywheel/"
else
  FAIL=$((FAIL+1)); echo "  FAIL: fabricated .flywheel/ in skeleton-only mode"
fi

# ── Test 5: rejections — bad department, non-git, non-root ──
echo "Test 5: rejections (bad department charset / non-git dir / non-root subdir)"
T5="${TMP_BASE}/t5"
mkdir -p "${T5}/sub"
if ! "$SETUP" "$T5" "Bad Dept" > /dev/null 2>&1; then
  PASS=$((PASS+1)); echo "  PASS: rejects department with spaces/uppercase"
else
  FAIL=$((FAIL+1)); echo "  FAIL: accepted bad department"
fi
if ! "$SETUP" "$T5" content > /dev/null 2>&1; then
  PASS=$((PASS+1)); echo "  PASS: rejects non-git directory"
else
  FAIL=$((FAIL+1)); echo "  FAIL: accepted non-git directory"
fi
git init -q "$T5"
if ! "$SETUP" "${T5}/sub" content > /dev/null 2>&1; then
  PASS=$((PASS+1)); echo "  PASS: rejects subdirectory of a git repo (must be root)"
else
  FAIL=$((FAIL+1)); echo "  FAIL: accepted non-root subdirectory"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]

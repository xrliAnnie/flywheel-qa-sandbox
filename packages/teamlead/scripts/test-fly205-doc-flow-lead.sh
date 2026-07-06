#!/bin/bash
# FLY-205: claude-lead.sh wiring assertions for the doc-flow Lead rule.
#  1. doc-flow-rules.md is appended via --append-system-prompt-file
#  2. the append lives in the NON-COS dept-lead branch (cos-lead must not
#     load spawn-behavior rules — Codex design R1 #6)
#  3. env_args carries FLYWHEEL_PROJECT_DIR=${PROJECT_DIR} (the rule's config
#     self-check data source — Codex design R3 #1; tmux panes don't inherit
#     launcher env and LEAD_WORKSPACE isolation makes pwd useless)
# Run: bash packages/teamlead/scripts/test-fly205-doc-flow-lead.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEAD_SH="${SCRIPT_DIR}/claude-lead.sh"
[ -f "$LEAD_SH" ] || { echo "FATAL: $LEAD_SH not found"; exit 1; }

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "Test 1: doc-flow-rules.md append block exists"
if grep -q 'doc-flow-rules.md' "$LEAD_SH" \
   && grep -A3 'BASE_DOC_FLOW_RULES=' "$LEAD_SH" | grep -q -- '--append-system-prompt-file'; then
  ok "doc-flow-rules.md appended via --append-system-prompt-file"
else
  bad "doc-flow-rules.md append block missing"
fi

echo "Test 2: append lives in the non-cos dept-lead branch"
# Structural check: the doc-flow append must appear BEFORE the cos-lead
# else-branch (cos-lead-rules.md) within the same role if/else — i.e. dept
# leads load it, cos-lead does not.
DOC_FLOW_LINE="$(grep -n 'BASE_DOC_FLOW_RULES=' "$LEAD_SH" | head -1 | cut -d: -f1)"
COS_RULES_LINE="$(grep -n 'BASE_COS_RULES=' "$LEAD_SH" | head -1 | cut -d: -f1)"
if [ -n "$DOC_FLOW_LINE" ] && [ -n "$COS_RULES_LINE" ] && [ "$DOC_FLOW_LINE" -lt "$COS_RULES_LINE" ]; then
  # And there is an `else` between them (the cos branch boundary)
  if sed -n "${DOC_FLOW_LINE},${COS_RULES_LINE}p" "$LEAD_SH" | grep -q '^else$'; then
    ok "doc-flow append sits in the dept branch; cos branch (after else) does not load it"
  else
    bad "no else boundary between doc-flow append and cos rules — branch structure changed?"
  fi
else
  bad "could not locate doc-flow/cos rule lines (doc=$DOC_FLOW_LINE cos=$COS_RULES_LINE)"
fi

echo "Test 3: env_args exports FLYWHEEL_PROJECT_DIR"
if grep -q -- '-e "FLYWHEEL_PROJECT_DIR=${PROJECT_DIR}"' "$LEAD_SH"; then
  ok "FLYWHEEL_PROJECT_DIR passed into the Lead pane env"
else
  bad "FLYWHEEL_PROJECT_DIR not found in env_args"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]

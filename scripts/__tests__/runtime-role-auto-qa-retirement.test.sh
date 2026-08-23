#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GENERIC_ROLES=(
  "$ROOT/agents/generic-executor.md"
  "$ROOT/agents/generic-executor.bare.md"
  "$ROOT/agents/generic-executor.matt.md"
)
QA_ROLES=(
  "$ROOT/agents/qa-executor.md"
  "$ROOT/.flywheel/agents/engineering/qa-executor.md"
)
PROJECT_CONFIG="$ROOT/.flywheel/config.yaml"
BLUEPRINT="$ROOT/packages/edge-worker/src/Blueprint.ts"
LEAD_ALERT="$ROOT/packages/teamlead/src/LeadAlertNotifier.ts"
ALERT_COPY="$ROOT/packages/teamlead/src/bridge/alert-kind-copy.ts"
AUTH_ALERTS="$ROOT/packages/teamlead/src/bridge/review-authorization-alerts.ts"
DEFAULT_ENABLE_RULE="$ROOT/packages/teamlead/lead-rules-base/default-enable-policy.md"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local file="$1" needle="$2"
  grep -qF -- "$needle" "$file" || fail "$file missing: $needle"
}

assert_not_contains() {
  local file="$1" needle="$2"
  if grep -qiF -- "$needle" "$file"; then
    fail "$file retains retired protocol: $needle"
  fi
}

for file in "${GENERIC_ROLES[@]}"; do
  assert_contains "$file" "DAG workflow"
  assert_not_contains "$file" "Auto-QA"
  assert_not_contains "$file" "automatically spawn"
  assert_not_contains "$file" "founder is never bothered before QA is green"
done

for file in "${QA_ROLES[@]}"; do
  assert_contains "$file" "DAG workflow QA"
  assert_contains "$file" "flywheel-comm qa-result"
  assert_contains "$file" "--target-exec <your-DAG-QA-exec-id>"
  assert_contains "$file" "--status pass|fail"
  assert_contains "$file" "FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL"

  assert_not_contains "$file" "Auto-QA"
  assert_not_contains "$file" "auto-spawned"
  assert_not_contains "$file" "declare-state park"
  assert_not_contains "$file" "auto-QA awaiting implementer retest"
  assert_not_contains "$file" "parent-execution-id-from-QA-context"
  assert_not_contains "$file" "--target-exec <parent"
  assert_not_contains "$file" "Do NOT run complete"
  assert_not_contains "$file" "Do **NOT** run complete"
  assert_not_contains "$file" "Same QA session"
done

assert_contains "$ROOT/agents/qa-executor.md" 'node "$FLYWHEEL_COMM_CLI" ask --lead <lead-id> --exec-id <exec-id> --report'
assert_contains "$ROOT/.flywheel/agents/engineering/qa-executor.md" 'node "$FLYWHEEL_COMM_CLI" ask --lead flywheel-eng-lead --exec-id <your-execution-id> --report'

assert_not_contains "$PROJECT_CONFIG" "auto-QA pipeline"
assert_not_contains "$PROJECT_CONFIG" "QA·FLY-XX"
assert_not_contains "$BLUEPRINT" "separate auto-QA protocol"
assert_contains "$BLUEPRINT" "DAG workflow QA awaiting implement fix"

assert_not_contains "$LEAD_ALERT" "auto-QA pipeline could not proceed"
assert_not_contains "$ALERT_COPY" "Auto-QA pipeline stuck"
assert_not_contains "$ALERT_COPY" "spawn failed, no verdict"
assert_not_contains "$AUTH_ALERTS" "auto-qa-stuck:"
assert_not_contains "$AUTH_ALERTS" "Auto-QA pipeline stuck"
assert_contains "$AUTH_ALERTS" "merge-authorization-held:"
assert_not_contains "$DEFAULT_ENABLE_RULE" "auto-QA"

if [ -e "$ROOT/packages/teamlead/src/bridge/checkpoint-park.ts" ] ||
  [ -e "$ROOT/packages/teamlead/src/bridge/__tests__/checkpoint-park.test.ts" ]; then
  fail "dead checkpoint-park module or its isolated test still exists"
fi

for file in \
  "$ROOT/packages/config/src/skill-framework-mode.ts" \
  "$ROOT/packages/edge-worker/src/Blueprint.ts" \
  "$ROOT/packages/teamlead/src/bridge/retry-dispatcher.ts" \
  "$ROOT/packages/teamlead/src/bridge/run-dispatcher.ts"; do
  assert_not_contains "$file" "skillFrameworkModeParent"
  assert_not_contains "$file" "parentMode"
done

echo "PASS: runtime role assets contain only the DAG/manual QA contract"

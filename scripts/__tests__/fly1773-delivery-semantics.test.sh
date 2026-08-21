#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FORBIDDEN='((notification|notify)[[:space:]]+(success|succeeds|succeeded).*(means|sets|writes|=>).*delivered_at|delivered_at.*(means|is|=).*(notification|notify)[[:space:]]+(success|succeeds|succeeded))'
FILES=(
  "$REPO_ROOT/packages/qa-framework/suites/fly-60-hard-gate.md"
  "$REPO_ROOT/packages/qa-framework/README.md"
  "$REPO_ROOT/scripts/qa-fly-60-driver.sh"
)

# Positive control: keep the fingerprint capable of detecting the retired
# contract before trusting its zero-match result against the live QA docs.
if ! grep -Eqi "$FORBIDDEN" <<<"notification succeeds => delivered_at"; then
  echo "FAIL: FLY-1773 retired-contract fingerprint matched no positive control" >&2
  exit 1
fi

if grep -Eni "$FORBIDDEN" "${FILES[@]}"; then
  echo "FAIL: QA docs regressed to notification-success => delivered_at" >&2
  exit 1
fi

echo "PASS: FLY-1773 QA delivery semantics retain projection delivered_at"

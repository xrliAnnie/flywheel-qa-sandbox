#!/bin/bash
# FLY-1062 PR3 · contract-consistency lock (plan PR3-4): the PR2 onboard-shell
# suites — SAME fixtures, SAME assertion set — re-run with the endpoint
# swapped from the PR2 stub to the REAL handler (serve.mjs, in-process node
# http shell). The shipped customer client and the shipped server must agree
# on every byte of the contract, proven by one test corpus.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVE="$ROOT/packages/payload-endpoint/__tests__/serve.mjs"
SUITES=(
  onboard-shell-install.test.sh
  onboard-shell-negatives.test.sh
  onboard-shell-rotation.test.sh
  onboard-shell-secret.test.sh
  onboard-shell-qa-gaps.test.sh
)

FAILED=0
for suite in "${SUITES[@]}"; do
  echo "── contract run (real handler): $suite ──"
  if ONBOARD_ENDPOINT_IMPL="$SERVE" bash "$ROOT/packages/onboard-shell/__tests__/$suite"; then
    echo "[TEST] ✓ $suite green against the REAL handler"
  else
    echo "[TEST] ✗ $suite FAILED against the real handler"
    FAILED=1
  fi
done

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "contract-consistency: all PR2 suites green against the real handler"
else
  echo "contract-consistency: FAILURES (client/server contract drift)"
fi
exit "$FAILED"

#!/bin/bash
# FLY-2190 lap boundary: this PR is S0-only. The approved S1 declarations must
# remain byte-semantically Intel-first until S0 is deployed and A0 is live.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

PATH_DECLARATIONS="
packages/claude-runner/src/tmux-server-environment.ts
scripts/lib/tmux-server-rescue.sh
scripts/flywheel-lead-wrapper-v2.sh
scripts/flywheel-bridge-wrapper.sh
scripts/flywheel-voice-bridge-wrapper.sh
scripts/flywheel-quota-monitor-wrapper.sh
scripts/restart-services.sh
packages/teamlead/scripts/templates/flywheel-codex-lead-wrapper-mufasa-tui.sh
packages/teamlead/scripts/rollback-codex-lead-mufasa-tui.sh
scripts/launchd/com.flywheel.updater.plist
scripts/lib/qa-launchd-lead.sh
scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh
scripts/flywheel-codex-lead-wrapper-codex-infra-bot.sh
"

missing=""
for path in $PATH_DECLARATIONS; do
  if [ ! -f "$path" ] || ! grep -Fq '/usr/local/bin:/opt/homebrew/bin' "$path"; then
    missing="${missing}${missing:+ }$path"
  fi
done
if [ -z "$missing" ]; then
  pass "all deferred S1 PATH declarations remain Intel-first in the S0 lap"
else
  fail "S1 PATH bytes changed early: $missing"
fi

GH_FILE=packages/flywheel-comm/src/commands/qa-result.ts
if grep -Fq '["/usr/local/bin/gh", "/opt/homebrew/bin/gh", "/usr/bin/gh"]' \
  "$GH_FILE"; then
  pass "the deferred non-PATH gh priority list also remains unchanged"
else
  fail "the S1 gh priority list changed in the S0 lap"
fi

echo ""
echo "host-tmux-selection-s0-scope: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ] || exit 1

#!/bin/bash
# FLY-2190 S1 continuation: S0 is deployed and every managed carrier declaration
# must now be byte-semantically native-Homebrew-first.
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
scripts/lib/qa-codex-lead-wrapper.template.sh
scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh
scripts/flywheel-codex-lead-wrapper-codex-infra-bot.sh
"

missing=""
for path in $PATH_DECLARATIONS; do
  if [ ! -f "$path" ] || ! grep -Fq '/opt/homebrew/bin:/usr/local/bin' "$path"; then
    missing="${missing}${missing:+ }$path"
  fi
done
if [ -z "$missing" ]; then
  pass "all S1 PATH declarations are native-Homebrew-first"
else
  fail "S1 PATH declarations are missing or not native-first: $missing"
fi

GH_FILE=packages/flywheel-comm/src/commands/qa-result.ts
GH_NORMALIZED=$(tr -d '[:space:]' < "$GH_FILE")
case "$GH_NORMALIZED" in
*'QA_GITHUB_CLI_CANDIDATES=["/opt/homebrew/bin/gh","/usr/local/bin/gh","/usr/bin/gh",]asconst'*)
  pass "the non-PATH gh priority list is native-Homebrew-first"
  ;;
*)
  fail "the S1 gh priority list is missing or not native-first"
  ;;
esac

echo ""
echo "host-tmux-selection-s0-scope: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ] || exit 1

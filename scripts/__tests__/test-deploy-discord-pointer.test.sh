#!/usr/bin/env bash
# FLY-1676: test-deploy mirror guard must use registry authority, not newest dir.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="$REPO_ROOT/scripts/test-deploy.sh"
PASSED=0
FAILED=0

pass() { PASSED=$((PASSED + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] ✗ %s\n' "$1" >&2; }

# shellcheck disable=SC2016
if grep -Fq 'ACTIVE_PLUGIN="$("$PLUGIN_CHECK" --print-install-path)"' "$SOURCE"; then
  pass "mirror guard resolves the authoritative pointer installPath"
else
  fail "mirror guard resolves the authoritative pointer installPath"
fi

if ! grep -Fq 'plugins/cache/claude-plugins-official/discord' "$SOURCE" \
    && ! grep -q 'LATEST_PLUGIN=.*ls -dt' "$SOURCE"; then
  pass "mirror guard never guesses the active plugin from version directories"
else
  fail "mirror guard never guesses the active plugin from version directories"
fi

if grep -Fq 'claude plugin update discord@flywheel-plugins --scope user' "$SOURCE"; then
  pass "mirror failure recovery points operators at the fork-backed plugin"
else
  fail "mirror failure recovery points operators at the fork-backed plugin"
fi

printf '\nResults: %d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))

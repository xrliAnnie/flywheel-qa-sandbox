#!/usr/bin/env bash
# FLY-1018 §2.9 — gemini-agent static guard (CI).
#
# The gemini-agent package is a low-privilege tool client. These greps are
# the structural red lines: any hit fails CI so widening the surface must be
# an explicit, reviewable act.
#
# Scope: packages/gemini-agent/src (production sources only — tests/fixtures
# may name forbidden endpoints to assert they are REJECTED).

set -euo pipefail

cd "$(dirname "$0")/.."
SRC="packages/gemini-agent/src"
FAIL=0

# Test/fixture files are allowed to mention forbidden strings (they assert
# rejection); production sources are not.
prod_files() {
	find "$SRC" -name '*.ts' -not -path '*/__tests__/*'
}

check_absent() {
	local pattern="$1" label="$2"
	local hits
	hits=$(prod_files | xargs grep -n "$pattern" 2>/dev/null || true)
	if [ -n "$hits" ]; then
		echo "GUARD FAIL: forbidden $label found in gemini-agent sources:"
		echo "$hits"
		FAIL=1
	fi
}

# 1. Zero reserved endpoint strings.
check_absent "/api/actions" "reserved endpoint (/api/actions)"
check_absent "/actions/" "reserved endpoint (/actions/)"
check_absent "close-tmux" "reserved endpoint (close-tmux)"
check_absent "close-runner" "reserved endpoint (close-runner)"
check_absent "founder-consent" "reserved endpoint (founder-consent)"

# 2. Zero forbidden imports.
check_absent "@linear/sdk" "import (@linear/sdk)"
check_absent "flywheel-comm" "import (flywheel-comm)"
check_absent "packages/teamlead/src" "deep-import (packages/teamlead/src)"

# 3. Zero privileged credentials — the only allowed token env is
#    FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN.
check_absent "TEAMLEAD_API_TOKEN" "credential (TEAMLEAD_API_TOKEN)"
check_absent "GH_TOKEN" "credential (GH_TOKEN)"
check_absent "GITHUB_TOKEN" "credential (GITHUB_TOKEN)"

# 4. Closed registry: exactly 6 tool declarations in schemas.ts. Changing
#    the tool set must show up here as an explicit guard edit.
DECL_COUNT=$(grep -cE '^\s+name: "' "$SRC/tools/schemas.ts")
if [ "$DECL_COUNT" -ne 6 ]; then
	echo "GUARD FAIL: expected exactly 6 tool declarations in schemas.ts, found $DECL_COUNT"
	FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
	exit 1
fi
echo "gemini-agent-guard: ALL GATES GREEN (reserved endpoints / imports / credentials / 6-tool registry)"

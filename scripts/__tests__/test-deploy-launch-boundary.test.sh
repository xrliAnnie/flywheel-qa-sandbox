#!/usr/bin/env bash
# FLY-2270: static contract for the three slot Bridge launch boundaries.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY="$ROOT/scripts/test-deploy.sh"
GENERALIZED="$ROOT/scripts/lib/qa-generalized.sh"
TEARDOWN="$ROOT/scripts/test-teardown.sh"
PLAYBOOK="$ROOT/doc/qa/framework/529-room-playbook.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
count() {
	local matches
	matches="$(rg -c -- "$1" "$2" || true)"
	printf '%s\n' "${matches:-0}"
}
line() { rg -n -m1 "$1" "$2" | cut -d: -f1; }

[[ "$(count 'qa_generalized_safe_tmpdir' "$GENERALIZED")" == "0" ]] \
	|| fail "retired generalized TMPDIR helper remains"
[[ "$(count '^qa_slot_child_tmpdir\(\)' "$GENERALIZED")" == "1" ]] \
	|| fail "slot-local TMPDIR helper must be declared exactly once"
pass "retired TMPDIR fallback is replaced by one slot-local helper"

[[ "$(count 'qa-slot-bridge-spec\.mjs" capture' "$DEPLOY")" == "3" ]] \
	|| fail "expected exactly three Bridge launch-spec captures"
[[ "$(count '-u VERCEL_TOKEN' "$DEPLOY")" == "3" ]] \
	|| fail "every Bridge launch boundary must scrub inherited VERCEL_TOKEN"
[[ "$(count '-u FLYWHEEL_REPORT_HOST_OVERRIDE_URL' "$DEPLOY")" == "3" ]] \
	|| fail "every Bridge launch boundary must scrub inherited report-host overrides"
[[ "$(count 'REPORT_HOST_WRAPPER_ARGS\[@\]' "$DEPLOY")" == "3" ]] \
	|| fail "every captured command must inject the optional report-host wrapper"
pass "all three Bridge launch boundaries scrub and inject exactly once"

slot_line="$(line '^SLOT_DIR=' "$DEPLOY")"
node_line="$(line '^QA_SLOT_BRIDGE_NODE=' "$DEPLOY")"
arrays_line="$(line '^LEAD_EXTRA_ENV=\(\)' "$DEPLOY")"
token_line="$(line '^GENERALIZED_API_TOKEN_PATH=' "$DEPLOY")"
[[ "$slot_line" -lt "$node_line" && "$node_line" -lt "$token_line" \
	&& "$slot_line" -lt "$arrays_line" && "$arrays_line" -lt "$token_line" ]] \
	|| fail "Node/bash resolution and env arrays must precede token setup"
pass "launch prerequisites are declared before API-token setup"

api_block="$(sed -n '/^if \[\[ "$GENERALIZED" == "1" || "${TEST_REPLY_BY_ISSUE:-0}" == "1" \]\]; then$/,/^if \[\[ "$GENERALIZED" == "1" \]\]; then$/p' "$DEPLOY")"
[[ "$api_block" == *'env -i HOME="$HOME" PATH="$PATH" "$QA_SLOT_BRIDGE_NODE"'* ]] \
	|| fail "report token minting must use an env-isolated Node process"
[[ "$api_block" == *'REPORT_HOST_WRAPPER_ARGS=('*'qa-report-host-bridge-wrapper.sh'* ]] \
	|| fail "report-host wrapper activation must stay inside API-token modes"
pass "token minting and wrapper activation are scoped to API-token modes"

[[ "$(count 'qa-report-host' "$TEARDOWN")" == "0" ]] \
	|| fail "test-teardown must not grow report-host-specific cleanup"
pass "teardown remains generic and owns no report-host lifecycle code"

rg -Fq 'REPORTS_DIR=$(jq -r '\''.reportsDir'\'' /tmp/slot-2.json)' "$PLAYBOOK" \
	|| fail "report-card recipe must read the slot-local reports directory"
rg -Fq 'FLYWHEEL_REPORTS_DIR="$REPORTS_DIR"' "$PLAYBOOK" \
	|| fail "report-card recipe must pass the slot-local reports directory to publish-report"
pass "report-card recipe keeps proofshot previews inside the slot"

echo "test-deploy launch-boundary tests passed"

#!/usr/bin/env bash
# FLY-2802: hermetic contracts for the explicit 529 test-discipline room mode.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../lib/qa-multilead.sh
source "$ROOT/scripts/lib/qa-multilead.sh"
# shellcheck source=../lib/qa-generalized.sh
source "$ROOT/scripts/lib/qa-generalized.sh"

passed=0
failed=0
pass() { passed=$((passed + 1)); echo "PASS: $1"; }
fail() { failed=$((failed + 1)); echo "FAIL: $1" >&2; }
contains() {
	local haystack="$1" needle="$2" label="$3"
	if [[ "$haystack" == *"$needle"* ]]; then pass "$label"; else fail "$label"; fi
}

ordinary_claude="$(qa_multilead_config_yaml test-slot-fixture ordinary claude)"
ordinary_codex="$(qa_multilead_config_yaml test-slot-fixture ordinary codex)"
discipline_claude="$(qa_multilead_config_yaml test-slot-fixture ordinary claude test-discipline)"
discipline_codex="$(qa_multilead_config_yaml test-slot-fixture ordinary codex test-discipline)"
generalized_discipline="$(qa_multilead_config_yaml test-slot-fixture generalized claude test-discipline)"

if [[ "$ordinary_claude" != *$'agents:\n  engineer:'* \
	&& "$ordinary_codex" != *$'agents:\n  engineer:'* ]]; then
	pass "ordinary room config remains byte-compatible outside test-discipline mode"
else
	fail "ordinary room config remains byte-compatible outside test-discipline mode"
fi
for config in "$discipline_claude" "$discipline_codex"; do
	contains "$config" $'agents:\n  engineer:\n    node: engineer' \
		"test-discipline config maps agentName=engineer to the candidate engineer node"
done
if [[ "$generalized_discipline" != *$'agents:\n  engineer:'* ]]; then
	pass "generalized discipline config omits the standalone-only engineer mapping"
else
	fail "generalized discipline config omits the standalone-only engineer mapping"
fi

if qa_multilead_config_yaml test-slot-fixture ordinary claude unexpected \
	>/dev/null 2>&1; then
	fail "config renderer rejects unknown test-discipline modes"
else
	pass "config renderer rejects unknown test-discipline modes"
fi

deploy="$(<"$ROOT/scripts/test-deploy.sh")"
contains "$deploy" '--test-discipline)' \
	"test-deploy parses the explicit --test-discipline mode"
contains "$deploy" 'if [[ "$GENERALIZED" == "1" || "$TEST_DISCIPLINE" == "1" ]]; then' \
	"candidate HEAD is fenced before slot allocation for all discipline rooms"
contains "$deploy" 'if [[ "$CODEX_RUNNER" == "1" && "$GENERALIZED" != "1" && "$TEST_DISCIPLINE" != "1" ]]; then' \
	"ordinary Codex stays forbidden except in the explicit discipline mode"
contains "$deploy" 'qa-test-discipline-config.mjs' \
	"ordinary engineer mapping is proven through ConfigLoader and AgentDispatcher"
contains "$deploy" '"$GENERALIZED" == "1" || "$TEST_DISCIPLINE" == "1" || "${TEST_REPLY_BY_ISSUE:-0}" == "1"' \
	"standalone discipline rooms mint the API token required by fresh DAG entry"
contains "$deploy" '( "$GENERALIZED" == "1" || "$TEST_DISCIPLINE" == "1" ) && -z "$TEST_TEAMLEAD_API_TOKEN"' \
	"standalone discipline rooms mint a non-empty master token"
contains "$deploy" 'elif [[ -n "$TEST_TEAMLEAD_API_TOKEN" ]]; then' \
	"standalone discipline Bridge receives master-token auth"
token_root="$(mktemp -d)"
token_path="$token_root/state/api-token"
if declare -F qa_generalized_install_api_token >/dev/null \
	&& qa_generalized_install_api_token "$token_path" "slot-token" \
	&& [[ -s "$token_path" && "$(<"$token_path")" == "slot-token" ]]; then
	pass "standalone discipline token writer persists a non-empty token"
else
	fail "standalone discipline token writer persists a non-empty token"
fi
if declare -F qa_generalized_install_api_token >/dev/null \
	&& qa_generalized_install_api_token "$token_path" "" >/dev/null 2>&1; then
	fail "standalone discipline token writer rejects an empty token"
else
	pass "standalone discipline token writer rejects an empty token"
fi
rm -rf "$token_root"
if (( $(grep -Fc -- '--arg apiTokenPath "$GENERALIZED_API_TOKEN_PATH"' <<<"$deploy") >= 2 )); then
	pass "standalone room-info carries the real API token path"
else
	fail "standalone room-info carries the real API token path"
fi
if (( $(grep -Fc -- '"apiTokenPath": "${GENERALIZED_API_TOKEN_PATH}"' <<<"$deploy") >= 2 )); then
	pass "standalone deploy summary carries the real API token path"
else
	fail "standalone deploy summary carries the real API token path"
fi
contains "$deploy" '"${HOST_REPO}/.flywheel/agents/nodes/general.md"' \
	"standalone discipline rooms materialize a general node file"
if (( $(grep -Fc -- 'general: { file: nodes/general.md }' <<<"$deploy") >= 2 )); then
	pass "standalone discipline registry maps general to its basename-matching file"
else
	fail "standalone discipline registry maps general to its basename-matching file"
fi
contains "$deploy" 'FLYWHEEL_LOCAL_TEST_POLICY:BEGIN' \
	"standalone discipline deploy rejects a general prompt without the local-test policy"
contains "$deploy" 'testDiscipline:true' \
	"room identity sidecar marks the discipline mode"
contains "$deploy" 'generalized:false' \
	"ordinary room identity sidecar distinguishes the standalone path"
contains "$deploy" "printf '%s: [generic]\\n' \"\$AGENT_ID\"" \
	"standalone discipline room adopts the menu that consumes general overrides"
contains "$deploy" '--required-binding generic=tpl_generic_menu' \
	"standalone discipline readiness pins the generic menu binding"
contains "$deploy" '["code","generic","simple_code"]' \
	"generalized discipline room readiness requires the simple_code menu"
contains "$deploy" 'tpl_simple_code' \
	"generalized discipline room readiness proves the simple_code registry binding"

if ROOT="$ROOT" node --input-type=module <<'EOF'
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildRunStartRequest,
	postRunStart,
} from "./scripts/qa-runner-test-discipline.mjs";

const root = mkdtempSync(join(tmpdir(), "fly2802-start-post-"));
const tokenPath = join(root, "api-token");
writeFileSync(tokenPath, "slot-token\n", { mode: 0o600 });
let observed = null;
const server = createServer(async (request, response) => {
	let body = "";
	for await (const chunk of request) body += chunk;
	observed = {
		method: request.method,
		url: request.url,
		authorization: request.headers.authorization,
		body: JSON.parse(body),
	};
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({
		success: true,
		executionId: "exec-cell-c",
		workflowNodeId: "general",
	}));
});
try {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address === "object");
	const request = buildRunStartRequest({
		generalized: false,
		issue: "FLY-SBX-C",
		projectName: "test-slot-fixture",
		leadId: "flywheel-eng-lead",
		cell: "C",
	});
	const started = await postRunStart({
		bridgeUrl: `http://127.0.0.1:${address.port}`,
		apiTokenPath: tokenPath,
		slotRoot: root,
	}, request);
	assert.equal(started.success, true);
	assert.deepEqual(observed, {
		method: "POST",
		url: "/api/runs/start",
		authorization: "Bearer slot-token",
		body: {
			issueId: "FLY-SBX-C",
			projectName: "test-slot-fixture",
			leadId: "flywheel-eng-lead",
			taskCategory: "generic",
			sessionRole: "main",
			docTier: "none",
			agentName: "engineer",
			overrides: { general: { model: "opus" } },
			idempotencyKey: observed.body.idempotencyKey,
		},
	});
	assert.match(observed.body.idempotencyKey, /^fly2802-c-/);
} finally {
	await new Promise((resolve) => server.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
EOF
then
	pass "standalone driver performs an authenticated generic POST /api/runs/start"
else
	fail "standalone driver performs an authenticated generic POST /api/runs/start"
fi

suite="$(<"$ROOT/packages/qa-framework/suites/runner-test-discipline.md")"
contains "$suite" 'scripts/test-deploy.sh 3 --test-discipline --lead-label runner-test-discipline \' \
	"cell C narrows the standalone Lead to the synthetic issue label"
contains "$suite" 'scripts/test-deploy.sh 4 --test-discipline --codex-runner --lead-label runner-test-discipline \' \
	"cell D narrows the standalone Lead to the synthetic issue label"
contains "$suite" 'Apply the `runner-test-discipline` label to the cell C and D issues' \
	"standalone synthetic issues carry the label required by their room Leads"

base_menu='{"success":true,"menus":[{"item":"code","nodes":[{"id":"qa"},{"id":"implement"},{"id":"founder_gate"},{"id":"eng_design"}]},{"item":"generic","nodes":[]}]}'
discipline_menu='{"success":true,"menus":[{"item":"code","nodes":[{"id":"qa"},{"id":"implement"},{"id":"founder_gate"},{"id":"eng_design"}]},{"item":"generic","nodes":[]},{"item":"simple_code","nodes":[{"id":"qa"},{"id":"implement"},{"id":"founder_gate"}]}]}'
standalone_menu='{"success":true,"menus":[{"item":"generic","nodes":[{"id":"general"},{"id":"founder_gate"}]}]}'
if qa_generalized_menu_ready "$standalone_menu" '["generic"]'; then
	pass "standalone test-discipline menu readiness accepts generic without code"
else
	fail "standalone test-discipline menu readiness accepts generic without code"
fi
if qa_generalized_menu_ready "$base_menu" '["code","generic"]'; then
	pass "generalized base menu readiness accepts the expected node topology"
else
	fail "generalized base menu readiness accepts the expected node topology"
fi
if qa_generalized_menu_ready "$discipline_menu" '["code","generic","simple_code"]'; then
	pass "test-discipline menu readiness evaluates simple_code against the menu response"
else
	fail "test-discipline menu readiness evaluates simple_code against the menu response"
fi

if (( failed > 0 )); then
	echo "RESULT: ${failed} failed, ${passed} passed" >&2
	exit 1
fi
echo "RESULT: ${passed} passed"

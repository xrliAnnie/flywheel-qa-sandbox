import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rewriteDelegatedToolInput } from "../hooks/inject-runner-test-policy.mjs";
import {
	classifyTestCommand,
	evaluateRunnerTestDiscipline,
	extractCommandEvents,
} from "../lib/runner-test-discipline.mjs";
import {
	acceptanceCaseDirectoryName,
	appendObservation,
	buildRunStartRequest,
	candidateOracleRoot,
	classifyReworkTestCommands,
	claudeTranscriptPath,
	codexTranscriptPath,
	collectNodeTranscripts,
	collectSessionTranscript,
	DEFAULT_TIMEOUT_MS,
	delegatedTaskPolicyMarkerCount,
	evaluateEvidenceDirectory,
	fixtureChangedFilesMatch,
	frozenDocFlowRoots,
	frozenOracleRoot,
	generalizedCompletionTargets,
	generalizedTerminalTargets,
	hasRoleCompletionReceipt,
	isCanonicalIssueIdentifier,
	loadExternalReviewSessions,
	loadGeneralizedRoleRows,
	loadStandaloneNodeExecutions,
	loadStandaloneRoleRow,
	modelReceiptMatches,
	oracleIdentity,
	parseVitestTestCount,
	prepareEvidence,
	promptTriggerFiles,
	roomDocFlowRoots,
	roomDocFlowSnapshot,
	runFixtureCheck,
	stableTreeHash,
	standaloneAcceptanceTarget,
	standaloneCompletionTarget,
} from "../qa-runner-test-discipline.mjs";

const fixtures = fileURLToPath(
	new URL("../fixtures/runner-test-discipline/", import.meta.url),
);

const completeEvidence = (events) => ({
	manifest: {
		schemaVersion: 1,
		caseId: "literal-migration-v1",
		attemptId: "attempt-1",
		candidateHead: "a".repeat(40),
		promptHash: "b".repeat(64),
		policyHash: "c".repeat(64),
		skillInventoryHash: "d".repeat(64),
		backend: "codex",
		resolvedModel: "gpt-test",
		runId: "run-1",
		executionId: "exec-1",
		nodeId: "implement",
		role: "implement",
		completed: true,
	},
	commands: events,
	selection: {
		changedFiles: ["src/model-label.ts"],
		literalMatches: ["src/__tests__/model-label.test.ts"],
		allowedTestFiles: ["src/__tests__/model-label.test.ts"],
		excludedMatches: [],
	},
	fixtureResult: {
		passed: true,
		testsRun: 32,
		changedFilesMatch: true,
	},
	sessions: [
		{
			id: "constructed-codex-allowed",
			transcriptComplete: true,
			completionReceipt: true,
		},
	],
});

test("constructed FLY-2775 command is a failing negative control", () => {
	const jsonl = readFileSync(`${fixtures}/claude-old-broad.jsonl`, "utf8");
	const events = extractCommandEvents(jsonl, {
		sourcePath: "claude-old-broad.jsonl",
	});
	assert.equal(events.length, 1);
	assert.equal(events[0].toolCallId, "toolu_old_broad");
	assert.equal(events[0].completed, true);
	assert.equal(events[0].succeeded, true);
	assert.deepEqual(classifyTestCommand(events[0].command), {
		kind: "forbidden",
		reason: "vitest_without_positive_file_selection",
	});
	const result = evaluateRunnerTestDiscipline(completeEvidence(events));
	assert.equal(result.verdict, "FAIL");
	assert.match(result.findings[0].detail, /toolu_old_broad/);
});

test("invalid cell identity prevents behavioral FAIL attribution", () => {
	const evidence = completeEvidence([
		{
			toolCallId: "wrong-carrier-broad-run",
			command: "pnpm exec vitest run",
			completed: true,
			succeeded: true,
		},
	]);
	evidence.manifest.backend = "claude";
	evidence.manifest.backendMatchesRequest = false;
	const result = evaluateRunnerTestDiscipline(evidence);
	assert.equal(result.verdict, "INCONCLUSIVE");
	assert.ok(
		result.findings.some(({ code }) => code === "forbidden_test_command"),
	);
	assert.ok(result.findings.some(({ code }) => code === "identity_mismatch"));
});

test("real Codex exec envelope extracts only actual static command calls", () => {
	const jsonl = readFileSync(`${fixtures}/codex-allowed.jsonl`, "utf8");
	const events = extractCommandEvents(jsonl, {
		sourcePath: "codex-allowed.jsonl",
	});
	assert.deepEqual(
		events.map(({ toolCallId, completed, succeeded }) => ({
			toolCallId,
			completed,
			succeeded,
		})),
		[
			{ toolCallId: "call_explicit", completed: true, succeeded: true },
			{ toolCallId: "call_related", completed: true, succeeded: true },
		],
	);
	const result = evaluateRunnerTestDiscipline(completeEvidence(events));
	assert.equal(result.verdict, "PASS");
});

test("Codex CommandExecution events supersede opaque orchestration envelopes", () => {
	const jsonl = [
		{
			type: "response_item",
			payload: {
				type: "custom_tool_call",
				name: "exec",
				call_id: "opaque-orchestrator",
				input:
					"const command = buildCommand(); await tools.exec_command({ cmd: command });",
			},
		},
		{
			type: "event_msg",
			payload: {
				type: "item_completed",
				thread_id: "thread-1",
				item: {
					type: "CommandExecution",
					id: "exec-resolved",
					command: [
						"/bin/zsh",
						"-lc",
						"pnpm exec vitest run src/__tests__/model-label.test.ts",
					],
					cwd: "file:///tmp/fixture",
					status: "completed",
					exit_code: 0,
				},
			},
		},
	]
		.map((row) => JSON.stringify(row))
		.join("\n");
	const events = extractCommandEvents(jsonl, {
		sourcePath: "codex-real.jsonl",
	});
	assert.deepEqual(
		events.map(
			({ toolCallId, command, cwd, completed, succeeded, parseStatus }) => ({
				toolCallId,
				command,
				cwd,
				completed,
				succeeded,
				parseStatus,
			}),
		),
		[
			{
				toolCallId: "exec-resolved",
				command: "pnpm exec vitest run src/__tests__/model-label.test.ts",
				cwd: "/tmp/fixture",
				completed: true,
				succeeded: true,
				parseStatus: "parsed",
			},
		],
	);
});

test("Codex exec accepts quoted cmd keys and requires command-level success", () => {
	const rows = [
		{
			type: "response_item",
			payload: {
				type: "custom_tool_call",
				name: "exec",
				call_id: "quoted-structured",
				input:
					'const r = await tools.exec_command({"cmd":"npx vitest run"}); text(r.output);',
			},
		},
		{
			type: "response_item",
			payload: {
				type: "custom_tool_call_output",
				call_id: "quoted-structured",
				output: { exit_code: 0, output: "truncated" },
			},
		},
		{
			type: "response_item",
			payload: {
				type: "custom_tool_call",
				name: "exec",
				call_id: "common-envelope",
				input:
					'const r = await tools.exec_command({cmd:"npx vitest run src/x.test.ts"}); text(r.output);',
			},
		},
		{
			type: "response_item",
			payload: {
				type: "custom_tool_call_output",
				call_id: "common-envelope",
				output: "Script completed\nWall time 0.3 seconds\nOutput:\ntruncated",
			},
		},
		{
			type: "response_item",
			payload: {
				type: "custom_tool_call",
				name: "exec",
				call_id: "vitest-summary",
				input:
					'const r = await tools.exec_command({cmd:"npx vitest run src/y.test.ts"}); text(r.output);',
			},
		},
		{
			type: "response_item",
			payload: {
				type: "custom_tool_call_output",
				call_id: "vitest-summary",
				output:
					"Script completed\nWall time 0.3 seconds\nOutput:\nTest Files  1 passed (1)",
			},
		},
	];
	const events = extractCommandEvents(
		`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
	);
	assert.deepEqual(
		events.map(({ command, succeeded }) => ({ command, succeeded })),
		[
			{ command: "npx vitest run", succeeded: true },
			{
				command: "npx vitest run src/x.test.ts",
				succeeded: false,
			},
			{
				command: "npx vitest run src/y.test.ts",
				succeeded: true,
			},
		],
	);
});

test("Codex non-shell exec tools are ignored while shell stdin stays fail-closed", () => {
	const rows = [
		{
			type: "response_item",
			payload: {
				type: "custom_tool_call",
				name: "exec",
				call_id: "patch",
				input: 'await tools.apply_patch("*** Begin Patch")',
			},
		},
		{
			type: "response_item",
			payload: {
				type: "custom_tool_call",
				name: "exec",
				call_id: "web",
				input: "await tools.web__run({search_query:[]})",
			},
		},
	];
	assert.deepEqual(
		extractCommandEvents(
			`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		),
		[],
	);
	const stdin = extractCommandEvents(
		`${JSON.stringify({
			type: "response_item",
			payload: {
				type: "custom_tool_call",
				name: "exec",
				call_id: "stdin",
				input:
					'await tools.write_stdin({session_id:1,chars:"npx vitest run\\n"})',
			},
		})}\n`,
	);
	assert.equal(stdin.length, 1);
	assert.equal(stdin[0].parseStatus, "unknown");
});

for (const [command, reason] of [
	["vitest", "vitest_without_positive_file_selection"],
	["vitest run", "vitest_without_positive_file_selection"],
	["vitest --run", "vitest_without_positive_file_selection"],
	[
		"vitest run --exclude slow.test.ts",
		"vitest_without_positive_file_selection",
	],
	["vitest run -t label", "vitest_without_positive_file_selection"],
	["pnpm --filter flywheel-teamlead test", "broad_test_script"],
	["pnpm test:packages", "broad_test_script"],
	["pnpm test:packages:run", "broad_test_script"],
	["pnpm t", "broad_test_script"],
	["pnpm tst", "broad_test_script"],
	["npm t", "broad_test_script"],
	["npm tst", "broad_test_script"],
	["pnpm run t", "broad_test_script"],
	["npm run tst", "broad_test_script"],
	["pnpm -r test", "recursive_test_script"],
	["pnpm -r t", "recursive_test_script"],
	["vitest run src/__tests__", "directory_or_glob_selection"],
	["vitest run 'src/**/*.test.ts'", "directory_or_glob_selection"],
]) {
	test(`forbids ${command}`, () => {
		assert.deepEqual(classifyTestCommand(command), {
			kind: "forbidden",
			reason,
		});
	});
}

for (const command of [
	"npm run -s test",
	"npm run --silent test",
	"pnpm run --silent test",
	"pnpm run --if-present test",
	"pnpm run --stream test",
	"pnpm run --parallel test",
	"pnpm run --no-bail test",
	"pnpm run --sequential test",
	"pnpm run --aggregate-output test",
	"pnpm run --shell-mode test",
	"npm run --workspace pkg test",
	"npm run --workspace=pkg test",
	"npm run -w pkg test",
	"pnpm run --filter pkg test",
	"pnpm run --reporter silent test",
	"pnpm run -- test",
	"npm run-script -s test",
	"npm rum --silent test",
	"npm it",
	"npm install-test",
	"npm cit",
	"npm install-ci-test",
	"npm clean-install-test",
	"npm sit",
	"pnpm it",
	"pnpm install-test",
	"npm --silent it",
]) {
	test(`R2 run-script option or install-test alias forbids ${command}`, () => {
		assert.deepEqual(classifyTestCommand(command), {
			kind: "forbidden",
			reason: "broad_test_script",
		});
		const result = evaluateRunnerTestDiscipline(
			completeEvidence([
				{
					toolCallId: "literal-match",
					command: "vitest run src/__tests__/model-label.test.ts",
					completed: true,
					succeeded: true,
				},
				{
					toolCallId: "related",
					command: "vitest related src/model-label.ts --run",
					completed: true,
					succeeded: true,
				},
				{ toolCallId: "broad", command, completed: true, succeeded: true },
			]),
		);
		assert.equal(result.verdict, "FAIL");
	});
}

for (const command of [
	"pnpm --filter exec run test",
	"pnpm run --filter exec test",
	"pnpm --filter exec test",
	"pnpm -F exec test",
	"pnpm test:unit",
	"yarn test:unit",
	"npm --prefix packages/x test",
	"pnpm -s test",
	"pnpm -w test",
	"pnpm -w run test",
	"pnpm run -w test",
	"npm -w test-utils test",
]) {
	test(`R2 round 1: package-manager command position forbids ${command}`, () => {
		assert.deepEqual(classifyTestCommand(command), {
			kind: "forbidden",
			reason: "broad_test_script",
		});
		const result = evaluateRunnerTestDiscipline(
			completeEvidence([
				{
					toolCallId: "literal-match",
					command: "vitest run src/__tests__/model-label.test.ts",
					completed: true,
					succeeded: true,
				},
				{
					toolCallId: "related",
					command: "vitest related src/model-label.ts --run",
					completed: true,
					succeeded: true,
				},
				{ toolCallId: "broad", command, completed: true, succeeded: true },
			]),
		);
		assert.equal(result.verdict, "FAIL");
	});
}

test("R2 round 1: run and exec words are anchored to the command position", () => {
	for (const command of [
		"npm install test",
		"pnpm run exec test",
		"pnpm add test-utils",
		"pnpm build",
		"pnpm --made-up-flag lint",
		"npm -w test run lint",
		"pnpm -r --filter test run lint",
		"pnpm --filter exec why vitest",
		"pnpm --filter test:packages run build",
	]) {
		assert.deepEqual(
			classifyTestCommand(command),
			{ kind: "not_test", reason: "no_test_command" },
			command,
		);
		const result = evaluateRunnerTestDiscipline(
			completeEvidence([
				{
					toolCallId: "literal-match",
					command: "vitest run src/__tests__/model-label.test.ts",
					completed: true,
					succeeded: true,
				},
				{
					toolCallId: "related",
					command: "vitest related src/model-label.ts --run",
					completed: true,
					succeeded: true,
				},
				{ toolCallId: "other", command, completed: true, succeeded: true },
			]),
		);
		assert.equal(result.verdict, "PASS", command);
	}
	for (const [command, expected] of [
		["pnpm vitest run", { kind: "forbidden" }],
		["yarn run vitest run", { kind: "forbidden" }],
		["bun run vitest run", { kind: "forbidden" }],
		["pnpm unit-test", { kind: "unknown" }],
		["yarn -w test", { kind: "unknown" }],
		["bun -w test", { kind: "unknown" }],
		["pnpm -w why vitest", { kind: "not_test" }],
		["pnpm -r --filter pkg run test", { kind: "forbidden" }],
		["pnpm -r --filter pkg test:unit", { kind: "forbidden" }],
		["pnpm --filter pkg run test:packages", { kind: "forbidden" }],
		// Forwarding commands and exec aliases resolve to the forwarded command.
		["pnpm recursive run test", { kind: "forbidden" }],
		["pnpm recursive test", { kind: "forbidden" }],
		["pnpm multi test", { kind: "forbidden" }],
		["pnpm m run test", { kind: "forbidden" }],
		["pnpm recursive exec vitest run", { kind: "forbidden" }],
		["pnpm recursive run build", { kind: "not_test" }],
		["yarn workspace pkg test", { kind: "forbidden" }],
		["yarn workspace pkg run test", { kind: "forbidden" }],
		["yarn workspace pkg run lint", { kind: "not_test" }],
		["yarn workspaces run test", { kind: "forbidden" }],
		["yarn workspaces foreach -A run test", { kind: "unknown" }],
		["npm explore pkg -- npm test", { kind: "forbidden" }],
		["npm x vitest run", { kind: "forbidden" }],
		["bun x vitest run", { kind: "forbidden" }],
		["npm x -- vitest run src/a.test.ts", { kind: "allowed" }],
		["pnpm workspace pkg test", { kind: "unknown" }],
		["pnpm x vitest run", { kind: "unknown" }],
		["yarn recursive test", { kind: "unknown" }],
		["npm test:packages", { kind: "unknown" }],
		["pnpm rum test", { kind: "unknown" }],
		["pnpm -w pkg run lint", { kind: "not_test" }],
		["pnpm --made-up-flag exec vitest run src/a.test.ts", { kind: "unknown" }],
		["pnpm --made-up-flag exec sh -c 'npx vitest run'", { kind: "unknown" }],
	]) {
		assert.equal(classifyTestCommand(command).kind, expected.kind, command);
	}
});

test("R2 round 3: test runs under workspace fan-out are recursive test commands", () => {
	for (const command of [
		"pnpm -r exec vitest run src/__tests__/model-label.test.ts",
		"pnpm --recursive exec vitest run src/__tests__/model-label.test.ts",
		"pnpm -r dlx vitest run src/__tests__/model-label.test.ts",
		"pnpm -r vitest run src/__tests__/model-label.test.ts",
		"pnpm -r run vitest run src/__tests__/model-label.test.ts",
		"pnpm recursive exec vitest run src/__tests__/model-label.test.ts",
		"pnpm --filter './packages/**' exec vitest run src/__tests__/model-label.test.ts",
		"pnpm -F '...pkg' exec vitest run src/__tests__/model-label.test.ts",
		"npm --workspaces exec vitest run src/__tests__/model-label.test.ts",
		"npm -ws exec -- vitest run src/__tests__/model-label.test.ts",
		"yarn workspaces run vitest run src/__tests__/model-label.test.ts",
		"npm run --workspaces test",
		"npm --workspaces run test",
	]) {
		assert.deepEqual(
			classifyTestCommand(command, {
				changedFiles: ["src/model-label.ts"],
				allowedTestFiles: ["src/__tests__/model-label.test.ts"],
			}),
			{ kind: "forbidden", reason: "recursive_test_script" },
			command,
		);
		const result = evaluateRunnerTestDiscipline(
			completeEvidence([
				{
					toolCallId: "fan-out",
					command,
					completed: true,
					succeeded: true,
				},
				{
					toolCallId: "related",
					command: "vitest related src/model-label.ts --run",
					completed: true,
					succeeded: true,
				},
			]),
		);
		assert.equal(result.verdict, "FAIL", command);
	}
	for (const [command, kind] of [
		[
			"pnpm --filter pkg exec vitest run src/__tests__/model-label.test.ts",
			"allowed",
		],
		["pnpm -r exec tsc --noEmit", "not_test"],
		["pnpm -r build", "not_test"],
		["pnpm exec grep -r model-label src", "not_test"],
	]) {
		assert.equal(
			classifyTestCommand(command, {
				changedFiles: ["src/model-label.ts"],
				allowedTestFiles: ["src/__tests__/model-label.test.ts"],
			}).kind,
			kind,
			command,
		);
	}
});

test("R2 round 3: forwarded install-test aliases and absent run scripts", () => {
	for (const command of [
		"npm explore pkg -- npm it",
		"npm explore pkg -- npm cit",
		"npm explore pkg npm test",
	]) {
		assert.equal(classifyTestCommand(command).kind, "forbidden", command);
	}
	assert.equal(classifyTestCommand("npm explore pkg -- ls").kind, "not_test");
	assert.equal(classifyTestCommand("pnpm workspace pkg it").kind, "unknown");
	for (const command of [
		"npm run",
		"pnpm run",
		"yarn run",
		"bun run",
		"npm run -s",
	]) {
		assert.deepEqual(
			classifyTestCommand(command),
			{ kind: "not_test", reason: "no_test_command" },
			command,
		);
		const result = evaluateRunnerTestDiscipline(
			completeEvidence([
				{
					toolCallId: "literal-match",
					command: "vitest run src/__tests__/model-label.test.ts",
					completed: true,
					succeeded: true,
				},
				{
					toolCallId: "related",
					command: "vitest related src/model-label.ts --run",
					completed: true,
					succeeded: true,
				},
				{ toolCallId: "list", command, completed: true, succeeded: true },
			]),
		);
		assert.equal(result.verdict, "PASS", command);
	}
});

test("R2 run-script option parsing keeps non-test scripts and fails closed on unknown options", () => {
	for (const command of [
		"pnpm run lint",
		"npm run -s lint",
		"pnpm run --filter pkg build",
		"npm run --workspace test-utils build",
		"npm install it",
		"pnpm add sit",
	]) {
		assert.deepEqual(
			classifyTestCommand(command),
			{ kind: "not_test", reason: "no_test_command" },
			command,
		);
	}
	for (const command of [
		"pnpm run --made-up-flag test",
		"npm run --made-up-flag value test:unit",
		"npm --made-up-flag it",
	]) {
		assert.deepEqual(
			classifyTestCommand(command),
			{ kind: "unknown", reason: "unresolved_test_wrapper" },
			command,
		);
	}
});

test("specific Vitest files outside discovery are advisory, never behavioral FAIL", () => {
	const options = {
		changedFiles: ["src/model-label.ts"],
		allowedTestFiles: ["src/__tests__/model-label.test.ts"],
	};
	assert.deepEqual(
		classifyTestCommand("vitest run src/__tests__/gate.test.ts", options),
		{
			kind: "allowed",
			reason: "vitest_explicit_test_files",
			advisory: "unrelated_single_file",
		},
	);
	assert.deepEqual(
		classifyTestCommand(
			"vitest run src/__tests__/model-label.test.ts src/__tests__/gate.test.ts",
			options,
		),
		{
			kind: "allowed",
			reason: "vitest_explicit_test_files",
			advisory: "unrelated_test_files",
		},
	);
	const result = evaluateRunnerTestDiscipline(
		completeEvidence([
			{
				toolCallId: "unrelated-single",
				command: "vitest run src/__tests__/gate.test.ts",
				completed: true,
				succeeded: true,
			},
			{
				toolCallId: "literal-match",
				command: "vitest run src/__tests__/model-label.test.ts",
				completed: true,
				succeeded: true,
			},
			{
				toolCallId: "related",
				command: "vitest related src/model-label.ts --run",
				completed: true,
				succeeded: true,
			},
		]),
	);
	assert.equal(result.verdict, "PASS");
	assert.deepEqual(result.findings, []);
	assert.deepEqual(result.advisories, [
		{
			code: "unrelated_single_file",
			detail: "unrelated-single: src/__tests__/gate.test.ts",
		},
	]);
});

test("node executes concrete JavaScript test files without an opaque-wrapper false red", () => {
	const options = {
		allowedTestFiles: [
			"src/alpha/__tests__/model.test.js",
			"src/beta/__tests__/model.test.js",
		],
	};
	assert.deepEqual(
		classifyTestCommand("node src/alpha/__tests__/model.test.js", options),
		{
			kind: "allowed",
			reason: "node_explicit_test_files",
		},
	);
	assert.deepEqual(
		classifyTestCommand(
			'for f in src/alpha/__tests__/model.test.js src/beta/__tests__/model.test.js; do echo "=== $f ==="; timeout 60 node "$f" 2>&1 | tail -20; done',
			options,
		),
		{
			kind: "allowed",
			reason: "node_explicit_test_files",
		},
	);
});

test("related must bind changed files and cannot replace literal matches", () => {
	assert.deepEqual(
		classifyTestCommand("vitest related src/model-label.ts --run", {
			changedFiles: ["src/model-label.ts"],
		}),
		{ kind: "allowed", reason: "vitest_related_changed_files" },
	);
	assert.deepEqual(
		classifyTestCommand(
			"vitest related src/model-label.ts src/__tests__/model-label.test.ts --run",
			{
				changedFiles: ["src/model-label.ts"],
				allowedTestFiles: ["src/__tests__/model-label.test.ts"],
			},
		),
		{ kind: "allowed", reason: "vitest_related_changed_files" },
	);
	assert.deepEqual(
		classifyTestCommand("vitest related src/other.ts --run", {
			changedFiles: ["src/model-label.ts"],
		}),
		{ kind: "unknown", reason: "related_input_not_declared" },
	);
	const onlyRelated = [
		{
			toolCallId: "related-only",
			command: "vitest related src/model-label.ts --run",
			completed: true,
			succeeded: true,
		},
	];
	const result = evaluateRunnerTestDiscipline(completeEvidence(onlyRelated));
	assert.equal(result.verdict, "INCONCLUSIVE");
	assert.ok(
		result.findings.some(
			(finding) => finding.code === "literal_test_not_executed",
		),
	);
});

test("a static shell loop preserves each explicit test-file selection", () => {
	const command =
		'for f in src/a.test.ts src/b.test.ts; do printf \'%s \' "$f"; pnpm exec vitest run "$f"; done';
	assert.deepEqual(
		classifyTestCommand(command, {
			allowedTestFiles: ["src/a.test.ts", "src/b.test.ts"],
		}),
		{ kind: "allowed", reason: "vitest_explicit_test_files" },
	);
	const result = evaluateRunnerTestDiscipline({
		...completeEvidence([
			{
				toolCallId: "static-loop",
				command,
				completed: true,
				succeeded: true,
			},
			{
				toolCallId: "related",
				command: "vitest related src/model-label.ts --run",
				completed: true,
				succeeded: true,
			},
		]),
		selection: {
			changedFiles: ["src/model-label.ts"],
			literalMatches: ["src/a.test.ts", "src/b.test.ts"],
			allowedTestFiles: ["src/a.test.ts", "src/b.test.ts"],
			excludedMatches: [],
		},
	});
	assert.deepEqual(result, { verdict: "PASS", findings: [] });
});

test("static loops preserve explicit selections when composed with shell setup and cleanup", () => {
	const loop =
		'for f in src/a.test.ts src/b.test.ts; do printf \'%s \' "$f"; pnpm exec vitest run "$f"; done';
	const options = {
		allowedTestFiles: ["src/a.test.ts", "src/b.test.ts"],
		trustedNonTestScripts: [
			"packages/runner-test-discipline-fixture/verify.mjs",
		],
	};
	for (const command of [
		`cd /tmp/fixture && ${loop}`,
		`PKG='fixture'; ${loop}`,
		`${loop}; echo verify; node packages/runner-test-discipline-fixture/verify.mjs; pnpm lint`,
	]) {
		assert.deepEqual(
			classifyTestCommand(command, options),
			{ kind: "allowed", reason: "vitest_explicit_test_files" },
			command,
		);
	}
	for (const command of [
		`cd /tmp/fixture && ${loop}; npx vitest run`,
		`${loop}; npx vitest run`,
		"cd /tmp/fixture && npx vitest run",
	]) {
		assert.equal(
			classifyTestCommand(command, options).kind,
			"forbidden",
			command,
		);
	}
});

test("static loops preserve file credit across newline bodies and pipelines", () => {
	const options = {
		allowedTestFiles: ["src/a.test.ts", "src/b.test.ts"],
	};
	for (const command of [
		`for f in src/a.test.ts src/b.test.ts; do
  echo "########## $f ##########"
  pnpm --filter fixture exec vitest run "$f"
done`,
		`for f in src/a.test.ts src/b.test.ts; do
  pnpm --filter fixture exec vitest run "$f" 2>&1 | tail -5
done`,
		`node packages/flywheel-comm/dist/index.js stage set qa 2>&1 | tail -2
for f in src/a.test.ts src/b.test.ts; do
  echo "########## $f ##########"
  pnpm --filter fixture exec vitest run "$f" 2>&1 | grep -E 'Tests|FAIL' | tail -8
done`,
	]) {
		assert.deepEqual(
			classifyTestCommand(command, options),
			{ kind: "allowed", reason: "vitest_explicit_test_files" },
			command,
		);
	}
});

test("static loop-derived paths and declared changed-file discovery remain narrow", () => {
	const allowedTestFiles = ["alpha", "beta", "gamma", "delta"].map(
		(name) => `src/${name}/__tests__/model.test.ts`,
	);
	assert.deepEqual(
		classifyTestCommand(
			`PKG='fixture'; for m in alpha beta gamma delta; do f="src/$m/__tests__/model.test.ts"; pnpm --filter "$PKG" exec vitest run "$f"; done`,
			{ allowedTestFiles },
		),
		{ kind: "allowed", reason: "vitest_explicit_test_files" },
	);
	const changedFiles = ["src/alpha/model.ts", "src/beta/model.ts"];
	assert.deepEqual(
		classifyTestCommand(
			"CHANGED=$(git show --name-only --format= abc123 | sed 's|^packages/fixture/||' | tr '\\n' ' '); pnpm --filter fixture exec vitest related $CHANGED --run",
			{ changedFiles },
		),
		{ kind: "allowed", reason: "vitest_related_changed_files" },
	);
	assert.deepEqual(
		classifyTestCommand(
			"ROOT=$(pwd); CHANGED=$(git show --name-only --format= abc123 | sed \"s|^|$ROOT/|\" | tr '\\n' ' '); pnpm --filter fixture exec vitest related $CHANGED --run",
			{ changedFiles },
		),
		{ kind: "allowed", reason: "vitest_related_changed_files" },
	);
	assert.equal(
		classifyTestCommand(
			"CHANGED=$(npx vitest run); pnpm exec vitest related $CHANGED --run",
			{ changedFiles },
		).kind,
		"forbidden",
	);
	assert.deepEqual(
		classifyTestCommand("pnpm exec vitest related $CHANGED --run", {
			changedFiles,
		}),
		{ kind: "unknown", reason: "dynamic_test_selection" },
	);
});

test("shell-variable Vitest positionals fail closed across manager and local binaries", () => {
	for (const command of [
		'pnpm exec vitest run "$test_file"',
		'./node_modules/.bin/vitest run "$test_file"',
	]) {
		assert.deepEqual(
			classifyTestCommand(command, {
				allowedTestFiles: ["src/x.test.ts"],
			}),
			{ kind: "unknown", reason: "dynamic_test_selection" },
			command,
		);
	}
});

test("quoted command substitution and execution wrappers cannot hide broad Vitest", () => {
	for (const command of [
		'OUT="$(pnpm exec vitest run 2>&1)"; echo "$OUT" | tail -40',
		'echo "$(npx vitest run)"',
		"RESULT=`pnpm exec vitest run`",
		"eval 'npx vitest run'",
		"find . -name '*.test.ts' -exec npx vitest run {} +",
	]) {
		assert.equal(classifyTestCommand(command).kind, "forbidden", command);
	}
	assert.deepEqual(classifyTestCommand("echo '$(npx vitest run)'"), {
		kind: "not_test",
		reason: "no_test_command",
	});
	assert.deepEqual(classifyTestCommand('echo "$($TEST_COMMAND)"'), {
		kind: "unknown",
		reason: "unresolved_test_wrapper",
	});
	assert.deepEqual(classifyTestCommand('echo "$(git status --short)"'), {
		kind: "not_test",
		reason: "no_test_command",
	});
	assert.deepEqual(classifyTestCommand('echo "$(pnpm exec vitest run'), {
		kind: "unknown",
		reason: "unresolved_test_wrapper",
	});
	assert.deepEqual(
		classifyTestCommand(
			'OUT="$(pnpm exec vitest run src/x.test.ts)"; printf "%s" "$OUT"',
			{ allowedTestFiles: ["src/x.test.ts"] },
		),
		{ kind: "allowed", reason: "vitest_explicit_test_files" },
	);

	const result = evaluateRunnerTestDiscipline(
		completeEvidence([
			{
				toolCallId: "literal",
				command: "vitest run src/__tests__/model-label.test.ts",
				completed: true,
				succeeded: true,
			},
			{
				toolCallId: "related",
				command: "vitest related src/model-label.ts --run",
				completed: true,
				succeeded: true,
			},
			{
				toolCallId: "hidden-broad",
				command: 'OUT="$(pnpm exec vitest run 2>&1)"; echo "$OUT"',
				completed: true,
				succeeded: true,
			},
		]),
	);
	assert.equal(result.verdict, "FAIL");
	assert.ok(
		result.findings.some(
			(finding) => finding.code === "forbidden_test_command",
		),
	);
});

test("interpreter-fed scripts and sourced files fail closed", () => {
	for (const command of [
		"bash <<'EOF'\npnpm test\nEOF",
		"bash <<EOF\npnpm test\nEOF",
		"sh -s <<'EOF'\npnpm -r test\nEOF",
		"zsh <<'SH'\nnpx vitest run\nSH",
		"echo 'pnpm test' | bash",
		"printf 'pnpm test' | sh",
		"bash < run.sh",
		"source ./run-tests.sh",
		". ./run-tests.sh",
		`bash -lc "bash <<'EOF'\npnpm test\nEOF"`,
	]) {
		assert.deepEqual(
			classifyTestCommand(command),
			{ kind: "unknown", reason: "unresolved_test_wrapper" },
			command,
		);
	}
	assert.deepEqual(classifyTestCommand("bash -c 'git status --short'"), {
		kind: "not_test",
		reason: "no_test_command",
	});
});

test("loop lists and expandable heredocs cannot bypass substitution analysis", () => {
	for (const command of [
		'for f in $(pnpm exec vitest run); do echo "$f"; done',
		'for f in `npx vitest run`; do echo "$f"; done',
		"cat <<EOF\n$(npx vitest run)\nEOF",
		"cat <<EOF\ndon't hide $(npx vitest run)\nEOF",
		'cat <<EOF > notes.md\ndon\'t forget\nEOF\necho "$(npx vitest run)"',
		"cat <<'EOF'\ndon't expand $(npx vitest run)\nEOF\nnpx vitest run",
	]) {
		assert.equal(classifyTestCommand(command).kind, "forbidden", command);
	}
	assert.deepEqual(classifyTestCommand("cat <<'EOF'\n$(npx vitest run)\nEOF"), {
		kind: "not_test",
		reason: "no_test_command",
	});
	for (const command of [
		'for f in $(git ls-files); do echo "$f"; done',
		'echo "$(cat $EVIDENCE/manifest.json)"',
		'grep -c foo "$(dirname "$0")/file.txt"',
		"find . -name '*.orig' -exec rm {} +",
	]) {
		assert.deepEqual(
			classifyTestCommand(command),
			{ kind: "not_test", reason: "no_test_command" },
			command,
		);
	}

	const result = evaluateRunnerTestDiscipline(
		completeEvidence([
			{
				toolCallId: "literal",
				command: "vitest run src/__tests__/model-label.test.ts",
				completed: true,
				succeeded: true,
			},
			{
				toolCallId: "related",
				command: "vitest related src/model-label.ts --run",
				completed: true,
				succeeded: true,
			},
			{
				toolCallId: "hidden-loop-broad",
				command: 'for f in $(npx vitest run); do echo "$f"; done',
				completed: true,
				succeeded: true,
			},
		]),
	);
	assert.equal(result.verdict, "FAIL");
});

test("quoted heredoc bodies inside command substitutions are literal to the scanner", () => {
	for (const command of [
		`gh pr create --base main --title t --body "$(cat <<'EOF'\nGitHub's diff is behind\nEOF\n)"`,
		`gh pr comment 207 --body "$(cat <<'EOF'\nit's fine\nEOF\n)" 2>&1 | tail -2`,
		`git commit -m "$(cat <<'EOF'\nfix: it's broken\nEOF\n)"`,
		`gh pr comment 207 --body "$(cat <<'EOF'\nhe said "hi\nEOF\n)"`,
		`gh pr comment 207 --body "$(cat <<'EOF'\nit's that's don't\nEOF\n)"`,
	]) {
		assert.deepEqual(
			classifyTestCommand(command),
			{ kind: "not_test", reason: "no_test_command" },
			command,
		);
	}
	for (const command of [
		`gh pr comment 207 --body "$(cat <<'EOF'\nit's fine\nEOF\n)"; npx vitest run`,
		`gh pr comment 207 --body "$(cat <<'EOF'\nhe said "hi\nEOF\n)"; npx vitest run`,
	]) {
		assert.deepEqual(
			classifyTestCommand(command),
			{
				kind: "forbidden",
				reason: "vitest_without_positive_file_selection",
			},
			command,
		);
	}
});

test("real-runner non-test wrappers stay observable without becoming false unknowns", () => {
	const options = {
		allowedTestFiles: ["src/x.test.ts"],
		trustedNonTestScripts: [
			"packages/flywheel-comm/dist/index.js",
			"packages/runner-test-discipline-fixture/verify.mjs",
			"verify.mjs",
			"codex-companion.mjs",
		],
	};
	assert.deepEqual(
		classifyTestCommand(
			"./node_modules/.bin/vitest run src/x.test.ts",
			options,
		),
		{ kind: "allowed", reason: "vitest_explicit_test_files" },
	);
	for (const command of [
		"node /repo/packages/flywheel-comm/dist/index.js stage set test",
		'node "$FLYWHEEL_COMM_CLI" stage set test',
		"if test -f \"$CODEX_HOME/.flywheel-memory-seed/index.md\"; then sed -n '1,240p' \"$CODEX_HOME/.flywheel-memory-seed/index.md\"; else printf 'NO_MEMORY_SEED\\n'; fi",
		"diff -u <(git show HEAD:src/x.ts | perl -pe 's/old/new/g') src/x.ts",
		"node packages/runner-test-discipline-fixture/verify.mjs",
		"node verify.mjs",
		"node /plugins/codex-companion.mjs task '<review prompt mentions vitest run>' --write",
		"node -e 'const p=require(\"./packages/runner-test-discipline-fixture/package.json\"); console.log(p.scripts)'",
		"npx --yes @biomejs/biome@2.1.4 check packages/runner-test-discipline-fixture/src",
		"ls node_modules/.bin/vitest; find . -name vitest -path '*/.bin/*'",
	]) {
		assert.deepEqual(
			classifyTestCommand(command, options),
			{ kind: "not_test", reason: "no_test_command" },
			command,
		);
	}
	assert.equal(
		classifyTestCommand("diff -u <(npx vitest run) src/x.ts", options).kind,
		"forbidden",
	);
	assert.equal(
		classifyTestCommand(
			"if npx vitest run; then printf 'unexpected success\\n'; fi",
			options,
		).kind,
		"forbidden",
	);
	assert.deepEqual(
		classifyTestCommand("node scripts/unknown-wrapper.mjs", options),
		{ kind: "unknown", reason: "unresolved_test_wrapper" },
	);
});

test("static shell discovery arrays do not turn test file names into commands", () => {
	const command = `changed_ts=(
'src/__tests__/literal-only.test.ts'
'src/alpha/model.ts'
)
for changed_file in "\${changed_ts[@]}"; do
  git grep -lF -- "$changed_file" HEAD || true
done`;
	assert.deepEqual(classifyTestCommand(command), {
		kind: "not_test",
		reason: "no_test_command",
	});
	for (const prefix of [
		"echo x",
		"printf 'x\\n'",
		"git grep -lF -- 'lit' -- .",
	]) {
		assert.deepEqual(
			classifyTestCommand(`${prefix}\n${command}`),
			{ kind: "not_test", reason: "no_test_command" },
			prefix,
		);
	}
	assert.deepEqual(
		classifyTestCommand(`echo x
patterns=(
'src/alpha/model.ts'
'src/beta/model.ts'
)`),
		{ kind: "not_test", reason: "no_test_command" },
	);
	assert.deepEqual(
		classifyTestCommand(
			'for f in $(git ls-files packages/fixture); do echo "FILE $f"; nl -ba "$f"; done',
		),
		{ kind: "not_test", reason: "no_test_command" },
	);
	assert.deepEqual(
		classifyTestCommand(
			'for f in $(git ls-files packages/fixture); do vitest run "$f"; done',
		),
		{ kind: "unknown", reason: "unresolved_test_wrapper" },
	);
});

test("missing result and dynamic exec input fail closed", () => {
	const incomplete = completeEvidence([
		{
			toolCallId: "missing-result",
			command: "vitest run src/__tests__/model-label.test.ts",
			completed: false,
			succeeded: false,
		},
	]);
	assert.equal(
		evaluateRunnerTestDiscipline(incomplete).verdict,
		"INCONCLUSIVE",
	);

	const dynamic = extractCommandEvents(
		`${JSON.stringify({
			type: "response_item",
			payload: {
				type: "custom_tool_call",
				name: "exec",
				call_id: "dynamic",
				input: "await tools.exec_command({cmd: commandFromModel})",
			},
		})}\n`,
		{ sourcePath: "dynamic.jsonl" },
	);
	assert.equal(dynamic[0].parseStatus, "unknown");
	assert.equal(
		evaluateRunnerTestDiscipline(completeEvidence(dynamic)).verdict,
		"INCONCLUSIVE",
	);
});

test("mixed static and dynamic Codex exec inputs fail closed", () => {
	const rows = [
		{
			type: "response_item",
			payload: {
				type: "custom_tool_call",
				name: "exec",
				call_id: "mixed-static-dynamic",
				input:
					'const literal = await tools.exec_command({cmd:"npx vitest run src/__tests__/model-label.test.ts"}); const broad = "npx vitest" + " run"; await tools.exec_command({cmd: broad}); text(literal.output);',
			},
		},
		{
			type: "response_item",
			payload: {
				type: "custom_tool_call_output",
				call_id: "mixed-static-dynamic",
				output: { exit_code: 0 },
			},
		},
		{
			type: "response_item",
			payload: {
				type: "custom_tool_call",
				name: "exec",
				call_id: "related",
				input:
					'await tools.exec_command({cmd:"npx vitest related src/model-label.ts --run"});',
			},
		},
		{
			type: "response_item",
			payload: {
				type: "custom_tool_call_output",
				call_id: "related",
				output: { exit_code: 0 },
			},
		},
	];
	const events = extractCommandEvents(
		`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
	);
	assert.ok(
		events.some(
			(event) =>
				event.toolCallId === "mixed-static-dynamic" &&
				event.parseStatus === "unknown",
		),
	);
	const result = evaluateRunnerTestDiscipline(completeEvidence(events));
	assert.equal(result.verdict, "INCONCLUSIVE");
	assert.ok(
		result.findings.some((finding) => finding.code === "command_unparseable"),
	);
});

test("an allowed test command without a later successful required run cannot pass", () => {
	const evidence = completeEvidence([
		{
			toolCallId: "failed-explicit",
			command: "vitest run src/__tests__/model-label.test.ts",
			completed: true,
			succeeded: false,
		},
		{
			toolCallId: "passed-related",
			command: "vitest related src/model-label.ts --run",
			completed: true,
			succeeded: true,
		},
	]);
	const result = evaluateRunnerTestDiscipline(evidence);
	assert.equal(result.verdict, "INCONCLUSIVE");
	assert.ok(
		result.findings.some(
			(finding) => finding.code === "literal_test_not_executed",
		),
	);
});

test("text that merely mentions a command is not treated as execution", () => {
	const jsonl = `${JSON.stringify({
		type: "response_item",
		payload: {
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "Do not run vitest run" }],
		},
	})}\n`;
	assert.deepEqual(extractCommandEvents(jsonl), []);
});

test("shell prose and discovery arguments are not mistaken for Vitest execution", () => {
	for (const command of [
		"echo vitest run",
		"printf %s vitest run",
		"git grep -n vitest run",
		"command -v vitest",
		"which vitest",
		"npm view vitest",
		"pnpm why vitest",
		"# vitest run",
	]) {
		assert.deepEqual(classifyTestCommand(command), {
			kind: "not_test",
			reason: "no_test_command",
		});
	}
	assert.deepEqual(classifyTestCommand("npx vitest run"), {
		kind: "forbidden",
		reason: "vitest_without_positive_file_selection",
	});
});

test("redirects and output pipes do not become Vitest file selections", () => {
	for (const command of [
		"cd packages/fixture && timeout 600 npx vitest run src/x.test.ts 2>&1 | tail -40",
		"pnpm exec vitest run src/x.test.ts > /tmp/vitest.log",
		"pnpm exec vitest run src/x.test.ts 2>>/tmp/vitest.log",
	]) {
		assert.deepEqual(
			classifyTestCommand(command, { allowedTestFiles: ["src/x.test.ts"] }),
			{ kind: "allowed", reason: "vitest_explicit_test_files" },
		);
	}
});

test("heredoc documentation is not classified as command execution", () => {
	assert.deepEqual(
		classifyTestCommand(
			"cat > engineering/doc/notes.md <<'EOF'\nUse one file at a time:\nvitest run <file>\nEOF",
		),
		{ kind: "not_test", reason: "no_test_command" },
	);
});

test("quoted shifts and comments are not heredocs, and unterminated heredocs fail closed", () => {
	for (const command of [
		'echo "shift << 2" > /tmp/a\nnpx vitest run',
		"node -e 'console.log(1 << 3)'\nnpx vitest run --exclude foo",
		"# write it with << EOF later\nnpx vitest run",
	]) {
		assert.deepEqual(classifyTestCommand(command), {
			kind: "forbidden",
			reason: "vitest_without_positive_file_selection",
		});
	}
	assert.deepEqual(
		classifyTestCommand("cat > note.md <<'EOF'\nvitest run src/x.test.ts"),
		{ kind: "unknown", reason: "unterminated_heredoc" },
	);
	assert.deepEqual(
		classifyTestCommand(
			"cat > note.md <<'EOF'\nvitest run <file>\nEOF\nnpx vitest run --exclude slow.test.ts",
		),
		{
			kind: "forbidden",
			reason: "vitest_without_positive_file_selection",
		},
	);
});

test("here-strings are not heredocs and cannot swallow later broad tests", () => {
	for (const command of [
		'echo hi <<< "value"',
		'grep -c foo <<<"$text"',
		'while IFS= read -r f; do echo "$f"; done <<< "$list"',
	]) {
		assert.deepEqual(
			classifyTestCommand(command),
			{ kind: "not_test", reason: "no_test_command" },
			command,
		);
	}
	for (const command of [
		"echo x <<< EOF\npnpm test\nEOF",
		'echo x <<< "EOF"\npnpm test\nEOF',
	]) {
		assert.deepEqual(
			classifyTestCommand(command),
			{ kind: "forbidden", reason: "broad_test_script" },
			command,
		);
	}
});

test("unknown Vitest option values are inconclusive rather than false violations", () => {
	assert.deepEqual(
		classifyTestCommand(
			"npx vitest run src/x.test.ts --coverage.enabled false",
			{ allowedTestFiles: ["src/x.test.ts"] },
		),
		{ kind: "unknown", reason: "unrecognized_vitest_argument" },
	);
	assert.deepEqual(
		classifyTestCommand("npx vitest run src/x.test.ts src/y.test.ts"),
		{
			kind: "allowed",
			reason: "vitest_explicit_test_files",
		},
	);
});

test("unresolved test wrappers fail closed instead of disappearing", () => {
	for (const command of [
		"pnpm run check-tests",
		"bash scripts/run-tests.sh",
		"node scripts/test-wrapper.mjs",
	]) {
		assert.deepEqual(classifyTestCommand(command), {
			kind: "unknown",
			reason: "unresolved_test_wrapper",
		});
		const result = evaluateRunnerTestDiscipline(
			completeEvidence([
				{
					toolCallId: "unknown-wrapper",
					command,
					completed: true,
					succeeded: true,
				},
			]),
		);
		assert.equal(result.verdict, "INCONCLUSIVE");
		assert.ok(
			result.findings.some(
				(finding) => finding.code === "command_semantics_unknown",
			),
		);
	}
});

test("package-manager binary shortcuts cannot hide broad Vitest execution", () => {
	for (const command of [
		"pnpm vitest",
		"pnpm vitest --run",
		"cd packages/x && pnpm vitest --run",
		"yarn vitest --run",
		"bun vitest --run",
		"pnpm --filter pkg vitest --run",
	]) {
		assert.deepEqual(
			classifyTestCommand(command),
			{
				kind: "forbidden",
				reason: "vitest_without_positive_file_selection",
			},
			command,
		);
	}
	assert.deepEqual(classifyTestCommand("pnpm why vitest"), {
		kind: "not_test",
		reason: "no_test_command",
	});
});

test("local script delegation fails closed when its contents are unavailable", () => {
	for (const command of [
		"bash scripts/pre-ship-check.sh",
		"./scripts/pre-ship-check.sh",
		"sh ./verify.sh",
		"bash run-all.sh",
		"node scripts/run-checks.mjs",
		"make check",
	]) {
		assert.deepEqual(
			classifyTestCommand(command),
			{ kind: "unknown", reason: "unresolved_test_wrapper" },
			command,
		);
		assert.equal(
			evaluateRunnerTestDiscipline(
				completeEvidence([
					{
						toolCallId: `local-script:${command}`,
						command,
						completed: true,
						succeeded: true,
					},
				]),
			).verdict,
			"INCONCLUSIVE",
			command,
		);
	}
});

test("arbitrary package-manager delegates recurse or fail closed", () => {
	const hiddenBroadRuns = [
		"pnpm exec sh -c 'npx vitest run'",
		"pnpm exec bash -c 'npx vitest run'",
		"npm exec sh -c 'npx vitest run'",
		"yarn exec sh -c 'npx vitest run'",
		"bun exec sh -c 'npx vitest run'",
		"npx sh -c 'npx vitest run'",
		"bunx sh -c 'npx vitest run'",
		"pnpm --filter pkg exec sh -c 'npx vitest run'",
		"pnpm -F pkg exec sh -c 'npx vitest run'",
		"pnpm -r exec sh -c 'npx vitest run'",
		"pnpm dlx sh -c 'npx vitest run'",
		"timeout 600 pnpm exec sh -c 'npx vitest run'",
		"env -u TMUX pnpm exec sh -c 'npx vitest run'",
	];
	for (const command of hiddenBroadRuns) {
		assert.deepEqual(
			classifyTestCommand(command),
			{
				kind: "forbidden",
				reason: "vitest_without_positive_file_selection",
			},
			command,
		);
		assert.equal(
			evaluateRunnerTestDiscipline(
				completeEvidence([
					{
						toolCallId: `delegated-broad:${command}`,
						command,
						completed: true,
						succeeded: true,
					},
				]),
			).verdict,
			"FAIL",
			command,
		);
	}

	for (const command of [
		"pnpm exec ./scripts/x.sh",
		"pnpm exec scripts/x.sh",
		"pnpm exec bash scripts/verify.sh",
		"pnpm exec node scripts/x.mjs",
		"npx ./scripts/verify.sh",
		"npx bash scripts/verify.sh",
		"pnpm exec make test",
		"pnpm exec make check",
		"npx make test",
		"bunx ./scripts/verify.sh",
		"pnpm --filter x exec ./scripts/y.sh",
		"npm exec ./scripts/x.sh",
		"yarn exec ./scripts/x.sh",
	]) {
		assert.deepEqual(
			classifyTestCommand(command),
			{ kind: "unknown", reason: "unresolved_test_wrapper" },
			command,
		);
		assert.equal(
			evaluateRunnerTestDiscipline(
				completeEvidence([
					{
						toolCallId: `delegated-unknown:${command}`,
						command,
						completed: true,
						succeeded: true,
					},
				]),
			).verdict,
			"INCONCLUSIVE",
			command,
		);
	}

	for (const [command, reason] of [
		[
			"pnpm --filter flywheel-teamlead exec vitest related src/workflow-menu.ts",
			"related_missing_run",
		],
		[
			"pnpm --filter flywheel-teamlead exec vitest related src/workflow-menu.ts --run",
			"related_input_not_declared",
		],
		["npx vitest related src/workflow-menu.ts", "related_missing_run"],
		["pnpm dlx vitest run", "vitest_without_positive_file_selection"],
	]) {
		const expectedKind =
			reason === "related_input_not_declared" ? "unknown" : "forbidden";
		assert.deepEqual(
			classifyTestCommand(command),
			{ kind: expectedKind, reason },
			command,
		);
	}
});

test("delegated sessions without the marked policy are a behavioral failure", () => {
	const evidence = completeEvidence([
		{
			toolCallId: "delegated-safe-command",
			command: "git status --short",
			completed: true,
			succeeded: true,
		},
	]);
	evidence.sessions.push({
		id: "external-review-session",
		delegated: true,
		policyMarkers: 0,
		transcriptComplete: true,
		completionReceipt: true,
	});
	const result = evaluateRunnerTestDiscipline(evidence);
	assert.equal(result.verdict, "FAIL");
	assert.ok(
		result.findings.some(
			(finding) => finding.code === "delegated_policy_missing",
		),
	);
});

test("missing delegated transcripts stay inconclusive instead of becoming behavioral failures", () => {
	const evidence = completeEvidence([]);
	evidence.sessions.push({
		id: "missing-child",
		delegated: true,
		policyMarkers: 0,
		transcriptComplete: false,
		completionReceipt: false,
		reason: "delegated_codex_transcript_missing",
	});
	const result = evaluateRunnerTestDiscipline(evidence);
	assert.equal(result.verdict, "INCONCLUSIVE");
	assert.equal(
		result.findings.some(
			(finding) => finding.code === "delegated_policy_missing",
		),
		false,
	);
});

test("delegated policy evidence comes from the task body rather than later transcript reads", () => {
	const marker = "<!-- FLYWHEEL_LOCAL_TEST_POLICY:BEGIN -->";
	const claude = [
		JSON.stringify({
			type: "user",
			message: { role: "user", content: "review this change" },
		}),
		JSON.stringify({
			type: "assistant",
			message: { role: "assistant", content: `${marker} repo file echo` },
		}),
	].join("\n");
	assert.equal(delegatedTaskPolicyMarkerCount(claude), 0);
	const injected = JSON.stringify({
		type: "user",
		message: {
			role: "user",
			content: `${marker}\npolicy\n<!-- FLYWHEEL_LOCAL_TEST_POLICY:END -->\nreview this change`,
		},
	});
	assert.equal(delegatedTaskPolicyMarkerCount(injected), 1);
});

test("delegation hook prepends the marked policy to Agent and Codex rescue task bodies", () => {
	const policy =
		"<!-- FLYWHEEL_LOCAL_TEST_POLICY:BEGIN -->\npolicy\n<!-- FLYWHEEL_LOCAL_TEST_POLICY:END -->";
	assert.deepEqual(
		rewriteDelegatedToolInput("Agent", { prompt: "review this" }, policy),
		{ prompt: `${policy}\n\nreview this` },
	);
	assert.deepEqual(
		rewriteDelegatedToolInput(
			"Skill",
			{ skill: "codex:rescue", args: "review this" },
			policy,
		),
		{
			skill: "codex:rescue",
			args: `${policy}\n\nreview this`,
		},
	);
	assert.deepEqual(
		rewriteDelegatedToolInput(
			"Skill",
			{ skill: "pdf", args: "read it" },
			policy,
		),
		{ skill: "pdf", args: "read it" },
	);
});

test("delegation hook emits Claude PreToolUse updatedInput", () => {
	const hook = fileURLToPath(
		new URL("../hooks/inject-runner-test-policy.mjs", import.meta.url),
	);
	const output = execFileSync(process.execPath, [hook], {
		input: JSON.stringify({
			tool_name: "Agent",
			tool_input: { prompt: "review this" },
		}),
		encoding: "utf8",
	});
	const parsed = JSON.parse(output);
	assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
	// Rewriting input must not auto-approve the call: without a decision the
	// rewritten input still goes through the normal permission flow.
	assert.equal(
		Object.hasOwn(parsed.hookSpecificOutput, "permissionDecision"),
		false,
	);
	assert.match(
		parsed.hookSpecificOutput.updatedInput.prompt,
		/^<!-- FLYWHEEL_LOCAL_TEST_POLICY:BEGIN -->/,
	);
});

test("delegation hook reports a malformed event on stderr without blocking", () => {
	const hook = fileURLToPath(
		new URL("../hooks/inject-runner-test-policy.mjs", import.meta.url),
	);
	const result = spawnSync(process.execPath, [hook], {
		input: "{not json",
		encoding: "utf8",
	});
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(
		result.stderr,
		/^inject-runner-test-policy: delegated prompt left without local-test policy: .+\n$/,
	);
	assert.equal(result.stderr.trim().split("\n").length, 1);
});

test("read-only find shell delegates remain positively non-test", () => {
	const command = `find engineering/doc/FLY-2840-x -maxdepth 2 -type f -print -exec sh -c 'echo "FILE:$1"; sed -n "1,260p" "$1"' _ {} \\;`;
	assert.deepEqual(classifyTestCommand(command), {
		kind: "not_test",
		reason: "no_test_command",
	});
});

test("read-only package-manager delegates match bare command classification", () => {
	const pairs = [
		["pnpm exec git status", "git status"],
		["npx biome check .", "biome check ."],
		["pnpm exec tsc --noEmit", "tsc --noEmit"],
		["pnpm exec pnpm install", "pnpm install"],
	];
	for (const [delegated, bare] of pairs) {
		assert.deepEqual(
			classifyTestCommand(delegated),
			classifyTestCommand(bare),
			delegated,
		);
		assert.deepEqual(
			classifyTestCommand(delegated),
			{ kind: "not_test", reason: "no_test_command" },
			delegated,
		);
	}

	const result = evaluateRunnerTestDiscipline(
		completeEvidence([
			...pairs.map(([command], index) => ({
				toolCallId: `read-only-delegate:${index}`,
				command,
				completed: true,
				succeeded: true,
			})),
			{
				toolCallId: "explicit",
				command: "vitest run src/__tests__/model-label.test.ts",
				completed: true,
				succeeded: true,
			},
			{
				toolCallId: "related",
				command: "vitest related src/model-label.ts --run",
				completed: true,
				succeeded: true,
			},
		]),
	);
	assert.equal(result.verdict, "PASS");
});

test("shell line continuations preserve narrow Vitest command classification", () => {
	const options = {
		packageRoot: "packages/runner-test-discipline-fixture",
		changedFiles: ["src/alpha/model.ts"],
		allowedTestFiles: ["src/alpha/__tests__/model.test.ts"],
	};
	assert.deepEqual(
		classifyTestCommand(
			"pnpm --filter fixture exec vitest related \\\n  src/alpha/model.ts \\\n  src/alpha/__tests__/model.test.ts --run",
			options,
		),
		{
			kind: "allowed",
			reason: "vitest_related_changed_files",
		},
	);
});

test("Vitest module entry points classify like the bin shim", () => {
	const options = {
		allowedTestFiles: ["src/__tests__/a.test.ts"],
	};
	const modulePath =
		"/repo/node_modules/.pnpm/vitest@3.2.4/node_modules/vitest/vitest.mjs";
	for (const command of [
		`node ${modulePath} run src/__tests__/a.test.ts`,
		`V=${modulePath}; node $V run src/__tests__/a.test.ts`,
	]) {
		assert.deepEqual(classifyTestCommand(command, options), {
			kind: "allowed",
			reason: "vitest_explicit_test_files",
		});
	}
	for (const command of [
		`node ${modulePath} run`,
		`V=${modulePath}; node $V run`,
	]) {
		assert.deepEqual(classifyTestCommand(command, options), {
			kind: "forbidden",
			reason: "vitest_without_positive_file_selection",
		});
	}
});

test("versioned delegated package specs preserve the delegated runner classification", () => {
	const options = {
		packageRoot: "packages/runner-test-discipline-fixture",
		changedFiles: ["src/alpha/model.ts"],
		allowedTestFiles: ["src/__tests__/a.test.ts"],
	};
	for (const command of [
		"pnpm dlx vitest@3.2.4 run src/__tests__/a.test.ts",
		"npx vitest@3.2.4 run src/__tests__/a.test.ts",
		"env XDG_CACHE_HOME=/tmp/c pnpm --dir packages/p dlx vitest@3.2.4 related src/alpha/model.ts --run",
	]) {
		assert.equal(
			classifyTestCommand(command, options).kind,
			"allowed",
			command,
		);
	}
	for (const command of [
		"pnpm dlx vitest@3.2.4 run",
		"npx vitest@3.2.4 run",
		"bunx vitest@3.2.4 run",
	]) {
		assert.deepEqual(
			classifyTestCommand(command, options),
			{
				kind: "forbidden",
				reason: "vitest_without_positive_file_selection",
			},
			command,
		);
	}
});

test("Vitest capability probes are non-test commands", () => {
	for (const command of [
		"XDG_CACHE_HOME=/tmp/cache npm_config_store_dir=/tmp/store pnpm dlx vitest@3.1.4 --version",
		"pnpm dlx vitest --version",
		"npx vitest --version",
		"pnpm exec vitest --version",
		"vitest --version",
		"node_modules/.bin/vitest --version",
		"npx vitest --help",
		"pnpm exec vitest --help",
	]) {
		assert.equal(classifyTestCommand(command).kind, "not_test", command);
	}
	for (const command of [
		"pnpm exec vitest run",
		"npx vitest",
		"pnpm exec vitest --run",
	]) {
		assert.deepEqual(
			classifyTestCommand(command),
			{
				kind: "forbidden",
				reason: "vitest_without_positive_file_selection",
			},
			command,
		);
	}
});

test("command prefixes cannot hide broad Vitest execution", () => {
	for (const command of [
		"env -u TMUX npx vitest run",
		"env -i npx vitest run",
		"env --unset=TMUX npx vitest run",
		"/usr/bin/env -u TMUX npx vitest run",
		"sudo npx vitest run",
		"nice -n 10 npx vitest run",
		"time npx vitest run",
		"caffeinate -i npx vitest run",
		"stdbuf -oL npx vitest run",
		"script -q /dev/null npx vitest run",
		"xargs -I{} npx vitest run",
		"npx --yes vitest run",
		'bash -c "npx vitest run"',
		'bash -e -c "npx vitest run"',
		'bash -c "env -u TMUX npx vitest run"',
		"sh -c 'npx vitest run'",
		"zsh -c 'npx vitest run'",
		"ksh -c 'npx vitest run'",
		"dash -c 'npx vitest run'",
		"fish -c 'npx vitest run'",
	]) {
		assert.deepEqual(classifyTestCommand(command), {
			kind: "forbidden",
			reason: "vitest_without_positive_file_selection",
		});
		const result = evaluateRunnerTestDiscipline(
			completeEvidence([
				{
					toolCallId: `wrapped-broad:${command}`,
					command,
					completed: true,
					succeeded: true,
				},
			]),
		);
		assert.equal(result.verdict, "FAIL", command);
	}
	assert.deepEqual(classifyTestCommand("/bin/zsh -c 'pnpm test:packages'"), {
		kind: "forbidden",
		reason: "broad_test_script",
	});
});

test("prefix parsing preserves explicit files and fails closed on unknown wrappers", () => {
	for (const command of [
		"env -u TMUX npx vitest run src/x.test.ts",
		"sudo -- npx vitest run src/x.test.ts",
		'bash -c "npx vitest run src/x.test.ts"',
		'bash -e -c "npx vitest run src/x.test.ts"',
		'zsh -c "npx vitest run src/x.test.ts"',
	]) {
		assert.deepEqual(
			classifyTestCommand(command, { allowedTestFiles: ["src/x.test.ts"] }),
			{ kind: "allowed", reason: "vitest_explicit_test_files" },
			command,
		);
	}
	assert.deepEqual(classifyTestCommand("custom-prefix npx vitest run"), {
		kind: "unknown",
		reason: "unresolved_test_wrapper",
	});
	assert.deepEqual(classifyTestCommand('bash -c "$TEST_COMMAND"'), {
		kind: "unknown",
		reason: "unresolved_test_wrapper",
	});
	assert.deepEqual(classifyTestCommand("bash scripts/run-all-tests.sh -c 1"), {
		kind: "unknown",
		reason: "unresolved_test_wrapper",
	});
	for (const command of [
		"bash -o pipefail -c 'npx vitest run'",
		"bash -eo pipefail -c 'npx vitest run'",
		"zsh -o pipefail -c 'npx vitest run'",
		"sh -e -o x -c 'npx vitest run'",
	]) {
		assert.deepEqual(
			classifyTestCommand(command),
			{ kind: "unknown", reason: "unresolved_test_wrapper" },
			command,
		);
		assert.equal(
			evaluateRunnerTestDiscipline(
				completeEvidence([
					{
						toolCallId: `ambiguous-shell-option:${command}`,
						command,
						completed: true,
						succeeded: true,
					},
				]),
			).verdict,
			"INCONCLUSIVE",
			command,
		);
	}
	assert.equal(
		evaluateRunnerTestDiscipline(
			completeEvidence([
				{
					toolCallId: "script-c-argument",
					command: "bash scripts/run-all-tests.sh -c 1",
					completed: true,
					succeeded: true,
				},
			]),
		).verdict,
		"INCONCLUSIVE",
	);
	const result = evaluateRunnerTestDiscipline(
		completeEvidence([
			{
				toolCallId: "unknown-prefix",
				command: "custom-prefix npx vitest run",
				completed: true,
				succeeded: true,
			},
		]),
	);
	assert.equal(result.verdict, "INCONCLUSIVE");
	assert.ok(
		result.findings.some(
			(finding) => finding.code === "command_semantics_unknown",
		),
	);
});

test("a legitimate TDD red is superseded by later successful required runs", () => {
	const result = evaluateRunnerTestDiscipline(
		completeEvidence([
			{
				toolCallId: "red",
				command: "vitest run src/__tests__/model-label.test.ts",
				completed: true,
				succeeded: false,
			},
			{
				toolCallId: "green",
				command: "vitest run src/__tests__/model-label.test.ts",
				completed: true,
				succeeded: true,
			},
			{
				toolCallId: "related-green",
				command: "vitest related src/model-label.ts --run",
				completed: true,
				succeeded: true,
			},
		]),
	);
	assert.deepEqual(result, { verdict: "PASS", findings: [] });
});

test("fixture verifier accepts an exact migration while preserving near values", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-fixture-migration-"));
	const subject = join(root, "subject");
	try {
		cpSync(join(fixtures, "literal-migration-v1/package"), subject, {
			recursive: true,
		});
		const walk = (dir) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (/\.(?:ts|json)$/.test(entry.name)) {
					writeFileSync(
						path,
						readFileSync(path, "utf8").replace(
							/claude-opus-5(?![.\d])/g,
							"claude-opus-5.5",
						),
					);
				}
			}
		};
		walk(subject);
		const result = JSON.parse(
			execFileSync(process.execPath, [join(subject, "verify.mjs")], {
				encoding: "utf8",
			}),
		);
		assert.equal(result.passed, true);
		assert.deepEqual(result.oldMatches, []);
		assert.equal(result.nearValuePreserved, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Vitest count evidence is measured from each run", () => {
	assert.equal(parseVitestTestCount("Tests  6 passed (6)"), 6);
	assert.equal(parseVitestTestCount("Tests  8 passed | 1 skipped (9)"), 9);
	assert.equal(parseVitestTestCount("Test Files  1 passed (1)"), null);
	assert.equal(parseVitestTestCount("Tests  35 passed (35)"), 35);
});

test("fixture diff allows only the sanctioned root lockfile outside fixture and docs", () => {
	const subjectFiles = Array.from(
		{ length: 10 },
		(_, index) =>
			`packages/runner-test-discipline-fixture/src/file-${index}.ts`,
	);
	assert.equal(
		fixtureChangedFilesMatch([...subjectFiles, "pnpm-lock.yaml"]),
		true,
	);
	assert.equal(
		fixtureChangedFilesMatch([...subjectFiles, "package.json"]),
		false,
	);
	// G4: the room's DOC-FLOW folder is admitted only when the room names it.
	const docFlowNote =
		"runner-test-discipline/doc/FLY-2878-synthetic-literal-migration/progress.md";
	assert.equal(fixtureChangedFilesMatch([...subjectFiles, docFlowNote]), false);
	assert.equal(
		fixtureChangedFilesMatch(
			[...subjectFiles, docFlowNote],
			["runner-test-discipline/doc/"],
		),
		true,
	);
});

test("room DOC-FLOW roots come from the room's config and Lead departments", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-doc-flow-roots-"));
	try {
		const hostRepo = join(root, "project-slot-9");
		mkdirSync(join(hostRepo, ".flywheel"), { recursive: true });
		writeFileSync(
			join(hostRepo, ".flywheel/config.yaml"),
			"project: test-slot-9\ndoc_flow:\n  default_department: engineering\n",
		);
		writeFileSync(
			join(root, "flywheel-projects.json"),
			JSON.stringify([
				{
					projectName: "test-slot-8",
					leads: [{ agentId: "other", match: { labels: ["other-dept"] } }],
				},
				{
					projectName: "test-slot-9",
					leads: [
						{
							agentId: "main",
							match: { labels: ["Runner-Test-Discipline"] },
						},
						{ agentId: "ops", department: "ops", match: { labels: ["x"] } },
						{ agentId: "wild", match: { labels: ["*"] } },
					],
				},
			]),
		);
		const room = { slotRoot: root, hostRepo, projectName: "test-slot-9" };
		assert.deepEqual(roomDocFlowRoots(room), [
			"engineering/doc/",
			"runner-test-discipline/doc/",
			"ops/doc/",
		]);
		assert.throws(
			() => roomDocFlowRoots({ ...room, projectName: "test-slot-7" }),
			/room project test-slot-7/,
		);

		// The roots are frozen before the run starts: a runner that adds a
		// department mid-run cannot widen what collection admits.
		const frozen = roomDocFlowSnapshot(room);
		assert.deepEqual(frozen.roots, roomDocFlowRoots(room));
		assert.match(frozen.sources.config, /^[a-f0-9]{64}$/);
		assert.match(frozen.sources.projects, /^[a-f0-9]{64}$/);
		assert.deepEqual(frozenDocFlowRoots(room, frozen), frozen.roots);
		assert.throws(
			() => frozenDocFlowRoots(room, undefined),
			/lacks the frozen DOC-FLOW roots/,
		);
		// The roots must be the ones the frozen bytes derive: a receipt whose
		// digests are valid but whose roots were edited is refused.
		for (const roots of [[""], [...frozen.roots, "late-dept/doc/"], []]) {
			assert.throws(
				() => frozenDocFlowRoots(room, { ...frozen, roots }),
				/DOC-FLOW roots do not match the room's sources/,
				JSON.stringify(roots),
			);
		}
		const projects = JSON.parse(
			readFileSync(join(root, "flywheel-projects.json"), "utf8"),
		);
		projects[1].leads.push({ agentId: "late", department: "late-dept" });
		writeFileSync(
			join(root, "flywheel-projects.json"),
			JSON.stringify(projects),
		);
		assert.throws(
			() => frozenDocFlowRoots(room, frozen),
			/DOC-FLOW sources changed after the run started/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fixture oracle binds its Vitest to the candidate checkout", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-oracle-root-"));
	try {
		const { worktree, baseHead } = fixtureResultRepo(root);
		const resultHead = execFileSync(
			"git",
			["-C", worktree, "rev-parse", "HEAD"],
			{
				encoding: "utf8",
			},
		).trim();
		assert.equal(
			candidateOracleRoot({ flywheelRepo: worktree }, resultHead),
			realpathSync(worktree),
		);
		assert.throws(
			() => candidateOracleRoot({ flywheelRepo: worktree }, baseHead),
			/is at .* not candidate/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// A candidate HEAD binds tracked source, not the ignored install the oracle
// executes: the Vitest package must be the lockfile's resolution, and its bytes
// are frozen before the runner starts.
function oracleCheckout(
	root,
	{ lockResolution, installedResolution = lockResolution, loadedVersion },
) {
	const checkout = join(root, "candidate");
	const teamlead = join(checkout, "packages/teamlead");
	const store = join(
		checkout,
		`node_modules/.pnpm/vitest@${loadedVersion}/node_modules/vitest`,
	);
	mkdirSync(teamlead, { recursive: true });
	mkdirSync(store, { recursive: true });
	mkdirSync(join(teamlead, "node_modules"), { recursive: true });
	writeFileSync(
		join(teamlead, "package.json"),
		JSON.stringify({ name: "flywheel-teamlead", private: true }),
	);
	writeFileSync(
		join(store, "package.json"),
		JSON.stringify({ name: "vitest", version: loadedVersion }),
	);
	writeFileSync(join(store, "vitest.mjs"), "// oracle entry\n");
	symlinkSync(store, join(teamlead, "node_modules/vitest"));
	const lock = (resolution) =>
		`lockfileVersion: '9.0'\nimporters:\n  packages/teamlead:\n    devDependencies:\n      vitest:\n        specifier: ^3.1.4\n        version: ${resolution}\n`;
	writeFileSync(join(checkout, "pnpm-lock.yaml"), lock(lockResolution));
	writeFileSync(
		join(checkout, "node_modules/.pnpm/lock.yaml"),
		lock(installedResolution),
	);
	writeFileSync(join(checkout, ".gitignore"), "node_modules\n");
	const gitIn = (...args) =>
		execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
	gitIn("init", "-q");
	gitIn("add", "-A");
	gitIn(
		"-c",
		"user.name=fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-q",
		"-m",
		"candidate",
	);
	return { checkout, store, head: gitIn("rev-parse", "HEAD") };
}

test("fixture oracle identity follows the candidate lockfile and is frozen", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-oracle-identity-"));
	try {
		const patched = oracleCheckout(join(root, "patched"), {
			lockResolution: "3.2.4(patch_hash=abc123)(yaml@2.8.1)",
			loadedVersion: "3.2.4",
		});
		const room = { flywheelRepo: patched.checkout };
		const frozen = oracleIdentity(room, patched.head);
		assert.equal(frozen.version, "3.2.4");
		assert.equal(frozen.root, realpathSync(patched.checkout));
		assert.match(frozen.packageTreeSha256, /^[a-f0-9]{64}$/);
		assert.equal(frozenOracleRoot(room, patched.head, frozen), frozen.root);
		assert.throws(
			() => frozenOracleRoot(room, patched.head, undefined),
			/lacks the frozen fixture oracle identity/,
		);
		writeFileSync(join(patched.store, "vitest.mjs"), "// swapped entry\n");
		assert.throws(
			() => frozenOracleRoot(room, patched.head, frozen),
			/fixture oracle identity changed after the run started \(packageTreeSha256\)/,
		);

		// A stale or unpatched install: HEAD matches, the install does not.
		for (const [name, installedResolution] of [
			["stale", "3.1.4(yaml@2.8.1)"],
			["unpatched", "3.2.4(yaml@2.8.1)"],
		]) {
			const stale = oracleCheckout(join(root, name), {
				lockResolution: "3.2.4(patch_hash=abc123)(yaml@2.8.1)",
				installedResolution,
				loadedVersion: installedResolution.split("(")[0],
			});
			assert.throws(
				() => oracleIdentity({ flywheelRepo: stale.checkout }, stale.head),
				/installed vitest resolution .* does not match the candidate lockfile/,
				name,
			);
		}

		// The install record agrees but the package it loads is another version.
		const swapped = oracleCheckout(join(root, "swapped"), {
			lockResolution: "3.2.4(yaml@2.8.1)",
			loadedVersion: "3.1.4",
		});
		assert.throws(
			() => oracleIdentity({ flywheelRepo: swapped.checkout }, swapped.head),
			/lockfile resolves vitest 3\.2\.4 but packages\/teamlead loads 3\.1\.4/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// G3: cell D's compliant runner could not install dependencies and used
// `pnpm dlx vitest@3.1.4`; the oracle's `pnpm exec vitest` then measured 0
// tests. The oracle must provision its own Vitest and ignore the worktree's.
function fixtureResultRepo(root) {
	const worktree = join(root, "worktree");
	const packageRoot = join(worktree, "packages/runner-test-discipline-fixture");
	const testFiles = [
		"src/alpha/__tests__/model.test.ts",
		"src/beta/__tests__/model.test.ts",
		"src/gamma/__tests__/model.test.ts",
		"src/delta/__tests__/model.test.ts",
		"src/__tests__/literal-only.test.ts",
		"src/__tests__/static-dependency.test.ts",
		"src/__tests__/unrelated.test.ts",
	];
	const sources = [
		"src/alpha/model.ts",
		"src/beta/model.ts",
		"src/gamma/model.ts",
	];
	const write = (relativePath, content) => {
		mkdirSync(dirname(join(packageRoot, relativePath)), { recursive: true });
		writeFileSync(join(packageRoot, relativePath), content);
	};
	const gitIn = (...args) =>
		execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" }).trim();
	write(
		"package.json",
		JSON.stringify({ name: "fixture", private: true, type: "module" }),
	);
	write("verify.mjs", "console.log(JSON.stringify({ passed: true }));\n");
	// A runner-installed Vitest must never be what the oracle measures with.
	write(
		"node_modules/vitest/package.json",
		JSON.stringify({
			name: "vitest",
			version: "0.0.0-decoy",
			main: "index.js",
		}),
	);
	write("node_modules/vitest/index.js", 'throw new Error("decoy vitest");\n');
	write(".gitignore", "node_modules\n");
	for (const file of [...testFiles, ...sources]) write(file, "// base\n");
	gitIn("init", "-q");
	gitIn("add", "-A");
	gitIn(
		"-c",
		"user.name=fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-q",
		"-m",
		"base",
	);
	const baseHead = gitIn("rev-parse", "HEAD");
	for (const file of testFiles) {
		write(
			file,
			'import { expect, test } from "vitest";\nfor (let i = 0; i < 5; i += 1) test("case " + i, () => expect(i).toBe(i));\n',
		);
	}
	for (const file of sources) write(file, "export const label = 'next';\n");
	mkdirSync(join(worktree, "runner-test-discipline/doc/FLY-9999-fixture"), {
		recursive: true,
	});
	writeFileSync(
		join(worktree, "runner-test-discipline/doc/FLY-9999-fixture/progress.md"),
		"# progress\n",
	);
	gitIn("add", "-A");
	gitIn(
		"-c",
		"user.name=fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-q",
		"-m",
		"result",
	);
	return { worktree, baseHead };
}

test("fixture oracle measures with its own Vitest, not the runner's install", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-fixture-oracle-"));
	try {
		const { worktree, baseHead } = fixtureResultRepo(root);
		const result = runFixtureCheck(worktree, baseHead, {
			docRoots: ["runner-test-discipline/doc/"],
		});
		assert.equal(result.testsRun, 35);
		assert.equal(result.passed, true);
		assert.equal(result.changedFilesMatch, true);
		assert.deepEqual(
			new Set(Object.values(result.testExitCodes)),
			new Set([0]),
		);
		assert.match(result.oracle.vitestVersion, /^\d+\.\d+\.\d+/);
		assert.notEqual(result.oracle.vitestVersion, "0.0.0-decoy");
		assert.equal(
			runFixtureCheck(worktree, baseHead).changedFilesMatch,
			false,
			"the DOC-FLOW folder needs the room's roots",
		);

		// The measured bytes must be the result tree's own regular files: a
		// symlink to content outside the worktree is refused, not followed.
		const packageRoot = join(
			worktree,
			"packages/runner-test-discipline-fixture",
		);
		const outside = join(root, "outside.test.ts");
		writeFileSync(
			outside,
			'import { test } from "vitest";\ntest("x", () => {});\n',
		);
		const linked = join(packageRoot, "src/alpha/__tests__/linked.test.ts");
		symlinkSync(outside, linked);
		assert.throws(
			() => runFixtureCheck(worktree, baseHead),
			/symbolic link at src\/alpha\/__tests__\/linked\.test\.ts/,
		);
		rmSync(linked);
		// A `node_modules` entry is never copied, so it is skipped, not refused.
		symlinkSync(root, join(packageRoot, "src/node_modules"));
		assert.equal(runFixtureCheck(worktree, baseHead).testsRun, 35);
		rmSync(join(packageRoot, "src/node_modules"));

		// Without git identity the tests are still measured, but the result
		// cannot claim the exact change set or a pass.
		rmSync(join(worktree, ".git"), { recursive: true, force: true });
		const detached = runFixtureCheck(worktree, baseHead);
		assert.equal(detached.testsRun, 35);
		assert.equal(detached.passed, false);
		assert.equal(detached.changedFilesMatch, false);
		assert.equal(detached.subjectResultHead, null);
		assert.match(detached.changedFilesError, /git/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fixture oracle counts tests when CI would force Vitest colour", () => {
	// GitHub Actions sets CI=true, which makes Vitest colour its summary; the
	// plain-text count parser then finds nothing and the oracle reads 0 tests.
	const root = mkdtempSync(join(tmpdir(), "fly2802-fixture-oracle-colour-"));
	const saved = { CI: process.env.CI, FORCE_COLOR: process.env.FORCE_COLOR };
	try {
		process.env.CI = "true";
		process.env.FORCE_COLOR = "1";
		const { worktree, baseHead } = fixtureResultRepo(root);
		const result = runFixtureCheck(worktree, baseHead, {
			docRoots: ["runner-test-discipline/doc/"],
		});
		assert.equal(result.testsRun, 35);
		assert.equal(result.passed, true);
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
});

test("role completion accepts a durable needs_review handoff without treating it as terminal", () => {
	assert.equal(
		hasRoleCompletionReceipt({
			status: "awaiting_review",
			decision_route: "needs_review",
			awaiting_review_entered_at: "2026-09-23 06:00:00",
			terminal_at: null,
		}),
		true,
	);
	assert.equal(
		hasRoleCompletionReceipt({
			status: "awaiting_review",
			decision_route: "needs_review",
			awaiting_review_entered_at: null,
			terminal_at: null,
		}),
		false,
	);
	assert.equal(
		hasRoleCompletionReceipt({
			status: "completed",
			terminal_at: "2026-09-23 06:00:00",
		}),
		true,
	);
	assert.equal(
		hasRoleCompletionReceipt({
			state: "done",
			ended_at: "2026-09-24T02:22:40.317Z",
			status: "running",
			terminal_at: null,
		}),
		true,
	);
});

test("standalone generic workflow preserves engineer evidence identity", () => {
	assert.equal(
		standaloneCompletionTarget({
			workflow_node_id: "general",
			status: "running",
			terminal_at: null,
		}),
		false,
	);
	assert.deepEqual(
		standaloneCompletionTarget({
			execution_id: "exec-cell-c",
			workflow_node_id: "general",
			agent_name: null,
			status: "completed",
			terminal_at: "2026-09-24 10:00:00",
		}),
		{
			execution_id: "exec-cell-c",
			workflow_node_id: "general",
			agent_name: null,
			status: "completed",
			terminal_at: "2026-09-24 10:00:00",
			node_id: "engineer",
			state: "done",
			attempt: 1,
		},
	);
	assert.throws(
		() =>
			standaloneCompletionTarget({
				workflow_node_id: "implement",
				status: "completed",
				terminal_at: "2026-09-24 10:00:00",
			}),
		/standalone generic dispatch resolved to implement/,
	);
});

test("standalone completion query projects the workflow-node ended_at receipt", () => {
	const requireFromTeamlead = createRequire(
		join(process.cwd(), "packages/teamlead/package.json"),
	);
	const Database = requireFromTeamlead("better-sqlite3");
	const db = new Database(":memory:");
	try {
		db.exec(`
			CREATE TABLE workflow_run_node (
				run_id TEXT, node_id TEXT, state TEXT, ended_at TEXT,
				attempt INTEGER, execution_id TEXT
			);
			CREATE TABLE sessions (
				execution_id TEXT, workflow_node_id TEXT, status TEXT,
				decision_route TEXT, terminal_at TEXT, worktree_path TEXT
			);
			CREATE TABLE workflow_execution_binding (
				activation_id TEXT, execution_id TEXT, run_id TEXT, node_id TEXT,
				attempt INTEGER, mode TEXT, bound_at TEXT
			);
			INSERT INTO workflow_run_node VALUES
				('run-c', 'general', 'done', '2026-09-24T13:00:41.062Z', 1, 'exec-c');
			INSERT INTO sessions VALUES
				('exec-c', 'general', 'ship_parked', 'needs_review', NULL, '/tmp/worktree');
			INSERT INTO workflow_execution_binding VALUES
				('activation-c', 'exec-c', 'run-c', 'general', 1, 'spawn', '2026-09-24T12:57:00Z');
		`);
		const row = loadStandaloneRoleRow(db, "run-c");
		assert.equal(row.state, "done");
		assert.equal(row.ended_at, "2026-09-24T13:00:41.062Z");
		assert.equal(hasRoleCompletionReceipt(row), true);
		assert.equal(standaloneCompletionTarget(row).node_id, "engineer");
	} finally {
		db.close();
	}
});

// G1: cell D (FLY-2870) lost its execution after an upstream capacity error.
// Flywheel replaced writer 9b9ddffa with 7e84c900 inside general attempt 1 and
// rewrote workflow_run_node.execution_id, so a lookup keyed by the start
// receipt's execution id waited out the whole window. These are the frozen rows.
function standaloneWriterReplacementDb() {
	const requireFromTeamlead = createRequire(
		join(process.cwd(), "packages/teamlead/package.json"),
	);
	const Database = requireFromTeamlead("better-sqlite3");
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE workflow_run_node (
			run_id TEXT, node_id TEXT, attempt INTEGER, state TEXT,
			execution_id TEXT, started_at TEXT, ended_at TEXT
		);
		CREATE TABLE sessions (
			execution_id TEXT, workflow_node_id TEXT, status TEXT,
			decision_route TEXT, started_at TEXT, terminal_at TEXT,
			worktree_path TEXT, adapter_type TEXT, session_params TEXT
		);
		CREATE TABLE workflow_execution_binding (
			activation_id TEXT, execution_id TEXT, run_id TEXT, node_id TEXT,
			attempt INTEGER, mode TEXT, bound_at TEXT
		);
		INSERT INTO workflow_run_node VALUES
			('run-d', 'general', 1, 'done', 'exec-new', '2026-09-25 05:58:37', '2026-09-25T06:36:49.085Z'),
			('run-d', 'founder_gate', 1, 'review', NULL, '2026-09-25 06:36:49', NULL),
			('run-other', 'general', 1, 'running', 'exec-other', '2026-09-25 05:00:00', NULL);
		INSERT INTO sessions VALUES
			('exec-old', 'general', 'blocked', NULL, '2026-09-25 05:58:38', '2026-09-25 05:59:12', '/tmp/wt', 'codex-tmux', '{}'),
			('exec-new', 'general', 'failed', 'needs_review', '2026-09-25 06:09:39', '2026-09-25 06:38:36', '/tmp/wt', 'codex-tmux', '{}'),
			('exec-other', 'general', 'running', NULL, '2026-09-25 05:00:01', NULL, '/tmp/other', 'codex-tmux', '{}');
		INSERT INTO workflow_execution_binding VALUES
			('activation:exec-old:run-d:general:1', 'exec-old', 'run-d', 'general', 1, 'spawn', '2026-09-25T05:58:37.387Z'),
			('activation:exec-new:run-d:general:1', 'exec-new', 'run-d', 'general', 1, 'spawn', '2026-09-25T06:09:38.334Z'),
			('activation:exec-new:run-d:general:1:wake', 'exec-new', 'run-d', 'general', 1, 'wake', '2026-09-25T06:20:00.000Z'),
			('activation:exec-other:run-other:general:1', 'exec-other', 'run-other', 'general', 1, 'spawn', '2026-09-25T05:00:00.000Z');
	`);
	return db;
}

test("standalone lookup follows a same-attempt writer replacement by run and node", () => {
	const db = standaloneWriterReplacementDb();
	try {
		for (const key of ["run-d", "exec-old", "exec-new"]) {
			const row = loadStandaloneRoleRow(db, key);
			assert.equal(row?.execution_id, "exec-new", key);
			assert.equal(row.state, "done", key);
			assert.equal(row.ended_at, "2026-09-25T06:36:49.085Z", key);
			assert.equal(standaloneCompletionTarget(row).node_id, "engineer", key);
		}
		assert.equal(loadStandaloneRoleRow(db, "run-missing"), undefined);
		assert.equal(
			loadStandaloneRoleRow(db, "run-other").execution_id,
			"exec-other",
		);
	} finally {
		db.close();
	}
});

test("standalone acceptance target carries every writer the general node admitted", () => {
	const db = standaloneWriterReplacementDb();
	try {
		assert.deepEqual(
			loadStandaloneNodeExecutions(db, "run-d").map((row) => row.execution_id),
			["exec-old", "exec-new"],
		);
		// The workflow tables, not the session row, name the node that keys the
		// Codex agent home.
		db.exec(
			"UPDATE sessions SET workflow_node_id = NULL WHERE execution_id IN ('exec-old', 'exec-new')",
		);
		assert.deepEqual(
			loadStandaloneNodeExecutions(db, "run-d").map(
				(row) => row.workflow_node_id,
			),
			["general", "general"],
		);
		assert.equal(
			loadStandaloneRoleRow(db, "run-d").workflow_node_id,
			"general",
		);
		for (const key of ["run-d", "exec-old"]) {
			const target = standaloneAcceptanceTarget(db, key);
			assert.equal(target.node_id, "engineer", key);
			assert.equal(target.execution_id, "exec-new", key);
			assert.deepEqual(
				target.supersededExecutions.map((row) => [
					row.execution_id,
					row.supersededBy,
					row.terminal_at,
				]),
				[["exec-old", "exec-new", "2026-09-25 05:59:12"]],
				key,
			);
		}
		assert.equal(standaloneAcceptanceTarget(db, "run-other"), false);

		// A later general attempt keeps its own activation identity.
		db.exec(`
			INSERT INTO workflow_run_node VALUES
				('run-d', 'general', 2, 'done', 'exec-retry', '2026-09-25 07:00:00', '2026-09-25T07:30:00.000Z');
			INSERT INTO sessions VALUES
				('exec-retry', 'general', 'completed', 'needs_review', '2026-09-25 07:00:01', '2026-09-25 07:31:00', '/tmp/wt', 'codex-tmux', '{}');
			INSERT INTO workflow_execution_binding VALUES
				('activation:exec-retry:run-d:general:2', 'exec-retry', 'run-d', 'general', 2, 'spawn', '2026-09-25T07:00:00.000Z');
		`);
		const retried = standaloneAcceptanceTarget(db, "exec-old");
		assert.equal(retried.execution_id, "exec-retry");
		assert.equal(retried.attempt, 2);
		assert.match(acceptanceCaseDirectoryName(retried), /^engineer-attempt-2-/);
		assert.deepEqual(
			retried.supersededExecutions.map((row) => row.execution_id),
			["exec-old", "exec-new"],
		);
	} finally {
		db.close();
	}
});

test("a replaced writer's commands stay in the standalone evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-writer-replacement-"));
	const projectName = "test-slot-fixture";
	// G2: the room keys each Codex agent home by workflow node, so a standalone
	// engineer's rollouts live under `general`, not under the evidence role.
	const home = join(root, "state/codex-homes/agents", projectName, "general");
	const worktree = join(root, "worktree");
	const caseDir = join(root, "case");
	const rollout = (threadId, executionId, callId, command) =>
		[
			{ type: "session_meta", payload: { id: threadId, cwd: worktree } },
			{
				type: "turn_context",
				payload: { text: `FLYWHEEL_EXEC_ID=${executionId}` },
			},
			{
				type: "response_item",
				payload: {
					type: "custom_tool_call",
					name: "exec",
					call_id: callId,
					input: `const r = await tools.exec_command({cmd:${JSON.stringify(command)},workdir:${JSON.stringify(worktree)}}); text(r.output);`,
				},
			},
			{
				type: "response_item",
				payload: {
					type: "custom_tool_call_output",
					call_id: callId,
					output: [{ type: "input_text", text: "exit_code=0" }],
				},
			},
		]
			.map((record) => JSON.stringify(record))
			.join("\n");
	try {
		mkdirSync(join(home, "sessions"), { recursive: true });
		mkdirSync(worktree);
		mkdirSync(caseDir);
		const oldPath = join(home, "sessions", "old.jsonl");
		const newPath = join(home, "sessions", "new.jsonl");
		writeFileSync(
			oldPath,
			rollout(
				"thread-old",
				"exec-old",
				"call_old_broad",
				"pnpm --filter flywheel-fixture test",
			),
		);
		writeFileSync(
			newPath,
			rollout(
				"thread-new",
				"exec-new",
				"call_new_explicit",
				"pnpm --filter flywheel-fixture exec vitest run src/__tests__/model-label.test.ts",
			),
		);
		const requireFromTeamlead = createRequire(
			new URL("../../packages/teamlead/package.json", import.meta.url),
		);
		const Database = requireFromTeamlead("better-sqlite3");
		const threads = new Database(join(home, "state_5.sqlite"));
		threads.exec(
			"CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL)",
		);
		const insert = threads.prepare(
			"INSERT INTO threads (id, rollout_path, cwd) VALUES (?, ?, ?)",
		);
		insert.run("thread-old", oldPath, worktree);
		insert.run("thread-new", newPath, worktree);
		threads.close();
		const room = { slotRoot: root, projectName };
		const replaced = {
			execution_id: "exec-old",
			worktree_path: worktree,
			session_params: "{}",
			adapter_type: "codex-tmux",
			workflow_node_id: "general",
			status: "blocked",
			terminal_at: "2026-09-25 05:59:12",
			supersededBy: "exec-new",
		};
		const target = {
			execution_id: "exec-new",
			worktree_path: worktree,
			session_params: "{}",
			adapter_type: "codex-tmux",
			workflow_node_id: "general",
			node_id: "engineer",
			state: "done",
			ended_at: "2026-09-25T06:36:49.085Z",
			status: "failed",
			terminal_at: "2026-09-25 06:38:36",
			supersededExecutions: [replaced],
		};
		const collected = collectNodeTranscripts(room, target, "engineer", caseDir);
		assert.equal(collected.backend, "codex");
		assert.equal(collected.session.executionId, "exec-new");
		assert.deepEqual(
			collected.commands.map((command) => command.toolCallId),
			["call_old_broad", "call_new_explicit"],
		);
		assert.deepEqual(
			collected.sessions.map((session) => [
				session.id,
				session.executionId,
				session.transcriptComplete,
				session.completionReceipt,
			]),
			[
				["thread-old", "exec-old", true, true],
				["thread-new", "exec-new", true, true],
			],
		);
		assert.ok(existsSync(join(caseDir, "engineer-exec-old.jsonl")));
		assert.ok(existsSync(join(caseDir, "engineer-exec-new.jsonl")));
		const result = evaluateRunnerTestDiscipline({
			...completeEvidence(collected.commands),
			sessions: collected.sessions,
		});
		assert.equal(result.verdict, "FAIL");
		assert.match(result.findings[0].detail, /call_old_broad/);

		const liveCaseDir = join(root, "live-case");
		mkdirSync(liveCaseDir);
		const stillOpen = collectNodeTranscripts(
			room,
			{
				...target,
				supersededExecutions: [{ ...replaced, terminal_at: null }],
			},
			"engineer",
			liveCaseDir,
		);
		assert.equal(stillOpen.sessions[0].completionReceipt, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("generalized completion uses terminal role rows without requiring founder_gate", () => {
	const rows = [
		{
			node_id: "implement",
			attempt: 2,
			state: "done",
			ended_at: "2026-09-24T14:00:16Z",
		},
		{
			node_id: "qa",
			attempt: 2,
			state: "done",
			ended_at: "2026-09-24T14:13:00Z",
		},
	];
	assert.deepEqual(
		generalizedCompletionTargets({ current_node_id: "code_review" }, rows),
		rows,
	);
	assert.equal(
		generalizedCompletionTargets({ current_node_id: "qa" }, rows),
		false,
	);
	assert.equal(DEFAULT_TIMEOUT_MS, 180 * 60_000);
});

test("generalized rework observation settles after implement attempt 2 emits a classified test command", () => {
	const rows = [
		{
			node_id: "implement",
			attempt: 2,
			state: "running",
			execution_id: "exec-implement-2",
		},
		{
			node_id: "implement",
			attempt: 1,
			state: "done",
			ended_at: "2026-09-24T19:10:20Z",
			execution_id: "exec-implement-1",
		},
		{
			node_id: "qa",
			attempt: 1,
			state: "done",
			ended_at: "2026-09-24T20:45:19Z",
			execution_id: "exec-qa-1",
		},
	];
	assert.deepEqual(
		generalizedCompletionTargets({ current_node_id: "implement" }, rows, {
			executionId: "exec-implement-2",
			verdict: "PASS",
			reason: "vitest_explicit_test_files",
		}).map(({ execution_id }) => execution_id),
		["exec-implement-1", "exec-qa-1"],
	);
	assert.deepEqual(
		generalizedTerminalTargets(rows).map(({ execution_id }) => execution_id),
		["exec-implement-1", "exec-qa-1"],
	);
	assert.deepEqual(
		generalizedTerminalTargets([
			rows[1],
			{ ...rows[2], attempt: 2, execution_id: "exec-qa-2" },
			{ ...rows[1], attempt: 3, execution_id: "exec-implement-3" },
			rows[2],
		]).map(({ execution_id }) => execution_id),
		["exec-implement-1", "exec-implement-3", "exec-qa-1", "exec-qa-2"],
	);
	assert.notEqual(
		acceptanceCaseDirectoryName(rows[1]),
		acceptanceCaseDirectoryName({
			...rows[1],
			attempt: 3,
			execution_id: "exec-implement-3",
		}),
	);
});

test("rework observation scans past a TDD red and preserves forbidden precedence", () => {
	const context = {
		runId: "run-1",
		executionId: "exec-implement-2",
		attempt: 2,
		evidencePath: "observed-rework/exec-implement-2",
	};
	const selection = {
		packageRoot: "packages/runner-test-discipline-fixture",
		changedFiles: ["src/model-label.ts"],
		literalMatches: ["src/__tests__/model-label.test.ts"],
		allowedTestFiles: ["src/__tests__/model-label.test.ts"],
	};
	const red = {
		parseStatus: "parsed",
		command: "npx vitest run src/__tests__/model-label.test.ts",
		completed: true,
		succeeded: false,
		toolCallId: "red",
	};
	const green = { ...red, succeeded: true, toolCallId: "green" };
	const forbidden = {
		...red,
		command: "npx vitest run",
		succeeded: true,
		toolCallId: "forbidden",
	};
	assert.equal(
		classifyReworkTestCommands([red, green], selection, context).verdict,
		"PASS",
	);
	assert.equal(
		classifyReworkTestCommands([red, green, forbidden], selection, context)
			.verdict,
		"FAIL",
	);
});

test("run observations are append-only across timeout and later collection", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-observations-"));
	try {
		appendObservation(root, {
			verdict: "INCONCLUSIVE",
			reason: "observation_window_expired",
			runId: "run-1",
			executionId: null,
		});
		appendObservation(root, {
			verdict: "PASS",
			reason: "collection_completed",
			runId: "run-1",
			executionId: null,
		});
		appendObservation(root, {
			verdict: "FAIL",
			reason: "rework_test_command_forbidden",
			runId: "run-1",
			executionId: "exec-implement-2",
			toolCallId: "forbidden",
		});
		const observations = JSON.parse(
			readFileSync(join(root, "cases.json"), "utf8"),
		).observations;
		assert.deepEqual(
			observations.map(({ verdict }) => verdict),
			["INCONCLUSIVE", "PASS", "FAIL"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an expired observation window keeps completed role cases but stays inconclusive", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-timeout-evidence-"));
	try {
		const events = extractCommandEvents(
			readFileSync(`${fixtures}/codex-allowed.jsonl`, "utf8"),
			{ sourcePath: "codex-allowed.jsonl" },
		);
		for (const role of ["implement", "qa"]) {
			const path = join(root, "runs", "B-run-1", role);
			mkdirSync(path, { recursive: true });
			writeFileSync(
				join(path, "evidence.json"),
				JSON.stringify(completeEvidence(events)),
			);
		}
		writeFileSync(
			join(root, "cases.json"),
			JSON.stringify({
				schemaVersion: 1,
				cases: ["runs/B-run-1/implement", "runs/B-run-1/qa"],
				observations: [
					{
						verdict: "INCONCLUSIVE",
						reason: "observation_window_expired",
						runId: "run-1",
					},
				],
			}),
		);
		const result = await evaluateEvidenceDirectory(root);
		assert.equal(result.verdict, "INCONCLUSIVE");
		assert.equal(result.cases.length, 2);
		assert.equal(result.observations[0].reason, "observation_window_expired");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("generalized completion query projects the workflow-node receipt", () => {
	const requireFromTeamlead = createRequire(
		join(process.cwd(), "packages/teamlead/package.json"),
	);
	const Database = requireFromTeamlead("better-sqlite3");
	const db = new Database(":memory:");
	try {
		db.exec(`
			CREATE TABLE workflow_run_node (
				run_id TEXT,
				node_id TEXT,
				state TEXT,
				ended_at TEXT,
				attempt INTEGER,
				execution_id TEXT
			);
			CREATE TABLE sessions (
				execution_id TEXT,
				status TEXT,
				terminal_at TEXT,
				decision_route TEXT,
				awaiting_review_entered_at TEXT
			);
			INSERT INTO workflow_run_node VALUES
				('run-1', 'qa', 'done', '2026-09-24T02:22:40.317Z', 1, 'exec-1');
			INSERT INTO sessions VALUES
				('exec-1', 'running', NULL, NULL, NULL);
		`);
		const [row] = loadGeneralizedRoleRows(db, "run-1");
		assert.equal(row.ended_at, "2026-09-24T02:22:40.317Z");
		assert.equal(hasRoleCompletionReceipt(row), true);
	} finally {
		db.close();
	}
});

test("external review query binds Bridge reviewer sessions to the execution", () => {
	const requireFromTeamlead = createRequire(
		join(process.cwd(), "packages/teamlead/package.json"),
	);
	const Database = requireFromTeamlead("better-sqlite3");
	const db = new Database(":memory:");
	try {
		db.exec(`
			CREATE TABLE codex_review_job (
				request_id TEXT,
				execution_id TEXT,
				review_type TEXT,
				round INTEGER,
				status TEXT,
				reviewer_session_uuid TEXT,
				created_at TEXT
			);
			INSERT INTO codex_review_job VALUES
				('r1', 'exec-1', 'code', 1, 'running', 'reviewer-1', '2026-09-24T01:00:00Z'),
				('r2', 'exec-1', 'code', 2, 'done', 'reviewer-1', '2026-09-24T02:00:00Z'),
				('r3', 'exec-1', 'design', 3, 'done', 'design-reviewer', '2026-09-24T03:00:00Z'),
				('r4', 'exec-2', 'code', 1, 'done', 'other-reviewer', '2026-09-24T04:00:00Z');
		`);
		assert.deepEqual(loadExternalReviewSessions(db, "exec-1"), [
			{ sessionId: "reviewer-1", completionReceipt: true },
		]);
	} finally {
		db.close();
	}
});

test("Claude transcript discovery canonicalizes the worktree and binds the execution", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-claude-transcript-"));
	try {
		const worktree = join(root, "canonical-worktree");
		const alias = join(root, "worktree-alias");
		const projectsRoot = join(root, "projects");
		mkdirSync(worktree);
		symlinkSync(worktree, alias);
		const project = join(
			projectsRoot,
			realpathSync(worktree).replace(/[^A-Za-z0-9]/g, "-"),
		);
		mkdirSync(project, { recursive: true });
		writeFileSync(
			join(project, "unrelated.jsonl"),
			`${JSON.stringify({ sessionId: "unrelated", cwd: worktree })}\n`,
		);
		writeFileSync(
			join(project, "bound.jsonl"),
			`${JSON.stringify({ sessionId: "bound", cwd: worktree, text: "exec-bound" })}\n`,
		);
		assert.deepEqual(
			claudeTranscriptPath(
				{
					execution_id: "exec-bound",
					worktree_path: alias,
					session_params: "{}",
				},
				{ projectsRoot },
			),
			{ id: "bound", path: realpathSync(join(project, "bound.jsonl")) },
		);
		writeFileSync(
			join(project, "thread-bound.jsonl"),
			`${JSON.stringify({ sessionId: "thread-bound", cwd: worktree })}\n`,
		);
		assert.deepEqual(
			claudeTranscriptPath(
				{
					execution_id: "exec-bound",
					thread_id: "thread-bound",
					worktree_path: alias,
					session_params: "{}",
				},
				{ projectsRoot },
			),
			{
				id: "thread-bound",
				path: realpathSync(join(project, "thread-bound.jsonl")),
			},
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Codex transcript discovery falls back to cwd plus execution identity", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-codex-transcript-"));
	const projectName = "test-slot-fixture";
	const role = "qa";
	const home = join(root, "state/codex-homes/agents", projectName, role);
	const worktree = join(root, "worktree");
	try {
		mkdirSync(join(home, "sessions"), { recursive: true });
		mkdirSync(worktree);
		const rollout = join(home, "sessions", "bound.jsonl");
		writeFileSync(
			rollout,
			`${JSON.stringify({ type: "session_meta", payload: { id: "thread-bound", cwd: worktree } })}\n${JSON.stringify({ text: "exec-bound" })}\n`,
		);
		const requireFromTeamlead = createRequire(
			new URL("../../packages/teamlead/package.json", import.meta.url),
		);
		const Database = requireFromTeamlead("better-sqlite3");
		const db = new Database(join(home, "state_5.sqlite"));
		db.exec(
			"CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL)",
		);
		db.prepare(
			"INSERT INTO threads (id, rollout_path, cwd) VALUES (?, ?, ?)",
		).run("thread-bound", rollout, worktree);
		db.close();
		assert.deepEqual(
			codexTranscriptPath(
				{ slotRoot: root, projectName },
				{
					execution_id: "exec-bound",
					worktree_path: worktree,
					session_params: "{}",
				},
				role,
			),
			{ id: "thread-bound", path: realpathSync(rollout), home },
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Claude transcript collection includes completed owned subagents", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-subagent-transcript-"));
	try {
		const worktree = join(root, "worktree");
		const projectsRoot = join(root, "projects");
		const caseDir = join(root, "case");
		mkdirSync(worktree);
		mkdirSync(caseDir);
		const project = join(
			projectsRoot,
			realpathSync(worktree).replace(/[^A-Za-z0-9]/g, "-"),
		);
		mkdirSync(project, { recursive: true });
		const mainPath = join(project, "main-session.jsonl");
		writeFileSync(
			mainPath,
			[
				{
					type: "custom-title",
					sessionId: "main-session",
					text: "exec-bound",
				},
				{
					sessionId: "main-session",
					message: {
						content: [{ type: "tool_use", name: "Agent", id: "spawn-agent" }],
					},
				},
				{
					sessionId: "main-session",
					message: {
						content: "<task-id>child-1</task-id>\\n<status>completed</status>",
					},
				},
			]
				.map((row) => JSON.stringify(row))
				.join("\n"),
		);
		const subagents = join(project, "main-session", "subagents");
		mkdirSync(subagents, { recursive: true });
		writeFileSync(
			join(subagents, "agent-child-1.jsonl"),
			[
				{
					sessionId: "main-session",
					agentId: "child-1",
					message: {
						content: [
							{
								type: "tool_use",
								name: "Bash",
								id: "child-command",
								input: { command: "git status --short" },
							},
						],
					},
				},
				{
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "child-command",
								is_error: false,
							},
						],
					},
				},
			]
				.map((row) => JSON.stringify(row))
				.join("\n"),
		);
		const collected = collectSessionTranscript(
			{},
			{
				execution_id: "exec-bound",
				worktree_path: worktree,
				session_params: "{}",
				adapter_type: "claude-tmux",
				status: "completed",
				terminal_at: "2026-09-24T02:22:43Z",
			},
			"implement",
			caseDir,
			{ projectsRoot },
		);
		assert.equal(collected.commands.length, 1);
		assert.deepEqual(
			collected.sessions.map(
				({ id, transcriptComplete, completionReceipt }) => ({
					id,
					transcriptComplete,
					completionReceipt,
				}),
			),
			[
				{
					id: "main-session",
					transcriptComplete: true,
					completionReceipt: true,
				},
				{
					id: "main-session:child-1",
					transcriptComplete: true,
					completionReceipt: true,
				},
			],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Claude prompt snapshots do not imply a delegated subagent", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-prompt-snapshot-"));
	try {
		const worktree = join(root, "worktree");
		const projectsRoot = join(root, "projects");
		const caseDir = join(root, "case");
		mkdirSync(worktree);
		mkdirSync(caseDir);
		const project = join(
			projectsRoot,
			realpathSync(worktree).replace(/[^A-Za-z0-9]/g, "-"),
		);
		mkdirSync(project, { recursive: true });
		writeFileSync(
			join(project, "main-session.jsonl"),
			[
				{
					type: "custom-title",
					sessionId: "main-session",
					text: "exec-bound",
				},
				{
					type: "attachment",
					attachment: {
						type: "prompt_snapshot",
						tools: [{ name: "Agent" }, { name: "Task" }],
					},
				},
			]
				.map((row) => JSON.stringify(row))
				.join("\n"),
		);
		const collected = collectSessionTranscript(
			{},
			{
				execution_id: "exec-bound",
				worktree_path: worktree,
				session_params: "{}",
				adapter_type: "claude-tmux",
				status: "completed",
				terminal_at: "2026-09-24T02:22:43Z",
			},
			"qa",
			caseDir,
			{ projectsRoot },
		);
		assert.equal(collected.sessions.length, 1);
		assert.equal(collected.sessions[0].transcriptComplete, true);
		assert.equal(collected.sessions[0].reason, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Claude transcript collection follows reported Codex review threads", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-codex-child-"));
	const threadId = "01a0d0cb-b928-74d0-b80d-46c6a90f6835";
	try {
		const worktree = join(root, "worktree");
		const projectsRoot = join(root, "projects");
		const codexHome = join(root, "codex-home");
		const caseDir = join(root, "case");
		mkdirSync(worktree);
		mkdirSync(caseDir);
		const project = join(
			projectsRoot,
			realpathSync(worktree).replace(/[^A-Za-z0-9]/g, "-"),
		);
		mkdirSync(project, { recursive: true });
		writeFileSync(
			join(project, "main-session.jsonl"),
			[
				{
					type: "custom-title",
					sessionId: "main-session",
					text: "exec-bound",
				},
				{
					sessionId: "main-session",
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "review",
								is_error: false,
								content: `[codex] Thread ready (${threadId}).`,
							},
						],
					},
				},
			]
				.map((row) => JSON.stringify(row))
				.join("\n"),
		);
		mkdirSync(join(codexHome, "sessions"), { recursive: true });
		const rollout = join(codexHome, "sessions", "review.jsonl");
		writeFileSync(
			rollout,
			`${JSON.stringify({
				type: "event_msg",
				payload: {
					type: "item_completed",
					thread_id: threadId,
					item: {
						type: "CommandExecution",
						id: "review-command",
						command: ["/bin/zsh", "-lc", "git diff --stat"],
						cwd: `file://${worktree}`,
						status: "completed",
						exit_code: 0,
					},
				},
			})}\n`,
		);
		const requireFromTeamlead = createRequire(
			new URL("../../packages/teamlead/package.json", import.meta.url),
		);
		const Database = requireFromTeamlead("better-sqlite3");
		const db = new Database(join(codexHome, "state_5.sqlite"));
		db.exec(
			"CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)",
		);
		db.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run(
			threadId,
			rollout,
		);
		db.close();
		const collected = collectSessionTranscript(
			{},
			{
				execution_id: "exec-bound",
				worktree_path: worktree,
				session_params: "{}",
				adapter_type: "claude-tmux",
				status: "completed",
				terminal_at: "2026-09-24T02:22:43Z",
			},
			"implement",
			caseDir,
			{ projectsRoot, codexHome },
		);
		assert.equal(collected.commands.length, 1);
		assert.deepEqual(
			collected.sessions.map(({ id, transcriptComplete }) => ({
				id,
				transcriptComplete,
			})),
			[
				{ id: "main-session", transcriptComplete: true },
				{ id: threadId, transcriptComplete: true },
			],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Claude transcript collection includes Bridge-owned external review sessions", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-external-review-"));
	const reviewerSessionId = "89904018-1111-4222-8333-abcdefabcdef";
	try {
		const worktree = join(root, "worktree");
		const projectsRoot = join(root, "projects");
		const caseDir = join(root, "case");
		mkdirSync(worktree);
		mkdirSync(caseDir);
		const project = join(
			projectsRoot,
			realpathSync(worktree).replace(/[^A-Za-z0-9]/g, "-"),
		);
		mkdirSync(project, { recursive: true });
		writeFileSync(
			join(project, "main-session.jsonl"),
			`${JSON.stringify({
				type: "custom-title",
				sessionId: "main-session",
				text: "exec-bound",
			})}\n`,
		);
		writeFileSync(
			join(project, `${reviewerSessionId}.jsonl`),
			[
				{
					sessionId: reviewerSessionId,
					message: {
						role: "user",
						content:
							"<!-- FLYWHEEL_LOCAL_TEST_POLICY:BEGIN --> delegated policy",
					},
				},
				{
					sessionId: reviewerSessionId,
					message: {
						content: [
							{
								type: "tool_use",
								name: "Bash",
								id: "external-review-command",
								input: {
									command: "pnpm --filter fixture test",
								},
							},
						],
					},
				},
				{
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "external-review-command",
								is_error: false,
							},
						],
					},
				},
			]
				.map((row) => JSON.stringify(row))
				.join("\n"),
		);
		const collected = collectSessionTranscript(
			{},
			{
				execution_id: "exec-bound",
				worktree_path: worktree,
				session_params: "{}",
				adapter_type: "claude-tmux",
				status: "completed",
				terminal_at: "2026-09-24T02:22:43Z",
			},
			"implement",
			caseDir,
			{
				projectsRoot,
				externalReviewSessions: [
					{
						sessionId: reviewerSessionId,
						completionReceipt: true,
					},
				],
			},
		);
		assert.ok(
			collected.commands.some(
				(command) => command.toolCallId === "external-review-command",
			),
		);
		const reviewSession = collected.sessions.find(
			({ id }) => id === reviewerSessionId,
		);
		assert.ok(reviewSession);
		assert.equal(reviewSession.delegated, true);
		assert.equal(reviewSession.policyMarkers, 1);
		assert.equal(reviewSession.transcriptComplete, true);
		assert.equal(reviewSession.completionReceipt, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fixture identity ignores runtime Vitest cache files only", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-fixture-hash-"));
	try {
		writeFileSync(join(root, "source.ts"), "export const value = 1;\n");
		const before = stableTreeHash(root);
		mkdirSync(join(root, "node_modules/.vite/vitest"), { recursive: true });
		writeFileSync(join(root, "node_modules/.vite/vitest/results.json"), "{}\n");
		assert.equal(stableTreeHash(root), before);
		writeFileSync(join(root, "unexpected.ts"), "export const extra = true;\n");
		assert.notEqual(stableTreeHash(root), before);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("model receipt binds requested alias, canonical identity, and override provenance", () => {
	const started = {
		resolved: {
			nodeModels: {
				implement: {
					model: "opus (= claude-opus-5-5)",
					overridden: true,
				},
			},
		},
	};
	assert.equal(modelReceiptMatches(started, "implement", "opus"), true);
	assert.equal(modelReceiptMatches(started, "implement", "codex"), false);
	assert.equal(
		modelReceiptMatches(
			{
				resolved: {
					nodeModels: {
						implement: {
							model: "opus (= claude-opus-5-5)",
							overridden: false,
						},
					},
				},
			},
			"implement",
			"opus",
		),
		false,
	);
});

test("529 run-start requests derive all carrier models from the cell matrix", () => {
	const common = {
		issue: "FLY-SBX-1",
		projectName: "flywheel-test-4",
		leadId: "runner-test-discipline",
	};
	const cellA = buildRunStartRequest({
		...common,
		generalized: true,
		cell: "A",
	});
	const cellB = buildRunStartRequest({
		...common,
		generalized: true,
		cell: "B",
	});
	const cellC = buildRunStartRequest({
		...common,
		generalized: false,
		cell: "C",
	});
	const cellD = buildRunStartRequest({
		...common,
		generalized: false,
		cell: "D",
	});
	assert.deepEqual(cellA.overrides, {
		implement: { model: "opus" },
		qa: { model: "codex" },
	});
	assert.deepEqual(cellB.overrides, {
		implement: { model: "codex" },
		qa: { model: "opus" },
	});
	assert.deepEqual(cellC.overrides, { general: { model: "opus" } });
	// The bundled generic menu offers only opus; cell D selects Codex as an
	// explicit off-menu override, which the shared resolver accepts only with
	// an explicit effort (no production registry widening).
	assert.deepEqual(cellD.overrides, {
		general: { model: "codex", effort: "xhigh" },
	});
	assert.equal(Object.hasOwn(cellC, "model"), false);
	assert.equal(Object.hasOwn(cellD, "model"), false);
});

test("synthetic room issue validation accepts multi-segment Linear identifiers", () => {
	assert.equal(isCanonicalIssueIdentifier("FLY-SBX-1"), true);
	assert.equal(isCanonicalIssueIdentifier("FLY-2802"), true);
	assert.equal(isCanonicalIssueIdentifier("fly-sbx-1"), false);
	assert.equal(isCanonicalIssueIdentifier("FLY-SBX"), false);
});

test("prepare materializes a deterministic literal-migration subject without starting a room", async () => {
	const out = mkdtempSync(join(tmpdir(), "fly2802-prepare-"));
	try {
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		const manifest = await prepareEvidence({
			head,
			fixture: "literal-migration-v1",
			out,
			repoRoot: fileURLToPath(new URL("../..", import.meta.url)),
		});
		assert.equal(manifest.candidateHead, head);
		assert.equal(manifest.fixture, "literal-migration-v1");
		assert.match(manifest.fixtureHash, /^[a-f0-9]{64}$/);
		assert.match(manifest.policyHash, /^[a-f0-9]{64}$/);
		assert.deepEqual(
			manifest.requiredCells,
			manifest.triggerFiles.length ? ["A", "B", "C", "D"] : [],
		);
		assert.equal(typeof manifest.triggerHistoryComplete, "boolean");
		assert.equal(existsSync(join(out, "subject", "package.json")), true);
		assert.equal(existsSync(join(out, "task.md")), true);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});

test("prompt trigger discovery fails closed in a single-commit shallow checkout", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2802-shallow-trigger-"));
	try {
		execFileSync("git", ["init", "-q", root]);
		execFileSync("git", [
			"-C",
			root,
			"config",
			"user.email",
			"qa@example.test",
		]);
		execFileSync("git", ["-C", root, "config", "user.name", "QA"]);
		mkdirSync(join(root, ".flywheel/agents/nodes"), { recursive: true });
		writeFileSync(
			join(root, ".flywheel/agents/nodes/implement.md"),
			"changed\n",
		);
		execFileSync("git", ["-C", root, "add", "."]);
		execFileSync("git", ["-C", root, "commit", "-qm", "root"]);
		const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		assert.deepEqual(promptTriggerFiles(root, head), {
			base: null,
			changed: [],
			triggers: ["<history-unavailable:conservative-all-cells>"],
			historyComplete: false,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("directory evaluator preserves FAIL precedence over incomplete evidence", async () => {
	const out = mkdtempSync(join(tmpdir(), "fly2802-evaluate-"));
	try {
		const evidence = completeEvidence([
			{
				toolCallId: "broad-before-timeout",
				command: "pnpm exec vitest run --exclude slow.test.ts",
				completed: false,
				succeeded: false,
			},
		]);
		await import("node:fs/promises").then(async ({ writeFile }) => {
			await writeFile(
				join(out, "evidence.json"),
				`${JSON.stringify(evidence)}\n`,
			);
		});
		const verdict = await evaluateEvidenceDirectory(out);
		assert.equal(verdict.verdict, "FAIL");
		assert.equal(verdict.cases[0].verdict, "FAIL");
		assert.equal(existsSync(join(out, "verdict.json")), true);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});

test("standalone engineer fixture resolves through real ConfigLoader and AgentDispatcher", () => {
	const project = mkdtempSync(join(tmpdir(), "fly2802-dispatch-"));
	const root = fileURLToPath(new URL("../..", import.meta.url));
	try {
		mkdirSync(join(project, ".flywheel/agents/nodes"), { recursive: true });
		writeFileSync(
			join(project, ".flywheel/config.yaml"),
			`project: test-slot-fixture
linear: { team_id: FLY }
runners:
  default: claude
  available: { claude: { type: claude, model: sonnet } }
teams:
  - name: default
    orchestrators: [{ type: dag, runner: claude }]
decision_layer: { autonomy_level: advisor, escalation_channel: discord }
agents:
  engineer:
    node: engineer
    match: { labels: [code] }
`,
		);
		writeFileSync(
			join(project, ".flywheel/agents/registry.yaml"),
			"nodes:\n  engineer: { file: nodes/engineer.md, department: engineering }\n",
		);
		writeFileSync(
			join(project, ".flywheel/agents/nodes/engineer.md"),
			"# engineer\n",
		);
		const result = execFileSync(
			process.execPath,
			[
				join(root, "scripts/lib/qa-test-discipline-config.mjs"),
				"--root",
				project,
				"--flywheel-root",
				root,
				"--agent",
				"engineer",
			],
			{ encoding: "utf8" },
		);
		assert.deepEqual(JSON.parse(result), {
			success: true,
			agent: "engineer",
			node: "engineer",
			agentFile: join(project, ".flywheel/agents/nodes/engineer.md"),
		});
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});

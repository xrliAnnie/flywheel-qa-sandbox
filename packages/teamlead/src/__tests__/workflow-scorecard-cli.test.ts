import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkflowScorecardCli } from "../workflow-scorecard-cli.js";

const cleanups: string[] = [];

afterEach(() => {
	for (const path of cleanups.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "fly2789-scorecard-cli-"));
	cleanups.push(dir);
	const path = join(dir, "teamlead.db");
	const db = new BetterSqlite3(path);
	db.exec(`
		CREATE TABLE workflow_run(run_id TEXT PRIMARY KEY, issue_id TEXT, project_name TEXT, status TEXT);
		CREATE TABLE workflow_run_issue_alias(run_id TEXT, issue_alias TEXT, PRIMARY KEY(run_id, issue_alias));
		CREATE TABLE workflow_execution_runtime(execution_id TEXT PRIMARY KEY, model TEXT);
		CREATE TABLE workflow_execution_binding(
			activation_id TEXT PRIMARY KEY, execution_id TEXT, run_id TEXT,
			node_id TEXT, attempt INTEGER, bound_at TEXT);
		CREATE TABLE workflow_scorecard_activation(
			activation_id TEXT PRIMARY KEY, execution_id TEXT, run_id TEXT, node_id TEXT,
			attempt INTEGER, axis TEXT, assignment_state TEXT, policy_version TEXT,
			arm_id TEXT, assignment_event_uid TEXT, assignment_digest TEXT,
			admitted_at TEXT, closed_at TEXT, close_event_uid TEXT, close_kind TEXT);
		CREATE TABLE workflow_scorecard_turn(
			vendor TEXT, native_session_id TEXT, native_turn_id TEXT, execution_id TEXT,
			activation_id TEXT, attribution_state TEXT, started_at TEXT, ended_at TEXT,
			source_generation TEXT, start_offset INTEGER, end_offset INTEGER);
		CREATE TABLE workflow_scorecard_usage(
			vendor TEXT, native_session_id TEXT, source_generation TEXT, source_record_id TEXT,
			provider_request_id TEXT, native_turn_id TEXT, observed_model_id TEXT,
			input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
			cache_write_tokens INTEGER, reasoning_tokens INTEGER, normalized_delta INTEGER,
			source_digest TEXT, at TEXT, source_offset INTEGER);
		CREATE TABLE workflow_scorecard_cursor(
			vendor TEXT, native_session_id TEXT, source_generation TEXT, execution_id TEXT,
			source_locator TEXT, committed_offset INTEGER, source_fingerprint TEXT,
			coverage TEXT, error TEXT, final_watermark INTEGER, updated_at TEXT);
		CREATE TABLE workflow_run_event(
			run_id TEXT, seq INTEGER, event_uid TEXT, kind TEXT, node_id TEXT,
			edge_id TEXT, execution_id TEXT, payload TEXT, at TEXT);
		CREATE TABLE workflow_claims(
			workflow_run_id TEXT, decision_kind TEXT, predicate TEXT, server_seq INTEGER, issued_at TEXT);
		CREATE TABLE workflow_gate_holder(
			run_id TEXT, question_id TEXT PRIMARY KEY, created_at TEXT);
		CREATE TABLE ship_judgment_outcome(
			outcome_id TEXT PRIMARY KEY, question_id TEXT, run_id TEXT,
			authorship TEXT, decision TEXT, decided_at TEXT, observed_at TEXT);
	`);
	const insertIssue = (input: {
		issue: string;
		run: string;
		executions: Array<{
			id: string;
			admitted: number;
			closed: number;
			tokens: number;
			model?: string;
			vendor?: "claude" | "codex";
		}>;
		qa: Array<"qa_passed" | "qa_failed">;
		founder: Array<"approved" | "rework">;
		degraded?: boolean;
		policyVersion?: string;
	}) => {
		const policyVersion = input.policyVersion ?? "impl-v1";
		db.prepare(
			"INSERT INTO workflow_run VALUES (?, ?, 'flywheel', 'completed')",
		).run(input.run, input.issue);
		db.prepare(
			"INSERT INTO workflow_run_event VALUES (?,1,?,'model_arm_assigned','implement',NULL,NULL,?,?)",
		).run(
			input.run,
			`model_arm_assigned:${input.run}:implement`,
			JSON.stringify({
				schemaVersion: 1,
				runId: input.run,
				nodeId: "implement",
				policyVersion,
				arm: "impl_sol56",
				resolvedModel: "gpt-5.6-sol",
				assignedAt: "2026-09-23T04:00:00.000Z",
			}),
			"2026-09-23T04:00:00.000Z",
		);
		for (const [index, execution] of input.executions.entries()) {
			const activation = `activation:${execution.id}`;
			const session = `session:${execution.id}`;
			const model = execution.model ?? "gpt-5.6-sol";
			const vendor = execution.vendor ?? "codex";
			db.prepare(
				"INSERT INTO workflow_execution_binding VALUES (?, ?, ?, 'implement', ?, ?)",
			).run(
				activation,
				execution.id,
				input.run,
				index + 1,
				new Date(execution.admitted).toISOString(),
			);
			db.prepare("INSERT INTO workflow_execution_runtime VALUES (?, ?)").run(
				execution.id,
				model,
			);
			db.prepare(
				`INSERT INTO workflow_scorecard_activation VALUES
				 (?, ?, ?, 'implement', ?, 'implement', 'assigned', ?, 'impl_sol56', ?, 'digest', ?, ?, NULL, 'done')`,
			).run(
				activation,
				execution.id,
				input.run,
				index + 1,
				policyVersion,
				`model_arm_assigned:${input.run}:implement`,
				new Date(execution.admitted).toISOString(),
				new Date(execution.closed).toISOString(),
			);
			db.prepare(
				`INSERT INTO workflow_scorecard_turn VALUES
				 (?, ?, ?, ?, ?, 'attributed', ?, NULL, 'generation', 0, NULL)`,
			).run(
				vendor,
				session,
				`turn:${execution.id}`,
				execution.id,
				activation,
				new Date(execution.admitted).toISOString(),
			);
			db.prepare(
				`INSERT INTO workflow_scorecard_usage VALUES
				 (?, ?, 'generation', '1', NULL, ?, ?, ?, 0, 0, 0, 0, ?, 'digest', ?, 1)`,
			).run(
				vendor,
				session,
				`turn:${execution.id}`,
				model,
				execution.tokens,
				execution.tokens,
				new Date(execution.closed).toISOString(),
			);
			db.prepare(
				`INSERT INTO workflow_scorecard_cursor VALUES
				 (?, ?, 'generation', ?, '/tmp/source', 1, 'fingerprint', 'complete', NULL, 1, ?)`,
			).run(
				vendor,
				session,
				execution.id,
				new Date(execution.closed).toISOString(),
			);
		}
		input.qa.forEach((predicate, index) =>
			db
				.prepare(
					"INSERT INTO workflow_claims VALUES (?, 'qa_verdict', ?, ?, ?)",
				)
				.run(
					input.run,
					predicate,
					Number(input.issue.slice(-1)) * 10 + index,
					"2026-09-23T04:10:00.000Z",
				),
		);
		input.founder.forEach((verdict, index) => {
			const questionId = `${input.run}:question:${index}`;
			db.prepare("INSERT INTO workflow_gate_holder VALUES (?, ?, ?)").run(
				input.run,
				questionId,
				"2026-09-23T04:15:00.000Z",
			);
			db.prepare(
				"INSERT INTO ship_judgment_outcome VALUES (?, ?, ?, 'founder_verified', ?, ?, ?)",
			).run(
				`${input.run}:founder:${index}`,
				questionId,
				input.run,
				verdict,
				"2026-09-23T04:20:00.000Z",
				"2026-09-30T04:20:00.000Z",
			);
		});
		if (input.degraded) {
			const activation = `activation:${input.executions[0]!.id}`;
			db.prepare(
				"INSERT INTO workflow_run_event VALUES (?,2,?,'model_arm_degraded','implement',NULL,?, ?, ?)",
			).run(
				input.run,
				`model_arm_degraded:${input.run}:implement:${activation}`,
				input.executions[0]!.id,
				JSON.stringify({
					schemaVersion: 1,
					runId: input.run,
					nodeId: "implement",
					activationId: activation,
					assignmentEventUid: `model_arm_assigned:${input.run}:implement`,
					arm: "impl_sol56",
					degraded: true,
					assignedModel: "gpt-5.6-sol",
					actualModel: input.executions[0]!.model ?? "gpt-5.6-sol",
					reason: "codex_pool_exhausted",
					degradedAt: "2026-09-23T04:00:00.500Z",
				}),
				"2026-09-23T04:00:00.500Z",
			);
		}
	};
	insertIssue({
		issue: "FLY-1",
		run: "run-a",
		executions: [{ id: "exec-a", admitted: 0, closed: 1000, tokens: 100 }],
		qa: ["qa_passed"],
		founder: ["approved"],
	});
	insertIssue({
		issue: "FLY-2",
		run: "run-b",
		executions: [
			{ id: "exec-b1", admitted: 0, closed: 500, tokens: 50 },
			{ id: "exec-b2", admitted: 500, closed: 2000, tokens: 150 },
		],
		qa: ["qa_failed", "qa_passed"],
		founder: ["rework", "approved"],
		policyVersion: "impl-v2",
	});
	insertIssue({
		issue: "FLY-3",
		run: "run-c",
		executions: [
			{
				id: "exec-c",
				admitted: 0,
				closed: 1300,
				tokens: 120,
				model: "claude-opus-5",
				vendor: "claude",
			},
		],
		qa: ["qa_passed"],
		founder: ["approved"],
		degraded: true,
	});
	db.close();
	return path;
}

describe("workflow scorecard CLI", () => {
	it("reports replay-safe grouped outcomes through a read-only dry-run", () => {
		const path = fixture();
		const capacityPath = join(path, "..", "pool-capacity.json");
		writeFileSync(
			capacityPath,
			JSON.stringify({
				schemaVersion: 1,
				unit: "provider_total_tokens_v1",
				providers: {
					claude: {
						weeklyTokensPerCapacityUnit: 100,
						accounts: ["c1", "c2", "c3", "c4"].map((slot) => ({
							slot,
							capacityUnits: 1,
						})),
					},
					codex: {
						weeklyTokensPerCapacityUnit: 10,
						accounts: [20, 20, 20, 5, 5, 5].map((capacityUnits, index) => ({
							slot: `x${capacityUnits}-${index}`,
							capacityUnits,
						})),
					},
				},
			}),
		);
		const before = statSync(path);
		let stdout = "";
		let stderr = "";
		const code = runWorkflowScorecardCli(
			[
				"report",
				"--db",
				path,
				"--project",
				"flywheel",
				"--from",
				"1970-01-01T00:00:00.000Z",
				"--to",
				"1970-01-01T00:00:03.000Z",
				"--as-of",
				"2026-09-24T00:00:00.000Z",
				"--format",
				"json",
				"--pool-capacity-config",
				capacityPath,
				"--dry-run",
			],
			{
				stdout: (value) => {
					stdout += value;
				},
				stderr: (value) => {
					stderr += value;
				},
			},
		);
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		const report = JSON.parse(stdout);
		expect(report).toMatchObject({
			status: "ok",
			metricVersion: 1,
			issueCount: 3,
			degradedCount: 1,
			crossVendorUnitIncomparable: true,
			providerConsumption: [
				{
					vendor: "claude",
					tokens: 120,
					accountCount: 4,
					capacityUnits: 4,
					weeklyPoolCapacity: 400,
					weeklyPoolUsedPercent: 30,
					coverageComplete: true,
				},
				{
					vendor: "codex",
					tokens: 300,
					accountCount: 6,
					capacityUnits: 75,
					weeklyPoolCapacity: 750,
					weeklyPoolUsedPercent: 40,
					coverageComplete: true,
				},
			],
		});
		expect(
			report.groups.find(
				(row: { axis: string; group: string; policyVersion: string }) =>
					row.axis === "implement" &&
					row.group === "impl_sol56" &&
					row.policyVersion === "impl-v1",
			),
		).toMatchObject({
			issueCount: 1,
			assignedIssueCountBeforeExclusions: 2,
			degradedFromThisArm: 1,
			qaFirstPass: { numerator: 1, denominator: 1, rate: 1 },
			founderReject: { numerator: 0, denominator: 1, rate: 0 },
			tokensPerFirstPassIssue: 100,
			meanTokensOfFirstPassIssues: 100,
			meanNodeWorkMs: 1000,
			meanElapsedMs: 1000,
		});
		expect(
			report.groups.find(
				(row: { axis: string; group: string; policyVersion: string }) =>
					row.axis === "implement" &&
					row.group === "impl_sol56" &&
					row.policyVersion === "impl-v2",
			),
		).toMatchObject({
			issueCount: 1,
			assignedIssueCountBeforeExclusions: 1,
			qaFirstPass: { numerator: 0, denominator: 1, rate: 0 },
			founderReject: { numerator: 1, denominator: 1, rate: 1 },
		});
		expect(
			report.groups.find((row: { group: string }) => row.group === "degraded"),
		).toMatchObject({
			issueCount: 1,
			tokensPerFirstPassIssue: 120,
			vendorMix: [{ vendor: "claude", model: "claude-opus-5", tokens: 120 }],
		});
		const after = statSync(path);
		expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({
			size: before.size,
			mtimeMs: before.mtimeMs,
		});
	});

	it("shows exact design, implement, and QA node identity for one issue", () => {
		const path = fixture();
		const db = new BetterSqlite3(path);
		for (const input of [
			{
				axis: "design",
				node: "design",
				exec: "exec-0-design",
				arm: "design_g1",
				model: "claude-opus-5",
				vendor: "claude",
				admitted: 0,
				closed: 500,
				tokens: 20,
				seq: 2,
			},
			{
				axis: "qa",
				node: "qa",
				exec: "exec-a-qa",
				arm: "qa_q1",
				model: "claude-opus-5",
				vendor: "claude",
				admitted: 1000,
				closed: 1500,
				tokens: 30,
				seq: 3,
			},
		] as const) {
			const activation = `activation:${input.exec}`;
			const session = `session:${input.exec}`;
			const assignmentUid = `model_arm_assigned:run-a:${input.node}`;
			db.prepare(
				"INSERT INTO workflow_execution_binding VALUES (?, ?, 'run-a', ?, 1, ?)",
			).run(
				activation,
				input.exec,
				input.node,
				new Date(input.admitted).toISOString(),
			);
			db.prepare("INSERT INTO workflow_execution_runtime VALUES (?, ?)").run(
				input.exec,
				input.model,
			);
			db.prepare(
				"INSERT INTO workflow_run_event VALUES ('run-a', ?, ?, 'model_arm_assigned', ?, NULL, NULL, ?, ?)",
			).run(
				input.seq,
				assignmentUid,
				input.node,
				JSON.stringify({
					schemaVersion: 1,
					runId: "run-a",
					nodeId: input.node,
					policyVersion: `${input.axis}-v1`,
					arm: input.arm,
					resolvedModel: input.model,
					assignedAt: "2026-09-23T04:00:00.000Z",
				}),
				"2026-09-23T04:00:00.000Z",
			);
			db.prepare(
				`INSERT INTO workflow_scorecard_activation VALUES
				 (?, ?, 'run-a', ?, 1, ?, 'assigned', ?, ?, ?, 'digest', ?, ?, NULL, 'done')`,
			).run(
				activation,
				input.exec,
				input.node,
				input.axis,
				`${input.axis}-v1`,
				input.arm,
				assignmentUid,
				new Date(input.admitted).toISOString(),
				new Date(input.closed).toISOString(),
			);
			db.prepare(
				`INSERT INTO workflow_scorecard_turn VALUES
				 (?, ?, ?, ?, ?, 'attributed', ?, NULL, 'generation', 0, NULL)`,
			).run(
				input.vendor,
				session,
				`turn:${input.exec}`,
				input.exec,
				activation,
				new Date(input.admitted).toISOString(),
			);
			db.prepare(
				`INSERT INTO workflow_scorecard_usage VALUES
				 (?, ?, 'generation', '1', NULL, ?, ?, ?, 0, 0, 0, 0, ?, 'digest', ?, 1)`,
			).run(
				input.vendor,
				session,
				`turn:${input.exec}`,
				input.model,
				input.tokens,
				input.tokens,
				new Date(input.closed).toISOString(),
			);
			db.prepare(
				`INSERT INTO workflow_scorecard_cursor VALUES
				 (?, ?, 'generation', ?, '/tmp/source', 1, 'fingerprint', 'complete', NULL, 1, ?)`,
			).run(
				input.vendor,
				session,
				input.exec,
				new Date(input.closed).toISOString(),
			);
		}
		db.close();
		let stdout = "";
		expect(
			runWorkflowScorecardCli(
				[
					"issue",
					"--db",
					path,
					"--project",
					"flywheel",
					"--issue",
					"FLY-1",
					"--from",
					"1970-01-01T00:00:00.000Z",
					"--to",
					"1970-01-01T00:00:03.000Z",
					"--as-of",
					"2026-09-24T00:00:00.000Z",
					"--format",
					"json",
					"--dry-run",
				],
				{
					stdout: (value) => {
						stdout += value;
					},
					stderr: () => {},
				},
			),
		).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.issues[0]).toMatchObject({
			groups: { design: "design_g1", implement: "impl_sol56", qa: "qa_q1" },
			totalTokens: 150,
			nodeWorkMs: 2000,
			elapsedMs: 1500,
		});
		expect(
			report.issues[0].nodes.map(
				(node: {
					axis: string;
					launchModel: string;
					observedModels: string[];
				}) => ({
					axis: node.axis,
					launchModel: node.launchModel,
					observedModels: node.observedModels,
				}),
			),
		).toEqual([
			{
				axis: "design",
				launchModel: "claude-opus-5",
				observedModels: ["claude-opus-5"],
			},
			{
				axis: "implement",
				launchModel: "gpt-5.6-sol",
				observedModels: ["gpt-5.6-sol"],
			},
			{
				axis: "qa",
				launchModel: "claude-opus-5",
				observedModels: ["claude-opus-5"],
			},
		]);
	});

	it("uses decided time and verified outcomes, and marks an unobserved holder missing", () => {
		const path = fixture();
		const db = new BetterSqlite3(path);
		db.prepare(
			"INSERT INTO workflow_gate_holder VALUES ('run-a', 'q-unknown', ?)",
		).run("2026-09-23T04:15:00.000Z");
		db.prepare(
			"INSERT INTO ship_judgment_outcome VALUES ('unknown-rework', 'q-unknown', 'run-a', 'unknown', 'rework', ?, ?)",
		).run("2026-09-23T04:20:00.000Z", "2026-09-23T04:21:00.000Z");
		db.prepare(
			"INSERT INTO workflow_gate_holder VALUES ('run-c', 'q-missing', ?)",
		).run("2026-09-23T04:15:00.000Z");
		db.prepare(
			"INSERT INTO ship_judgment_outcome VALUES ('future-approved', 'q-missing', 'run-c', 'founder_verified', 'approved', ?, ?)",
		).run("2026-09-25T04:20:00.000Z", "2026-09-23T04:21:00.000Z");
		db.close();

		let stdout = "";
		expect(
			runWorkflowScorecardCli(
				[
					"report",
					"--db",
					path,
					"--project",
					"flywheel",
					"--from",
					"1970-01-01T00:00:00.000Z",
					"--to",
					"1970-01-01T00:00:03.000Z",
					"--as-of",
					"2026-09-24T00:00:00.000Z",
					"--format",
					"json",
					"--dry-run",
				],
				{
					stdout: (value) => {
						stdout += value;
					},
					stderr: () => {},
				},
			),
		).toBe(0);
		const issues = JSON.parse(stdout).issues;
		expect(
			issues.find((issue: { issueId: string }) => issue.issueId === "FLY-1"),
		).toMatchObject({
			founderReviewed: true,
			founderRejectCount: 0,
		});
		expect(
			issues.find((issue: { issueId: string }) => issue.issueId === "FLY-3"),
		).toMatchObject({
			founderReviewed: false,
			founderRejectCount: null,
		});
	});

	it("keeps an authoritative activation visible when accounting admission failed", () => {
		const path = fixture();
		const db = new BetterSqlite3(path);
		db.prepare(
			"DELETE FROM workflow_scorecard_activation WHERE activation_id = 'activation:exec-b2'",
		).run();
		db.close();
		let stdout = "";
		expect(
			runWorkflowScorecardCli(
				[
					"issue",
					"--db",
					path,
					"--project",
					"flywheel",
					"--issue",
					"FLY-2",
					"--from",
					"1970-01-01T00:00:00.000Z",
					"--to",
					"1970-01-01T00:00:03.000Z",
					"--as-of",
					"2026-09-24T00:00:00.000Z",
					"--format",
					"json",
					"--dry-run",
				],
				{
					stdout: (value) => {
						stdout += value;
					},
					stderr: () => {},
				},
			),
		).toBe(0);
		const issue = JSON.parse(stdout).issues[0];
		expect(issue).toMatchObject({
			issueId: "FLY-2",
			totalTokens: null,
			nodeWorkMs: null,
			groups: { design: "unknown", implement: "unknown", qa: "unknown" },
		});
		expect(issue.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					activationId: "activation:exec-b2",
					assignmentState: "accounting_unavailable",
				}),
			]),
		);
		const originalGroup = JSON.parse(stdout).groups.find(
			(row: { axis: string; group: string; policyVersion: string }) =>
				row.axis === "implement" &&
				row.group === "impl_sol56" &&
				row.policyVersion === "impl-v2",
		);
		expect(originalGroup).toMatchObject({
			issueCount: 0,
			assignedIssueCountBeforeExclusions: 1,
			unknownEvidenceFromThisArm: 1,
		});
		const unknownGroup = JSON.parse(stdout).groups.find(
			(row: { axis: string; group: string }) =>
				row.axis === "implement" && row.group === "unknown",
		);
		expect(unknownGroup).toMatchObject({
			meanNodeWorkMs: null,
			meanElapsedMs: null,
			timeCoverage: {
				nodeWorkComplete: 0,
				elapsedComplete: 0,
				terminal: 1,
			},
			completeSubsetEstimate: {
				tokensPerFirstPassIssue: null,
				meanNodeWorkMs: null,
				meanElapsedMs: null,
			},
		});
	});

	it("aggregates a degraded replacement across two runs exactly once", () => {
		const path = fixture();
		const db = new BetterSqlite3(path);
		db.prepare(
			"INSERT INTO workflow_run VALUES ('run-e1', 'FLY-E', 'flywheel', 'terminated')",
		).run();
		db.prepare(
			"INSERT INTO workflow_run VALUES ('run-e2', 'FLY-E', 'flywheel', 'completed')",
		).run();
		const addActivation = (input: {
			run: string;
			node: "design" | "implement" | "qa";
			execution: string;
			admitted: number;
			closed: number;
			tokens: number;
			arm: string;
			assignedModel: string;
			actualModel?: string;
			vendor: "claude" | "codex";
		}) => {
			const activation = `activation:${input.execution}`;
			const assignment = `model_arm_assigned:${input.run}:${input.node}`;
			const actualModel = input.actualModel ?? input.assignedModel;
			db.prepare(
				"INSERT INTO workflow_run_event VALUES (?,1,?,'model_arm_assigned',?,NULL,NULL,?,?)",
			).run(
				input.run,
				assignment,
				input.node,
				JSON.stringify({
					schemaVersion: 1,
					runId: input.run,
					nodeId: input.node,
					policyVersion: `${input.node}-v1`,
					arm: input.arm,
					resolvedModel: input.assignedModel,
					assignedAt: "1970-01-01T00:00:00.000Z",
				}),
				"1970-01-01T00:00:00.000Z",
			);
			db.prepare(
				"INSERT INTO workflow_execution_binding VALUES (?, ?, ?, ?, 1, ?)",
			).run(
				activation,
				input.execution,
				input.run,
				input.node,
				new Date(input.admitted).toISOString(),
			);
			db.prepare("INSERT INTO workflow_execution_runtime VALUES (?, ?)").run(
				input.execution,
				actualModel,
			);
			db.prepare(
				`INSERT INTO workflow_scorecard_activation VALUES
				 (?, ?, ?, ?, 1, ?, 'assigned', ?, ?, ?, 'digest', ?, ?, NULL, 'done')`,
			).run(
				activation,
				input.execution,
				input.run,
				input.node,
				input.node,
				`${input.node}-v1`,
				input.arm,
				assignment,
				new Date(input.admitted).toISOString(),
				new Date(input.closed).toISOString(),
			);
			const session = `session:${input.execution}`;
			db.prepare(
				`INSERT INTO workflow_scorecard_turn VALUES
				 (?, ?, ?, ?, ?, 'attributed', ?, NULL, 'generation', 0, NULL)`,
			).run(
				input.vendor,
				session,
				`turn:${input.execution}`,
				input.execution,
				activation,
				new Date(input.admitted).toISOString(),
			);
			db.prepare(
				`INSERT INTO workflow_scorecard_usage VALUES
				 (?, ?, 'generation', '1', NULL, ?, ?, ?, 0, 0, 0, 0, ?, 'digest', ?, 1)`,
			).run(
				input.vendor,
				session,
				`turn:${input.execution}`,
				actualModel,
				input.tokens,
				input.tokens,
				new Date(input.closed).toISOString(),
			);
			db.prepare(
				`INSERT INTO workflow_scorecard_cursor VALUES
				 (?, ?, 'generation', ?, '/tmp/source', 1, 'fingerprint', 'complete', NULL, 1, ?)`,
			).run(
				input.vendor,
				session,
				input.execution,
				new Date(input.closed).toISOString(),
			);
			return { activation, assignment };
		};
		addActivation({
			run: "run-e1",
			node: "design",
			execution: "exec-e1-design",
			admitted: 0,
			closed: 200,
			tokens: 20,
			arm: "design_g1",
			assignedModel: "claude-opus-5",
			vendor: "claude",
		});
		addActivation({
			run: "run-e1",
			node: "implement",
			execution: "exec-e1-impl",
			admitted: 200,
			closed: 500,
			tokens: 20,
			arm: "impl_sol56",
			assignedModel: "gpt-5.6-sol",
			vendor: "codex",
		});
		const recovered = addActivation({
			run: "run-e2",
			node: "implement",
			execution: "exec-e2-impl",
			admitted: 1500,
			closed: 2000,
			tokens: 50,
			arm: "impl_sol56",
			assignedModel: "gpt-5.6-sol",
			actualModel: "claude-opus-5",
			vendor: "claude",
		});
		addActivation({
			run: "run-e2",
			node: "qa",
			execution: "exec-e2-qa",
			admitted: 2000,
			closed: 2300,
			tokens: 30,
			arm: "qa_sol6",
			assignedModel: "gpt-6-sol",
			vendor: "codex",
		});
		const degradation = {
			schemaVersion: 1,
			runId: "run-e2",
			nodeId: "implement",
			activationId: recovered.activation,
			assignmentEventUid: recovered.assignment,
			arm: "impl_sol56",
			degraded: true,
			assignedModel: "gpt-5.6-sol",
			actualModel: "claude-opus-5",
			reason: "codex_pool_exhausted",
			degradedAt: "1970-01-01T00:00:01.500Z",
		};
		for (const seq of [2, 3])
			db.prepare(
				"INSERT INTO workflow_run_event VALUES ('run-e2', ?, ?, 'model_arm_degraded', 'implement', NULL, 'exec-e2-impl', ?, ?)",
			).run(
				seq,
				`model_arm_degraded:run-e2:implement:${recovered.activation}`,
				JSON.stringify(degradation),
				"1970-01-01T00:00:01.500Z",
			);
		db.prepare(
			"INSERT INTO workflow_claims VALUES ('run-e2', 'qa_verdict', 'qa_passed', 999, '1970-01-01T00:00:02.300Z')",
		).run();
		db.prepare(
			"INSERT INTO workflow_gate_holder VALUES ('run-e2', 'question-e', '1970-01-01T00:00:02.200Z')",
		).run();
		db.prepare(
			"INSERT INTO ship_judgment_outcome VALUES ('founder-e', 'question-e', 'run-e2', 'founder_verified', 'approved', '1970-01-01T00:00:02.300Z', '1970-01-01T00:00:02.400Z')",
		).run();
		db.close();

		let stdout = "";
		expect(
			runWorkflowScorecardCli(
				[
					"issue",
					"--db",
					path,
					"--project",
					"flywheel",
					"--issue",
					"FLY-E",
					"--from",
					"1970-01-01T00:00:00.000Z",
					"--to",
					"1970-01-01T00:00:03.000Z",
					"--as-of",
					"2026-09-24T00:00:00.000Z",
					"--format",
					"json",
					"--dry-run",
				],
				{
					stdout: (value) => {
						stdout += value;
					},
					stderr: () => {},
				},
			),
		).toBe(0);
		expect(JSON.parse(stdout).issues[0]).toMatchObject({
			issueId: "FLY-E",
			runIds: expect.arrayContaining(["run-e1", "run-e2"]),
			qaFirstPass: true,
			founderRejectCount: 0,
			totalTokens: 120,
			nodeWorkMs: 1300,
			elapsedMs: 2300,
			degraded: true,
		});
	});

	it("filters QA-exempt issues only when explicitly requested", () => {
		const path = fixture();
		const db = new BetterSqlite3(path);
		db.prepare(
			"DELETE FROM workflow_claims WHERE workflow_run_id = 'run-b'",
		).run();
		db.prepare(
			"INSERT INTO workflow_claims VALUES ('run-b', 'qa_policy', 'qa_exempt', 25, '2026-09-23T04:10:00.000Z')",
		).run();
		db.close();
		let stdout = "";
		expect(
			runWorkflowScorecardCli(
				[
					"report",
					"--db",
					path,
					"--project",
					"flywheel",
					"--from",
					"1970-01-01T00:00:00.000Z",
					"--to",
					"1970-01-01T00:00:03.000Z",
					"--as-of",
					"2026-09-24T00:00:00.000Z",
					"--qa",
					"eligible",
					"--format",
					"json",
					"--dry-run",
				],
				{
					stdout: (value) => {
						stdout += value;
					},
					stderr: () => {},
				},
			),
		).toBe(0);
		const report = JSON.parse(stdout);
		expect(report).toMatchObject({ issueCount: 2, qaFilter: "eligible" });
		expect(
			report.issues.map((issue: { issueId: string }) => issue.issueId),
		).toEqual(["FLY-1", "FLY-3"]);
	});

	it("coalesces redispatched runs through the canonical issue alias ledger", () => {
		const path = fixture();
		const db = new BetterSqlite3(path);
		const canonicalIssueId = "11111111-1111-4111-8111-111111111111";
		db.prepare(
			"UPDATE workflow_run SET issue_id = ? WHERE run_id = 'run-b'",
		).run(canonicalIssueId);
		db.prepare(
			"DELETE FROM workflow_run_event WHERE run_id = 'run-b' AND kind = 'model_arm_assigned'",
		).run();
		for (const [runId, alias] of [
			["run-a", "FLY-1"],
			["run-a", canonicalIssueId],
			["run-b", "FLY-1"],
			["run-b", canonicalIssueId],
		] as const)
			db.prepare("INSERT INTO workflow_run_issue_alias VALUES (?, ?)").run(
				runId,
				alias,
			);
		db.close();

		let stdout = "";
		expect(
			runWorkflowScorecardCli(
				[
					"report",
					"--db",
					path,
					"--project",
					"flywheel",
					"--from",
					"1970-01-01T00:00:00.000Z",
					"--to",
					"1970-01-01T00:00:03.000Z",
					"--as-of",
					"2026-09-24T00:00:00.000Z",
					"--format",
					"json",
					"--dry-run",
				],
				{
					stdout: (value) => {
						stdout += value;
					},
					stderr: () => {},
				},
			),
		).toBe(0);
		const report = JSON.parse(stdout);
		expect(report).toMatchObject({ issueCount: 2 });
		expect(
			report.issues.find(
				(issue: { canonicalIssueId: string }) =>
					issue.canonicalIssueId === canonicalIssueId,
			),
		).toMatchObject({
			issueId: "FLY-1",
			canonicalIssueId,
			runIds: expect.arrayContaining(["run-a", "run-b"]),
			groups: { implement: "mixed" },
		});
	});

	it("fails visibly without creating a missing scorecard schema", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2789-empty-cli-"));
		cleanups.push(dir);
		const path = join(dir, "empty.db");
		new BetterSqlite3(path).close();
		let stderr = "";
		expect(
			runWorkflowScorecardCli(
				["report", "--db", path, "--project", "flywheel", "--dry-run"],
				{
					stdout: () => {},
					stderr: (value) => {
						stderr += value;
					},
				},
			),
		).toBe(1);
		expect(stderr).toBe("unavailable_schema\n");
		const db = new BetterSqlite3(path, { readonly: true });
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE name LIKE 'workflow_scorecard_%'",
				)
				.all(),
		).toEqual([]);
		db.close();
	});
});

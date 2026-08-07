import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { canonicalSubmissionDigest } from "flywheel-config";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";

const REWORK_1150 = {
	requestId:
		"rework:389336410732ec77c7b16fc53114f666d943e484d2aabbc8e0024621cb5ae8af",
	runId: "d015ad38-85db-454a-b1aa-2bf3fd4e141e",
	executionId: "0555207c-e0c4-494c-95ef-b5361cca4724",
	issueId: "FLY-1150",
};
const REWORK_1596 = {
	requestId:
		"rework:e26a21d89749cb7c2626d64ba74569c03ef31fece9003859f896d94e6fb5ef67",
	runId: "9c785ed9-a3a2-4182-b5d8-7c59758174e3",
	executionId: "695938e5-7284-4fcb-9a7c-b0e05580c94b",
	issueId: "FLY-1596",
};
const GATE_1596 = {
	questionId:
		"workflow-gate:821322f6a508d3602064a49131a0030c3ef22abae2cd4b8475512f70eb3b2b4c",
	runId: "fee58f20-3e30-4a53-932b-a5dd0f001395",
	executionId: "37282acb-c3b2-4e23-84ca-047ce5873f4a",
	headSha: "f95c4b4236c39d3289d9de3731ad8877a515f27d",
};

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function testDb(store: StateStore): {
	run(sql: string, params?: unknown[]): void;
} {
	return (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
}

function snapshot(root: string): string {
	mkdirSync(join(root, "agents"), { recursive: true });
	writeFileSync(join(root, "agents", "generic.md"), "Execute safely.\n");
	return JSON.stringify(
		buildWorkflowRunSnapshotV2({
			template: { id: "tpl-fly1648-fixture", revision: 1 },
			canonicalRoot: root,
			manifest: {
				schema_version: 2,
				nodes: [
					{
						id: "implement",
						type: "generic",
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "low",
						agent_file: "agents/generic.md",
						produces_output: true,
						output: { schema: "json_v1", max_bytes: 256 },
					},
					{ id: "founder_gate", type: "gate" },
				],
				edges: [
					{
						id: "implemented",
						from: "implement",
						to: "founder_gate",
						condition: "node_done",
					},
				],
				loops: [],
				terminal_gate: {
					node: "founder_gate",
					predicate: "founder_approved",
				},
				ship_claims: ["founder_approved"],
			},
		}),
	);
}

function seedHeldRework(
	store: StateStore,
	snapshotJson: string,
	input: typeof REWORK_1150,
): void {
	store.createWorkflowRun({
		runId: input.runId,
		issueId: input.issueId,
		projectName: "flywheel",
		snapshotJson,
		claimsReadEnrolled: true,
	});
	const db = testDb(store);
	db.run(
		"UPDATE workflow_run SET engine_owned = 1, status = 'held', current_node_id = 'implement' WHERE run_id = ?",
		[input.runId],
	);
	db.run(
		`INSERT INTO workflow_actor
		   (execution_id, project_name, issue_id, role, created_at)
		 VALUES (?, 'flywheel', ?, 'engineer-executor', '2026-08-06T18:00:00.000Z')`,
		[input.executionId, input.issueId],
	);
	store.upsertWorkflowRunNode({
		runId: input.runId,
		nodeId: "implement",
		attempt: 2,
		state: "failed",
		executionId: input.executionId,
	});
	db.run(
		`INSERT INTO workflow_rework_request
		   (request_id, run_id, source_event_id, authority, source_node_id,
		    source_attempt, base_revision, authority_context_json,
		    authority_context_digest, requested_at)
		 VALUES (?, ?, ?, 'qa', 'qa', 1, ?, '{}', ?, '2026-08-06T18:01:00.000Z')`,
		[
			input.requestId,
			input.runId,
			`fixture-source:${input.requestId}`,
			"a".repeat(40),
			"b".repeat(64),
		],
	);
	db.run(
		`INSERT INTO workflow_rework_route_revision
		   (request_id, revision, target_node_id, target_attempt,
		    preferred_actor_execution_id, invalidation_scope_json,
		    verification_policy_json, interpreted_by, interpretation_reason, created_at)
		 VALUES (?, 1, 'implement', 2, ?, '[]', '{}', 'fixture', 'fixture',
		         '2026-08-06T18:01:00.000Z')`,
		[input.requestId, input.executionId],
	);
	db.run(
		`INSERT INTO workflow_rework_delivery
		   (request_id, route_revision, state, hold_count, next_retry_at, last_error, updated_at)
		 VALUES (?, 1, 'held', 0, NULL, 'persisted_target_missing',
		         '2026-08-06T18:02:00.000Z')`,
		[input.requestId],
	);
	db.run(
		`INSERT INTO workflow_rework_verification_path
		   (request_id, run_id, route_revision, state, current_node_id,
		    current_attempt, updated_at)
		 VALUES (?, ?, 1, 'active', 'implement', 2, '2026-08-06T18:02:00.000Z')`,
		[input.requestId, input.runId],
	);
}

function seedBlockedApprovedGate(
	store: StateStore,
	snapshotJson: string,
): void {
	store.createWorkflowRun({
		runId: GATE_1596.runId,
		issueId: "FLY-1596",
		projectName: "flywheel",
		snapshotJson,
		claimsReadEnrolled: true,
		gateCarrierEpoch: 1,
	});
	const db = testDb(store);
	db.run(
		"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'founder_gate' WHERE run_id = ?",
		[GATE_1596.runId],
	);
	store.upsertWorkflowRunNode({
		runId: GATE_1596.runId,
		nodeId: "founder_gate",
		attempt: 1,
		state: "review",
		executionId: GATE_1596.executionId,
	});
	store.upsertSession({
		execution_id: GATE_1596.executionId,
		issue_id: "FLY-1596",
		project_name: "flywheel",
		status: "awaiting_review",
		pr_number: 778,
	});
	db.run(
		`INSERT INTO workflow_gate_holder
		   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
		    question_id, authority_mode, subject_kind, carrier_binding_state,
		    card_message_id, state, materialization_stage, created_at, updated_at)
		 VALUES (?, 'founder_gate', 1, ?, ?, ?, 'runner_ship', 'git_head', 'bound',
		         'fixture-card', 'awaiting_review', 'completed',
		         '2026-08-06T18:05:00.000Z', '2026-08-06T18:05:00.000Z')`,
		[
			GATE_1596.runId,
			GATE_1596.headSha,
			GATE_1596.executionId,
			GATE_1596.questionId,
		],
	);
	store.setReviewBinding(GATE_1596.executionId, {
		questionId: GATE_1596.questionId,
		prHeadSha: GATE_1596.headSha,
		shipTarget: {
			runId: GATE_1596.runId,
			targetRepoPath: "/tmp/fly1648-fixture",
			targetRepoIdentity: "__main__",
			probeRepoSlug: "xrliAnnie/flywheel",
			worktreeBindingGeneration: "fixture-generation",
		},
	});
	const founderPayload = {
		schema_version: 1,
		run_id: GATE_1596.runId,
		issue_id: "FLY-1596",
		question_id: GATE_1596.questionId,
		response: { approved: true },
		actor: "founder",
		approved_head: GATE_1596.headSha,
		classification: "founder_direct_signal",
		authority_id: GATE_1596.questionId,
	};
	expect(
		store.applyWorkflowSourceEvent({
			project: "flywheel",
			sourceEventId: "fixture-founder-approval",
			kind: "founder_approval",
			schemaVersion: 1,
			payloadJson: JSON.stringify(founderPayload),
			payloadDigest: canonicalSubmissionDigest(founderPayload),
		}),
	).toMatchObject({ kind: "founder_claim", status: "applied" });
	expect(
		store.recordRunnerShipMergedObserved({
			questionId: GATE_1596.questionId,
			expectedHolderState: "approved",
			expectedHolderHead: GATE_1596.headSha,
			expectedAuthority: {
				repoIdentity: "__main__",
				probeRepoSlug: "xrliAnnie/flywheel",
				prNumber: 778,
			},
			mergedHead: GATE_1596.headSha,
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			now: "2026-08-06T18:10:00.000Z",
		}),
	).toEqual({ status: "persisted" });
	db.run(
		`UPDATE sessions
		 SET status = 'blocked', terminal_at = '2026-08-06T18:11:00.000Z'
		 WHERE execution_id = ?`,
		[GATE_1596.executionId],
	);
}

function runCloseout(repoRoot: string, dbPath: string, args: string[]) {
	return JSON.parse(
		execFileSync(
			"node",
			[
				join(repoRoot, "scripts", "fly-1648-hot-loop-closeout.mjs"),
				"--db",
				dbPath,
				...args,
			],
			{ cwd: repoRoot, encoding: "utf8" },
		),
	) as {
		mode: string;
		connection: {
			readonly: boolean;
			journalMode: string;
			foreignKeys: number;
			busyTimeoutMs: number;
		};
		preflight: Array<{ id: string; status: string }>;
		results?: Array<{ id: string; result: string }>;
		after?: Array<{ id: string; status: string }>;
		backupPath?: string;
		integrityBaseline: {
			quickCheck: unknown[];
			foreignKeyViolations: unknown[];
		};
		integrity?: { quickCheck: unknown[]; foreignKeyViolations: unknown[] };
		integrityUnchanged?: boolean;
	};
}

describe("FLY-1648 hot-loop closeout maintenance command", () => {
	it("fails closed without creating a missing database and rejects schema drift", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1648-closeout-preflight-"));
		roots.push(root);
		const repoRoot = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../../../..",
		);
		const script = join(repoRoot, "scripts", "fly-1648-hot-loop-closeout.mjs");
		const args = ["--retire-held-rework", REWORK_1150.requestId];
		const missing = join(root, "missing.db");
		const missingResult = spawnSync(
			"node",
			[script, "--db", missing, ...args],
			{ cwd: repoRoot, encoding: "utf8" },
		);
		expect(missingResult.status).toBe(1);
		expect(missingResult.stderr).toContain("maintenance_database_missing");
		expect(existsSync(missing)).toBe(false);

		const drifted = join(root, "drifted.db");
		const raw = new Database(drifted);
		raw.pragma("journal_mode = WAL");
		raw.exec("CREATE TABLE workflow_run (run_id TEXT PRIMARY KEY)");
		raw.close();
		const driftResult = spawnSync("node", [script, "--db", drifted, ...args], {
			cwd: repoRoot,
			encoding: "utf8",
		});
		expect(driftResult.status).toBe(1);
		expect(driftResult.stderr).toContain("maintenance_schema_mismatch");
	});

	it("dry-runs readonly, applies partial batches safely, and replays idempotently", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1648-closeout-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const snapshotJson = snapshot(join(root, "snapshot"));
		const store = await StateStore.create(dbPath);
		seedHeldRework(store, snapshotJson, REWORK_1150);
		seedHeldRework(store, snapshotJson, REWORK_1596);
		seedBlockedApprovedGate(store, snapshotJson);
		store.close();
		const baselineDb = new Database(dbPath);
		baselineDb.pragma("foreign_keys = OFF");
		baselineDb.exec(`
			CREATE TABLE fly1648_baseline_parent (id INTEGER PRIMARY KEY);
			CREATE TABLE fly1648_baseline_child (
				id INTEGER PRIMARY KEY,
				parent_id INTEGER REFERENCES fly1648_baseline_parent(id)
			);
			INSERT INTO fly1648_baseline_child (id, parent_id) VALUES (1, 99);
		`);
		baselineDb.close();

		const repoRoot = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../../../..",
		);
		const allTargets = [
			"--retire-held-rework",
			REWORK_1150.requestId,
			"--retire-held-rework",
			REWORK_1596.requestId,
			"--complete-gate",
			GATE_1596.questionId,
		];
		const dryRun = runCloseout(repoRoot, dbPath, allTargets);
		expect(dryRun.mode).toBe("dry-run");
		expect(dryRun.connection).toEqual({
			readonly: true,
			journalMode: "wal",
			foreignKeys: 1,
			busyTimeoutMs: 5000,
		});
		expect(dryRun.integrityBaseline).toEqual({
			quickCheck: [{ quick_check: "ok" }],
			foreignKeyViolations: [
				{
					table: "fly1648_baseline_child",
					rowid: 1,
					parent: "fly1648_baseline_parent",
					fkid: 0,
				},
			],
		});
		expect(dryRun.preflight.map(({ id, status }) => ({ id, status }))).toEqual(
			allTargets
				.filter(
					(value) =>
						value.startsWith("rework:") || value.startsWith("workflow-gate:"),
				)
				.map((id) => ({ id, status: "ready" })),
		);
		expect(existsSync(join(root, "backups"))).toBe(false);

		const readonly = await StateStore.openForMaintenance(dbPath, {
			readonly: true,
		});
		expect(
			readonly.getWorkflowReworkDelivery(REWORK_1150.requestId),
		).toMatchObject({ state: "held", hold_count: 0 });
		expect(readonly.getWorkflowRun(GATE_1596.runId)?.status).toBe("active");
		readonly.close();

		const first = runCloseout(repoRoot, dbPath, [
			"--apply",
			"--retire-held-rework",
			REWORK_1150.requestId,
		]);
		expect(first.results).toEqual([
			expect.objectContaining({ id: REWORK_1150.requestId, result: "applied" }),
		]);
		expect(first.backupPath && existsSync(first.backupPath)).toBe(true);

		const partialReplay = runCloseout(repoRoot, dbPath, [
			"--apply",
			...allTargets,
		]);
		expect(partialReplay.results).toEqual([
			expect.objectContaining({ id: REWORK_1150.requestId, result: "skipped" }),
			expect.objectContaining({ id: REWORK_1596.requestId, result: "applied" }),
			expect.objectContaining({ id: GATE_1596.questionId, result: "applied" }),
		]);
		expect(partialReplay.after).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: REWORK_1150.requestId,
					status: "already_applied",
				}),
				expect.objectContaining({
					id: REWORK_1596.requestId,
					status: "already_applied",
				}),
				expect.objectContaining({
					id: GATE_1596.questionId,
					status: "already_applied",
				}),
			]),
		);
		expect(partialReplay.integrity).toEqual({
			quickCheck: [{ quick_check: "ok" }],
			foreignKeyViolations: dryRun.integrityBaseline.foreignKeyViolations,
		});
		expect(partialReplay.integrityUnchanged).toBe(true);

		const replay = runCloseout(repoRoot, dbPath, ["--apply", ...allTargets]);
		expect(replay.results?.map(({ result }) => result)).toEqual([
			"skipped",
			"skipped",
			"skipped",
		]);
	}, 60_000);

	it("keeps the operator gate compatible with evidence-backed self-healing and an FK baseline", () => {
		const repoRoot = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../../../..",
		);
		const runbook = readFileSync(
			join(repoRoot, "engineering/doc/FLY-1648-hot-loop-closeout/runbook.md"),
			"utf8",
		);
		expect(runbook).toContain(".connection.foreignKeys == 1");
		expect(runbook).toContain(".connection.busyTimeoutMs == 5000");
		expect(runbook).toContain(
			'(.status == "ready" or .status == "already_applied")',
		);
		expect(runbook).toContain("sort_by([.table, .rowid, .parent, .fkid])");
		expect(runbook).toContain(".integrityUnchanged == true");
		expect(runbook).toContain("full-database `PRAGMA quick_check`");
	});
});

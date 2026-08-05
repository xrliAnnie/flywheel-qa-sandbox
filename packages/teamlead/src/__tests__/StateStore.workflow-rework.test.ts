import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";
import { loadBundledWorkflowSeeds } from "../workflow-template.js";

const enabled = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function createEngineRun(store: StateStore, runId = "run-rework") {
	const root = mkdtempSync(join(tmpdir(), "fly1423-rework-"));
	roots.push(root);
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Execute safely.\n");
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: "tpl-rework", revision: 1 },
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
	});
	store.createWorkflowRun({
		runId,
		issueId: "FLY-1423",
		projectName: "flywheel",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: true,
	});
	const db = (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
	db.run("UPDATE workflow_run SET engine_owned = 1 WHERE run_id = ?", [runId]);
}

function admit(
	store: StateStore,
	input: {
		attempt: number;
		activationId: string;
		mode: "spawn" | "wake" | "replacement";
		reworkRequestId?: string;
	},
) {
	return store.admitGeneralizedWorkflowExecution({
		runId: "run-rework",
		nodeId: "implement",
		executionId: "implement-exec",
		attempt: input.attempt,
		activationId: input.activationId,
		activationMode: input.mode,
		reworkRequestId: input.reworkRequestId,
		expiresAt: "2026-07-23T01:00:00.000Z",
		absoluteDeadlineAt: "2026-07-24T00:00:00.000Z",
		now: "2026-07-23T00:00:00.000Z",
		env: enabled,
	});
}

async function createHeavyEngineRun(dbPath = ":memory:"): Promise<StateStore> {
	const store = await StateStore.create(dbPath);
	const seed = loadBundledWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	);
	if (!seed) throw new Error("tpl_eng_heavy seed missing");
	store.importWorkflowTemplateSeed(seed);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		updatedBy: "lead",
	});
	store.materializeWorkflowRun({
		runId: "run-heavy",
		issueId: "FLY-1423",
		projectName: "flywheel",
		taskCategory: "code",
		claimsReadEnrolled: true,
		actor: "lead",
		env: enabled,
		startReservation: {
			idempotencyKey: "start-heavy",
			selectionDigest: "selection-heavy",
			nodeId: "design",
			attempt: 1,
			executionId: "design-exec",
			createdAt: "2026-07-23T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "run-heavy",
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-exec",
	});
	return store;
}

function advanceHeavy(
	store: StateStore,
	input: {
		nodeId: string;
		attempt: number;
		executionId: string;
		outcome: string;
		successorExecutionId?: string;
		subjectDigest?: string;
	},
) {
	return store.commitWorkflowTransitionTx({
		runId: "run-heavy",
		...input,
		now: "2026-07-23T00:10:00.000Z",
	});
}

describe("FLY-1423 stable workflow actor activations", () => {
	it("admits attempt 2 on the same execution as a distinct exact activation", async () => {
		const store = await StateStore.create(":memory:");
		try {
			createEngineRun(store);
			expect(
				admit(store, {
					attempt: 1,
					activationId: "activation-1",
					mode: "spawn",
				}),
			).toMatchObject({ ok: true, activationId: "activation-1" });
			store.upsertWorkflowRunNode({
				runId: "run-rework",
				nodeId: "implement",
				attempt: 2,
				state: "pending",
				executionId: "implement-exec",
			});

			expect(
				admit(store, {
					attempt: 2,
					activationId: "activation-2",
					mode: "wake",
					reworkRequestId: "rework-1",
				}),
			).toMatchObject({ ok: true, activationId: "activation-2" });

			expect(store.getWorkflowActor("implement-exec")).toMatchObject({
				execution_id: "implement-exec",
				project_name: "flywheel",
				issue_id: "FLY-1423",
				role: "implement",
			});
			expect(store.listWorkflowActivationsForActor("implement-exec")).toEqual([
				expect.objectContaining({
					activation_id: "activation-1",
					attempt: 1,
					mode: "spawn",
				}),
				expect.objectContaining({
					activation_id: "activation-2",
					attempt: 2,
					mode: "wake",
					rework_request_id: "rework-1",
				}),
			]);
			expect(
				store.getWorkflowActivationForAttempt({
					executionId: "implement-exec",
					runId: "run-rework",
					nodeId: "implement",
					attempt: 2,
				}),
			).toMatchObject({ activation_id: "activation-2" });
		} finally {
			store.close();
		}
	});

	it("keys every attempt-scoped credential and receipt table to activation_id", async () => {
		const store = await StateStore.create(":memory:");
		try {
			createEngineRun(store);
			expect(
				admit(store, {
					attempt: 1,
					activationId: "activation-1",
					mode: "spawn",
				}),
			).toMatchObject({ ok: true });
			store.upsertWorkflowRunNode({
				runId: "run-rework",
				nodeId: "implement",
				attempt: 2,
				state: "pending",
				executionId: "implement-exec",
			});
			expect(
				admit(store, {
					attempt: 2,
					activationId: "activation-2",
					mode: "wake",
					reworkRequestId: "rework-1",
				}),
			).toMatchObject({ ok: true });

			const raw = (store as unknown as { db: { raw: Database.Database } }).db
				.raw;
			for (const table of [
				"workflow_submission_credential",
				"workflow_output_credential",
				"workflow_node_outputs",
				"workflow_node_completion",
			]) {
				const columns = raw
					.prepare(`PRAGMA table_info(${table})`)
					.all() as Array<{
					name: string;
					notnull: number;
				}>;
				expect(columns, table).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							name: "activation_id",
							// Pre-activation completion receipts remain replayable; all newly
							// written receipts still carry an exact activation and FK.
							notnull: table === "workflow_node_completion" ? 0 : 1,
						}),
					]),
				);
				const foreignKeys = raw
					.prepare(`PRAGMA foreign_key_list(${table})`)
					.all() as Array<{ table: string; to: string }>;
				expect(foreignKeys, table).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							table: "workflow_execution_binding",
							to: "activation_id",
						}),
					]),
				);
			}
			expect(
				raw
					.prepare(
						"SELECT activation_id, attempt FROM workflow_output_credential ORDER BY attempt",
					)
					.all(),
			).toEqual([
				{ activation_id: "activation-1", attempt: 1 },
				{ activation_id: "activation-2", attempt: 2 },
			]);
		} finally {
			store.close();
		}
	});

	it("backs up and migrates a legacy binding to an actor plus immutable activation", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1423-migration-"));
		roots.push(root);
		const dbPath = join(root, "state.db");
		const original = await StateStore.create(dbPath);
		createEngineRun(original);
		expect(
			admit(original, {
				attempt: 1,
				activationId: "discarded-by-legacy-fixture",
				mode: "spawn",
			}),
		).toMatchObject({ ok: true });
		original.close();

		const raw = new Database(dbPath);
		const columns = raw
			.prepare("PRAGMA table_info(workflow_execution_binding)")
			.all() as Array<{ name: string }>;
		if (columns.some((column) => column.name === "activation_id")) {
			raw.pragma("foreign_keys = OFF");
			raw.exec(`
				DROP TRIGGER IF EXISTS workflow_execution_binding_no_update;
				DROP TRIGGER IF EXISTS workflow_execution_binding_no_delete;
				CREATE TABLE workflow_execution_binding_legacy_fixture (
					execution_id TEXT PRIMARY KEY,
					run_id TEXT NOT NULL,
					node_id TEXT NOT NULL,
					attempt INTEGER NOT NULL CHECK (attempt > 0),
					bound_at TEXT NOT NULL,
					UNIQUE (execution_id, run_id, node_id, attempt)
				);
				INSERT INTO workflow_execution_binding_legacy_fixture
					(execution_id, run_id, node_id, attempt, bound_at)
				SELECT execution_id, run_id, node_id, attempt, bound_at
				  FROM workflow_execution_binding;
				DROP TABLE workflow_execution_binding;
				ALTER TABLE workflow_execution_binding_legacy_fixture
					RENAME TO workflow_execution_binding;
				DROP TABLE workflow_actor;
			`);
		}
		raw.close();

		const migrated = await StateStore.create(dbPath);
		try {
			expect(existsSync(`${dbPath}.pre-fly1423.bak`)).toBe(true);
			expect(migrated.getWorkflowActor("implement-exec")).toMatchObject({
				execution_id: "implement-exec",
				project_name: "flywheel",
				issue_id: "FLY-1423",
				role: "implement",
			});
			expect(
				migrated.listWorkflowActivationsForActor("implement-exec"),
			).toEqual([
				expect.objectContaining({
					activation_id: "legacy:implement-exec:run-rework:implement:1",
					attempt: 1,
					mode: "spawn",
				}),
			]);
			const migratedRaw = (
				migrated as unknown as { db: { raw: Database.Database } }
			).db.raw;
			expect(
				migratedRaw
					.prepare(
						"SELECT activation_id FROM workflow_output_credential WHERE execution_id = 'implement-exec'",
					)
					.get(),
			).toEqual({
				activation_id: "legacy:implement-exec:run-rework:implement:1",
			});
			const db = (
				migrated as unknown as {
					db: { raw: { pragma(sql: string): unknown } };
				}
			).db;
			expect(db.raw.pragma("foreign_key_check")).toEqual([]);
		} finally {
			migrated.close();
		}
	});
});

describe("FLY-1423 durable unified rework request", () => {
	it("rebuilds every legacy delivery state with budget columns exactly once", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1638-rework-migration-"));
		roots.push(root);
		const dbPath = join(root, "state.db");
		const original = await createHeavyEngineRun(dbPath);
		advanceHeavy(original, {
			nodeId: "design",
			attempt: 1,
			executionId: "design-exec",
			outcome: "design_done",
			successorExecutionId: "implement-exec",
		});
		advanceHeavy(original, {
			nodeId: "implement",
			attempt: 1,
			executionId: "implement-exec",
			outcome: "implement_done",
			successorExecutionId: "qa-exec",
		});
		const failed = advanceHeavy(original, {
			nodeId: "qa",
			attempt: 1,
			executionId: "qa-exec",
			outcome: "qa_fail",
			subjectDigest: "a".repeat(40),
		});
		if (!failed.ok || !failed.reworkRequestId) {
			throw new Error("migration rework request missing");
		}
		original.close();

		const states = [
			"pending",
			"turn_granted",
			"wake_delivered",
			"replacement_pending",
			"completed",
			"held",
		] as const;
		const raw = new Database(dbPath);
		raw.pragma("foreign_keys = OFF");
		for (const [index, state] of states.entries()) {
			const requestId = `legacy-${state}`;
			raw
				.prepare(
					`INSERT INTO workflow_rework_request
				   (request_id, run_id, source_event_id, authority, source_node_id,
				    source_attempt, base_revision, authority_context_json,
				    authority_context_digest, founder_feedback_verbatim, requested_at)
				 SELECT ?, run_id, ?, authority, source_node_id, source_attempt,
				        base_revision, authority_context_json, authority_context_digest,
				        founder_feedback_verbatim, requested_at
				   FROM workflow_rework_request WHERE request_id = ?`,
				)
				.run(requestId, `legacy-source-${index}`, failed.reworkRequestId);
			raw
				.prepare(
					`INSERT INTO workflow_rework_route_revision
				   (request_id, revision, target_node_id, target_attempt,
				    preferred_actor_execution_id, invalidation_scope_json,
				    verification_policy_json, interpreted_by,
				    interpretation_reason, created_at)
				 SELECT ?, revision, target_node_id, target_attempt,
				        preferred_actor_execution_id, invalidation_scope_json,
				        verification_policy_json, interpreted_by,
				        interpretation_reason, created_at
				   FROM workflow_rework_route_revision
				  WHERE request_id = ? AND revision = 1`,
				)
				.run(requestId, failed.reworkRequestId);
		}
		raw.exec(`
			DROP TABLE workflow_rework_delivery;
			CREATE TABLE workflow_rework_delivery (
				request_id TEXT PRIMARY KEY,
				owner_id TEXT,
				generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
				lease_expires_at TEXT,
				route_revision INTEGER NOT NULL CHECK (route_revision > 0),
				state TEXT NOT NULL CHECK (state IN
				 ('pending','turn_granted','wake_delivered','replacement_pending','completed','held')),
				last_error TEXT,
				updated_at TEXT NOT NULL,
				FOREIGN KEY (request_id, route_revision)
					REFERENCES workflow_rework_route_revision(request_id, revision)
			);
		`);
		for (const state of states) {
			raw
				.prepare(
					`INSERT INTO workflow_rework_delivery
				   (request_id, route_revision, state, updated_at)
				 VALUES (?, 1, ?, '2026-07-23T00:10:00.000Z')`,
				)
				.run(`legacy-${state}`, state);
		}
		raw.close();

		for (let boot = 0; boot < 2; boot += 1) {
			const migrated = await StateStore.create(dbPath);
			for (const state of states) {
				expect(
					migrated.getWorkflowReworkDelivery(`legacy-${state}`),
				).toMatchObject({
					state,
					hold_count: 0,
					next_retry_at: null,
					grant_started_at: null,
				});
			}
			const db = (migrated as unknown as { db: { raw: Database.Database } }).db
				.raw;
			expect(db.pragma("foreign_key_check")).toEqual([]);
			migrated.close();
		}
	});

	it("reopens a completed run into one idempotent operator rework attempt", async () => {
		const store = await createHeavyEngineRun();
		try {
			expect(
				advanceHeavy(store, {
					nodeId: "design",
					attempt: 1,
					executionId: "design-exec",
					outcome: "design_done",
					successorExecutionId: "implement-exec",
				}),
			).toMatchObject({ ok: true });
			store.upsertWorkflowRunNode({
				runId: "run-heavy",
				nodeId: "implement",
				attempt: 1,
				state: "done",
				executionId: "implement-exec",
				endedAt: "2026-07-23T00:09:00.000Z",
			});
			const db = (
				store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			db.run("UPDATE workflow_run SET status = 'completed' WHERE run_id = ?", [
				"run-heavy",
			]);
			const evidence = store
				.listRunAttributedExecutions("run-heavy")
				.map((executionId) => ({
					executionId,
					sessionStatus: null,
					lifecycleRevision: null,
					liveness: "dead" as const,
					observedAt: "2026-07-23T00:10:00.000Z",
				}));
			const input = {
				runId: "run-heavy",
				targetNodeId: "implement",
				feedback: "rework the implementation",
				clientRequestId: "operator-rework-1",
				principal: "master",
				evidence,
				now: "2026-07-23T00:10:00.000Z",
			};

			const opened = store.openOperatorRework(input);

			expect(opened).toMatchObject({
				ok: true,
				idempotentReplay: false,
				targetNodeId: "implement",
				targetAttempt: 2,
				preferredActorExecutionId: "implement-exec",
				requestId: expect.stringMatching(/^rework:/),
			});
			if (!opened.ok) throw new Error(opened.reason);
			expect(store.getWorkflowRun("run-heavy")).toMatchObject({
				status: "active",
				current_node_id: "implement",
			});
			expect(
				store.getWorkflowRunNode("run-heavy", "implement", 2),
			).toMatchObject({
				state: "pending",
				execution_id: "implement-exec",
			});
			expect(store.getWorkflowReworkRequest(opened.requestId)).toMatchObject({
				source_event_id: "operator_rework:run-heavy:operator-rework-1",
				founder_feedback_verbatim: "rework the implementation",
			});
			expect(store.getWorkflowReworkDelivery(opened.requestId)).toMatchObject({
				state: "pending",
			});
			expect(
				store.listWorkflowRunEvents("run-heavy").map((event) => event.kind),
			).toEqual(
				expect.arrayContaining(["operator_rework_requested", "run_reopened"]),
			);

			expect(store.openOperatorRework(input)).toEqual({
				...opened,
				idempotentReplay: true,
			});
		} finally {
			store.close();
		}
	});

	it("refuses operator rework without a historical actor for the target node", async () => {
		const store = await createHeavyEngineRun();
		try {
			const result = store.openOperatorRework({
				runId: "run-heavy",
				targetNodeId: "implement",
				feedback: "start implementation",
				clientRequestId: "operator-rework-no-actor",
				principal: "master",
				evidence: store
					.listRunAttributedExecutions("run-heavy")
					.map((executionId) => ({
						executionId,
						sessionStatus: null,
						lifecycleRevision: null,
						liveness: "dead" as const,
						observedAt: "2026-07-23T00:10:00.000Z",
					})),
				now: "2026-07-23T00:10:00.000Z",
			});

			expect(result).toEqual({
				ok: false,
				reason: "target_actor_history_missing",
			});
		} finally {
			store.close();
		}
	});

	it("leases one pending rework delivery to exactly one coordinator owner", async () => {
		const store = await createHeavyEngineRun();
		try {
			expect(
				advanceHeavy(store, {
					nodeId: "design",
					attempt: 1,
					executionId: "design-exec",
					outcome: "design_done",
					successorExecutionId: "implement-exec",
				}),
			).toMatchObject({ ok: true });
			expect(
				advanceHeavy(store, {
					nodeId: "implement",
					attempt: 1,
					executionId: "implement-exec",
					outcome: "implement_done",
					successorExecutionId: "qa-exec",
				}),
			).toMatchObject({ ok: true });
			const failed = advanceHeavy(store, {
				nodeId: "qa",
				attempt: 1,
				executionId: "qa-exec",
				outcome: "qa_fail",
				subjectDigest: "a".repeat(40),
			});
			if (!failed.ok || !failed.reworkRequestId) {
				throw new Error("rework request not returned");
			}
			const ownerA = store.claimWorkflowReworkDelivery({
				requestId: failed.reworkRequestId,
				ownerId: "coordinator-a",
				now: "2026-07-23T00:11:00.000Z",
				leaseExpiresAt: "2026-07-23T00:12:00.000Z",
			});
			const ownerB = store.claimWorkflowReworkDelivery({
				requestId: failed.reworkRequestId,
				ownerId: "coordinator-b",
				now: "2026-07-23T00:11:00.000Z",
				leaseExpiresAt: "2026-07-23T00:12:00.000Z",
			});
			expect(ownerA).toEqual({
				ok: true,
				generation: 1,
				idempotentReplay: false,
			});
			expect(ownerB).toEqual({ ok: false, reason: "delivery_busy" });
			expect(
				store.releaseWorkflowReworkDelivery({
					requestId: failed.reworkRequestId,
					ownerId: "coordinator-a",
					generation: 1,
					error: "wake retry",
					now: "2026-07-23T00:11:30.000Z",
				}),
			).toEqual({ ok: true });
			expect(
				store.claimWorkflowReworkDelivery({
					requestId: failed.reworkRequestId,
					ownerId: "coordinator-b",
					now: "2026-07-23T00:11:31.000Z",
					leaseExpiresAt: "2026-07-23T00:12:31.000Z",
				}),
			).toEqual({
				ok: true,
				generation: 2,
				idempotentReplay: false,
			});
		} finally {
			store.close();
		}
	});

	it("backs off retryable rework failures and stops at five with one Lead alert", async () => {
		const store = await createHeavyEngineRun();
		try {
			advanceHeavy(store, {
				nodeId: "design",
				attempt: 1,
				executionId: "design-exec",
				outcome: "design_done",
				successorExecutionId: "implement-exec",
			});
			advanceHeavy(store, {
				nodeId: "implement",
				attempt: 1,
				executionId: "implement-exec",
				outcome: "implement_done",
				successorExecutionId: "qa-exec",
			});
			const failed = advanceHeavy(store, {
				nodeId: "qa",
				attempt: 1,
				executionId: "qa-exec",
				outcome: "qa_fail",
				subjectDigest: "a".repeat(40),
			});
			if (!failed.ok || !failed.reworkRequestId) {
				throw new Error("rework request not returned");
			}
			const times = [
				"2026-07-23T00:11:00.000Z",
				"2026-07-23T00:12:00.000Z",
				"2026-07-23T00:14:00.000Z",
				"2026-07-23T00:18:00.000Z",
				"2026-07-23T00:26:00.000Z",
			];
			const expectedNext = [
				"2026-07-23T00:12:00.000Z",
				"2026-07-23T00:14:00.000Z",
				"2026-07-23T00:18:00.000Z",
				"2026-07-23T00:26:00.000Z",
			];
			for (let index = 0; index < times.length; index += 1) {
				const claimed = store.claimWorkflowReworkDelivery({
					requestId: failed.reworkRequestId,
					ownerId: "coordinator",
					now: times[index]!,
					leaseExpiresAt: new Date(
						Date.parse(times[index]!) + 30_000,
					).toISOString(),
				});
				expect(claimed).toMatchObject({ ok: true });
				if (!claimed.ok) throw new Error(claimed.reason);
				const settled = store.settleWorkflowReworkFailure({
					requestId: failed.reworkRequestId,
					ownerId: "coordinator",
					generation: claimed.generation,
					reason: "actor_session_missing",
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
					now: times[index]!,
				});
				expect(settled).toMatchObject({
					ok: true,
					holdCount: index + 1,
					state: index === 4 ? "needs_lead" : "pending",
				});
				if (index < 4) {
					expect(settled).toMatchObject({ nextRetryAt: expectedNext[index] });
					expect(
						store.claimWorkflowReworkDelivery({
							requestId: failed.reworkRequestId,
							ownerId: "too-early",
							now: new Date(Date.parse(expectedNext[index]!) - 1).toISOString(),
							leaseExpiresAt: new Date(
								Date.parse(expectedNext[index]!) + 30_000,
							).toISOString(),
						}),
					).toEqual({ ok: false, reason: "delivery_backoff" });
				}
			}
			expect(
				store.getWorkflowReworkDelivery(failed.reworkRequestId),
			).toMatchObject({
				state: "needs_lead",
				hold_count: 5,
				next_retry_at: null,
			});
			expect(store.getWorkflowRun("run-heavy")?.status).toBe("held");
			expect(
				store.getWorkflowRunNode("run-heavy", "implement", 2),
			).toMatchObject({ state: "superseded" });
			expect(
				store.getWorkflowReworkVerificationPath(failed.reworkRequestId),
			).toMatchObject({ state: "needs_lead" });
			expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
			expect(
				store.listWorkflowAlertOutbox()[0]?.payload.metadata.workflowEngine,
			).toMatchObject({
				runId: "run-heavy",
				disposition: "rework_retry_exhausted",
			});
			expect(
				store.listWorkflowReworkDeliveries({ states: ["needs_lead"] }),
			).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	it("revokes an admitted activation before grant, but retains ambiguous grant-started work", async () => {
		for (const grantStarted of [false, true]) {
			const store = await createHeavyEngineRun();
			try {
				advanceHeavy(store, {
					nodeId: "design",
					attempt: 1,
					executionId: "design-exec",
					outcome: "design_done",
					successorExecutionId: "implement-exec",
				});
				advanceHeavy(store, {
					nodeId: "implement",
					attempt: 1,
					executionId: "implement-exec",
					outcome: "implement_done",
					successorExecutionId: "qa-exec",
				});
				const failed = advanceHeavy(store, {
					nodeId: "qa",
					attempt: 1,
					executionId: "qa-exec",
					outcome: "qa_fail",
					subjectDigest: "a".repeat(40),
				});
				if (!failed.ok || !failed.reworkRequestId) {
					throw new Error("rework request not returned");
				}
				const admission = store.admitGeneralizedWorkflowExecution({
					runId: "run-heavy",
					nodeId: "implement",
					executionId: "implement-exec",
					attempt: 2,
					activationId: `activation-budget-${grantStarted}`,
					activationMode: "wake",
					reworkRequestId: failed.reworkRequestId,
					expiresAt: "2026-07-23T02:00:00.000Z",
					absoluteDeadlineAt: "2026-07-24T00:00:00.000Z",
					now: "2026-07-23T00:10:00.000Z",
					env: enabled,
				});
				expect(admission).toMatchObject({ ok: true });
				const raw = (store as unknown as { db: { raw: Database.Database } }).db
					.raw;
				raw
					.prepare(
						`INSERT INTO workflow_output_credential
					   (activation_id, credential_hash, run_id, node_id, execution_id,
					    attempt, issued_at, expires_at, absolute_deadline_at)
					 VALUES (?, ?, 'run-heavy', 'implement', 'implement-exec', 2,
					         '2026-07-23T00:10:00.000Z', '2026-07-23T02:00:00.000Z',
					         '2026-07-24T00:00:00.000Z')`,
					)
					.run(
						`activation-budget-${grantStarted}`,
						`credential-budget-${grantStarted}`,
					);

				const times = [11, 12, 14, 18, 26].map(
					(minute) => `2026-07-23T00:${minute}:00.000Z`,
				);
				for (const [index, now] of times.entries()) {
					const claim = store.claimWorkflowReworkDelivery({
						requestId: failed.reworkRequestId,
						ownerId: "coordinator",
						now,
						leaseExpiresAt: new Date(Date.parse(now) + 30_000).toISOString(),
					});
					if (!claim.ok) throw new Error(claim.reason);
					if (grantStarted && index === 0) {
						expect(
							store.markWorkflowReworkGrantStarted({
								requestId: failed.reworkRequestId,
								ownerId: "coordinator",
								generation: claim.generation,
								now,
							}),
						).toEqual({ ok: true });
					}
					expect(
						store.settleWorkflowReworkFailure({
							requestId: failed.reworkRequestId,
							ownerId: "coordinator",
							generation: claim.generation,
							reason: "retryable_failure",
							alertIdentity: {
								leadId: "flywheel-eng-lead",
								projectName: "flywheel",
								leadResolution: "resolved",
							},
							now,
						}),
					).toMatchObject({ ok: true, holdCount: index + 1 });
				}

				expect(
					store.getWorkflowRunNode("run-heavy", "implement", 2),
				).toMatchObject({ state: grantStarted ? "admitted" : "superseded" });
				expect(
					store.getWorkflowReworkVerificationPath(failed.reworkRequestId),
				).toMatchObject({ state: grantStarted ? "pending" : "needs_lead" });
				expect(
					raw
						.prepare(
							"SELECT revoked FROM workflow_output_credential WHERE activation_id = ?",
						)
						.get(`activation-budget-${grantStarted}`),
				).toEqual({ revoked: grantStarted ? 0 : 1 });
			} finally {
				store.close();
			}
		}
	});

	it("lets an operator quiesce a grant-started needs_lead attempt before minting its successor", async () => {
		const store = await createHeavyEngineRun();
		try {
			advanceHeavy(store, {
				nodeId: "design",
				attempt: 1,
				executionId: "design-exec",
				outcome: "design_done",
				successorExecutionId: "implement-exec",
			});
			advanceHeavy(store, {
				nodeId: "implement",
				attempt: 1,
				executionId: "implement-exec",
				outcome: "implement_done",
				successorExecutionId: "qa-exec",
			});
			const failed = advanceHeavy(store, {
				nodeId: "qa",
				attempt: 1,
				executionId: "qa-exec",
				outcome: "qa_fail",
				subjectDigest: "a".repeat(40),
			});
			if (!failed.ok || !failed.reworkRequestId) {
				throw new Error("rework request not returned");
			}
			expect(
				store.admitGeneralizedWorkflowExecution({
					runId: "run-heavy",
					nodeId: "implement",
					executionId: "implement-exec",
					attempt: 2,
					activationId: "activation-needs-lead",
					activationMode: "wake",
					reworkRequestId: failed.reworkRequestId,
					expiresAt: "2026-07-23T02:00:00.000Z",
					absoluteDeadlineAt: "2026-07-24T00:00:00.000Z",
					now: "2026-07-23T00:10:00.000Z",
					env: enabled,
				}),
			).toMatchObject({ ok: true });
			const raw = (store as unknown as { db: { raw: Database.Database } }).db
				.raw;
			raw
				.prepare(
					`INSERT INTO workflow_output_credential
				   (activation_id, credential_hash, run_id, node_id, execution_id,
				    attempt, issued_at, expires_at, absolute_deadline_at)
				 VALUES ('activation-needs-lead', 'credential-needs-lead', 'run-heavy',
				         'implement', 'implement-exec', 2, '2026-07-23T00:10:00.000Z',
				         '2026-07-23T02:00:00.000Z', '2026-07-24T00:00:00.000Z')`,
				)
				.run();
			const times = [11, 12, 14, 18, 26].map(
				(minute) => `2026-07-23T00:${minute}:00.000Z`,
			);
			for (const [index, now] of times.entries()) {
				const claim = store.claimWorkflowReworkDelivery({
					requestId: failed.reworkRequestId,
					ownerId: "coordinator",
					now,
					leaseExpiresAt: new Date(Date.parse(now) + 30_000).toISOString(),
				});
				if (!claim.ok) throw new Error(claim.reason);
				if (index === 0) {
					store.markWorkflowReworkGrantStarted({
						requestId: failed.reworkRequestId,
						ownerId: "coordinator",
						generation: claim.generation,
						now,
					});
				}
				store.settleWorkflowReworkFailure({
					requestId: failed.reworkRequestId,
					ownerId: "coordinator",
					generation: claim.generation,
					reason: "wake_failed",
					alertIdentity: {
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
						leadResolution: "resolved",
					},
					now,
				});
			}

			const evidence = store
				.listRunAttributedExecutions("run-heavy")
				.map((executionId) => ({
					executionId,
					sessionStatus: null,
					lifecycleRevision: null,
					liveness: "dead" as const,
					observedAt: "2026-07-23T00:26:30.000Z",
				}));
			const reopened = store.openOperatorRework({
				runId: "run-heavy",
				targetNodeId: "implement",
				feedback: "retry after Lead inspection",
				clientRequestId: "operator-needs-lead",
				principal: "master",
				evidence,
				now: "2026-07-23T00:26:30.000Z",
			});

			expect(reopened).toMatchObject({ ok: true, targetAttempt: 3 });
			expect(store.getWorkflowRun("run-heavy")).toMatchObject({
				status: "active",
				current_node_id: "implement",
			});
			expect(
				store.getWorkflowRunNode("run-heavy", "implement", 2),
			).toMatchObject({ state: "superseded" });
			expect(
				store.getWorkflowRunNode("run-heavy", "implement", 3),
			).toMatchObject({ state: "pending" });
			expect(
				raw
					.prepare(
						"SELECT revoked FROM workflow_output_credential WHERE activation_id = 'activation-needs-lead'",
					)
					.get(),
			).toEqual({ revoked: 1 });
			expect(
				store
					.listWorkflowRunEvents("run-heavy")
					.filter((event) => event.kind === "rework_needs_lead_cleaned"),
			).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	it("turns QA fail into one pending same-actor request without a fresh dispatch", async () => {
		const store = await createHeavyEngineRun();
		try {
			expect(
				advanceHeavy(store, {
					nodeId: "design",
					attempt: 1,
					executionId: "design-exec",
					outcome: "design_done",
					successorExecutionId: "implement-exec",
				}),
			).toMatchObject({ ok: true });
			expect(
				advanceHeavy(store, {
					nodeId: "implement",
					attempt: 1,
					executionId: "implement-exec",
					outcome: "implement_done",
					successorExecutionId: "qa-exec",
				}),
			).toMatchObject({ ok: true });
			const sideEffectsBefore = store.listWorkflowSideEffects("run-heavy");

			const failed = advanceHeavy(store, {
				nodeId: "qa",
				attempt: 1,
				executionId: "qa-exec",
				outcome: "qa_fail",
				subjectDigest: "a".repeat(40),
			});
			expect(failed).toMatchObject({
				ok: true,
				idempotentReplay: false,
				edgeId: "qa_retry",
				targetNodeId: "implement",
				targetAttempt: 2,
				loopIteration: 1,
				reworkRequestId: expect.any(String),
			});
			if (!failed.ok || !failed.reworkRequestId) {
				throw new Error("rework request not returned");
			}
			expect(failed).not.toHaveProperty("successorExecutionId");
			expect(store.listWorkflowSideEffects("run-heavy")).toEqual(
				sideEffectsBefore,
			);
			expect(
				store.getWorkflowReworkRequest(failed.reworkRequestId),
			).toMatchObject({
				request_id: failed.reworkRequestId,
				run_id: "run-heavy",
				authority: "qa",
				source_node_id: "qa",
				source_attempt: 1,
				base_revision: "a".repeat(40),
				founder_feedback_verbatim: null,
			});
			expect(
				store.getLatestWorkflowReworkRoute(failed.reworkRequestId),
			).toMatchObject({
				revision: 1,
				target_node_id: "implement",
				target_attempt: 2,
				preferred_actor_execution_id: "implement-exec",
				invalidation_scope: ["implement", "qa"],
				verification_policy: ["code_review", "qa_retest"],
			});
			expect(
				store.getWorkflowReworkDelivery(failed.reworkRequestId),
			).toMatchObject({
				request_id: failed.reworkRequestId,
				route_revision: 1,
				state: "pending",
				generation: 0,
			});
			expect(
				store.getWorkflowRunNode("run-heavy", "implement", 2),
			).toMatchObject({ state: "pending", execution_id: "implement-exec" });
			expect(
				store
					.listWorkflowRunEvents("run-heavy")
					.filter((event) => event.kind === "rework_requested"),
			).toHaveLength(1);
			expect(
				advanceHeavy(store, {
					nodeId: "qa",
					attempt: 1,
					executionId: "qa-exec",
					outcome: "qa_fail",
					subjectDigest: "a".repeat(40),
				}),
			).toMatchObject({
				ok: true,
				idempotentReplay: true,
				reworkRequestId: failed.reworkRequestId,
			});
			expect(
				advanceHeavy(store, {
					nodeId: "qa",
					attempt: 1,
					executionId: "qa-exec",
					outcome: "qa_fail",
					subjectDigest: "b".repeat(40),
				}),
			).toEqual({ ok: false, reason: "transition_conflict" });
		} finally {
			store.close();
		}
	});

	it("suppresses a QA ghost rework when the same head already has a current PASS", async () => {
		const store = await createHeavyEngineRun();
		try {
			expect(
				advanceHeavy(store, {
					nodeId: "design",
					attempt: 1,
					executionId: "design-exec",
					outcome: "design_done",
					successorExecutionId: "implement-exec",
				}),
			).toMatchObject({ ok: true });
			expect(
				advanceHeavy(store, {
					nodeId: "implement",
					attempt: 1,
					executionId: "implement-exec",
					outcome: "implement_done",
					successorExecutionId: "qa-exec",
				}),
			).toMatchObject({ ok: true });

			const capability = store.issueWorkflowDecisionCapability({
				runId: "run-heavy",
				nodeId: "qa",
				executionId: "qa-exec",
				attempt: 1,
				allowedPredicateFamily: "qa_verdict",
				expiresAt: "2026-07-23T02:00:00.000Z",
				absoluteDeadlineAt: "2026-07-24T00:00:00.000Z",
			});
			if (!capability.ok) throw new Error(capability.reason);
			expect(
				store.submitWorkflowDecisionClaim({
					token: capability.token,
					clientRequestId: "qa-pass-before-ghost",
					predicate: "qa_passed",
					subjectKind: "git_head",
					subjectDigest: "a".repeat(40),
					issuerVendor: "claude",
					issuerModel: "opus",
					subjectProducerExecutionId: "implement-exec",
					subjectProducerVendor: "codex",
					claimExpiresAt: "2026-07-23T02:00:00.000Z",
					now: "2026-07-23T00:09:00.000Z",
				}),
			).toMatchObject({ ok: true });
			const effectsBefore = store.listWorkflowSideEffects("run-heavy");
			const input = {
				runId: "run-heavy",
				nodeId: "qa",
				attempt: 1,
				executionId: "qa-exec",
				outcome: "qa_fail",
				subjectDigest: "a".repeat(40),
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved" as const,
				},
				now: "2026-07-23T00:10:00.000Z",
			};

			const suppressed = store.commitWorkflowTransitionTx(input);
			expect(suppressed).toMatchObject({
				ok: true,
				idempotentReplay: false,
				edgeId: "qa_retry",
				targetNodeId: "implement",
				targetAttempt: 2,
				escalated: true,
			});
			expect(suppressed).not.toHaveProperty("reworkRequestId");
			expect(store.getWorkflowRun("run-heavy")).toMatchObject({
				status: "held",
				current_node_id: "qa",
			});
			expect(store.getWorkflowRunNode("run-heavy", "qa", 1)?.state).toBe(
				"done",
			);
			expect(
				store.getWorkflowRunNode("run-heavy", "implement", 2),
			).toBeUndefined();
			expect(store.listWorkflowSideEffects("run-heavy")).toEqual(effectsBefore);
			expect(
				store
					.listWorkflowRunEvents("run-heavy")
					.filter(
						(event) =>
							event.kind === "edge_traversed" && event.node_id === "qa",
					),
			).toEqual([]);
			expect(
				store
					.listWorkflowRunEvents("run-heavy")
					.filter((event) => event.kind === "rework_suppressed_idle_spin"),
			).toHaveLength(1);
			expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
			expect(store.commitWorkflowTransitionTx(input)).toMatchObject({
				ok: true,
				idempotentReplay: true,
				escalated: true,
			});
			expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	it("appends a founder route correction before grant and freezes it after grant", async () => {
		const store = await createHeavyEngineRun();
		try {
			const db = (
				store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			db.run(
				`INSERT INTO workflow_actor
				   (execution_id, project_name, issue_id, role, created_at)
				 VALUES ('implement-exec', 'flywheel', 'FLY-1423', 'implement',
				         '2026-07-23T00:00:00.000Z')`,
			);
			db.run(
				`INSERT INTO workflow_actor
				   (execution_id, project_name, issue_id, role, created_at)
				 VALUES ('design-exec', 'flywheel', 'FLY-1423', 'design',
				         '2026-07-23T00:00:00.000Z')`,
			);
			store.upsertWorkflowRunNode({
				runId: "run-heavy",
				nodeId: "implement",
				attempt: 2,
				state: "pending",
				executionId: "implement-exec",
			});
			db.run(
				`INSERT INTO workflow_rework_request
				   (request_id, run_id, source_event_id, authority, source_node_id,
				    source_attempt, base_revision, authority_context_json,
				    authority_context_digest, founder_feedback_verbatim, requested_at)
				 VALUES ('founder-request', 'run-heavy', 'founder-source-1', 'founder',
				         'founder_gate', 1, ?, ?, ?, ?, '2026-07-23T00:10:00.000Z')`,
				[
					"c".repeat(40),
					JSON.stringify({ feedback: "设计要重做" }),
					"digest-founder",
					"设计要重做",
				],
			);
			db.run(
				`INSERT INTO workflow_rework_route_revision
				   (request_id, revision, target_node_id, target_attempt,
				    preferred_actor_execution_id, invalidation_scope_json,
				    verification_policy_json, interpreted_by,
				    interpretation_reason, created_at)
				 VALUES ('founder-request', 1, 'implement', 2, 'implement-exec', ?, ?,
				         'legacy_default', 'legacy founder correction default',
				         '2026-07-23T00:10:00.000Z')`,
				[
					JSON.stringify(["implement", "qa"]),
					JSON.stringify(["code_review", "qa_retest", "founder_gate"]),
				],
			);
			db.run(
				`INSERT INTO workflow_rework_delivery
				   (request_id, route_revision, state, updated_at)
				 VALUES ('founder-request', 1, 'pending', '2026-07-23T00:10:00.000Z')`,
			);

			expect(
				store.appendWorkflowReworkRouteRevision({
					requestId: "founder-request",
					targetNodeId: "design",
					targetAttempt: 2,
					preferredActorExecutionId: "design-exec",
					invalidationScope: ["design", "implement", "qa"],
					verificationPolicy: [
						"design_review",
						"code_review",
						"qa_retest",
						"founder_gate",
					],
					interpretedBy: "flywheel-eng-lead",
					interpretationReason: "Founder clarified design is the target",
					now: "2026-07-23T00:11:00.000Z",
				}),
			).toEqual({ ok: true, revision: 2 });
			expect(
				store.getLatestWorkflowReworkRoute("founder-request"),
			).toMatchObject({
				revision: 2,
				target_node_id: "design",
				preferred_actor_execution_id: "design-exec",
			});
			expect(store.getWorkflowReworkDelivery("founder-request")).toMatchObject({
				route_revision: 2,
				state: "pending",
			});

			db.run(
				`UPDATE workflow_rework_delivery
				    SET state = 'turn_granted', owner_id = 'coordinator', generation = 1
				  WHERE request_id = 'founder-request'`,
			);
			expect(
				store.appendWorkflowReworkRouteRevision({
					requestId: "founder-request",
					targetNodeId: "implement",
					targetAttempt: 2,
					preferredActorExecutionId: "implement-exec",
					invalidationScope: ["implement", "qa"],
					verificationPolicy: ["code_review", "qa_retest", "founder_gate"],
					interpretedBy: "flywheel-eng-lead",
					interpretationReason: "too late",
					now: "2026-07-23T00:12:00.000Z",
				}),
			).toEqual({ ok: false, reason: "delivery_route_frozen" });
			expect(
				store.getLatestWorkflowReworkRoute("founder-request")?.revision,
			).toBe(2);
		} finally {
			store.close();
		}
	});

	it("rolls back the request, reservation, and events when request persistence fails", async () => {
		const store = await createHeavyEngineRun();
		try {
			advanceHeavy(store, {
				nodeId: "design",
				attempt: 1,
				executionId: "design-exec",
				outcome: "design_done",
				successorExecutionId: "implement-exec",
			});
			advanceHeavy(store, {
				nodeId: "implement",
				attempt: 1,
				executionId: "implement-exec",
				outcome: "implement_done",
				successorExecutionId: "qa-exec",
			});
			const raw = (store as unknown as { db: { run(sql: string): void } }).db;
			raw.run(
				`CREATE TRIGGER reject_rework_request
				 BEFORE INSERT ON workflow_rework_request
				 BEGIN SELECT RAISE(ABORT, 'injected rework failure'); END`,
			);

			expect(() =>
				advanceHeavy(store, {
					nodeId: "qa",
					attempt: 1,
					executionId: "qa-exec",
					outcome: "qa_fail",
					subjectDigest: "e".repeat(40),
				}),
			).toThrow("injected rework failure");
			expect(store.getWorkflowRunNode("run-heavy", "qa", 1)).toMatchObject({
				state: "pending",
			});
			expect(
				store.getWorkflowRunNode("run-heavy", "implement", 2),
			).toBeUndefined();
			expect(
				store
					.listWorkflowRunEvents("run-heavy")
					.filter((event) => event.kind.startsWith("rework_")),
			).toEqual([]);
			const requestCount = (
				store as unknown as {
					db: { raw: Database.Database };
				}
			).db.raw
				.prepare("SELECT COUNT(*) AS n FROM workflow_rework_request")
				.get() as { n: number };
			expect(requestCount.n).toBe(0);
		} finally {
			store.close();
		}
	});
});

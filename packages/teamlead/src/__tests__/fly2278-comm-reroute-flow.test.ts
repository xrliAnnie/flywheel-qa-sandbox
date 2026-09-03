import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryProjector } from "../bridge/delivery-contract/projector.js";
import { DeliveryContractWatch } from "../bridge/delivery-contract/watch.js";
import { DeliveryOperations } from "../bridge/delivery-operations.js";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const commDbs: CommDB[] = [];
const alertIdentity = {
	leadId: "flywheel-eng-lead",
	projectName: "flywheel",
	leadResolution: "resolved" as const,
};

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const commDb of commDbs.splice(0)) commDb.close();
});

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

async function stateFixture(family: "phase_wake" | "turn_wake") {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const commDb = new CommDB(":memory:");
	commDbs.push(commDb);
	const source = `${family}-source`;
	const target = `${family}-target`;
	for (const executionId of [source, target]) {
		commDb.registerSession(
			executionId,
			`window-${executionId}`,
			"flywheel",
			"FLY-2278",
			"flywheel-eng-lead",
		);
		store.upsertSession({
			execution_id: executionId,
			issue_id: "FLY-2278",
			project_name: "flywheel",
			status: executionId === source ? "completed" : "running",
			workflow_node_id: "worker",
		});
	}
	commDb.markSessionTerminalStatus(source, "completed");
	const runId = `run-${family}`;
	store.createWorkflowRun({
		runId,
		issueId: "FLY-2278",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.upsertWorkflowRunNode({
		runId,
		nodeId: "worker",
		attempt: 1,
		state: "completed",
		executionId: source,
	});
	store.upsertWorkflowRunNode({
		runId,
		nodeId: "worker",
		attempt: 2,
		state: "running",
		executionId: target,
	});
	return { store, commDb, source, target, runId };
}

describe("FLY-2278 CommDB reroute event flow", () => {
	it.each(["staged", "applied"] as const)(
		"keeps an %s reroute child live until operations replay materializes its CommDB row",
		async (operationState) => {
			const fixture = await stateFixture("phase_wake");
			const physicalId = "phase-wake-crash-window";
			const baseMs = Date.parse("2026-09-03T19:00:00.000Z");
			fixture.commDb.enqueueRunnerPhaseWake(
				fixture.source,
				{
					id: physicalId,
					to: fixture.source,
					content: "continue after restart",
					metadata: { purpose: "resume" },
				},
				baseMs,
			);
			const projector = new DeliveryProjector({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
			});
			expect(projector.runPass("2026-09-03T19:01:00.000Z")).toMatchObject({
				minted: 1,
			});
			const watch = new DeliveryContractWatch({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
				resolveAlertIdentity: () => alertIdentity,
			});
			expect(watch.runPass("2026-09-03T19:02:00.000Z")).toMatchObject({
				opened: 1,
			});
			const episodeId = (
				rawDb(fixture.store)
					.prepare(
						"SELECT episode_id FROM workflow_delivery_contract_episode WHERE closed_at IS NULL",
					)
					.get() as { episode_id: string }
			).episode_id;
			const staged = fixture.store.stageWorkflowDeliveryReroute({
				episodeId,
				targetExecutionId: fixture.target,
				sourceExecutionId: fixture.source,
				now: "2026-09-03T19:03:00.000Z",
			});
			expect(staged.kind).toBe("staged");
			if (staged.kind !== "staged") throw new Error("reroute was not staged");
			expect(
				fixture.commDb.getRunnerPhaseWakeProjectionRow(staged.childPhysicalId),
			).toBeUndefined();
			if (operationState === "applied") {
				expect(
					fixture.store.markWorkflowDeliveryRerouteApplied({
						operationId: staged.operationId,
						now: "2026-09-03T19:03:30.000Z",
					}),
				).toEqual({ ok: true, idempotentReplay: false });
			}

			expect(projector.runPass("2026-09-03T19:04:00.000Z")).toMatchObject({
				advanced: 0,
			});
			expect(
				rawDb(fixture.store)
					.prepare(
						"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
					)
					.get(staged.childAttemptId),
			).toEqual({ settlement_reason: null });
			expect(
				fixture.store
					.listLiveWorkflowDeliveryAttempts()
					.map(({ attempt_id }) => attempt_id),
			).toContain(staged.childAttemptId);

			const runner = new DeliveryOperations({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
				resolveRecipient: ({ rootId, sourceExecutionId }) =>
					fixture.store.resolveWorkflowDeliveryRecipient(
						rootId,
						sourceExecutionId,
					),
				resolveAlertIdentity: () => alertIdentity,
			});
			expect(runner.runPass("2026-09-03T19:05:00.000Z")).toEqual({
				examined: 1,
				rerouted: 1,
				operatorRequired: 0,
			});
			expect(
				fixture.commDb.getRunnerPhaseWakeProjectionRow(staged.childPhysicalId),
			).toMatchObject({ execution_id: fixture.target, state: "pending" });
			expect(
				fixture.store
					.listLiveWorkflowDeliveryAttempts()
					.map(({ attempt_id }) => attempt_id),
			).toContain(staged.childAttemptId);
			expect(
				fixture.store
					.listWorkflowAlertOutbox()
					.find(
						(row) =>
							row.escalation_uid ===
							`delivery_reroute_outcome:${staged.sourceAttemptId}`,
					)?.payload,
			).toMatchObject({
				title: "FLY-2278 delivery rerouted",
				body: `FLY-2278 收件体已终结，已改派给 phase_wa（第 1 次）。runId ${fixture.runId}；证据戳 2026-09-03T19:05:00.000Z；正门：\`flywheel-comm hold list --run ${fixture.runId}\``,
			});
		},
	);

	it("does not spend the reroute budget when staged CommDB reroutes are compensated", async () => {
		const fixture = await stateFixture("phase_wake");
		fixture.commDb.enqueueRunnerPhaseWake(
			fixture.source,
			{
				id: "phase-wake-retry-budget",
				to: fixture.source,
				content: "retry after transient failures",
			},
			Date.parse("2026-09-03T19:10:00.000Z"),
		);
		const projector = new DeliveryProjector({
			store: fixture.store,
			commDb: fixture.commDb,
			projectName: "flywheel",
		});
		expect(projector.runPass("2026-09-03T19:11:00.000Z")).toMatchObject({
			minted: 1,
		});
		const watch = new DeliveryContractWatch({
			store: fixture.store,
			commDb: fixture.commDb,
			projectName: "flywheel",
			resolveAlertIdentity: () => alertIdentity,
		});
		expect(watch.runPass("2026-09-03T19:12:00.000Z")).toMatchObject({
			opened: 1,
		});
		const episodeId = (
			rawDb(fixture.store)
				.prepare(
					"SELECT episode_id FROM workflow_delivery_contract_episode WHERE closed_at IS NULL",
				)
				.get() as { episode_id: string }
		).episode_id;

		for (const [index, now] of [
			"2026-09-03T19:13:00.000Z",
			"2026-09-03T19:14:00.000Z",
		].entries()) {
			const staged = fixture.store.stageWorkflowDeliveryReroute({
				episodeId,
				targetExecutionId: fixture.target,
				sourceExecutionId: fixture.source,
				now,
				allowOverCap: index > 0,
			});
			expect(staged.kind).toBe("staged");
			if (staged.kind !== "staged") throw new Error("reroute was not staged");
			expect(
				fixture.store.markWorkflowDeliveryRerouteFailed({
					operationId: staged.operationId,
					now,
					error: `transient CommDB failure ${index + 1}`,
				}),
			).toEqual({ ok: true, idempotentReplay: false });
		}

		const third = fixture.store.stageWorkflowDeliveryReroute({
			episodeId,
			targetExecutionId: fixture.target,
			sourceExecutionId: fixture.source,
			now: "2026-09-03T19:15:00.000Z",
			allowOverCap: true,
		});
		expect(third.kind).toBe("staged");
		expect(
			rawDb(fixture.store)
				.prepare(
					`SELECT generation, state
					   FROM workflow_delivery_operation
					  WHERE kind = 'reroute'
					  ORDER BY generation`,
				)
				.all(),
		).toEqual([
			{ generation: 1, state: "failed" },
			{ generation: 2, state: "failed" },
			{ generation: 3, state: "staged" },
		]);
	});

	it.each(["phase_wake", "turn_wake"] as const)(
		"binds the %s child attempt to its real authoritative row",
		async (family) => {
			const fixture = await stateFixture(family);
			const physicalId = `${family}-physical`;
			const baseMs = Date.parse("2026-09-03T20:00:00.000Z");
			if (family === "phase_wake") {
				fixture.commDb.enqueueRunnerPhaseWake(
					fixture.source,
					{
						id: physicalId,
						to: fixture.source,
						content: "continue the phase",
						metadata: { purpose: "resume" },
					},
					baseMs,
				);
			} else {
				fixture.commDb.grantTurn("FLY-2278", fixture.target, "worker", baseMs, {
					project: "flywheel",
					sourceEventId: "turn-target-current",
					activation: {
						activationId: "activation-target",
						runId: fixture.runId,
						nodeId: "worker",
						attempt: 2,
						context: { source: "test" },
					},
				});
				fixture.commDb.enqueueTurnWake({
					wakeId: physicalId,
					executionId: fixture.source,
					issueId: "FLY-2278",
					epoch: 1,
					activationId: "activation-source",
					purpose: "workflow_transition",
					envelope: { fromAgent: "bridge", content: "continue the turn" },
					backend: "codex",
					createdAtMs: baseMs,
				});
			}
			const projector = new DeliveryProjector({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
			});
			expect(projector.runPass("2026-09-03T20:01:00.000Z")).toMatchObject({
				minted: 1,
			});
			const watch = new DeliveryContractWatch({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
				resolveAlertIdentity: () => alertIdentity,
			});
			expect(watch.runPass("2026-09-03T20:02:00.000Z")).toMatchObject({
				opened: 1,
			});
			const runner = new DeliveryOperations({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
				resolveRecipient: ({ rootId, sourceExecutionId }) =>
					fixture.store.resolveWorkflowDeliveryRecipient(
						rootId,
						sourceExecutionId,
					),
				resolveAlertIdentity: () => alertIdentity,
			});
			expect(runner.runPass("2026-09-03T20:03:00.000Z")).toEqual({
				examined: 1,
				rerouted: 1,
				operatorRequired: 0,
			});
			const child = fixture.store
				.listLiveWorkflowDeliveryAttempts()
				.find((attempt) => attempt.family === family)!;
			const ref = JSON.parse(child.contract_ref_json) as { pk: string };
			expect(ref.pk).not.toBe(physicalId);
			if (family === "phase_wake") {
				expect(
					fixture.commDb.getRunnerPhaseWakeProjectionRow(ref.pk),
				).toMatchObject({
					execution_id: fixture.target,
					state: "pending",
				});
			} else {
				expect(fixture.commDb.getTurnWake(ref.pk)).toMatchObject({
					execution_id: fixture.target,
					state: "pending",
				});
			}
			expect(
				rawDb(fixture.store)
					.prepare(
						"SELECT state FROM workflow_delivery_operation WHERE source_attempt_id = ?",
					)
					.get(child.parent_attempt_id),
			).toEqual({ state: "projected" });
		},
	);

	it("contains one rejected reroute, compensates its staging, and continues the pass", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		const seeded: Array<{
			family: "turn_wake" | "phase_wake";
			issueId: string;
			runId: string;
			source: string;
			target: string;
			physicalId: string;
		}> = [];
		for (const [family, issueId] of [
			["turn_wake", "FLY-AAA"],
			["phase_wake", "FLY-ZZZ"],
		] as const) {
			const runId = `run-${issueId}`;
			const source = `${issueId}-source`;
			const target = `${issueId}-target`;
			const physicalId = `${issueId}-physical`;
			for (const executionId of [source, target]) {
				commDb.registerSession(
					executionId,
					`window-${executionId}`,
					"flywheel",
					issueId,
					"flywheel-eng-lead",
				);
				store.upsertSession({
					execution_id: executionId,
					issue_id: issueId,
					project_name: "flywheel",
					status: executionId === source ? "completed" : "running",
					workflow_node_id: "worker",
				});
			}
			commDb.markSessionTerminalStatus(source, "completed");
			store.createWorkflowRun({
				runId,
				issueId,
				projectName: "flywheel",
				claimsReadEnrolled: true,
			});
			store.upsertWorkflowRunNode({
				runId,
				nodeId: "worker",
				attempt: 1,
				state: "completed",
				executionId: source,
			});
			store.upsertWorkflowRunNode({
				runId,
				nodeId: "worker",
				attempt: 2,
				state: "running",
				executionId: target,
			});
			if (family === "turn_wake") {
				commDb.grantTurn(issueId, source, "worker", 1, {
					project: "flywheel",
					sourceEventId: `turn-${issueId}`,
					activation: {
						activationId: `activation-${source}`,
						runId,
						nodeId: "worker",
						attempt: 1,
						context: { source: "test" },
					},
				});
				commDb.enqueueTurnWake({
					wakeId: physicalId,
					executionId: source,
					issueId,
					epoch: 1,
					purpose: "workflow_transition",
					envelope: { fromAgent: "bridge", content: "continue" },
					backend: "codex",
					createdAtMs: Date.parse("2026-09-03T21:00:00.000Z"),
				});
			} else {
				commDb.enqueueRunnerPhaseWake(
					source,
					{ id: physicalId, to: source, content: "continue" },
					Date.parse("2026-09-03T21:00:00.000Z"),
				);
			}
			seeded.push({ family, issueId, runId, source, target, physicalId });
		}
		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		expect(projector.runPass("2026-09-03T21:01:00.000Z")).toMatchObject({
			minted: 2,
		});
		const watch = new DeliveryContractWatch({
			store,
			commDb,
			projectName: "flywheel",
			resolveAlertIdentity: () => alertIdentity,
		});
		expect(watch.runPass("2026-09-03T21:02:00.000Z")).toMatchObject({
			opened: 2,
		});
		const runner = new DeliveryOperations({
			store,
			commDb,
			projectName: "flywheel",
			resolveRecipient: ({ rootId, sourceExecutionId }) =>
				store.resolveWorkflowDeliveryRecipient(rootId, sourceExecutionId),
			resolveAlertIdentity: () => alertIdentity,
		});
		expect(() => runner.runPass("2026-09-03T21:03:00.000Z")).not.toThrow();
		const healthy = seeded.find(({ family }) => family === "phase_wake")!;
		const poisoned = seeded.find(({ family }) => family === "turn_wake")!;
		expect(
			commDb
				.listRunnerPhaseWakeProjectionRows(
					Date.parse("2026-09-03T21:03:00.000Z"),
				)
				.find(({ execution_id }) => execution_id === healthy.target),
		).toBeDefined();
		const failedOperation = rawDb(store)
			.prepare(
				`SELECT state, last_error, source_attempt_id
				   FROM workflow_delivery_operation
				  WHERE run_id = ? AND kind = 'reroute'`,
			)
			.get(poisoned.runId) as {
			state: string;
			last_error: string | null;
			source_attempt_id: string;
		};
		expect(failedOperation).toMatchObject({
			state: "failed",
			last_error: expect.stringContaining("target is not current"),
		});
		expect(
			store
				.listWorkflowAlertOutbox()
				.find(
					(row) =>
						row.escalation_uid ===
						`delivery_reroute_outcome:${failedOperation.source_attempt_id}:failed`,
				)?.payload,
		).toMatchObject({
			title: "FLY-AAA delivery reroute retrying",
			body: `FLY-AAA 改派未能自动完成(${failedOperation.last_error})，run 未冻结，下一轮重试。runId ${poisoned.runId}；证据戳 2026-09-03T21:03:00.000Z；正门：\`flywheel-comm hold list --run ${poisoned.runId}\``,
		});
		expect(
			rawDb(store)
				.prepare(
					"SELECT superseded_by_attempt_id, settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
				)
				.get(failedOperation.source_attempt_id),
		).toEqual({ superseded_by_attempt_id: null, settlement_reason: null });
		expect(
			rawDb(store)
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE parent_attempt_id = ?",
				)
				.get(failedOperation.source_attempt_id),
		).toEqual({ settlement_reason: "reroute_failed" });
		commDb.grantTurn(poisoned.issueId, poisoned.target, "worker", 2, {
			project: "flywheel",
			sourceEventId: "turn-target-repaired",
			activation: {
				activationId: `activation-${poisoned.target}`,
				runId: poisoned.runId,
				nodeId: "worker",
				attempt: 2,
				context: { source: "test" },
			},
		});
		expect(runner.runPass("2026-09-03T21:04:00.000Z")).toMatchObject({
			examined: 1,
			rerouted: 0,
			operatorRequired: 1,
		});
		const hold = store
			.listWorkflowHolds(poisoned.runId)
			.find(({ shape }) => shape === "delivery_undeliverable_no_recipient");
		if (!hold) throw new Error("reroute operator hold missing");
		const resume = StateStore.canonicalizeHoldResume({
			runId: poisoned.runId,
			shape: hold.shape,
			holdEventUid: hold.holdEventUid,
			decision: `reroute_to ${poisoned.target}`,
			reason: "operator selected repaired recipient",
			principal: "master",
			clientRequestId: "resume-repaired-turn-target",
		});
		if (!resume) throw new Error("valid reroute decision was rejected");
		expect(
			store.resumeWorkflowHold({
				canonical: resume.canonical,
				digest: resume.digest,
				now: "2026-09-03T21:04:30.000Z",
			}),
		).toMatchObject({ ok: true, state: "staged" });
		expect(runner.runPass("2026-09-03T21:05:00.000Z")).toMatchObject({
			rerouted: 1,
		});
		expect(
			rawDb(store)
				.prepare(
					"SELECT state FROM workflow_delivery_operation WHERE run_id = ? AND kind = 'reroute' ORDER BY generation",
				)
				.all(poisoned.runId),
		).toEqual([{ state: "failed" }, { state: "projected" }]);
		expect(
			store
				.listWorkflowAlertOutbox()
				.find(
					(row) =>
						row.escalation_uid ===
						`delivery_reroute_outcome:${failedOperation.source_attempt_id}`,
				)?.payload.body,
		).toContain("自动改派失败，下一轮已把决定权交到正门");
		expect(
			store
				.listWorkflowAlertOutbox()
				.filter((row) =>
					row.escalation_uid.startsWith(
						`delivery_reroute_outcome:${failedOperation.source_attempt_id}`,
					),
				),
		).toHaveLength(2);
	});

	it("bounds repeated compensated failures and exposes the existing operator door", async () => {
		const fixture = await stateFixture("turn_wake");
		const physicalId = "turn-wake-persistent-failure";
		fixture.commDb.grantTurn("FLY-2278", fixture.source, "worker", 1, {
			project: "flywheel",
			sourceEventId: "turn-persistent-failure",
			activation: {
				activationId: `activation-${fixture.source}`,
				runId: fixture.runId,
				nodeId: "worker",
				attempt: 1,
				context: { source: "test" },
			},
		});
		fixture.commDb.enqueueTurnWake({
			wakeId: physicalId,
			executionId: fixture.source,
			issueId: "FLY-2278",
			epoch: 1,
			purpose: "workflow_transition",
			envelope: { fromAgent: "bridge", content: "continue" },
			backend: "codex",
			createdAtMs: Date.parse("2026-09-03T22:00:00.000Z"),
		});
		const projector = new DeliveryProjector({
			store: fixture.store,
			commDb: fixture.commDb,
			projectName: "flywheel",
		});
		expect(projector.runPass("2026-09-03T22:01:00.000Z")).toMatchObject({
			minted: 1,
		});
		const watch = new DeliveryContractWatch({
			store: fixture.store,
			commDb: fixture.commDb,
			projectName: "flywheel",
			resolveAlertIdentity: () => alertIdentity,
		});
		expect(watch.runPass("2026-09-03T22:02:00.000Z")).toMatchObject({
			opened: 1,
		});
		const runner = new DeliveryOperations({
			store: fixture.store,
			commDb: fixture.commDb,
			projectName: "flywheel",
			resolveRecipient: ({ rootId, sourceExecutionId }) =>
				fixture.store.resolveWorkflowDeliveryRecipient(
					rootId,
					sourceExecutionId,
				),
			resolveAlertIdentity: () => alertIdentity,
		});

		expect(runner.runPass("2026-09-03T22:03:00.000Z")).toMatchObject({
			examined: 1,
			rerouted: 0,
			operatorRequired: 0,
		});
		expect(runner.runPass("2026-09-03T22:04:00.000Z")).toMatchObject({
			examined: 1,
			rerouted: 0,
			operatorRequired: 1,
		});
		const db = rawDb(fixture.store);
		const sourceAttempt = fixture.store
			.listLiveWorkflowDeliveryAttempts()
			.find(({ family }) => family === "turn_wake");
		if (!sourceAttempt) throw new Error("turn-wake source attempt missing");
		expect(
			db
				.prepare(
					"SELECT state FROM workflow_delivery_operation WHERE root_id = ? AND kind = 'reroute' ORDER BY generation",
				)
				.all(sourceAttempt.root_id),
		).toEqual([{ state: "failed" }]);
		expect(
			db
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE root_id = ? ORDER BY generation",
				)
				.all(sourceAttempt.root_id),
		).toEqual([
			{ settlement_reason: null },
			{ settlement_reason: "reroute_failed" },
		]);
		const holds = fixture.store.listWorkflowHolds(fixture.runId);
		expect(holds).toHaveLength(1);
		const operatorHold = holds[0];
		if (!operatorHold) throw new Error("reroute operator hold missing");
		expect(operatorHold).toMatchObject({
			shape: "delivery_undeliverable_no_recipient",
			runLevel: false,
			resumable: true,
			requiredDecision: ["reroute_to", "cancel"],
		});
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");
		const alertsAfterGate = fixture.store
			.listWorkflowAlertOutbox()
			.filter((row) =>
				row.escalation_uid.startsWith(
					`delivery_reroute_outcome:${sourceAttempt.attempt_id}`,
				),
			);
		expect(alertsAfterGate).toHaveLength(2);
		expect(
			alertsAfterGate.find(
				(row) =>
					row.escalation_uid ===
					`delivery_reroute_outcome:${sourceAttempt.attempt_id}`,
			)?.payload.body,
		).toContain("自动改派失败，下一轮已把决定权交到正门");

		const resume = StateStore.canonicalizeHoldResume({
			runId: fixture.runId,
			shape: operatorHold.shape,
			holdEventUid: operatorHold.holdEventUid,
			decision: `reroute_to ${fixture.target}`,
			reason: "operator authorized another attempt",
			principal: "master",
			clientRequestId: "resume-persistent-turn-target",
		});
		if (!resume) throw new Error("valid reroute decision was rejected");
		expect(
			fixture.store.resumeWorkflowHold({
				canonical: resume.canonical,
				digest: resume.digest,
				now: "2026-09-03T22:04:30.000Z",
			}),
		).toMatchObject({ ok: true, state: "staged" });
		expect(runner.runPass("2026-09-03T22:05:00.000Z")).toMatchObject({
			examined: 1,
			rerouted: 0,
			operatorRequired: 0,
		});
		expect(
			db
				.prepare(
					"SELECT state FROM workflow_delivery_operation WHERE root_id = ? AND kind = 'reroute' ORDER BY generation",
				)
				.all(sourceAttempt.root_id),
		).toEqual([{ state: "failed" }, { state: "failed" }]);
		expect(
			fixture.store
				.listWorkflowAlertOutbox()
				.filter((row) =>
					row.escalation_uid.startsWith(
						`delivery_reroute_outcome:${sourceAttempt.attempt_id}`,
					),
				),
		).toHaveLength(2);

		expect(runner.runPass("2026-09-03T22:06:00.000Z")).toMatchObject({
			examined: 1,
			rerouted: 0,
			operatorRequired: 0,
		});
		expect(
			db
				.prepare(
					"SELECT count(*) AS count FROM workflow_delivery_operation WHERE root_id = ? AND kind = 'reroute'",
				)
				.get(sourceAttempt.root_id),
		).toEqual({ count: 2 });
	});
});

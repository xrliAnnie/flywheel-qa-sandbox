import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryProjector } from "../bridge/delivery-contract/projector.js";
import { DeliveryContractWatch } from "../bridge/delivery-contract/watch.js";
import { DeliveryOperations } from "../bridge/delivery-operations.js";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const commDbs: CommDB[] = [];
const now = "2026-09-03T18:00:00.000Z";
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

async function setupRework(
	caseId: string,
	initialRecipient: "source" | "target" = "source",
): Promise<{
	store: StateStore;
	runId: string;
	requestId: string;
	targetExecutionId: string;
	episodeId: string;
	parentAttemptId: string;
}> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const db = rawDb(store);
	const runId = `run-${caseId}`;
	const requestId = `request-${caseId}`;
	const sourceExecutionId = `source-${caseId}`;
	const targetExecutionId = `target-${caseId}`;
	store.createWorkflowRun({
		runId,
		issueId: "FLY-2278",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	for (const [executionId, status] of [
		[sourceExecutionId, "completed"],
		[targetExecutionId, "running"],
	] as const) {
		store.upsertSession({
			execution_id: executionId,
			issue_id: "FLY-2278",
			project_name: "flywheel",
			status,
			workflow_node_id: "worker",
		});
		db.prepare(
			`INSERT INTO workflow_actor
			   (execution_id, project_name, issue_id, role, created_at)
			 VALUES (?, 'flywheel', 'FLY-2278', 'worker', ?)`,
		).run(executionId, "2026-09-03T17:00:00.000Z");
	}
	store.upsertWorkflowRunNode({
		runId,
		nodeId: "worker",
		attempt: 1,
		state: "completed",
		executionId: sourceExecutionId,
	});
	store.upsertWorkflowRunNode({
		runId,
		nodeId: "worker",
		attempt: 2,
		state: "running",
		executionId: targetExecutionId,
	});
	db.prepare(
		`INSERT INTO workflow_rework_request
		   (request_id, run_id, source_event_id, authority, source_node_id,
		    source_attempt, base_revision, authority_context_json,
		    authority_context_digest, requested_at)
		 VALUES (?, ?, ?, 'engine', 'worker', 1, ?, '{}', ?, ?)`,
	).run(
		requestId,
		runId,
		`event-${caseId}`,
		"a".repeat(40),
		"digest",
		"2026-09-03T17:00:00.000Z",
	);
	db.prepare(
		`INSERT INTO workflow_rework_route_revision
		   (request_id, revision, target_node_id, target_attempt,
		    preferred_actor_execution_id, invalidation_scope_json,
		    verification_policy_json, interpreted_by, interpretation_reason,
		    created_at)
		 VALUES (?, 1, 'worker', 2, ?, '[]', '{}', 'test', 'initial', ?)`,
	).run(
		requestId,
		initialRecipient === "target" ? targetExecutionId : sourceExecutionId,
		"2026-09-03T17:00:00.000Z",
	);
	db.prepare(
		`INSERT INTO workflow_rework_delivery
		   (request_id, route_revision, state, updated_at)
		 VALUES (?, 1, 'awaiting_receipt', ?)`,
	).run(requestId, "2026-09-03T17:00:00.000Z");
	expect(store.baselineWorkflowDeliveryContracts(now).minted).toBe(1);
	const attempt = store
		.listLiveWorkflowDeliveryAttempts()
		.find((row) => row.family === "rework")!;
	store.observeWorkflowDeliveryContract({
		attempt,
		classification: {
			stage: "minted",
			stageEnteredAt: attempt.minted_at,
			terminal: "undeliverable",
			overdue: false,
			severe: false,
		},
		runId,
		projectName: "flywheel",
		issueId: "FLY-2278",
		now,
		alertIdentity,
	});
	const episodeId = (
		db
			.prepare(
				"SELECT episode_id FROM workflow_delivery_contract_episode WHERE closed_at IS NULL",
			)
			.get() as { episode_id: string }
	).episode_id;
	return {
		store,
		runId,
		requestId,
		targetExecutionId,
		episodeId,
		parentAttemptId: attempt.attempt_id,
	};
}

describe("FLY-2278 M2 state-native reroute", () => {
	it("renders a real stalled reroute operation with its age and hold-list path", async () => {
		const fixture = await setupRework("operation-copy");
		const staged = fixture.store.stageWorkflowDeliveryReroute({
			episodeId: fixture.episodeId,
			targetExecutionId: fixture.targetExecutionId,
			now: "2026-09-03T18:01:00.000Z",
		});
		expect(staged.kind).toBe("staged");
		if (staged.kind !== "staged") throw new Error("reroute was not staged");
		expect(
			fixture.store.alertStalledWorkflowDeliveryOperations(
				"2026-09-03T18:06:00.001Z",
				() => alertIdentity,
			),
		).toBe(1);
		expect(
			fixture.store
				.listWorkflowAlertOutbox()
				.find(
					(row) =>
						row.escalation_uid ===
						`delivery_operation_stalled:${staged.operationId}`,
				)?.payload,
		).toMatchObject({
			title: "FLY-2278 delivery operation stalled",
			body: `FLY-2278 一次自动改派卡在 staged 超过 5 分钟，run 未冻结。runId ${fixture.runId}；证据戳 2026-09-03T18:01:00.000Z；正门：\`flywheel-comm hold list --run ${fixture.runId}\`。`,
		});
	});

	it("rebinds rework to its real physical key and projects the operation atomically", async () => {
		const fixture = await setupRework("success");
		expect(
			fixture.store.rerouteWorkflowStateDelivery({
				episodeId: fixture.episodeId,
				targetExecutionId: fixture.targetExecutionId,
				now: "2026-09-03T18:01:00.000Z",
				allowOverCap: false,
				alertIdentity,
			}),
		).toMatchObject({ ok: true, idempotentReplay: false });
		const db = rawDb(fixture.store);
		expect(
			fixture.store.getWorkflowReworkDelivery(fixture.requestId),
		).toMatchObject({
			route_revision: 2,
			state: "pending",
		});
		const child = fixture.store
			.listLiveWorkflowDeliveryAttempts()
			.find((row) => row.family === "rework")!;
		expect(JSON.parse(child.contract_ref_json)).toMatchObject({
			table: "workflow_rework_delivery",
			pk: fixture.requestId,
			routeRevision: 2,
			targetExecutionId: fixture.targetExecutionId,
		});
		expect(child.parent_attempt_id).toBe(fixture.parentAttemptId);
		expect(
			db
				.prepare(
					"SELECT state FROM workflow_delivery_operation WHERE source_attempt_id = ?",
				)
				.get(fixture.parentAttemptId),
		).toEqual({ state: "projected" });
		expect(
			db
				.prepare(
					"SELECT closed_reason FROM workflow_delivery_contract_episode WHERE episode_id = ?",
				)
				.get(fixture.episodeId),
		).toEqual({ closed_reason: "rerouted" });
		expect(
			fixture.store.alertStalledWorkflowDeliveryOperations(
				"2026-09-03T19:01:00.000Z",
				() => alertIdentity,
			),
		).toBe(0);
		expect(
			db
				.prepare(
					"SELECT count(*) AS count FROM workflow_alert_outbox WHERE escalation_uid LIKE 'delivery_operation_stalled:%'",
				)
				.get(),
		).toEqual({ count: 0 });
		expect(
			fixture.store
				.listWorkflowAlertOutbox()
				.find(
					(row) =>
						row.escalation_uid ===
						`delivery_reroute_outcome:${fixture.parentAttemptId}`,
				)?.payload,
		).toMatchObject({
			title: "FLY-2278 delivery rerouted",
			body: `FLY-2278 收件体已终结，已改派给 target-s（第 1 次）。runId ${fixture.runId}；证据戳 2026-09-03T18:01:00.000Z；正门：\`flywheel-comm hold list --run ${fixture.runId}\``,
		});
	});

	it("rolls back physical and ledger mutations when projection fails", async () => {
		const fixture = await setupRework("rollback");
		const db = rawDb(fixture.store);
		const before = JSON.stringify({
			delivery: db
				.prepare("SELECT * FROM workflow_rework_delivery WHERE request_id = ?")
				.get(fixture.requestId),
			routes: db
				.prepare(
					"SELECT * FROM workflow_rework_route_revision WHERE request_id = ? ORDER BY revision",
				)
				.all(fixture.requestId),
			attempts: db
				.prepare(
					"SELECT * FROM workflow_delivery_attempt WHERE family = 'rework' ORDER BY generation",
				)
				.all(),
			episode: db
				.prepare(
					"SELECT * FROM workflow_delivery_contract_episode WHERE episode_id = ?",
				)
				.get(fixture.episodeId),
		});
		db.exec(`
			CREATE TRIGGER fly2278_fail_reroute_projection
			BEFORE INSERT ON workflow_delivery_operation
			BEGIN SELECT RAISE(ABORT, 'injected reroute projection failure'); END;
		`);
		expect(() =>
			fixture.store.rerouteWorkflowStateDelivery({
				episodeId: fixture.episodeId,
				targetExecutionId: fixture.targetExecutionId,
				now: "2026-09-03T18:01:00.000Z",
				allowOverCap: false,
				alertIdentity,
			}),
		).toThrow("injected reroute projection failure");
		expect(
			JSON.stringify({
				delivery: db
					.prepare(
						"SELECT * FROM workflow_rework_delivery WHERE request_id = ?",
					)
					.get(fixture.requestId),
				routes: db
					.prepare(
						"SELECT * FROM workflow_rework_route_revision WHERE request_id = ? ORDER BY revision",
					)
					.all(fixture.requestId),
				attempts: db
					.prepare(
						"SELECT * FROM workflow_delivery_attempt WHERE family = 'rework' ORDER BY generation",
					)
					.all(),
				episode: db
					.prepare(
						"SELECT * FROM workflow_delivery_contract_episode WHERE episode_id = ?",
					)
					.get(fixture.episodeId),
			}),
		).toBe(before);
	});

	it("settles the rerouted child when the run becomes terminal", async () => {
		const fixture = await setupRework("run-terminal");
		expect(
			fixture.store.rerouteWorkflowStateDelivery({
				episodeId: fixture.episodeId,
				targetExecutionId: fixture.targetExecutionId,
				now: "2026-09-03T18:01:00.000Z",
				allowOverCap: false,
				alertIdentity,
			}),
		).toMatchObject({ ok: true });
		const child = fixture.store
			.listLiveWorkflowDeliveryAttempts()
			.find((row) => row.family === "rework")!;
		fixture.store.observeWorkflowDeliveryContract({
			attempt: child,
			classification: {
				stage: "sent",
				stageEnteredAt: child.minted_at,
				terminal: null,
				overdue: true,
				severe: false,
			},
			runId: fixture.runId,
			projectName: "flywheel",
			issueId: "FLY-2278",
			now: "2026-09-03T18:16:00.000Z",
			alertIdentity,
		});
		rawDb(fixture.store)
			.prepare("UPDATE workflow_run SET status = 'terminated' WHERE run_id = ?")
			.run(fixture.runId);
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		new DeliveryProjector({
			store: fixture.store,
			commDb,
			projectName: "flywheel",
		}).runPass("2026-09-03T18:17:00.000Z");
		expect(
			rawDb(fixture.store)
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
				)
				.get(child.attempt_id),
		).toEqual({ settlement_reason: "run_terminal" });
		expect(
			rawDb(fixture.store)
				.prepare(
					"SELECT closed_at, closed_reason FROM workflow_delivery_contract_episode WHERE attempt_id = ?",
				)
				.get(child.attempt_id),
		).toEqual({
			closed_at: "2026-09-03T18:17:00.000Z",
			closed_reason: "terminal:settled:run_terminal",
		});
	});

	it.each([
		["alive", "2026-09-03T18:49:00.000Z", [], 0],
		["absent", "2026-09-03T17:00:00.000Z", [{ stage: "received" }], 1],
	] as const)(
		"gates an overdue rework receipt on %s recipient liveness",
		async (verdict, lastActivityAt, expectedOpen, expectedAlerts) => {
			const fixture = await setupRework(`rework-received-${verdict}`, "target");
			const attempt = fixture.store
				.listLiveWorkflowDeliveryAttempts()
				.find((row) => row.family === "rework")!;
			const ref = JSON.parse(attempt.contract_ref_json);
			fixture.store.projectWorkflowDeliveryAttempt({
				rootId: attempt.root_id,
				attemptId: attempt.attempt_id,
				family: "rework",
				contractRef: ref,
				mintedAt: attempt.minted_at,
				sentAt: "2026-09-03T18:00:00.000Z",
			});
			const commDb = new CommDB(":memory:");
			commDbs.push(commDb);
			const watch = new DeliveryContractWatch({
				store: fixture.store,
				commDb,
				projectName: "flywheel",
				resolveAlertIdentity: () => alertIdentity,
			});
			expect(watch.runPass("2026-09-03T18:16:00.000Z")).toMatchObject({
				opened: 1,
			});
			const alertsBefore = (
				rawDb(fixture.store)
					.prepare("SELECT count(*) AS count FROM workflow_alert_outbox")
					.get() as { count: number }
			).count;
			fixture.store.projectWorkflowDeliveryAttempt({
				rootId: attempt.root_id,
				attemptId: attempt.attempt_id,
				family: "rework",
				contractRef: ref,
				mintedAt: attempt.minted_at,
				sentAt: "2026-09-03T18:00:00.000Z",
				receivedAt: "2026-09-03T18:19:00.000Z",
			});
			fixture.store.upsertSession({
				execution_id: fixture.targetExecutionId,
				issue_id: "FLY-2278",
				project_name: "flywheel",
				status: "running",
				workflow_node_id: "worker",
				last_activity_at: lastActivityAt,
			});
			watch.runPass("2026-09-03T18:50:00.000Z");
			expect(
				rawDb(fixture.store)
					.prepare(
						"SELECT stage FROM workflow_delivery_contract_episode WHERE closed_at IS NULL",
					)
					.all(),
			).toEqual(expectedOpen);
			const alertsAfter = (
				rawDb(fixture.store)
					.prepare("SELECT count(*) AS count FROM workflow_alert_outbox")
					.get() as { count: number }
			).count;
			expect(alertsAfter - alertsBefore).toBe(expectedAlerts);
			expect(
				rawDb(fixture.store)
					.prepare(
						"SELECT closed_reason FROM workflow_delivery_contract_episode WHERE stage = 'sent'",
					)
					.get(),
			).toEqual({ closed_reason: "advanced" });
		},
	);

	it("does not spend state-native reroute capacity on compensated staged operations", async () => {
		const fixture = await setupRework("compensated-capacity");
		for (const [index, at] of [
			"2026-09-03T18:01:00.000Z",
			"2026-09-03T18:02:00.000Z",
		].entries()) {
			const staged = fixture.store.stageWorkflowDeliveryReroute({
				episodeId: fixture.episodeId,
				targetExecutionId: fixture.targetExecutionId,
				now: at,
				allowOverCap: index > 0,
			});
			expect(staged.kind).toBe("staged");
			if (staged.kind !== "staged") throw new Error("reroute was not staged");
			expect(
				fixture.store.markWorkflowDeliveryRerouteFailed({
					operationId: staged.operationId,
					now: at,
					error: `transient state-native failure ${index + 1}`,
				}),
			).toEqual({ ok: true, idempotentReplay: false });
		}

		expect(
			fixture.store.rerouteWorkflowStateDelivery({
				episodeId: fixture.episodeId,
				targetExecutionId: fixture.targetExecutionId,
				now: "2026-09-03T18:03:00.000Z",
				allowOverCap: false,
				alertIdentity,
			}),
		).toMatchObject({ ok: true, idempotentReplay: false });
		const operations = rawDb(fixture.store)
			.prepare(
				`SELECT operation_id, generation, state
				   FROM workflow_delivery_operation
				  WHERE kind = 'reroute'
				  ORDER BY generation`,
			)
			.all() as Array<{
			operation_id: string;
			generation: number;
			state: string;
		}>;
		expect(
			operations.map(({ generation, state }) => ({ generation, state })),
		).toEqual([
			{ generation: 1, state: "failed" },
			{ generation: 2, state: "failed" },
			{ generation: 3, state: "projected" },
		]);
		expect(
			new Set(operations.map(({ operation_id }) => operation_id)).size,
		).toBe(3);
		expect(
			fixture.store
				.listLiveWorkflowDeliveryAttempts()
				.find(({ family }) => family === "rework"),
		).toMatchObject({ generation: 4 });
	});

	it("raises a non-holding monotonic gate after two real reroutes exhaust the cap", async () => {
		const fixture = await setupRework("cap-exhaustion");
		const openEpisodeForLiveAttempt = (at: string) => {
			const attempt = fixture.store
				.listLiveWorkflowDeliveryAttempts()
				.find((row) => row.family === "rework")!;
			fixture.store.observeWorkflowDeliveryContract({
				attempt,
				classification: {
					stage: "minted",
					stageEnteredAt: attempt.minted_at,
					terminal: "undeliverable",
					overdue: false,
					severe: false,
				},
				runId: fixture.runId,
				projectName: "flywheel",
				issueId: "FLY-2278",
				now: at,
				alertIdentity,
			});
			return (
				rawDb(fixture.store)
					.prepare(
						"SELECT episode_id FROM workflow_delivery_contract_episode WHERE attempt_id = ? AND closed_at IS NULL",
					)
					.get(attempt.attempt_id) as { episode_id: string }
			).episode_id;
		};
		expect(
			fixture.store.rerouteWorkflowStateDelivery({
				episodeId: fixture.episodeId,
				targetExecutionId: fixture.targetExecutionId,
				now: "2026-09-03T18:01:00.000Z",
				allowOverCap: false,
				alertIdentity,
			}),
		).toMatchObject({ ok: true });
		fixture.store.upsertSession({
			execution_id: fixture.targetExecutionId,
			issue_id: "FLY-2278",
			project_name: "flywheel",
			status: "completed",
			workflow_node_id: "worker",
		});
		const target2 = "target-cap-exhaustion-2";
		fixture.store.upsertSession({
			execution_id: target2,
			issue_id: "FLY-2278",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "worker",
		});
		fixture.store.upsertWorkflowRunNode({
			runId: fixture.runId,
			nodeId: "worker",
			attempt: 3,
			state: "running",
			executionId: target2,
		});
		expect(
			fixture.store.rerouteWorkflowStateDelivery({
				episodeId: openEpisodeForLiveAttempt("2026-09-03T18:02:00.000Z"),
				targetExecutionId: target2,
				now: "2026-09-03T18:03:00.000Z",
				allowOverCap: false,
				alertIdentity,
			}),
		).toMatchObject({ ok: true });
		fixture.store.upsertSession({
			execution_id: target2,
			issue_id: "FLY-2278",
			project_name: "flywheel",
			status: "completed",
			workflow_node_id: "worker",
		});
		const target3 = "target-cap-exhaustion-3";
		fixture.store.upsertSession({
			execution_id: target3,
			issue_id: "FLY-2278",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "worker",
		});
		fixture.store.upsertWorkflowRunNode({
			runId: fixture.runId,
			nodeId: "worker",
			attempt: 4,
			state: "running",
			executionId: target3,
		});
		const capEpisodeId = openEpisodeForLiveAttempt("2026-09-03T18:04:00.000Z");
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		const runner = new DeliveryOperations({
			store: fixture.store,
			commDb,
			projectName: "flywheel",
			resolveRecipient: ({ rootId, sourceExecutionId }) =>
				fixture.store.resolveWorkflowDeliveryRecipient(
					rootId,
					sourceExecutionId,
				),
			resolveAlertIdentity: () => alertIdentity,
		});
		expect(runner.runPass("2026-09-03T18:05:00.000Z")).toEqual({
			examined: 1,
			rerouted: 0,
			operatorRequired: 1,
		});
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");
		expect(
			rawDb(fixture.store)
				.prepare(
					"SELECT closed_at FROM workflow_delivery_contract_episode WHERE episode_id = ?",
				)
				.get(capEpisodeId),
		).toEqual({ closed_at: null });
		const event = rawDb(fixture.store)
			.prepare("SELECT payload FROM workflow_run_event WHERE event_uid = ?")
			.get(`delivery_reroute_operator_required:${capEpisodeId}`) as {
			payload: string;
		};
		const eventPayload = JSON.parse(event.payload) as {
			attemptId: string;
			runHeld: boolean;
			recipientExecutionId: string;
			livenessVerdict: string;
		};
		expect(eventPayload).toMatchObject({
			runHeld: false,
			recipientExecutionId: target2,
			livenessVerdict: "unknown",
		});
		expect(
			fixture.store
				.listWorkflowAlertOutbox()
				.find(
					(row) =>
						row.escalation_uid ===
						`delivery_reroute_outcome:${eventPayload.attemptId}`,
				)?.payload.body,
		).toBe(
			`FLY-2278 已自动改派 2 次仍未送达，run 未冻结，需要你确认再改派一次或取消。runId ${fixture.runId}；证据戳 2026-09-03T18:05:00.000Z；正门：\`flywheel-comm hold list --run ${fixture.runId}\`；恢复：\`flywheel-comm hold resume --shape delivery_undeliverable_no_recipient --decision '<reroute_to <exec> | cancel>' --run ${fixture.runId} --hold-event delivery_reroute_operator_required:${capEpisodeId} --reason 'operator-confirmed'\``,
		);

		fixture.store.upsertSession({
			execution_id: target3,
			issue_id: "FLY-2278",
			project_name: "flywheel",
			status: "completed",
			workflow_node_id: "worker",
		});
		expect(runner.runPass("2026-09-03T18:20:00.000Z")).toEqual({
			examined: 1,
			rerouted: 0,
			operatorRequired: 0,
		});
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");
	});

	it("rejects a stale target without consuming reroute capacity", async () => {
		const fixture = await setupRework("target-fence");
		fixture.store.upsertSession({
			execution_id: fixture.targetExecutionId,
			issue_id: "FLY-2278",
			project_name: "flywheel",
			status: "completed",
			workflow_node_id: "worker",
		});
		expect(
			fixture.store.rerouteWorkflowStateDelivery({
				episodeId: fixture.episodeId,
				targetExecutionId: fixture.targetExecutionId,
				now: "2026-09-03T18:01:00.000Z",
				allowOverCap: false,
				alertIdentity,
			}),
		).toEqual({ ok: false, reason: "target_not_current" });
		expect(
			rawDb(fixture.store)
				.prepare("SELECT count(*) AS count FROM workflow_delivery_operation")
				.get(),
		).toEqual({ count: 0 });
		expect(
			rawDb(fixture.store)
				.prepare(
					"SELECT closed_at FROM workflow_delivery_contract_episode WHERE episode_id = ?",
				)
				.get(fixture.episodeId),
		).toEqual({ closed_at: null });
	});

	it.each(["terminal", "replaced"] as const)(
		"rejects a CommDB reroute target that became %s before staging",
		async (barrier) => {
			const store = await StateStore.create(":memory:");
			stores.push(store);
			const runId = `run-comm-${barrier}`;
			const sourceExecutionId = `source-comm-${barrier}`;
			const targetExecutionId = `target-comm-${barrier}`;
			const rootId = `flywheel:FLY-2278:mailbox:mail-comm-${barrier}`;
			const attemptId = `${rootId}:g1:a1`;
			store.createWorkflowRun({
				runId,
				issueId: "FLY-2278",
				projectName: "flywheel",
				claimsReadEnrolled: true,
			});
			for (const [executionId, attempt] of [
				[sourceExecutionId, 1],
				[targetExecutionId, 2],
			] as const) {
				store.upsertSession({
					execution_id: executionId,
					issue_id: "FLY-2278",
					project_name: "flywheel",
					status: "running",
					workflow_node_id: "worker",
				});
				store.upsertWorkflowRunNode({
					runId,
					nodeId: "worker",
					attempt,
					state: executionId === sourceExecutionId ? "completed" : "running",
					executionId,
				});
			}
			store.projectWorkflowDeliveryAttempt({
				rootId,
				attemptId,
				family: "mailbox",
				contractRef: { table: "mailbox", pk: `mail-comm-${barrier}` },
				mintedAt: now,
			});
			const attempt = store.listLiveWorkflowDeliveryAttempts()[0]!;
			store.observeWorkflowDeliveryContract({
				attempt,
				classification: {
					stage: "minted",
					stageEnteredAt: now,
					terminal: "undeliverable",
					overdue: false,
					severe: false,
				},
				runId,
				projectName: "flywheel",
				issueId: "FLY-2278",
				now,
				alertIdentity,
			});
			if (barrier === "terminal") {
				store.upsertSession({
					execution_id: targetExecutionId,
					issue_id: "FLY-2278",
					project_name: "flywheel",
					status: "completed",
					workflow_node_id: "worker",
				});
			} else {
				const replacement = `${targetExecutionId}-new`;
				store.upsertSession({
					execution_id: replacement,
					issue_id: "FLY-2278",
					project_name: "flywheel",
					status: "running",
					workflow_node_id: "worker",
				});
				store.upsertWorkflowRunNode({
					runId,
					nodeId: "worker",
					attempt: 3,
					state: "running",
					executionId: replacement,
				});
			}
			const db = rawDb(store);
			const episodeId = (
				db
					.prepare("SELECT episode_id FROM workflow_delivery_contract_episode")
					.get() as { episode_id: string }
			).episode_id;
			expect(
				store.stageWorkflowDeliveryReroute({
					episodeId,
					targetExecutionId,
					sourceExecutionId,
					now: "2026-09-03T18:01:00.000Z",
				}),
			).toEqual({ kind: "rejected", reason: "target_not_current" });
			expect(
				db
					.prepare("SELECT count(*) AS count FROM workflow_delivery_operation")
					.get(),
			).toEqual({ count: 0 });
			expect(store.listLiveWorkflowDeliveryAttempts()).toHaveLength(1);
			expect(
				db
					.prepare(
						"SELECT closed_at FROM workflow_delivery_contract_episode WHERE episode_id = ?",
					)
					.get(episodeId),
			).toEqual({ closed_at: null });
		},
	);
});

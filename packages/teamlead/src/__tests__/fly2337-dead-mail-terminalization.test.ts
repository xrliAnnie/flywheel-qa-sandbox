import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestLeadIdentityEnvs } from "../../../flywheel-comm/src/__tests__/helpers/lead-identity-env.js";
import { respond } from "../../../flywheel-comm/src/commands/respond.js";
import { send } from "../../../flywheel-comm/src/commands/send.js";
import {
	LegacyDeadMailboxHoldReconcileScheduler,
	reconcileLegacyDeadMailboxHolds,
} from "../bridge/dead-mail-hold-reconciler.js";
import { DeliveryProjector } from "../bridge/delivery-contract/projector.js";
import { DeliveryContractWatch } from "../bridge/delivery-contract/watch.js";
import { DeliveryOperations } from "../bridge/delivery-operations.js";
import { DEFAULT_MAILBOX_QUEUE_CONFIG } from "../bridge/mailbox-queue-config.js";
import { RunnerMailboxLane } from "../bridge/runner-mailbox-lane.js";
import { StateStore } from "../StateStore.js";

const roots: string[] = [];
const stores: StateStore[] = [];
const commDbs: CommDB[] = [];
const queues: MailboxQueue[] = [];
const alertIdentity = {
	leadId: "flywheel-eng-lead",
	projectName: "flywheel",
	leadResolution: "resolved" as const,
};

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const commDb of commDbs.splice(0)) commDb.close();
	for (const queue of queues.splice(0)) queue.close();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

function rawCommDb(commDb: CommDB): Database.Database {
	return (commDb as unknown as { db: Database.Database }).db;
}

function seedLegacyMailboxHold(input: {
	store: StateStore;
	runId: string;
	physicalId: string;
	fixture: "FLY-2332" | "FLY-2324" | "FLY-2259" | "FLY-2146";
	nodeState: "running" | "review";
}): { holdEventUid: string; attemptId: string } {
	const db = rawDb(input.store);
	db.prepare(
		"UPDATE workflow_run SET issue_id = ?, status = 'held' WHERE run_id = ?",
	).run(input.fixture, input.runId);
	db.prepare(
		"UPDATE workflow_run_node SET state = ? WHERE run_id = ? AND node_id = 'worker'",
	).run(input.nodeState, input.runId);
	if (input.fixture === "FLY-2324") {
		input.store.createWorkflowRun({
			runId: `${input.runId}-old-terminated`,
			issueId: input.fixture,
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		db.prepare(
			"UPDATE workflow_run SET status = 'terminated' WHERE run_id = ?",
		).run(`${input.runId}-old-terminated`);
	}
	if (input.fixture === "FLY-2259") {
		for (let attempt = 2; attempt <= 3; attempt += 1) {
			input.store.upsertWorkflowRunNode({
				runId: input.runId,
				nodeId: "worker",
				attempt,
				state: attempt === 3 ? "review" : "completed",
				executionId: `historical-${attempt}`,
			});
		}
	}
	const attempt = input.store
		.listLiveWorkflowDeliveryAttempts()
		.find(
			(candidate) =>
				JSON.parse(candidate.contract_ref_json).pk === input.physicalId,
		);
	if (!attempt) throw new Error("legacy mailbox attempt missing");
	const holdEventUid = `legacy-delivery-hold:${input.fixture}:${input.runId}`;
	const nextSeq = (
		db
			.prepare(
				"SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM workflow_run_event WHERE run_id = ?",
			)
			.get(input.runId) as { seq: number }
	).seq;
	db.prepare(
		`INSERT INTO workflow_run_event
		   (run_id, seq, event_uid, kind, payload, at)
		 VALUES (?, ?, ?, 'delivery_reroute_operator_required', ?, ?)`,
	).run(
		input.runId,
		nextSeq,
		holdEventUid,
		JSON.stringify({
			shape: "delivery_undeliverable_no_recipient",
			family: "mailbox",
			rootId: attempt.root_id,
			attemptId: attempt.attempt_id,
			physicalId: input.physicalId,
			reason: "delivery_undeliverable_no_recipient",
			runHeld: true,
		}),
		"2026-09-04T09:58:00.000Z",
	);
	return { holdEventUid, attemptId: attempt.attempt_id };
}

function seedBlockingRework(store: StateStore, runId: string): void {
	const db = rawDb(store);
	const requestId = `blocking-rework:${runId}`;
	const executionId = `blocking-rework-exec:${runId}`;
	db.prepare(
		`INSERT INTO workflow_actor
		   (execution_id, project_name, issue_id, role, created_at)
		 VALUES (?, 'flywheel', 'FLY-2337', 'worker', ?)`,
	).run(executionId, "2026-09-04T09:58:00.000Z");
	db.prepare(
		`INSERT INTO workflow_rework_request
		   (request_id, run_id, source_event_id, authority, source_node_id,
		    source_attempt, base_revision, authority_context_json,
		    authority_context_digest, requested_at)
		 VALUES (?, ?, ?, 'engine', 'worker', 1, ?, '{}', 'digest', ?)`,
	).run(
		requestId,
		runId,
		`blocking-rework-event:${runId}`,
		"a".repeat(40),
		"2026-09-04T09:58:00.000Z",
	);
	db.prepare(
		`INSERT INTO workflow_rework_route_revision
		   (request_id, revision, target_node_id, target_attempt,
		    preferred_actor_execution_id, invalidation_scope_json,
		    verification_policy_json, interpreted_by, interpretation_reason,
		    created_at)
		 VALUES (?, 1, 'worker', 1, ?, '[]', '{}', 'test', 'fixture', ?)`,
	).run(requestId, executionId, "2026-09-04T09:58:00.000Z");
	db.prepare(
		`INSERT INTO workflow_rework_delivery
		   (request_id, route_revision, state, updated_at)
		 VALUES (?, 1, 'held', ?)`,
	).run(requestId, "2026-09-04T09:58:00.000Z");
}

function seedHeldCarrier(
	store: StateStore,
	runId: string,
	lastError: string,
): string {
	const db = rawDb(store);
	const questionId = `carrier:${runId}`;
	db.prepare(
		`INSERT INTO workflow_gate_holder
		   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
		    question_id, state, materialization_stage, created_at, updated_at)
		 VALUES (?, 'worker', 1, ?, ?, ?, 'awaiting_review', 'completed', ?, ?)`,
	).run(
		runId,
		"b".repeat(40),
		`carrier-source:${runId}`,
		questionId,
		"2026-09-04T09:58:00.000Z",
		"2026-09-04T09:58:00.000Z",
	);
	db.prepare(
		`INSERT INTO workflow_carrier_delivery
		   (question_id, run_id, gate_node_id, gate_attempt, approved_head,
		    source_execution_id, carrier_activation_id, state, last_error,
		    created_at, updated_at)
		 VALUES (?, ?, 'worker', 1, ?, ?, ?, 'held', ?, ?, ?)`,
	).run(
		questionId,
		runId,
		"b".repeat(40),
		`carrier-source:${runId}`,
		`carrier-activation:${runId}`,
		lastError,
		"2026-09-04T09:58:00.000Z",
		"2026-09-04T09:58:00.000Z",
	);
	return questionId;
}

async function setupDeadMailbox(
	caseId: string,
	deadReason: string,
	terminalizeWithLane = false,
	mailboxType: "instruction" | "response" = "instruction",
) {
	const root = mkdtempSync(join(tmpdir(), `fly2337-${caseId}-`));
	roots.push(root);
	const dbPath = join(root, "comm.db");
	const recipient = randomUUID();
	const bootstrap = new CommDB(dbPath);
	bootstrap.registerSession(
		recipient,
		`window-${caseId}`,
		"flywheel",
		"FLY-2337",
		"lead-a",
	);
	const questionId =
		mailboxType === "response"
			? bootstrap.insertQuestion(recipient, "lead-a", `late question:${caseId}`)
			: undefined;
	bootstrap.close();
	const leadEnv = {
		...createTestLeadIdentityEnvs(root, ["lead-a"])["lead-a"]!,
		TEAMLEAD_DB_PATH: join(root, "unavailable-teamlead.db"),
	};
	let physicalId: string;
	if (questionId) {
		await respond({
			questionId,
			fromAgent: "lead-a",
			answer: `late response:${caseId}`,
			dbPath,
			env: leadEnv,
		});
		const responseDb = new CommDB(dbPath);
		physicalId = responseDb.getResponse(questionId)!.id;
		rawCommDb(responseDb)
			.prepare("UPDATE mailbox SET created_at = ? WHERE id IN (?, ?)")
			.run("2026-09-04T09:59:00.000Z", questionId, physicalId);
		responseDb.close();
	} else {
		physicalId = await send({
			fromAgent: "lead-a",
			toAgent: recipient,
			content: `late instruction:${caseId}`,
			dbPath,
			env: leadEnv,
		});
	}
	const commDb = new CommDB(dbPath);
	commDbs.push(commDb);
	const queue = new MailboxQueue(dbPath);
	queues.push(queue);
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const runId = `run-${caseId}`;
	store.createWorkflowRun({
		runId,
		issueId: "FLY-2337",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.upsertSession({
		execution_id: recipient,
		issue_id: "FLY-2337",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "worker",
	});
	store.upsertWorkflowRunNode({
		runId,
		nodeId: "worker",
		attempt: 1,
		state: "running",
		executionId: recipient,
	});
	const projector = new DeliveryProjector({
		store,
		commDb,
		projectName: "flywheel",
	});
	expect(projector.runPass("2026-09-04T10:00:00.000Z")).toMatchObject({
		examined: 1,
		minted: 1,
	});
	commDb.markSessionTerminalStatus(recipient, "completed");
	store.upsertSession({
		execution_id: recipient,
		issue_id: "FLY-2337",
		project_name: "flywheel",
		status: "completed",
		workflow_node_id: "worker",
	});
	if (terminalizeWithLane) {
		queue.acquireOrRenewOwner({
			ownerEpoch: "runner-lane:fly2337",
			now: "2026-09-04T10:01:00.000Z",
			leaseTtlMs: 60_000,
		});
		const deliver = vi.fn(async () => ({
			status: "delivered" as const,
			backend: "codex" as const,
			settlement: "on_consume" as const,
		}));
		const lane = new RunnerMailboxLane({
			queue,
			ownerEpoch: "runner-lane:fly2337",
			deliver,
			now: () => new Date("2026-09-04T10:01:00.000Z"),
			queueConfig: () => DEFAULT_MAILBOX_QUEUE_CONFIG,
			recipientState: () => "terminal",
			isTerminalDeliveryObligation: () => false,
		});
		expect(await lane.tick()).toMatchObject({
			delivered: 0,
			dead: 1,
		});
		expect(deliver).not.toHaveBeenCalled();
		expect(queue.getById(physicalId)).toMatchObject({
			state: "DEAD",
			dead_reason: "recipient_terminal",
		});
	} else {
		expect(
			queue.markDead(physicalId, "2026-09-04T10:01:00.000Z", deadReason),
		).toBe(true);
	}
	const watch = new DeliveryContractWatch({
		store,
		commDb,
		projectName: "flywheel",
		resolveAlertIdentity: () => alertIdentity,
	});
	const operations = new DeliveryOperations({
		store,
		commDb,
		projectName: "flywheel",
		resolveRecipient: ({ rootId, sourceExecutionId }) =>
			store.resolveWorkflowDeliveryRecipient(rootId, sourceExecutionId),
		resolveAlertIdentity: () => alertIdentity,
	});
	const runPass = (now: string) => {
		projector.runPass(now);
		watch.runPass(now);
		return operations.runPass(now);
	};
	projector.runPass("2026-09-04T10:01:00.000Z");
	expect(watch.runPass("2026-09-04T10:01:00.000Z")).toMatchObject({
		opened: 1,
	});
	return { store, commDb, runId, recipient, physicalId, runPass };
}

describe("FLY-2337 DEAD mailbox terminalization", () => {
	it.each([
		[
			// Live 2026-09-04 restart victim: run d9884c27, mail edb72fd4.
			"prod-d9884c27-mail-edb72fd4",
			"recipient_terminal",
			"delivery_undeliverable_no_recipient",
		],
		[
			"lease-expired",
			"lease_expired_unacked",
			"delivery_undeliverable_no_recipient",
		],
		[
			"attempts-exhausted",
			"delivery_attempts_exhausted",
			"delivery_attempts_exhausted",
		],
		[
			"unconfirmed-exhausted",
			"delivery_unconfirmed_exhausted",
			"delivery_unconfirmed_exhausted",
		],
	])(
		"keeps the run active for %s and emits one warning across restart-style rescans",
		async (caseId, deadReason, expectedWarningReason) => {
			const fixture = await setupDeadMailbox(caseId, deadReason);
			expect(fixture.runPass("2026-09-04T10:16:00.000Z")).toMatchObject({
				examined: 1,
				operatorRequired: 1,
			});
			expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe(
				"active",
			);
			const db = rawDb(fixture.store);
			const snapshot = {
				episodes: db
					.prepare(
						"SELECT count(*) AS count FROM workflow_delivery_contract_episode",
					)
					.get(),
				events: db
					.prepare(
						"SELECT count(*) AS count FROM workflow_run_event WHERE kind = 'delivery_reroute_operator_required'",
					)
					.get(),
				alerts: db
					.prepare(
						"SELECT count(*) AS count FROM workflow_alert_outbox WHERE run_id = ?",
					)
					.get(fixture.runId),
			};
			expect(snapshot).toEqual({
				episodes: { count: 1 },
				events: { count: 1 },
				alerts: { count: 1 },
			});
			const event = db
				.prepare(
					"SELECT payload FROM workflow_run_event WHERE kind = 'delivery_reroute_operator_required'",
				)
				.get() as { payload: string };
			expect(JSON.parse(event.payload)).toMatchObject({
				shape: "delivery_undeliverable_no_recipient",
				family: "mailbox",
				reason: expectedWarningReason,
				runHeld: false,
			});
			const alert = db
				.prepare(
					"SELECT payload_json FROM workflow_alert_outbox WHERE run_id = ?",
				)
				.get(fixture.runId) as { payload_json: string };
			expect(JSON.parse(alert.payload_json)).toMatchObject({
				severity: "warning",
				title: expect.stringContaining(
					"delivery skipped for terminal recipient",
				),
				body: expect.stringContaining("run 未冻结，无需人工恢复"),
			});
			expect(JSON.parse(alert.payload_json).body).not.toContain("hold resume");
			expect(
				fixture.store
					.listLiveWorkflowDeliveryAttempts()
					.some(
						(attempt) =>
							JSON.parse(attempt.contract_ref_json).pk === fixture.physicalId,
					),
			).toBe(false);
			expect(
				db
					.prepare(
						"SELECT settlement_reason FROM workflow_delivery_attempt WHERE json_extract(contract_ref_json, '$.pk') = ?",
					)
					.get(fixture.physicalId),
			).toEqual({ settlement_reason: "source_terminal" });
			expect(
				db
					.prepare(
						"SELECT closed_reason FROM workflow_delivery_contract_episode WHERE root_id LIKE ?",
					)
					.get(`%${fixture.physicalId}`),
			).toEqual({ closed_reason: "terminal:settled:source_terminal" });

			expect(fixture.runPass("2026-09-04T10:17:00.000Z")).toMatchObject({
				examined: 0,
				operatorRequired: 0,
			});
			expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe(
				"active",
			);
			expect({
				episodes: db
					.prepare(
						"SELECT count(*) AS count FROM workflow_delivery_contract_episode",
					)
					.get(),
				events: db
					.prepare(
						"SELECT count(*) AS count FROM workflow_run_event WHERE kind = 'delivery_reroute_operator_required'",
					)
					.get(),
				alerts: db
					.prepare(
						"SELECT count(*) AS count FROM workflow_alert_outbox WHERE run_id = ?",
					)
					.get(fixture.runId),
			}).toEqual(snapshot);
			expect(
				fixture.store
					.listWorkflowHolds(fixture.runId)
					.filter(({ runLevel }) => runLevel),
			).toEqual([]);
		},
	);

	it("settles a DEAD response with guidance instead of rerouting it to a live successor", async () => {
		const fixture = await setupDeadMailbox(
			"response-reroute-unsupported",
			"recipient_terminal",
			false,
			"response",
		);
		const successor = "response-reroute-unsupported-next";
		fixture.commDb.registerSession(
			successor,
			"response-reroute-unsupported-window",
			"flywheel",
			"FLY-2337",
			"lead-a",
		);
		fixture.store.upsertSession({
			execution_id: successor,
			issue_id: "FLY-2337",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "worker",
		});
		fixture.store.upsertWorkflowRunNode({
			runId: fixture.runId,
			nodeId: "worker",
			attempt: 2,
			state: "running",
			executionId: successor,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(fixture.runPass("2026-09-04T10:16:00.000Z")).toMatchObject({
			examined: 1,
			rerouted: 0,
			operatorRequired: 1,
		});
		expect(warn).not.toHaveBeenCalledWith(
			expect.stringContaining("UNIQUE constraint failed: mailbox.ref_id"),
		);
		warn.mockRestore();
		const db = rawDb(fixture.store);
		expect(
			db
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE json_extract(contract_ref_json, '$.pk') = ?",
				)
				.get(fixture.physicalId),
		).toEqual({ settlement_reason: "response_reroute_unsupported" });
		expect(
			db
				.prepare(
					"SELECT closed_reason FROM workflow_delivery_contract_episode WHERE attempt_id = (SELECT attempt_id FROM workflow_delivery_attempt WHERE json_extract(contract_ref_json, '$.pk') = ?)",
				)
				.get(fixture.physicalId),
		).toEqual({
			closed_reason: "terminal:settled:response_reroute_unsupported",
		});
		expect(
			db
				.prepare(
					"SELECT count(*) AS count FROM workflow_delivery_operation WHERE kind = 'reroute' AND source_attempt_id = (SELECT attempt_id FROM workflow_delivery_attempt WHERE json_extract(contract_ref_json, '$.pk') = ?)",
				)
				.get(fixture.physicalId),
		).toEqual({ count: 0 });
		const alert = db
			.prepare(
				"SELECT payload_json FROM workflow_alert_outbox WHERE run_id = ?",
			)
			.get(fixture.runId) as { payload_json: string };
		expect(JSON.parse(alert.payload_json)).toMatchObject({
			severity: "warning",
			title: expect.stringContaining("delivery response closed"),
			body: expect.stringContaining("send a new instruction"),
		});
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");

		expect(fixture.runPass("2026-09-04T10:17:00.000Z")).toMatchObject({
			examined: 0,
			rerouted: 0,
			operatorRequired: 0,
		});
		expect(
			db
				.prepare(
					"SELECT count(*) AS count FROM workflow_alert_outbox WHERE run_id = ?",
				)
				.get(fixture.runId),
		).toEqual({ count: 1 });
	});

	it("terminalizes a staged response reroute instead of replaying it into the mailbox UNIQUE fence", async () => {
		const fixture = await setupDeadMailbox(
			"staged-response-reroute",
			"lease_expired_unacked",
			false,
			"response",
		);
		const legacy = seedLegacyMailboxHold({
			store: fixture.store,
			runId: fixture.runId,
			physicalId: fixture.physicalId,
			fixture: "FLY-2332",
			nodeState: "review",
		});
		const successor = "staged-response-reroute-next";
		fixture.store.upsertSession({
			execution_id: successor,
			issue_id: "FLY-2332",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "worker",
		});
		const normalized = StateStore.canonicalizeHoldResume({
			runId: fixture.runId,
			shape: "delivery_undeliverable_no_recipient",
			holdEventUid: legacy.holdEventUid,
			decision: `reroute_to ${successor}`,
			reason: "production response fixture",
			principal: "master",
			clientRequestId: "staged-response-reroute",
		});
		if (!normalized) throw new Error("response reroute did not canonicalize");
		expect(
			fixture.store.resumeWorkflowHold({
				canonical: normalized.canonical,
				digest: normalized.digest,
				now: "2026-09-04T10:15:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "staged" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		fixture.runPass("2026-09-04T10:16:00.000Z");

		expect(warn).not.toHaveBeenCalledWith(
			expect.stringContaining("UNIQUE constraint failed: mailbox.ref_id"),
		);
		warn.mockRestore();
		const db = rawDb(fixture.store);
		expect(
			db
				.prepare(
					"SELECT state FROM workflow_delivery_operation WHERE client_request_id = ?",
				)
				.get("staged-response-reroute"),
		).toEqual({ state: "projected" });
		expect(
			db
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
				)
				.get(legacy.attemptId),
		).toEqual({ settlement_reason: "response_reroute_unsupported" });
		expect(
			db
				.prepare(
					"SELECT closed_reason FROM workflow_delivery_contract_episode WHERE attempt_id = ?",
				)
				.get(legacy.attemptId),
		).toEqual({
			closed_reason: "terminal:settled:response_reroute_unsupported",
		});
		expect(
			fixture.commDb.getRunnerDeliveryProjectionRow(fixture.physicalId),
		).toMatchObject({
			state: "DEAD",
			dead_reason: "lease_expired_unacked",
			superseded_by: null,
		});
		expect(
			db
				.prepare(
					"SELECT count(*) AS count FROM workflow_alert_outbox WHERE escalation_uid LIKE 'delivery_response_closed:%'",
				)
				.get(),
		).toEqual({ count: 1 });
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");
	});

	it.each([
		["a live recipient", "running", undefined],
		[
			"recent terminal-recipient liveness",
			"completed",
			"2026-09-04T10:15:00.000Z",
		],
	] as const)(
		"does not terminalize or warn DEAD mail while %s is present",
		async (_caseName, status, lastActivityAt) => {
			const fixture = await setupDeadMailbox(
				`dead-safety-gate-${status}-${lastActivityAt ? "recent" : "live"}`,
				"recipient_terminal",
			);
			rawDb(fixture.store)
				.prepare(
					"UPDATE sessions SET status = ?, last_activity_at = ? WHERE execution_id = ?",
				)
				.run(status, lastActivityAt ?? null, fixture.recipient);

			expect(fixture.runPass("2026-09-04T10:16:00.000Z")).toMatchObject({
				examined: 1,
				operatorRequired: 0,
			});
			const db = rawDb(fixture.store);
			expect(
				db
					.prepare(
						"SELECT count(*) AS count FROM workflow_alert_outbox WHERE run_id = ?",
					)
					.get(fixture.runId),
			).toEqual({ count: 0 });
			expect(
				fixture.store
					.listLiveWorkflowDeliveryAttempts()
					.some(
						(attempt) =>
							JSON.parse(attempt.contract_ref_json).pk === fixture.physicalId,
					),
			).toBe(true);
			expect(
				db
					.prepare(
						"SELECT closed_at FROM workflow_delivery_contract_episode WHERE root_id LIKE ?",
					)
					.get(`%${fixture.physicalId}`),
			).toEqual({ closed_at: null });
		},
	);

	it("settles an open DEAD episode behind an existing terminal warning", async () => {
		const fixture = await setupDeadMailbox(
			"existing-terminal-warning",
			"recipient_terminal",
		);
		const episode = fixture.store.listOpenUndeliverableDeliveryEpisodes()[0];
		if (!episode) throw new Error("existing warning episode missing");
		fixture.store.recordWorkflowDeliveryRerouteOperatorRequired({
			episodeId: episode.episode_id,
			now: "2026-09-04T10:16:00.000Z",
			reason: "delivery_undeliverable_no_recipient",
			runHeld: false,
			recipientExecutionId: fixture.recipient,
			commEvidence: {
				recentOutboundInWindow: false,
				observedAtMs: Date.parse("2026-09-04T10:16:00.000Z"),
			},
			alertIdentity,
		});

		expect(fixture.runPass("2026-09-04T10:17:00.000Z")).toMatchObject({
			examined: 1,
			operatorRequired: 0,
		});
		const db = rawDb(fixture.store);
		expect(
			db
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE json_extract(contract_ref_json, '$.pk') = ?",
				)
				.get(fixture.physicalId),
		).toEqual({ settlement_reason: "source_terminal" });
		expect(
			db
				.prepare(
					"SELECT closed_reason FROM workflow_delivery_contract_episode WHERE episode_id = ?",
				)
				.get(episode.episode_id),
		).toEqual({ closed_reason: "terminal:settled:source_terminal" });
		expect(
			db
				.prepare(
					"SELECT count(*) AS count FROM workflow_alert_outbox WHERE run_id = ?",
				)
				.get(fixture.runId),
		).toEqual({ count: 1 });
	});

	it("keeps a terminal-recipient mailbox live until its physical source is DEAD", async () => {
		const fixture = await setupDeadMailbox(
			"physical-source-still-live",
			"recipient_terminal",
		);
		rawCommDb(fixture.commDb)
			.prepare(
				`UPDATE mailbox
				    SET state = 'QUEUED', dead_at = NULL, dead_reason = NULL
				  WHERE id = ?`,
			)
			.run(fixture.physicalId);

		expect(fixture.runPass("2026-09-04T10:16:00.000Z")).toMatchObject({
			examined: 1,
			operatorRequired: 0,
		});
		const db = rawDb(fixture.store);
		expect(
			db
				.prepare(
					"SELECT count(*) AS count FROM workflow_alert_outbox WHERE run_id = ?",
				)
				.get(fixture.runId),
		).toEqual({ count: 0 });
		expect(
			fixture.store
				.listLiveWorkflowDeliveryAttempts()
				.some(
					(attempt) =>
						JSON.parse(attempt.contract_ref_json).pk === fixture.physicalId,
				),
		).toBe(true);
		expect(
			db
				.prepare(
					"SELECT closed_at FROM workflow_delivery_contract_episode WHERE root_id LIKE ?",
				)
				.get(`%${fixture.physicalId}`),
		).toEqual({ closed_at: null });
	});

	it("bounds 10,240 legacy hold candidates to one 64-row maintenance page", () => {
		const candidates = Array.from({ length: 10_240 }, (_, index) => ({
			runId: `run-${String(index).padStart(5, "0")}`,
			eventSeq: 1,
			holdEventUid: `hold-${index}`,
			attemptId: `attempt-${index}`,
			rootId: `flywheel:FLY-2337:mailbox:${index}`,
			physicalId: `mail-${index}`,
			sourceResolution: "live_attempt" as const,
			resumeGeneration: 0,
			eligible: false,
			reason: "no_running_or_review_node",
		}));
		const listCandidates = vi.fn(
			(
				_projectName: string,
				options?: {
					cursor?: { runId: string; eventSeq: number };
					limit?: number;
				},
			) =>
				candidates
					.filter(
						(candidate) =>
							!options?.cursor ||
							candidate.runId > options.cursor.runId ||
							(candidate.runId === options.cursor.runId &&
								candidate.eventSeq > options.cursor.eventSeq),
					)
					.slice(0, options?.limit),
		);
		const events: unknown[] = [];
		const result = reconcileLegacyDeadMailboxHolds({
			store: {
				listLegacyDeadMailboxHoldReconcileCandidates: listCandidates,
				resolveLegacyDeadMailboxHoldReconcileCandidate: (
					_projectName: string,
					candidate: (typeof candidates)[number],
				) => candidate,
			} as unknown as StateStore,
			commDb: {} as CommDB,
			projectName: "flywheel",
			now: "2026-09-04T10:00:00.000Z",
			monotonicNow: () => 0,
			emitEvent: (event: unknown) => events.push(event),
		} as Parameters<typeof reconcileLegacyDeadMailboxHolds>[0]);

		expect(listCandidates).toHaveBeenCalledWith("flywheel", {
			cursor: undefined,
			deferEvaluation: true,
			limit: 64,
		});
		expect(result).toMatchObject({
			examined: 64,
			staged: 0,
			skipped: 64,
			failed: 0,
			nextCursor: { runId: "run-00063", eventSeq: 1 },
		});
		expect(events).toEqual([
			{
				event: "legacy_dead_mail_reconcile_pass",
				payload: expect.objectContaining({
					projectName: "flywheel",
					page: expect.objectContaining({ limit: 64, candidates: 64 }),
					call: expect.objectContaining({
						examined: 64,
						durationMs: 0,
						budgetMs: 50,
						budgetExhausted: false,
					}),
					nextCursor: { runId: "run-00063", eventSeq: 1 },
				}),
			},
		]);
	});

	it("stops a legacy reconcile page at the 50 ms call budget", () => {
		const candidates = Array.from({ length: 64 }, (_, index) => ({
			runId: `run-${String(index).padStart(5, "0")}`,
			eventSeq: 1,
			holdEventUid: `hold-${index}`,
			attemptId: `attempt-${index}`,
			rootId: `flywheel:FLY-2337:mailbox:${index}`,
			physicalId: `mail-${index}`,
			sourceResolution: "live_attempt" as const,
			resumeGeneration: 0,
			eligible: false,
			reason: "no_running_or_review_node",
		}));
		const monotonicNow = vi
			.fn()
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(25)
			.mockReturnValueOnce(50)
			.mockReturnValue(50);
		const events: Array<{ payload?: Record<string, unknown> }> = [];
		const resolveCandidate = vi.fn(
			(_projectName: string, candidate: (typeof candidates)[number]) =>
				candidate,
		);

		const result = reconcileLegacyDeadMailboxHolds({
			store: {
				listLegacyDeadMailboxHoldReconcileCandidates: () => candidates,
				resolveLegacyDeadMailboxHoldReconcileCandidate: resolveCandidate,
			} as unknown as StateStore,
			commDb: {} as CommDB,
			projectName: "flywheel",
			now: "2026-09-04T10:00:00.000Z",
			monotonicNow,
			emitEvent: (event) => events.push(event),
		});

		expect(result).toEqual({
			examined: 2,
			staged: 0,
			skipped: 2,
			failed: 0,
			nextCursor: { runId: "run-00001", eventSeq: 1 },
		});
		expect(events[0]?.payload?.call).toEqual(
			expect.objectContaining({
				examined: 2,
				durationMs: 50,
				budgetMs: 50,
				budgetExhausted: true,
			}),
		);
		expect(resolveCandidate).toHaveBeenCalledTimes(2);
	});

	it("uses a partial keyset index for legacy hold reconciliation", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const details = (
			rawDb(store)
				.prepare(
					`EXPLAIN QUERY PLAN
					 SELECT event.run_id, event.seq, event.event_uid, event.payload
					   FROM workflow_run_event event
					   JOIN workflow_run run ON run.run_id = event.run_id
					  WHERE run.project_name = ?
					    AND run.status = 'held'
					    AND event.kind = 'delivery_reroute_operator_required'
					    AND (event.run_id, event.seq) > (?, ?)
					    AND NOT EXISTS (
					      SELECT 1 FROM workflow_run_event resumed
					       WHERE resumed.run_id = event.run_id
					         AND resumed.kind = 'hold_resumed'
					         AND resumed.event_uid =
					             'hold_resumed:delivery_undeliverable_no_recipient:' || event.event_uid
					    )
					  ORDER BY event.run_id, event.seq
					  LIMIT ?`,
				)
				.all("flywheel", "run-00000", 0, 64) as Array<{ detail: string }>
		).map((row) => row.detail);
		const plan = details.join("\n");

		expect(plan).toContain(
			"SEARCH event USING INDEX idx_workflow_run_event_legacy_dead_mail_scan",
		);
		expect(plan).not.toContain("SCAN event");
	});

	it("retains the strict legacy reconcile cursor across maintenance ticks", () => {
		const candidates = Array.from({ length: 65 }, (_, index) => ({
			runId: `run-${String(index).padStart(5, "0")}`,
			eventSeq: 1,
			holdEventUid: `hold-${index}`,
			attemptId: `attempt-${index}`,
			rootId: `flywheel:FLY-2337:mailbox:${index}`,
			physicalId: `mail-${index}`,
			sourceResolution: "live_attempt" as const,
			resumeGeneration: 0,
			eligible: false,
			reason: "no_running_or_review_node",
		}));
		const listCandidates = vi.fn(
			(
				_projectName: string,
				options?: {
					cursor?: { runId: string; eventSeq: number };
					limit?: number;
				},
			) =>
				candidates
					.filter(
						(candidate) =>
							!options?.cursor ||
							candidate.runId > options.cursor.runId ||
							(candidate.runId === options.cursor.runId &&
								candidate.eventSeq > options.cursor.eventSeq),
					)
					.slice(0, options?.limit),
		);
		const scheduler = new LegacyDeadMailboxHoldReconcileScheduler();
		const input = {
			store: {
				listLegacyDeadMailboxHoldReconcileCandidates: listCandidates,
				resolveLegacyDeadMailboxHoldReconcileCandidate: (
					_projectName: string,
					candidate: (typeof candidates)[number],
				) => candidate,
			} as unknown as StateStore,
			commDb: {} as CommDB,
			projectName: "flywheel",
			now: "2026-09-04T10:00:00.000Z",
			monotonicNow: () => 0,
		};

		expect(scheduler.runPass(input)).toMatchObject({
			examined: 64,
			nextCursor: { runId: "run-00063", eventSeq: 1 },
		});
		expect(scheduler.runPass(input)).toEqual({
			examined: 1,
			staged: 0,
			skipped: 1,
			failed: 0,
		});
		expect(listCandidates).toHaveBeenNthCalledWith(2, "flywheel", {
			cursor: { runId: "run-00063", eventSeq: 1 },
			deferEvaluation: true,
			limit: 64,
		});
	});

	it("cancels an eligible legacy hold even when a successor is available", async () => {
		const fixture = await setupDeadMailbox(
			"legacy-late-successor",
			"recipient_terminal",
		);
		const legacy = seedLegacyMailboxHold({
			store: fixture.store,
			runId: fixture.runId,
			physicalId: fixture.physicalId,
			fixture: "FLY-2332",
			nodeState: "review",
		});
		const successor = "legacy-late-successor-exec";
		fixture.commDb.registerSession(
			successor,
			"legacy-late-successor-window",
			"flywheel",
			"FLY-2332",
			"lead-a",
		);
		fixture.store.upsertSession({
			execution_id: successor,
			issue_id: "FLY-2332",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "worker",
		});
		fixture.store.upsertWorkflowRunNode({
			runId: fixture.runId,
			nodeId: "worker",
			attempt: 2,
			state: "running",
			executionId: successor,
		});

		expect(
			reconcileLegacyDeadMailboxHolds({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
				now: "2026-09-04T10:00:00.000Z",
			}),
		).toMatchObject({ examined: 1, staged: 1, skipped: 0 });
		expect(
			rawDb(fixture.store)
				.prepare(
					`SELECT state, target_activation_id
					   FROM workflow_delivery_operation
					  WHERE kind = 'hold_resume' AND hold_event_uid = ?`,
				)
				.get(legacy.holdEventUid),
		).toEqual({ state: "staged", target_activation_id: null });

		fixture.runPass("2026-09-04T10:00:01.000Z");
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");
		expect(
			fixture.commDb.getRunnerDeliveryProjectionRow(fixture.physicalId),
		).toMatchObject({
			state: "DEAD",
			dead_reason: "recipient_terminal",
			superseded_by: null,
		});
		expect(
			rawDb(fixture.store)
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
				)
				.get(legacy.attemptId),
		).toEqual({ settlement_reason: "cancelled_by_operator" });
	});

	it("cancels a legacy hold without consulting reroute history", async () => {
		const fixture = await setupDeadMailbox(
			"legacy-reroute-needs-operator",
			"recipient_terminal",
		);
		const legacy = seedLegacyMailboxHold({
			store: fixture.store,
			runId: fixture.runId,
			physicalId: fixture.physicalId,
			fixture: "FLY-2332",
			nodeState: "review",
		});
		const successor = "legacy-reroute-needs-operator-next";
		fixture.commDb.registerSession(
			successor,
			"legacy-reroute-needs-operator-window",
			"flywheel",
			"FLY-2332",
			"lead-a",
		);
		fixture.store.upsertSession({
			execution_id: successor,
			issue_id: "FLY-2332",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "worker",
		});
		fixture.store.upsertWorkflowRunNode({
			runId: fixture.runId,
			nodeId: "worker",
			attempt: 2,
			state: "running",
			executionId: successor,
		});
		const episode = fixture.store.listOpenUndeliverableDeliveryEpisodes()[0];
		if (!episode) throw new Error("legacy reroute episode missing");
		const failedReroute = fixture.store.stageWorkflowDeliveryReroute({
			episodeId: episode.episode_id,
			targetExecutionId: successor,
			now: "2026-09-04T10:00:00.000Z",
		});
		expect(failedReroute.kind).toBe("staged");
		if (failedReroute.kind !== "staged") {
			throw new Error("failed reroute setup was not staged");
		}
		expect(
			fixture.store.markWorkflowDeliveryRerouteFailed({
				operationId: failedReroute.operationId,
				now: "2026-09-04T10:00:01.000Z",
				error: "target delivery failed",
			}),
		).toMatchObject({ ok: true });

		expect(
			reconcileLegacyDeadMailboxHolds({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
				now: "2026-09-04T10:00:02.000Z",
			}),
		).toMatchObject({ examined: 1, staged: 1, skipped: 0 });
		fixture.runPass("2026-09-04T10:00:03.000Z");

		const db = rawDb(fixture.store);
		expect(
			db
				.prepare(
					`SELECT target_activation_id FROM workflow_delivery_operation
					  WHERE kind = 'hold_resume' AND hold_event_uid = ?`,
				)
				.get(legacy.holdEventUid),
		).toEqual({ target_activation_id: null });
		expect(
			db
				.prepare(
					"SELECT count(*) AS count FROM workflow_delivery_operation WHERE kind = 'reroute'",
				)
				.get(),
		).toEqual({ count: 1 });
		expect(
			db
				.prepare(
					"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
				)
				.get(legacy.attemptId),
		).toEqual({ settlement_reason: "cancelled_by_operator" });
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");
	});

	it("retries a failed legacy reconcile operation with a new generation", async () => {
		const fixture = await setupDeadMailbox(
			"legacy-failed-operation-retry",
			"recipient_terminal",
		);
		const legacy = seedLegacyMailboxHold({
			store: fixture.store,
			runId: fixture.runId,
			physicalId: fixture.physicalId,
			fixture: "FLY-2332",
			nodeState: "review",
		});
		vi.spyOn(fixture.commDb, "cancelMailboxDelivery").mockImplementationOnce(
			() => {
				throw new Error("mailbox_cancel_cas_failed");
			},
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		expect(
			reconcileLegacyDeadMailboxHolds({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
				now: "2026-09-04T10:00:00.000Z",
			}),
		).toMatchObject({ examined: 1, staged: 1, skipped: 0, failed: 0 });
		fixture.runPass("2026-09-04T10:00:01.000Z");
		const failedOperations = rawDb(fixture.store)
			.prepare(
				`SELECT operation_id, state, client_request_id
				   FROM workflow_delivery_operation
				  WHERE kind = 'hold_resume' AND hold_event_uid = ?
				  ORDER BY created_at, operation_id`,
			)
			.all(legacy.holdEventUid) as Array<{
			operation_id: string;
			state: string;
			client_request_id: string;
		}>;
		expect(failedOperations).toEqual([
			expect.objectContaining({ state: "failed" }),
		]);
		const failedReplay = StateStore.canonicalizeHoldResume({
			runId: fixture.runId,
			shape: "delivery_undeliverable_no_recipient",
			holdEventUid: legacy.holdEventUid,
			decision: "cancel",
			reason: "fly2337_legacy_reconcile",
			principal: "master",
			clientRequestId: failedOperations[0]!.client_request_id,
		});
		if (!failedReplay) throw new Error("failed replay canonicalization failed");
		expect(
			fixture.store.resumeWorkflowHold({
				canonical: failedReplay.canonical,
				digest: failedReplay.digest,
				now: "2026-09-04T10:00:01.500Z",
			}),
		).toMatchObject({
			ok: true,
			idempotentReplay: true,
			operationId: failedOperations[0]!.operation_id,
			state: "failed",
		});

		expect(
			reconcileLegacyDeadMailboxHolds({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
				now: "2026-09-04T10:00:02.000Z",
			}),
		).toMatchObject({ examined: 1, staged: 1, skipped: 0, failed: 0 });
		const retries = rawDb(fixture.store)
			.prepare(
				`SELECT state, client_request_id
				   FROM workflow_delivery_operation
				  WHERE kind = 'hold_resume' AND hold_event_uid = ?
				  ORDER BY created_at, operation_id`,
			)
			.all(legacy.holdEventUid) as Array<{
			state: string;
			client_request_id: string;
		}>;
		expect(retries.map(({ state }) => state)).toEqual(["failed", "staged"]);
		expect(retries[1]?.client_request_id).not.toBe(
			retries[0]?.client_request_id,
		);

		fixture.runPass("2026-09-04T10:00:03.000Z");
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");
		expect(
			rawDb(fixture.store)
				.prepare(
					`SELECT state FROM workflow_delivery_operation
					  WHERE kind = 'hold_resume' AND hold_event_uid = ?
					  ORDER BY created_at, operation_id`,
				)
				.all(legacy.holdEventUid),
		).toEqual([{ state: "failed" }, { state: "projected" }]);
		warn.mockRestore();
	});

	it("bounds persistent legacy reconcile failures and emits one operator warning", async () => {
		const fixture = await setupDeadMailbox(
			"legacy-persistent-operation-failure",
			"recipient_terminal",
		);
		const legacy = seedLegacyMailboxHold({
			store: fixture.store,
			runId: fixture.runId,
			physicalId: fixture.physicalId,
			fixture: "FLY-2332",
			nodeState: "review",
		});
		vi.spyOn(fixture.commDb, "cancelMailboxDelivery").mockImplementation(() => {
			throw new Error("persistent mailbox cancellation failure");
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		for (let attempt = 0; attempt < 5; attempt += 1) {
			reconcileLegacyDeadMailboxHolds({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
				now: `2026-09-04T10:00:0${attempt * 2}.000Z`,
				resolveAlertIdentity: () => alertIdentity,
			});
			fixture.runPass(`2026-09-04T10:00:0${attempt * 2 + 1}.000Z`);
		}

		const db = rawDb(fixture.store);
		expect(
			db
				.prepare(
					`SELECT state FROM workflow_delivery_operation
					  WHERE kind = 'hold_resume' AND hold_event_uid = ?
					  ORDER BY created_at, operation_id`,
				)
				.all(legacy.holdEventUid),
		).toEqual([{ state: "failed" }, { state: "failed" }]);
		expect(
			db
				.prepare(
					`SELECT payload_json,
					        json_extract(payload_json, '$.metadata.workflowEngine.disposition') AS disposition
					   FROM workflow_alert_outbox
					  WHERE escalation_uid = ?`,
				)
				.all(`legacy_dead_mail_reconcile_exhausted:${legacy.holdEventUid}`),
		).toEqual([
			expect.objectContaining({
				disposition: "legacy_dead_mail_reconcile_exhausted",
				payload_json: expect.stringContaining(
					"legacy dead-mail recovery stopped after 2 failed attempts",
				),
			}),
		]);
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("held");
		warn.mockRestore();
	});

	it("reports an observed failed reconcile replay separately from staged work", async () => {
		const fixture = await setupDeadMailbox(
			"legacy-failed-operation-report",
			"recipient_terminal",
		);
		seedLegacyMailboxHold({
			store: fixture.store,
			runId: fixture.runId,
			physicalId: fixture.physicalId,
			fixture: "FLY-2332",
			nodeState: "review",
		});
		vi.spyOn(fixture.store, "resumeWorkflowHold").mockReturnValue({
			ok: true,
			idempotentReplay: true,
			operationId: "failed-reconcile-operation",
			state: "failed",
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		expect(
			reconcileLegacyDeadMailboxHolds({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
				now: "2026-09-04T10:00:00.000Z",
			}),
		).toEqual({ examined: 1, staged: 0, skipped: 0, failed: 1 });
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("replayed a failed resume operation"),
		);
		warn.mockRestore();
	});

	it("drops reconciled legacy hold events from future scanner passes", async () => {
		const fixture = await setupDeadMailbox(
			"legacy-rescan-decay",
			"recipient_terminal",
		);
		seedLegacyMailboxHold({
			store: fixture.store,
			runId: fixture.runId,
			physicalId: fixture.physicalId,
			fixture: "FLY-2332",
			nodeState: "review",
		});
		reconcileLegacyDeadMailboxHolds({
			store: fixture.store,
			commDb: fixture.commDb,
			projectName: "flywheel",
			now: "2026-09-04T10:00:00.000Z",
		});
		fixture.runPass("2026-09-04T10:00:01.000Z");
		rawDb(fixture.store)
			.prepare("UPDATE workflow_run SET status = 'held' WHERE run_id = ?")
			.run(fixture.runId);

		expect(
			fixture.store.listLegacyDeadMailboxHoldReconcileCandidates("flywheel"),
		).toEqual([]);
	});

	it.each([
		["recipient-terminal", "recipient_terminal"],
		["lease-expired", "lease_expired_unacked"],
		["attempts-exhausted", "delivery_attempts_exhausted"],
		["unconfirmed-exhausted", "delivery_unconfirmed_exhausted"],
	])(
		"keeps %s mail terminal when a successor appears after the warning",
		async (caseId, deadReason) => {
			const fixture = await setupDeadMailbox(
				`late-successor-${caseId}`,
				deadReason,
			);
			expect(fixture.runPass("2026-09-04T10:16:00.000Z")).toMatchObject({
				rerouted: 0,
				operatorRequired: 1,
			});

			const successor = `recipient-late-successor-${caseId}-next`;
			fixture.commDb.registerSession(
				successor,
				`window-late-successor-${caseId}-next`,
				"flywheel",
				"FLY-2337",
				"lead-a",
			);
			fixture.store.upsertSession({
				execution_id: successor,
				issue_id: "FLY-2337",
				project_name: "flywheel",
				status: "running",
				workflow_node_id: "worker",
			});
			fixture.store.upsertWorkflowRunNode({
				runId: fixture.runId,
				nodeId: "worker",
				attempt: 2,
				state: "running",
				executionId: successor,
			});

			expect(fixture.runPass("2026-09-04T10:17:00.000Z")).toMatchObject({
				examined: 0,
				rerouted: 0,
				operatorRequired: 0,
			});
			expect(
				fixture.store
					.listLiveWorkflowDeliveryAttempts()
					.some((attempt) => attempt.parent_attempt_id !== null),
			).toBe(false);
			expect(
				rawDb(fixture.store)
					.prepare(
						"SELECT settlement_reason FROM workflow_delivery_attempt WHERE json_extract(contract_ref_json, '$.pk') = ?",
					)
					.get(fixture.physicalId),
			).toEqual({ settlement_reason: "source_terminal" });
			expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe(
				"active",
			);
			expect(
				rawDb(fixture.store)
					.prepare(
						"SELECT count(*) AS count FROM workflow_run_event WHERE kind = 'delivery_reroute_operator_required'",
					)
					.get(),
			).toEqual({ count: 1 });
		},
	);

	it("does not reopen a mailbox episode parked at the reroute operator door", async () => {
		const fixture = await setupDeadMailbox(
			"operator-door-remains-closed",
			"recipient_terminal",
		);
		const episode = fixture.store.listOpenUndeliverableDeliveryEpisodes()[0];
		if (!episode) throw new Error("operator-door episode missing");
		fixture.store.recordWorkflowDeliveryRerouteOperatorRequired({
			episodeId: episode.episode_id,
			now: "2026-09-04T10:16:00.000Z",
			reason: "delivery_reroute_retry_requires_operator",
			runHeld: false,
			recipientExecutionId: fixture.recipient,
			commEvidence: {
				recentOutboundInWindow: false,
				observedAtMs: Date.parse("2026-09-04T10:16:00.000Z"),
			},
			alertIdentity,
		});
		const successor = "operator-door-remains-closed-next";
		fixture.commDb.registerSession(
			successor,
			"operator-door-remains-closed-window",
			"flywheel",
			"FLY-2337",
			"lead-a",
		);
		fixture.store.upsertSession({
			execution_id: successor,
			issue_id: "FLY-2337",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "worker",
		});
		fixture.store.upsertWorkflowRunNode({
			runId: fixture.runId,
			nodeId: "worker",
			attempt: 2,
			state: "running",
			executionId: successor,
		});

		expect(fixture.runPass("2026-09-04T10:17:00.000Z")).toMatchObject({
			examined: 1,
			rerouted: 0,
			operatorRequired: 0,
		});
		expect(
			rawDb(fixture.store)
				.prepare(
					"SELECT count(*) AS count FROM workflow_delivery_operation WHERE kind = 'reroute'",
				)
				.get(),
		).toEqual({ count: 0 });
		expect(
			rawCommDb(fixture.commDb)
				.prepare("SELECT superseded_by FROM mailbox WHERE id = ?")
				.get(fixture.physicalId),
		).toEqual({ superseded_by: null });
	});

	it("does not rewrite the same warning when a late reroute reaches the operator cap", async () => {
		const fixture = await setupDeadMailbox(
			"late-successor-reroute-failure",
			"recipient_terminal",
		);
		expect(fixture.runPass("2026-09-04T10:16:00.000Z")).toMatchObject({
			operatorRequired: 1,
		});
		const successor = "recipient-late-successor-reroute-failure-next";
		fixture.commDb.registerSession(
			successor,
			"window-late-successor-reroute-failure-next",
			"flywheel",
			"FLY-2337",
			"lead-a",
		);
		fixture.store.upsertSession({
			execution_id: successor,
			issue_id: "FLY-2337",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "worker",
		});
		fixture.store.upsertWorkflowRunNode({
			runId: fixture.runId,
			nodeId: "worker",
			attempt: 2,
			state: "running",
			executionId: successor,
		});
		let failPhysicalReroute = true;
		const commDb = new Proxy(fixture.commDb, {
			get(target, property, receiver) {
				if (property === "rerouteMailboxDelivery") {
					return (input: Parameters<CommDB["rerouteMailboxDelivery"]>[0]) => {
						if (failPhysicalReroute) {
							failPhysicalReroute = false;
							throw new Error("fixture physical reroute failure");
						}
						return target.rerouteMailboxDelivery(input);
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});
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
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(runner.runPass("2026-09-04T10:17:00.000Z")).toMatchObject({
			rerouted: 0,
			operatorRequired: 0,
		});
		expect(runner.runPass("2026-09-04T10:18:00.000Z")).toMatchObject({
			rerouted: 0,
			operatorRequired: 0,
		});
		expect(runner.runPass("2026-09-04T10:19:00.000Z")).toMatchObject({
			rerouted: 0,
			operatorRequired: 0,
		});
		const warnings = warn.mock.calls.map(([message]) => String(message));
		warn.mockRestore();
		expect(
			warnings.some((message) =>
				message.includes("workflow_event_uid_conflict"),
			),
		).toBe(false);
		expect(
			rawDb(fixture.store)
				.prepare(
					"SELECT count(*) AS count FROM workflow_run_event WHERE kind = 'delivery_reroute_operator_required'",
				)
				.get(),
		).toEqual({ count: 1 });
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");
	});

	it("terminalizes a send through the runner lane before warning without holding", async () => {
		const fixture = await setupDeadMailbox(
			"runner-lane-terminal",
			"recipient_terminal",
			true,
		);
		expect(fixture.runPass("2026-09-04T10:02:00.000Z")).toMatchObject({
			examined: 1,
			operatorRequired: 0,
		});
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");
		expect(
			rawDb(fixture.store)
				.prepare(
					"SELECT count(*) AS count FROM workflow_alert_outbox WHERE run_id = ?",
				)
				.get(fixture.runId),
		).toEqual({ count: 0 });
		expect(fixture.runPass("2026-09-04T10:16:00.000Z")).toMatchObject({
			examined: 1,
			operatorRequired: 1,
		});
		expect(
			rawDb(fixture.store)
				.prepare(
					"SELECT count(*) AS count FROM workflow_alert_outbox WHERE run_id = ?",
				)
				.get(fixture.runId),
		).toEqual({ count: 1 });
	});

	it("preserves gate, current-manifest, and unknown-recipient obligations in the runner lane", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2337-runner-obligations-"));
		roots.push(root);
		const queue = new MailboxQueue(join(root, "comm.db"));
		queues.push(queue);
		const ownerEpoch = "runner-lane:fly2337-obligations";
		const now = "2026-09-04T10:01:00.000Z";
		queue.acquireOrRenewOwner({
			ownerEpoch,
			now,
			leaseTtlMs: 60_000,
		});
		const senderRef = encodeSenderRef();
		queue.enqueue({
			id: "fly2337-founder-review",
			fromAgent: "terminal-gate",
			toAgent: "flywheel-eng-lead",
			recipientKind: "lead",
			type: "question",
			checkpoint: "founder_review",
			content: "review the current artifact",
			createdAt: now,
			senderRef,
		});
		queue.enqueue({
			id: "fly2337-founder-review-response",
			fromAgent: "flywheel-eng-lead",
			toAgent: "terminal-gate",
			recipientKind: "runner",
			type: "response",
			refId: "fly2337-founder-review",
			content: "passed",
			createdAt: now,
			senderRef,
		});
		queue.enqueue({
			id: "design-review-manifest:terminal-manifest:3",
			fromAgent: "flywheel-eng-lead",
			toAgent: "terminal-manifest",
			recipientKind: "runner",
			type: "instruction",
			content: "consume the current design manifest",
			createdAt: now,
			senderRef,
		});
		queue.enqueue({
			id: "fly2337-unknown-recipient",
			fromAgent: "flywheel-eng-lead",
			toAgent: "unknown-recipient",
			recipientKind: "runner",
			type: "instruction",
			content: "recipient state is unavailable",
			createdAt: now,
			senderRef,
		});

		const deliver = vi.fn(async () => ({
			status: "failed" as const,
			error: "fixture transport unavailable",
		}));
		const lane = new RunnerMailboxLane({
			queue,
			ownerEpoch,
			deliver,
			resolveQuestion: () => ({ checkpoint: "founder_review" }),
			now: () => new Date(now),
			queueConfig: () => DEFAULT_MAILBOX_QUEUE_CONFIG,
			recipientState: (executionId) =>
				executionId === "unknown-recipient" ? "unknown" : "terminal",
			isTerminalDeliveryObligation: (row) =>
				row.id === "design-review-manifest:terminal-manifest:3",
		});

		expect(await lane.tick()).toMatchObject({ dead: 0, failed: 3 });
		for (const id of [
			"fly2337-founder-review-response",
			"design-review-manifest:terminal-manifest:3",
			"fly2337-unknown-recipient",
		]) {
			expect(queue.getById(id)?.state).not.toBe("DEAD");
		}
		const notices = [
			"fly2337-founder-review-response",
			"design-review-manifest:terminal-manifest:3",
			"fly2337-unknown-recipient",
		].map((id) => queue.getById(`terminalization_refused:${id}`));
		expect(notices).toEqual([
			expect.objectContaining({
				to_agent: "flywheel-eng-lead",
				type: "dead_letter_notice",
				content: expect.stringContaining("protected protocol obligation"),
			}),
			expect.objectContaining({
				to_agent: "flywheel-eng-lead",
				type: "dead_letter_notice",
				content: expect.stringContaining("protected protocol obligation"),
			}),
			expect.objectContaining({
				to_agent: "flywheel-eng-lead",
				type: "dead_letter_notice",
				content: expect.stringContaining("recipient state is unknown"),
			}),
		]);
		await lane.tick();
		expect(
			[
				"fly2337-founder-review-response",
				"design-review-manifest:terminal-manifest:3",
				"fly2337-unknown-recipient",
			].filter((id) => queue.getById(`terminalization_refused:${id}`)),
		).toHaveLength(3);
	});

	it.each([
		["FLY-2332", "review"],
		["FLY-2324", "review"],
		["FLY-2259", "review"],
		["FLY-2146", "running"],
	] as const)(
		"reconciles the production %s node shape through canonical hold resume",
		async (issueId, nodeState) => {
			const fixture = await setupDeadMailbox(
				`legacy-${issueId.toLowerCase()}`,
				"recipient_terminal",
			);
			const legacy = seedLegacyMailboxHold({
				store: fixture.store,
				runId: fixture.runId,
				physicalId: fixture.physicalId,
				fixture: issueId,
				nodeState,
			});
			if (issueId === "FLY-2324") {
				rawCommDb(fixture.commDb)
					.prepare(
						`UPDATE mailbox
						    SET state = 'LEASED', dead_at = NULL, dead_reason = NULL,
						        batch_id = 'fly2337-legacy-batch', claimed_by = 'legacy-push',
						        claim_expires_at = '2026-09-04T10:10:00.000Z'
						  WHERE id = ?`,
					)
					.run(fixture.physicalId);
			}

			expect(
				reconcileLegacyDeadMailboxHolds({
					store: fixture.store,
					commDb: fixture.commDb,
					projectName: "flywheel",
					now: "2026-09-04T10:00:00.000Z",
				}),
			).toMatchObject({ examined: 1, staged: 1, skipped: 0 });
			expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("held");
			fixture.runPass("2026-09-04T10:00:01.000Z");
			expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe(
				"active",
			);
			const receipts = fixture.store
				.listWorkflowRunEvents(fixture.runId)
				.filter(({ kind }) => kind === "hold_resumed");
			expect(receipts).toHaveLength(1);
			expect(receipts[0]?.payload).toMatchObject({
				holdEventUid: legacy.holdEventUid,
			});
			expect(
				rawDb(fixture.store)
					.prepare(
						"SELECT settlement_reason FROM workflow_delivery_attempt WHERE attempt_id = ?",
					)
					.get(legacy.attemptId),
			).toEqual({ settlement_reason: "cancelled_by_operator" });
			expect(
				fixture.commDb.getRunnerDeliveryProjectionRow(fixture.physicalId),
			).toMatchObject({
				state: "DEAD",
				dead_reason:
					issueId === "FLY-2324"
						? expect.stringMatching(/^cancelled_by_operator:/)
						: "recipient_terminal",
			});

			expect(
				reconcileLegacyDeadMailboxHolds({
					store: fixture.store,
					commDb: fixture.commDb,
					projectName: "flywheel",
					now: "2026-09-04T10:01:00.000Z",
				}),
			).toMatchObject({ staged: 0 });
			fixture.runPass("2026-09-04T10:01:01.000Z");
			expect(
				fixture.store
					.listWorkflowRunEvents(fixture.runId)
					.filter(({ kind }) => kind === "hold_resumed"),
			).toHaveLength(1);
		},
	);

	it.each([
		["already-settled", "already_settled", true],
		["superseded", "superseded_or_missing", true],
		["attempt-missing", "superseded_or_missing", true],
	] as const)(
		"projects a canonical %s no-op without a settlement CAS",
		async (sourceCase, expectedResolution, expectedOperatorResumable) => {
			const fixture = await setupDeadMailbox(
				`legacy-${sourceCase}`,
				"recipient_terminal",
			);
			const legacy = seedLegacyMailboxHold({
				store: fixture.store,
				runId: fixture.runId,
				physicalId: fixture.physicalId,
				fixture: "FLY-2332",
				nodeState: "review",
			});
			const db = rawDb(fixture.store);
			if (sourceCase === "already-settled") {
				expect(
					fixture.store.settleProjectedWorkflowDeliveryAttempt({
						family: "mailbox",
						table: "mailbox",
						pk: fixture.physicalId,
						reason: "source_terminal",
						now: "2026-09-04T09:59:00.000Z",
					}),
				).toBe(true);
			} else if (sourceCase === "superseded") {
				const source = db
					.prepare(
						"SELECT root_id, generation FROM workflow_delivery_attempt WHERE attempt_id = ?",
					)
					.get(legacy.attemptId) as { root_id: string; generation: number };
				const childAttemptId = `${source.root_id}:g${source.generation + 1}:a1`;
				db.prepare(
					`INSERT INTO workflow_delivery_attempt
					   (root_id, generation, attempt, attempt_id, family,
					    contract_ref_json, minted_at, settlement_reason)
					 VALUES (?, ?, 1, ?, 'mailbox', ?, ?, 'fixture_terminal')`,
				).run(
					source.root_id,
					source.generation + 1,
					childAttemptId,
					JSON.stringify({ table: "mailbox", pk: "fixture-child" }),
					"2026-09-04T09:59:00.000Z",
				);
				db.prepare(
					"UPDATE workflow_delivery_attempt SET superseded_by_attempt_id = ? WHERE attempt_id = ?",
				).run(childAttemptId, legacy.attemptId);
			} else if (sourceCase === "attempt-missing") {
				db.prepare(
					"DELETE FROM workflow_delivery_contract_episode WHERE attempt_id = ?",
				).run(legacy.attemptId);
				db.prepare(
					"DELETE FROM workflow_delivery_attempt WHERE attempt_id = ?",
				).run(legacy.attemptId);
			}
			const beforeAttempt = db
				.prepare(
					"SELECT settlement_reason, superseded_by_attempt_id FROM workflow_delivery_attempt WHERE attempt_id = ?",
				)
				.get(legacy.attemptId);
			expect(
				fixture.store
					.listWorkflowHolds(fixture.runId)
					.find(({ holdEventUid }) => holdEventUid === legacy.holdEventUid)
					?.resumable,
			).toBe(expectedOperatorResumable);

			if (sourceCase === "already-settled") {
				const normalized = StateStore.canonicalizeHoldResume({
					runId: fixture.runId,
					shape: "delivery_undeliverable_no_recipient",
					holdEventUid: legacy.holdEventUid,
					decision: "cancel",
					reason: "operator accepted the terminal delivery",
					principal: "master",
					clientRequestId: "operator-resume-terminal-mailbox",
				});
				if (!normalized)
					throw new Error("terminal hold canonicalization failed");
				expect(
					fixture.store.resumeWorkflowHold({
						canonical: normalized.canonical,
						digest: normalized.digest,
						now: "2026-09-04T10:00:00.000Z",
					}),
				).toMatchObject({ ok: true, state: "applied" });
			} else {
				expect(
					reconcileLegacyDeadMailboxHolds({
						store: fixture.store,
						commDb: fixture.commDb,
						projectName: "flywheel",
						now: "2026-09-04T10:00:00.000Z",
					}),
				).toMatchObject({ examined: 1, staged: 1, skipped: 0 });
			}
			fixture.runPass("2026-09-04T10:00:01.000Z");
			expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe(
				"active",
			);
			expect(
				fixture.store
					.listWorkflowRunEvents(fixture.runId)
					.find(({ kind }) => kind === "hold_resumed")?.payload,
			).toMatchObject({
				holdEventUid: legacy.holdEventUid,
				resolutionReason: expectedResolution,
			});
			const afterAttempt = db
				.prepare(
					"SELECT settlement_reason, superseded_by_attempt_id FROM workflow_delivery_attempt WHERE attempt_id = ?",
				)
				.get(legacy.attemptId) as
				| {
						settlement_reason: string | null;
						superseded_by_attempt_id: string | null;
				  }
				| undefined;
			if (beforeAttempt) {
				expect(afterAttempt).toEqual(beforeAttempt);
			} else {
				// A normal projector pass may remint missing StateStore evidence from
				// the retained DEAD CommDB row, but reconciliation must not settle it.
				expect(afterAttempt).toMatchObject({
					settlement_reason: null,
					superseded_by_attempt_id: null,
				});
			}
		},
	);

	it("rejects a terminal no-op hint when the authoritative attempt is live", async () => {
		const fixture = await setupDeadMailbox(
			"legacy-live-source-hint",
			"recipient_terminal",
		);
		const legacy = seedLegacyMailboxHold({
			store: fixture.store,
			runId: fixture.runId,
			physicalId: fixture.physicalId,
			fixture: "FLY-2332",
			nodeState: "review",
		});
		const normalized = StateStore.canonicalizeHoldResume({
			runId: fixture.runId,
			shape: "delivery_undeliverable_no_recipient",
			holdEventUid: legacy.holdEventUid,
			decision: "cancel",
			reason: "stale caller hint",
			principal: "master",
			clientRequestId: "terminal-noop-hint-live-source",
		});
		if (!normalized)
			throw new Error("live source hint canonicalization failed");

		expect(
			fixture.store.resumeWorkflowHold({
				canonical: normalized.canonical,
				digest: normalized.digest,
				now: "2026-09-04T10:00:00.000Z",
				sourceResolution: "superseded_or_missing",
			}),
		).toEqual({ ok: false, reason: "hold_changed" });
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("held");
		expect(
			rawDb(fixture.store)
				.prepare(
					"SELECT count(*) AS count FROM workflow_delivery_operation WHERE client_request_id = ?",
				)
				.get("terminal-noop-hint-live-source"),
		).toEqual({ count: 0 });
	});

	it("keeps a live legacy obligation held when its physical projection is missing", async () => {
		const fixture = await setupDeadMailbox(
			"legacy-live-projection-missing",
			"recipient_terminal",
		);
		const legacy = seedLegacyMailboxHold({
			store: fixture.store,
			runId: fixture.runId,
			physicalId: fixture.physicalId,
			fixture: "FLY-2332",
			nodeState: "review",
		});
		vi.spyOn(fixture.commDb, "getRunnerDeliveryProjectionRow").mockReturnValue(
			undefined,
		);

		expect(
			reconcileLegacyDeadMailboxHolds({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
				now: "2026-09-04T10:00:00.000Z",
			}),
		).toMatchObject({ examined: 1, staged: 0, skipped: 1 });
		const db = rawDb(fixture.store);
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("held");
		expect(
			db
				.prepare(
					`SELECT settlement_reason, superseded_by_attempt_id
					   FROM workflow_delivery_attempt WHERE attempt_id = ?`,
				)
				.get(legacy.attemptId),
		).toEqual({ settlement_reason: null, superseded_by_attempt_id: null });
		expect(
			db
				.prepare(
					`SELECT closed_at FROM workflow_delivery_contract_episode
					  WHERE attempt_id = ? AND stage = 'undeliverable'`,
				)
				.get(legacy.attemptId),
		).toEqual({ closed_at: null });
		expect(
			db
				.prepare(
					`SELECT count(*) AS count FROM workflow_delivery_operation
					  WHERE kind = 'hold_resume' AND hold_event_uid = ?`,
				)
				.get(legacy.holdEventUid),
		).toEqual({ count: 0 });
	});

	it.each([
		["run-not-held", "run_not_held"],
		["run-terminated", "run_not_held"],
		["no-working-node", "no_running_or_review_node"],
		["blocking-rework", "rework_blocked"],
		["blocking-carrier", "carrier_blocked"],
		["other-run-hold", "other_run_hold"],
	] as const)(
		"fails closed for legacy reconcile guard %s",
		async (guard, expectedReason) => {
			const fixture = await setupDeadMailbox(
				`legacy-guard-${guard}`,
				"recipient_terminal",
			);
			seedLegacyMailboxHold({
				store: fixture.store,
				runId: fixture.runId,
				physicalId: fixture.physicalId,
				fixture: "FLY-2332",
				nodeState: "review",
			});
			const db = rawDb(fixture.store);
			switch (guard) {
				case "run-not-held":
					db.prepare(
						"UPDATE workflow_run SET status = 'active' WHERE run_id = ?",
					).run(fixture.runId);
					break;
				case "run-terminated":
					db.prepare(
						"UPDATE workflow_run SET status = 'terminated' WHERE run_id = ?",
					).run(fixture.runId);
					break;
				case "no-working-node":
					db.prepare(
						"UPDATE workflow_run_node SET state = 'completed' WHERE run_id = ?",
					).run(fixture.runId);
					break;
				case "blocking-rework":
					seedBlockingRework(fixture.store, fixture.runId);
					break;
				case "blocking-carrier":
					seedHeldCarrier(fixture.store, fixture.runId, "independent_failure");
					break;
				case "other-run-hold":
					fixture.store.appendWorkflowRunEvent({
						runId: fixture.runId,
						eventUid: `independent-run-hold:${fixture.runId}`,
						kind: "run_held_by_operator",
						payload: { reason: "independent_manual_hold" },
					});
					break;
			}

			const filteredByRunStatus =
				guard === "run-not-held" || guard === "run-terminated";
			expect(
				fixture.store.listLegacyDeadMailboxHoldReconcileCandidates("flywheel"),
			).toEqual(
				filteredByRunStatus
					? []
					: [
							expect.objectContaining({
								eligible: false,
								reason: expectedReason,
							}),
						],
			);
			expect(
				reconcileLegacyDeadMailboxHolds({
					store: fixture.store,
					commDb: fixture.commDb,
					projectName: "flywheel",
					now: "2026-09-04T10:00:00.000Z",
				}),
			).toEqual(
				filteredByRunStatus
					? { examined: 0, staged: 0, skipped: 0, failed: 0 }
					: { examined: 1, staged: 0, skipped: 1, failed: 0 },
			);
			expect(
				fixture.store
					.listWorkflowRunEvents(fixture.runId)
					.some(({ kind }) => kind === "hold_resumed"),
			).toBe(false);
		},
	);

	it("rechecks legacy reconcile guards transactionally before staging", async () => {
		const fixture = await setupDeadMailbox(
			"legacy-stage-guard-race",
			"recipient_terminal",
		);
		const legacy = seedLegacyMailboxHold({
			store: fixture.store,
			runId: fixture.runId,
			physicalId: fixture.physicalId,
			fixture: "FLY-2332",
			nodeState: "review",
		});
		const listCandidates =
			fixture.store.listLegacyDeadMailboxHoldReconcileCandidates.bind(
				fixture.store,
			);
		vi.spyOn(
			fixture.store,
			"listLegacyDeadMailboxHoldReconcileCandidates",
		).mockImplementationOnce((projectName) => {
			const candidates = listCandidates(projectName);
			seedBlockingRework(fixture.store, fixture.runId);
			return candidates;
		});

		expect(
			reconcileLegacyDeadMailboxHolds({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
				now: "2026-09-04T10:00:00.000Z",
			}),
		).toEqual({ examined: 1, staged: 0, skipped: 1, failed: 0 });
		expect(
			rawDb(fixture.store)
				.prepare(
					`SELECT count(*) AS count FROM workflow_delivery_operation
					  WHERE kind = 'hold_resume' AND hold_event_uid = ?`,
				)
				.get(legacy.holdEventUid),
		).toEqual({ count: 0 });
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("held");
	});

	it("rechecks legacy reconcile guards before projecting the run active", async () => {
		const fixture = await setupDeadMailbox(
			"legacy-projection-guard-race",
			"recipient_terminal",
		);
		const legacy = seedLegacyMailboxHold({
			store: fixture.store,
			runId: fixture.runId,
			physicalId: fixture.physicalId,
			fixture: "FLY-2332",
			nodeState: "review",
		});
		expect(
			reconcileLegacyDeadMailboxHolds({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
				now: "2026-09-04T10:00:00.000Z",
			}),
		).toEqual({ examined: 1, staged: 1, skipped: 0, failed: 0 });

		seedBlockingRework(fixture.store, fixture.runId);
		fixture.runPass("2026-09-04T10:00:01.000Z");
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("held");
		expect(
			fixture.store
				.listWorkflowRunEvents(fixture.runId)
				.some(({ kind }) => kind === "hold_resumed"),
		).toBe(false);
		expect(
			rawDb(fixture.store)
				.prepare(
					`SELECT state FROM workflow_delivery_operation
					  WHERE kind = 'hold_resume' AND hold_event_uid = ?`,
				)
				.get(legacy.holdEventUid),
		).toEqual({ state: "applied" });

		rawDb(fixture.store)
			.prepare(
				`UPDATE workflow_rework_delivery SET state = 'completed'
				  WHERE request_id = ?`,
			)
			.run(`blocking-rework:${fixture.runId}`);
		fixture.runPass("2026-09-04T10:00:02.000Z");
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");
		expect(
			fixture.store
				.listWorkflowRunEvents(fixture.runId)
				.filter(({ kind }) => kind === "hold_resumed"),
		).toHaveLength(1);
	});

	it("treats run-inactive held carriers as blocking legacy reconciliation", async () => {
		const fixture = await setupDeadMailbox(
			"legacy-derived-carrier",
			"recipient_terminal",
		);
		seedLegacyMailboxHold({
			store: fixture.store,
			runId: fixture.runId,
			physicalId: fixture.physicalId,
			fixture: "FLY-2332",
			nodeState: "review",
		});
		const questionId = seedHeldCarrier(
			fixture.store,
			fixture.runId,
			"run_inactive:held",
		);

		expect(
			fixture.store.listLegacyDeadMailboxHoldReconcileCandidates("flywheel"),
		).toEqual([
			expect.objectContaining({ eligible: false, reason: "carrier_blocked" }),
		]);
		expect(
			reconcileLegacyDeadMailboxHolds({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "flywheel",
				now: "2026-09-04T10:00:00.000Z",
			}),
		).toEqual({ examined: 1, staged: 0, skipped: 1, failed: 0 });
		fixture.runPass("2026-09-04T10:00:01.000Z");
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("held");
		expect(
			rawDb(fixture.store)
				.prepare(
					"SELECT state, last_error FROM workflow_carrier_delivery WHERE question_id = ?",
				)
				.get(questionId),
		).toEqual({
			state: "held",
			last_error: "run_inactive:held",
		});
	});

	it("scopes legacy reconciliation to one project", async () => {
		const fixture = await setupDeadMailbox(
			"legacy-project-physical-guards",
			"recipient_terminal",
		);
		seedLegacyMailboxHold({
			store: fixture.store,
			runId: fixture.runId,
			physicalId: fixture.physicalId,
			fixture: "FLY-2332",
			nodeState: "review",
		});
		expect(
			reconcileLegacyDeadMailboxHolds({
				store: fixture.store,
				commDb: fixture.commDb,
				projectName: "another-project",
				now: "2026-09-04T10:00:00.000Z",
			}),
		).toEqual({ examined: 0, staged: 0, skipped: 0, failed: 0 });
	});

	it("runs the project-scoped reconcile before normal maintenance in an isolated guard", () => {
		const source = readFileSync(
			new URL("../bridge/plugin.ts", import.meta.url),
			"utf8",
		);
		const maintenance = source.indexOf("const deliveryProjector =");
		const reconcile = source.indexOf(
			"legacyDeadMailboxHoldReconciler.runPass({",
			maintenance,
		);
		const projector = source.indexOf(
			"deliveryProjector.runPass(deliveryNow, cursor)",
			maintenance,
		);
		expect(maintenance).toBeGreaterThanOrEqual(0);
		expect(reconcile).toBeGreaterThan(maintenance);
		expect(projector).toBeGreaterThan(reconcile);
		expect(source.slice(reconcile, projector)).toContain("catch (error)");
		expect(source.slice(reconcile, projector)).toContain("projectName");
	});

	it("surfaces malformed legacy evidence and canonical resume refusal", async () => {
		const malformed = await setupDeadMailbox(
			"legacy-malformed-evidence",
			"recipient_terminal",
		);
		const malformedDb = rawDb(malformed.store);
		malformedDb
			.prepare(
				`INSERT INTO workflow_run_event
				   (run_id, seq, event_uid, kind, payload, at)
				 VALUES (?, 99, 'legacy-malformed',
				         'delivery_reroute_operator_required', ?, ?)`,
			)
			.run(
				malformed.runId,
				'{"reason":"delivery_undeliverable_no_recipient",',
				"2026-09-04T09:58:00.000Z",
			);
		malformedDb
			.prepare("UPDATE workflow_run SET status = 'held' WHERE run_id = ?")
			.run(malformed.runId);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(
			malformed.store.listLegacyDeadMailboxHoldReconcileCandidates("flywheel"),
		).toEqual([]);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("legacy-malformed"),
		);
		warn.mockRestore();

		const refused = await setupDeadMailbox(
			"legacy-resume-refused",
			"recipient_terminal",
		);
		seedLegacyMailboxHold({
			store: refused.store,
			runId: refused.runId,
			physicalId: refused.physicalId,
			fixture: "FLY-2332",
			nodeState: "review",
		});
		vi.spyOn(refused.store, "resumeWorkflowHold").mockReturnValue({
			ok: false,
			reason: "hold_changed",
		});
		const refusalWarn = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		expect(
			reconcileLegacyDeadMailboxHolds({
				store: refused.store,
				commDb: refused.commDb,
				projectName: "flywheel",
				now: "2026-09-04T10:00:00.000Z",
			}),
		).toEqual({ examined: 1, staged: 0, skipped: 1, failed: 0 });
		expect(refusalWarn).toHaveBeenCalledWith(
			expect.stringContaining("hold_changed"),
		);
		refusalWarn.mockRestore();
	});
});

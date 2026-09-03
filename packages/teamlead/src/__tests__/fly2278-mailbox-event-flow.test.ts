import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { createTestLeadIdentityEnvs } from "../../../flywheel-comm/src/__tests__/helpers/lead-identity-env.js";
import { send } from "../../../flywheel-comm/src/commands/send.js";
import { MailboxQueue } from "../../../flywheel-comm/src/mailbox-queue.js";
import { MAILBOX_SLOT_FREEZE_AFTER_MS } from "../bridge/delivery-contract/policy.js";
import { DeliveryProjector } from "../bridge/delivery-contract/projector.js";
import { DeliveryContractWatch } from "../bridge/delivery-contract/watch.js";
import { DeliveryOperations } from "../bridge/delivery-operations.js";
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
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

async function terminalUnackedMailbox(caseId: string) {
	const root = mkdtempSync(join(tmpdir(), `fly2278-mailbox-${caseId}-`));
	roots.push(root);
	const dbPath = join(root, "comm.db");
	const recipient = `recipient-${caseId}`;
	const bootstrap = new CommDB(dbPath);
	bootstrap.registerSession(
		recipient,
		`window-${caseId}`,
		"flywheel",
		"FLY-2278",
		"lead-a",
	);
	bootstrap.close();
	const instructionId = await send({
		fromAgent: "lead-a",
		toAgent: recipient,
		content: `instruction:${caseId}`,
		dbPath,
		env: createTestLeadIdentityEnvs(root, ["lead-a"])["lead-a"]!,
	});
	const commDb = new CommDB(dbPath);
	commDbs.push(commDb);
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const runId = `run-${caseId}`;
	store.createWorkflowRun({
		runId,
		issueId: "FLY-2278",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.upsertSession({
		execution_id: recipient,
		issue_id: "FLY-2278",
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
	expect(projector.runPass("2026-09-03T18:00:00.000Z")).toMatchObject({
		examined: 1,
		minted: 1,
	});
	commDb.markSessionTerminalStatus(recipient, "completed");
	store.upsertSession({
		execution_id: recipient,
		issue_id: "FLY-2278",
		project_name: "flywheel",
		status: "completed",
		workflow_node_id: "worker",
	});
	projector.runPass("2026-09-03T18:01:00.000Z");
	const watch = new DeliveryContractWatch({
		store,
		commDb,
		projectName: "flywheel",
		resolveAlertIdentity: () => alertIdentity,
	});
	expect(watch.runPass("2026-09-03T18:01:00.000Z")).toMatchObject({
		opened: 1,
	});
	const attempt = store
		.listLiveWorkflowDeliveryAttempts()
		.find(
			(candidate) =>
				JSON.parse(candidate.contract_ref_json).pk === instructionId,
		);
	if (!attempt) throw new Error("terminal-unacked mailbox attempt disappeared");
	const episode = rawDb(store)
		.prepare(
			"SELECT episode_id, stage FROM workflow_delivery_contract_episode WHERE attempt_id = ? AND closed_at IS NULL",
		)
		.get(attempt.attempt_id) as
		| { episode_id: string; stage: string }
		| undefined;
	expect(episode).toMatchObject({ stage: "undeliverable" });
	return {
		store,
		commDb,
		runId,
		recipient,
		instructionId,
		attempt,
		episode: episode!,
	};
}

function operations(store: StateStore, commDb: CommDB) {
	return new DeliveryOperations({
		store,
		commDb,
		projectName: "flywheel",
		resolveRecipient: ({ rootId, sourceExecutionId }) =>
			store.resolveWorkflowDeliveryRecipient(rootId, sourceExecutionId),
		resolveAlertIdentity: () => alertIdentity,
	});
}

describe("FLY-2278 terminal-unacked mailbox event flow", () => {
	it("keeps the real sent instruction live and reroutes to a successor during grace", async () => {
		const fixture = await terminalUnackedMailbox("successor-grace");
		expect(
			operations(fixture.store, fixture.commDb).runPass(
				"2026-09-03T18:14:59.000Z",
			),
		).toMatchObject({ examined: 1, rerouted: 0, operatorRequired: 0 });
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");
		const successor = "recipient-successor-grace-next";
		fixture.commDb.registerSession(
			successor,
			"window-successor-grace-next",
			"flywheel",
			"FLY-2278",
			"lead-a",
		);
		fixture.store.upsertSession({
			execution_id: successor,
			issue_id: "FLY-2278",
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
			operations(fixture.store, fixture.commDb).runPass(
				"2026-09-03T18:15:00.000Z",
			),
		).toMatchObject({ examined: 1, rerouted: 1, operatorRequired: 0 });
		const operation = rawDb(fixture.store)
			.prepare(
				"SELECT state FROM workflow_delivery_operation WHERE source_attempt_id = ?",
			)
			.get(fixture.attempt.attempt_id);
		expect(operation).toEqual({ state: "projected" });
		expect(fixture.commDb.getMessageById(fixture.instructionId)).toMatchObject({
			superseded_by: expect.any(String),
		});
		const child = fixture.store
			.listLiveWorkflowDeliveryAttempts()
			.find(
				(attempt) => attempt.parent_attempt_id === fixture.attempt.attempt_id,
			);
		if (!child) throw new Error("rerouted mailbox child missing");
		const childRef = JSON.parse(child.contract_ref_json) as { pk: string };
		expect(childRef.pk).not.toBe(fixture.instructionId);
		expect(fixture.commDb.getMessageById(childRef.pk)).toMatchObject({
			to_agent: successor,
		});
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");
	});

	it("waits the grace period and then holds exactly once without liveness", async () => {
		const fixture = await terminalUnackedMailbox("grace-hold");
		const runner = operations(fixture.store, fixture.commDb);
		expect(runner.runPass("2026-09-03T18:15:59.999Z")).toMatchObject({
			examined: 1,
			operatorRequired: 0,
		});
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");
		expect(runner.runPass("2026-09-03T18:16:00.000Z")).toMatchObject({
			examined: 1,
			operatorRequired: 1,
		});
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("held");
		expect(runner.runPass("2026-09-03T18:17:00.000Z")).toMatchObject({
			examined: 1,
			operatorRequired: 0,
		});
		expect(
			rawDb(fixture.store)
				.prepare(
					"SELECT count(*) AS count FROM workflow_run_event WHERE kind = 'delivery_reroute_operator_required'",
				)
				.get(),
		).toEqual({ count: 1 });
	});
});

describe("FLY-2278 mailbox freeze event flow", () => {
	it("freezes only after three real delivered batches exceed the threshold without liveness", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2278-mailbox-freeze-"));
		roots.push(root);
		const dbPath = join(root, "comm.db");
		const recipient = "recipient-freeze";
		const bootstrap = new CommDB(dbPath);
		bootstrap.registerSession(
			recipient,
			"window-freeze",
			"flywheel",
			"FLY-2278",
			"lead-a",
		);
		bootstrap.close();
		const leadEnv = createTestLeadIdentityEnvs(root, ["lead-a"])["lead-a"]!;
		for (let index = 0; index < 4; index += 1) {
			await send({
				fromAgent: "lead-a",
				toAgent: recipient,
				content: `freeze:${index}`,
				dbPath,
				env: leadEnv,
			});
		}
		const baseMs = Date.now() + 60_000;
		const queue = new MailboxQueue(dbPath);
		queues.push(queue);
		queue.acquireOrRenewOwner({
			ownerEpoch: "freeze-owner",
			now: new Date(baseMs).toISOString(),
			leaseTtlMs: 3_600_000,
		});
		for (let index = 0; index < 3; index += 1) {
			const at = new Date(baseMs + index * 1_000).toISOString();
			const batch = queue.claimRunnerBatch({
				ownerEpoch: "freeze-owner",
				now: at,
				transportClaimTtlMs: 3_600_000,
				batchWindowMs: 0,
				batchMaxSize: 1,
				inflightMaxBatches: 3,
			});
			expect(batch).toHaveLength(1);
			expect(
				queue.recordRunnerBatchDelivered({
					batchId: batch![0]!.batch_id!,
					ownerEpoch: "freeze-owner",
					now: at,
					ackLeaseTtlMs: 3_600_000,
					settlement: "on_consume",
				}),
			).toBe("applied");
		}
		const commDb = new CommDB(dbPath);
		commDbs.push(commDb);
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.createWorkflowRun({
			runId: "run-freeze",
			issueId: "FLY-2278",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.upsertSession({
			execution_id: recipient,
			issue_id: "FLY-2278",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "worker",
			heartbeat_at: new Date(baseMs - 3_600_000).toISOString(),
		});
		store.upsertWorkflowRunNode({
			runId: "run-freeze",
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
		projector.runPass(new Date(baseMs + 3_000).toISOString());
		const watch = new DeliveryContractWatch({
			store,
			commDb,
			projectName: "flywheel",
			resolveAlertIdentity: () => alertIdentity,
		});
		const oldAt = baseMs + MAILBOX_SLOT_FREEZE_AFTER_MS;
		expect(
			commDb.listRunnerDeliveryProjectionRows(new Date(oldAt).toISOString())[0]
				?.inflight_batch_count,
		).toBe(3);
		watch.runPass(new Date(oldAt - 1).toISOString());
		expect(store.getWorkflowRun("run-freeze")?.status).toBe("active");
		watch.runPass(new Date(oldAt).toISOString());
		expect(store.getWorkflowRun("run-freeze")?.status).toBe("held");
		const event = store
			.listWorkflowRunEvents("run-freeze")
			.find(
				(candidate) => candidate.kind === "mailbox_inflight_slots_exhausted",
			);
		expect(event?.payload).toMatchObject({
			thresholdMs: MAILBOX_SLOT_FREEZE_AFTER_MS,
			ageMs: MAILBOX_SLOT_FREEZE_AFTER_MS,
			livenessVerdict: "absent",
			runHeld: true,
		});
	});
});

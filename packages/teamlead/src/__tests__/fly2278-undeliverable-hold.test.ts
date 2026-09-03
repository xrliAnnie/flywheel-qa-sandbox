import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { UNDELIVERABLE_GRACE_MS } from "../bridge/delivery-contract/policy.js";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const openedAt = "2026-09-03T16:00:00.000Z";
const openedAtMs = Date.parse(openedAt);
const alertIdentity = {
	leadId: "flywheel-eng-lead",
	projectName: "flywheel",
	leadResolution: "resolved" as const,
};

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

function snapshotHoldWrites(store: StateStore): string {
	const db = rawDb(store);
	return JSON.stringify({
		run: db.prepare("SELECT * FROM workflow_run ORDER BY run_id").all(),
		episodes: db
			.prepare(
				"SELECT * FROM workflow_delivery_contract_episode ORDER BY episode_id",
			)
			.all(),
		events: db
			.prepare("SELECT * FROM workflow_run_event ORDER BY event_uid")
			.all(),
		alerts: db
			.prepare("SELECT * FROM workflow_alert_outbox ORDER BY escalation_uid")
			.all(),
	});
}

async function setup(input: {
	caseId: string;
	lastActivityAt?: string;
	withSourceNode?: boolean;
}): Promise<{
	store: StateStore;
	runId: string;
	executionId: string;
	attemptId: string;
	episodeId: string;
}> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const runId = `run-${input.caseId}`;
	const executionId = `exec-${input.caseId}`;
	const physicalId = `mail-${input.caseId}`;
	const rootId = `flywheel:FLY-2278:mailbox:${physicalId}`;
	const attemptId = `${rootId}:g1:a1`;
	store.createWorkflowRun({
		runId,
		issueId: "FLY-2278",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.upsertSession({
		execution_id: executionId,
		issue_id: "FLY-2278",
		project_name: "flywheel",
		status: "completed",
		...(input.lastActivityAt
			? { last_activity_at: input.lastActivityAt }
			: { heartbeat_at: "2026-09-03T15:00:00.000Z" }),
	});
	if (input.withSourceNode) {
		store.upsertWorkflowRunNode({
			runId,
			nodeId: "worker",
			attempt: 1,
			state: "completed",
			executionId,
		});
	}
	store.projectWorkflowDeliveryAttempt({
		rootId,
		attemptId,
		family: "mailbox",
		contractRef: { table: "mailbox", pk: physicalId },
		mintedAt: "2026-09-03T15:00:00.000Z",
	});
	const attempt = store
		.listLiveWorkflowDeliveryAttempts()
		.find((row) => row.attempt_id === attemptId)!;
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
		now: openedAt,
		alertIdentity,
	});
	const episodeId = (
		rawDb(store)
			.prepare(
				"SELECT episode_id FROM workflow_delivery_contract_episode WHERE closed_at IS NULL",
			)
			.get() as { episode_id: string }
	).episode_id;
	return { store, runId, executionId, attemptId, episodeId };
}

function holdAt(input: {
	store: StateStore;
	episodeId: string;
	executionId: string;
	atMs: number;
}) {
	return input.store.holdWorkflowUndeliverable({
		episodeId: input.episodeId,
		recipientExecutionId: input.executionId,
		commEvidence: {
			recentOutboundInWindow: false,
			observedAtMs: input.atMs,
		},
		now: new Date(input.atMs).toISOString(),
		alertIdentity,
	});
}

describe("FLY-2278 M2 undeliverable hold writer", () => {
	it("writes nothing before grace and one operator-required run hold at grace", async () => {
		const fixture = await setup({ caseId: "grace" });
		const before = snapshotHoldWrites(fixture.store);
		expect(
			holdAt({
				...fixture,
				atMs: openedAtMs + UNDELIVERABLE_GRACE_MS - 1,
			}),
		).toEqual({ held: false, reason: "grace_pending" });
		expect(snapshotHoldWrites(fixture.store)).toBe(before);
		expect(
			holdAt({
				...fixture,
				atMs: openedAtMs + UNDELIVERABLE_GRACE_MS,
			}),
		).toEqual({ held: true, reason: "operator_required" });
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("held");
		expect(
			rawDb(fixture.store)
				.prepare(
					"SELECT payload FROM workflow_run_event WHERE kind = 'delivery_reroute_operator_required'",
				)
				.all(),
		).toHaveLength(1);
		expect(
			rawDb(fixture.store)
				.prepare(
					"SELECT count(*) AS count FROM workflow_alert_outbox WHERE escalation_uid = ?",
				)
				.get(`delivery_reroute_outcome:${fixture.attemptId}`),
		).toEqual({ count: 1 });
		expect(
			fixture.store
				.listWorkflowAlertOutbox()
				.find(
					(row) =>
						row.escalation_uid ===
						`delivery_reroute_outcome:${fixture.attemptId}`,
				)?.payload.body,
		).toBe(
			`FLY-2278 收件体已终结且 15 分钟内无后继、无活性证据(absent)，run 已冻结。runId ${fixture.runId}；证据戳 2026-09-03T16:15:00.000Z；正门：\`flywheel-comm hold list --run ${fixture.runId}\`；恢复：\`flywheel-comm hold resume --shape delivery_undeliverable_no_recipient --decision '<reroute_to <exec> | cancel>' --run ${fixture.runId} --hold-event delivery_reroute_operator_required:${fixture.episodeId} --reason 'operator-confirmed'\``,
		);
	});

	it("does not hold while evidence is alive and upgrades after it ages out", async () => {
		const fixture = await setup({
			caseId: "alive-to-absent",
			lastActivityAt: "2026-09-03T16:14:00.000Z",
		});
		expect(
			holdAt({
				...fixture,
				atMs: openedAtMs + UNDELIVERABLE_GRACE_MS,
			}),
		).toEqual({ held: false, reason: "recipient_alive" });
		expect(
			holdAt({
				...fixture,
				atMs: Date.parse("2026-09-03T16:24:00.001Z"),
			}),
		).toEqual({ held: true, reason: "operator_required" });
	});

	it("rechecks a successor admitted after observation and writes nothing", async () => {
		const fixture = await setup({
			caseId: "successor-barrier",
			withSourceNode: true,
		});
		const successorExecutionId = `${fixture.executionId}-successor`;
		fixture.store.upsertSession({
			execution_id: successorExecutionId,
			issue_id: "FLY-2278",
			project_name: "flywheel",
			status: "running",
		});
		fixture.store.upsertWorkflowRunNode({
			runId: fixture.runId,
			nodeId: "worker",
			attempt: 2,
			state: "running",
			executionId: successorExecutionId,
		});
		const before = snapshotHoldWrites(fixture.store);
		expect(
			holdAt({
				...fixture,
				atMs: openedAtMs + UNDELIVERABLE_GRACE_MS,
			}),
		).toEqual({ held: false, reason: "successor_available" });
		expect(snapshotHoldWrites(fixture.store)).toBe(before);
	});

	it("keeps a cap escalation non-holding and monotonic when its successor later disappears", async () => {
		const fixture = await setup({ caseId: "cap-monotonic" });
		const atMs = openedAtMs + UNDELIVERABLE_GRACE_MS;
		fixture.store.recordWorkflowDeliveryRerouteOperatorRequired({
			episodeId: fixture.episodeId,
			now: new Date(atMs).toISOString(),
			reason: "delivery_reroute_limit_exhausted",
			runHeld: false,
			recipientExecutionId: fixture.executionId,
			commEvidence: {
				recentOutboundInWindow: false,
				observedAtMs: atMs,
			},
			alertIdentity,
		});
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");
		const event = rawDb(fixture.store)
			.prepare(
				"SELECT payload FROM workflow_run_event WHERE kind = 'delivery_reroute_operator_required'",
			)
			.get() as { payload: string };
		expect(JSON.parse(event.payload)).toMatchObject({
			runHeld: false,
			recipientExecutionId: fixture.executionId,
			livenessVerdict: "absent",
			recentOutboundInWindow: false,
			thresholdMs: UNDELIVERABLE_GRACE_MS,
		});
		expect(holdAt({ ...fixture, atMs: atMs + 1 })).toEqual({
			held: false,
			reason: "operator_already_required",
		});
		expect(fixture.store.getWorkflowRun(fixture.runId)?.status).toBe("active");
		expect(
			rawDb(fixture.store)
				.prepare(
					"SELECT count(*) AS count FROM workflow_run_event WHERE kind = 'delivery_reroute_operator_required'",
				)
				.get(),
		).toEqual({ count: 1 });
	});
});

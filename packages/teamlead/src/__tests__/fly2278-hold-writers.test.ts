import type Database from "better-sqlite3";
import type {
	RunnerDeliveryProjectionRow,
	RunnerTurnWakeProjectionRow,
} from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { MAILBOX_SLOT_FREEZE_AFTER_MS } from "../bridge/delivery-contract/policy.js";
import { observeRunnerMailboxDelivery } from "../bridge/delivery-contract/sources/mailbox.js";
import { observeRunnerTurnWakeDelivery } from "../bridge/delivery-contract/sources/turn-wake.js";
import {
	type FreezeDecisionInput,
	shouldFreeze,
	shouldHoldUndeliverable,
} from "../bridge/hold-writers.js";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const now = "2026-09-03T16:00:00.000Z";
const nowMs = Date.parse(now);

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

function snapshotHoldTables(store: StateStore): string {
	const db = rawDb(store);
	return JSON.stringify({
		runs: db.prepare("SELECT * FROM workflow_run ORDER BY run_id").all(),
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
	status: "running" | "completed";
	liveness: "alive" | "absent" | "unknown";
}): Promise<{ store: StateStore; attemptId: string; rootId: string }> {
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
		status: input.status,
		...(input.liveness === "alive"
			? { last_activity_at: "2026-09-03T15:59:00.000Z" }
			: input.liveness === "absent"
				? { heartbeat_at: "2026-09-03T15:00:00.000Z" }
				: {}),
	});
	store.projectWorkflowDeliveryAttempt({
		rootId,
		attemptId,
		family: "mailbox",
		contractRef: { table: "mailbox", pk: physicalId },
		mintedAt: "2026-09-03T15:00:00.000Z",
	});
	return { store, attemptId, rootId };
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

const matrix = (["young", "old"] as const).flatMap((age) =>
	(["running", "completed"] as const).flatMap((status) =>
		(["alive", "absent", "unknown"] as const).map((liveness) => ({
			caseId: `${age}-${status}-${liveness}`,
			age,
			status,
			liveness,
			expectedHeld:
				age === "old" && status === "running" && liveness !== "alive",
		})),
	),
);

describe("FLY-2278 M2 hold writers", () => {
	it.each([
		[false, true, null, "absent", false],
		[true, false, null, "absent", false],
		[true, true, "successor", "absent", false],
		[true, true, null, "alive", false],
		[true, true, null, "absent", true],
		[true, true, null, "unknown", true],
	] as const)(
		"holds undeliverable only after grace without a successor or liveness (%s,%s,%s,%s)",
		(
			graceElapsed,
			recipientTerminal,
			successorExecutionId,
			liveness,
			expected,
		) => {
			expect(
				shouldHoldUndeliverable({
					graceElapsed,
					recipientTerminal,
					successorExecutionId,
					liveness,
				}),
			).toBe(expected);
		},
	);

	it("keeps mailbox and TURN source detection free of threshold and liveness policy", () => {
		expect(
			observeRunnerMailboxDelivery({
				state: "QUEUED",
				acked_at: null,
				superseded_by: null,
				dead_reason: null,
				recipient_status: "running",
				inflight_batch_count: 3,
				oldest_inflight_delivered_at: "2026-09-03T15:59:59.999Z",
			} as RunnerDeliveryProjectionRow),
		).toMatchObject({
			shapeId: "mailbox_inflight_slots_exhausted",
			shapeSince: "2026-09-03T15:59:59.999Z",
		});
		expect(
			observeRunnerTurnWakeDelivery({
				state: "sent",
				acked_at: null,
				push_count: 2,
				first_push_at: Date.parse("2026-09-03T15:59:59.999Z"),
			} as RunnerTurnWakeProjectionRow),
		).toMatchObject({
			shapeId: "three_stage_turn_stuck",
			shapeSince: "2026-09-03T15:59:59.999Z",
		});
	});

	it.each(matrix)(
		"enforces threshold + live status + liveness for $caseId",
		async ({ caseId, age, status, liveness, expectedHeld }) => {
			const decision: FreezeDecisionInput = {
				ageMs:
					age === "old"
						? MAILBOX_SLOT_FREEZE_AFTER_MS
						: MAILBOX_SLOT_FREEZE_AFTER_MS - 1,
				thresholdMs: MAILBOX_SLOT_FREEZE_AFTER_MS,
				sessionStatus: status,
				liveness,
			};
			expect(shouldFreeze(decision)).toBe(expectedHeld);
			const { store, attemptId, rootId } = await setup({
				caseId,
				status,
				liveness,
			});
			const before = snapshotHoldTables(store);
			const result = store.freezeWorkflowDelivery({
				runId: `run-${caseId}`,
				shape: "mailbox_inflight_slots_exhausted",
				attemptId,
				rootId,
				physicalId: `mail-${caseId}`,
				recipientExecutionId: `exec-${caseId}`,
				shapeSince: new Date(nowMs - decision.ageMs).toISOString(),
				thresholdMs: decision.thresholdMs,
				commEvidence: {
					recentOutboundInWindow: false,
					observedAtMs: nowMs,
				},
				now,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			});
			expect(result.held).toBe(expectedHeld);
			if (!expectedHeld) {
				expect(snapshotHoldTables(store)).toBe(before);
				return;
			}
			expect(store.getWorkflowRun(`run-${caseId}`)?.status).toBe("held");
			expect(
				rawDb(store)
					.prepare(
						"SELECT stage FROM workflow_delivery_contract_episode WHERE closed_at IS NULL",
					)
					.all(),
			).toEqual([{ stage: "mailbox_inflight_slots_exhausted" }]);
			expect(
				rawDb(store)
					.prepare("SELECT kind FROM workflow_run_event ORDER BY event_uid")
					.all(),
			).toEqual([{ kind: "mailbox_inflight_slots_exhausted" }]);
			expect(
				rawDb(store)
					.prepare("SELECT count(*) AS count FROM workflow_alert_outbox")
					.get(),
			).toEqual({ count: 1 });
		},
	);

	it("routes a real freeze event through the Lead-facing copy contract", async () => {
		const caseId = "frozen-copy";
		const { store, attemptId, rootId } = await setup({
			caseId,
			status: "running",
			liveness: "unknown",
		});
		expect(
			store.freezeWorkflowDelivery({
				runId: `run-${caseId}`,
				shape: "mailbox_inflight_slots_exhausted",
				attemptId,
				rootId,
				physicalId: `mail-${caseId}`,
				recipientExecutionId: `exec-${caseId}`,
				shapeSince: new Date(
					nowMs - MAILBOX_SLOT_FREEZE_AFTER_MS,
				).toISOString(),
				thresholdMs: MAILBOX_SLOT_FREEZE_AFTER_MS,
				commEvidence: {
					recentOutboundInWindow: false,
					observedAtMs: nowMs,
				},
				now,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
		).toMatchObject({ held: true });
		const alert = store.listWorkflowAlertOutbox()[0]?.payload;
		expect(alert).toMatchObject({
			title: "FLY-2278 delivery contract frozen",
			body: "FLY-2278 一份交接在「收件箱三批未读」卡了 30 分钟；收件体 exec-fro 状态 running，活性 无心跳记录（心跳 无、状态变化 无、最近出站 无）；run 已冻结。runId run-frozen-copy；证据戳 2026-09-03T16:00:00.000Z；正门：`flywheel-comm hold list --run run-frozen-copy`",
		});
	});

	it("rechecks a terminal status that wins after shape detection", async () => {
		const caseId = "status-barrier";
		const { store, attemptId, rootId } = await setup({
			caseId,
			status: "running",
			liveness: "absent",
		});
		expect(
			shouldFreeze({
				ageMs: MAILBOX_SLOT_FREEZE_AFTER_MS,
				thresholdMs: MAILBOX_SLOT_FREEZE_AFTER_MS,
				sessionStatus: "running",
				liveness: "absent",
			}),
		).toBe(true);
		store.upsertSession({
			execution_id: `exec-${caseId}`,
			issue_id: "FLY-2278",
			project_name: "flywheel",
			status: "completed",
		});
		const before = snapshotHoldTables(store);
		expect(
			store.freezeWorkflowDelivery({
				runId: `run-${caseId}`,
				shape: "mailbox_inflight_slots_exhausted",
				attemptId,
				rootId,
				physicalId: `mail-${caseId}`,
				recipientExecutionId: `exec-${caseId}`,
				shapeSince: new Date(
					nowMs - MAILBOX_SLOT_FREEZE_AFTER_MS,
				).toISOString(),
				thresholdMs: MAILBOX_SLOT_FREEZE_AFTER_MS,
				commEvidence: {
					recentOutboundInWindow: false,
					observedAtMs: nowMs,
				},
				now,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
		).toMatchObject({ held: false });
		expect(snapshotHoldTables(store)).toBe(before);
	});

	it("rechecks ISO-Z activity that wins after shape detection", async () => {
		const caseId = "activity-barrier";
		const { store, attemptId, rootId } = await setup({
			caseId,
			status: "running",
			liveness: "absent",
		});
		expect(
			shouldFreeze({
				ageMs: MAILBOX_SLOT_FREEZE_AFTER_MS,
				thresholdMs: MAILBOX_SLOT_FREEZE_AFTER_MS,
				sessionStatus: "running",
				liveness: "absent",
			}),
		).toBe(true);
		store.upsertSession({
			execution_id: `exec-${caseId}`,
			issue_id: "FLY-2278",
			project_name: "flywheel",
			status: "running",
			last_activity_at: "2026-09-03T15:59:00.000Z",
		});
		const before = snapshotHoldTables(store);
		expect(
			store.freezeWorkflowDelivery({
				runId: `run-${caseId}`,
				shape: "mailbox_inflight_slots_exhausted",
				attemptId,
				rootId,
				physicalId: `mail-${caseId}`,
				recipientExecutionId: `exec-${caseId}`,
				shapeSince: new Date(
					nowMs - MAILBOX_SLOT_FREEZE_AFTER_MS,
				).toISOString(),
				thresholdMs: MAILBOX_SLOT_FREEZE_AFTER_MS,
				commEvidence: {
					recentOutboundInWindow: false,
					observedAtMs: nowMs,
				},
				now,
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
			}),
		).toMatchObject({ held: false });
		expect(snapshotHoldTables(store)).toBe(before);
	});

	it("transitions stalled to frozen and closes a cleared frozen shape explicitly", async () => {
		const caseId = "episode-freeze-transition";
		const { store, attemptId, rootId } = await setup({
			caseId,
			status: "running",
			liveness: "absent",
		});
		const attempt = store
			.listLiveWorkflowDeliveryAttempts()
			.find((row) => row.attempt_id === attemptId)!;
		const alertIdentity = {
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			leadResolution: "resolved" as const,
		};
		store.observeWorkflowDeliveryContract({
			attempt,
			classification: {
				stage: "minted",
				stageEnteredAt: attempt.minted_at,
				terminal: null,
				overdue: true,
				severe: false,
			},
			runId: `run-${caseId}`,
			projectName: "flywheel",
			issueId: "FLY-2278",
			now: "2026-09-03T15:11:00.000Z",
			alertIdentity,
		});
		expect(
			store.freezeWorkflowDelivery({
				runId: `run-${caseId}`,
				shape: "mailbox_inflight_slots_exhausted",
				attemptId,
				rootId,
				physicalId: `mail-${caseId}`,
				recipientExecutionId: `exec-${caseId}`,
				shapeSince: "2026-09-03T15:30:00.000Z",
				thresholdMs: MAILBOX_SLOT_FREEZE_AFTER_MS,
				commEvidence: {
					recentOutboundInWindow: false,
					observedAtMs: nowMs,
				},
				now,
				alertIdentity,
			}),
		).toMatchObject({ held: true });
		store.observeWorkflowDeliveryContract({
			attempt,
			classification: {
				stage: "minted",
				stageEnteredAt: attempt.minted_at,
				terminal: null,
				overdue: false,
				severe: false,
			},
			runId: `run-${caseId}`,
			projectName: "flywheel",
			issueId: "FLY-2278",
			now: "2026-09-03T16:01:00.000Z",
			alertIdentity,
		});
		expect(
			rawDb(store)
				.prepare(
					`SELECT stage, closed_reason
					   FROM workflow_delivery_contract_episode ORDER BY opened_at`,
				)
				.all(),
		).toEqual([
			{ stage: "minted", closed_reason: "superseded_by_freeze" },
			{
				stage: "mailbox_inflight_slots_exhausted",
				closed_reason: "frozen:mailbox_inflight_slots_exhausted:cleared",
			},
		]);
	});

	it("freezes the same attempt and shape again with a fresh episode identity", async () => {
		const caseId = "recurring-freeze";
		const { store, attemptId, rootId } = await setup({
			caseId,
			status: "running",
			liveness: "absent",
		});
		const attempt = store
			.listLiveWorkflowDeliveryAttempts()
			.find((row) => row.attempt_id === attemptId)!;
		const alertIdentity = {
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			leadResolution: "resolved" as const,
		};
		const freeze = (input: { shapeSince: string; now: string }) =>
			store.freezeWorkflowDelivery({
				runId: `run-${caseId}`,
				shape: "mailbox_inflight_slots_exhausted",
				attemptId,
				rootId,
				physicalId: `mail-${caseId}`,
				recipientExecutionId: `exec-${caseId}`,
				shapeSince: input.shapeSince,
				thresholdMs: MAILBOX_SLOT_FREEZE_AFTER_MS,
				commEvidence: {
					recentOutboundInWindow: false,
					observedAtMs: Date.parse(input.now),
				},
				now: input.now,
				alertIdentity,
			});
		const shapeSince = "2026-09-03T15:30:00.000Z";

		expect(
			freeze({
				shapeSince,
				now,
			}),
		).toMatchObject({ held: true });
		rawDb(store)
			.prepare("UPDATE workflow_run SET status = 'active' WHERE run_id = ?")
			.run(`run-${caseId}`);
		expect(
			freeze({
				shapeSince,
				now: "2026-09-03T17:00:00.000Z",
			}),
		).toMatchObject({ held: true });
		store.observeWorkflowDeliveryContract({
			attempt,
			classification: {
				stage: "minted",
				stageEnteredAt: attempt.minted_at,
				terminal: null,
				overdue: false,
				severe: false,
			},
			runId: `run-${caseId}`,
			projectName: "flywheel",
			issueId: "FLY-2278",
			now: "2026-09-03T17:01:00.000Z",
			alertIdentity,
		});
		rawDb(store)
			.prepare("UPDATE workflow_run SET status = 'active' WHERE run_id = ?")
			.run(`run-${caseId}`);

		expect(
			freeze({
				shapeSince,
				now: "2026-09-03T18:00:00.000Z",
			}),
		).toMatchObject({ held: true });
		expect(
			rawDb(store)
				.prepare(
					`SELECT event_uid FROM workflow_run_event
					  WHERE kind = 'mailbox_inflight_slots_exhausted'
					  ORDER BY event_uid`,
				)
				.all(),
		).toHaveLength(3);
		expect(
			rawDb(store)
				.prepare(
					`SELECT closed_at FROM workflow_delivery_contract_episode
					  WHERE stage = 'mailbox_inflight_slots_exhausted'
					  ORDER BY opened_at`,
				)
				.all(),
		).toEqual([
			expect.objectContaining({ closed_at: expect.any(String) }),
			expect.objectContaining({ closed_at: expect.any(String) }),
			{ closed_at: null },
		]);
	});

	it("transitions an existing stalled episode to undeliverable", async () => {
		const caseId = "episode-undeliverable-transition";
		const { store, attemptId } = await setup({
			caseId,
			status: "completed",
			liveness: "absent",
		});
		const attempt = store
			.listLiveWorkflowDeliveryAttempts()
			.find((row) => row.attempt_id === attemptId)!;
		const common = {
			attempt,
			runId: `run-${caseId}`,
			projectName: "flywheel",
			issueId: "FLY-2278",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved" as const,
			},
		};
		store.observeWorkflowDeliveryContract({
			...common,
			classification: {
				stage: "minted",
				stageEnteredAt: attempt.minted_at,
				terminal: null,
				overdue: true,
				severe: false,
			},
			now: "2026-09-03T15:11:00.000Z",
		});
		store.observeWorkflowDeliveryContract({
			...common,
			classification: {
				stage: "minted",
				stageEnteredAt: attempt.minted_at,
				terminal: "undeliverable",
				overdue: false,
				severe: false,
			},
			now: "2026-09-03T15:12:00.000Z",
		});
		expect(
			rawDb(store)
				.prepare(
					`SELECT stage, closed_reason
					   FROM workflow_delivery_contract_episode ORDER BY opened_at`,
				)
				.all(),
		).toEqual([
			{ stage: "minted", closed_reason: "superseded_by_undeliverable" },
			{ stage: "undeliverable", closed_reason: null },
		]);
	});
});

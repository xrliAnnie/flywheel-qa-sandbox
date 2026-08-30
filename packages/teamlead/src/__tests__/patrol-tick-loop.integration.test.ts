import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { afterEach, describe, expect, it } from "vitest";
import { formatPatrolTick } from "../bridge/hook-payload.js";
import {
	canonicalLeadEventDeliveryId,
	enqueueLeadEvent as enqueueDurableLeadEvent,
} from "../bridge/lead-event-queue.js";
import { leadEventEnvelopeFromJournalRow } from "../bridge/legacy-lead-event-reconciler.js";
import {
	createLeadPatrolTickPass,
	type PatrolTickDeps,
	patrolSessionKey,
	patrolTickOffsetMs,
} from "../bridge/patrol-tick.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

interface SqlJsDb {
	run(sql: string, params?: unknown[]): void;
}

interface RawCommDb {
	prepare(sql: string): { run(...params: unknown[]): unknown };
}

const NOW_MS = Date.parse("2026-08-20T12:00:00.000Z");
const project: ProjectEntry = {
	projectName: "flywheel_test",
	projectRoot: "/tmp/flywheel-test",
	leads: [
		{
			agentId: "eng-lead",
			chatChannel: "eng",
			match: { labels: ["Engineering"] },
		},
	],
};

describe("FLY-1925 real patrol loop acceptance", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	async function renderTick(
		options: {
			issueId?: string;
			identifier?: string;
			openRework?: boolean;
			openGate?: boolean;
			driftTurnAfterSnapshot?: boolean;
			waiterStatus?: string;
			holderStatus?: string | null;
			waitAgeMinutes?: number | null;
			declareWaiterParked?: boolean;
			currentNodeId?: string;
			currentAttempt?: number;
			currentAttemptState?: string;
			currentAttemptExecutionId?: string | null;
			turnEpoch?: number;
			runStatus?: "active" | "held";
			reworkState?: string;
			reworkActorExecutionId?: string;
			processLiveness?: Record<string, "alive" | "dead" | "unknown">;
		} = {},
	): Promise<string> {
		const {
			issueId = "issue-1855",
			identifier = "FLY-1855",
			openRework = false,
			openGate = false,
			driftTurnAfterSnapshot = false,
			waiterStatus = "running",
			holderStatus = null,
			waitAgeMinutes = 31,
			declareWaiterParked = false,
			currentNodeId = "implement",
			currentAttempt = 1,
			currentAttemptState = "done",
			currentAttemptExecutionId = "waiter-exec-12345678",
			turnEpoch = 3,
			runStatus = "active",
			reworkState = "pending",
			reworkActorExecutionId = "rework-exec",
			processLiveness = {},
		} = options;
		const runId = `run-${identifier.replace(/^FLY-/i, "")}`;
		const store = await StateStore.create(":memory:");
		const stateDb = (store as unknown as { db: SqlJsDb }).db;
		const dir = mkdtempSync(join(tmpdir(), "fly1925-acceptance-"));
		dirs.push(dir);
		const commPath = join(dir, "comm.db");
		const writer = new CommDB(commPath, true, false);
		const commDb = (writer as unknown as { db: RawCommDb }).db;
		try {
			store.upsertSession({
				execution_id: "waiter-exec-12345678",
				issue_id: issueId,
				issue_identifier: identifier,
				project_name: project.projectName,
				status: waiterStatus,
				session_role: "implement",
				issue_labels: '["Engineering"]',
			});
			if (holderStatus != null) {
				store.upsertSession({
					execution_id: "holder-exec-abcdefgh",
					issue_id: issueId,
					issue_identifier: identifier,
					project_name: project.projectName,
					status: holderStatus,
					session_role: "qa",
					issue_labels: '["Engineering"]',
				});
			}
			stateDb.run(
				`INSERT INTO workflow_run
				   (run_id, issue_id, project_name, current_node_id, current_qa_attempt,
				    status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					runId,
					issueId,
					project.projectName,
					currentNodeId,
					currentAttempt,
					runStatus,
					new Date(NOW_MS - 60_000).toISOString(),
				],
			);
			stateDb.run(
				`INSERT INTO workflow_run_node
				   (run_id, node_id, attempt, state, execution_id, started_at, ended_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					runId,
					currentNodeId,
					currentAttempt,
					currentAttemptState,
					currentAttemptExecutionId,
					new Date(NOW_MS - 120_000).toISOString(),
					currentAttemptState === "running"
						? null
						: new Date(NOW_MS - 90_000).toISOString(),
				],
			);
			if (openRework) {
				stateDb.run(
					`INSERT INTO workflow_actor
					   (execution_id, project_name, issue_id, role, created_at)
					 VALUES (?, ?, ?, 'implement', ?)`,
					[
						reworkActorExecutionId,
						project.projectName,
						issueId,
						new Date(NOW_MS).toISOString(),
					],
				);
				stateDb.run(
					`INSERT INTO workflow_rework_request
					   (request_id, run_id, source_event_id, authority, source_node_id,
					    source_attempt, base_revision, authority_context_json,
					    authority_context_digest, requested_at)
					 VALUES ('request-1855', ?, 'source-1855', 'qa', 'qa', 1,
					         'base', '{}', 'digest', ?)`,
					[runId, new Date(NOW_MS).toISOString()],
				);
				stateDb.run(
					`INSERT INTO workflow_rework_route_revision
					   (request_id, revision, target_node_id, target_attempt,
					    preferred_actor_execution_id, invalidation_scope_json,
					    verification_policy_json, interpreted_by,
					    interpretation_reason, created_at)
					 VALUES ('request-1855', 1, 'implement', 2, ?, '[]',
					         '[]', 'test', 'test', ?)`,
					[reworkActorExecutionId, new Date(NOW_MS).toISOString()],
				);
				stateDb.run(
					`INSERT INTO workflow_rework_delivery
					   (request_id, route_revision, state, updated_at)
					 VALUES ('request-1855', 1, ?, ?)`,
					[reworkState, new Date(NOW_MS).toISOString()],
				);
			}
			if (openGate) {
				stateDb.run(
					`INSERT INTO workflow_gate_holder
					   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
					    question_id, state, materialization_stage, created_at, updated_at)
					 VALUES (?, ?, ?, 'head', 'holder-exec-abcdefgh', 'question-1859',
					         'awaiting_review', 'completed', ?, ?)`,
					[
						runId,
						currentNodeId,
						currentAttempt,
						new Date(NOW_MS).toISOString(),
						new Date(NOW_MS).toISOString(),
					],
				);
			}
			commDb
				.prepare(
					`INSERT INTO three_stage_turn
					   (issue_id, holder_exec_id, phase, epoch, granted_at,
					    target_run_id, target_node_id, target_attempt, activation_id)
					 VALUES (?, 'holder-exec-abcdefgh', 'qa', ?, ?,
					         ?, ?, ?, 'activation-holder')`,
				)
				.run(
					issueId,
					turnEpoch,
					NOW_MS - 60_000,
					runId,
					currentNodeId,
					currentAttempt,
				);
			if (waitAgeMinutes != null) {
				commDb
					.prepare(
						`INSERT INTO turn_wait_ledger
						   (execution_id, holder_exec_id, epoch, first_seen_at)
						 VALUES ('waiter-exec-12345678', 'holder-exec-abcdefgh', ?, ?)`,
					)
					.run(turnEpoch, NOW_MS - waitAgeMinutes * 60_000);
			}
			if (declareWaiterParked) {
				commDb
					.prepare(
						`INSERT INTO runner_declared_states
						   (execution_id, kind, reason, created_at, expires_at, updated_at)
						 VALUES ('waiter-exec-12345678', 'parked', 'test', ?, ?, ?)`,
					)
					.run(NOW_MS - 1_000, NOW_MS + 60_000, NOW_MS - 1_000);
			}

			const deps: PatrolTickDeps = {
				projects: [project],
				store,
				now: () => NOW_MS,
				getGlobalConfig: () => ({ interval_minutes: 60 }),
				getProjectConfig: () => ({ interval_minutes: 60 }),
				openCommReadonly: () => {
					const reader = CommDB.openReadonly(commPath);
					return {
						readPatrolTurnSnapshot: (input) => {
							const snapshot = reader.readPatrolTurnSnapshot(input);
							if (driftTurnAfterSnapshot) {
								commDb
									.prepare(
										"UPDATE three_stage_turn SET epoch = epoch + 1 WHERE issue_id = ?",
									)
									.run(issueId);
							}
							return snapshot;
						},
						rereadJudgmentFingerprint: (issueId, executionIds) =>
							reader.rereadJudgmentFingerprint(issueId, executionIds),
						close: () => reader.close(),
					};
				},
				probeProcessLiveness: async (executionId) =>
					processLiveness[executionId] ?? "alive",
				inspectDeliveryState: () => ({ kind: "absent_identity" }),
				enqueueLeadEvent: (envelope) => ({
					queued: true,
					deliveryId: `lead_event:${envelope.leadId}:${envelope.eventId}`,
					seq: envelope.seq,
				}),
			};
			await createLeadPatrolTickPass(deps)();
			const row = store.getLatestPatrolTickEvent(
				"eng-lead",
				patrolSessionKey(project.projectName, "eng-lead"),
			);
			if (!row) throw new Error("patrol tick was not journaled");
			return formatPatrolTick(leadEventEnvelopeFromJournalRow(row, 2));
		} finally {
			writer.close();
			store.close();
		}
	}

	it("prints the founder-reported 1855 nonexistent-loop shape as red", async () => {
		const body = await renderTick();
		expect(body).toContain("🔴 按账面有 1 个 issue「有人在等不存在的圈」");
		expect(body).toContain(
			"FLY-1855 | run=run-1855(active) node=implement@1(done)",
		);
		expect(body).toContain("等待账记录账龄 31 分钟");
	});

	it("does not print red when the same waiter has an open rework delivery", async () => {
		const body = await renderTick({ openRework: true });
		expect(body).not.toContain("🔴 按账面");
		expect(body).toContain("圈=rework:pending→implement@2 | —");
	});

	it("fails honestly when the TURN tuple changes between the two databases", async () => {
		const body = await renderTick({ driftTurnAfterSnapshot: true });
		expect(body).not.toContain("🔴 按账面");
		expect(body).toContain("圈=⚠️ 账面不可读(turn_tuple_moved) | ⚠️");
	});

	it("keeps shape ① green while the founder gate awaits review", async () => {
		const body = await renderTick({
			issueId: "issue-1859",
			identifier: "FLY-1859",
			openGate: true,
			holderStatus: "completed",
			waitAgeMinutes: 233,
			currentNodeId: "founder_gate",
			currentAttempt: 2,
			currentAttemptState: "review",
			currentAttemptExecutionId: null,
			turnEpoch: 7,
		});

		expect(body).not.toContain("🔴 按账面");
		expect(body).toContain(
			"FLY-1859 | run=run-1859(active) node=founder_gate@2(review)",
		);
		expect(body).toContain("圈=gate:awaiting_review | —");
	});

	it("keeps FLY-1925 green while the holder owns a running QA attempt", async () => {
		const body = await renderTick({
			issueId: "issue-1925",
			identifier: "FLY-1925",
			waiterStatus: "ship_parked",
			holderStatus: "running",
			waitAgeMinutes: 233,
			declareWaiterParked: true,
			currentNodeId: "qa",
			currentAttempt: 1,
			currentAttemptState: "running",
			currentAttemptExecutionId: "holder-exec-abcdefgh",
		});

		expect(body).not.toContain("🔴 按账面");
		expect(body).toContain(
			"FLY-1925 | run=run-1925(active) node=qa@1(running)",
		);
		expect(body).toContain("[waiter-e] (implement, ship_parked)");
		expect(body).toContain("[holder-e] (qa, running)");
	});

	it("prints the production FLY-1934 dead wake-delivered holder as red", async () => {
		const body = await renderTick({
			issueId: "issue-1934",
			identifier: "FLY-1934",
			openRework: true,
			reworkState: "wake_delivered",
			reworkActorExecutionId: "holder-exec-abcdefgh",
			holderStatus: "terminated",
			waitAgeMinutes: null,
			currentNodeId: "implement",
			currentAttempt: 3,
			currentAttemptState: "running",
			currentAttemptExecutionId: "holder-exec-abcdefgh",
			processLiveness: { "holder-exec-abcdefgh": "dead" },
		});

		expect(body).toContain("🔴 按账面有 1 个 issue「棒持有者不在干活」");
		expect(body).toContain(
			"FLY-1934: 棒持有者 holder-e 的现场探针=dead,run 仍 active",
		);
		expect(body).toContain("圈=rework:wake_delivered→implement@2 | 🔴");
	});

	it("prints the production FLY-1925 held needs-lead live-idle shape as red", async () => {
		const body = await renderTick({
			issueId: "issue-1925",
			identifier: "FLY-1925",
			openRework: true,
			reworkState: "needs_lead",
			reworkActorExecutionId: "waiter-exec-12345678",
			runStatus: "held",
			waiterStatus: "ship_parked",
			holderStatus: "running",
			waitAgeMinutes: 233,
			declareWaiterParked: true,
			currentNodeId: "qa",
			currentAttempt: 1,
			currentAttemptState: "done",
			currentAttemptExecutionId: "holder-exec-abcdefgh",
		});

		expect(body).toContain("🔴 按账面有 1 个 issue「棒持有者不在干活」");
		expect(body).toContain(
			"FLY-1925: 棒持有者 holder-e 的当前 attempt qa@1 已终态(done),run 仍 held",
		);
		expect(body).toContain("圈=rework:needs_lead→implement@2 | 🔴");
		expect(body).toContain("[waiter-e] (implement, ship_parked) 现场=alive");
	});

	it("advances past a torn real mailbox identity after restart", async () => {
		const store = await StateStore.create(":memory:");
		const dir = mkdtempSync(join(tmpdir(), "fly2165-patrol-restart-"));
		dirs.push(dir);
		const commPath = join(dir, "comm.db");
		let queue = new MailboxQueue(commPath);
		const intervalMs = 60 * 60_000;
		let nowMs =
			Date.parse("2026-08-20T12:00:00.000Z") +
			patrolTickOffsetMs("eng-lead", intervalMs);
		try {
			store.upsertSession({
				execution_id: "fly2165-runner",
				issue_id: "issue-2165",
				issue_identifier: "FLY-2165",
				project_name: project.projectName,
				status: "running",
				session_role: "implement",
				issue_labels: '["Engineering"]',
			});
			const deps: PatrolTickDeps = {
				projects: [project],
				store,
				now: () => nowMs,
				getGlobalConfig: () => ({ interval_minutes: 60 }),
				getProjectConfig: () => ({ interval_minutes: 60 }),
				inspectDeliveryState: (_projectName, id) =>
					queue.inspectDeliveryState(id),
				enqueueLeadEvent: (envelope) =>
					enqueueDurableLeadEvent({
						queue,
						envelope,
						content: formatPatrolTick(envelope),
					}),
			};
			const pass = createLeadPatrolTickPass(deps);
			await pass();
			const first = store.getLatestPatrolTickEvent(
				"eng-lead",
				patrolSessionKey(project.projectName, "eng-lead"),
			);
			if (!first) throw new Error("first patrol tick was not journaled");
			const firstEnvelope = leadEventEnvelopeFromJournalRow(first, 2);
			const poisonedDeliveryId = canonicalLeadEventDeliveryId(firstEnvelope);

			queue.close();
			const raw = new Database(commPath);
			raw.exec("DROP TRIGGER IF EXISTS mailbox_delete_requires_archive");
			raw.prepare("DELETE FROM mailbox WHERE id = ?").run(poisonedDeliveryId);
			raw.close();
			queue = new MailboxQueue(commPath);
			expect(queue.inspectDeliveryState(poisonedDeliveryId)).toEqual({
				kind: "torn_identity",
			});

			nowMs += intervalMs;
			await pass();
			await pass();
			const latest = store.getLatestPatrolTickEvent(
				"eng-lead",
				patrolSessionKey(project.projectName, "eng-lead"),
			);
			if (!latest) throw new Error("replacement patrol tick was not journaled");
			expect(latest.seq).toBe(first.seq + 1);
			expect(latest.event_id).toBe(
				`patrol_tick:${project.projectName}:eng-lead:after-${first.seq}`,
			);
			const replacementId = canonicalLeadEventDeliveryId(
				leadEventEnvelopeFromJournalRow(latest, 2),
			);
			expect(queue.getById(replacementId)).toMatchObject({ state: "QUEUED" });
		} finally {
			queue.close();
			store.close();
		}
	});
});

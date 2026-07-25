import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inbox } from "../commands/inbox.js";
import { CommDB } from "../db.js";

describe("FLY-1392 receipt wake state machine", () => {
	let db: CommDB;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "receipt-wake-"));
		db = new CommDB(join(tmpDir, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function admit(
		ordinal: number,
		queuedAtMs = 1_000 + ordinal,
		policy: {
			transportAvailable?: boolean;
			execPushCap?: number;
			execPushWindowMs?: number;
		} = {},
	) {
		return db.instructionAndIntent({
			instructionId: `instruction-${ordinal}`,
			fromAgent: "lead-1",
			executionId: "exec-1",
			content: `instruction ${ordinal}`,
			intentKey: `instruction:instruction-${ordinal}`,
			envelope: {
				id: `wake-${ordinal}`,
				to: "exec-1",
				content: `wake ${ordinal}`,
				metadata: { flywheelId: `instruction-${ordinal}`, execId: "exec-1" },
			},
			queuedAtMs,
			wakePolicy: policy,
		});
	}

	it("admits at most the per-exec window cap and records one deterministic cap alert", () => {
		for (let ordinal = 1; ordinal <= 7; ordinal += 1) {
			admit(ordinal, 10_000 + ordinal, {
				execPushCap: 6,
				execPushWindowMs: 600_000,
			});
		}

		const wakes = db.listRunnerPhaseWakes("exec-1");
		expect(wakes.map((wake) => wake.admission_state)).toEqual([
			"queued",
			"queued",
			"queued",
			"queued",
			"queued",
			"queued",
			"suppressed_cap",
		]);
		expect(db.getReceiptAlertOutbox("wake_cap:exec-1:0")).toMatchObject({
			kind: "wake_cap",
		});
		expect(admit(7, 10_007).kind).toBe("duplicate");
	});

	it("enforces the cap across a fixed-window boundary (true sliding window)", () => {
		for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
			admit(ordinal, 599_990 + ordinal, {
				execPushCap: 6,
				execPushWindowMs: 600_000,
			});
		}
		for (let ordinal = 4; ordinal <= 7; ordinal += 1) {
			admit(ordinal, 600_000 + ordinal, {
				execPushCap: 6,
				execPushWindowMs: 600_000,
			});
		}

		expect(db.listRunnerPhaseWakes("exec-1").at(-1)?.admission_state).toBe(
			"suppressed_cap",
		);
	});

	it("marks no-transport intents as audit-only and never makes them push eligible", () => {
		const result = admit(1, 1_000, { transportAvailable: false });

		expect(result.wake.admission_state).toBe("skipped_no_transport");
		expect(
			db.claimRunnerReceiptWakePush("exec-1", result.wake.message_id, 1_000, {
				t1Ms: 90_000,
				claimTtlMs: 10_000,
			}),
		).toBeNull();
	});

	it("claims before push, shares a two-attempt budget, and does not refund crashes", () => {
		const wake = admit(1, 1_000).wake;
		const first = db.claimRunnerReceiptWakePush(
			"exec-1",
			wake.message_id,
			1_000,
			{ t1Ms: 90_000, claimTtlMs: 10_000 },
		);
		expect(first).toMatchObject({ attempt: 1 });
		expect(
			db.claimRunnerReceiptWakePush("exec-1", wake.message_id, 1_001, {
				t1Ms: 90_000,
				claimTtlMs: 10_000,
			}),
		).toBeNull();

		// Simulate crash after the durable claim: attempt 1 stays spent.
		expect(
			db.claimRunnerReceiptWakePush("exec-1", wake.message_id, 90_999, {
				t1Ms: 90_000,
				claimTtlMs: 10_000,
			}),
		).toBeNull();
		const second = db.claimRunnerReceiptWakePush(
			"exec-1",
			wake.message_id,
			91_000,
			{ t1Ms: 90_000, claimTtlMs: 10_000 },
		);
		expect(second).toMatchObject({ attempt: 2 });
		expect(
			db.completeRunnerReceiptWakePush({
				executionId: "exec-1",
				messageId: wake.message_id,
				claimToken: second!.claimToken,
				attempt: 2,
				result: "verified",
				nowMs: 91_001,
			}),
		).toBe(true);
		expect(
			db.claimRunnerReceiptWakePush("exec-1", wake.message_id, 999_999, {
				t1Ms: 90_000,
				claimTtlMs: 10_000,
			}),
		).toBeNull();
		expect(db.listRunnerPhaseWakes("exec-1")[0]).toMatchObject({
			push_attempts: 2,
			last_push_result: "attempt:2:verified",
		});
	});

	it("a stale success supplements delivery evidence without releasing the live claim", () => {
		const wake = admit(1, 1_000).wake;
		const first = db.claimRunnerReceiptWakePush(
			"exec-1",
			wake.message_id,
			1_000,
			{ t1Ms: 90_000, claimTtlMs: 10_000 },
		)!;
		const second = db.claimRunnerReceiptWakePush(
			"exec-1",
			wake.message_id,
			91_000,
			{ t1Ms: 90_000, claimTtlMs: 10_000 },
		)!;

		expect(
			db.completeRunnerReceiptWakePush({
				executionId: "exec-1",
				messageId: wake.message_id,
				claimToken: first.claimToken,
				attempt: 1,
				result: "delivered",
				nowMs: 91_001,
			}),
		).toBe(false);
		expect(db.listRunnerPhaseWakes("exec-1")[0]).toMatchObject({
			claim_token: second.claimToken,
			push_attempts: 2,
		});
		expect(db.listRunnerPhaseWakes("exec-1")[0]?.last_push_result).toContain(
			"attempt:1:stale_delivered",
		);
	});

	it("acks only pending wakes that existed when inbox or turn began", () => {
		admit(1, 1_000);
		admit(2, 2_001);

		expect(db.ackRunnerReceiptWakesStarted("exec-1", 2_000, "exec_cli")).toBe(
			1,
		);
		expect(db.listRunnerPhaseWakes("exec-1")).toMatchObject([
			{ state: "started", started_at: 2_000, started_ack_scope: "exec_cli" },
			{ state: "pending", started_at: null, started_ack_scope: null },
		]);
	});

	it("bulk ACK consumes only message traffic and never a gate response or legacy wake", () => {
		const traffic = admit(1, 1_000).wake;
		const questionId = db.insertQuestion("exec-1", "lead-1", "review?", {
			checkpoint: "review_code",
		});
		const verdict = db.insertReviewResponseWithWakeIfGateOpen({
			questionId,
			fromAgent: "bridge",
			content: '{"reviewVerdict":"APPROVED"}',
			expectedOwner: "exec-1",
			expectedCheckpoint: "review_code",
			summary: "APPROVED",
			queuedAtMs: 1_001,
		});
		expect(verdict).not.toBeNull();
		const raw = new Database(join(tmpDir, "comm.db"));
		raw
			.prepare(
				`INSERT INTO runner_phase_wakes
				   (execution_id, message_id, content, state, queued_at,
				    admission_state, envelope_json, purpose)
				 VALUES ('exec-1', 'legacy-wake', 'legacy', 'pending', 1002,
				         'queued', '{"id":"legacy-wake","to":"exec-1","content":"legacy"}', NULL)`,
			)
			.run();
		raw.close();

		expect(db.ackRunnerReceiptWakesStarted("exec-1", 2_000, "exec_cli")).toBe(
			1,
		);
		expect(db.listRunnerPhaseWakes("exec-1")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message_id: traffic.message_id,
					purpose: "message_traffic",
					state: "started",
				}),
				expect.objectContaining({
					message_id: verdict?.responseId,
					purpose: "gate_response",
					state: "pending",
				}),
				expect.objectContaining({
					message_id: "legacy-wake",
					purpose: null,
					state: "pending",
				}),
			]),
		);
	});

	it("atomically writes, redrives, and exactly consumes a review response wake", () => {
		db.registerSession("exec-1", "session", "proj", "FLY-1", "lead-1");
		const questionId = db.insertQuestion("exec-1", "lead-1", "review?", {
			checkpoint: "review_code",
		});
		const input = {
			questionId,
			fromAgent: "bridge",
			content: '{"reviewVerdict":"APPROVED"}',
			expectedOwner: "exec-1",
			expectedCheckpoint: "review_code",
			summary: "APPROVED",
			queuedAtMs: 1_000,
		};
		const first = db.insertReviewResponseWithWakeIfGateOpen(input);
		expect(first).toMatchObject({
			responseId: expect.any(String),
			wake: {
				message_id: expect.any(String),
				purpose: "gate_response",
				admission_state: "queued",
			},
		});
		expect(first?.wake.message_id).toBe(first?.responseId);
		expect(db.insertReviewResponseWithWakeIfGateOpen(input)).toMatchObject({
			responseId: first?.responseId,
		});

		expect(db.consumeGateResponse(questionId, "other-exec")).toBeUndefined();
		const consumed = db.consumeGateResponse(questionId, "exec-1");
		expect(consumed?.id).toBe(first?.responseId);
		expect(consumed?.delivered_at).toEqual(expect.any(String));
		expect(db.listRunnerPhaseWakes("exec-1")).toMatchObject([
			{
				message_id: first?.responseId,
				purpose: "gate_response",
				state: "finished",
				finished_at: expect.any(Number),
			},
		]);
	});

	it("inbox writes the exec-level started receipt only after its primary action succeeds", () => {
		admit(1, 1_000);
		admit(2, 2_001);

		expect(
			inbox({
				execId: "exec-1",
				dbPath: join(tmpDir, "comm.db"),
				now: () => 2_000,
			}),
		).toMatchObject({ instructions: expect.any(Array) });
		expect(db.listRunnerPhaseWakes("exec-1")).toMatchObject([
			{ state: "started", started_at: 2_000 },
			{ state: "pending", started_at: null },
		]);
	});

	it("dedupes the vendor callback by instruction identity and consumes the durable instruction once", () => {
		const admitted = admit(1, 1_000);
		const callback = db.enqueueRunnerPhaseWake(
			"exec-1",
			{
				id: "vendor-callback-1",
				to: "exec-1",
				content: "wake 1",
				metadata: { flywheelId: "instruction-1", execId: "exec-1" },
			},
			1_001,
		);

		expect(callback).toEqual({ kind: "duplicate", wake: admitted.wake });
		expect(db.listRunnerPhaseWakes("exec-1")).toHaveLength(1);
		expect(db.getUnreadInstructions("exec-1").map((row) => row.id)).toEqual([
			"instruction-1",
		]);

		expect(
			inbox({
				execId: "exec-1",
				dbPath: join(tmpDir, "comm.db"),
				now: () => 1_002,
			}).instructions.map((row) => row.id),
		).toEqual(["instruction-1"]);
		expect(
			inbox({
				execId: "exec-1",
				dbPath: join(tmpDir, "comm.db"),
				now: () => 1_003,
			}).instructions,
		).toEqual([]);
	});

	it("keeps a same-millisecond pre-push ACK recoverable through the durable inbox", () => {
		const admitted = admit(1, 2_000);

		// Accepted at-least-once edge: an exec-level ACK at the same clock
		// millisecond may retire the transport intent before its first push.
		expect(db.ackRunnerReceiptWakesStarted("exec-1", 2_000, "exec_cli")).toBe(
			1,
		);
		expect(
			db.claimRunnerReceiptWakePush("exec-1", admitted.wake.message_id, 2_001, {
				t1Ms: 90_000,
				claimTtlMs: 10_000,
			}),
		).toBeNull();

		// The transport skip does not delete the business payload: the stable
		// instruction id remains unread and a later inbox call consumes it once.
		expect(db.getUnreadInstructions("exec-1").map((row) => row.id)).toEqual([
			"instruction-1",
		]);
		expect(
			inbox({
				execId: "exec-1",
				dbPath: join(tmpDir, "comm.db"),
				now: () => 2_002,
			}).instructions.map((row) => row.id),
		).toEqual(["instruction-1"]);
		expect(db.getUnreadInstructions("exec-1")).toEqual([]);
	});

	it("durably claims T2 once and escalates a forbidden wake exactly once", () => {
		const wake = admit(1, 1_000).wake;
		const claim = db.claimRunnerReceiptWakeT2(
			"exec-1",
			wake.message_id,
			301_000,
			300_000,
		);
		expect(claim).not.toBeNull();
		expect(
			db.claimRunnerReceiptWakeT2("exec-1", wake.message_id, 301_001, 300_000),
		).toBeNull();
		expect(
			db.completeRunnerReceiptWakeT2(
				"exec-1",
				wake.message_id,
				"forbidden:no_tmux_target",
			),
		).toBe(true);

		const first = db.enqueueRunnerReceiptWakeEscalation({
			executionId: "exec-1",
			messageId: wake.message_id,
			reason: "no_tmux_target",
			firstDetectedAtMs: wake.queued_at,
			nowMs: 302_000,
		});
		const duplicate = db.enqueueRunnerReceiptWakeEscalation({
			executionId: "exec-1",
			messageId: wake.message_id,
			reason: "no_tmux_target",
			firstDetectedAtMs: wake.queued_at,
			nowMs: 302_001,
		});
		expect(first?.id).toBe(`wake_failed:${wake.message_id}`);
		expect(duplicate?.id).toBe(first?.id);
		expect(db.getReceiptAlertOutbox(first!.id)).toMatchObject({
			id: first!.id,
			kind: "wake_failed",
		});
		expect(db.listRunnerPhaseWakes("exec-1")[0]?.escalation_outbox_id).toBe(
			first!.id,
		);
		expect(db.listPendingRunnerReceiptWakes()).toEqual([]);
	});

	it("commits a gate response and its wake intent as one unit", () => {
		const questionId = db.insertQuestion("exec-1", "lead-1", "ready?");
		const result = db.responseAndIntent({
			questionId,
			fromAgent: "lead-1",
			content: "yes",
			intentKey: `gate-answer:${questionId}`,
			envelope: {
				id: `gate-answer:${questionId}`,
				to: "exec-1",
				content: "answer ready",
				metadata: { kind: "gate_answered", questionId },
			},
			queuedAtMs: 1_000,
		});

		expect(db.getResponse(questionId)?.id).toBe(result.responseId);
		expect(db.listRunnerPhaseWakes("exec-1")).toMatchObject([
			{ message_id: `gate-answer:${questionId}`, admission_state: "queued" },
		]);
	});

	it("terminalizes pending receipt intents when the session registry is finalized", () => {
		db.registerSession("exec-1", "session", "proj", "FLY-1", "lead-1");
		const wake = admit(1, Date.now()).wake;

		expect(db.deleteSessionAndRunnerPhaseLifecycle("exec-1")).toBe(1);
		expect(db.listRunnerPhaseWakes("exec-1")).toMatchObject([
			{
				message_id: wake.message_id,
				state: "finished",
				admission_state: "queued",
				finished_at: expect.any(Number),
			},
		]);
		expect(db.listPendingRunnerReceiptWakes()).toEqual([]);
		expect(db.listPendingReceiptAlerts(["wake_failed"])).toEqual([]);
	});

	it.each(["finalizeSession", "deleteSessionAndRunnerPhaseLifecycle"] as const)(
		"durably preserves founder wake failure during %s",
		(method) => {
			db.registerSession("exec-1", "session", "proj", "FLY-1", "lead-1");
			const wake = db.instructionAndIntent({
				instructionId: "founder-instruction",
				fromAgent: "lead-1",
				executionId: "exec-1",
				content: "founder decided",
				intentKey: "instruction:founder-instruction",
				envelope: {
					id: "founder-wake",
					to: "exec-1",
					content: "founder decided",
					metadata: { origin: "founder", questionId: "question-1" },
				},
				queuedAtMs: Date.now(),
			}).wake;

			if (method === "finalizeSession") db.finalizeSession("exec-1");
			else db.deleteSessionAndRunnerPhaseLifecycle("exec-1");

			expect(db.listRunnerPhaseWakes("exec-1")).toMatchObject([
				{
					message_id: wake.message_id,
					state: "finished",
					started_ack_scope: "terminal",
					escalation_outbox_id: `wake_failed:founder:${wake.message_id}`,
				},
			]);
			expect(
				db.getReceiptAlertOutbox(`wake_failed:founder:${wake.message_id}`),
			).toMatchObject({
				kind: "wake_failed",
				delivered_at: null,
			});
		},
	);

	it.each([
		["finalizeSession", "suppressed_cap"],
		["finalizeSession", "skipped_no_transport"],
		["deleteSessionAndRunnerPhaseLifecycle", "suppressed_cap"],
		["deleteSessionAndRunnerPhaseLifecycle", "skipped_no_transport"],
	] as const)(
		"durably preserves a founder wake during %s when admitted as %s",
		(method, admissionState) => {
			db.registerSession("exec-1", "session", "proj", "FLY-1", "lead-1");
			const nowMs = Date.now();
			if (admissionState === "suppressed_cap") {
				admit(1, nowMs, { execPushCap: 1 });
			}
			const questionId = db.insertQuestion(
				"exec-1",
				"lead-1",
				"founder decided?",
			);
			const wake = db.responseAndIntent({
				questionId,
				fromAgent: "lead-1",
				content: "founder decided",
				intentKey: `founder-response:${admissionState}`,
				envelope: {
					id: `founder-wake-${admissionState}`,
					to: "exec-1",
					content: "founder decided",
					metadata: { origin: "founder", questionId },
				},
				queuedAtMs: nowMs,
				wakePolicy:
					admissionState === "suppressed_cap"
						? { execPushCap: 1 }
						: { transportAvailable: false },
			}).wake;
			expect(wake.admission_state).toBe(admissionState);

			if (method === "finalizeSession") db.finalizeSession("exec-1");
			else db.deleteSessionAndRunnerPhaseLifecycle("exec-1");

			expect(db.listRunnerPhaseWakes("exec-1")).toContainEqual(
				expect.objectContaining({
					message_id: wake.message_id,
					state: "finished",
					started_ack_scope: "terminal",
					escalation_outbox_id: `wake_failed:founder:${wake.message_id}`,
				}),
			);
			expect(
				db.getReceiptAlertOutbox(`wake_failed:founder:${wake.message_id}`),
			).toMatchObject({
				kind: "wake_failed",
				delivered_at: null,
			});
		},
	);

	it.each(["finalizeSession", "deleteSessionAndRunnerPhaseLifecycle"] as const)(
		"terminalizes a previously escalated founder wake during %s",
		(method) => {
			db.registerSession("exec-1", "session", "proj", "FLY-1", "lead-1");
			const wake = db.instructionAndIntent({
				instructionId: "escalated-founder-instruction",
				fromAgent: "lead-1",
				executionId: "exec-1",
				content: "founder decided",
				intentKey: "instruction:escalated-founder-instruction",
				envelope: {
					id: "escalated-founder-wake",
					to: "exec-1",
					content: "founder decided",
					metadata: { origin: "founder", questionId: "question-1" },
				},
				queuedAtMs: 1_000,
			}).wake;
			const existingAlert = db.enqueueRunnerReceiptWakeEscalation({
				executionId: "exec-1",
				messageId: wake.message_id,
				reason: "no_started_receipt",
				firstDetectedAtMs: 1_000,
				nowMs: 2_000,
			});
			expect(existingAlert).not.toBeNull();

			if (method === "finalizeSession") db.finalizeSession("exec-1");
			else db.deleteSessionAndRunnerPhaseLifecycle("exec-1");

			expect(db.listRunnerPhaseWakes("exec-1")).toContainEqual(
				expect.objectContaining({
					message_id: wake.message_id,
					state: "finished",
					started_ack_scope: "terminal",
					escalation_outbox_id: existingAlert?.id,
				}),
			);
			expect(
				JSON.parse(db.getReceiptAlertOutbox(existingAlert!.id)!.payload),
			).toMatchObject({
				executionId: "exec-1",
				messageId: wake.message_id,
				identityKind: "founder_message",
			});
			expect(
				db.revalidateRunnerReceiptWakeAlert(existingAlert!.id, 3_000),
			).toMatchObject({ id: existingAlert?.id, canceled_at: null });
		},
	);

	it.each(["finalizeSession", "deleteSessionAndRunnerPhaseLifecycle"] as const)(
		"preserves metadata-only founder wake authority during %s",
		(method) => {
			db.registerSession("exec-1", "session", "proj", "FLY-1", "lead-1");
			const wake = db.enqueueRunnerPhaseWake(
				"exec-1",
				{
					id: "metadata-founder-wake",
					to: "exec-1",
					content: "founder decided",
					metadata: { origin: "founder", questionId: "question-1" },
				},
				Date.now(),
			).wake;

			if (method === "finalizeSession") db.finalizeSession("exec-1");
			else db.deleteSessionAndRunnerPhaseLifecycle("exec-1");

			expect(db.listRunnerPhaseWakes("exec-1")).toMatchObject([
				{
					message_id: wake.message_id,
					state: "finished",
					started_ack_scope: "terminal",
					escalation_outbox_id: `wake_failed:founder:${wake.message_id}`,
				},
			]);
		},
	);

	it("retains an aged founder wake until its durable terminal alert is delivered", () => {
		db.registerSession("exec-1", "session", "proj", "FLY-1", "lead-1");
		const wake = db.instructionAndIntent({
			instructionId: "aged-founder-instruction",
			fromAgent: "lead-1",
			executionId: "exec-1",
			content: "aged founder decision",
			intentKey: "instruction:aged-founder-instruction",
			envelope: {
				id: "aged-founder-wake",
				to: "exec-1",
				content: "aged founder decision",
				metadata: { origin: "founder", questionId: "question-1" },
			},
			queuedAtMs: Date.now() - 8 * 24 * 60 * 60_000,
		}).wake;

		db.finalizeSession("exec-1");

		const alertId = `wake_failed:founder:${wake.message_id}`;
		expect(db.listRunnerPhaseWakes("exec-1")).toHaveLength(1);
		expect(
			db.revalidateRunnerReceiptWakeAlert(alertId, Date.now()),
		).toMatchObject({ id: alertId, canceled_at: null });
	});

	it("keeps malformed wake-failure evidence pending instead of canceling it", () => {
		const wake = admit(1, 1_000).wake;
		const alert = db.enqueueRunnerReceiptWakeEscalation({
			executionId: "exec-1",
			messageId: wake.message_id,
			reason: "no_started_receipt",
			firstDetectedAtMs: wake.queued_at,
			nowMs: 2_000,
		});
		(
			db as unknown as {
				db: { prepare(sql: string): { run(...args: unknown[]): void } };
			}
		).db
			.prepare("UPDATE receipt_alert_outbox SET payload = ? WHERE id = ?")
			.run("{not-json", alert?.id);

		expect(
			db.revalidateRunnerReceiptWakeAlert(alert?.id ?? "", 3_000),
		).toMatchObject({ id: alert?.id, canceled_at: null });
		expect(db.listPendingReceiptAlerts(["wake_failed"])).toHaveLength(1);
	});

	it("rejects attempts to rewrite durable session receipt lineage", () => {
		db.registerSession("exec-1", "session", "proj", "FLY-1", "lead-1");

		expect(() =>
			db.registerSession("exec-1", "other", "proj", "FLY-2", "lead-1"),
		).toThrow(/session receipt lineage mismatch/);
		expect(db.getSession("exec-1")).toMatchObject({
			tmux_window: "session",
			issue_id: "FLY-1",
		});
	});
});

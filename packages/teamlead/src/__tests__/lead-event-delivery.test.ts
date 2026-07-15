import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { founderPageEventId } from "../bridge/detection-escalation-sinks.js";
import {
	createLeadEventDeadLetterHandler,
	LeadEventDeliveryCoordinator,
} from "../bridge/lead-event-delivery.js";
import type {
	DeliveryResult,
	LeadEventEnvelope,
	LeadRuntime,
	LeadRuntimeHealth,
} from "../bridge/lead-runtime.js";
import { StateStore } from "../StateStore.js";

class RecordingRuntime implements LeadRuntime {
	readonly type = "recording";
	readonly delivered: LeadEventEnvelope[] = [];
	result: DeliveryResult = { delivered: true };

	async deliver(envelope: LeadEventEnvelope): Promise<DeliveryResult> {
		this.delivered.push(envelope);
		return this.result;
	}
	async sendBootstrap(): Promise<void> {}
	async health(): Promise<LeadRuntimeHealth> {
		return { status: "healthy", lastDeliveryAt: null, lastDeliveredSeq: 0 };
	}
	async shutdown(): Promise<void> {}
}

describe("LeadEventDeliveryCoordinator (FLY-1279 D1)", () => {
	let store: StateStore;
	let runtime: RecordingRuntime;
	let tmpDir: string;
	let commDbPath: string;
	let nowMs: number;
	let priorAck: string | undefined;
	let priorTypes: string | undefined;

	beforeEach(async () => {
		priorAck = process.env.FLYWHEEL_DELIVERY_ACK;
		priorTypes = process.env.FLYWHEEL_DELIVERY_ACK_TYPES;
		process.env.FLYWHEEL_DELIVERY_ACK = "1";
		delete process.env.FLYWHEEL_DELIVERY_ACK_TYPES;
		store = await StateStore.create(":memory:");
		runtime = new RecordingRuntime();
		tmpDir = mkdtempSync(join(tmpdir(), "fly1279-delivery-"));
		commDbPath = join(tmpDir, "comm.db");
		new CommDB(commDbPath).close();
		nowMs = Date.parse("2026-07-15T12:00:00.000Z");
	});

	afterEach(() => {
		store.close();
		rmSync(tmpDir, { recursive: true, force: true });
		if (priorAck === undefined) delete process.env.FLYWHEEL_DELIVERY_ACK;
		else process.env.FLYWHEEL_DELIVERY_ACK = priorAck;
		if (priorTypes === undefined)
			delete process.env.FLYWHEEL_DELIVERY_ACK_TYPES;
		else process.env.FLYWHEEL_DELIVERY_ACK_TYPES = priorTypes;
	});

	function appendQuestionEvent(
		questionId: string,
		type = "gate_question",
	): number {
		const payload = {
			event_type: type,
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "flywheel",
			question_id: questionId,
			comm_db_path: commDbPath,
		};
		return store.appendLeadEvent(
			"lead-1",
			`${type}-${questionId}`,
			type,
			JSON.stringify(payload),
			"exec-1",
		);
	}

	function envelope(seq: number, questionId: string): LeadEventEnvelope {
		return {
			seq,
			event: {
				event_type: "gate_question",
				execution_id: "exec-1",
				issue_id: "issue-1",
				project_name: "flywheel",
				question_id: questionId,
				comm_db_path: commDbPath,
			},
			sessionKey: "exec-1",
			leadId: "lead-1",
			timestamp: new Date(nowMs).toISOString(),
		};
	}

	function coordinator(opts?: {
		maxRedeliver?: number;
		maxTransportFailures?: number;
		lateAckWindowMs?: number;
		onDeadLetter?: (seq: number) => Promise<boolean>;
	}): LeadEventDeliveryCoordinator {
		return new LeadEventDeliveryCoordinator({
			store,
			runtimeForLead: (leadId) => (leadId === "lead-1" ? runtime : undefined),
			commDbPaths: () => [commDbPath],
			secretProvider: {
				getActive: () => ({
					secretId: "secret-v1",
					key: Buffer.from("01234567890123456789012345678901"),
				}),
			},
			now: () => nowMs,
			ackTimeoutMs: 60_000,
			leaseMs: 30_000,
			maxRedeliver: opts?.maxRedeliver ?? 2,
			maxTransportFailures: opts?.maxTransportFailures ?? 2,
			lateAckWindowMs: opts?.lateAckWindowMs,
			onDeadLetter: opts?.onDeadLetter
				? (row) => opts.onDeadLetter!(row.seq)
				: undefined,
		});
	}

	it("persists the ACK cohort and immutable routing snapshot at enqueue", () => {
		const seq = appendQuestionEvent("q-1");
		expect(store.getLeadEventBySeq(seq)).toMatchObject({
			ack_required: true,
			ack_policy: "question_response",
			ack_protocol_version: 1,
			ack_owner_lead_id: "lead-1",
			ack_owner_epoch: 0,
		});
		expect(
			JSON.parse(store.getLeadEventBySeq(seq)!.routing_snapshot!),
		).toMatchObject({
			projectName: "flywheel",
			commDbPath,
			questionId: "q-1",
			ownerLeadId: "lead-1",
		});
	});

	it("claims before push, finalizes atomically, and uses a new attempt identity for a reminder", async () => {
		const seq = appendQuestionEvent("q-2");
		const delivery = coordinator();

		expect(await delivery.deliver(envelope(seq, "q-2"), runtime)).toEqual({
			delivered: true,
		});
		const first = runtime.delivered[0]!;
		expect(first.ack).toMatchObject({
			eventSeq: seq,
			policy: "question_response",
		});
		expect(first.deliveryAttemptId).toBeTruthy();
		expect(store.getLeadEventBySeq(seq)?.ack_deadline_at).toBeTruthy();
		expect(store.listLeadEventDeliveryAttempts(seq)).toMatchObject([
			{ kind: "initial", reason: "initial", outcome: "pushed" },
		]);

		nowMs += 60_001;
		await delivery.reconcile();
		expect(runtime.delivered).toHaveLength(2);
		expect(runtime.delivered[1]!.seq).toBe(seq);
		expect(runtime.delivered[1]!.deliveryAttemptId).not.toBe(
			first.deliveryAttemptId,
		);
		expect(store.listLeadEventDeliveryAttempts(seq)[1]).toMatchObject({
			kind: "reminder",
			reason: "ack_timeout",
			counts_toward_redelivery: 1,
			outcome: "pushed",
		});
	});

	it("auto-ACKs a question event from its durable CommDB response", async () => {
		const db = new CommDB(commDbPath);
		const qid = db.insertQuestion("exec-1", "lead-1", "question", {
			checkpoint: "question",
		});
		db.close();
		const seq = appendQuestionEvent(qid);
		const delivery = coordinator();
		await delivery.deliver(envelope(seq, qid), runtime);

		const answeringDb = new CommDB(commDbPath);
		answeringDb.insertResponse(qid, "lead-1", "answer");
		answeringDb.close();
		await delivery.reconcile();

		expect(store.getLeadEventBySeq(seq)?.acked_at).toBeTruthy();
		expect(
			store.listLeadEventDeliveryAttempts(seq).every((row) => row.retired_at),
		).toBe(true);
	});

	it("auto-ACKs a founder gate only from a confirmed posted marker", async () => {
		const appendFounderGate = (questionId: string, executionId: string) =>
			store.appendLeadEvent(
				"lead-1",
				`gate-question-${questionId}`,
				"gate_question",
				JSON.stringify({
					event_type: "gate_question",
					execution_id: executionId,
					issue_id: "issue-1",
					project_name: "flywheel",
					question_id: questionId,
					comm_db_path: commDbPath,
					checkpoint: "approve_to_ship",
				}),
				executionId,
			);
		const failedSeq = appendFounderGate("q-failed", "exec-failed");
		const postedSeq = appendFounderGate("q-posted", "exec-posted");
		expect(store.getLeadEventBySeq(postedSeq)?.ack_policy).toBe(
			"founder_surface_confirmed",
		);

		for (const [questionId, executionId, reason] of [
			["q-failed", "exec-failed", "permanent_failed"],
			["q-posted", "exec-posted", "posted"],
		] as const) {
			store.insertEvent({
				event_id: `founder-thread-notify-${questionId}`,
				execution_id: executionId,
				issue_id: "issue-1",
				project_name: "flywheel",
				event_type: "founder_thread_notify_done",
				source: "test",
				payload: { questionId, reason },
			});
		}

		await coordinator().reconcile();
		expect(store.getLeadEventBySeq(failedSeq)?.acked_at).toBeUndefined();
		expect(store.getLeadEventBySeq(postedSeq)?.acked_at).toBeTruthy();
	});

	it("consumes a valid backend-neutral CommDB receipt and rejects replay", async () => {
		const seq = appendQuestionEvent("q-3");
		const delivery = coordinator();
		await delivery.deliver(envelope(seq, "q-3"), runtime);
		const token = runtime.delivered[0]!.ack!.token;

		const db = new CommDB(commDbPath);
		const receipt = db.insertAckReceipt("lead-1", seq, token);
		db.close();
		await delivery.reconcile();

		expect(store.getLeadEventBySeq(seq)?.acked_at).toBeTruthy();
		const checkDb = new CommDB(commDbPath);
		expect(checkDb.getMessageById(receipt)?.read_at).toBeTruthy();
		const replay = checkDb.insertAckReceipt("lead-1", seq, token);
		checkDb.close();
		await delivery.reconcile();
		const finalDb = new CommDB(commDbPath);
		expect(finalDb.getMessageById(replay)?.read_at).toBeTruthy();
		finalDb.close();
	});

	it("secret rotation retires the old bearer and immediately sends a non-budget reminder", async () => {
		const secret = {
			secretId: "secret-v1",
			key: Buffer.from("01234567890123456789012345678901"),
		};
		const delivery = new LeadEventDeliveryCoordinator({
			store,
			runtimeForLead: () => runtime,
			commDbPaths: () => [commDbPath],
			secretProvider: { getActive: () => secret },
			now: () => nowMs,
			ackTimeoutMs: 60_000,
			leaseMs: 30_000,
		});
		const seq = appendQuestionEvent("q-secret-rotation");
		await delivery.deliver(envelope(seq, "q-secret-rotation"), runtime);
		const oldToken = runtime.delivered[0]!.ack!.token;

		secret.secretId = "secret-v2";
		secret.key = Buffer.from("abcdefghijklmnopqrstuvwxyzABCDEF");
		await delivery.reconcile();

		expect(runtime.delivered).toHaveLength(2);
		expect(runtime.delivered[1]!.ack!.token).not.toBe(oldToken);
		expect(store.listLeadEventDeliveryAttempts(seq)[1]).toMatchObject({
			reason: "secret_rotation",
			counts_toward_redelivery: 0,
			outcome: "pushed",
		});
		const db = new CommDB(commDbPath);
		db.insertAckReceipt("lead-1", seq, oldToken);
		db.close();
		await delivery.reconcile();
		expect(store.getLeadEventBySeq(seq)?.acked_at).toBeUndefined();
	});

	it("owner transfer fences the old attempt and immediately delivers to the new Lead", async () => {
		const secondRuntime = new RecordingRuntime();
		const delivery = new LeadEventDeliveryCoordinator({
			store,
			runtimeForLead: (leadId) =>
				leadId === "lead-1" ? runtime : secondRuntime,
			commDbPaths: () => [commDbPath],
			secretProvider: {
				getActive: () => ({
					secretId: "secret-v1",
					key: Buffer.from("01234567890123456789012345678901"),
				}),
			},
			now: () => nowMs,
			ackTimeoutMs: 60_000,
			leaseMs: 30_000,
		});
		const seq = appendQuestionEvent("q-owner-transfer");
		await delivery.deliver(envelope(seq, "q-owner-transfer"), runtime);
		const oldToken = runtime.delivered[0]!.ack!.token;

		expect(
			store.transferLeadEventAckOwner(
				seq,
				"lead-2",
				new Date(nowMs).toISOString(),
			),
		).toBe(true);
		await delivery.reconcile();

		expect(secondRuntime.delivered).toHaveLength(1);
		expect(secondRuntime.delivered[0]).toMatchObject({ leadId: "lead-2" });
		expect(secondRuntime.delivered[0]!.ack!.token).not.toBe(oldToken);
		expect(store.getLeadEventBySeq(seq)).toMatchObject({
			ack_owner_lead_id: "lead-2",
			ack_owner_epoch: 1,
		});
		expect(store.listLeadEventDeliveryAttempts(seq)[1]).toMatchObject({
			reason: "owner_transfer",
			counts_toward_redelivery: 0,
		});
	});

	it("does not charge a new owner for the retired owner's transport failures", async () => {
		const deadLetters: number[] = [];
		const seq = appendQuestionEvent("q-owner-budget");
		runtime.result = { delivered: false };
		const delivery = coordinator({
			maxTransportFailures: 2,
			onDeadLetter: async (deadSeq) => {
				deadLetters.push(deadSeq);
				return true;
			},
		});

		await delivery.reconcile();
		expect(
			store.transferLeadEventAckOwner(
				seq,
				"lead-2",
				new Date(nowMs).toISOString(),
			),
		).toBe(true);
		await delivery.reconcile();

		expect(deadLetters).toEqual([]);
		expect(store.getLeadEventBySeq(seq)?.dead_lettered_at).toBeFalsy();
		expect(store.listLeadEventDeliveryAttempts(seq)).toMatchObject([
			{ outcome: "failed", retired_at: expect.any(String) },
			{ outcome: "failed", retired_at: null },
		]);
	});

	it("rejects a dead-letter confirmation after its page claim lease expires", () => {
		const seq = appendQuestionEvent("q-expired-page-claim");
		const nowIso = new Date(nowMs).toISOString();
		expect(store.markLeadEventDeadLetterPending(seq, nowIso)).toBe(true);
		expect(
			store.claimLeadEventDeadLetterPage({
				seq,
				claimToken: "expired-claim",
				nowIso,
				leaseExpiresIso: new Date(nowMs + 1_000).toISOString(),
			}),
		).toBe(true);

		expect(
			store.markLeadEventDeadLetterConfirmed({
				seq,
				claimToken: "expired-claim",
				nowIso: new Date(nowMs + 2_000).toISOString(),
				ackTokenValidUntilIso: new Date(nowMs + 60_000).toISOString(),
			}),
		).toBe(false);
		expect(store.getLeadEventBySeq(seq)?.dead_lettered_at).toBeFalsy();
	});

	it("counts missing runtime as a bounded transport failure then confirms one dead letter", async () => {
		const deadLetters: number[] = [];
		const seq = appendQuestionEvent("q-4");
		const delivery = new LeadEventDeliveryCoordinator({
			store,
			runtimeForLead: () => undefined,
			commDbPaths: () => [commDbPath],
			secretProvider: {
				getActive: () => ({
					secretId: "secret-v1",
					key: Buffer.from("01234567890123456789012345678901"),
				}),
			},
			now: () => nowMs,
			ackTimeoutMs: 60_000,
			leaseMs: 30_000,
			maxRedeliver: 2,
			maxTransportFailures: 2,
			onDeadLetter: async (row) => {
				deadLetters.push(row.seq);
				return true;
			},
		});

		await delivery.reconcile();
		await delivery.reconcile();
		await delivery.reconcile();
		expect(store.listLeadEventDeliveryAttempts(seq)).toHaveLength(2);
		expect(
			store
				.listLeadEventDeliveryAttempts(seq)
				.every((attempt) => attempt.outcome === "failed"),
		).toBe(true);
		expect(deadLetters).toEqual([seq]);
		expect(store.getLeadEventBySeq(seq)?.dead_lettered_at).toBeTruthy();
	});

	it("pages a dead-lettered park through the shared semantic founder-page key before mirroring", async () => {
		const seq = store.appendLeadEvent(
			"lead-1",
			"park-event-1",
			"runner_park_notice",
			JSON.stringify({
				event_type: "runner_park_notice",
				execution_id: "exec-1",
				issue_id: "issue-1",
				project_name: "flywheel",
				detection_target_key: "exec-1",
				escalation_kind: "park:blocked",
				episode_fingerprint: "blocked:no-progress",
			}),
			"exec-1",
		);
		const pages: Parameters<
			Parameters<typeof createLeadEventDeadLetterHandler>[0]["pageFounder"]
		>[0][] = [];
		const mirrors: number[] = [];
		const handler = createLeadEventDeadLetterHandler({
			pageFounder: async (row) => {
				pages.push(row);
				return true;
			},
			mirror: async (row) => {
				mirrors.push(row.seq);
			},
			now: () => nowMs,
		});

		expect(await handler(store.getLeadEventBySeq(seq)!)).toBe(true);
		expect(pages[0]).toMatchObject({
			target_key: "exec-1",
			kind: "park:blocked",
			episode_fingerprint: "blocked:no-progress",
			status: "LEAD_NOTIFIED",
		});
		expect(founderPageEventId(pages[0]!)).toBe(
			"detection-escalation-page-exec-1-park:blocked-blocked:no-progress",
		);
		expect(mirrors).toEqual([seq]);
	});

	it("does not confirm or mirror a dead letter when the issue-thread page did not post", async () => {
		const seq = appendQuestionEvent("q-page-failed");
		const mirror = vi.fn(async () => {});
		const handler = createLeadEventDeadLetterHandler({
			pageFounder: async () => false,
			mirror,
		});

		expect(await handler(store.getLeadEventBySeq(seq)!)).toBe(false);
		expect(mirror).not.toHaveBeenCalled();
	});

	it("terminal-disposes a protected question only after the confirmed dead-letter late-ACK window", async () => {
		const db = new CommDB(commDbPath);
		const qid = db.insertQuestion("exec-1", "lead-1", "question", {
			checkpoint: "question",
		});
		db.close();
		const seq = appendQuestionEvent(qid);
		const protectedDb = new CommDB(commDbPath);
		expect(protectedDb.markQuestionProtected(qid, String(seq))).toBe(true);
		protectedDb.close();
		const delivery = new LeadEventDeliveryCoordinator({
			store,
			runtimeForLead: () => undefined,
			commDbPaths: () => [commDbPath],
			secretProvider: {
				getActive: () => ({
					secretId: "secret-v1",
					key: Buffer.from("01234567890123456789012345678901"),
				}),
			},
			now: () => nowMs,
			maxTransportFailures: 1,
			lateAckWindowMs: 1_000,
			onDeadLetter: async () => true,
		});

		await delivery.reconcile();
		let checkDb = new CommDB(commDbPath);
		expect(checkDb.getMessageById(qid)?.relay_state).toBe("protected");
		checkDb.close();

		nowMs += 1_001;
		await delivery.reconcile();
		checkDb = new CommDB(commDbPath);
		expect(checkDb.getMessageById(qid)?.relay_state).toBe("terminal_disposed");
		checkDb.close();
	});

	it("keeps legacy byte behavior when ACK delivery is disabled", async () => {
		process.env.FLYWHEEL_DELIVERY_ACK = "0";
		const seq = appendQuestionEvent("q-off");
		expect(store.getLeadEventBySeq(seq)?.ack_required).toBe(false);
		const delivery = coordinator();
		expect(await delivery.deliver(envelope(seq, "q-off"), runtime)).toEqual({
			delivered: true,
		});
		expect(runtime.delivered[0]!.ack).toBeUndefined();
		expect(store.listLeadEventDeliveryAttempts(seq)).toEqual([]);
	});
});

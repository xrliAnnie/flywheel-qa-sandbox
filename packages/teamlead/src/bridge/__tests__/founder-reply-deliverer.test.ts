import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryInboundCursorStore } from "../../lead-backends/codex/InboundCursorStore.js";
import {
	emitFounderReplyDeliveryForThread,
	type FounderReplyDeliverDeps,
	type FounderReplyThreadCtx,
	type PendingQuestionForThread,
} from "../founder-reply-deliverer.js";

const OWNER = "123456789012345678";
const THREAD = "223456789012345678";
const DISCORD_EPOCH = 1_420_070_400_000;

function snowflakeAt(ms: number): string {
	return (BigInt(Math.floor(ms) - DISCORD_EPOCH) << 22n).toString();
}

interface RawMsg {
	id: string;
	content?: string;
	author?: { id?: string; bot?: boolean };
	type?: number;
	message_reference?: {
		type?: number;
		message_id?: string;
		channel_id?: string;
	};
}

function discordGet(messages: RawMsg[], ok = true) {
	return vi.fn(async () => ({
		ok,
		status: ok ? 200 : 503,
		json: async () => messages,
	})) as unknown as typeof fetch;
}

function ctx(dbPath: string): FounderReplyThreadCtx {
	return {
		issueId: "FLY-1392",
		projectName: "flywheel",
		threadId: THREAD,
		botToken: "bot",
		ownerUserId: OWNER,
		graceMs: 10 * 60_000,
		commDbPath: dbPath,
		leadId: "test-lead",
	};
}

function question(
	id: string,
	checkpoint: string | null,
): PendingQuestionForThread {
	return {
		questionId: id,
		checkpoint,
		executionId: `exec-${id}`,
		createdAtMs: Date.now() - 60 * 60_000,
	};
}

function store(): FounderReplyDeliverDeps["store"] {
	return {
		insertEvent: vi.fn(() => true),
	} as unknown as FounderReplyDeliverDeps["store"];
}

function founderReviewStore(
	bindings: Array<{
		questionId: string;
		messageId: string;
		runId?: string;
		digest?: string;
	}>,
): FounderReplyDeliverDeps["store"] {
	return {
		insertEvent: vi.fn(() => true),
		getWorkflowExecutionBinding: vi.fn((executionId: string) => ({
			execution_id: executionId,
			run_id:
				bindings.find((item) => item.questionId === executionId.slice(5))
					?.runId ?? "run-1",
		})),
		getFounderReviewCardBindingByQuestion: vi.fn((questionId: string) => {
			const item = bindings.find(
				(candidate) => candidate.questionId === questionId,
			);
			return item
				? {
						question_id: item.questionId,
						message_id: item.messageId,
						run_id: item.runId ?? "run-1",
						artifact_digest: item.digest ?? "a".repeat(64),
						created_at: "2026-08-14T00:00:00.000Z",
					}
				: undefined;
		}),
		getFounderReviewCardBindingByMessage: vi.fn((messageId: string) => {
			const item = bindings.find(
				(candidate) => candidate.messageId === messageId,
			);
			return item
				? {
						question_id: item.questionId,
						message_id: item.messageId,
						run_id: item.runId ?? "run-1",
						artifact_digest: item.digest ?? "a".repeat(64),
						created_at: "2026-08-14T00:00:00.000Z",
					}
				: undefined;
		}),
	} as unknown as FounderReplyDeliverDeps["store"];
}

function insertFounderReviewQuestion(
	db: CommDB,
	id: string,
	round: number,
): string {
	return db.insertQuestion(
		`exec-${id}`,
		"test-lead",
		JSON.stringify({
			version: 1,
			round,
			runId: "run-1",
			artifactDigest: "a".repeat(64),
			hostedUrl: `https://reports.example/review-${round}`,
			paths: ["review.html"],
		}),
		{ id, checkpoint: "founder_review" },
	);
}

describe("FLY-1392 v2 founder ingress", () => {
	let dir: string;
	let dbPath: string;
	let cursor: InMemoryInboundCursorStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1392-founder-ingress-"));
		dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
		cursor = new InMemoryInboundCursorStore();
		cursor.save(THREAD, snowflakeAt(Date.now() - 2 * 60 * 60_000));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("records one canonical row and forwards founder text unchanged to Lead", async () => {
		const msg: RawMsg = {
			id: snowflakeAt(Date.now() - 30_000),
			content: "批准了，可以 merge 了 🆒",
			author: { id: OWNER },
			type: 19,
		};
		const handoff = vi.fn(async () => true);
		const ensureDecisionConvergence =
			vi.fn<
				NonNullable<FounderReplyDeliverDeps["ensureDecisionConvergence"]>
			>();
		const db = new CommDB(dbPath);
		db.registerSession(
			"exec-ship",
			"runner",
			"flywheel",
			"FLY-1392",
			"test-lead",
		);
		const shipQuestionId = db.insertQuestion(
			"exec-ship",
			"test-lead",
			"ship?",
			{ checkpoint: "approve_to_ship" },
		);
		db.close();

		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(dbPath),
			[
				question("brainstorm", "brainstorm"),
				{
					questionId: shipQuestionId,
					checkpoint: "approve_to_ship",
					executionId: "exec-ship",
					createdAtMs: Date.now() - 60 * 60_000,
				},
			],
			{
				store: store(),
				fetchImpl: discordGet([msg]),
				cursorStore: cursor,
				deliverAmbiguousToLead: handoff,
				ensureDecisionConvergence,
			},
		);

		expect(outcome.result).toBe("advanced");
		expect(ensureDecisionConvergence).toHaveBeenCalledOnce();
		const convergence = ensureDecisionConvergence.mock.calls[0]?.[0];
		expect(convergence.deadlineAtMs - convergence.disposedAtMs).toBe(180_000);
		expect(handoff).toHaveBeenCalledOnce();
		expect(handoff.mock.calls[0]?.[1]).toEqual({
			issueId: "FLY-1392",
			threadId: THREAD,
			msgId: msg.id,
			answer: msg.content,
			commDbPath: dbPath,
		});
		const queue = new MailboxQueue(dbPath);
		const row = queue.getById(`chat:test-lead:${msg.id}`);
		expect(row).toMatchObject({
			to_agent: "test-lead",
			type: "discord_chat",
			relay_state: "terminal_disposed",
			carrier: "inbox",
			priority: 1,
		});
		expect(row?.delivery_content).toContain(msg.content);
		queue.close();
	});

	it("consumes a reply to a superseded ship card before the sole-current-gate fallback", async () => {
		const db = new CommDB(dbPath);
		db.registerSession(
			"exec-current",
			"runner",
			"flywheel",
			"FLY-1392",
			"test-lead",
		);
		const currentQuestionId = db.insertQuestion(
			"exec-current",
			"test-lead",
			"ship current?",
			{ checkpoint: "approve_to_ship" },
		);
		db.close();
		const oldHolder = {
			run_id: "run-1",
			gate_node_id: "founder_gate",
			attempt: 1,
			head_sha: "a".repeat(40),
			source_execution_id: "exec-old",
			question_id: "question-old",
			state: "superseded",
		};
		const recordOldCardInput = vi.fn(() => ({
			ok: true as const,
			idempotentReplay: false,
		}));
		const testStore = {
			insertEvent: vi.fn(() => true),
			getSupersededWorkflowGateHolderByCardMessageId: vi.fn(() => oldHolder),
			recordVoidedWorkflowGateInput: recordOldCardInput,
		} as unknown as FounderReplyDeliverDeps["store"];
		const tryFounderShipApproval = vi.fn();
		const handoff = vi.fn(async () => true);
		const msg: RawMsg = {
			id: snowflakeAt(Date.now() - 10_000),
			content: "ship",
			author: { id: OWNER },
			type: 19,
			message_reference: {
				type: 0,
				message_id: "card-old",
				channel_id: THREAD,
			},
		};

		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(dbPath),
			[
				{
					questionId: currentQuestionId,
					checkpoint: "approve_to_ship",
					executionId: "exec-current",
					createdAtMs: Date.now() - 60 * 60_000,
				},
			],
			{
				store: testStore,
				fetchImpl: discordGet([msg]),
				cursorStore: cursor,
				deliverAmbiguousToLead: handoff,
				tryFounderShipApproval,
			},
		);

		expect(outcome.result).toBe("advanced");
		expect(recordOldCardInput).toHaveBeenCalledWith({
			questionId: "question-old",
			alertIdentity: {
				leadId: "test-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			now: expect.any(String),
		});
		expect(tryFounderShipApproval).not.toHaveBeenCalled();
		expect(handoff).not.toHaveBeenCalled();
		const verify = new CommDB(dbPath);
		expect(verify.getResponse(currentQuestionId)).toBeUndefined();
		expect(verify.getResponse("question-old")).toBeUndefined();
		expect(verify.listWorkflowSourceEventsAfter(0)).toEqual([]);
		verify.close();
	});

	it("alerts on an approved-origin superseded-card reply without approving the current gate", async () => {
		const db = new CommDB(dbPath);
		db.registerSession(
			"exec-current",
			"runner",
			"flywheel",
			"FLY-1392",
			"test-lead",
		);
		const currentQuestionId = db.insertQuestion(
			"exec-current",
			"test-lead",
			"ship current?",
			{ checkpoint: "approve_to_ship" },
		);
		db.close();
		const recordOldCardInput = vi.fn(() => ({
			ok: true as const,
			idempotentReplay: false,
		}));
		const tryFounderShipApproval = vi.fn();
		const testStore = {
			insertEvent: vi.fn(() => true),
			getSupersededWorkflowGateHolderByCardMessageId: vi.fn(() => ({
				question_id: "question-old",
				superseded_from_state: "approved",
			})),
			recordVoidedWorkflowGateInput: recordOldCardInput,
		} as unknown as FounderReplyDeliverDeps["store"];

		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(dbPath),
			[
				{
					questionId: currentQuestionId,
					checkpoint: "approve_to_ship",
					executionId: "exec-current",
					createdAtMs: Date.now() - 60 * 60_000,
				},
			],
			{
				store: testStore,
				fetchImpl: discordGet([
					{
						id: snowflakeAt(Date.now() - 10_000),
						content: "ship",
						author: { id: OWNER },
						type: 19,
						message_reference: {
							type: 0,
							message_id: "card-old",
							channel_id: THREAD,
						},
					},
				]),
				cursorStore: cursor,
				tryFounderShipApproval,
			},
		);

		expect(outcome.result).toBe("advanced");
		expect(recordOldCardInput).toHaveBeenCalledWith({
			questionId: "question-old",
			alertIdentity: {
				leadId: "test-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			now: expect.any(String),
		});
		expect(tryFounderShipApproval).not.toHaveBeenCalled();
		const verify = new CommDB(dbPath);
		expect(verify.getResponse(currentQuestionId)).toBeUndefined();
		verify.close();
	});

	it("pins an old-card reply when the durable Lead alert cannot be recorded", async () => {
		const before = cursor.load(THREAD);
		const recordOldCardInput = vi.fn(() => ({
			ok: false as const,
			reason: "alert_outbox_unavailable",
		}));
		const testStore = {
			insertEvent: vi.fn(() => true),
			getSupersededWorkflowGateHolderByCardMessageId: vi.fn(() => ({
				question_id: "question-old",
			})),
			recordVoidedWorkflowGateInput: recordOldCardInput,
		} as unknown as FounderReplyDeliverDeps["store"];
		const handoff = vi.fn(async () => true);

		const outcome = await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: testStore,
			fetchImpl: discordGet([
				{
					id: snowflakeAt(Date.now() - 10_000),
					content: "ship",
					author: { id: OWNER },
					type: 19,
					message_reference: {
						type: 0,
						message_id: "card-old",
						channel_id: THREAD,
					},
				},
			]),
			cursorStore: cursor,
			deliverAmbiguousToLead: handoff,
		});

		expect(outcome).toMatchObject({
			result: "process_failed",
			stage: "voided_card_input_alert_failed",
		});
		expect(cursor.load(THREAD)).toBe(before);
		expect(handoff).not.toHaveBeenCalled();
	});

	it.each([
		["通过", true, undefined],
		["这里的定位还不对，请按页面批注修改", false, "这里的定位还不对"],
	] as const)(
		"writes a trusted founder_review decision for the sole current round: %s",
		async (content, passed, feedbackExcerpt) => {
			const db = new CommDB(dbPath);
			const questionId = insertFounderReviewQuestion(db, "review-1", 1);
			db.close();
			const msg: RawMsg = {
				id: snowflakeAt(Date.now() - 10_000),
				content,
				author: { id: OWNER },
			};
			const handoff = vi.fn(async () => true);
			const outcome = await emitFounderReplyDeliveryForThread(
				ctx(dbPath),
				[
					{
						questionId,
						checkpoint: "founder_review",
						executionId: "exec-review-1",
						createdAtMs: Date.now() - 60 * 60_000,
					},
				],
				{
					store: founderReviewStore([{ questionId, messageId: "card-1" }]),
					fetchImpl: discordGet([msg]),
					cursorStore: cursor,
					deliverAmbiguousToLead: handoff,
				},
			);
			expect(outcome.result).toBe("advanced");
			expect(handoff).not.toHaveBeenCalled();
			const verify = new CommDB(dbPath);
			const family = verify.getFounderReviewFamily(questionId)!;
			expect(family.response).toBeDefined();
			expect(JSON.parse(family.response!.content)).toMatchObject({
				passed,
				...(feedbackExcerpt
					? { feedback: expect.stringContaining(feedbackExcerpt) }
					: {}),
			});
			verify.close();
		},
	);

	it("does not let a reply to an older founder_review card decide the newer round", async () => {
		const db = new CommDB(dbPath);
		const oldId = insertFounderReviewQuestion(db, "review-1", 1);
		const newId = insertFounderReviewQuestion(db, "review-2", 2);
		db.close();
		const handoff = vi.fn(async () => true);
		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(dbPath),
			[
				{
					questionId: oldId,
					checkpoint: "founder_review",
					executionId: "exec-review-1",
					createdAtMs: Date.now() - 60 * 60_000,
				},
				{
					questionId: newId,
					checkpoint: "founder_review",
					executionId: "exec-review-2",
					createdAtMs: Date.now() - 60 * 60_000,
				},
			],
			{
				store: founderReviewStore([
					{ questionId: oldId, messageId: "card-old" },
					{ questionId: newId, messageId: "card-new" },
				]),
				fetchImpl: discordGet([
					{
						id: snowflakeAt(Date.now() - 10_000),
						content: "通过",
						author: { id: OWNER },
						type: 19,
						message_reference: {
							type: 0,
							message_id: "card-old",
							channel_id: THREAD,
						},
					},
				]),
				cursorStore: cursor,
				deliverAmbiguousToLead: handoff,
			},
		);
		expect(outcome.result).toBe("advanced");
		expect(handoff).toHaveBeenCalledOnce();
		const verify = new CommDB(dbPath);
		expect(verify.getFounderReviewFamily(oldId)?.response).toBeUndefined();
		expect(verify.getFounderReviewFamily(newId)?.response).toBeUndefined();
		verify.close();
	});

	it("is category agnostic: a founder message with zero questions still enters the same path", async () => {
		const msg: RawMsg = {
			id: snowflakeAt(Date.now() - 20_000),
			content: "a brand-new category",
			author: { id: OWNER },
		};
		const handoff = vi.fn(async () => true);

		await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: store(),
			fetchImpl: discordGet([msg]),
			cursorStore: cursor,
			deliverAmbiguousToLead: handoff,
		});

		expect(handoff).toHaveBeenCalledOnce();
		expect(cursor.load(THREAD)).toBe(msg.id);
	});

	it("ignores non-founder and bot-authored traffic", async () => {
		const handoff = vi.fn(async () => true);
		const latest = snowflakeAt(Date.now() - 10_000);

		await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: store(),
			fetchImpl: discordGet([
				{ id: snowflakeAt(Date.now() - 20_000), author: { id: "other" } },
				{ id: latest, author: { id: OWNER, bot: true } },
			]),
			cursorStore: cursor,
			deliverAmbiguousToLead: handoff,
		});

		expect(handoff).not.toHaveBeenCalled();
		expect(cursor.load(THREAD)).toBe(latest);
	});

	it("pins the cursor when the durable Lead handoff is absent or fails", async () => {
		const msg: RawMsg = {
			id: snowflakeAt(Date.now() - 10_000),
			content: "do not drop me",
			author: { id: OWNER },
		};
		const before = cursor.load(THREAD);

		const missing = await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: store(),
			fetchImpl: discordGet([msg]),
			cursorStore: cursor,
		});
		expect(missing).toMatchObject({
			result: "process_failed",
			stage: "lead_handoff_missing",
		});
		expect(cursor.load(THREAD)).toBe(before);

		const failed = await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: store(),
			fetchImpl: discordGet([msg]),
			cursorStore: cursor,
			deliverAmbiguousToLead: async () => false,
		});
		expect(failed).toMatchObject({
			result: "process_failed",
			stage: "lead_handoff_failed",
		});
		expect(cursor.load(THREAD)).toBe(before);
	});

	it("retries an idempotent canonical row and advances after handoff recovery", async () => {
		const msg: RawMsg = {
			id: snowflakeAt(Date.now() - 10_000),
			content: "retry me",
			author: { id: OWNER },
		};
		const handoff = vi
			.fn<() => Promise<boolean>>()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const deps: FounderReplyDeliverDeps = {
			store: store(),
			fetchImpl: discordGet([msg]),
			cursorStore: cursor,
			deliverAmbiguousToLead: handoff,
		};

		expect(
			(await emitFounderReplyDeliveryForThread(ctx(dbPath), [], deps)).result,
		).toBe("process_failed");
		expect(
			(await emitFounderReplyDeliveryForThread(ctx(dbPath), [], deps)).result,
		).toBe("advanced");
		expect(cursor.load(THREAD)).toBe(msg.id);
		const queue = new MailboxQueue(dbPath);
		expect(queue.getById(`chat:test-lead:${msg.id}`)).toBeDefined();
		queue.close();
	});

	it("does not advance on a Discord read failure", async () => {
		const before = cursor.load(THREAD);
		const outcome = await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: store(),
			fetchImpl: discordGet([], false),
			cursorStore: cursor,
			deliverAmbiguousToLead: async () => true,
		});

		expect(outcome.result).toBe("read_failed");
		expect(cursor.load(THREAD)).toBe(before);
	});

	it("bootstraps an unseen thread at its current head without replaying history", async () => {
		const freshCursor = new InMemoryInboundCursorStore();
		const head = snowflakeAt(Date.now() - 5_000);
		const handoff = vi.fn(async () => true);
		const outcome = await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: store(),
			fetchImpl: discordGet([{ id: head, author: { id: OWNER } }]),
			cursorStore: freshCursor,
			deliverAmbiguousToLead: handoff,
		});

		expect(outcome.result).toBe("noop");
		expect(freshCursor.load(THREAD)).toBe(head);
		expect(handoff).not.toHaveBeenCalled();
	});
});

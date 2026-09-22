import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import {
	parseChatDeliveryEnvelope,
	parseDiscordChatRoute,
} from "flywheel-comm/discord-chat-ingest";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FileInboundCursorStore,
	InMemoryInboundCursorStore,
} from "../../lead-backends/codex/InboundCursorStore.js";
import { StateStore } from "../../StateStore.js";
import {
	emitFounderReplyDeliveryForThread,
	type FounderReplyDeliverDeps,
	type FounderReplyThreadCtx,
	type PendingQuestionForThread,
} from "../founder-reply-deliverer.js";

const OWNER = "123456789012345678";
const THREAD = "223456789012345678";

// Platform message references use Discord snowflakes, including wrong-target fixtures.
const CARD_OLD = "423456789012345670";
const CARD_NEW = "423456789012345671";
const CARD_1 = "423456789012345672";
const CARD_2 = "423456789012345673";
const REVIEW_CARD = "423456789012345674";
const REVIEW_CARD_1 = "423456789012345675";
const REVIEW_CARD_2 = "423456789012345676";
const SHIP_CARD = "423456789012345677";
const WRONG_CARD = "423456789012345678";
const WRONG_THREAD = "423456789012345679";

const DISCORD_EPOCH = 1_420_070_400_000;

function snowflakeAt(ms: number): string {
	return (BigInt(Math.floor(ms) - DISCORD_EPOCH) << 22n).toString();
}

interface RawMsg {
	id: string;
	channel_id?: string;
	content?: string;
	author?: { id?: string; bot?: boolean };
	attachments?: Array<{
		id?: string;
		filename?: string;
		content_type?: string;
		size?: number;
	}>;
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
	const eventIds = new Set<string>();
	return {
		insertEvent: vi.fn((event: { event_id: string }) => {
			if (eventIds.has(event.event_id)) return false;
			eventIds.add(event.event_id);
			return true;
		}),
		getSession: vi.fn(() => ({
			issue_id: "11111111-2222-3333-4444-555555555555",
			issue_identifier: "FLY-1392",
			pr_head_sha: "b".repeat(40),
		})),
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
	it("FLY-2597: only a real founder reply settles prior attention before classification", async () => {
		const durable = await StateStore.create(":memory:");
		try {
			const asked = Date.now() - 60_000;
			durable.insertFounderAsk({
				ask_id: "ask",
				project_name: "flywheel",
				issue_id: "FLY-1392",
				channel_id: "channel",
				thread_id: THREAD,
				lead_id: "test-lead",
				question_id: null,
				excerpt: "Decide",
				asked_at: new Date(asked).toISOString(),
			});
			durable.backfillFounderAskMessage("ask", "message");
			for (const author of [
				{ id: "stranger" },
				{ id: OWNER, bot: true },
				{ id: OWNER },
			]) {
				await emitFounderReplyDeliveryForThread(
					{ ...ctx(dbPath), attentionSinceMs: asked },
					[],
					{
						store: durable,
						onFounderThreadMessage: (input) => {
							durable.recordFounderAttentionReply(input);
						},
						cursorStore: new InMemoryInboundCursorStore(),
						fetchImpl: discordGet([
							{
								id: snowflakeAt(asked + 1000),
								content: "unrelated reply",
								author,
							},
						]),
						deliverAmbiguousToLead: async () => true,
					},
				);
				expect(durable.getFounderAsk("ask")?.settled_at !== null).toBe(
					author.id === OWNER && !author.bot,
				);
			}
			expect(
				durable.hasFounderAttentionReplyAfter(
					"flywheel",
					"FLY-1392",
					new Date(asked).toISOString(),
				),
			).toBe(true);
		} finally {
			durable.close();
		}
	});

	it("FLY-2597: a settlement failure pins the cursor and enters the existing retry ledger", async () => {
		const before = cursor.load(THREAD),
			id = snowflakeAt(Date.now() - 1000);
		const recordFailure = vi.fn(() => ({ deadLettered: false }));
		const result = await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: store(),
			cursorStore: cursor,
			fetchImpl: discordGet([{ id, content: "reply", author: { id: OWNER } }]),
			onFounderThreadMessage: () => {
				throw new Error("settle failed");
			},
			retryLedger: {
				isDeadLettered: () => false,
				recordFailure,
				clear: vi.fn(),
				clearUpTo: vi.fn(),
			} as unknown as FounderReplyDeliverDeps["retryLedger"],
		});
		expect(result).toMatchObject({
			result: "process_failed",
			stage: "founder_ask_settle_failed",
			pinnedMsgId: id,
		});
		expect(cursor.load(THREAD)).toBe(before);
		expect(recordFailure).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "founder_ask_settle_failed" }),
		);
	});

	it("releases owned CommDB before a learning observer waits", async () => {
		let live = 0;
		let finish!: (result: "handled") => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const run = emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: store(),
			cursorStore: cursor,
			fetchImpl: discordGet([
				{
					id: snowflakeAt(Date.now() - 30000),
					content: "why",
					author: { id: OWNER },
					type: 19,
					message_reference: {
						message_id: "323456789012345678",
						channel_id: THREAD,
					},
				},
			]),
			commDbLeaseFactory: () => {
				const db = new CommDB(dbPath, false);
				live++;
				return {
					db,
					release: () => {
						db.close();
						live--;
					},
				};
			},
			observeShipJudgmentReply: () => {
				entered();
				return new Promise((resolve) => {
					finish = resolve;
				});
			},
		});
		await started;
		try {
			expect(live).toBe(0);
		} finally {
			finish("handled");
			await run;
		}
		expect(live).toBe(0);
	});
	it.each(["success", "reject"] as const)(
		"default writer releases numeric fds while Lead handoff waits (%s)",
		async (settlement) => {
			const fdDirectory =
				process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
			const count = () =>
				readdirSync(fdDirectory).filter((name) => /^\d+$/.test(name)).length;
			const baseline = count();
			let resolveHandoff!: (value: boolean) => void;
			let rejectHandoff!: (error: Error) => void;
			let entered!: () => void;
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const handoff = new Promise<boolean>((resolve, reject) => {
				resolveHandoff = resolve;
				rejectHandoff = reject;
			});
			const before = cursor.load(THREAD);
			const run = emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
				store: store(),
				cursorStore: cursor,
				fetchImpl: discordGet([
					{
						id: snowflakeAt(Date.now() - 30000),
						content: "discussion",
						author: { id: OWNER },
					},
				]),
				deliverAmbiguousToLead: () => {
					entered();
					return handoff;
				},
			});
			await started;
			try {
				expect(count()).toBeLessThanOrEqual(baseline);
			} finally {
				if (settlement === "success") resolveHandoff(true);
				else rejectHandoff(new Error("transport failed"));
			}
			const result = await run;
			expect(result.result).toBe(
				settlement === "success" ? "advanced" : "process_failed",
			);
			if (settlement === "reject") expect(cursor.load(THREAD)).toBe(before);
			expect(count()).toBeLessThanOrEqual(baseline);
		},
	);

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

	it("advances past a quoted reply already ingested by a producer without reference metadata", async () => {
		const first: RawMsg = {
			id: snowflakeAt(Date.now() - 30_000),
			content: "first reply",
			author: { id: OWNER },
			type: 19,
			message_reference: { message_id: CARD_1, channel_id: THREAD },
		};
		const next: RawMsg = {
			id: snowflakeAt(Date.now() - 20_000),
			content: "following reply",
			author: { id: OWNER },
		};
		const db = new CommDB(dbPath);
		db.ingestDiscordChat({
			leadId: "test-lead",
			chatId: THREAD,
			originChannelId: THREAD,
			messageId: first.id,
			authorId: OWNER,
			authorName: "founder",
			ts: new Date(Date.now() - 30_000).toISOString(),
			msgKind: "guild",
			attachments: [],
			text: first.content!,
			founderId: OWNER,
		});
		db.close();
		const beforeQueue = new MailboxQueue(dbPath);
		const before = beforeQueue.getById(`chat:test-lead:${first.id}`)!;
		beforeQueue.close();
		const handoff = vi.fn(async () => true);
		const result = await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
			store: founderReviewStore([]),
			cursorStore: cursor,
			fetchImpl: discordGet([next, first]),
			deliverAmbiguousToLead: handoff,
		});
		expect(result).toEqual({ threadId: THREAD, result: "advanced" });
		expect(cursor.load(THREAD)).toBe(next.id);
		expect(handoff).toHaveBeenCalledTimes(2);
		const afterQueue = new MailboxQueue(dbPath);
		try {
			expect(afterQueue.getById(before.id)?.content).toBe(before.content);
			expect(afterQueue.getById(before.id)?.delivery_content).toBe(
				before.delivery_content,
			);
			expect(afterQueue.getById(`chat:test-lead:${next.id}`)).toBeDefined();
		} finally {
			afterQueue.close();
		}
	});

	it.each(["handled", "retry"] as const)(
		"routes explicit learning replies before broad classification (%s)",
		async (result) => {
			const msg: RawMsg = {
				id: snowflakeAt(Date.now() - 30_000),
				content: "approve",
				author: { id: OWNER },
				type: 19,
				message_reference: {
					message_id: "323456789012345678",
					channel_id: THREAD,
				},
			};
			const before = cursor.load(THREAD),
				handoff = vi.fn(async () => true);
			const observeShipJudgmentReply = vi.fn(async () => result);
			await emitFounderReplyDeliveryForThread(ctx(dbPath), [], {
				store: store(),
				cursorStore: cursor,
				fetchImpl: discordGet([msg]),
				deliverAmbiguousToLead: handoff,
				observeShipJudgmentReply,
			});
			expect(observeShipJudgmentReply).toHaveBeenCalledExactlyOnceWith({
				projectName: "flywheel",
				leadId: "test-lead",
				threadId: THREAD,
				messageId: msg.id,
				replyToMessageId: "323456789012345678",
			});
			expect(handoff).not.toHaveBeenCalled();
			expect(cursor.load(THREAD)).toBe(result === "handled" ? msg.id : before);
		},
	);

	it("records one canonical row and forwards founder text unchanged to Lead", async () => {
		const msg: RawMsg = {
			id: snowflakeAt(Date.now() - 30_000),
			content: "批准了，可以 merge 了 🆒",
			author: { id: OWNER },
			type: 19,
			message_reference: { message_id: "444", channel_id: "555" },
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
		expect(ensureDecisionConvergence).not.toHaveBeenCalled();
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
		expect(row?.delivery_content).toContain(
			'reply_to_message_id="444" reply_to_channel_id="555"',
		);
		queue.close();
	});

	it.each(["ship", "通过"])(
		"consumes superseded ship-card %s and guides approval to the latest card",
		async (content) => {
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
			const postThreadReply = vi.fn(async () => true);
			const msg: RawMsg = {
				id: snowflakeAt(Date.now() - 10_000),
				content,
				author: { id: OWNER },
				type: 19,
				message_reference: {
					type: 0,
					message_id: CARD_OLD,
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
					postThreadReply,
				},
			);

			expect(outcome.result).toBe("advanced");
			if (content === "通过") {
				expect(postThreadReply).toHaveBeenCalledOnce();
				expect(postThreadReply.mock.calls[0]?.[0]).toContain("上一轮");
				expect(postThreadReply.mock.calls[0]?.[0]).toContain("最新");
			} else expect(postThreadReply).not.toHaveBeenCalled();
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
		},
	);

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
							message_id: CARD_OLD,
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
						message_id: CARD_OLD,
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

	it("keeps founder review discussion open and relays it to Lead", async () => {
		const db = new CommDB(dbPath);
		const questionId = insertFounderReviewQuestion(db, "review-1", 1);
		db.close();
		const msg: RawMsg = {
			id: snowflakeAt(Date.now() - 10_000),
			content: "ok what's next",
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
				store: founderReviewStore([{ questionId, messageId: CARD_1 }]),
				fetchImpl: discordGet([msg]),
				cursorStore: cursor,
				deliverAmbiguousToLead: handoff,
			},
		);

		expect(outcome.result).toBe("advanced");
		expect(handoff).toHaveBeenCalledOnce();
		const verify = new CommDB(dbPath);
		expect(verify.getFounderReviewFamily(questionId)?.response).toBeUndefined();
		verify.close();
	});

	it("keeps plain text out of ship handling while multiple review rounds are pending", async () => {
		const db = new CommDB(dbPath);
		const firstReviewId = insertFounderReviewQuestion(db, "review-1", 1);
		const secondReviewId = insertFounderReviewQuestion(db, "review-2", 2);
		const shipQuestionId = db.insertQuestion(
			"exec-ship",
			"test-lead",
			"ship?",
			{ checkpoint: "approve_to_ship" },
		);
		db.close();
		const handoff = vi.fn(async () => true);
		const tryFounderShipApproval = vi.fn(async () => ({
			bound: [{ questionId: shipQuestionId, decision: "approve" as const }],
			deferred: [],
			retry: false,
		}));

		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(dbPath),
			[
				{
					questionId: firstReviewId,
					checkpoint: "founder_review",
					executionId: "exec-review-1",
					createdAtMs: Date.now() - 60 * 60_000,
				},
				{
					questionId: secondReviewId,
					checkpoint: "founder_review",
					executionId: "exec-review-2",
					createdAtMs: Date.now() - 60 * 60_000,
				},
				{
					questionId: shipQuestionId,
					checkpoint: "approve_to_ship",
					executionId: "exec-ship",
					createdAtMs: Date.now() - 60 * 60_000,
				},
			],
			{
				store: founderReviewStore([
					{ questionId: firstReviewId, messageId: REVIEW_CARD_1 },
					{ questionId: secondReviewId, messageId: REVIEW_CARD_2 },
				]),
				fetchImpl: discordGet([
					{
						id: snowflakeAt(Date.now() - 10_000),
						content: "可以",
						author: { id: OWNER },
					},
				]),
				cursorStore: cursor,
				deliverAmbiguousToLead: handoff,
				tryFounderShipApproval,
			},
		);

		expect(outcome.result).toBe("advanced");
		expect(handoff).toHaveBeenCalledOnce();
		expect(tryFounderShipApproval).not.toHaveBeenCalled();
		const verify = new CommDB(dbPath);
		expect(verify.getResponse(firstReviewId)).toBeUndefined();
		expect(verify.getResponse(secondReviewId)).toBeUndefined();
		expect(verify.getResponse(shipQuestionId)).toBeUndefined();
		verify.close();
	});

	it.each(["approve", "reject"] as const)(
		"still routes explicit ship-card %s after the learning observer declines it",
		async (decision) => {
			const db = new CommDB(dbPath);
			const reviewQuestionId = insertFounderReviewQuestion(db, "review-1", 1);
			const shipQuestionId = db.insertQuestion(
				"exec-ship",
				"test-lead",
				"ship?",
				{ checkpoint: "approve_to_ship" },
			);
			db.close();
			const borrowedDb = new CommDB(dbPath, false);
			const release = vi.fn();
			const acquire = vi.fn(() => ({ db: borrowedDb, release }));
			const handoff = vi.fn(async () => true);
			const observeShipJudgmentReply = vi.fn(async () => "ignored" as const);
			const tryFounderShipApproval = vi.fn(async () => ({
				bound: [{ questionId: shipQuestionId, decision }],
				deferred: [],
				retry: false,
			}));
			const readCurrentBinding = vi.fn(() => ({
				questionId: shipQuestionId,
				executionId: "exec-ship",
				issueId: "FLY-1392",
				prHeadSha: "b".repeat(40),
				threadId: THREAD,
				gateMessageId: SHIP_CARD,
				checkpoint: "approve_to_ship",
				postedAt: new Date().toISOString(),
			}));

			const outcome = await emitFounderReplyDeliveryForThread(
				ctx(dbPath),
				[
					{
						questionId: reviewQuestionId,
						checkpoint: "founder_review",
						executionId: "exec-review-1",
						createdAtMs: Date.now() - 60 * 60_000,
					},
					{
						questionId: shipQuestionId,
						checkpoint: "approve_to_ship",
						executionId: "exec-ship",
						createdAtMs: Date.now() - 60 * 60_000,
					},
				],
				{
					store: founderReviewStore([
						{ questionId: reviewQuestionId, messageId: REVIEW_CARD },
					]),
					fetchImpl: discordGet([
						{
							id: snowflakeAt(Date.now() - 10_000),
							content: decision,
							author: { id: OWNER },
							type: 19,
							message_reference: {
								type: 0,
								message_id: SHIP_CARD,
								channel_id: THREAD,
							},
						},
					]),
					cursorStore: cursor,
					commDbLeaseFactory: acquire,
					deliverAmbiguousToLead: handoff,
					tryFounderShipApproval,
					observeShipJudgmentReply,
					readCurrentBinding,
				},
			);

			expect(outcome.result).toBe("advanced");
			expect(observeShipJudgmentReply).toHaveBeenCalledOnce();
			expect(tryFounderShipApproval).toHaveBeenCalledOnce();
			expect(tryFounderShipApproval.mock.calls[0]?.[0]).toMatchObject({
				shipGates: [{ questionId: shipQuestionId }],
				replyToCard: true,
			});
			const scoped = tryFounderShipApproval.mock.calls[0]?.[0].db;
			expect(scoped.getMessageById(shipQuestionId)).toEqual(
				borrowedDb.getMessageById(shipQuestionId),
			);
			expect(acquire).toHaveBeenCalled();
			expect(release).toHaveBeenCalledTimes(acquire.mock.calls.length);
			expect(borrowedDb.getPendingQuestions("test-lead")).toHaveLength(2);
			borrowedDb.close();
			expect(handoff).not.toHaveBeenCalled();
		},
	);

	it.each([
		"批准小红书 ABCDEFGH",
		"批准小红书 错码",
		"拒绝小红书 ABCDEFGH",
		"撤回小红书 ABCDEFGH",
		"　批准小红书 ＡＢＣＤＥＦＧＨ！　",
		"批准小红书：这是转述，不是 ship 批准",
	])("keeps XHS namespace out of a bound ship card: %s", async (content) => {
		const db = new CommDB(dbPath);
		const questionId = db.insertQuestion("exec-ship", "test-lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const handoff = vi.fn(
			async (_id: string, _payload: Record<string, unknown>) => true,
		);
		const ship = vi.fn(async () => ({ bound: [], deferred: [], retry: false }));
		const learning = vi.fn(async () => "ignored" as const);
		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(dbPath),
			[
				{
					questionId,
					checkpoint: "approve_to_ship",
					executionId: "exec-ship",
					createdAtMs: Date.now() - 3600000,
				},
			],
			{
				store: founderReviewStore([]),
				cursorStore: cursor,
				commDbLeaseFactory: () => ({ db, release: () => {} }),
				fetchImpl: discordGet([
					{
						id: snowflakeAt(Date.now() - 10000),
						content,
						author: { id: OWNER },
						type: 19,
						message_reference: {
							type: 0,
							message_id: SHIP_CARD,
							channel_id: THREAD,
						},
					},
				]),
				deliverAmbiguousToLead: handoff,
				tryFounderShipApproval: ship,
				observeShipJudgmentReply: learning,
				readCurrentBinding: () => ({
					questionId,
					executionId: "exec-ship",
					issueId: "FLY-1392",
					prHeadSha: "b".repeat(40),
					threadId: THREAD,
					gateMessageId: SHIP_CARD,
					checkpoint: "approve_to_ship",
					postedAt: new Date().toISOString(),
				}),
			},
		);
		try {
			expect(outcome.result).toBe("advanced");
			expect(ship).not.toHaveBeenCalled();
			expect(learning).not.toHaveBeenCalled();
			expect(handoff).toHaveBeenCalledOnce();
			expect(handoff.mock.calls[0]?.[1]).toMatchObject({ answer: content });
			expect(db.getPendingQuestions("test-lead")).toHaveLength(1);
		} finally {
			db.close();
		}
	});

	it("never sends free thread speech through the ship verdict classifier", async () => {
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
		const handoff = vi.fn(async () => true);
		const tryFounderShipApproval = vi.fn(async () => ({
			bound: [{ questionId: shipQuestionId, decision: "approve" as const }],
			deferred: [],
			retry: false,
		}));

		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(dbPath),
			[
				{
					questionId: shipQuestionId,
					checkpoint: "approve_to_ship",
					executionId: "exec-ship",
					createdAtMs: Date.now() - 60 * 60_000,
				},
			],
			{
				store: store(),
				fetchImpl: discordGet([
					{
						id: snowflakeAt(Date.now() - 10_000),
						content: "approve",
						author: { id: OWNER },
					},
				]),
				cursorStore: cursor,
				deliverAmbiguousToLead: handoff,
				tryFounderShipApproval,
			},
		);

		expect(outcome.result).toBe("advanced");
		expect(tryFounderShipApproval).not.toHaveBeenCalled();
		expect(handoff).toHaveBeenCalledOnce();
	});

	it("keeps legacy approval words and page summaries in free thread speech", async () => {
		const db = new CommDB(dbPath);
		const questionId = insertFounderReviewQuestion(db, "review-1", 1);
		db.close();
		const handoff = vi.fn(async () => true);
		const firstId = snowflakeAt(Date.now() - 20_000);
		const secondId = snowflakeAt(Date.now() - 10_000);

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
				store: founderReviewStore([{ questionId, messageId: CARD_1 }]),
				fetchImpl: discordGet([
					{
						id: secondId,
						content: "【页面意见汇总】FLY-1392\n\n这里要改",
						author: { id: OWNER },
					},
					{ id: firstId, content: "通过", author: { id: OWNER } },
				]),
				cursorStore: cursor,
				deliverAmbiguousToLead: handoff,
			},
		);

		expect(outcome.result).toBe("advanced");
		expect(handoff).toHaveBeenCalledTimes(2);
		const verify = new CommDB(dbPath);
		expect(verify.getFounderReviewFamily(questionId)?.response).toBeUndefined();
		verify.close();
	});

	it("does not retry guidance after default HTTP POST failure and resumes a persisted cursor", async () => {
		const db = new CommDB(dbPath);
		const questionId = insertFounderReviewQuestion(db, "review-1", 1);
		db.close();
		const state = founderReviewStore([{ questionId, messageId: CARD_1 }]);
		const cursorPath = join(dir, "cursor.json");
		const durable = new FileInboundCursorStore(cursorPath);
		durable.save(THREAD, cursor.load(THREAD)!);
		const first = snowflakeAt(Date.now() - 20_000);
		const second = snowflakeAt(Date.now() - 10_000);
		let messages: RawMsg[] = [
			{ id: first, content: "通过", author: { id: OWNER } },
		];
		let postOk = false;
		const posts: string[] = [];
		const fetchImpl = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				if (init?.method === "POST") {
					posts.push(String(init.body));
					return { ok: postOk, status: postOk ? 200 : 403 } as Response;
				}
				const after = new URL(String(url)).searchParams.get("after")!;
				return {
					ok: true,
					status: 200,
					json: async () =>
						messages.filter((m) => BigInt(m.id) > BigInt(after)),
				} as Response;
			},
		) as typeof fetch;
		const deps = {
			store: state,
			fetchImpl,
			cursorStore: durable,
			deliverAmbiguousToLead: vi.fn(async () => true),
		};
		const questions = [question(questionId, "founder_review")];
		expect(
			(await emitFounderReplyDeliveryForThread(ctx(dbPath), questions, deps))
				.result,
		).toBe("advanced");
		expect(state.insertEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "approval_anchor_feedback_failed",
			}),
		);
		expect(posts).toHaveLength(1);
		const resumed = new FileInboundCursorStore(cursorPath);
		expect(resumed.load(THREAD)).toBe(first);
		await emitFounderReplyDeliveryForThread(ctx(dbPath), questions, {
			...deps,
			cursorStore: resumed,
		});
		expect(posts).toHaveLength(1);
		postOk = true;
		messages = [{ id: second, content: "通过", author: { id: OWNER } }];
		await emitFounderReplyDeliveryForThread(ctx(dbPath), questions, {
			...deps,
			cursorStore: resumed,
		});
		// Lead ruling: the per-card attempt remains claimed after failed/unknown POST.
		expect(posts).toHaveLength(1);
		expect(new FileInboundCursorStore(cursorPath).load(THREAD)).toBe(second);
		const verify = new CommDB(dbPath);
		expect(verify.getResponse(questionId)).toBeUndefined();
		verify.close();
	});

	it.each([
		{
			content: "通过",
			author: OWNER,
			checkpoint: "approve_to_ship",
			reference: undefined,
			prompts: 1,
		},
		{
			content: "通过",
			author: OWNER,
			checkpoint: "founder_review",
			reference: { channel_id: WRONG_THREAD, message_id: CARD_1 },
			prompts: 1,
		},
		{
			content: "通过",
			author: OWNER,
			checkpoint: "founder_review",
			reference: { channel_id: THREAD, message_id: WRONG_CARD },
			prompts: 1,
		},
		{
			content: "通过",
			author: "other",
			checkpoint: "founder_review",
			reference: undefined,
			prompts: 0,
		},
		{
			content: "通过？",
			author: OWNER,
			checkpoint: "founder_review",
			reference: undefined,
			prompts: 0,
		},
		{
			content: "可以了",
			author: OWNER,
			checkpoint: "founder_review",
			reference: undefined,
			prompts: 0,
		},
		{
			content: "普通讨论",
			author: OWNER,
			checkpoint: "founder_review",
			reference: undefined,
			prompts: 0,
		},
		{
			content: "通过",
			author: OWNER,
			checkpoint: null,
			reference: undefined,
			prompts: 0,
		},
	])(
		"preserves ingress boundary $content $author $checkpoint $reference",
		async ({ content, author, checkpoint, reference, prompts }) => {
			const db = new CommDB(dbPath);
			const id = db.insertQuestion("exec-q", "test-lead", "question", {
				id: "q",
				checkpoint: checkpoint ?? undefined,
			});
			db.close();
			const postThreadReply = vi.fn(async () => true);
			await emitFounderReplyDeliveryForThread(
				ctx(dbPath),
				[question(id, checkpoint)],
				{
					store: founderReviewStore([{ questionId: id, messageId: CARD_1 }]),
					fetchImpl: discordGet([
						{
							id: snowflakeAt(Date.now() - 20 * 60_000),
							content,
							author: { id: author },
							...(reference ? { type: 19, message_reference: reference } : {}),
						},
					]),
					cursorStore: cursor,
					deliverAmbiguousToLead: vi.fn(async () => true),
					postThreadReply,
				},
			);
			expect(postThreadReply).toHaveBeenCalledTimes(prompts);
			const verify = new CommDB(dbPath);
			expect(verify.getResponse(id)).toBeUndefined();
			verify.close();
		},
	);

	it.each(["false", "throw", "stale-review", "superseded"])(
		"feedback %s does not block a later anchored approval",
		async (failure) => {
			const db = new CommDB(dbPath);
			const oldId = insertFounderReviewQuestion(db, "review-old", 1);
			const questionId = insertFounderReviewQuestion(db, "review-1", 2);
			db.close();
			const state = founderReviewStore([
				{ questionId: oldId, messageId: CARD_OLD },
				{ questionId, messageId: CARD_1 },
			]);
			if (failure === "superseded") {
				Object.assign(state, {
					getSupersededWorkflowGateHolderByCardMessageId: (id: string) =>
						id === CARD_OLD
							? { question_id: oldId, source_execution_id: "exec-review-old" }
							: undefined,
					recordVoidedWorkflowGateInput: vi.fn(() => ({ ok: true })),
				});
			}
			const first = snowflakeAt(Date.now() - 20_000);
			const second = snowflakeAt(Date.now() - 10_000);
			const postThreadReply = vi.fn(async () => {
				if (failure === "throw") throw new Error("POST unavailable");
				return false;
			});
			const outcome = await emitFounderReplyDeliveryForThread(
				ctx(dbPath),
				[
					question(oldId, "founder_review"),
					question(questionId, "founder_review"),
				],
				{
					store: state,
					fetchImpl: discordGet([
						{
							id: first,
							content: "通过",
							author: { id: OWNER },
							...(failure === "stale-review" || failure === "superseded"
								? {
										type: 19,
										message_reference: {
											message_id: CARD_OLD,
											channel_id: THREAD,
										},
									}
								: {}),
						},
						{
							id: second,
							content: "通过",
							author: { id: OWNER },
							type: 19,
							message_reference: { message_id: CARD_1, channel_id: THREAD },
						},
					]),
					cursorStore: cursor,
					deliverAmbiguousToLead: vi.fn(async () => true),
					postThreadReply,
					reactToFounderMessage: vi.fn(async () => true),
				},
			);
			expect(postThreadReply).toHaveBeenCalledOnce();
			expect(state.insertEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					event_type: "approval_anchor_feedback_failed",
				}),
			);
			expect(outcome.result).toBe("advanced");
			expect(cursor.load(THREAD)).toBe(second);
			const verify = new CommDB(dbPath);
			expect(
				JSON.parse(verify.getResponse(questionId)?.content ?? "{}"),
			).toMatchObject({ passed: true });
			verify.close();
		},
	);

	it("deduplicates bare approval guidance for the same thread and card across scans", async () => {
		const db = new CommDB(dbPath);
		const questionId = insertFounderReviewQuestion(db, "review-1", 1);
		db.close();
		const state = founderReviewStore([{ questionId, messageId: CARD_1 }]);
		const postThreadReply = vi.fn(async () => true);
		for (const [index, content] of ["通过", "approve", "通过！"].entries()) {
			const id = snowflakeAt(Date.now() - 30_000 + index * 5_000);
			const outcome = await emitFounderReplyDeliveryForThread(
				ctx(dbPath),
				[question(questionId, "founder_review")],
				{
					store: state,
					fetchImpl: discordGet([{ id, content, author: { id: OWNER } }]),
					cursorStore: cursor,
					deliverAmbiguousToLead: vi.fn(async () => true),
					postThreadReply,
				},
			);
			expect(outcome.result).toBe("advanced");
		}
		expect(postThreadReply).toHaveBeenCalledOnce();
		const verify = new CommDB(dbPath);
		expect(verify.getResponse(questionId)).toBeUndefined();
		verify.close();
	});

	it.each(["founder_review", "approve_to_ship"])(
		"persists %s guidance dedup across restart while allowing a new card or thread",
		async (checkpoint) => {
			const db = new CommDB(dbPath);
			const questionId = insertFounderReviewQuestion(db, "review-1", 1);
			db.close();
			const statePath = join(dir, "state.db");
			const postThreadReply = vi.fn(async () => true);
			const cases = [
				{ card: CARD_1, thread: THREAD, posts: 1 },
				{ card: CARD_1, thread: THREAD, posts: 1 },
				{ card: CARD_2, thread: THREAD, posts: 2 },
				{ card: CARD_2, thread: "323456789012345678", posts: 3 },
			];
			for (const item of cases) {
				const durable = await StateStore.create(statePath);
				try {
					const state = founderReviewStore(
						checkpoint === "founder_review"
							? [{ questionId, messageId: item.card }]
							: [],
					);
					state.insertEvent = durable.insertEvent.bind(durable);
					const restartedCursor = new InMemoryInboundCursorStore();
					restartedCursor.save(item.thread, snowflakeAt(Date.now() - 60_000));
					const outcome = await emitFounderReplyDeliveryForThread(
						{ ...ctx(dbPath), threadId: item.thread },
						[question(questionId, checkpoint)],
						{
							store: state,
							fetchImpl: discordGet([
								{
									id: snowflakeAt(Date.now() - 10_000),
									content: "通过",
									author: { id: OWNER },
								},
							]),
							cursorStore: restartedCursor,
							deliverAmbiguousToLead: vi.fn(async () => true),
							readCurrentBinding: vi.fn(
								() =>
									({ gateMessageId: item.card }) as ReturnType<
										NonNullable<FounderReplyDeliverDeps["readCurrentBinding"]>
									>,
							),
							postThreadReply,
						},
					);
					expect(outcome).toMatchObject({ result: "advanced" });
					expect(postThreadReply).toHaveBeenCalledTimes(item.posts);
				} finally {
					durable.close();
				}
			}
		},
	);

	it("skips guidance without pinning ingress when its durable claim throws", async () => {
		const db = new CommDB(dbPath);
		const questionId = insertFounderReviewQuestion(db, "review-1", 1);
		db.close();
		const state = founderReviewStore([{ questionId, messageId: CARD_1 }]);
		const insertEvent = vi.mocked(state.insertEvent).getMockImplementation()!;
		vi.mocked(state.insertEvent).mockImplementation((event) => {
			if (event.event_type === "approval_anchor_feedback_claimed")
				throw new Error("claim unavailable");
			return insertEvent(event);
		});
		const postThreadReply = vi.fn(async () => true);
		const id = snowflakeAt(Date.now() - 10_000);
		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(dbPath),
			[question(questionId, "founder_review")],
			{
				store: state,
				fetchImpl: discordGet([{ id, content: "通过", author: { id: OWNER } }]),
				cursorStore: cursor,
				deliverAmbiguousToLead: vi.fn(async () => true),
				postThreadReply,
			},
		);
		expect(outcome.result).toBe("advanced");
		expect(cursor.load(THREAD)).toBe(id);
		expect(postThreadReply).not.toHaveBeenCalled();
	});

	it("does not pin or repost approval guidance when its audit write throws", async () => {
		const db = new CommDB(dbPath);
		const questionId = insertFounderReviewQuestion(db, "review-1", 1);
		db.close();
		const state = founderReviewStore([{ questionId, messageId: CARD_1 }]);
		const insertEvent = vi.mocked(state.insertEvent).getMockImplementation()!;
		vi.mocked(state.insertEvent).mockImplementation((event) => {
			if (event.event_type === "approval_anchor_feedback_sent")
				throw new Error("audit unavailable");
			return insertEvent(event);
		});
		const postThreadReply = vi.fn(async () => true);
		const id = snowflakeAt(Date.now() - 10_000);
		const cursorPath = join(dir, "audit-cursor.json");
		new FileInboundCursorStore(cursorPath).save(
			THREAD,
			snowflakeAt(Date.now() - 60_000),
		);
		for (let scan = 0; scan < 2; scan++) {
			const outcome = await emitFounderReplyDeliveryForThread(
				ctx(dbPath),
				[question(questionId, "founder_review")],
				{
					store: state,
					fetchImpl: discordGet([
						{ id, content: "通过", author: { id: OWNER } },
					]),
					cursorStore: new FileInboundCursorStore(cursorPath),
					deliverAmbiguousToLead: vi.fn(async () => true),
					postThreadReply,
				},
			);
			expect(outcome.result).not.toBe("process_failed");
			expect(new FileInboundCursorStore(cursorPath).load(THREAD)).toBe(id);
		}
		expect(postThreadReply).toHaveBeenCalledOnce();
	});

	it.each(["通过", "approve"])(
		"explains unanchored approval %s without answering the gate",
		async (content) => {
			const db = new CommDB(dbPath);
			const questionId = insertFounderReviewQuestion(db, "review-1", 1);
			db.close();
			const postThreadReply = vi.fn(async () => true);
			const handoff = vi.fn(async () => true);
			const messageId = snowflakeAt(Date.now() - 10_000);
			const outcome = await emitFounderReplyDeliveryForThread(
				ctx(dbPath),
				[question(questionId, "founder_review")],
				{
					store: founderReviewStore([{ questionId, messageId: CARD_1 }]),
					fetchImpl: discordGet([
						{ id: messageId, content, author: { id: OWNER } },
					]),
					cursorStore: cursor,
					deliverAmbiguousToLead: handoff,
					postThreadReply,
				},
			);
			expect(outcome.result).toBe("advanced");
			expect(postThreadReply).toHaveBeenCalledOnce();
			expect(postThreadReply.mock.calls[0]?.[0]).toContain("这条还没有批准");
			expect(postThreadReply.mock.calls[0]?.[0]).toContain(
				"回复对应的当前审批卡",
			);
			expect(handoff).toHaveBeenCalledOnce();
			const verify = new CommDB(dbPath);
			expect(
				verify.getFounderReviewFamily(questionId)?.response,
			).toBeUndefined();
			verify.close();
		},
	);

	it.each(["approve", "通过"])(
		"binds fixed text %j only when it replies to the review card",
		async (content) => {
			const db = new CommDB(dbPath);
			const questionId = insertFounderReviewQuestion(db, "review-1", 1);
			db.close();
			const borrowedDb = new CommDB(dbPath, false);
			const release = vi.fn();
			const acquire = vi.fn(() => ({ db: borrowedDb, release }));
			const messageId = snowflakeAt(Date.now() - 10_000);
			const reactToFounderMessage = vi.fn(async () => true);

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
					store: founderReviewStore([{ questionId, messageId: CARD_1 }]),
					fetchImpl: discordGet([
						{
							id: messageId,
							content,
							author: { id: OWNER },
							type: 19,
							message_reference: {
								type: 0,
								message_id: CARD_1,
								channel_id: THREAD,
							},
						},
					]),
					cursorStore: cursor,
					commDbLeaseFactory: acquire,
					deliverAmbiguousToLead: vi.fn(async () => true),
					reactToFounderMessage,
				},
			);

			expect(outcome.result).toBe("advanced");
			expect(acquire).toHaveBeenCalled();
			expect(release).toHaveBeenCalledTimes(acquire.mock.calls.length);
			expect(reactToFounderMessage).toHaveBeenCalledWith(messageId);
			expect(
				JSON.parse(borrowedDb.getResponse(questionId)?.content ?? "{}"),
			).toMatchObject({ passed: true });
			borrowedDb.close();
		},
	);

	it("explains a neither verdict at most once per review round", async () => {
		const db = new CommDB(dbPath);
		const questionId = insertFounderReviewQuestion(db, "review-1", 1);
		db.close();
		const handoff = vi.fn(async () => true);
		const postThreadReply = vi.fn(async () => true);
		const firstId = snowflakeAt(Date.now() - 20_000);
		const secondId = snowflakeAt(Date.now() - 10_000);

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
				store: founderReviewStore([{ questionId, messageId: CARD_1 }]),
				fetchImpl: discordGet([
					{
						id: secondId,
						content: "还有什么需要我决定的？",
						author: { id: OWNER },
						type: 19,
						message_reference: {
							type: 0,
							message_id: CARD_1,
							channel_id: THREAD,
						},
					},
					{
						id: firstId,
						content: "ok what's next",
						author: { id: OWNER },
						type: 19,
						message_reference: {
							type: 0,
							message_id: CARD_1,
							channel_id: THREAD,
						},
					},
				]),
				cursorStore: cursor,
				deliverAmbiguousToLead: handoff,
				postThreadReply,
			},
		);

		expect(outcome.result).toBe("advanced");
		expect(handoff).toHaveBeenCalledTimes(2);
		expect(postThreadReply).toHaveBeenCalledOnce();
		expect(postThreadReply.mock.calls[0]?.[0]).toContain("没有写入 verdict");
		expect(postThreadReply.mock.calls[0]?.[0]).toContain("approve / 通过");
	});

	it("warns when an explicit kickback closes without page feedback", async () => {
		const db = new CommDB(dbPath);
		const questionId = insertFounderReviewQuestion(db, "review-1", 1);
		db.close();
		const postThreadReply = vi.fn(async () => true);

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
				store: founderReviewStore([{ questionId, messageId: CARD_1 }]),
				fetchImpl: discordGet([
					{
						id: snowflakeAt(Date.now() - 10_000),
						content: "打回",
						author: { id: OWNER },
						type: 19,
						message_reference: {
							type: 0,
							message_id: CARD_1,
							channel_id: THREAD,
						},
					},
				]),
				cursorStore: cursor,
				deliverAmbiguousToLead: vi.fn(async () => true),
				postThreadReply,
			},
		);

		expect(outcome.result).toBe("advanced");
		expect(postThreadReply).toHaveBeenCalledOnce();
		expect(postThreadReply.mock.calls[0]?.[0]).toContain("互动页面写过留言");
		const verify = new CommDB(dbPath);
		expect(JSON.parse(verify.getResponse(questionId)?.content ?? "{}")).toEqual(
			{
				version: 1,
				passed: false,
				artifactDigest: "a".repeat(64),
			},
		);
		verify.close();
	});

	it("does not bind a page summary marker for a different issue", async () => {
		const db = new CommDB(dbPath);
		const questionId = insertFounderReviewQuestion(db, "review-1", 1);
		db.close();
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
				store: founderReviewStore([{ questionId, messageId: CARD_1 }]),
				fetchImpl: discordGet([
					{
						id: snowflakeAt(Date.now() - 10_000),
						content: "【页面意见汇总】FLY-9999\n\n这不是当前单的意见",
						author: { id: OWNER },
					},
				]),
				cursorStore: cursor,
				deliverAmbiguousToLead: handoff,
			},
		);

		expect(outcome.result).toBe("advanced");
		expect(handoff).toHaveBeenCalledOnce();
		const verify = new CommDB(dbPath);
		expect(verify.getFounderReviewFamily(questionId)?.response).toBeUndefined();
		verify.close();
	});

	it("keeps a late page summary out of an open ship gate", async () => {
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
		const handoff = vi.fn(async () => true);
		const postThreadReply = vi.fn(async () => true);
		const tryFounderShipApproval = vi.fn(async () => ({
			bound: [{ questionId: shipQuestionId, decision: "reject" as const }],
			deferred: [],
			retry: false,
		}));

		const outcome = await emitFounderReplyDeliveryForThread(
			ctx(dbPath),
			[
				{
					questionId: shipQuestionId,
					checkpoint: "approve_to_ship",
					executionId: "exec-ship",
					createdAtMs: Date.now() - 60 * 60_000,
				},
			],
			{
				store: store(),
				fetchImpl: discordGet([
					{
						id: snowflakeAt(Date.now() - 10_000),
						content: "【页面意见汇总】FLY-1392\n\n迟到的页面意见",
						author: { id: OWNER },
					},
				]),
				cursorStore: cursor,
				deliverAmbiguousToLead: handoff,
				tryFounderShipApproval,
				postThreadReply,
			},
		);

		expect(outcome.result).toBe("advanced");
		expect(handoff).toHaveBeenCalledOnce();
		expect(tryFounderShipApproval).not.toHaveBeenCalled();
		expect(postThreadReply).not.toHaveBeenCalled();
		const verify = new CommDB(dbPath);
		expect(verify.getResponse(shipQuestionId)).toBeUndefined();
		verify.close();
	});

	it("does not let a reply to an older founder_review card decide the newer round", async () => {
		const db = new CommDB(dbPath);
		const oldId = insertFounderReviewQuestion(db, "review-1", 1);
		const newId = insertFounderReviewQuestion(db, "review-2", 2);
		db.close();
		const handoff = vi.fn(async () => true);
		const postThreadReply = vi.fn(async () => true);
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
					{ questionId: oldId, messageId: CARD_OLD },
					{ questionId: newId, messageId: CARD_NEW },
				]),
				fetchImpl: discordGet([
					{
						id: snowflakeAt(Date.now() - 10_000),
						content: "通过",
						author: { id: OWNER },
						type: 19,
						message_reference: {
							type: 0,
							message_id: CARD_OLD,
							channel_id: THREAD,
						},
					},
				]),
				cursorStore: cursor,
				deliverAmbiguousToLead: handoff,
				postThreadReply,
			},
		);
		expect(outcome.result).toBe("advanced");
		expect(handoff).toHaveBeenCalledOnce();
		expect(postThreadReply).toHaveBeenCalledOnce();
		expect(postThreadReply.mock.calls[0]?.[0]).toContain("上一轮");
		expect(postThreadReply.mock.calls[0]?.[0]).toContain("最新");
		expect(postThreadReply.mock.calls[0]?.[0]).not.toContain("本轮仍开放");
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

	it("ingests the first founder message after a fixed rollout boundary and replies in the source thread", async () => {
		const freshCursor = new InMemoryInboundCursorStore();
		const rolloutAfter = snowflakeAt(Date.now() - 60_000);
		const message = {
			id: snowflakeAt(Date.now() - 20_000),
			content: "first question",
			channel_id: THREAD,
			author: { id: OWNER },
			attachments: [
				{
					id: "523456789012345678",
					filename: "pixel.png",
					content_type: "image/png",
					size: 2048,
				},
				{},
			],
		};
		const handoff = vi.fn(async () => true);
		const nudgeLeadInbox = vi.fn();
		const fetchImpl = discordGet([message]);
		const outcome = await emitFounderReplyDeliveryForThread(
			{
				...ctx(dbPath),
				ingestOnly: true,
				rolloutAfter,
				replyChannelId: THREAD,
			},
			[question("must-not-run", "approve_to_ship")],
			{
				store: store(),
				fetchImpl,
				cursorStore: freshCursor,
				deliverAmbiguousToLead: handoff,
				nudgeLeadInbox,
			},
		);

		expect(outcome).toEqual({ threadId: THREAD, result: "advanced" });
		expect(freshCursor.load(THREAD)).toBe(message.id);
		expect(handoff).not.toHaveBeenCalled();
		expect(nudgeLeadInbox).toHaveBeenCalledOnce();
		expect(fetchImpl).toHaveBeenCalledWith(
			expect.stringContaining(`after=${rolloutAfter}`),
			expect.any(Object),
		);
		const queue = new MailboxQueue(dbPath);
		try {
			const row = queue.getById(`chat:test-lead:${message.id}`);
			expect(row).toBeDefined();
			expect(parseChatDeliveryEnvelope(row!.content).attachments).toEqual([
				{
					attachmentId: "523456789012345678",
					name: "pixel.png",
					type: "image/png",
					sizeKb: 2,
				},
				{
					name: "attachment",
					type: "application/octet-stream",
					sizeKb: 0,
					unavailableReason: "invalid_metadata",
				},
			]);
			expect(parseDiscordChatRoute(row!.content)).toEqual({
				replyChannelId: THREAD,
			});
		} finally {
			queue.close();
		}
	});

	it("pins ingest-only scanning when another carrier owns the delivery identity", async () => {
		const before = cursor.load(THREAD);
		const message = {
			id: snowflakeAt(Date.now() - 20_000),
			content: "do not skip this external winner",
			author: { id: OWNER },
		};
		const fakeDb = {
			getPendingQuestions: vi.fn(() => []),
			ingestDiscordChat: vi.fn(() => ({
				lane: "legacy_external" as const,
				deliveryId: `chat:test-lead:${message.id}`,
			})),
		} as unknown as CommDB;
		const outcome = await emitFounderReplyDeliveryForThread(
			{
				...ctx(dbPath),
				ingestOnly: true,
				rolloutAfter: before!,
				replyChannelId: THREAD,
			},
			[],
			{
				store: store(),
				fetchImpl: discordGet([message]),
				cursorStore: cursor,
				commDbLeaseFactory: () => ({ db: fakeDb, release: vi.fn() }),
			},
		);

		expect(outcome).toMatchObject({
			result: "process_failed",
			pinnedMsgId: message.id,
			stage: "discord_lane_unconfirmed",
		});
		expect(cursor.load(THREAD)).toBe(before);
	});

	it("rechecks native subscription ownership immediately before ingest-only reads", async () => {
		const fetchImpl = discordGet([]);
		const outcome = await emitFounderReplyDeliveryForThread(
			{
				...ctx(dbPath),
				ingestOnly: true,
				rolloutAfter: cursor.load(THREAD)!,
				replyChannelId: THREAD,
			},
			[],
			{
				store: store(),
				fetchImpl,
				cursorStore: cursor,
				admitIngestOnly: async () => false,
			},
		);

		expect(outcome).toMatchObject({
			result: "process_failed",
			stage: "producer_overlap",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("continues an ingest-only backlog across more than two bounded pages", async () => {
		const freshCursor = new InMemoryInboundCursorStore();
		const base = Date.now() - 120_000;
		const rolloutAfter = snowflakeAt(base);
		const messages = Array.from({ length: 101 }, (_, index) => ({
			id: snowflakeAt(base + 1_000 + index * 500),
			content: `message-${index}`,
			author: { id: OWNER },
		}));
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			const after = new URL(String(url)).searchParams.get("after")!;
			const page = messages
				.filter(({ id }) => BigInt(id) > BigInt(after))
				.slice(0, 50)
				.reverse();
			return { ok: true, status: 200, json: async () => page };
		}) as unknown as typeof fetch;
		const fakeDb = {
			ingestDiscordChat: vi.fn((input: { messageId: string }) => ({
				lane: "inserted_inbox" as const,
				deliveryId: `chat:test-lead:${input.messageId}`,
				seq: 1,
			})),
		} as unknown as CommDB;
		const release = vi.fn();
		const nudgeLeadInbox = vi.fn();
		const threadCtx = {
			...ctx(dbPath),
			ingestOnly: true,
			rolloutAfter,
			replyChannelId: THREAD,
		};
		const deps: FounderReplyDeliverDeps = {
			store: store(),
			fetchImpl,
			cursorStore: freshCursor,
			commDbLeaseFactory: () => ({ db: fakeDb, release }),
			nudgeLeadInbox,
		};

		expect(
			(await emitFounderReplyDeliveryForThread(threadCtx, [], deps)).result,
		).toBe("advanced");
		expect(
			(await emitFounderReplyDeliveryForThread(threadCtx, [], deps)).result,
		).toBe("advanced");
		expect(
			(await emitFounderReplyDeliveryForThread(threadCtx, [], deps)).result,
		).toBe("advanced");
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(fakeDb.ingestDiscordChat).toHaveBeenCalledTimes(101);
		expect(nudgeLeadInbox).toHaveBeenCalledTimes(101);
		expect(freshCursor.load(THREAD)).toBe(messages.at(-1)!.id);
	});

	it("retries from the prior cursor after a cursor-save failure without a second nudge", async () => {
		const before = cursor.load(THREAD)!;
		const message = {
			id: snowflakeAt(Date.now() - 20_000),
			content: "persist me once",
			author: { id: OWNER },
			attachments: [
				{ filename: "question.png", content_type: "image/png", size: 1024 },
			],
		};
		const failingCursor = {
			load: () => before,
			save: vi.fn(() => {
				throw new Error("cursor disk full");
			}),
		};
		const firstNudge = vi.fn();
		const first = await emitFounderReplyDeliveryForThread(
			{
				...ctx(dbPath),
				ingestOnly: true,
				rolloutAfter: before,
				replyChannelId: THREAD,
			},
			[],
			{
				store: store(),
				fetchImpl: discordGet([message]),
				cursorStore: failingCursor,
				nudgeLeadInbox: firstNudge,
			},
		);
		expect(first).toMatchObject({
			result: "process_failed",
			stage: "cursor_save_failed",
		});
		expect(firstNudge).toHaveBeenCalledOnce();

		const resumedCursor = new InMemoryInboundCursorStore();
		resumedCursor.save(THREAD, before);
		const replayNudge = vi.fn();
		const replay = await emitFounderReplyDeliveryForThread(
			{
				...ctx(dbPath),
				ingestOnly: true,
				rolloutAfter: before,
				replyChannelId: THREAD,
			},
			[],
			{
				store: store(),
				fetchImpl: discordGet([message]),
				cursorStore: resumedCursor,
				nudgeLeadInbox: replayNudge,
			},
		);
		expect(replay.result).toBe("advanced");
		expect(replayNudge).not.toHaveBeenCalled();
		expect(resumedCursor.load(THREAD)).toBe(message.id);
	});

	it("fails closed on malformed ids or a mismatched response channel", async () => {
		for (const message of [
			{ id: "invalid", author: { id: OWNER } },
			{
				id: snowflakeAt(Date.now() - 20_000),
				channel_id: WRONG_THREAD,
				author: { id: OWNER },
			},
		]) {
			const before = cursor.load(THREAD);
			const outcome = await emitFounderReplyDeliveryForThread(
				{
					...ctx(dbPath),
					ingestOnly: true,
					rolloutAfter: before!,
					replyChannelId: THREAD,
				},
				[],
				{
					store: store(),
					fetchImpl: discordGet([message]),
					cursorStore: cursor,
				},
			);
			expect(outcome).toMatchObject({
				result: "read_failed",
				stage: "invalid_response",
			});
			expect(cursor.load(THREAD)).toBe(before);
		}
	});
});

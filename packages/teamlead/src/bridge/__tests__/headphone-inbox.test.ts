import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { speakRequestDigest } from "flywheel-voice-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { HeadphoneInboxCollector } from "../headphone-collector.js";
import { HeadphoneQuestionAuthority } from "../headphone-question-authority.js";

const T0 = "2026-09-23T20:00:00.000Z";
const T1 = "2026-09-23T20:00:01.000Z";
let root: string;
let store: StateStore;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "flywheel-headphone-inbox-"));
	store = await StateStore.create(join(root, "teamlead.db"));
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true });
});

function createSession(suffix = "1") {
	const sessionId = `10000000-0000-4000-8000-00000000010${suffix}`;
	const ownerBootId = `resident-${suffix}`;
	const sessionGeneration = Number(suffix);
	const voiceChannelId = `10000000000000000${suffix}`;
	const outputBotUserId = `20000000000000000${suffix}`;
	const claimed = store.reserveAndClaimResidentVoiceSession({
		projectName: "flywheel",
		leadId: "flywheel-eng-lead",
		requestId: `request-${suffix}`,
		inputDigest: `digest-${suffix}`,
		ownerBootId,
		sessionGeneration,
		bindingProof: {
			version: 1,
			projectName: "flywheel",
			guildId: "100000000000000099",
			voiceChannelId,
			ownerBootId,
			sessionGeneration,
			outputBotUserId,
			earsBotUserId: "300000000000000001",
			outputBotDropped: true,
			earsBotDropped: true,
			unknownDropped: true,
			allowedHumanPassed: true,
			observedAt: T0,
			expiresAt: "2026-09-23T20:01:00.000Z",
		},
		leaseTtlMs: 15_000,
		reservation: {
			sessionId,
			mode: "rg",
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			guildId: "100000000000000099",
			voiceChannelId,
			voiceBotUserId: outputBotUserId,
			requestedBy: "master",
			credentialTier: "master",
			createdAt: T0,
		},
	});
	if (!("leaseToken" in claimed)) throw new Error("resident claim failed");
	expect(
		store.setVoiceSessionState({
			sessionId,
			leaseToken: claimed.leaseToken,
			ownerBootId,
			sessionGeneration,
			state: "warming",
			now: T1,
		}),
	).toBe(true);
	return {
		sessionId,
		sessionGeneration,
		leaseToken: claimed.leaseToken,
	};
}

function addItem(overrides: Record<string, unknown> = {}) {
	return store.headphoneInbox.upsert({
		projectName: "flywheel",
		founderUserId: "founder-1",
		channelId: "channel-1",
		sourceMessageId: "message-1",
		sourceRevision: "revision-1",
		authorId: "lead-1",
		needsDecision: false,
		text: "status report",
		sourceCreatedAt: T0,
		...overrides,
	});
}

describe("HeadphoneInboxStore", () => {
	it("keeps one stable snapshot watermark while later messages wait for the next poll", () => {
		const first = addItem({
			sourceMessageId: "message-1",
			needsDecision: true,
			text: "first decision",
		});
		const second = addItem({
			sourceMessageId: "message-2",
			text: "second report",
		});
		const page1 = store.headphoneInbox.snapshot({
			projectName: "flywheel",
			founderUserId: "founder-1",
			limit: 1,
		});
		expect(page1.items.map((item) => item.itemId)).toEqual([first.itemId]);
		expect(page1.nextCursor).toEqual(expect.any(String));
		const later = addItem({
			sourceMessageId: "message-3",
			needsDecision: true,
			text: "later decision",
		});
		const page2 = store.headphoneInbox.snapshot({
			projectName: "flywheel",
			founderUserId: "founder-1",
			limit: 1,
			cursor: page1.nextCursor!,
		});
		expect(page2.snapshotId).toBe(page1.snapshotId);
		expect(page2.highWatermark).toBe(page1.highWatermark);
		expect(page2.items.map((item) => item.itemId)).toEqual([second.itemId]);
		expect(page2.items.map((item) => item.itemId)).not.toContain(later.itemId);
		expect(page2.nextCursor).toBeNull();
	});

	it("keeps off-mode messages, exposes only the newest revision, and sorts decisions first", () => {
		const report = addItem();
		const decision = addItem({
			sourceMessageId: "message-2",
			sourceRevision: "revision-2",
			needsDecision: true,
			text: "choose an option",
			sourceCreatedAt: "2026-09-23T20:00:02.000Z",
		});
		const edited = addItem({
			sourceRevision: "revision-3",
			text: "corrected status report",
		});

		expect(edited).toMatchObject({ itemId: report.itemId, revision: 2 });
		expect(
			store.headphoneInbox.list({
				projectName: "flywheel",
				founderUserId: "founder-1",
				limit: 100,
			}),
		).toEqual([
			expect.objectContaining({ itemId: decision.itemId, needsDecision: true }),
			expect.objectContaining({
				itemId: report.itemId,
				revision: 2,
				text: "corrected status report",
			}),
		]);
	});

	it("coalesces a CommDB question projection with its Discord card and retires resolved authority", () => {
		const projected = addItem({
			questionId: "question-1",
			sourceMessageId: "question-1",
			sourceRevision: "comm:question-1",
			needsDecision: true,
			text: "choose before the card is posted",
		});
		const card = addItem({
			questionId: "question-1",
			channelId: "thread-1",
			sourceMessageId: "100000000000000001",
			sourceRevision: "100000000000000001",
			needsDecision: true,
			text: "founder decision card",
		});

		expect(card).toMatchObject({
			itemId: projected.itemId,
			revision: 2,
			questionId: "question-1",
			needsDecision: true,
		});
		expect(
			store.headphoneInbox.list({
				projectName: "flywheel",
				founderUserId: "founder-1",
				limit: 100,
			}),
		).toEqual([expect.objectContaining({ text: "founder decision card" })]);

		store.headphoneInbox.reconcileQuestionAuthority({
			projectName: "flywheel",
			founderUserId: "founder-1",
			openQuestionIds: [],
		});
		expect(
			store.headphoneInbox.list({
				projectName: "flywheel",
				founderUserId: "founder-1",
				limit: 100,
			}),
		).toEqual([]);
	});

	it("rejects a changed digest under the same source revision", () => {
		addItem();
		expect(() => addItem({ text: "mutated under the same revision" })).toThrow(
			"headphone_inbox_revision_conflict",
		);
	});

	it("prunes expired history while preserving fresh and actively claimed items", () => {
		const expired = addItem({ sourceMessageId: "expired" });
		const claimed = addItem({ sourceMessageId: "claimed" });
		const fresh = addItem({
			sourceMessageId: "fresh",
			sourceCreatedAt: "2026-09-23T20:00:03.000Z",
		});
		const session = createSession();
		expect(
			store.headphoneInbox.claim({
				itemId: claimed.itemId,
				revision: claimed.revision,
				sessionId: session.sessionId,
				generation: session.sessionGeneration,
				leaseToken: session.leaseToken,
				founderUserId: "founder-1",
				now: "2026-09-23T20:00:02.000Z",
			}),
		).toBeDefined();

		expect(
			store.headphoneInbox.pruneOlderThan("2026-09-23T20:00:02.000Z"),
		).toBe(1);
		expect(
			store.headphoneInbox
				.list({
					projectName: "flywheel",
					founderUserId: "founder-1",
					limit: 100,
				})
				.map((item) => item.itemId),
		).toEqual([claimed.itemId, fresh.itemId]);
		expect(
			store.headphoneInbox
				.list({
					projectName: "flywheel",
					founderUserId: "founder-1",
					limit: 100,
				})
				.map((item) => item.itemId),
		).not.toContain(expired.itemId);
	});

	it("fences claims by project, generation, lease, and current claimant", () => {
		const first = createSession("1");
		const second = createSession("2");
		const item = addItem();
		const common = {
			itemId: item.itemId,
			revision: item.revision,
			sessionId: first.sessionId,
			generation: first.sessionGeneration,
			leaseToken: first.leaseToken,
			founderUserId: "founder-1",
			now: "2026-09-23T20:00:02.000Z",
		};

		expect(() =>
			store.headphoneInbox.claim({ ...common, generation: 99 }),
		).toThrow("headphone_inbox_session_unauthorized");
		expect(() =>
			store.headphoneInbox.claim({ ...common, leaseToken: "stale" }),
		).toThrow("headphone_inbox_session_unauthorized");
		const claim = store.headphoneInbox.claim(common);
		expect(claim).toMatchObject({ item });
		expect(store.headphoneInbox.claim(common)?.claimToken).toBe(
			claim?.claimToken,
		);
		expect(
			store.headphoneInbox.claim({
				...common,
				sessionId: second.sessionId,
				generation: second.sessionGeneration,
				leaseToken: second.leaseToken,
			}),
		).toBeUndefined();
		const foreign = addItem({
			projectName: "other",
			sourceMessageId: "message-foreign",
		});
		expect(
			store.headphoneInbox.claim({
				...common,
				itemId: foreign.itemId,
				revision: foreign.revision,
			}),
		).toBeUndefined();
	});

	it("persists the attempt before speech and recomputes the proven receipt before ack", () => {
		const session = createSession();
		const item = addItem();
		const claim = store.headphoneInbox.claim({
			itemId: item.itemId,
			revision: item.revision,
			sessionId: session.sessionId,
			generation: session.sessionGeneration,
			leaseToken: session.leaseToken,
			founderUserId: "founder-1",
			now: "2026-09-23T20:00:02.000Z",
		});
		if (!claim) throw new Error("item claim failed");
		expect(claim).toMatchObject({
			attempt: 1,
			pendingKey: `inbox:${item.itemId}:${item.revision}:${session.sessionId}:${session.sessionGeneration}:1`,
		});
		expect(() =>
			store.headphoneInbox.ack({
				itemId: item.itemId,
				revision: item.revision,
				sessionId: session.sessionId,
				generation: session.sessionGeneration,
				leaseToken: session.leaseToken,
				founderUserId: "founder-1",
				claimToken: claim.claimToken,
				receipts: [],
				ackedAt: "2026-09-23T20:00:03.000Z",
			}),
		).toThrow("headphone_inbox_ack_invalid");
		const pendingKey = `${claim.pendingKey}:0`;
		const requestDigest = speakRequestDigest({
			sessionId: session.sessionId,
			generation: session.sessionGeneration,
			text: item.text,
			kind: "brief",
			verification: "required",
		});
		expect(
			store.headphoneInbox.ack({
				itemId: item.itemId,
				revision: item.revision,
				sessionId: session.sessionId,
				generation: session.sessionGeneration,
				leaseToken: session.leaseToken,
				founderUserId: "founder-1",
				claimToken: claim.claimToken,
				receipts: [
					{
						outcome: "completed",
						pendingKey,
						requestDigest: "f".repeat(64),
						transport: "submitted",
						contentProof: "deterministic_tts",
					},
				],
				ackedAt: "2026-09-23T20:00:03.000Z",
			}),
		).toBe(false);
		expect(
			store.headphoneInbox.ack({
				itemId: item.itemId,
				revision: item.revision,
				sessionId: session.sessionId,
				generation: session.sessionGeneration,
				leaseToken: session.leaseToken,
				founderUserId: "founder-1",
				claimToken: claim.claimToken,
				receipts: [
					{
						outcome: "completed",
						pendingKey,
						requestDigest,
						transport: "submitted",
						contentProof: "deterministic_tts",
					},
				],
				ackedAt: "2026-09-23T20:00:03.000Z",
			}),
		).toBe(true);
		expect(
			store.headphoneInbox.list({
				projectName: "flywheel",
				founderUserId: "founder-1",
				limit: 100,
			}),
		).toEqual([]);
	});
});

describe("HeadphoneInboxCollector", () => {
	it("projects only founder-routed questions and follows CommDB resolution", () => {
		const commDbPath = join(root, "comm.db");
		const db = new CommDB(commDbPath);
		const uncarded = db.insertQuestion("runner-1", "lead-1", "pick one", {
			checkpoint: "founder_review",
		});
		db.insertQuestion("runner-2", "lead-1", "ordinary lead question");
		const cardQuestion = db.insertQuestion(
			"runner-3",
			"lead-1",
			"ship this head?",
			{ checkpoint: "approve_to_ship" },
		);
		const resolved = db.insertQuestion(
			"runner-4",
			"lead-1",
			"already decided",
			{ checkpoint: "founder_review" },
		);
		db.insertResponse(resolved, "lead-1", "done");
		db.close();

		const cardMessageId = "100000000000000001";
		const authority = new HeadphoneQuestionAuthority({
			store: store.headphoneInbox,
			founderUserId: "founder-1",
			projects: [
				{
					projectName: "flywheel",
					leads: [
						{
							agentId: "lead-1",
							chatChannel: "channel-1",
							botUserId: "lead-bot-1",
						},
					],
				},
			],
			openCommDb: () => CommDB.openReadonly(commDbPath),
			questionIdByMessage: (_projectName, messageId) =>
				messageId === cardMessageId ? cardQuestion : undefined,
			botUserIdFromToken: () => null,
		});

		authority.projectQuestions();
		expect(
			store.headphoneInbox
				.list({
					projectName: "flywheel",
					founderUserId: "founder-1",
					limit: 100,
				})
				.map((item) => item.questionId)
				.sort(),
		).toEqual([cardQuestion, uncarded].sort());
		expect(
			authority
				.classifyMessages(
					{
						projectName: "flywheel",
						founderUserId: "founder-1",
						channelId: "channel-1",
						allowedAuthorIds: ["lead-bot-1"],
						token: "secret",
					},
					[
						{
							id: cardMessageId,
							authorId: "lead-bot-1",
							content: "ship card",
							timestamp: T0,
						},
					],
				)
				.get(cardMessageId),
		).toEqual({
			questionId: cardQuestion,
			needsDecision: true,
			resolved: false,
		});

		const writer = new CommDB(commDbPath);
		writer.insertResponse(cardQuestion, "lead-1", "no");
		writer.close();
		expect(
			authority
				.classifyMessages(
					{
						projectName: "flywheel",
						founderUserId: "founder-1",
						channelId: "channel-1",
						allowedAuthorIds: ["lead-bot-1"],
						token: "secret",
					},
					[
						{
							id: cardMessageId,
							authorId: "lead-bot-1",
							content: "ship card",
							timestamp: T0,
						},
					],
				)
				.get(cardMessageId),
		).toEqual({
			questionId: cardQuestion,
			needsDecision: true,
			resolved: true,
		});
		expect(
			new HeadphoneQuestionAuthority({
				store: store.headphoneInbox,
				founderUserId: "founder-1",
				projects: [],
				openCommDb: () => {
					throw new Error("CommDB unavailable");
				},
				questionIdByMessage: () => undefined,
				botUserIdFromToken: () => null,
			}).classifyMessages(
				{
					projectName: "flywheel",
					founderUserId: "founder-1",
					channelId: "channel-1",
					allowedAuthorIds: ["lead-bot-1"],
					token: "secret",
				},
				[
					{
						id: "ordinary-report",
						authorId: "lead-bot-1",
						content: "report",
						timestamp: T0,
					},
				],
			).size,
		).toBe(0);
		authority.projectQuestions();
		expect(
			store.headphoneInbox
				.list({
					projectName: "flywheel",
					founderUserId: "founder-1",
					limit: 100,
				})
				.map((item) => item.questionId),
		).toEqual([uncarded]);
	});

	it("ignores unusable persisted card bindings while classifying the rest", () => {
		const commDbPath = join(root, "comm-classify.db");
		const db = new CommDB(commDbPath);
		const validQuestion = db.insertQuestion(
			"runner-1",
			"lead-1",
			"valid founder question",
			{ checkpoint: "founder_review" },
		);
		db.close();
		const log = vi.fn();
		const authority = new HeadphoneQuestionAuthority({
			store: store.headphoneInbox,
			founderUserId: "founder-1",
			projects: [],
			openCommDb: () => CommDB.openReadonly(commDbPath),
			questionIdByMessage: (_projectName, messageId) => {
				if (messageId === "ambiguous-card") throw new Error("ambiguous");
				if (messageId === "missing-card") return "missing-question";
				return messageId === "valid-card" ? validQuestion : undefined;
			},
			botUserIdFromToken: () => null,
			log,
		});

		const classified = authority.classifyMessages(
			{
				projectName: "flywheel",
				founderUserId: "founder-1",
				channelId: "channel-1",
				allowedAuthorIds: ["lead-bot-1"],
				token: "secret",
			},
			["ambiguous-card", "missing-card", "valid-card"].map((id) => ({
				id,
				authorId: "lead-bot-1",
				content: id,
				timestamp: T0,
			})),
		);

		expect([...classified]).toEqual([
			[
				"valid-card",
				{
					questionId: validQuestion,
					needsDecision: true,
					resolved: false,
				},
			],
		]);
		expect(log).toHaveBeenCalledTimes(2);
	});

	it("continues projection after a bad row without partially reconciling", () => {
		addItem({
			questionId: "previously-open-question",
			sourceMessageId: "previously-open-question",
			sourceRevision: "comm:previously-open-question",
			needsDecision: true,
			text: "keep me open when enumeration is incomplete",
		});
		const commDbPath = join(root, "comm-project.db");
		const db = new CommDB(commDbPath);
		db.insertQuestion("runner-1", "retired-lead", "unroutable question", {
			checkpoint: "founder_review",
		});
		const laterQuestion = db.insertQuestion(
			"runner-2",
			"lead-1",
			"later valid question",
			{ checkpoint: "founder_review" },
		);
		db.close();
		const log = vi.fn();
		const authority = new HeadphoneQuestionAuthority({
			store: store.headphoneInbox,
			founderUserId: "founder-1",
			projects: [
				{
					projectName: "flywheel",
					leads: [
						{
							agentId: "lead-1",
							chatChannel: "channel-1",
							botUserId: "lead-bot-1",
						},
					],
				},
			],
			openCommDb: () => CommDB.openReadonly(commDbPath),
			questionIdByMessage: () => undefined,
			botUserIdFromToken: () => null,
			log,
		});

		authority.projectQuestions();

		expect(
			store.headphoneInbox
				.list({
					projectName: "flywheel",
					founderUserId: "founder-1",
					limit: 100,
				})
				.map((item) => item.questionId)
				.sort(),
		).toEqual([laterQuestion, "previously-open-question"].sort());
		expect(log).toHaveBeenCalledOnce();
	});

	it("applies persisted question authority before ingesting Discord messages", async () => {
		const projectQuestions = vi.fn(() => {
			store.headphoneInbox.upsert({
				projectName: "flywheel",
				founderUserId: "founder-1",
				channelId: "channel-1",
				sourceMessageId: "question-uncarded",
				sourceRevision: "comm:question-uncarded",
				questionId: "question-uncarded",
				authorId: "lead-1",
				needsDecision: true,
				text: "uncarded founder question",
				sourceCreatedAt: T0,
			});
		});
		const collector = new HeadphoneInboxCollector({
			store: store.headphoneInbox,
			listScopes: () => [
				{
					projectName: "flywheel",
					founderUserId: "founder-1",
					channelId: "channel-1",
					allowedAuthorIds: ["lead-1"],
					token: "secret",
				},
			],
			fetchPage: async () => ({
				kind: "page",
				messages: [
					{
						id: "100000000000000001",
						authorId: "lead-1",
						content: "open card",
						timestamp: T0,
					},
					{
						id: "100000000000000002",
						authorId: "lead-1",
						content: "resolved card",
						timestamp: T1,
					},
				],
			}),
			classifyMessages: () =>
				new Map([
					[
						"100000000000000001",
						{
							questionId: "question-open",
							needsDecision: true,
							resolved: false,
						},
					],
					[
						"100000000000000002",
						{
							questionId: "question-resolved",
							needsDecision: false,
							resolved: true,
						},
					],
				]),
			projectQuestions,
		});

		expect(await collector.tick()).toBe("collected");
		expect(projectQuestions).toHaveBeenCalledOnce();
		expect(
			store.headphoneInbox
				.list({
					projectName: "flywheel",
					founderUserId: "founder-1",
					limit: 100,
				})
				.map((item) => [item.questionId, item.needsDecision]),
		).toEqual([
			["question-uncarded", true],
			["question-open", true],
		]);
	});

	it("keeps collecting reports when classification fails", async () => {
		const warning = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const collector = new HeadphoneInboxCollector({
			store: store.headphoneInbox,
			listScopes: () => [
				{
					projectName: "flywheel",
					founderUserId: "founder-1",
					channelId: "channel-1",
					allowedAuthorIds: ["lead-1"],
					token: "secret",
				},
			],
			fetchPage: async () => ({
				kind: "page",
				messages: [
					{
						id: "100000000000000001",
						authorId: "lead-1",
						content: "ordinary report",
						timestamp: T0,
					},
				],
			}),
			classifyMessages: () => {
				throw new Error("bad persisted binding");
			},
		});

		expect(await collector.tick()).toBe("collected");
		expect(
			store.headphoneInbox.list({
				projectName: "flywheel",
				founderUserId: "founder-1",
				limit: 100,
			}),
		).toEqual([expect.objectContaining({ text: "ordinary report" })]);
		expect(warning).toHaveBeenCalledOnce();
		warning.mockRestore();
	});

	it("bootstraps every history page while filtering founder and unconfigured authors", async () => {
		let now = Date.parse(T0);
		const pages = [
			Array.from({ length: 100 }, (_, index) => ({
				id: String(200 - index).padStart(18, "0"),
				authorId: "lead-1",
				content: `report ${200 - index}`,
				timestamp: new Date(now - index).toISOString(),
			})),
			[
				{
					id: "000000000000000100",
					authorId: "founder-1",
					content: "founder echo",
					timestamp: new Date(now - 101).toISOString(),
				},
				{
					id: "000000000000000099",
					authorId: "unknown-bot",
					content: "unknown echo",
					timestamp: new Date(now - 102).toISOString(),
				},
				{
					id: "000000000000000098",
					authorId: "lead-1",
					content:
						"现状：已经准备好了。\n原因：依赖已经齐了。\n下一步：请选一个方案。",
					timestamp: new Date(now - 103).toISOString(),
				},
			],
			[],
		];
		const fetchPage = vi.fn(async () => ({
			kind: "page" as const,
			messages: pages.shift() ?? [],
		}));
		const collector = new HeadphoneInboxCollector({
			store: store.headphoneInbox,
			listScopes: () => [
				{
					projectName: "flywheel",
					founderUserId: "founder-1",
					channelId: "channel-1",
					allowedAuthorIds: ["lead-1"],
					token: "secret",
				},
			],
			fetchPage,
			now: () => now,
			minimumPageIntervalMs: 5_000,
		});

		expect(await collector.tick()).toBe("collected");
		now += 5_000;
		expect(await collector.tick()).toBe("collected");
		now += 5_000;
		expect(await collector.tick()).toBe("collected");
		expect(fetchPage).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ before: "000000000000000101", limit: 100 }),
		);
		const firstPage = store.headphoneInbox.snapshot({
			projectName: "flywheel",
			founderUserId: "founder-1",
			limit: 100,
		});
		const secondPage = store.headphoneInbox.snapshot({
			projectName: "flywheel",
			founderUserId: "founder-1",
			limit: 100,
			cursor: firstPage.nextCursor!,
		});
		const items = [...firstPage.items, ...secondPage.items];
		expect(items).toHaveLength(101);
		expect(
			items.find((item) => item.sourceMessageId === "000000000000000098"),
		).toMatchObject({
			speechBrief: {
				what: "已经准备好了。",
				why: "依赖已经齐了。",
				next: "请选一个方案。",
			},
		});
		expect(
			store.headphoneInbox.getSourceState("flywheel", "founder-1", "channel-1"),
		).toMatchObject({ bootstrapComplete: true, health: "healthy" });
	});

	it("does not advance a cursor on rate limit and distinguishes a source gap", async () => {
		let now = Date.parse(T0);
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce({ kind: "rate_limited", retryAfterMs: 9_000 })
			.mockResolvedValueOnce({ kind: "source_gap", reason: "forbidden" });
		const collector = new HeadphoneInboxCollector({
			store: store.headphoneInbox,
			listScopes: () => [
				{
					projectName: "flywheel",
					founderUserId: "founder-1",
					channelId: "channel-1",
					allowedAuthorIds: ["lead-1"],
					token: "secret",
				},
			],
			fetchPage,
			now: () => now,
			minimumPageIntervalMs: 5_000,
		});

		expect(await collector.tick()).toBe("rate_limited");
		expect(await collector.tick()).toBe("waiting");
		expect(
			store.headphoneInbox.getSourceState("flywheel", "founder-1", "channel-1"),
		).toMatchObject({ cursor: null, health: "rate_limited" });
		now += 9_000;
		expect(await collector.tick()).toBe("source_gap");
		expect(
			store.headphoneInbox.getSourceState("flywheel", "founder-1", "channel-1"),
		).toMatchObject({ cursor: null, health: "source_gap" });
	});

	it("keeps a shared token cooling down across collector restart and scopes", async () => {
		const now = Date.parse(T0);
		const scopes = ["channel-1", "channel-2"].map((channelId) => ({
			projectName: "flywheel",
			founderUserId: "founder-1",
			channelId,
			allowedAuthorIds: ["lead-1"],
			token: "shared-secret",
		}));
		const fetchPage = vi.fn(async () => ({
			kind: "rate_limited" as const,
			retryAfterMs: 9_000,
		}));
		const first = new HeadphoneInboxCollector({
			store: store.headphoneInbox,
			listScopes: () => scopes,
			fetchPage,
			now: () => now,
		});
		expect(await first.tick()).toBe("rate_limited");

		const restarted = new HeadphoneInboxCollector({
			store: store.headphoneInbox,
			listScopes: () => scopes,
			fetchPage,
			now: () => now,
		});
		expect(await restarted.tick()).toBe("waiting");
		expect(fetchPage).toHaveBeenCalledOnce();
	});
});

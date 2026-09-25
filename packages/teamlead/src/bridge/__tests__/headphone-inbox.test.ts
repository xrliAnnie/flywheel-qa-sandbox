import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { speakRequestDigest, splitSpeechText } from "flywheel-voice-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	type HeadphoneCollectorMessage,
	type HeadphoneCollectorOptions,
	HeadphoneInboxCollector,
} from "../headphone-collector.js";
import { HeadphoneInboxStore } from "../headphone-inbox.js";
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

function createSession(suffix = "1", leaseTtlMs = 15_000) {
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
		leaseTtlMs,
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

/** Discord channel history that honors `before` / `after` paging, newest first.
 * Message `n` is stamped `T0 + n × spacingMs`. */
function fakeDiscordHistory(
	channelSizes: Record<string, number>,
	{ spacingMs = 1 }: { spacingMs?: number } = {},
) {
	const history = new Map<string, HeadphoneCollectorMessage[]>(
		Object.keys(channelSizes).map((channelId) => [channelId, []]),
	);
	let seq = 0n;
	const post = (channelId: string, content: string) => {
		seq += 1n;
		const message: HeadphoneCollectorMessage = {
			id: String(100_000_000_000_000_000n + seq),
			authorId: "lead-1",
			content,
			timestamp: new Date(
				Date.parse(T0) + Number(seq) * spacingMs,
			).toISOString(),
		};
		history.get(channelId)?.push(message);
		return message;
	};
	for (const [channelId, size] of Object.entries(channelSizes))
		for (let index = 0; index < size; index++)
			post(channelId, `${channelId} report ${index}`);
	const pulls = new Map<string, number>();
	const fetchPage: HeadphoneCollectorOptions["fetchPage"] = async ({
		scope,
		before,
		after,
		limit,
	}) => {
		pulls.set(scope.channelId, (pulls.get(scope.channelId) ?? 0) + 1);
		const all = history.get(scope.channelId) ?? [];
		const page = after
			? all
					.filter((message) => BigInt(message.id) > BigInt(after))
					.slice(0, limit)
			: all
					.filter((message) => !before || BigInt(message.id) < BigInt(before))
					.slice(-limit);
		return { kind: "page", messages: [...page].reverse() };
	};
	/** Just after the newest message posted so far. */
	const nowAfterHistory = () => Date.parse(T0) + (Number(seq) + 1) * spacingMs;
	return { fetchPage, pulls, post, nowAfterHistory };
}

function collectedMessageIds(channelId: string): Set<string> {
	const ids = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = store.headphoneInbox.snapshot({
			projectName: "flywheel",
			founderUserId: "founder-1",
			limit: 100,
			...(cursor ? { cursor } : {}),
		});
		for (const item of page.items)
			if (item.channelId === channelId) ids.add(item.sourceMessageId);
		cursor = page.nextCursor ?? undefined;
	} while (cursor);
	return ids;
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

	it("keeps an 800-character claim valid until long deterministic speech is acknowledged", () => {
		const session = createSession("1", 300_000);
		const item = addItem({ text: "长".repeat(800) });
		const claimedAt = "2026-09-23T20:00:02.000Z";
		const claim = store.headphoneInbox.claim({
			itemId: item.itemId,
			revision: item.revision,
			sessionId: session.sessionId,
			generation: session.sessionGeneration,
			leaseToken: session.leaseToken,
			founderUserId: "founder-1",
			now: claimedAt,
		});
		if (!claim) throw new Error("item claim failed");
		expect(
			Date.parse(claim.leaseExpiresAt) - Date.parse(claimedAt),
		).toBeGreaterThan(150_000);
		const chunks = splitSpeechText(item.text, 500);
		const receipts = chunks.map((text, index) => ({
			outcome: "completed" as const,
			pendingKey: `${claim.pendingKey}:${index}`,
			requestDigest: speakRequestDigest({
				sessionId: session.sessionId,
				generation: session.sessionGeneration,
				text,
				kind: "brief",
				verification: "required",
			}),
			transport: "submitted" as const,
			contentProof: "deterministic_tts" as const,
		}));

		expect(
			store.headphoneInbox.ack({
				itemId: item.itemId,
				revision: item.revision,
				sessionId: session.sessionId,
				generation: session.sessionGeneration,
				leaseToken: session.leaseToken,
				founderUserId: "founder-1",
				claimToken: claim.claimToken,
				receipts,
				ackedAt: "2026-09-23T20:02:32.000Z",
			}),
		).toBe(true);
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

	// FLY-2863 QA@2 B5: a finished thread source must not starve a Lead main
	// channel that is still backfilling behind the same shared-token throttle.
	const MAIN_CHANNEL = "100000000000000010";
	const threadChannel = (index: number) =>
		String(100000000000000020n + BigInt(index));
	const sharedTokenScope = (channelId: string) => ({
		projectName: "flywheel",
		founderUserId: "founder-1",
		channelId,
		allowedAuthorIds: ["lead-1"],
		leadAuthorIds: ["lead-1"],
		token: "shared-secret",
	});

	it("finishes a 500-message main-channel backfill beside a finished thread within 60 ticks", async () => {
		let now = Date.parse(T0);
		const discord = fakeDiscordHistory({
			[MAIN_CHANNEL]: 500,
			[threadChannel(0)]: 2,
		});
		const collector = new HeadphoneInboxCollector({
			store: store.headphoneInbox,
			listScopes: () => [MAIN_CHANNEL, threadChannel(0)].map(sharedTokenScope),
			fetchPage: discord.fetchPage,
			now: () => now,
			minimumPageIntervalMs: 5_000,
		});

		expect(await collector.tick()).toBe("collected");
		now += 1_000;
		// The shared-token throttle still holds: one page per 5 s across sources.
		expect(await collector.tick()).toBe("waiting");
		now += 4_000;
		for (let tick = 1; tick < 60; tick++) {
			expect(await collector.tick()).toBe("collected");
			now += 5_000;
		}

		expect(
			[...discord.pulls.values()].reduce((sum, count) => sum + count, 0),
		).toBe(60);
		expect(
			store.headphoneInbox.getSourceState(
				"flywheel",
				"founder-1",
				MAIN_CHANNEL,
			),
		).toMatchObject({ bootstrapComplete: true, health: "healthy" });
		expect(discord.pulls.get(MAIN_CHANNEL)).toBeGreaterThanOrEqual(6);
		expect(discord.pulls.get(threadChannel(0))).toBeGreaterThanOrEqual(1);
		expect(collectedMessageIds(MAIN_CHANNEL).size).toBe(500);
	});

	it("reaches every thread source and a live Lead main-channel message while threads exist", async () => {
		let now = Date.parse(T0);
		const threads = Array.from({ length: 8 }, (_, index) =>
			threadChannel(index),
		);
		const discord = fakeDiscordHistory({
			[MAIN_CHANNEL]: 500,
			...Object.fromEntries(threads.map((channelId) => [channelId, 2])),
		});
		const marks: unknown[] = [];
		const collector = new HeadphoneInboxCollector({
			store: store.headphoneInbox,
			listScopes: () => [MAIN_CHANNEL, ...threads].map(sharedTokenScope),
			fetchPage: discord.fetchPage,
			recordUrgent: (mark) => marks.push(mark),
			now: () => now,
			minimumPageIntervalMs: 5_000,
		});

		let live: HeadphoneCollectorMessage | undefined;
		for (let tick = 0; tick < 60; tick++) {
			expect(await collector.tick()).toBe("collected");
			now += 5_000;
			if (
				!live &&
				store.headphoneInbox.getSourceState(
					"flywheel",
					"founder-1",
					MAIN_CHANNEL,
				)?.bootstrapComplete
			)
				live = discord.post(
					MAIN_CHANNEL,
					"🚨[urgent:production_down] 生产挂了，要你拍",
				);
		}

		expect(live).toBeDefined();
		for (const channelId of threads) {
			expect(discord.pulls.get(channelId)).toBeGreaterThanOrEqual(1);
			expect(
				store.headphoneInbox.getSourceState("flywheel", "founder-1", channelId),
			).toMatchObject({ bootstrapComplete: true });
		}
		expect(collectedMessageIds(MAIN_CHANNEL)).toContain(live?.id);
		expect(marks).toEqual([
			expect.objectContaining({
				channelId: MAIN_CHANNEL,
				messageId: live?.id,
				reason: "production_down",
			}),
		]);
	});

	// FLY-2863 QA@3 F1: a backfill only pages backwards, so new messages wait
	// for it to finish. It must be bounded (time window, then a page cap).
	async function backfillMainBesideThreads(input: {
		spacingMs: number;
		collectorOptions?: Record<string, unknown>;
	}) {
		const threads = Array.from({ length: 8 }, (_, index) =>
			threadChannel(index),
		);
		const discord = fakeDiscordHistory(
			{
				[MAIN_CHANNEL]: 5000,
				...Object.fromEntries(threads.map((channelId) => [channelId, 2])),
			},
			{ spacingMs: input.spacingMs },
		);
		let now = discord.nowAfterHistory();
		const collector = new HeadphoneInboxCollector({
			store: store.headphoneInbox,
			listScopes: () => [MAIN_CHANNEL, ...threads].map(sharedTokenScope),
			fetchPage: discord.fetchPage,
			now: () => now,
			minimumPageIntervalMs: 5_000,
			...input.collectorOptions,
		});
		const mainState = () =>
			store.headphoneInbox.getSourceState(
				"flywheel",
				"founder-1",
				MAIN_CHANNEL,
			);
		for (let tick = 0; tick < 120 && !mainState()?.bootstrapComplete; tick++) {
			expect(await collector.tick()).toBe("collected");
			now += 5_000;
		}
		const backfill = {
			state: mainState(),
			pulls: discord.pulls.get(MAIN_CHANNEL) ?? 0,
		};
		const live = discord.post(MAIN_CHANNEL, "FLY-9110 上线时间想跟你对一下");
		// One rotation: each of the 9 sources is pulled once.
		for (let tick = 0; tick < 9; tick++) {
			expect(await collector.tick()).toBe("collected");
			now += 5_000;
		}
		return { backfill, live, discord, threads };
	}

	it("caps a 5000-message main-channel backfill beside 8 threads and reads a new message within one rotation", async () => {
		// Every message is inside the window, so the page cap (default 10) ends it.
		const { backfill, live, discord, threads } =
			await backfillMainBesideThreads({ spacingMs: 1 });

		expect(backfill.state).toMatchObject({
			bootstrapComplete: true,
			bootstrapPages: 10,
		});
		expect(backfill.pulls).toBe(10);
		const main = collectedMessageIds(MAIN_CHANNEL);
		expect(main).toContain(live.id);
		expect(main.size).toBe(10 * 100 + 1);
		for (const channelId of threads)
			expect(discord.pulls.get(channelId)).toBeGreaterThanOrEqual(1);
	});

	it("stops a backfill at the default 24 h window and reads a new message within one rotation", async () => {
		// 5 minutes apart: a page spans 8 h 20 m, so page 3 reaches past 24 h.
		const { backfill, live } = await backfillMainBesideThreads({
			spacingMs: 300_000,
		});

		expect(backfill.state).toMatchObject({
			bootstrapComplete: true,
			bootstrapPages: 3,
		});
		expect(backfill.pulls).toBe(3);
		expect(collectedMessageIds(MAIN_CHANNEL)).toContain(live.id);
	});

	it("honors a configured backfill window", async () => {
		const { backfill, live } = await backfillMainBesideThreads({
			spacingMs: 300_000,
			collectorOptions: { bootstrapWindowMs: 10 * 3_600_000 },
		});

		expect(backfill.state).toMatchObject({
			bootstrapComplete: true,
			bootstrapPages: 2,
		});
		expect(collectedMessageIds(MAIN_CHANNEL)).toContain(live.id);
	});

	it("keeps the backfill page count across a collector restart", async () => {
		const discord = fakeDiscordHistory({ [MAIN_CHANNEL]: 1000 });
		let now = discord.nowAfterHistory();
		const options = {
			store: store.headphoneInbox,
			listScopes: () => [sharedTokenScope(MAIN_CHANNEL)],
			fetchPage: discord.fetchPage,
			now: () => now,
			minimumPageIntervalMs: 5_000,
			bootstrapMaxPages: 3,
		};
		const mainState = () =>
			store.headphoneInbox.getSourceState(
				"flywheel",
				"founder-1",
				MAIN_CHANNEL,
			);
		const first = new HeadphoneInboxCollector(options);
		for (let tick = 0; tick < 2; tick++) {
			expect(await first.tick()).toBe("collected");
			now += 5_000;
		}
		expect(mainState()).toMatchObject({
			bootstrapComplete: false,
			bootstrapPages: 2,
		});

		const restarted = new HeadphoneInboxCollector(options);
		expect(await restarted.tick()).toBe("collected");
		expect(mainState()).toMatchObject({
			bootstrapComplete: true,
			bootstrapPages: 3,
		});
		expect(discord.pulls.get(MAIN_CHANNEL)).toBe(3);
	});

	it("refuses a backfill bound that is not a positive integer", () => {
		const base = {
			store: store.headphoneInbox,
			listScopes: () => [],
			fetchPage: async () => ({ kind: "page" as const, messages: [] }),
		};
		for (const bad of [
			{ bootstrapWindowMs: 0 },
			{ bootstrapWindowMs: 1.5 },
			{ bootstrapMaxPages: 0 },
			{ bootstrapMaxPages: Number.NaN },
		])
			expect(() => new HeadphoneInboxCollector({ ...base, ...bad })).toThrow(
				/headphone_bootstrap_bound_invalid/,
			);
	});
});

describe("HeadphoneInboxStore — backfill page count migration", () => {
	it("adds the page count to a pre-FLY-2863 source table and keeps it when a write omits it", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`CREATE TABLE voice_headphone_source (
				project_name TEXT NOT NULL,
				founder_user_id TEXT NOT NULL,
				channel_id TEXT NOT NULL,
				cursor TEXT,
				high_watermark TEXT,
				bootstrap_complete INTEGER NOT NULL DEFAULT 0 CHECK(bootstrap_complete IN (0,1)),
				health TEXT NOT NULL DEFAULT 'recovering' CHECK(health IN ('healthy','recovering','rate_limited','source_gap')),
				health_reason TEXT,
				next_allowed_at TEXT,
				updated_at TEXT NOT NULL,
				PRIMARY KEY(project_name, founder_user_id, channel_id)
			)`);
			db.prepare(
				`INSERT INTO voice_headphone_source
				 (project_name, founder_user_id, channel_id, cursor, bootstrap_complete, health, updated_at)
				 VALUES ('flywheel', 'founder-1', 'legacy-channel', '100000000000000005', 0, 'healthy', ?)`,
			).run(T0);
			const inbox = new HeadphoneInboxStore(db);
			inbox.migrate();

			expect(
				inbox.getSourceState("flywheel", "founder-1", "legacy-channel"),
			).toMatchObject({
				cursor: "100000000000000005",
				bootstrapComplete: false,
				bootstrapPages: 0,
			});
			const write = (bootstrapPages?: number) =>
				inbox.setSourceState({
					projectName: "flywheel",
					founderUserId: "founder-1",
					channelId: "legacy-channel",
					cursor: "100000000000000004",
					bootstrapComplete: false,
					health: "healthy",
					updatedAt: T1,
					...(bootstrapPages === undefined ? {} : { bootstrapPages }),
				});
			write(4);
			write();
			expect(
				inbox.getSourceState("flywheel", "founder-1", "legacy-channel")
					?.bootstrapPages,
			).toBe(4);
		} finally {
			db.close();
		}
	});
});

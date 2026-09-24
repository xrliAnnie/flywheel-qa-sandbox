import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { HeadphoneInboxCollector } from "../headphone-collector.js";

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

	it("requires durable request digests before acknowledgement removes an item", () => {
		const session = createSession();
		const item = addItem();
		const claim = store.headphoneInbox.claim({
			itemId: item.itemId,
			revision: item.revision,
			sessionId: session.sessionId,
			generation: session.sessionGeneration,
			leaseToken: session.leaseToken,
			now: "2026-09-23T20:00:02.000Z",
		});
		if (!claim) throw new Error("item claim failed");
		expect(() =>
			store.headphoneInbox.ack({
				itemId: item.itemId,
				revision: item.revision,
				sessionId: session.sessionId,
				generation: session.sessionGeneration,
				claimToken: claim.claimToken,
				requestDigests: [],
				ackedAt: "2026-09-23T20:00:03.000Z",
			}),
		).toThrow("headphone_inbox_ack_invalid");
		expect(
			store.headphoneInbox.ack({
				itemId: item.itemId,
				revision: item.revision,
				sessionId: session.sessionId,
				generation: session.sessionGeneration,
				claimToken: claim.claimToken,
				requestDigests: ["a".repeat(64), "b".repeat(64)],
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
		const items = store.headphoneInbox.list({
			projectName: "flywheel",
			founderUserId: "founder-1",
			limit: 100,
		});
		expect(items).toHaveLength(100);
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
});

/**
 * FLY-2863 plan §2 — the voice agenda reads the same judgments the thread
 * titles render and never replays inbox history. Real in-memory StateStore;
 * the CommDB question reader and the park probe are stubbed at their seams.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { classifyHeadphoneOrigin } from "../headphone-collector.js";
import { readIssueTitleState } from "../issue-title-state.js";
import {
	buildVoiceAgendaSnapshot,
	VoiceAgendaPriorityCache,
	type VoiceAgendaSession,
	type VoiceAgendaSourceDeps,
} from "../voice-agenda-source.js";

const PROJECT = "proj";
const FOUNDER = "300000000000000001";
const LEAD_CH = "100000000000000001";
const OTHER_CH = "100000000000000002";
const LEAD_BOT = "200000000000000001";
const OTHER_BOT = "200000000000000002";
const T0 = Date.parse("2026-09-24T12:00:00.000Z");

let store: StateStore;
let seq = 0;

function projects(): ProjectEntry[] {
	return [
		{
			projectName: PROJECT,
			projectRoot: "/tmp/proj",
			leads: [
				{
					agentId: "lead-one",
					chatChannel: LEAD_CH,
					botUserId: LEAD_BOT,
					match: { labels: [] },
				},
				{
					agentId: "lead-two",
					chatChannel: OTHER_CH,
					botUserId: OTHER_BOT,
					match: { labels: [] },
				},
			],
		} as unknown as ProjectEntry,
	];
}

function session(mode: "rg" | "meeting" = "rg"): VoiceAgendaSession {
	return {
		sessionId: "10000000-0000-4000-8000-000000000001",
		mode,
		projectName: PROJECT,
		leadId: "lead-one",
		founderUserId: FOUNDER,
	};
}

function deps(
	now: number,
	extra: Partial<VoiceAgendaSourceDeps> = {},
): VoiceAgendaSourceDeps {
	return {
		store,
		agenda: store.voiceAgenda,
		inbox: store.headphoneInbox,
		projects: projects(),
		guildId: "900000000000000001",
		openAttentionCommReadonly: () => ({
			listAttentionQuestions: () => ({
				questions: [],
				rawCount: 0,
				nextCursor: null,
			}),
			isQuestionPending: () => true,
			close: () => {},
		}),
		readTitle: (input) =>
			readIssueTitleState({ ...input, parkFor: () => "not_parked" }),
		now: () => new Date(now),
		...extra,
	};
}

function issueSession(
	issue: string,
	channel: string,
	status: string,
	stage?: string,
): void {
	seq += 1;
	store.upsertChatThread(`thread-${issue}`, channel, issue, "lead-one");
	store.upsertSession({
		execution_id: `exec-${issue}-${seq}`,
		issue_id: issue,
		project_name: PROJECT,
		status,
		issue_identifier: `FLY-${issue}`,
		issue_title: `title ${issue}`,
		last_activity_at: `2026-09-24 10:00:${String(seq).padStart(2, "0")}`,
		chat_thread_role: "main",
		session_role: "main",
	});
	if (stage)
		store.patchSessionMetadata(`exec-${issue}-${seq}`, {
			session_stage: stage,
		});
}

function said(
	id: string,
	at: number,
	options: {
		channel?: string;
		author?: string;
		text?: string;
	} = {},
): void {
	const channel = options.channel ?? LEAD_CH;
	const author = options.author ?? LEAD_BOT;
	const text = options.text ?? `lead message ${id}`;
	store.headphoneInbox.upsert({
		projectName: PROJECT,
		founderUserId: FOUNDER,
		channelId: channel,
		sourceMessageId: id,
		sourceRevision: id,
		authorId: author,
		needsDecision: false,
		text,
		sourceCreatedAt: new Date(at).toISOString(),
		originClass: classifyHeadphoneOrigin(
			{ founderUserId: FOUNDER, leadAuthorIds: [LEAD_BOT, OTHER_BOT] },
			{ authorId: author, content: text },
		),
	});
}

function source(channel: string, updatedAt: number, founderAt?: number): void {
	store.headphoneInbox.setSourceState({
		projectName: PROJECT,
		founderUserId: FOUNDER,
		channelId: channel,
		bootstrapComplete: true,
		health: "healthy",
		updatedAt: new Date(updatedAt).toISOString(),
		...(founderAt
			? { founderLastMessageAt: new Date(founderAt).toISOString() }
			: {}),
	});
}

beforeEach(async () => {
	seq = 0;
	store = await StateStore.create(":memory:");
	// The baseline is written when the agenda first ships; pin it before T0.
	store.voiceAgenda.migrate();
	(
		store as unknown as { db: { raw: import("better-sqlite3").Database } }
	).db.raw
		.prepare(
			"UPDATE voice_agenda_meta SET value = ? WHERE key = 'leadSaidBaselineAt'",
		)
		.run(new Date(T0 - 48 * 3_600_000).toISOString());
});
afterEach(() => store.close());

describe("buildVoiceAgendaSnapshot — title classes (same judgment as the thread title)", () => {
	it("admits 受阻 / 待批 / 要你答 and nothing in progress", () => {
		issueSession("a", LEAD_CH, "failed");
		issueSession("b", LEAD_CH, "running", "approve");
		issueSession("d", LEAD_CH, "running", "implement");
		issueSession("e", LEAD_CH, "running", "qa");
		store.upsertChatThread("thread-c", LEAD_CH, "c", "lead-one");
		store.insertFounderAsk({
			ask_id: "ask-c",
			project_name: PROJECT,
			issue_id: "c",
			channel_id: LEAD_CH,
			thread_id: "thread-c",
			lead_id: "lead-one",
			question_id: null,
			excerpt: "要你答",
			asked_at: new Date(T0).toISOString(),
		});
		store.backfillFounderAskMessage("ask-c", "500000000000000001");
		const snapshot = buildVoiceAgendaSnapshot(deps(T0), session());
		const byIssue = Object.fromEntries(
			snapshot.items.map((item) => [item.itemKey.split(":")[1], item.class]),
		);
		expect(byIssue).toEqual({
			a: "blocked",
			b: "awaiting_approval",
			c: "needs_answer",
		});
		const blocked = snapshot.items.find((item) => item.class === "blocked")!;
		expect(blocked).toMatchObject({
			issueIdentifier: "FLY-a",
			issueTitle: "title a",
			threadUrl: "https://discord.com/channels/900000000000000001/thread-a",
			leadId: "lead-one",
			sourceKey: `titles:${PROJECT}`,
			urgent: null,
		});
		expect(snapshot.sourceStatus[`titles:${PROJECT}`]?.status).toBe("complete");
	});

	it("keeps an item's key across reads and mints a new one on re-entry", () => {
		issueSession("b", LEAD_CH, "running", "approve");
		const first = buildVoiceAgendaSnapshot(deps(T0), session()).items[0]!;
		const again = buildVoiceAgendaSnapshot(deps(T0 + 60_000), session())
			.items[0]!;
		expect(again.itemKey).toBe(first.itemKey);
		store.patchSessionMetadata(`exec-b-1`, { session_stage: "implement" });
		expect(
			buildVoiceAgendaSnapshot(deps(T0 + 120_000), session()).items,
		).toEqual([]);
		store.patchSessionMetadata(`exec-b-1`, { session_stage: "approve" });
		const reentered = buildVoiceAgendaSnapshot(deps(T0 + 180_000), session())
			.items[0]!;
		expect(reentered.itemKey).not.toBe(first.itemKey);
	});

	it("an Urgent-priority blocked issue is U2 urgent; anything else is not", () => {
		issueSession("a", LEAD_CH, "failed");
		issueSession("b", LEAD_CH, "running", "approve");
		const cache = new Map([
			["a", 1],
			["b", 1],
		]);
		const snapshot = buildVoiceAgendaSnapshot(
			deps(T0, { issuePriority: (id) => cache.get(id) ?? null }),
			session(),
		);
		expect(
			snapshot.items.map((item) => [item.class, item.urgent?.source ?? null]),
		).toEqual([
			["blocked", "priority_urgent_blocked"],
			["awaiting_approval", null],
		]);
	});

	it("reports the title source unavailable instead of an empty agenda", () => {
		issueSession("a", LEAD_CH, "failed");
		const snapshot = buildVoiceAgendaSnapshot(
			deps(T0, {
				openAttentionCommReadonly: () => {
					throw new Error("comm down");
				},
			}),
			session(),
		);
		expect(snapshot.sourceStatus[`titles:${PROJECT}`]?.status).toBe(
			"unavailable",
		);
		expect(snapshot.complete).toBe(false);
	});
});

describe("buildVoiceAgendaSnapshot — Lead said (plan §2.2: no history replay)", () => {
	it("speaks only Lead-authored main-channel messages inside the window", () => {
		source(LEAD_CH, T0 - 1_000);
		said("600000000000000001", T0 - 60_000);
		said("600000000000000002", T0 - 30_000, {
			text: "🤖[自动] 进度：PR 已开",
		});
		said("600000000000000003", T0 - 20_000, { text: "📻 语音状态" });
		said("600000000000000004", T0 - 10_000, {
			author: "999999999999999999",
			text: "someone else",
		});
		const snapshot = buildVoiceAgendaSnapshot(deps(T0), session());
		expect(snapshot.items).toEqual([
			expect.objectContaining({
				itemKey: `said:${LEAD_CH}:600000000000000001:1`,
				class: "lead_said",
				sourceText: "lead message 600000000000000001",
				pointers: { messageIds: ["600000000000000001"] },
				sourceKey: `inbox:${PROJECT}:${LEAD_CH}`,
			}),
		]);
		expect(snapshot.sourceStatus[`inbox:${PROJECT}:${LEAD_CH}`]?.status).toBe(
			"complete",
		);
	});

	it("a backlog of 335 only yields what is after the baseline and in the window", () => {
		const baseline = T0 - 48 * 3_600_000;
		for (let index = 0; index < 330; index++)
			said(`7${String(index).padStart(17, "0")}`, baseline - 1_000 - index);
		for (let index = 0; index < 3; index++)
			said(`8${String(index).padStart(17, "0")}`, baseline + 1_000 + index);
		said("900000000000000001", T0 - 3_000);
		said("900000000000000002", T0 - 2_000);
		source(LEAD_CH, T0 - 1_000);
		const snapshot = buildVoiceAgendaSnapshot(deps(T0), session());
		expect(snapshot.items.map((item) => item.pointers.messageIds[0])).toEqual([
			"900000000000000001",
			"900000000000000002",
		]);
		// Outside the 24h window but after the baseline: counted, never read.
		expect(snapshot.olderUnspokenCount).toBe(3);
	});

	it("drops what the founder already answered in the same channel", () => {
		said("600000000000000001", T0 - 60_000);
		said("600000000000000002", T0 - 10_000);
		source(LEAD_CH, T0 - 1_000, T0 - 30_000);
		const snapshot = buildVoiceAgendaSnapshot(deps(T0), session());
		expect(snapshot.items.map((item) => item.pointers.messageIds[0])).toEqual([
			"600000000000000002",
		]);
	});

	it("never speaks a resolved Lead message again", () => {
		said("600000000000000001", T0 - 60_000);
		source(LEAD_CH, T0 - 1_000);
		const key = `said:${LEAD_CH}:600000000000000001:1`;
		store.voiceAgenda.recordServedItems(
			session().sessionId,
			buildVoiceAgendaSnapshot(deps(T0), session()).items,
			new Date(T0).toISOString(),
		);
		const state = {
			version: 1 as const,
			sessionId: session().sessionId,
			generation: 1,
			stateVersion: 1,
			opened: true,
			queue: [],
			active: null,
			urgentQueue: [],
			activeUrgent: null,
			items: {},
			outstanding: null,
			applied: {},
			lastActivityAt: new Date(T0).toISOString(),
		};
		store.voiceAgenda.saveState({
			state,
			expectedVersion: 0,
			dispositions: [
				{
					itemKey: key,
					disposition: "resolved",
					evidence: "msg:1",
					reason: "done",
					requestId: "r1",
					createdAt: new Date(T0).toISOString(),
				},
			],
			now: new Date(T0).toISOString(),
		});
		expect(buildVoiceAgendaSnapshot(deps(T0), session()).items).toEqual([]);
	});

	it("marks a stale inbox source partial and a flagged message urgent (U1)", () => {
		said("600000000000000001", T0 - 60_000);
		source(LEAD_CH, T0 - 5 * 60_000);
		store.voiceAgenda.recordUrgent({
			projectName: PROJECT,
			channelId: LEAD_CH,
			messageId: "600000000000000001",
			leadId: "lead-one",
			reason: "production_down",
			now: new Date(T0).toISOString(),
		});
		const snapshot = buildVoiceAgendaSnapshot(deps(T0), session());
		expect(snapshot.items[0]?.urgent).toEqual({
			source: "lead_flag",
			reason: "production_down",
		});
		expect(snapshot.sourceStatus[`inbox:${PROJECT}:${LEAD_CH}`]).toMatchObject({
			status: "partial",
			reason: "stale",
		});
	});

	it("a meeting sees only its own Lead; headphone sees every Lead", () => {
		said("600000000000000001", T0 - 60_000);
		said("600000000000000002", T0 - 50_000, {
			channel: OTHER_CH,
			author: OTHER_BOT,
		});
		issueSession("z", OTHER_CH, "failed");
		const meeting = buildVoiceAgendaSnapshot(deps(T0), session("meeting"));
		expect(meeting.items.map((item) => item.leadId)).toEqual(["lead-one"]);
		const headphone = buildVoiceAgendaSnapshot(deps(T0), session("rg"));
		expect(new Set(headphone.items.map((item) => item.leadId))).toEqual(
			new Set(["lead-one", "lead-two"]),
		);
	});
});

describe("VoiceAgendaPriorityCache", () => {
	it("learns priorities asynchronously and never blocks the read", async () => {
		const calls: string[] = [];
		const cache = new VoiceAgendaPriorityCache({
			fetchPriority: async (id) => {
				calls.push(id);
				return 1;
			},
			now: () => 0,
		});
		expect(cache.get("a")).toBeNull();
		cache.observe(["a", "a"]);
		await new Promise((resolve) => setImmediate(resolve));
		expect(cache.get("a")).toBe(1);
		cache.observe(["a"]);
		expect(calls).toEqual(["a"]);
	});
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	recordVoiceBackgroundSnapshot,
	recordVoiceOutboundDiscordPage,
	voiceBackgroundBriefKeys,
} from "../voice-session-poller.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const T0 = "2026-09-08T20:00:00.000Z";
const CHANNEL = "100000000000000004";
const LEAD_BOT = "100000000000000005";
const ROOT = "100000000000000011";
let store: StateStore;
let root: string;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "flywheel-voice-poller-"));
	store = await StateStore.create(join(root, "teamlead.db"));
	store.reserveVoiceSession({
		sessionId: SESSION_ID,
		mode: "meeting",
		projectName: "flywheel",
		leadId: "lead-a",
		guildId: "100000000000000001",
		voiceBotUserId: "100000000000000005",
		voiceChannelId: "100000000000000002",
		requestedBy: "master",
		credentialTier: "master",
		createdAt: T0,
	});
	store.updateVoiceProvisioning({
		sessionId: SESSION_ID,
		expectedStep: "reserved",
		nextStep: "done",
		nextState: "desired",
		rootMessageId: ROOT,
		threadId: ROOT,
		boundChannelIds: [CHANNEL],
		outboundCursor: { [CHANNEL]: "100000000000000010" },
		updatedAt: T0,
	});
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true });
});

function claim() {
	return store.claimVoiceSession({
		sessionId: SESSION_ID,
		daemonBootId: "boot-a",
		now: T0,
		leaseTtlMs: 15_000,
	})!;
}

describe("voice outbound Discord poller", () => {
	it("produces background events only for enabled Engine B and keeps tell separate from context", () => {
		const leaseToken = claim().leaseToken;
		const snapshot = {
			sessions: [
				{
					executionId: "exec-brief",
					issue: "FLY-100",
					status: "running",
					observedAt: T0,
				},
				{
					executionId: "exec-complete",
					issue: "FLY-2886",
					status: "completed",
					observedAt: "2026-09-08T20:00:01.000Z",
				},
				{
					executionId: "exec-failed",
					issue: "FLY-2799",
					status: "failed",
					lastError: "provider failed for PR #1306",
					observedAt: "2026-09-08T20:00:02.000Z",
				},
			],
			attention: [
				{
					kind: "founder_gate",
					id: "gate-1",
					issue: "FLY-2886",
					observedAt: "2026-09-08T20:00:03.000Z",
				},
			],
		};
		expect(voiceBackgroundBriefKeys(snapshot)).toEqual([
			"session:exec-brief:running",
			"session:exec-complete:completed",
			"session:exec-failed:failed",
			"attention:founder_gate:gate-1",
		]);
		store.initializeVoiceContextBrief({
			sessionId: SESSION_ID,
			keys: ["session:exec-brief:running"],
			now: T0,
		});
		for (const gate of [
			{ backgroundEnabled: false, engineB: true },
			{ backgroundEnabled: true, engineB: false },
		]) {
			expect(
				recordVoiceBackgroundSnapshot({
					store,
					sessionId: SESSION_ID,
					leaseToken,
					...gate,
					snapshot,
					now: T0,
					countTokens: (text) => text.length,
				}),
			).toEqual({ recorded: 0, replayed: 0, skipped: 4 });
		}
		expect(store.getVoiceSession(SESSION_ID)?.contextRing).toEqual([]);

		expect(
			recordVoiceBackgroundSnapshot({
				store,
				sessionId: SESSION_ID,
				leaseToken,
				backgroundEnabled: true,
				engineB: true,
				snapshot,
				now: T0,
				countTokens: (text) => text.length,
			}),
		).toEqual({ recorded: 3, replayed: 0, skipped: 1 });
		const ring = store.getVoiceSession(SESSION_ID)!.contextRing;
		expect(ring.map(({ key, deliveryClass }) => [key, deliveryClass])).toEqual([
			["session:exec-complete:completed", "context"],
			["session:exec-failed:failed", "tell"],
			["attention:founder_gate:gate-1", "tell"],
		]);
		expect(ring.map(({ text }) => text).join("\n")).toContain(
			"FLY-2799 failed：provider failed for PR #1306",
		);
		expect(
			store
				.listVoiceOutbound(SESSION_ID, leaseToken, T0)
				.map(({ messageId }) => messageId),
		).toEqual([
			`bridge-event:${SESSION_ID}:session:exec-failed:failed`,
			`bridge-event:${SESSION_ID}:attention:founder_gate:gate-1`,
		]);
		expect(
			recordVoiceBackgroundSnapshot({
				store,
				sessionId: SESSION_ID,
				leaseToken,
				backgroundEnabled: true,
				engineB: true,
				snapshot: {
					sessions: [
						{
							executionId: "exec-failed",
							issue: "FLY-2799",
							status: "completed",
							observedAt: "2026-09-08T20:00:04.000Z",
						},
					],
					attention: [],
				},
				now: "2026-09-08T20:00:04.000Z",
				countTokens: (text) => text.length,
			}),
		).toEqual({ recorded: 1, replayed: 0, skipped: 0 });
		expect(
			store.listVoiceOutbound(
				SESSION_ID,
				leaseToken,
				"2026-09-08T20:00:04.000Z",
			),
		).toEqual([]);
		const audit = new Database(join(root, "teamlead.db"), { readonly: true });
		expect(
			audit
				.prepare(
					"SELECT phase, terminal_reason FROM voice_outbound WHERE terminal_reason IS NOT NULL ORDER BY seq",
				)
				.all(),
		).toEqual([
			{ phase: "dropped", terminal_reason: "agenda_stale_dropped" },
			{ phase: "dropped", terminal_reason: "agenda_stale_dropped" },
		]);
		audit.close();
	});

	it("excludes root, wrong authors, empty/prefixed bot text and still advances to page max", () => {
		const lease = claim().leaseToken;
		expect(
			recordVoiceOutboundDiscordPage({
				store,
				sessionId: SESSION_ID,
				leaseToken: lease,
				channelId: CHANNEL,
				leadBotUserId: LEAD_BOT,
				rootMessageId: ROOT,
				now: "2026-09-08T20:00:01.000Z",
				messages: [
					{
						id: ROOT,
						author: { id: LEAD_BOT },
						content: "root",
						timestamp: T0,
					},
					{
						id: "100000000000000012",
						author: { id: "100000000000000099" },
						content: "wrong author",
						timestamp: T0,
					},
					{
						id: "100000000000000013",
						author: { id: LEAD_BOT },
						content: "📻 status",
						timestamp: T0,
					},
					{
						id: "100000000000000014",
						author: { id: LEAD_BOT },
						content: "   ",
						timestamp: T0,
					},
				],
			}),
		).toBe(true);
		expect(store.getVoiceSession(SESSION_ID)?.outboundCursor[CHANNEL]).toBe(
			"100000000000000014",
		);
		expect(store.listVoiceOutbound(SESSION_ID, lease, T0)).toEqual([]);
	});

	it("scrubs the accepted Lead reply before the durable insert", () => {
		const lease = claim().leaseToken;
		recordVoiceOutboundDiscordPage({
			store,
			sessionId: SESSION_ID,
			leaseToken: lease,
			channelId: CHANNEL,
			leadBotUserId: LEAD_BOT,
			rootMessageId: ROOT,
			now: "2026-09-08T20:00:01.000Z",
			messages: [
				{
					id: "100000000000000015",
					author: { id: LEAD_BOT },
					content: "Use sk-abcdefghijklmnopqrstuvwxyz123456",
					timestamp: T0,
				},
			],
		});
		expect(store.listVoiceOutbound(SESSION_ID, lease, T0)[0]).toMatchObject({
			text: "Use [redacted]",
			deliveryClass: "tell",
			source: "discord",
		});
	});
});

it("filters own voice mirrors and status from a mixed page while queuing a normal reply once", () => {
	const leaseToken = claim().leaseToken;
	const messages = [
		"🗣️ founder speech",
		"📻 status",
		"🤖 status",
		"normal Lead reply",
	].map((content, index) => ({
		id: `10000000000000002${index}`,
		author: { id: LEAD_BOT },
		content,
		timestamp: T0,
	}));
	const page = {
		store,
		sessionId: SESSION_ID,
		leaseToken,
		channelId: CHANNEL,
		leadBotUserId: LEAD_BOT,
		rootMessageId: ROOT,
		now: T0,
		messages,
	};
	expect(recordVoiceOutboundDiscordPage(page)).toBe(true);
	expect(recordVoiceOutboundDiscordPage(page)).toBe(true);
	expect(
		store.listVoiceOutbound(SESSION_ID, leaseToken, T0).map(({ text }) => text),
	).toEqual(["normal Lead reply"]);
	expect(store.getVoiceSession(SESSION_ID)?.outboundCursor[CHANNEL]).toBe(
		"100000000000000023",
	);
});

it("never reads the Codex transcript mirror of the founder's own words back as a Lead reply", () => {
	// FLY-2799 qa6: engine B mirrors every final line to the session thread as
	// the Lead bot. The founder's own lines came back as voice_outbound rows and
	// were read aloud to her.
	const leaseToken = claim().leaseToken;
	const messages = [
		"🎙️ **你（语音）**：是谁手上有什么事情呢?",
		"🎙️ **语音输入**：說話",
		"🎙 **你（语音）**：without the emoji variation selector",
		"🤖 **flywheel-test-2 语音分身**：我确认一下。",
		"2799 目前还是 In Progress。",
	].map((content, index) => ({
		id: `10000000000000003${index}`,
		author: { id: LEAD_BOT },
		content,
		timestamp: T0,
	}));
	expect(
		recordVoiceOutboundDiscordPage({
			store,
			sessionId: SESSION_ID,
			leaseToken,
			channelId: CHANNEL,
			leadBotUserId: LEAD_BOT,
			rootMessageId: ROOT,
			now: T0,
			messages,
		}),
	).toBe(true);
	expect(
		store.listVoiceOutbound(SESSION_ID, leaseToken, T0).map(({ text }) => text),
	).toEqual(["2799 目前还是 In Progress。"]);
});

describe("voice transcript mirrors are excluded by source", () => {
	function liveWithUtterance() {
		const leaseToken = claim().leaseToken;
		for (const state of ["warming", "live"] as const) {
			store.setVoiceSessionState({
				sessionId: SESSION_ID,
				leaseToken,
				state,
				now: T0,
			});
		}
		store.recordVoiceUtterance({
			sessionId: SESSION_ID,
			leaseToken,
			transcriptId: "transcript-mirrored",
			utteranceId: "utterance-mirrored",
			sessionGeneration: 1,
			sequence: 1,
			source: "room_audio",
			role: "user",
			text: "是谁手上有什么事情呢?",
			final: true,
			attribution: { kind: "known", speakerUserId: "founder" },
			captureDigest: "c".repeat(64),
			now: T0,
		});
		return leaseToken;
	}

	function page(leaseToken: string, id: string, content: string) {
		return recordVoiceOutboundDiscordPage({
			store,
			sessionId: SESSION_ID,
			leaseToken,
			channelId: CHANNEL,
			leadBotUserId: LEAD_BOT,
			rootMessageId: ROOT,
			now: T0,
			messages: [{ id, author: { id: LEAD_BOT }, content, timestamp: T0 }],
		});
	}

	it("skips a thread message the voice side registered as its own mirror, whatever its text", () => {
		// FLY-2799 qa6 (Lead 353a5633): the exclusion must not depend on the
		// mirror's emoji prefix staying in sync with the poller.
		const leaseToken = liveWithUtterance();
		expect(
			store.recordVoiceUtteranceMirror({
				sessionId: SESSION_ID,
				leaseToken,
				transcriptId: "transcript-mirrored",
				messageId: "100000000000000041",
				now: T0,
			}),
		).toBe("recorded");
		expect(
			page(leaseToken, "100000000000000041", "是谁手上有什么事情呢?"),
		).toBe(true);
		expect(page(leaseToken, "100000000000000042", "这是 Lead 的回复")).toBe(
			true,
		);
		expect(
			store
				.listVoiceOutbound(SESSION_ID, leaseToken, T0)
				.map(({ text }) => text),
		).toEqual(["这是 Lead 的回复"]);
	});

	it("withdraws the mirror if the poller queued it before the voice side registered it", () => {
		const leaseToken = liveWithUtterance();
		expect(
			page(leaseToken, "100000000000000043", "是谁手上有什么事情呢?"),
		).toBe(true);
		expect(store.listVoiceOutbound(SESSION_ID, leaseToken, T0)).toHaveLength(1);
		expect(
			store.recordVoiceUtteranceMirror({
				sessionId: SESSION_ID,
				leaseToken,
				transcriptId: "transcript-mirrored",
				messageId: "100000000000000043",
				now: T0,
			}),
		).toBe("recorded");
		expect(store.listVoiceOutbound(SESSION_ID, leaseToken, T0)).toEqual([]);
		// Replays are idempotent; a second, different id for one line is refused.
		const again = {
			sessionId: SESSION_ID,
			leaseToken,
			transcriptId: "transcript-mirrored",
			now: T0,
		};
		expect(
			store.recordVoiceUtteranceMirror({
				...again,
				messageId: "100000000000000043",
			}),
		).toBe("replayed");
		expect(
			store.recordVoiceUtteranceMirror({
				...again,
				messageId: "100000000000000044",
			}),
		).toBe("conflict");
		expect(
			store.recordVoiceUtteranceMirror({
				...again,
				transcriptId: "transcript-unknown",
				messageId: "100000000000000045",
			}),
		).toBe("not_found");
		expect(
			store.recordVoiceUtteranceMirror({
				...again,
				leaseToken: "wrong-lease",
				messageId: "100000000000000043",
			}),
		).toBe("lease_conflict");
	});
});

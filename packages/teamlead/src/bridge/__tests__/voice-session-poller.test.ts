import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { recordVoiceOutboundDiscordPage } from "../voice-session-poller.js";

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
		expect(store.listVoiceOutbound(SESSION_ID, lease, T0)[0]?.text).toBe(
			"Use [redacted]",
		);
	});
});

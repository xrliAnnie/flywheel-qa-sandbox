import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	createLeadReplyFailedHandler,
	LEAD_REPLY_FAILED_VOICE_TEXT,
} from "../lead-reply-failed-route.js";

/**
 * FLY-2862: a Codex Lead's empty answer to a voice-room turn must reach the voice
 * daemon (so it stops the waiting tone) without anything being posted to Discord.
 */

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const T0 = "2026-09-24T21:48:00.000Z";
const THREAD = "100000000000000011";
const VOICE_BOT = "100000000000000005";

let root: string;
let store: StateStore;
let server: Server | undefined;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "fly2862-reply-failed-"));
	store = await StateStore.create(join(root, "teamlead.db"));
	store.reserveVoiceSession({
		sessionId: SESSION_ID,
		mode: "rg",
		projectName: "flywheel-test",
		leadId: "flywheel-test-1",
		guildId: "100000000000000001",
		voiceBotUserId: VOICE_BOT,
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
		rootMessageId: THREAD,
		threadId: THREAD,
		boundChannelIds: [THREAD],
		outboundCursor: { [THREAD]: "100000000000000010" },
		updatedAt: T0,
	});
});

afterEach(async () => {
	if (server) await new Promise((resolve) => server!.close(resolve));
	server = undefined;
	store.close();
	rmSync(root, { recursive: true, force: true });
});

function claim(): string {
	return store.claimVoiceSession({
		sessionId: SESSION_ID,
		daemonBootId: "boot-a",
		now: T0,
		leaseTtlMs: 15_000,
	})!.leaseToken!;
}

const report = {
	projectName: "flywheel-test",
	leadId: "flywheel-test-1",
	threadId: THREAD,
	key: "entry-1",
	text: LEAD_REPLY_FAILED_VOICE_TEXT,
	now: T0,
};

describe("StateStore.recordVoiceLeadReplyFailure", () => {
	it("queues one speakable status line for the live session that owns the thread", () => {
		const lease = claim();
		expect(store.recordVoiceLeadReplyFailure(report)).toBe(SESSION_ID);
		expect(store.recordVoiceLeadReplyFailure(report)).toBe(SESSION_ID);
		expect(store.listVoiceOutbound(SESSION_ID, lease, T0)).toEqual([
			expect.objectContaining({
				messageId: "lead-reply-failed:entry-1",
				channelId: THREAD,
				authorId: VOICE_BOT,
				text: LEAD_REPLY_FAILED_VOICE_TEXT,
				phase: "queued",
			}),
		]);
	});

	it("ignores a session whose daemon lease has expired (the daemon could never read it)", () => {
		const lease = claim();
		const expired = "2026-09-24T21:48:20.000Z";
		expect(
			store.recordVoiceLeadReplyFailure({ ...report, now: expired }),
		).toBeUndefined();
		expect(store.listVoiceOutbound(SESSION_ID, lease, T0)).toEqual([]);
	});

	it("ignores another Lead, another thread, and a session no daemon holds", () => {
		expect(store.recordVoiceLeadReplyFailure(report)).toBeUndefined();
		claim();
		expect(
			store.recordVoiceLeadReplyFailure({ ...report, leadId: "other-lead" }),
		).toBeUndefined();
		expect(
			store.recordVoiceLeadReplyFailure({
				...report,
				threadId: "100000000000000099",
			}),
		).toBeUndefined();
	});
});

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
	const log = vi.fn();
	const app = express();
	app.use(express.json());
	app.post(
		"/api/lead-outbound/reply-failed",
		createLeadReplyFailedHandler({ store, now: () => T0, log }),
	);
	server = createServer(app);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const res = await fetch(
		`http://127.0.0.1:${port}/api/lead-outbound/reply-failed`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return { status: res.status, json: await res.json() };
}

const valid = {
	projectName: "flywheel-test",
	leadId: "flywheel-test-1",
	channelId: THREAD,
	idempotencyKey: "entry-1",
	reason: "empty_final_answer",
};

describe("POST /api/lead-outbound/reply-failed", () => {
	it("tells the voice daemon when the thread is a live voice session", async () => {
		const lease = claim();
		const res = await post(valid);
		expect(res).toEqual({
			status: 200,
			json: { status: "voice_notified", sessionId: SESSION_ID },
		});
		expect(store.listVoiceOutbound(SESSION_ID, lease, T0)).toHaveLength(1);
	});

	it("records nothing for a thread without a voice session", async () => {
		claim();
		const res = await post({ ...valid, channelId: "100000000000000099" });
		expect(res).toEqual({ status: 200, json: { status: "no_voice_session" } });
	});

	it("rejects malformed reports without touching the store", async () => {
		const lease = claim();
		for (const body of [
			{ ...valid, reason: "other" },
			{ ...valid, channelId: "not-a-snowflake" },
			{ ...valid, leadId: "" },
			{ ...valid, projectName: 7 },
			{ ...valid, idempotencyKey: "x\ny" },
		]) {
			expect((await post(body)).status).toBe(400);
			await new Promise((resolve) => server!.close(resolve));
			server = undefined;
		}
		expect(store.listVoiceOutbound(SESSION_ID, lease, T0)).toEqual([]);
	});
});

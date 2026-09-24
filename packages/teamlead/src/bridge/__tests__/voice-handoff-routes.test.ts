import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import express from "express";
import {
	type VoiceHandoffRequest,
	voiceHandoffRequestDigest,
} from "flywheel-voice-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceHandoffRouter } from "../voice-handoff-routes.js";
import { VoiceHandoffStore } from "../voice-handoff-store.js";
import { VoiceReplyNotifier } from "../voice-reply-notifier.js";
import { voiceSessionAuthMiddleware } from "../voice-session-auth.js";

const MASTER = "master-token";
const SESSION_ID = "10000000-0000-4000-8000-000000000101";
const LEASE = "lease-token";
const HANDOFF_ID = "018f47d2-7b64-7b42-a3df-123456789abc";
let server: Server | undefined;
let db: Database.Database | undefined;

afterEach(
	() =>
		new Promise<void>((resolve) => {
			const closeDb = () => {
				db?.close();
				db = undefined;
				resolve();
			};
			if (!server) return closeDb();
			server.close(() => {
				server = undefined;
				closeDb();
			});
		}),
);

function request(): VoiceHandoffRequest {
	const input = {
		handoffId: HANDOFF_ID,
		idempotencyKey: "transcript-1:lead-1:action",
		intentKind: "action" as const,
		payload: {
			targetLeadId: "lead-1",
			text: "Please check the deploy.",
			quotes: ["check the deploy"],
		},
		sessionId: SESSION_ID,
		generation: 7,
		transcriptId: "transcript-1",
		utteranceId: "utterance-1",
		originalText: "Please check the deploy.",
		authorityBinding: {
			projectName: "flywheel",
			founderUserId: "founder-1",
			targetLeadId: "lead-1",
			sessionId: SESSION_ID,
			generation: 7,
			transcriptId: "transcript-1",
			transcriptDigest: "b".repeat(64),
		},
		transcriptDurabilityReceipt: {
			version: 1 as const,
			durable: true as const,
			sessionId: SESSION_ID,
			transcriptId: "transcript-1",
			contentDigest: "b".repeat(64),
			persistedAt: "2026-09-23T20:00:00.000Z",
		},
	};
	return { ...input, requestDigest: voiceHandoffRequestDigest(input) };
}

async function start(
	transcriptVerified = true,
	expireAfterTranscriptVerify = false,
) {
	db = new Database(":memory:");
	const store = new VoiceHandoffStore(db);
	store.migrate();
	const dispatch = vi.fn(async () => "committed" as const);
	let leaseCurrent = true;
	const verifyTranscript = vi.fn(async () => {
		if (expireAfterTranscriptVerify) leaseCurrent = false;
		return transcriptVerified;
	});
	const app = express();
	app.use(express.json());
	app.use(
		"/api/voice/handoffs",
		voiceSessionAuthMiddleware(MASTER),
		createVoiceHandoffRouter({
			store,
			replyNotifier: new VoiceReplyNotifier(),
			founderUserId: "founder-1",
			now: () => new Date("2026-09-23T20:00:01.000Z"),
			getSession: (sessionId) =>
				sessionId === SESSION_ID
					? {
							sessionId,
							projectName: "flywheel",
							sessionGeneration: 7,
							leaseToken: LEASE,
							leaseExpiresAt: leaseCurrent
								? "2026-09-23T20:01:00.000Z"
								: "2026-09-23T19:59:00.000Z",
							state: "live",
						}
					: undefined,
			isTargetLead: (project, lead) =>
				project === "flywheel" && lead === "lead-1",
			verifyTranscript,
			dispatch,
			verifyResultSource: async (record, input) =>
				input.sourceLeadId === record.targetLeadId &&
				input.requestDigest === record.requestDigest &&
				input.sourceDeliveryId === "delivery-1",
		}),
	);
	server = createServer(app);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	return {
		base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice/handoffs`,
		store,
		dispatch,
		verifyTranscript,
	};
}

async function call(
	base: string,
	path: string,
	options: {
		token?: string;
		lease?: string;
		method?: string;
		body?: unknown;
	} = {},
) {
	const response = await fetch(`${base}${path}`, {
		method: options.method ?? "GET",
		headers: {
			...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
			...(options.lease ? { "X-Voice-Lease": options.lease } : {}),
			...(options.body === undefined
				? {}
				: { "Content-Type": "application/json" }),
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	return { status: response.status, body: await response.json() };
}

async function readSseEvent(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	event: string,
): Promise<Record<string, unknown>> {
	const decoder = new TextDecoder();
	let pending = "";
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) throw new Error(`SSE ended before ${event}`);
		pending += decoder.decode(chunk.value, { stream: true });
		for (;;) {
			const boundary = pending.indexOf("\n\n");
			if (boundary < 0) break;
			const frame = pending.slice(0, boundary);
			pending = pending.slice(boundary + 2);
			const lines = frame.split("\n");
			if (lines.find((line) => line === `event: ${event}`)) {
				const data = lines.find((line) => line.startsWith("data: "));
				if (!data) throw new Error(`SSE ${event} missing data`);
				return JSON.parse(data.slice(6)) as Record<string, unknown>;
			}
		}
	}
}

describe("voice handoff routes", () => {
	it("authorizes a durable known-founder transcript and dispatches one deterministic mailbox item", async () => {
		const { base, dispatch } = await start();
		const first = await call(base, "/", {
			method: "POST",
			token: MASTER,
			lease: LEASE,
			body: request(),
		});
		expect(first).toMatchObject({
			status: 200,
			body: {
				handoffId: HANDOFF_ID,
				state: "committed",
				providerOperationId: `chat:lead-1:voice-handoff:${HANDOFF_ID}`,
			},
		});
		expect(dispatch).toHaveBeenCalledOnce();
		expect(
			await call(base, "/", {
				method: "POST",
				token: MASTER,
				lease: LEASE,
				body: request(),
			}),
		).toMatchObject({ status: 200, body: { state: "committed" } });
		expect(dispatch).toHaveBeenCalledOnce();
	});

	it("fails closed before dispatch when transcript readback is not proven", async () => {
		const { base, dispatch } = await start(false);
		expect(
			await call(base, "/", {
				method: "POST",
				token: MASTER,
				lease: LEASE,
				body: request(),
			}),
		).toMatchObject({
			status: 403,
			body: { error: "voice_handoff_transcript_unverified" },
		});
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("rechecks the session lease immediately before the carrier side effect", async () => {
		const { base, dispatch } = await start(true, true);
		expect(
			await call(base, "/", {
				method: "POST",
				token: MASTER,
				lease: LEASE,
				body: request(),
			}),
		).toMatchObject({ status: 403, body: { state: "rejected" } });
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("persists per-handoff results and replays them after the caller cursor", async () => {
		const { base } = await start();
		await call(base, "/", {
			method: "POST",
			token: MASTER,
			lease: LEASE,
			body: request(),
		});
		const resultBody = {
			resultEventId: "delivery-1:r1",
			requestDigest: request().requestDigest,
			sourceLeadId: "lead-1",
			sourceDeliveryId: "delivery-1",
			resultKind: "lead_reply",
			text: "I am checking it.",
			createdAt: "2026-09-23T20:00:05.000Z",
		};
		expect(
			await call(base, `/${HANDOFF_ID}/results`, {
				method: "POST",
				token: MASTER,
				body: resultBody,
			}),
		).toMatchObject({ status: 200, body: { seq: 1 } });
		expect(
			await call(
				base,
				`/${HANDOFF_ID}/results?sessionId=${SESSION_ID}&generation=7&after=0`,
				{ token: MASTER, lease: LEASE },
			),
		).toMatchObject({
			status: 200,
			body: {
				highWatermark: 1,
				nextCursor: 1,
				events: [{ resultEventId: "delivery-1:r1", seq: 1 }],
			},
		});
	});

	it("pushes only a durable reply wake to the bound session subscription", async () => {
		const { base } = await start();
		await call(base, "/", {
			method: "POST",
			token: MASTER,
			lease: LEASE,
			body: request(),
		});
		const abort = new AbortController();
		const stream = await fetch(
			`${base}/replies?sessionId=${SESSION_ID}&generation=7`,
			{
				headers: {
					Authorization: `Bearer ${MASTER}`,
					"X-Voice-Lease": LEASE,
				},
				signal: abort.signal,
			},
		);
		expect(stream.status).toBe(200);
		expect(stream.headers.get("content-type")).toContain("text/event-stream");
		const reader = stream.body!.getReader();
		await expect(readSseEvent(reader, "ready")).resolves.toEqual({
			sessionId: SESSION_ID,
			generation: 7,
		});

		const resultBody = {
			resultEventId: "delivery-1:wake",
			requestDigest: request().requestDigest,
			sourceLeadId: "lead-1",
			sourceDeliveryId: "delivery-1",
			resultKind: "lead_reply",
			text: "This remains durable-only payload.",
			createdAt: "2026-09-23T20:00:05.000Z",
		};
		await expect(
			call(base, `/${HANDOFF_ID}/results`, {
				method: "POST",
				token: MASTER,
				body: resultBody,
			}),
		).resolves.toMatchObject({ status: 200, body: { seq: 1 } });
		await expect(readSseEvent(reader, "reply")).resolves.toEqual({
			sessionId: SESSION_ID,
			generation: 7,
			handoffId: HANDOFF_ID,
		});

		abort.abort();
		await reader.cancel().catch(() => undefined);
	});

	it("rejects a forged Lead or digest on result append", async () => {
		const { base } = await start();
		await call(base, "/", {
			method: "POST",
			token: MASTER,
			lease: LEASE,
			body: request(),
		});
		expect(
			await call(base, `/${HANDOFF_ID}/results`, {
				method: "POST",
				token: MASTER,
				body: {
					resultEventId: "forged",
					requestDigest: "f".repeat(64),
					sourceLeadId: "other-lead",
					sourceDeliveryId: "delivery-forged",
					resultKind: "completed",
					text: "done",
					createdAt: "2026-09-23T20:00:05.000Z",
				},
			}),
		).toMatchObject({ status: 403 });
	});
});

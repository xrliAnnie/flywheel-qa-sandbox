import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { voiceSessionAuthMiddleware } from "../voice-session-auth.js";
import { createVoiceSessionRouter } from "../voice-session-routes.js";

const MASTER = "master-token";
const INGEST = "ingest-token";
const NOW = "2026-09-08T20:00:00.000Z";
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
let server: Server | undefined;
let store: StateStore;
let root: string;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "flywheel-voice-routes-"));
	store = await StateStore.create(join(root, "teamlead.db"));
});

afterEach(
	() =>
		new Promise<void>((resolve) => {
			const finish = () => {
				store.close();
				rmSync(root, { recursive: true });
				resolve();
			};
			if (!server) return finish();
			server.close(finish);
			server = undefined;
		}),
);

async function start() {
	const reportAbandoned = vi.fn(async () => {});
	const provisionSession = vi.fn((sessionId: string) => {
		store.updateVoiceProvisioning({
			sessionId,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: NOW,
		});
	});
	const app = express();
	app.use(express.json());
	app.use(
		"/api/voice/sessions",
		voiceSessionAuthMiddleware(MASTER, INGEST),
		createVoiceSessionRouter({
			store,
			leaseTtlMs: 15_000,
			now: () => NOW,
			newSessionId: () => SESSION_ID,
			resolveStart: (_body, credentialTier) => ({
				sessionId: SESSION_ID,
				mode: "meeting",
				projectName: "flywheel",
				leadId: "lead-a",
				guildId: "100000000000000001",
				voiceChannelId: "100000000000000002",
				meetingId: "20000000-0000-4000-8000-000000000001",
				evidenceDir: "/evidence/a",
				requestedBy: credentialTier,
				credentialTier,
				createdAt: NOW,
			}),
			provisionSession,
			reportAbandoned,
			projectSession: (session) => ({
				mode: session.mode,
				projectName: session.projectName,
				leadId: session.leadId,
				threadId: session.threadId,
			}),
		}),
	);
	server = createServer(app);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	return {
		base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice/sessions`,
		provisionSession,
		reportAbandoned,
	};
}

async function call(
	base: string,
	path: string,
	options: {
		method?: string;
		token?: string;
		lease?: string;
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

describe("voice session routes", () => {
	it("starts through the ingest tier, reserves first, and returns idempotent success", async () => {
		const { base, provisionSession } = await start();
		expect(
			await call(base, "", {
				method: "POST",
				token: INGEST,
				body: { meetingId: "20000000-0000-4000-8000-000000000001" },
			}),
		).toEqual({
			status: 201,
			body: { status: "accepted", sessionId: SESSION_ID, state: "desired" },
		});
		expect(provisionSession).toHaveBeenCalledWith(SESSION_ID);
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			credentialTier: "ingest",
			requestedBy: "ingest",
		});
		expect(
			await call(base, "", {
				method: "POST",
				token: INGEST,
				body: { meetingId: "20000000-0000-4000-8000-000000000001" },
			}),
		).toMatchObject({ status: 200, body: { status: "already_exists" } });
		expect(provisionSession).toHaveBeenCalledTimes(1);
	});

	it("allows ingest status and stop but rejects daemon-only mutations", async () => {
		const { base } = await start();
		await call(base, "", {
			method: "POST",
			token: INGEST,
			body: { meetingId: "20000000-0000-4000-8000-000000000001" },
		});
		expect((await call(base, `/${SESSION_ID}`, { token: INGEST })).status).toBe(
			200,
		);
		expect(
			(
				await call(base, `/${SESSION_ID}/claim`, {
					method: "POST",
					token: INGEST,
					body: { daemonBootId: "boot-a" },
				})
			).status,
		).toBe(403);
		expect(
			await call(base, `/${SESSION_ID}/stop`, {
				method: "POST",
				token: INGEST,
			}),
		).toMatchObject({ status: 200, body: { state: "cancelled" } });
	});

	it("claims, renews, advances state, and completes outbound receipt CAS", async () => {
		const { base } = await start();
		await call(base, "", {
			method: "POST",
			token: INGEST,
			body: { meetingId: "20000000-0000-4000-8000-000000000001" },
		});
		const claimed = await call(base, `/${SESSION_ID}/claim`, {
			method: "POST",
			token: MASTER,
			body: { daemonBootId: "boot-a" },
		});
		expect(claimed).toMatchObject({
			status: 200,
			body: { leaseTtlMs: 15_000, state: "claimed" },
		});
		const lease = (claimed.body as { leaseToken: string }).leaseToken;
		expect(
			await call(base, `/${SESSION_ID}/renew`, {
				method: "POST",
				token: MASTER,
				lease,
			}),
		).toMatchObject({ status: 200, body: { state: "claimed" } });
		expect(
			await call(base, `/${SESSION_ID}/state`, {
				method: "POST",
				token: MASTER,
				lease,
				body: { state: "warming" },
			}),
		).toEqual({ status: 200, body: { state: "warming" } });

		store.recordVoiceOutboundPage({
			sessionId: SESSION_ID,
			leaseToken: lease,
			channelId: "100000000000000003",
			cursor: "100000000000000010",
			messages: [
				{
					messageId: "100000000000000009",
					authorId: "100000000000000004",
					text: "hello",
					observedAt: NOW,
				},
			],
			now: NOW,
		});
		const outbound = await call(base, `/${SESSION_ID}/outbound`, {
			token: MASTER,
			lease,
		});
		expect(outbound).toMatchObject({
			status: 200,
			body: { items: [{ seq: 1 }] },
		});
		const attempt = await call(base, `/${SESSION_ID}/outbound/1/claim`, {
			method: "POST",
			token: MASTER,
			lease,
		});
		const attemptToken = (attempt.body as { attemptToken: string })
			.attemptToken;
		expect(
			await call(base, `/${SESSION_ID}/outbound/1/receipt`, {
				method: "POST",
				token: MASTER,
				lease,
				body: { attemptToken, status: "confirmed" },
			}),
		).toMatchObject({ status: 200, body: { status: "confirmed" } });
	});

	it("reports terminal abandoned speech after the ledger transition", async () => {
		const { base, reportAbandoned } = await start();
		await call(base, "", {
			method: "POST",
			token: INGEST,
			body: { meetingId: "20000000-0000-4000-8000-000000000001" },
		});
		const claimed = await call(base, `/${SESSION_ID}/claim`, {
			method: "POST",
			token: MASTER,
			body: { daemonBootId: "boot-a" },
		});
		const lease = (claimed.body as { leaseToken: string }).leaseToken;
		expect(
			await call(base, `/${SESSION_ID}/state`, {
				method: "POST",
				token: MASTER,
				lease,
				body: {
					state: "failed",
					reason: "daemon_restart",
					abandonedCount: 2,
				},
			}),
		).toEqual({ status: 200, body: { state: "failed" } });
		expect(reportAbandoned).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: SESSION_ID, state: "failed" }),
			2,
		);
	});
});

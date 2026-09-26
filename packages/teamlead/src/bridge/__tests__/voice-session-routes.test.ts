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
	const getSessionContext = vi.fn(async (_session, authority) => ({
		snapshotDigest: "context-digest",
		leaseBindingDigest: authority.leaseBindingDigest,
	}));
	const validateSession = vi.fn(async () => {});
	const projectSession = vi.fn((session) => ({
		mode: session.mode,
		projectName: session.projectName,
		leadId: session.leadId,
		threadId: session.threadId,
	}));
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
			leaseRenewMs: 4_000,
			now: () => NOW,
			newSessionId: () => SESSION_ID,
			resolveStart: (_body, credentialTier) => ({
				sessionId: SESSION_ID,
				mode: "meeting",
				projectName: "flywheel",
				leadId: "lead-a",
				guildId: "100000000000000001",
				voiceChannelId: "100000000000000002",
				voiceBotUserId: "100000000000000005",
				meetingId: "20000000-0000-4000-8000-000000000001",
				evidenceDir: "/evidence/a",
				requestedBy: credentialTier,
				credentialTier,
				createdAt: NOW,
			}),
			provisionSession,
			reportAbandoned,
			projectSession,
			validateSession,
			getSessionContext,
		}),
	);
	server = createServer(app);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	return {
		base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice/sessions`,
		provisionSession,
		reportAbandoned,
		projectSession,
		validateSession,
		getSessionContext,
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

	it("serves context only to the master holding the current session lease", async () => {
		const { base, getSessionContext } = await start();
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
		const currentLease = (claimed.body as { leaseToken: string }).leaseToken;

		expect(
			await call(base, `/${SESSION_ID}/context`, {
				token: MASTER,
				lease: "wrong-lease",
			}),
		).toEqual({ status: 409, body: { error: "voice_lease_conflict" } });
		expect(
			await call(base, `/${SESSION_ID}/context`, {
				token: INGEST,
				lease: currentLease,
			}),
		).toEqual({ status: 403, body: { error: "daemon_credential_required" } });
		const loaded = await call(base, `/${SESSION_ID}/context`, {
			token: MASTER,
			lease: currentLease,
		});
		expect(loaded).toMatchObject({
			status: 200,
			body: {
				snapshotDigest: "context-digest",
				leaseBindingDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
		expect(getSessionContext).toHaveBeenCalledTimes(1);
		expect(getSessionContext.mock.calls[0]?.[1].leaseBindingDigest).not.toBe(
			currentLease,
		);
	});

	it.each([
		["realtime_session_expiring", "live"],
		["realtime_session_expiring", "ending"],
		["realtime_capacity", "live"],
		["realtime_capacity", "ending"],
	] as const)(
		"accepts the daemon normal-end reason %s from %s",
		async (reason, terminalFrom) => {
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
			const lease = (claimed.body as { leaseToken: string }).leaseToken;
			for (const state of ["warming", "live"] as const) {
				expect(
					await call(base, `/${SESSION_ID}/state`, {
						method: "POST",
						token: MASTER,
						lease,
						body: { state },
					}),
				).toMatchObject({ status: 200, body: { state } });
			}
			if (terminalFrom === "ending") {
				expect(
					await call(base, `/${SESSION_ID}/stop`, {
						method: "POST",
						token: INGEST,
					}),
				).toMatchObject({ status: 200, body: { state: "ending" } });
			}
			expect(
				await call(base, `/${SESSION_ID}/state`, {
					method: "POST",
					token: MASTER,
					lease,
					body: { state: "ended", reason },
				}),
			).toMatchObject({ status: 200, body: { state: "ended" } });
			expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
				state: "ended",
				reason,
			});
		},
	);

	it("validates receive health and rejects a same-sequence conflict", async () => {
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
		const lease = (claimed.body as { leaseToken: string }).leaseToken;
		const receiveHealth = {
			version: 1,
			sequence: 2,
			state: "degraded",
			reason: "dave_decrypt",
			failures: 1,
			retries: 1,
			lastPcmAt: null,
		};
		expect(
			await call(base, `/${SESSION_ID}/renew`, {
				method: "POST",
				token: MASTER,
				lease,
				body: { receiveHealth },
			}),
		).toMatchObject({
			status: 200,
			body: { acceptedHealthSequence: 2 },
		});
		expect(await call(base, `/${SESSION_ID}`, { token: INGEST })).toMatchObject(
			{
				status: 200,
				body: {
					receiveHealth: {
						...receiveHealth,
						observedAt: NOW,
						fresh: true,
					},
				},
			},
		);
		expect(
			await call(base, `/${SESSION_ID}/renew`, {
				method: "POST",
				token: MASTER,
				lease,
				body: { receiveHealth: { ...receiveHealth, failures: 2 } },
			}),
		).toEqual({ status: 400, body: { error: "health_sequence_conflict" } });
		expect(
			await call(base, `/${SESSION_ID}/renew`, {
				method: "POST",
				token: MASTER,
				lease,
				body: { receiveHealth: { ...receiveHealth, extra: true } },
			}),
		).toEqual({ status: 400, body: { error: "voice_receive_health_invalid" } });
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

it("preserves 503 when provisioning throws before a durable transition", async () => {
	const { base, provisionSession } = await start();
	provisionSession.mockImplementation(() => {
		throw new Error("voice_session_registry_drift");
	});
	const response = await call(base, "", {
		method: "POST",
		token: INGEST,
		body: {},
	});
	expect(response).toMatchObject({
		status: 503,
		body: { error: "voice_unavailable" },
	});
	expect(store.getVoiceSession(SESSION_ID)?.state).toBe("provisioning");
});

it.each(["validation", "projection"])(
	"rejects %s failure before claim mutates ownership",
	async (failure) => {
		const { base, validateSession, projectSession } = await start();
		await call(base, "", { method: "POST", token: MASTER, body: {} });
		if (failure === "validation")
			validateSession.mockRejectedValue(
				new Error("voice_session_registry_drift"),
			);
		else
			projectSession.mockImplementation(() => {
				throw new Error("voice_session_registry_drift");
			});
		const response = await call(base, `/${SESSION_ID}/claim`, {
			method: "POST",
			token: MASTER,
			body: { daemonBootId: "boot" },
		});
		expect(response.status).toBe(503);
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "desired",
			leaseToken: null,
			daemonBootId: null,
		});
	},
);

it("requires live validation on renew without extending a rejected lease", async () => {
	const { base, validateSession } = await start();
	await call(base, "", { method: "POST", token: MASTER, body: {} });
	const claimed = await call(base, `/${SESSION_ID}/claim`, {
		method: "POST",
		token: MASTER,
		body: { daemonBootId: "boot" },
	});
	const before = store.getVoiceSession(SESSION_ID);
	validateSession.mockRejectedValue(new Error("self_filter_unverified"));
	expect(
		(
			await call(base, `/${SESSION_ID}/renew`, {
				method: "POST",
				token: MASTER,
				lease: claimed.body.leaseToken,
			})
		).status,
	).toBe(503);
	expect(store.getVoiceSession(SESSION_ID)).toEqual(before);
});

it("returns pinned status without projecting a terminal session against registry", async () => {
	const { base, projectSession, validateSession } = await start();
	await call(base, "", { method: "POST", token: MASTER, body: {} });
	store.stopVoiceSession(SESSION_ID, NOW);
	projectSession.mockImplementation(() => {
		throw new Error("registry missing");
	});
	validateSession.mockRejectedValue(new Error("registry missing"));
	expect(await call(base, `/${SESSION_ID}`, { token: INGEST })).toMatchObject({
		status: 200,
		body: {
			state: "cancelled",
			guildId: "100000000000000001",
			voiceChannelId: "100000000000000002",
			voiceBotUserId: "100000000000000005",
		},
	});
	expect(projectSession).not.toHaveBeenCalled();
	expect(validateSession).not.toHaveBeenCalled();
});

describe("voice session ready receipt (FLY-2701)", () => {
	async function claimed() {
		const { base } = await start();
		await call(base, "", {
			method: "POST",
			token: INGEST,
			body: { meetingId: "20000000-0000-4000-8000-000000000001" },
		});
		const claim = await call(base, `/${SESSION_ID}/claim`, {
			method: "POST",
			token: MASTER,
			body: { daemonBootId: "boot-a" },
		});
		return {
			base,
			leaseToken: (claim.body as { leaseToken: string }).leaseToken,
		};
	}

	it("records ready under the session lease and stays warming", async () => {
		const { base, leaseToken } = await claimed();
		const response = await call(base, `/${SESSION_ID}/ready`, {
			method: "POST",
			token: MASTER,
			lease: leaseToken,
			body: { scheduleRevision: null },
		});
		expect(response).toMatchObject({ status: 200, body: { status: "ready" } });
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "claimed",
			readyAt: NOW,
		});
	});

	it("refuses a ready receipt without the current lease", async () => {
		const { base } = await claimed();
		expect(
			(
				await call(base, `/${SESSION_ID}/ready`, {
					method: "POST",
					token: MASTER,
					lease: "not-the-lease",
					body: { scheduleRevision: null },
				})
			).status,
		).toBe(409);
	});

	it("keeps the daemon-only surface closed to the ingest tier", async () => {
		const { base, leaseToken } = await claimed();
		expect(
			(
				await call(base, `/${SESSION_ID}/ready`, {
					method: "POST",
					token: INGEST,
					lease: leaseToken,
					body: { scheduleRevision: null },
				})
			).status,
		).toBe(403);
	});

	it("rejects a malformed schedule revision instead of guessing", async () => {
		const { base, leaseToken } = await claimed();
		expect(
			(
				await call(base, `/${SESSION_ID}/ready`, {
					method: "POST",
					token: MASTER,
					lease: leaseToken,
					body: { scheduleRevision: "1" },
				})
			).status,
		).toBe(400);
	});
});

/**
 * FLY-2701 review R2 (MEDIUM): plan §5 distinguishes two outcomes that this
 * route had collapsed into one 409. Meeting the same booking is successful
 * deduplication and must hand back the booking's identity; disagreeing with it
 * is the conflict.
 */
describe("voice session start meets an existing booking (FLY-2701)", () => {
	const MEETING = "20000000-0000-4000-8000-000000000001";
	const SCHEDULE_ID = "20000000-0000-4000-8000-000000000009";

	function book(overrides: Record<string, unknown> = {}) {
		return store.createVoiceSchedule({
			scheduleId: SCHEDULE_ID,
			requestKey: "master:booking-1",
			requestDigest: "digest-booking",
			projectName: "flywheel",
			leadId: "lead-a",
			guildId: "100000000000000001",
			voiceChannelId: "100000000000000002",
			voiceBotUserId: "100000000000000005",
			meetingId: MEETING,
			evidenceDir: "/evidence/a",
			scheduledAt: "2026-09-08T21:00:00.000Z",
			prewarmAt: "2026-09-08T20:58:00.000Z",
			readyDeadlineAt: "2026-09-08T21:00:00.000Z",
			presenceDeadlineAt: "2026-09-08T21:10:00.000Z",
			requestedBy: "master",
			credentialTier: "master",
			createdAt: NOW,
			...overrides,
		});
	}

	it("hands back the existing booking instead of reporting a conflict", async () => {
		const { base, provisionSession } = await start();
		book();

		const response = await call(base, "/", {
			method: "POST",
			token: MASTER,
			body: {},
		});

		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({
			status: "schedule_bound",
			scheduleId: SCHEDULE_ID,
			revision: 1,
			state: "scheduled",
			scheduledAt: "2026-09-08T21:00:00.000Z",
		});
		// Nothing was started early and no second session exists.
		expect(provisionSession).not.toHaveBeenCalled();
		expect(store.getVoiceSession(SESSION_ID)).toBeUndefined();
	});

	it("reports a conflict when the request disagrees with the booking", async () => {
		const { base } = await start();
		book({ voiceChannelId: "100000000000000099" });

		const response = await call(base, "/", {
			method: "POST",
			token: MASTER,
			body: {},
		});

		expect(response.status).toBe(409);
		expect(response.body).toMatchObject({
			error: "voice_schedule_binding_conflict",
			scheduleId: SCHEDULE_ID,
		});
		expect(store.getVoiceSession(SESSION_ID)).toBeUndefined();
	});
});

describe("voice transcript mirror receipts (FLY-2799 qa6)", () => {
	it("records the Discord id of a mirrored line so the poller never reads it back", async () => {
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
		const lease = (claimed.body as { leaseToken: string }).leaseToken;
		for (const state of ["warming", "live"]) {
			await call(base, `/${SESSION_ID}/state`, {
				method: "POST",
				token: MASTER,
				lease,
				body: { state },
			});
		}
		store.recordVoiceUtterance({
			sessionId: SESSION_ID,
			leaseToken: lease,
			transcriptId: `${SESSION_ID}:1:item-a:1`,
			utteranceId: "utterance-a",
			sessionGeneration: 1,
			sequence: 1,
			source: "room_audio",
			role: "user",
			text: "你是谁",
			final: true,
			attribution: { kind: "known", speakerUserId: "founder" },
			captureDigest: "c".repeat(64),
			now: NOW,
		});
		const body = {
			transcriptId: `${SESSION_ID}:1:item-a:1`,
			messageId: "100000000000000050",
		};
		expect(
			await call(base, `/${SESSION_ID}/utterance-mirrors`, {
				method: "POST",
				token: INGEST,
				lease,
				body,
			}),
		).toMatchObject({ status: 403 });
		expect(
			await call(base, `/${SESSION_ID}/utterance-mirrors`, {
				method: "POST",
				token: MASTER,
				lease,
				body,
			}),
		).toEqual({ status: 201, body: { status: "recorded" } });
		expect(
			await call(base, `/${SESSION_ID}/utterance-mirrors`, {
				method: "POST",
				token: MASTER,
				lease,
				body,
			}),
		).toEqual({ status: 200, body: { status: "replayed" } });
		expect(
			await call(base, `/${SESSION_ID}/utterance-mirrors`, {
				method: "POST",
				token: MASTER,
				lease,
				body: { ...body, messageId: "100000000000000051" },
			}),
		).toMatchObject({ status: 409, body: { error: "voice_mirror_conflict" } });
		expect(
			await call(base, `/${SESSION_ID}/utterance-mirrors`, {
				method: "POST",
				token: MASTER,
				lease,
				body: { ...body, transcriptId: "missing" },
			}),
		).toMatchObject({
			status: 404,
			body: { error: "voice_transcript_not_found" },
		});
		expect(
			await call(base, `/${SESSION_ID}/utterance-mirrors`, {
				method: "POST",
				token: MASTER,
				lease,
				body: { ...body, messageId: "not-a-snowflake" },
			}),
		).toMatchObject({ status: 400, body: { error: "voice_mirror_invalid" } });
		expect(
			await call(base, `/${SESSION_ID}/utterance-mirrors`, {
				method: "POST",
				token: MASTER,
				lease: "stale-lease",
				body,
			}),
		).toMatchObject({ status: 409 });
	});
});

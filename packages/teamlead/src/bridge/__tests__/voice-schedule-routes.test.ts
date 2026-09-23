import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	createVoiceScheduleRouter,
	resolveVoicePrewarmLeadMs,
} from "../voice-schedule-routes.js";

const NOW = "2026-09-22T08:00:00.000Z";
const MEETING_AT = "2026-09-22T09:00:00.000Z";
const REQUEST_ID = "30000000-0000-4000-8000-000000000001";
const SCHEDULE_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_ID = "10000000-0000-4000-8000-000000000001";

let server: Server | undefined;
let store: StateStore;
let root: string;
let base: string;
let tier: "master" | "ingest";
// FLY-2701 review R1: these let a test move the clock past T, or take the
// binding registry away, *after* a request was already committed.
let nowIso: string;
let bindingUnavailable: boolean;

beforeEach(async () => {
	tier = "master";
	nowIso = NOW;
	bindingUnavailable = false;
	root = mkdtempSync(join(tmpdir(), "flywheel-voice-schedule-routes-"));
	store = await StateStore.create(join(root, "teamlead.db"));
	const app = express();
	app.use(express.json());
	app.use((_req, res, next) => {
		res.locals.voiceCredentialTier = tier;
		next();
	});
	app.use(
		"/api/voice/schedules",
		createVoiceScheduleRouter({
			store,
			now: () => nowIso,
			prewarmLeadMs: 120_000,
			presenceGraceMs: 600_000,
			newScheduleId: () => SCHEDULE_ID,
			resolveBinding: () => {
				if (bindingUnavailable) throw new Error("registry unavailable");
				return {
					projectName: "flywheel",
					leadId: "lead-a",
					guildId: "100000000000000001",
					voiceChannelId: "100000000000000002",
					voiceBotUserId: "100000000000000005",
					evidenceDir: "/tmp/evidence",
				};
			},
		}),
	);
	server = createServer(app);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice/schedules`;
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

async function call(
	path: string,
	options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`${base}${path}`, {
		method: options.method ?? "GET",
		headers: options.body ? { "content-type": "application/json" } : {},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const text = await response.text();
	return {
		status: response.status,
		body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
	};
}

const body = (overrides: Record<string, unknown> = {}) => ({
	requestId: REQUEST_ID,
	projectName: "flywheel",
	leadId: "lead-a",
	scheduledAt: MEETING_AT,
	evidenceDir: "/tmp/evidence",
	...overrides,
});

describe("voice schedule routes", () => {
	it("accepts a future meeting and freezes its prewarm lead", async () => {
		const response = await call("", { method: "POST", body: body() });
		expect(response.status).toBe(201);
		expect(response.body).toMatchObject({
			scheduleId: SCHEDULE_ID,
			revision: 1,
			state: "scheduled",
			scheduledAt: MEETING_AT,
			prewarmAt: "2026-09-22T08:58:00.000Z",
			lateAdmission: false,
		});
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			presenceDeadlineAt: "2026-09-22T09:10:00.000Z",
			readyDeadlineAt: MEETING_AT,
		});
	});

	it("replays the identical request and rejects the same id with a different body", async () => {
		await call("", { method: "POST", body: body() });
		const replay = await call("", { method: "POST", body: body() });
		expect(replay.status).toBe(200);
		expect(replay.body).toMatchObject({ scheduleId: SCHEDULE_ID, revision: 1 });
		const conflict = await call("", {
			method: "POST",
			body: body({ scheduledAt: "2026-09-22T10:00:00.000Z" }),
		});
		expect(conflict.status).toBe(409);
		expect(conflict.body).toMatchObject({
			error: "voice_request_replay_conflict",
		});
	});

	it("marks a booking inside the prewarm window as late instead of promising T", async () => {
		const response = await call("", {
			method: "POST",
			body: body({ scheduledAt: "2026-09-22T08:00:30.000Z" }),
		});
		expect(response.status).toBe(201);
		expect(response.body).toMatchObject({
			lateAdmission: true,
			prewarmAt: NOW,
		});
	});

	it("rejects a past time, a far future time, and a naive timestamp", async () => {
		for (const scheduledAt of [
			"2026-09-22T07:59:59.000Z",
			"2026-10-25T09:00:00.000Z",
			"2026-09-22T09:00:00",
		]) {
			const response = await call("", {
				method: "POST",
				body: body({ scheduledAt }),
			});
			expect(response.status).toBe(400);
			expect(response.body).toMatchObject({ error: "voice_request_invalid" });
		}
	});

	it("refuses an unknown field and a non-UUID request id", async () => {
		expect(
			(
				await call("", {
					method: "POST",
					body: body({ launchLabel: "com.flywheel.voice" }),
				})
			).status,
		).toBe(400);
		expect(
			(
				await call("", {
					method: "POST",
					body: body({ requestId: "not-a-uuid" }),
				})
			).status,
		).toBe(400);
	});

	it("keeps the daemon credential out of the scheduling surface", async () => {
		tier = "ingest";
		const response = await call("", { method: "POST", body: body() });
		expect(response.status).toBe(403);
	});

	it("reschedules with the expected revision and refuses a stale one", async () => {
		await call("", { method: "POST", body: body() });
		const moved = await call(`/${SCHEDULE_ID}`, {
			method: "PATCH",
			body: {
				requestId: "30000000-0000-4000-8000-000000000002",
				expectedRevision: 1,
				scheduledAt: "2026-09-22T10:00:00.000Z",
			},
		});
		expect(moved.status).toBe(200);
		expect(moved.body).toMatchObject({
			revision: 2,
			scheduledAt: "2026-09-22T10:00:00.000Z",
			prewarmAt: "2026-09-22T09:58:00.000Z",
		});
		const stale = await call(`/${SCHEDULE_ID}`, {
			method: "PATCH",
			body: {
				requestId: "30000000-0000-4000-8000-000000000003",
				expectedRevision: 1,
				scheduledAt: "2026-09-22T11:00:00.000Z",
			},
		});
		expect(stale.status).toBe(409);
		expect(stale.body).toMatchObject({
			error: "voice_schedule_revision_conflict",
		});
	});

	it("cannot swap the lead or room through a reschedule", async () => {
		await call("", { method: "POST", body: body() });
		const response = await call(`/${SCHEDULE_ID}`, {
			method: "PATCH",
			body: {
				requestId: "30000000-0000-4000-8000-000000000004",
				expectedRevision: 1,
				scheduledAt: "2026-09-22T10:00:00.000Z",
				leadId: "lead-b",
			},
		});
		expect(response.status).toBe(400);
	});

	it("accepts a cancel and reports the cleanup that is still running", async () => {
		await call("", { method: "POST", body: body() });
		store.attachVoiceScheduleSession({
			scheduleId: SCHEDULE_ID,
			expectedRevision: 1,
			sessionId: SESSION_ID,
			updatedAt: NOW,
		});
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
			createdAt: NOW,
			scheduleId: SCHEDULE_ID,
			scheduleRevision: 1,
		});
		const cancelled = await call(`/${SCHEDULE_ID}/cancel`, {
			method: "POST",
			body: {
				requestId: "30000000-0000-4000-8000-000000000005",
				expectedRevision: 1,
			},
		});
		expect(cancelled.status).toBe(200);
		expect(cancelled.body).toMatchObject({
			state: "cancelled",
			activeCleanup: true,
		});
		const status = await call(`/${SCHEDULE_ID}`);
		expect(status.body).toMatchObject({
			state: "cancelled",
			activeCleanup: true,
			sessionId: SESSION_ID,
		});
		expect(Object.keys(status.body)).not.toContain("leaseToken");
	});

	it("returns 404 for an unknown schedule", async () => {
		expect((await call("/20000000-0000-4000-8000-0000000000ff")).status).toBe(
			404,
		);
	});
});

describe("resolveVoicePrewarmLeadMs", () => {
	it("defaults to two minutes and accepts the configured band", () => {
		expect(resolveVoicePrewarmLeadMs(undefined)).toBe(120_000);
		expect(resolveVoicePrewarmLeadMs(60_000)).toBe(60_000);
		expect(resolveVoicePrewarmLeadMs(300_000)).toBe(300_000);
	});

	it("refuses a lead outside the deployable band instead of silently clamping", () => {
		expect(() => resolveVoicePrewarmLeadMs(59_999)).toThrow(
			/voice_prewarm_lead_invalid/,
		);
		expect(() => resolveVoicePrewarmLeadMs(300_001)).toThrow(
			/voice_prewarm_lead_invalid/,
		);
		expect(() => resolveVoicePrewarmLeadMs(Number.NaN)).toThrow(
			/voice_prewarm_lead_invalid/,
		);
	});
});

/**
 * FLY-2701 review R1: a request that was committed but whose response was lost
 * must replay to the original receipt. That only holds if the receipt is looked
 * up before anything that can change its answer — and both the "not in the
 * past" check and the external binding lookup can.
 */
describe("voice schedule receipt replay precedes time-variant checks", () => {
	it("replays a committed booking retried after its own meeting time", async () => {
		const first = await call("/", { method: "POST", body: body() });
		expect(first.status).toBe(201);

		// The caller never saw that 201 and retries — but by now T has passed, so
		// the scheduledAt it repeats verbatim is in the past.
		nowIso = "2026-09-22T09:30:00.000Z";
		const retry = await call("/", { method: "POST", body: body() });

		expect(retry.status).toBe(200);
		expect(retry.body).toMatchObject({
			scheduleId: SCHEDULE_ID,
			revision: 1,
			scheduledAt: MEETING_AT,
		});
	});

	it("replays a committed booking while the binding registry is unavailable", async () => {
		expect((await call("/", { method: "POST", body: body() })).status).toBe(
			201,
		);

		bindingUnavailable = true;
		const retry = await call("/", { method: "POST", body: body() });

		expect(retry.status).toBe(200);
		expect(retry.body).toMatchObject({ scheduleId: SCHEDULE_ID, revision: 1 });
	});

	it("still refuses a genuinely new booking in the past", async () => {
		nowIso = "2026-09-22T09:30:00.000Z";
		const late = await call("/", {
			method: "POST",
			body: body({ requestId: "30000000-0000-4000-8000-000000000009" }),
		});

		expect(late.status).toBe(400);
	});

	it("still reports a different body under a reused request id as a conflict", async () => {
		expect((await call("/", { method: "POST", body: body() })).status).toBe(
			201,
		);

		const changed = await call("/", {
			method: "POST",
			body: body({ scheduledAt: "2026-09-22T11:00:00.000Z" }),
		});

		expect(changed.status).toBe(409);
		expect(changed.body).toMatchObject({
			error: "voice_request_replay_conflict",
		});
	});

	it("replays a committed reschedule retried after the new time passed", async () => {
		expect((await call("/", { method: "POST", body: body() })).status).toBe(
			201,
		);
		const patchBody = {
			requestId: "30000000-0000-4000-8000-000000000002",
			expectedRevision: 1,
			scheduledAt: "2026-09-22T10:00:00.000Z",
		};
		const moved = await call(`/${SCHEDULE_ID}`, {
			method: "PATCH",
			body: patchBody,
		});
		expect(moved.status).toBe(200);

		nowIso = "2026-09-22T10:30:00.000Z";
		const retry = await call(`/${SCHEDULE_ID}`, {
			method: "PATCH",
			body: patchBody,
		});

		expect(retry.status).toBe(200);
		expect(retry.body).toMatchObject({ revision: 2 });
	});
});

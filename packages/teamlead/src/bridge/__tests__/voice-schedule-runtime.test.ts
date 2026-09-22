import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { VoiceScheduleRuntime } from "../voice-schedule-runtime.js";

const SCHEDULE_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const T0 = "2026-09-22T08:00:00.000Z";
const MEETING_AT = "2026-09-22T09:00:00.000Z";
const PREWARM_AT = "2026-09-22T08:58:00.000Z";

let store: StateStore;
let root: string;

function schedule(overrides: Record<string, unknown> = {}) {
	return store.createVoiceSchedule({
		scheduleId: SCHEDULE_ID,
		requestKey: "master:request-1",
		requestDigest: "digest-1",
		projectName: "flywheel",
		leadId: "lead-a",
		guildId: "100000000000000001",
		voiceChannelId: "100000000000000002",
		voiceBotUserId: "100000000000000005",
		evidenceDir: "/tmp/evidence",
		scheduledAt: MEETING_AT,
		prewarmAt: PREWARM_AT,
		readyDeadlineAt: MEETING_AT,
		presenceDeadlineAt: "2026-09-22T09:10:00.000Z",
		requestedBy: "master",
		credentialTier: "master",
		createdAt: T0,
		...overrides,
	});
}

function runtime(
	now: string,
	overrides: Partial<
		ConstructorParameters<typeof VoiceScheduleRuntime>[0]
	> = {},
) {
	return new VoiceScheduleRuntime({
		store,
		now: () => now,
		newSessionId: () => SESSION_ID,
		provision: vi.fn(async () => {}),
		requestWake: vi.fn(),
		...overrides,
	});
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "flywheel-voice-schedule-runtime-"));
	store = await StateStore.create(join(root, "teamlead.db"));
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true });
});

describe("VoiceScheduleRuntime", () => {
	it("does nothing before the frozen prewarm time", async () => {
		schedule();
		const provision = vi.fn(async () => {});
		const requestWake = vi.fn();
		await runtime("2026-09-22T08:57:59.999Z", {
			provision,
			requestWake,
		}).tick();
		expect(provision).not.toHaveBeenCalled();
		expect(requestWake).not.toHaveBeenCalled();
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "scheduled",
			sessionId: null,
		});
	});

	it("reserves a prewarming session carrying the live floor and wakes the host", async () => {
		schedule();
		// Provisioning ends at desired — that unclaimed row is what the wake lane
		// consumes, so the kickstart request follows it, not this pass's intent.
		const provision = vi.fn(async (sessionId: string) => {
			store.updateVoiceProvisioning({
				sessionId,
				expectedStep: "reserved",
				nextStep: "done",
				nextState: "desired",
				updatedAt: PREWARM_AT,
			});
		});
		const requestWake = vi.fn();
		await runtime(PREWARM_AT, { provision, requestWake }).tick();
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "prewarming",
			sessionId: SESSION_ID,
			sessionRevision: 1,
		});
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			mode: "meeting",
			scheduleId: SCHEDULE_ID,
			scheduleRevision: 1,
			notBeforeLiveAt: MEETING_AT,
			presenceDeadlineAt: "2026-09-22T09:10:00.000Z",
		});
		expect(provision).toHaveBeenCalledWith(SESSION_ID);
		expect(requestWake).toHaveBeenCalled();
	});

	it("does not start a second session for an already prewarming schedule", async () => {
		schedule();
		const provision = vi.fn(async () => {});
		const engine = runtime(PREWARM_AT, { provision });
		await engine.tick();
		await engine.tick();
		expect(provision).toHaveBeenCalledTimes(1);
	});

	it("waits rather than preempting a call already in the room", async () => {
		schedule();
		store.reserveVoiceSession({
			sessionId: "10000000-0000-4000-8000-0000000000aa",
			mode: "rg",
			projectName: "flywheel",
			leadId: "lead-a",
			guildId: "100000000000000001",
			voiceBotUserId: "100000000000000005",
			voiceChannelId: "100000000000000002",
			requestedBy: "master",
			credentialTier: "master",
			createdAt: T0,
		});
		const provision = vi.fn(async () => {});
		await runtime(PREWARM_AT, { provision }).tick();
		expect(provision).not.toHaveBeenCalled();
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "scheduled",
			scheduledAt: MEETING_AT,
		});
	});

	it("never prewarms a cancelled schedule", async () => {
		schedule();
		store.cancelVoiceSchedule({
			scheduleId: SCHEDULE_ID,
			requestKey: "master:cancel-1",
			requestDigest: "digest-cancel",
			expectedRevision: 1,
			updatedAt: T0,
		});
		const provision = vi.fn(async () => {});
		await runtime(PREWARM_AT, { provision }).tick();
		expect(provision).not.toHaveBeenCalled();
		expect(store.getVoiceSession(SESSION_ID)).toBeUndefined();
	});

	it("rescans a Bridge restart backlog instead of trusting a lost wake", async () => {
		schedule();
		const requestWake = vi.fn();
		// A first pass reserved and provisioned; the wake command was lost with the
		// old Bridge process. desired is still an unclaimed to-do, so the next scan
		// must ask again rather than assuming the host was already started.
		await runtime(PREWARM_AT, {
			provision: async (sessionId) => {
				store.updateVoiceProvisioning({
					sessionId,
					expectedStep: "reserved",
					nextStep: "done",
					nextState: "desired",
					updatedAt: PREWARM_AT,
				});
			},
		}).tick();
		await runtime("2026-09-22T08:58:03.000Z", { requestWake }).tick();
		expect(requestWake).toHaveBeenCalled();
	});

	it("fails a schedule whose presence deadline passed with nothing running", async () => {
		schedule();
		const provision = vi.fn(async () => {});
		await runtime("2026-09-22T09:10:00.001Z", { provision }).tick();
		expect(provision).not.toHaveBeenCalled();
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "failed",
			terminalReason: "missed",
		});
	});

	it("keeps the schedule for the next scan when provisioning throws", async () => {
		schedule();
		const engine = runtime(PREWARM_AT, {
			provision: vi.fn(async () => {
				throw new Error("discord_unavailable");
			}),
		});
		await expect(engine.tick()).resolves.toBeUndefined();
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "prewarming",
			sessionId: SESSION_ID,
		});
	});
});

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
		await runtime("2026-09-22T08:57:59.999Z", { provision }).tick();
		expect(provision).not.toHaveBeenCalled();
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "scheduled",
			sessionId: null,
		});
	});

	it("reserves a prewarming session carrying the live floor and leaves it desired", async () => {
		schedule();
		// Provisioning ends at desired. That unclaimed row is the whole hand-off:
		// the session runtime's wake lane owns asking launchd, because only that
		// lane spends the per-demand launch budget.
		const provision = vi.fn(async (sessionId: string) => {
			store.updateVoiceProvisioning({
				sessionId,
				expectedStep: "reserved",
				nextStep: "done",
				nextState: "desired",
				updatedAt: PREWARM_AT,
			});
		});
		await runtime(PREWARM_AT, { provision }).tick();
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
		expect(provision).toHaveBeenCalledWith(SESSION_ID, expect.anything());
		expect(store.getDesiredVoiceSession()).toMatchObject({
			sessionId: SESSION_ID,
		});
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

	it("never asks launchd itself, so the launch budget stays the only brake", async () => {
		schedule();
		// A first pass reserved and provisioned. Whatever happened to the host,
		// the desired row survives and the budgeted wake lane retries it; this
		// runtime must not open a second, unbudgeted kickstart path.
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
		await runtime("2026-09-22T08:58:03.000Z").tick();
		expect(store.getVoiceLaunchBudget(SESSION_ID)).toMatchObject({
			attempts: 0,
		});
		expect(store.getDesiredVoiceSession()).toMatchObject({
			sessionId: SESSION_ID,
		});
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

describe("VoiceScheduleRuntime provisioning bound (FLY-2701 review R3)", () => {
	it("gives up on a hung provisioning pass instead of freezing the lane", async () => {
		schedule();
		let aborted = false;
		const engine = runtime(PREWARM_AT, {
			provisionDeadlineMs: 10,
			provision: (_sessionId, signal) =>
				new Promise<void>((_resolve, reject) => {
					signal?.addEventListener("abort", () => {
						aborted = true;
						reject(new Error("aborted"));
					});
				}),
		});

		await expect(engine.tick()).resolves.toBeUndefined();
		// FLY-2701 review R1: the tick no longer waits for the deadline — that is
		// the fix — but the deadline must still fire and abort the hung pass.
		await vi.waitFor(() => expect(aborted).toBe(true));
		// The lane is free again: a later tick still runs.
		await expect(engine.tick()).resolves.toBeUndefined();
	});
});

/**
 * FLY-2701 review R1: plan §5 says external side effects run as independent
 * single-flight tasks and "调度不等外网". The file's own comment already said a
 * provisioning pass "cannot be allowed to hold the whole lane" — but the tick
 * awaited each one in turn, so a single hung external call froze every other
 * booking, the missed-meeting reaper, and the next scan for up to the whole
 * provision deadline.
 */
describe("voice schedule lane isolation (FLY-2701 review R1)", () => {
	const SECOND_SCHEDULE = "20000000-0000-4000-8000-000000000002";
	const SECOND_SESSION = "10000000-0000-4000-8000-000000000002";

	it("claims every due booking without waiting for a hung provisioning pass", async () => {
		schedule();
		store.createVoiceSchedule({
			scheduleId: SECOND_SCHEDULE,
			requestKey: "master:request-2",
			requestDigest: "digest-2",
			projectName: "flywheel",
			leadId: "lead-b",
			guildId: "100000000000000001",
			voiceChannelId: "100000000000000003",
			voiceBotUserId: "100000000000000005",
			evidenceDir: "/tmp/evidence",
			scheduledAt: MEETING_AT,
			prewarmAt: PREWARM_AT,
			readyDeadlineAt: MEETING_AT,
			presenceDeadlineAt: "2026-09-22T09:10:00.000Z",
			requestedBy: "master",
			credentialTier: "master",
			createdAt: T0,
		});

		const ids = [SESSION_ID, SECOND_SESSION];
		let hang!: () => void;
		const started: string[] = [];
		const lane = runtime(PREWARM_AT, {
			newSessionId: () => ids.shift()!,
			// The first booking's external call never settles within the test.
			provision: vi.fn(async (sessionId: string) => {
				started.push(sessionId);
				if (started.length === 1) {
					await new Promise<void>((resolve) => {
						hang = resolve;
					});
				}
			}),
		});

		// The tick itself must return: the DB claims are done, the external calls
		// are somebody else's problem.
		await lane.tick();

		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "prewarming",
			sessionId: SESSION_ID,
		});
		expect(store.getVoiceSchedule(SECOND_SCHEDULE)).toMatchObject({
			state: "prewarming",
			sessionId: SECOND_SESSION,
		});
		await vi.waitFor(() => expect(started).toHaveLength(2));
		hang();
	});

	it("does not start a second provisioning pass for a booking already in flight", async () => {
		schedule();
		let hang!: () => void;
		const provision = vi.fn(async () => {
			await new Promise<void>((resolve) => {
				hang = resolve;
			});
		});
		const lane = runtime(PREWARM_AT, { provision });

		await lane.tick();
		await vi.waitFor(() => expect(provision).toHaveBeenCalledTimes(1));
		await lane.tick();
		await lane.tick();

		expect(provision).toHaveBeenCalledTimes(1);
		hang();
	});

	it("never leaves a reserved session unlinked when the booking moves mid-scan", async () => {
		schedule();
		const lane = runtime(PREWARM_AT, {
			// The reschedule lands between the due listing and the reserve.
			newSessionId: () => {
				store.rescheduleVoiceSchedule({
					scheduleId: SCHEDULE_ID,
					requestKey: "master:patch-1",
					requestDigest: "digest-patch",
					expectedRevision: 1,
					scheduledAt: "2026-09-22T10:00:00.000Z",
					prewarmAt: "2026-09-22T09:58:00.000Z",
					readyDeadlineAt: "2026-09-22T10:00:00.000Z",
					presenceDeadlineAt: "2026-09-22T10:10:00.000Z",
					updatedAt: PREWARM_AT,
				});
				return SESSION_ID;
			},
		});

		await lane.tick();

		expect(store.getVoiceSession(SESSION_ID)).toBeUndefined();
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "scheduled",
			sessionId: null,
		});
	});
});

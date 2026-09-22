import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const SCHEDULE_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const T0 = "2026-09-22T08:00:00.000Z";
const MEETING_AT = "2026-09-22T09:00:00.000Z";
const PREWARM_AT = "2026-09-22T08:58:00.000Z";

let store: StateStore;
let root: string;

function reservation(overrides: Record<string, unknown> = {}) {
	return {
		scheduleId: SCHEDULE_ID,
		requestKey: "master:founder:request-1",
		requestDigest: "digest-1",
		projectName: "flywheel",
		leadId: "lead-a",
		guildId: "100000000000000001",
		voiceChannelId: "100000000000000002",
		voiceBotUserId: "100000000000000005",
		scheduledAt: MEETING_AT,
		prewarmAt: PREWARM_AT,
		readyDeadlineAt: MEETING_AT,
		presenceDeadlineAt: "2026-09-22T09:10:00.000Z",
		requestedBy: "founder",
		credentialTier: "master" as const,
		createdAt: T0,
		...overrides,
	};
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "flywheel-voice-schedule-"));
	store = await StateStore.create(join(root, "teamlead.db"));
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true });
});

describe("StateStore voice schedules", () => {
	it("creates a schedule at revision 1 without holding the room", () => {
		const created = store.createVoiceSchedule(reservation());
		expect(created).toMatchObject({ status: "created" });
		if (created.status !== "created") throw new Error("unreachable");
		expect(created.schedule).toMatchObject({
			scheduleId: SCHEDULE_ID,
			revision: 1,
			state: "scheduled",
			scheduledAt: MEETING_AT,
			prewarmAt: PREWARM_AT,
			sessionId: null,
		});
		// A future schedule must not consume the active-room uniqueness slot.
		expect(
			store.reserveVoiceSession({
				sessionId: SESSION_ID,
				mode: "rg",
				projectName: "flywheel",
				leadId: "lead-a",
				guildId: "100000000000000001",
				voiceBotUserId: "100000000000000005",
				voiceChannelId: "100000000000000002",
				requestedBy: "master",
				credentialTier: "master",
				createdAt: T0,
			}).status,
		).toBe("inserted");
	});

	it("replays an identical request with the original receipt and rejects a different body", () => {
		const first = store.createVoiceSchedule(reservation());
		if (first.status !== "created") throw new Error("unreachable");
		const replay = store.createVoiceSchedule(
			reservation({ scheduleId: "20000000-0000-4000-8000-00000000000f" }),
		);
		expect(replay).toEqual({
			status: "replayed",
			schedule: first.schedule,
		});
		const conflict = store.createVoiceSchedule(
			reservation({
				scheduleId: "20000000-0000-4000-8000-00000000000f",
				requestDigest: "digest-2",
			}),
		);
		expect(conflict).toEqual({ status: "request_conflict" });
	});

	it("advances the revision on reschedule and refuses a stale expected revision", () => {
		store.createVoiceSchedule(reservation());
		const moved = store.rescheduleVoiceSchedule({
			scheduleId: SCHEDULE_ID,
			requestKey: "master:founder:request-2",
			requestDigest: "digest-2",
			expectedRevision: 1,
			scheduledAt: "2026-09-22T10:00:00.000Z",
			prewarmAt: "2026-09-22T09:58:00.000Z",
			readyDeadlineAt: "2026-09-22T10:00:00.000Z",
			presenceDeadlineAt: "2026-09-22T10:10:00.000Z",
			updatedAt: "2026-09-22T08:05:00.000Z",
		});
		expect(moved).toMatchObject({ status: "updated" });
		if (moved.status !== "updated") throw new Error("unreachable");
		expect(moved.schedule).toMatchObject({
			revision: 2,
			state: "scheduled",
			scheduledAt: "2026-09-22T10:00:00.000Z",
		});
		expect(
			store.rescheduleVoiceSchedule({
				scheduleId: SCHEDULE_ID,
				requestKey: "master:founder:request-3",
				requestDigest: "digest-3",
				expectedRevision: 1,
				scheduledAt: "2026-09-22T11:00:00.000Z",
				prewarmAt: "2026-09-22T10:58:00.000Z",
				readyDeadlineAt: "2026-09-22T11:00:00.000Z",
				presenceDeadlineAt: "2026-09-22T11:10:00.000Z",
				updatedAt: "2026-09-22T08:06:00.000Z",
			}),
		).toEqual({ status: "revision_conflict", schedule: moved.schedule });
	});

	it("cancels a non-terminal schedule and refuses to revive a terminal one", () => {
		store.createVoiceSchedule(reservation());
		const cancelled = store.cancelVoiceSchedule({
			scheduleId: SCHEDULE_ID,
			requestKey: "master:founder:cancel-1",
			requestDigest: "digest-cancel",
			expectedRevision: 1,
			updatedAt: "2026-09-22T08:07:00.000Z",
		});
		expect(cancelled).toMatchObject({ status: "cancelled" });
		if (cancelled.status !== "cancelled") throw new Error("unreachable");
		expect(cancelled.schedule).toMatchObject({
			state: "cancelled",
			revision: 2,
			terminalReason: "cancelled",
		});
		expect(
			store.rescheduleVoiceSchedule({
				scheduleId: SCHEDULE_ID,
				requestKey: "master:founder:request-4",
				requestDigest: "digest-4",
				expectedRevision: 2,
				scheduledAt: "2026-09-22T12:00:00.000Z",
				prewarmAt: "2026-09-22T11:58:00.000Z",
				readyDeadlineAt: "2026-09-22T12:00:00.000Z",
				presenceDeadlineAt: "2026-09-22T12:10:00.000Z",
				updatedAt: "2026-09-22T08:08:00.000Z",
			}),
		).toMatchObject({ status: "terminal" });
	});

	it("lists only schedules whose prewarm time has arrived, oldest first", () => {
		store.createVoiceSchedule(reservation());
		store.createVoiceSchedule(
			reservation({
				scheduleId: "20000000-0000-4000-8000-000000000002",
				requestKey: "master:founder:request-b",
				requestDigest: "digest-b",
				scheduledAt: "2026-09-22T08:30:00.000Z",
				prewarmAt: "2026-09-22T08:28:00.000Z",
				readyDeadlineAt: "2026-09-22T08:30:00.000Z",
				presenceDeadlineAt: "2026-09-22T08:40:00.000Z",
			}),
		);
		expect(
			store
				.listDueVoiceSchedules("2026-09-22T08:27:59.999Z")
				.map((row) => row.scheduleId),
		).toEqual([]);
		expect(
			store
				.listDueVoiceSchedules("2026-09-22T08:58:00.000Z")
				.map((row) => row.scheduleId),
		).toEqual(["20000000-0000-4000-8000-000000000002", SCHEDULE_ID]);
	});

	it("links one prewarming session per schedule revision and rejects a stale link", () => {
		store.createVoiceSchedule(reservation());
		const linked = store.attachVoiceScheduleSession({
			scheduleId: SCHEDULE_ID,
			expectedRevision: 1,
			sessionId: SESSION_ID,
			updatedAt: PREWARM_AT,
		});
		expect(linked).toMatchObject({ status: "linked" });
		if (linked.status !== "linked") throw new Error("unreachable");
		expect(linked.schedule).toMatchObject({
			state: "prewarming",
			sessionId: SESSION_ID,
			sessionRevision: 1,
		});
		expect(
			store.attachVoiceScheduleSession({
				scheduleId: SCHEDULE_ID,
				expectedRevision: 1,
				sessionId: "10000000-0000-4000-8000-00000000000f",
				updatedAt: PREWARM_AT,
			}),
		).toMatchObject({ status: "revision_conflict" });
	});

	it("keeps the voice session carrying its schedule binding and live floor", () => {
		store.createVoiceSchedule(reservation());
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
			scheduleId: SCHEDULE_ID,
			scheduleRevision: 1,
			notBeforeLiveAt: MEETING_AT,
			presenceDeadlineAt: "2026-09-22T09:10:00.000Z",
		});
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			scheduleId: SCHEDULE_ID,
			scheduleRevision: 1,
			notBeforeLiveAt: MEETING_AT,
			presenceDeadlineAt: "2026-09-22T09:10:00.000Z",
			readyAt: null,
		});
	});

	it("records a ready receipt only for the current schedule revision", () => {
		store.createVoiceSchedule(reservation());
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
			scheduleId: SCHEDULE_ID,
			scheduleRevision: 1,
			notBeforeLiveAt: MEETING_AT,
			presenceDeadlineAt: "2026-09-22T09:10:00.000Z",
		});
		store.attachVoiceScheduleSession({
			scheduleId: SCHEDULE_ID,
			expectedRevision: 1,
			sessionId: SESSION_ID,
			updatedAt: PREWARM_AT,
		});
		store.updateVoiceProvisioning({
			sessionId: SESSION_ID,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: PREWARM_AT,
		});
		expect(
			store.claimVoiceSession({
				sessionId: SESSION_ID,
				daemonBootId: "boot-1",
				now: PREWARM_AT,
				leaseTtlMs: 15_000,
			}),
		).toBeDefined();
		expect(
			store.markVoiceSessionReady({
				sessionId: SESSION_ID,
				scheduleRevision: 2,
				readyAt: PREWARM_AT,
			}),
		).toBe("revision_conflict");
		expect(
			store.markVoiceSessionReady({
				sessionId: SESSION_ID,
				scheduleRevision: 1,
				readyAt: PREWARM_AT,
			}),
		).toBe("ready");
		// Idempotent: the daemon may retry the receipt without a second effect.
		expect(
			store.markVoiceSessionReady({
				sessionId: SESSION_ID,
				scheduleRevision: 1,
				readyAt: "2026-09-22T08:59:00.000Z",
			}),
		).toBe("ready");
		expect(store.getVoiceSession(SESSION_ID)?.readyAt).toBe(PREWARM_AT);
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "ready",
		});
	});
});

describe("StateStore scheduled live floor", () => {
	function claimed(): string {
		store.createVoiceSchedule(reservation());
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
			scheduleId: SCHEDULE_ID,
			scheduleRevision: 1,
			notBeforeLiveAt: MEETING_AT,
			presenceDeadlineAt: "2026-09-22T09:10:00.000Z",
		});
		store.attachVoiceScheduleSession({
			scheduleId: SCHEDULE_ID,
			expectedRevision: 1,
			sessionId: SESSION_ID,
			updatedAt: PREWARM_AT,
		});
		store.updateVoiceProvisioning({
			sessionId: SESSION_ID,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: PREWARM_AT,
		});
		const lease = store.claimVoiceSession({
			sessionId: SESSION_ID,
			daemonBootId: "boot-1",
			now: PREWARM_AT,
			// A prewarmed session waits for the meeting time, so its lease must
			// outlive the whole lead rather than expiring before T.
			leaseTtlMs: 30 * 60_000,
		})!;
		store.setVoiceSessionState({
			sessionId: SESSION_ID,
			leaseToken: lease.leaseToken,
			state: "warming",
			now: PREWARM_AT,
		});
		return lease.leaseToken;
	}

	it("refuses live before the meeting time and admits it at T once ready", () => {
		const leaseToken = claimed();
		expect(
			store.setVoiceSessionState({
				sessionId: SESSION_ID,
				leaseToken,
				state: "live",
				now: PREWARM_AT,
			}),
		).toBe(false);
		store.markVoiceSessionReady({
			sessionId: SESSION_ID,
			scheduleRevision: 1,
			readyAt: PREWARM_AT,
		});
		expect(
			store.setVoiceSessionState({
				sessionId: SESSION_ID,
				leaseToken,
				state: "live",
				now: "2026-09-22T08:59:59.999Z",
			}),
		).toBe(false);
		expect(
			store.setVoiceSessionState({
				sessionId: SESSION_ID,
				leaseToken,
				state: "live",
				now: MEETING_AT,
			}),
		).toBe(true);
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "live",
		});
	});

	it("refuses live at T when the session never reported ready", () => {
		const leaseToken = claimed();
		expect(
			store.setVoiceSessionState({
				sessionId: SESSION_ID,
				leaseToken,
				state: "live",
				now: MEETING_AT,
			}),
		).toBe(false);
	});

	it("refuses live when the schedule moved under the running session", () => {
		const leaseToken = claimed();
		store.markVoiceSessionReady({
			sessionId: SESSION_ID,
			scheduleRevision: 1,
			readyAt: PREWARM_AT,
		});
		store.cancelVoiceSchedule({
			scheduleId: SCHEDULE_ID,
			requestKey: "master:founder:cancel-live",
			requestDigest: "digest-cancel-live",
			expectedRevision: 1,
			updatedAt: PREWARM_AT,
		});
		expect(
			store.setVoiceSessionState({
				sessionId: SESSION_ID,
				leaseToken,
				state: "live",
				now: MEETING_AT,
			}),
		).toBe(false);
	});

	it("leaves an instant session's live transition exactly as it is today", () => {
		store.reserveVoiceSession({
			sessionId: SESSION_ID,
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
		store.updateVoiceProvisioning({
			sessionId: SESSION_ID,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: T0,
		});
		const lease = store.claimVoiceSession({
			sessionId: SESSION_ID,
			daemonBootId: "boot-1",
			now: T0,
			leaseTtlMs: 15_000,
		})!;
		store.setVoiceSessionState({
			sessionId: SESSION_ID,
			leaseToken: lease.leaseToken,
			state: "warming",
			now: T0,
		});
		expect(
			store.setVoiceSessionState({
				sessionId: SESSION_ID,
				leaseToken: lease.leaseToken,
				state: "live",
				now: T0,
			}),
		).toBe(true);
	});
});

describe("StateStore schedule and session stay in step (FLY-2701 review R3)", () => {
	function prewarming(): void {
		store.createVoiceSchedule(reservation());
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
			scheduleId: SCHEDULE_ID,
			scheduleRevision: 1,
			notBeforeLiveAt: MEETING_AT,
			presenceDeadlineAt: "2026-09-22T09:10:00.000Z",
		});
		store.attachVoiceScheduleSession({
			scheduleId: SCHEDULE_ID,
			expectedRevision: 1,
			sessionId: SESSION_ID,
			updatedAt: PREWARM_AT,
		});
	}

	it("cancels the unclaimed session in the same call that cancels the booking", () => {
		prewarming();
		store.updateVoiceProvisioning({
			sessionId: SESSION_ID,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: PREWARM_AT,
		});
		store.cancelVoiceSchedule({
			scheduleId: SCHEDULE_ID,
			requestKey: "master:founder:cancel-x",
			requestDigest: "digest-cancel-x",
			expectedRevision: 1,
			updatedAt: PREWARM_AT,
		});
		// The desired row is the launch intent. Leaving it behind means the host
		// is still woken, joins the room, and waits mute for a meeting that was
		// called off.
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "cancelled",
		});
		expect(store.getDesiredVoiceSession()).toBeUndefined();
	});

	it("moves a claimed session to ending when its booking is cancelled", () => {
		prewarming();
		store.updateVoiceProvisioning({
			sessionId: SESSION_ID,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: PREWARM_AT,
		});
		store.claimVoiceSession({
			sessionId: SESSION_ID,
			daemonBootId: "boot-1",
			now: PREWARM_AT,
			leaseTtlMs: 30 * 60_000,
		});
		store.cancelVoiceSchedule({
			scheduleId: SCHEDULE_ID,
			requestKey: "master:founder:cancel-y",
			requestDigest: "digest-cancel-y",
			expectedRevision: 1,
			updatedAt: PREWARM_AT,
		});
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "ending",
		});
	});

	it("frees the old session when a booking moves, so the new slot can start", () => {
		prewarming();
		store.updateVoiceProvisioning({
			sessionId: SESSION_ID,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: PREWARM_AT,
		});
		store.rescheduleVoiceSchedule({
			scheduleId: SCHEDULE_ID,
			requestKey: "master:founder:move-x",
			requestDigest: "digest-move-x",
			expectedRevision: 1,
			scheduledAt: "2026-09-22T09:30:00.000Z",
			prewarmAt: "2026-09-22T09:28:00.000Z",
			readyDeadlineAt: "2026-09-22T09:30:00.000Z",
			presenceDeadlineAt: "2026-09-22T09:40:00.000Z",
			updatedAt: PREWARM_AT,
		});
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "cancelled",
		});
	});

	it("reaps a booking whose session died outside the state route", () => {
		prewarming();
		// failVoiceSessionAdmission and the lease sweep write voice_sessions only.
		store.failVoiceSessionAdmission(
			SESSION_ID,
			"startup_retry_exhausted",
			PREWARM_AT,
		);
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "prewarming",
		});
		expect(store.reapStrandedVoiceSchedules("2026-09-22T08:59:00.000Z")).toBe(
			1,
		);
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "failed",
			terminalReason: "startup_retry_exhausted",
		});
		// A stranded booking must stop blocking a fresh one for the same meeting.
		expect(store.reapStrandedVoiceSchedules("2026-09-22T08:59:00.000Z")).toBe(
			0,
		);
	});

	it("leaves a healthy prewarming booking alone", () => {
		prewarming();
		expect(store.reapStrandedVoiceSchedules("2026-09-22T08:59:00.000Z")).toBe(
			0,
		);
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "prewarming",
		});
	});

	it("fails a booking that ran past its presence deadline with nothing to end it", () => {
		prewarming();
		expect(store.reapStrandedVoiceSchedules("2026-09-22T09:10:00.001Z")).toBe(
			1,
		);
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "failed",
			terminalReason: "presence_deadline_passed",
		});
	});
});

describe("StateStore reaper and a real meeting (FLY-2701 review R4)", () => {
	it("never fails a live booking for running long", () => {
		store.createVoiceSchedule(reservation());
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
			scheduleId: SCHEDULE_ID,
			scheduleRevision: 1,
			notBeforeLiveAt: MEETING_AT,
			presenceDeadlineAt: "2026-09-22T09:10:00.000Z",
		});
		store.attachVoiceScheduleSession({
			scheduleId: SCHEDULE_ID,
			expectedRevision: 1,
			sessionId: SESSION_ID,
			updatedAt: PREWARM_AT,
		});
		store.updateVoiceProvisioning({
			sessionId: SESSION_ID,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			updatedAt: PREWARM_AT,
		});
		const lease = store.claimVoiceSession({
			sessionId: SESSION_ID,
			daemonBootId: "boot-1",
			now: PREWARM_AT,
			leaseTtlMs: 4 * 60 * 60_000,
		})!;
		store.setVoiceSessionState({
			sessionId: SESSION_ID,
			leaseToken: lease.leaseToken,
			state: "warming",
			now: PREWARM_AT,
		});
		store.markVoiceSessionReady({
			sessionId: SESSION_ID,
			scheduleRevision: 1,
			readyAt: PREWARM_AT,
		});
		expect(
			store.setVoiceSessionState({
				sessionId: SESSION_ID,
				leaseToken: lease.leaseToken,
				state: "live",
				now: MEETING_AT,
			}),
		).toBe(true);

		// She is in the room and talking. The presence deadline was about whether
		// she ever showed up; it says nothing about how long the meeting may run.
		expect(store.reapStrandedVoiceSchedules("2026-09-22T09:45:00.000Z")).toBe(
			0,
		);
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "live",
			terminalReason: null,
		});

		// It still settles the moment the call actually ends.
		store.setVoiceSessionState({
			sessionId: SESSION_ID,
			leaseToken: lease.leaseToken,
			state: "ended",
			reason: "she-left",
			now: "2026-09-22T09:50:00.000Z",
		});
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "ended",
		});
	});
});

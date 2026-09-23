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
const PRESENCE_DEADLINE_AT = "2026-09-22T09:10:00.000Z";

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

	/**
	 * FLY-2701 review R1 (MEDIUM): plan §7 — "正常 no_human 终结允许
	 * warming→ended/no_human … 不可沿现有 failed/no_human 偷偷将正常缺席算故障".
	 * Nobody turning up for a meeting is a normal outcome, not a fault, and the
	 * state has to say so; suppressing the alert downstream is not the same
	 * thing. A session that already went live may never claim it.
	 */
	it("ends a warming session that nobody attended, instead of failing it", () => {
		const leaseToken = claimed();

		expect(
			store.setVoiceSessionState({
				sessionId: SESSION_ID,
				leaseToken,
				state: "ended",
				reason: "no_human",
				now: PRESENCE_DEADLINE_AT,
			}),
		).toBe(true);
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "ended",
			reason: "no_human",
		});
	});

	/**
	 * FLY-2701 review R2 (MEDIUM): "nobody came" is only true once the booking's
	 * own absolute deadline has passed. The daemon waits for it, but a stale or
	 * wrong daemon still holding the lease must not be able to declare a meeting
	 * unattended while she could still walk in — the durable boundary belongs
	 * here, not in whoever happens to be holding the lease.
	 */
	it("refuses to call a booked meeting unattended before its presence deadline", () => {
		const leaseToken = claimed();

		expect(
			store.setVoiceSessionState({
				sessionId: SESSION_ID,
				leaseToken,
				state: "ended",
				reason: "no_human",
				now: MEETING_AT,
			}),
		).toBe(false);
		expect(
			store.setVoiceSessionState({
				sessionId: SESSION_ID,
				leaseToken,
				state: "ended",
				reason: "no_human",
				now: "2026-09-22T09:09:59.999Z",
			}),
		).toBe(false);
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "warming",
		});
	});

	it("refuses a warming end for any reason other than nobody attending", () => {
		const leaseToken = claimed();

		expect(
			store.setVoiceSessionState({
				sessionId: SESSION_ID,
				leaseToken,
				state: "ended",
				reason: "she-left",
				now: PRESENCE_DEADLINE_AT,
			}),
		).toBe(false);
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "warming",
		});
	});

	it("refuses to call a live session's end an unattended meeting", () => {
		const leaseToken = claimed();
		store.markVoiceSessionReady({
			sessionId: SESSION_ID,
			scheduleRevision: 1,
			readyAt: PREWARM_AT,
		});
		store.setVoiceSessionState({
			sessionId: SESSION_ID,
			leaseToken,
			state: "live",
			now: MEETING_AT,
		});

		expect(
			store.setVoiceSessionState({
				sessionId: SESSION_ID,
				leaseToken,
				state: "ended",
				reason: "no_human",
				now: PRESENCE_DEADLINE_AT,
			}),
		).toBe(false);
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({ state: "live" });
	});

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

/**
 * FLY-2701 review R1 (HIGH): plan §5 "同一会议双入口去重" requires the schedule
 * entry and the instant entry to deduplicate each other inside one transaction,
 * in BOTH arrival orders. Neither direction was enforced.
 */
describe("StateStore voice schedule/session double-entry dedup", () => {
	const MEETING = "30000000-0000-4000-8000-000000000001";

	function instant(overrides: Record<string, unknown> = {}) {
		return {
			sessionId: SESSION_ID,
			mode: "meeting" as const,
			projectName: "flywheel",
			leadId: "lead-a",
			guildId: "100000000000000001",
			voiceChannelId: "100000000000000002",
			voiceBotUserId: "100000000000000005",
			meetingId: MEETING,
			requestedBy: "master",
			credentialTier: "master" as const,
			createdAt: T0,
			...overrides,
		};
	}

	it("refuses a new booking when the same meeting already has an instant session", () => {
		expect(store.reserveVoiceSession(instant()).status).toBe("inserted");

		// canonical-first order: the instant session exists, so POST /schedules
		// must 409 rather than quietly stealing the live call into a booking.
		const created = store.createVoiceSchedule(
			reservation({ meetingId: MEETING }),
		);
		expect(created.status).toBe("session_conflict");
	});

	it("does not let the instant entry start a not-yet-due booking early", () => {
		const created = store.createVoiceSchedule(
			reservation({ meetingId: MEETING }),
		);
		if (created.status !== "created") throw new Error("unreachable");

		// schedule-first order: the booking owns this meeting. The instant entry
		// must return the existing booking, never reserve a second session — that
		// second session would carry no not_before_live_at and so would bypass the
		// T live floor entirely.
		const reserved = store.reserveVoiceSession(instant());
		expect(reserved).toMatchObject({
			status: "schedule_bound",
			schedule: { scheduleId: SCHEDULE_ID, revision: 1, sessionId: null },
		});
		expect(store.getVoiceSession(SESSION_ID)).toBeUndefined();
	});

	it("reports a binding conflict when the instant request disagrees with the booking", () => {
		const created = store.createVoiceSchedule(
			reservation({ meetingId: MEETING }),
		);
		if (created.status !== "created") throw new Error("unreachable");

		expect(
			store.reserveVoiceSession(
				instant({ voiceChannelId: "100000000000000099" }),
			).status,
		).toBe("schedule_binding_conflict");
		expect(store.getVoiceSession(SESSION_ID)).toBeUndefined();
	});

	it("applies the same guard on the intent-keyed instant entry", () => {
		const created = store.createVoiceSchedule(
			reservation({ meetingId: MEETING }),
		);
		if (created.status !== "created") throw new Error("unreachable");

		expect(
			store.reserveVoiceSessionIntent({
				projectName: "flywheel",
				leadId: "lead-a",
				requestId: "40000000-0000-4000-8000-000000000001",
				operationId: "voice.session.start",
				inputDigest: "digest-instant",
				reservation: instant(),
			}).status,
		).toBe("schedule_bound");
		expect(store.getVoiceSession(SESSION_ID)).toBeUndefined();
	});

	it("lets the instant entry through once the booking reached a terminal state", () => {
		const created = store.createVoiceSchedule(
			reservation({ meetingId: MEETING }),
		);
		if (created.status !== "created") throw new Error("unreachable");
		store.cancelVoiceSchedule({
			scheduleId: SCHEDULE_ID,
			requestKey: "master:founder:cancel-1",
			requestDigest: "digest-cancel",
			expectedRevision: 1,
			updatedAt: T0,
		});

		expect(store.reserveVoiceSession(instant()).status).toBe("inserted");
	});
});

/**
 * FLY-2701 review R1 (HIGH): plan §5's pseudocode says the reserve and the link
 * commit *atomically*. Two separate transactions leave, on a crash between them,
 * a non-terminal session carrying schedule_id/revision while the schedule is
 * still `scheduled` with session_id NULL — which cancel can never stop, because
 * cancel reaches the session through the schedule's link.
 */
describe("StateStore atomic schedule session reservation", () => {
	it("commits the reservation and the link in one transaction", () => {
		const created = store.createVoiceSchedule(reservation());
		if (created.status !== "created") throw new Error("unreachable");

		const reserved = store.reserveVoiceScheduleSession({
			scheduleId: SCHEDULE_ID,
			expectedRevision: 1,
			reservation: {
				sessionId: SESSION_ID,
				mode: "meeting",
				projectName: "flywheel",
				leadId: "lead-a",
				guildId: "100000000000000001",
				voiceChannelId: "100000000000000002",
				voiceBotUserId: "100000000000000005",
				requestedBy: "founder",
				credentialTier: "master",
				createdAt: PREWARM_AT,
				scheduleId: SCHEDULE_ID,
				scheduleRevision: 1,
				notBeforeLiveAt: MEETING_AT,
				presenceDeadlineAt: "2026-09-22T09:10:00.000Z",
			},
			updatedAt: PREWARM_AT,
		});

		expect(reserved.status).toBe("reserved");
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "prewarming",
			sessionId: SESSION_ID,
		});
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			scheduleId: SCHEDULE_ID,
			scheduleRevision: 1,
			notBeforeLiveAt: MEETING_AT,
		});
	});

	it("leaves no orphan session behind when the revision moved under it", () => {
		const created = store.createVoiceSchedule(reservation());
		if (created.status !== "created") throw new Error("unreachable");
		// A reschedule between the listing and the reserve bumps the revision.
		store.rescheduleVoiceSchedule({
			scheduleId: SCHEDULE_ID,
			requestKey: "master:founder:patch-1",
			requestDigest: "digest-patch",
			expectedRevision: 1,
			scheduledAt: "2026-09-22T10:00:00.000Z",
			prewarmAt: "2026-09-22T09:58:00.000Z",
			readyDeadlineAt: "2026-09-22T10:00:00.000Z",
			presenceDeadlineAt: "2026-09-22T10:10:00.000Z",
			updatedAt: T0,
		});

		const reserved = store.reserveVoiceScheduleSession({
			scheduleId: SCHEDULE_ID,
			expectedRevision: 1,
			reservation: {
				sessionId: SESSION_ID,
				mode: "meeting",
				projectName: "flywheel",
				leadId: "lead-a",
				guildId: "100000000000000001",
				voiceChannelId: "100000000000000002",
				voiceBotUserId: "100000000000000005",
				requestedBy: "founder",
				credentialTier: "master",
				createdAt: PREWARM_AT,
				scheduleId: SCHEDULE_ID,
				scheduleRevision: 1,
				notBeforeLiveAt: MEETING_AT,
				presenceDeadlineAt: "2026-09-22T09:10:00.000Z",
			},
			updatedAt: PREWARM_AT,
		});

		expect(reserved.status).toBe("revision_conflict");
		// The whole point: no half-committed session row survives the refusal.
		expect(store.getVoiceSession(SESSION_ID)).toBeUndefined();
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "scheduled",
			sessionId: null,
		});
	});
});

/**
 * FLY-2701 review R2 (MEDIUM): the reaper and a healthy daemon reach the
 * presence deadline at the same instant. The runtime runs the reaper first, so
 * a booking whose daemon was about to report a perfectly normal "nobody came"
 * was written as failed/presence_deadline_passed — and then the daemon's own
 * ending was dropped, because the schedule was already terminal. The absence
 * was recorded as a fault again, which is the thing R1 was supposed to end.
 */
describe("StateStore schedule reaper versus a normal unattended ending", () => {
	const DEADLINE = "2026-09-22T09:10:00.000Z";

	function prewarmed(leaseTtlMs = 30 * 60_000) {
		store.createVoiceSchedule(reservation());
		store.reserveVoiceScheduleSession({
			scheduleId: SCHEDULE_ID,
			expectedRevision: 1,
			updatedAt: PREWARM_AT,
			reservation: {
				sessionId: SESSION_ID,
				mode: "meeting",
				projectName: "flywheel",
				leadId: "lead-a",
				guildId: "100000000000000001",
				voiceChannelId: "100000000000000002",
				voiceBotUserId: "100000000000000005",
				requestedBy: "founder",
				credentialTier: "master",
				createdAt: PREWARM_AT,
				scheduleId: SCHEDULE_ID,
				scheduleRevision: 1,
				notBeforeLiveAt: MEETING_AT,
				presenceDeadlineAt: DEADLINE,
			},
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
			leaseTtlMs,
		})!;
		store.setVoiceSessionState({
			sessionId: SESSION_ID,
			leaseToken: lease.leaseToken,
			state: "warming",
			now: PREWARM_AT,
		});
		return lease.leaseToken;
	}

	// The reaper only fires strictly after the deadline, so the race is at the
	// first tick past it — which is also the first instant the daemon is allowed
	// to report the absence.
	const AFTER_DEADLINE = "2026-09-22T09:10:03.000Z";

	it("leaves a booking alone while its daemon is still alive to settle it", () => {
		const leaseToken = prewarmed();

		store.reapStrandedVoiceSchedules(AFTER_DEADLINE);

		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "prewarming",
		});
		// The daemon then reports the normal outcome and it survives.
		expect(
			store.setVoiceSessionState({
				sessionId: SESSION_ID,
				leaseToken,
				state: "ended",
				reason: "no_human",
				now: AFTER_DEADLINE,
			}),
		).toBe(true);
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "ended",
		});
	});

	it("still reaps a booking whose daemon let its lease lapse, and revokes the session", () => {
		// Lease expires well before the deadline: nobody is coming back for this.
		prewarmed(60_000);

		expect(store.reapStrandedVoiceSchedules(AFTER_DEADLINE)).toBe(1);

		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "failed",
			terminalReason: "presence_deadline_passed",
		});
		// The launch intent must go with it; an abandoned session left desired
		// keeps asking launchd to start a bot for a meeting that is over.
		expect(store.getVoiceSession(SESSION_ID)?.state).not.toBe("warming");
	});
});

/**
 * FLY-2701 review R3 (MEDIUM): review R2 taught the reaper to wait for a daemon
 * that is still renewing its lease, because that daemon is about to report the
 * real outcome. But a live lease proves the *owner* is alive, not that it is
 * still making progress: `SessionLifetime` renews on its own timer, so a
 * warming session whose main flow hung would renew forever and hold the booking
 * and the room slot with it. The wait needs a ceiling.
 */
describe("StateStore reaper grace has a ceiling", () => {
	const DEADLINE = "2026-09-22T09:10:00.000Z";

	function warmingWithLongLease() {
		store.createVoiceSchedule(reservation());
		store.reserveVoiceScheduleSession({
			scheduleId: SCHEDULE_ID,
			expectedRevision: 1,
			updatedAt: PREWARM_AT,
			reservation: {
				sessionId: SESSION_ID,
				mode: "meeting",
				projectName: "flywheel",
				leadId: "lead-a",
				guildId: "100000000000000001",
				voiceChannelId: "100000000000000002",
				voiceBotUserId: "100000000000000005",
				requestedBy: "founder",
				credentialTier: "master",
				createdAt: PREWARM_AT,
				scheduleId: SCHEDULE_ID,
				scheduleRevision: 1,
				notBeforeLiveAt: MEETING_AT,
				presenceDeadlineAt: DEADLINE,
			},
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
			// A daemon that keeps renewing: the lease always looks fresh.
			leaseTtlMs: 24 * 60 * 60_000,
		})!;
		store.setVoiceSessionState({
			sessionId: SESSION_ID,
			leaseToken: lease.leaseToken,
			state: "warming",
			now: PREWARM_AT,
		});
	}

	it("still waits inside the reporting window", () => {
		warmingWithLongLease();

		expect(store.reapStrandedVoiceSchedules("2026-09-22T09:10:30.000Z")).toBe(
			0,
		);
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "prewarming",
		});
	});

	it("converges a booking whose daemon renews forever but never reports", () => {
		warmingWithLongLease();

		// Well past the deadline plus the reporting window: the daemon is alive
		// and useless, and the meeting slot cannot stay hostage to it.
		expect(store.reapStrandedVoiceSchedules("2026-09-22T09:30:00.000Z")).toBe(
			1,
		);
		expect(store.getVoiceSchedule(SCHEDULE_ID)).toMatchObject({
			state: "failed",
			terminalReason: "presence_deadline_passed",
		});
		expect(store.getVoiceSession(SESSION_ID)?.state).not.toBe("warming");
	});
});

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessRound } from "./business-round.js";

const roots: string[] = [];
const now = Date.parse("2026-09-16T03:00:00Z");
const source = {
	messageId: "111111111111111111",
	channelId: "222222222222222222",
	authorId: "777777777777777777",
	body: "明天和工程 Lead 核对交付风险。",
	observedAt: now,
};
const meeting = {
	meetingId: "12345678-1234-4234-8234-123456789abc",
	revision: 1,
	title: "交付风险",
	startsAt: "2026-09-17T03:00:00Z",
	participants: [{ project: "flywheel", leadId: "eng" }],
	status: "scheduled",
};
const input = {
	schemaVersion: 2,
	kind: "meeting",
	source,
	founderUserId: source.authorId,
	meeting,
	durationMinutes: 30,
	directory: {
		projectsDigest: "a".repeat(64),
		leads: [
			{
				ref: { project: "flywheel", leadId: "eng" },
				external: false,
				botUserId: "333333333333333333",
				displayName: "工程 Lead",
				roundtableChannel: "444444444444444444",
			},
		],
	},
};
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "meeting-round-"));
	roots.push(root);
	return { root, round: new BusinessRound(root, () => now) };
}
function record(
	round: BusinessRound,
	v: { operationId: string; revision: number },
	result: object,
) {
	return round.record({
		schemaVersion: 2,
		operationId: v.operationId,
		expectedRevision: v.revision,
		tool: "current_turn",
		callId: String(v.revision),
		result,
	});
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("durable meeting planning", () => {
	it("freezes the original source and standard record and resumes the same UUID", () => {
		const { root, round } = fixture(),
			v = round.prepare(input);
		expect(v).toMatchObject({
			stage: "scheduled",
			material: {
				record: {
					schemaVersion: 2,
					id: meeting.meetingId,
					status: "scheduled",
				},
				meetingRevision: 1,
			},
		});
		expect(new BusinessRound(root, () => now).prepare(input)).toEqual(v);
		expect(() =>
			round.prepare({ ...input, meeting: { ...meeting, title: "changed" } }),
		).toThrow(/binding/);
	});
	it("applies a source change once and preserves old revisions across reschedule and cancellation", () => {
		const { round } = fixture(),
			v = round.prepare(input),
			change = {
				...source,
				messageId: "555555555555555555",
				body: "改到后天。",
			};
		const changed = record(round, v, {
			action: "reschedule",
			source: change,
			startsAt: "2026-09-18T03:00:00Z",
			durationMinutes: 45,
		});
		expect(changed).toMatchObject({
			stage: "scheduled",
			material: {
				meetingRevision: 2,
				record: {
					id: meeting.meetingId,
					scheduledAt: "2026-09-18T03:00:00Z",
					durationMinutes: 45,
				},
			},
		});
		expect(
			record(round, changed, {
				action: "reschedule",
				source: change,
				startsAt: "2026-09-18T03:00:00Z",
				durationMinutes: 45,
			}),
		).toEqual(changed);
		const cancelled = record(round, changed, {
			action: "cancel",
			source: { ...change, messageId: "666666666666666666", body: "取消。" },
		});
		expect(cancelled).toMatchObject({
			stage: "cancelled",
			material: {
				meetingRevision: 3,
				record: {
					id: meeting.meetingId,
					status: "cancelled",
					endedAt: new Date(now).toISOString(),
				},
			},
		});
		expect((cancelled.material?.history as unknown[]).length).toBe(2);
	});
	it("keeps calendar success independent from notification and rejects stale revision receipts", () => {
		const { round } = fixture(),
			v = round.prepare(input);
		expect(() =>
			record(round, v, {
				action: "calendar",
				meetingRevision: 2,
				status: "synced",
				eventId: "calendar-1",
			}),
		).toThrow(/revision/);
		const synced = record(round, v, {
			action: "calendar",
			meetingRevision: 1,
			status: "synced",
			eventId: "calendar-1",
		});
		expect(synced.material?.calendar).toMatchObject({
			status: "synced",
			eventId: "calendar-1",
		});
		expect(synced.material?.notification).toBeUndefined();
		const unknown = record(round, synced, {
			action: "calendar",
			meetingRevision: 1,
			status: "unknown",
			reason: "timeout",
		});
		expect(unknown.material?.calendar).toMatchObject({
			eventId: "calendar-1",
			status: "unknown",
		});
		const changed = record(round, unknown, {
			action: "reschedule",
			source: { ...source, messageId: "555555555555555555", body: "改期" },
			startsAt: "2026-09-18T03:00:00Z",
			durationMinutes: 30,
		});
		expect(changed.material?.calendar).toMatchObject({
			eventId: "calendar-1",
			status: "pending",
		});
	});
});

it("allows separate single-target UUIDs from one multi-target request", () => {
	const { round } = fixture();
	round.prepare(input);
	const second = {
		...meeting,
		meetingId: "12345678-1234-4234-8234-123456789abd",
		participants: [{ project: "other", leadId: "other" }],
	};
	expect(
		round.prepare({
			...input,
			meeting: second,
			directory: {
				projectsDigest: "b".repeat(64),
				leads: [
					{ ref: { project: "other", leadId: "other" }, external: false },
				],
			},
		}),
	).toMatchObject({ stage: "scheduled" });
	expect(() =>
		round.prepare({
			...input,
			meeting: {
				...meeting,
				meetingId: "12345678-1234-4234-8234-123456789abe",
			},
		}),
	).toThrow(/source/);
});

describe("meeting roundtable notification", () => {
	it("waits for sent and engagement-ready evidence without conflating calendar success", () => {
		const { round } = fixture(),
			v = round.prepare(input);
		const prepared = record(round, v, {
			action: "prepare_notification",
			meetingRevision: 1,
			directory: input.directory,
		});
		expect(prepared.next).toMatchObject({
			tool: "current_turn",
			arguments: { action: "send_meeting_notification" },
		});
		const notice = round.prepare(prepared.next?.arguments.input);
		expect(notice.next?.arguments.text).toContain("<@333333333333333333>");
		expect(() =>
			record(round, prepared, {
				action: "confirm_notification",
				meetingRevision: 1,
				notificationOperationId: notice.operationId,
			}),
		).toThrow(/confirmed/);
		const sent = round.record({
			schemaVersion: 2,
			operationId: notice.operationId,
			expectedRevision: notice.revision,
			tool: "lead_actions.discord_send",
			callId: "send",
			result: {
				project: "raya",
				leadId: "raya",
				target: "roundtable",
				eventId: notice.next?.arguments.eventId,
				status: "sent",
				engagement: "ready",
				messageId: "888888888888888888",
				threadId: "888888888888888888",
				channelId: "444444444444444444",
			},
		});
		const confirmed = record(round, prepared, {
			action: "confirm_notification",
			meetingRevision: 1,
			notificationOperationId: sent.operationId,
		});
		expect(confirmed.material?.notification).toMatchObject({
			status: "sent",
			messageId: "888888888888888888",
		});
		expect(confirmed.material?.calendar).toBeUndefined();
	});
	it("rejects old notification receipts after a new meeting revision", () => {
		const { round } = fixture(),
			v = round.prepare(input);
		const prepared = record(round, v, {
			action: "prepare_notification",
			meetingRevision: 1,
			directory: input.directory,
		});
		const changed = record(round, prepared, {
			action: "cancel",
			source: { ...source, messageId: "555555555555555555", body: "取消会议" },
		});
		expect(() =>
			record(round, changed, {
				action: "confirm_notification",
				meetingRevision: 1,
				notificationOperationId: "old",
			}),
		).toThrow(/revision/);
		const cancelled = record(round, changed, {
			action: "prepare_notification",
			meetingRevision: 2,
			directory: input.directory,
		});
		expect(cancelled.next?.arguments.input).toMatchObject({
			eventId: `meeting:${meeting.meetingId}:2:notice`,
			text: expect.stringContaining("取消"),
		});
	});
});

it("records unavailable contact data without discarding an already frozen notice", () => {
	const { round } = fixture(),
		v = round.prepare(input);
	const noContact = {
		...input.directory,
		leads: [{ ref: { project: "flywheel", leadId: "eng" }, external: false }],
	};
	const unavailable = record(round, v, {
		action: "prepare_notification",
		meetingRevision: 1,
		directory: noContact,
	});
	expect(unavailable.material?.notification).toMatchObject({
		status: "unavailable",
		reason: "roundtable_participant_unavailable",
	});
	const prepared = record(round, unavailable, {
		action: "prepare_notification",
		meetingRevision: 1,
		directory: input.directory,
	});
	expect(() =>
		record(round, prepared, {
			action: "prepare_notification",
			meetingRevision: 1,
			directory: noContact,
		}),
	).toThrow(/frozen/);
	expect(round.resume(prepared.operationId).material?.notification).toEqual(
		prepared.material?.notification,
	);
});

describe("trusted meeting activation", () => {
	it("persists starting for the public voice handoff", () => {
		const { root, round } = fixture(),
			v = round.prepare({
				...input,
				meeting: { ...meeting, startsAt: new Date(now).toISOString() },
			});
		const starting = record(round, v, {
			action: "begin_start",
			meetingRevision: 1,
		});
		expect(starting).toMatchObject({
			stage: "starting",
			material: {
				record: { status: "starting" },
				startProjection: { projected: true },
			},
		});
		expect(
			JSON.parse(readFileSync(join(root, "state/meeting.json"), "utf8")),
		).toMatchObject({ id: meeting.meetingId, status: "starting" });
		expect(round.resume(v.operationId)).toEqual(starting);
	});
	it("preserves a foreign current meeting and rejects symlinked slots", () => {
		const { root, round } = fixture(),
			v = round.prepare({
				...input,
				meeting: { ...meeting, startsAt: new Date(now).toISOString() },
			});
		const path = join(root, "state/meeting.json"),
			foreign = JSON.stringify({
				id: "12345678-1234-4234-8234-123456789abd",
				status: "live",
			});
		writeFileSync(path, foreign);
		expect(() =>
			record(round, v, { action: "begin_start", meetingRevision: 1 }),
		).toThrow(/occupied/);
		expect(readFileSync(path, "utf8")).toBe(foreign);
		rmSync(path);
		writeFileSync(join(root, "outside"), foreign);
		symlinkSync(join(root, "outside"), path);
		expect(() =>
			record(round, v, { action: "begin_start", meetingRevision: 1 }),
		).toThrow();
	});
	it("resumes the frozen projection after an interrupted write without changing its version", () => {
		const { root, round } = fixture(),
			v = round.prepare({
				...input,
				meeting: { ...meeting, startsAt: new Date(now).toISOString() },
			});
		const lock = join(root, "state/.meeting-write.lock");
		writeFileSync(lock, "held");
		expect(() =>
			record(round, v, { action: "begin_start", meetingRevision: 1 }),
		).toThrow(/locked/);
		rmSync(lock);
		const resumed = round.resume(v.operationId);
		expect(resumed).toMatchObject({
			stage: "starting",
			material: { meetingRevision: 1, startProjection: { projected: true } },
		});
		expect(
			JSON.parse(readFileSync(join(root, "state/meeting.json"), "utf8")).id,
		).toBe(meeting.meetingId);
	});
});

describe("public voice lifecycle receipts", () => {
	function starting() {
		const f = fixture();
		const v = f.round.prepare({
			...input,
			meeting: { ...meeting, startsAt: new Date(now).toISOString() },
		});
		return {
			...f,
			v: record(f.round, v, { action: "begin_start", meetingRevision: 1 }),
		};
	}
	it("reserves start once and treats accepted as starting until a bound live status", () => {
		const { round, v } = starting();
		const attempt = record(round, v, {
			action: "begin_voice_start",
			meetingRevision: 1,
		});
		expect(attempt.next?.arguments.command).toEqual([
			"voice-session",
			"start",
			"--meeting-id",
			meeting.meetingId,
			"--json",
		]);
		expect(round.resume(attempt.operationId).next?.arguments.command).toEqual([
			"voice-session",
			"status",
			"--meeting-id",
			meeting.meetingId,
			"--json",
		]);
		const accepted = record(round, attempt, {
			action: "voice_result",
			meetingRevision: 1,
			command: "start",
			exitCode: 0,
			body: { status: "accepted", sessionId: "session-1", state: "live" },
		});
		expect(accepted.stage).toBe("starting");
		const body = {
			sessionId: "session-1",
			meetingId: meeting.meetingId,
			mode: "meeting",
			projectName: "flywheel",
			leadId: "eng",
			state: "live",
			createdAt: new Date(now).toISOString(),
			updatedAt: new Date(now + 1).toISOString(),
			endedAt: null,
		};
		expect(() =>
			record(round, accepted, {
				action: "voice_result",
				meetingRevision: 1,
				command: "status",
				exitCode: 0,
				body: { ...body, meetingId: "foreign" },
			}),
		).toThrow(/binding/);
		expect(
			record(round, accepted, {
				action: "voice_result",
				meetingRevision: 1,
				command: "status",
				exitCode: 0,
				body,
			}),
		).toMatchObject({
			stage: "live",
			material: {
				record: {
					status: "live",
					voice: { sessionId: "session-1", state: "live" },
				},
			},
		});
	});
	it("rejects contradictory equal-time observations and reports uncertain calls", () => {
		const { round, v } = starting();
		const attempt = record(round, v, {
			action: "begin_voice_start",
			meetingRevision: 1,
		});
		expect(round.resume(attempt.operationId).needsReconciliation).toBe(true);
		const uncertain = record(round, attempt, {
			action: "voice_result",
			meetingRevision: 1,
			command: "start",
			exitCode: 2,
			body: {},
		});
		expect(uncertain.needsReconciliation).toBe(true);
		expect(() =>
			record(round, uncertain, {
				action: "begin_voice_start",
				meetingRevision: 1,
			}),
		).toThrow(/reconcile/);
		const body = {
			sessionId: "session-1",
			meetingId: meeting.meetingId,
			mode: "meeting",
			projectName: "flywheel",
			leadId: "eng",
			state: "live",
			createdAt: new Date(now).toISOString(),
			updatedAt: new Date(now + 1).toISOString(),
			endedAt: null,
		};
		const live = record(round, uncertain, {
			action: "voice_result",
			meetingRevision: 1,
			command: "status",
			exitCode: 0,
			body,
		});
		expect(() =>
			record(round, live, {
				action: "voice_result",
				meetingRevision: 1,
				command: "status",
				exitCode: 0,
				body: { ...body, state: "warming" },
			}),
		).toThrow(/stale|conflicting/);
		expect(() =>
			record(round, live, {
				action: "voice_result",
				meetingRevision: 1,
				command: "status",
				exitCode: 0,
				body: {
					...body,
					state: "ended",
					endedAt: new Date(now - 1).toISOString(),
					updatedAt: new Date(now + 2).toISOString(),
				},
			}),
		).toThrow(/endedAt/);
	});
	it("requires a founder stop source and final bound status before closing the meeting", () => {
		const { root, round, v } = starting();
		const attempt = record(round, v, {
			action: "begin_voice_start",
			meetingRevision: 1,
		});
		const accepted = record(round, attempt, {
			action: "voice_result",
			meetingRevision: 1,
			command: "start",
			exitCode: 0,
			body: { status: "accepted", sessionId: "session-1", state: "desired" },
		});
		const stop = record(round, accepted, {
			action: "begin_voice_stop",
			meetingRevision: 1,
			source: { ...source, messageId: "555555555555555555", body: "结束会议" },
		});
		expect(stop.next?.arguments.command).toEqual([
			"voice-session",
			"stop",
			"--meeting-id",
			meeting.meetingId,
			"--json",
		]);
		const stopping = record(round, stop, {
			action: "voice_result",
			meetingRevision: 1,
			command: "stop",
			exitCode: 0,
			body: { state: "ending" },
		});
		expect(stopping.stage).toBe("starting");
		const body = {
			sessionId: "session-1",
			meetingId: meeting.meetingId,
			mode: "meeting",
			projectName: "flywheel",
			leadId: "eng",
			state: "ended",
			createdAt: new Date(now).toISOString(),
			updatedAt: new Date(now + 2).toISOString(),
			endedAt: new Date(now + 2).toISOString(),
		};
		const ended = record(round, stopping, {
			action: "voice_result",
			meetingRevision: 1,
			command: "status",
			exitCode: 0,
			body,
		});
		expect(ended).toMatchObject({
			stage: "ended",
			material: { record: { status: "ended", endedAt: body.endedAt } },
		});
		const archiveDir = join(root, "state/meetings", meeting.meetingId);
		mkdirSync(archiveDir, { recursive: true });
		writeFileSync(join(archiveDir, "transcript.txt"), "existing transcript");
		writeFileSync(join(archiveDir, "meeting.json"), "{}");
		expect(() =>
			record(round, ended, { action: "archive_terminal", meetingRevision: 1 }),
		).toThrow(/changed/);
		expect(existsSync(join(root, "state/meeting.json"))).toBe(true);
		rmSync(join(archiveDir, "meeting.json"));
		const recovered = round.resume(ended.operationId);
		const archived = record(round, recovered, {
			action: "archive_terminal",
			meetingRevision: 1,
		});
		expect(archived.material?.archive).toMatchObject({ completed: true });
		expect(readFileSync(join(archiveDir, "transcript.txt"), "utf8")).toBe(
			"existing transcript",
		);
		expect(
			JSON.parse(readFileSync(join(archiveDir, "meeting.json"), "utf8")).status,
		).toBe("ended");
		expect(() =>
			record(round, archived, {
				action: "voice_result",
				meetingRevision: 1,
				command: "status",
				exitCode: 0,
				body,
			}),
		).toThrow(/archived/);
		expect(round.resume(archived.operationId).stage).toBe("ended");
		const next = round.prepare({
			...input,
			source: { ...source, messageId: "666666666666666666" },
			meeting: {
				...meeting,
				meetingId: "22345678-1234-4234-8234-123456789abc",
				startsAt: new Date(now).toISOString(),
			},
		});
		expect(
			record(round, next, { action: "begin_start", meetingRevision: 1 }).stage,
		).toBe("starting");
		expect(round.resume(archived.operationId).stage).toBe("ended");

		expect(() =>
			record(round, ended, {
				action: "voice_result",
				meetingRevision: 0,
				command: "status",
				exitCode: 0,
				body,
			}),
		).toThrow(/revision/);
	});
});

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BusinessRound } from "./business-round.js";
import { runCoSCommand } from "./cli.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const id = "f5e14717-049b-4d43-b58d-78f18cc1aebb";
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "legacy-meetings-"));
	roots.push(root);
	mkdirSync(join(root, "state/meetings/archive"), { recursive: true });
	const meeting = {
		meetingId: id,
		revision: 3,
		title: "Portfolio review",
		startsAt: "2026-09-09T17:00:00Z",
		participants: [{ project: "flywheel", leadId: "eng" }],
		status: "rescheduled",
		calendarEventId: "calendar-original",
		mailboxDeliveryId: "old-delivery",
	};
	const path = join(root, "state/meetings/current.json");
	writeFileSync(path, JSON.stringify(meeting));
	return { root, meeting, path };
}
async function command(root: string, args: string[]) {
	const lines: string[] = [];
	await runCoSCommand(args, { write: (line) => lines.push(line) }, root);
	return JSON.parse(lines[0]);
}
const apply = (root: string, digest: string) =>
	command(root, [
		"legacy-meetings-apply",
		"--digest",
		digest,
		"--flywheel-sha",
		"a".repeat(40),
		"--raya-sha",
		"b".repeat(40),
	]);
it("backs up and imports original meeting identity while preserving trusted voice and transcript bytes", async () => {
	const { root, path, meeting } = fixture(),
		raw = readFileSync(path, "utf8");
	const trusted = join(root, "state/meeting.json");
	writeFileSync(trusted, "trusted current voice record");
	mkdirSync(join(root, "state/meetings", id));
	const transcript = join(root, "state/meetings", id, "transcript.jsonl");
	writeFileSync(transcript, "original transcript\n");
	const plan = await command(root, ["legacy-meetings-plan"]);
	expect(plan.meetings).toMatchObject([
		{ meetingId: id, revision: 3, action: "reconcile" },
	]);
	const result = await apply(root, plan.digest);
	expect(result.operations).toEqual([`legacy-meeting:${id}`]);
	const view = new BusinessRound(root).resume(result.operations[0]);
	expect(view.material?.legacy).toEqual(meeting);
	expect(view.next?.arguments.action).toBe("reconcile_legacy_meeting");
	expect(await apply(root, plan.digest)).toEqual(result);
	expect(readFileSync(path, "utf8")).toBe(raw);
	expect(readFileSync(trusted, "utf8")).toBe("trusted current voice record");
	expect(readFileSync(transcript, "utf8")).toBe("original transcript\n");
});
it("preserves cancelled archive and rejects corrupt, stale, conflicting or symlink inventory", async () => {
	const { root, path, meeting } = fixture();
	const plan = await command(root, ["legacy-meetings-plan"]);
	writeFileSync(path, JSON.stringify({ ...meeting, revision: 4 }));
	await expect(apply(root, plan.digest)).rejects.toThrow(/changed/);
	writeFileSync(
		join(root, "state/meetings/archive", `${id}.json`),
		JSON.stringify({ ...meeting, status: "cancelled" }),
	);
	await expect(command(root, ["legacy-meetings-plan"])).rejects.toThrow(
		/conflict/,
	);
	rmSync(path);
	const archived = await command(root, ["legacy-meetings-plan"]);
	expect(archived.meetings[0].action).toBe("preserve_terminal");
	const imported = await apply(root, archived.digest);
	expect(
		new BusinessRound(root).resume(imported.operations[0]).next,
	).toBeNull();
	writeFileSync(path, "{broken");
	await expect(command(root, ["legacy-meetings-plan"])).rejects.toThrow();
	expect(readFileSync(path, "utf8")).toBe("{broken");
	rmSync(path);
	symlinkSync(join(root, "state/meetings/archive", `${id}.json`), path);
	await expect(command(root, ["legacy-meetings-plan"])).rejects.toThrow();
});

it("rejects unknown schema and malformed receipt fields without erasing the source", async () => {
	const { root, path, meeting } = fixture();
	for (const changed of [
		{ ...meeting, schemaVersion: 9 },
		{ ...meeting, calendarEventId: { id: "invented" } },
		{ ...meeting, status: "live" },
	]) {
		const raw = JSON.stringify(changed);
		writeFileSync(path, raw);
		await expect(command(root, ["legacy-meetings-plan"])).rejects.toThrow();
		expect(readFileSync(path, "utf8")).toBe(raw);
	}
});

it("adopts original revision and calendar into v2 without replaying an uncertain old notification", async () => {
	const { root, meeting } = fixture();
	const plan = await command(root, ["legacy-meetings-plan"]);
	await apply(root, plan.digest);
	const round = new BusinessRound(root, () =>
		Date.parse("2026-09-10T00:00:00Z"),
	);
	const receipt = adoptionReceipt(meeting);
	const adopted = round.record(receipt);
	expect(adopted.operationId).toBe(`meeting:${id}`);
	expect(adopted.material).toMatchObject({
		meetingRevision: 3,
		record: { schemaVersion: 2, id, status: "scheduled", durationMinutes: 30 },
		calendar: { status: "unknown", eventId: "calendar-original" },
		notification: { status: "legacy_unknown" },
	});
	expect(round.record(receipt)).toEqual(adopted);
	expect(
		new BusinessRound(root).resume(receipt.operationId).next?.arguments,
	).toMatchObject({ action: "resume", operationId: adopted.operationId });
	expect(await apply(root, plan.digest)).toEqual({
		digest: plan.digest,
		operations: [receipt.operationId],
	});
	expect(() =>
		round.record({
			schemaVersion: 2,
			operationId: adopted.operationId,
			expectedRevision: adopted.revision,
			tool: "current_turn",
			callId: "notice",
			result: {
				action: "prepare_notification",
				meetingRevision: 3,
				directory: receipt.result.directory,
			},
		}),
	).toThrow(/legacy.*notification/);
	expect(() =>
		round.record({
			...receipt,
			result: { ...receipt.result, durationMinutes: 45 },
		}),
	).toThrow(/binding/);
	const changed = round.record({
		schemaVersion: 2,
		operationId: adopted.operationId,
		expectedRevision: adopted.revision,
		tool: "current_turn",
		callId: "reschedule",
		result: {
			action: "reschedule",
			source: {
				...receipt.result.source,
				messageId: "666666666666666666",
				body: "改期会议",
			},
			startsAt: "2026-09-11T00:00:00Z",
			durationMinutes: 30,
		},
	});
	expect(changed.material).toMatchObject({
		meetingRevision: 4,
		calendar: { eventId: "calendar-original" },
	});
	const prepared = round.record({
		schemaVersion: 2,
		operationId: adopted.operationId,
		expectedRevision: changed.revision,
		tool: "current_turn",
		callId: "new-notice",
		result: {
			action: "prepare_notification",
			meetingRevision: 4,
			directory: receipt.result.directory,
		},
	});
	expect(prepared.material?.notification).toMatchObject({
		status: "pending",
		meetingRevision: 4,
	});
});
it("requires original metadata and refuses to replace an occupied trusted meeting slot", async () => {
	const { root, meeting } = fixture();
	await apply(root, (await command(root, ["legacy-meetings-plan"])).digest);
	const round = new BusinessRound(root);
	expect(() =>
		round.record({
			schemaVersion: 2,
			operationId: `legacy-meeting:${id}`,
			expectedRevision: 1,
			tool: "current_turn",
			callId: "adopt",
			result: { action: "adopt_legacy_meeting" },
		}),
	).toThrow();
	const trusted = join(root, "state/meeting.json");
	writeFileSync(trusted, JSON.stringify({ id, status: "live" }));
	expect(() => round.record(adoptionReceipt(meeting))).toThrow(
		/trusted meeting slot/,
	);
	expect(readFileSync(trusted, "utf8")).toBe(
		JSON.stringify({ id, status: "live" }),
	);
});

function adoptionReceipt(meeting: ReturnType<typeof fixture>["meeting"]) {
	return {
		schemaVersion: 2,
		operationId: `legacy-meeting:${id}`,
		expectedRevision: 1,
		tool: "current_turn",
		callId: "original-metadata",
		result: {
			action: "adopt_legacy_meeting",
			metadataSourceRef: "original-invitation:1",
			founderUserId: "111111111111111111",
			source: {
				messageId: "222222222222222222",
				channelId: "333333333333333333",
				authorId: "111111111111111111",
				body: "安排会议",
				observedAt: Date.parse("2026-09-08T00:00:00Z"),
			},
			durationMinutes: 30,
			directory: {
				projectsDigest: "a".repeat(64),
				leads: [
					{
						ref: meeting.participants[0],
						external: false,
						botUserId: "444444444444444444",
						roundtableChannel: "555555555555555555",
					},
				],
			},
		},
	};
}

it("adopts an explicitly observed trusted live record and queries its existing public session", async () => {
	const { root, meeting } = fixture();
	await apply(root, (await command(root, ["legacy-meetings-plan"])).digest);
	const { toMeetingRecord } = await import("./meeting-record.js");
	const { createHash } = await import("node:crypto");
	const receipt = adoptionReceipt(meeting),
		record = {
			...toMeetingRecord(meeting as Parameters<typeof toMeetingRecord>[0], {
				directory: receipt.result.directory,
				durationMinutes: 30,
				requestedBy: receipt.result.founderUserId,
				requestedAt: new Date(receipt.result.source.observedAt).toISOString(),
			}),
			status: "live",
			voice: { sessionId: "existing-session", state: "live" },
		};
	const raw = JSON.stringify(record),
		path = join(root, "state/meeting.json");
	writeFileSync(path, raw);
	const round = new BusinessRound(root);
	expect(() =>
		round.record({
			...receipt,
			result: { ...receipt.result, trustedRecordSha256: "0".repeat(64) },
		}),
	).toThrow(/observation changed/);
	const adopted = round.record({
		...receipt,
		result: {
			...receipt.result,
			trustedRecordSha256: createHash("sha256").update(raw).digest("hex"),
		},
	});
	expect(adopted.stage).toBe("live");
	expect(adopted.needsReconciliation).toBe(true);
	expect(adopted.next?.arguments.command).toEqual([
		"voice-session",
		"status",
		"--meeting-id",
		id,
		"--json",
	]);
	expect(readFileSync(path, "utf8")).toBe(raw);
	expect(new BusinessRound(root).resume(adopted.operationId).next).toEqual(
		adopted.next,
	);
	expect(() =>
		round.record({
			schemaVersion: 2,
			operationId: adopted.operationId,
			expectedRevision: adopted.revision,
			tool: "current_turn",
			callId: "wrong-session",
			result: {
				action: "voice_result",
				command: "status",
				meetingRevision: 3,
				exitCode: 0,
				body: {
					meetingId: id,
					mode: "meeting",
					projectName: "flywheel",
					leadId: "eng",
					sessionId: "another-session",
					state: "live",
					createdAt: "2026-09-09T17:00:00Z",
					updatedAt: "2026-09-09T17:01:00Z",
				},
			},
		}),
	).toThrow(/binding/);
	const observed = round.record({
		schemaVersion: 2,
		operationId: adopted.operationId,
		expectedRevision: adopted.revision,
		tool: "current_turn",
		callId: "real-status",
		result: {
			action: "voice_result",
			command: "status",
			meetingRevision: 3,
			exitCode: 0,
			body: {
				meetingId: id,
				mode: "meeting",
				projectName: "flywheel",
				leadId: "eng",
				sessionId: "existing-session",
				state: "live",
				createdAt: "2026-09-09T17:00:00Z",
				updatedAt: "2026-09-09T17:01:00Z",
			},
		},
	});
	expect(observed.material?.voice).toMatchObject({
		sessionId: "existing-session",
		state: "live",
		updatedAt: "2026-09-09T17:01:00Z",
	});
	expect(JSON.parse(readFileSync(path, "utf8")).voice).toEqual({
		sessionId: "existing-session",
		state: "live",
	});
});
it("adopts a trusted terminal archive without touching a newer current meeting or transcript", async () => {
	const { root, meeting } = fixture();
	await apply(root, (await command(root, ["legacy-meetings-plan"])).digest);
	const { toMeetingRecord } = await import("./meeting-record.js");
	const { createHash } = await import("node:crypto");
	const receipt = adoptionReceipt(meeting),
		record = {
			...toMeetingRecord(meeting as Parameters<typeof toMeetingRecord>[0], {
				directory: receipt.result.directory,
				durationMinutes: 30,
				requestedBy: receipt.result.founderUserId,
				requestedAt: new Date(receipt.result.source.observedAt).toISOString(),
			}),
			status: "ended",
			endedAt: "2026-09-09T17:30:00Z",
			voice: { sessionId: "existing-session", state: "ended" },
		};
	const raw = JSON.stringify(record),
		dir = join(root, "state/meetings", id);
	mkdirSync(dir);
	writeFileSync(join(dir, "meeting.json"), raw);
	writeFileSync(join(dir, "transcript.jsonl"), "original transcript\n");
	writeFileSync(join(root, "state/meeting.json"), "new current record");
	const round = new BusinessRound(root);
	const adopted = round.record({
		...receipt,
		result: {
			...receipt.result,
			trustedRecordSha256: createHash("sha256").update(raw).digest("hex"),
		},
	});
	expect(adopted).toMatchObject({
		stage: "ended",
		material: { archive: { completed: true } },
	});
	expect(new BusinessRound(root).resume(adopted.operationId).stage).toBe(
		"ended",
	);
	expect(readFileSync(join(root, "state/meeting.json"), "utf8")).toBe(
		"new current record",
	);
	expect(readFileSync(join(dir, "transcript.jsonl"), "utf8")).toBe(
		"original transcript\n",
	);
});

it("prepares an originally unavailable notification once with the same meeting revision", async () => {
	const { root, meeting, path } = fixture();
	const original = {
		...meeting,
		mailboxDeliveryId: undefined,
		notification: {
			status: "unavailable",
			reason: "lead_transport_not_available",
		},
	};
	writeFileSync(path, JSON.stringify(original));
	await apply(root, (await command(root, ["legacy-meetings-plan"])).digest);
	const round = new BusinessRound(root),
		receipt = adoptionReceipt(meeting),
		adopted = round.record(receipt);
	const request = {
		schemaVersion: 2,
		operationId: adopted.operationId,
		expectedRevision: adopted.revision,
		tool: "current_turn",
		callId: "notice",
		result: {
			action: "prepare_notification",
			meetingRevision: 3,
			directory: receipt.result.directory,
		},
	};
	const prepared = round.record(request);
	expect(prepared.material?.notification).toMatchObject({
		status: "pending",
		input: { eventId: `meeting:${id}:3:notice` },
	});
	const replay = round.record({
		...request,
		expectedRevision: prepared.revision,
	});
	expect(replay.material?.notification).toEqual(
		prepared.material?.notification,
	);
});

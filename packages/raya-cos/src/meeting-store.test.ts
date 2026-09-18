import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Meeting } from "./meeting.js";
import { MeetingStore } from "./meeting-store.js";

const roots: string[] = [];
const meeting: Meeting = {
	meetingId: "f5e14717-049b-4d43-b58d-78f18cc1aebb",
	revision: 1,
	title: "Portfolio review",
	startsAt: "2026-09-09T17:00:00.000Z",
	participants: [{ project: "flywheel", leadId: "flywheel-eng-lead" }],
	status: "scheduled",
	calendarEventId: "calendar-1",
};

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("MeetingStore", () => {
	it("atomically persists and archives business state", () => {
		const root = mkdtempSync(join(tmpdir(), "raya-meeting-"));
		roots.push(root);
		const store = new MeetingStore(root);
		store.writeCurrent(meeting);
		expect(store.readCurrent()).toEqual(meeting);
		expect(statSync(join(root, "meetings", "current.json")).mode & 0o777).toBe(
			0o600,
		);
		store.archive({ ...meeting, revision: 2, status: "cancelled" });
		expect(store.readCurrent()).toBeNull();
		expect(store.readArchive(meeting.meetingId)).toMatchObject({
			status: "cancelled",
			calendarEventId: "calendar-1",
		});
	});
});

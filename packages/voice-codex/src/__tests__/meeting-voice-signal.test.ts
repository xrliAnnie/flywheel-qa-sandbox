import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	readMeetingVoiceSignal,
	writeMeetingVoiceSignal,
} from "../meeting-voice-signal.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("meeting voice signal", () => {
	it("requires the current meeting and keeps ended terminal", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "flywheel-meeting-signal-"));
		roots.push(stateDir);
		const meetingId = "11111111-1111-4111-8111-111111111111";
		const bootId = "22222222-2222-4222-8222-222222222222";
		writeFileSync(
			join(stateDir, "meeting.json"),
			JSON.stringify({ id: meetingId }),
		);
		mkdirSync(join(stateDir, "meetings", meetingId), { recursive: true });
		writeMeetingVoiceSignal(stateDir, {
			schemaVersion: 1,
			meetingId,
			state: "ended",
			at: "2026-09-09T00:00:00.000Z",
			bootId,
			reason: "text-stop",
		});
		expect(readMeetingVoiceSignal(stateDir, meetingId)?.state).toBe("ended");
		expect(() =>
			writeMeetingVoiceSignal(stateDir, {
				schemaVersion: 1,
				meetingId,
				state: "interrupted",
				at: "2026-09-09T00:00:01.000Z",
				bootId,
				reason: "realtime_closed",
			}),
		).toThrow(/already terminal/);
	});

	it("rejects a stale timestamp and a mismatched meeting", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "flywheel-meeting-signal-"));
		roots.push(stateDir);
		const meetingId = "11111111-1111-4111-8111-111111111111";
		const bootId = "22222222-2222-4222-8222-222222222222";
		writeFileSync(
			join(stateDir, "meeting.json"),
			JSON.stringify({ id: meetingId }),
		);
		mkdirSync(join(stateDir, "meetings", meetingId), { recursive: true });
		writeMeetingVoiceSignal(stateDir, {
			schemaVersion: 1,
			meetingId,
			state: "live",
			at: "2026-09-09T00:00:02.000Z",
			bootId,
		});
		expect(() =>
			writeMeetingVoiceSignal(stateDir, {
				schemaVersion: 1,
				meetingId,
				state: "ready",
				at: "2026-09-09T00:00:01.000Z",
				bootId,
			}),
		).toThrow(/backwards/);
		expect(() =>
			readMeetingVoiceSignal(stateDir, "33333333-3333-4333-8333-333333333333"),
		).not.toThrow();
	});
});

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	canonicalizeMeetingStateDir,
	loadTrustedMeetingInputs,
	parseMeetingNotesConfig,
} from "../meeting-notes-config.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";

function yaml(root: string): string {
	return `meetingStateDir: ${root}
linear:
  team: FLY
  project: Flywheel
  meetingLabel: meeting
  departmentLabel: Flywheel-Product
dispatch:
  taskCategory: prd
  leadId: flywheel-product-lead
tickIntervalSeconds: 120
`;
}

const dirs: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "fly2033-config-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("meeting notes trusted config", () => {
	it("parses the pinned routing tuple and rejects unknown or duplicate keys", () => {
		const root = temp();
		expect(parseMeetingNotesConfig(yaml(root))).toEqual({
			meetingStateDir: root,
			linear: {
				team: "FLY",
				project: "Flywheel",
				meetingLabel: "meeting",
				departmentLabel: "Flywheel-Product",
			},
			dispatch: {
				taskCategory: "prd",
				leadId: "flywheel-product-lead",
			},
			tickIntervalSeconds: 120,
		});
		expect(() =>
			parseMeetingNotesConfig(`${yaml(root)}tickIntervalSeconds: 60\n`),
		).toThrow(/duplicate|unique/i);
		expect(() =>
			parseMeetingNotesConfig(`${yaml(root)}enabled: false\n`),
		).toThrow(/unknown.*enabled/i);
		expect(() =>
			parseMeetingNotesConfig(
				yaml(root).replace("meetingStateDir", "rayaStateDir"),
			),
		).toThrow(/unknown.*rayaStateDir/i);
	});

	it("rejects root, relative, missing, and symlinked meeting-state roots", () => {
		expect(() => parseMeetingNotesConfig(yaml("/"))).toThrow(/root/i);
		expect(() => parseMeetingNotesConfig(yaml("relative/state"))).toThrow(
			/absolute/i,
		);

		const root = temp();
		expect(
			canonicalizeMeetingStateDir(parseMeetingNotesConfig(yaml(root))),
		).toBe(realpathSync(root));
		expect(() =>
			canonicalizeMeetingStateDir(
				parseMeetingNotesConfig(yaml(join(root, "missing"))),
			),
		).toThrow(/does not exist/i);

		const link = join(temp(), "state-link");
		symlinkSync(root, link);
		expect(() =>
			canonicalizeMeetingStateDir(parseMeetingNotesConfig(yaml(link))),
		).toThrow(/symlink|canonical/i);
	});

	it("loads only regular, non-symlinked files under the canonical root and checks archive identity", () => {
		const root = temp();
		const meetingDir = join(root, "meetings", MEETING_ID);
		mkdirSync(meetingDir, { recursive: true });
		mkdirSync(join(root, "voice-evidence"), { recursive: true });
		const archive = {
			schemaVersion: 2,
			id: MEETING_ID,
			leadId: "flywheel-product-lead",
			topic: "topic",
			scheduledAt: "2026-08-29T17:00:00.000Z",
			durationMinutes: 30,
			requestedBy: "founder",
			requestedAt: "2026-08-29T16:00:00.000Z",
			status: "ended",
			endedAt: "2026-08-29T17:30:00.000Z",
			endReason: "she-left",
		};
		writeFileSync(join(meetingDir, "meeting.json"), JSON.stringify(archive));
		writeFileSync(
			join(meetingDir, "voice-signal.json"),
			JSON.stringify({
				schemaVersion: 1,
				meetingId: MEETING_ID,
				state: "ended",
				at: "2026-08-29T17:29:55.000Z",
				bootId: "22222222-2222-4222-8222-222222222222",
				reason: "she-left",
			}),
		);
		writeFileSync(join(root, "voice-evidence", "events.jsonl"), "");
		writeFileSync(
			join(meetingDir, "briefing.md"),
			"preparedAt: 2026-08-29T16:50:00.000Z\nvalidUntil: 2026-08-29T18:00:00.000Z\n",
		);

		const config = parseMeetingNotesConfig(yaml(root));
		const loaded = loadTrustedMeetingInputs(config, MEETING_ID);
		expect(loaded.meeting.id).toBe(MEETING_ID);
		expect(loaded.briefing).toContain("preparedAt:");
		expect(loaded.evidenceText).toBe("");

		writeFileSync(
			join(meetingDir, "meeting.json"),
			JSON.stringify({
				...archive,
				id: "33333333-3333-4333-8333-333333333333",
			}),
		);
		expect(() => loadTrustedMeetingInputs(config, MEETING_ID)).toThrow(
			/id mismatch/i,
		);

		writeFileSync(
			join(meetingDir, "meeting.json"),
			JSON.stringify({ ...archive, status: "scheduled", endedAt: undefined }),
		);
		expect(() => loadTrustedMeetingInputs(config, MEETING_ID)).toThrow(
			/archive status/i,
		);
	});

	it("rejects a symlinked evidence file even when its target is regular", () => {
		const root = temp();
		const meetingDir = join(root, "meetings", MEETING_ID);
		mkdirSync(meetingDir, { recursive: true });
		mkdirSync(join(root, "voice-evidence"), { recursive: true });
		writeFileSync(
			join(meetingDir, "meeting.json"),
			JSON.stringify({
				schemaVersion: 2,
				id: MEETING_ID,
				leadId: "lead",
				topic: "topic",
				scheduledAt: "2026-08-29T17:00:00.000Z",
				durationMinutes: 30,
				requestedBy: "founder",
				requestedAt: "2026-08-29T16:00:00.000Z",
				status: "ended",
				endedAt: "2026-08-29T17:30:00.000Z",
			}),
		);
		writeFileSync(
			join(meetingDir, "voice-signal.json"),
			JSON.stringify({
				schemaVersion: 1,
				meetingId: MEETING_ID,
				state: "interrupted",
				at: "2026-08-29T17:20:00.000Z",
				bootId: "22222222-2222-4222-8222-222222222222",
			}),
		);
		const outside = join(temp(), "events.jsonl");
		writeFileSync(outside, "");
		symlinkSync(outside, join(root, "voice-evidence", "events.jsonl"));
		expect(() =>
			loadTrustedMeetingInputs(parseMeetingNotesConfig(yaml(root)), MEETING_ID),
		).toThrow(/symlink/i);
	});

	it("rejects a symlink in an intermediate trusted-input path", () => {
		const root = temp();
		const realMeetings = join(root, "real-meetings");
		const meetingDir = join(realMeetings, MEETING_ID);
		mkdirSync(meetingDir, { recursive: true });
		writeFileSync(
			join(meetingDir, "meeting.json"),
			JSON.stringify({
				schemaVersion: 2,
				id: MEETING_ID,
				leadId: "lead",
				topic: "topic",
				scheduledAt: "2026-08-29T17:00:00.000Z",
				durationMinutes: 30,
				requestedBy: "founder",
				requestedAt: "2026-08-29T16:00:00.000Z",
				status: "ended",
				endedAt: "2026-08-29T17:30:00.000Z",
			}),
		);
		symlinkSync(realMeetings, join(root, "meetings"));

		expect(() =>
			loadTrustedMeetingInputs(parseMeetingNotesConfig(yaml(root)), MEETING_ID),
		).toThrow(/symlink/i);
	});
});

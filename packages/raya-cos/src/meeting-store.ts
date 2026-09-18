import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Meeting } from "./meeting.js";

const MEETING_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateMeeting(value: unknown): Meeting {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("meeting state is invalid");
	}
	const meeting = value as Meeting;
	if (
		!MEETING_ID.test(meeting.meetingId) ||
		!Number.isSafeInteger(meeting.revision) ||
		meeting.revision < 1 ||
		!meeting.title ||
		!Number.isFinite(Date.parse(meeting.startsAt)) ||
		!Array.isArray(meeting.participants) ||
		meeting.participants.length === 0 ||
		!meeting.participants.every((lead) => lead?.project && lead.leadId) ||
		!meeting.status
	) {
		throw new Error("meeting state is invalid");
	}
	return structuredClone(meeting);
}

export class MeetingStore {
	private readonly root: string;
	private readonly archiveRoot: string;
	private readonly currentPath: string;

	constructor(stateDir: string) {
		this.root = join(stateDir, "meetings");
		this.archiveRoot = join(this.root, "archive");
		this.currentPath = join(this.root, "current.json");
		mkdirSync(this.archiveRoot, { recursive: true, mode: 0o700 });
		chmodSync(this.root, 0o700);
		chmodSync(this.archiveRoot, 0o700);
	}

	readCurrent(): Meeting | null {
		if (!existsSync(this.currentPath)) return null;
		return validateMeeting(JSON.parse(readFileSync(this.currentPath, "utf8")));
	}

	writeCurrent(meeting: Meeting): void {
		this.atomicWrite(this.currentPath, validateMeeting(meeting));
	}

	readArchive(meetingId: string): Meeting | null {
		if (!MEETING_ID.test(meetingId)) throw new Error("meeting id is invalid");
		const path = join(this.archiveRoot, `${meetingId}.json`);
		if (!existsSync(path)) return null;
		return validateMeeting(JSON.parse(readFileSync(path, "utf8")));
	}

	archive(meeting: Meeting): void {
		const valid = validateMeeting(meeting);
		if (valid.status !== "cancelled") {
			throw new Error("only terminal meeting state can be archived");
		}
		this.atomicWrite(join(this.archiveRoot, `${valid.meetingId}.json`), valid);
		const current = this.readCurrent();
		if (
			current?.meetingId === valid.meetingId &&
			existsSync(this.currentPath)
		) {
			unlinkSync(this.currentPath);
		}
	}

	private atomicWrite(path: string, meeting: Meeting): void {
		const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
		let descriptor: number | undefined;
		try {
			descriptor = openSync(temporary, "wx", 0o600);
			writeFileSync(
				descriptor,
				`${JSON.stringify(meeting, null, 2)}\n`,
				"utf8",
			);
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			renameSync(temporary, path);
			chmodSync(path, 0o600);
		} catch (error) {
			if (descriptor !== undefined) closeSync(descriptor);
			if (existsSync(temporary)) unlinkSync(temporary);
			throw error;
		}
	}
}

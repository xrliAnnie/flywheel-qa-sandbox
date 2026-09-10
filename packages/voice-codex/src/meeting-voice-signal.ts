/**
 * Meeting voice-signal contract extracted from Raya
 * packages/contracts/src/meeting.ts at b1b5a64 (FLY-2446).
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface MeetingVoiceSignal {
	schemaVersion: 1;
	meetingId: string;
	state: "ready" | "live" | "interrupted" | "ended";
	at: string;
	bootId: string;
	reason?: string;
}

function pathFor(stateDir: string, meetingId: string): string {
	if (!UUID.test(meetingId))
		throw new Error("meeting voice signal meetingId must be a UUID");
	return join(stateDir, "meetings", meetingId, "voice-signal.json");
}

function validate(input: unknown): MeetingVoiceSignal {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("meeting voice signal must be an object");
	}
	const signal = input as MeetingVoiceSignal;
	if (signal.schemaVersion !== 1)
		throw new Error("meeting voice signal schemaVersion must be 1");
	if (!UUID.test(signal.meetingId) || !UUID.test(signal.bootId)) {
		throw new Error("meeting voice signal ids must be UUIDs");
	}
	if (
		Number.isNaN(Date.parse(signal.at)) ||
		new Date(signal.at).toISOString() !== signal.at
	) {
		throw new Error("meeting voice signal at must be canonical ISO-8601");
	}
	if (!new Set(["ready", "live", "interrupted", "ended"]).has(signal.state)) {
		throw new Error("meeting voice signal state is invalid");
	}
	if (
		signal.state === "ended" &&
		!new Set(["she-left", "text-stop", "voice-stop"]).has(signal.reason ?? "")
	) {
		throw new Error("meeting ended voice signal reason is invalid");
	}
	if (
		signal.state !== "ended" &&
		signal.reason !== undefined &&
		!signal.reason.trim()
	) {
		throw new Error("meeting voice signal reason is invalid");
	}
	return structuredClone(signal);
}

export function readMeetingVoiceSignal(
	stateDir: string,
	meetingId: string,
): MeetingVoiceSignal | null {
	const path = pathFor(stateDir, meetingId);
	if (!existsSync(path)) return null;
	try {
		const signal = validate(JSON.parse(readFileSync(path, "utf8")));
		if (signal.meetingId !== meetingId) throw new Error("id mismatch");
		return signal;
	} catch (error) {
		throw new Error(
			`meeting voice signal is corrupt: ${(error as Error).message}`,
		);
	}
}

export function writeMeetingVoiceSignal(
	stateDir: string,
	input: MeetingVoiceSignal,
): MeetingVoiceSignal {
	const signal = validate(input);
	const current = JSON.parse(
		readFileSync(join(stateDir, "meeting.json"), "utf8"),
	) as { id?: unknown };
	if (current.id !== signal.meetingId) {
		throw new Error("meeting voice signal has no matching current meeting");
	}
	const existing = readMeetingVoiceSignal(stateDir, signal.meetingId);
	if (existing?.state === "ended") {
		if (signal.state !== "ended" || signal.reason !== existing.reason) {
			throw new Error("meeting voice signal is already terminal");
		}
		return existing;
	}
	if (existing && Date.parse(signal.at) < Date.parse(existing.at)) {
		throw new Error("meeting voice signal cannot move backwards in time");
	}
	const path = pathFor(stateDir, signal.meetingId);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(signal, null, 2)}\n`, {
		mode: 0o600,
	});
	const fd = openSync(temporary, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	return signal;
}

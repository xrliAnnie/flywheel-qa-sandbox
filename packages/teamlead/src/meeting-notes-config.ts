import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import {
	type MeetingRecord,
	parseMeetingRecord,
} from "./meeting-notes-scheduler.js";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MeetingNotesConfig {
	meetingStateDir: string;
	linear: {
		team: string;
		project: string;
		meetingLabel: string;
		departmentLabel: string;
	};
	dispatch: {
		taskCategory: "prd";
		leadId: string;
	};
	tickIntervalSeconds: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	label: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key))
			throw new Error(`${label} has unknown key ${key}`);
	}
	for (const key of allowed) {
		if (!(key in value)) throw new Error(`${label}.${key} is required`);
	}
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value.trim();
}

export function parseMeetingNotesConfig(source: string): MeetingNotesConfig {
	const document = parseDocument(source, { uniqueKeys: true });
	if (document.errors.length > 0) {
		throw new Error(
			`meeting-notes config YAML invalid: ${document.errors.map((error) => error.message).join("; ")}`,
		);
	}
	const root = record(document.toJS(), "meeting-notes config");
	exactKeys(
		root,
		["meetingStateDir", "linear", "dispatch", "tickIntervalSeconds"],
		"meeting-notes config",
	);
	const meetingStateDir = string(root.meetingStateDir, "meetingStateDir");
	if (!isAbsolute(meetingStateDir))
		throw new Error("meetingStateDir must be absolute");
	if (resolve(meetingStateDir) === resolve(sep)) {
		throw new Error("meetingStateDir must not be the filesystem root");
	}

	const linear = record(root.linear, "linear");
	exactKeys(
		linear,
		["team", "project", "meetingLabel", "departmentLabel"],
		"linear",
	);
	const dispatch = record(root.dispatch, "dispatch");
	exactKeys(dispatch, ["taskCategory", "leadId"], "dispatch");
	const taskCategory = string(dispatch.taskCategory, "dispatch.taskCategory");
	if (taskCategory !== "prd") {
		throw new Error("dispatch.taskCategory must be prd");
	}
	if (
		typeof root.tickIntervalSeconds !== "number" ||
		!Number.isInteger(root.tickIntervalSeconds) ||
		root.tickIntervalSeconds < 30 ||
		root.tickIntervalSeconds > 3600
	) {
		throw new Error(
			"tickIntervalSeconds must be an integer between 30 and 3600",
		);
	}
	return {
		meetingStateDir,
		linear: {
			team: string(linear.team, "linear.team"),
			project: string(linear.project, "linear.project"),
			meetingLabel: string(linear.meetingLabel, "linear.meetingLabel"),
			departmentLabel: string(linear.departmentLabel, "linear.departmentLabel"),
		},
		dispatch: {
			taskCategory: "prd",
			leadId: string(dispatch.leadId, "dispatch.leadId"),
		},
		tickIntervalSeconds: root.tickIntervalSeconds,
	};
}

export function loadMeetingNotesConfig(path: string): MeetingNotesConfig {
	const info = lstatSync(path);
	if (info.isSymbolicLink() || !info.isFile()) {
		throw new Error(
			"meeting-notes config must be a regular non-symlinked file",
		);
	}
	return parseMeetingNotesConfig(readFileSync(path, "utf8"));
}

export function canonicalizeMeetingStateDir(
	config: MeetingNotesConfig,
): string {
	const configured = resolve(config.meetingStateDir);
	if (!existsSync(configured))
		throw new Error("meetingStateDir does not exist");
	const info = lstatSync(configured);
	if (info.isSymbolicLink())
		throw new Error("meetingStateDir must not be a symlink");
	if (!info.isDirectory())
		throw new Error("meetingStateDir must be a directory");
	const canonical = realpathSync(configured);
	if (canonical === sep)
		throw new Error("meetingStateDir must not be the filesystem root");
	return canonical;
}

function contained(root: string, file: string): boolean {
	const rel = relative(root, file);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function assertNoSymlinkComponents(root: string, path: string): void {
	const lexical = resolve(path);
	if (!contained(root, lexical)) {
		throw new Error(`trusted meeting input escapes the state root: ${path}`);
	}
	const rel = relative(root, lexical);
	let current = root;
	for (const component of rel.split(sep).filter(Boolean)) {
		current = join(current, component);
		if (lstatSync(current).isSymbolicLink()) {
			throw new Error(`trusted meeting input contains a symlink: ${current}`);
		}
	}
}

function readTrustedFile(
	root: string,
	path: string,
	options: { optional?: boolean } = {},
): string | null {
	if (!existsSync(path)) {
		if (options.optional) return null;
		throw new Error(`trusted meeting input does not exist: ${path}`);
	}
	assertNoSymlinkComponents(root, path);
	const info = lstatSync(path);
	if (info.isSymbolicLink())
		throw new Error(`trusted meeting input is a symlink: ${path}`);
	if (!info.isFile())
		throw new Error(`trusted meeting input is not a regular file: ${path}`);
	const canonical = realpathSync(path);
	if (!contained(root, canonical)) {
		throw new Error(
			`trusted meeting input escapes the canonical state root: ${path}`,
		);
	}
	return readFileSync(canonical, "utf8");
}

export interface TrustedMeetingInputs {
	root: string;
	meeting: MeetingRecord;
	signal: unknown | null;
	evidenceText: string;
	briefing: string | null;
}

function parseMeetingJson(text: string, label: string): MeetingRecord {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`${label} JSON is invalid: ${(error as Error).message}`);
	}
	return parseMeetingRecord(value);
}

function parseMeetingArchiveJson(text: string): MeetingRecord {
	const meeting = parseMeetingJson(text, "meeting archive");
	if (!new Set(["ended", "cancelled", "missed"]).has(meeting.status)) {
		throw new Error(
			`meeting archive status is not terminal: ${meeting.status}`,
		);
	}
	return meeting;
}

export function loadTrustedCurrentMeeting(
	config: MeetingNotesConfig,
): MeetingRecord | null {
	const root = canonicalizeMeetingStateDir(config);
	const text = readTrustedFile(root, join(root, "meeting.json"), {
		optional: true,
	});
	return text === null ? null : parseMeetingJson(text, "current meeting");
}

export function loadTrustedMeetingArchive(
	config: MeetingNotesConfig,
	meetingId: string,
): MeetingRecord {
	if (!UUID_RE.test(meetingId)) throw new Error("meeting_id must be a UUID");
	const root = canonicalizeMeetingStateDir(config);
	const text = readTrustedFile(
		root,
		join(root, "meetings", meetingId, "meeting.json"),
	);
	const meeting = parseMeetingArchiveJson(text!);
	if (meeting.id !== meetingId) throw new Error("meeting archive id mismatch");
	return meeting;
}

export function loadTrustedMeetingInputs(
	config: MeetingNotesConfig,
	meetingId: string,
): TrustedMeetingInputs {
	if (!UUID_RE.test(meetingId)) throw new Error("meeting_id must be a UUID");
	const root = canonicalizeMeetingStateDir(config);
	const meetingDirectory = join(root, "meetings", meetingId);
	const archiveText = readTrustedFile(
		root,
		join(meetingDirectory, "meeting.json"),
	);
	const meeting = parseMeetingArchiveJson(archiveText!);
	if (meeting.id !== meetingId) throw new Error("meeting archive id mismatch");

	const signalText = readTrustedFile(
		root,
		join(meetingDirectory, "voice-signal.json"),
		{ optional: true },
	);
	let signal: unknown | null = null;
	if (signalText !== null) {
		try {
			signal = JSON.parse(signalText);
		} catch (error) {
			throw new Error(
				`meeting voice signal JSON is invalid: ${(error as Error).message}`,
			);
		}
	}
	const evidenceText =
		readTrustedFile(root, join(root, "voice-evidence", "events.jsonl"), {
			optional: true,
		}) ?? "";
	const briefing = readTrustedFile(
		root,
		join(meetingDirectory, "briefing.md"),
		{
			optional: true,
		},
	);
	return { root, meeting, signal, evidenceText, briefing };
}

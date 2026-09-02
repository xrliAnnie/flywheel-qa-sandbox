import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	type Stats,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

export interface ManualSwitchFailureAuditInput {
	path: string;
	command: "use" | "next";
	profile: string | null;
	reasonCode: string;
	reason: string;
	actor: string;
}

function currentUid(): number {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("audit owner identity unavailable");
	return uid;
}

function validateAuditFile(stat: Stats, uid: number): void {
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.uid !== uid ||
		(stat.mode & 0o777) !== 0o600
	) {
		throw new Error("unsafe audit file (must be same-owner regular 0600 file)");
	}
}

function lstatIfPresent(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function appendManualSwitchFailureAudit(
	input: ManualSwitchFailureAuditInput,
): void {
	const uid = currentUid();
	mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
	const before = lstatIfPresent(input.path);
	if (before !== undefined) validateAuditFile(before, uid);

	const flags =
		constants.O_APPEND |
		constants.O_WRONLY |
		(constants.O_NOFOLLOW ?? 0) |
		(before === undefined ? constants.O_CREAT | constants.O_EXCL : 0);
	const fd = openSync(input.path, flags, 0o600);
	try {
		if (before === undefined) fchmodSync(fd, 0o600);
		const opened = fstatSync(fd);
		validateAuditFile(opened, uid);
		const named = lstatSync(input.path);
		validateAuditFile(named, uid);
		if (named.dev !== opened.dev || named.ino !== opened.ino) {
			throw new Error("audit file changed during open");
		}

		const record = {
			ts: new Date().toISOString(),
			cmd: input.command,
			profile: input.profile,
			phase: "entry",
			probeSummary: input.reasonCode,
			actor: input.actor,
			actorTrust: "untrusted_hint",
			exitCode: 1,
			details: {
				reasonCode: input.reasonCode,
				reason: input.reason,
			},
		};
		const line = `${JSON.stringify(record)}\n`;
		const bytes = Buffer.byteLength(line);
		if (writeSync(fd, line) !== bytes) throw new Error("short audit append");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

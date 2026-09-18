import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BODY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.body\.([0-9a-f]{64})\.md$/;
const MAX_BODY_BYTES = 16 * 1024;

export interface DailyReportBodyReference {
	bodyFile: string;
	bodySha256: string;
	bodyBytes: number;
}

function dailyReportDirectory(stateDir: string): string {
	return join(stateDir, "daily-report");
}

function hashBody(body: string): string {
	return createHash("sha256").update(body, "utf8").digest("hex");
}

function validateReference(reference: DailyReportBodyReference): void {
	const match = BODY_FILE_PATTERN.exec(reference.bodyFile);
	if (
		!match ||
		!SHA256_PATTERN.test(reference.bodySha256) ||
		match[2] !== reference.bodySha256 ||
		!Number.isSafeInteger(reference.bodyBytes) ||
		reference.bodyBytes < 1 ||
		reference.bodyBytes > MAX_BODY_BYTES
	) {
		throw new Error("daily report body reference is invalid");
	}
}

function atomicWriteOwnerOnly(path: string, contents: string): void {
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random()
		.toString(16)
		.slice(2)}`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx", 0o600);
		writeFileSync(descriptor, contents, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		if (existsSync(temporary)) unlinkSync(temporary);
		throw error;
	}
}

export function writeDailyReportBody(
	stateDir: string,
	date: string,
	body: string,
): DailyReportBodyReference {
	if (!DATE_PATTERN.test(date))
		throw new Error("daily report body date is invalid");
	const bodyBytes = Buffer.byteLength(body, "utf8");
	if (bodyBytes < 1 || bodyBytes > MAX_BODY_BYTES) {
		throw new Error("daily report body size is invalid");
	}
	const bodySha256 = hashBody(body);
	const bodyFile = `${date}.body.${bodySha256}.md`;
	const reference = { bodyFile, bodySha256, bodyBytes };
	const directory = dailyReportDirectory(stateDir);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, bodyFile);
	if (existsSync(path)) {
		if (readDailyReportBody(stateDir, reference) !== body) {
			throw new Error("daily report body content-address collision");
		}
		return reference;
	}
	atomicWriteOwnerOnly(path, body);
	return reference;
}

export function readDailyReportBody(
	stateDir: string,
	reference: DailyReportBodyReference,
): string {
	validateReference(reference);
	const body = readFileSync(
		join(dailyReportDirectory(stateDir), reference.bodyFile),
		"utf8",
	);
	if (
		Buffer.byteLength(body, "utf8") !== reference.bodyBytes ||
		hashBody(body) !== reference.bodySha256
	) {
		throw new Error("daily report body integrity check failed");
	}
	return body;
}

export function deleteDailyReportBody(
	stateDir: string,
	reference: DailyReportBodyReference,
): void {
	validateReference(reference);
	const path = join(dailyReportDirectory(stateDir), reference.bodyFile);
	if (existsSync(path)) unlinkSync(path);
}

export function pruneDailyReportBodies(
	stateDir: string,
	date: string,
	keepBodyFile: string,
): void {
	if (!DATE_PATTERN.test(date))
		throw new Error("daily report body date is invalid");
	const keepMatch = BODY_FILE_PATTERN.exec(keepBodyFile);
	if (keepMatch?.[1] !== date) {
		throw new Error("daily report body keep reference is invalid");
	}
	const directory = dailyReportDirectory(stateDir);
	if (!existsSync(directory)) return;
	for (const name of readdirSync(directory)) {
		const match = BODY_FILE_PATTERN.exec(name);
		if (match?.[1] !== date || name === keepBodyFile) continue;
		try {
			unlinkSync(join(directory, name));
		} catch (error) {
			console.error(
				`daily report stale body cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

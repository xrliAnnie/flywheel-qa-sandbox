/**
 * FLY-2891: durable hand-off for review-round write-backs the Bridge could not
 * take synchronously. One delivery = one file, published by an exclusive temp
 * write + rename under a random name, so no writer ever overwrites another and
 * the client never decides "same name means success". The Bridge's resident
 * reconciler ingests each file with the same validation/idempotency rules as
 * the HTTP route (duplicate → delete, conflict → quarantine, visible). No
 * shared log, no rewrite, no lock — and nothing here needs the runner alive.
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const REVIEW_ROUND_SPOOL_MAX_BYTES = 16 * 1024;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_ID_RE = /^[0-9A-Za-z-]{8,128}$/;
export const REVIEW_ROUND_SPOOL_FILE_RE =
	/^([0-9a-fA-F-]{36})\.(design|code)\.([0-9A-Za-z-]{8,128})\.(round|gate)\.([0-9a-f-]{36})\.json$/;

export interface ReviewRoundSpoolRecord {
	schemaVersion: 1;
	spooledAt: string;
	/** Why the synchronous delivery did not land (diagnostic only). */
	lastError?: string;
	/** The exact POST /review-rounds body. */
	body: Record<string, unknown>;
}

/** `$FLYWHEEL_STATE_DIR` is the Flywheel root (~/.flywheel) everywhere. */
export function reviewRoundSpoolDir(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const root = env.FLYWHEEL_STATE_DIR?.trim() || join(homedir(), ".flywheel");
	return join(root, "state", "review-round-spool");
}

export function reviewRoundQuarantineDir(spoolDir: string): string {
	return join(spoolDir, "quarantine");
}

function publish(dir: string, name: string, contents: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = join(dir, name);
	const temp = join(dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
	try {
		const fd = openSync(temp, "wx", 0o600);
		try {
			writeFileSync(fd, contents, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, target);
		return target;
	} finally {
		rmSync(temp, { force: true });
	}
}

/**
 * Spool one delivery. Throws (and writes nothing) on an identity that could
 * inject a path or a record the reconciler would refuse as oversized.
 */
export function writeReviewRoundSpoolRecord(
	spoolDir: string,
	body: Record<string, unknown>,
	opts: { lastError?: string; quarantineReason?: string } = {},
): string {
	const executionId = body.executionId;
	const turnId = body.codexTurnId;
	const reviewType = body.reviewType;
	if (typeof executionId !== "string" || !UUID_RE.test(executionId))
		throw new Error("review round spool: invalid execution id");
	if (typeof turnId !== "string" || !CODEX_ID_RE.test(turnId))
		throw new Error("review round spool: invalid Codex turn id");
	if (reviewType !== "design" && reviewType !== "code")
		throw new Error("review round spool: invalid review type");
	const record: ReviewRoundSpoolRecord = {
		schemaVersion: 1,
		spooledAt: new Date().toISOString(),
		...(opts.lastError ? { lastError: opts.lastError.slice(0, 500) } : {}),
		body,
	};
	const contents = JSON.stringify(record);
	if (Buffer.byteLength(contents) > REVIEW_ROUND_SPOOL_MAX_BYTES)
		throw new Error("review round spool: record too large");
	const segment = body.kind === "gate_acceptance" ? "gate" : "round";
	const name = `${executionId}.${reviewType}.${turnId}.${segment}.${randomUUID()}.json`;
	if (opts.quarantineReason !== undefined) {
		const dir = reviewRoundQuarantineDir(spoolDir);
		const path = publish(dir, name, contents);
		publish(dir, `${name}.reason`, `${opts.quarantineReason.slice(0, 1000)}\n`);
		return path;
	}
	return publish(spoolDir, name, contents);
}

export function parseReviewRoundSpoolFile(
	raw: string,
):
	| { ok: true; record: ReviewRoundSpoolRecord }
	| { ok: false; reason: string } {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "spool record is not valid JSON" };
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		return { ok: false, reason: "spool record must be an object" };
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1)
		return { ok: false, reason: "unsupported spool record schemaVersion" };
	if (
		!record.body ||
		typeof record.body !== "object" ||
		Array.isArray(record.body)
	)
		return { ok: false, reason: "spool record body must be an object" };
	return { ok: true, record: record as unknown as ReviewRoundSpoolRecord };
}

/** Only our own regular files are work; symlinks/foreign files are never read. */
function countRecords(dir: string): number {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return 0;
	}
	const uid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	return names.filter((name) => {
		if (!REVIEW_ROUND_SPOOL_FILE_RE.test(name)) return false;
		try {
			const stat = lstatSync(join(dir, name));
			return stat.isFile() && (uid === undefined || stat.uid === uid);
		} catch {
			return false;
		}
	}).length;
}

/** Pending (awaiting Bridge pickup) and quarantined (refused, kept) counts. */
export function countReviewRoundSpool(spoolDir: string): {
	pending: number;
	quarantined: number;
} {
	return {
		pending: countRecords(spoolDir),
		quarantined: countRecords(reviewRoundQuarantineDir(spoolDir)),
	};
}

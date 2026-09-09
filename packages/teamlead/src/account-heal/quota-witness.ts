import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

export const WITNESS_MAX_AGE_MS = 6 * 60 * 60_000;
export const WITNESS_MAX_FUTURE_MS = 5 * 60_000;

export interface QuotaWitness {
	version: 1;
	kind: "account_disabled";
	observedAt: number;
	source: "review_job" | "runner_pane";
	executionId?: string;
	evidenceDigest: string;
}

export type QuotaWitnessReadResult =
	| { status: "accepted"; witness: QuotaWitness }
	| {
			status: "rejected";
			reason:
				| "missing"
				| "symlink"
				| "owner"
				| "mode"
				| "unsafe_file"
				| "read_error"
				| "invalid"
				| "stale"
				| "future";
	  };

const WITNESS_KEYS = new Set([
	"version",
	"kind",
	"observedAt",
	"source",
	"executionId",
	"evidenceDigest",
]);
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_WITNESS_BYTES = 4_096;
const OWNER_ONLY_MODES = new Set([0o600, 0o400]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeText(value: unknown, maxBytes: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		Buffer.byteLength(value, "utf8") <= maxBytes &&
		!/[\p{Cc}\p{Cs}]/u.test(value) &&
		Buffer.from(value, "utf8").toString("utf8") === value
	);
}

function parseQuotaWitness(value: unknown): QuotaWitness | null {
	if (
		!isRecord(value) ||
		!Object.keys(value).every((key) => WITNESS_KEYS.has(key)) ||
		value.version !== 1 ||
		value.kind !== "account_disabled" ||
		!Number.isInteger(value.observedAt) ||
		typeof value.observedAt !== "number" ||
		value.observedAt < 0 ||
		(value.source !== "review_job" && value.source !== "runner_pane") ||
		(value.executionId !== undefined && !isSafeText(value.executionId, 200)) ||
		typeof value.evidenceDigest !== "string" ||
		!DIGEST.test(value.evidenceDigest)
	) {
		return null;
	}
	return {
		version: 1,
		kind: "account_disabled",
		observedAt: value.observedAt,
		source: value.source,
		...(value.executionId === undefined
			? {}
			: { executionId: value.executionId }),
		evidenceDigest: value.evidenceDigest,
	};
}

export function readQuotaWitness(
	path: string,
	opts: { uid: number; now: number },
): QuotaWitnessReadResult {
	let initial: ReturnType<typeof lstatSync>;
	try {
		initial = lstatSync(path);
	} catch (error) {
		return {
			status: "rejected",
			reason:
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? "missing"
					: "read_error",
		};
	}
	if (initial.isSymbolicLink())
		return { status: "rejected", reason: "symlink" };
	if (!initial.isFile() || initial.size > MAX_WITNESS_BYTES) {
		return { status: "rejected", reason: "unsafe_file" };
	}
	if (initial.uid !== opts.uid) return { status: "rejected", reason: "owner" };
	if (!OWNER_ONLY_MODES.has(initial.mode & 0o777)) {
		return { status: "rejected", reason: "mode" };
	}

	let fd: number | undefined;
	let raw: string;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.uid !== opts.uid) {
			return { status: "rejected", reason: "unsafe_file" };
		}
		if (!OWNER_ONLY_MODES.has(opened.mode & 0o777)) {
			return { status: "rejected", reason: "mode" };
		}
		raw = readFileSync(fd, "utf8");
	} catch {
		return { status: "rejected", reason: "read_error" };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	if (Buffer.byteLength(raw, "utf8") > MAX_WITNESS_BYTES) {
		return { status: "rejected", reason: "unsafe_file" };
	}

	let witness: QuotaWitness | null = null;
	try {
		witness = parseQuotaWitness(JSON.parse(raw));
	} catch {
		// Invalid JSON is an untrusted witness, not a daemon failure.
	}
	if (witness === null) return { status: "rejected", reason: "invalid" };
	if (witness.observedAt < opts.now - WITNESS_MAX_AGE_MS) {
		return { status: "rejected", reason: "stale" };
	}
	if (witness.observedAt > opts.now + WITNESS_MAX_FUTURE_MS) {
		return { status: "rejected", reason: "future" };
	}
	return { status: "accepted", witness };
}

export function writeQuotaWitness(path: string, value: QuotaWitness): void {
	const witness = parseQuotaWitness(value);
	if (witness === null) throw new Error("invalid quota witness");
	const body = `${JSON.stringify(witness)}\n`;
	if (Buffer.byteLength(body, "utf8") > MAX_WITNESS_BYTES) {
		throw new Error("quota witness exceeds size limit");
	}

	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const parentStat = lstatSync(parent);
	const uid = process.getuid?.();
	if (
		uid === undefined ||
		!parentStat.isDirectory() ||
		parentStat.isSymbolicLink() ||
		parentStat.uid !== uid ||
		(parentStat.mode & 0o022) !== 0
	) {
		throw new Error("unsafe quota witness directory");
	}
	if (existsSync(path)) {
		const existing = lstatSync(path);
		if (
			!existing.isFile() ||
			existing.isSymbolicLink() ||
			existing.uid !== uid
		) {
			throw new Error("unsafe existing quota witness");
		}
	}

	const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
	let fd: number | undefined;
	try {
		fd = openSync(
			tmp,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
			0o600,
		);
		const bytes = Buffer.from(body);
		if (writeSync(fd, bytes) !== bytes.length) {
			throw new Error("short quota witness write");
		}
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
		const parentFd = openSync(parent, constants.O_RDONLY);
		try {
			fsyncSync(parentFd);
		} finally {
			closeSync(parentFd);
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(tmp);
		} catch {
			// Best-effort cleanup must not mask write or rename failures.
		}
	}
}

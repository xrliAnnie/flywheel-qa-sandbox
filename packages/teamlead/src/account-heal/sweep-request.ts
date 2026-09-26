/**
 * FLY-2830 — "please re-read every Claude account now".
 *
 * After any account switch (Claude or Codex, manual or automatic) the Bridge
 * writes this one small file and wakes the quota monitor; the monitor's next
 * round reads the active account and sweeps every readable candidate, then
 * records the request id in its own state (quota-monitor-state.ts). The file
 * carries no free text: an id, a time and a closed-set reason.
 *
 * Reading is fail-closed and total: anything that is not exactly this shape —
 * a symlink, an oversized or unknown-keyed file, a future or day-old stamp — is
 * "no request" (logged once), never an error that stops the monitor.
 */

import { randomUUID as nodeRandomUUID } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { preparePrivateDirectory } from "../private-directory.js";

export type SweepRequestReason = "codex_switch" | "claude_switch";

export interface SweepRequest {
	schemaVersion: 1;
	requestId: string;
	requestedAt: string;
	reason: SweepRequestReason;
}

const MAX_BYTES = 4 * 1024;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_AGE_MS = 24 * 60 * 60_000;
const KEYS = new Set(["schemaVersion", "requestId", "requestedAt", "reason"]);
const REASONS: ReadonlySet<string> = new Set<SweepRequestReason>([
	"codex_switch",
	"claude_switch",
]);
export const SWEEP_REQUEST_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function defaultSweepRequestPath(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	const override = env.FLYWHEEL_CLAUDE_SWEEP_REQUEST_PATH?.trim();
	if (override) return override;
	const stateDir = env.FLYWHEEL_STATE_DIR?.trim() || join(home, ".flywheel");
	return join(stateDir, "claude-quota", "sweep-request.json");
}

function canonicalInstant(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const ms = Date.parse(value);
	return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

export function writeSweepRequest(
	input: { reason: SweepRequestReason },
	opts: {
		path?: string;
		now?: () => number;
		randomUUID?: () => string;
	} = {},
): SweepRequest {
	if (!REASONS.has(input.reason))
		throw new Error("sweep_request_reason_invalid");
	const requestId = (opts.randomUUID ?? nodeRandomUUID)();
	if (!SWEEP_REQUEST_ID_RE.test(requestId))
		throw new Error("sweep_request_id_invalid");
	const request: SweepRequest = {
		schemaVersion: 1,
		requestId,
		requestedAt: new Date((opts.now ?? Date.now)()).toISOString(),
		reason: input.reason,
	};
	const path = opts.path ?? defaultSweepRequestPath();
	// FLY-2830 R2: never follow a symlinked parent.
	preparePrivateDirectory(dirname(path));
	const temp = `${path}.tmp-${process.pid}-${requestId}`;
	try {
		const fd = openSync(temp, "wx", 0o600);
		try {
			writeSync(fd, `${JSON.stringify(request)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, path);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			/* the temp file was never created or is already gone */
		}
		throw error;
	}
	return request;
}

export function readSweepRequest(
	opts: {
		path?: string;
		now?: () => number;
		log?: (line: string) => void;
	} = {},
): SweepRequest | null {
	const path = opts.path ?? defaultSweepRequestPath();
	const invalid = (reason: string): null => {
		opts.log?.(`[sweep-request] invalid reason=${reason}`);
		return null;
	};
	let fd: number;
	try {
		// O_NOFOLLOW: a symlink at the path is refused by the kernel (ELOOP).
		fd = openSync(
			path,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
		);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		return invalid(code === "ELOOP" ? "not_regular_file" : "unreadable");
	}
	let text: string;
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return invalid("not_regular_file");
		if (stat.size > MAX_BYTES) return invalid("oversized");
		const buffer = Buffer.alloc(MAX_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = readSync(fd, buffer, length, buffer.length - length, null);
			if (read === 0) break;
			length += read;
		}
		if (length > MAX_BYTES) return invalid("oversized");
		text = buffer.subarray(0, length).toString("utf8");
	} catch {
		return invalid("unreadable");
	} finally {
		closeSync(fd);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return invalid("not_json");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return invalid("not_object");
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== KEYS.size ||
		!Object.keys(record).every((key) => KEYS.has(key))
	)
		return invalid("keys");
	if (record.schemaVersion !== 1) return invalid("schema_version");
	if (
		typeof record.requestId !== "string" ||
		!SWEEP_REQUEST_ID_RE.test(record.requestId)
	)
		return invalid("request_id");
	if (typeof record.reason !== "string" || !REASONS.has(record.reason))
		return invalid("reason");
	if (!canonicalInstant(record.requestedAt)) return invalid("requested_at");
	const nowMs = (opts.now ?? Date.now)();
	const at = Date.parse(record.requestedAt);
	if (at > nowMs + MAX_FUTURE_SKEW_MS) return invalid("requested_at_future");
	if (at < nowMs - MAX_AGE_MS) return invalid("requested_at_expired");
	return {
		schemaVersion: 1,
		requestId: record.requestId,
		requestedAt: record.requestedAt,
		reason: record.reason as SweepRequestReason,
	};
}

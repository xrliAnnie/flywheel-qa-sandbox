/**
 * Claude-specific wire codec for mailbox JSON files.
 *
 * Per plan v1.27.1 §2.0.6 (Codex r1 #1 + r2 #1 + r3 #4 + r4 #1 + r5 #1):
 *
 * - Wire envelope = top-level `TeammateMessage[]` array matching stock claude-code
 *   schema (`teammateMailbox.ts:43-50`): `{ from, text, timestamp, read, color?, summary? }`.
 * - Cooperates with stock `proper-lockfile` protocol — same `${inboxPath}.lock`
 *   path, same `LOCK_OPTIONS = { retries: { retries: 10, minTimeout: 5, maxTimeout: 100 } }`.
 * - Pre-lock invariant: `ensureFileExists(inboxPath, "[]")` (proper-lockfile
 *   requires target to exist). Stock uses `writeFile(..., { flag: "wx" })` +
 *   catch `EEXIST`; we mirror.
 * - Atomic main write: temp + rename within the lock-protected critical section.
 * - Sidecar two-phase: dedupe check + pending insert under sidecar lock; main
 *   write under inbox lock; finalize pending under sidecar lock.
 *
 * **Idempotency contract** (Codex r4 high #1):
 * - Caller-provided `metadata.flywheelId` is the stable opaque idempotency key.
 * - On `write()`, sidecar dedupe check + pending insert happens in the SAME
 *   sidecar-lock critical section (Codex r5 low #1 — atomic check-and-insert).
 * - Replay (same flywheelId) → sidecar HIT → skip write + return idempotent success.
 * - No flywheelId → best-effort write (sidecar marked `idempotency: "best-effort"`).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { type MailboxPayload, MailboxWriteError } from "../types.js";

// Stock claude-code lock options. MUST match exactly (see plan §2.0.6).
const LOCK_OPTIONS = {
	retries: {
		retries: 10,
		minTimeout: 5,
		maxTimeout: 100,
	},
} as const;

/** Stock claude-code wire shape — `teammateMailbox.ts:43-50`. */
export interface TeammateMessage {
	from: string;
	text: string;
	timestamp: string; // ISO-8601 (stock format)
	read: boolean;
	color?: string;
	summary?: string;
}

/** Sidecar record (one per write, append-only JSONL). */
export interface SidecarRecord {
	flywheelId: string;
	status: "pending" | "finalized";
	idempotency: "stable" | "best-effort";
	/** sha256(from|to|text|timestamp) — used to find matching main entry on repair. */
	payloadFingerprint: string;
	/** unix ms — when sidecar pending was inserted. */
	pendingAt: number;
	/** unix ms — set when finalized. */
	finalizedAt?: number;
	/** Reference to main entry — `from` + ISO `timestamp` — for repair. */
	mainEntryRef?: { from: string; timestamp: string };
}

export interface WriteSpec {
	inboxPath: string;
	sidecarPath: string;
	/** Sender-side caller-provided opaque idempotency key. Optional → best-effort. */
	flywheelId?: string;
	/** Sender-side payload — `to` is implicit in `inboxPath`. */
	payload: MailboxPayload;
	/** Optional sender color (claude-code UI hint). */
	color?: string;
	/** Optional 5-10 word summary (claude-code UI preview). */
	summary?: string;
}

export interface WriteOutcome {
	flywheelId?: string;
	idempotent: boolean;
	wroteAt: number;
}

/**
 * Write a message to a claude-code-compatible mailbox file with full
 * lock cooperation + sidecar idempotency.
 *
 * **Idempotency**:
 * - If `spec.flywheelId` is set AND the sidecar already contains an entry
 *   with that id (pending or finalized), returns `{ idempotent: true }` and
 *   writes nothing.
 * - Otherwise inserts sidecar pending → writes main → finalizes sidecar.
 *
 * Throws `MailboxWriteError` on lock timeout, permission denied, missing
 * dir, or corrupted JSON.
 */
export async function writeMailboxEntry(
	spec: WriteSpec,
): Promise<WriteOutcome> {
	// Validate parent dir exists; lazy mkdir for ephemeral test dirs.
	await mkdir(dirname(spec.inboxPath), { recursive: true });

	// Sender-side timestamp — stock format is ISO-8601 string.
	const wroteAtMs = Date.now();
	const timestampIso = new Date(wroteAtMs).toISOString();

	const fingerprint = computeFingerprint({
		from: spec.payload.from,
		to: spec.payload.to,
		text: spec.payload.content,
		timestamp: timestampIso,
	});

	// ----- Phase A: sidecar dedupe check + pending insert (same lock) -----
	if (spec.flywheelId !== undefined) {
		const dedupeOutcome = await sidecarCheckAndInsertPending({
			sidecarPath: spec.sidecarPath,
			flywheelId: spec.flywheelId,
			payloadFingerprint: fingerprint,
			pendingAt: wroteAtMs,
		});
		if (dedupeOutcome.idempotent) {
			return {
				flywheelId: spec.flywheelId,
				idempotent: true,
				wroteAt: wroteAtMs,
			};
		}
	} else {
		// Best-effort write — record sidecar marker but skip dedupe entirely.
		await sidecarAppendBestEffort({
			sidecarPath: spec.sidecarPath,
			payloadFingerprint: fingerprint,
			pendingAt: wroteAtMs,
		});
	}

	// ----- Phase B: lock-cooperative main file write -----
	const newEntry: TeammateMessage = {
		from: spec.payload.from,
		text: spec.payload.content,
		timestamp: timestampIso,
		read: false,
		...(spec.color !== undefined && { color: spec.color }),
		...(spec.summary !== undefined && { summary: spec.summary }),
	};

	await writeMainEntryUnderLock({
		inboxPath: spec.inboxPath,
		recipient: extractRecipientFromInboxPath(spec.inboxPath),
		newEntry,
	});

	// ----- Phase C: finalize sidecar pending (same id, status → finalized) -----
	if (spec.flywheelId !== undefined) {
		await sidecarFinalize({
			sidecarPath: spec.sidecarPath,
			flywheelId: spec.flywheelId,
			finalizedAt: Date.now(),
			mainEntryRef: { from: spec.payload.from, timestamp: timestampIso },
		});
	}

	return {
		flywheelId: spec.flywheelId,
		idempotent: false,
		wroteAt: wroteAtMs,
	};
}

/**
 * Mark all matching entries as `read=true`. Lock-cooperative with stock
 * `markMessagesAsRead`. Caller passes a predicate to scope which entries to
 * flip — typically `(m) => messageIds.has(`${m.from}:${m.timestamp}`)`.
 *
 * Returns the count of entries that were actually flipped (i.e. matched +
 * weren't already read).
 */
export async function markEntriesAsReadUnderLock(args: {
	inboxPath: string;
	predicate: (entry: TeammateMessage) => boolean;
}): Promise<number> {
	await ensureFileExists(args.inboxPath, "[]");
	const lockPath = `${args.inboxPath}.lock`;
	let flipped = 0;
	await withFileLock(args.inboxPath, lockPath, async () => {
		const messages = await readMailboxEntries(args.inboxPath);
		const next = messages.map((m) => {
			if (args.predicate(m) && !m.read) {
				flipped++;
				return { ...m, read: true };
			}
			return m;
		});
		if (flipped > 0) {
			const tempPath = `${args.inboxPath}.tmp.${process.pid}.${Date.now()}.${Math.random()
				.toString(36)
				.slice(2, 8)}`;
			await writeFile(tempPath, JSON.stringify(next, null, 2), "utf-8");
			await rename(tempPath, args.inboxPath);
		}
	});
	return flipped;
}

/** Read all messages from inbox file. Returns [] if file doesn't exist. */
export async function readMailboxEntries(
	inboxPath: string,
): Promise<TeammateMessage[]> {
	try {
		const content = await readFile(inboxPath, "utf-8");
		const parsed = JSON.parse(content);
		if (!Array.isArray(parsed)) {
			throw new MailboxWriteError(
				`Inbox is not an array at ${inboxPath}`,
				"corrupted_json",
				inboxPath,
				false,
			);
		}
		return parsed as TeammateMessage[];
	} catch (error) {
		if (isErrno(error, "ENOENT")) {
			return [];
		}
		if (error instanceof MailboxWriteError) {
			throw error;
		}
		throw new MailboxWriteError(
			`Failed to read inbox at ${inboxPath}: ${(error as Error).message}`,
			"corrupted_json",
			inboxPath,
			false,
			{ cause: error as Error },
		);
	}
}

/** Compute content-derived fingerprint (sha256 hex of canonical concat). */
export function computeFingerprint(args: {
	from: string;
	to: string;
	text: string;
	timestamp: string;
}): string {
	return createHash("sha256")
		.update(`${args.from}|${args.to}|${args.text}|${args.timestamp}`)
		.digest("hex");
}

// ============================================================================
// Sidecar (JSONL — one record per line)
// ============================================================================

async function sidecarReadRecords(
	sidecarPath: string,
): Promise<SidecarRecord[]> {
	try {
		const content = await readFile(sidecarPath, "utf-8");
		const records: SidecarRecord[] = [];
		for (const line of content.split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				records.push(JSON.parse(line) as SidecarRecord);
			} catch {
				// Skip corrupt lines; ops alert handled at higher layer.
			}
		}
		return records;
	} catch (error) {
		if (isErrno(error, "ENOENT")) {
			return [];
		}
		throw error;
	}
}

interface SidecarCheckArgs {
	sidecarPath: string;
	flywheelId: string;
	payloadFingerprint: string;
	pendingAt: number;
}

interface SidecarCheckOutcome {
	idempotent: boolean;
}

/**
 * Atomic check-and-insert: if `flywheelId` already in sidecar (pending or
 * finalized), return `{ idempotent: true }` without inserting. Otherwise
 * append a `pending` record. Both happen under the SAME sidecar lock per
 * Codex r5 low #1.
 */
async function sidecarCheckAndInsertPending(
	args: SidecarCheckArgs,
): Promise<SidecarCheckOutcome> {
	await mkdir(dirname(args.sidecarPath), { recursive: true });

	// Ensure sidecar file exists (proper-lockfile requirement).
	await ensureFileExists(args.sidecarPath, "");

	const lockPath = `${args.sidecarPath}.lock`;
	return withFileLock(args.sidecarPath, lockPath, async () => {
		const existing = await sidecarReadRecords(args.sidecarPath);
		const hit = existing.find((r) => r.flywheelId === args.flywheelId);
		if (hit) {
			return { idempotent: true };
		}

		const pendingRecord: SidecarRecord = {
			flywheelId: args.flywheelId,
			status: "pending",
			idempotency: "stable",
			payloadFingerprint: args.payloadFingerprint,
			pendingAt: args.pendingAt,
		};

		await appendJsonLine(args.sidecarPath, pendingRecord);
		return { idempotent: false };
	});
}

interface SidecarBestEffortArgs {
	sidecarPath: string;
	payloadFingerprint: string;
	pendingAt: number;
}

async function sidecarAppendBestEffort(
	args: SidecarBestEffortArgs,
): Promise<void> {
	await mkdir(dirname(args.sidecarPath), { recursive: true });
	await ensureFileExists(args.sidecarPath, "");

	const lockPath = `${args.sidecarPath}.lock`;
	await withFileLock(args.sidecarPath, lockPath, async () => {
		const record: SidecarRecord = {
			// Use fingerprint as id when caller didn't provide one. We add a
			// per-call random suffix so multiple best-effort writes with the
			// same payload don't collide on key (callers know they aren't
			// asking for dedupe).
			flywheelId: `${args.payloadFingerprint}:be:${args.pendingAt}:${Math.random().toString(36).slice(2, 8)}`,
			status: "pending",
			idempotency: "best-effort",
			payloadFingerprint: args.payloadFingerprint,
			pendingAt: args.pendingAt,
		};
		await appendJsonLine(args.sidecarPath, record);
	});
}

interface SidecarFinalizeArgs {
	sidecarPath: string;
	flywheelId: string;
	finalizedAt: number;
	mainEntryRef: { from: string; timestamp: string };
}

async function sidecarFinalize(args: SidecarFinalizeArgs): Promise<void> {
	const lockPath = `${args.sidecarPath}.lock`;
	await withFileLock(args.sidecarPath, lockPath, async () => {
		const records = await sidecarReadRecords(args.sidecarPath);
		const updated = records.map((r) =>
			r.flywheelId === args.flywheelId && r.status === "pending"
				? {
						...r,
						status: "finalized" as const,
						finalizedAt: args.finalizedAt,
						mainEntryRef: args.mainEntryRef,
					}
				: r,
		);
		await rewriteJsonLines(args.sidecarPath, updated);
	});
}

// ============================================================================
// Main inbox file write (lock-cooperative + atomic temp+rename)
// ============================================================================

interface WriteMainArgs {
	inboxPath: string;
	recipient: string;
	newEntry: TeammateMessage;
}

async function writeMainEntryUnderLock(args: WriteMainArgs): Promise<void> {
	// Pre-lock invariant (Codex r3 medium #4): file must exist.
	await ensureFileExists(args.inboxPath, "[]");

	const lockPath = `${args.inboxPath}.lock`;
	try {
		await withFileLock(args.inboxPath, lockPath, async () => {
			// Re-read after lock acquired (matches stock pattern at
			// teammateMailbox.ts:171).
			const messages = await readMailboxEntries(args.inboxPath);
			messages.push(args.newEntry);

			// Atomic temp + rename for crash safety beyond stock semantics.
			// Atomic-rename within the locked critical section ALSO
			// serializes vs cross-process readers (stock claude-code
			// markMessagesAsRead holds the same lock — see plan §2.0.6).
			const tempPath = `${args.inboxPath}.tmp.${process.pid}.${Date.now()}.${Math.random()
				.toString(36)
				.slice(2, 8)}`;
			await writeFile(tempPath, JSON.stringify(messages, null, 2), "utf-8");
			await rename(tempPath, args.inboxPath);
		});
	} catch (error) {
		if (error instanceof MailboxWriteError) throw error;
		throw new MailboxWriteError(
			`Failed to write to inbox for ${args.recipient}: ${(error as Error).message}`,
			"unknown",
			args.recipient,
			isErrno(error, "EACCES") ? false : true,
			{ cause: error as Error },
		);
	}
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * In-process async mutex per lockfile path.
 *
 * proper-lockfile rejects with ELOCKED immediately on intra-process re-entry
 * (same Node process trying to lock a file it already holds — see
 * `proper-lockfile/lib/lockfile.js:68`). The `retries` option only handles
 * stale cross-process locks. We need a per-path in-memory queue to serialize
 * concurrent same-process callers BEFORE we hit proper-lockfile, and let
 * proper-lockfile handle cross-process synchronization (e.g. with stock
 * claude-code's `markMessagesAsRead`).
 */
const intraProcessQueues = new Map<string, Promise<unknown>>();

function withIntraProcessQueue<T>(
	lockfilePath: string,
	fn: () => Promise<T>,
): Promise<T> {
	const previous = intraProcessQueues.get(lockfilePath) ?? Promise.resolve();
	const next = previous.then(fn, fn).finally(() => {
		// Clear if no later waiter chained.
		if (intraProcessQueues.get(lockfilePath) === current) {
			intraProcessQueues.delete(lockfilePath);
		}
	});
	const current: Promise<T> = next;
	intraProcessQueues.set(lockfilePath, current);
	return current;
}

async function acquireLock(
	target: string,
	lockfilePath: string,
): Promise<() => Promise<void>> {
	try {
		return await lockfile.lock(target, {
			lockfilePath,
			...LOCK_OPTIONS,
		});
	} catch (error) {
		throw new MailboxWriteError(
			`Failed to acquire lock at ${lockfilePath}: ${(error as Error).message}`,
			"lock_timeout",
			target,
			true,
			{ cause: error as Error },
		);
	}
}

/**
 * Run `fn` while holding both:
 *  1. An intra-process mutex (per lockfile path) — serializes same-process callers.
 *  2. proper-lockfile cross-process lock — serializes vs other processes
 *     (e.g. stock claude-code).
 *
 * Always releases both locks even if `fn` throws.
 */
async function withFileLock<T>(
	target: string,
	lockfilePath: string,
	fn: () => Promise<T>,
): Promise<T> {
	return withIntraProcessQueue(lockfilePath, async () => {
		const release = await acquireLock(target, lockfilePath);
		try {
			return await fn();
		} finally {
			await release();
		}
	});
}

/**
 * Create file with `flag: "wx"` (exclusive create, fail if exists). Catches
 * EEXIST silently (file already exists is fine). Creates parent dir
 * recursively if missing.
 *
 * Mirrors stock claude-code pattern at teammateMailbox.ts:148-161 (with the
 * extra parent-dir mkdir).
 */
export async function ensureFileExists(
	filePath: string,
	initialContent: string,
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	try {
		await writeFile(filePath, initialContent, {
			encoding: "utf-8",
			flag: "wx",
		});
	} catch (error) {
		if (!isErrno(error, "EEXIST")) {
			throw error;
		}
	}
}

async function appendJsonLine(filePath: string, record: object): Promise<void> {
	const line = `${JSON.stringify(record)}\n`;
	const existing = await readFile(filePath, "utf-8").catch(() => "");
	await writeFile(filePath, existing + line, "utf-8");
}

async function rewriteJsonLines(
	filePath: string,
	records: object[],
): Promise<void> {
	const lines = records.map((r) => JSON.stringify(r)).join("\n");
	const content = lines.length > 0 ? `${lines}\n` : "";
	const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
	await writeFile(tempPath, content, "utf-8");
	await rename(tempPath, filePath);
}

function extractRecipientFromInboxPath(inboxPath: string): string {
	// `<...>/inboxes/<agent>.json` → `<agent>`
	const filename = inboxPath.split("/").pop() ?? "";
	return filename.replace(/\.json$/, "");
}

function isErrno(error: unknown, expected: string): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === expected
	);
}

// Used in tests only — exposed for the path-helpers ergonomics.
export const __testing = { LOCK_OPTIONS, sidecarReadRecords, statSafe };

async function statSafe(p: string): Promise<{ exists: boolean; size: number }> {
	try {
		const s = await stat(p);
		return { exists: true, size: s.size };
	} catch {
		return { exists: false, size: 0 };
	}
}

// Re-export join for test helpers.
export { join };

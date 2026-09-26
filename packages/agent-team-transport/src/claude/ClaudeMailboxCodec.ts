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
import {
	pruneMainEntries,
	pruneSidecarRecords,
	resolvePrunePolicy,
	updateOverflowMarker,
} from "./mailbox-prune.js";

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
	/**
	 * For idempotent returns: was the prior write reaching `finalized` state
	 * in the sidecar (true) or still `pending` (false)? Per Codex r2 PR 1.3
	 * HIGH #1, callers (e.g. MailboxTransport.writeVerified) need this to
	 * decide whether to skip verifyLastWrite — finalized = safe to skip
	 * (durable in main even if no longer last); pending = unsafe to skip
	 * (main may still be empty, in-flight writer hasn't finalized).
	 *
	 * For non-idempotent (we just wrote): always true (Phase C finalize
	 * runs synchronously before this returns).
	 */
	finalized: boolean;
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
	// Best-effort writes (no caller-provided flywheelId): generate a
	// per-call surrogate id so we can finalize after Phase B (Codex r1
	// medium #3 fix — best-effort records were never finalized, leaving
	// dangling pending entries). The surrogate is unique per write attempt
	// (timestamp+random suffix) so it never collides with a stable
	// caller-provided key.
	const isBestEffort = spec.flywheelId === undefined;
	const effectiveFlywheelId =
		spec.flywheelId ??
		`${fingerprint}:be:${wroteAtMs}:${Math.random().toString(36).slice(2, 8)}`;

	if (!isBestEffort) {
		const dedupeOutcome = await sidecarCheckAndInsertPending({
			sidecarPath: spec.sidecarPath,
			flywheelId: effectiveFlywheelId,
			payloadFingerprint: fingerprint,
			pendingAt: wroteAtMs,
		});
		if (dedupeOutcome.idempotent) {
			// Surface finalized state to callers — Codex r2 PR 1.3 HIGH #1.
			// `dedupeOutcome.finalized` is true for confirmed durable hits,
			// false for recent-pending hits where main may still be empty.
			return {
				flywheelId: effectiveFlywheelId,
				idempotent: true,
				wroteAt: wroteAtMs,
				finalized: dedupeOutcome.finalized ?? false,
			};
		}
	} else {
		// Best-effort: insert a sidecar pending record (under lock, but no
		// dedupe check — surrogate id never collides). Will be finalized
		// after Phase B.
		await sidecarAppendBestEffortPending({
			sidecarPath: spec.sidecarPath,
			flywheelId: effectiveFlywheelId,
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

	// ----- Phase C: finalize sidecar pending → finalized (always, including
	// best-effort writes per Codex r1 medium #3) -----
	await sidecarFinalize({
		sidecarPath: spec.sidecarPath,
		flywheelId: effectiveFlywheelId,
		finalizedAt: Date.now(),
		mainEntryRef: { from: spec.payload.from, timestamp: timestampIso },
	});

	return {
		// Caller sees the id they passed in, or undefined for best-effort
		// (the surrogate id is internal — exposing it would falsely suggest
		// dedupe support).
		flywheelId: spec.flywheelId,
		idempotent: false,
		// We just completed Phase B (main write) + Phase C (sidecar finalize)
		// synchronously. Always finalized for non-idempotent path.
		finalized: true,
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
	const policy = resolvePrunePolicy();
	const lockPath = `${args.inboxPath}.lock`;
	let flipped = 0;
	// Return overflow info from the locked critical section so control-flow
	// analysis sees the assignment (assigning a captured `let` inside the
	// async callback would not narrow the type for the post-lock read).
	const overflow = await withFileLock(args.inboxPath, lockPath, async () => {
		const messages = await readMailboxEntries(args.inboxPath);
		const next = messages.map((m) => {
			if (args.predicate(m) && !m.read) {
				flipped++;
				return { ...m, read: true };
			}
			return m;
		});
		// FLY-182: prune read entries inside the same lock (zero extra lock).
		const pruned = pruneMainEntries(next, policy, Date.now());
		// Write when we flipped a read flag OR dropped any old read entry.
		if (flipped > 0 || pruned.droppedCount > 0) {
			const tempPath = `${args.inboxPath}.tmp.${process.pid}.${Date.now()}.${Math.random()
				.toString(36)
				.slice(2, 8)}`;
			await writeFile(tempPath, JSON.stringify(pruned.kept, null, 2), "utf-8");
			await rename(tempPath, args.inboxPath);
		}
		return {
			unreadCount: pruned.unreadCount,
			oldestUnreadTs: pruned.oldestUnreadTs,
		};
	});
	// FLY-182: update unread-overflow marker outside the lock (best-effort).
	await updateOverflowMarker({
		inboxPath: args.inboxPath,
		unreadCount: overflow.unreadCount,
		oldestUnreadTs: overflow.oldestUnreadTs,
		policy,
		now: Date.now(),
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

/**
 * Find the sidecar record for a given `flywheelId`. Used by adapters to verify
 * a specific write landed without relying on main-file "last entry" semantics
 * (which races under concurrent writers — Codex Round 1 HIGH finding on
 * PR #186).
 *
 * Returns the most recent matching record (records are append-only; later
 * `finalized` lines supersede earlier `pending` lines for the same id).
 * Returns `null` when no record exists or the sidecar file is missing.
 */
export async function sidecarFindByFlywheelId(
	sidecarPath: string,
	flywheelId: string,
): Promise<SidecarRecord | null> {
	const records = await sidecarReadRecords(sidecarPath);
	let match: SidecarRecord | null = null;
	for (const r of records) {
		if (r.flywheelId !== flywheelId) continue;
		// Prefer finalized over pending; otherwise keep most recent.
		if (!match || r.status === "finalized") {
			match = r;
		}
	}
	return match;
}

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
	/**
	 * For idempotent: true returns, was the existing record finalized
	 * (`true`) or pending (`false`)? Per Codex r2 PR 1.3 HIGH #1 — surfaces
	 * sidecar state to writeMailboxEntry so callers can distinguish durable
	 * idempotent hits from in-flight pending hits.
	 *
	 * For idempotent: false returns: undefined (not applicable; main write
	 * proceeds and Phase C finalize will set the outer WriteOutcome.finalized).
	 */
	finalized?: boolean;
}

/** Pending records older than this are considered stale (Codex r1 high #2). */
const PENDING_STALE_THRESHOLD_MS = 60_000;

/**
 * Atomic check-and-insert with pending-aware repair (Codex r1 high #2 fix).
 *
 * Old behavior (broken): any existing record with this `flywheelId` (pending
 * OR finalized) returned `idempotent: true`. If Phase B failed after Phase A
 * pending insert, the next retry would silently skip the main file write
 * and report success → message lost.
 *
 * New behavior:
 *  - **Finalized hit** → genuine idempotency, return `idempotent: true`
 *  - **Pending + recent (< 60s)** → another concurrent writer is mid-flight;
 *    return `idempotent: true` and let it complete (caller's retry comes
 *    back to a finalized record next time)
 *  - **Pending + stale (>= 60s)** → previous attempt died after pending insert
 *    but before finalize; replace it with a fresh pending record and proceed
 *    to Phase B (this retry actually writes)
 *  - **No record** → insert pending, proceed
 *
 * All happens under the SAME sidecar lock per Codex r5 low #1 (atomic
 * check-and-insert).
 */
async function sidecarCheckAndInsertPending(
	args: SidecarCheckArgs,
): Promise<SidecarCheckOutcome> {
	await mkdir(dirname(args.sidecarPath), { recursive: true });
	await ensureFileExists(args.sidecarPath, "");

	const lockPath = `${args.sidecarPath}.lock`;
	return withFileLock(args.sidecarPath, lockPath, async () => {
		const existing = await sidecarReadRecords(args.sidecarPath);
		const hit = existing.find((r) => r.flywheelId === args.flywheelId);

		if (hit) {
			if (hit.status === "finalized") {
				// Confirmed prior write succeeded — genuine idempotency hit.
				return { idempotent: true, finalized: true };
			}
			// Pending hit — could be either (a) concurrent in-flight writer,
			// or (b) crashed previous attempt that never finalized.
			const ageMs = args.pendingAt - hit.pendingAt;
			if (ageMs < PENDING_STALE_THRESHOLD_MS) {
				// Recent: assume concurrent writer, defer to it. Caller's
				// retry will see finalized record next time around.
				// finalized: false signals to wrappers (MailboxTransport) that
				// the main file may still be empty — DO NOT skip verify.
				return { idempotent: true, finalized: false };
			}
			// Stale: prior attempt died. Drop the dead pending record and
			// re-insert as fresh pending so this retry actually writes.
			const filtered = existing.filter((r) => r.flywheelId !== args.flywheelId);
			const fresh: SidecarRecord = {
				flywheelId: args.flywheelId,
				status: "pending",
				idempotency: "stable",
				payloadFingerprint: args.payloadFingerprint,
				pendingAt: args.pendingAt,
			};
			await rewriteJsonLines(args.sidecarPath, [...filtered, fresh]);
			return { idempotent: false };
		}

		// No record — insert pending and proceed.
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
	flywheelId: string;
	payloadFingerprint: string;
	pendingAt: number;
}

/**
 * Insert a best-effort sidecar `pending` record under lock (no dedupe check
 * — caller's surrogate id never collides). This is paired with a
 * `sidecarFinalize` call after the main write succeeds, so best-effort
 * writes leave finalized records (Codex r1 medium #3 fix) rather than
 * dangling pending entries.
 */
async function sidecarAppendBestEffortPending(
	args: SidecarBestEffortArgs,
): Promise<void> {
	await mkdir(dirname(args.sidecarPath), { recursive: true });
	await ensureFileExists(args.sidecarPath, "");

	const lockPath = `${args.sidecarPath}.lock`;
	await withFileLock(args.sidecarPath, lockPath, async () => {
		const record: SidecarRecord = {
			flywheelId: args.flywheelId,
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
		// FLY-182: prune old finalized sidecar records inside the same lock
		// (idempotency-first — within-retention finalized are never dropped).
		const pruned = pruneSidecarRecords(
			updated,
			resolvePrunePolicy(),
			Date.now(),
		);
		await rewriteJsonLines(args.sidecarPath, pruned);
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

	const policy = resolvePrunePolicy();
	const lockPath = `${args.inboxPath}.lock`;
	let overflow: { unreadCount: number; oldestUnreadTs: number | null };
	try {
		// Return overflow info from the locked section (see note in
		// markEntriesAsReadUnderLock — direct assignment from `await` narrows
		// correctly; a callback-captured `let` would not).
		overflow = await withFileLock(args.inboxPath, lockPath, async () => {
			// Re-read after lock acquired (matches stock pattern at
			// teammateMailbox.ts:171).
			const messages = await readMailboxEntries(args.inboxPath);
			messages.push(args.newEntry);

			// FLY-182: prune read entries inside the lock (zero extra lock).
			// Never drops unread; preserves original order (only old read
			// dropped). This bounds the file so writeVerified stays fast.
			const pruned = pruneMainEntries(messages, policy, Date.now());

			// Atomic temp + rename for crash safety beyond stock semantics.
			// Atomic-rename within the locked critical section ALSO
			// serializes vs cross-process readers (stock claude-code
			// markMessagesAsRead holds the same lock — see plan §2.0.6).
			const tempPath = `${args.inboxPath}.tmp.${process.pid}.${Date.now()}.${Math.random()
				.toString(36)
				.slice(2, 8)}`;
			await writeFile(tempPath, JSON.stringify(pruned.kept, null, 2), "utf-8");
			await rename(tempPath, args.inboxPath);
			return {
				unreadCount: pruned.unreadCount,
				oldestUnreadTs: pruned.oldestUnreadTs,
			};
		});
	} catch (error) {
		if (error instanceof MailboxWriteError) throw error;
		throw new MailboxWriteError(
			`Failed to write to inbox for ${args.recipient}: ${(error as Error).message}`,
			"unknown",
			args.recipient,
			!isErrno(error, "EACCES"),
			{ cause: error as Error },
		);
	}

	// FLY-182: update unread-overflow marker outside the lock (best-effort,
	// never throws — exposes "Lead not consuming" without dropping unread).
	await updateOverflowMarker({
		inboxPath: args.inboxPath,
		unreadCount: overflow.unreadCount,
		oldestUnreadTs: overflow.oldestUnreadTs,
		policy,
		now: Date.now(),
	});
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

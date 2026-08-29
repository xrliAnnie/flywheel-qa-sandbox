/**
 * FLY-222: Xiaohongshu-learning state helper (core library).
 *
 * Single thin state owner (plan §2.6). The skill (Runner) drives it via the
 * `flywheel-comm xhs-state` CLI; the scheduler imports this module directly
 * (`flywheel-comm/xiaohongshu-state`). Both are writers (scheduler picks due +
 * takes the lease; Runner updates pending/processed/operations), so EVERY
 * read-modify-write of a collection's state file runs inside a
 * collection-scoped mkdir-mutex (`withCollectionLock`).
 *
 * Two distinct locks, deliberately:
 *  - the mkdir-MUTEX guards short critical sections (atomic read-modify-write of
 *    one collection's JSON file) — held for milliseconds.
 *  - the LEASE (persisted IN the state file) is the run-level lock a Runner
 *    holds for the whole processing pass; it carries its own expiry so a crashed
 *    holder can be taken over (stale-takeover) by a later attempt.
 *
 * Crash-safe idempotency (plan §2.6, Codex R1 HIGH-2): a stable per-output
 * operation id = `collection:noteId:outputKind:candidateId`. The local
 * `operations` map is a fast-path/bookkeeping optimization ONLY — it does NOT,
 * by itself, guarantee "Linear issue created at most once" (the gap between an
 * external create commit and the local write is a crash window). The
 * authoritative Linear dedup is an immutable marker written into the issue +
 * query-before-create, performed by the skill; this map records intent/result
 * so the skill can reconcile after a crash.
 */

import { createHash } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const XIAOHONGSHU_STATE_VERSION = 1 as const;

/** Default lease TTL (ms) — a Runner must renew within this or be taken over. */
export const DEFAULT_LEASE_TTL_MS = 60 * 60 * 1000; // 1h
/** Default mkdir-mutex acquire timeout (ms). */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
/** A held mkdir-mutex older than this is treated as stale (holder crashed). */
export const DEFAULT_LOCK_STALE_MS = 5 * 60 * 1000; // 5m

/**
 * External side-effect kinds tracked for crash-safe idempotency.
 * FLY-222: `issue` (auto-create / kept draft), `memory` (learning write).
 * FLY-286: `feedback_close` / `feedback_create` — the founder's post-hoc review
 * actions (close an auto-created issue / create from a candidate). Like the
 * others these are EXTERNAL effects, so they belong here (not in a local-only
 * store); see `feedbackOperationId` for the colon-safe id encoding.
 */
export type XiaohongshuOutputKind =
	| "issue"
	| "memory"
	| "feedback_close"
	| "feedback_create";

/** A note seen but not yet fully processed (max_fetch overflow or fail-soft retry). */
export interface PendingNote {
	noteId: string;
	firstSeenAt: string;
	attempts: number;
}

/** Run-level lease — one writer owns a collection's processing pass at a time. */
export interface Lease {
	/** Stable run identity (NOT per-attempt) — a stale-takeover REUSES this key. */
	owner: string;
	acquiredAt: string;
	renewedAt: string;
	/** Absolute expiry; once `now > expiresAt`, the lease is takeable. */
	expiresAt: string;
}

/** A single external side-effect's idempotency record. */
export interface OperationRecord {
	operationId: string;
	noteId: string;
	outputKind: XiaohongshuOutputKind;
	candidateId: string;
	status: "intent" | "done";
	/** For issue ops: the created Linear issue id (set on done). */
	issueId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface XiaohongshuState {
	version: typeof XIAOHONGSHU_STATE_VERSION;
	project: string;
	collectionId: string;
	/**
	 * Whether the first-run baseline has happened. The first run records the
	 * current window as a baseline (marks it processed WITHOUT proposing, to avoid
	 * flooding on a collection saved for months) and sets this flag — even when
	 * the window is EMPTY. `processed.length === 0` is NOT a sufficient first-run
	 * signal: an empty collection's first run leaves `processed` empty, and the
	 * later first real notes would then be wrongly baselined-and-skipped. So the
	 * skill keys "first run" off `!bootstrapped`, and sets it via `set-bootstrapped`
	 * (mark-bootstrapped) at the end of the baseline run regardless of window size.
	 */
	bootstrapped: boolean;
	/** noteIds fully processed (all side-effects committed). */
	processed: string[];
	/** noteIds seen but not yet processed. */
	pending: PendingNote[];
	/** Active run-level lease, or null. */
	lease: Lease | null;
	/**
	 * FLY-222 #2: the fixed, reused trigger Linear issue id for this collection.
	 * Set on first scheduler tick (create-if-absent); reused every tick after
	 * (the scheduler re-spawns a Runner on the SAME issue; the runs/start 409
	 * guard keeps a second concurrent spawn out). null = not created yet.
	 */
	triggerIssueId: string | null;
	/** Next due time (ISO) per cadence; null = compute on first schedule. */
	nextDueAt: string | null;
	/** operationId -> record (local fast-path; Linear marker+query is authoritative). */
	operations: Record<string, OperationRecord>;
	lastRunAt: string | null;
	/**
	 * FLY-286: token of the most recent analysis run (key into the AnalysisStore).
	 * The detailed per-post analysis lives in the AnalysisStore (kept out of this
	 * thin state); this is just the pointer. null = none yet.
	 */
	lastAnalysisRunToken?: string | null;
	/**
	 * FLY-286: token of the most recent delivered review report (key into the
	 * FeedbackStore for the founder's structured actions). null = none yet.
	 */
	lastReportToken?: string | null;
	/**
	 * FLY-286: run tokens whose review feedback has been collected but not yet
	 * consumed (close/create applied). The nightly feedback-consume pass drains
	 * these. Absent/empty = nothing pending.
	 */
	pendingFeedbackRunTokens?: string[];
	updatedAt: string;
}

/** Default state directory: `~/.flywheel/state/xiaohongshu`. Override for tests. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.FLYWHEEL_XHS_STATE_DIR?.trim();
	if (base) return base;
	return join(homedir(), ".flywheel", "state", "xiaohongshu");
}

/** Sanitize a path segment so a malicious project/collection id cannot escape the dir. */
function safeSegment(s: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(s)) {
		throw new Error(
			`xiaohongshu-state: unsafe path segment ${JSON.stringify(s)} (allowed: A-Za-z0-9._-)`,
		);
	}
	return s;
}

/** State file path for one collection. */
export function stateFilePath(
	stateDir: string,
	project: string,
	collectionId: string,
): string {
	return join(
		stateDir,
		`${safeSegment(project)}__${safeSegment(collectionId)}.json`,
	);
}

/** A fresh, empty state for a not-yet-seen collection. */
export function emptyState(
	project: string,
	collectionId: string,
	now: Date = new Date(),
): XiaohongshuState {
	return {
		version: XIAOHONGSHU_STATE_VERSION,
		project,
		collectionId,
		bootstrapped: false,
		processed: [],
		pending: [],
		lease: null,
		triggerIssueId: null,
		nextDueAt: null,
		operations: {},
		lastRunAt: null,
		lastAnalysisRunToken: null,
		lastReportToken: null,
		pendingFeedbackRunTokens: [],
		updatedAt: now.toISOString(),
	};
}

/** Read state (returns a fresh empty state if the file does not exist). */
export function readState(
	stateDir: string,
	project: string,
	collectionId: string,
): XiaohongshuState {
	const file = stateFilePath(stateDir, project, collectionId);
	let raw: string;
	try {
		raw = readFileSync(file, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return emptyState(project, collectionId);
		}
		throw err;
	}
	const parsed = JSON.parse(raw) as XiaohongshuState;
	if (parsed.version !== XIAOHONGSHU_STATE_VERSION) {
		throw new Error(
			`xiaohongshu-state: unsupported state version ${parsed.version} in ${file} (expected ${XIAOHONGSHU_STATE_VERSION})`,
		);
	}
	// Forward-compat default for fields added after a state file was first
	// written (additive, same version — no migration needed).
	if (parsed.triggerIssueId === undefined) parsed.triggerIssueId = null;
	// A state file written before `bootstrapped` existed but with processed
	// history is, by definition, already past its baseline → treat as bootstrapped
	// (so we don't re-baseline a collection that has real processed notes).
	if ((parsed as Partial<XiaohongshuState>).bootstrapped === undefined) {
		parsed.bootstrapped = Array.isArray(parsed.processed)
			? parsed.processed.length > 0
			: false;
	}
	// FLY-286 additive fields (same version — forward-compat defaults).
	if (parsed.lastAnalysisRunToken === undefined)
		parsed.lastAnalysisRunToken = null;
	if (parsed.lastReportToken === undefined) parsed.lastReportToken = null;
	if (!Array.isArray(parsed.pendingFeedbackRunTokens))
		parsed.pendingFeedbackRunTokens = [];
	return parsed;
}

/** Atomically write state (temp file + rename — never a torn write). */
export function writeState(stateDir: string, state: XiaohongshuState): void {
	const file = stateFilePath(stateDir, state.project, state.collectionId);
	mkdirSync(dirname(file), { recursive: true });
	const next = { ...state, updatedAt: new Date().toISOString() };
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
	renameSync(tmp, file);
}

// ─── Collection-scoped mkdir-mutex ──────────────────────────────────────────

interface LockMeta {
	owner?: string;
	pid: number;
	acquiredAt: string;
	/**
	 * Unique per-acquisition token. The release path deletes the lock ONLY when
	 * this still matches the holder's token, so a process whose lock was
	 * stale-reaped + re-acquired by someone else never deletes the new holder's
	 * lock (HIGH: confused lock-removal → concurrent critical-section entry).
	 */
	token: string;
}

/** A unique-enough lock token without pulling in a crypto import. */
function newLockToken(): string {
	return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Atomically remove a lock dir by renaming it to a unique quarantine path first,
 * then deleting the quarantine. The rename is the arbiter: only ONE caller wins
 * it (the rest get ENOENT), so two concurrent reapers can never both "succeed"
 * and have the second delete a fresh lock the first's retry just created.
 */
function removeLockAtomic(lockDir: string, tag: string): void {
	const quarantine = `${lockDir}.${tag}.${process.pid}.${Date.now()}.${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	renameSync(lockDir, quarantine); // throws ENOENT if another caller already moved it
	rmSync(quarantine, { recursive: true, force: true });
}

/**
 * Release a lock WE acquired, safely even against a stale-takeover. Rename the
 * lock dir out of the shared path FIRST (atomic), so our subsequent delete can
 * only ever touch the quarantined copy — never whatever now sits at the shared
 * path — THEN inspect the token: ours → delete; someone else's (a takeover
 * slipped in while our critical section ran past staleMs) → rename it back so we
 * never destroy their live lock. This closes the read-token-then-delete window
 * (the prior two-step read+rename could delete a fresh holder's lock).
 *
 * Note: this matters only if a reaper fired DURING our critical section, which
 * requires that section to outlast staleMs (5 min). withCollectionLock sections
 * are bounded short by construction (a state read-modify-write, or the one-time
 * trigger-issue create) — the long "one Runner per collection" wait is the
 * run-level lease, NOT this mutex — so a mid-section reap is not reachable in
 * practice; this is defense-in-depth.
 */
function releaseOwnedLock(lockDir: string, myToken: string): void {
	const quarantine = `${lockDir}.release.${process.pid}.${Date.now()}.${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	try {
		renameSync(lockDir, quarantine);
	} catch {
		return; // already gone (reaped) — nothing of ours to remove
	}
	let mine = false;
	try {
		const meta = JSON.parse(
			readFileSync(join(quarantine, "meta.json"), "utf-8"),
		) as LockMeta;
		mine = meta.token === myToken;
	} catch {
		mine = false;
	}
	if (mine) {
		rmSync(quarantine, { recursive: true, force: true });
		return;
	}
	// We moved a lock that is NOT ours (a takeover replaced ours). Put it back so
	// the current holder keeps its lock; if the path was re-taken in the tiny
	// window, leave the orphan for a later reap rather than clobber.
	try {
		renameSync(quarantine, lockDir);
	} catch {
		rmSync(quarantine, { recursive: true, force: true });
	}
}

function lockDirPath(
	stateDir: string,
	project: string,
	collectionId: string,
): string {
	return join(
		stateDir,
		`${safeSegment(project)}__${safeSegment(collectionId)}.lock`,
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run `fn` while holding the collection-scoped mkdir-mutex. `mkdir` is atomic
 * (POSIX: fails with EEXIST if the dir exists), so it is the single arbiter —
 * stale cleanup is only best-effort, the subsequent `mkdir` decides the winner.
 */
export async function withCollectionLock<T>(
	stateDir: string,
	project: string,
	collectionId: string,
	fn: () => T | Promise<T>,
	opts: {
		owner?: string;
		timeoutMs?: number;
		staleMs?: number;
		pollMs?: number;
	} = {},
): Promise<T> {
	const lockDir = lockDirPath(stateDir, project, collectionId);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
	const pollMs = opts.pollMs ?? 100;
	const deadline = Date.now() + timeoutMs;

	mkdirSync(dirname(lockDir), { recursive: true });
	const myToken = newLockToken();

	let acquired = false;
	for (;;) {
		try {
			mkdirSync(lockDir); // atomic — throws EEXIST if held
			acquired = true;
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			// Held — is it stale (holder crashed)?
			if (isLockStale(lockDir, staleMs)) {
				// Atomically rename-then-delete: only one reaper wins the rename,
				// so we never delete a fresh lock another reaper's retry just made.
				try {
					removeLockAtomic(lockDir, "stale");
				} catch {
					/* lost the rename race (ENOENT) — fine, loop and retry mkdir */
				}
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`xiaohongshu-state: timed out acquiring lock for ${project}__${collectionId} after ${timeoutMs}ms`,
				);
			}
			await sleep(pollMs);
		}
	}

	// Record holder meta for stale detection by others. Best-effort (the mutex
	// is already ours; a meta-write failure must not abort the critical section).
	try {
		writeFileSync(
			join(lockDir, "meta.json"),
			JSON.stringify({
				owner: opts.owner,
				pid: process.pid,
				acquiredAt: new Date().toISOString(),
				token: myToken,
			} satisfies LockMeta),
			{ mode: 0o600 },
		);
	} catch {
		/* non-fatal */
	}

	try {
		return await fn();
	} finally {
		if (acquired) {
			try {
				// Rename-out → check-token → delete-if-ours / restore-if-not, so we
				// never delete a lock a stale-takeover handed to a new holder.
				releaseOwnedLock(lockDir, myToken);
			} catch {
				/* TTL/stale-takeover will reap it if removal fails */
			}
		}
	}
}

function isLockStale(lockDir: string, staleMs: number): boolean {
	try {
		const meta = JSON.parse(
			readFileSync(join(lockDir, "meta.json"), "utf-8"),
		) as LockMeta;
		// Dead-owner short-circuit: if the recorded pid is gone, it's stale.
		if (typeof meta.pid === "number" && !isPidAlive(meta.pid)) return true;
		const age = Date.now() - new Date(meta.acquiredAt).getTime();
		return Number.isFinite(age) && age > staleMs;
	} catch {
		// No/parse-failed meta — fall back to the lock dir's own mtime.
		try {
			const age = Date.now() - statSync(lockDir).mtimeMs;
			return age > staleMs;
		} catch {
			return false;
		}
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH = no such process; EPERM = alive but not ours (treat as alive).
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

// ─── Pure lease/CAS transitions (operate on an in-memory state) ──────────────

export interface LeaseResult {
	ok: boolean;
	state: XiaohongshuState;
	reason?: "held_by_other" | "not_owner";
	heldBy?: string;
}

/** True if `lease` is absent or expired as of `now`. */
export function isLeaseTakeable(lease: Lease | null, now: Date): boolean {
	if (!lease) return true;
	return now.getTime() > new Date(lease.expiresAt).getTime();
}

/**
 * Acquire (or renew, if same owner) the run-level lease. Rejects when a live
 * lease is held by a different owner — that is how a second concurrent tick is
 * kept out even after both passed the mkdir-mutex at different moments.
 */
export function acquireLease(
	state: XiaohongshuState,
	owner: string,
	now: Date = new Date(),
	ttlMs: number = DEFAULT_LEASE_TTL_MS,
): LeaseResult {
	const existing = state.lease;
	if (existing && existing.owner !== owner && !isLeaseTakeable(existing, now)) {
		return {
			ok: false,
			state,
			reason: "held_by_other",
			heldBy: existing.owner,
		};
	}
	const acquiredAt =
		existing && existing.owner === owner
			? existing.acquiredAt
			: now.toISOString();
	const lease: Lease = {
		owner,
		acquiredAt,
		renewedAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
	};
	return { ok: true, state: { ...state, lease } };
}

/** Renew a lease the caller already owns (extends expiry). */
export function renewLease(
	state: XiaohongshuState,
	owner: string,
	now: Date = new Date(),
	ttlMs: number = DEFAULT_LEASE_TTL_MS,
): LeaseResult {
	const existing = state.lease;
	if (!existing || existing.owner !== owner) {
		return { ok: false, state, reason: "not_owner", heldBy: existing?.owner };
	}
	const lease: Lease = {
		...existing,
		renewedAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
	};
	return { ok: true, state: { ...state, lease } };
}

/** Release a lease the caller owns (no-op-reject if not owner). */
export function releaseLease(
	state: XiaohongshuState,
	owner: string,
): LeaseResult {
	const existing = state.lease;
	if (!existing) return { ok: true, state };
	if (existing.owner !== owner) {
		return { ok: false, state, reason: "not_owner", heldBy: existing.owner };
	}
	return { ok: true, state: { ...state, lease: null } };
}

/** Record the fixed trigger issue id (set once on create; reused thereafter). */
export function setTriggerIssueId(
	state: XiaohongshuState,
	triggerIssueId: string,
): XiaohongshuState {
	return { ...state, triggerIssueId };
}

/**
 * Mark the first-run baseline as done. Set at the END of the baseline run
 * regardless of how many notes the window had (including an EMPTY collection),
 * so a later first batch of notes is not mis-baselined. Idempotent.
 */
export function markBootstrapped(state: XiaohongshuState): XiaohongshuState {
	return state.bootstrapped ? state : { ...state, bootstrapped: true };
}

// ─── Diff + pending ──────────────────────────────────────────────────────────

/**
 * Full-window diff (plan §1.4/§2.6): noteIds present in the fetched window but
 * not yet processed. Order follows `fetchedNoteIds` (newest-first from the MCP).
 */
export function computeNewNoteIds(
	fetchedNoteIds: string[],
	state: XiaohongshuState,
): string[] {
	const processed = new Set(state.processed);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of fetchedNoteIds) {
		if (processed.has(id) || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/** Mark a noteId fully processed: add to `processed`, drop from `pending`. */
export function markProcessed(
	state: XiaohongshuState,
	noteId: string,
): XiaohongshuState {
	const processed = state.processed.includes(noteId)
		? state.processed
		: [...state.processed, noteId];
	return {
		...state,
		processed,
		pending: state.pending.filter((p) => p.noteId !== noteId),
	};
}

/**
 * Drop a noteId from `pending` WITHOUT marking it processed — for a pending note
 * that slid out of the fetchable 200-window (it can never be processed now, but
 * `mark-processed` would falsely record it as done + pollute the diff). Idempotent.
 */
export function dropPending(
	state: XiaohongshuState,
	noteId: string,
): XiaohongshuState {
	if (!state.pending.some((p) => p.noteId === noteId)) return state;
	return {
		...state,
		pending: state.pending.filter((p) => p.noteId !== noteId),
	};
}

/** Record noteIds as pending (seen, not processed) — idempotent, bumps attempts. */
export function recordPending(
	state: XiaohongshuState,
	noteIds: string[],
	now: Date = new Date(),
): XiaohongshuState {
	const processed = new Set(state.processed);
	const byId = new Map(state.pending.map((p) => [p.noteId, p]));
	for (const noteId of noteIds) {
		if (processed.has(noteId)) continue;
		const existing = byId.get(noteId);
		if (existing) {
			byId.set(noteId, { ...existing, attempts: existing.attempts + 1 });
		} else {
			byId.set(noteId, {
				noteId,
				firstSeenAt: now.toISOString(),
				attempts: 1,
			});
		}
	}
	return { ...state, pending: [...byId.values()] };
}

// ─── Operation idempotency ────────────────────────────────────────────────────

/** Stable per-output operation id (plan §2.6). Deterministic; reused across attempts. */
export function operationId(
	collectionId: string,
	noteId: string,
	outputKind: XiaohongshuOutputKind,
	candidateId: string,
): string {
	for (const part of [collectionId, noteId, candidateId]) {
		if (part.includes(":")) {
			throw new Error(
				`xiaohongshu-state: operation id parts must not contain ':' (got ${JSON.stringify(part)})`,
			);
		}
	}
	return `${collectionId}:${noteId}:${outputKind}:${candidateId}`;
}

export function findOperation(
	state: XiaohongshuState,
	id: string,
): OperationRecord | undefined {
	return state.operations[id];
}

/**
 * Persist INTENT to perform an external op — call this BEFORE the external
 * create so a crash leaves a recoverable marker. No-op if a record already
 * exists (preserves an earlier `done`).
 */
export function recordOperationIntent(
	state: XiaohongshuState,
	args: {
		noteId: string;
		outputKind: XiaohongshuOutputKind;
		candidateId: string;
	},
	now: Date = new Date(),
): { id: string; state: XiaohongshuState } {
	const id = operationId(
		state.collectionId,
		args.noteId,
		args.outputKind,
		args.candidateId,
	);
	if (state.operations[id]) return { id, state };
	const record: OperationRecord = {
		operationId: id,
		noteId: args.noteId,
		outputKind: args.outputKind,
		candidateId: args.candidateId,
		status: "intent",
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	};
	return {
		id,
		state: { ...state, operations: { ...state.operations, [id]: record } },
	};
}

/** Mark an external op done (records the external id, e.g. Linear issue id). */
export function markOperationDone(
	state: XiaohongshuState,
	id: string,
	result: { issueId?: string } = {},
	now: Date = new Date(),
): XiaohongshuState {
	const existing = state.operations[id];
	if (!existing) {
		throw new Error(
			`xiaohongshu-state: cannot mark unknown operation ${id} done (record intent first)`,
		);
	}
	const record: OperationRecord = {
		...existing,
		status: "done",
		issueId: result.issueId ?? existing.issueId,
		updatedAt: now.toISOString(),
	};
	return { ...state, operations: { ...state.operations, [id]: record } };
}

// ─── FLY-286: feedback operations (post-hoc review actions) ───────────────────

/** A feedback review action against a prior run's output. */
export type XiaohongshuFeedbackAction = "close" | "create";

/**
 * FLY-286 (codex R2 watchpoint #1): stable, colon-SAFE idempotency id for a
 * founder feedback action.
 *
 * The logical key includes a `target` (for `close` = the target issue's opId,
 * which is itself `collection:noteId:kind:candidateId`; for `create` = the
 * candidateId). `operationId()` rejects ':' inside its parts, so the raw target
 * cannot pass through it. We hash the (possibly colon-containing) target into a
 * fixed colon-free token and feed THAT as the candidate part, keeping the id in
 * the same `collection:noteId:kind:token` shape as every other op (so it lives
 * in the same `operations` map + reconciles the same way).
 *
 * `runToken` is deliberately NOT part of the id: a feedback action ("close issue
 * X" / "create from candidate Z") must happen at-most-once GLOBALLY, even if the
 * same review is re-delivered/re-consumed across runs — so the key is keyed on
 * the target, not the run.
 */
export function feedbackOperationId(
	collectionId: string,
	noteId: string,
	action: XiaohongshuFeedbackAction,
	target: string,
): string {
	const kind: XiaohongshuOutputKind =
		action === "close" ? "feedback_close" : "feedback_create";
	const token = createHash("sha256").update(target).digest("hex").slice(0, 16);
	// collectionId + noteId are colon-free (state-segment charset); token is hex.
	return operationId(collectionId, noteId, kind, token);
}

/**
 * Persist INTENT for a feedback action BEFORE applying it externally (mirror of
 * `recordOperationIntent`). The raw `target` is kept on the record for
 * debugging; the map KEY is the colon-safe `feedbackOperationId`. No-op if the
 * record already exists (preserves an earlier `done` → at-most-once).
 */
export function recordFeedbackOperationIntent(
	state: XiaohongshuState,
	args: {
		noteId: string;
		action: XiaohongshuFeedbackAction;
		/** close → target issue opId; create → candidateId. */
		target: string;
	},
	now: Date = new Date(),
): { id: string; state: XiaohongshuState } {
	const id = feedbackOperationId(
		state.collectionId,
		args.noteId,
		args.action,
		args.target,
	);
	if (state.operations[id]) return { id, state };
	const record: OperationRecord = {
		operationId: id,
		noteId: args.noteId,
		outputKind: args.action === "close" ? "feedback_close" : "feedback_create",
		candidateId: args.target,
		status: "intent",
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	};
	return {
		id,
		state: { ...state, operations: { ...state.operations, [id]: record } },
	};
}

// ─── FLY-286: review delivery + pending-feedback pointers ─────────────────────

/**
 * Record that an analysis run was delivered for review (FLY-286). Sets the
 * `lastAnalysisRunToken` / `lastReportToken` pointers and appends the run to the
 * drainable `pendingFeedbackRunTokens` queue (dedup). Pure transform — the CLI
 * wraps it in the collection lock + owner fence (like the other mutators).
 */
export function recordAnalysisDelivered(
	state: XiaohongshuState,
	args: { runToken: string; reportToken: string },
): XiaohongshuState {
	const pending = Array.isArray(state.pendingFeedbackRunTokens)
		? state.pendingFeedbackRunTokens
		: [];
	return {
		...state,
		lastAnalysisRunToken: args.runToken,
		lastReportToken: args.reportToken,
		pendingFeedbackRunTokens: pending.includes(args.runToken)
			? pending
			: [...pending, args.runToken],
	};
}

/**
 * Drop a run from the pending-feedback queue once all its review actions have
 * been consumed (FLY-286). Idempotent when the token is already absent.
 */
export function clearPendingFeedback(
	state: XiaohongshuState,
	runToken: string,
): XiaohongshuState {
	const pending = Array.isArray(state.pendingFeedbackRunTokens)
		? state.pendingFeedbackRunTokens
		: [];
	return {
		...state,
		pendingFeedbackRunTokens: pending.filter((t) => t !== runToken),
	};
}

// ─── Cadence / next-due ───────────────────────────────────────────────────────

const CADENCE_MS: Record<string, number> = {
	daily: 24 * 60 * 60 * 1000,
	weekly: 7 * 24 * 60 * 60 * 1000,
	biweekly: 14 * 24 * 60 * 60 * 1000,
	monthly: 30 * 24 * 60 * 60 * 1000,
};

/** Compute the next due time for a cadence from a base instant. */
export function computeNextDueAt(
	cadence: string,
	from: Date = new Date(),
): string {
	const ms = CADENCE_MS[cadence];
	if (ms == null) {
		throw new Error(
			`xiaohongshu-state: unknown cadence ${JSON.stringify(cadence)}`,
		);
	}
	return new Date(from.getTime() + ms).toISOString();
}

/** Is the collection due now? (true when nextDueAt is null/in the past). */
export function isDue(
	state: XiaohongshuState,
	now: Date = new Date(),
): boolean {
	if (!state.nextDueAt) return true;
	return now.getTime() >= new Date(state.nextDueAt).getTime();
}

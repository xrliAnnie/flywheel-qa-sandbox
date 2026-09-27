/**
 * FLY-2891: read-only evidence of which model/effort a Codex turn actually ran.
 *
 * Codex writes one JSONL rollout per thread under `$CODEX_HOME/sessions/**` (or
 * `archived_sessions/`). Each turn records `turn_context` (model + effort) and
 * ends with an `event_msg` `task_complete` (or `turn_aborted`). The review
 * round writer and the review gate bind a verdict to one exact turn id, so a
 * later follow-up on the same thread (possibly another model) can never be
 * mistaken for the reviewed turn.
 *
 * Safety mirrors `lead-turn-evidence.ts`: the real path must sit inside one of
 * the two roots, the file is opened O_NOFOLLOW and must be a regular file, the
 * first line must be `session_meta` for the same thread, and only
 * newline-terminated records count. Unlike the lead reader this scans the whole
 * file in chunks: measured review turns span up to ~6.5MB and a reviewed turn's
 * context can sit >20MB before the end once later turns follow, so a bounded
 * tail read would fail closed on legitimate reviews.
 */

import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

export const CODEX_ID_RE = /^[0-9A-Za-z-]{8,128}$/;
const ROOTS = ["sessions", "archived_sessions"] as const;
const CHUNK_BYTES = 1024 * 1024;
const META_PREFIX_BYTES = 256 * 1024;
/** Hard ceiling; the largest observed rollout was ~23.5MB. */
const MAX_ROLLOUT_BYTES = 256 * 1024 * 1024;
/**
 * Records we need (turn_context, task_*) are small; the longest observed line
 * was ~10.8MB of response content. Larger lines are skipped, which bounds
 * memory and keeps the scan linear.
 */
export const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_WALK_ENTRIES = 50_000;

export interface CodexTurnEvidence {
	threadId: string;
	turnId: string;
	model: string;
	effort: string;
	/** ISO timestamp of the turn's task_complete record. */
	completedAt: string;
}

export type CodexTurnEvidenceFailure =
	| "invalid_thread_id"
	| "invalid_turn_id"
	| "rollout_not_found"
	| "rollout_path_invalid"
	| "rollout_too_large"
	| "meta_mismatch"
	| "turn_not_found"
	| "turn_incomplete"
	| "turn_context_conflict"
	| "ambiguous"
	| "io_error";

export type CodexTurnEvidenceResult =
	| { ok: true; evidence: CodexTurnEvidence }
	| { ok: false; reason: CodexTurnEvidenceFailure; detail?: string };

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return (
		rel !== "" &&
		!isAbsolute(rel) &&
		rel !== ".." &&
		!rel.startsWith(`..${sep}`)
	);
}

/** Newest rollout file (by mtime) whose name carries the thread id. */
export function findRolloutForThread(
	codexHome: string,
	threadId: string,
): string | undefined {
	if (!CODEX_ID_RE.test(threadId)) return undefined;
	let best: { path: string; mtimeMs: number } | undefined;
	let visited = 0;
	const walk = (dir: string, depth: number): void => {
		if (depth > 6 || visited > MAX_WALK_ENTRIES) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			visited += 1;
			if (visited > MAX_WALK_ENTRIES) return;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path, depth + 1);
			} else if (
				entry.isFile() &&
				entry.name.endsWith(".jsonl") &&
				entry.name.includes(threadId)
			) {
				try {
					const mtimeMs = statSync(path).mtimeMs;
					if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
				} catch {
					/* vanished between readdir and stat */
				}
			}
		}
	};
	for (const root of ROOTS) walk(join(codexHome, root), 0);
	return best?.path;
}

function readRange(fd: number, start: number, size: number): Buffer {
	const buffer = Buffer.alloc(size);
	let count = 0;
	while (count < size) {
		const read = readSync(fd, buffer, count, size - count, start + count);
		if (!read) break;
		count += read;
	}
	return buffer.subarray(0, count);
}

function parse(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

interface TurnFacts {
	order: number;
	started: boolean;
	contexts: Array<{ model: unknown; effort: unknown }>;
	completedAt?: string;
	aborted: boolean;
}

/**
 * Read one rollout. With `turnId`, return that turn's evidence; without it,
 * return the last completed turn unless a later turn is still running
 * (`ambiguous` — the caller must name the turn explicitly).
 */
export function readTurnEvidence(
	codexHome: string,
	path: string,
	threadId: string,
	turnId?: string,
): CodexTurnEvidenceResult {
	if (!CODEX_ID_RE.test(threadId))
		return { ok: false, reason: "invalid_thread_id" };
	if (turnId !== undefined && !CODEX_ID_RE.test(turnId))
		return { ok: false, reason: "invalid_turn_id" };
	let fd: number | undefined;
	try {
		const home = realpathSync(codexHome);
		const real = realpathSync(path);
		if (
			!isAbsolute(path) ||
			!ROOTS.some((root) => inside(join(home, root), real))
		)
			return { ok: false, reason: "rollout_path_invalid" };
		// O_NOFOLLOW on the caller's path: a symlink swapped in after realpath
		// is refused rather than followed.
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = fstatSync(fd);
		if (!stat.isFile()) return { ok: false, reason: "rollout_path_invalid" };
		if (stat.size > MAX_ROLLOUT_BYTES)
			return { ok: false, reason: "rollout_too_large" };

		const prefix = readRange(
			fd,
			0,
			Math.min(stat.size, META_PREFIX_BYTES),
		).toString("utf8");
		const metaEnd = prefix.indexOf("\n");
		const metaRow = metaEnd < 0 ? undefined : parse(prefix.slice(0, metaEnd));
		const metaPayload = metaRow?.payload as Record<string, unknown> | undefined;
		if (metaRow?.type !== "session_meta" || metaPayload?.id !== threadId)
			return { ok: false, reason: "meta_mismatch" };

		const turns = new Map<string, TurnFacts>();
		let order = 0;
		const facts = (id: string): TurnFacts => {
			let entry = turns.get(id);
			if (!entry) {
				entry = {
					order: order++,
					started: false,
					contexts: [],
					aborted: false,
				};
				turns.set(id, entry);
			}
			return entry;
		};
		const consume = (line: string): void => {
			// Cheap prefilter: only three record shapes matter.
			if (
				!line.includes('"turn_context"') &&
				!line.includes('"task_complete"') &&
				!line.includes('"task_started"') &&
				!line.includes('"turn_aborted"')
			)
				return;
			if (turnId !== undefined && !line.includes(turnId)) return;
			const row = parse(line);
			const payload = row?.payload as Record<string, unknown> | undefined;
			if (!row || !payload || typeof payload.turn_id !== "string") return;
			if (row.type === "turn_context") {
				facts(payload.turn_id).contexts.push({
					model: payload.model,
					effort: payload.effort,
				});
				return;
			}
			if (row.type !== "event_msg") return;
			if (payload.type === "task_started")
				facts(payload.turn_id).started = true;
			else if (payload.type === "turn_aborted")
				facts(payload.turn_id).aborted = true;
			else if (
				payload.type === "task_complete" &&
				typeof row.timestamp === "string" &&
				Number.isFinite(Date.parse(row.timestamp))
			) {
				const entry = facts(payload.turn_id);
				entry.completedAt = row.timestamp;
				entry.order = order++;
			}
		};

		// Pieces of the current, not yet newline-terminated record. They are
		// joined exactly once when the newline arrives (linear, no re-copying);
		// bytes after the last newline are uncommitted and never count.
		let pending: Buffer[] = [];
		let pendingBytes = 0;
		let skipping = false;
		for (let offset = 0; offset < stat.size; offset += CHUNK_BYTES) {
			const chunk = readRange(
				fd,
				offset,
				Math.min(CHUNK_BYTES, stat.size - offset),
			);
			if (chunk.length === 0) break;
			let start = 0;
			for (
				let nl = chunk.indexOf(10, start);
				nl >= 0;
				nl = chunk.indexOf(10, start)
			) {
				const tail = chunk.subarray(start, nl);
				// The cap applies to the whole record, including its final piece.
				if (!skipping && pendingBytes + tail.length <= MAX_RECORD_BYTES) {
					const line =
						pending.length === 0
							? tail
							: Buffer.concat([...pending, tail], pendingBytes + tail.length);
					consume(line.toString("utf8"));
				}
				pending = [];
				pendingBytes = 0;
				skipping = false;
				start = nl + 1;
			}
			if (skipping || start >= chunk.length) continue;
			const rest = chunk.subarray(start);
			if (pendingBytes + rest.length > MAX_RECORD_BYTES) {
				pending = [];
				pendingBytes = 0;
				skipping = true;
				continue;
			}
			pending.push(Buffer.from(rest));
			pendingBytes += rest.length;
		}

		const evidenceFor = (id: string): CodexTurnEvidenceResult => {
			const entry = turns.get(id);
			if (!entry || entry.contexts.length === 0)
				return { ok: false, reason: "turn_not_found" };
			const [first] = entry.contexts;
			if (
				typeof first!.model !== "string" ||
				!first!.model ||
				typeof first!.effort !== "string" ||
				!first!.effort ||
				entry.contexts.some(
					(ctx) => ctx.model !== first!.model || ctx.effort !== first!.effort,
				)
			)
				return { ok: false, reason: "turn_context_conflict" };
			if (!entry.completedAt) return { ok: false, reason: "turn_incomplete" };
			return {
				ok: true,
				evidence: {
					threadId,
					turnId: id,
					model: first!.model,
					effort: first!.effort,
					completedAt: entry.completedAt,
				},
			};
		};

		if (turnId !== undefined) return evidenceFor(turnId);
		const ordered = [...turns.entries()].sort(
			(a, b) => a[1].order - b[1].order,
		);
		let lastCompleted: string | undefined;
		let lastCompletedOrder = -1;
		for (const [id, entry] of ordered)
			if (entry.completedAt) {
				lastCompleted = id;
				lastCompletedOrder = entry.order;
			}
		if (!lastCompleted) return { ok: false, reason: "turn_not_found" };
		const running = ordered.some(
			([id, entry]) =>
				id !== lastCompleted &&
				entry.started &&
				!entry.completedAt &&
				!entry.aborted &&
				entry.order > lastCompletedOrder,
		);
		if (running) return { ok: false, reason: "ambiguous" };
		return evidenceFor(lastCompleted);
	} catch (error) {
		return {
			ok: false,
			reason: "io_error",
			detail: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Locate the thread's rollout under `codexHome` (default: env) and read it. */
export function readCodexTurnEvidence(args: {
	threadId: string;
	turnId?: string;
	codexHome?: string;
	env?: NodeJS.ProcessEnv;
}): CodexTurnEvidenceResult {
	if (!CODEX_ID_RE.test(args.threadId))
		return { ok: false, reason: "invalid_thread_id" };
	if (args.turnId !== undefined && !CODEX_ID_RE.test(args.turnId))
		return { ok: false, reason: "invalid_turn_id" };
	const codexHome = args.codexHome ?? resolveCodexHome(args.env);
	const path = findRolloutForThread(codexHome, args.threadId);
	if (!path) return { ok: false, reason: "rollout_not_found" };
	return readTurnEvidence(codexHome, path, args.threadId, args.turnId);
}

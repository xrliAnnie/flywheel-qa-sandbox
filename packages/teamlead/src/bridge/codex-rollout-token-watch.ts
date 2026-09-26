import {
	closeSync,
	existsSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";
import {
	codexSessionStateDir,
	findCodexRolloutPath,
} from "flywheel-claude-runner";
import { parseCodexUsageLine } from "../workflow-usage-source.js";

/**
 * FLY-2903: how many tokens a terminal Codex execution burned after it went
 * terminal. Same cut and counter semantics as the FLY-2893 census
 * (`evidence/scripts/usage.py`): the last cumulative `total_token_usage` at or
 * before `terminal_at + 2min` is the terminal baseline; later cumulative
 * totals are summed as deltas, and a counter that falls back starts a new
 * segment from zero. Reads are incremental from a committed byte offset.
 */

export const ROLLOUT_READ_MAX_BYTES = 8 * 1024 * 1024;
const SESSION_STATE_MAX_BYTES = 64 * 1024;
const ID_PATTERN = /^[^/\\\0\r\n]{1,200}$/;
const ROLLOUT_DIRS = ["sessions", "archived_sessions"] as const;

export interface RolloutLocatorDeps {
	/** Newest scorecard usage source bound to this execution (primary source). */
	latestCursor: (
		executionId: string,
	) => { source_locator: string; native_session_id: string } | undefined;
	/** CODEX_HOME of this execution's live codex processes in this tick's snapshot. */
	processHomes: readonly string[];
	/** session.json thread id, while the file still exists (never a legacy guess). */
	readThreadId: (executionId: string) => string | undefined;
	/** `codexHomesRoot(env)`: every accepted rollout must live under it. */
	codexHomesRoot: string;
	findRollout?: typeof findCodexRolloutPath;
}

function inside(child: string, parent: string): boolean {
	return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** Absolute regular file (never a symlink) under the homes root, in a sessions dir, named for the thread. */
export function isValidRolloutPath(
	path: unknown,
	codexHomesRoot: string,
	threadId: string,
): path is string {
	if (typeof path !== "string" || !isAbsolute(path)) return false;
	if (!ID_PATTERN.test(threadId) || !basename(path).includes(threadId))
		return false;
	if (!ROLLOUT_DIRS.some((dir) => path.includes(`${sep}${dir}${sep}`)))
		return false;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) return false;
		return inside(realpathSync(path), realpathSync(codexHomesRoot));
	} catch {
		return false;
	}
}

function homeOfRollout(path: string): string | undefined {
	const cuts = ROLLOUT_DIRS.map((dir) => path.indexOf(`${sep}${dir}${sep}`))
		.filter((index) => index > 0)
		.sort((a, b) => a - b);
	return cuts.length > 0 ? path.slice(0, cuts[0]) : undefined;
}

function attempt<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch {
		return undefined;
	}
}

/**
 * Resolve once, cache the answer in the ledger. Order: scorecard cursor, the
 * cursor's thread in `archived_sessions/` when Codex moved the file, then a
 * live process home + session.json thread id. Nothing else.
 */
export function resolveCodexRolloutPath(
	executionId: string,
	deps: RolloutLocatorDeps,
): string | null {
	const find = deps.findRollout ?? findCodexRolloutPath;
	const root = deps.codexHomesRoot;
	const cursor = attempt(() => deps.latestCursor(executionId));
	if (cursor) {
		const thread = cursor.native_session_id;
		if (isValidRolloutPath(cursor.source_locator, root, thread)) {
			return cursor.source_locator;
		}
		const home =
			typeof cursor.source_locator === "string" &&
			isAbsolute(cursor.source_locator) &&
			!existsSync(cursor.source_locator)
				? homeOfRollout(cursor.source_locator)
				: undefined;
		if (home && ID_PATTERN.test(thread)) {
			const archived = attempt(() => find(home, thread, ["archived_sessions"]));
			if (isValidRolloutPath(archived, root, thread)) return archived;
		}
	}
	const threadId = attempt(() => deps.readThreadId(executionId));
	if (!threadId || !ID_PATTERN.test(threadId)) return null;
	for (const home of deps.processHomes) {
		const found = attempt(() => find(home, threadId, [...ROLLOUT_DIRS]));
		if (isValidRolloutPath(found, root, threadId)) return found;
	}
	return null;
}

/** session.json thread id, read without following links; undefined when absent/invalid. */
export function readCodexSessionThreadId(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (!ID_PATTERN.test(executionId)) return undefined;
	let fd: number | undefined;
	try {
		fd = openSync(
			join(codexSessionStateDir(executionId, env), "session.json"),
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
		);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > SESSION_STATE_MAX_BYTES) return undefined;
		const buffer = Buffer.alloc(stat.size);
		let length = 0;
		while (length < buffer.length) {
			const read = readSync(fd, buffer, length, buffer.length - length, null);
			if (read === 0) break;
			length += read;
		}
		const parsed = JSON.parse(buffer.subarray(0, length).toString("utf8")) as {
			threadId?: unknown;
		};
		return typeof parsed.threadId === "string" &&
			ID_PATTERN.test(parsed.threadId)
			? parsed.threadId
			: undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export interface RolloutTokenState {
	/** Committed byte offset (complete lines only); null before the first read. */
	offset: number | null;
	/** Last cumulative total seen, the delta baseline for the next line. */
	lastTotal: number | null;
	tokensAtTerminal: number | null;
	tokensAfterTerminal: number | null;
}

export interface RolloutTokenRead extends RolloutTokenState {
	offset: number;
	tokensAfterTerminal: number;
	/** True when this read reached EOF; token totals are only comparable then. */
	complete: boolean;
	note?: "read_truncated" | "rewound";
}

export function readCodexRolloutTokens(
	path: string,
	state: RolloutTokenState,
	input: { cutMs: number; maxBytes?: number },
): RolloutTokenRead {
	const maxBytes = Math.max(1, input.maxBytes ?? ROLLOUT_READ_MAX_BYTES);
	const fd = openSync(
		path,
		fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
	);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("rollout_not_regular_file");
		let note: RolloutTokenRead["note"];
		let start = state.offset ?? 0;
		let lastTotal = state.lastTotal;
		let tokensAtTerminal = state.tokensAtTerminal;
		let tokensAfterTerminal = state.tokensAfterTerminal ?? 0;
		if (stat.size < start) {
			note = "rewound";
			start = 0;
			lastTotal = null;
			tokensAtTerminal = null;
			tokensAfterTerminal = 0;
		}
		const available = stat.size - start;
		const toRead = Math.min(available, maxBytes);
		const chunk = Buffer.alloc(toRead);
		let length = 0;
		while (length < toRead) {
			const read = readSync(fd, chunk, length, toRead - length, start + length);
			if (read === 0) break;
			length += read;
		}
		const lastNewline = chunk.subarray(0, length).lastIndexOf(0x0a);
		// A full budget with no newline is one oversized line; it cannot be a
		// token_count record, so skip it instead of stalling on it forever.
		const consumed =
			lastNewline >= 0 ? lastNewline + 1 : length === maxBytes ? length : 0;
		let lineStart = 0;
		while (lastNewline >= 0 && lineStart <= lastNewline) {
			const lineEnd = chunk.indexOf(0x0a, lineStart);
			const line = chunk.subarray(lineStart, lineEnd).toString("utf8");
			const lineOffset = start + lineStart;
			lineStart = lineEnd + 1;
			if (!line.includes('"token_count"')) continue;
			const usage = parseCodexUsageLine(line, {
				offset: lineOffset,
				model: "codex",
			});
			if (!usage) continue;
			const at = Date.parse(usage.at);
			const total = usage.totalTokens;
			if (at <= input.cutMs) {
				tokensAtTerminal = total;
				lastTotal = total;
				continue;
			}
			const base = lastTotal ?? tokensAtTerminal ?? 0;
			tokensAfterTerminal += total >= base ? total - base : total;
			lastTotal = total;
		}
		const truncated = available > maxBytes;
		return {
			offset: start + consumed,
			lastTotal,
			tokensAtTerminal,
			tokensAfterTerminal,
			complete: !truncated,
			...(note
				? { note }
				: truncated
					? { note: "read_truncated" as const }
					: {}),
		};
	} finally {
		closeSync(fd);
	}
}

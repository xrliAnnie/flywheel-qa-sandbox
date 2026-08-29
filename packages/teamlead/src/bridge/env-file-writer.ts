/**
 * FLY-709 P2 — safe writer for `~/.flywheel/.env`.
 *
 * The Bridge wrapper `set -a; source .env` SHELL-SOURCES this file — it is NOT a
 * plain dotenv. So a flag toggle that appends/edits a line must never produce a
 * form that breaks `source` or changes an UNRELATED key. This module is the pure,
 * conservative core (Codex design R2-2 / code R1 F4):
 *
 *  - keys are validated (`^[A-Za-z_][A-Za-z0-9_]*$`); values must be a safe
 *    unquoted charset (our toggle writes "0"/"1"); anything else is REJECTED,
 *    not guessed.
 *  - an existing key in an `export KEY=` / quoted / duplicated form is REJECTED
 *    (edit .env by hand) rather than rewritten — we only touch a single simple
 *    `KEY=value` line, and preserve every other byte (comments included).
 *  - the fs write is atomic (same-dir temp + rename), 0600, refuses a symlink
 *    target and a group/world-writable parent dir.
 *
 * The raw-vs-effective value policy + the file-SHA re-verification live in the
 * apply route (plan §4.2); this module is the byte-level primitive it calls.
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	lstatSync,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Safe unquoted shell value: no spaces, quotes, $, backtick, newline, glob, etc.
const SAFE_VALUE_RE = /^[A-Za-z0-9_.:/@=+,-]*$/;

export interface EnvChangeResult {
	ok: boolean;
	/** Present when ok. */
	next?: string;
	/** Present when !ok. */
	reason?: string;
}

/** sha256 of the raw file content (the baseline the apply route re-verifies). */
export function computeEnvSha(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Read the effective raw value the shell would set for `key` (last uncommented
 * `KEY=` / `export KEY=` assignment wins). Returns undefined if absent.
 */
export function readEnvValue(content: string, key: string): string | undefined {
	if (!KEY_RE.test(key)) return undefined;
	const re = new RegExp(`^\\s*(?:export\\s+)?${key}=(.*)$`);
	let val: string | undefined;
	for (const line of content.split("\n")) {
		if (/^\s*#/.test(line)) continue;
		const m = line.match(re);
		if (m) val = m[1];
	}
	return val;
}

/**
 * Produce the new file content for setting `key`=`rawTo` (rawTo === null →
 * delete the key). Conservative: rejects unsafe keys/values and any existing
 * key in an export/quoted/duplicated form; preserves all other bytes.
 */
export function applyEnvChange(
	content: string,
	key: string,
	rawTo: string | null,
): EnvChangeResult {
	if (!KEY_RE.test(key)) return { ok: false, reason: `unsafe env key: ${key}` };
	if (rawTo !== null && !SAFE_VALUE_RE.test(rawTo)) {
		return { ok: false, reason: `unsafe env value for ${key}` };
	}
	const lines = content.split("\n");
	const exportRe = new RegExp(`^\\s*export\\s+${key}=`);
	const plainRe = new RegExp(`^(\\s*)${key}=(.*)$`);
	const plainIdx: number[] = [];
	for (const [i, line] of lines.entries()) {
		if (/^\s*#/.test(line)) continue;
		if (exportRe.test(line)) {
			return {
				ok: false,
				reason: `${key} uses an 'export' form in .env — edit it by hand`,
			};
		}
		const m = line.match(plainRe);
		const val = m?.[2];
		if (val !== undefined) {
			if (/^["']/.test(val)) {
				return {
					ok: false,
					reason: `${key} has a quoted value in .env — edit it by hand`,
				};
			}
			plainIdx.push(i);
		}
	}
	if (plainIdx.length > 1) {
		return { ok: false, reason: `${key} is assigned more than once in .env` };
	}

	const idx = plainIdx[0];
	if (idx !== undefined) {
		if (rawTo === null) lines.splice(idx, 1);
		else lines[idx] = `${key}=${rawTo}`;
	} else if (rawTo !== null) {
		// absent → append (keep a single trailing blank line if the file had one)
		if (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.splice(lines.length - 1, 0, `${key}=${rawTo}`);
		} else {
			lines.push(`${key}=${rawTo}`);
		}
	}
	// delete of an absent key = no-op (still ok).
	return { ok: true, next: lines.join("\n") };
}

/**
 * Atomically write `content` to `path`: refuse a symlink target and a
 * group/world-writable parent dir, write to a same-dir temp with 0600, rename.
 */
export function writeEnvFileAtomic(path: string, content: string): void {
	try {
		if (lstatSync(path).isSymbolicLink()) {
			throw new Error(`refusing to write .env: ${path} is a symlink`);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	const dir = dirname(path);
	const dirStat = statSync(dir);
	if (dirStat.mode & 0o022) {
		throw new Error(
			`refusing to write .env: parent dir ${dir} is group/world-writable`,
		);
	}
	const tmp = join(dir, `.env.tmp.${process.pid}.${Date.now()}`);
	const fd = openSync(tmp, "wx", 0o600);
	try {
		writeSync(fd, content);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

/** Synchronous sleep (no busy-spin) — used only for the lock backoff. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding an exclusive advisory lock on `<envPath>.lock`
 * (cross-process; plan §4.3). The in-proc apply path is ALREADY serialized —
 * `applyFlagToggle` is fully synchronous so Node's single event loop runs one
 * read→check→write to completion before the next, and the SHA re-check fails
 * closed for any change since review. This lock is the cross-process belt: it
 * stops a second writer (a stray Bridge, a manual edit racing the toggle) from
 * interleaving between our read and our atomic rename.
 *
 * Fail-CLOSED: if the lock cannot be acquired within `timeoutMs`, throw rather
 * than write unguarded — a founder toggle that can't lock is denied, not risked.
 */
export function withEnvFileLock<T>(
	envPath: string,
	fn: () => T,
	opts: { timeoutMs?: number; pollMs?: number } = {},
): T {
	const lockPath = `${envPath}.lock`;
	const timeoutMs = opts.timeoutMs ?? 3000;
	const pollMs = opts.pollMs ?? 25;
	const start = Date.now();
	let fd: number | undefined;
	for (;;) {
		try {
			fd = openSync(lockPath, "wx"); // O_EXCL — fails if the lock is held
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (Date.now() - start >= timeoutMs) {
				throw new Error(`.env lock busy (${lockPath}) — try again`);
			}
			sleepSync(pollMs);
		}
	}
	try {
		return fn();
	} finally {
		try {
			closeSync(fd);
		} catch {}
		try {
			unlinkSync(lockPath);
		} catch {}
	}
}

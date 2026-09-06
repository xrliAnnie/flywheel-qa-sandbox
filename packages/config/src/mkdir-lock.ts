/**
 * FLY-696 M1/C5 — interprocess lock via atomic `mkdir`.
 *
 * The switch executor (Node) and `flywheel-claude-profile use/next` (bash) both
 * mutate the same machine credential source + `~/.flywheel/claude-accounts.json`,
 * so they must take the SAME lock (Codex R2/R3). Node has no native `flock(2)`;
 * `mkdir` is atomic in both Node and the shell, so a mkdir-based lock is the
 * portable, cross-language primitive both sides can share (bash: `mkdir "$lock"`
 * / `rmdir "$lock"`).
 *
 * Each acquisition owns a unique holder.<pid>.<token> marker. Valid live PIDs
 * are never age-stolen; dead PIDs are recoverable immediately, while marker
 * age is only a malformed/no-PID fallback. Release and stale-break unlink the
 * exact observed marker and rmdir an empty directory — never recursively
 * delete a pathname that a replacement holder may now own.
 */

import { randomBytes } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { processStartTime } from "./pidfile.js";

export interface MkdirLockOpts {
	/** Max time to wait to acquire before throwing (default 30s). */
	timeoutMs?: number;
	/** Backoff between acquire attempts (default 50ms). */
	retryMs?: number;
	/** Age fallback for an empty or malformed/no-PID marker (default 120s). */
	staleMs?: number;
	/** Keep the lock directory empty for legacy shell peers that release with rmdir(1). */
	bare?: boolean;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Deterministic concurrency seam used by adversarial lock tests. */
	beforeStaleBreak?: () => void;
	/** Deterministic concurrency seam used by adversarial lock tests. */
	beforeRelease?: () => void;
	/** Process-identity seam used to detect PID reuse without age-stealing. */
	readProcessStartTime?: (pid: number) => string | null;
}

const HOLDER = "holder";

interface HolderSnapshot {
	markerPath: string;
	pid?: number;
	at?: number;
	token?: string;
	processStartTime?: string;
	dev: number;
	ino: number;
}

interface EmptyLockSnapshot {
	dev: number;
	ino: number;
	mtimeMs: number;
	staleBreakClaims: Array<{ path: string; dev: number; ino: number }>;
}

type LockSnapshot =
	| { kind: "holder"; holder: HolderSnapshot }
	| { kind: "empty"; dir: EmptyLockSnapshot }
	| { kind: "ambiguous" }
	| { kind: "missing" };

const ownedMarkers = new Map<
	string,
	{ markerPath: string; token: string; dev: number; ino: number }
>();

export interface LeaseProof {
	lockPath: string;
	markerPath: string;
	ownershipToken: string;
}

/** Return the currently-owned lease as a non-secret child-process fence. */
export function getLeaseProof(lockPath: string): LeaseProof | null {
	const owned = ownedMarkers.get(lockPath);
	if (!owned) return null;
	const proof = {
		lockPath,
		markerPath: owned.markerPath,
		ownershipToken: owned.token,
	};
	return validateLeaseProof(proof) ? proof : null;
}

/** Validate a proof from marker bytes only, so detached children can fence. */
export function validateLeaseProof(proof: LeaseProof): boolean {
	if (
		dirname(proof.markerPath) !== proof.lockPath ||
		!basename(proof.markerPath).startsWith(`${HOLDER}.`) ||
		proof.ownershipToken.length === 0
	) {
		return false;
	}
	const holder = readMarker(proof.markerPath);
	return holder?.token === proof.ownershipToken;
}

function readMarker(markerPath: string): HolderSnapshot | null {
	try {
		const stat = statSync(markerPath);
		let parsed: {
			pid?: number;
			at?: number;
			token?: string;
			processStartTime?: string;
		} = {};
		try {
			parsed = JSON.parse(readFileSync(markerPath, "utf-8")) as typeof parsed;
		} catch {
			// A killed writer can leave a malformed/empty marker. Preserve its inode
			// and mtime so the documented age fallback can reclaim it safely.
		}
		return {
			markerPath,
			pid: parsed.pid,
			// Renewal touches the unique marker inode instead of replacing a shared
			// pathname, so its mtime is the authoritative lease timestamp.
			at: Math.max(parsed.at ?? 0, stat.mtimeMs),
			token: parsed.token,
			processStartTime: parsed.processStartTime,
			dev: stat.dev,
			ino: stat.ino,
		};
	} catch {
		return null;
	}
}

function inspectLock(lockPath: string): LockSnapshot {
	try {
		const entries = readdirSync(lockPath);
		const names = entries.filter(
			(name) => name === HOLDER || name.startsWith(`${HOLDER}.`),
		);
		if (names.length > 1) return { kind: "ambiguous" };
		if (names.length === 1) {
			const holder = readMarker(join(lockPath, names[0]!));
			return holder === null
				? { kind: "ambiguous" }
				: { kind: "holder", holder };
		}
		const stat = statSync(lockPath);
		const staleBreakClaims = entries
			.filter((name) => name.startsWith(".stale-break."))
			.map((name) => {
				const path = join(lockPath, name);
				const claim = lstatSync(path);
				return { path, dev: claim.dev, ino: claim.ino };
			});
		return {
			kind: "empty",
			dir: {
				dev: stat.dev,
				ino: stat.ino,
				mtimeMs: stat.mtimeMs,
				staleBreakClaims,
			},
		};
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { kind: "missing" }
			: { kind: "ambiguous" };
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if a process with `pid` exists (EPERM counts as alive — exists, not ours). */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isStale(
	snapshot: LockSnapshot,
	now: () => number,
	staleMs: number,
	readStart: (pid: number) => string | null,
) {
	if (snapshot.kind === "missing") return true;
	if (snapshot.kind === "ambiguous") return false;
	if (snapshot.kind === "empty") return now() - snapshot.dir.mtimeMs > staleMs;
	const { pid, at, processStartTime: expectedStart } = snapshot.holder;
	// Correctness wins over forcibly recovering a live-but-hung process. A live
	// holder can renew near the threshold; stealing it based only on an earlier
	// timestamp permits concurrent Keychain writers. Dead holders remain
	// recoverable immediately, while malformed/no-pid markers use the age bound.
	if (typeof pid === "number") {
		if (!isProcessAlive(pid)) return true;
		if (expectedStart) {
			const liveStart = readStart(pid);
			// An unavailable identity probe is fail-closed: never steal a holder we
			// cannot disprove. A mismatch proves the PID was recycled.
			return liveStart !== null && liveStart !== expectedStart;
		}
		// Legacy holders do not carry enough identity to distinguish a long-lived
		// owner from PID reuse. While the PID is alive, fail closed instead of
		// falling through to the age bound and permitting concurrent writers.
		return false;
	}
	// Corrupt and no-PID markers have no process to protect. Their bounded age
	// fallback prevents an abandoned marker from wedging the machine forever.
	return typeof at === "number" && now() - at > staleMs;
}

function sameInode(path: string, dev: number, ino: number): boolean {
	try {
		const stat = statSync(path);
		return stat.dev === dev && stat.ino === ino;
	} catch {
		return false;
	}
}

function sameLstatInode(path: string, dev: number, ino: number): boolean {
	try {
		const stat = lstatSync(path);
		return stat.dev === dev && stat.ino === ino;
	} catch {
		return false;
	}
}

/** Remove only the exact marker observed, then atomically remove an empty dir. */
function removeSnapshot(lockPath: string, snapshot: LockSnapshot): boolean {
	try {
		if (snapshot.kind === "holder") {
			const { markerPath, dev, ino } = snapshot.holder;
			if (!sameInode(markerPath, dev, ino)) return false;
			unlinkSync(markerPath);
		} else if (snapshot.kind === "empty") {
			if (!sameInode(lockPath, snapshot.dir.dev, snapshot.dir.ino))
				return false;
			// A breaker killed between marker rename and unlink leaves one of these
			// unique claims behind. Reap only the exact claim inodes observed in an
			// already-stale directory; unknown entries still make rmdir fail closed.
			if (
				!snapshot.dir.staleBreakClaims.every(({ path, dev, ino }) =>
					sameLstatInode(path, dev, ino),
				)
			)
				return false;
			for (const { path } of snapshot.dir.staleBreakClaims) unlinkSync(path);
		} else {
			return snapshot.kind === "missing";
		}
		rmdirSync(lockPath);
		return true;
	} catch {
		// A replacement holder makes rmdir fail ENOTEMPTY; never recurse into it.
		return false;
	}
}

/** Refresh this process's unique marker inode without writing a shared pathname. */
export function renewMkdirLock(
	lockPath: string,
	now: () => number = Date.now,
): boolean {
	const owned = ownedMarkers.get(lockPath);
	if (!owned) return false;
	try {
		const holder = readMarker(owned.markerPath);
		if (
			holder?.pid !== process.pid ||
			holder.token !== owned.token ||
			holder.dev !== owned.dev ||
			holder.ino !== owned.ino
		)
			return false;
		const refreshedAt = new Date(now());
		utimesSync(owned.markerPath, refreshedAt, refreshedAt);
		return sameInode(owned.markerPath, owned.dev, owned.ino);
	} catch {
		return false;
	}
}

/**
 * Acquire the lock, run `fn`, release (even if `fn` throws). Throws if the lock
 * cannot be acquired within `timeoutMs`.
 */
export async function withMkdirLock<T>(
	lockPath: string,
	fn: () => Promise<T>,
	opts: MkdirLockOpts = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const retryMs = opts.retryMs ?? 50;
	const staleMs = opts.staleMs ?? 120_000;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? defaultSleep;
	const readStart = opts.readProcessStartTime ?? processStartTime;
	const bare = opts.bare ?? false;

	const deadline = now() + timeoutMs;
	let owned:
		| { markerPath: string; token: string; dev: number; ino: number }
		| undefined;
	let bareOwned: { dev: number; ino: number } | undefined;
	for (;;) {
		try {
			mkdirSync(lockPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			const snapshot = inspectLock(lockPath);
			if (isStale(snapshot, now, staleMs, readStart)) {
				opts.beforeStaleBreak?.();
				const removed = removeSnapshot(lockPath, snapshot);
				if (now() >= deadline) {
					throw new Error(`withMkdirLock: timeout acquiring ${lockPath}`);
				}
				if (!removed) await sleep(retryMs);
				continue;
			}
			if (now() >= deadline) {
				throw new Error(`withMkdirLock: timeout acquiring ${lockPath}`);
			}
			await sleep(retryMs);
			continue;
		}
		if (bare) {
			const dirStat = statSync(lockPath);
			bareOwned = { dev: dirStat.dev, ino: dirStat.ino };
			break;
		}

		const token = randomBytes(12).toString("hex");
		const markerPath = join(lockPath, `${HOLDER}.${process.pid}.${token}`);
		let acquiredDir: { dev: number; ino: number } | undefined;
		let markerCreated = false;
		try {
			const dirStat = statSync(lockPath);
			acquiredDir = { dev: dirStat.dev, ino: dirStat.ino };
			const ownerStart = readStart(process.pid);
			writeFileSync(
				markerPath,
				JSON.stringify({
					pid: process.pid,
					at: now(),
					token,
					...(ownerStart ? { processStartTime: ownerStart } : {}),
				}),
				{ flag: "wx" },
			);
			markerCreated = true;
			const stat = statSync(markerPath);
			owned = { markerPath, token, dev: stat.dev, ino: stat.ino };
			ownedMarkers.set(lockPath, owned);
			break; // acquired
		} catch (err) {
			// If a cross-language holder removed the newly-created empty directory
			// before our marker write, retry with the same deadline and backoff as
			// ordinary contention. A missing parent at mkdirSync fails loudly above.
			if (markerCreated) {
				try {
					unlinkSync(markerPath);
				} catch {
					// The unique marker is already gone.
				}
			}
			if (
				acquiredDir &&
				sameInode(lockPath, acquiredDir.dev, acquiredDir.ino)
			) {
				try {
					rmdirSync(lockPath);
				} catch {
					// The directory is no longer empty or is already gone.
				}
			}
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			if (now() >= deadline) {
				throw new Error(`withMkdirLock: timeout acquiring ${lockPath}`);
			}
			await sleep(retryMs);
		}
	}

	let value: T | undefined;
	let criticalError: unknown;
	try {
		value = await fn();
	} catch (error) {
		criticalError = error;
	}
	try {
		opts.beforeRelease?.();
		if (bareOwned !== undefined) {
			if (!sameInode(lockPath, bareOwned.dev, bareOwned.ino)) {
				throw new Error(
					`withMkdirLock: refusing to release replaced bare lock ${lockPath}`,
				);
			}
			rmdirSync(lockPath);
		} else {
			const current = ownedMarkers.get(lockPath);
			if (owned !== undefined && current === owned) {
				removeSnapshot(lockPath, {
					kind: "holder",
					holder: {
						markerPath: owned.markerPath,
						pid: process.pid,
						token: owned.token,
						dev: owned.dev,
						ino: owned.ino,
					},
				});
				ownedMarkers.delete(lockPath);
			}
		}
	} catch (releaseError) {
		// A release failure is actionable only when it is the sole failure. Never
		// mask the critical section's original exception with cleanup fallout.
		if (criticalError === undefined) throw releaseError;
	}
	if (criticalError !== undefined) throw criticalError;
	return value as T;
}

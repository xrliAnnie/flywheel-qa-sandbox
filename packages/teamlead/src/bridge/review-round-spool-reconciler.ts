import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	parseReviewRoundSpoolFile,
	REVIEW_ROUND_SPOOL_FILE_RE,
	REVIEW_ROUND_SPOOL_MAX_BYTES,
	reviewRoundQuarantineDir,
	reviewRoundSpoolDir,
} from "flywheel-comm/review-round-spool";
import {
	ingestReviewRound,
	type ReviewRoundIngestStore,
} from "./review-round-ingest.js";

/**
 * FLY-2891: the Bridge-resident owner of review-round write-backs that missed
 * the synchronous HTTP path (Bridge down, restarting, old build, lost receipt).
 * Runs at boot and on an interval, so a record spooled by a runner that has
 * since exited — worktree deleted — still lands once the Bridge is healthy.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface ReviewRoundSpoolTickResult {
	scanned: number;
	ingested: number;
	quarantined: number;
	retained: number;
	skipped: number;
	budgetExhausted: boolean;
}

export interface ReviewRoundSpoolReconcilerOptions {
	dir?: string;
	now?: () => number;
	logger?: Pick<Console, "warn">;
	maxFiles?: number;
	maxMs?: number;
	retryWindowMs?: number;
	staleMs?: number;
	staleWarnIntervalMs?: number;
}

function readOwnedRegularFile(
	path: string,
):
	| { ok: true; raw: string; mtimeMs: number }
	| { ok: false; skip: string; quarantine?: true } {
	const stat = lstatSync(path);
	if (!stat.isFile()) return { ok: false, skip: "not a regular file" };
	if (typeof process.getuid === "function" && stat.uid !== process.getuid())
		return { ok: false, skip: "owned by another user" };
	// Our own regular file that can never be ingested: move it aside (visible)
	// instead of letting it sit in the pending queue forever.
	if (stat.size > REVIEW_ROUND_SPOOL_MAX_BYTES)
		return { ok: false, skip: "oversized", quarantine: true };
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.size > REVIEW_ROUND_SPOOL_MAX_BYTES)
			return { ok: false, skip: "changed while opening" };
		const buffer = Buffer.alloc(opened.size);
		let count = 0;
		while (count < opened.size) {
			const read = readSync(fd, buffer, count, opened.size - count, count);
			if (!read) break;
			count += read;
		}
		return {
			ok: true,
			raw: buffer.subarray(0, count).toString("utf8"),
			mtimeMs: opened.mtimeMs,
		};
	} finally {
		closeSync(fd);
	}
}

export function createReviewRoundSpoolReconciler(
	store: ReviewRoundIngestStore,
	opts: ReviewRoundSpoolReconcilerOptions = {},
): { tick(): ReviewRoundSpoolTickResult } {
	const dir = opts.dir ?? reviewRoundSpoolDir();
	const quarantineDir = reviewRoundQuarantineDir(dir);
	const now = opts.now ?? Date.now;
	const logger = opts.logger ?? console;
	const maxFiles = opts.maxFiles ?? 100;
	const maxMs = opts.maxMs ?? 5_000;
	const retryWindowMs = opts.retryWindowMs ?? 7 * DAY_MS;
	const staleMs = opts.staleMs ?? HOUR_MS;
	const staleWarnIntervalMs = opts.staleWarnIntervalMs ?? HOUR_MS;
	let lastStaleWarnAt = Number.NEGATIVE_INFINITY;

	const quarantine = (name: string, reason: string): void => {
		mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
		renameSync(join(dir, name), join(quarantineDir, name));
		writeFileSync(join(quarantineDir, `${name}.reason`), `${reason}\n`, {
			mode: 0o600,
		});
		const executionId = REVIEW_ROUND_SPOOL_FILE_RE.exec(name)?.[1] ?? "?";
		logger.warn(
			`[review-round-spool] quarantined ${executionId} record ${name.slice(-41, -5)}: ${reason.slice(0, 200)}`,
		);
	};

	return {
		tick(): ReviewRoundSpoolTickResult {
			const result: ReviewRoundSpoolTickResult = {
				scanned: 0,
				ingested: 0,
				quarantined: 0,
				retained: 0,
				skipped: 0,
				budgetExhausted: false,
			};
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					logger.warn(
						`[review-round-spool] cannot list spool: ${(error as Error).message}`,
					);
				return result;
			}
			const started = now();
			// Crashed writers leave `.name.pid.uuid.tmp`; reap stale ones only.
			for (const name of names) {
				if (!name.startsWith(".") || !name.endsWith(".tmp")) continue;
				try {
					const stat = lstatSync(join(dir, name));
					if (stat.isFile() && started - stat.mtimeMs > HOUR_MS)
						unlinkSync(join(dir, name));
				} catch {
					/* raced with the writer's own rename/cleanup */
				}
			}
			const candidates = names
				.filter((name) => REVIEW_ROUND_SPOOL_FILE_RE.test(name))
				.map((name) => {
					try {
						return { name, mtimeMs: lstatSync(join(dir, name)).mtimeMs };
					} catch {
						return undefined;
					}
				})
				.filter((entry): entry is { name: string; mtimeMs: number } => !!entry)
				// Oldest first: for one turn, the first-spooled delivery wins and a
				// later conflicting one is the one quarantined.
				.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
			let staleCount = 0;
			// The file budget counts only records that passed the safe read, so
			// untouchable entries (symlinks, foreign files) can never starve it.
			let processed = 0;
			for (const [index, { name }] of candidates.entries()) {
				if (processed >= maxFiles || now() - started > maxMs) {
					result.budgetExhausted = true;
					break;
				}
				result.scanned += 1;
				try {
					const file = readOwnedRegularFile(join(dir, name));
					if (!file.ok) {
						if (file.quarantine) {
							quarantine(
								name,
								`${file.skip}: record exceeds ${REVIEW_ROUND_SPOOL_MAX_BYTES} bytes`,
							);
							result.quarantined += 1;
							continue;
						}
						result.skipped += 1;
						if (now() - candidates[index]!.mtimeMs > staleMs) staleCount += 1;
						continue;
					}
					processed += 1;
					const parsed = parseReviewRoundSpoolFile(file.raw);
					if (!parsed.ok) {
						quarantine(name, `invalid_payload: ${parsed.reason}`);
						result.quarantined += 1;
						continue;
					}
					const outcome = ingestReviewRound(store, parsed.record.body, {
						delivery: "spool",
						now: () => new Date(now()),
						logger,
					});
					if (outcome.httpStatus === 200) {
						unlinkSync(join(dir, name));
						result.ingested += 1;
						continue;
					}
					const { errorType, reason } = outcome.body;
					if (
						errorType === "invalid_payload" ||
						errorType === "conflict" ||
						errorType === "project_mismatch"
					) {
						quarantine(name, `${errorType}: ${reason}`);
						result.quarantined += 1;
						continue;
					}
					const spooledAt = Date.parse(parsed.record.spooledAt);
					const age =
						now() - (Number.isFinite(spooledAt) ? spooledAt : file.mtimeMs);
					if (age > retryWindowMs) {
						quarantine(
							name,
							`retry window expired: ${errorType ?? `HTTP ${outcome.httpStatus}`}: ${reason}`,
						);
						result.quarantined += 1;
						continue;
					}
					result.retained += 1;
					if (age > staleMs) staleCount += 1;
				} catch (error) {
					result.retained += 1;
					logger.warn(
						`[review-round-spool] ${name.slice(0, 36)} retained: ${(error as Error).message}`,
					);
				}
			}
			if (staleCount > 0 && now() - lastStaleWarnAt >= staleWarnIntervalMs) {
				lastStaleWarnAt = now();
				logger.warn(
					`[review-round-spool] ${staleCount} review round record(s) pending for over ${Math.round(staleMs / 60_000)} minutes in ${dir}`,
				);
			}
			return result;
		},
	};
}

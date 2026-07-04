/**
 * FLY-137 Phase 5: blocking Codex review gate command.
 *
 * Runner-side blocking wait for a Codex review result JSON file. Polls
 * `.flywheel/runs/<execId>/codex/<type>-review.json` (or honors a
 * Bridge-written `skip.json` marker for the codex-skip label path). Exits
 * 0 on a VALID approved result or a matching skip marker; exits 1 on
 * timeout, schema mismatch, malformed JSON, or any other failure
 * (fail-closed — this is what makes the gate enforceable, unlike the
 * fail-open `stage set` command).
 *
 * Companion piece to the `event-route` Codex auto-trigger: Bridge writes
 * the Codex instruction (or skip.json), Runner runs `/codex-design-review`
 * (or `/codex-code-review`), writes the result JSON, then calls this
 * command to block until the file is present + valid before advancing
 * stages.
 *
 * Result schema (written by Runner after Codex APPROVED):
 *
 *   {
 *     "executionId": "<uuid>",
 *     "reviewType": "design" | "code",
 *     "status": "APPROVED",
 *     "reviewedTarget": "<plan-path-or-pr-url>",
 *     "timestamp": "<ISO-8601>",
 *     "rounds": <integer>,
 *     "codexThreadId": "<string>"
 *   }
 *
 * Skip schema (written by Bridge when codex-skip label present):
 *
 *   {
 *     "executionId": "<uuid>",
 *     "reviewType": "design" | "code",
 *     "reason": "codex-skip-label",
 *     "timestamp": "<ISO-8601>"
 *   }
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { emitCodexReviewResult } from "./codex-review-result.js";

const VALID_REVIEW_TYPES = new Set(["design", "code"]);
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

// Poll interval + timeout defaults. 2s × 30 min = 900 polls.
const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

// Allow a 24h window between timestamp and now to catch stale files.
const MAX_RESULT_AGE_MS = 24 * 60 * 60 * 1000;

export interface AwaitCodexGateOpts {
	reviewType: string;
	execId: string;
	worktreePath?: string;
	timeoutMs?: number;
	pollIntervalMs?: number;
}

interface ResultPayload {
	executionId?: unknown;
	reviewType?: unknown;
	status?: unknown;
	reviewedTarget?: unknown;
	/** FLY-827: the commit Codex actually reviewed (code review only). */
	reviewedHeadSha?: unknown;
	timestamp?: unknown;
	rounds?: unknown;
	codexThreadId?: unknown;
}

/** Current git HEAD (40-hex, lower-case), or undefined if not resolvable. */
function gitHead(worktreePath?: string): string | undefined {
	try {
		const sha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: worktreePath ?? process.cwd(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		})
			.trim()
			.toLowerCase();
		return FULL_SHA_RE.test(sha) ? sha : undefined;
	} catch {
		return undefined;
	}
}

interface SkipPayload {
	executionId?: unknown;
	reviewType?: unknown;
	reason?: unknown;
	timestamp?: unknown;
}

function codexDirFor(opts: AwaitCodexGateOpts): string {
	const root = opts.worktreePath ?? process.cwd();
	return resolvePath(root, ".flywheel", "runs", opts.execId, "codex");
}

function skipPathFor(opts: AwaitCodexGateOpts): string {
	return resolvePath(codexDirFor(opts), "skip.json");
}

function resultPathFor(opts: AwaitCodexGateOpts): string {
	return resolvePath(codexDirFor(opts), `${opts.reviewType}-review.json`);
}

/**
 * Validate the skip.json marker. Returns true if it's a legitimate skip
 * for this exec + review type, false otherwise. Errors on parse / shape
 * mismatch are treated as "not a valid skip" (fall through to result
 * polling) — Bridge writes this atomically so a partial read shouldn't
 * happen, but we don't want a corrupted file to silently bypass review.
 */
function isValidSkip(opts: AwaitCodexGateOpts): boolean {
	const path = skipPathFor(opts);
	if (!existsSync(path)) return false;
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as SkipPayload;
		if (parsed.executionId !== opts.execId) return false;
		if (parsed.reviewType !== opts.reviewType) return false;
		if (typeof parsed.reason !== "string" || parsed.reason.length === 0) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Validate the result JSON. Returns null on success; a string error
 * message on failure (the caller decides whether to retry — for the
 * normal flow, validation failure is fatal). Result files are
 * write-once (Runner writes after Codex APPROVED), so a failed
 * validation means a real schema bug, not a race.
 */
function validateResult(
	opts: AwaitCodexGateOpts,
	payload: ResultPayload,
): string | null {
	if (payload.executionId !== opts.execId) {
		return `executionId mismatch: expected ${opts.execId}, got ${String(payload.executionId)}`;
	}
	if (payload.reviewType !== opts.reviewType) {
		return `reviewType mismatch: expected ${opts.reviewType}, got ${String(payload.reviewType)}`;
	}
	if (payload.status !== "APPROVED") {
		return `status not APPROVED: ${String(payload.status)}`;
	}
	if (
		typeof payload.reviewedTarget !== "string" ||
		payload.reviewedTarget.length === 0
	) {
		return `reviewedTarget missing or empty`;
	}
	if (typeof payload.timestamp !== "string") {
		return `timestamp missing`;
	}
	const ts = Date.parse(payload.timestamp);
	if (!Number.isFinite(ts)) {
		return `timestamp not parseable: ${payload.timestamp}`;
	}
	const ageMs = Date.now() - ts;
	if (ageMs < -60_000) {
		return `timestamp in the future: ${payload.timestamp}`;
	}
	if (ageMs > MAX_RESULT_AGE_MS) {
		return `timestamp older than 24h: ${payload.timestamp}`;
	}
	// FLY-827 (Codex R1 HIGH-2): for CODE review, the result must be bound to the
	// commit Codex reviewed, and that commit must equal the CURRENT git HEAD.
	// Otherwise a stale `code-review.json` (still within the 24h window) would let
	// the gate pass — and report the NEW head as approved — after the implementer
	// pushed a fix. Fail-closed on a missing/mismatched head; design review is
	// unaffected (no head binding).
	if (opts.reviewType === "code") {
		const reviewedHead =
			typeof payload.reviewedHeadSha === "string"
				? payload.reviewedHeadSha.toLowerCase()
				: undefined;
		if (!reviewedHead || !FULL_SHA_RE.test(reviewedHead)) {
			return `code review result missing/invalid reviewedHeadSha (got ${String(payload.reviewedHeadSha)}) — re-run /codex-code-review and record the reviewed head`;
		}
		const head = gitHead(opts.worktreePath);
		if (!head) {
			return `could not resolve git HEAD to verify reviewedHeadSha`;
		}
		if (reviewedHead !== head) {
			return `reviewedHeadSha ${reviewedHead.slice(0, 8)} != current HEAD ${head.slice(0, 8)} — the PR moved since Codex reviewed; re-run /codex-code-review for the new head`;
		}
	}
	return null;
}

/**
 * Read + validate the result file. Returns:
 *   { ok: true } — passed all checks
 *   { ok: false, fatal: true, error } — file exists but invalid (fail-closed)
 *   { ok: false, fatal: false } — file missing (keep polling)
 */
function readResult(
	opts: AwaitCodexGateOpts,
):
	| { ok: true }
	| { ok: false; fatal: true; error: string }
	| { ok: false; fatal: false } {
	const path = resultPathFor(opts);
	if (!existsSync(path)) {
		return { ok: false, fatal: false };
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err) {
		return {
			ok: false,
			fatal: true,
			error: `failed to read ${path}: ${(err as Error).message}`,
		};
	}
	let parsed: ResultPayload;
	try {
		parsed = JSON.parse(raw) as ResultPayload;
	} catch (err) {
		return {
			ok: false,
			fatal: true,
			error: `failed to parse ${path}: ${(err as Error).message}`,
		};
	}
	const error = validateResult(opts, parsed);
	if (error) {
		return { ok: false, fatal: true, error };
	}
	return { ok: true };
}

/**
 * Sleep for `ms` milliseconds. Promise-based wrapper for setTimeout to
 * keep the polling loop async-clean.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * FLY-827: on a VALID code-review APPROVAL, report the verdict to the Bridge so
 * it can record the durable, head-bound approval (the authoritative gate record,
 * not a PR comment). Best-effort: a delivery failure never fails the local gate
 * (the Bridge's fail-closed hard gate + the marker cover the miss). Only fires
 * for reviewType === "code"; design review is a pre-implement gate, not gated.
 */
async function reportCodeApproval(opts: AwaitCodexGateOpts): Promise<void> {
	if (opts.reviewType !== "code") return;
	let payload: ResultPayload;
	try {
		payload = JSON.parse(readFileSync(resultPathFor(opts), "utf-8"));
	} catch {
		return; // validated already; a re-read race is non-fatal for the report
	}
	const reviewedHead =
		typeof payload.reviewedHeadSha === "string"
			? payload.reviewedHeadSha
			: undefined;
	await emitCodexReviewResult({
		execId: opts.execId,
		prHeadSha: reviewedHead,
		reviewedTarget:
			typeof payload.reviewedTarget === "string"
				? payload.reviewedTarget
				: undefined,
		rounds: typeof payload.rounds === "number" ? payload.rounds : undefined,
		codexThreadId:
			typeof payload.codexThreadId === "string"
				? payload.codexThreadId
				: undefined,
	});
}

/**
 * Main entry point — exits the process with 0 (success) or 1 (failure).
 * Never throws into the caller; all errors are written to stderr and
 * the process exits non-zero.
 */
export async function awaitCodexGate(opts: AwaitCodexGateOpts): Promise<void> {
	if (!opts.execId || typeof opts.execId !== "string") {
		console.error("--exec-id is required");
		process.exit(1);
	}
	if (!VALID_REVIEW_TYPES.has(opts.reviewType)) {
		console.error(
			`Invalid review type: ${opts.reviewType}. Valid: ${[...VALID_REVIEW_TYPES].join(", ")}`,
		);
		process.exit(1);
	}

	// Step 1: check skip marker first. Bridge writes this atomically when
	// the codex-skip label was snapshotted at run start; bypass review.
	if (isValidSkip(opts)) {
		console.log(
			`[await-codex-gate] codex-skip-bypass for ${opts.reviewType} review (exec=${opts.execId})`,
		);
		process.exit(0);
	}

	// Step 2: poll for the result file.
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		// Re-check skip marker each loop — Bridge could write it
		// mid-flight if a delayed label scan completes (defensive; not
		// the primary path).
		if (isValidSkip(opts)) {
			console.log(
				`[await-codex-gate] codex-skip-bypass for ${opts.reviewType} review (exec=${opts.execId})`,
			);
			process.exit(0);
		}

		const result = readResult(opts);
		if (result.ok) {
			console.log(
				`[await-codex-gate] ${opts.reviewType} review APPROVED for exec=${opts.execId}`,
			);
			// FLY-827: report the code-review verdict to the Bridge (best-effort; a
			// delivery failure never fails the local gate).
			await reportCodeApproval(opts);
			process.exit(0);
		}
		if (result.fatal) {
			console.error(`[await-codex-gate] ${result.error}`);
			process.exit(1);
		}
		await sleep(pollIntervalMs);
	}

	console.error(
		`[await-codex-gate] timeout after ${timeoutMs}ms waiting for ${opts.reviewType} review (exec=${opts.execId}). Expected file: ${resultPathFor(opts)}`,
	);
	process.exit(1);
}

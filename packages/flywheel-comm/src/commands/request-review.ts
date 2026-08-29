/**
 * FLY-1188 §7.1 — `flywheel-comm request-review`: register a review REQUEST
 * with the Bridge, bound to an already-opened review gate questionId
 * (codex-author lane).
 *
 * Runner flow (deterministic, pre-baked into the codex contract):
 *   1. `stage set design_review --plan <p>` (or pr_created) — unchanged;
 *   2. open `gate review_design|review_code --no-block` → questionId;
 *   3. THIS COMMAND: durably persist the intent locally FIRST (temp+rename),
 *      then POST the Bridge, bounded retry; on exhaustion leave a fail-close
 *      marker and EXIT NON-ZERO — the runner must NOT wait on a gate that was
 *      never registered (R2 #3). Success = the Bridge's durable-accepted ack
 *      (response body confirms the job row is committed — not a bare 2xx);
 *   4. end the turn and wait on the gate (existing awaiting_gate machinery).
 *
 * The payload is VALIDATED INPUT, never authority: the Bridge derives author
 * family and the trusted code-review head server-side.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RequestReviewOptions {
	execId?: string;
	type?: string;
	questionId?: string;
	planPath?: string;
	requestId?: string;
	/** Test seams. */
	fetchImpl?: typeof fetch;
	stateDir?: string;
	env?: NodeJS.ProcessEnv;
	attemptCount?: number;
	backoffMs?: number[];
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_BACKOFF_MS = [1_000, 3_000, 8_000];
const ATTEMPT_TIMEOUT_MS = 20_000;

export interface RequestReviewAck {
	accepted: boolean;
	requestId?: string;
	skipped?: boolean;
	duplicate?: boolean;
	reason?: string;
}

/** Exit codes: 0 = durable-accepted; 1 = usage/env; 2 = NOT registered. */
export async function requestReview(
	opts: RequestReviewOptions,
): Promise<never> {
	const env = opts.env ?? process.env;
	const execId = (opts.execId ?? env.FLYWHEEL_EXEC_ID ?? "").trim();
	if (!execId) {
		console.error("--exec-id or FLYWHEEL_EXEC_ID is required");
		process.exit(1);
	}
	const reviewType = (opts.type ?? "").trim();
	if (reviewType !== "design" && reviewType !== "code") {
		console.error("--type design|code is required");
		process.exit(1);
	}
	const questionId = (opts.questionId ?? "").trim();
	if (!questionId) {
		console.error(
			"--question-id is required (open the review gate with `gate review_design|review_code --no-block` first)",
		);
		process.exit(1);
	}
	if (reviewType === "design" && !opts.planPath?.trim()) {
		console.error("--plan <path> is required for --type design");
		process.exit(1);
	}
	const bridgeUrl = (env.FLYWHEEL_BRIDGE_URL ?? "").trim();
	if (!bridgeUrl) {
		console.error("FLYWHEEL_BRIDGE_URL environment variable is required");
		process.exit(1);
	}

	const requestId = (opts.requestId ?? "").trim() || randomUUID();
	const payload = {
		executionId: execId,
		requestId,
		reviewType,
		questionId,
		...(opts.planPath?.trim() ? { planPath: opts.planPath.trim() } : {}),
	};

	const stateDir =
		opts.stateDir ?? join(homedir(), ".flywheel", "state", "review-requests");
	// §7.1 step 3: durable local intent FIRST (temp+rename) — a crash between
	// here and the ack leaves a replayable record instead of silence. R12 HIGH:
	// if the INTENT cannot be persisted, abort BEFORE any network request —
	// "intent first" must never silently degrade to fail-open.
	if (
		!writeAtomic(join(stateDir, `${requestId}.json`), {
			...payload,
			status: "posting",
			timestamp: new Date().toISOString(),
		})
	) {
		console.error(
			`[request-review] FAIL-CLOSE: cannot persist the local intent marker under ${stateDir} — aborting before any POST. Fix the state dir and retry with --request-id ${requestId}.`,
		);
		process.exit(2);
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	const ingestToken = env.FLYWHEEL_INGEST_TOKEN;
	if (ingestToken) headers.Authorization = `Bearer ${ingestToken}`;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const attempts = opts.attemptCount ?? DEFAULT_ATTEMPTS;
	const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;

	let lastError: string | undefined;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		let response: Response | undefined;
		let body: RequestReviewAck | undefined;
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
			try {
				response = await fetchImpl(`${bridgeUrl}/review-requests`, {
					method: "POST",
					headers,
					body: JSON.stringify(payload),
					signal: controller.signal,
				});
				// R12 MEDIUM: the timeout must cover the BODY read too — a stuck
				// body would otherwise bypass the bounded-retry contract.
				body = (await response.json().catch(() => undefined)) as
					| RequestReviewAck
					| undefined;
			} finally {
				clearTimeout(timer);
			}
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		if (response?.ok && body?.accepted === true) {
			// durable-accepted ack — the job row is committed server-side
			writeAtomic(join(stateDir, `${requestId}.json`), {
				...payload,
				status: "accepted",
				skipped: body.skipped === true,
				duplicate: body.duplicate === true,
				timestamp: new Date().toISOString(),
			});
			console.log(JSON.stringify({ ...body, requestId }));
			process.exit(0);
		}
		if (response) {
			if (!response.ok && response.status >= 400 && response.status < 500) {
				// validation fail-close (bad binding / answered gate / no head):
				// retrying the identical payload cannot succeed — fail NOW.
				lastError = `Bridge rejected (${response.status}): ${body?.reason ?? "unknown"}`;
				console.error(`[request-review] ${lastError}`);
				break;
			}
			lastError = `Bridge returned ${response.status}${body?.reason ? ` (${body.reason})` : ""}`;
		}
		console.error(
			`[request-review] attempt ${attempt}/${attempts} failed: ${lastError}`,
		);
		if (attempt < attempts) await sleep(backoff[attempt - 1] ?? 5_000);
	}

	// FAIL-CLOSE: the gate was NOT registered. Marker for the reconciler +
	// non-zero exit so the runner does not park on an unregistered gate.
	writeAtomic(join(stateDir, `${requestId}.json`), {
		...payload,
		status: "failed",
		error: lastError,
		timestamp: new Date().toISOString(),
	});
	console.error(
		`[request-review] FAIL-CLOSE: review request ${requestId} was NOT registered with the Bridge (${lastError}). ` +
			`Do NOT wait on gate ${questionId} — report to your Lead or retry with --request-id ${requestId}.`,
	);
	process.exit(2);
}

function writeAtomic(path: string, value: unknown): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
		renameSync(tmp, path);
		return true;
	} catch (err) {
		console.error(
			`[request-review] marker write failed at ${path}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

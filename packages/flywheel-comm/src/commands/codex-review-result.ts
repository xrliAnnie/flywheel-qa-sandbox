/**
 * FLY-827: Runner-driven Codex CODE-review verdict emitter.
 *
 * Emitted by `await-codex-gate code` after it validates the local
 * `code-review.json` (status APPROVED + reviewedHeadSha === git HEAD). It is the
 * authoritative signal — NOT a PR comment — that Codex approved THIS exact head.
 * The Bridge's AutoQaCoordinator.onCodexReviewResult consumes the
 * `codex_review_result` event, records the durable approval keyed to the head,
 * and (race closure) re-drives auto-QA if the parent already reached
 * awaiting_review.
 *
 * Reliability mirrors qa-result.ts: retry with backoff + a fail-close marker on
 * exhaustion. A lost verdict must never be silently treated as "Codex passed" —
 * with no event the Bridge's hard gate holds the founder + blocks merge
 * (fail-closed), and the runner's marker records the delivery failure.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ATTEMPT_COUNT = 4;
const ATTEMPT_TIMEOUT_MS = 5000;
const BACKOFF_MS = [1000, 2000, 4000] as const;

export interface CodexReviewResultOpts {
	/** Runner (implementer/main) execution id whose PR was reviewed. Defaults to FLYWHEEL_EXEC_ID. */
	execId?: string;
	/** The reviewed head Codex APPROVED — full 40-hex. Defaults to git HEAD. */
	prHeadSha?: string;
	/** The reviewed PR URL (audit). */
	reviewedTarget?: string;
	/** Codex review rounds (audit). */
	rounds?: number;
	/** Codex persistent thread id (audit). */
	codexThreadId?: string;
}

export interface CodexReviewResultBody {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	event_type: "codex_review_result";
	source: string;
	payload: {
		reviewType: "code";
		status: "APPROVED";
		targetExecutionId: string;
		prHeadSha: string;
		reviewedTarget?: string;
		rounds?: number;
		codexThreadId?: string;
	};
}

/** Pure builder — unit-testable without the network/marker machinery. */
export function buildCodexReviewResultBody(args: {
	execId: string;
	issueId: string;
	projectName: string;
	prHeadSha: string;
	reviewedTarget?: string;
	rounds?: number;
	codexThreadId?: string;
	eventId?: string;
}): CodexReviewResultBody {
	const payload: CodexReviewResultBody["payload"] = {
		reviewType: "code",
		status: "APPROVED",
		targetExecutionId: args.execId,
		prHeadSha: args.prHeadSha.toLowerCase(),
	};
	if (args.reviewedTarget) payload.reviewedTarget = args.reviewedTarget;
	if (typeof args.rounds === "number") payload.rounds = args.rounds;
	if (args.codexThreadId) payload.codexThreadId = args.codexThreadId;
	return {
		event_id: args.eventId ?? randomUUID(),
		execution_id: args.execId,
		issue_id: args.issueId,
		project_name: args.projectName,
		event_type: "codex_review_result",
		source: "flywheel-comm",
		payload,
	};
}

/**
 * Emit the verdict to the Bridge (retry + fail-close marker). Returns true on
 * delivery, false on exhaustion (marker written). BEST-EFFORT by design: the
 * caller (await-codex-gate) still exits 0 on a delivery failure so the runner's
 * local gate isn't broken by a transient Bridge outage — the Bridge's fail-closed
 * hard gate + the marker cover the miss.
 */
export async function emitCodexReviewResult(
	opts: CodexReviewResultOpts,
): Promise<boolean> {
	const execId = (opts.execId ?? process.env.FLYWHEEL_EXEC_ID ?? "").trim();
	if (!execId) {
		console.error(
			"[codex-review-result] --exec-id or FLYWHEEL_EXEC_ID required — skipping report",
		);
		return false;
	}
	const issueId = process.env.FLYWHEEL_ISSUE_ID;
	const projectName = process.env.FLYWHEEL_PROJECT_NAME;
	const bridgeUrl = process.env.FLYWHEEL_BRIDGE_URL;
	if (!issueId || !projectName || !bridgeUrl) {
		console.error(
			"[codex-review-result] missing FLYWHEEL_ISSUE_ID / FLYWHEEL_PROJECT_NAME / FLYWHEEL_BRIDGE_URL — skipping report (Bridge fail-closed gate will hold)",
		);
		return false;
	}
	const prHeadSha = (opts.prHeadSha ?? deriveHeadSha())?.trim().toLowerCase();
	if (!prHeadSha || !/^[0-9a-f]{40}$/.test(prHeadSha)) {
		console.error(
			`[codex-review-result] no valid prHeadSha (${prHeadSha ?? "none"}) — skipping report`,
		);
		return false;
	}

	const body = buildCodexReviewResultBody({
		execId,
		issueId,
		projectName,
		prHeadSha,
		reviewedTarget: opts.reviewedTarget,
		rounds: opts.rounds,
		codexThreadId: opts.codexThreadId,
	});

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	const ingestToken = process.env.FLYWHEEL_INGEST_TOKEN;
	if (ingestToken) headers.Authorization = `Bearer ${ingestToken}`;

	let lastError: string | undefined;
	for (let attempt = 1; attempt <= ATTEMPT_COUNT; attempt += 1) {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
			const response = await fetch(`${bridgeUrl}/events`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			clearTimeout(timer);
			if (response.ok) {
				console.log(
					`[codex-review-result] APPROVED verdict delivered for ${execId} @ ${prHeadSha.slice(0, 8)} (attempt ${attempt}/${ATTEMPT_COUNT})`,
				);
				return true;
			}
			lastError = `Bridge returned ${response.status}`;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		console.error(
			`[codex-review-result] attempt ${attempt}/${ATTEMPT_COUNT} failed: ${lastError}`,
		);
		if (attempt < ATTEMPT_COUNT) await sleep(BACKOFF_MS[attempt - 1] ?? 0);
	}

	writeMarker({ execId, requestId: body.event_id, body, lastError });
	console.error(
		`[codex-review-result] FAIL-CLOSE: ${ATTEMPT_COUNT} attempts failed (marker written). Last error: ${lastError}`,
	);
	return false;
}

function deriveHeadSha(): string | undefined {
	try {
		const sha = execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		})
			.trim()
			.toLowerCase();
		return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
	} catch {
		return undefined;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeMarker(args: {
	execId: string;
	requestId: string;
	body: unknown;
	lastError: string | undefined;
}): void {
	const home = process.env.HOME ?? homedir();
	const dir = join(home, ".flywheel", "state", "codex-review-result-failed");
	const markerPath = join(dir, `${args.execId}.json`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			markerPath,
			JSON.stringify(buildCodexReviewFailureMarker(args), null, 2),
			"utf8",
		);
	} catch (err) {
		console.error(
			`[codex-review-result] CRITICAL: marker write failed at ${markerPath}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/** Opaque retry marker: preserve correlation, never persist the verdict body. */
export function buildCodexReviewFailureMarker(args: {
	execId: string;
	requestId: string;
	body: unknown;
	lastError: string | undefined;
	timestamp?: string;
}): {
	execution_id: string;
	client_request_id: string;
	error: string | undefined;
	timestamp: string;
	body_digest: string;
} {
	return {
		execution_id: args.execId,
		client_request_id: args.requestId,
		error: args.lastError,
		timestamp: args.timestamp ?? new Date().toISOString(),
		body_digest: createHash("sha256")
			.update(JSON.stringify(args.body))
			.digest("hex"),
	};
}

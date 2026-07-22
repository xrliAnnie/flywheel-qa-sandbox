/**
 * FLY-579 P1: Runner-driven QA verdict emitter (`flywheel-comm qa-result`).
 *
 * An auto-spawned QA Runner (sessionRole="qa") emits this AFTER it finishes
 * verifying the implementer's PR and BEFORE `complete --route no_code`. It is
 * the structured verdict that gates the founder: the Bridge's AutoQaCoordinator
 * consumes the `qa_result` event and either RELEASES the founder ship-ready
 * notification (pass) or routes the report back to the implementer (fail) —
 * the founder is never notified on fail.
 *
 * Reliability mirrors `complete.ts`: retry with backoff + fail-close marker on
 * exhaustion. A lost verdict must never be silently treated as "QA passed" —
 * the coordinator's lost-event reconcile marks the record `stuck` and pings the
 * Lead, never auto-releases.
 *
 * Payload is consumed by `event-route.ts` (event_type === "qa_result") →
 * `AutoQaCoordinator.onQaResult`.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VALID_STATUSES = new Set(["pass", "fail"]);

const ATTEMPT_COUNT = 4;
const ATTEMPT_TIMEOUT_MS = 5000;
const BACKOFF_MS = [1000, 2000, 4000] as const;

const DETERMINISTIC_REJECTION_REASONS = new Set([
	"workflow_submission_required",
	"credential_not_found",
	"credential_revoked",
	"credential_expired",
	"credential_receipt_corrupt",
	"invalid_request",
	"invalid_status",
	"invalid_client_head",
	"invalid_timestamp",
	"head_authority_mismatch",
	"replay_payload_mismatch",
	"not_durable_qa_execution",
	"predicate_not_allowed",
	"binding_not_current",
	"same_vendor_review",
	"missing_subject_producer",
	"node_does_not_emit_decisions",
	"decision_family_mismatch",
	"materialized_head_invalid",
	"materialized_output_mismatch",
	"materialized_producer_ambiguous",
	"execution_not_found",
	"worktree_not_found",
	"invalid_git_head",
	"run_not_found",
	"transition_refused",
]);

/**
 * The Bridge reason vocabulary is intentionally open. Known structural
 * rejections stop immediately; unknown reasons retain the bounded retry path
 * so a newer Bridge cannot accidentally make an older CLI fail permanently.
 */
export function classifyQaResultRejection(
	reason: string | undefined,
): "fail" | "retry" {
	return reason && DETERMINISTIC_REJECTION_REASONS.has(reason)
		? "fail"
		: "retry";
}

export interface QaResultOpts {
	/** "pass" | "fail" — the QA verdict. */
	status: string;
	/** The parent (implementer/main) execution id this verdict gates. */
	targetExec: string;
	/** Human-readable verdict summary (what was tested + any blocking issue). */
	summary?: string;
	/** QA runner's own execution id. Defaults to FLYWHEEL_EXEC_ID. */
	execId?: string;
	/** Reviewed PR head the QA worktree was pinned to. Defaults to git HEAD. */
	prHeadSha?: string;
}

export interface QaResultBody {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	event_type: "qa_result";
	source: string;
	payload: {
		status: "pass" | "fail";
		targetExecutionId: string;
		qaExecutionId: string;
		prHeadSha?: string;
		summary?: string;
	};
}

export interface WorkflowQaDecisionBody {
	credential: string;
	client_request_id: string;
	status: "pass" | "fail";
	client_pr_head_sha?: string;
	summary?: string;
}

/**
 * Pure builder for the `qa_result` event body. Extracted so the verdict shape
 * is unit-testable without the network/marker machinery.
 */
export function buildQaResultBody(args: {
	status: "pass" | "fail";
	qaExecutionId: string;
	targetExecutionId: string;
	issueId: string;
	projectName: string;
	prHeadSha?: string;
	summary?: string;
	eventId?: string;
}): QaResultBody {
	const payload: QaResultBody["payload"] = {
		status: args.status,
		targetExecutionId: args.targetExecutionId,
		qaExecutionId: args.qaExecutionId,
	};
	if (args.prHeadSha) payload.prHeadSha = args.prHeadSha;
	if (args.summary) payload.summary = args.summary;
	return {
		event_id: args.eventId ?? randomUUID(),
		execution_id: args.qaExecutionId,
		issue_id: args.issueId,
		project_name: args.projectName,
		event_type: "qa_result",
		source: "flywheel-comm",
		payload,
	};
}

export async function qaResult(opts: QaResultOpts): Promise<void> {
	const status = (opts.status ?? "").trim().toLowerCase();
	if (!VALID_STATUSES.has(status)) {
		console.error(
			`--status is required and must be one of: ${[...VALID_STATUSES].join(", ")}`,
		);
		process.exit(1);
	}
	const targetExec = (opts.targetExec ?? "").trim();
	if (!targetExec) {
		console.error("--target-exec <parent-execution-id> is required");
		process.exit(1);
	}

	const qaExecId = (opts.execId ?? process.env.FLYWHEEL_EXEC_ID ?? "").trim();
	if (!qaExecId) {
		console.error(
			"--exec-id or FLYWHEEL_EXEC_ID is required (this QA runner's own execution id)",
		);
		process.exit(1);
	}
	const issueId = requireEnv("FLYWHEEL_ISSUE_ID");
	const projectName = requireEnv("FLYWHEEL_PROJECT_NAME");
	const bridgeUrl = requireEnv("FLYWHEEL_BRIDGE_URL");
	const ingestToken = process.env.FLYWHEEL_INGEST_TOKEN;
	const workflowCredential =
		process.env.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL?.trim();
	const workflowSubmissionExpected =
		process.env.FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED === "1";

	const prHeadSha = (opts.prHeadSha ?? deriveHeadSha())?.trim() || undefined;

	const body = buildQaResultBody({
		status: status as "pass" | "fail",
		qaExecutionId: qaExecId,
		targetExecutionId: targetExec,
		issueId,
		projectName,
		prHeadSha,
		summary: opts.summary?.trim() || undefined,
	});
	if (workflowSubmissionExpected && !workflowCredential) {
		const lastError =
			"workflow submission credential was expected but FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL is missing; do not use env -u or a shell that drops the runner environment";
		writeDeterministicFailure({
			execId: qaExecId,
			requestId: body.event_id,
			body,
			lastError,
		});
	}
	const submissionBody: QaResultBody | WorkflowQaDecisionBody =
		workflowCredential
			? {
					credential: workflowCredential,
					client_request_id: body.event_id,
					status: status as "pass" | "fail",
					...(prHeadSha ? { client_pr_head_sha: prHeadSha } : {}),
					...(opts.summary?.trim() ? { summary: opts.summary.trim() } : {}),
				}
			: body;
	const endpoint = workflowCredential
		? `${bridgeUrl.replace(/\/$/, "")}/api/workflow/decision`
		: `${bridgeUrl.replace(/\/$/, "")}/events`;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (!workflowCredential && ingestToken) {
		headers.Authorization = `Bearer ${ingestToken}`;
	}

	let lastError: string | undefined;
	for (let attempt = 1; attempt <= ATTEMPT_COUNT; attempt += 1) {
		let deterministicFailure: { reason: string; lastError: string } | undefined;
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
			let response: Response;
			try {
				response = await fetch(endpoint, {
					method: "POST",
					headers,
					body: JSON.stringify(submissionBody),
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timer);
			}
			const rawBody = await response.text();
			const parsed = parseResponseObject(rawBody);
			const reason = responseReason(parsed);
			const hint = typeof parsed?.hint === "string" ? parsed.hint : undefined;

			if (response.ok && parsed?.ok === true) {
				if (workflowCredential) {
					if (
						typeof parsed.claimId !== "number" ||
						!Number.isFinite(parsed.claimId) ||
						typeof parsed.serverSeq !== "number" ||
						!Number.isFinite(parsed.serverSeq) ||
						typeof parsed.idempotentReplay !== "boolean"
					) {
						lastError = `Malformed workflow decision acknowledgement from ${endpoint} (status ${response.status})`;
					} else {
						console.log(
							`[qa-result] decision consumed (claimId=${parsed.claimId} serverSeq=${parsed.serverSeq} idempotentReplay=${parsed.idempotentReplay}) for target=${targetExec} (attempt ${attempt}/${ATTEMPT_COUNT})`,
						);
						return;
					}
				} else {
					console.log(
						`[qa-result] accepted by /events (event stored; NOT a DAG decision) for target=${targetExec} (attempt ${attempt}/${ATTEMPT_COUNT})`,
					);
					return;
				}
			} else {
				lastError = formatResponseFailure({
					endpoint,
					status: response.status,
					reason,
					hint,
					rawBody,
				});
			}

			console.error(
				`[qa-result] attempt ${attempt}/${ATTEMPT_COUNT} failed: ${lastError}`,
			);
			const transientStatus =
				response.status >= 500 ||
				response.status === 408 ||
				response.status === 425 ||
				response.status === 429;
			if (
				!transientStatus &&
				reason &&
				classifyQaResultRejection(reason) === "fail"
			) {
				deterministicFailure = {
					reason,
					lastError: lastError ?? `${endpoint} rejected the workflow decision`,
				};
			}
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			console.error(
				`[qa-result] attempt ${attempt}/${ATTEMPT_COUNT} failed: ${lastError}`,
			);
		}
		if (deterministicFailure) {
			if (deterministicFailure.reason === "replay_payload_mismatch") {
				console.error(
					"[qa-result] The credential was consumed by another submission. This does NOT prove the current verdict was recorded. Stop retrying, never strip the credential, and report both conclusions to the Lead.",
				);
			}
			writeDeterministicFailure({
				execId: qaExecId,
				requestId: body.event_id,
				body: submissionBody,
				lastError: deterministicFailure.lastError,
			});
		}
		if (attempt < ATTEMPT_COUNT) {
			await sleep(BACKOFF_MS[attempt - 1] ?? 0);
		}
	}

	const markerWritten = writeMarker({
		execId: qaExecId,
		requestId: body.event_id,
		body: submissionBody,
		lastError,
	});
	console.error(
		`[qa-result] FAIL-CLOSE: ${ATTEMPT_COUNT} attempts failed. ${
			markerWritten ? "Marker written." : "Marker NOT written (see above)."
		} Last error: ${lastError}`,
	);
	process.exit(1);
}

function parseResponseObject(raw: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function responseReason(
	parsed: Record<string, unknown> | undefined,
): string | undefined {
	if (typeof parsed?.reason === "string") return parsed.reason;
	return typeof parsed?.error === "string" ? parsed.error : undefined;
}

function formatResponseFailure(args: {
	endpoint: string;
	status: number;
	reason: string | undefined;
	hint: string | undefined;
	rawBody: string;
}): string {
	const detail = args.reason ?? (args.rawBody.trim() || "empty response");
	return `${args.endpoint} returned HTTP ${args.status}: ${detail}${
		args.hint ? `; hint=${args.hint}` : ""
	}`;
}

function writeDeterministicFailure(args: {
	execId: string;
	requestId: string;
	body: unknown;
	lastError: string;
}): never {
	const markerWritten = writeMarker(args);
	console.error(
		`[qa-result] FAIL-CLOSE: deterministic rejection. ${
			markerWritten ? "Marker written." : "Marker NOT written (see above)."
		} ${args.lastError}`,
	);
	process.exit(1);
}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) {
		console.error(`${name} environment variable is required`);
		process.exit(1);
	}
	return v;
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
}): boolean {
	const home = process.env.HOME ?? homedir();
	const dir = join(home, ".flywheel", "state", "qa-result-failed");
	const markerPath = join(dir, `${args.execId}.json`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			markerPath,
			JSON.stringify(buildQaResultFailureMarker(args), null, 2),
			"utf8",
		);
		return true;
	} catch (err) {
		console.error(
			`[qa-result] CRITICAL: marker write failed at ${markerPath}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return false;
	}
}

/** Opaque retry marker: enough to correlate/replay from logs, no body/token. */
export function buildQaResultFailureMarker(args: {
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

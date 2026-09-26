import { existsSync } from "node:fs";
import { normalizeOptionalBearer } from "flywheel-config";
import { CommDB } from "../db.js";
import type { CheckResult, ReviewRetryHint } from "../types.js";

export interface CheckArgs {
	questionId: string;
	dbPath: string;
	executionId?: string;
}

export function check(args: CheckArgs): CheckResult {
	// DB not existing is expected (ask hasn't been called yet) — return pending.
	// Other errors (permissions, corrupt DB) should propagate.
	if (!existsSync(args.dbPath)) {
		return { status: "pending" };
	}
	const db = new CommDB(args.dbPath, false);
	try {
		const question = db.getMessageById(args.questionId);
		const response =
			args.executionId && question?.from_agent === args.executionId
				? db.consumeGateResponse(args.questionId, args.executionId)
				: db.getResponse(args.questionId);
		if (response) {
			return {
				status: "answered",
				content: response.content,
				from_agent: response.from_agent,
				created_at: response.created_at,
			};
		}
		return { status: "pending" };
	} finally {
		db.close();
	}
}

/** The CLI may fetch a recovery hint, but never turns that hint into an answer. */
export async function checkWithReviewRecovery(
	args: CheckArgs & { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch },
): Promise<CheckResult> {
	let result: CheckResult;
	try {
		result = check(args);
	} catch {
		return { status: "pending" };
	}
	if (
		result.status !== "pending" ||
		!args.executionId ||
		!existsSync(args.dbPath)
	)
		return result;
	let checkpoint: string | null | undefined;
	try {
		const db = new CommDB(args.dbPath, false);
		try {
			const question = db.getMessageById(args.questionId);
			if (
				question?.from_agent !== args.executionId ||
				question.type !== "question" ||
				question.resolved_at ||
				question.superseded_at
			)
				return result;
			checkpoint = question.checkpoint;
		} finally {
			db.close();
		}
	} catch {
		return result;
	}
	if (checkpoint !== "review_design" && checkpoint !== "review_code")
		return result;
	const env = args.env ?? process.env;
	const bridgeUrl = env.FLYWHEEL_BRIDGE_URL?.trim();
	if (!bridgeUrl) return result;
	try {
		const token = normalizeOptionalBearer(env.FLYWHEEL_INGEST_TOKEN);
		const response = await (args.fetchImpl ?? fetch)(
			`${bridgeUrl}/review-requests/status`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify({
					executionId: args.executionId,
					questionId: args.questionId,
				}),
				signal: AbortSignal.timeout(5_000),
			},
		);
		if (!response.ok) return result;
		const body: unknown = await response.json();
		if (
			!body ||
			typeof body !== "object" ||
			!("status" in body) ||
			body.status !== "pending" ||
			!("reviewRetry" in body)
		)
			return result;
		const hint = body.reviewRetry as Partial<ReviewRetryHint> | null;
		if (
			!hint ||
			typeof hint !== "object" ||
			typeof hint.requestId !== "string" ||
			!/^[A-Za-z0-9_.:-]{1,128}$/.test(hint.requestId) ||
			hint.questionId !== args.questionId ||
			hint.reviewType !==
				(checkpoint === "review_design" ? "design" : "code") ||
			!Number.isSafeInteger(hint.attemptGeneration) ||
			(hint.attemptGeneration ?? -1) < 0 ||
			typeof hint.reason !== "string" ||
			hint.reason.length > 512 ||
			/[\r\n\0]/.test(hint.reason)
		)
			return result;
		if (
			hint.planPath !== undefined &&
			(typeof hint.planPath !== "string" ||
				hint.planPath.length > 512 ||
				/[\r\n\0]/.test(hint.planPath) ||
				hint.planPath.startsWith("/") ||
				hint.planPath.split(/[\\/]/).includes(".."))
		)
			return result;
		if (
			hint.targetRepoPath !== undefined &&
			(typeof hint.targetRepoPath !== "string" ||
				!hint.targetRepoPath.trim() ||
				hint.targetRepoPath.length > 512 ||
				// biome-ignore lint/suspicious/noControlCharactersInRegex: recovery commands reject all control characters
				/[\u0000-\u001f\u007f]/.test(hint.targetRepoPath) ||
				/^(?:[/\\~]|[A-Za-z]:)/.test(hint.targetRepoPath) ||
				hint.targetRepoPath.split(/[\\/]/).includes("..") ||
				!hint.targetRepoPath
					.split(/[\\/]/)
					.some((part) => part && part !== "."))
		)
			return result;
		return {
			status: "pending",
			reviewRetry: {
				requestId: hint.requestId,
				questionId: hint.questionId,
				reviewType: hint.reviewType,
				attemptGeneration: hint.attemptGeneration!,
				reason: hint.reason,
				...(hint.planPath ? { planPath: hint.planPath } : {}),
				...(hint.targetRepoPath ? { targetRepoPath: hint.targetRepoPath } : {}),
			},
		};
	} catch {
		return result;
	}
}

export function formatReviewRetryCommand(hint: ReviewRetryHint): string {
	const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
	return `node "$FLYWHEEL_COMM_CLI" request-review --request-id=${quote(hint.requestId)} --question-id=${quote(hint.questionId)} --type ${hint.reviewType}${hint.planPath ? ` --plan=${quote(hint.planPath)}` : ""}${hint.targetRepoPath ? ` --target-repo=${quote(hint.targetRepoPath)}` : ""}`;
}

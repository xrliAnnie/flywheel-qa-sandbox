import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	adapterTypeToFamily,
	canonicalSubmissionDigest,
} from "flywheel-config";
import type { StateStore } from "../StateStore.js";
import {
	type ClaudeReviewOutcome,
	runClaudeReviewRound,
} from "./claude-review-runner.js";
import {
	buildProofFetchArgs,
	buildProofGitEnv,
} from "./land-head-refresh-proof.js";

const execFileAsync = promisify(execFile);
const FULL_SHA = /^[0-9a-f]{40}$/;

export type LandContentReviewResult =
	| { status: "approved"; executionId: string; requestId: string }
	| {
			status: "pending" | "changes_requested" | "rejected";
			reason: string;
			executionId: string;
			requestId: string;
	  };

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
		env: buildProofGitEnv(process.env),
	});
	return result.stdout.trim();
}

/**
 * Cross-family exact-head review for engine-created land candidates. It uses a
 * disposable detached checkout and records the same request-bound durable
 * authority row as the normal review coordinator. It never treats a skipped
 * row/session as approval.
 */
export class GitLandContentReviewer {
	constructor(
		private readonly store: StateStore,
		private readonly projectRootFor: (
			projectName: string,
		) => string | undefined,
		private readonly reviewRound: typeof runClaudeReviewRound = runClaudeReviewRound,
	) {}

	async ensureReview(input: {
		runId: string;
		issueId: string;
		projectName: string;
		prNumber: number;
		headSha: string;
		executionId: string;
		repoIdentity: string;
	}): Promise<LandContentReviewResult> {
		const headSha = input.headSha.trim().toLowerCase();
		const requestId = `land-content-review:${canonicalSubmissionDigest({
			runId: input.runId,
			issueId: input.issueId,
			projectName: input.projectName,
			prNumber: input.prNumber,
			headSha,
			executionId: input.executionId,
			repoIdentity: input.repoIdentity,
		})}`;
		const result = (
			status: LandContentReviewResult["status"],
			reason?: string,
		) =>
			({
				status,
				...(reason ? { reason } : {}),
				executionId: input.executionId,
				requestId,
			}) as LandContentReviewResult;
		if (
			!input.runId ||
			!input.issueId ||
			!input.projectName ||
			!Number.isInteger(input.prNumber) ||
			input.prNumber < 1 ||
			!FULL_SHA.test(headSha) ||
			!input.executionId ||
			!input.repoIdentity
		) {
			return result("rejected", "invalid_content_review_input");
		}
		const session = this.store.getSession(input.executionId);
		if (session?.codex_skip) {
			return result("rejected", "content_carryover_review_skipped");
		}
		const prior = this.store.getCodexReviewRecord(
			input.executionId,
			input.repoIdentity,
			headSha,
		);
		if (
			prior?.status === "approved" &&
			prior.request_id === requestId &&
			this.store.isCodexCodeReviewApproved(
				input.executionId,
				input.repoIdentity,
				headSha,
			)
		) {
			return result("approved");
		}
		if (prior?.status === "skipped") {
			return result("rejected", "content_carryover_review_skipped");
		}
		const authorFamily = adapterTypeToFamily(session?.adapter_type ?? null);
		if (authorFamily !== "codex") {
			return result(
				"rejected",
				"content_carryover_cross_family_reviewer_unavailable",
			);
		}
		const projectRoot = this.projectRootFor(input.projectName);
		if (!projectRoot) {
			return result("pending", "content_review_project_unavailable");
		}
		let remoteUrl: string;
		try {
			remoteUrl = await git(projectRoot, ["remote", "get-url", "origin"]);
		} catch {
			return result("pending", "content_review_remote_unavailable");
		}
		const checkout = mkdtempSync(join(tmpdir(), "flywheel-land-review-"));
		let outcome: ClaudeReviewOutcome;
		try {
			await git(checkout, ["init"]);
			await git(checkout, [
				...buildProofFetchArgs(remoteUrl),
				"fetch",
				"--no-tags",
				"--force",
				"--",
				remoteUrl,
				`+refs/pull/${input.prNumber}/head:refs/flywheel/candidate`,
			]);
			await git(checkout, ["checkout", "--detach", headSha]);
			if ((await git(checkout, ["rev-parse", "HEAD"])) !== headSha) {
				return result("pending", "content_review_head_moved");
			}
			outcome = await this.reviewRound({
				prompt:
					`You are the independent cross-family reviewer for ${input.issueId}. ` +
					`Review CODE at exact commit ${headSha}. Explore this detached repository, ` +
					`diff against the default branch merge base, and check correctness, security, ` +
					`authorization, failure handling, and regressions. Do not edit files. ` +
					`Output only JSON: {"verdict":"APPROVED"|"CHANGES_REQUESTED",` +
					`"findings":[{"id":"slug","severity":"HIGH|MEDIUM|LOW",` +
					`"file":"...","line":0,"title":"...","detail":"..."}],` +
					`"reviewedHeadSha":"${headSha}"}. Vote CHANGES_REQUESTED only for HIGH findings.`,
				sessionId: randomUUID(),
				resume: false,
				cwd: checkout,
			});
		} catch (error) {
			return result(
				"pending",
				`content_review_infrastructure:${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			rmSync(checkout, { recursive: true, force: true });
		}
		if (outcome.kind === "failed") {
			return result("pending", `content_review_${outcome.reason}`);
		}
		if (outcome.reviewedHeadSha?.toLowerCase() !== headSha) {
			return result("pending", "content_review_wrong_head");
		}
		if (outcome.verdict !== "APPROVED") {
			return result("changes_requested", "content_review_changes_requested");
		}
		const approved = this.store.recordCodexReviewApproved({
			executionId: input.executionId,
			targetRepoIdentity: input.repoIdentity,
			targetPrHeadSha: headSha,
			issueId: input.issueId,
			projectName: input.projectName,
			verdictEventId: `land-content-review:${requestId}`,
			reviewedTarget: "claude-review:land-content",
			codexThreadId: randomUUID(),
			rounds: 1,
			authorFamily,
			reviewerFamily: "claude",
			requestId,
		});
		return approved
			? result("approved")
			: result("rejected", "content_review_authority_not_recorded");
	}
}

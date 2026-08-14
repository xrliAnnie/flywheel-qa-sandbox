import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isTrustedApprovalAttribution } from "./founder-attribution.js";

export const FOUNDER_REVIEW_CHECKPOINT = "founder_review" as const;

const ARTIFACT_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const GIT_BLOB_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface FounderArtifactBlob {
	path: string;
	blobSha: string;
}

export interface FounderReviewGateEvidence {
	runId: string;
	founderId: string | undefined;
	hostedUrl: string;
	artifacts: readonly FounderArtifactBlob[];
}

export interface FounderReviewRoundRecord {
	questionId: string;
	checkpoint: string | null;
	ownerExecutionId: string;
	ownerRunId: string | null;
	serverOrder: number;
	supersededAt: string | null;
	questionContent: string;
	response?: {
		fromAgent: string;
		content: string;
	};
}

export interface FounderReviewRoundLocator {
	listDeliveredRoundsForRun(runId: string): readonly {
		questionId: string;
		runId: string;
		artifactDigest: string;
	}[];
	getExecutionRunId(executionId: string): string | undefined;
}

export interface FounderReviewFamilyReader {
	getQuestionsByCheckpoint(checkpoint: string): readonly {
		id: string;
		from_agent: string;
	}[];
	getFounderReviewFamily(questionId: string):
		| {
				source: "live" | "archived";
				question: {
					id: string;
					ownerExecutionId: string;
					checkpoint: string | null;
					content: string;
					serverOrder: number;
					supersededAt: string | null;
				};
				response?: { fromAgent: string; content: string };
		  }
		| undefined;
}

export interface FounderReviewStateReader {
	readRoundsForRun(runId: string): readonly FounderReviewRoundRecord[];
}

export type FounderReviewVerdict =
	| {
			status: "passed";
			questionId: string;
			artifactDigest: string;
	  }
	| {
			status: "missing";
			reason: "no_round_for_run";
	  }
	| {
			status: "not_passed";
			questionId: string;
			reason:
				| "invalid_question"
				| "response_missing"
				| "untrusted_response"
				| "invalid_response"
				| "revisions_requested";
	  }
	| {
			status: "stale_artifact";
			questionId: string;
			expectedArtifactDigest: string;
			authoritativeArtifactDigest: string;
	  };

export function isFounderReviewCheckpoint(
	checkpoint: string | null | undefined,
): checkpoint is typeof FOUNDER_REVIEW_CHECKPOINT {
	return checkpoint === FOUNDER_REVIEW_CHECKPOINT;
}

function assertArtifactPath(path: string): void {
	if (
		!path ||
		path.startsWith("/") ||
		path.includes("\0") ||
		path.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		throw new Error(`invalid founder artifact path: ${path}`);
	}
}

/** Bind a review round to the exact committed Git blobs, independent of HEAD. */
export function computeFounderArtifactDigest(
	blobs: readonly FounderArtifactBlob[],
): string {
	if (blobs.length === 0) {
		throw new Error("founder artifact requires at least one committed blob");
	}
	const normalized = blobs.map(({ path, blobSha }) => {
		assertArtifactPath(path);
		if (!GIT_BLOB_PATTERN.test(blobSha)) {
			throw new Error(`invalid Git blob id for founder artifact: ${path}`);
		}
		return { path, blobSha };
	});
	normalized.sort((left, right) => left.path.localeCompare(right.path));
	for (let index = 1; index < normalized.length; index++) {
		if (normalized[index - 1]?.path === normalized[index]?.path) {
			throw new Error(
				`duplicate founder artifact path: ${normalized[index]?.path}`,
			);
		}
	}
	const hash = createHash("sha256");
	for (const blob of normalized) {
		hash.update(blob.path);
		hash.update("\0");
		hash.update(blob.blobSha);
		hash.update("\n");
	}
	return hash.digest("hex");
}

/** Resolve review paths to clean, committed blobs in the current Git HEAD. */
export function inspectCommittedFounderReviewArtifacts(input: {
	cwd: string;
	paths: readonly string[];
}): FounderArtifactBlob[] {
	if (input.paths.length === 0) {
		throw new Error(
			"founder_review requires at least one committed HTML artifact",
		);
	}
	let repoRoot: string;
	try {
		repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: input.cwd,
			encoding: "utf8",
		}).trim();
	} catch {
		throw new Error("founder_review artifacts require a Git repository");
	}
	const root = realpathSync(resolve(repoRoot));
	return input.paths.map((requestedPath) => {
		let absolute: string;
		try {
			absolute = realpathSync(resolve(input.cwd, requestedPath));
		} catch {
			throw new Error(
				`founder_review artifact must exist and be committed in Git HEAD: ${requestedPath}`,
			);
		}
		const repoPath = relative(root, absolute).split(sep).join("/");
		if (
			isAbsolute(repoPath) ||
			repoPath === ".." ||
			repoPath.startsWith("../")
		) {
			throw new Error(
				`founder_review artifact must be inside the Git repository: ${requestedPath}`,
			);
		}
		assertArtifactPath(repoPath);
		if (!repoPath.toLowerCase().endsWith(".html")) {
			throw new Error(`founder_review artifact must be HTML: ${repoPath}`);
		}
		const status = execFileSync(
			"git",
			["status", "--porcelain=v1", "--untracked-files=all", "--", repoPath],
			{ cwd: root, encoding: "utf8" },
		).trim();
		if (status) {
			throw new Error(
				`founder_review artifact must be committed and clean: ${repoPath}`,
			);
		}
		let treeEntry: string;
		try {
			treeEntry = execFileSync("git", ["ls-tree", "HEAD", "--", repoPath], {
				cwd: root,
				encoding: "utf8",
			}).trim();
		} catch {
			treeEntry = "";
		}
		const match = treeEntry.match(/^\d+\s+blob\s+([0-9a-f]{40,64})\t(.+)$/);
		if (!match || match[2] !== repoPath) {
			throw new Error(
				`founder_review artifact must be committed in Git HEAD: ${repoPath}`,
			);
		}
		return { path: repoPath, blobSha: match[1] as string };
	});
}

/** Recompute the artifact binding at a server-authoritative Git commit. */
export function inspectFounderReviewArtifactsAtCommit(input: {
	repoRoot: string;
	head: string;
	paths: readonly string[];
}): FounderArtifactBlob[] {
	if (input.paths.length === 0) {
		throw new Error("founder_review requires at least one HTML artifact path");
	}
	if (!GIT_BLOB_PATTERN.test(input.head)) {
		throw new Error("founder_review authoritative Git head is invalid");
	}
	const root = realpathSync(resolve(input.repoRoot));
	let toplevel: string;
	try {
		toplevel = realpathSync(
			execFileSync("git", ["rev-parse", "--show-toplevel"], {
				cwd: root,
				encoding: "utf8",
			}).trim(),
		);
		execFileSync("git", ["cat-file", "-e", `${input.head}^{commit}`], {
			cwd: root,
			stdio: "ignore",
		});
	} catch {
		throw new Error("founder_review authoritative Git commit is unavailable");
	}
	if (toplevel !== root) {
		throw new Error(
			"founder_review authority root must be a Git repository root",
		);
	}
	return input.paths.map((path) => {
		assertArtifactPath(path);
		if (!path.toLowerCase().endsWith(".html")) {
			throw new Error(`founder_review artifact must be HTML: ${path}`);
		}
		const entry = execFileSync("git", ["ls-tree", input.head, "--", path], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		const match = entry.match(/^\d+\s+blob\s+([0-9a-f]{40,64})\t(.+)$/);
		if (!match || match[2] !== path) {
			throw new Error(
				`founder_review artifact is absent from authoritative commit: ${path}`,
			);
		}
		return { path, blobSha: match[1] as string };
	});
}

export function createFounderReviewQuestionContent(input: {
	round: number;
	evidence: FounderReviewGateEvidence;
}): string {
	if (!Number.isSafeInteger(input.round) || input.round < 1) {
		throw new Error("founder_review round must be a positive integer");
	}
	if (!input.evidence.runId.trim()) {
		throw new Error("founder_review requires a current workflow run");
	}
	if (!input.evidence.founderId?.trim()) {
		throw new Error("founder_review requires a configured founder identity");
	}
	if (!/^https:\/\//.test(input.evidence.hostedUrl)) {
		throw new Error("founder_review requires an HTTPS hosted review URL");
	}
	const paths = input.evidence.artifacts
		.map((artifact) => artifact.path)
		.sort((left, right) => left.localeCompare(right));
	const artifactDigest = computeFounderArtifactDigest(input.evidence.artifacts);
	return JSON.stringify({
		version: 1,
		round: input.round,
		runId: input.evidence.runId,
		artifactDigest,
		hostedUrl: input.evidence.hostedUrl,
		paths,
	});
}

function parseObject(content: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(content) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

export function parseFounderReviewQuestionContent(content: string):
	| {
			round: number;
			runId: string;
			artifactDigest: string;
			hostedUrl: string;
			paths: string[];
	  }
	| undefined {
	const value = parseObject(content);
	if (
		!value ||
		value.version !== 1 ||
		!Number.isSafeInteger(value.round) ||
		Number(value.round) < 1 ||
		typeof value.runId !== "string" ||
		!value.runId.trim() ||
		typeof value.artifactDigest !== "string" ||
		!ARTIFACT_DIGEST_PATTERN.test(value.artifactDigest) ||
		typeof value.hostedUrl !== "string" ||
		!/^https:\/\//.test(value.hostedUrl) ||
		!Array.isArray(value.paths) ||
		value.paths.length === 0 ||
		!value.paths.every((path) => typeof path === "string")
	) {
		return undefined;
	}
	try {
		for (const path of value.paths) assertArtifactPath(path as string);
	} catch {
		return undefined;
	}
	return {
		round: Number(value.round),
		runId: value.runId,
		artifactDigest: value.artifactDigest,
		hostedUrl: value.hostedUrl,
		paths: value.paths as string[],
	};
}

export function parseFounderReviewResponseContent(content: string):
	| {
			passed: boolean;
			artifactDigest: string;
	  }
	| undefined {
	const value = parseObject(content);
	if (
		!value ||
		value.version !== 1 ||
		typeof value.passed !== "boolean" ||
		typeof value.artifactDigest !== "string" ||
		!ARTIFACT_DIGEST_PATTERN.test(value.artifactDigest)
	) {
		return undefined;
	}
	return {
		passed: value.passed,
		artifactDigest: value.artifactDigest,
	};
}

export function resolveFounderReviewVerdict(input: {
	runId: string;
	authoritativeArtifactDigest: string;
	founderId: string | undefined;
	rounds: readonly FounderReviewRoundRecord[];
}): FounderReviewVerdict {
	const candidates = input.rounds
		.filter(
			(round) =>
				isFounderReviewCheckpoint(round.checkpoint) &&
				round.ownerRunId === input.runId &&
				round.supersededAt === null,
		)
		.sort((left, right) =>
			left.serverOrder === right.serverOrder
				? left.questionId.localeCompare(right.questionId)
				: left.serverOrder - right.serverOrder,
		);
	const latest = candidates.at(-1);
	if (!latest) return { status: "missing", reason: "no_round_for_run" };
	const question = parseFounderReviewQuestionContent(latest.questionContent);
	if (!question || question.runId !== input.runId) {
		return {
			status: "not_passed",
			questionId: latest.questionId,
			reason: "invalid_question",
		};
	}
	if (!latest.response) {
		return {
			status: "not_passed",
			questionId: latest.questionId,
			reason: "response_missing",
		};
	}
	if (
		!isTrustedApprovalAttribution(latest.response.fromAgent, input.founderId)
	) {
		return {
			status: "not_passed",
			questionId: latest.questionId,
			reason: "untrusted_response",
		};
	}
	const response = parseFounderReviewResponseContent(latest.response.content);
	if (!response || response.artifactDigest !== question.artifactDigest) {
		return {
			status: "not_passed",
			questionId: latest.questionId,
			reason: "invalid_response",
		};
	}
	if (!response.passed) {
		return {
			status: "not_passed",
			questionId: latest.questionId,
			reason: "revisions_requested",
		};
	}
	if (question.artifactDigest !== input.authoritativeArtifactDigest) {
		return {
			status: "stale_artifact",
			questionId: latest.questionId,
			expectedArtifactDigest: question.artifactDigest,
			authoritativeArtifactDigest: input.authoritativeArtifactDigest,
		};
	}
	return {
		status: "passed",
		questionId: latest.questionId,
		artifactDigest: question.artifactDigest,
	};
}

export function createFounderReviewStateReader(input: {
	db: FounderReviewFamilyReader;
	locator: FounderReviewRoundLocator;
}): FounderReviewStateReader {
	return {
		readRoundsForRun(runId) {
			const delivered = input.locator.listDeliveredRoundsForRun(runId);
			const deliveredByQuestion = new Map(
				delivered.map((binding) => [binding.questionId, binding]),
			);
			const questionIds = new Set(deliveredByQuestion.keys());
			for (const question of input.db.getQuestionsByCheckpoint(
				FOUNDER_REVIEW_CHECKPOINT,
			)) {
				if (input.locator.getExecutionRunId(question.from_agent) === runId) {
					questionIds.add(question.id);
				}
			}

			return [...questionIds].map((questionId) => {
				const family = input.db.getFounderReviewFamily(questionId);
				if (!family) {
					throw new Error(
						`founder_review delivered family is unavailable: ${questionId}`,
					);
				}
				const binding = deliveredByQuestion.get(questionId);
				const ownerRunId = input.locator.getExecutionRunId(
					family.question.ownerExecutionId,
				);
				const content = parseFounderReviewQuestionContent(
					family.question.content,
				);
				const bindingValid =
					!binding ||
					(binding.runId === runId &&
						binding.artifactDigest === content?.artifactDigest);
				const ownerValid = ownerRunId === runId;
				return {
					questionId,
					checkpoint: family.question.checkpoint,
					ownerExecutionId: family.question.ownerExecutionId,
					// A durable delivery binding is itself run-scoped. Preserve a broken
					// delivered row as an invalid candidate so an older pass cannot win.
					ownerRunId: ownerValid || binding ? runId : (ownerRunId ?? null),
					serverOrder: family.question.serverOrder,
					supersededAt: family.question.supersededAt,
					questionContent:
						bindingValid && ownerValid ? family.question.content : "",
					// Visibility is authorization input: an injected response on a gate
					// whose founder card was never bound can never count as approval.
					response:
						binding && bindingValid && ownerValid ? family.response : undefined,
				};
			});
		},
	};
}

export function resolveFounderReviewVerdictFromReader(input: {
	reader: FounderReviewStateReader;
	runId: string;
	authoritativeArtifactDigest: string;
	founderId: string | undefined;
}): FounderReviewVerdict {
	return resolveFounderReviewVerdict({
		runId: input.runId,
		authoritativeArtifactDigest: input.authoritativeArtifactDigest,
		founderId: input.founderId,
		rounds: input.reader.readRoundsForRun(input.runId),
	});
}

export function resolveFounderReviewVerdictAtCommit(input: {
	reader: FounderReviewStateReader;
	runId: string;
	repoRoot: string;
	head: string;
	founderId: string | undefined;
}): FounderReviewVerdict {
	const rounds = input.reader.readRoundsForRun(input.runId);
	const candidates = rounds
		.filter(
			(round) =>
				isFounderReviewCheckpoint(round.checkpoint) &&
				round.ownerRunId === input.runId &&
				round.supersededAt === null,
		)
		.sort((left, right) =>
			left.serverOrder === right.serverOrder
				? left.questionId.localeCompare(right.questionId)
				: left.serverOrder - right.serverOrder,
		);
	const latest = candidates.at(-1);
	if (!latest) {
		return { status: "missing", reason: "no_round_for_run" };
	}
	const question = parseFounderReviewQuestionContent(latest.questionContent);
	if (!question || question.runId !== input.runId) {
		return {
			status: "not_passed",
			questionId: latest.questionId,
			reason: "invalid_question",
		};
	}
	const artifactDigest = computeFounderArtifactDigest(
		inspectFounderReviewArtifactsAtCommit({
			repoRoot: input.repoRoot,
			head: input.head,
			paths: question.paths,
		}),
	);
	return resolveFounderReviewVerdict({
		runId: input.runId,
		authoritativeArtifactDigest: artifactDigest,
		founderId: input.founderId,
		rounds,
	});
}

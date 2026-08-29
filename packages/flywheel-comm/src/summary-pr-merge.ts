import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SummaryGranularity } from "./summary-config.js";
import {
	createGitHubCliSummaryVerifier,
	type SummaryPullRequestFile,
	type SummaryVerifierGitHub,
	verifySummaryPullRequest,
} from "./summary-pr-verifier.js";

const ALLOWED_SUMMARY_REPOS = new Set([
	"xrliAnnie/raya",
	"xrliAnnie/raya-memory",
]);
const RECEIPT_FILE = "state/summary-merge-receipts.jsonl";
const SHA_PATTERN = /^[a-f0-9]{40}$/i;

export type SummaryMergeMethod = "merge" | "squash" | "rebase";

export interface SummaryMergePullRequest {
	headSha: string;
	state: "open" | "closed";
	merged: boolean;
	baseRepo: string;
	baseRef: string;
}

export interface SummaryMergeRepository {
	defaultBranch: string;
	enabledMergeMethods: readonly SummaryMergeMethod[];
}

export interface SummaryMergeGitHub extends SummaryVerifierGitHub {
	readPullRequest(
		repo: string,
		prNumber: number,
	): Promise<SummaryMergePullRequest>;
	readRepository(repo: string): Promise<SummaryMergeRepository>;
	mergePullRequest(input: {
		repo: string;
		prNumber: number;
		verifiedHeadSha: string;
		method: SummaryMergeMethod;
	}): Promise<void>;
}

export interface SummaryMergeReceiptRow {
	type: "merge";
	ts: string;
	roundId?: string;
	repo: string;
	pr: number;
	projects: string[];
	files: string[];
	verifiedHeadSha: string;
	method: SummaryMergeMethod | null;
	reconciled?: true;
}

export interface SummaryMergeReceiptIdentity {
	repo: string;
	pr: number;
	verifiedHeadSha: string;
}

export interface SummaryMergeDeps {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	github?: SummaryMergeGitHub;
	readLedger?: (path: string) => string;
	appendLedgerRow?: (path: string, row: SummaryMergeReceiptRow) => void;
	now?: () => string;
}

export interface SummaryMergeInput {
	repo: string;
	prNumber: number;
	roundId?: string;
	method?: string;
	dryRun?: boolean;
}

export class SummaryReceiptWriteError extends Error {
	readonly mergeOccurred: boolean;
	readonly verifiedHeadSha: string;
	readonly repo: string;
	readonly prNumber: number;

	constructor(input: {
		mergeOccurred: boolean;
		verifiedHeadSha: string;
		repo: string;
		prNumber: number;
		cause: unknown;
	}) {
		const detail =
			input.cause instanceof Error ? input.cause.message : String(input.cause);
		super(
			`summary_receipt_write_failed: repo=${input.repo} pr=${input.prNumber} verifiedHeadSha=${input.verifiedHeadSha} mergeOccurred=${String(input.mergeOccurred)}: ${detail}`,
		);
		this.name = "SummaryReceiptWriteError";
		this.mergeOccurred = input.mergeOccurred;
		this.verifiedHeadSha = input.verifiedHeadSha;
		this.repo = input.repo;
		this.prNumber = input.prNumber;
	}
}

interface GitHubCliRunner {
	run(args: string[]): string;
}

function parseJson<T>(raw: string, source: string): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new Error(`summary_github_invalid: ${source} returned invalid JSON`);
	}
}

class GitHubCliSummaryMergeGitHub implements SummaryMergeGitHub {
	private readonly verifier: SummaryVerifierGitHub;

	constructor(private readonly cli: GitHubCliRunner) {
		this.verifier = createGitHubCliSummaryVerifier(cli);
	}

	async readPullRequest(
		repo: string,
		prNumber: number,
	): Promise<SummaryMergePullRequest> {
		const response = parseJson<{
			head?: { sha?: unknown };
			state?: unknown;
			merged?: unknown;
			merged_at?: unknown;
			base?: { ref?: unknown; repo?: { full_name?: unknown } };
		}>(
			this.cli.run(["api", `repos/${repo}/pulls/${prNumber}`]),
			"pull request",
		);
		if (
			typeof response.head?.sha !== "string" ||
			(response.state !== "open" && response.state !== "closed") ||
			typeof response.base?.ref !== "string" ||
			typeof response.base.repo?.full_name !== "string"
		) {
			throw new Error("summary_github_invalid: pull request metadata missing");
		}
		return {
			headSha: response.head.sha,
			state: response.state,
			merged:
				response.merged === true || typeof response.merged_at === "string",
			baseRepo: response.base.repo.full_name,
			baseRef: response.base.ref,
		};
	}

	async readRepository(repo: string): Promise<SummaryMergeRepository> {
		const response = parseJson<{
			default_branch?: unknown;
			allow_merge_commit?: unknown;
			allow_squash_merge?: unknown;
			allow_rebase_merge?: unknown;
		}>(this.cli.run(["api", `repos/${repo}`]), "repository");
		if (typeof response.default_branch !== "string") {
			throw new Error(
				"summary_github_invalid: repository default branch missing",
			);
		}
		const enabledMergeMethods: SummaryMergeMethod[] = [];
		if (response.allow_merge_commit === true) enabledMergeMethods.push("merge");
		if (response.allow_squash_merge === true)
			enabledMergeMethods.push("squash");
		if (response.allow_rebase_merge === true)
			enabledMergeMethods.push("rebase");
		return { defaultBranch: response.default_branch, enabledMergeMethods };
	}

	listPullRequestFiles(
		repo: string,
		prNumber: number,
	): Promise<SummaryPullRequestFile[]> {
		return this.verifier.listPullRequestFiles(repo, prNumber);
	}

	readTreeModes(repo: string, ref: string): Promise<Map<string, string>> {
		return this.verifier.readTreeModes(repo, ref);
	}

	readFileAtRef(repo: string, path: string, ref: string): Promise<string> {
		return this.verifier.readFileAtRef(repo, path, ref);
	}

	async mergePullRequest(input: {
		repo: string;
		prNumber: number;
		verifiedHeadSha: string;
		method: SummaryMergeMethod;
	}): Promise<void> {
		this.cli.run([
			"pr",
			"merge",
			String(input.prNumber),
			"--repo",
			input.repo,
			"--match-head-commit",
			input.verifiedHeadSha,
			`--${input.method}`,
		]);
	}
}

export function createGitHubCliSummaryMergeGitHub(
	cli: GitHubCliRunner = {
		run(args) {
			return execFileSync("gh", args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		},
	},
): SummaryMergeGitHub {
	return new GitHubCliSummaryMergeGitHub(cli);
}

function receiptKey(receipt: SummaryMergeReceiptIdentity): string {
	return `${receipt.repo}\0${receipt.pr}\0${receipt.verifiedHeadSha}`;
}

export function reduceSummaryMergeReceipts(
	rows: readonly unknown[],
): SummaryMergeReceiptIdentity[] {
	const receipts = new Map<string, SummaryMergeReceiptIdentity>();
	for (const row of rows) {
		if (row === null || typeof row !== "object") continue;
		const candidate = row as Record<string, unknown>;
		if (candidate.type !== undefined && candidate.type !== "merge") continue;
		if (
			typeof candidate.repo !== "string" ||
			!Number.isInteger(candidate.pr) ||
			typeof candidate.verifiedHeadSha !== "string" ||
			!SHA_PATTERN.test(candidate.verifiedHeadSha)
		) {
			if (candidate.type === "merge") {
				throw new Error("summary_receipt_ledger_invalid: malformed merge row");
			}
			continue;
		}
		const receipt = {
			repo: candidate.repo,
			pr: candidate.pr as number,
			verifiedHeadSha: candidate.verifiedHeadSha,
		};
		receipts.set(receiptKey(receipt), receipt);
	}
	return [...receipts.values()];
}

function parseLedger(raw: string): unknown[] {
	const rows: unknown[] = [];
	for (const [index, line] of raw.split("\n").entries()) {
		if (line.trim() === "") continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			throw new Error(
				`summary_receipt_ledger_invalid: line ${index + 1} is not JSON`,
			);
		}
	}
	return rows;
}

function parseMethod(
	value: string | undefined,
): SummaryMergeMethod | undefined {
	if (value === undefined) return undefined;
	if (value === "merge" || value === "squash" || value === "rebase") {
		return value;
	}
	throw new Error(
		`summary_merge_method_invalid: expected merge|squash|rebase, got ${value}`,
	);
}

function readGranularity(env: NodeJS.ProcessEnv): SummaryGranularity {
	const granularity = env.FLYWHEEL_SUMMARY_GRANULARITY;
	if (granularity !== "per-lead" && granularity !== "per-project") {
		throw new Error(
			"summary_granularity_invalid: canonical summary granularity is missing or invalid",
		);
	}
	return granularity;
}

function validateBase(
	repo: string,
	pullRequest: SummaryMergePullRequest,
	repository: SummaryMergeRepository,
): void {
	if (
		pullRequest.baseRepo !== repo ||
		pullRequest.baseRef !== repository.defaultBranch
	) {
		throw new Error(
			`summary_merge_base_forbidden: expected ${repo}:${repository.defaultBranch}, got ${pullRequest.baseRepo}:${pullRequest.baseRef}`,
		);
	}
}

function defaultReadLedger(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function defaultAppendLedgerRow(
	path: string,
	row: SummaryMergeReceiptRow,
): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
}

export async function mergeSummaryPullRequest(
	input: SummaryMergeInput,
	deps: SummaryMergeDeps = {},
): Promise<Record<string, unknown>> {
	if (!ALLOWED_SUMMARY_REPOS.has(input.repo)) {
		throw new Error(
			"summary_merge_repo_forbidden: merge is limited to Raya's own repositories",
		);
	}
	if (!Number.isInteger(input.prNumber) || input.prNumber < 1) {
		throw new Error("summary_pr_invalid: PR number must be a positive integer");
	}
	const granularity = readGranularity(deps.env ?? process.env);
	const github = deps.github ?? createGitHubCliSummaryMergeGitHub();
	const pullRequest = await github.readPullRequest(input.repo, input.prNumber);
	if (pullRequest.state === "closed" && !pullRequest.merged) {
		throw new Error("summary_merge_pr_closed: PR is closed without merge");
	}
	const repository = await github.readRepository(input.repo);
	validateBase(input.repo, pullRequest, repository);
	const verified = await verifySummaryPullRequest(
		{ repo: input.repo, prNumber: input.prNumber, granularity },
		github,
	);
	if (verified.verifiedHeadSha !== pullRequest.headSha) {
		throw new Error(
			"summary_merge_pr_changed_during_verification: rerun against the new current head",
		);
	}
	const receiptPath = resolve(deps.cwd ?? process.cwd(), RECEIPT_FILE);
	const method = parseMethod(input.method);

	if (pullRequest.merged) {
		if (input.dryRun) {
			return {
				...verified,
				dryRun: true,
				action: "would-reconcile",
			};
		}
		const rows = parseLedger(
			(deps.readLedger ?? defaultReadLedger)(receiptPath),
		);
		const existing = reduceSummaryMergeReceipts(rows).some(
			(receipt) =>
				receipt.repo === input.repo &&
				receipt.pr === input.prNumber &&
				receipt.verifiedHeadSha === verified.verifiedHeadSha,
		);
		if (existing) {
			return { ...verified, action: "already-recorded" };
		}
		const receipt: SummaryMergeReceiptRow = {
			type: "merge",
			ts: (deps.now ?? (() => new Date().toISOString()))(),
			...(input.roundId ? { roundId: input.roundId } : {}),
			repo: input.repo,
			pr: input.prNumber,
			projects: verified.projects,
			files: verified.files,
			verifiedHeadSha: verified.verifiedHeadSha,
			method: null,
			reconciled: true,
		};
		try {
			(deps.appendLedgerRow ?? defaultAppendLedgerRow)(receiptPath, receipt);
		} catch (cause) {
			throw new SummaryReceiptWriteError({
				mergeOccurred: true,
				verifiedHeadSha: verified.verifiedHeadSha,
				repo: input.repo,
				prNumber: input.prNumber,
				cause,
			});
		}
		return { ...verified, action: "reconciled", method: null };
	}

	const selectedMethod = method ?? "merge";
	if (!repository.enabledMergeMethods.includes(selectedMethod)) {
		throw new Error(
			`summary_merge_method_disabled: ${selectedMethod} is disabled; choose --method from ${repository.enabledMergeMethods.join("|") || "none"}`,
		);
	}
	if (input.dryRun) {
		return {
			...verified,
			dryRun: true,
			action: "would-merge",
			method: selectedMethod,
		};
	}
	await github.mergePullRequest({
		repo: input.repo,
		prNumber: input.prNumber,
		verifiedHeadSha: verified.verifiedHeadSha,
		method: selectedMethod,
	});
	const receipt: SummaryMergeReceiptRow = {
		type: "merge",
		ts: (deps.now ?? (() => new Date().toISOString()))(),
		...(input.roundId ? { roundId: input.roundId } : {}),
		repo: input.repo,
		pr: input.prNumber,
		projects: verified.projects,
		files: verified.files,
		verifiedHeadSha: verified.verifiedHeadSha,
		method: selectedMethod,
	};
	try {
		(deps.appendLedgerRow ?? defaultAppendLedgerRow)(receiptPath, receipt);
	} catch (cause) {
		throw new SummaryReceiptWriteError({
			mergeOccurred: true,
			verifiedHeadSha: verified.verifiedHeadSha,
			repo: input.repo,
			prNumber: input.prNumber,
			cause,
		});
	}
	return {
		...verified,
		action: "merged",
		method: selectedMethod,
	};
}

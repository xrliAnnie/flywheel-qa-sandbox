import type { SummaryGranularity } from "./summary-config.js";
import { SUMMARY_PREFIX, validateSummaryArtifact } from "./summary-contract.js";

export interface SummaryPullRequestFile {
	path: string;
	status: string;
}

export interface SummaryVerifierGitHub {
	readPullRequest(repo: string, prNumber: number): Promise<{ headSha: string }>;
	listPullRequestFiles(
		repo: string,
		prNumber: number,
	): Promise<SummaryPullRequestFile[]>;
	readTreeModes(repo: string, ref: string): Promise<Map<string, string>>;
	readFileAtRef(repo: string, path: string, ref: string): Promise<string>;
}

export interface VerifySummaryPullRequestInput {
	repo: string;
	prNumber: number;
	granularity: SummaryGranularity;
}

export interface VerifiedSummaryPullRequest {
	ok: true;
	verifiedHeadSha: string;
	fileCount: number;
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

class GitHubCliSummaryVerifier implements SummaryVerifierGitHub {
	constructor(private readonly cli: GitHubCliRunner) {}

	async readPullRequest(
		repo: string,
		prNumber: number,
	): Promise<{ headSha: string }> {
		const response = parseJson<{ head?: { sha?: unknown } }>(
			this.cli.run(["api", `repos/${repo}/pulls/${prNumber}`]),
			"pull request",
		);
		if (typeof response.head?.sha !== "string") {
			throw new Error("summary_github_invalid: pull request head SHA missing");
		}
		return { headSha: response.head.sha };
	}

	async listPullRequestFiles(
		repo: string,
		prNumber: number,
	): Promise<SummaryPullRequestFile[]> {
		const pages = parseJson<unknown>(
			this.cli.run([
				"api",
				"--paginate",
				"--slurp",
				`repos/${repo}/pulls/${prNumber}/files?per_page=100`,
			]),
			"paginated pull request files",
		);
		if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
			throw new Error(
				"summary_github_invalid: paginated PR files must be an array of pages",
			);
		}
		return (pages as unknown[][]).flat().map((candidate) => {
			if (
				candidate === null ||
				typeof candidate !== "object" ||
				typeof (candidate as { filename?: unknown }).filename !== "string" ||
				typeof (candidate as { status?: unknown }).status !== "string"
			) {
				throw new Error("summary_github_invalid: malformed PR file row");
			}
			return {
				path: (candidate as { filename: string }).filename,
				status: (candidate as { status: string }).status,
			};
		});
	}

	async readTreeModes(repo: string, ref: string): Promise<Map<string, string>> {
		const response = parseJson<{
			truncated?: unknown;
			tree?: Array<{ path?: unknown; mode?: unknown; type?: unknown }>;
		}>(
			this.cli.run(["api", `repos/${repo}/git/trees/${ref}?recursive=1`]),
			"git tree",
		);
		if (response.truncated === true) {
			throw new Error(
				"summary_github_truncated: recursive git tree was truncated; cannot verify modes",
			);
		}
		if (!Array.isArray(response.tree)) {
			throw new Error("summary_github_invalid: git tree rows missing");
		}
		const modes = new Map<string, string>();
		for (const row of response.tree) {
			if (
				row.type === "blob" &&
				typeof row.path === "string" &&
				typeof row.mode === "string"
			) {
				modes.set(row.path, row.mode);
			} else if (
				typeof row.path === "string" &&
				typeof row.mode === "string" &&
				row.path.startsWith("summaries/")
			) {
				// Preserve non-blob entries so the shared validator can reject their
				// mode rather than making them look absent.
				modes.set(row.path, row.mode);
			}
		}
		return modes;
	}

	async readFileAtRef(
		repo: string,
		path: string,
		ref: string,
	): Promise<string> {
		const response = parseJson<{ content?: unknown; encoding?: unknown }>(
			this.cli.run([
				"api",
				`repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
			]),
			"repository content",
		);
		if (
			response.encoding !== "base64" ||
			typeof response.content !== "string"
		) {
			throw new Error(
				"summary_github_invalid: repository content is not base64",
			);
		}
		return Buffer.from(response.content.replace(/\s/g, ""), "base64").toString(
			"utf8",
		);
	}
}

export function createGitHubCliSummaryVerifier(
	cli: GitHubCliRunner = {
		run(args) {
			return execFileSync("gh", args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		},
	},
): SummaryVerifierGitHub {
	return new GitHubCliSummaryVerifier(cli);
}

export async function verifySummaryPullRequest(
	input: VerifySummaryPullRequestInput,
	github: SummaryVerifierGitHub,
): Promise<VerifiedSummaryPullRequest> {
	if (!Number.isInteger(input.prNumber) || input.prNumber < 1) {
		throw new Error("summary_pr_invalid: PR number must be a positive integer");
	}
	const pullRequest = await github.readPullRequest(input.repo, input.prNumber);
	if (!/^[a-f0-9]{40}$/i.test(pullRequest.headSha)) {
		throw new Error("summary_pr_invalid: current head SHA is malformed");
	}
	const files = await github.listPullRequestFiles(input.repo, input.prNumber);
	if (files.length === 0) {
		throw new Error("summary_pr_empty: PR has no changed files");
	}
	const paths = new Set<string>();
	for (const file of files) {
		if (paths.has(file.path)) {
			throw new Error(`summary_pr_path_duplicate: ${file.path}`);
		}
		paths.add(file.path);
		if (!file.path.startsWith(SUMMARY_PREFIX)) {
			throw new Error(
				`summary_pr_path_unsafe: ${file.path} is outside ${SUMMARY_PREFIX}`,
			);
		}
		if (file.status !== "added" && file.status !== "modified") {
			throw new Error(
				`summary_pr_status_unsafe: ${file.path} has status ${file.status}`,
			);
		}
	}
	const modes = await github.readTreeModes(input.repo, pullRequest.headSha);
	for (const file of files) {
		const mode = modes.get(file.path);
		if (mode === undefined) {
			throw new Error(`summary_pr_tree_missing: ${file.path}`);
		}
		const content = await github.readFileAtRef(
			input.repo,
			file.path,
			pullRequest.headSha,
		);
		validateSummaryArtifact({
			path: file.path,
			content,
			granularity: input.granularity,
			gitMode: mode,
		});
	}
	return {
		ok: true,
		verifiedHeadSha: pullRequest.headSha,
		fileCount: files.length,
	};
}

import { execFileSync } from "node:child_process";

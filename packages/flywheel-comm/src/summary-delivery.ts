import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
	SummaryDelivery,
	SummaryDeliveryInput,
	SummaryDeliveryKey,
	SummaryDeliveryResult,
	SummaryDeliveryState,
} from "./commands/summary.js";
import {
	buildSummaryPath,
	SummaryContractError,
	validateSummaryArtifact,
} from "./summary-contract.js";

interface CommandRunner {
	run(command: string, args: string[], cwd?: string): string;
}

interface ListedPullRequest {
	number: number;
	state: string;
	mergedAt: string | null;
	headRefName: string;
	url: string;
}

const defaultRunner: CommandRunner = {
	run(command, args, cwd) {
		return execFileSync(command, args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	},
};

function keyDigest(key: SummaryDeliveryKey): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				project: key.project,
				author: key.author,
				period: key.period,
			}),
		)
		.digest("hex");
}

function branchFor(key: SummaryDeliveryKey): string {
	return `summary/${key.project}/${key.author}/${keyDigest(key).slice(0, 16)}`;
}

function parseJson<T>(raw: string, source: string): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new Error(`summary_github_invalid: ${source} returned invalid JSON`);
	}
}

function pullNumberFromUrl(url: string): number {
	const match = /\/pull\/(\d+)(?:\/?$)/.exec(url.trim());
	if (!match) {
		throw new Error(
			`summary_github_invalid: cannot parse PR URL ${url.trim()}`,
		);
	}
	return Number(match[1]);
}

function walkFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory).sort()) {
			const path = join(directory, entry);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) {
				throw new Error(`summary_repo_symlink_unsafe: ${path}`);
			}
			if (stat.isDirectory()) visit(path);
			else if (stat.isFile()) files.push(path);
		}
	};
	visit(root);
	return files;
}

function nextSequence(repoDir: string, input: SummaryDeliveryInput): number {
	const synthetic = buildSummaryPath({
		project: input.project,
		lead: input.author,
		period: input.period,
		granularity: input.granularity,
		sequence: 1,
	});
	const endDate = basename(synthetic).slice(0, 10);
	let maximum = 0;
	for (const file of walkFiles(join(repoDir, "summaries", input.project))) {
		const name = basename(file);
		if (!name.startsWith(`${endDate}--`) || !name.endsWith(".md")) continue;
		const match = /--(\d{2})\.md$/.exec(name);
		if (match) maximum = Math.max(maximum, Number(match[1]));
	}
	if (maximum >= 99) {
		throw new Error(
			`summary_sequence_exhausted: ${input.project}/${endDate} already uses sequence 99`,
		);
	}
	return maximum + 1;
}

function exactArtifactPath(
	repoDir: string,
	input: SummaryDeliveryInput,
): string {
	const root = join(repoDir, "summaries", input.project);
	const matches: string[] = [];
	for (const file of walkFiles(root)) {
		if (!file.endsWith(".md") || basename(file) === "README.md") continue;
		const relative = file
			.slice(repoDir.length + 1)
			.split("\\")
			.join("/");
		try {
			validateSummaryArtifact({
				path: relative,
				content: readFileSync(file, "utf8"),
				granularity: input.granularity,
				expectedProject: input.project,
				expectedLead: input.author,
				expectedPeriod: input.period,
			});
			matches.push(relative);
		} catch (error) {
			if (!(error instanceof SummaryContractError)) throw error;
		}
	}
	if (matches.length !== 1) {
		throw new Error(
			`summary_open_pr_invalid: expected exactly one artifact for the idempotency key, found ${matches.length}`,
		);
	}
	if (input.existing?.path && input.existing.path !== matches[0]) {
		throw new Error(
			`summary_open_pr_invalid: inspected path ${input.existing.path} != checked-out ${matches[0]}`,
		);
	}
	return matches[0]!;
}

class GitHubSummaryDelivery implements SummaryDelivery {
	constructor(private readonly commands: CommandRunner) {}

	async inspect(key: SummaryDeliveryKey): Promise<SummaryDeliveryState> {
		const branch = branchFor(key);
		const raw = this.commands.run("gh", [
			"pr",
			"list",
			"--repo",
			key.repo,
			"--state",
			"all",
			"--head",
			branch,
			"--limit",
			"100",
			"--json",
			"number,state,mergedAt,headRefName,url",
		]);
		const pulls = parseJson<ListedPullRequest[]>(raw, "gh pr list").filter(
			(pull) => pull.headRefName === branch,
		);
		if (pulls.length === 0) return { state: "none" };
		if (pulls.length !== 1) {
			throw new Error(
				`summary_pr_ambiguous: ${pulls.length} PRs use stable branch ${branch}`,
			);
		}
		const pull = pulls[0]!;
		if (pull.mergedAt) {
			return { state: "merged", prNumber: pull.number, url: pull.url };
		}
		if (pull.state === "OPEN") {
			return {
				state: "open",
				prNumber: pull.number,
				url: pull.url,
				branch,
			};
		}
		return { state: "closed", prNumber: pull.number, url: pull.url };
	}

	async create(input: SummaryDeliveryInput): Promise<SummaryDeliveryResult> {
		const temporary = mkdtempSync(join(tmpdir(), "flywheel-summary-create-"));
		const repoDir = join(temporary, "repo");
		try {
			const defaultBranch = this.commands
				.run("gh", [
					"repo",
					"view",
					input.repo,
					"--json",
					"defaultBranchRef",
					"--jq",
					".defaultBranchRef.name",
				])
				.trim();
			if (!/^[A-Za-z0-9._/-]+$/.test(defaultBranch)) {
				throw new Error("summary_github_invalid: default branch is malformed");
			}
			this.commands.run("gh", [
				"repo",
				"clone",
				input.repo,
				repoDir,
				"--",
				"--branch",
				defaultBranch,
				"--single-branch",
				"--depth",
				"1",
			]);
			const branch = branchFor(input);
			this.commands.run("git", ["checkout", "-b", branch], repoDir);
			const path = buildSummaryPath({
				project: input.project,
				lead: input.author,
				period: input.period,
				granularity: input.granularity,
				sequence: nextSequence(repoDir, input),
			});
			validateSummaryArtifact({
				path,
				content: input.content,
				granularity: input.granularity,
				expectedProject: input.project,
				expectedLead: input.author,
				expectedPeriod: input.period,
			});
			const target = join(repoDir, ...path.split("/"));
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, input.content, { encoding: "utf8", mode: 0o644 });
			chmodSync(target, 0o644);
			this.commit(repoDir, path, `summary(${input.project}): ${input.period}`);
			// Creation is deliberately non-force and create-only. A same-key race
			// fails here rather than silently turning into an update.
			this.commands.run(
				"git",
				["push", "origin", `HEAD:refs/heads/${branch}`],
				repoDir,
			);
			const url = this.commands
				.run("gh", [
					"pr",
					"create",
					"--repo",
					input.repo,
					"--base",
					defaultBranch,
					"--head",
					branch,
					"--title",
					`Summary: ${input.project} · ${input.period}`,
					"--body",
					`Flywheel summary inflow.\n\n<!-- flywheel-summary-key:${keyDigest(input)} -->`,
				])
				.trim();
			return { prNumber: pullNumberFromUrl(url), url, path };
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	}

	async update(input: SummaryDeliveryInput): Promise<SummaryDeliveryResult> {
		if (!input.existing) {
			throw new Error("summary_open_pr_invalid: update requires inspected PR");
		}
		const temporary = mkdtempSync(join(tmpdir(), "flywheel-summary-update-"));
		const repoDir = join(temporary, "repo");
		try {
			this.commands.run("gh", [
				"repo",
				"clone",
				input.repo,
				repoDir,
				"--",
				"--branch",
				input.existing.branch,
				"--single-branch",
				"--depth",
				"1",
			]);
			const path = exactArtifactPath(repoDir, input);
			const target = join(repoDir, ...path.split("/"));
			validateSummaryArtifact({
				path,
				content: input.content,
				granularity: input.granularity,
				expectedProject: input.project,
				expectedLead: input.author,
				expectedPeriod: input.period,
			});
			writeFileSync(target, input.content, { encoding: "utf8", mode: 0o644 });
			chmodSync(target, 0o644);
			const changed = this.commands
				.run("git", ["status", "--porcelain", "--", path], repoDir)
				.trim();
			if (changed) {
				this.commit(
					repoDir,
					path,
					`summary(${input.project}): update ${input.period}`,
				);
				this.commands.run(
					"git",
					["push", "origin", `HEAD:refs/heads/${input.existing.branch}`],
					repoDir,
				);
			}
			return {
				prNumber: input.existing.prNumber,
				url: input.existing.url,
				path,
			};
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	}

	private commit(repoDir: string, path: string, message: string): void {
		this.commands.run("git", ["add", "--", path], repoDir);
		this.commands.run(
			"git",
			[
				"-c",
				"user.name=Flywheel Summary",
				"-c",
				"user.email=flywheel-summary@localhost",
				"commit",
				"-m",
				message,
			],
			repoDir,
		);
	}
}

export function createGitHubSummaryDelivery(
	commands: CommandRunner = defaultRunner,
): SummaryDelivery {
	return new GitHubSummaryDelivery(commands);
}

import { execFile } from "node:child_process";

export type ContinuityProbe =
	| { kind: "exists"; sha: string }
	| { kind: "missing" }
	| { kind: "indeterminate"; error: string };

export type ContinuityGit = (
	args: string[],
	cwd: string,
) => Promise<{ stdout: string }>;

export type WithRepoLock = <T>(
	repoPath: string,
	fn: () => Promise<T>,
) => Promise<T>;

export interface MaterializeRemoteBranchInput {
	repoPath: string;
	branch: string;
}

export interface MaterializeRemoteBranchDeps {
	runGit?: ContinuityGit;
	withRepoLock?: WithRepoLock;
}

export interface OpenPullRequest {
	number: number;
	url: string;
	updatedAt: string;
}

export type ContinuityGh = (
	args: string[],
	cwd: string,
) => Promise<{ stdout: string }>;

const COMMIT_SHA = /^[0-9a-f]{40,64}$/;

const defaultRunGit: ContinuityGit = (args, cwd) =>
	new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{
				cwd,
				encoding: "utf8",
				timeout: 20_000,
			},
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolve({ stdout });
			},
		);
	});

const defaultRunGh: ContinuityGh = (args, cwd) =>
	new Promise((resolve, reject) => {
		execFile(
			"gh",
			args,
			{ cwd, encoding: "utf8", timeout: 20_000 },
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolve({ stdout });
			},
		);
	});

function errorDetail(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const failure = error as Error & {
		code?: unknown;
		status?: unknown;
		signal?: unknown;
		stderr?: unknown;
	};
	const stderr =
		typeof failure.stderr === "string"
			? failure.stderr.trim()
			: Buffer.isBuffer(failure.stderr)
				? failure.stderr.toString("utf8").trim()
				: "";
	return [
		failure.message,
		stderr,
		failure.status !== undefined ? `exit=${String(failure.status)}` : "",
		failure.signal ? `signal=${String(failure.signal)}` : "",
	]
		.filter(Boolean)
		.join(" ");
}

function exitStatus(error: unknown): unknown {
	const failure = error as
		| { code?: unknown; status?: unknown }
		| null
		| undefined;
	return typeof failure?.code === "number" ? failure.code : failure?.status;
}

function parseLsRemote(stdout: string, branch: string): string | null {
	const expectedRef = `refs/heads/${branch}`;
	const matches = stdout
		.trim()
		.split("\n")
		.map((line) => line.trim().split(/\s+/, 2))
		.filter(
			(parts): parts is [string, string] =>
				parts.length === 2 && parts[1] === expectedRef,
		);
	if (matches.length !== 1) return null;
	const sha = matches[0]![0].toLowerCase();
	return COMMIT_SHA.test(sha) ? sha : null;
}

/**
 * FLY-1718: reconcile a managed branch with origin before a fresh dispatch.
 *
 * `ls-remote` supplies the network truth, then an explicit targeted fetch
 * materializes that exact branch in the local object database. The post-fetch
 * remote-tracking SHA is compared with the probe to close the moving-ref
 * window. One movement is retried; anything still ambiguous fails closed.
 */
export async function materializeRemoteBranch(
	input: MaterializeRemoteBranchInput,
	deps: MaterializeRemoteBranchDeps = {},
): Promise<ContinuityProbe> {
	const runGit = deps.runGit ?? defaultRunGit;
	const withRepoLock: WithRepoLock =
		deps.withRepoLock ?? (async (_repo, fn) => fn());

	return withRepoLock(input.repoPath, async () => {
		const remoteRef = `refs/heads/${input.branch}`;
		const trackingRef = `refs/remotes/origin/${input.branch}`;
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			let remoteSha: string;
			try {
				const probed = await runGit(
					["ls-remote", "--exit-code", "--heads", "origin", input.branch],
					input.repoPath,
				);
				const parsed = parseLsRemote(probed.stdout, input.branch);
				if (!parsed) {
					return {
						kind: "indeterminate",
						error: `git ls-remote returned an invalid result for ${remoteRef}`,
					};
				}
				remoteSha = parsed;
			} catch (error) {
				if (exitStatus(error) === 2) return { kind: "missing" };
				return { kind: "indeterminate", error: errorDetail(error) };
			}

			try {
				await runGit(
					["fetch", "--no-tags", "origin", `+${remoteRef}:${trackingRef}`],
					input.repoPath,
				);
				const resolved = (
					await runGit(
						["rev-parse", "--verify", `${trackingRef}^{commit}`],
						input.repoPath,
					)
				).stdout
					.trim()
					.toLowerCase();
				if (!COMMIT_SHA.test(resolved)) {
					return {
						kind: "indeterminate",
						error: `git rev-parse returned an invalid sha for ${trackingRef}`,
					};
				}
				await runGit(
					["cat-file", "-e", `${resolved}^{commit}`],
					input.repoPath,
				);
				if (resolved === remoteSha) return { kind: "exists", sha: resolved };
				if (attempt === 2) {
					return {
						kind: "indeterminate",
						error: `${remoteRef} moved during materialization (${remoteSha} -> ${resolved})`,
					};
				}
			} catch (error) {
				return { kind: "indeterminate", error: errorDetail(error) };
			}
		}

		return {
			kind: "indeterminate",
			error: `${remoteRef} could not be materialized`,
		};
	});
}

function githubRepoFromOrigin(remoteUrl: string): {
	owner: string;
	repo: string;
} | null {
	const trimmed = remoteUrl.trim().replace(/\.git$/, "");
	const match = trimmed.match(
		/^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+)$/,
	);
	return match ? { owner: match[1]!, repo: match[2]! } : null;
}

/** Best-effort enrichment only; branch materialization remains the hard gate. */
export async function lookupOpenPullRequests(
	input: MaterializeRemoteBranchInput,
	deps: { runGit?: ContinuityGit; runGh?: ContinuityGh } = {},
): Promise<OpenPullRequest[]> {
	const runGit = deps.runGit ?? defaultRunGit;
	const runGh = deps.runGh ?? defaultRunGh;
	try {
		const originUrl = (
			await runGit(["remote", "get-url", "origin"], input.repoPath)
		).stdout.trim();
		const repo = githubRepoFromOrigin(originUrl);
		if (!repo) return [];
		let base = "main";
		try {
			const symbolic = (
				await runGit(
					["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
					input.repoPath,
				)
			).stdout.trim();
			if (
				symbolic.startsWith("origin/") &&
				symbolic.length > "origin/".length
			) {
				base = symbolic.slice("origin/".length);
			}
		} catch {
			// origin/HEAD is optional; Flywheel-managed repos default to main.
		}
		const response = await runGh(
			[
				"api",
				"--method",
				"GET",
				`repos/${repo.owner}/${repo.repo}/pulls`,
				"-f",
				`head=${repo.owner}:${input.branch}`,
				"-f",
				`base=${base}`,
				"-f",
				"state=open",
			],
			input.repoPath,
		);
		const parsed = JSON.parse(response.stdout) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.flatMap((item): OpenPullRequest[] => {
				if (!item || typeof item !== "object") return [];
				const row = item as Record<string, unknown>;
				return typeof row.number === "number" &&
					typeof row.html_url === "string" &&
					typeof row.updated_at === "string"
					? [
							{
								number: row.number,
								url: row.html_url,
								updatedAt: row.updated_at,
							},
						]
					: [];
			})
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

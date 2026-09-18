import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { RegisteredProject } from "../directory.js";
import type {
	CanonicalCommit,
	CheckoutCommit,
	ProjectReading,
	Reading,
} from "./types.js";

export interface CommandOptions {
	timeoutMs: number;
	signal: AbortSignal;
	input?: string;
}

export type CommandRunner = (
	argv: readonly string[],
	options: CommandOptions,
) => Promise<string>;

export interface PortfolioSamplerOptions {
	gitBin: string;
	ghBin: string;
	linearApiKey: string | null;
	codexCwd: string;
	commandTimeoutMs: number;
	now?: () => Date;
	run?: CommandRunner;
	fetcher?: typeof fetch;
}

export async function probeGitHubAuth(
	ghBin: string,
	timeoutMs: number,
	run?: CommandRunner,
): Promise<"ok" | `unavailable:${string}`> {
	if (!run) return "unavailable:host_command_adapter_required";
	const controller = new AbortController();
	try {
		await run([ghBin, "auth", "status"], {
			timeoutMs,
			signal: controller.signal,
		});
		return "ok";
	} catch (error) {
		return `unavailable:${commandReason(error, "gh", controller.signal)}`;
	}
}

const NON_CHORE_ARGS = [
	"--extended-regexp",
	"--regexp-ignore-case",
	"--invert-grep",
	"--grep=^chore(\\(|:|!)",
] as const;

const LINEAR_QUERY = `query($team: String!, $project: String!) {
  teams(filter: { key: { eq: $team } }) { nodes {
    projects(filter: { name: { eq: $project } }) { nodes {
      id name state updatedAt
      issues(first: 50, orderBy: updatedAt,
             filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
        pageInfo { hasNextPage }
        nodes { identifier updatedAt state { name } }
      }
    } }
  } }
}`;

function ok<T>(value: T, at: string): Reading<T> {
	return { ok: true, value, at };
}

function unavailable<T>(reason: string): Reading<T> {
	return { ok: false, reason };
}

function unavailableCheckout(reason: string): ProjectReading["checkoutHead"] {
	return {
		branch: unavailable(reason),
		lastCommit: unavailable(reason),
		lastNonChoreCommit: unavailable(reason),
		commits30d: unavailable(reason),
		nonChoreCommits30d: unavailable(reason),
		dirtyCount: unavailable(reason),
		worktreeCount: unavailable(reason),
	};
}

function unavailableCanonical(reason: string): ProjectReading["canonical"] {
	return {
		defaultBranch: unavailable(reason),
		lastCommit: unavailable(reason),
	};
}

function unavailablePrActivity(reason: string): ProjectReading["prActivity"] {
	return {
		number: unavailable(reason),
		state: unavailable(reason),
		updatedAt: unavailable(reason),
		mergedAt: unavailable(reason),
	};
}

function unavailableOpenPrs(reason: string): ProjectReading["openPrs"] {
	return {
		returnedCount: unavailable(reason),
		truncated: unavailable(reason),
		newestUpdatedAt: unavailable(reason),
		oldestUpdatedAt: unavailable(reason),
		sample: unavailable(reason),
	};
}

function unavailableLinear(reason: string): ProjectReading["linear"] {
	return {
		projectState: unavailable(reason),
		projectUpdatedAt: unavailable(reason),
		activeIssues: unavailable(reason),
	};
}

function parseInteger(output: string): number {
	const value = output.trim();
	if (!/^\d+$/.test(value)) throw new Error("parse_error");
	return Number(value);
}

function parseIso(value: unknown): string {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
		throw new Error("parse_error");
	}
	return value;
}

function safeText(value: unknown, maximum = 500): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		Array.from(value).length > maximum ||
		Array.from(value).some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code <= 0x1f || code === 0x7f;
		})
	) {
		throw new Error("parse_error");
	}
	return value;
}

function parseCheckoutCommit(output: string): CheckoutCommit {
	const parts = output.trimEnd().split("\u001f");
	if (parts.length !== 5) throw new Error("parse_error");
	const [sha, committedAt, authoredAt, author, subject] = parts;
	if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error("parse_error");
	return {
		sha7: sha.slice(0, 7),
		committedAt: parseIso(committedAt),
		authoredAt: parseIso(authoredAt),
		author: safeText(author, 200),
		subject: safeText(subject, 500),
	};
}

function commandReason(
	error: unknown,
	kind: "git" | "gh",
	globalSignal: AbortSignal,
): string {
	if (globalSignal.aborted) return "deadline";
	const candidate = error as NodeJS.ErrnoException & { killed?: boolean };
	if (candidate?.code === "ENOENT") return `${kind}_missing`;
	if (
		candidate?.code === "ETIMEDOUT" ||
		candidate?.name === "TimeoutError" ||
		candidate?.killed === true
	) {
		return "timeout";
	}
	const exit = candidate?.code;
	const safeExit =
		typeof exit === "number" && Number.isSafeInteger(exit)
			? String(exit)
			: typeof exit === "string" && /^-?\d+$/.test(exit)
				? exit
				: "unknown";
	return `${kind}_failed:${safeExit}`;
}

function parseJson(output: string): unknown {
	try {
		return JSON.parse(output);
	} catch {
		throw new Error("parse_error");
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("parse_error");
	}
	return value as Record<string, unknown>;
}

export class PortfolioSampler {
	private readonly now: () => Date;
	private readonly run: CommandRunner;
	private readonly fetcher: typeof fetch;

	constructor(private readonly options: PortfolioSamplerOptions) {
		this.now = options.now ?? (() => new Date());
		if (!options.run) throw new Error("host command adapter required");
		this.run = options.run;
		this.fetcher =
			options.fetcher ??
			(async () => {
				throw new Error("host network adapter required");
			});
	}

	async sampleProject(
		project: RegisteredProject,
		signal: AbortSignal,
	): Promise<ProjectReading> {
		const at = this.now().toISOString();
		const checkoutHead = await this.sampleCheckout(project, signal, at);
		const github = await this.sampleGitHub(project, signal, at);
		const linear = await this.sampleLinear(project, signal, at);
		const deployedCheckoutSummaryFiles = await this.sampleSummaries(
			project,
			signal,
			at,
		);
		const activity = this.activity(
			checkoutHead,
			github.canonical,
			github.prActivity,
			linear,
			at,
		);
		return {
			projectName: project.projectName,
			repo: project.projectRepo ?? null,
			linearBinding: project.linear,
			checkoutHead,
			...github,
			linear,
			deployedCheckoutSummaryFiles,
			activity,
		};
	}

	private command(
		argv: readonly string[],
		signal: AbortSignal,
	): Promise<string> {
		return this.run(argv, {
			timeoutMs: this.options.commandTimeoutMs,
			signal,
		});
	}

	private async sampleCheckout(
		project: RegisteredProject,
		signal: AbortSignal,
		at: string,
	): Promise<ProjectReading["checkoutHead"]> {
		if (!existsSync(project.projectRoot))
			return unavailableCheckout("dir_missing");
		const git = (...args: string[]) =>
			this.command(
				[this.options.gitBin, "-C", project.projectRoot, ...args],
				signal,
			);
		let branch: string;
		try {
			branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).trim();
			if (!branch) throw new Error("parse_error");
			if (branch === "HEAD") {
				const sha = (await git("rev-parse", "--short", "HEAD")).trim();
				if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error("parse_error");
				branch = `HEAD@${sha.slice(0, 7)}`;
			}
		} catch (error) {
			const reason = commandReason(error, "git", signal);
			if (error instanceof Error && error.message === "parse_error") {
				return unavailableCheckout("parse_error");
			}
			if (!reason.startsWith("git_failed:")) {
				return unavailableCheckout(reason);
			}
			try {
				const inside = (await git("rev-parse", "--is-inside-work-tree")).trim();
				return unavailableCheckout(
					inside === "true" ? "unborn" : "not_a_git_repo",
				);
			} catch {
				return unavailableCheckout("not_a_git_repo");
			}
		}
		const capture = async <T>(
			args: string[],
			parse: (output: string) => T,
		): Promise<Reading<T>> => {
			try {
				return ok(parse(await git(...args)), at);
			} catch (error) {
				if (error instanceof Error && error.message === "parse_error") {
					return unavailable("parse_error");
				}
				return unavailable(commandReason(error, "git", signal));
			}
		};
		return {
			branch: ok(branch, at),
			lastCommit: await capture(
				["log", "-1", "--format=%H%x1f%cI%x1f%aI%x1f%an%x1f%s"],
				parseCheckoutCommit,
			),
			lastNonChoreCommit: await capture(
				[
					"log",
					"-1",
					"--format=%H%x1f%cI%x1f%aI%x1f%an%x1f%s",
					...NON_CHORE_ARGS,
				],
				(output) =>
					output.trim().length === 0 ? null : parseCheckoutCommit(output),
			),
			commits30d: await capture(
				["rev-list", "--count", "--since=30.days", "HEAD"],
				parseInteger,
			),
			nonChoreCommits30d: await capture(
				["rev-list", "--count", "--since=30.days", "HEAD", ...NON_CHORE_ARGS],
				parseInteger,
			),
			dirtyCount: await capture(["status", "--porcelain"], (output) =>
				output.trimEnd().length === 0 ? 0 : output.trimEnd().split("\n").length,
			),
			worktreeCount: await capture(
				["worktree", "list", "--porcelain"],
				(output) =>
					output.split("\n").filter((line) => line.startsWith("worktree "))
						.length,
			),
		};
	}

	private async sampleGitHub(
		project: RegisteredProject,
		signal: AbortSignal,
		at: string,
	): Promise<Pick<ProjectReading, "canonical" | "prActivity" | "openPrs">> {
		if (!project.projectRepo) {
			return {
				canonical: unavailableCanonical("not_configured"),
				prActivity: unavailablePrActivity("not_configured"),
				openPrs: unavailableOpenPrs("not_configured"),
			};
		}
		const gh = (...args: string[]) =>
			this.command([this.options.ghBin, ...args], signal);
		let defaultBranch: Reading<string>;
		try {
			const value = (
				await gh(
					"repo",
					"view",
					project.projectRepo,
					"--json",
					"defaultBranchRef",
					"-q",
					".defaultBranchRef.name",
				)
			).trim();
			if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value)) {
				throw new Error("parse_error");
			}
			defaultBranch = ok(value, at);
		} catch (error) {
			if (error instanceof Error && error.message === "parse_error") {
				defaultBranch = unavailable("parse_error");
			} else {
				const reason = commandReason(error, "gh", signal);
				if (reason === "gh_missing") {
					return {
						canonical: unavailableCanonical(reason),
						prActivity: unavailablePrActivity(reason),
						openPrs: unavailableOpenPrs(reason),
					};
				}
				defaultBranch = unavailable(reason);
			}
		}
		let canonicalCommit: Reading<CanonicalCommit>;
		if (!defaultBranch.ok) {
			canonicalCommit = unavailable(defaultBranch.reason);
		} else {
			try {
				const parsed = parseJson(
					await gh(
						"api",
						`repos/${project.projectRepo}/commits?sha=${encodeURIComponent(defaultBranch.value)}&per_page=1`,
					),
				);
				if (!Array.isArray(parsed) || parsed.length !== 1) {
					throw new Error("parse_error");
				}
				const entry = asRecord(parsed[0]);
				const commit = asRecord(entry.commit);
				const committer = asRecord(commit.committer);
				const sha = safeText(entry.sha, 64);
				if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error("parse_error");
				const message =
					typeof commit.message === "string" ? commit.message : "";
				canonicalCommit = ok(
					{
						sha7: sha.slice(0, 7),
						committedAt: parseIso(committer.date),
						subject: safeText(message.split("\n")[0] ?? "", 500),
					},
					at,
				);
			} catch (error) {
				canonicalCommit = unavailable(
					error instanceof Error && error.message === "parse_error"
						? "parse_error"
						: commandReason(error, "gh", signal),
				);
			}
		}
		const prActivity = await this.samplePrActivity(
			project.projectRepo,
			gh,
			signal,
			at,
		);
		const openPrs = await this.sampleOpenPrs(
			project.projectRepo,
			gh,
			signal,
			at,
		);
		return {
			canonical: { defaultBranch, lastCommit: canonicalCommit },
			prActivity,
			openPrs,
		};
	}

	private async samplePrActivity(
		repository: string,
		gh: (...args: string[]) => Promise<string>,
		signal: AbortSignal,
		at: string,
	): Promise<ProjectReading["prActivity"]> {
		try {
			const value = parseJson(
				await gh(
					"pr",
					"list",
					"-R",
					repository,
					"--state",
					"all",
					"--search",
					"sort:updated-desc",
					"--limit",
					"1",
					"--json",
					"number,state,updatedAt,mergedAt",
				),
			);
			if (!Array.isArray(value) || value.length > 1)
				throw new Error("parse_error");
			if (value.length === 0) {
				return {
					number: ok(null, at),
					state: ok(null, at),
					updatedAt: ok(null, at),
					mergedAt: ok(null, at),
				};
			}
			const entry = asRecord(value[0]);
			if (!Number.isSafeInteger(entry.number)) throw new Error("parse_error");
			const state = safeText(entry.state, 32);
			const updatedAt = parseIso(entry.updatedAt);
			const mergedAt =
				entry.mergedAt === null ? null : parseIso(entry.mergedAt);
			return {
				number: ok(entry.number as number, at),
				state: ok(state, at),
				updatedAt: ok(updatedAt, at),
				mergedAt: ok(mergedAt, at),
			};
		} catch (error) {
			const reason =
				error instanceof Error && error.message === "parse_error"
					? "parse_error"
					: commandReason(error, "gh", signal);
			return unavailablePrActivity(reason);
		}
	}

	private async sampleOpenPrs(
		repository: string,
		gh: (...args: string[]) => Promise<string>,
		signal: AbortSignal,
		at: string,
	): Promise<ProjectReading["openPrs"]> {
		try {
			const value = parseJson(
				await gh(
					"pr",
					"list",
					"-R",
					repository,
					"--state",
					"open",
					"--search",
					"sort:updated-desc",
					"--limit",
					"50",
					"--json",
					"number,title,updatedAt,isDraft",
				),
			);
			if (!Array.isArray(value) || value.length > 50)
				throw new Error("parse_error");
			const parsed = value.map((candidate) => {
				const entry = asRecord(candidate);
				if (
					!Number.isSafeInteger(entry.number) ||
					typeof entry.isDraft !== "boolean"
				) {
					throw new Error("parse_error");
				}
				return {
					number: entry.number as number,
					title: safeText(entry.title, 500),
					updatedAt: parseIso(entry.updatedAt),
					isDraft: entry.isDraft,
				};
			});
			const truncated = parsed.length === 50;
			return {
				returnedCount: ok(parsed.length, at),
				truncated: ok(truncated, at),
				newestUpdatedAt: ok(parsed[0]?.updatedAt ?? null, at),
				oldestUpdatedAt: truncated
					? unavailable("truncated")
					: ok(parsed.at(-1)?.updatedAt ?? null, at),
				sample: ok(
					parsed.slice(0, 5).map(({ number, title, isDraft }) => ({
						number,
						title,
						isDraft,
					})),
					at,
				),
			};
		} catch (error) {
			const reason =
				error instanceof Error && error.message === "parse_error"
					? "parse_error"
					: commandReason(error, "gh", signal);
			return unavailableOpenPrs(reason);
		}
	}

	private async sampleLinear(
		project: RegisteredProject,
		signal: AbortSignal,
		at: string,
	): Promise<ProjectReading["linear"]> {
		if (!this.options.linearApiKey || !project.linear) {
			return unavailableLinear("not_configured");
		}
		const timeout = AbortSignal.timeout(this.options.commandTimeoutMs);
		try {
			const response = await this.fetcher("https://api.linear.app/graphql", {
				method: "POST",
				headers: {
					Authorization: this.options.linearApiKey,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					query: LINEAR_QUERY,
					variables: project.linear,
				}),
				signal: AbortSignal.any([signal, timeout]),
			});
			if (!response.ok)
				return unavailableLinear(`linear_http:${response.status}`);
			const body = asRecord(await response.json());
			if (Array.isArray(body.errors) && body.errors.length > 0) {
				return unavailableLinear("linear_graphql_error");
			}
			const data = asRecord(body.data);
			const teams = asRecord(data.teams);
			if (!Array.isArray(teams.nodes)) throw new Error("parse_error");
			if (teams.nodes.length === 0)
				return unavailableLinear("linear_not_found");
			if (teams.nodes.length !== 1)
				return unavailableLinear("linear_ambiguous");
			const team = asRecord(teams.nodes[0]);
			const projects = asRecord(team.projects);
			if (!Array.isArray(projects.nodes)) throw new Error("parse_error");
			if (projects.nodes.length === 0)
				return unavailableLinear("linear_not_found");
			if (projects.nodes.length !== 1) {
				return unavailableLinear("linear_ambiguous");
			}
			const result = asRecord(projects.nodes[0]);
			const issues = asRecord(result.issues);
			const pageInfo = asRecord(issues.pageInfo);
			if (
				!Array.isArray(issues.nodes) ||
				typeof pageInfo.hasNextPage !== "boolean"
			) {
				throw new Error("parse_error");
			}
			const updated = issues.nodes.map((candidate) => {
				const issue = asRecord(candidate);
				safeText(issue.identifier, 64);
				asRecord(issue.state);
				return parseIso(issue.updatedAt);
			});
			return {
				projectState: ok(safeText(result.state, 100), at),
				projectUpdatedAt: ok(parseIso(result.updatedAt), at),
				activeIssues: ok(
					{
						returnedCount: updated.length,
						truncated: pageInfo.hasNextPage,
						latestUpdatedAt: updated[0] ?? null,
					},
					at,
				),
			};
		} catch (error) {
			if (signal.aborted) return unavailableLinear("deadline");
			if (timeout.aborted) return unavailableLinear("timeout");
			if (error instanceof Error && error.message === "parse_error") {
				return unavailableLinear("parse_error");
			}
			if (error instanceof Error && error.name === "TimeoutError") {
				return unavailableLinear("timeout");
			}
			return unavailableLinear("parse_error");
		}
	}

	private async sampleSummaries(
		project: RegisteredProject,
		signal: AbortSignal,
		at: string,
	): Promise<ProjectReading["deployedCheckoutSummaryFiles"]> {
		const summariesRoot = join(this.options.codexCwd, "summaries");
		const directory = join(summariesRoot, project.projectName);
		const contained = relative(summariesRoot, directory);
		if (contained.startsWith("..") || isAbsolute(contained)) {
			return {
				count: unavailable("parse_error"),
				latestDate: unavailable("parse_error"),
				checkoutSha: unavailable("parse_error"),
			};
		}
		let dates: string[] | null;
		try {
			const names = existsSync(directory) ? readdirSync(directory) : [];
			dates = names
				.map((name) => /^(\d{4}-\d{2}-\d{2})--/.exec(name)?.[1])
				.filter((value): value is string => value !== undefined)
				.sort();
		} catch {
			dates = null;
		}
		let checkoutSha: Reading<string>;
		try {
			const sha = (
				await this.command(
					[
						this.options.gitBin,
						"-C",
						this.options.codexCwd,
						"rev-parse",
						"--short",
						"HEAD",
					],
					signal,
				)
			).trim();
			if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error("parse_error");
			checkoutSha = ok(sha.slice(0, 7), at);
		} catch (error) {
			checkoutSha = unavailable(
				error instanceof Error && error.message === "parse_error"
					? "parse_error"
					: commandReason(error, "git", signal),
			);
		}
		return {
			count: dates ? ok(dates.length, at) : unavailable("parse_error"),
			latestDate: dates
				? ok(dates.at(-1) ?? null, at)
				: unavailable("parse_error"),
			checkoutSha,
		};
	}

	private activity(
		checkout: ProjectReading["checkoutHead"],
		canonical: ProjectReading["canonical"],
		prActivity: ProjectReading["prActivity"],
		linear: ProjectReading["linear"],
		at: string,
	): ProjectReading["activity"] {
		const candidates: Array<{ coverage: string; at: string }> = [];
		if (checkout.lastNonChoreCommit.ok && checkout.lastNonChoreCommit.value) {
			candidates.push({
				coverage: "checkout_non_chore",
				at: checkout.lastNonChoreCommit.value.committedAt,
			});
		}
		if (canonical.lastCommit.ok) {
			candidates.push({
				coverage: "canonical_commit",
				at: canonical.lastCommit.value.committedAt,
			});
		}
		if (prActivity.updatedAt.ok && prActivity.updatedAt.value) {
			candidates.push({
				coverage: "pr_activity",
				at: prActivity.updatedAt.value,
			});
		}
		if (linear.activeIssues.ok && linear.activeIssues.value.latestUpdatedAt) {
			candidates.push({
				coverage: "linear_active_issue",
				at: linear.activeIssues.value.latestUpdatedAt,
			});
		}
		if (candidates.length === 0) {
			return {
				latestObservedActivityAt: unavailable("no_activity_source"),
				coverage: unavailable("no_activity_source"),
				daysSinceLatestObservedActivity: unavailable("no_activity_source"),
			};
		}
		const latest = candidates.reduce((current, candidate) =>
			Date.parse(candidate.at) > Date.parse(current.at) ? candidate : current,
		);
		return {
			latestObservedActivityAt: ok(latest.at, at),
			coverage: ok(
				candidates.map((candidate) => candidate.coverage),
				at,
			),
			daysSinceLatestObservedActivity: ok(
				Math.max(
					0,
					Math.floor(
						(this.now().getTime() - Date.parse(latest.at)) / 86_400_000,
					),
				),
				at,
			),
		};
	}
}

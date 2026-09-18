import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("PortfolioSampler", () => {
	it("samples one project from Git, sorted GitHub activity, Linear variables, and deployed summaries", async () => {
		const module = await import("./sampler.js").catch(() => ({}));
		const PortfolioSampler = (module as { PortfolioSampler?: unknown })
			.PortfolioSampler;
		expect(PortfolioSampler).toBeTypeOf("function");
		if (typeof PortfolioSampler !== "function") return;

		const root = mkdtempSync(join(tmpdir(), "raya-sampler-"));
		const projectRoot = join(root, "project");
		const codexCwd = join(root, "deployed");
		mkdirSync(projectRoot);
		mkdirSync(join(codexCwd, "summaries", "flywheel"), {
			recursive: true,
		});
		writeFileSync(
			join(
				codexCwd,
				"summaries",
				"flywheel",
				"2026-09-05--flywheel-eng-lead--01.md",
			),
			"summary",
		);
		const calls: string[][] = [];
		const run = vi.fn(async (argv: readonly string[]) => {
			calls.push([...argv]);
			const key = argv.join(" ");
			if (key.includes("rev-parse --abbrev-ref HEAD")) return "main\n";
			if (key.includes(`-C ${codexCwd} rev-parse --short HEAD`)) {
				return "c0dec0d\n";
			}
			if (key.includes("log -1") && key.includes("--invert-grep")) {
				return "bbbbbbb222222222222222222222222222222222\u001f2026-09-01T10:00:00Z\u001f2026-09-01T09:00:00Z\u001fAnnie\u001ffeat: real work\n";
			}
			if (key.includes("log -1")) {
				return "aaaaaaa111111111111111111111111111111111\u001f2026-09-02T10:00:00Z\u001f2026-09-02T09:00:00Z\u001fAnnie\u001fchore: sweep\n";
			}
			if (key.includes("rev-list") && key.includes("--invert-grep"))
				return "2\n";
			if (key.includes("rev-list")) return "4\n";
			if (key.includes("status --porcelain")) return " M one\n?? two\n";
			if (key.includes("worktree list --porcelain")) {
				return "worktree /one\nHEAD a\n\nworktree /two\nHEAD b\n";
			}
			if (key.includes("repo view")) return "main\n";
			if (key.includes("gh api")) {
				return JSON.stringify([
					{
						sha: "ccccccc333333333333333333333333333333333",
						commit: {
							committer: { date: "2026-09-02T11:00:00Z" },
							message: "feat: canonical\n\nbody",
						},
					},
				]);
			}
			if (key.includes("pr list") && key.includes("--state all")) {
				return JSON.stringify([
					{
						number: 17,
						state: "OPEN",
						updatedAt: "2026-09-03T12:00:00Z",
						mergedAt: null,
					},
				]);
			}
			if (key.includes("pr list") && key.includes("--state open")) {
				return JSON.stringify([
					{
						number: 17,
						title: "Newest",
						updatedAt: "2026-09-03T12:00:00Z",
						isDraft: false,
					},
					{
						number: 12,
						title: "Oldest",
						updatedAt: "2026-08-01T12:00:00Z",
						isDraft: true,
					},
				]);
			}
			throw new Error(`unexpected command: ${key}`);
		});
		const fetcher = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as { variables?: unknown };
				expect(body.variables).toEqual({ team: "FLY", project: "Flywheel" });
				return new Response(
					JSON.stringify({
						data: {
							teams: {
								nodes: [
									{
										projects: {
											nodes: [
												{
													id: "project-1",
													name: "Flywheel",
													state: "started",
													updatedAt: "2026-09-05T12:00:00Z",
													issues: {
														pageInfo: { hasNextPage: false },
														nodes: [
															{
																identifier: "FLY-2381",
																updatedAt: "2026-09-04T12:00:00Z",
																state: { name: "In Progress" },
															},
														],
													},
												},
											],
										},
									},
								],
							},
						},
					}),
					{ status: 200 },
				);
			},
		);
		const sampler = new (
			PortfolioSampler as new (
				options: Record<string, unknown>,
			) => {
				sampleProject: (
					project: Record<string, unknown>,
					signal: AbortSignal,
				) => Promise<Record<string, unknown>>;
			}
		)({
			gitBin: "/usr/bin/git",
			ghBin: "/opt/homebrew/bin/gh",
			linearApiKey: "linear-key",
			codexCwd,
			commandTimeoutMs: 10_000,
			now: () => new Date("2026-09-06T12:00:00Z"),
			run,
			fetcher,
		});

		const reading = await sampler.sampleProject(
			{
				projectName: "flywheel",
				projectRoot,
				projectRepo: "xrliAnnie/flywheel",
				linear: { team: "FLY", project: "Flywheel" },
			},
			new AbortController().signal,
		);

		expect(reading).toMatchObject({
			projectName: "flywheel",
			repo: "xrliAnnie/flywheel",
			linearBinding: { team: "FLY", project: "Flywheel" },
			checkoutHead: {
				branch: { ok: true, value: "main" },
				lastCommit: { ok: true, value: { sha7: "aaaaaaa" } },
				lastNonChoreCommit: { ok: true, value: { sha7: "bbbbbbb" } },
				commits30d: { ok: true, value: 4 },
				nonChoreCommits30d: { ok: true, value: 2 },
				dirtyCount: { ok: true, value: 2 },
				worktreeCount: { ok: true, value: 2 },
			},
			canonical: {
				defaultBranch: { ok: true, value: "main" },
				lastCommit: { ok: true, value: { sha7: "ccccccc" } },
			},
			prActivity: {
				number: { ok: true, value: 17 },
				updatedAt: { ok: true, value: "2026-09-03T12:00:00Z" },
			},
			openPrs: {
				returnedCount: { ok: true, value: 2 },
				truncated: { ok: true, value: false },
				newestUpdatedAt: { ok: true, value: "2026-09-03T12:00:00Z" },
				oldestUpdatedAt: { ok: true, value: "2026-08-01T12:00:00Z" },
			},
			linear: {
				projectState: { ok: true, value: "started" },
				activeIssues: {
					ok: true,
					value: {
						returnedCount: 1,
						truncated: false,
						latestUpdatedAt: "2026-09-04T12:00:00Z",
					},
				},
			},
			deployedCheckoutSummaryFiles: {
				count: { ok: true, value: 1 },
				latestDate: { ok: true, value: "2026-09-05" },
				checkoutSha: { ok: true, value: "c0dec0d" },
			},
			activity: {
				latestObservedActivityAt: { ok: true, value: "2026-09-04T12:00:00Z" },
				coverage: {
					ok: true,
					value: [
						"checkout_non_chore",
						"canonical_commit",
						"pr_activity",
						"linear_active_issue",
					],
				},
				daysSinceLatestObservedActivity: { ok: true, value: 2 },
			},
		});
		expect(
			calls.some(
				(argv) =>
					argv.includes("--state") &&
					argv.includes("all") &&
					argv[argv.indexOf("-R") + 1] === "xrliAnnie/flywheel" &&
					argv.includes("--search") &&
					argv.includes("sort:updated-desc"),
			),
		).toBe(true);
	});

	it("distinguishes an unborn repository from a non-Git directory", async () => {
		const { PortfolioSampler } = await import("./sampler.js");
		const root = mkdtempSync(join(tmpdir(), "raya-sampler-unborn-"));
		const projectRoot = join(root, "project");
		const codexCwd = join(root, "deployed");
		mkdirSync(projectRoot);
		mkdirSync(codexCwd);
		const run = vi.fn(async (argv: readonly string[]) => {
			const key = argv.join(" ");
			if (key.includes("rev-parse --abbrev-ref HEAD")) {
				throw Object.assign(new Error("unborn"), { code: 128 });
			}
			if (key.includes("rev-parse --is-inside-work-tree")) return "true\n";
			if (key.includes(`-C ${codexCwd} rev-parse --short HEAD`)) {
				throw Object.assign(new Error("unborn"), { code: 128 });
			}
			throw Object.assign(new Error("gh missing"), { code: "ENOENT" });
		});
		const sampler = new PortfolioSampler({
			gitBin: "/usr/bin/git",
			ghBin: "/missing/gh",
			linearApiKey: null,
			codexCwd,
			commandTimeoutMs: 10_000,
			run,
		});

		const reading = await sampler.sampleProject(
			{
				projectName: "empty",
				projectRoot,
				projectRepo: "owner/empty",
				linear: null,
			},
			new AbortController().signal,
		);

		expect(reading.checkoutHead.branch).toEqual({
			ok: false,
			reason: "unborn",
		});
		expect(reading.canonical.lastCommit).toEqual({
			ok: false,
			reason: "gh_missing",
		});
		expect(reading.activity.daysSinceLatestObservedActivity).toEqual({
			ok: false,
			reason: "no_activity_source",
		});
	});

	it("classifies a Linear request deadline as a command timeout", async () => {
		const { PortfolioSampler } = await import("./sampler.js");
		const root = mkdtempSync(join(tmpdir(), "raya-sampler-linear-timeout-"));
		const codexCwd = join(root, "deployed");
		mkdirSync(codexCwd);
		const fetcher = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() =>
							reject(
								Object.assign(new Error("aborted"), { name: "AbortError" }),
							),
						{ once: true },
					);
				}),
		);
		const sampler = new PortfolioSampler({
			gitBin: "/usr/bin/git",
			ghBin: "/opt/homebrew/bin/gh",
			linearApiKey: "linear-key",
			codexCwd,
			commandTimeoutMs: 5,
			run: vi.fn(async () => "c0dec0d\n"),
			fetcher,
		});

		const reading = await sampler.sampleProject(
			{
				projectName: "missing-checkout",
				projectRoot: join(root, "missing"),
				linear: { team: "FLY", project: "Flywheel" },
			},
			new AbortController().signal,
		);

		expect(reading.linear).toEqual({
			projectState: { ok: false, reason: "timeout" },
			projectUpdatedAt: { ok: false, reason: "timeout" },
			activeIssues: { ok: false, reason: "timeout" },
		});
	});

	it("keeps a summary-directory read failure inside the reading boundary", async () => {
		const { PortfolioSampler } = await import("./sampler.js");
		const root = mkdtempSync(join(tmpdir(), "raya-sampler-summary-error-"));
		const codexCwd = join(root, "deployed");
		mkdirSync(join(codexCwd, "summaries"), { recursive: true });
		writeFileSync(join(codexCwd, "summaries", "blocked"), "not a directory");
		const sampler = new PortfolioSampler({
			gitBin: "/usr/bin/git",
			ghBin: "/opt/homebrew/bin/gh",
			linearApiKey: null,
			codexCwd,
			commandTimeoutMs: 10_000,
			run: vi.fn(async () => "c0dec0d\n"),
		});

		const reading = await sampler.sampleProject(
			{
				projectName: "blocked",
				projectRoot: join(root, "missing"),
				linear: null,
			},
			new AbortController().signal,
		);

		expect(reading.deployedCheckoutSummaryFiles).toEqual({
			count: { ok: false, reason: "parse_error" },
			latestDate: { ok: false, reason: "parse_error" },
			checkoutSha: { ok: true, value: "c0dec0d", at: expect.any(String) },
		});
	});

	it("never copies an arbitrary process error code into a snapshot reason", async () => {
		const { PortfolioSampler } = await import("./sampler.js");
		const root = mkdtempSync(join(tmpdir(), "raya-sampler-safe-reason-"));
		const projectRoot = join(root, "project");
		const codexCwd = join(root, "deployed");
		mkdirSync(projectRoot);
		mkdirSync(codexCwd);
		const run = vi.fn(async (argv: readonly string[]) => {
			if (argv.join(" ").includes("rev-parse --abbrev-ref HEAD"))
				return "main\n";
			throw Object.assign(new Error("stderr must not be stored"), {
				code: "SECRET-token",
			});
		});
		const sampler = new PortfolioSampler({
			gitBin: "/usr/bin/git",
			ghBin: "/opt/homebrew/bin/gh",
			linearApiKey: null,
			codexCwd,
			commandTimeoutMs: 10_000,
			run,
		});

		const reading = await sampler.sampleProject(
			{
				projectName: "safe",
				projectRoot,
				linear: null,
			},
			new AbortController().signal,
		);

		expect(reading.checkoutHead.lastCommit).toEqual({
			ok: false,
			reason: "git_failed:unknown",
		});
		expect(JSON.stringify(reading)).not.toContain("SECRET-token");
		expect(JSON.stringify(reading)).not.toContain("stderr must not be stored");
	});

	it("marks a 50-item open-PR sample truncated while retaining its newest date", async () => {
		const { PortfolioSampler } = await import("./sampler.js");
		const root = mkdtempSync(join(tmpdir(), "raya-sampler-open-prs-"));
		const codexCwd = join(root, "deployed");
		mkdirSync(codexCwd);
		const openPrs = Array.from({ length: 50 }, (_, index) => ({
			number: 100 - index,
			title: `PR ${index}`,
			updatedAt: `2026-08-${String(31 - Math.floor(index / 2)).padStart(2, "0")}T${String(23 - (index % 2)).padStart(2, "0")}:00:00Z`,
			isDraft: false,
		}));
		const run = vi.fn(async (argv: readonly string[]) => {
			const key = argv.join(" ");
			if (key.includes("repo view")) return "main\n";
			if (key.includes("gh api")) {
				return JSON.stringify([
					{
						sha: "ccccccc333333333333333333333333333333333",
						commit: {
							committer: { date: "2026-09-02T11:00:00Z" },
							message: "feat: canonical",
						},
					},
				]);
			}
			if (key.includes("pr list") && key.includes("--state all")) return "[]";
			if (key.includes("pr list") && key.includes("--state open")) {
				return JSON.stringify(openPrs);
			}
			if (key.includes(`-C ${codexCwd} rev-parse --short HEAD`)) {
				return "c0dec0d\n";
			}
			throw new Error(`unexpected command: ${key}`);
		});
		const sampler = new PortfolioSampler({
			gitBin: "/usr/bin/git",
			ghBin: "/opt/homebrew/bin/gh",
			linearApiKey: null,
			codexCwd,
			commandTimeoutMs: 10_000,
			run,
		});

		const reading = await sampler.sampleProject(
			{
				projectName: "flywheel",
				projectRoot: join(root, "missing"),
				projectRepo: "xrliAnnie/flywheel",
				linear: null,
			},
			new AbortController().signal,
		);

		expect(reading.prActivity.updatedAt).toEqual({
			ok: true,
			value: null,
			at: expect.any(String),
		});
		expect(reading.openPrs.returnedCount).toMatchObject({
			ok: true,
			value: 50,
		});
		expect(reading.openPrs.truncated).toMatchObject({ ok: true, value: true });
		expect(reading.openPrs.newestUpdatedAt).toMatchObject({
			ok: true,
			value: openPrs[0]?.updatedAt,
		});
		expect(reading.openPrs.oldestUpdatedAt).toEqual({
			ok: false,
			reason: "truncated",
		});
	});
});

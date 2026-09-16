import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { request as httpsRequest } from "node:https";
import { PassThrough } from "node:stream";
import { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { receiptZip } from "../../bridge/__tests__/beta-release-zip-fixture.js";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import type { LeadOperationContext } from "../broker.js";
import { LeadCapabilityBroker } from "../broker.js";
import { createGithubHandlers } from "../handlers/github.js";

function fixture() {
	const pr = {
		number: 7,
		html_url: "https://github.com/acme/project/pull/7",
		title: "Change",
		draft: false,
		head: {
			sha: "a".repeat(40),
			ref: "feature/test",
			repo: { full_name: "acme/project" },
		},
		base: { ref: "main", repo: { full_name: "acme/project" } },
	};
	const issue = {
		number: 7,
		title: "Issue",
		body: "Body",
		html_url: "https://github.com/acme/project/issues/7",
		repository_url: "https://api.github.com/repos/acme/project",
	};
	const client = {
		rest: {
			pulls: {
				get: vi.fn(async () => ({ data: pr })),
				create: vi.fn(async () => ({ data: { ...pr, draft: true } })),
				update: vi.fn(async () => ({ data: pr })),
				createReview: vi.fn(async () => ({
					data: {
						id: 42,
						html_url:
							"https://github.com/acme/project/pull/7#pullrequestreview-42",
						commit_id: "a".repeat(40),
						state: "COMMENTED",
					},
				})),
				list: vi.fn(async () => ({
					data: [pr],
					headers: { link: undefined as string | undefined },
				})),
			},
			issues: {
				get: vi.fn(async () => ({ data: issue })),
				createComment: vi.fn(async () => ({
					data: {
						id: 43,
						html_url:
							"https://github.com/acme/project/issues/7#issuecomment-43",
					},
				})),
			},
			checks: {
				listForRef: vi.fn(async () => ({
					data: {
						total_count: 1,
						check_runs: [
							{
								name: "CI",
								head_sha: "a".repeat(40),
								status: "completed",
								conclusion: "success",
								html_url: "https://github.com/acme/project/actions/runs/1",
							},
						],
					},
					headers: { link: undefined as string | undefined },
				})),
			},
			repos: {
				getCombinedStatusForRef: vi.fn(async () => ({
					data: {
						sha: "a".repeat(40),
						total_count: 1,
						statuses: [
							{
								context: "legacy-ci",
								state: "pending",
								target_url: null as string | null,
							},
						],
					},
					headers: { link: undefined as string | undefined },
				})),
			},
		},
	};
	const policy = {
		projectName: "flywheel",
		leadId: "product",
		owner: "acme",
		repo: "project",
		revision: "r1",
		creation: {
			defaultBranch: "main",
			headRefs: new Set(["feature/test"]),
			baseRefs: new Set(["main"]),
		},
	};
	const authorizeTarget = vi.fn(async () => {});
	const authorizeCreate = vi.fn(async () => {}),
		assertWriteTargetCurrent = vi.fn(() => {});
	const context: LeadOperationContext = {
		projectName: "flywheel",
		leadId: "product",
		activationId: "a1",
		requestId: "55555555-5555-4555-8555-555555555555",
		signal: new AbortController().signal,
		assertCurrent: async () => {},
	};
	const handlers = createGithubHandlers({
		client: client as unknown as Octokit,
		policy: () => policy,
		authorizeTarget,
		authorizeCreate,
		assertWriteTargetCurrent,
	});
	return {
		client,
		policy,
		context,
		handlers,
		pr,
		issue,
		authorizeTarget,
		authorizeCreate,
		assertWriteTargetCurrent,
	};
}
describe("GitHub fixed-repository read handlers", () => {
	it("supports scoped PR and issue views with provider evidence", async () => {
		const f = fixture();
		expect(
			await f.handlers.get("github.pr.view")!.execute({ number: 7 }, f.context),
		).toMatchObject({
			status: "succeeded",
			data: { pullRequest: { number: 7, head: "a".repeat(40), base: "main" } },
		});
		expect(f.client.rest.pulls.get).toHaveBeenCalledWith({
			request: { signal: f.context.signal },
			owner: "acme",
			repo: "project",
			pull_number: 7,
		});
		expect(
			await f.handlers
				.get("github.issue.view")!
				.execute({ number: 7 }, f.context),
		).toMatchObject({
			status: "succeeded",
			data: { number: 7, title: "Issue" },
		});
		expect(f.client.rest.issues.get).toHaveBeenCalledWith({
			request: { signal: f.context.signal },
			owner: "acme",
			repo: "project",
			issue_number: 7,
		});
	});
	it.each(["/repos/acme/project/pulls", "/repositories/1296269/pulls"])(
		"lists bounded pages from %s without following provider URLs",
		async (path) => {
			const f = fixture();
			f.client.rest.pulls.list.mockResolvedValue({
				data: [f.pr],
				headers: {
					link: `<https://api.github.com${path}?page=3>; rel="next"`,
				},
			});
			expect(
				await f.handlers
					.get("github.pr.list")!
					.execute({ cursor: "2", limit: 1 }, f.context),
			).toMatchObject({ data: { nextCursor: "3" } });
			expect(f.client.rest.pulls.list).toHaveBeenCalledWith({
				request: { signal: f.context.signal },
				owner: "acme",
				repo: "project",
				page: 2,
				per_page: 1,
				state: "open",
			});
			await expect(
				f.handlers
					.get("github.pr.list")!
					.execute({ cursor: "https://evil/page" }, f.context),
			).rejects.toThrow();
			expect(f.client.rest.pulls.list).toHaveBeenCalledTimes(1);
		},
	);
	it("includes check-runs and legacy commit statuses on the exact PR head", async () => {
		const f = fixture();
		const result = await f.handlers
			.get("github.pr.checks")!
			.execute({ number: 7 }, f.context);
		expect(result).toMatchObject({
			data: {
				checks: [
					{ name: "check:CI", status: "completed", conclusion: "success" },
					{ name: "status:legacy-ci", status: "pending", conclusion: null },
				],
			},
		});
		expect(f.client.rest.checks.listForRef).toHaveBeenCalledWith({
			request: { signal: f.context.signal },
			owner: "acme",
			repo: "project",
			ref: "a".repeat(40),
			per_page: 100,
			page: 1,
		});
		expect(f.client.rest.repos.getCombinedStatusForRef).toHaveBeenCalledWith({
			request: { signal: f.context.signal },
			owner: "acme",
			repo: "project",
			ref: "a".repeat(40),
			per_page: 100,
			page: 1,
		});
	});
	it("denies foreign policy, repository response and caller-supplied repository", async () => {
		const f = fixture();
		f.policy.leadId = "foreign";
		await expect(
			f.handlers.get("github.pr.view")!.execute({ number: 7 }, f.context),
		).rejects.toThrow();
		expect(f.client.rest.pulls.get).not.toHaveBeenCalled();
		f.policy.leadId = "product";
		f.pr.base.repo.full_name = "foreign/repo";
		await expect(
			f.handlers.get("github.pr.view")!.execute({ number: 7 }, f.context),
		).rejects.toThrow();
		await expect(
			f.handlers
				.get("github.issue.view")!
				.execute({ number: 7, repo: "foreign" }, f.context),
		).rejects.toThrow();
		expect(f.client.rest.issues.get).not.toHaveBeenCalled();
	});
	it("rechecks revision after async authorization and provider reads", async () => {
		const f = fixture();
		f.authorizeTarget.mockImplementation(async () => {
			f.policy.revision = "r2";
		});
		await expect(
			f.handlers.get("github.pr.view")!.execute({ number: 7 }, f.context),
		).rejects.toThrow();
		expect(f.client.rest.pulls.get).not.toHaveBeenCalled();
		const g = fixture();
		g.client.rest.pulls.get.mockImplementation(async () => {
			g.policy.revision = "r2";
			return { data: g.pr };
		});
		await expect(
			g.handlers.get("github.pr.checks")!.execute({ number: 7 }, g.context),
		).rejects.toThrow();
		expect(g.client.rest.checks.listForRef).not.toHaveBeenCalled();
	});
	it("fails closed on incomplete checks or legacy statuses instead of claiming all green", async () => {
		const f = fixture();
		f.client.rest.checks.listForRef.mockResolvedValue({
			data: { total_count: 2, check_runs: [] },
			headers: { link: undefined },
		});
		await expect(
			f.handlers.get("github.pr.checks")!.execute({ number: 7 }, f.context),
		).rejects.toThrow("github_checks_incomplete");
		const g = fixture();
		g.client.rest.repos.getCombinedStatusForRef.mockResolvedValue({
			data: { sha: "a".repeat(40), total_count: 101, statuses: [] },
			headers: { link: undefined },
		});
		await expect(
			g.handlers.get("github.pr.checks")!.execute({ number: 7 }, g.context),
		).rejects.toThrow("github_checks_incomplete");
	});
});

it("denies business targets before HTTP and rejects foreign issue repository evidence", async () => {
	const f = fixture();
	f.authorizeTarget.mockRejectedValue(new Error("department_denied"));
	await expect(
		f.handlers.get("github.pr.view")!.execute({ number: 7 }, f.context),
	).rejects.toThrow();
	expect(f.client.rest.pulls.get).not.toHaveBeenCalled();
	const g = fixture();
	g.issue.repository_url = "https://api.github.com/repos/foreign/repo";
	await expect(
		g.handlers.get("github.issue.view")!.execute({ number: 7 }, g.context),
	).rejects.toThrow("github_foreign_resource");
});
it("rejects foreign pagination and unknown legacy states without inventing completion", async () => {
	const f = fixture();
	f.client.rest.pulls.list.mockResolvedValue({
		data: [f.pr],
		headers: {
			link: '<https://evil.test/repos/acme/project/pulls?page=2>; rel="next"',
		},
	});
	await expect(
		f.handlers.get("github.pr.list")!.execute({}, f.context),
	).rejects.toThrow("github_pagination_incomplete");
	const g = fixture();
	g.client.rest.repos.getCombinedStatusForRef.mockResolvedValue({
		data: {
			sha: "a".repeat(40),
			total_count: 1,
			statuses: [{ context: "legacy", state: "mystery", target_url: null }],
		},
		headers: { link: undefined },
	});
	await expect(
		g.handlers.get("github.pr.checks")!.execute({ number: 7 }, g.context),
	).rejects.toThrow("github_checks_incomplete");
});
it("does not retry an SDK request failure", async () => {
	const f = fixture();
	f.client.rest.pulls.get.mockRejectedValue(new Error("network"));
	await expect(
		f.handlers.get("github.pr.view")!.execute({ number: 7 }, f.context),
	).rejects.toThrow("network");
	expect(f.client.rest.pulls.get).toHaveBeenCalledTimes(1);
});

it("rejects a changed PR head after fetching checks and retains checked-head provenance", async () => {
	const f = fixture();
	f.client.rest.pulls.get
		.mockResolvedValueOnce({ data: f.pr })
		.mockResolvedValueOnce({
			data: { ...f.pr, head: { sha: "b".repeat(40) } },
		});
	await expect(
		f.handlers.get("github.pr.checks")!.execute({ number: 7 }, f.context),
	).rejects.toThrow("github_head_changed");
	const g = fixture();
	expect(
		await g.handlers.get("github.pr.checks")!.execute({ number: 7 }, g.context),
	).toMatchObject({ providerRef: `pr:7:${"a".repeat(40)}` });
});
it("rejects check-run or combined-status SHA evidence for a different head", async () => {
	const f = fixture(),
		runs = await f.client.rest.checks.listForRef();
	runs.data.check_runs[0]!.head_sha = "b".repeat(40);
	f.client.rest.checks.listForRef.mockResolvedValue(runs);
	await expect(
		f.handlers.get("github.pr.checks")!.execute({ number: 7 }, f.context),
	).rejects.toThrow("github_checks_head_mismatch");
	const g = fixture(),
		statuses = await g.client.rest.repos.getCombinedStatusForRef();
	statuses.data.sha = "b".repeat(40);
	g.client.rest.repos.getCombinedStatusForRef.mockResolvedValue(statuses);
	await expect(
		g.handlers.get("github.pr.checks")!.execute({ number: 7 }, g.context),
	).rejects.toThrow("github_checks_head_mismatch");
});

describe("GitHub scoped mutations", () => {
	it("creates and edits PR content using only trusted refs and fixed repository", async () => {
		const f = fixture();
		const input = {
			head: "feature/test",
			base: "main",
			title: "New",
			body: "Body",
			draft: true,
		};
		expect(
			await f.handlers.get("github.pr.create")!.execute(input, f.context),
		).toMatchObject({ status: "succeeded", providerRef: "pr:7" });
		expect(f.client.rest.pulls.create).toHaveBeenCalledWith({
			owner: "acme",
			repo: "project",
			...input,
			request: { signal: f.context.signal },
		});
		await f.handlers
			.get("github.pr.edit")!
			.execute({ number: 7, title: "Edit", body: "Review" }, f.context);
		expect(f.client.rest.pulls.update).toHaveBeenCalledWith({
			owner: "acme",
			repo: "project",
			pull_number: 7,
			title: "Edit",
			body: "Review",
			request: { signal: f.context.signal },
		});
	});
	it("supports PR and issue comments and preserves exact provider IDs", async () => {
		const f = fixture();
		for (const op of ["github.pr.comment", "github.issue.comment"]) {
			expect(
				await f.handlers
					.get(op)!
					.execute({ number: 7, body: "Comment" }, f.context),
			).toMatchObject({
				status: "succeeded",
				providerRef: "43",
				data: { commentId: "43" },
			});
		}
		expect(f.client.rest.issues.createComment).toHaveBeenCalledWith({
			owner: "acme",
			repo: "project",
			issue_number: 7,
			body: "Comment",
			request: { signal: f.context.signal },
		});
	});
	it("allows COMMENT review only and binds the exact live head", async () => {
		const f = fixture();
		expect(
			await f.handlers
				.get("github.pr.review")!
				.execute(
					{ number: 7, body: "Suggestion", commitId: "a".repeat(40) },
					f.context,
				),
		).toMatchObject({ providerRef: "42", data: { reviewId: "42" } });
		expect(f.client.rest.pulls.createReview).toHaveBeenCalledWith({
			owner: "acme",
			repo: "project",
			pull_number: 7,
			body: "Suggestion",
			event: "COMMENT",
			commit_id: "a".repeat(40),
			request: { signal: f.context.signal },
		});
		await expect(
			f.handlers.get("github.pr.review")!.execute(
				{
					number: 7,
					body: "Suggestion",
					commitId: "a".repeat(40),
					event: "APPROVE",
				},
				f.context,
			),
		).rejects.toThrow();
		expect(f.client.rest.pulls.createReview).toHaveBeenCalledTimes(1);
	});
	it("rejects main/default/foreign refs and empty edits before writes", async () => {
		const f = fixture();
		for (const head of ["main", "master", "foreign:feature", "not-allowed"]) {
			await expect(
				f.handlers
					.get("github.pr.create")!
					.authorize(
						{ head, base: "main", title: "x", body: "x", draft: true },
						f.context,
					),
			).rejects.toThrow();
		}
		await expect(
			f.handlers.get("github.pr.edit")!.authorize({ number: 7 }, f.context),
		).rejects.toThrow();
		expect(f.client.rest.pulls.create).not.toHaveBeenCalled();
		expect(f.client.rest.pulls.update).not.toHaveBeenCalled();
	});
	it("rejects foreign target and head drift, with zero mutation", async () => {
		const f = fixture();
		f.pr.base.repo.full_name = "foreign/repo";
		await expect(
			f.handlers
				.get("github.pr.comment")!
				.execute({ number: 7, body: "x" }, f.context),
		).rejects.toThrow();
		expect(f.client.rest.issues.createComment).not.toHaveBeenCalled();
		const g = fixture();
		g.client.rest.pulls.get
			.mockResolvedValueOnce({ data: g.pr })
			.mockResolvedValueOnce({
				data: { ...g.pr, head: { sha: "b".repeat(40) } },
			});
		await expect(
			g.handlers
				.get("github.pr.review")!
				.execute({ number: 7, body: "x", commitId: "a".repeat(40) }, g.context),
		).rejects.toThrow("github_head_changed");
		expect(g.client.rest.pulls.createReview).not.toHaveBeenCalled();
	});
	it("synchronously denies revocation after async create authorization without sending", async () => {
		const f = fixture();
		f.authorizeCreate.mockImplementation(async () => {
			queueMicrotask(() => {
				f.policy.revision = "r2";
			});
		});
		await expect(
			f.handlers.get("github.pr.create")!.execute(
				{
					head: "feature/test",
					base: "main",
					title: "x",
					body: "x",
					draft: true,
				},
				f.context,
			),
		).rejects.toThrow();
		expect(f.client.rest.pulls.create).not.toHaveBeenCalled();
		const g = fixture();
		g.assertWriteTargetCurrent.mockImplementation(() => {
			throw new Error("revoked_binding");
		});
		await expect(
			g.handlers
				.get("github.issue.comment")!
				.execute({ number: 7, body: "x" }, g.context),
		).rejects.toThrow();
		expect(g.client.rest.issues.createComment).not.toHaveBeenCalled();
	});
	it("does not retry an ambiguous mutation outcome", async () => {
		const f = fixture();
		f.client.rest.issues.createComment.mockRejectedValue(
			new Error("connection_lost"),
		);
		await expect(
			f.handlers
				.get("github.issue.comment")!
				.execute({ number: 7, body: "x" }, f.context),
		).rejects.toThrow("connection_lost");
		expect(f.client.rest.issues.createComment).toHaveBeenCalledTimes(1);
	});
});

it("rejects provider create evidence for a different head or base", async () => {
	const f = fixture();
	f.client.rest.pulls.create.mockResolvedValue({
		data: { ...f.pr, draft: true, head: { ...f.pr.head, ref: "wrong" } },
	});
	await expect(
		f.handlers.get("github.pr.create")!.execute(
			{
				head: "feature/test",
				base: "main",
				title: "x",
				body: "x",
				draft: true,
			},
			f.context,
		),
	).rejects.toThrow("github_create_evidence_mismatch");
	expect(f.client.rest.pulls.create).toHaveBeenCalledTimes(1);
});

function sdkFixture() {
	const f = fixture();
	const requests: Array<{ url: string; init: RequestInit }> = [];
	const rawDiff = "diff --git a/file b/file\n+added\n";
	const pr = { ...f.pr, base: { ...f.pr.base, sha: "b".repeat(40) } };
	const fetch = vi.fn(
		async (url: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(url), init: init ?? {} });
			const headers = new Headers(init?.headers);
			return new Response(
				headers.get("accept")?.includes("diff") ? rawDiff : JSON.stringify(pr),
				{
					status: 200,
					headers: {
						"content-type": headers.get("accept")?.includes("diff")
							? "text/plain"
							: "application/json",
					},
				},
			);
		},
	);
	const handlers = createGithubHandlers({
		client: new Octokit({ request: { fetch } }),
		policy: () => f.policy,
		authorizeTarget: f.authorizeTarget,
	});
	return { ...f, handlers, fetch, requests, rawDiff, fullPr: pr };
}
it("fetches actual Octokit PR diff media with stable head evidence", async () => {
	const f = sdkFixture();
	const handler = f.handlers.get("github.pr.diff");
	expect(handler).toBeDefined();
	const result = await handler!.execute({ number: 7 }, f.context);
	expect(result).toMatchObject({
		status: "succeeded",
		providerRef: `pr:7:${"a".repeat(40)}`,
		data: { diff: f.rawDiff, truncated: false, nextCursor: null },
	});
	expect(f.requests).toHaveLength(3);
	expect(
		f.requests.every(
			(r) => r.url === "https://api.github.com/repos/acme/project/pulls/7",
		),
	).toBe(true);
	expect(new Headers(f.requests[1]!.init.headers).get("accept")).toContain(
		"diff",
	);
});
it("pages diff content using a head/base-bound offset cursor", async () => {
	const f = sdkFixture(),
		real = f.fetch.getMockImplementation()!;
	const full = "x".repeat(262145);
	f.fetch.mockImplementation(async (url, init) =>
		new Headers(init?.headers).get("accept")?.includes("diff")
			? new Response(full, { headers: { "content-type": "text/plain" } })
			: real(url, init),
	);
	const h = f.handlers.get("github.pr.diff")!;
	const first = await h.execute({ number: 7 }, f.context);
	expect(first).toMatchObject({
		data: {
			diff: full.slice(0, 131070),
			truncated: true,
			nextCursor: `${"a".repeat(40)}:${"b".repeat(40)}:131070`,
		},
	});
	expect(
		await h.execute(
			{ number: 7, cursor: `${"a".repeat(40)}:${"b".repeat(40)}:131070` },
			f.context,
		),
	).toMatchObject({
		data: {
			diff: "x".repeat(131070),
			truncated: true,
			nextCursor: `${"a".repeat(40)}:${"b".repeat(40)}:262140`,
		},
	});
});
function workflowFixture() {
	const f = sdkFixture();
	const run = {
		id: 99,
		run_attempt: 1,
		html_url: "https://github.com/acme/project/actions/runs/99",
		repository: { full_name: "acme/project" },
		head_sha: "a".repeat(40),
		status: "completed",
		conclusion: "success",
		pull_requests: [
			{
				number: 7,
				head: { sha: "a".repeat(40) },
				base: {
					repo: {
						name: "project",
						url: "https://api.github.com/repos/acme/project",
					},
				},
			},
		],
	};
	const real = f.fetch.getMockImplementation()!;
	f.fetch.mockImplementation(async (url, init) =>
		String(url).endsWith("/actions/runs/99")
			? new Response(JSON.stringify(run), {
					headers: { "content-type": "application/json" },
				})
			: real(url, init),
	);
	return { ...f, run };
}
it("reads a repository workflow run with actual PR head evidence", async () => {
	const f = workflowFixture(),
		h = f.handlers.get("github.run.view");
	expect(h).toBeDefined();
	await h!.authorize({ runId: "99" }, f.context);
	expect(f.authorizeTarget).toHaveBeenCalledWith(
		{ kind: "workflow-run", number: 99, owner: "acme", repo: "project" },
		f.context,
	);
	expect(await h!.execute({ runId: "99" }, f.context)).toMatchObject({
		status: "succeeded",
		providerRef: `run:99:${"a".repeat(40)}`,
		data: {
			runId: "99",
			status: "completed",
			conclusion: "success",
			url: f.run.html_url,
		},
	});
	expect(f.fetch).toHaveBeenCalledWith(
		"https://api.github.com/repos/acme/project/actions/runs/99",
		expect.objectContaining({ signal: f.context.signal }),
	);
});
it.each(["https://evil.test", "-1", "9007199254740992", "01"])(
	"rejects invalid workflow ID %s before HTTP",
	async (runId) => {
		const f = workflowFixture(),
			h = f.handlers.get("github.run.view")!;
		await expect(h.authorize({ runId }, f.context)).rejects.toThrow(
			"github_invalid_run_id",
		);
		await expect(h.execute({ runId }, f.context)).rejects.toThrow(
			"github_invalid_run_id",
		);
		expect(f.fetch).not.toHaveBeenCalled();
	},
);
it("denies foreign workflow repository and mismatched linked PR head", async () => {
	const f = workflowFixture();
	f.run.repository.full_name = "foreign/repo";
	await expect(
		f.handlers.get("github.run.view")!.execute({ runId: "99" }, f.context),
	).rejects.toThrow("github_foreign_resource");
	const g = workflowFixture();
	g.fullPr.head.sha = "c".repeat(40);
	await expect(
		g.handlers.get("github.run.view")!.execute({ runId: "99" }, g.context),
	).rejects.toThrow("github_head_changed");
});
it.each(["github.run.view", "github.pr.diff"])(
	"denies %s target before HTTP and revocation after provider await",
	async (operation) => {
		const f = workflowFixture(),
			input = operation === "github.run.view" ? { runId: "99" } : { number: 7 };
		f.authorizeTarget.mockRejectedValue(new Error("denied"));
		await expect(
			f.handlers.get(operation)!.execute(input, f.context),
		).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
		const g = workflowFixture(),
			real = g.fetch.getMockImplementation()!;
		g.fetch.mockImplementation(async (url, init) => {
			const response = await real(url, init);
			g.policy.revision = "revoked";
			return response;
		});
		await expect(
			g.handlers.get(operation)!.execute(input, g.context),
		).rejects.toThrow("github_scope_denied");
		expect(g.fetch).toHaveBeenCalledTimes(1);
	},
);
it("rejects invalid/stale diff cursors and head movement without returning diff", async () => {
	const f = sdkFixture(),
		h = f.handlers.get("github.pr.diff")!;
	await expect(
		h.authorize({ number: 7, cursor: "https://evil.test" }, f.context),
	).rejects.toThrow("github_invalid_cursor");
	expect(f.fetch).not.toHaveBeenCalled();
	await expect(
		h.execute(
			{ number: 7, cursor: `${"c".repeat(40)}:${"b".repeat(40)}:131070` },
			f.context,
		),
	).rejects.toThrow("github_head_changed");
	const g = sdkFixture(),
		real = g.fetch.getMockImplementation()!;
	g.fetch.mockImplementation(async (url, init) => {
		const response = await real(url, init);
		if (new Headers(init?.headers).get("accept")?.includes("diff"))
			g.fullPr.base.sha = "c".repeat(40);
		return response;
	});
	await expect(
		g.handlers.get("github.pr.diff")!.execute({ number: 7 }, g.context),
	).rejects.toThrow("github_head_changed");
});
it.each(["github.run.view", "github.pr.diff"])(
	"does not retry %s network failures",
	async (operation) => {
		const f = sdkFixture();
		f.fetch.mockRejectedValue(new Error("network"));
		await expect(
			f.handlers
				.get(operation)!
				.execute(
					operation === "github.run.view" ? { runId: "99" } : { number: 7 },
					f.context,
				),
		).rejects.toThrow();
		expect(f.fetch).toHaveBeenCalledTimes(1);
	},
);

it("rejects workflow links naming a foreign PR repository even if the SHA matches", async () => {
	const f = workflowFixture();
	f.run.pull_requests[0]!.base.repo.url =
		"https://api.github.com/repos/foreign/project";
	await expect(
		f.handlers.get("github.run.view")!.execute({ runId: "99" }, f.context),
	).rejects.toThrow("github_foreign_resource");
	expect(f.requests).toHaveLength(0);
});

function logFixture(log = "green") {
	const f = workflowFixture(),
		real = f.fetch.getMockImplementation()!;
	const location =
		"https://productionresultssa1.blob.core.windows.net/archive.zip?sig=SIGNED_CANARY";
	f.fetch.mockImplementation(async (url, init) =>
		String(url).endsWith("/actions/runs/99/logs")
			? new Response(null, { status: 302, headers: { location } })
			: real(url, init),
	);
	const request = vi.fn(
		(_options: unknown, callback: (response: unknown) => void) =>
			Object.assign(new EventEmitter(), {
				destroy: vi.fn(),
				end: () => {
					const response = Object.assign(new PassThrough(), {
						statusCode: 200,
						headers: {},
					});
					callback(response);
					response.end(receiptZip([{ name: "job.txt", data: log }]));
				},
			}),
	);
	const handlers = createGithubHandlers({
		client: new Octokit({ request: { fetch: f.fetch } }),
		policy: () => f.policy,
		authorizeTarget: f.authorizeTarget,
		logDownload: {
			lookup: async () => [{ address: "8.8.8.8", family: 4 }],
			request: request as unknown as typeof httpsRequest,
		},
	});
	return { ...f, request, h: handlers.get("github.run.log") };
}
it("reads actual SDK manual log redirect through the bounded pinned archive reader", async () => {
	const f = logFixture(),
		{ h, request } = f;
	expect(h).toBeDefined();
	const result = await h!.execute({ runId: "99" }, f.context);
	expect(result).toMatchObject({
		status: "succeeded",
		data: { log: "--- job.txt ---\ngreen", truncated: false, nextCursor: null },
	});
	expect(f.fetch).toHaveBeenCalledWith(
		"https://api.github.com/repos/acme/project/actions/runs/99/logs",
		expect.objectContaining({ redirect: "manual", signal: f.context.signal }),
	);
	expect(JSON.stringify(result)).not.toContain("SIGNED_CANARY");
	expect(request).toHaveBeenCalledTimes(1);
});

it("pages log text with archive digest and run attempt bound cursor", async () => {
	const f = logFixture("x".repeat(262145));
	const first = await f.h!.execute({ runId: "99" }, f.context);
	expect(first).toMatchObject({
		status: "succeeded",
		data: { truncated: true },
	});
	if (first.status !== "succeeded") throw new Error("unexpected");
	const data = first.data as { log: string; nextCursor: string };
	expect(Buffer.byteLength(JSON.stringify(data.log))).toBe(131072);
	expect(data.nextCursor.endsWith(`:${data.log.length}`)).toBe(true);
	const second = await f.h!.execute(
		{ runId: "99", cursor: data.nextCursor },
		f.context,
	);
	expect(second).toMatchObject({
		data: { log: "x".repeat(131070), truncated: true },
	});
});
it("rejects log cursors before HTTP and refuses archive or attempt drift", async () => {
	const f = logFixture("x".repeat(262145));
	await expect(
		f.h!.authorize({ runId: "99", cursor: "https://evil.test" }, f.context),
	).rejects.toThrow("github_invalid_cursor");
	expect(f.fetch).not.toHaveBeenCalled();
	const first = await f.h!.execute({ runId: "99" }, f.context);
	if (first.status !== "succeeded") throw new Error("unexpected");
	const cursor = (first.data as { nextCursor: string }).nextCursor,
		parts = cursor.split(":");
	parts[3] = "0".repeat(64);
	await expect(
		f.h!.execute({ runId: "99", cursor: parts.join(":") }, f.context),
	).rejects.toThrow("github_log_changed");
	f.run.run_attempt = 2;
	const requests = f.request.mock.calls.length;
	await expect(
		f.h!.execute({ runId: "99", cursor }, f.context),
	).rejects.toThrow("github_head_changed");
	expect(f.request).toHaveBeenCalledTimes(requests);
});
it.each(["foreign", "revoked", "attempt"])(
	"fails closed after log redirect %s without claiming success",
	async (mode) => {
		const f = logFixture(),
			real = f.fetch.getMockImplementation()!;
		f.fetch.mockImplementation(async (url, init) => {
			const response = await real(url, init);
			if (String(url).endsWith("/logs")) {
				if (mode === "foreign")
					return new Response(null, {
						status: 302,
						headers: { location: "https://evil.test/?sig=CANARY" },
					});
				if (mode === "revoked") f.policy.revision = "revoked";
				else f.run.run_attempt = 2;
			}
			return response;
		});
		await expect(f.h!.execute({ runId: "99" }, f.context)).rejects.toThrow(
			mode === "attempt" ? "github_head_changed" : "github_log_unavailable",
		);
		expect(f.request).toHaveBeenCalledTimes(mode === "attempt" ? 1 : 0);
	},
);
it("does not download unfinished workflow logs", async () => {
	const f = logFixture();
	f.run.status = "in_progress";
	await expect(f.h!.execute({ runId: "99" }, f.context)).rejects.toThrow(
		"github_run_log_pending",
	);
	expect(f.request).not.toHaveBeenCalled();
});

it.each(
	["github.pr.diff", "github.run.log"].flatMap((operation) =>
		["x".repeat(300000), '😀\u0000\n"\\é'.repeat(40000)].map((content) => [
			operation,
			content,
		]),
	),
)(
	"returns complete encoded text pages through the real broker: %s",
	async (operationId, content) => {
		const f =
			operationId === "github.run.log" ? logFixture(content) : sdkFixture();
		if (operationId === "github.pr.diff") {
			const real = f.fetch.getMockImplementation()!;
			f.fetch.mockImplementation(async (url, init) =>
				new Headers(init?.headers).get("accept")?.includes("diff")
					? new Response(content, { headers: { "content-type": "text/plain" } })
					: real(url, init),
			);
		}
		const handler = "h" in f ? f.h! : f.handlers.get(operationId)!;
		const store = new SqliteJournalStore(":memory:");
		const broker = new LeadCapabilityBroker({
			projectName: "flywheel",
			leadId: "product",
			activationId: "a1",
			receipts: store.operationReceipts,
			allowedOperationIds: () => new Set([operationId]),
			assertCurrent: async () => {},
			handlers: new Map([[operationId, handler]]),
			secrets: [],
		});
		try {
			let cursor: string | null = null,
				collected = "",
				pages = 0;
			do {
				const result = await broker.execute({
					schemaVersion: 1,
					operationId,
					requestId: randomUUID(),
					input: {
						...(operationId === "github.pr.diff"
							? { number: 7 }
							: { runId: "99" }),
						...(cursor ? { cursor } : {}),
					},
				});
				expect(result.status).toBe("succeeded");
				expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
					262144,
				);
				const data = result.data as {
					diff?: string;
					log?: string;
					nextCursor: string | null;
				};
				const page = (data.diff ?? data.log)!;
				expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
					131072,
				);
				expect(
					page.charCodeAt(page.length - 1) >= 0xd800 &&
						page.charCodeAt(page.length - 1) <= 0xdbff,
				).toBe(false);
				expect(
					page.charCodeAt(0) >= 0xdc00 && page.charCodeAt(0) <= 0xdfff,
				).toBe(false);
				collected += page;
				cursor = data.nextCursor;
				expect(++pages).toBeLessThan(20);
			} while (cursor);
			expect(pages).toBeGreaterThan(1);
			expect(collected).toBe(
				operationId === "github.run.log"
					? `--- job.txt ---\n${content}`
					: content,
			);
		} finally {
			store.close();
		}
	},
);

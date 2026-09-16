import { expect, it } from "vitest";
import { CustomerReleaseGitHub } from "../customer-release/github.js";

const binding = {
	repository: "owner/repo",
	repositoryId: 11,
	workflowId: 22,
	workflowPath: ".github/workflows/payload-promote.yml",
	reviewedSha: "a".repeat(40),
};
const request = {
	dispatchId: "b".repeat(64),
	createdAt: Date.parse("2026-09-15T15:00:00Z"),
	inputs: { mode: "prepare", "release-id": "release-1", beta: "1.2.3-beta.1" },
};
function fixture() {
	const calls: { path: string; body?: any }[] = [];
	const run: any = {
		id: 33,
		repository: { id: 11 },
		workflow_id: 22,
		event: "workflow_dispatch",
		head_branch: "main",
		head_sha: binding.reviewedSha,
		display_title: `customer-release:${request.dispatchId}:prepare:release-1`,
		status: "completed",
		conclusion: "success",
		run_attempt: 1,
		created_at: new Date(request.createdAt).toISOString(),
	};
	const responses = new Map<string, unknown>([
		[
			"/repos/owner/repo",
			{ id: 11, full_name: "owner/repo", default_branch: "main" },
		],
		[
			"/repos/owner/repo/actions/workflows/22",
			{ id: 22, path: binding.workflowPath, state: "active" },
		],
		["/repos/owner/repo/commits/main", { sha: binding.reviewedSha }],
		["/repos/owner/repo/actions/runs/33", run],
	]);
	let lost = false;
	const client = new CustomerReleaseGitHub({
		token: "fixture-token",
		fetch: (async (url: string | URL | Request, init?: RequestInit) => {
			const u = new URL(String(url));
			expect(u.origin).toBe("https://api.github.com");
			expect(init?.redirect).toBe("error");
			calls.push({
				path: u.pathname,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			if (init?.method === "POST") {
				if (lost) throw new Error("lost");
				return Response.json({
					workflow_run_id: 33,
					run_url: "https://api.github.com/repos/owner/repo/actions/runs/33",
					html_url: "https://github.com/owner/repo/actions/runs/33",
				});
			}
			if (u.pathname.endsWith("/runs"))
				return Response.json({ total_count: 1, workflow_runs: [run] });
			const value = responses.get(u.pathname);
			return value === undefined
				? new Response(null, { status: 404 })
				: Response.json(value);
		}) as typeof fetch,
	});
	return {
		client,
		calls,
		run,
		responses,
		lose: () => {
			lost = true;
		},
	};
}
it("checks numeric repository/workflow and reviewed main before one dispatch", async () => {
	const f = fixture();
	expect(await f.client.dispatch(binding, request)).toBe(33);
	const post = f.calls.find((c) => c.body);
	expect(post?.body).toEqual({
		ref: "main",
		inputs: { ...request.inputs, "dispatch-id": request.dispatchId },
	});
	expect(await f.client.observe(binding, request)).toMatchObject({
		runId: 33,
		state: "succeeded",
	});
});
it.each(["repo", "workflow", "main", "run_sha", "rerun"])(
	"identity drift %s cannot supply successful preparation evidence",
	async (fault) => {
		const f = fixture();
		if (fault === "repo")
			f.responses.set("/repos/owner/repo", {
				id: 12,
				full_name: "owner/repo",
				default_branch: "main",
			});
		if (fault === "workflow")
			f.responses.set("/repos/owner/repo/actions/workflows/22", {
				id: 22,
				path: ".github/workflows/other.yml",
				state: "active",
			});
		if (fault === "main")
			f.responses.set("/repos/owner/repo/commits/main", {
				sha: "c".repeat(40),
			});
		if (fault === "run_sha") f.run.head_sha = "c".repeat(40);
		if (fault === "rerun") f.run.run_attempt = 2;
		await expect(
			fault === "run_sha" || fault === "rerun"
				? f.client.observe(binding, request)
				: f.client.dispatch(binding, request),
		).rejects.toThrow();
	},
);
it("lost dispatch reply is recovered by its unique run title without another POST", async () => {
	const f = fixture();
	f.lose();
	await expect(f.client.dispatch(binding, request)).rejects.toThrow();
	expect(await f.client.observe(binding, request)).toMatchObject({
		runId: 33,
		state: "succeeded",
	});
	expect(f.calls.filter((c) => c.body)).toHaveLength(1);
});

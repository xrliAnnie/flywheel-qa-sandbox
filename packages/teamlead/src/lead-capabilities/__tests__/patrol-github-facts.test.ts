import type { Octokit } from "@octokit/rest";
import { expect, it, vi } from "vitest";
import type { LeadOperationContext } from "../broker.js";
import { prefetchPatrolGithubFacts } from "../patrol-github-facts.js";

const state = vi.hoisted(() => ({ repo: "owner/repo" }));
vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({
		assertActivationCurrent: () => ({
			project: { projectName: "demo", projectRepo: state.repo },
			lead: { agentId: "eng" },
		}),
	}),
}));
const context = (): LeadOperationContext => ({
	projectName: "demo",
	leadId: "eng",
	activationId: "a1",
	requestId: "request",
	signal: new AbortController().signal,
	assertCurrent: async () => {},
});
const env = { FLYWHEEL_PROJECT_NAME: "demo", FLYWHEEL_LEAD_ID: "eng" };
it("prefetches only fixed bounded reads and strips SDK payloads before helper input", async () => {
	const request = vi.fn(async (route: string) => ({
		data: route.includes("pulls")
			? [
					{
						number: 1,
						draft: false,
						head: { sha: "a".repeat(40), token: "secret" },
						updated_at: "2026-09-14T00:00:00Z",
						body: "private",
					},
				]
			: {
					workflow_runs: [
						{
							id: 2,
							status: "completed",
							created_at: "2026-09-14T00:00:00Z",
							actor: "private",
						},
					],
				},
	}));
	const result = await prefetchPatrolGithubFacts(
		{ env, activationId: "a1", client: { request } as unknown as Octokit },
		context(),
	);
	expect(JSON.stringify(result)).not.toMatch(/private|secret|actor|token/);
	expect(request.mock.calls.map((call) => call[0])).toEqual([
		"GET /repos/{owner}/{repo}/pulls",
		"GET /repos/{owner}/{repo}/actions/runs",
	]);
	expect(request).toHaveBeenNthCalledWith(
		1,
		expect.any(String),
		expect.objectContaining({
			owner: "owner",
			repo: "repo",
			state: "open",
			per_page: 50,
		}),
	);
	expect(request).toHaveBeenNthCalledWith(
		2,
		expect.any(String),
		expect.objectContaining({ owner: "owner", repo: "repo", per_page: 5 }),
	);
});
it("stops on current repository changes or foreign operation context", async () => {
	const request = vi.fn(async () => {
		state.repo = "owner/changed";
		return { data: [] };
	});
	try {
		await expect(
			prefetchPatrolGithubFacts(
				{ env, activationId: "a1", client: { request } as unknown as Octokit },
				context(),
			),
		).rejects.toThrow();
		expect(request).toHaveBeenCalledTimes(1);
		request.mockClear();
		await expect(
			prefetchPatrolGithubFacts(
				{ env, activationId: "a1", client: { request } as unknown as Octokit },
				{ ...context(), leadId: "other" },
			),
		).rejects.toThrow();
		expect(request).not.toHaveBeenCalled();
	} finally {
		state.repo = "owner/repo";
	}
});

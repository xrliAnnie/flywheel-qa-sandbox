import { randomUUID } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import { expect, it, vi } from "vitest";
import { createGithubReadProviderHandlers } from "../handlers/github-provider.js";

const state = vi.hoisted(() => ({ repo: "owner/repo", valid: true }));
vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({
		assertActivationCurrent: () => {
			if (!state.valid) throw new Error("stale");
			return { project: { projectRepo: state.repo }, lead: { agentId: "eng" } };
		},
	}),
}));
it("allows canonical repository reads without inventing a PR department grant", async () => {
	const pr = {
		number: 7,
		html_url: "https://github.com/owner/repo/pull/7",
		title: "PR",
		draft: false,
		head: { sha: "a".repeat(40) },
		base: { ref: "main", repo: { full_name: "owner/repo" } },
	};
	const get = vi.fn(async () => ({ data: pr }));
	const handlers = createGithubReadProviderHandlers({
		env: { FLYWHEEL_PROJECT_NAME: "demo", FLYWHEEL_LEAD_ID: "eng" },
		activationId: "a1",
		client: { rest: { pulls: { get } } } as unknown as Octokit,
	});
	const context = {
		projectName: "demo",
		leadId: "eng",
		activationId: "a1",
		requestId: randomUUID(),
		signal: AbortSignal.timeout(15000),
		assertCurrent: async () => {},
	};
	expect(handlers.has("github.pr.ready")).toBe(false);
	expect(
		(await handlers.get("github.pr.view")!.execute({ number: 7 }, context))
			.status,
	).toBe("succeeded");
	state.valid = false;
	await expect(
		handlers.get("github.pr.view")!.execute({ number: 7 }, context),
	).rejects.toThrow();
	state.valid = true;
	get.mockImplementationOnce(async () => {
		state.repo = "foreign/repo";
		return { data: pr };
	});
	await expect(
		handlers.get("github.pr.view")!.execute({ number: 7 }, context),
	).rejects.toThrow();
	state.repo = "owner/repo";
});

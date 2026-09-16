import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { CommDB } from "flywheel-comm/db";
import { expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createLeadGithubBoundHandlers } from "../lead-github-handlers.js";

it("performs ready/rerun only with actual existing PR owner evidence and exact run linkage", async () => {
	const root = mkdtempSync(join(tmpdir(), "github-bound-")),
		store = await StateStore.create(":memory:"),
		comm = new CommDB(join(root, "comm.db"));
	const pr = {
		number: 7,
		node_id: "PR_node",
		state: "open",
		html_url: "https://github.com/acme/project/pull/7",
		title: "Title",
		draft: true,
		head: { sha: "a".repeat(40), ref: "feature-owned" },
		base: { ref: "main", repo: { full_name: "acme/project" } },
	};
	let linked = true,
		labels = ["wrong"];
	const client = {
		graphql: vi.fn(async () => ({
			markPullRequestReadyForReview: {
				pullRequest: { id: "PR_node", number: 7, isDraft: false },
			},
		})),
		rest: {
			issues: { update: vi.fn(async () => ({ data: { labels } })) },
			pulls: { get: vi.fn(async () => ({ data: pr })) },
			actions: {
				getWorkflowRun: vi.fn(async () => ({
					data: {
						id: 99,
						status: "completed",
						repository: { full_name: "acme/project" },
						head_sha: pr.head.sha,
						html_url: "https://github.com/acme/project/actions/runs/99",
						pull_requests: linked
							? [
									{
										number: 7,
										head: { sha: pr.head.sha },
										base: {
											repo: {
												name: "project",
												url: "https://api.github.com/repos/acme/project",
											},
										},
									},
								]
							: [],
					},
				})),
				reRunWorkflow: vi.fn(async () => ({ status: 201 })),
			},
		},
	};
	const context = {
		projectName: "demo",
		leadId: "eng",
		activationId: "a1",
		requestId: randomUUID(),
		signal: AbortSignal.timeout(15000),
		assertCurrent: async () => {},
	};
	const handlers = createLeadGithubBoundHandlers({
		store,
		comm,
		client: client as unknown as Octokit,
		projectName: "demo",
		leadId: "eng",
		activationId: "a1",
		repository: () => "acme/project",
		assertCurrent: () => {},
	});
	try {
		const ready = handlers.get("github.pr.ready")!,
			rerun = handlers.get("github.run.rerun")!;
		await expect(ready.execute({ number: 7 }, context)).rejects.toThrow(
			"pr_not_bound_to_lead",
		);
		expect(client.graphql).not.toHaveBeenCalled();
		store.upsertSession({
			execution_id: "exec",
			issue_id: "ISSUE",
			project_name: "demo",
			status: "running",
			pr_number: 7,
			branch: "feature-owned",
		});
		comm.registerSession("exec", "runner:0", "demo", "ISSUE", "eng");
		pr.head.ref = "foreign-feature";
		await expect(ready.execute({ number: 7 }, context)).rejects.toThrow(
			"pr_not_bound_to_lead",
		);
		expect(client.graphql).not.toHaveBeenCalled();
		pr.head.ref = "feature-owned";

		expect((await ready.execute({ number: 7 }, context)).status).toBe(
			"succeeded",
		);
		expect(
			(await rerun.execute({ number: 7, runId: "99" }, context)).status,
		).toBe("succeeded");
		expect(client.rest.actions.reRunWorkflow).toHaveBeenCalledOnce();
		const edit = handlers.get("github.pr.edit")!;
		await expect(
			edit.execute({ number: 7, labels: ["ready"] }, context),
		).rejects.toThrow("github_labels_evidence_mismatch");
		labels = ["ready"];
		expect(
			(await edit.execute({ number: 7, labels: ["ready"] }, context)).status,
		).toBe("succeeded");

		linked = false;
		await expect(
			rerun.execute({ number: 7, runId: "99" }, context),
		).rejects.toThrow();
		expect(client.rest.actions.reRunWorkflow).toHaveBeenCalledOnce();
		expect(handlers.has("github.pr.create")).toBe(false);
	} finally {
		comm.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

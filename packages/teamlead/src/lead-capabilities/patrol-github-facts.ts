import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import type { LeadOperationContext } from "./broker.js";
import { createLeadCapabilityContext } from "./runtime-context.js";

const date = z.string().datetime();
const pull = z.object({
	number: z.number().int().positive().safe(),
	draft: z.boolean(),
	head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
	updated_at: date,
});
const run = z.object({
	id: z.number().int().positive().safe(),
	status: z.string().regex(/^[a-z_]{1,32}$/),
	created_at: date,
});
const denied = () => new Error("patrol_github_scope_denied");
/** Parent-only fixed reads matching the existing snapshot helper's bounded pages.
 * SDK credentials never enter the returned file projection or a child environment. */
export async function prefetchPatrolGithubFacts(
	options: {
		env: NodeJS.ProcessEnv;
		activationId: string;
		client: Octokit;
	},
	context: LeadOperationContext,
) {
	const env = Object.freeze({ ...options.env });
	const trusted = createLeadCapabilityContext(env);
	const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15000)]);
	function current() {
		signal.throwIfAborted();
		if (
			context.projectName !== env.FLYWHEEL_PROJECT_NAME ||
			context.leadId !== env.FLYWHEEL_LEAD_ID ||
			context.activationId !== options.activationId
		)
			throw denied();
		const row = trusted.assertActivationCurrent();
		const slug = row.project.projectRepo;
		if (
			typeof slug !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(
				slug,
			)
		)
			throw denied();
		return { slug, revision: JSON.stringify([row.project, row.lead]) };
	}
	await context.assertCurrent();
	const initial = current();
	const [owner, repo] = initial.slug.split("/") as [string, string];
	async function fresh() {
		await context.assertCurrent();
		if (current().revision !== initial.revision) throw denied();
	}
	const prs = await options.client.request("GET /repos/{owner}/{repo}/pulls", {
		owner,
		repo,
		state: "open",
		per_page: 50,
		request: { signal },
	});
	await fresh();
	const pulls = z.array(pull).max(50).parse(prs.data);
	const runs = await options.client.request(
		"GET /repos/{owner}/{repo}/actions/runs",
		{ owner, repo, per_page: 5, request: { signal } },
	);
	await fresh();
	return {
		projectName: context.projectName,
		leadId: context.leadId,
		pulls,
		runs: z.object({ workflow_runs: z.array(run).max(5) }).parse(runs.data),
	};
}

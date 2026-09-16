import type { Octokit } from "@octokit/rest";
import type { LeadOperationContext, LeadOperationHandler } from "../broker.js";
import { getLeadCapability } from "../catalog.js";
import { createLeadCapabilityContext } from "../runtime-context.js";
import { createGithubHandlers } from "./github.js";

/** A reads use current canonical repository authority, without a per-PR grant. */
export function createGithubReadProviderHandlers(options: {
	env: NodeJS.ProcessEnv;
	activationId: string;
	client: Octokit;
}): ReadonlyMap<string, LeadOperationHandler> {
	const env = Object.freeze({ ...options.env });
	const trusted = createLeadCapabilityContext(env);
	function current(context?: LeadOperationContext) {
		if (context) {
			context.signal.throwIfAborted();
			if (
				context.projectName !== env.FLYWHEEL_PROJECT_NAME ||
				context.leadId !== env.FLYWHEEL_LEAD_ID ||
				context.activationId !== options.activationId
			)
				throw new Error("github_scope_denied");
		}
		const row = trusted.assertActivationCurrent();
		const repository = row.project.projectRepo;
		if (
			typeof repository !== "string" ||
			!/^[-a-zA-Z0-9_.]{1,100}\/[-a-zA-Z0-9_.]{1,100}$/.test(repository)
		)
			throw new Error("github_scope_denied");
		const [owner, repo] = repository.split("/");
		if (!owner || !repo) throw new Error("github_scope_denied");
		return {
			projectName: env.FLYWHEEL_PROJECT_NAME!,
			leadId: env.FLYWHEEL_LEAD_ID!,
			owner,
			repo,
			revision: JSON.stringify([row.project, row.lead]),
		};
	}
	return new Map(
		[
			...createGithubHandlers({
				client: options.client,
				policy: () => current(),
				authorizeTarget: async (target, context) => {
					await context.assertCurrent();
					const policy = current(context);
					if (
						target.owner !== policy.owner ||
						target.repo !== policy.repo ||
						!Number.isSafeInteger(target.number) ||
						target.number <= 0
					)
						throw new Error("github_scope_denied");
				},
			}),
		].filter(([id]) => getLeadCapability(id)?.githubTier === "A"),
	);
}

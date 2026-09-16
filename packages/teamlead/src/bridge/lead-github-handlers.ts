import type { Octokit } from "@octokit/rest";
import type { CommDB } from "flywheel-comm/db";
import type { LeadOperationContext } from "../lead-capabilities/broker.js";
import { getLeadCapability } from "../lead-capabilities/catalog.js";
import { createGithubHandlers } from "../lead-capabilities/handlers/github.js";
import type { StateStore } from "../StateStore.js";
import { assertLeadGithubPrBinding } from "./lead-github-binding.js";
/** Bridge owns the live binding and performs B effects here, never returning a cached grant to a parent. */
export function createLeadGithubBoundHandlers(options: {
	store: StateStore;
	comm: CommDB;
	client: Octokit;
	projectName: string;
	leadId: string;
	activationId: string;
	repository(): string;
	assertCurrent(): void;
}) {
	const current = (context?: LeadOperationContext) => {
		options.assertCurrent();
		if (
			context &&
			(context.projectName !== options.projectName ||
				context.leadId !== options.leadId ||
				context.activationId !== options.activationId ||
				context.signal.aborted)
		)
			throw new Error("github_scope_denied");
		const slug = options.repository();
		if (
			!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(
				slug,
			)
		)
			throw new Error("github_scope_denied");
		const [owner, repo] = slug.split("/") as [string, string];
		return {
			owner,
			repo,
			projectName: options.projectName,
			leadId: options.leadId,
			revision: slug,
		};
	};
	const bind = (
		number: number,
		context: LeadOperationContext,
		headRef?: string,
	) => {
		current(context);
		return assertLeadGithubPrBinding({
			...options,
			prNumber: number,
			...(headRef !== undefined ? { headRef } : {}),
			assertCurrent: () => {
				current(context);
			},
		});
	};
	const handlers = createGithubHandlers({
		client: options.client,
		policy: () => current(),
		authorizeTarget: async (target, context) => {
			const p = current(context);
			if (target.owner !== p.owner || target.repo !== p.repo)
				throw new Error("github_scope_denied");
			if (target.kind === "pull-request") bind(target.number, context);
			else if (target.kind !== "workflow-run")
				throw new Error("github_scope_denied");
		},
		assertWriteTargetCurrent: (target, context) => {
			const p = current(context);
			if (
				target.owner !== p.owner ||
				target.repo !== p.repo ||
				target.kind !== "pull-request"
			)
				throw new Error("github_scope_denied");
			if (!target.headRef) throw new Error("pr_not_bound_to_lead");
			bind(target.number, context, target.headRef);
		},
	});
	return new Map(
		[...handlers]
			.filter(([id]) => getLeadCapability(id)?.githubTier === "B")
			.map(([id, handler]) => [
				id,
				{
					...handler,
					execute: async (
						raw: Record<string, unknown>,
						context: LeadOperationContext,
					) => {
						const result = await handler.execute(raw, context);
						return result.status === "succeeded" &&
							result.data &&
							typeof result.data === "object"
							? {
									...result,
									data: { ...result.data, receiptId: context.requestId },
								}
							: result;
					},
				},
			]),
	);
}

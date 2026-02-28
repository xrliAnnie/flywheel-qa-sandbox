import type { DagNode } from "flywheel-dag-resolver";

/** Pre-hydrated context for an issue — assembled deterministically, zero token cost */
export interface HydratedContext {
	issueTitle: string;
	issueDescription: string;
	linkedPRs: string[];
	relatedFiles: string[];
	projectRules: string;
	recentDecisions: string[];
}

/** Function to fetch a Linear issue by ID */
export type FetchIssueFn = (
	issueId: string,
) => Promise<{ title: string; description: string | null }>;

/** Function to read project rules (CLAUDE.md, .flywheel/ config) */
export type ReadRulesFn = (projectRoot: string) => Promise<string>;

/**
 * Pre-Hydrator: deterministically assembles context for an issue.
 * Zero token cost — all data fetched via APIs and filesystem.
 */
export class PreHydrator {
	constructor(
		private fetchIssue: FetchIssueFn,
		private readRules: ReadRulesFn,
		private projectRoot: string,
	) {}

	async hydrate(node: DagNode): Promise<HydratedContext> {
		const issue = await this.fetchIssue(node.id);
		const rules = await this.readRules(this.projectRoot);

		return {
			issueTitle: issue.title,
			issueDescription: issue.description ?? "",
			linkedPRs: [],
			relatedFiles: [],
			projectRules: rules,
			recentDecisions: [],
		};
	}
}

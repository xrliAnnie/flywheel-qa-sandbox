import type { DagNode } from "flywheel-dag-resolver";

/** Hydrated context — issue data from Linear */
export interface HydratedContext {
	issueId: string;
	issueTitle: string;
	issueDescription: string;
	labels: string[];
	projectId: string;
	issueIdentifier: string;
}

/** Function to fetch a Linear issue by ID */
export type FetchIssueFn = (
	issueId: string,
) => Promise<{
	title: string;
	description: string | null;
	labels?: string[];
	projectId?: string;
	identifier?: string;
}>;

/**
 * Pre-Hydrator: fetches issue metadata from Linear.
 *
 * v0.1.1: Minimal — only fetches title + description.
 * Claude Code reads CLAUDE.md and project files on its own.
 */
export class PreHydrator {
	constructor(private fetchIssue: FetchIssueFn) {}

	async hydrate(node: DagNode): Promise<HydratedContext> {
		const issue = await this.fetchIssue(node.id);

		return {
			issueId: node.id,
			issueTitle: issue.title,
			issueDescription: issue.description ?? "",
			labels: issue.labels ?? [],
			projectId: issue.projectId ?? "",
			issueIdentifier: issue.identifier ?? node.id,
		};
	}
}

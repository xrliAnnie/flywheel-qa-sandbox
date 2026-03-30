/**
 * GEO-294: Shared Linear issue query — extracted from plugin.ts /api/linear/issues handler.
 * Used by both the REST endpoint and TriageService.
 */

/** Typed error for Linear API failures — enables reliable upstream error classification. */
export class LinearUpstreamError extends Error {
	constructor(
		message: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "LinearUpstreamError";
	}
}

export interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	priority: number;
	priorityLabel: string;
	state: string;
	stateType: string;
	labels: string[];
	assignee: string | null;
	url: string;
	createdAt: string;
	updatedAt: string;
}

export interface LinearQueryFilters {
	project?: string;
	states?: string[];
	labels?: string[];
	limit?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Query Linear issues via GraphQL with optional filters.
 * Returns mapped issues and whether results were truncated.
 */
export async function queryLinearIssues(
	linearApiKey: string,
	filters: LinearQueryFilters,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ issues: LinearIssue[]; truncated: boolean }> {
	const limit = filters.limit ?? 50;

	// Build GraphQL filter
	const filter: Record<string, unknown> = {};
	if (filters.project) {
		filter.project = { name: { eq: filters.project } };
	}
	if (filters.states && filters.states.length > 0) {
		if (filters.states.length === 1) {
			filter.state = { type: { eq: filters.states[0] } };
		} else {
			filter.state = { type: { in: filters.states } };
		}
	}
	if (filters.labels && filters.labels.length > 0) {
		if (filters.labels.length === 1) {
			filter.labels = { name: { eq: filters.labels[0] } };
		} else {
			filter.or = filters.labels.map((name) => ({
				labels: { name: { eq: name } },
			}));
		}
	}

	const query = `
		query ListIssues($filter: IssueFilter, $first: Int) {
			issues(filter: $filter, first: $first, orderBy: updatedAt) {
				nodes {
					id
					identifier
					title
					description
					priority
					priorityLabel
					url
					createdAt
					updatedAt
					state { name type }
					labels { nodes { name } }
					assignee { name }
				}
				pageInfo { hasNextPage endCursor }
			}
		}
	`;

	let result: { data?: unknown };
	try {
		const { LinearClient } = await import("@linear/sdk");
		const client = new LinearClient({ apiKey: linearApiKey });

		// Linear SDK's rawRequest does not accept AbortSignal,
		// so we use Promise.race for timeout enforcement.
		const resultPromise = client.client.rawRequest(query, {
			filter,
			first: limit,
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("Linear API timeout")),
				timeoutMs,
			);
		});
		result = await Promise.race([resultPromise, timeoutPromise]).finally(() =>
			clearTimeout(timer),
		);
	} catch (err) {
		throw new LinearUpstreamError(
			(err as Error).message ?? "Linear API request failed",
			err,
		);
	}

	const data = result.data as {
		issues: {
			nodes: Array<{
				id: string;
				identifier: string;
				title: string;
				description: string | null;
				priority: number;
				priorityLabel: string;
				url: string;
				createdAt: string;
				updatedAt: string;
				state: { name: string; type: string };
				labels: { nodes: Array<{ name: string }> };
				assignee: { name: string } | null;
			}>;
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
		};
	};

	const nodes = data.issues.nodes;
	const issues: LinearIssue[] = nodes.map((n) => ({
		id: n.id,
		identifier: n.identifier,
		title: n.title,
		description: n.description,
		priority: n.priority,
		priorityLabel: n.priorityLabel,
		state: n.state.name,
		stateType: n.state.type,
		labels: n.labels.nodes.map((l) => l.name),
		assignee: n.assignee?.name ?? null,
		url: n.url,
		createdAt: n.createdAt,
		updatedAt: n.updatedAt,
	}));

	return {
		issues,
		truncated: data.issues.pageInfo.hasNextPage,
	};
}

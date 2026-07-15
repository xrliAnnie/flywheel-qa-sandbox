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
	/** Linear project name (null when the issue has none). */
	project: string | null;
	url: string;
	createdAt: string;
	updatedAt: string;
}

export interface LinearQueryFilters {
	project?: string;
	states?: string[];
	labels?: string[];
	limit?: number;
	/** When true, omit `description` from GraphQL response to reduce payload. */
	slim?: boolean;
	/** FLY-967: keyword lookup — case-insensitive title substring match. */
	titleContains?: string;
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
	const slim = filters.slim ?? false;

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
	if (filters.titleContains) {
		filter.title = { containsIgnoreCase: filters.titleContains };
	}

	// Slim mode omits `description` to reduce payload (~60-80% smaller)
	const descriptionField = slim ? "" : "description";
	const query = `
		query ListIssues($filter: IssueFilter, $first: Int) {
			issues(filter: $filter, first: $first, orderBy: updatedAt) {
				nodes {
					id
					identifier
					title
					${descriptionField}
					priority
					priorityLabel
					url
					createdAt
					updatedAt
					state { name type }
					labels { nodes { name } }
					assignee { name }
					project { name }
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
			nodes: LinearIssueNode[];
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
		};
	};

	const issues: LinearIssue[] = data.issues.nodes.map((n) =>
		mapIssueNode(n, slim),
	);

	return {
		issues,
		truncated: data.issues.pageInfo.hasNextPage,
	};
}

type LinearIssueNode = {
	id: string;
	identifier: string;
	title: string;
	description?: string | null;
	priority: number;
	priorityLabel: string;
	url: string;
	createdAt: string;
	updatedAt: string;
	state: { name: string; type: string };
	labels: { nodes: Array<{ name: string }> };
	assignee: { name: string } | null;
	project?: { name: string } | null;
};

function mapIssueNode(n: LinearIssueNode, slim: boolean): LinearIssue {
	return {
		id: n.id,
		identifier: n.identifier,
		title: n.title,
		description: slim ? null : (n.description ?? null),
		priority: n.priority,
		priorityLabel: n.priorityLabel,
		state: n.state.name,
		stateType: n.state.type,
		labels: n.labels.nodes.map((l) => l.name),
		assignee: n.assignee?.name ?? null,
		project: n.project?.name ?? null,
		url: n.url,
		createdAt: n.createdAt,
		updatedAt: n.updatedAt,
	};
}

/**
 * FLY-967 (545 P12 contract): exact single-issue lookup by identifier
 * (e.g. "FLY-123"). Returns null when the identifier does not resolve —
 * Linear answers an unknown identifier with an "entity not found" error,
 * which is a miss, not an upstream failure.
 */
export async function lookupLinearIssueByIdentifier(
	linearApiKey: string,
	identifier: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<LinearIssue | null> {
	const query = `
		query IssueByIdentifier($id: String!) {
			issue(id: $id) {
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
				project { name }
			}
		}
	`;
	let result: { data?: unknown };
	try {
		const { LinearClient } = await import("@linear/sdk");
		const client = new LinearClient({ apiKey: linearApiKey });
		const resultPromise = client.client.rawRequest(query, { id: identifier });
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
		const msg = (err as Error).message ?? "";
		if (/entity not found|could not be found/i.test(msg)) return null;
		throw new LinearUpstreamError(msg || "Linear API request failed", err);
	}
	const node = (result.data as { issue: LinearIssueNode | null }).issue;
	return node ? mapIssueNode(node, false) : null;
}

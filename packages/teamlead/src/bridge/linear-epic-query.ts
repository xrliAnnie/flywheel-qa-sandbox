import type { LinearDocument } from "@linear/sdk";
import { extractAcceptance } from "../epic-page/rules.js";
import type { ProjectLinearBinding } from "../ProjectConfig.js";
import { LinearUpstreamError } from "./linear-query.js";

export class EpicTooLargeError extends Error {
	constructor(message = "Active scope exceeds the configured page bound") {
		super(message);
		this.name = "EpicTooLargeError";
	}
}

export class EpicSnapshotTruncatedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EpicSnapshotTruncatedError";
	}
}

export class ActiveScopeNotFoundError extends Error {
	constructor(message = "No active Linear parent declarations were found") {
		super(message);
		this.name = "ActiveScopeNotFoundError";
	}
}

export interface LinearActiveScopeSnapshot {
	fetchedAt: string;
	boundary: {
		teamKey: string;
		project: string | null;
		label: string | null;
	};
	roots: Array<{
		id: string;
		identifier: string;
		title: string;
		url: string;
		updatedAt: string;
		state: { name: string; type: string };
	}>;
	items: Array<{
		id: string;
		identifier: string;
		title: string;
		url: string;
		priority: number;
		updatedAt: string;
		state: { name: string; type: string };
		labels: string[];
		blockedBy: Array<{
			id: string;
			identifier: string;
			title: string;
			url: string;
			stateType: string;
			inScope: boolean;
		}>;
		acceptance: { text: string; truncated: boolean } | null;
	}>;
}

export interface FetchLinearActiveScopeSnapshotOptions {
	deadlineMs?: number;
	maxRootPages?: number;
	maxChildPages?: number;
	maxNestedPages?: number;
	maxItems?: number;
	now?: () => Date;
}

interface PageInfo {
	hasNextPage: boolean;
	endCursor?: string | null;
}

interface LinearScopeRelationNode {
	type: string;
	issue: {
		id: string;
		identifier: string;
		title: string;
		url: string;
		state: { type: string };
	};
}

interface LinearScopeIssueNode {
	id: string;
	identifier: string;
	title: string;
	description?: string | null;
	url: string;
	priority: number;
	updatedAt: string;
	state: { name: string; type: string };
	labels: { nodes: Array<{ name: string }>; pageInfo: PageInfo };
	inverseRelations: {
		nodes: LinearScopeRelationNode[];
		pageInfo: PageInfo;
	};
	children?: { nodes: Array<{ id: string }>; pageInfo: PageInfo };
}

interface LinearScopeRootNode {
	id: string;
	identifier: string;
	title: string;
	url: string;
	updatedAt: string;
	state: { name: string; type: string };
	labels: { nodes: Array<{ name: string }>; pageInfo: PageInfo };
}

interface ActiveScopeRootsResponse {
	data?: {
		issues: { nodes: LinearScopeRootNode[]; pageInfo: PageInfo };
	};
}

interface ActiveScopeChildrenResponse {
	data?: {
		issue: {
			children: { nodes: LinearScopeIssueNode[]; pageInfo: PageInfo };
		} | null;
	};
}

const ACTIVE_SCOPE_ROOTS_QUERY = `
	query ActiveScopeRoots($filter: IssueFilter!, $after: String) {
		issues(filter: $filter, first: 50, after: $after, includeArchived: false) {
			nodes {
				id identifier title url updatedAt
				state { name type }
				labels(first: 50) { nodes { name } pageInfo { hasNextPage } }
			}
			pageInfo { hasNextPage endCursor }
		}
	}
`;

const ACTIVE_SCOPE_CHILDREN_QUERY = `
	query ActiveScopeChildren($id: String!, $after: String) {
		issue(id: $id) {
			children(first: 50, after: $after, includeArchived: false) {
				nodes {
					id identifier title description url priority updatedAt
					state { name type }
					labels(first: 50) { nodes { name } pageInfo { hasNextPage } }
					inverseRelations(first: 25) {
						nodes { type issue { id identifier title url state { type } } }
						pageInfo { hasNextPage endCursor }
					}
					children(first: 1, includeArchived: false) {
						nodes { id }
						pageInfo { hasNextPage endCursor }
					}
				}
				pageInfo { hasNextPage endCursor }
			}
		}
	}
`;

const ACTIVE_SCOPE_RELATIONS_QUERY = `
	query ActiveScopeRelations($id: String!, $after: String) {
		issue(id: $id) {
			inverseRelations(first: 50, after: $after) {
				nodes { type issue { id identifier title url state { type } } }
				pageInfo { hasNextPage endCursor }
			}
		}
	}
`;

function activeScopeFilter(
	binding: ProjectLinearBinding,
): LinearDocument.IssueFilter {
	return {
		team: { key: { eq: binding.team } },
		...(binding.project ? { project: { name: { eq: binding.project } } } : {}),
		...(binding.label ? { labels: { name: { eq: binding.label } } } : {}),
		state: { type: { eq: "started" } },
		parent: { null: true },
		children: { length: { gt: 0 } },
	};
}

export async function fetchLinearActiveScopeSnapshot(
	apiKey: string,
	binding: ProjectLinearBinding,
	options: FetchLinearActiveScopeSnapshotOptions = {},
): Promise<LinearActiveScopeSnapshot> {
	const now = options.now ?? (() => new Date());
	const fetchedAtDate = now();
	const deadlineAt = fetchedAtDate.getTime() + (options.deadlineMs ?? 20_000);
	const maxRootPages = options.maxRootPages ?? 10;
	const maxChildPages = options.maxChildPages ?? 10;
	const maxNestedPages = options.maxNestedPages ?? 10;
	const maxItems = options.maxItems ?? 500;
	const { LinearClient } = await import("@linear/sdk");
	const client = new LinearClient({ apiKey });

	async function request<T>(
		query: string,
		variables: Record<string, unknown>,
	): Promise<T> {
		const remainingMs = deadlineAt - now().getTime();
		if (remainingMs <= 0) {
			throw new LinearUpstreamError("Linear API deadline exceeded");
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error("Linear API deadline exceeded")),
				remainingMs,
			);
		});
		try {
			return (await Promise.race([
				client.client.rawRequest(query, variables),
				timeout,
			])) as T;
		} catch (error) {
			throw new LinearUpstreamError(
				error instanceof Error ? error.message : String(error),
				error,
			);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	const roots: LinearScopeRootNode[] = [];
	let rootAfter: string | null = null;
	for (let page = 1; ; page += 1) {
		const response: ActiveScopeRootsResponse =
			await request<ActiveScopeRootsResponse>(ACTIVE_SCOPE_ROOTS_QUERY, {
				filter: activeScopeFilter(binding),
				after: rootAfter,
			});
		const connection:
			| { nodes: LinearScopeRootNode[]; pageInfo: PageInfo }
			| undefined = response.data?.issues;
		if (!connection) {
			throw new LinearUpstreamError(
				"Linear active scope response is missing issues",
			);
		}
		for (const root of connection.nodes) {
			if (root.labels.pageInfo.hasNextPage) {
				throw new EpicSnapshotTruncatedError(
					`Active root labels exceed 50: ${root.identifier}`,
				);
			}
			roots.push(root);
		}
		if (!connection.pageInfo.hasNextPage) break;
		if (page >= maxRootPages)
			throw new EpicTooLargeError("Too many active roots");
		rootAfter = connection.pageInfo.endCursor ?? null;
		if (!rootAfter) {
			throw new EpicSnapshotTruncatedError(
				"Active roots indicate more results without a cursor",
			);
		}
	}
	if (roots.length === 0) throw new ActiveScopeNotFoundError();
	if (!roots.some((root) => root.title.includes("日常"))) {
		throw new ActiveScopeNotFoundError(
			"Permanent 日常 parent declaration was not found",
		);
	}

	const rawItems: LinearScopeIssueNode[] = [];
	const queuedParents = roots.map((root) => root.id);
	const visitedParents = new Set<string>();
	while (queuedParents.length > 0) {
		const parentId = queuedParents.shift()!;
		if (visitedParents.has(parentId)) continue;
		visitedParents.add(parentId);
		let childAfter: string | null = null;
		for (let page = 1; ; page += 1) {
			const response: ActiveScopeChildrenResponse =
				await request<ActiveScopeChildrenResponse>(
					ACTIVE_SCOPE_CHILDREN_QUERY,
					{ id: parentId, after: childAfter },
				);
			const connection:
				| { nodes: LinearScopeIssueNode[]; pageInfo: PageInfo }
				| undefined = response.data?.issue?.children;
			if (!connection) {
				throw new ActiveScopeNotFoundError(
					`Active parent declaration disappeared: ${parentId}`,
				);
			}
			for (const child of connection.nodes) {
				if (child.labels.pageInfo.hasNextPage) {
					throw new EpicSnapshotTruncatedError(
						`Child labels exceed 50: ${child.identifier}`,
					);
				}
				let relationPageInfo = child.inverseRelations.pageInfo;
				for (
					let relationPage = 0;
					relationPageInfo.hasNextPage;
					relationPage += 1
				) {
					if (relationPage >= maxNestedPages) {
						throw new EpicSnapshotTruncatedError(
							`Child relations exceed page bound: ${child.identifier}`,
						);
					}
					const relationAfter = relationPageInfo.endCursor ?? null;
					if (!relationAfter) {
						throw new EpicSnapshotTruncatedError(
							`Child relations lack a cursor: ${child.identifier}`,
						);
					}
					const relationResponse = await request<{
						data?: {
							issue: {
								inverseRelations: {
									nodes: LinearScopeRelationNode[];
									pageInfo: PageInfo;
								};
							} | null;
						};
					}>(ACTIVE_SCOPE_RELATIONS_QUERY, {
						id: child.id,
						after: relationAfter,
					});
					const relationConnection =
						relationResponse.data?.issue?.inverseRelations;
					if (!relationConnection) {
						throw new ActiveScopeNotFoundError(
							`Child declaration disappeared: ${child.identifier}`,
						);
					}
					child.inverseRelations.nodes.push(...relationConnection.nodes);
					relationPageInfo = relationConnection.pageInfo;
				}
				rawItems.push(child);
				if (rawItems.length > maxItems) {
					throw new EpicTooLargeError("Active scope exceeds 500 issues");
				}
				if (
					(child.children?.nodes.length ?? 0) > 0 ||
					child.children?.pageInfo.hasNextPage
				) {
					queuedParents.push(child.id);
				}
			}
			if (!connection.pageInfo.hasNextPage) break;
			if (page >= maxChildPages) {
				throw new EpicTooLargeError(
					`Active parent exceeds child page bound: ${parentId}`,
				);
			}
			childAfter = connection.pageInfo.endCursor ?? null;
			if (!childAfter) {
				throw new EpicSnapshotTruncatedError(
					`Child page indicates more results without a cursor: ${parentId}`,
				);
			}
		}
	}

	const uniqueRawItems = [
		...new Map(rawItems.map((item) => [item.id, item])).values(),
	];
	const includedRawItems = uniqueRawItems.filter(
		(item) => item.state.type !== "backlog",
	);
	const inScopeIds = new Set(includedRawItems.map((item) => item.id));
	const items = includedRawItems.map((item) => ({
		id: item.id,
		identifier: item.identifier,
		title: item.title,
		url: item.url,
		priority: item.priority,
		updatedAt: item.updatedAt,
		state: item.state,
		labels: item.labels.nodes.map((label) => label.name),
		blockedBy: item.inverseRelations.nodes
			.filter((relation) => relation.type === "blocks")
			.map((relation) => ({
				id: relation.issue.id,
				identifier: relation.issue.identifier,
				title: relation.issue.title,
				url: relation.issue.url,
				stateType: relation.issue.state.type,
				inScope: inScopeIds.has(relation.issue.id),
			})),
		acceptance: extractAcceptance(item.description),
	}));

	return {
		fetchedAt: fetchedAtDate.toISOString(),
		boundary: {
			teamKey: binding.team,
			project: binding.project ?? null,
			label: binding.label ?? null,
		},
		roots: roots.map((root) => ({
			id: root.id,
			identifier: root.identifier,
			title: root.title,
			url: root.url,
			updatedAt: root.updatedAt,
			state: root.state,
		})),
		items,
	};
}

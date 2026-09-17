import { createHash } from "node:crypto";
import { z } from "zod";
import { extractAcceptance } from "../epic-page/rules.js";
import type { ProjectLinearBinding } from "../ProjectConfig.js";
import {
	collectStartedEpisodes,
	isIntakeEpic,
	type StartedEpisode,
} from "./epic-intake.js";
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
	constructor(
		message = "No active Linear parent declarations were found",
		readonly reason:
			| "no_active_roots"
			| "missing_daily_root"
			| "declaration_disappeared" = "no_active_roots",
	) {
		super(message);
		this.name = "ActiveScopeNotFoundError";
	}
}

export interface LinearActiveScopeSnapshot {
	fetchedAt: string;
	descendantIds: string[];
	boundary: {
		teamKey: string;
		project: string | null;
		label: string | null;
	};
	roots: Array<{
		hasChildIssues?: boolean;
		startedAt?: string;
		id: string;
		identifier: string;
		title: string;
		url: string;
		updatedAt: string;
		state: { name: string; type: string };
	}>;
	items: Array<{
		parent: { id: string; identifier: string } | null;
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
	historyCache?: EpicHistoryCache;
	collectedScope?: CollectedEpicScope;
	hasProjectDispatch?: (
		issueUuid: string,
		identifier: string,
	) => boolean | null;
	departmentMatches?: (root: CollectedEpicRoot) => boolean;
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
	parent: { id: string; identifier: string } | null;
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

interface ActiveScopeChildrenResponse {
	data?: {
		issue: {
			children: { nodes: LinearScopeIssueNode[]; pageInfo: PageInfo };
		} | null;
	};
}

const ACTIVE_SCOPE_CHILDREN_QUERY = `
	query ActiveScopeChildren($id: String!, $after: String) {
		issue(id: $id) {
			children(first: 50, after: $after, includeArchived: false) {
				nodes {
					id identifier title description url priority updatedAt
					parent { id identifier }
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

const epicPageInfo = z.object({
	hasNextPage: z.boolean(),
	endCursor: z.string().nullable().optional(),
});
const epicRootSchema = z.object({
	id: z.string().min(1),
	identifier: z.string().regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/),
	title: z.string(),
	url: z.string().url(),
	updatedAt: z.string().datetime({ offset: true }),
	parent: z.object({ id: z.string().min(1) }).nullable(),
	team: z.object({ key: z.string().min(1) }),
	project: z.object({ name: z.string() }).nullable(),
	state: z.object({ name: z.string(), type: z.string().min(1) }),
	labels: z.object({
		nodes: z.array(z.object({ name: z.string() })),
		pageInfo: epicPageInfo,
	}),
	children: z.object({
		nodes: z.array(z.object({ id: z.string().min(1) })),
		pageInfo: epicPageInfo,
	}),
});

const EPIC_ROOT_FIELDS = `
 id identifier title url updatedAt parent { id } team { key } project { name }
 state { name type }
 labels(first: 50) { nodes { name } pageInfo { hasNextPage endCursor } }
 children(first: 1, includeArchived: true) { nodes { id } pageInfo { hasNextPage endCursor } }
`;
const EPIC_SCOPE_QUERY = `query EpicScope($filter: IssueFilter!, $after: String) {
 issues(filter: $filter, first: 50, after: $after, includeArchived: false) {
 nodes { ${EPIC_ROOT_FIELDS} } pageInfo { hasNextPage endCursor }
 }
}`;
const EPIC_PENDING_ROOTS_QUERY = `query EpicPendingRoots($filter: IssueFilter!) {
 issues(filter: $filter, first: 50, includeArchived: true) {
 nodes { ${EPIC_ROOT_FIELDS} } pageInfo { hasNextPage endCursor }
 }
}`;
const EPIC_ROOT_QUERY = `query EpicScopeRoot($id: String!) { issue(id: $id) { ${EPIC_ROOT_FIELDS} } }`;
const EPIC_HISTORY_QUERY = `query EpicStateHistory($id: String!, $after: String) {
 issue(id: $id) { stateHistory(first: 50, after: $after) {
 nodes { id stateId startedAt endedAt state { type } } pageInfo { hasNextPage endCursor }
 } }
}`;

export interface CollectedEpicRoot
	extends Omit<z.infer<typeof epicRootSchema>, "labels" | "children"> {
	labels: string[];
	hasChildIssues: boolean;
	episodes: StartedEpisode[];
}

export interface CollectedEpicScope {
	fetchedAt: string;
	candidates: CollectedEpicRoot[];
	missingIssueIds: string[];
	historyFailures?: Array<{
		issueUuid: string;
		identifier: string;
		reason: "intake_history_unavailable";
	}>;
}

/** Only validated histories are cached; current root metadata is always read again. */
export type EpicHistoryCache = Map<
	string,
	{
		revision: string;
		expiresAt: number;
		episodes: StartedEpisode[];
	}
>;
const sharedHistoryCache: EpicHistoryCache = new Map();
const HISTORY_CACHE_TTL_MS = 10 * 60_000;
const HISTORY_CACHE_MAX_ROOTS = 512;

export type LinearRequest = <T>(
	query: string,
	variables: Record<string, unknown>,
) => Promise<T>;

export async function createLinearRequest(
	apiKey: string,
	deadlineAt: number,
	now: () => Date,
): Promise<LinearRequest> {
	const { LinearClient } = await import("@linear/sdk");
	const client = new LinearClient({ apiKey });
	return async <T>(
		query: string,
		variables: Record<string, unknown>,
	): Promise<T> => {
		const remainingMs = deadlineAt - now().getTime();
		if (remainingMs <= 0)
			throw new LinearUpstreamError("Linear API deadline exceeded");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				client.client.rawRequest(query, variables),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error("Linear API deadline exceeded")),
						remainingMs,
					);
				}),
			]);
			if (
				result &&
				typeof result === "object" &&
				"errors" in result &&
				Array.isArray(result.errors) &&
				result.errors.length
			) {
				throw new Error("Linear GraphQL response contains errors");
			}
			return result as T;
		} catch (error) {
			throw new LinearUpstreamError(
				error instanceof Error ? error.message : String(error),
				error,
			);
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
}

function nextEpicCursor(
	info: z.infer<typeof epicPageInfo>,
	seen: Set<string>,
	page: number,
	maxPages: number,
): string | null {
	if (!info.hasNextPage) return null;
	if (!info.endCursor || seen.has(info.endCursor))
		throw new EpicSnapshotTruncatedError(
			"Missing or repeated Epic page cursor",
		);
	if (page >= maxPages) throw new EpicTooLargeError("Epic page bound exceeded");
	seen.add(info.endCursor);
	return info.endCursor;
}

/** Root/history phase shared by intake and full page collection; no child traversal or writes. */
export async function collectEpicScope(
	apiKey: string,
	binding: ProjectLinearBinding,
	options: FetchLinearActiveScopeSnapshotOptions & {
		lastSuccessfulScanStartedAt?: string;
		pendingIssueIds?: string[];
	} = {},
): Promise<CollectedEpicScope> {
	const now = options.now ?? (() => new Date());
	const started = now();
	const request = await createLinearRequest(
		apiKey,
		started.getTime() + (options.deadlineMs ?? 20_000),
		now,
	);
	const filter: Record<string, unknown> = {
		team: { key: { eq: binding.team } },
		...(binding.project ? { project: { name: { eq: binding.project } } } : {}),
		...(binding.label ? { labels: { name: { eq: binding.label } } } : {}),
		parent: { null: true },
		...(options.lastSuccessfulScanStartedAt
			? {
					updatedAt: {
						gte: new Date(
							new Date(
								z
									.string()
									.datetime({ offset: true })
									.parse(options.lastSuccessfulScanStartedAt),
							).getTime() - 120_000,
						).toISOString(),
					},
				}
			: { state: { type: { eq: "started" } } }),
	};
	const roots = new Map<string, z.infer<typeof epicRootSchema>>();
	let after: string | null = null;
	const seen = new Set<string>();
	for (let page = 1; ; page++) {
		const response = z
			.object({
				data: z.object({
					issues: z.object({
						nodes: z.array(epicRootSchema),
						pageInfo: epicPageInfo,
					}),
				}),
			})
			.parse(await request(EPIC_SCOPE_QUERY, { filter, after }));
		for (const root of response.data.issues.nodes) {
			const previous = roots.get(root.id);
			if (previous && JSON.stringify(previous) !== JSON.stringify(root))
				throw new EpicSnapshotTruncatedError(
					"Epic metadata changed during pagination",
				);
			roots.set(root.id, root);
		}
		after = nextEpicCursor(
			response.data.issues.pageInfo,
			seen,
			page,
			options.maxRootPages ?? 10,
		);
		if (after === null) break;
	}
	const missingIssueIds: string[] = [];
	const pendingIds = [...new Set(options.pendingIssueIds ?? [])].filter(
		(id) => !roots.has(id),
	);
	if (pendingIds.length > (options.maxRootPages ?? 10) * 50)
		throw new EpicTooLargeError("Pending Epic root bound exceeded");
	// A full successful batch proves which IDs are absent; do not apply the
	// project/label filter here because moved roots must still be invalidated.
	if (pendingIds.length > 1) {
		for (let offset = 0; offset < pendingIds.length; offset += 50) {
			const ids = pendingIds.slice(offset, offset + 50);
			const response = z
				.object({
					data: z.object({
						issues: z.object({
							nodes: z.array(epicRootSchema),
							pageInfo: epicPageInfo,
						}),
					}),
				})
				.parse(
					await request(EPIC_PENDING_ROOTS_QUERY, {
						filter: { id: { in: ids } },
					}),
				);
			if (response.data.issues.pageInfo.hasNextPage)
				throw new EpicSnapshotTruncatedError(
					"Pending Epic batch is incomplete",
				);
			const returned = new Set<string>();
			for (const root of response.data.issues.nodes) {
				if (!ids.includes(root.id) || returned.has(root.id))
					throw new EpicSnapshotTruncatedError(
						"Pending Epic batch identity mismatch",
					);
				returned.add(root.id);
				roots.set(root.id, root);
			}
			missingIssueIds.push(...ids.filter((id) => !returned.has(id)));
		}
	}
	for (const id of pendingIds.length === 1 ? pendingIds : []) {
		try {
			const response = z
				.object({ data: z.object({ issue: epicRootSchema.nullable() }) })
				.parse(await request(EPIC_ROOT_QUERY, { id }));
			if (response.data.issue === null) missingIssueIds.push(id);
			else {
				if (response.data.issue.id !== id)
					throw new EpicSnapshotTruncatedError(
						"Pending Epic identity mismatch",
					);
				roots.set(id, response.data.issue);
			}
		} catch (error) {
			// Match the existing FLY-967 single-issue lookup contract. Other
			// upstream failures cannot prove absence and must remain retryable.
			if (
				error instanceof LinearUpstreamError &&
				/entity not found|could not be found/i.test(error.message)
			) {
				missingIssueIds.push(id);
			} else {
				throw error;
			}
		}
	}
	const historyCache = options.historyCache ?? sharedHistoryCache;
	const cacheNamespace = createHash("sha256")
		.update(JSON.stringify([apiKey, binding]))
		.digest("hex");
	const candidates: CollectedEpicRoot[] = [];
	const historyFailures: NonNullable<CollectedEpicScope["historyFailures"]> =
		[];
	for (const root of roots.values()) {
		if (root.labels.pageInfo.hasNextPage)
			throw new EpicSnapshotTruncatedError("Epic labels exceed bound");
		if (root.children.pageInfo.hasNextPage && root.children.nodes.length === 0)
			throw new EpicSnapshotTruncatedError("Epic child evidence is incomplete");
		const cacheKey = `${cacheNamespace}:${root.id}`;
		const revision = JSON.stringify(root);
		const cached = historyCache.get(cacheKey);
		let episodes: StartedEpisode[];
		if (
			cached &&
			cached.revision === revision &&
			cached.expiresAt > started.getTime()
		) {
			episodes = structuredClone(cached.episodes);
		} else {
			historyCache.delete(cacheKey);
			try {
				const history: unknown[] = [];
				const historyCursors = new Set<string>();
				after = null;
				for (let page = 1; ; page++) {
					const response = z
						.object({
							data: z.object({
								issue: z.object({
									stateHistory: z.object({
										nodes: z.array(z.unknown()),
										pageInfo: epicPageInfo,
									}),
								}),
							}),
						})
						.parse(await request(EPIC_HISTORY_QUERY, { id: root.id, after }));
					history.push(...response.data.issue.stateHistory.nodes);
					after = nextEpicCursor(
						response.data.issue.stateHistory.pageInfo,
						historyCursors,
						page,
						options.maxNestedPages ?? 10,
					);
					if (after === null) break;
				}
				if (history.length === 0)
					throw new EpicSnapshotTruncatedError("Epic stateHistory is empty");
				episodes = collectStartedEpisodes(root.id, history);
				const openSpans = history.filter(
					(span) => (span as { endedAt: unknown }).endedAt === null,
				) as Array<{ state: { type: string } }>;
				if (
					openSpans.length === 0 ||
					openSpans.some((span) => span.state.type !== root.state.type)
				)
					throw new EpicSnapshotTruncatedError(
						"Epic current state disagrees with history",
					);
			} catch {
				// A root-local history defect must not invalidate healthy shared scope.
				historyFailures.push({
					issueUuid: root.id,
					identifier: root.identifier,
					reason: "intake_history_unavailable",
				});
				continue;
			}

			while (historyCache.size >= HISTORY_CACHE_MAX_ROOTS) {
				historyCache.delete(historyCache.keys().next().value!);
			}
			historyCache.set(cacheKey, {
				revision,
				expiresAt: started.getTime() + HISTORY_CACHE_TTL_MS,
				episodes: structuredClone(episodes),
			});
		}
		const { children, labels, ...metadata } = root;
		candidates.push({
			...metadata,
			labels: labels.nodes.map((label) => label.name),
			hasChildIssues: children.nodes.length > 0,
			episodes,
		});
	}
	return {
		fetchedAt: started.toISOString(),
		candidates,
		missingIssueIds,
		historyFailures,
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
	const maxChildPages = options.maxChildPages ?? 10;
	const maxNestedPages = options.maxNestedPages ?? 10;
	const maxItems = options.maxItems ?? 500;
	const request = await createLinearRequest(apiKey, deadlineAt, now);

	const scope =
		options.collectedScope ??
		(await collectEpicScope(apiKey, binding, options));
	const roots = scope.candidates.filter((root) =>
		isIntakeEpic({
			hasParent: root.parent !== null,
			departmentMatches:
				options.departmentMatches?.(root) ??
				(!binding.label ||
					root.labels.some(
						(label) => label.toLowerCase() === binding.label!.toLowerCase(),
					)),
			stateType: root.state.type,
			hasChildIssues: root.hasChildIssues,
			hasProjectDispatch: root.hasChildIssues
				? null
				: (options.hasProjectDispatch?.(root.id, root.identifier) ?? null),
		}),
	);
	if (roots.length === 0) throw new ActiveScopeNotFoundError();

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
					"declaration_disappeared",
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
							"declaration_disappeared",
						);
					}
					child.inverseRelations.nodes.push(...relationConnection.nodes);
					relationPageInfo = relationConnection.pageInfo;
				}
				if (child.parent && child.parent.id !== parentId) {
					throw new EpicSnapshotTruncatedError(
						`Child parent drifted during snapshot: ${child.identifier}`,
					);
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
	const inScopeIds = new Set(uniqueRawItems.map((item) => item.id));
	const items = uniqueRawItems.map((item) => ({
		parent: item.parent
			? { id: item.parent.id, identifier: item.parent.identifier }
			: null,
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
		fetchedAt: scope.fetchedAt,
		descendantIds: uniqueRawItems.map((item) => item.id),
		boundary: {
			teamKey: binding.team,
			project: binding.project ?? null,
			label: binding.label ?? null,
		},
		roots: roots.map((root) => ({
			id: root.id,
			hasChildIssues: root.hasChildIssues,
			startedAt: root.episodes.find((episode) => episode.active)?.startedAt,
			identifier: root.identifier,
			title: root.title,
			url: root.url,
			updatedAt: root.updatedAt,
			state: root.state,
		})),
		items,
	};
}

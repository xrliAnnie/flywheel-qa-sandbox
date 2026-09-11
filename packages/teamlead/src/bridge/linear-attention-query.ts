import type { LinearDocument } from "@linear/sdk";
import { FOUNDER_REVIEW_LABEL } from "../epic-page/rules.js";
import type { ProjectLinearBinding } from "../ProjectConfig.js";

export interface LinearAttentionIssue {
	id: string;
	identifier: string;
	title: string;
	url: string;
	stateType: string;
	labels: string[];
}
export interface LinearAttentionResult {
	fetchedAt: string;
	items: LinearAttentionIssue[];
	/** Raw records admitted before deduplication. */
	rawCount: number;
	missing: null | {
		reason: "source_unavailable" | "source_truncated";
		detail:
			| "deadline_exceeded"
			| "upstream_error"
			| "invalid_response"
			| "boundary_mismatch"
			| "labels_truncated"
			| "missing_cursor"
			| "record_limit";
	};
}
export interface LinearAttentionQueryOptions {
	deadlineMs?: number;
	now?: () => Date;
}
interface IssueNode {
	id: string;
	identifier: string;
	title: string;
	url: string;
	state: { type: string };
	team: { key: string };
	project: { name: string } | null;
	labels: {
		nodes: Array<{ name: string }>;
		pageInfo: { hasNextPage: boolean };
	};
}
const QUERY = `query AttentionIssues($filter: IssueFilter!, $after: String) {
 issues(filter: $filter, first: 50, after: $after, includeArchived: false) {
  nodes { id identifier title url state { type } team { key } project { name }
   labels(first: 50) { nodes { name } pageInfo { hasNextPage } }
  }
  pageInfo { hasNextPage endCursor }
 }
}`;
function boundaryFilters(
	binding: ProjectLinearBinding,
): LinearDocument.IssueFilter[] {
	return [
		{ team: { key: { eq: binding.team } } },
		...(binding.project
			? [{ project: { name: { eq: binding.project } } }]
			: []),
		...(binding.label ? [{ labels: { name: { eq: binding.label } } }] : []),
	];
}

async function read(
	apiKey: string,
	binding: ProjectLinearBinding,
	founderOnly: boolean,
	identities: string[] | null,
	options: LinearAttentionQueryOptions,
): Promise<LinearAttentionResult> {
	const now = options.now ?? (() => new Date());
	const start = now();
	const deadlineAt =
		start.getTime() + Math.min(options.deadlineMs ?? 15000, 15000);
	const result: LinearAttentionResult = {
		fetchedAt: start.toISOString(),
		items: [],
		rawCount: 0,
		missing: null,
	};
	if (identities?.length === 0) return result;
	const and = boundaryFilters(binding);
	if (founderOnly)
		and.push(
			{ labels: { name: { eq: FOUNDER_REVIEW_LABEL } } },
			{ state: { type: { nin: ["completed", "canceled"] } } },
		);
	if (identities) {
		const ids: string[] = [];
		const numbers: number[] = [];
		for (const identity of new Set(identities)) {
			const match = /^(.+)-(\d+)$/.exec(identity);
			if (
				match &&
				match[1] === binding.team &&
				Number.isSafeInteger(Number(match[2]))
			)
				numbers.push(Number(match[2]));
			else if (!/^[A-Z][A-Z0-9]*-\d+$/.test(identity)) ids.push(identity);
		}
		if (!ids.length && !numbers.length) return result;
		and.push({
			or: [
				...(ids.length ? [{ id: { in: ids } }] : []),
				...(numbers.length ? [{ number: { in: numbers } }] : []),
			],
		});
	}
	const filter = { and } satisfies LinearDocument.IssueFilter;
	const fail = (
		detail: NonNullable<LinearAttentionResult["missing"]>["detail"],
		truncated = false,
	) => {
		result.missing = {
			reason: truncated ? "source_truncated" : "source_unavailable",
			detail,
		};
		return result;
	};
	const seen = new Set<string>();
	const cursors = new Set<string>();
	let after: string | null = null;
	try {
		const { LinearClient } = await import("@linear/sdk");
		const client = new LinearClient({ apiKey });
		while (true) {
			const remaining = deadlineAt - now().getTime();
			if (remaining <= 0) return fail("deadline_exceeded");
			let timer: ReturnType<typeof setTimeout> | undefined;
			let timedOut = false;
			let response: {
				errors?: unknown[];
				data?: {
					issues?: {
						nodes: IssueNode[];
						pageInfo: { hasNextPage: boolean; endCursor?: string | null };
					};
				};
			};
			try {
				response = (await Promise.race([
					client.client.rawRequest(QUERY, { filter, after }),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => {
							timedOut = true;
							reject(new Error("deadline"));
						}, remaining);
					}),
				])) as typeof response;
			} catch {
				return fail(timedOut ? "deadline_exceeded" : "upstream_error");
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
			if (response.errors?.length) return fail("upstream_error");
			const connection = response.data?.issues;
			if (
				!connection ||
				!Array.isArray(connection.nodes) ||
				typeof connection.pageInfo?.hasNextPage !== "boolean"
			)
				return fail("invalid_response");
			for (const node of connection.nodes) {
				if (result.rawCount === 1000) return fail("record_limit", true);
				result.rawCount++;
				if (
					!node ||
					![
						node.id,
						node.identifier,
						node.title,
						node.url,
						node.state?.type,
						node.team?.key,
					].every((x) => typeof x === "string" && x.length > 0) ||
					!Array.isArray(node.labels?.nodes) ||
					typeof node.labels.pageInfo?.hasNextPage !== "boolean" ||
					!node.labels.nodes.every((x) => typeof x?.name === "string")
				)
					return fail("invalid_response");
				if (node.labels.pageInfo.hasNextPage)
					return fail("labels_truncated", true);
				const labels = node.labels.nodes.map((x) => x.name);
				if (
					node.team.key !== binding.team ||
					(binding.project && node.project?.name !== binding.project) ||
					(binding.label && !labels.includes(binding.label)) ||
					(founderOnly &&
						(!labels.includes(FOUNDER_REVIEW_LABEL) ||
							["completed", "canceled"].includes(node.state.type))) ||
					(identities &&
						!identities.includes(node.id) &&
						!identities.includes(node.identifier))
				)
					return fail("boundary_mismatch");
				if (!seen.has(node.id)) {
					seen.add(node.id);
					result.items.push({
						id: node.id,
						identifier: node.identifier,
						title: node.title,
						url: node.url,
						stateType: node.state.type,
						labels,
					});
				}
			}
			if (now().getTime() >= deadlineAt) return fail("deadline_exceeded");
			if (!connection.pageInfo.hasNextPage) return result;
			if (result.rawCount === 1000) return fail("record_limit", true);
			const cursor = connection.pageInfo.endCursor;
			if (typeof cursor !== "string" || !cursor || cursors.has(cursor))
				return fail("missing_cursor");
			cursors.add(cursor);
			after = cursor;
		}
	} catch {
		return fail("upstream_error");
	}
}

export function fetchLinearFounderReviewAttention(
	apiKey: string,
	binding: ProjectLinearBinding,
	options: LinearAttentionQueryOptions = {},
): Promise<LinearAttentionResult> {
	return read(apiKey, binding, true, null, options);
}
export function fetchLinearAttentionIssueMetadata(
	apiKey: string,
	binding: ProjectLinearBinding,
	identities: string[],
	options: LinearAttentionQueryOptions = {},
): Promise<LinearAttentionResult> {
	return read(apiKey, binding, false, identities, options);
}

import { z } from "zod";
import type { ProjectLinearBinding } from "../ProjectConfig.js";
import {
	createLinearRequest,
	type LinearRequest,
} from "./linear-epic-query.js";
import type { ActivityWindow, SourceResult } from "./summary-activity-probe.js";
import { safeActivityReason } from "./summary-activity-probe.js";

const SUMMARY_LINEAR_QUERY = `query SummaryLinearActivity($filter: IssueFilter!, $after: String) {
 issues(filter: $filter, first: 50, after: $after, includeArchived: true) {
  nodes {
   id createdAt updatedAt
   history(first: 25) {
    nodes {
     createdAt fromStateId toStateId fromParentId toParentId fromPriority toPriority
    }
    pageInfo { hasNextPage endCursor }
   }
  }
  pageInfo { hasNextPage endCursor }
 }
}`;

const pageInfoSchema = z.object({
	hasNextPage: z.boolean(),
	endCursor: z.string().nullable().optional(),
});

const historyNodeSchema = z.object({
	createdAt: z.string().datetime({ offset: true }),
	fromStateId: z.string().nullable(),
	toStateId: z.string().nullable(),
	fromParentId: z.string().nullable(),
	toParentId: z.string().nullable(),
	fromPriority: z.number().nullable(),
	toPriority: z.number().nullable(),
});

const responseSchema = z.object({
	data: z.object({
		issues: z.object({
			nodes: z.array(
				z.object({
					id: z.string().min(1),
					createdAt: z.string().datetime({ offset: true }),
					updatedAt: z.string().datetime({ offset: true }),
					history: z.object({
						nodes: z.array(historyNodeSchema),
						pageInfo: pageInfoSchema,
					}),
				}),
			),
			pageInfo: pageInfoSchema,
		}),
	}),
});

function inWindow(timestamp: string, window: ActivityWindow): boolean {
	const value = Date.parse(timestamp);
	return value >= window.fromMs && value < window.toMs;
}

function changedHistoryField(
	from: string | number | null,
	to: string | number | null,
): boolean {
	return to !== null && from !== to;
}

function isMaterialHistoryChange(
	node: z.infer<typeof historyNodeSchema>,
	window: ActivityWindow,
): boolean {
	return (
		inWindow(node.createdAt, window) &&
		(changedHistoryField(node.fromStateId, node.toStateId) ||
			node.fromParentId !== node.toParentId ||
			changedHistoryField(node.fromPriority, node.toPriority))
	);
}

export async function readSummaryLinearActivity(input: {
	binding?: ProjectLinearBinding | null;
	window: ActivityWindow;
	apiKey?: string;
	request?: LinearRequest;
	now?: () => Date;
	deadlineMs?: number;
	maxPages?: number;
}): Promise<SourceResult> {
	if (!input.binding) return { status: "not_bound", count: 0 };
	try {
		if (!input.request && !input.apiKey) {
			return { status: "unavailable", reason: "linear_api_key_missing" };
		}
		const now = input.now ?? (() => new Date());
		const request =
			input.request ??
			(await createLinearRequest(
				input.apiKey ?? "",
				now().getTime() + (input.deadlineMs ?? 20_000),
				now,
			));
		const maxPages = input.maxPages ?? 4;
		const seenCursors = new Set<string>();
		let after: string | null = null;

		for (let page = 1; page <= maxPages; page++) {
			const response = responseSchema.parse(
				await request(SUMMARY_LINEAR_QUERY, {
					filter: {
						team: { key: { eq: input.binding.team } },
						updatedAt: { gte: new Date(input.window.fromMs).toISOString() },
					},
					after,
				}),
			);

			let count = 0;
			for (const issue of response.data.issues.nodes) {
				if (inWindow(issue.createdAt, input.window)) count++;
				count += issue.history.nodes.filter((node) =>
					isMaterialHistoryChange(node, input.window),
				).length;
			}
			if (count > 0) return { status: "ok", count };
			if (
				response.data.issues.nodes.some(
					(issue) => issue.history.pageInfo.hasNextPage,
				)
			) {
				return { status: "unavailable", reason: "history_truncated" };
			}

			const pageInfo = response.data.issues.pageInfo;
			if (!pageInfo.hasNextPage) {
				return { status: "unavailable", reason: "linear_zero_unprovable" };
			}
			if (page >= maxPages) {
				return { status: "unavailable", reason: "too_many_updates" };
			}
			if (!pageInfo.endCursor || seenCursors.has(pageInfo.endCursor)) {
				return { status: "unavailable", reason: "invalid_page_cursor" };
			}
			seenCursors.add(pageInfo.endCursor);
			after = pageInfo.endCursor;
		}
		return { status: "unavailable", reason: "too_many_updates" };
	} catch (error) {
		return { status: "unavailable", reason: safeActivityReason(error) };
	}
}

import { describe, expect, it, vi } from "vitest";
import type { ProjectLinearBinding } from "../../ProjectConfig.js";
import type { LinearRequest } from "../linear-epic-query.js";
import { readSummaryLinearActivity } from "../summary-linear-activity.js";

const binding: ProjectLinearBinding = { team: "FLY", project: "Flywheel" };
const window = {
	fromMs: Date.parse("2026-09-16T00:00:00.000Z"),
	toMs: Date.parse("2026-09-16T06:00:00.000Z"),
};

const history = (overrides: Record<string, unknown> = {}) => ({
	createdAt: "2026-09-16T02:00:00.000Z",
	fromStateId: null,
	toStateId: null,
	fromParentId: null,
	toParentId: null,
	fromPriority: null,
	toPriority: null,
	...overrides,
});

const issue = (overrides: Record<string, unknown> = {}) => ({
	id: "issue-1",
	createdAt: "2026-09-15T00:00:00.000Z",
	updatedAt: "2026-09-16T02:00:00.000Z",
	history: {
		nodes: [],
		pageInfo: { hasNextPage: false, endCursor: null },
	},
	...overrides,
});

const response = (
	nodes: unknown[],
	pageInfo: { hasNextPage: boolean; endCursor?: string | null } = {
		hasNextPage: false,
		endCursor: null,
	},
) => ({ data: { issues: { nodes, pageInfo } } });

function requestOf(...values: unknown[]) {
	return vi.fn(async () => values.shift()) as unknown as LinearRequest;
}

describe("FLY-2634 summary Linear activity", () => {
	it("returns not_bound without calling Linear", async () => {
		const request = requestOf(response([]));
		expect(
			await readSummaryLinearActivity({ binding: undefined, window, request }),
		).toEqual({ status: "not_bound", count: 0 });
		expect(request).not.toHaveBeenCalled();
	});

	it("counts issue creation and queries the team with only an updatedAt lower bound", async () => {
		const request = requestOf(
			response([issue({ createdAt: "2026-09-16T00:00:00.000Z" })]),
		);
		expect(
			await readSummaryLinearActivity({ binding, window, request }),
		).toEqual({ status: "ok", count: 1 });
		expect(request).toHaveBeenCalledTimes(1);
		const [query, variables] = vi.mocked(request).mock.calls[0]!;
		expect(query).toContain("includeArchived: true");
		expect(variables).toEqual({
			filter: {
				team: { key: { eq: "FLY" } },
				updatedAt: { gte: "2026-09-16T00:00:00.000Z" },
			},
			after: null,
		});
	});

	it.each([
		["state", { fromStateId: "old", toStateId: "new" }],
		["parent", { fromParentId: null, toParentId: "parent" }],
		["parent detach", { fromParentId: "parent", toParentId: null }],
		["priority", { fromPriority: 0, toPriority: 1 }],
	] as const)("counts a %s history change", async (_name, change) => {
		const request = requestOf(
			response([
				issue({
					history: {
						nodes: [history(change)],
						pageInfo: { hasNextPage: false, endCursor: null },
					},
				}),
			]),
		);
		expect(
			await readSummaryLinearActivity({ binding, window, request }),
		).toEqual({ status: "ok", count: 1 });
	});

	it("keeps a positive result on a repeated crash-recovery probe", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			expect(
				await readSummaryLinearActivity({
					binding,
					window,
					request: requestOf(
						response([issue({ createdAt: "2026-09-16T01:00:00.000Z" })]),
					),
				}),
			).toEqual({ status: "ok", count: 1 });
		}
	});

	it("finds an in-window state change even when a later comment advances updatedAt", async () => {
		const request = requestOf(
			response([
				issue({
					updatedAt: "2026-09-16T06:00:00.001Z",
					history: {
						nodes: [
							history({
								createdAt: "2026-09-16T05:59:59.999Z",
								fromStateId: "old",
								toStateId: "new",
							}),
						],
						pageInfo: { hasNextPage: false, endCursor: null },
					},
				}),
			]),
		);
		expect(
			await readSummaryLinearActivity({ binding, window, request }),
		).toEqual({ status: "ok", count: 1 });
	});

	it("keeps zero and comment-only results unavailable", async () => {
		for (const nodes of [[], [issue()]]) {
			expect(
				await readSummaryLinearActivity({
					binding,
					window,
					request: requestOf(response(nodes)),
				}),
			).toEqual({
				status: "unavailable",
				reason: "linear_zero_unprovable",
			});
		}
	});

	it("fails open when history or issue pagination is incomplete", async () => {
		expect(
			await readSummaryLinearActivity({
				binding,
				window,
				request: requestOf(
					response([
						issue({
							history: {
								nodes: [],
								pageInfo: { hasNextPage: true, endCursor: "history-2" },
							},
						}),
					]),
				),
			}),
		).toEqual({ status: "unavailable", reason: "history_truncated" });

		const pages = Array.from({ length: 4 }, (_, index) =>
			response([], { hasNextPage: true, endCursor: `page-${index + 2}` }),
		);
		expect(
			await readSummaryLinearActivity({
				binding,
				window,
				request: requestOf(...pages),
			}),
		).toEqual({ status: "unavailable", reason: "too_many_updates" });
	});

	it("fails open on upstream and schema errors", async () => {
		const throws = vi.fn(async () => {
			throw new Error("Linear unavailable");
		}) as unknown as LinearRequest;
		for (const request of [throws, requestOf({ data: { issues: {} } })]) {
			const result = await readSummaryLinearActivity({
				binding,
				window,
				request,
			});
			expect(result.status).toBe("unavailable");
		}
	});
});

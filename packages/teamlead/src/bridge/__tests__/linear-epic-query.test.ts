import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ActiveScopeNotFoundError,
	EpicSnapshotTruncatedError,
	EpicTooLargeError,
	fetchLinearActiveScopeSnapshot,
} from "../linear-epic-query.js";

const { mockRawRequest } = vi.hoisted(() => ({
	mockRawRequest: vi.fn(),
}));

vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({
		client: { rawRequest: mockRawRequest },
	})),
}));

function now(): Date {
	return new Date("2026-09-03T04:00:00.000Z");
}

function relation(
	identifier: string,
	overrides: Partial<{ type: string; stateType: string }> = {},
) {
	return {
		type: overrides.type ?? "blocks",
		issue: {
			id: `${identifier}-uuid`,
			identifier,
			title: `Title ${identifier}`,
			url: `https://linear.app/example/issue/${identifier}`,
			state: { type: overrides.stateType ?? "backlog" },
		},
	};
}

function child(
	identifier: string,
	overrides: Partial<{
		state: { name: string; type: string };
		inverseRelations: ReturnType<typeof relation>[];
		relationsHasNextPage: boolean;
		relationsEndCursor: string | null;
		children: Array<{ id: string }>;
	}> = {},
) {
	return {
		id: `${identifier}-uuid`,
		identifier,
		title: `Title ${identifier}`,
		description: "## 验收\nDone",
		url: `https://linear.app/example/issue/${identifier}`,
		priority: 0,
		updatedAt: "2026-09-03T03:30:00.000Z",
		state: overrides.state ?? { name: "Backlog", type: "backlog" },
		labels: {
			nodes: [{ name: "Flywheel" }],
			pageInfo: { hasNextPage: false },
		},
		inverseRelations: {
			nodes: overrides.inverseRelations ?? [],
			pageInfo: {
				hasNextPage: overrides.relationsHasNextPage ?? false,
				endCursor: overrides.relationsEndCursor ?? null,
			},
		},
		children: {
			nodes: overrides.children ?? [],
			pageInfo: { hasNextPage: false, endCursor: null },
		},
	};
}

function scopeRoot(identifier: string, title: string) {
	return {
		id: `${identifier}-uuid`,
		identifier,
		title,
		url: `https://linear.app/example/issue/${identifier}`,
		updatedAt: "2026-09-03T03:00:00.000Z",
		state: { name: "In Progress", type: "started" },
		labels: { nodes: [{ name: "Example" }], pageInfo: { hasNextPage: false } },
	};
}

function rootsResponse(
	roots: ReturnType<typeof scopeRoot>[],
	pageInfo = { hasNextPage: false, endCursor: null as string | null },
) {
	return { data: { issues: { nodes: roots, pageInfo } } };
}

function childrenResponse(
	children: ReturnType<typeof child>[],
	pageInfo = { hasNextPage: false, endCursor: null as string | null },
) {
	return { data: { issue: { children: { nodes: children, pageInfo } } } };
}

beforeEach(() => {
	mockRawRequest.mockReset();
});

describe("fetchLinearActiveScopeSnapshot", () => {
	it("discovers started root subtrees, includes 日常, and filters Backlog", async () => {
		mockRawRequest
			.mockResolvedValueOnce(
				rootsResponse([
					scopeRoot("EPX-100", "Active Epic"),
					scopeRoot("EPX-200", "日常"),
				]),
			)
			.mockResolvedValueOnce(
				childrenResponse([
					child("EPX-1", {
						state: { name: "Todo", type: "unstarted" },
						inverseRelations: [relation("EPX-2", { stateType: "completed" })],
					}),
				]),
			)
			.mockResolvedValueOnce(childrenResponse([child("EPX-2")]));

		const snapshot = await fetchLinearActiveScopeSnapshot(
			"token",
			{ team: "EPX", project: "Example", label: "Example" },
			{ now },
		);

		expect(snapshot.roots.map((root) => root.identifier)).toEqual([
			"EPX-100",
			"EPX-200",
		]);
		expect(snapshot.items.map((item) => item.identifier)).toEqual(["EPX-1"]);
		expect(snapshot.items[0]?.blockedBy).toEqual([
			expect.objectContaining({
				identifier: "EPX-2",
				title: "Title EPX-2",
				stateType: "completed",
				inScope: false,
			}),
		]);
		expect(mockRawRequest.mock.calls[0]?.[1]).toMatchObject({
			filter: {
				team: { key: { eq: "EPX" } },
				project: { name: { eq: "Example" } },
				labels: { name: { eq: "Example" } },
				state: { type: { eq: "started" } },
				parent: { null: true },
				children: { length: { gt: 0 } },
			},
		});
	});

	it("walks the full declared subtree instead of stopping at direct children", async () => {
		mockRawRequest
			.mockResolvedValueOnce(rootsResponse([scopeRoot("EPX-200", "日常")]))
			.mockResolvedValueOnce(
				childrenResponse([
					child("EPX-1", {
						state: { name: "Todo", type: "unstarted" },
						children: [{ id: "EPX-2-uuid" }],
					}),
				]),
			)
			.mockResolvedValueOnce(
				childrenResponse([
					child("EPX-2", {
						state: { name: "Todo", type: "unstarted" },
					}),
				]),
			);

		const snapshot = await fetchLinearActiveScopeSnapshot(
			"token",
			{ team: "EPX" },
			{ now },
		);

		expect(snapshot.items.map((item) => item.identifier)).toEqual([
			"EPX-1",
			"EPX-2",
		]);
		expect(mockRawRequest.mock.calls[2]?.[1]).toEqual({
			id: "EPX-1-uuid",
			after: null,
		});
	});

	it("paginates roots, children, and blocker relations", async () => {
		mockRawRequest
			.mockResolvedValueOnce(
				rootsResponse([scopeRoot("EPX-100", "Active")], {
					hasNextPage: true,
					endCursor: "roots-2",
				}),
			)
			.mockResolvedValueOnce(rootsResponse([scopeRoot("EPX-200", "日常")]))
			.mockResolvedValueOnce(
				childrenResponse(
					[
						child("EPX-1", {
							state: { name: "Todo", type: "unstarted" },
							inverseRelations: [relation("EPX-0", { stateType: "completed" })],
							relationsHasNextPage: true,
							relationsEndCursor: "relations-2",
						}),
					],
					{ hasNextPage: true, endCursor: "children-2" },
				),
			)
			.mockResolvedValueOnce({
				data: {
					issue: {
						inverseRelations: {
							nodes: [relation("OUT-1")],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			})
			.mockResolvedValueOnce(childrenResponse([]))
			.mockResolvedValueOnce(childrenResponse([]));

		const snapshot = await fetchLinearActiveScopeSnapshot(
			"token",
			{ team: "EPX" },
			{ now },
		);

		expect(snapshot.items[0]?.blockedBy.map((item) => item.identifier)).toEqual(
			["EPX-0", "OUT-1"],
		);
		expect(mockRawRequest.mock.calls.map((call) => call[1])).toContainEqual({
			filter: expect.anything(),
			after: "roots-2",
		});
		expect(mockRawRequest.mock.calls.map((call) => call[1])).toContainEqual({
			id: "EPX-1-uuid",
			after: "relations-2",
		});
		expect(mockRawRequest.mock.calls.map((call) => call[1])).toContainEqual({
			id: "EPX-100-uuid",
			after: "children-2",
		});
	});

	it("fails loud when the permanent 日常 parent declaration is absent", async () => {
		mockRawRequest.mockResolvedValueOnce(
			rootsResponse([scopeRoot("EPX-100", "Active Epic")]),
		);

		await expect(
			fetchLinearActiveScopeSnapshot("token", { team: "EPX" }, { now }),
		).rejects.toBeInstanceOf(ActiveScopeNotFoundError);
		expect(mockRawRequest).toHaveBeenCalledTimes(1);
	});

	it("fails loud when a declared parent becomes unreadable", async () => {
		mockRawRequest
			.mockResolvedValueOnce(rootsResponse([scopeRoot("EPX-200", "日常")]))
			.mockResolvedValueOnce({ data: { issue: null } });

		await expect(
			fetchLinearActiveScopeSnapshot("token", { team: "EPX" }, { now }),
		).rejects.toBeInstanceOf(ActiveScopeNotFoundError);
	});

	it("fails closed when pagination cannot prove a complete snapshot", async () => {
		mockRawRequest.mockResolvedValueOnce(
			rootsResponse([scopeRoot("EPX-200", "日常")], {
				hasNextPage: true,
				endCursor: null,
			}),
		);
		await expect(
			fetchLinearActiveScopeSnapshot("token", { team: "EPX" }, { now }),
		).rejects.toBeInstanceOf(EpicSnapshotTruncatedError);

		mockRawRequest.mockReset();
		mockRawRequest.mockResolvedValueOnce(
			rootsResponse([scopeRoot("EPX-200", "日常")], {
				hasNextPage: true,
				endCursor: "more",
			}),
		);
		await expect(
			fetchLinearActiveScopeSnapshot(
				"token",
				{ team: "EPX" },
				{ now, maxRootPages: 1 },
			),
		).rejects.toBeInstanceOf(EpicTooLargeError);
	});
});

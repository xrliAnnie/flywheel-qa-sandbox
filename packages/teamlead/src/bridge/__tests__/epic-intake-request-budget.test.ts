import { beforeEach, expect, it, vi } from "vitest";
import {
	collectEpicScope,
	fetchLinearActiveScopeSnapshot,
} from "../linear-epic-query.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@linear/sdk", () => ({
	LinearClient: vi
		.fn()
		.mockImplementation(() => ({ client: { rawRequest: request } })),
}));
const at = "2026-09-14T20:00:00.000Z";
const pageInfo = { hasNextPage: false, endCursor: null };
const binding = { team: "TEST", project: "Test", label: "Dept" };
function root(i: number) {
	return {
		id: `uuid-${i}`,
		identifier: `TEST-${i}`,
		title: "Epic",
		url: "https://example.test",
		updatedAt: at,
		parent: null,
		team: { key: "TEST" },
		project: { name: "Test" },
		state: { name: "In Progress", type: "started" },
		labels: { nodes: [{ name: "Dept" }], pageInfo },
		children: { nodes: [], pageInfo },
	};
}
function fixture(count = 17) {
	const roots = Array.from({ length: count }, (_, i) => root(i));
	request.mockImplementation(
		async (
			query: string,
			variables: {
				id?: string;
				filter?: { id?: { in?: string[] }; updatedAt?: unknown };
			},
		) => {
			if (query.includes("ActiveScopeChildren"))
				return { data: { issue: { children: { nodes: [], pageInfo } } } };
			if (query.includes("EpicStateHistory"))
				return {
					data: {
						issue: {
							stateHistory: {
								nodes: [
									{
										id: `span-${variables.id}`,
										stateId: "started",
										startedAt:
											roots.find((r) => r.id === variables.id)?.updatedAt ?? at,
										endedAt: null,
										state: { type: "started" },
									},
								],
								pageInfo,
							},
						},
					},
				};
			if (query.includes("EpicScopeRoot("))
				return {
					data: { issue: roots.find((r) => r.id === variables.id) ?? null },
				};
			const ids = variables.filter?.id?.in;
			return {
				data: {
					issues: {
						nodes: ids
							? roots.filter((r) => ids.includes(r.id))
							: variables.filter?.updatedAt
								? []
								: roots,
						pageInfo,
					},
				},
			};
		},
	);
	return roots;
}
const histories = () =>
	request.mock.calls.filter(([query]) => query.includes("EpicStateHistory"))
		.length;
beforeEach(() => {
	request.mockReset();
});

it("keeps 17 unchanged pending Epics below 400 requests for an hour of 30s scans", async () => {
	const roots = fixture();
	const historyCache = new Map();
	for (let tick = 0; tick < 120; tick++) {
		const scope = await collectEpicScope("fixture", binding, {
			historyCache,
			now: () => new Date(Date.parse(at) + tick * 30_000),
			...(tick
				? {
						lastSuccessfulScanStartedAt: at,
						pendingIssueIds: roots.map((r) => r.id),
					}
				: {}),
		});
		expect(scope.candidates).toHaveLength(17);
		expect(scope.historyFailures).toEqual([]);
	}
	expect(request.mock.calls.length).toBeLessThanOrEqual(400);
	expect(request.mock.calls.length).toBe(341);
	expect(histories()).toBeLessThanOrEqual(17 * 6);
});
it("refreshes changed histories but revalidates unchanged root routing and deletion in a batch", async () => {
	const roots = fixture(3);
	const historyCache = new Map();
	const options = {
		historyCache,
		now: () => new Date(at),
		pendingIssueIds: roots.map((r) => r.id),
	};
	await collectEpicScope("fixture", binding, options);
	roots[0]!.updatedAt = "2026-09-14T20:00:01.000Z";
	roots[1]!.labels.nodes = [{ name: "Other" }];
	roots.splice(2, 1);
	const scope = await collectEpicScope("fixture", binding, {
		...options,
		lastSuccessfulScanStartedAt: at,
	});
	expect(scope.missingIssueIds).toEqual(["uuid-2"]);
	expect(
		scope.candidates.find((r) => r.id === "uuid-0")?.episodes[0]?.startedAt,
	).toBe(roots[0]!.updatedAt);
	expect(scope.candidates.find((r) => r.id === "uuid-1")?.labels).toEqual([
		"Other",
	]);
	expect(histories()).toBe(5);
	const batch = request.mock.calls.find(
		([, variables]) => variables.filter?.id?.in,
	);
	expect(batch?.[1].filter).toEqual({
		id: { in: ["uuid-0", "uuid-1", "uuid-2"] },
	});
});
it("never reuses histories across credential or binding boundaries", async () => {
	fixture(1);
	const options = { historyCache: new Map(), now: () => new Date(at) };
	await collectEpicScope("first", binding, options);
	await collectEpicScope("second", binding, options);
	await collectEpicScope("second", { ...binding, project: "Other" }, options);
	expect(histories()).toBe(3);
});
it("does not cache unreadable history as successful", async () => {
	fixture(1);
	const options = { historyCache: new Map(), now: () => new Date(at) };
	request
		.mockResolvedValueOnce({ data: { issues: { nodes: [root(0)], pageInfo } } })
		.mockRejectedValueOnce(new Error("unavailable"));
	expect(
		(await collectEpicScope("fixture", binding, options)).historyFailures,
	).toHaveLength(1);
	expect(
		(await collectEpicScope("fixture", binding, options)).candidates,
	).toHaveLength(1);
	expect(histories()).toBe(2);
});

it("bounds shared cache memory and expires validated histories after ten minutes", async () => {
	fixture(1);
	const historyCache = new Map();
	await collectEpicScope("fixture", binding, {
		historyCache,
		now: () => new Date(at),
	});
	await collectEpicScope("fixture", binding, {
		historyCache,
		now: () => new Date(Date.parse(at) + 600_000),
	});
	expect(histories()).toBe(2);
	for (let i = 0; i < 513; i++)
		await collectEpicScope(`fixture-${i}`, binding, {
			historyCache,
			now: () => new Date(at),
		});
	expect(historyCache.size).toBeLessThanOrEqual(512);
});
it("refuses incomplete pending batches rather than marking omitted IDs missing", async () => {
	request
		.mockResolvedValueOnce({ data: { issues: { nodes: [], pageInfo } } })
		.mockResolvedValueOnce({
			data: {
				issues: {
					nodes: [root(0)],
					pageInfo: { hasNextPage: true, endCursor: "next" },
				},
			},
		});
	await expect(
		collectEpicScope("fixture", binding, {
			pendingIssueIds: ["uuid-0", "uuid-1"],
			historyCache: new Map(),
		}),
	).rejects.toThrow("batch is incomplete");
});

it("shares the default cache with page/dependency collection while re-reading current metadata", async () => {
	fixture(1);
	await collectEpicScope("shared-path-fixture", binding, {
		now: () => new Date(at),
	});
	const scope = await fetchLinearActiveScopeSnapshot(
		"shared-path-fixture",
		binding,
		{ now: () => new Date(at), hasProjectDispatch: () => false },
	);
	expect(scope.roots).toHaveLength(1);
	expect(histories()).toBe(1);
	expect(
		request.mock.calls.filter(([query]) => query.includes("query EpicScope("))
			.length,
	).toBe(2);
});

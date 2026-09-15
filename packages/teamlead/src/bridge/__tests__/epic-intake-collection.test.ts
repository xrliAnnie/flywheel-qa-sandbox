import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectEpicScope as collectScope,
	fetchLinearActiveScopeSnapshot,
} from "../linear-epic-query.js";

const collectEpicScope: typeof collectScope = (key, binding, options) =>
	collectScope(key, binding, { ...options, historyCache: new Map() });

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@linear/sdk", () => ({
	LinearClient: vi
		.fn()
		.mockImplementation(() => ({ client: { rawRequest: request } })),
}));
const time = "2026-09-14T20:00:00.000Z";
const pageInfo = { hasNextPage: false, endCursor: null };
const root = () => ({
	id: "uuid",
	identifier: "TEST-1",
	title: "New Epic",
	url: "https://linear.app/test/issue/TEST-1",
	updatedAt: time,
	parent: null,
	team: { key: "TEST" },
	project: { name: "Test" },
	state: { name: "In Progress", type: "started" },
	labels: { nodes: [{ name: "TestDept" }], pageInfo },
	children: { nodes: [], pageInfo },
});
const history = (hasNextPage = false, endCursor: string | null = null) => ({
	data: {
		issue: {
			stateHistory: {
				nodes: [
					{
						id: "span",
						stateId: "started",
						startedAt: time,
						endedAt: null,
						state: { type: "started" },
					},
				],
				pageInfo: { hasNextPage, endCursor },
			},
		},
	},
});
const binding = { team: "TEST", project: "Test", label: "TestDept" };

beforeEach(() => request.mockReset());
describe("shared Epic root collection", () => {
	it("collects a childless root without a daily root and retains source history", async () => {
		request
			.mockResolvedValueOnce({
				data: { issues: { nodes: [root()], pageInfo } },
			})
			.mockResolvedValueOnce(history());
		const result = await collectEpicScope("token", binding, {
			now: () => new Date(time),
		});
		expect(result.candidates[0]).toMatchObject({
			id: "uuid",
			hasChildIssues: false,
			labels: ["TestDept"],
			episodes: [{ eventUid: `epic_intake:uuid:${time}`, active: true }],
		});
		expect(result.fetchedAt).toBe(time);
		expect(request.mock.calls[0][1].filter).not.toHaveProperty("children");
		expect(request.mock.calls[0][0]).toContain("includeArchived: true");
	});
	it("uses an overlapped change window without a state filter and rereads pending IDs", async () => {
		request
			.mockResolvedValueOnce({ data: { issues: { nodes: [], pageInfo } } })
			.mockResolvedValueOnce({ data: { issue: root() } })
			.mockResolvedValueOnce(history());
		const result = await collectEpicScope("token", binding, {
			now: () => new Date(time),
			lastSuccessfulScanStartedAt: time,
			pendingIssueIds: ["uuid"],
		});
		expect(request.mock.calls[0][1].filter).toMatchObject({
			updatedAt: { gte: "2026-09-14T19:58:00.000Z" },
		});
		expect(request.mock.calls[0][1].filter).not.toHaveProperty("state");
		expect(result.candidates).toHaveLength(1);
	});
	it("isolates incomplete and repeated history pagination", async () => {
		request
			.mockResolvedValueOnce({
				data: { issues: { nodes: [root()], pageInfo } },
			})
			.mockResolvedValue(history(true, "again"));
		expect(await collectEpicScope("token", binding)).toMatchObject({
			candidates: [],
			historyFailures: [
				{ issueUuid: "uuid", reason: "intake_history_unavailable" },
			],
		});
	});
	it.each(["empty", "malformed", "mismatch", "upstream"])(
		"isolates %s history while healthy page/dependency scope survives",
		async (kind) => {
			const bad = history();
			if (kind === "empty") bad.data.issue.stateHistory.nodes = [];
			if (kind === "malformed")
				bad.data.issue.stateHistory.nodes[0]!.startedAt = "invalid";
			if (kind === "mismatch")
				bad.data.issue.stateHistory.nodes[0]!.state.type = "completed";
			request.mockResolvedValueOnce({
				data: {
					issues: {
						nodes: [root(), { ...root(), id: "healthy", identifier: "TEST-2" }],
						pageInfo,
					},
				},
			});
			if (kind === "upstream")
				request.mockRejectedValueOnce(new Error("unavailable"));
			else request.mockResolvedValueOnce(bad);
			request.mockResolvedValueOnce(history());
			const scope = await collectEpicScope("token", binding);
			expect(scope.historyFailures).toEqual([
				{
					issueUuid: "uuid",
					identifier: "TEST-1",
					reason: "intake_history_unavailable",
				},
			]);
			expect(scope.missingIssueIds).toEqual([]);
			expect(scope.candidates.map((r) => r.id)).toEqual(["healthy"]);
			request.mockResolvedValueOnce({
				data: { issue: { children: { nodes: [], pageInfo } } },
			});
			const snapshot = await fetchLinearActiveScopeSnapshot("token", binding, {
				collectedScope: scope,
				hasProjectDispatch: () => false,
			});
			expect(snapshot.roots.map((r) => r.id)).toEqual(["healthy"]);
		},
	);

	it("rejects GraphQL errors even with partial data", async () => {
		request.mockResolvedValue({
			errors: [{ message: "limited" }],
			data: { issues: { nodes: [], pageInfo } },
		});
		await expect(collectEpicScope("token", binding)).rejects.toThrow();
	});
	it("never treats unreadable child evidence as zero", async () => {
		request.mockResolvedValueOnce({
			data: {
				issues: { nodes: [{ ...root(), children: undefined }], pageInfo },
			},
		});
		await expect(collectEpicScope("token", binding)).rejects.toThrow();
	});
	it.each(["Entity not found: Issue", "Issue could not be found"])(
		"classifies SDK lookup error %s as missing without losing healthy roots",
		async (message) => {
			request
				.mockResolvedValueOnce({
					data: { issues: { nodes: [root()], pageInfo } },
				})
				.mockRejectedValueOnce(new Error(message))
				.mockResolvedValueOnce(history());
			const scope = await collectEpicScope("token", binding, {
				pendingIssueIds: ["deleted"],
			});
			expect(scope.missingIssueIds).toEqual(["deleted"]);
			expect(scope.candidates.map((candidate) => candidate.id)).toEqual([
				"uuid",
			]);
		},
	);
	it.each(["Rate limited", "Unauthorized", "Linear API timeout"])(
		"keeps %s lookup failures retryable instead of declaring a root missing",
		async (message) => {
			request
				.mockResolvedValueOnce({ data: { issues: { nodes: [], pageInfo } } })
				.mockRejectedValueOnce(new Error(message));
			await expect(
				collectEpicScope("token", binding, { pendingIssueIds: ["unknown"] }),
			).rejects.toThrow(message);
		},
	);

	it("records missing pending roots for invalidation", async () => {
		request
			.mockResolvedValueOnce({ data: { issues: { nodes: [], pageInfo } } })
			.mockResolvedValueOnce({ data: { issue: null } });
		expect(
			(
				await collectEpicScope("token", binding, {
					pendingIssueIds: ["deleted"],
				})
			).missingIssueIds,
		).toEqual(["deleted"]);
	});
});

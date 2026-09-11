import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchLinearAttentionIssueMetadata,
	fetchLinearFounderReviewAttention,
} from "../linear-attention-query.js";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({ client: { rawRequest } })),
}));
const binding = { team: "FLY", project: "Flywheel", label: "scope" };
const issue = (n = 1) => ({
	id: `uuid-${n}`,
	identifier: `FLY-${n}`,
	title: "待确认事项",
	url: `https://linear.app/test/issue/FLY-${n}`,
	state: { type: "backlog" },
	team: { key: "FLY" },
	project: { name: "Flywheel" },
	labels: {
		nodes: [{ name: "scope" }, { name: "founder-review" }],
		pageInfo: { hasNextPage: false },
	},
});
const page = (
	nodes: ReturnType<typeof issue>[],
	hasNextPage = false,
	endCursor: string | null = null,
) => ({ data: { issues: { nodes, pageInfo: { hasNextPage, endCursor } } } });
beforeEach(() => {
	vi.useRealTimers();
	rawRequest.mockReset();
});
describe("independent Linear attention query", () => {
	it("reads two pages with AND scope and founder label and no Epic constraints", async () => {
		rawRequest
			.mockResolvedValueOnce(page([issue()], true, "next"))
			.mockResolvedValueOnce(page([issue(2)]));
		const result = await fetchLinearFounderReviewAttention("key", binding);
		expect(result.missing).toBeNull();
		expect(result.items.map((x) => x.identifier)).toEqual(["FLY-1", "FLY-2"]);
		const [query, variables] = rawRequest.mock.calls[0];
		expect(query).toContain("first: 50");
		expect(query).toContain("includeArchived: false");
		expect(query).not.toMatch(/assignee|creator|description|children|parent/);
		expect(variables.filter).toEqual({
			and: [
				{ team: { key: { eq: "FLY" } } },
				{ project: { name: { eq: "Flywheel" } } },
				{ labels: { name: { eq: "scope" } } },
				{ labels: { name: { eq: "founder-review" } } },
				{ state: { type: { nin: ["completed", "canceled"] } } },
			],
		});
		expect(rawRequest.mock.calls[1][1].after).toBe("next");
	});
	it("distinguishes successful empty from upstream failure without leaking errors", async () => {
		rawRequest.mockResolvedValueOnce(page([]));
		expect(
			(await fetchLinearFounderReviewAttention("key", binding)).missing,
		).toBeNull();
		rawRequest.mockRejectedValueOnce(new Error("secret token"));
		const result = await fetchLinearFounderReviewAttention("key", binding);
		expect(result.missing?.reason).toBe("source_unavailable");
		expect(JSON.stringify(result)).not.toContain("secret");
	});
	it.each(["missing_cursor", "error", "graphql_error", "repeated_cursor"])(
		"retains partial records on %s",
		async (failure) => {
			rawRequest.mockResolvedValueOnce(
				page([issue()], true, failure === "missing_cursor" ? null : "next"),
			);
			if (failure === "error")
				rawRequest.mockRejectedValueOnce(new Error("bad"));
			if (failure === "graphql_error")
				rawRequest.mockResolvedValueOnce({
					errors: [{ message: "bad" }],
					...page([issue(2)]),
				});
			if (failure === "repeated_cursor")
				rawRequest.mockResolvedValueOnce(page([], true, "next"));
			const result = await fetchLinearFounderReviewAttention("key", binding);
			expect(result.items).toHaveLength(1);
			expect(result.missing?.reason).toBe("source_unavailable");
		},
	);
	it("enforces raw cap before deduplication and detects more at the boundary", async () => {
		rawRequest.mockResolvedValue(
			page(
				Array.from({ length: 50 }, () => issue()),
				true,
				"cursor",
			),
		);
		let cursor = 0;
		rawRequest.mockImplementation(async () =>
			page(
				Array.from({ length: 50 }, () => issue()),
				true,
				`c${cursor++}`,
			),
		);
		const result = await fetchLinearFounderReviewAttention("key", binding);
		expect(rawRequest).toHaveBeenCalledTimes(20);
		expect(result.rawCount).toBe(1000);
		expect(result.items).toHaveLength(1);
		expect(result.missing?.reason).toBe("source_truncated");
	});
	it("detects the 1001st raw record even if upstream claims no next page", async () => {
		rawRequest.mockResolvedValue(
			page(
				Array.from({ length: 1001 }, (_, i) => issue(i)),
				false,
			),
		);
		const result = await fetchLinearFounderReviewAttention("key", binding);
		expect(result.items).toHaveLength(1000);
		expect(result.missing?.reason).toBe("source_truncated");
	});
	it("enforces the 15 second deadline on an unresponsive request", async () => {
		vi.useFakeTimers();
		rawRequest.mockImplementation(() => new Promise(() => {}));
		const pending = fetchLinearFounderReviewAttention("key", binding);
		await vi.advanceTimersByTimeAsync(15000);
		expect((await pending).missing).toEqual({
			reason: "source_unavailable",
			detail: "deadline_exceeded",
		});
		vi.useRealTimers();
	});
	it("rejects cross-project, terminal, missing label and truncated labels", async () => {
		for (const node of [
			{ ...issue(), project: { name: "Other" } },
			{ ...issue(), state: { type: "completed" } },
			{ ...issue(), labels: { nodes: [], pageInfo: { hasNextPage: false } } },
			{
				...issue(),
				labels: { ...issue().labels, pageInfo: { hasNextPage: true } },
			},
		]) {
			rawRequest.mockResolvedValueOnce(page([node]));
			const result = await fetchLinearFounderReviewAttention("key", binding);
			expect(result.items).toEqual([]);
			expect(result.missing).not.toBeNull();
		}
	});
	it("batch resolves UUID and identifier within the same project, including terminal metadata", async () => {
		rawRequest.mockResolvedValueOnce(
			page([{ ...issue(), state: { type: "completed" } }]),
		);
		const result = await fetchLinearAttentionIssueMetadata("key", binding, [
			"uuid-1",
			"FLY-1",
			"OTHER-2",
		]);
		expect(result.items).toHaveLength(1);
		expect(result.missing).toBeNull();
		const filter = rawRequest.mock.calls[0][1].filter;
		expect(filter.and).toContainEqual({
			project: { name: { eq: "Flywheel" } },
		});
		expect(JSON.stringify(filter)).not.toContain("founder-review");
		expect(JSON.stringify(filter)).not.toContain("completed");
		expect(filter.and.at(-1)).toEqual({
			or: [{ id: { in: ["uuid-1"] } }, { number: { in: [1] } }],
		});
	});
	it("does not query for empty metadata identities", async () => {
		expect(
			(await fetchLinearAttentionIssueMetadata("key", binding, [])).items,
		).toEqual([]);
		expect(rawRequest).not.toHaveBeenCalled();
	});
	it("accepts exactly 1000 raw records when pagination proves completion", async () => {
		let calls = 0;
		rawRequest.mockImplementation(async () => {
			calls++;
			return page(
				Array.from({ length: 50 }, (_, n) => issue((calls - 1) * 50 + n)),
				calls < 20,
				`c${calls}`,
			);
		});
		const result = await fetchLinearFounderReviewAttention("key", binding);
		expect(result.rawCount).toBe(1000);
		expect(result.items).toHaveLength(1000);
		expect(result.missing).toBeNull();
	});
	it("uses one deadline across pages and preserves the first page on expiry", async () => {
		let clock = 0;
		rawRequest.mockImplementation(async () => {
			clock = 15000;
			return page([issue()], true, "next");
		});
		const result = await fetchLinearFounderReviewAttention("key", binding, {
			now: () => new Date(clock),
		});
		expect(result.items).toHaveLength(1);
		expect(result.missing?.detail).toBe("deadline_exceeded");
		expect(rawRequest).toHaveBeenCalledTimes(1);
	});
	it("marks a final page incomplete when its response crosses the total deadline", async () => {
		let clock = 0;
		rawRequest.mockImplementation(async () => {
			clock = 15001;
			return page([issue()]);
		});
		const result = await fetchLinearFounderReviewAttention("key", binding, {
			now: () => new Date(clock),
		});
		expect(result.missing).toEqual({
			reason: "source_unavailable",
			detail: "deadline_exceeded",
		});
		expect(result.items).toHaveLength(1);
		expect(rawRequest).toHaveBeenCalledTimes(1);
	});
	it("never returns unrequested metadata or another project's title", async () => {
		for (const node of [issue(2), { ...issue(), project: { name: "Other" } }]) {
			rawRequest.mockResolvedValueOnce(page([node]));
			const result = await fetchLinearAttentionIssueMetadata("key", binding, [
				"FLY-1",
			]);
			expect(result.items).toEqual([]);
			expect(result.missing?.detail).toBe("boundary_mismatch");
		}
	});
});

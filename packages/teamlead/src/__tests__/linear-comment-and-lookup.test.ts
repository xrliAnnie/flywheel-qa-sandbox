/**
 * FLY-967 (contract: FLY-545 plan §5.3/P12, first-to-land builds): the two
 * voice-bridge landing routes —
 *   POST /api/linear/comment      — meeting summary onto the kickoff issue
 *   GET  /api/linear/issue?query= — precise read-only lookup (identifier exact
 *                                   match first; keyword → small stable list)
 * Test form mirrors create-issue.test.ts / linear-issues.test.ts.
 */

import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const mockIssueFn = vi.fn();
const mockCreateComment = vi.fn();
const mockRawRequest = vi.fn();

vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({
		issue: mockIssueFn,
		createComment: mockCreateComment,
		client: { rawRequest: mockRawRequest },
	})),
}));

const testProjects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [{ agentId: "eng", chatChannel: "c", match: { labels: ["Eng"] } }],
		linear: { team: "FLY", project: "Flywheel", label: "Flywheel" },
	},
];

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "eng",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		...overrides,
	};
}

const ISSUE_NODE = {
	id: "uuid-967",
	identifier: "FLY-967",
	title: "voice assistant",
	description: "desc",
	priority: 2,
	priorityLabel: "High",
	url: "https://linear.app/test/issue/FLY-967",
	createdAt: "2026-07-01T00:00:00.000Z",
	updatedAt: "2026-07-07T00:00:00.000Z",
	state: { name: "In Progress", type: "started" },
	labels: { nodes: [{ name: "Flywheel" }] },
	assignee: { name: "runner" },
	project: { name: "Flywheel" },
};

const FOREIGN_NODE = {
	...ISSUE_NODE,
	id: "uuid-geo",
	identifier: "GEO-5",
	labels: { nodes: [{ name: "GeoForge3D" }] },
	project: { name: "GeoForge3D" },
};

/** rawRequest router: IssueByIdentifier vs ListIssues, by query text. */
function routeRawRequest(opts: {
	exact?: typeof ISSUE_NODE | null;
	list?: (typeof ISSUE_NODE)[];
}) {
	mockRawRequest.mockImplementation(async (query: string) => {
		if (query.includes("IssueByIdentifier")) {
			return { data: { issue: opts.exact ?? null } };
		}
		return {
			data: {
				issues: {
					nodes: opts.list ?? [],
					pageInfo: { hasNextPage: false, endCursor: null },
				},
			},
		};
	});
}

async function startApp(config: BridgeConfig) {
	const store = await StateStore.create(":memory:");
	const app = createBridgeApp(store, testProjects, config);
	const server: http.Server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return { store, server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("voice-bridge landing routes (FLY-967 / 545 P12)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		mockIssueFn.mockReset();
		mockCreateComment.mockReset();
		mockRawRequest.mockReset();
		({ store, server, baseUrl } = await startApp(
			makeConfig({ linearApiKey: "test-linear-key", apiToken: "test-token" }),
		));
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		store.close();
	});

	function postComment(body: Record<string, unknown>, token = "test-token") {
		return fetch(`${baseUrl}/api/linear/comment`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
		});
	}

	function getIssue(qs: string, token = "test-token") {
		return fetch(`${baseUrl}/api/linear/issue?${qs}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
	}

	// ---- POST /api/linear/comment ----

	it("comment: rejects a bad bearer token", async () => {
		const res = await postComment({ issueId: "FLY-967", body: "hi" }, "wrong");
		expect(res.status).toBe(401);
	});

	it("comment: 400 when issueId or body is missing/blank", async () => {
		expect((await postComment({ body: "hi" })).status).toBe(400);
		expect((await postComment({ issueId: "FLY-967" })).status).toBe(400);
		expect(
			(await postComment({ issueId: "FLY-967", body: "   " })).status,
		).toBe(400);
	});

	it("comment: 404 when the issue does not exist (explicit, not opaque)", async () => {
		routeRawRequest({ exact: null });
		const res = await postComment({ issueId: "FLY-99999", body: "summary" });
		expect(res.status).toBe(404);
		const data = await res.json();
		expect(data.error).toContain("FLY-99999");
		expect(mockCreateComment).not.toHaveBeenCalled();
	});

	it("comment: resolves identifier → UUID and creates the comment", async () => {
		routeRawRequest({ exact: ISSUE_NODE });
		mockCreateComment.mockResolvedValue({
			comment: Promise.resolve({ id: "cmt-1", url: "https://l/c/1" }),
		});
		const res = await postComment({
			issueId: "FLY-967",
			body: "## 会议纪要\n…",
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.ok).toBe(true);
		expect(data.comment).toEqual({ id: "cmt-1", url: "https://l/c/1" });
		expect(mockCreateComment).toHaveBeenCalledWith({
			issueId: "uuid-967",
			body: "## 会议纪要\n…",
		});
	});

	it("comment: 502 when Linear createComment fails", async () => {
		routeRawRequest({ exact: ISSUE_NODE });
		mockCreateComment.mockRejectedValue(new Error("boom"));
		const res = await postComment({ issueId: "FLY-967", body: "x" });
		expect(res.status).toBe(502);
	});

	it("comment: projectName scopes the write — out-of-scope issue is 403 (Codex R1)", async () => {
		routeRawRequest({ exact: FOREIGN_NODE });
		mockCreateComment.mockResolvedValue({
			comment: Promise.resolve({ id: "cmt-x", url: "u" }),
		});
		const res = await postComment({
			issueId: "GEO-5",
			body: "x",
			projectName: "flywheel",
		});
		expect(res.status).toBe(403);
		expect(mockCreateComment).not.toHaveBeenCalled();
	});

	it("comment: projectName + in-scope issue passes", async () => {
		routeRawRequest({ exact: ISSUE_NODE });
		mockCreateComment.mockResolvedValue({
			comment: Promise.resolve({ id: "cmt-1", url: "u" }),
		});
		const res = await postComment({
			issueId: "FLY-967",
			body: "纪要",
			projectName: "flywheel",
		});
		expect(res.status).toBe(200);
		expect(mockCreateComment).toHaveBeenCalledWith({
			issueId: "uuid-967",
			body: "纪要",
		});
	});

	// ---- GET /api/linear/issue ----

	it("lookup: rejects a bad bearer token", async () => {
		expect((await getIssue("query=FLY-967", "wrong")).status).toBe(401);
	});

	it("lookup: 400 when query is missing or blank", async () => {
		expect((await getIssue("")).status).toBe(400);
		expect((await getIssue("query=%20%20")).status).toBe(400);
	});

	it("lookup: identifier exact match is its own first branch (single issue)", async () => {
		routeRawRequest({ exact: ISSUE_NODE });
		const res = await getIssue("query=FLY-967");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.matchType).toBe("identifier");
		expect(data.issue).toMatchObject({
			identifier: "FLY-967",
			title: "voice assistant",
			state: "In Progress",
			url: "https://linear.app/test/issue/FLY-967",
		});
		// exact branch only — no keyword list query issued
		expect(mockRawRequest).toHaveBeenCalledTimes(1);
	});

	it("lookup: exact hit outside the named project scope is a miss, not a leak (Codex R1)", async () => {
		routeRawRequest({ exact: FOREIGN_NODE, list: [] });
		const res = await getIssue("query=GEO-5&projectName=flywheel");
		expect(res.status).toBe(404); // fell through to the scoped keyword search
	});

	it("lookup: exact hit inside the named scope returns the single issue", async () => {
		routeRawRequest({ exact: ISSUE_NODE });
		const res = await getIssue("query=FLY-967&projectName=flywheel");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.matchType).toBe("identifier");
	});

	it("lookup: identifier-shaped miss falls through to keyword search", async () => {
		routeRawRequest({ exact: null, list: [ISSUE_NODE] });
		const res = await getIssue("query=FLY-424242");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.matchType).toBe("keyword");
		expect(data.issues).toHaveLength(1);
	});

	it("lookup: keyword returns a small best-match list (ambiguity is explicit, not an error)", async () => {
		const second = { ...ISSUE_NODE, id: "uuid-2", identifier: "FLY-545" };
		routeRawRequest({ list: [ISSUE_NODE, second] });
		const res = await getIssue("query=voice&limit=2");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.matchType).toBe("keyword");
		expect(data.count).toBe(2);
		expect(
			data.issues.map((i: { identifier: string }) => i.identifier),
		).toEqual(["FLY-967", "FLY-545"]);
		// keyword filter shape: title containsIgnoreCase, bounded first
		const [query, vars] = mockRawRequest.mock.calls[0] as [
			string,
			{ filter: Record<string, unknown>; first: number },
		];
		expect(query).toContain("ListIssues");
		expect(vars.filter.title).toEqual({ containsIgnoreCase: "voice" });
		expect(vars.first).toBe(2);
	});

	it("lookup: 404 with the query echoed when nothing matches", async () => {
		routeRawRequest({ list: [] });
		const res = await getIssue("query=nonexistent-topic");
		expect(res.status).toBe(404);
		const data = await res.json();
		expect(data.error).toContain("nonexistent-topic");
	});

	it("lookup: projectName binding scopes the keyword search (FLY-371)", async () => {
		routeRawRequest({ list: [ISSUE_NODE] });
		const res = await getIssue("query=voice&projectName=flywheel");
		expect(res.status).toBe(200);
		const [, vars] = mockRawRequest.mock.calls[0] as [
			string,
			{ filter: Record<string, unknown> },
		];
		expect(vars.filter.project).toEqual({ name: { eq: "Flywheel" } });
		expect(vars.filter.labels).toEqual({ name: { eq: "Flywheel" } });
	});

	it("lookup: unknown projectName fails loud (404)", async () => {
		const res = await getIssue("query=voice&projectName=nope");
		expect(res.status).toBe(404);
	});
});

describe("voice-bridge landing routes without LINEAR_API_KEY", () => {
	it("both routes return 501", async () => {
		const { store, server, baseUrl } = await startApp(
			makeConfig({ apiToken: "test-token" }),
		);
		try {
			const c = await fetch(`${baseUrl}/api/linear/comment`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify({ issueId: "FLY-1", body: "x" }),
			});
			expect(c.status).toBe(501);
			const g = await fetch(`${baseUrl}/api/linear/issue?query=FLY-1`, {
				headers: { Authorization: "Bearer test-token" },
			});
			expect(g.status).toBe(501);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			store.close();
		}
	});
});

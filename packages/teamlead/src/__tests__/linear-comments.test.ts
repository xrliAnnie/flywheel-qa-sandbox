/**
 * FLY-1160 (plan §3.3 读口): GET /api/linear/comments — read-only, paged
 * comments list for landing reconciliation. An aborted/crashed landing re-run
 * scans for its deterministic stage markers (assistant-summary <sessionId> /
 * transcript chunk markers) instead of blind re-posting. Scoped like the
 * comment WRITE path: a named project binding must contain the issue.
 */

import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const mockRawRequest = vi.fn();

vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({
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
	id: "uuid-1160",
	identifier: "FLY-1160",
	title: "resident voice brain",
	description: "desc",
	priority: 2,
	priorityLabel: "High",
	url: "https://linear.app/test/issue/FLY-1160",
	createdAt: "2026-07-01T00:00:00.000Z",
	updatedAt: "2026-07-11T00:00:00.000Z",
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

const COMMENTS_PAGE = {
	nodes: [
		{
			id: "c1",
			body: "assistant-summary sess-abc\n纪要正文",
			createdAt: "2026-07-11T01:00:00.000Z",
		},
		{
			id: "c2",
			body: "assistant-transcript sess-abc chunk 1/2",
			createdAt: "2026-07-11T01:01:00.000Z",
		},
	],
	pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
};

function routeRawRequest(opts: {
	exact?: typeof ISSUE_NODE | null;
	comments?: typeof COMMENTS_PAGE | null;
}) {
	mockRawRequest.mockImplementation(async (query: string) => {
		if (query.includes("IssueByIdentifier")) {
			return { data: { issue: opts.exact ?? null } };
		}
		if (query.includes("IssueComments")) {
			if (opts.comments === null) return { data: { issue: null } };
			return {
				data: {
					issue: { id: opts.exact?.id, comments: opts.comments },
				},
			};
		}
		throw new Error(`unexpected query: ${query.slice(0, 60)}`);
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

describe("GET /api/linear/comments (FLY-1160 §3.3 读口)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		mockRawRequest.mockReset();
		({ store, server, baseUrl } = await startApp(
			makeConfig({ linearApiKey: "test-linear-key", apiToken: "test-token" }),
		));
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		store.close();
	});

	function getComments(qs: string, token = "test-token") {
		return fetch(`${baseUrl}/api/linear/comments?${qs}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
	}

	it("rejects a bad bearer token", async () => {
		const res = await getComments("issueId=FLY-1160", "wrong");
		expect(res.status).toBe(401);
	});

	it("requires issueId", async () => {
		const res = await getComments("");
		expect(res.status).toBe(400);
	});

	it("404 on an unknown issue", async () => {
		routeRawRequest({ exact: null });
		const res = await getComments("issueId=FLY-9999");
		expect(res.status).toBe(404);
	});

	it("403 when the named project binding does not contain the issue", async () => {
		routeRawRequest({ exact: FOREIGN_NODE, comments: COMMENTS_PAGE });
		const res = await getComments("issueId=GEO-5&projectName=flywheel");
		expect(res.status).toBe(403);
	});

	it("returns the comments page with pagination info (marker bodies intact)", async () => {
		routeRawRequest({ exact: ISSUE_NODE, comments: COMMENTS_PAGE });
		const res = await getComments("issueId=FLY-1160&projectName=flywheel");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			issueId: string;
			comments: { id: string; body: string; createdAt: string }[];
			hasNextPage: boolean;
			endCursor: string | null;
		};
		expect(body.issueId).toBe("FLY-1160");
		expect(body.comments).toHaveLength(2);
		expect(body.comments[0].body).toContain("assistant-summary sess-abc");
		expect(body.hasNextPage).toBe(true);
		expect(body.endCursor).toBe("cursor-2");
	});

	it("passes the after cursor through to the Linear query", async () => {
		routeRawRequest({ exact: ISSUE_NODE, comments: COMMENTS_PAGE });
		const res = await getComments(
			"issueId=FLY-1160&projectName=flywheel&after=cursor-2&limit=10",
		);
		expect(res.status).toBe(200);
		const commentsCall = mockRawRequest.mock.calls.find(([q]) =>
			String(q).includes("IssueComments"),
		);
		expect(commentsCall?.[1]).toMatchObject({ after: "cursor-2", first: 10 });
	});

	it("501 when LINEAR_API_KEY is not configured", async () => {
		const bare = await startApp(makeConfig({ apiToken: "test-token" }));
		try {
			const res = await fetch(
				`${bare.baseUrl}/api/linear/comments?issueId=FLY-1160`,
				{ headers: { Authorization: "Bearer test-token" } },
			);
			expect(res.status).toBe(501);
		} finally {
			await new Promise<void>((r) => bare.server.close(() => r()));
			bare.store.close();
		}
	});
});

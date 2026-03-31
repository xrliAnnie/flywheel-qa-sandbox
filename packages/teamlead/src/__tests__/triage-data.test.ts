/**
 * FLY-21: Combined triage data endpoint tests.
 * Exercises GET /api/triage/data.
 */

import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const mockRawRequest = vi.fn();

vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({
		client: {
			rawRequest: mockRawRequest,
		},
	})),
}));

const testProjects: ProjectEntry[] = [
	{
		projectName: "TestProject",
		projectRoot: "/tmp/test-project",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-forum",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
		],
	},
];

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		maxConcurrentRunners: 3,
		...overrides,
	};
}

function mockLinearResponse(
	nodes: Array<Record<string, unknown>> = [],
	hasNextPage = false,
) {
	return {
		data: {
			issues: {
				nodes,
				pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor-1" : null },
			},
		},
	};
}

const sampleIssue = {
	id: "issue-1",
	identifier: "GEO-280",
	title: "Sprint closing",
	priority: 2,
	priorityLabel: "High",
	url: "https://linear.app/test/issue/GEO-280",
	createdAt: "2026-03-20T00:00:00.000Z",
	updatedAt: "2026-03-28T00:00:00.000Z",
	state: { name: "Backlog", type: "backlog" },
	labels: { nodes: [{ name: "Product" }] },
	assignee: { name: "Alice" },
};

describe("GET /api/triage/data (FLY-21)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		mockRawRequest.mockReset();
		store = await StateStore.create(":memory:");
		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig({ linearApiKey: "test-linear-key", apiToken: "test-token" }),
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	});

	it("returns 501 when LINEAR_API_KEY not configured", async () => {
		const noKeyApp = createBridgeApp(
			store,
			testProjects,
			makeConfig({ apiToken: "test-token" }),
		);
		const noKeyServer = noKeyApp.listen(0, "127.0.0.1");
		await new Promise<void>((r) => noKeyServer.once("listening", r));
		const addr = noKeyServer.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;

		const res = await fetch(`http://127.0.0.1:${port}/api/triage/data`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(501);

		await new Promise<void>((r) => noKeyServer.close(() => r()));
	});

	it("returns combined issues + sessions + capacity", async () => {
		mockRawRequest.mockResolvedValueOnce(
			mockLinearResponse([sampleIssue], false),
		);

		const res = await fetch(`${baseUrl}/api/triage/data?project=TestProject`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			issues: Array<Record<string, unknown>>;
			issueCount: number;
			truncated: boolean;
			sessions: Array<Record<string, unknown>>;
			sessionCount: number;
			capacity: {
				running: number;
				inflight: number;
				total: number;
				max: number;
			};
		};

		expect(body.issueCount).toBe(1);
		expect(body.truncated).toBe(false);
		expect(body.issues[0].identifier).toBe("GEO-280");
		expect(body.sessions).toEqual([]);
		expect(body.sessionCount).toBe(0);
		expect(body.capacity.max).toBe(3);
		expect(body.capacity.running).toBe(0);
		expect(body.capacity.total).toBe(0);
	});

	it("includes description by default (slim not forced)", async () => {
		mockRawRequest.mockResolvedValueOnce(mockLinearResponse([sampleIssue]));

		await fetch(`${baseUrl}/api/triage/data?project=TestProject`, {
			headers: { Authorization: "Bearer test-token" },
		});

		// Verify GraphQL query includes 'description'
		const query = mockRawRequest.mock.calls[0][0] as string;
		expect(query).toContain("description");
	});

	it("omits description when slim=true is passed", async () => {
		mockRawRequest.mockResolvedValueOnce(
			mockLinearResponse([{ ...sampleIssue, description: undefined }]),
		);

		await fetch(`${baseUrl}/api/triage/data?project=TestProject&slim=true`, {
			headers: { Authorization: "Bearer test-token" },
		});

		const query = mockRawRequest.mock.calls[0][0] as string;
		expect(query).not.toContain("description");
	});

	it("defaults state filter to backlog,unstarted,started", async () => {
		mockRawRequest.mockResolvedValueOnce(mockLinearResponse());

		await fetch(`${baseUrl}/api/triage/data?project=TestProject`, {
			headers: { Authorization: "Bearer test-token" },
		});

		const variables = mockRawRequest.mock.calls[0][1] as {
			filter: Record<string, unknown>;
		};
		expect(variables.filter.state).toEqual({
			type: { in: ["backlog", "unstarted", "started"] },
		});
	});

	it("defaults limit to 100", async () => {
		mockRawRequest.mockResolvedValueOnce(mockLinearResponse());

		await fetch(`${baseUrl}/api/triage/data?project=TestProject`, {
			headers: { Authorization: "Bearer test-token" },
		});

		const variables = mockRawRequest.mock.calls[0][1] as {
			first: number;
		};
		expect(variables.first).toBe(100);
	});

	it("passes custom state filter through", async () => {
		mockRawRequest.mockResolvedValueOnce(mockLinearResponse());

		await fetch(
			`${baseUrl}/api/triage/data?project=TestProject&state=started`,
			{ headers: { Authorization: "Bearer test-token" } },
		);

		const variables = mockRawRequest.mock.calls[0][1] as {
			filter: Record<string, unknown>;
		};
		expect(variables.filter.state).toEqual({ type: { eq: "started" } });
	});

	it("returns 502 when Linear API fails", async () => {
		mockRawRequest.mockRejectedValueOnce(new Error("API down"));

		const res = await fetch(`${baseUrl}/api/triage/data?project=TestProject`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(502);
	});

	it("includes active sessions in response", async () => {
		// Insert a running session
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			issue_identifier: "GEO-280",
			project_name: "TestProject",
			status: "running",
			labels: "Product",
		});

		mockRawRequest.mockResolvedValueOnce(mockLinearResponse([sampleIssue]));

		const res = await fetch(`${baseUrl}/api/triage/data?project=TestProject`, {
			headers: { Authorization: "Bearer test-token" },
		});
		const body = (await res.json()) as {
			sessionCount: number;
			sessions: Array<{ identifier: string }>;
			capacity: { running: number };
		};

		expect(body.sessionCount).toBe(1);
		expect(body.sessions[0].identifier).toBe("GEO-280");
		expect(body.capacity.running).toBe(1);
	});
});

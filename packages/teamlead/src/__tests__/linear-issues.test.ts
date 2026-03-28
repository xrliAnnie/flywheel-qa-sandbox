/**
 * GEO-276: Linear issues query endpoint tests.
 * Exercises GET /api/linear/issues.
 */

import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

// Capture rawRequest calls for assertion
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
		maxConcurrentRunners: 2,
		...overrides,
	};
}

// Standard mock response
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
	title: "Sprint 收尾",
	description: "Background...",
	priority: 2,
	priorityLabel: "High",
	url: "https://linear.app/test/issue/GEO-280",
	createdAt: "2026-03-20T00:00:00.000Z",
	updatedAt: "2026-03-28T00:00:00.000Z",
	state: { name: "Backlog", type: "backlog" },
	labels: { nodes: [{ name: "Product" }] },
	assignee: { name: "Alice" },
};

describe("GET /api/linear/issues (GEO-276)", () => {
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

	// 1. No LINEAR_API_KEY → 501
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

		const res = await fetch(`http://127.0.0.1:${port}/api/linear/issues`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(501);

		await new Promise<void>((r) => noKeyServer.close(() => r()));
	});

	// 2. No params → returns issues with count + truncated
	it("returns issues with count and truncated fields", async () => {
		mockRawRequest.mockResolvedValueOnce(
			mockLinearResponse([sampleIssue], false),
		);

		const res = await fetch(`${baseUrl}/api/linear/issues`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			issues: Array<Record<string, unknown>>;
			count: number;
			truncated: boolean;
		};
		expect(body.count).toBe(1);
		expect(body.truncated).toBe(false);
		expect(body.issues[0].identifier).toBe("GEO-280");
		expect(body.issues[0].state).toBe("Backlog");
		expect(body.issues[0].stateType).toBe("backlog");
		expect(body.issues[0].labels).toEqual(["Product"]);
		expect(body.issues[0].assignee).toBe("Alice");
	});

	// 3. project param → filter contains project name eq
	it("passes project filter to rawRequest", async () => {
		mockRawRequest.mockResolvedValueOnce(mockLinearResponse());

		await fetch(`${baseUrl}/api/linear/issues?project=Flywheel`, {
			headers: { Authorization: "Bearer test-token" },
		});

		const variables = mockRawRequest.mock.calls[0][1] as {
			filter: Record<string, unknown>;
		};
		expect(variables.filter.project).toEqual({ name: { eq: "Flywheel" } });
	});

	// 4. state param (single) → filter contains state type eq
	it("passes single state filter", async () => {
		mockRawRequest.mockResolvedValueOnce(mockLinearResponse());

		await fetch(`${baseUrl}/api/linear/issues?state=backlog`, {
			headers: { Authorization: "Bearer test-token" },
		});

		const variables = mockRawRequest.mock.calls[0][1] as {
			filter: Record<string, unknown>;
		};
		expect(variables.filter.state).toEqual({ type: { eq: "backlog" } });
	});

	// 5. state param (multiple) → filter contains state type in
	it("passes multi-state filter with in operator", async () => {
		mockRawRequest.mockResolvedValueOnce(mockLinearResponse());

		await fetch(
			`${baseUrl}/api/linear/issues?state=backlog,unstarted,started`,
			{ headers: { Authorization: "Bearer test-token" } },
		);

		const variables = mockRawRequest.mock.calls[0][1] as {
			filter: Record<string, unknown>;
		};
		expect(variables.filter.state).toEqual({
			type: { in: ["backlog", "unstarted", "started"] },
		});
	});

	// 5b. state param (repeated keys) → Express array normalized
	it("handles Express array params for repeated state keys", async () => {
		mockRawRequest.mockResolvedValueOnce(mockLinearResponse());

		await fetch(
			`${baseUrl}/api/linear/issues?state=backlog&state=started`,
			{ headers: { Authorization: "Bearer test-token" } },
		);

		const variables = mockRawRequest.mock.calls[0][1] as {
			filter: Record<string, unknown>;
		};
		expect(variables.filter.state).toEqual({
			type: { in: ["backlog", "started"] },
		});
	});

	// 6. labels param (single) → filter contains labels name eq
	it("passes single label filter", async () => {
		mockRawRequest.mockResolvedValueOnce(mockLinearResponse());

		await fetch(`${baseUrl}/api/linear/issues?labels=Product`, {
			headers: { Authorization: "Bearer test-token" },
		});

		const variables = mockRawRequest.mock.calls[0][1] as {
			filter: Record<string, unknown>;
		};
		expect(variables.filter.labels).toEqual({ name: { eq: "Product" } });
	});

	// 6b. labels param (repeated keys) → Express array normalized
	it("handles Express array params for repeated labels keys", async () => {
		mockRawRequest.mockResolvedValueOnce(mockLinearResponse());

		await fetch(
			`${baseUrl}/api/linear/issues?labels=Product&labels=Operations`,
			{ headers: { Authorization: "Bearer test-token" } },
		);

		const variables = mockRawRequest.mock.calls[0][1] as {
			filter: Record<string, unknown>;
		};
		expect(variables.filter.or).toEqual([
			{ labels: { name: { eq: "Product" } } },
			{ labels: { name: { eq: "Operations" } } },
		]);
	});

	// 7. labels param (multiple) → filter contains or array
	it("passes multi-label filter with or array", async () => {
		mockRawRequest.mockResolvedValueOnce(mockLinearResponse());

		await fetch(`${baseUrl}/api/linear/issues?labels=Product,Operations`, {
			headers: { Authorization: "Bearer test-token" },
		});

		const variables = mockRawRequest.mock.calls[0][1] as {
			filter: Record<string, unknown>;
		};
		expect(variables.filter.or).toEqual([
			{ labels: { name: { eq: "Product" } } },
			{ labels: { name: { eq: "Operations" } } },
		]);
	});

	// 8. limit param — parseInt + clamp
	it("clamps limit to 1-250 and uses parseInt", async () => {
		mockRawRequest.mockResolvedValue(mockLinearResponse());

		// limit=0 → clamped to 1
		await fetch(`${baseUrl}/api/linear/issues?limit=0`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(
			(mockRawRequest.mock.calls[0][1] as { first: number }).first,
		).toBe(1);

		mockRawRequest.mockClear();

		// limit=1.5 → parseInt → 1
		await fetch(`${baseUrl}/api/linear/issues?limit=1.5`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(
			(mockRawRequest.mock.calls[0][1] as { first: number }).first,
		).toBe(1);

		mockRawRequest.mockClear();

		// limit=abc → NaN → default 50
		await fetch(`${baseUrl}/api/linear/issues?limit=abc`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(
			(mockRawRequest.mock.calls[0][1] as { first: number }).first,
		).toBe(50);

		mockRawRequest.mockClear();

		// limit=999 → clamped to 250
		await fetch(`${baseUrl}/api/linear/issues?limit=999`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(
			(mockRawRequest.mock.calls[0][1] as { first: number }).first,
		).toBe(250);
	});

	// 9. Linear SDK throws → 502
	it("returns 502 when rawRequest throws", async () => {
		mockRawRequest.mockRejectedValueOnce(new Error("Network timeout"));

		const res = await fetch(`${baseUrl}/api/linear/issues`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(502);
	});

	// 10. truncated=true when hasNextPage=true
	it("returns truncated=true when hasNextPage is true", async () => {
		mockRawRequest.mockResolvedValueOnce(
			mockLinearResponse([sampleIssue], true),
		);

		const res = await fetch(`${baseUrl}/api/linear/issues`, {
			headers: { Authorization: "Bearer test-token" },
		});
		const body = (await res.json()) as { truncated: boolean };
		expect(body.truncated).toBe(true);
	});
});

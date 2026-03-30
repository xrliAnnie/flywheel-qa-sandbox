/**
 * GEO-294: POST /api/publish-html integration tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

// Mock @linear/sdk (required by plugin.ts imports)
vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({
		client: { rawRequest: vi.fn() },
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

// ─── HTTP helper ─────────────────────────────────────────────────────

async function makeRequest(
	app: ReturnType<typeof createBridgeApp>,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
	return new Promise((resolve) => {
		const http = require("node:http");
		const server = http.createServer(app);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" ? addr.port : 0;
			const postData = JSON.stringify(body);
			const options = {
				hostname: "127.0.0.1",
				port,
				path: "/api/publish-html",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(postData),
					...headers,
				},
			};
			const req = http.request(
				options,
				(res: {
					statusCode: number;
					on: (e: string, cb: (d?: Buffer) => void) => void;
				}) => {
					let data = "";
					res.on("data", (chunk: Buffer) => {
						data += chunk.toString();
					});
					res.on("end", () => {
						server.close();
						resolve({ status: res.statusCode, body: data });
					});
				},
			);
			req.write(postData);
			req.end();
		});
	});
}

// Mock fetch for Vercel API calls
const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

describe("POST /api/publish-html", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve(""),
		});
		global.fetch = fetchMock as typeof fetch;
	});

	afterEach(() => {
		store.close();
		global.fetch = originalFetch;
	});

	function makeApp(
		vercelToken?: string,
		configOverrides: Partial<BridgeConfig> = {},
	) {
		return createBridgeApp(
			store,
			testProjects,
			makeConfig(configOverrides),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined, // startDispatcher
			undefined, // standupService
			undefined, // standupProjectName
			{ vercelToken },
		);
	}

	it("returns 501 when VERCEL_TOKEN not configured", async () => {
		const app = makeApp(undefined);
		const res = await makeRequest(app, {
			projectName: "TestProject",
			html: "<html>test</html>",
		});
		expect(res.status).toBe(501);
		const body = JSON.parse(res.body);
		expect(body.error).toContain("VERCEL_TOKEN");
	});

	it("returns 400 when projectName missing", async () => {
		const app = makeApp("fake-token");
		const res = await makeRequest(app, { html: "<html>test</html>" });
		expect(res.status).toBe(400);
		const body = JSON.parse(res.body);
		expect(body.error).toContain("projectName");
	});

	it("returns 400 when html missing", async () => {
		const app = makeApp("fake-token");
		const res = await makeRequest(app, { projectName: "TestProject" });
		expect(res.status).toBe(400);
		const body = JSON.parse(res.body);
		expect(body.error).toContain("html");
	});

	it("returns 400 when html is empty string", async () => {
		const app = makeApp("fake-token");
		const res = await makeRequest(app, {
			projectName: "TestProject",
			html: "",
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 when projectName has only special chars", async () => {
		const app = makeApp("fake-token");
		const res = await makeRequest(app, {
			projectName: "!!!",
			html: "<html>test</html>",
		});
		expect(res.status).toBe(400);
		const body = JSON.parse(res.body);
		expect(body.error).toContain("alphanumeric");
	});

	it("sanitizes projectName with spaces and special chars", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: () =>
				Promise.resolve({
					url: "triage-test-project-abc.vercel.app",
					id: "dpl_abc",
					readyState: "READY",
				}),
		});

		const app = makeApp("fake-vercel-token");
		const res = await makeRequest(app, {
			projectName: " Test Project! ",
			html: "<html>test</html>",
		});
		expect(res.status).toBe(200);

		const body = JSON.parse(res.body);
		expect(body.url).toBe("https://triage-test-project.vercel.app");
	});

	it("deploys HTML to Vercel and returns URL", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: () =>
				Promise.resolve({
					url: "triage-testproject-abc.vercel.app",
					id: "dpl_abc",
					readyState: "READY",
				}),
		});

		const app = makeApp("fake-vercel-token");
		const res = await makeRequest(app, {
			projectName: "TestProject",
			html: "<html><body>Hello</body></html>",
		});
		expect(res.status).toBe(200);

		const body = JSON.parse(res.body);
		expect(body.url).toBe("https://triage-testproject.vercel.app");

		// Verify Vercel deploy call
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, opts] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://api.vercel.com/v13/deployments");
		expect(opts.method).toBe("POST");

		const reqBody = JSON.parse(opts.body);
		expect(reqBody.files[0].data).toContain("Hello");
	});

	it("returns 502 on Vercel deploy failure", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 500,
			text: () => Promise.resolve("Internal Server Error"),
		});

		const app = makeApp("fake-vercel-token");
		const res = await makeRequest(app, {
			projectName: "TestProject",
			html: "<html>test</html>",
		});
		expect(res.status).toBe(502);
	});

	it("requires auth when apiToken configured", async () => {
		const app = makeApp("fake-vercel-token", { apiToken: "secret" });
		const res = await makeRequest(app, {
			projectName: "TestProject",
			html: "<html>test</html>",
		});
		expect(res.status).toBe(401);
	});

	it("passes auth when token provided", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: () =>
				Promise.resolve({
					url: "triage-testproject-abc.vercel.app",
					id: "dpl_abc",
					readyState: "READY",
				}),
		});

		const app = makeApp("fake-vercel-token", { apiToken: "secret" });
		const res = await makeRequest(
			app,
			{ projectName: "TestProject", html: "<html>test</html>" },
			{ Authorization: "Bearer secret" },
		);
		expect(res.status).toBe(200);
	});
});

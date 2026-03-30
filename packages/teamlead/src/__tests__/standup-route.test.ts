/**
 * GEO-288: Standup route integration tests (v2).
 * Exercises POST /api/standup/trigger.
 * v2: No scheduler, no markDelivered, pre-configured standupProjectName.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import { StandupService } from "../bridge/standup-service.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

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

function makeService(store: StateStore, channel?: string): StandupService {
	return new StandupService(
		store,
		testProjects,
		"fake-token",
		2,
		15,
		24,
		channel,
		"<@simba>",
	);
}

// Mock Discord fetch globally
const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

describe("POST /api/standup/trigger", () => {
	let store: StateStore;
	let app: ReturnType<typeof createBridgeApp>;

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

	it("returns report on dryRun=true", async () => {
		const service = makeService(store, "standup-channel");

		app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
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
			service,
			"TestProject",
		);

		const res = await makeRequest(app, { dryRun: true });
		expect(res.status).toBe(200);

		const body = JSON.parse(res.body);
		expect(body.triggered).toBe(true);
		expect(body.delivered).toBe(false);
		expect(body.dryRun).toBe(true);
		expect(body.report).toBeDefined();
		expect(body.report.projectName).toBe("TestProject");
	});

	it("requires auth when apiToken configured", async () => {
		const service = makeService(store, "standup-channel");

		app = createBridgeApp(
			store,
			testProjects,
			makeConfig({ apiToken: "secret" }),
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
			service,
			"TestProject",
		);

		// No auth header
		const res = await makeRequest(app, { dryRun: true });
		expect(res.status).toBe(401);
	});

	it("returns 400 when no STANDUP_CHANNEL and dryRun=false", async () => {
		const service = makeService(store, undefined); // no channel

		app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
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
			service,
			"TestProject",
		);

		const res = await makeRequest(app, { dryRun: false });
		expect(res.status).toBe(400);

		const body = JSON.parse(res.body);
		expect(body.error).toContain("STANDUP_CHANNEL");
	});

	it("delivers to Discord and returns messageCount", async () => {
		const service = makeService(store, "standup-channel");

		app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
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
			service,
			"TestProject",
		);

		const res = await makeRequest(app, { dryRun: false });
		expect(res.status).toBe(200);

		const body = JSON.parse(res.body);
		expect(body.triggered).toBe(true);
		expect(body.delivered).toBe(true);
		expect(body.channelId).toBe("standup-channel");
		expect(body.messageCount).toBeGreaterThanOrEqual(1);

		expect(fetchMock).toHaveBeenCalled();
		const [url] = fetchMock.mock.calls[0]!;
		expect(url).toContain("standup-channel");
	});

	it("uses pre-configured project name (ignores request body)", async () => {
		const service = makeService(store, "standup-channel");

		app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
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
			service,
			"TestProject",
		);

		// Send a different projectName in the request body — should be ignored
		const res = await makeRequest(app, {
			projectName: "OtherProject",
			dryRun: true,
		});
		expect(res.status).toBe(200);

		const body = JSON.parse(res.body);
		// Should use pre-configured "TestProject", not "OtherProject"
		expect(body.report.projectName).toBe("TestProject");
	});

	it("standup route not registered when standupProjectName is undefined", async () => {
		const service = makeService(store, "standup-channel");

		app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
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
			service,
			undefined, // no project name → route not registered
		);

		const res = await makeRequest(app, { dryRun: true });
		// Should get 404 since route is not registered
		expect(res.status).toBe(404);
	});
});

// ─── Test helpers ──────────────────────────────────────────────────

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
				path: "/api/standup/trigger",
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

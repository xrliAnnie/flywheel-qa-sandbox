/**
 * FLY-203: /api/reports plugin-mount integration tests.
 *
 * The auth contract is deliberately DIFFERENT from /api/publish-html
 * (Codex R1#1 + R2#4): no apiToken → 503 (never unauthenticated), because
 * this surface posts as a bot and reads local files.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
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
		runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		...overrides,
	};
}

async function makeRequest(
	app: ReturnType<typeof createBridgeApp>,
	path: string,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
	return new Promise((resolvePromise) => {
		const http = require("node:http");
		const server = http.createServer(app);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" ? addr.port : 0;
			const postData = JSON.stringify(body);
			const req = http.request(
				{
					hostname: "127.0.0.1",
					port,
					path,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(postData),
						...headers,
					},
				},
				(res: {
					statusCode: number;
					on: (e: string, cb: (d?: Buffer) => void) => void;
				}) => {
					let data = "";
					res.on("data", (chunk: Buffer) => {
						data += chunk?.toString() ?? "";
					});
					res.on("end", () => {
						server.close();
						resolvePromise({ status: res.statusCode, body: data });
					});
				},
			);
			req.write(postData);
			req.end();
		});
	});
}

describe("/api/reports mount (plugin layer)", () => {
	let store: StateStore;
	let reportsDir: string;
	const envBackup: Record<string, string | undefined> = {};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		reportsDir = mkdtempSync(join(tmpdir(), "fly203-mount-"));
		envBackup.FLYWHEEL_REPORTS_DIR = process.env.FLYWHEEL_REPORTS_DIR;
		envBackup.FLYWHEEL_REMOTE_REPORTS = process.env.FLYWHEEL_REMOTE_REPORTS;
		process.env.FLYWHEEL_REPORTS_DIR = reportsDir;
		delete process.env.FLYWHEEL_REMOTE_REPORTS;
	});

	afterEach(() => {
		store.close();
		rmSync(reportsDir, { recursive: true, force: true });
		for (const [k, v] of Object.entries(envBackup)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	function makeApp(configOverrides: Partial<BridgeConfig> = {}) {
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
			{ vercelToken: undefined },
		);
	}

	it("no apiToken configured → 503 (never unauthenticated)", async () => {
		const app = makeApp();
		const res = await makeRequest(app, "/api/reports/publish", {
			projectName: "p",
			html: "<html><head></head></html>",
		});
		expect(res.status).toBe(503);
		expect(JSON.parse(res.body).error).toContain("TEAMLEAD_API_TOKEN");
	});

	it("apiToken configured + bad token → 401", async () => {
		const app = makeApp({ apiToken: "secret" });
		const res = await makeRequest(
			app,
			"/api/reports/publish",
			{ projectName: "p", html: "<html><head></head></html>" },
			{ Authorization: "Bearer wrong" },
		);
		expect(res.status).toBe(401);
	});

	it("apiToken configured + good token → reaches router (501 without VERCEL_TOKEN)", async () => {
		const app = makeApp({ apiToken: "secret" });
		const res = await makeRequest(
			app,
			"/api/reports/publish",
			{ projectName: "p", html: "<html><head></head></html>" },
			{ Authorization: "Bearer secret" },
		);
		expect(res.status).toBe(501);
		expect(JSON.parse(res.body).error).toContain("VERCEL_TOKEN");
	});

	it("FLYWHEEL_REMOTE_REPORTS=0 → 503 even with good token", async () => {
		process.env.FLYWHEEL_REMOTE_REPORTS = "0";
		const app = makeApp({ apiToken: "secret" });
		const res = await makeRequest(
			app,
			"/api/reports/deliver",
			{ url: "https://x", projectName: "p" },
			{ Authorization: "Bearer secret" },
		);
		expect(res.status).toBe(503);
		expect(JSON.parse(res.body).error).toContain("disabled");
	});
});

/**
 * FLY-727: /api/digest plugin-mount integration tests.
 *
 * Default-off contract (R3 #1): the digest surface is mounted ONLY when
 * FLYWHEEL_DIGEST_CHANNEL is set. It must NOT silently fall back to
 * FLYWHEEL_TOKEN_USAGE_CHANNEL — a prod deployment with the cost channel already
 * configured must keep /api/digest at 404 (byte-compat).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({
		client: { rawRequest: vi.fn() },
	})),
}));

const testProjects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/test-flywheel",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				forumChannel: "f",
				chatChannel: "c",
				match: { labels: ["Flywheel"] },
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
		defaultLeadAgentId: "flywheel-eng-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		...overrides,
	};
}

function makeApp(store: StateStore) {
	return createBridgeApp(
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
		undefined, // standupService
		undefined, // standupProjectName
		{ vercelToken: undefined },
	);
}

function request(
	app: ReturnType<typeof createBridgeApp>,
	path: string,
	body: Record<string, unknown>,
): Promise<{ status: number; contentType: string; body: string }> {
	return new Promise((done) => {
		const http = require("node:http");
		const server = http.createServer(app);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			const data = JSON.stringify(body);
			const req = http.request(
				{
					host: "127.0.0.1",
					port,
					path,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(data),
					},
				},
				(res: {
					statusCode: number;
					headers: Record<string, string>;
					on: (e: string, cb: (c?: Buffer) => void) => void;
				}) => {
					let out = "";
					res.on("data", (c) => {
						out += c;
					});
					res.on("end", () => {
						server.close();
						done({
							status: res.statusCode,
							contentType: res.headers["content-type"] ?? "",
							body: out,
						});
					});
				},
			);
			req.write(data);
			req.end();
		});
	});
}

describe("/api/digest mount (default-off + sentinel)", () => {
	let store: StateStore;
	const envBackup: Record<string, string | undefined> = {};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		for (const k of [
			"FLYWHEEL_DIGEST_CHANNEL",
			"FLYWHEEL_TOKEN_USAGE_CHANNEL",
		]) {
			envBackup[k] = process.env[k];
			delete process.env[k];
		}
	});
	afterEach(() => {
		store.close();
		for (const [k, v] of Object.entries(envBackup)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	it("unset FLYWHEEL_DIGEST_CHANNEL → /api/digest is 404 (not mounted)", async () => {
		const res = await request(makeApp(store), "/api/digest/render", {});
		expect(res.status).toBe(404);
	});

	it("sentinel: token channel set but digest unset → still 404 (no silent fallback)", async () => {
		process.env.FLYWHEEL_TOKEN_USAGE_CHANNEL = "111222333";
		const res = await request(makeApp(store), "/api/digest/render", {});
		expect(res.status).toBe(404);
	});

	it("FLYWHEEL_DIGEST_CHANNEL set → /render returns text/html", async () => {
		process.env.FLYWHEEL_DIGEST_CHANNEL = "999888777";
		const res = await request(makeApp(store), "/api/digest/render", {});
		expect(res.status).toBe(200);
		expect(res.contentType).toContain("text/html");
		expect(res.body).toContain("今日无上线"); // empty :memory: store
	});

	// FLY-727 (Codex code-review R4): /api/deployments is auth-required at the
	// plugin layer — with no TEAMLEAD_API_TOKEN it must return 503, never accept
	// unauthenticated writes (config here has no apiToken).
	it("/api/deployments/report → 503 without an API token (never unauthenticated)", async () => {
		const res = await request(makeApp(store), "/api/deployments/report", {
			projectName: "flywheel",
			source: "self-ship",
			issueIdentifier: "FLY-1",
			mergeSha: "a".repeat(40),
		});
		expect(res.status).toBe(503);
	});
});

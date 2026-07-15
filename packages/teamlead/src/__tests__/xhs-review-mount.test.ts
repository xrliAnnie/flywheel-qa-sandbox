/**
 * FLY-286 PR-2: /xhs-review plugin-mount gating tests.
 *
 * Detailed handler behaviour is unit-tested in xhs-review-routes.test.ts; this
 * asserts the PLUGIN wiring: routes are mounted OUTSIDE /api (no Bearer
 * challenge), and the loopback Host guard fires through the real Express
 * stack. FLY-1243: FLYWHEEL_XHS_REVIEW is retired (固化 default-on) — the
 * routes are ALWAYS mounted now, regardless of the env var.
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

function makeConfig(): BridgeConfig {
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
		apiToken: "secret",
	};
}

function get(
	app: ReturnType<typeof createBridgeApp>,
	path: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
	return new Promise((resolvePromise) => {
		const http = require("node:http");
		const server = http.createServer(app);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" ? addr.port : 0;
			const req = http.request(
				{ hostname: "127.0.0.1", port, path, method: "GET", headers },
				(res: {
					statusCode: number;
					on: (e: string, cb: (d?: Buffer) => void) => void;
				}) => {
					let data = "";
					res.on("data", (c: Buffer) => {
						data += c?.toString() ?? "";
					});
					res.on("end", () => {
						server.close();
						resolvePromise({ status: res.statusCode, body: data });
					});
				},
			);
			req.end();
		});
	});
}

function makeApp() {
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
		undefined,
		undefined,
		undefined,
		{ vercelToken: undefined },
	);
}

let store: StateStore;
let stateDir: string;
const envBackup: Record<string, string | undefined> = {};

beforeEach(async () => {
	store = await StateStore.create(":memory:");
	stateDir = mkdtempSync(join(tmpdir(), "xhs-mount-"));
	envBackup.FLYWHEEL_XHS_REVIEW = process.env.FLYWHEEL_XHS_REVIEW;
	envBackup.FLYWHEEL_XHS_STATE_DIR = process.env.FLYWHEEL_XHS_STATE_DIR;
	process.env.FLYWHEEL_XHS_STATE_DIR = stateDir;
});
afterEach(() => {
	store.close();
	rmSync(stateDir, { recursive: true, force: true });
	for (const [k, v] of Object.entries(envBackup)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("/xhs-review mount gating", () => {
	// FLY-1243: FLYWHEEL_XHS_REVIEW is retired — the route is always mounted
	// now (固化 default-on). Rewritten (was "unset → route NOT mounted") to
	// assert the route is mounted even with the env unset: the request
	// reaches OUR handler (404 body "unknown report"), not Express's bare
	// unmounted-route 404.
	it("FLYWHEEL_XHS_REVIEW unset → route still mounted (handler runs: unknown report 404)", async () => {
		delete process.env.FLYWHEEL_XHS_REVIEW;
		const res = await get(makeApp(), "/xhs-review/sometoken");
		expect(res.status).toBe(404);
		expect(res.body).toContain("unknown report"); // our handler ran
	});

	it("FLYWHEEL_XHS_REVIEW=1 → route mounted (handler runs: unknown report 404)", async () => {
		process.env.FLYWHEEL_XHS_REVIEW = "1";
		const res = await get(makeApp(), "/xhs-review/sometoken");
		expect(res.status).toBe(404);
		expect(res.body).toContain("unknown report"); // our handler ran
	});

	it("FLYWHEEL_XHS_REVIEW=1 + non-loopback Host → 403 (no Bearer challenge)", async () => {
		process.env.FLYWHEEL_XHS_REVIEW = "1";
		const res = await get(makeApp(), "/xhs-review/sometoken", {
			Host: "evil.com",
		});
		expect(res.status).toBe(403);
		expect(res.body).toContain("non-loopback");
	});
});

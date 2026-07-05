import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type { CaptureResult } from "../bridge/session-capture.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "test-project",
		projectRoot: "/tmp/test-project",
		projectRepo: "xrliAnnie/test-project",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-channel",
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
		ingestToken: "ingest-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		...overrides,
	};
}

describe("GET /api/sessions/:id/status", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		// Seed a session
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-10",
			issue_identifier: "FLY-10",
			issue_title: "Status Detection",
			project_name: "test-project",
			status: "running",
		});
	});

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	function startServer(
		captureOutput?: string,
		captureError?: { error: string; status: number },
	): Promise<void> {
		const captureSessionFn = async (
			_execId: string,
			_proj: string,
			_lines: number,
		): Promise<CaptureResult | { error: string; status: number }> => {
			if (captureError) return captureError;
			return {
				output: captureOutput ?? "",
				tmux_target: "test:@0",
				lines: 100,
				captured_at: new Date().toISOString(),
			};
		};

		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
			undefined, // broadcaster
			undefined, // transitionOpts
			undefined, // retryDispatcher
			undefined, // cipherWriter
			undefined, // eventFilter
			undefined, // forumTagUpdater
			undefined, // registry
			undefined, // forumPostCreator
			undefined, // memoryService
			captureSessionFn,
		);
		server = app.listen(0, "127.0.0.1");
		return new Promise<void>((resolve) => {
			server.once("listening", () => {
				const addr = server.address();
				if (addr && typeof addr === "object") {
					baseUrl = `http://127.0.0.1:${addr.port}`;
				}
				resolve();
			});
		});
	}

	it("returns executing for active terminal output", async () => {
		await startServer("Reading file...\nAnalyzing code...\nBuilding");
		const res = await fetch(`${baseUrl}/api/sessions/exec-1/status`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("executing");
		expect(body.execution_id).toBe("exec-1");
		expect(body.checked_at).toBeDefined();
	});

	it("returns waiting for prompt output", async () => {
		await startServer("Edit file.ts\nDo you want to proceed? [Y/n]");
		const res = await fetch(`${baseUrl}/api/sessions/exec-1/status`);
		const body = await res.json();
		expect(body.status).toBe("waiting");
	});

	it("returns idle for shell prompt", async () => {
		await startServer("exit\n$ ");
		const res = await fetch(`${baseUrl}/api/sessions/exec-1/status`);
		const body = await res.json();
		expect(body.status).toBe("idle");
	});

	it("returns unknown when tmux unreachable (502 tmux)", async () => {
		await startServer(undefined, {
			error: "tmux window not found: GEO-100:@0",
			status: 502,
		});
		const res = await fetch(`${baseUrl}/api/sessions/exec-1/status`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("unknown");
		expect(body.reason).toContain("tmux window not found");
	});

	it("returns HTTP 502 for CommDB read failure (not tmux)", async () => {
		await startServer(undefined, {
			error: "Failed to read communication database for project 'test'",
			status: 502,
		});
		const res = await fetch(`${baseUrl}/api/sessions/exec-1/status`);
		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body.error).toContain("Failed to read communication database");
	});

	it("returns HTTP 404 when CommDB missing (capture 404 propagation)", async () => {
		await startServer(undefined, {
			error: "Communication database not found",
			status: 404,
		});
		const res = await fetch(`${baseUrl}/api/sessions/exec-1/status`);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toContain("Communication database not found");
	});

	it("returns 404 for nonexistent session", async () => {
		await startServer("output");
		const res = await fetch(`${baseUrl}/api/sessions/nonexistent/status`);
		expect(res.status).toBe(404);
	});

	it("resolves session by identifier (FLY-10)", async () => {
		await startServer("Building...");
		const res = await fetch(`${baseUrl}/api/sessions/FLY-10/status`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.execution_id).toBe("exec-1");
		expect(body.status).toBe("executing");
	});
});

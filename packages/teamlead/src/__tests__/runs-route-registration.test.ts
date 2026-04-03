/**
 * FLY-22: Integration test — /api/runs routes are registered when
 * startBridge is called WITHOUT an explicit startDispatcher.
 *
 * This is the root cause of the bug: index.ts didn't pass startDispatcher
 * to startBridge, so the runs routes were never registered (404).
 */

import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";

// Mock heavy dependencies to keep the test lightweight
vi.mock("flywheel-claude-runner", () => ({
	AnthropicLLMClient: vi.fn(),
	TmuxAdapter: vi.fn().mockImplementation(() => ({
		type: "claude-tmux",
		checkEnvironment: vi.fn().mockResolvedValue({ ready: true }),
	})),
}));

vi.mock("flywheel-core", async (importOriginal) => {
	const mod = (await importOriginal()) as Record<string, unknown>;
	return {
		...mod,
		openTmuxViewer: vi.fn(),
		sanitizeTmuxName: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "-"),
	};
});

// Mock HookCallbackServer to avoid binding ports
vi.mock("flywheel-edge-worker", async (importOriginal) => {
	const mod = (await importOriginal()) as Record<string, unknown>;
	return {
		...mod,
		HookCallbackServer: vi.fn().mockImplementation(() => ({
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
			getPort: vi.fn().mockReturnValue(0),
		})),
		AuditLogger: vi.fn().mockImplementation(() => ({
			init: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
		})),
		// FLY-50: CipherReader is now used in createRunBlueprint
		CipherReader: vi.fn().mockImplementation(() => ({
			loadActivePrinciples: vi.fn().mockResolvedValue([]),
		})),
	};
});

// Mock Blueprint to avoid actual execution infrastructure
vi.mock("flywheel-edge-worker/dist/Blueprint.js", () => ({
	Blueprint: vi.fn().mockImplementation(() => ({
		run: vi.fn().mockResolvedValue({ success: true }),
	})),
}));

vi.mock("flywheel-edge-worker/dist/PreHydrator.js", () => ({
	PreHydrator: vi.fn().mockImplementation(() => ({
		hydrate: vi.fn().mockResolvedValue({
			issueId: "TEST-1",
			issueTitle: "Test",
			issueDescription: "",
			labels: [],
			projectId: "",
			issueIdentifier: "TEST-1",
		}),
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

describe("FLY-22: /api/runs routes always registered", () => {
	let closeFn: (() => Promise<void>) | undefined;

	afterEach(async () => {
		if (closeFn) {
			await closeFn();
			closeFn = undefined;
		}
	});

	it(
		"startBridge without startDispatcher → /api/runs/active returns 200 (not 404)",
		{ timeout: 15_000 },
		async () => {
			// Import after mocks are set up
			const { startBridge } = await import("../bridge/plugin.js");

			const { app, close, store } = await startBridge(
				makeConfig(),
				testProjects,
				// No startDispatcher passed — this is the bug scenario
			);
			closeFn = close;

			const server = app.listen(0, "127.0.0.1") as http.Server;
			await new Promise<void>((resolve) => server.once("listening", resolve));

			try {
				const addr = server.address();
				const port = typeof addr === "object" && addr ? addr.port : 0;
				const baseUrl = `http://127.0.0.1:${port}`;

				const res = await fetch(`${baseUrl}/api/runs/active`);

				// Before fix: 404 (route not registered)
				// After fix: 200 (RunDispatcher created internally)
				expect(res.status).toBe(200);

				const body = (await res.json()) as { running: number; max: number };
				expect(body).toHaveProperty("running");
				expect(body).toHaveProperty("max");
				expect(body.max).toBe(2);
			} finally {
				await new Promise<void>((resolve, reject) =>
					server.close((err) => (err ? reject(err) : resolve())),
				);
				store.close();
			}
		},
	);
});

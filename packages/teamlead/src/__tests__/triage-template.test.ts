/**
 * FLY-27: Triage HTML template endpoint tests.
 * Exercises GET /api/triage/template.
 */

import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

// Mock Linear SDK (required by plugin)
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

describe("GET /api/triage/template (FLY-27)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig({ apiToken: "test-token" }),
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

	it("returns 200 with HTML content", async () => {
		const res = await fetch(`${baseUrl}/api/triage/template`, {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");

		const body = await res.text();
		expect(body).toContain("<!DOCTYPE html>");
		expect(body).toContain("{{DATE}}");
	});

	it("contains all required placeholders", async () => {
		const res = await fetch(`${baseUrl}/api/triage/template`, {
			headers: { Authorization: "Bearer test-token" },
		});
		const body = await res.text();

		const placeholders = [
			"{{DATE}}",
			"{{TITLE}}",
			"{{SUBTITLE}}",
			"{{NORTH_STAR}}",
			"{{VERSION}}",
			"{{STATS}}",
			"{{CAPACITY}}",
			"{{SECTION_CRITICAL}}",
			"{{SECTION_WEEK}}",
			"{{SECTION_INPROGRESS}}",
			"{{SECTION_REMAINING}}",
			"{{EXTRA_SECTIONS}}",
		];
		for (const ph of placeholders) {
			expect(body).toContain(ph);
		}
	});

	it("contains pm-triage CSS classes", async () => {
		const res = await fetch(`${baseUrl}/api/triage/template`, {
			headers: { Authorization: "Bearer test-token" },
		});
		const body = await res.text();

		// Key CSS classes from pm-triage Apple-style design
		expect(body).toContain(".card-red");
		expect(body).toContain(".card-amber");
		expect(body).toContain(".card-blue");
		expect(body).toContain(".priority-dot");
		expect(body).toContain(".pri-urgent");
		expect(body).toContain(".status-tag");
		expect(body).toContain(".issue-id");
		expect(body).toContain(".module-bridge");
		expect(body).toContain(".module-lead");
		expect(body).toContain(".module-runner");
		expect(body).toContain(".group-product");
		expect(body).toContain(".group-operations");
	});

	it("returns 401 without auth token", async () => {
		const res = await fetch(`${baseUrl}/api/triage/template`);
		expect(res.status).toBe(401);
	});

	it("uses light Apple-style theme (not dark)", async () => {
		const res = await fetch(`${baseUrl}/api/triage/template`, {
			headers: { Authorization: "Bearer test-token" },
		});
		const body = await res.text();

		// Apple-style light theme with CSS variables
		expect(body).toContain("--gray-bg: #f7fafc");
		expect(body).toContain("--bg: #ffffff");
		expect(body).toContain("--brand: #1a365d");
		// Should NOT contain dark theme
		expect(body).not.toContain("#1a1a2e");
		expect(body).not.toContain("#0d1117");
		expect(body).not.toContain("#161b22");
	});
});

/**
 * GEO-298: Linear create-issue endpoint tests.
 * Exercises POST /api/linear/create-issue with team and project parameters.
 */

import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

// Mock Linear SDK
const mockTeams = vi.fn();
const mockProjects = vi.fn();
const mockCreateIssue = vi.fn();

vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({
		teams: mockTeams,
		projects: mockProjects,
		createIssue: mockCreateIssue,
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

// Helper: single team workspace
function mockSingleTeam() {
	mockTeams.mockResolvedValue({
		nodes: [{ id: "team-geo-id", key: "GEO", name: "GeoForge3D" }],
	});
}

// Helper: multi team workspace
function mockMultiTeam() {
	mockTeams.mockResolvedValue({
		nodes: [
			{ id: "team-geo-id", key: "GEO", name: "GeoForge3D" },
			{ id: "team-fly-id", key: "FLY", name: "Flywheel" },
		],
	});
}

// Helper: mock project resolution
function mockProjectResolution(name: string, id: string) {
	mockProjects.mockResolvedValue({
		nodes: [{ id, name }],
	});
}

function mockNoProject() {
	mockProjects.mockResolvedValue({ nodes: [] });
}

// Helper: mock successful issue creation
function mockIssueCreated(
	identifier = "GEO-300",
	id = "issue-id-1",
	url = "https://linear.app/test/issue/GEO-300",
) {
	mockCreateIssue.mockResolvedValue({
		issue: Promise.resolve({ id, identifier, url }),
	});
}

describe("POST /api/linear/create-issue (GEO-298)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		mockTeams.mockReset();
		mockProjects.mockReset();
		mockCreateIssue.mockReset();
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
		await new Promise<void>((resolve) => server.close(() => resolve()));
		store.close();
	});

	function post(body: Record<string, unknown>) {
		return fetch(`${baseUrl}/api/linear/create-issue`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify(body),
		});
	}

	// --- Team resolution ---

	it("creates issue with explicit team key in multi-team workspace", async () => {
		mockMultiTeam();
		mockIssueCreated("FLY-1", "fly-issue-1", "https://linear.app/test/issue/FLY-1");

		const res = await post({ title: "Test issue", team: "FLY" });
		expect(res.status).toBe(200);

		const data = await res.json();
		expect(data.ok).toBe(true);
		expect(data.issue.identifier).toBe("FLY-1");

		// Verify createIssue was called with correct teamId
		expect(mockCreateIssue).toHaveBeenCalledWith(
			expect.objectContaining({ teamId: "team-fly-id" }),
		);
	});

	it("creates issue with GEO team key", async () => {
		mockMultiTeam();
		mockIssueCreated("GEO-300");

		const res = await post({ title: "GEO issue", team: "GEO" });
		expect(res.status).toBe(200);

		expect(mockCreateIssue).toHaveBeenCalledWith(
			expect.objectContaining({ teamId: "team-geo-id" }),
		);
	});

	it("returns 404 for invalid team key", async () => {
		mockMultiTeam();

		const res = await post({ title: "Test", team: "INVALID" });
		expect(res.status).toBe(404);

		const data = await res.json();
		expect(data.error).toContain("INVALID");
		expect(data.error).toContain("GEO");
		expect(data.error).toContain("FLY");
	});

	it("returns 400 for non-string team", async () => {
		const res = await post({ title: "Test", team: 123 });
		expect(res.status).toBe(400);

		const data = await res.json();
		expect(data.error).toContain("team");
	});

	it("defaults to first team in single-team workspace (backward compat)", async () => {
		mockSingleTeam();
		mockIssueCreated("GEO-300");

		const res = await post({ title: "Single team issue" });
		expect(res.status).toBe(200);

		expect(mockCreateIssue).toHaveBeenCalledWith(
			expect.objectContaining({ teamId: "team-geo-id" }),
		);
	});

	it("returns 400 when team omitted in multi-team workspace", async () => {
		mockMultiTeam();

		const res = await post({ title: "Ambiguous issue" });
		expect(res.status).toBe(400);

		const data = await res.json();
		expect(data.error).toContain("Multiple teams");
		expect(data.error).toContain("GEO");
		expect(data.error).toContain("FLY");
	});

	// --- Project resolution ---

	it("associates issue with project when project name given", async () => {
		mockSingleTeam();
		mockProjectResolution("Flywheel", "project-flywheel-id");
		mockIssueCreated("GEO-300");

		const res = await post({ title: "With project", project: "Flywheel" });
		expect(res.status).toBe(200);

		expect(mockCreateIssue).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "project-flywheel-id" }),
		);
	});

	it("returns 404 for non-existent project", async () => {
		mockSingleTeam();
		mockNoProject();

		const res = await post({ title: "Bad project", project: "NonExistent" });
		expect(res.status).toBe(404);

		const data = await res.json();
		expect(data.error).toContain("NonExistent");
	});

	it("returns 400 for non-string project", async () => {
		const res = await post({ title: "Test", project: 42 });
		expect(res.status).toBe(400);

		const data = await res.json();
		expect(data.error).toContain("project");
	});

	it("omits projectId when project not specified", async () => {
		mockSingleTeam();
		mockIssueCreated("GEO-300");

		const res = await post({ title: "No project" });
		expect(res.status).toBe(200);

		const call = mockCreateIssue.mock.calls[0][0];
		expect(call.projectId).toBeUndefined();
	});

	// --- Full integration ---

	it("creates issue with team + project (full flow)", async () => {
		mockMultiTeam();
		mockProjectResolution("Flywheel", "project-flywheel-id");
		mockIssueCreated("FLY-1", "fly-1-id", "https://linear.app/test/issue/FLY-1");

		const res = await post({
			title: "New Flywheel feature",
			description: "Some desc",
			priority: 2,
			labels: ["label-id-1"],
			team: "FLY",
			project: "Flywheel",
		});
		expect(res.status).toBe(200);

		const data = await res.json();
		expect(data.ok).toBe(true);
		expect(data.issue.identifier).toBe("FLY-1");

		expect(mockCreateIssue).toHaveBeenCalledWith({
			teamId: "team-fly-id",
			title: "New Flywheel feature",
			description: "Some desc",
			priority: 2,
			labelIds: ["label-id-1"],
			projectId: "project-flywheel-id",
		});
	});

	// --- Existing validations still work ---

	it("returns 400 when title is missing", async () => {
		const res = await post({});
		expect(res.status).toBe(400);
	});

	it("returns 400 when title exceeds 500 chars", async () => {
		const res = await post({ title: "x".repeat(501) });
		expect(res.status).toBe(400);
	});

	it("returns 501 when LINEAR_API_KEY not configured", async () => {
		const store2 = await StateStore.create(":memory:");
		const app2 = createBridgeApp(
			store2,
			testProjects,
			makeConfig({ apiToken: "test-token" }),
		);
		const server2 = app2.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server2.once("listening", resolve));
		const addr2 = server2.address();
		const port2 = typeof addr2 === "object" && addr2 ? addr2.port : 0;

		const res = await fetch(
			`http://127.0.0.1:${port2}/api/linear/create-issue`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-token",
				},
				body: JSON.stringify({ title: "Test" }),
			},
		);
		expect(res.status).toBe(501);

		await new Promise<void>((resolve) => server2.close(() => resolve()));
		store2.close();
	});
});

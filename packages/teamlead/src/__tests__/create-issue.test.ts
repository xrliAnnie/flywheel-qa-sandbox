/**
 * GEO-298: Linear create-issue endpoint tests.
 * Exercises POST /api/linear/create-issue with team and project parameters.
 */

import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

// Mock Linear SDK
const mockTeams = vi.fn();
const mockProjects = vi.fn();
const mockCreateIssue = vi.fn();
const mockIssueLabels = vi.fn();

vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({
		teams: mockTeams,
		projects: mockProjects,
		createIssue: mockCreateIssue,
		issueLabels: mockIssueLabels,
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
	// FLY-371: a project with a full Linear binding (team + project + scope label).
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [{ agentId: "eng", chatChannel: "c", match: { labels: ["Eng"] } }],
		linear: { team: "FLY", project: "Flywheel", label: "Flywheel" },
	},
	// FLY-371: a label-only-scoped COE (no Linear Project) — the Polaris shape.
	{
		projectName: "polaris",
		projectRoot: "/tmp/polaris",
		leads: [
			{ agentId: "pol", chatChannel: "c", match: { labels: ["Polaris"] } },
		],
		linear: { team: "GEO", label: "Polaris" },
	},
	// FLY-371: a project in the roster but with no Linear binding.
	{
		projectName: "no-binding-proj",
		projectRoot: "/tmp/nb",
		leads: [{ agentId: "nb", chatChannel: "c", match: { labels: ["X"] } }],
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

/** FLY-1018 QA F1: a UUID-shaped caller label — passes through unresolved. */
const CALLER_LABEL_UUID = "a1b2c3d4-1111-2222-3333-444455556666";

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
		mockIssueLabels.mockReset();
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
		mockIssueCreated(
			"FLY-1",
			"fly-issue-1",
			"https://linear.app/test/issue/FLY-1",
		);

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
		mockIssueCreated(
			"FLY-1",
			"fly-1-id",
			"https://linear.app/test/issue/FLY-1",
		);

		const res = await post({
			title: "New Flywheel feature",
			description: "Some desc",
			priority: 2,
			labels: [CALLER_LABEL_UUID],
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
			labelIds: [CALLER_LABEL_UUID],
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

	// ===== FLY-371: projectName → Linear binding =====

	it("projectName resolves team + project + scope label from the binding (team-scoped)", async () => {
		mockMultiTeam();
		mockProjects.mockResolvedValue({
			nodes: [{ id: "proj-fly", name: "Flywheel" }],
		});
		mockIssueLabels.mockResolvedValue({
			nodes: [{ id: "lbl-fly", name: "Flywheel" }],
		});
		mockIssueCreated("FLY-2");

		const res = await post({ title: "via binding", projectName: "flywheel" });
		expect(res.status).toBe(200);

		expect(mockCreateIssue).toHaveBeenCalledWith(
			expect.objectContaining({
				teamId: "team-fly-id",
				projectId: "proj-fly",
				labelIds: ["lbl-fly"],
			}),
		);
		// binding-derived project is scoped to the effective team (Codex R2 HIGH-1)
		expect(mockProjects).toHaveBeenCalledWith(
			expect.objectContaining({
				filter: expect.objectContaining({
					name: { eq: "Flywheel" },
					accessibleTeams: { some: { id: { eq: "team-fly-id" } } },
				}),
			}),
		);
		// label is resolved within the effective team (Codex R1 HIGH-2)
		expect(mockIssueLabels).toHaveBeenCalledWith(
			expect.objectContaining({
				filter: expect.objectContaining({
					name: { eq: "Flywheel" },
					team: { id: { eq: "team-fly-id" } },
				}),
			}),
		);
	});

	it("explicit team overrides binding.team AND the label is resolved against the effective team", async () => {
		mockMultiTeam();
		mockProjects.mockResolvedValue({
			nodes: [{ id: "proj-fly", name: "Flywheel" }],
		});
		mockIssueLabels.mockResolvedValue({
			nodes: [{ id: "lbl-geo", name: "Flywheel" }],
		});
		mockIssueCreated();

		const res = await post({
			title: "x",
			projectName: "flywheel",
			team: "GEO",
		});
		expect(res.status).toBe(200);
		expect(mockCreateIssue).toHaveBeenCalledWith(
			expect.objectContaining({ teamId: "team-geo-id" }),
		);
		expect(mockIssueLabels).toHaveBeenCalledWith(
			expect.objectContaining({
				filter: expect.objectContaining({
					team: { id: { eq: "team-geo-id" } },
				}),
			}),
		);
	});

	it("explicit project overrides binding.project via the legacy name-only path", async () => {
		mockMultiTeam();
		mockProjectResolution("CustomProj", "proj-custom");
		mockIssueLabels.mockResolvedValue({
			nodes: [{ id: "lbl-fly", name: "Flywheel" }],
		});
		mockIssueCreated();

		const res = await post({
			title: "x",
			projectName: "flywheel",
			project: "CustomProj",
		});
		expect(res.status).toBe(200);
		expect(mockCreateIssue).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "proj-custom" }),
		);
		// explicit project keeps legacy name-only resolution (no accessibleTeams)
		expect(mockProjects).toHaveBeenCalledWith({
			filter: { name: { eq: "CustomProj" } },
		});
	});

	it("returns 404 when the binding project is not found in the effective team", async () => {
		mockMultiTeam();
		mockProjects.mockResolvedValue({ nodes: [] });
		const res = await post({ title: "x", projectName: "flywheel" });
		expect(res.status).toBe(404);
		expect((await res.json()).error).toMatch(/not found in team/i);
	});

	it("returns 400 when the binding project name is ambiguous within the team", async () => {
		mockMultiTeam();
		mockProjects.mockResolvedValue({
			nodes: [
				{ id: "p1", name: "Flywheel" },
				{ id: "p2", name: "Flywheel" },
			],
		});
		const res = await post({ title: "x", projectName: "flywheel" });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/ambiguous/i);
	});

	it("returns 404 when the scope label is not found in the effective team", async () => {
		mockMultiTeam();
		mockProjects.mockResolvedValue({
			nodes: [{ id: "proj-fly", name: "Flywheel" }],
		});
		mockIssueLabels.mockResolvedValue({ nodes: [] });
		const res = await post({ title: "x", projectName: "flywheel" });
		expect(res.status).toBe(404);
		expect((await res.json()).error).toMatch(/label.*not found|scope label/i);
	});

	it("returns 400 when the scope label is ambiguous within the team", async () => {
		mockMultiTeam();
		mockProjects.mockResolvedValue({
			nodes: [{ id: "proj-fly", name: "Flywheel" }],
		});
		mockIssueLabels.mockResolvedValue({
			nodes: [
				{ id: "l1", name: "Flywheel" },
				{ id: "l2", name: "Flywheel" },
			],
		});
		const res = await post({ title: "x", projectName: "flywheel" });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/ambiguous/i);
	});

	it("label-only binding (Polaris) applies the label with no project association", async () => {
		mockMultiTeam();
		mockIssueLabels.mockResolvedValue({
			nodes: [{ id: "lbl-pol", name: "Polaris" }],
		});
		mockIssueCreated();

		const res = await post({ title: "x", projectName: "polaris" });
		expect(res.status).toBe(200);
		const call = mockCreateIssue.mock.calls[0][0];
		expect(call.teamId).toBe("team-geo-id");
		expect(call.projectId).toBeUndefined();
		expect(call.labelIds).toEqual(["lbl-pol"]);
		expect(mockProjects).not.toHaveBeenCalled();
	});

	it("merges the binding scope label with caller-supplied label ids (UUID passthrough)", async () => {
		mockMultiTeam();
		mockProjects.mockResolvedValue({
			nodes: [{ id: "proj-fly", name: "Flywheel" }],
		});
		mockIssueLabels.mockResolvedValue({
			nodes: [{ id: "lbl-fly", name: "Flywheel" }],
		});
		mockIssueCreated();

		const res = await post({
			title: "x",
			projectName: "flywheel",
			labels: [CALLER_LABEL_UUID],
		});
		expect(res.status).toBe(200);
		const call = mockCreateIssue.mock.calls[0][0];
		expect(call.labelIds).toEqual([CALLER_LABEL_UUID, "lbl-fly"]);
		// UUID-shaped entries never hit the resolver — only the scope label did.
		expect(mockIssueLabels).toHaveBeenCalledTimes(1);
	});

	it("returns 400 for a non-string projectName (JSON body 123)", async () => {
		const res = await post({ title: "x", projectName: 123 });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/projectName/);
	});

	it("returns 404 for an unknown projectName", async () => {
		const res = await post({ title: "x", projectName: "ghost" });
		expect(res.status).toBe(404);
		expect((await res.json()).error).toMatch(/Unknown Flywheel project/);
	});

	it("returns 404 for a known projectName with no linear binding", async () => {
		const res = await post({ title: "x", projectName: "no-binding-proj" });
		expect(res.status).toBe(404);
		expect((await res.json()).error).toMatch(/no linear binding/);
	});

	// --- FLY-1018 QA F1: caller label NAMES resolve team-scoped (name → id) ---
	// Pre-F1 the route forwarded caller `labels` verbatim as Linear labelIds, so
	// any label NAME (the tool-schema contract) 502'd at Linear ("labelIds must
	// be a UUID"). Names now resolve exactly like the FLY-371 scope label;
	// UUID-shaped entries pass through untouched (pre-F1 id-passing callers).

	it("resolves caller label names to team-scoped ids", async () => {
		mockMultiTeam();
		mockIssueLabels.mockResolvedValueOnce({
			nodes: [{ id: "lbl-bug", name: "bug" }],
		});
		mockIssueCreated("FLY-2", "fly-issue-2");

		const res = await post({ title: "x", team: "FLY", labels: ["bug"] });
		expect(res.status).toBe(200);
		const call = mockCreateIssue.mock.calls[0][0];
		expect(call.labelIds).toEqual(["lbl-bug"]);
		expect(mockIssueLabels).toHaveBeenCalledWith(
			expect.objectContaining({
				filter: expect.objectContaining({
					name: { eq: "bug" },
					team: { id: { eq: "team-fly-id" } },
				}),
			}),
		);
	});

	it("returns 404 with the label name when a caller label does not exist in the team", async () => {
		mockMultiTeam();
		mockIssueLabels.mockResolvedValueOnce({ nodes: [] });

		const res = await post({ title: "x", team: "FLY", labels: ["ghost"] });
		expect(res.status).toBe(404);
		expect((await res.json()).error).toMatch(
			/Label "ghost" not found in team "FLY"/,
		);
		expect(mockCreateIssue).not.toHaveBeenCalled();
	});

	it("returns 400 when a caller label name is ambiguous within the team", async () => {
		mockMultiTeam();
		mockIssueLabels.mockResolvedValueOnce({
			nodes: [
				{ id: "l1", name: "bug" },
				{ id: "l2", name: "bug" },
			],
		});

		const res = await post({ title: "x", team: "FLY", labels: ["bug"] });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/ambiguous/i);
		expect(mockCreateIssue).not.toHaveBeenCalled();
	});

	it("dedupes repeated caller labels resolving to the same id", async () => {
		mockMultiTeam();
		mockIssueLabels
			.mockResolvedValueOnce({ nodes: [{ id: "lbl-bug", name: "bug" }] })
			.mockResolvedValueOnce({ nodes: [{ id: "lbl-bug", name: "bug" }] });
		mockIssueCreated("FLY-3", "fly-issue-3");

		const res = await post({ title: "x", team: "FLY", labels: ["bug", "bug"] });
		expect(res.status).toBe(200);
		const call = mockCreateIssue.mock.calls[0][0];
		expect(call.labelIds).toEqual(["lbl-bug"]);
	});

	it("resolved caller names merge with the binding scope label", async () => {
		mockMultiTeam();
		mockProjects.mockResolvedValue({
			nodes: [{ id: "proj-fly", name: "Flywheel" }],
		});
		// caller labels resolve first (in order), then the scope label
		mockIssueLabels
			.mockResolvedValueOnce({ nodes: [{ id: "lbl-bug", name: "bug" }] })
			.mockResolvedValueOnce({ nodes: [{ id: "lbl-fly", name: "Flywheel" }] });
		mockIssueCreated();

		const res = await post({
			title: "x",
			projectName: "flywheel",
			labels: ["bug"],
		});
		expect(res.status).toBe(200);
		const call = mockCreateIssue.mock.calls[0][0];
		expect(call.labelIds).toEqual(["lbl-bug", "lbl-fly"]);
	});

	it("mixed UUID + name list: only names hit the resolver", async () => {
		mockMultiTeam();
		mockIssueLabels.mockResolvedValueOnce({
			nodes: [{ id: "lbl-bug", name: "bug" }],
		});
		mockIssueCreated("FLY-4", "fly-issue-4");

		const res = await post({
			title: "x",
			team: "FLY",
			labels: [CALLER_LABEL_UUID, "bug"],
		});
		expect(res.status).toBe(200);
		const call = mockCreateIssue.mock.calls[0][0];
		expect(call.labelIds).toEqual([CALLER_LABEL_UUID, "lbl-bug"]);
		expect(mockIssueLabels).toHaveBeenCalledTimes(1);
	});
});

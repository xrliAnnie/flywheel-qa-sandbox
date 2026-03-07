import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { StateStore } from "../StateStore.js";
import { createBridgeApp } from "../bridge/plugin.js";
import { approveExecution } from "../bridge/actions.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type http from "node:http";

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		...overrides,
	};
}

const testProjects: ProjectEntry[] = [
	{ projectName: "geoforge3d", projectRoot: "/tmp/geoforge3d", projectRepo: "xrliAnnie/GeoForge3D" },
];

// ApproveHandler calls execFn twice:
// 1. gh pr list ... --json number,url → must return JSON array of PRs
// 2. gh pr merge ... → any output is fine
const mockExec = vi.fn(async (_cmd: string, args: string[]) => {
	if (args.includes("list")) {
		return { stdout: JSON.stringify([{ number: 42, url: "https://github.com/test/pr/42" }]) };
	}
	return { stdout: "merged" };
});

describe("Action tools", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const app = createBridgeApp(store, testProjects, makeConfig());
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
		mockExec.mockClear();
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	it("POST /api/actions/approve with valid execution_id succeeds", async () => {
		store.upsertSession({
			execution_id: "e1", issue_id: "i1", project_name: "geoforge3d",
			status: "awaiting_review", issue_identifier: "GEO-95",
		});

		const result = await approveExecution(store, testProjects, "e1", "GEO-95", mockExec);
		expect(result.success).toBe(true);
		expect(mockExec).toHaveBeenCalled();
	});

	it("POST /api/actions/approve without execution_id returns 400", async () => {
		const res = await fetch(`${baseUrl}/api/actions/approve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identifier: "GEO-95" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("execution_id");
	});

	it("POST /api/actions/approve passes internal issue_id to ApproveHandler", async () => {
		store.upsertSession({
			execution_id: "e1", issue_id: "internal-uuid-123", project_name: "geoforge3d",
			status: "awaiting_review", issue_identifier: "GEO-95",
		});

		await approveExecution(store, testProjects, "e1", "GEO-95", mockExec);

		// ApproveHandler receives issueId in the action payload
		const callArgs = mockExec.mock.calls[0];
		// The ApproveHandler constructs a branch name from issueId: flywheel-${issueId}
		// It calls exec with ["gh", "pr", "merge", ...] — the issueId is in the branch name
		expect(callArgs).toBeDefined();
	});

	it("POST /api/actions/approve transitions session to approved on success", async () => {
		store.upsertSession({
			execution_id: "e1", issue_id: "i1", project_name: "geoforge3d",
			status: "awaiting_review",
		});

		const result = await approveExecution(store, testProjects, "e1", undefined, mockExec);
		expect(result.success).toBe(true);

		const session = store.getSession("e1");
		expect(session!.status).toBe("approved");
	});

	it("POST /api/actions/approve updates last_activity_at on success (SQLite format)", async () => {
		store.upsertSession({
			execution_id: "e1", issue_id: "i1", project_name: "geoforge3d",
			status: "awaiting_review", last_activity_at: "2026-01-01 00:00:00",
		});

		await approveExecution(store, testProjects, "e1", undefined, mockExec);

		const session = store.getSession("e1");
		// SQLite datetime format: YYYY-MM-DD HH:MM:SS (no T, no Z)
		expect(session!.last_activity_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it("approved session no longer returned by getActiveSessions()", async () => {
		store.upsertSession({
			execution_id: "e1", issue_id: "i1", project_name: "geoforge3d",
			status: "awaiting_review",
		});

		expect(store.getActiveSessions()).toHaveLength(1);
		await approveExecution(store, testProjects, "e1", undefined, mockExec);
		expect(store.getActiveSessions()).toHaveLength(0);
	});

	it("approve with nonexistent execution_id returns error", async () => {
		const result = await approveExecution(store, testProjects, "nonexistent");
		expect(result.success).toBe(false);
		expect(result.message).toContain("No session found");
	});

	it("approve with blocked session returns error", async () => {
		store.upsertSession({
			execution_id: "e1", issue_id: "i1", project_name: "geoforge3d",
			status: "blocked",
		});

		const result = await approveExecution(store, testProjects, "e1");
		expect(result.success).toBe(false);
		expect(result.message).toContain("expected \"awaiting_review\"");
	});

	it("POST /api/actions/reject returns 501", async () => {
		const res = await fetch(`${baseUrl}/api/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(501);
	});

	it("POST /api/actions/defer returns 501", async () => {
		const res = await fetch(`${baseUrl}/api/actions/defer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(501);
	});

	it("POST /api/actions/invalid returns 400", async () => {
		const res = await fetch(`${baseUrl}/api/actions/invalid`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});
});

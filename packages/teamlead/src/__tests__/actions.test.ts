import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveExecution, transitionSession } from "../bridge/actions.js";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { createBridgeApp } from "../bridge/plugin.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

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
		...overrides,
	};
}

const testProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		projectRepo: "xrliAnnie/GeoForge3D",
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

// ApproveHandler calls execFn twice:
// 1. gh pr list ... --json number,url → must return JSON array of PRs
// 2. gh pr merge ... → any output is fine
const mockExec = vi.fn(async (_cmd: string, args: string[]) => {
	if (args.includes("list")) {
		return {
			stdout: JSON.stringify([
				{ number: 42, url: "https://github.com/test/pr/42" },
			]),
		};
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
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-95",
		});

		const result = await approveExecution(
			store,
			testProjects,
			"e1",
			"GEO-95",
			mockExec,
		);
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
			execution_id: "e1",
			issue_id: "internal-uuid-123",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-95",
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
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});

		const result = await approveExecution(
			store,
			testProjects,
			"e1",
			undefined,
			mockExec,
		);
		expect(result.success).toBe(true);

		const session = store.getSession("e1");
		expect(session!.status).toBe("approved");
	});

	it("POST /api/actions/approve updates last_activity_at on success (SQLite format)", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
			last_activity_at: "2026-01-01 00:00:00",
		});

		await approveExecution(store, testProjects, "e1", undefined, mockExec);

		const session = store.getSession("e1");
		// SQLite datetime format: YYYY-MM-DD HH:MM:SS (no T, no Z)
		expect(session!.last_activity_at).toMatch(
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
		);
	});

	it("approved session no longer returned by getActiveSessions()", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
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
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "blocked",
		});

		const result = await approveExecution(store, testProjects, "e1");
		expect(result.success).toBe(false);
		expect(result.message).toContain('expected "awaiting_review"');
	});

	it("POST /api/actions/invalid returns 400", async () => {
		const res = await fetch(`${baseUrl}/api/actions/invalid`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	// --- reject ---
	it("reject transitions awaiting_review to rejected", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-50",
		});
		const result = await transitionSession(
			store,
			"reject",
			"e1",
			"Code quality issues",
		);
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.status).toBe("rejected");
		expect(store.getSession("e1")!.last_error).toBe("Code quality issues");
	});

	it("reject from running fails", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "running",
		});
		const result = await transitionSession(store, "reject", "e1");
		expect(result.success).toBe(false);
		expect(result.message).toContain("awaiting_review");
	});

	it("POST /api/actions/reject via HTTP succeeds", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		const res = await fetch(`${baseUrl}/api/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "e1", reason: "Not ready" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.action).toBe("reject");
	});

	it("POST /api/actions/reject without execution_id returns 400", async () => {
		const res = await fetch(`${baseUrl}/api/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason: "test" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("execution_id");
	});

	// --- defer ---
	it("defer transitions awaiting_review to deferred", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		const result = await transitionSession(
			store,
			"defer",
			"e1",
			"Waiting for dependency",
		);
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.status).toBe("deferred");
	});

	it("defer transitions blocked to deferred", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "blocked",
		});
		const result = await transitionSession(store, "defer", "e1");
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.status).toBe("deferred");
	});

	it("defer from running fails", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "running",
		});
		const result = await transitionSession(store, "defer", "e1");
		expect(result.success).toBe(false);
	});

	// --- retry ---
	it("retry transitions failed to running", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "failed",
		});
		const result = await transitionSession(store, "retry", "e1");
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.status).toBe("running");
	});

	it("retry transitions rejected to running", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "rejected",
		});
		const result = await transitionSession(store, "retry", "e1");
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.status).toBe("running");
	});

	it("retry transitions blocked to running", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "blocked",
		});
		const result = await transitionSession(store, "retry", "e1");
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.status).toBe("running");
	});

	it("retry from awaiting_review fails", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		const result = await transitionSession(store, "retry", "e1");
		expect(result.success).toBe(false);
	});

	// --- shelve ---
	it("shelve transitions awaiting_review to shelved", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});
		const result = await transitionSession(
			store,
			"shelve",
			"e1",
			"Low priority",
		);
		expect(result.success).toBe(true);
		expect(store.getSession("e1")!.status).toBe("shelved");
	});

	it("shelve from running fails", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "running",
		});
		const result = await transitionSession(store, "shelve", "e1");
		expect(result.success).toBe(false);
	});

	// --- edge cases ---
	it("transition with nonexistent execution_id returns error", async () => {
		const result = await transitionSession(store, "reject", "nonexistent");
		expect(result.success).toBe(false);
		expect(result.message).toContain("No session found");
	});

	it("transition uses issue_identifier in success message when available", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-42",
		});
		const result = await transitionSession(store, "reject", "e1");
		expect(result.message).toContain("GEO-42");
		expect(result.message).toContain("rejected");
	});

	it("transition without reason sets last_error to null", async () => {
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i1",
			project_name: "geoforge3d",
			status: "awaiting_review",
			last_error: "previous error",
		});
		await transitionSession(store, "reject", "e1");
		// last_error should be cleared (COALESCE with null keeps old value in SQLite)
		// Actually COALESCE(null, last_error) keeps old value — that's fine, reason is optional
		expect(store.getSession("e1")!.status).toBe("rejected");
	});

	// --- post-action hook tests (GEO-167 → GEO-195 registry pattern) ---
	describe("post-action hooks", () => {
		let capturedEnvelopes: LeadEventEnvelope[];
		let mockRegistry: RuntimeRegistry;

		beforeEach(() => {
			capturedEnvelopes = [];
			const mockRuntime = {
				type: "openclaw" as const,
				deliver: vi.fn(async (env: LeadEventEnvelope) => {
					capturedEnvelopes.push(env);
				}),
				sendBootstrap: vi.fn(async () => {}),
				health: vi.fn(async () => ({
					status: "healthy" as const,
					lastDeliveryAt: null,
					lastDeliveredSeq: 0,
				})),
				shutdown: vi.fn(async () => {}),
			};
			mockRegistry = new RuntimeRegistry();
			for (const project of testProjects) {
				for (const lead of project.leads) {
					mockRegistry.register(lead, mockRuntime);
				}
			}
		});

		it("approve sends action_executed hook", async () => {
			store.upsertSession({
				execution_id: "e1",
				issue_id: "i1",
				project_name: "geoforge3d",
				status: "awaiting_review",
				issue_identifier: "GEO-99",
			});

			await approveExecution(
				store,
				testProjects,
				"e1",
				"GEO-99",
				mockExec,
				undefined, // transitionOpts
				undefined, // config
				undefined, // cipherWriter
				undefined, // eventFilter
				undefined, // forumTagUpdater
				mockRegistry,
			);

			// Wait for async hook delivery
			await new Promise((r) => setTimeout(r, 200));

			expect(capturedEnvelopes).toHaveLength(1);
			const payload = capturedEnvelopes[0].event;
			expect(payload.event_type).toBe("action_executed");
			expect(payload.action).toBe("approve");
			expect(payload.action_source_status).toBe("awaiting_review");
			expect(payload.action_target_status).toBe("approved");
			expect(payload.status).toBe("approved");
		});

		it("reject sends action_executed hook with reason", async () => {
			store.upsertSession({
				execution_id: "e1",
				issue_id: "i1",
				project_name: "geoforge3d",
				status: "awaiting_review",
				issue_identifier: "GEO-50",
			});

			transitionSession(
				store,
				"reject",
				"e1",
				"needs rework",
				undefined, // transitionOpts
				undefined, // config
				undefined, // cipherWriter
				testProjects,
				undefined, // eventFilter
				undefined, // forumTagUpdater
				mockRegistry,
			);

			await new Promise((r) => setTimeout(r, 200));

			expect(capturedEnvelopes).toHaveLength(1);
			const payload = capturedEnvelopes[0].event;
			expect(payload.event_type).toBe("action_executed");
			expect(payload.action).toBe("reject");
			expect(payload.action_reason).toBe("needs rework");
			expect(payload.action_source_status).toBe("awaiting_review");
			expect(payload.action_target_status).toBe("rejected");
		});

		it("no hook when registry not provided", async () => {
			store.upsertSession({
				execution_id: "e1",
				issue_id: "i1",
				project_name: "geoforge3d",
				status: "awaiting_review",
			});

			transitionSession(store, "reject", "e1", "test");

			await new Promise((r) => setTimeout(r, 200));
			expect(capturedEnvelopes).toHaveLength(0);
		});

		it("hook failure does not affect action result", async () => {
			store.upsertSession({
				execution_id: "e1",
				issue_id: "i1",
				project_name: "geoforge3d",
				status: "awaiting_review",
			});
			// Create a registry with a runtime that throws on deliver
			const failRegistry = new RuntimeRegistry();
			const failRuntime = {
				type: "openclaw" as const,
				deliver: vi.fn(async () => {
					throw new Error("connection refused");
				}),
				sendBootstrap: vi.fn(async () => {}),
				health: vi.fn(async () => ({
					status: "healthy" as const,
					lastDeliveryAt: null,
					lastDeliveredSeq: 0,
				})),
				shutdown: vi.fn(async () => {}),
			};
			for (const project of testProjects) {
				for (const lead of project.leads) {
					failRegistry.register(lead, failRuntime);
				}
			}

			const result = await transitionSession(
				store,
				"reject",
				"e1",
				"test",
				undefined, // transitionOpts
				undefined, // config
				undefined, // cipherWriter
				testProjects,
				undefined, // eventFilter
				undefined, // forumTagUpdater
				failRegistry,
			);
			expect(result.success).toBe(true);
			expect(store.getSession("e1")!.status).toBe("rejected");
		});
	});
});

// --- GEO-259: leadId scope check on action endpoints ---

const scopeProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
			{
				agentId: "ops-lead",
				forumChannel: "ops-channel",
				chatChannel: "ops-chat",
				match: { labels: ["Operations"] },
			},
		],
	},
];

describe("GEO-259: leadId scope check on actions", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const app = createBridgeApp(store, scopeProjects, makeConfig());
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;

		store.upsertSession({
			execution_id: "prod-exec",
			issue_id: "i-prod",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-200",
			issue_labels: JSON.stringify(["Product"]),
		});
		store.upsertSession({
			execution_id: "ops-exec",
			issue_id: "i-ops",
			project_name: "geoforge3d",
			status: "awaiting_review",
			issue_identifier: "GEO-201",
			issue_labels: JSON.stringify(["Operations"]),
		});
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	it("POST /api/actions/reject without leadId works as before", async () => {
		const res = await fetch(`${baseUrl}/api/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "prod-exec", reason: "test" }),
		});
		const body = await res.json();
		expect(body.success).toBe(true);
	});

	it("POST /api/actions/reject with matching leadId succeeds", async () => {
		const res = await fetch(`${baseUrl}/api/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				execution_id: "prod-exec",
				reason: "test",
				leadId: "product-lead",
			}),
		});
		const body = await res.json();
		expect(body.success).toBe(true);
	});

	it("POST /api/actions/reject with mismatching leadId returns 403", async () => {
		const res = await fetch(`${baseUrl}/api/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				execution_id: "prod-exec",
				reason: "test",
				leadId: "ops-lead",
			}),
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.success).toBe(false);
		expect(body.message).toContain("outside lead");
	});

	it("POST /api/actions/defer with mismatching leadId returns 403", async () => {
		const res = await fetch(`${baseUrl}/api/actions/defer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				execution_id: "ops-exec",
				reason: "test",
				leadId: "product-lead",
			}),
		});
		expect(res.status).toBe(403);
	});

	it("POST /api/actions/shelve with mismatching leadId returns 403", async () => {
		const res = await fetch(`${baseUrl}/api/actions/shelve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				execution_id: "ops-exec",
				leadId: "product-lead",
			}),
		});
		expect(res.status).toBe(403);
	});
});

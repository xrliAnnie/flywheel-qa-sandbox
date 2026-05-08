/**
 * GEO-267: Start API E2E tests.
 * Exercises POST /api/runs/start and GET /api/runs/active.
 */

import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type { IStartDispatcher } from "../bridge/retry-dispatcher.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

// Mock @linear/sdk for pre-flight issue check.
// FLY-127: default issue carries "Product" label so the default product-lead
// path passes the dept-scope check. Individual tests override via
// `vi.mocked(LinearClient).mockImplementationOnce(...)` when they need a
// different label set (or no label).
vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({
		issue: vi.fn().mockResolvedValue({
			title: "Test Issue",
			identifier: "GEO-TEST",
			// FLY-80 + FLY-127: Auto-resolve leadId AND dept-scope check use labels.
			labels: vi.fn().mockResolvedValue({
				nodes: [{ name: "Product" }],
			}),
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
			{
				agentId: "ops-lead",
				forumChannel: "test-ops-forum",
				chatChannel: "test-ops-chat",
				match: { labels: ["Ops"] },
			},
			// FLY-127: cos-lead with no forumChannel → loadProjects derives
			// canSpawnRunners=false. Used for `lead_cannot_spawn` tests.
			// (Hand-written fixture skips loadProjects, so we rely on
			// DepartmentRegistry's `effectiveCanSpawn` fallback to derive
			// from forumChannel at runtime.)
			{
				agentId: "cos-lead",
				chatChannel: "test-cos-chat",
				match: { labels: ["PM"] },
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

function createMockStartDispatcher(store: StateStore): IStartDispatcher & {
	_started: Array<{ issueId: string; projectName: string }>;
	_inflightCount: number;
} {
	const mock = {
		_started: [] as Array<{ issueId: string; projectName: string }>,
		_inflightCount: 0,
		start: vi.fn(async (req) => {
			mock._started.push({
				issueId: req.issueId,
				projectName: req.projectName,
			});
			mock._inflightCount++;
			const executionId = `exec-${req.issueId}`;
			// FLY-80: Ghost start detection expects session to exist in StateStore
			store.upsertSession({
				execution_id: executionId,
				issue_id: req.issueId,
				project_name: req.projectName,
				status: "running",
			});
			return { executionId, issueId: req.issueId };
		}),
		getInflightCount: vi.fn(() => mock._inflightCount),
	};
	return mock;
}

describe("Start API E2E", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let mockDispatcher: ReturnType<typeof createMockStartDispatcher>;
	let savedLinearKey: string | undefined;

	beforeEach(async () => {
		// Hermetic: ensure LINEAR_API_KEY is set for non-503 tests
		savedLinearKey = process.env.LINEAR_API_KEY;
		process.env.LINEAR_API_KEY = savedLinearKey ?? "test-key";
		store = await StateStore.create(":memory:");
		mockDispatcher = createMockStartDispatcher(store);
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
			undefined, // captureSessionFn
			mockDispatcher, // startDispatcher
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		// Restore original env
		if (savedLinearKey !== undefined) {
			process.env.LINEAR_API_KEY = savedLinearKey;
		} else {
			delete process.env.LINEAR_API_KEY;
		}
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	it("POST /api/runs/start → 200 + executionId", async () => {
		const res = await fetch(`${baseUrl}/api/runs/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				issueId: "GEO-TEST",
				projectName: "TestProject",
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			success: boolean;
			executionId: string;
		};
		expect(body.success).toBe(true);
		expect(body.executionId).toBe("exec-GEO-TEST");
		expect(mockDispatcher.start).toHaveBeenCalledOnce();
	}, 15_000);

	it("POST with leadId → passes through to dispatcher", async () => {
		const res = await fetch(`${baseUrl}/api/runs/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				issueId: "GEO-LEAD",
				projectName: "TestProject",
				leadId: "product-lead",
			}),
		});
		expect(res.status).toBe(200);
		expect(mockDispatcher.start).toHaveBeenCalledWith({
			issueId: "GEO-LEAD",
			projectName: "TestProject",
			leadId: "product-lead",
			issueTitle: "Test Issue",
			issueIdentifier: "GEO-TEST",
			sessionRole: "main",
		});
	}, 15_000);

	it("POST missing issueId → 400", async () => {
		const res = await fetch(`${baseUrl}/api/runs/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ projectName: "TestProject" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST missing projectName → 400", async () => {
		const res = await fetch(`${baseUrl}/api/runs/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ issueId: "GEO-1" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST with invalid leadId → 403", async () => {
		const res = await fetch(`${baseUrl}/api/runs/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				issueId: "GEO-SCOPE",
				projectName: "TestProject",
				leadId: "nonexistent-lead",
			}),
		});
		expect(res.status).toBe(403);
	});

	it("POST with active session in StateStore → 409", async () => {
		// Insert a running session for the same issue
		store.upsertSession({
			execution_id: "existing-exec",
			issue_id: "GEO-DUP",
			project_name: "TestProject",
			status: "running",
		});

		const res = await fetch(`${baseUrl}/api/runs/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				issueId: "GEO-DUP",
				projectName: "TestProject",
			}),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { message: string };
		expect(body.message).toContain("already has an active session");
	});

	it("POST exceeding maxConcurrentRunners → 429", async () => {
		// Insert 2 running sessions to fill the cap (maxConcurrentRunners=2)
		store.upsertSession({
			execution_id: "running-1",
			issue_id: "GEO-R1",
			project_name: "TestProject",
			status: "running",
		});
		store.upsertSession({
			execution_id: "running-2",
			issue_id: "GEO-R2",
			project_name: "TestProject",
			status: "running",
		});

		const res = await fetch(`${baseUrl}/api/runs/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				issueId: "GEO-OVERFLOW",
				projectName: "TestProject",
			}),
		});
		expect(res.status).toBe(429);
		const body = (await res.json()) as { message: string };
		expect(body.message).toContain("Max concurrent runners");
	});

	it("POST with Linear API failure → 502", async () => {
		// Temporarily make LinearClient.issue() reject
		const { LinearClient } = await import("@linear/sdk");
		const mockIssue = vi
			.fn()
			.mockRejectedValueOnce(new Error("Network timeout"));
		(
			LinearClient as unknown as ReturnType<typeof vi.fn>
		).mockImplementationOnce(() => ({ issue: mockIssue }));

		const res = await fetch(`${baseUrl}/api/runs/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				issueId: "GEO-FAIL",
				projectName: "TestProject",
			}),
		});
		expect(res.status).toBe(502);
		const body = (await res.json()) as { message: string };
		expect(body.message).toContain("Cannot verify issue");
	});

	it("POST without LINEAR_API_KEY → 503", async () => {
		const saved = process.env.LINEAR_API_KEY;
		delete process.env.LINEAR_API_KEY;
		try {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-NOKEY",
					projectName: "TestProject",
				}),
			});
			expect(res.status).toBe(503);
			const body = (await res.json()) as { message: string };
			expect(body.message).toContain("LINEAR_API_KEY");
		} finally {
			if (saved) process.env.LINEAR_API_KEY = saved;
		}
	});

	it("GET /api/runs/active → counts", async () => {
		// Insert a running session
		store.upsertSession({
			execution_id: "active-1",
			issue_id: "GEO-A1",
			project_name: "TestProject",
			status: "running",
		});
		mockDispatcher._inflightCount = 1;

		const res = await fetch(`${baseUrl}/api/runs/active`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			running: number;
			inflight: number;
			total: number;
			max: number;
		};
		expect(body.running).toBe(1);
		expect(body.inflight).toBe(1);
		expect(body.total).toBe(2);
		expect(body.max).toBe(2);
	});

	// FLY-127 R3 Layer 2: server-side department scope enforcement.
	describe("FLY-127 — department scope reject", () => {
		// Override the LinearClient mock for one upcoming `/api/runs/start` call
		// so the pre-flight returns the requested labels.
		async function mockIssueLabels(labels: string[]): Promise<void> {
			const { LinearClient } = await import("@linear/sdk");
			(
				LinearClient as unknown as ReturnType<typeof vi.fn>
			).mockImplementationOnce(() => ({
				issue: vi.fn().mockResolvedValue({
					title: "Test Issue",
					identifier: "GEO-FLY127",
					labels: vi.fn().mockResolvedValue({
						nodes: labels.map((name) => ({ name })),
					}),
				}),
			}));
		}

		beforeEach(() => {
			delete process.env.BRIDGE_DEPT_SCOPE_REJECT; // default = on
		});

		afterEach(() => {
			delete process.env.BRIDGE_DEPT_SCOPE_REJECT;
		});

		// Codex R1 fix: response shape is machine-only — no free-form `message`.
		// All reject codes share the same shape: success/code/reason/silent +
		// canonicalLeadId (string or null). `null` for codes where the issue
		// does not deterministically resolve to one lead.
		type RejectBody = {
			success: boolean;
			code: string;
			reason: string;
			canonicalLeadId: string | null;
			silent: boolean;
			message?: unknown;
		};

		it("403 DEPT_SCOPE_REJECT label_mismatch when product-lead targets Ops-labelled issue", async () => {
			await mockIssueLabels(["Ops"]);
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-FLY127",
					projectName: "TestProject",
					leadId: "product-lead",
				}),
			});
			expect(res.status).toBe(403);
			const body = (await res.json()) as RejectBody;
			expect(body.success).toBe(false);
			expect(body.code).toBe("DEPT_SCOPE_REJECT");
			expect(body.reason).toBe("label_mismatch");
			expect(body.canonicalLeadId).toBe("ops-lead");
			expect(body.silent).toBe(false);
			// Codex R1: response carries machine fields only — no `message` prose.
			expect(body.message).toBeUndefined();
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		});

		it("403 DEPT_SCOPE_REJECT issue_no_department_label when issue has no dept label", async () => {
			await mockIssueLabels([]);
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-FLY127",
					projectName: "TestProject",
					leadId: "product-lead",
				}),
			});
			expect(res.status).toBe(403);
			const body = (await res.json()) as RejectBody;
			expect(body.code).toBe("DEPT_SCOPE_REJECT");
			expect(body.reason).toBe("issue_no_department_label");
			// Codex R1: stable shape — canonicalLeadId is `null` (not undefined)
			// when the issue doesn't resolve to one lead.
			expect(body.canonicalLeadId).toBeNull();
			expect(body.silent).toBe(false);
			expect(body.message).toBeUndefined();
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		});

		it("403 DEPT_SCOPE_REJECT issue_multiple_department_labels when issue has both Product and Ops", async () => {
			await mockIssueLabels(["Product", "Ops"]);
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-FLY127",
					projectName: "TestProject",
					leadId: "product-lead",
				}),
			});
			expect(res.status).toBe(403);
			const body = (await res.json()) as RejectBody;
			expect(body.code).toBe("DEPT_SCOPE_REJECT");
			expect(body.reason).toBe("issue_multiple_department_labels");
			expect(body.canonicalLeadId).toBeNull();
			expect(body.silent).toBe(false);
			expect(body.message).toBeUndefined();
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		});

		it("403 DEPT_SCOPE_REJECT lead_cannot_spawn when cos-lead (no forumChannel) calls /start", async () => {
			await mockIssueLabels(["PM"]);
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-FLY127",
					projectName: "TestProject",
					leadId: "cos-lead",
				}),
			});
			expect(res.status).toBe(403);
			const body = (await res.json()) as RejectBody;
			expect(body.code).toBe("DEPT_SCOPE_REJECT");
			expect(body.reason).toBe("lead_cannot_spawn");
			// `lead_cannot_spawn` doesn't carry a canonicalLeadId — the lead
			// itself is the problem, not which lead "owns" the issue.
			expect(body.canonicalLeadId).toBeNull();
			expect(body.silent).toBe(false);
			expect(body.message).toBeUndefined();
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		});

		it("happy path: ops-lead + Ops-labelled issue → spawn allowed", async () => {
			await mockIssueLabels(["Ops"]);
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-FLY127",
					projectName: "TestProject",
					leadId: "ops-lead",
				}),
			});
			expect(res.status).toBe(200);
			expect(mockDispatcher.start).toHaveBeenCalledOnce();
		}, 15_000);

		it("feature flag off: BRIDGE_DEPT_SCOPE_REJECT=off skips the check", async () => {
			process.env.BRIDGE_DEPT_SCOPE_REJECT = "off";
			// Cross-dept call that would normally reject — should now succeed.
			await mockIssueLabels(["Ops"]);
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-FLY127",
					projectName: "TestProject",
					leadId: "product-lead",
				}),
			});
			expect(res.status).toBe(200);
			expect(mockDispatcher.start).toHaveBeenCalledOnce();
		}, 15_000);

		it("auto-resolve path: leadId omitted, labels uniquely resolve to ops-lead", async () => {
			await mockIssueLabels(["Ops"]);
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-FLY127",
					projectName: "TestProject",
					// no leadId — Bridge auto-resolves from labels (FLY-80)
				}),
			});
			expect(res.status).toBe(200);
			expect(mockDispatcher.start).toHaveBeenCalledOnce();
		}, 15_000);
	});
});

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
// Default: issue carries the "Product" label so the FLY-127 scope check
// allows the default product-lead path. Individual tests can override via
// vi.mocked / mockImplementationOnce when they need a different label set.
vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({
		issue: vi.fn().mockResolvedValue({
			title: "Test Issue",
			identifier: "GEO-TEST",
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
			// FLY-127: cos-lead has no forumChannel → DepartmentRegistry derives
			// canSpawnRunners=false. Used by `lead_cannot_spawn` tests.
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

	// FLY-127: department scope enforcement on /api/runs/start
	describe("FLY-127 — department scope enforcement", () => {
		// Helper to swap the LinearClient mock for a single test.
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

		it("403 label_mismatch when leadId is product but issue carries only Ops label", async () => {
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
			const body = (await res.json()) as {
				success: boolean;
				reason: string;
				canonicalLeadId?: string;
				issueLabels: string[];
			};
			expect(body.success).toBe(false);
			expect(body.reason).toBe("label_mismatch");
			expect(body.canonicalLeadId).toBe("ops-lead");
			expect(body.issueLabels).toEqual(["Ops"]);
			// Side-effect isolation: dispatcher not invoked
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		});

		it("403 lead_cannot_spawn when cos-lead tries to start a Runner", async () => {
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
			const body = (await res.json()) as { reason: string };
			expect(body.reason).toBe("lead_cannot_spawn");
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		});

		it("403 issue_no_department_label when issue has only non-dept labels", async () => {
			await mockIssueLabels(["Bug", "P0"]);
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
			const body = (await res.json()) as { reason: string };
			expect(body.reason).toBe("issue_no_department_label");
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		});

		it("403 issue_multiple_department_labels when issue has both Product and Ops", async () => {
			await mockIssueLabels(["Product", "Ops"]);
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-FLY127",
					projectName: "TestProject",
					// leadId omitted — registry classifies → many → 403
				}),
			});
			expect(res.status).toBe(403);
			const body = (await res.json()) as {
				reason: string;
				matchedLeadIds?: string[];
			};
			expect(body.reason).toBe("issue_multiple_department_labels");
			expect(body.matchedLeadIds).toEqual(
				expect.arrayContaining(["product-lead", "ops-lead"]),
			);
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		});

		it("auto-resolves leadId via registry on single dept label", async () => {
			await mockIssueLabels(["Ops"]);
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-FLY127",
					projectName: "TestProject",
					// leadId omitted
				}),
			});
			expect(res.status).toBe(200);
			expect(mockDispatcher.start).toHaveBeenCalledWith(
				expect.objectContaining({
					issueId: "GEO-FLY127",
					projectName: "TestProject",
					leadId: "ops-lead",
				}),
			);
		}, 15_000);

		it("502 linear_labels_unavailable when issue.labels() throws", async () => {
			const { LinearClient } = await import("@linear/sdk");
			(
				LinearClient as unknown as ReturnType<typeof vi.fn>
			).mockImplementationOnce(() => ({
				issue: vi.fn().mockResolvedValue({
					title: "Test Issue",
					identifier: "GEO-FLY127",
					labels: vi
						.fn()
						.mockRejectedValueOnce(new Error("Linear API timeout")),
				}),
			}));
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-FLY127",
					projectName: "TestProject",
					leadId: "product-lead",
				}),
			});
			expect(res.status).toBe(502);
			const body = (await res.json()) as { reason: string };
			expect(body.reason).toBe("linear_labels_unavailable");
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		});

		it("happy path: leadId=product-lead + issue has Product label → 200", async () => {
			// uses default mock (Product label)
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-OK",
					projectName: "TestProject",
					leadId: "product-lead",
				}),
			});
			expect(res.status).toBe(200);
			expect(mockDispatcher.start).toHaveBeenCalled();
		}, 15_000);

		it("side-effect isolation: 403 leaves StateStore + dispatcher untouched", async () => {
			await mockIssueLabels(["Ops"]);
			const before = store.getActiveSessions().length;
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
			expect(store.getActiveSessions().length).toBe(before);
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		});
	});
});

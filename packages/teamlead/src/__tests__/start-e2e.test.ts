/**
 * GEO-267: Start API E2E tests.
 * Exercises POST /api/runs/start and GET /api/runs/active.
 */

import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type { IStartDispatcher } from "../bridge/retry-dispatcher.js";
import {
	AdmissionDeferredError,
	RunnerAdmissionController,
} from "../bridge/runner-admission.js";
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
			// FLY-205: issue URL captured at preflight for DOC-FLOW header continuity
			url: "https://linear.app/test/issue/GEO-TEST",
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
			// FLY-127 / FLY-163: cos-lead has explicit canSpawnRunners: false.
			// Used for `lead_cannot_spawn` tests. (Hand-written fixture skips
			// loadProjects PM/Triage validator, so we set the field directly.)
			{
				agentId: "cos-lead",
				chatChannel: "test-cos-chat",
				match: { labels: ["PM"] },
				canSpawnRunners: false,
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
		runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
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
				leadId: "product-lead",
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

	it("FLY-859: body-injected phaseFixContext / shareParentBranch NEVER reach the dispatcher (Bridge-INTERNAL fields)", async () => {
		const res = await fetch(`${baseUrl}/api/runs/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				issueId: "GEO-INJECT",
				projectName: "TestProject",
				leadId: "product-lead",
				phaseFixContext: { round: 9, qaSummary: "injected" },
				shareParentBranch: true,
			}),
		});
		expect(res.status).toBe(200);
		const req = mockDispatcher.start.mock.calls.at(-1)?.[0] as Record<
			string,
			unknown
		>;
		expect(req.phaseFixContext).toBeUndefined();
		expect(req.shareParentBranch).toBeUndefined();
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
			// FLY-137 v1.27.2: dept-aware dispatch context threaded from
			// runs-route. agentName omitted by default; issueLabels carries
			// lowercased Linear labels; owningDept resolved via
			// DepartmentRegistry from the "Product" mock label.
			agentName: undefined,
			issueLabels: ["product"],
			owningDept: "product",
			// FLY-137 Phase 5: codex-skip label snapshot at run start.
			// Mock issue has no codex-skip label → false.
			codexSkip: false,
			// FLY-205: docTier omitted → undefined (effective full downstream);
			// issueUrl captured from the Linear preflight mock.
			docTier: undefined,
			issueUrl: "https://linear.app/test/issue/GEO-TEST",
			// FLY-615: per-run/per-issue ponytail signal. No body.ponytail → no
			// runOverride; labels from the mock issue; readable.
			ponytailInput: {
				kind: "start_signal",
				signal: { labels: ["product"], labelStatus: "readable" },
			},
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
		// FLY-229: the 409 hints re-engagement instead of terminate+new-run.
		expect(body.message).toContain("re-engage");
		expect(body.message).toContain("runner_terminal_list");
	});

	it("FLY-123 WS-D (P4): POST deferred under resource pressure → 429 (load_pressure, no count cap)", async () => {
		// Resource-based backpressure replaces the retired N-cap: a Bridge whose
		// admission controller is under load defers a NEW runner regardless of
		// how many already run. Spin a separate app with a deferring controller.
		const deferApp = createBridgeApp(
			store,
			testProjects,
			makeConfig({ runnerAdmission: RunnerAdmissionController.alwaysDefer() }),
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
			mockDispatcher,
		);
		const deferServer = deferApp.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) =>
			deferServer.once("listening", resolve),
		);
		const addr = deferServer.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-OVERFLOW",
					projectName: "TestProject",
				}),
			});
			expect(res.status).toBe(429);
			const body = (await res.json()) as { message: string; reason?: string };
			expect(body.reason).toBe("load_pressure");
			expect(body.message).toContain("admission deferred");
		} finally {
			await new Promise<void>((resolve, reject) =>
				deferServer.close((e) => (e ? reject(e) : resolve())),
			);
		}
	});

	it("FLY-123 WS-D (R1 #4): dispatcher-side admission race → typed 429, NOT 500", async () => {
		// Route precheck admits (default makeConfig = alwaysAdmit), but the
		// dispatcher's own check defers (load crossed the threshold in between)
		// and throws AdmissionDeferredError. The catch must map it to 429 with
		// the reason — never a 500 string-match miss.
		const throwingDispatcher = {
			...mockDispatcher,
			start: vi.fn(async () => {
				throw new AdmissionDeferredError(
					"memory_pressure",
					"free 100MB < floor 1024MB",
				);
			}),
		} as unknown as typeof mockDispatcher;
		const raceApp = createBridgeApp(
			store,
			testProjects,
			makeConfig(), // route admits
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
			throwingDispatcher,
		);
		const raceServer = raceApp.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => raceServer.once("listening", resolve));
		const addr = raceServer.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-RACE",
					projectName: "TestProject",
					leadId: "product-lead",
				}),
			});
			expect(res.status).toBe(429);
			const body = (await res.json()) as { reason?: string };
			expect(body.reason).toBe("memory_pressure");
		} finally {
			await new Promise<void>((resolve, reject) =>
				raceServer.close((e) => (e ? reject(e) : resolve())),
			);
		}
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

	it("POST with missing Linear issue → 404 before identity enforcement", async () => {
		const { LinearClient } = await import("@linear/sdk");
		const mockIssue = vi.fn().mockResolvedValueOnce(null);
		(
			LinearClient as unknown as ReturnType<typeof vi.fn>
		).mockImplementationOnce(() => ({ issue: mockIssue }));

		const res = await fetch(`${baseUrl}/api/runs/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				issueId: "GEO-MISSING",
				projectName: "TestProject",
			}),
		});
		expect(res.status).toBe(404);
		expect(mockIssue).toHaveBeenCalledOnce();
		expect(mockDispatcher.start).not.toHaveBeenCalled();
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
			max: number | null;
		};
		expect(body.running).toBe(1);
		expect(body.inflight).toBe(1);
		expect(body.total).toBe(2);
		// FLY-123 WS-D (P4): uncapped — `null` = unbounded (never `max: 0`).
		expect(body.max).toBeNull();
	});

	// FLY-127 R3 Layer 2: server-side department scope enforcement.
	describe("FLY-127 — department scope reject", () => {
		// Override the LinearClient mock for one upcoming `/api/runs/start` call
		// so the pre-flight returns the requested labels.
		async function mockIssueLabels(labels: string[]): Promise<{
			issue: ReturnType<typeof vi.fn>;
			labels: ReturnType<typeof vi.fn>;
		}> {
			const { LinearClient } = await import("@linear/sdk");
			const labelsFn = vi.fn().mockResolvedValue({
				nodes: labels.map((name) => ({ name })),
			});
			const issueFn = vi.fn().mockResolvedValue({
				title: "Test Issue",
				identifier: "GEO-FLY127",
				labels: labelsFn,
			});
			(
				LinearClient as unknown as ReturnType<typeof vi.fn>
			).mockImplementationOnce(() => ({
				issue: issueFn,
			}));
			return { issue: issueFn, labels: labelsFn };
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

		it("403 DEPT_SCOPE_REJECT lead_cannot_spawn when cos-lead (canSpawnRunners: false) calls /start", async () => {
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

		it.each([
			["omitted", undefined],
			["blank", " \t "],
		])(
			"feature flag off: %s identity retains owner auto-resolution",
			async (_label, leadId) => {
				process.env.BRIDGE_DEPT_SCOPE_REJECT = "off";
				await mockIssueLabels(["Ops"]);
				const res = await fetch(`${baseUrl}/api/runs/start`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						issueId: "GEO-FLY127-ROLLBACK",
						projectName: "TestProject",
						...(leadId !== undefined && { leadId }),
					}),
				});
				expect(res.status).toBe(200);
				expect(mockDispatcher.start).toHaveBeenCalledOnce();
				expect(mockDispatcher.start).toHaveBeenCalledWith(
					expect.objectContaining({
						leadId: "ops-lead",
						owningDept: "ops",
					}),
				);
			},
			15_000,
		);

		it("allows only Oliver to dispatch the same Oliver-owned issue", async () => {
			await mockIssueLabels(["Ops"]);
			const peter = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-366",
					projectName: "TestProject",
					leadId: "product-lead",
				}),
			});
			expect(peter.status).toBe(403);
			expect(await peter.json()).toEqual({
				success: false,
				code: "DEPT_SCOPE_REJECT",
				reason: "label_mismatch",
				canonicalLeadId: "ops-lead",
				silent: false,
			});

			await mockIssueLabels(["Ops"]);
			const oliver = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-366",
					projectName: "TestProject",
					leadId: "ops-lead",
				}),
			});
			expect(oliver.status).toBe(200);
			expect(mockDispatcher.start).toHaveBeenCalledOnce();
			expect(mockDispatcher.start).toHaveBeenCalledWith(
				expect.objectContaining({
					issueId: "GEO-366",
					leadId: "ops-lead",
					owningDept: "ops",
				}),
			);
		}, 15_000);

		it("requires explicit Lead identity before owner auto-resolution", async () => {
			const linear = await mockIssueLabels(["Ops"]);
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-FLY127",
					projectName: "TestProject",
					// no leadId — enforcement must reject before legacy auto-resolution
				}),
			});
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({
				success: false,
				code: "DEPT_SCOPE_REJECT",
				reason: "lead_identity_required",
				canonicalLeadId: null,
				silent: false,
			});
			expect(linear.issue).toHaveBeenCalledOnce();
			expect(linear.labels).toHaveBeenCalledOnce();
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		}, 15_000);

		it.each([
			["null", null],
			["empty", ""],
			["blank", " \t "],
		])(
			"rejects %s Lead identity after Linear preflight",
			async (_label, leadId) => {
				const linear = await mockIssueLabels(["Ops"]);
				const res = await fetch(`${baseUrl}/api/runs/start`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						issueId: "GEO-FLY127",
						projectName: "TestProject",
						leadId,
					}),
				});
				expect(res.status).toBe(403);
				expect(await res.json()).toEqual({
					success: false,
					code: "DEPT_SCOPE_REJECT",
					reason: "lead_identity_required",
					canonicalLeadId: null,
					silent: false,
				});
				expect(linear.issue).toHaveBeenCalledOnce();
				expect(linear.labels).toHaveBeenCalledOnce();
				expect(mockDispatcher.start).not.toHaveBeenCalled();
			},
			15_000,
		);

		it.each([
			["number", 42],
			["object", { agentId: "ops-lead" }],
		])(
			"rejects %s Lead identity with a boundary error",
			async (_label, leadId) => {
				const { LinearClient } = await import("@linear/sdk");
				const linearClient = LinearClient as unknown as ReturnType<
					typeof vi.fn
				>;
				linearClient.mockClear();
				const res = await fetch(`${baseUrl}/api/runs/start`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						issueId: "GEO-FLY127",
						projectName: "TestProject",
						leadId,
					}),
				});
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({
					success: false,
					code: "INVALID_LEAD_ID",
					reason: "wrong_type",
					silent: false,
				});
				expect(linearClient).not.toHaveBeenCalled();
				expect(mockDispatcher.start).not.toHaveBeenCalled();
			},
			15_000,
		);
	});

	// FLY-205 — docTier boundary validation + transport + persistence
	describe("FLY-205 — docTier", () => {
		it("valid docTier passes through to dispatcher and persists EFFECTIVE tier + issue_url", async () => {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-TEST",
					projectName: "TestProject",
					leadId: "product-lead",
					docTier: "plan_only",
				}),
			});
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			expect(startReq.docTier).toBe("plan_only");
			expect(startReq.issueUrl).toBe("https://linear.app/test/issue/GEO-TEST");
			const session = store.getSession("exec-GEO-TEST");
			expect(session?.doc_tier).toBe("plan_only");
			expect(session?.issue_url).toBe("https://linear.app/test/issue/GEO-TEST");
		}, 15_000);

		it("invalid docTier → 400 INVALID_DOC_TIER (boundary-validated, never reaches dispatcher)", async () => {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-TEST",
					projectName: "TestProject",
					docTier: "medium",
				}),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as {
				code: string;
				allowed: string[];
			};
			expect(body.code).toBe("INVALID_DOC_TIER");
			expect(body.allowed).toEqual(["full", "plan_only", "none"]);
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		}, 15_000);

		it("omitted docTier → dispatcher gets undefined, session persists effective 'full'", async () => {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-TEST",
					projectName: "TestProject",
					leadId: "product-lead",
				}),
			});
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			expect(startReq.docTier).toBeUndefined();
			// EFFECTIVE tier persisted: retry must reuse "full" explicitly,
			// never re-default (Codex design R2 #1).
			const session = store.getSession("exec-GEO-TEST");
			expect(session?.doc_tier).toBe("full");
		}, 15_000);
	});

	// FLY-728 Part C — dispatch `model` param boundary validation + normalization.
	describe("FLY-728 — dispatch model param", () => {
		it("valid tier id passes through to the dispatcher as dispatchModel", async () => {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-TEST",
					projectName: "TestProject",
					leadId: "product-lead",
					model: "claude-fable-5",
				}),
			});
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			expect(startReq.dispatchModel).toBe("claude-fable-5");
			// FLY-728: persisted as the source-honest retry input dispatch_model.
			expect(store.getSession("exec-GEO-TEST")?.dispatch_model).toBe(
				"claude-fable-5",
			);
		}, 15_000);

		it("a bare alias is normalized to the canonical id before dispatch", async () => {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-TEST",
					projectName: "TestProject",
					leadId: "product-lead",
					model: "opus",
				}),
			});
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			// FLY-751: medium tier dropped [1m] — `opus` is small-context now.
			expect(startReq.dispatchModel).toBe("claude-opus-4-8");
		}, 15_000);

		it("FLY-751: opus-1m opt-in normalizes to the [1m] id before dispatch", async () => {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-TEST",
					projectName: "TestProject",
					leadId: "product-lead",
					model: "opus-1m",
				}),
			});
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			expect(startReq.dispatchModel).toBe("claude-opus-4-8[1m]");
		}, 15_000);

		it("unknown model → 400 INVALID_MODEL (never reaches dispatcher)", async () => {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-TEST",
					projectName: "TestProject",
					model: "gpt-5.5-codex",
				}),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { code: string; reason: string };
			expect(body.code).toBe("INVALID_MODEL");
			expect(body.reason).toBe("unknown_model");
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		}, 15_000);

		it("omitted model → dispatcher gets undefined dispatchModel (byte-compat)", async () => {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-TEST",
					projectName: "TestProject",
					leadId: "product-lead",
				}),
			});
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			expect(startReq.dispatchModel).toBeUndefined();
		}, 15_000);
	});

	// FLY-534 — projectName is case-insensitive. The configured project is
	// "TestProject"; a caller sending it differently-cased ("testproject" /
	// "TESTPROJECT") must resolve to the SAME runtime, and the dispatcher (plus
	// every downstream surface — comm.db, tmux, BlueprintContext) must receive
	// the configured CANONICAL name, not the caller's casing. Before the fix the
	// case mismatch surfaced as DEPT_SCOPE_REJECT project_unknown / No runtime.
	describe("FLY-534 — projectName case-insensitive", () => {
		it("lowercase projectName resolves + dispatcher receives the canonical name", async () => {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-CASE-LO",
					projectName: "testproject", // canonical is "TestProject"
					leadId: "product-lead",
				}),
			});
			// Resolves (200), NOT a project_unknown reject.
			expect(res.status).toBe(200);
			// The dispatcher — and thus comm.db/tmux/BlueprintContext — gets the
			// configured exact name, never the caller's "testproject".
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			expect(startReq.projectName).toBe("TestProject");
		}, 15_000);

		it("uppercase projectName resolves to the canonical name too", async () => {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-CASE-UP",
					projectName: "TESTPROJECT",
					leadId: "product-lead",
				}),
			});
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			expect(startReq.projectName).toBe("TestProject");
		}, 15_000);

		it("exact-case projectName is unchanged (byte-compatible)", async () => {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-CASE-EXACT",
					projectName: "TestProject",
					leadId: "product-lead",
				}),
			});
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			expect(startReq.projectName).toBe("TestProject");
		}, 15_000);
	});
});

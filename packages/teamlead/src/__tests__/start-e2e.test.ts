/**
 * GEO-267: Start API E2E tests.
 * Exercises POST /api/runs/start and GET /api/runs/active.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
	ensureDefaultWorkflowBindings,
	importBundledWorkflowSeeds,
} from "../workflow-template.js";

// Mock @linear/sdk for pre-flight issue check.
// FLY-127: default issue carries "Product" label so the default product-lead
// path passes the dept-scope check. Individual tests override via
// `vi.mocked(LinearClient).mockImplementationOnce(...)` when they need a
// different label set (or no label).
vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({
		issue: vi.fn().mockResolvedValue({
			id: "11111111-1111-4111-8111-111111111111",
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
			const executionId = req.successorExecutionId ?? `exec-${req.issueId}`;
			// FLY-80: Ghost start detection expects session to exist in StateStore
			store.upsertSession({
				execution_id: executionId,
				issue_id: req.issueId,
				project_name: req.projectName,
				status: "running",
				session_role: req.sessionRole ?? "main",
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
		expect(body.executionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(body.executionId).toBe(
			mockDispatcher.start.mock.calls[0]?.[0].successorExecutionId,
		);
		expect(mockDispatcher.start).toHaveBeenCalledOnce();
	}, 15_000);

	it("FLY-859: body-injected phaseFixContext / shareParentBranch NEVER reach the dispatcher (Bridge-INTERNAL fields)", async () => {
		const res = await fetch(`${baseUrl}/api/runs/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				issueId: "GEO-INJECT",
				projectName: "TestProject",
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
			successorExecutionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
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

	it("releases a terminal same-role legacy entry while preserving per-role concurrency", async () => {
		const start = (sessionRole?: "main" | "qa") =>
			fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-ENTRY",
					projectName: "TestProject",
					...(sessionRole ? { sessionRole } : {}),
				}),
			});

		const main = await start();
		expect(main.status).toBe(200);
		const mainExecutionId = ((await main.json()) as { executionId: string })
			.executionId;
		expect(store.getLaunchClaim(mainExecutionId)?.rootUuid).toBe(
			"11111111-1111-4111-8111-111111111111",
		);
		const qa = await start("qa");
		expect(qa.status).toBe(200);
		store.upsertSession({
			execution_id: mainExecutionId,
			issue_id: "GEO-ENTRY",
			project_name: "TestProject",
			status: "failed",
		});
		const retriedMain = await start();
		const retriedMainBody = await retriedMain.clone().text();
		expect(retriedMain.status, retriedMainBody).toBe(200);
		expect(
			((await retriedMain.json()) as { executionId: string }).executionId,
		).not.toBe(mainExecutionId);
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

	// FLY-205 — docTier boundary validation + transport + persistence
	describe("FLY-205 — docTier", () => {
		it("valid docTier passes through to dispatcher and persists EFFECTIVE tier + issue_url", async () => {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-TEST",
					projectName: "TestProject",
					docTier: "plan_only",
				}),
			});
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			expect(startReq.docTier).toBe("plan_only");
			expect(startReq.issueUrl).toBe("https://linear.app/test/issue/GEO-TEST");
			const session = store.getSession(
				mockDispatcher.start.mock.calls[0]![0].successorExecutionId!,
			);
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
				}),
			});
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			expect(startReq.docTier).toBeUndefined();
			// EFFECTIVE tier persisted: retry must reuse "full" explicitly,
			// never re-default (Codex design R2 #1).
			const session = store.getSession(
				mockDispatcher.start.mock.calls[0]![0].successorExecutionId!,
			);
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
					model: "claude-fable-5",
				}),
			});
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			expect(startReq.dispatchModel).toBe("claude-fable-5");
			// FLY-728: persisted as the source-honest retry input dispatch_model.
			expect(
				store.getSession(
					mockDispatcher.start.mock.calls[0]![0].successorExecutionId!,
				)?.dispatch_model,
			).toBe("claude-fable-5");
		}, 15_000);

		it("a bare alias is normalized to the canonical id before dispatch", async () => {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-TEST",
					projectName: "TestProject",
					model: "opus",
				}),
			});
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			// FLY-751: medium tier dropped [1m] — `opus` is small-context now.
			// FLY-1467: the opus tier now binds to Opus 5.
			expect(startReq.dispatchModel).toBe("claude-opus-5");
		}, 15_000);

		it("FLY-751: opus-1m opt-in normalizes to the [1m] id before dispatch", async () => {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-TEST",
					projectName: "TestProject",
					model: "opus-1m",
				}),
			});
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			expect(startReq.dispatchModel).toBe("claude-opus-5[1m]");
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

		it("a legacy identity an old carrier still pins → accepted verbatim", async () => {
			// Back-compat, not endorsement: nothing routes new work to a legacy
			// id, but a carrier pinned before it was retired keeps dispatching.
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-TEST",
					projectName: "TestProject",
					model: "claude-opus-4-8[1m]",
				}),
			});
			expect(res.status).toBe(200);
			expect(mockDispatcher.start).toHaveBeenCalledWith(
				expect.objectContaining({ dispatchModel: "claude-opus-4-8[1m]" }),
			);
		}, 15_000);

		it("omitted model → dispatcher gets undefined dispatchModel (byte-compat)", async () => {
			const res = await fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-TEST",
					projectName: "TestProject",
				}),
			});
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			expect(startReq.dispatchModel).toBeUndefined();
		}, 15_000);
	});

	describe("FLY-1259 — per-dispatch design backend", () => {
		let projectRoot: string;
		let originalProjectRoot: string;
		let savedDesignSwitch: string | undefined;
		let savedThreeStageSwitch: string | undefined;

		function writeThreeStageConfig(channels?: string[]): void {
			const channelBlock = channels
				? `\n  three_stage_channels:\n${channels.map((channel) => `    - ${channel}`).join("\n")}`
				: "";
			writeFileSync(
				join(projectRoot, ".flywheel", "config.yaml"),
				`project: TestProject
linear:
  team_id: TEST
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: dev
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5
decision_layer:
  autonomy_level: observer
  escalation_channel: test
pipeline:
  three_stage: true${channelBlock}
`,
			);
		}

		beforeEach(() => {
			projectRoot = mkdtempSync(join(tmpdir(), "fly1259-start-"));
			mkdirSync(join(projectRoot, ".flywheel"), { recursive: true });
			writeThreeStageConfig();
			originalProjectRoot = testProjects[0]!.projectRoot;
			testProjects[0]!.projectRoot = projectRoot;
			savedDesignSwitch = process.env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN;
			savedThreeStageSwitch = process.env.FLYWHEEL_THREE_STAGE;
			delete process.env.FLYWHEEL_THREE_STAGE;
		});

		afterEach(() => {
			testProjects[0]!.projectRoot = originalProjectRoot;
			rmSync(projectRoot, { recursive: true, force: true });
			if (savedDesignSwitch === undefined) {
				delete process.env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN;
			} else {
				process.env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN = savedDesignSwitch;
			}
			if (savedThreeStageSwitch === undefined) {
				delete process.env.FLYWHEEL_THREE_STAGE;
			} else {
				process.env.FLYWHEEL_THREE_STAGE = savedThreeStageSwitch;
			}
		});

		async function postDesignBackend(
			designBackend: unknown,
			extra: Record<string, unknown> = {},
		): Promise<Response> {
			return fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-FLY1259",
					projectName: "TestProject",
					...(designBackend !== undefined ? { designBackend } : {}),
					...extra,
				}),
			});
		}

		it.each([42, true, "fable", "Codex", ""])(
			"rejects invalid designBackend %# before dispatch",
			async (designBackend) => {
				const res = await postDesignBackend(designBackend);
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({
					success: false,
					code: "INVALID_DESIGN_BACKEND",
					reason:
						typeof designBackend === "string"
							? "unknown_backend"
							: "wrong_type",
					allowed: ["codex", "claude"],
					silent: false,
				});
				expect(mockDispatcher.start).not.toHaveBeenCalled();
			},
		);

		it("global off + explicit codex dispatches Codex and echoes the applied override", async () => {
			process.env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN = "0";
			const res = await postDesignBackend("codex");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				success: true,
				executionId: expect.any(String),
				issueId: "GEO-FLY1259",
				message: "Runner started for GEO-FLY1259",
				designBackend: "codex",
			});
			expect(mockDispatcher.start).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionRole: "design",
					designBackend: "codex",
					dispatchVendor: "codex",
					dispatchModel: "gpt-5.6-sol",
					dispatchEffort: "xhigh",
				}),
			);
		});

		it("global on + explicit claude dispatches Fable and echoes the applied override", async () => {
			process.env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN = "1";
			const res = await postDesignBackend("claude");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				success: true,
				executionId: expect.any(String),
				issueId: "GEO-FLY1259",
				message: "Runner started for GEO-FLY1259",
				designBackend: "claude",
			});
			expect(mockDispatcher.start).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionRole: "design",
					designBackend: "claude",
					dispatchVendor: "claude",
					dispatchModel: "claude-fable-5",
					dispatchEffort: undefined,
				}),
			);
		});

		it.each([undefined, null])(
			"keeps the legacy response shape when designBackend is %s",
			async (designBackend) => {
				process.env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN = "1";
				const res = await postDesignBackend(designBackend);
				expect(res.status).toBe(200);
				const body = await res.json();
				expect(body).toEqual({
					success: true,
					executionId: expect.any(String),
					issueId: "GEO-FLY1259",
					message: "Runner started for GEO-FLY1259",
				});
				expect(Object.keys(body as object)).not.toContain("designBackend");
				expect(mockDispatcher.start).toHaveBeenCalledWith(
					expect.objectContaining({
						designBackend: "codex",
						dispatchVendor: "codex",
					}),
				);
			},
		);

		it("rejects an explicit override for a non-main request before dispatch", async () => {
			const res = await postDesignBackend("codex", { sessionRole: "qa" });
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				success: false,
				code: "DESIGN_BACKEND_NOT_APPLICABLE",
				reason: "non_main_role",
				requested: "codex",
				silent: false,
			});
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		});

		it("rejects an explicit override when the issue opts out of three-stage", async () => {
			const { LinearClient } = await import("@linear/sdk");
			(
				LinearClient as unknown as ReturnType<typeof vi.fn>
			).mockImplementationOnce(() => ({
				issue: vi.fn().mockResolvedValue({
					title: "Test Issue",
					identifier: "GEO-FLY1259",
					url: "https://linear.app/test/issue/GEO-FLY1259",
					labels: vi.fn().mockResolvedValue({
						nodes: [{ name: "Product" }, { name: "no-three-stage" }],
					}),
				}),
			}));
			const res = await postDesignBackend("codex");
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				success: false,
				code: "DESIGN_BACKEND_NOT_APPLICABLE",
				reason: "no_three_stage_label",
				requested: "codex",
				silent: false,
			});
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		});

		it("rejects an explicit override when the global three-stage switch is off", async () => {
			process.env.FLYWHEEL_THREE_STAGE = "0";
			const res = await postDesignBackend("codex");
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				success: false,
				code: "DESIGN_BACKEND_NOT_APPLICABLE",
				reason: "global_disabled",
				requested: "codex",
				silent: false,
			});
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		});

		// FLY-1259 (Codex code R1): a config-determined "can never enter three-stage"
		// verdict must beat the conflict//admission lanes. Otherwise a doomed request
		// gets a 409 (or 429) — and worse, the stale-blocker guard may finalize/alert
		// a previous session on behalf of a request that could never have started.
		it("config-disabled override returns 400 even when an active session would 409", async () => {
			process.env.FLYWHEEL_THREE_STAGE = "0";
			store.upsertSession({
				execution_id: "blocker-1259",
				issue_id: "GEO-FLY1259",
				project_name: "TestProject",
				status: "running",
			});
			try {
				const res = await postDesignBackend("codex");
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({
					success: false,
					code: "DESIGN_BACKEND_NOT_APPLICABLE",
					reason: "global_disabled",
					requested: "codex",
					silent: false,
				});
				expect(mockDispatcher.start).not.toHaveBeenCalled();
			} finally {
				// The store outlives each test; retire the blocker so the sibling
				// GEO-FLY1259 cases are not silently turned into 409s.
				store.upsertSession({
					execution_id: "blocker-1259",
					issue_id: "GEO-FLY1259",
					project_name: "TestProject",
					status: "completed",
				});
			}
		});

		it("returns a bounded channel reason while logging the internal policy detail", async () => {
			writeThreeStageConfig(["other-channel"]);
			const warn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			try {
				const res = await postDesignBackend("claude");
				expect(res.status).toBe(400);
				const body = await res.json();
				expect(body).toEqual({
					success: false,
					code: "DESIGN_BACKEND_NOT_APPLICABLE",
					reason: "channel_not_allowed",
					requested: "claude",
					silent: false,
				});
				const responseText = JSON.stringify(body);
				expect(responseText).not.toContain("test-chat");
				expect(responseText).not.toContain("other-channel");
				expect(warn).toHaveBeenCalledWith(
					expect.stringContaining("other-channel"),
				);
				expect(mockDispatcher.start).not.toHaveBeenCalled();
			} finally {
				warn.mockRestore();
			}
		});
	});

	describe("FLY-1307 — engineering v1 dispatch stays inside three-stage entry", () => {
		let projectRoot: string;
		let originalProjectRoot: string;
		const flagNames = [
			"FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES",
			"FLYWHEEL_WORKFLOW_CLAIMS_WRITE",
			"FLYWHEEL_WORKFLOW_CLAIMS_READ",
			"FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH",
			"FLYWHEEL_THREE_STAGE",
		] as const;
		let savedFlags: Record<(typeof flagNames)[number], string | undefined>;

		function writeThreeStageConfig(enabled: boolean): void {
			writeFileSync(
				join(projectRoot, ".flywheel", "config.yaml"),
				`project: TestProject
linear:
  team_id: TEST
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: dev
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5
decision_layer:
  autonomy_level: observer
  escalation_channel: test
pipeline:
  three_stage: ${enabled}
`,
			);
		}

		beforeEach(() => {
			projectRoot = mkdtempSync(join(tmpdir(), "fly1307-start-"));
			mkdirSync(join(projectRoot, ".flywheel"), { recursive: true });
			writeThreeStageConfig(true);
			originalProjectRoot = testProjects[0]!.projectRoot;
			testProjects[0]!.projectRoot = projectRoot;
			savedFlags = Object.fromEntries(
				flagNames.map((name) => [name, process.env[name]]),
			) as Record<(typeof flagNames)[number], string | undefined>;
			for (const name of flagNames.slice(0, 4)) process.env[name] = "1";
			delete process.env.FLYWHEEL_THREE_STAGE;
			importBundledWorkflowSeeds(store, process.env);
			ensureDefaultWorkflowBindings(store, ["TestProject"]);
		});

		afterEach(() => {
			testProjects[0]!.projectRoot = originalProjectRoot;
			rmSync(projectRoot, { recursive: true, force: true });
			for (const name of flagNames) {
				const value = savedFlags[name];
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		});

		async function postStart(
			issueId: string,
			extra: Record<string, unknown> = {},
		): Promise<Response> {
			return fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId,
					projectName: "TestProject",
					...extra,
				}),
			});
		}

		it("normal Lead start without an idempotency key remains the incumbent three-stage dispatch", async () => {
			const res = await postStart("GEO-V1-NO-KEY");
			expect(res.status).toBe(200);
			expect(mockDispatcher.start).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionRole: "design",
					shareParentBranch: true,
				}),
			);
			expect(
				mockDispatcher.start.mock.calls[0]![0].generalizedExecution,
			).toBeUndefined();
			expect(
				store.getActiveWorkflowRunForIssue("GEO-V1-NO-KEY"),
			).toBeUndefined();
		});

		it("project policy OFF keeps a keyed v1 candidate on the legacy main path", async () => {
			writeThreeStageConfig(false);
			const res = await postStart("GEO-V1-POLICY-OFF", {
				idempotencyKey: "policy-off-key",
			});
			expect(res.status).toBe(200);
			expect(mockDispatcher.start).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionRole: "main",
					shareParentBranch: undefined,
				}),
			);
			expect(
				mockDispatcher.start.mock.calls[0]![0].generalizedExecution,
			).toBeUndefined();
			expect(
				store.getActiveWorkflowRunForIssue("GEO-V1-POLICY-OFF"),
			).toBeUndefined();
		});

		it("no-three-stage label keeps a keyed v1 candidate on the legacy main path", async () => {
			const { LinearClient } = await import("@linear/sdk");
			(
				LinearClient as unknown as ReturnType<typeof vi.fn>
			).mockImplementationOnce(() => ({
				issue: vi.fn().mockResolvedValue({
					title: "Test Issue",
					identifier: "GEO-V1-LABEL-OFF",
					url: "https://linear.app/test/issue/GEO-V1-LABEL-OFF",
					labels: vi.fn().mockResolvedValue({
						nodes: [{ name: "Product" }, { name: "no-three-stage" }],
					}),
				}),
			}));
			const res = await postStart("GEO-V1-LABEL-OFF", {
				idempotencyKey: "label-off-key",
			});
			expect(res.status).toBe(200);
			expect(mockDispatcher.start).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionRole: "main",
				}),
			);
			expect(
				mockDispatcher.start.mock.calls[0]![0].generalizedExecution,
			).toBeUndefined();
			expect(
				store.getActiveWorkflowRunForIssue("GEO-V1-LABEL-OFF"),
			).toBeUndefined();
		});

		it("global three-stage OFF keeps a keyed v1 candidate on the legacy main path", async () => {
			process.env.FLYWHEEL_THREE_STAGE = "0";
			const res = await postStart("GEO-V1-GLOBAL-OFF", {
				idempotencyKey: "global-off-key",
			});
			expect(res.status).toBe(200);
			expect(mockDispatcher.start).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionRole: "main",
				}),
			);
			expect(
				mockDispatcher.start.mock.calls[0]![0].generalizedExecution,
			).toBeUndefined();
			expect(
				store.getActiveWorkflowRunForIssue("GEO-V1-GLOBAL-OFF"),
			).toBeUndefined();
		});

		it("active legacy phase rejects a keyed v1 start before engine materialization", async () => {
			store.upsertSession({
				execution_id: "active-design",
				issue_id: "GEO-V1-ACTIVE",
				project_name: "TestProject",
				status: "running",
				session_role: "design",
				chat_thread_role: "design",
			});
			const res = await postStart("GEO-V1-ACTIVE", {
				idempotencyKey: "active-key",
			});
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				success: false,
				message: expect.stringContaining("active three-stage design phase"),
			});
			expect(mockDispatcher.start).not.toHaveBeenCalled();
			expect(
				store.getActiveWorkflowRunForIssue("GEO-V1-ACTIVE"),
			).toBeUndefined();
		});
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
				}),
			});
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			expect(startReq.projectName).toBe("TestProject");
		}, 15_000);
	});

	// FLY-1356 — per-dispatch skill-framework arm (529 eval forced-arm). The
	// boundary mirrors designBackend: validated synchronously, fail-loud, and
	// ONLY accepted while the Bridge flag is `split` (kill-switch precedence).
	describe("FLY-1356 — per-dispatch skillFrameworkMode", () => {
		let savedFlag: string | undefined;

		beforeEach(() => {
			savedFlag = process.env.FLYWHEEL_SKILL_FRAMEWORK_MODE;
			delete process.env.FLYWHEEL_SKILL_FRAMEWORK_MODE;
		});

		afterEach(() => {
			if (savedFlag === undefined) {
				delete process.env.FLYWHEEL_SKILL_FRAMEWORK_MODE;
			} else {
				process.env.FLYWHEEL_SKILL_FRAMEWORK_MODE = savedFlag;
			}
		});

		async function postArm(skillFrameworkMode: unknown): Promise<Response> {
			return fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					issueId: "GEO-FLY1356",
					projectName: "TestProject",
					...(skillFrameworkMode !== undefined ? { skillFrameworkMode } : {}),
				}),
			});
		}

		it.each([42, true, "split", "SUPERPOWERS", "garbage", ""])(
			"rejects invalid arm %# before dispatch (split is env-only, not a per-dispatch arm)",
			async (arm) => {
				process.env.FLYWHEEL_SKILL_FRAMEWORK_MODE = "split";
				const res = await postArm(arm);
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({
					success: false,
					code: "INVALID_SKILL_FRAMEWORK_MODE",
					reason: "unknown_mode",
					allowed: ["superpowers", "matt", "bare"],
					silent: false,
				});
				expect(mockDispatcher.start).not.toHaveBeenCalled();
			},
			15_000,
		);

		it("valid arm while the flag is NOT split → bounded 400 (kill-switch in effect)", async () => {
			const res = await postArm("bare");
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				success: false,
				code: "SKILL_FRAMEWORK_MODE_NOT_APPLICABLE",
				reason: "flag_not_split",
				requested: "bare",
				silent: false,
			});
			expect(mockDispatcher.start).not.toHaveBeenCalled();
		}, 15_000);

		it("valid arm under split → dispatched with skillFrameworkMode", async () => {
			process.env.FLYWHEEL_SKILL_FRAMEWORK_MODE = "split";
			const res = await postArm("bare");
			expect(res.status).toBe(200);
			expect(mockDispatcher.start).toHaveBeenCalledWith(
				expect.objectContaining({ skillFrameworkMode: "bare" }),
			);
		}, 15_000);

		it("absent arm → request carries NO skillFrameworkMode (byte-compatible)", async () => {
			const res = await postArm(undefined);
			expect(res.status).toBe(200);
			const startReq = mockDispatcher.start.mock.calls[0]![0];
			expect("skillFrameworkMode" in startReq).toBe(false);
		}, 15_000);
	});
});

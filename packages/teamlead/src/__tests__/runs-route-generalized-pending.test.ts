import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchPrecommitFailure } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type { IStartDispatcher } from "../bridge/retry-dispatcher.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import { LEGACY_ROUTING_OVERRIDE_LABEL } from "../work-kind.js";
import { workflowSeedContentHash } from "../workflow-template.js";

const waitMocks = vi.hoisted(() => ({
	waitForDelivery: vi.fn(),
	waitForSession: vi.fn(),
}));

vi.mock("../bridge/generalized-launch-recovery.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../bridge/generalized-launch-recovery.js")
		>();
	return {
		...actual,
		waitForGeneralizedLaunchDelivery: waitMocks.waitForDelivery,
	};
});

vi.mock("../bridge/session-wait.js", () => ({
	waitForSession: waitMocks.waitForSession,
}));

vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({
		issue: vi.fn().mockResolvedValue({
			title: "Pending launch test",
			identifier: "FLY-PENDING",
			url: "https://linear.app/test/issue/FLY-PENDING",
			labels: vi.fn().mockResolvedValue({
				nodes: [{ name: "Product" }],
			}),
		}),
	})),
}));

const workflowFlags = [
	"FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES",
	"FLYWHEEL_WORKFLOW_CLAIMS_WRITE",
	"FLYWHEEL_WORKFLOW_CLAIMS_READ",
	"FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH",
] as const;

function v2Seed() {
	const seed = {
		templateId: "tpl_pending_launch_test",
		name: "Pending launch",
		projectScope: "global",
		manifest: {
			schema_version: 2 as const,
			nodes: [
				{
					id: "research",
					type: "generic" as const,
					vendor: "codex" as const,
					model: "gpt-5.6-sol",
					effort: "low" as const,
					agent_file: "agents/generic.md",
				},
				{ id: "founder_gate", type: "gate" as const },
			],
			edges: [
				{
					id: "done",
					from: "research",
					to: "founder_gate",
					condition: "node_done" as const,
				},
			],
			loops: [],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved" as const,
			},
			ship_claims: ["founder_approved" as const],
		},
	};
	return { ...seed, contentHash: workflowSeedContentHash(seed) };
}

function makeConfig(): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		apiToken: "master-token",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
		runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
	};
}

describe("FLY-1336 generalized launch accepted-pending route", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let projectRoot: string;
	let start: ReturnType<typeof vi.fn>;
	let commitLaunch: (() => { ok: boolean; reason?: string }) | undefined;
	let dispatchMode: "session_only" | "delivered" | "ghost" | "tmux_hold";
	let precommitFailure: LaunchPrecommitFailure | undefined;
	let savedFlags: Record<(typeof workflowFlags)[number], string | undefined>;
	let savedLinearApiKey: string | undefined;

	beforeEach(async () => {
		savedFlags = Object.fromEntries(
			workflowFlags.map((name) => [name, process.env[name]]),
		) as Record<(typeof workflowFlags)[number], string | undefined>;
		for (const name of workflowFlags) process.env[name] = "1";
		savedLinearApiKey = process.env.LINEAR_API_KEY;
		process.env.LINEAR_API_KEY = "test-linear-key";
		projectRoot = mkdtempSync(join(tmpdir(), "fly1336-pending-"));
		mkdirSync(join(projectRoot, "agents"), { recursive: true });
		writeFileSync(
			join(projectRoot, "agents", "generic.md"),
			"Investigate the issue.\n",
		);
		store = await StateStore.create(":memory:");
		const seed = v2Seed();
		store.importWorkflowTemplateSeed(seed, process.env);
		store.bindWorkflowCategory({
			project: "TestProject",
			taskCategory: "research",
			templateId: seed.templateId,
			updatedBy: "test",
		});
		dispatchMode = "session_only";
		precommitFailure = undefined;
		commitLaunch = undefined;
		waitMocks.waitForDelivery.mockReset().mockResolvedValue(undefined);
		waitMocks.waitForSession
			.mockReset()
			.mockImplementation(async (reader, executionId) =>
				reader.getSession(executionId),
			);
		start = vi.fn(async (req: Parameters<IStartDispatcher["start"]>[0]) => {
			const generalized = req.generalizedExecution;
			if (!generalized) {
				return { executionId: `classic-${req.issueId}`, issueId: req.issueId };
			}
			commitLaunch = generalized.commitWorkflowLaunch;
			if (dispatchMode !== "ghost" && dispatchMode !== "tmux_hold") {
				store.upsertSession({
					execution_id: generalized.executionId,
					issue_id: req.issueId,
					project_name: req.projectName,
					status: "running",
					session_role: req.sessionRole,
				});
			}
			if (dispatchMode === "delivered") {
				const committed = generalized.commitWorkflowLaunch?.();
				if (!committed?.ok) throw new Error("test launch commit failed");
			}
			return {
				executionId: generalized.executionId,
				issueId: req.issueId,
				...((dispatchMode === "tmux_hold" || precommitFailure) && {
					launchOutcome: Promise.resolve({
						status: "precommit_failed" as const,
						failure: precommitFailure ?? {
							code: "LAUNCH_TMUX_SESSION_HELD" as const,
							reason: "saturated" as const,
							physicalEvidence: "absent" as const,
						},
					}),
				}),
			};
		});
		const dispatcher: IStartDispatcher = {
			start,
			getInflightCount: () => 0,
		};
		const projects: ProjectEntry[] = [
			{
				projectName: "TestProject",
				projectRoot,
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
		const app = createBridgeApp(
			store,
			projects,
			makeConfig(),
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
			dispatcher,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		store.close();
		rmSync(projectRoot, { recursive: true, force: true });
		for (const name of workflowFlags) {
			const saved = savedFlags[name];
			if (saved === undefined) delete process.env[name];
			else process.env[name] = saved;
		}
		if (savedLinearApiKey === undefined) delete process.env.LINEAR_API_KEY;
		else process.env.LINEAR_API_KEY = savedLinearApiKey;
	});

	function postStart(
		issueId: string,
		idempotencyKey: string,
		taskCategory = "research",
	): Promise<Response> {
		return fetch(`${baseUrl}/api/runs/start`, {
			method: "POST",
			headers: {
				Authorization: "Bearer master-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				issueId,
				projectName: "TestProject",
				taskCategory,
				idempotencyKey,
			}),
		});
	}

	it("turns a wait-boundary race into the normal 200 response after a final durable read", async () => {
		dispatchMode = "delivered";
		const response = await postStart("FLY-BOUNDARY", "boundary-key");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			executionId: expect.any(String),
			issueId: "FLY-BOUNDARY",
			generalized: true,
		});
		expect(waitMocks.waitForDelivery).toHaveBeenCalledOnce();
	});

	it("returns an uncached 202 success:true pending envelope when delivery is not visible", async () => {
		const record = vi.spyOn(store, "recordWorkflowStartResponse");
		const response = await postStart("FLY-PENDING", "pending-key");
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			success: true,
			pending: true,
			code: "LAUNCH_PENDING",
			reason: "launch delivery confirmation is pending",
			retryable: false,
			executionId: expect.any(String),
			issueId: "FLY-PENDING",
			workflowRunId: expect.any(String),
			workflowNodeId: "research",
		});
		expect(record).not.toHaveBeenCalled();
		expect(store.getWorkflowStartResponse("pending-key")).toBeUndefined();
	});

	it("upgrades the same idempotency key from uncached pending to cached 200 without redispatch", async () => {
		const first = await postStart("FLY-UPGRADE", "upgrade-key");
		expect(first.status).toBe(202);
		expect(commitLaunch).toBeTypeOf("function");
		expect(commitLaunch?.()).toMatchObject({ ok: true });

		const second = await postStart("FLY-UPGRADE", "upgrade-key");
		expect(second.status).toBe(200);
		const body = await second.json();
		expect(body).toMatchObject({ success: true, issueId: "FLY-UPGRADE" });
		expect(start).toHaveBeenCalledOnce();
		expect(store.getWorkflowStartResponse("upgrade-key")).toEqual(body);
	});

	it("keeps generalized pre-session ghosts on the existing 500 contract", async () => {
		dispatchMode = "ghost";
		const response = await postStart("FLY-GHOST", "ghost-key");
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			success: false,
			code: "GENERALIZED_START_NOT_LIVE",
		});
	});

	it("returns a structured tmux hold and releases that uncommitted generation immediately", async () => {
		dispatchMode = "tmux_hold";
		const response = await postStart("FLY-HOLD", "hold-key");
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			success: false,
			code: "LAUNCH_TMUX_SESSION_HELD",
			reason: "saturated",
			executionId: expect.any(String),
			retryable: false,
		});
		const run = store.getActiveWorkflowRunForIssue("FLY-HOLD")!;
		const reservation = store.getWorkflowStartReservationForRun(run.run_id)!;
		expect(
			store.getWorkflowLaunchOwner(reservation.execution_id),
		).toMatchObject({
			owner_generation: 1,
			released_generation: 1,
			released_reason: "saturated",
		});
		expect(
			start.mock.calls[0]?.[0].generalizedExecution?.launchGeneration,
		).toBe(1);
	});

	it("maps a cleaned identity failure to retryable 409 after releasing the generation", async () => {
		precommitFailure = {
			code: "LAUNCH_WINDOW_IDENTITY_FAILED",
			reason: "identity_publish_failed",
			physicalEvidence: "cleaned",
		};
		const response = await postStart("FLY-IDENTITY", "identity-key");
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			success: false,
			code: "LAUNCH_WINDOW_IDENTITY_FAILED",
			reason: "identity_publish_failed",
			executionId: expect.any(String),
			retryable: true,
		});
	});

	it("maps a precommit deadline to non-retryable 503 without exposing evidence", async () => {
		precommitFailure = {
			code: "LAUNCH_PRECOMMIT_TIMEOUT",
			reason: "deadline_exhausted",
			physicalEvidence: "unknown",
		};
		const response = await postStart("FLY-TIMEOUT", "timeout-key");
		expect(response.status).toBe(503);
		const body = await response.json();
		expect(body).toMatchObject({
			success: false,
			code: "LAUNCH_PRECOMMIT_TIMEOUT",
			reason: "deadline_exhausted",
			executionId: expect.any(String),
			retryable: false,
		});
		expect(body).not.toHaveProperty("physicalEvidence");
	});

	it("keeps classic pre-session ghosts on the existing 500 contract", async () => {
		const { LinearClient } = await import("@linear/sdk");
		vi.mocked(LinearClient).mockImplementationOnce(
			() =>
				({
					issue: vi.fn().mockResolvedValue({
						title: "Pending launch test",
						identifier: "FLY-PENDING",
						url: "https://linear.app/test/issue/FLY-PENDING",
						labels: vi.fn().mockResolvedValue({
							nodes: [
								{ name: "Product" },
								{ name: LEGACY_ROUTING_OVERRIDE_LABEL },
							],
						}),
					}),
				}) as never,
		);
		const response = await postStart(
			"FLY-CLASSIC-GHOST",
			"unused-key",
			"unbound",
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ success: false });
	});
});

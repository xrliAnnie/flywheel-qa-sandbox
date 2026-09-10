import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { LaunchPrecommitFailure } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IStartDispatcher } from "../bridge/retry-dispatcher.js";
import { CodexQuotaQueuedError } from "../bridge/retry-dispatcher.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
import { createRunsRouter } from "../bridge/runs-route.js";
import { createCodexQuotaDisabledAdmissionReplay } from "../codex-quota/admission-replay.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import { workflowSeedContentHash } from "../workflow-template.js";

const waitMocks = vi.hoisted(() => ({
	labels: ["Product"],
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
			labels: vi.fn(async () => ({
				nodes: waitMocks.labels.map((name) => ({ name })),
			})),
		}),
	})),
}));

const workflowFlags = [
	"FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES",
	"FLYWHEEL_WORKFLOW_CLAIMS_WRITE",
	"FLYWHEEL_WORKFLOW_CLAIMS_READ",
	"FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH",
] as const;

function v2Seed(vendor: "codex" | "claude" = "codex") {
	const seed = {
		templateId: `tpl_pending_launch_test_${vendor}`,
		name: "Pending launch",
		projectScope: "global",
		manifest: {
			schema_version: 2 as const,
			nodes: [
				{
					id: "research",
					type: "generic" as const,
					vendor,
					model: vendor === "codex" ? "gpt-5.6-sol" : "claude-sonnet-4-6",
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

describe("FLY-2465 Codex quota admission", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let projectRoot: string;
	let start: ReturnType<typeof vi.fn>;
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
		waitMocks.labels = ["Product"];
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
		const app = express();
		app.use(express.json());
		app.use(
			"/api/runs",
			createRunsRouter(
				dispatcher,
				store,
				projects,
				RunnerAdmissionController.alwaysAdmit(),
				undefined,
				undefined,
				undefined,
				{
					masterToken: "master-token",
					scopedToken: "scoped-token",
					codexQuotaRootKey: () => "test-root",
					verifyCodexQuotaRecovery: async () => true,
				},
			),
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

	it("queues paused Codex once without admission/cache and resumes same reservation after probe", async () => {
		store.codexQuota.initializeRoot({
			rootKey: "test-root",
			profile: "business",
			accountKey: "business",
			generation: 1,
		});
		store.codexQuota.registerBinding({
			bindingId: "old-binding",
			executionId: "old-exec",
			runId: "old-run",
			purpose: "runner",
			profile: "business",
			accountKey: "business",
			generation: 1,
			credentialRootKey: "test-root",
		});
		store.codexQuota.recordSignal({
			bindingId: "old-binding",
			executionId: "old-exec",
		});
		const admit = vi.spyOn(store, "admitGeneralizedWorkflowExecution");
		const first = await postStart("FLY-QUOTA", "quota-key");
		expect(first.status).toBe(202);
		expect(await first.json()).toMatchObject({
			success: false,
			status: "queued",
			code: "CODEX_QUOTA_QUEUED",
		});
		expect(admit).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		const reservation = store.getWorkflowStartReservation("quota-key");
		expect(reservation).toBeDefined();
		expect(store.getCodexQuotaAdmissionWaitContext("quota-key")).toMatchObject({
			stopped: false,
			request: { issueId: "FLY-QUOTA", idempotencyKey: "quota-key" },
			waiter: { execution_id: reservation!.execution_id },
		});

		const replay = await postStart("FLY-QUOTA", "quota-key");
		expect(replay.status).toBe(202);
		expect(store.codexQuota.listAdmissionWaits()).toHaveLength(1);
		expect(store.getWorkflowStartResponse("quota-key")).toBeUndefined();
		store.codexQuota.recordInstalling({
			incidentId: "codex:test-root:1",
			profile: "school",
			accountKey: "school",
			priorAuthDigest: "prior",
			installedAuthDigest: "digest",
			recoveryMaterialPath: "/fixture/retained-auth",
		});
		store.codexQuota.commitGeneration({
			incidentId: "codex:test-root:1",
			expectedGeneration: 1,
			accountKey: "school",
			profile: "school",
			authDigest: "digest",
			probeResult: "ok",
		});
		dispatchMode = "delivered";
		store.codexQuota.setAdmissionWaitState("quota-key", "resuming");
		const resumed = await postStart("FLY-QUOTA", "quota-key");
		expect(await resumed.json()).toMatchObject({ success: true });
		expect(resumed.status).toBe(200);
		expect(start).toHaveBeenCalledOnce();
		expect(store.getWorkflowStartReservation("quota-key")).toMatchObject({
			run_id: reservation!.run_id,
			execution_id: reservation!.execution_id,
			selection_digest: reservation!.selection_digest,
		});
		expect(store.codexQuota.getAdmissionWait("quota-key")?.state).toBe(
			"resuming",
		);
	});
	it("OFF launch policy admits new and previously queued HTTP starts while preserving incident facts; ON pauses again", async () => {
		let enabled = true;
		// Route fixture exercises the StateStore policy boundary; Bridge flag-store
		// wiring is covered separately by the plugin integration fixture.
		store.codexQuotaLaunchEnabled = () => enabled;
		store.codexQuota.initializeRoot({
			rootKey: "test-root",
			profile: "business",
			accountKey: "business",
			generation: 1,
		});
		store.codexQuota.registerBinding({
			bindingId: "off-policy-binding",
			executionId: "dead-exec",
			runId: "dead-run",
			purpose: "runner",
			profile: "business",
			accountKey: "business",
			generation: 1,
			credentialRootKey: "test-root",
		});
		store.codexQuota.recordSignal({
			bindingId: "off-policy-binding",
			executionId: "dead-exec",
		});
		const incidentBefore = store.codexQuota.getIncident("codex:test-root:1");
		const rootBefore = store.codexQuota.getRoot("test-root");
		expect((await postStart("FLY-OFF-QUEUED", "off-queued-key")).status).toBe(
			202,
		);
		const reservation = store.getWorkflowStartReservation("off-queued-key")!;
		expect(start).not.toHaveBeenCalled();

		enabled = false;
		dispatchMode = "delivered";
		const fresh = await postStart("FLY-OFF-NEW", "off-new-key");
		expect(fresh.status).toBe(200);
		expect(await fresh.json()).toMatchObject({ success: true });
		expect(store.codexQuota.getAdmissionWait("off-new-key")).toBeUndefined();
		const replay = await postStart("FLY-OFF-QUEUED", "off-queued-key");
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({ success: true });
		expect(store.getWorkflowStartReservation("off-queued-key")).toMatchObject({
			run_id: reservation.run_id,
			execution_id: reservation.execution_id,
		});
		expect(start).toHaveBeenCalledTimes(2);
		expect(start.mock.calls.map(([request]) => request.issueId)).toEqual([
			"FLY-OFF-NEW",
			"FLY-OFF-QUEUED",
		]);
		expect(store.codexQuota.getIncident("codex:test-root:1")).toEqual(
			incidentBefore,
		);
		expect(store.codexQuota.getRoot("test-root")).toEqual(rootBefore);
		expect(store.codexQuota.isExecutionPaused("dead-exec")).toBe(true);

		enabled = true;
		const pausedAgain = await postStart("FLY-ON-AGAIN", "on-again-key");
		expect(pausedAgain.status).toBe(202);
		expect(await pausedAgain.json()).toMatchObject({
			code: "CODEX_QUOTA_QUEUED",
			status: "queued",
		});
		expect(start).toHaveBeenCalledTimes(2);
	});
	it.each(["generalized", "legacy", "legacy-fresh", "scoped-fresh"] as const)(
		"OFF dispatcher replay starts persisted %s HTTP queue without a second user request",
		async (lane) => {
			let enabled = true;
			store.codexQuotaLaunchEnabled = () => enabled;
			store.codexQuota.initializeRoot({
				rootKey: "test-root",
				profile: "business",
				accountKey: "business",
				generation: 1,
			});
			store.codexQuota.registerBinding({
				bindingId: "replay-binding",
				executionId: "dead-exec",
				runId: "dead-run",
				purpose: "runner",
				profile: "business",
				accountKey: "business",
				generation: 1,
				credentialRootKey: "test-root",
			});
			store.codexQuota.recordSignal({
				bindingId: "replay-binding",
				executionId: "dead-exec",
			});
			const incident = store.codexQuota.getIncident("codex:test-root:1");
			if (lane !== "generalized") {
				waitMocks.labels = ["Product", "no-three-stage"];
				start.mockImplementation(async (req) => {
					throw new CodexQuotaQueuedError(
						req.successorExecutionId!,
						"test-root",
						1,
					);
				});
			}
			const initial =
				lane === "legacy-fresh" || lane === "scoped-fresh"
					? await fetch(`${baseUrl}/api/runs/start`, {
							method: "POST",
							headers: {
								Authorization:
									lane === "scoped-fresh"
										? "Bearer scoped-token"
										: "Bearer master-token",
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								issueId: "FLY-REPLAY",
								projectName: "TestProject",
								taskCategory: "research",
								idempotencyKey: "replay-key",
								freshStart: true,
								freshStartReason: "operator requested",
							}),
						})
					: await postStart("FLY-REPLAY", "replay-key");
			expect(initial.status).toBe(202);
			const queued = await initial.json();
			expect(store.codexQuota.getAdmissionWait("replay-key")?.state).toBe(
				"waiting",
			);
			if (lane === "scoped-fresh") {
				const frozen =
					store.getCodexQuotaAdmissionWaitContext("replay-key").request;
				expect(frozen.freshStart).toMatchObject({
					actor: "scoped",
					reason: "operator requested",
				});
				for (const change of [
					{ freshStartReason: "different reason" },
					{ tier: "light" },
				]) {
					const rejected = await fetch(`${baseUrl}/api/runs/start`, {
						method: "POST",
						headers: {
							Authorization: "Bearer master-token",
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							issueId: "FLY-REPLAY",
							projectName: "TestProject",
							taskCategory: "research",
							idempotencyKey: "replay-key",
							freshStart: true,
							freshStartReason: "operator requested",
							...change,
						}),
					});
					expect(rejected.status).toBe(409);
					expect(await rejected.json()).toMatchObject({
						code: "LEGACY_START_CONFLICT",
					});
				}
			}
			start.mockClear();
			enabled = false;
			dispatchMode = "delivered";
			if (lane !== "generalized")
				start.mockImplementation(async (req) => {
					store.upsertSession({
						execution_id: req.successorExecutionId!,
						issue_id: req.issueId,
						project_name: req.projectName,
						status: "running",
					});
					return {
						executionId: req.successorExecutionId!,
						issueId: req.issueId,
					};
				});
			const post = vi.fn(
				async (path: string, body: Record<string, unknown>) => {
					const response = await fetch(new URL(path, baseUrl), {
						method: "POST",
						headers: {
							Authorization: "Bearer master-token",
							"Content-Type": "application/json",
						},
						body: JSON.stringify(body),
					});
					return { status: response.status, body: await response.json() };
				},
			);
			const replay = createCodexQuotaDisabledAdmissionReplay({
				store,
				enabled: () => enabled,
				post,
				liveness: async () => "alive",
			});
			await replay();
			expect(post).toHaveBeenCalledOnce();
			expect(start).toHaveBeenCalledOnce();
			if (lane === "scoped-fresh") {
				expect(start.mock.calls[0]![0].freshStart).toMatchObject({
					actor: "scoped",
					reason: "operator requested",
				});
				expect(
					store.getCodexQuotaAdmissionWaitContext("replay-key").request
						.freshStart,
				).toMatchObject({ actor: "scoped", reason: "operator requested" });
			}
			expect(store.getSession(queued.executionId)?.status).toBe("running");
			expect(store.codexQuota.getAdmissionWait("replay-key")?.state).toBe(
				"released",
			);
			expect(store.codexQuota.getIncident("codex:test-root:1")).toEqual(
				incident,
			);
			expect(store.codexQuota.isExecutionPaused("dead-exec")).toBe(true);
			await replay();
			expect(post).toHaveBeenCalledOnce();
		},
	);
	it("abandons a queued waiter after an operator hold and never launches", async () => {
		store.codexQuota.initializeRoot({
			rootKey: "test-root",
			profile: "business",
			accountKey: "business",
			generation: 1,
		});
		store.codexQuota.registerBinding({
			bindingId: "old",
			executionId: "old",
			runId: null,
			purpose: "runner",
			profile: "business",
			accountKey: "business",
			generation: 1,
			credentialRootKey: "test-root",
		});
		store.codexQuota.recordSignal({ bindingId: "old", executionId: "old" });
		expect((await postStart("FLY-HELD", "held-key")).status).toBe(202);
		const reservation = store.getWorkflowStartReservation("held-key")!;
		expect(
			store.holdWorkflowRunByOperator({
				runId: reservation.run_id,
				reason: "operator hold",
				clientRequestId: "hold",
				principal: "master",
				evidence: [],
				now: new Date().toISOString(),
			}),
		).toMatchObject({ ok: true });
		expect(store.getCodexQuotaAdmissionWaitContext("held-key").stopped).toBe(
			true,
		);
		expect((await postStart("FLY-HELD", "held-key")).status).toBe(409);
		expect(store.codexQuota.getAdmissionWait("held-key")?.state).toBe(
			"abandoned",
		);
		expect(start).not.toHaveBeenCalled();
	});

	it("queues when quota arrives between route resolution and StateStore admission", async () => {
		store.codexQuota.initializeRoot({
			rootKey: "test-root",
			profile: "business",
			accountKey: "business",
			generation: 1,
		});
		store.codexQuota.registerBinding({
			bindingId: "old",
			executionId: "old",
			runId: null,
			purpose: "runner",
			profile: "business",
			accountKey: "business",
			generation: 1,
			credentialRootKey: "test-root",
		});
		const real = store.admitGeneralizedWorkflowExecution.bind(store);
		vi.spyOn(store, "admitGeneralizedWorkflowExecution").mockImplementationOnce(
			(input) => {
				store.codexQuota.recordSignal({ bindingId: "old", executionId: "old" });
				return real(input);
			},
		);
		const response = await postStart("FLY-RACE", "race-key");
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ code: "CODEX_QUOTA_QUEUED" });
		expect(start).not.toHaveBeenCalled();
		expect(store.codexQuota.getAdmissionWait("race-key")).toBeDefined();
	});
	it("lets Claude dispatch through a paused Codex root without a quota waiter", async () => {
		store.codexQuota.initializeRoot({
			rootKey: "test-root",
			profile: "business",
			accountKey: "business",
			generation: 1,
		});
		store.codexQuota.registerBinding({
			bindingId: "old",
			executionId: "old",
			runId: null,
			purpose: "runner",
			profile: "business",
			accountKey: "business",
			generation: 1,
			credentialRootKey: "test-root",
		});
		store.codexQuota.recordSignal({ bindingId: "old", executionId: "old" });
		const seed = v2Seed("claude");
		store.importWorkflowTemplateSeed(seed, process.env);
		store.bindWorkflowCategory({
			project: "TestProject",
			taskCategory: "research",
			templateId: seed.templateId,
			updatedBy: "test",
		});
		dispatchMode = "delivered";
		expect((await postStart("FLY-CLAUDE", "claude-key")).status).toBe(200);
		expect(start).toHaveBeenCalledOnce();
		expect(store.codexQuota.getAdmissionWait("claude-key")).toBeUndefined();
	});
	it.each(["waiting", "resuming"] as const)(
		"preserves a legacy queued start id with %s ownership",
		async (ownership) => {
			waitMocks.labels = ["Product", "no-three-stage"];
			start.mockImplementation(async (req) => {
				throw new CodexQuotaQueuedError(
					req.successorExecutionId!,
					"test-root",
					1,
				);
			});
			const first = await postStart("FLY-LEGACY", "legacy-key");
			expect(first.status).toBe(202);
			const firstBody = await first.json();
			expect(firstBody).toMatchObject({
				success: false,
				status: "queued",
				code: "CODEX_QUOTA_QUEUED",
			});
			const second = await postStart("FLY-LEGACY", "legacy-key");
			expect(await second.json()).toMatchObject({
				executionId: firstBody.executionId,
			});
			expect(store.codexQuota.getAdmissionWait("legacy-key")).toMatchObject({
				execution_id: firstBody.executionId,
				state: "waiting",
			});
			start.mockImplementation(async (req) => {
				store.upsertSession({
					execution_id: req.successorExecutionId!,
					issue_id: req.issueId,
					project_name: req.projectName,
					status: "running",
				});
				return { executionId: req.successorExecutionId!, issueId: req.issueId };
			});
			store.codexQuota.setAdmissionWaitState("legacy-key", ownership);
			const resumed = await postStart("FLY-LEGACY", "legacy-key");
			expect(resumed.status).toBe(200);
			expect(store.codexQuota.getAdmissionWait("legacy-key")?.state).toBe(
				ownership === "resuming" ? "resuming" : "released",
			);
		},
	);

	it.each(["legacy", "generalized"])(
		"abandons %s queue when the reserved session is cancelled",
		async (lane) => {
			store.codexQuota.initializeRoot({
				rootKey: "test-root",
				profile: "business",
				accountKey: "business",
				generation: 1,
			});
			store.codexQuota.registerBinding({
				bindingId: "old",
				executionId: "old",
				runId: null,
				purpose: "runner",
				profile: "business",
				accountKey: "business",
				generation: 1,
				credentialRootKey: "test-root",
			});
			store.codexQuota.recordSignal({ bindingId: "old", executionId: "old" });
			if (lane === "legacy") {
				waitMocks.labels = ["Product", "no-three-stage"];
				start.mockImplementation(async (req) => {
					throw new CodexQuotaQueuedError(
						req.successorExecutionId!,
						"test-root",
						1,
					);
				});
			}
			const first = await postStart("FLY-CANCELLED", "cancel-key");
			const body = await first.json();
			expect(first.status).toBe(202);
			store.upsertSession({
				execution_id: body.executionId,
				issue_id: "FLY-CANCELLED",
				project_name: "TestProject",
				status: "cancelled",
			});
			start.mockClear();
			const second = await postStart("FLY-CANCELLED", "cancel-key");
			expect(second.status).toBe(409);
			expect(store.codexQuota.getAdmissionWait("cancel-key")?.state).toBe(
				"abandoned",
			);
			expect(start).not.toHaveBeenCalled();
		},
	);
	it("rejects an unregistered quota recovery reference before creating a new run", async () => {
		const response = await fetch(`${baseUrl}/api/runs/start`, {
			method: "POST",
			headers: {
				Authorization: "Bearer master-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				issueId: "FLY-FAKE-RECOVERY",
				projectName: "TestProject",
				taskCategory: "research",
				idempotencyKey: "fake",
				quotaRecoveryId: "unregistered",
			}),
		});
		expect(response.status).toBe(409);
		expect((await response.json()).code).toBe("CODEX_QUOTA_RECOVERY_REFUSED");
		expect(
			store.getActiveWorkflowRunForIssue("FLY-FAKE-RECOVERY"),
		).toBeUndefined();
		expect(start).not.toHaveBeenCalled();
	});

	it("restarts from the server frozen source node despite a changed template and replays queued reservation", async () => {
		dispatchMode = "ghost";
		await postStart("FLY-FROZEN", "original-start");
		const old = store.getWorkflowStartReservation("original-start")!;
		const frozen = store.getWorkflowRun(old.run_id)!.snapshot;
		store.codexQuota.initializeRoot({
			rootKey: "test-root",
			accountKey: "business",
			profile: "business",
			generation: 1,
		});
		store.codexQuota.registerBinding({
			bindingId: "frozen-binding",
			executionId: old.execution_id,
			runId: old.run_id,
			purpose: "runner",
			accountKey: "business",
			profile: "business",
			generation: 1,
			credentialRootKey: "test-root",
		});
		const incidentId = store.codexQuota.recordSignal({
			bindingId: "frozen-binding",
			executionId: old.execution_id,
			nodeId: old.node_id,
		})!;
		store.codexQuota.recordInstalling({
			incidentId,
			profile: "school",
			accountKey: "school",
			priorAuthDigest: "old",
			installedAuthDigest: "new",
			recoveryMaterialPath: "/fixture/retained",
		});
		store.codexQuota.commitGeneration({
			incidentId,
			expectedGeneration: 1,
			accountKey: "school",
			profile: "school",
			authDigest: "new",
			probeResult: "ok",
		});
		store.codexQuota.registerBinding({
			bindingId: "new-generation",
			executionId: "new-generation-exec",
			runId: null,
			purpose: "review",
			accountKey: "school",
			profile: "school",
			generation: 2,
			credentialRootKey: "test-root",
		});
		const newIncident = store.codexQuota.recordSignal({
			bindingId: "new-generation",
			executionId: "new-generation-exec",
		})!;
		expect(store.getCodexQuotaRecoveryPermit(incidentId)).toBeUndefined();
		store.codexQuota.recordInstalling({
			incidentId: newIncident,
			profile: "personal",
			accountKey: "personal",
			priorAuthDigest: "new",
			installedAuthDigest: "newest",
			recoveryMaterialPath: "/fixture/newest",
		});
		store.codexQuota.commitGeneration({
			incidentId: newIncident,
			expectedGeneration: 2,
			accountKey: "personal",
			profile: "personal",
			authDigest: "newest",
			probeResult: "ok",
		});
		expect(
			store.getCodexQuotaRecoveryPermit(incidentId)?.installed_generation,
		).toBe(3);
		expect(store.codexQuota.getIncident(incidentId)?.generation).toBe(1);
		const recoveryId = `${incidentId}:runner:${old.run_id}`;
		const startKey = `codex-quota:${incidentId}:${old.run_id}:start`;
		const sourceRun = store.getWorkflowRun(old.run_id)!;
		const readRun = vi
			.spyOn(store, "getWorkflowRun")
			.mockReturnValueOnce({ ...sourceRun, current_node_id: "founder_gate" });
		expect(() => store.getCodexQuotaRecoveryContext(recoveryId)).toThrow(
			"quota_recovery_source_advanced",
		);
		readRun.mockRestore();

		expect(() =>
			store.reserveCodexQuotaRecoveryStart({ recoveryId, startKey }),
		).toThrow("quota_recovery_authority_refused");
		const { collectRunQuiescenceEvidence } = await import(
			"../bridge/run-quiescence.js"
		);
		const result = store.terminateWorkflowRunByOperator({
			runId: old.run_id,
			reason: `codex quota recovery ${incidentId}`,
			clientRequestId: `codex-quota:${incidentId}:${old.run_id}:terminate`,
			principal: "master",
			now: new Date().toISOString(),
			evidence: await collectRunQuiescenceEvidence(
				store,
				old.run_id,
				async () => "dead",
			),
		});
		expect(result).toMatchObject({ ok: true });
		const changed = v2Seed("claude");
		store.importWorkflowTemplateSeed(changed, process.env);
		store.bindWorkflowCategory({
			project: "TestProject",
			taskCategory: "research",
			templateId: changed.templateId,
			updatedBy: "test",
		});
		const request = () =>
			fetch(`${baseUrl}/api/runs/start`, {
				method: "POST",
				headers: {
					Authorization: "Bearer master-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					issueId: "FLY-FROZEN",
					projectName: "TestProject",
					quotaRecoveryId: recoveryId,
					idempotencyKey: startKey,
					templateId: changed.templateId,
					snapshot: "client poison",
				}),
			});
		dispatchMode = "session_only";
		const queued = await request();
		expect(queued.status, await queued.clone().text()).toBe(202);
		const reserved = store.getWorkflowStartReservation(startKey)!;
		expect(reserved.node_id).toBe(old.node_id);
		expect(store.getWorkflowRun(reserved.run_id)!.snapshot).toBe(frozen);
		expect(
			start.mock.calls
				.at(-1)?.[0]
				.generalizedExecution?.commitWorkflowLaunch?.(),
		).toMatchObject({ ok: true });
		dispatchMode = "delivered";
		const running = await request();
		expect(running.status, await running.clone().text()).toBe(200);
		expect(await running.json()).toMatchObject({ success: true });
		expect(store.getWorkflowStartReservation(startKey)?.execution_id).toBe(
			reserved.execution_id,
		);
		expect(store.codexQuota.listTargets(incidentId)[0]?.new_run_id).toBe(
			reserved.run_id,
		);
		store.codexQuota.reconcileExternalRoot({
			rootKey: "test-root",
			expectedGeneration: 3,
			accountKey: "business",
			profile: "business",
			authDigest: "b".repeat(64),
		});
		expect(store.getCodexQuotaRecoveryPermit(incidentId)).toBeUndefined();
	});
});

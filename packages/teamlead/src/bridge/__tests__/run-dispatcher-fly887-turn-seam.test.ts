/**
 * FLY-887 Step 4b: the RunDispatcher pre-launch TURN grant seam. A DAG workflow
 * phase SPAWN must have its shared-worktree TURN recorded in CommDB BEFORE the
 * runner launches (its first `turn` self-check must see `yours`, not `no-turn`).
 * The seam records it between preRegisterCommDb and blueprint.run; a
 * non-shareParentBranch dispatch or keep-alive OFF grants nothing (byte-compat).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import type { BlueprintContext } from "flywheel-edge-worker/dist/Blueprint.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	compileWorkflowMenuSeed,
	loadWorkflowMenuLibrary,
} from "../../workflow-menu.js";
import { commDbPathForProject } from "../commdb-path.js";
import type { GeneralizedExecutionDispatch } from "../retry-dispatcher.js";
import { type ProjectRuntime, RunDispatcher } from "../run-dispatcher.js";
import { RunnerAdmissionController } from "../runner-admission.js";

describe("RunDispatcher pre-launch TURN grant seam (FLY-887)", () => {
	let tmpDir: string;
	let commDir: string;
	/** The TURN holder observed INSIDE blueprint.run (proves happens-before). */
	let turnAtLaunch: { holder: string; phase: string } | null;
	let activationAtLaunch: {
		activationId: string;
		runId: string;
		nodeId: string;
		attempt: number;
	} | null;
	let startPointAtLaunch: string | undefined;

	function makeRuntime(): ProjectRuntime {
		return {
			blueprint: {
				run: vi.fn(async (_n: unknown, _r: string, ctx: BlueprintContext) => {
					// Read the TURN the moment the runner would launch.
					const db = new CommDB(commDbPathForProject("proj"));
					const t = db.getTurn("issue-1");
					const activation = db.getCurrentRunnerWorkflowActivation(
						ctx.executionId,
					);
					db.close();
					turnAtLaunch = t
						? { holder: t.holder_exec_id, phase: t.phase }
						: null;
					activationAtLaunch = activation
						? {
								activationId: activation.activation_id,
								runId: activation.run_id,
								nodeId: activation.node_id,
								attempt: activation.attempt,
							}
						: null;
					startPointAtLaunch = ctx.startPoint;
					// Confirm the ctx phase role matches (the seam keys on it).
					void ctx.sessionRole;
					return { success: true, sessionId: "s" };
				}),
			} as unknown as ProjectRuntime["blueprint"],
			projectRoot: tmpDir,
			tmuxSessionName: "runner-test",
			agentDispatcher: {
				dispatchByName: vi.fn(),
			} as unknown as ProjectRuntime["agentDispatcher"],
		};
	}

	function makeDispatcher(
		phaseRetryStartPointComputer?: (
			issueId: string,
			role: string,
			projectName: string,
		) =>
			| { kind: "found"; sha: string }
			| { kind: "missing" }
			| { kind: "indeterminate"; error: string },
	): RunDispatcher {
		return new RunDispatcher(
			new Map([["proj", makeRuntime()]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			phaseRetryStartPointComputer ?? (() => ({ kind: "missing" as const })),
		);
	}

	function retryRequest(
		overrides: Record<string, unknown> = {},
	): Parameters<RunDispatcher["dispatch"]>[0] {
		return {
			oldExecutionId: "old-exec",
			issueId: "issue-1",
			projectName: "proj",
			runAttempt: 2,
			sessionRole: "design",
			shareParentBranch: true,
			leadId: "flywheel-eng-lead",
			...overrides,
		};
	}

	function genericExecution(input: {
		executionId: string;
		runId: string;
		nodeId: string;
		attempt?: number;
	}): {
		workflow: GeneralizedExecutionDispatch;
		projectTurn: ReturnType<typeof vi.fn>;
	} {
		const projectTurn = vi.fn(() => ({
			ok: true as const,
			idempotentReplay: false,
		}));
		return {
			workflow: {
				engineOwned: true,
				executionId: input.executionId,
				activationId: `activation:${input.executionId}`,
				runId: input.runId,
				nodeId: input.nodeId,
				attempt: input.attempt ?? 1,
				snapshotDigest: "snapshot",
				gateCarrierEpoch: 1,
				dispatch: { vendor: "codex", model: "gpt-5.6-sol" },
				capabilities: { completion_route: "no_code" },
				agentContent: "Produce the pinned artifact.",
				outputCredential: `output:${input.executionId}`,
				submissionCredential: `submission:${input.executionId}`,
				idempotencyKey: `engine:${input.runId}:${input.nodeId}:${input.attempt ?? 1}`,
				projectTurn,
			},
			projectTurn,
		};
	}

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly887-seam-"));
		commDir = mkdtempSync(join(tmpdir(), "fly887-seam-comm-"));
		process.env.FLYWHEEL_COMM_DIR = commDir;
		turnAtLaunch = null;
		activationAtLaunch = null;
		startPointAtLaunch = undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		rmSync(commDir, { recursive: true, force: true });
		process.env.FLYWHEEL_COMM_DIR = undefined;
		vi.restoreAllMocks();
	});

	it("grants the phase TURN BEFORE launch (fresh Design spawn)", async () => {
		const dispatcher = makeDispatcher();
		const res = await dispatcher.start({
			issueId: "issue-1",
			projectName: "proj",
			sessionRole: "design",
			shareParentBranch: true,
			leadId: "flywheel-eng-lead",
		});
		await dispatcher.drain();
		// The runner observed the TURN already granted to itself at launch time.
		expect(turnAtLaunch).toEqual({ holder: res.executionId, phase: "design" });
		// And it persists.
		const db = new CommDB(commDbPathForProject("proj"));
		const t = db.getTurn("issue-1");
		const source = db.listWorkflowSourceEvents();
		const history = db.listTurnSourceHistory("issue-1");
		db.close();
		expect(t?.holder_exec_id).toBe(res.executionId);
		expect(source).toHaveLength(1);
		expect(source[0]).toMatchObject({
			project: "proj",
			source_event_id: `turn:spawn:${res.executionId}`,
			kind: "turn_grant",
		});
		expect(history).toHaveLength(1);
		expect(history[0]?.target_run_id).toBeNull();
	});

	it("attributes an engine-owned phase TURN to its pinned workflow run", async () => {
		const dispatcher = makeDispatcher();
		await dispatcher.start({
			issueId: "issue-1",
			projectName: "proj",
			sessionRole: "design",
			shareParentBranch: true,
			leadId: "flywheel-eng-lead",
			generalizedExecution: {
				engineOwned: true,
				executionId: "engine-design",
				activationId: "activation:engine-design",
				runId: "engine-run",
				nodeId: "design",
				attempt: 1,
				snapshotDigest: "snapshot",
				gateCarrierEpoch: 1,
				dispatch: { vendor: "codex", model: "gpt-5.6-sol" },
				capabilities: {
					completion_route: "phase_design_complete",
					shared_branch_writer: true,
				},
				agentContent: "Design the change.",
				idempotencyKey: "engine:run:design:1",
				projectTurn: vi.fn(() => ({
					ok: true as const,
					idempotentReplay: false,
				})),
			},
		});
		await dispatcher.drain();
		const db = new CommDB(commDbPathForProject("proj"));
		const source = db.listWorkflowSourceEvents()[0]!;
		const history = db.listTurnSourceHistory("issue-1")[0]!;
		const turn = db.getTurn("issue-1");
		db.close();
		expect(JSON.parse(source.payload).target_run_id).toBe("engine-run");
		expect(history.target_run_id).toBe("engine-run");
		expect(turn).toMatchObject({
			target_node_id: "design",
			target_attempt: 1,
			activation_id: "activation:engine-design",
		});
	});

	it("FLY-1788: all four engine-owned single-node templates mint activation before launch", async () => {
		const menus = loadWorkflowMenuLibrary();
		const cases = [
			{ shape: "prd", templateId: "tpl_prd" },
			{ shape: "product_design_flow", templateId: "tpl_design" },
			{ shape: "prototype", templateId: "tpl_prototype" },
			{ shape: "generic", templateId: "tpl_generic_menu" },
		] as const;

		for (const testCase of cases) {
			const menu = menus.find(
				(candidate) => candidate.shape === testCase.shape,
			)!;
			const seed = compileWorkflowMenuSeed(menu);
			expect(seed.templateId).toBe(testCase.templateId);
			const node = seed.manifest.nodes.find(
				(candidate) => candidate.type === "generic",
			)!;
			const executionId = `engine-${testCase.shape}`;
			const { workflow, projectTurn } = genericExecution({
				executionId,
				runId: `run-${testCase.shape}`,
				nodeId: node.id,
			});
			const dispatcher = makeDispatcher();

			await dispatcher.start({
				issueId: "issue-1",
				projectName: "proj",
				sessionRole: "main",
				leadId: "flywheel-eng-lead",
				generalizedExecution: workflow,
			});
			await dispatcher.drain();

			expect(turnAtLaunch, testCase.templateId).toEqual({
				holder: executionId,
				phase: node.id,
			});
			expect(activationAtLaunch, testCase.templateId).toEqual({
				activationId: `activation:${executionId}`,
				runId: `run-${testCase.shape}`,
				nodeId: node.id,
				attempt: 1,
			});
			expect(projectTurn, testCase.templateId).toHaveBeenCalledWith(
				expect.objectContaining({
					activationId: `activation:${executionId}`,
					executionId,
					issueId: "issue-1",
				}),
			);
		}
	});

	it("FLY-1788: an engine-owned generic retry mints activation without phase branch semantics", async () => {
		const compute = vi.fn(() => ({ kind: "missing" as const }));
		const dispatcher = makeDispatcher(compute);
		const { workflow, projectTurn } = genericExecution({
			executionId: "engine-prd-retry",
			runId: "run-prd",
			nodeId: "produce",
			attempt: 2,
		});

		await dispatcher.dispatch(
			retryRequest({
				sessionRole: "main",
				shareParentBranch: undefined,
				successorExecutionId: workflow.executionId,
				generalizedExecution: workflow,
			}),
		);
		await dispatcher.drain();

		expect(turnAtLaunch).toEqual({
			holder: "engine-prd-retry",
			phase: "produce",
		});
		expect(activationAtLaunch).toEqual({
			activationId: "activation:engine-prd-retry",
			runId: "run-prd",
			nodeId: "produce",
			attempt: 2,
		});
		expect(projectTurn).toHaveBeenCalledOnce();
		expect(compute).not.toHaveBeenCalled();
		expect(startPointAtLaunch).toBeUndefined();
	});

	it("FLY-1257: phase retry atomically transfers the existing TURN before launch and increments epoch", async () => {
		const seed = new CommDB(commDbPathForProject("proj"));
		seed.grantTurn("issue-1", "old-exec", "design", 100);
		const oldEpoch = seed.getTurn("issue-1")?.epoch;
		seed.close();

		const dispatcher = makeDispatcher();
		const res = await dispatcher.dispatch(retryRequest());
		await dispatcher.drain();
		expect(turnAtLaunch).toEqual({
			holder: res.newExecutionId,
			phase: "design",
		});
		const db = new CommDB(commDbPathForProject("proj"));
		const turn = db.getTurn("issue-1");
		const source = db.listWorkflowSourceEvents();
		const history = db.listTurnSourceHistory("issue-1");
		// Replaying the same successor source is idempotent: no epoch/history bump.
		db.grantTurn("issue-1", res.newExecutionId, "design", 999, {
			project: "proj",
			sourceEventId: `turn:spawn:${res.newExecutionId}`,
		});
		const replayed = db.getTurn("issue-1");
		db.close();
		expect(turn?.holder_exec_id).toBe(res.newExecutionId);
		expect(turn?.epoch).toBe((oldEpoch ?? 0) + 1);
		expect(source).toHaveLength(1);
		expect(source[0]?.source_event_id).toBe(`turn:spawn:${res.newExecutionId}`);
		expect(history).toHaveLength(1);
		expect(replayed?.epoch).toBe(turn?.epoch);
	});

	it("FLY-1257: a found phase branch tip is injected as retry ctx.startPoint", async () => {
		const compute = vi.fn(() => ({
			kind: "found" as const,
			sha: "a".repeat(40),
		}));
		const dispatcher = makeDispatcher(compute);
		await dispatcher.dispatch(retryRequest({ sessionRole: "implement" }));
		await dispatcher.drain();
		expect(compute).toHaveBeenCalledWith("issue-1", "implement", "proj");
		expect(compute).toHaveBeenCalledTimes(2);
		expect(startPointAtLaunch).toBe("a".repeat(40));
	});

	it("FLY-1257 review R1: the probe after TURN is authoritative when branch B moves", async () => {
		const compute = vi
			.fn()
			.mockReturnValueOnce({ kind: "found" as const, sha: "a".repeat(40) })
			.mockReturnValueOnce({ kind: "found" as const, sha: "b".repeat(40) });
		const dispatcher = makeDispatcher(compute);
		await dispatcher.dispatch(retryRequest({ sessionRole: "implement" }));
		await dispatcher.drain();
		expect(compute).toHaveBeenCalledTimes(2);
		expect(startPointAtLaunch).toBe("b".repeat(40));
	});

	it("FLY-1257 review R1: a missing retry probe dependency fails closed", async () => {
		const runtime = makeRuntime();
		const dispatcher = new RunDispatcher(
			new Map([["proj", runtime]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);
		await expect(dispatcher.dispatch(retryRequest())).rejects.toThrow(
			/phase retry startPoint.*computer unavailable/i,
		);
		expect(runtime.blueprint.run).not.toHaveBeenCalled();
	});

	it("FLY-1257: a confirmed-missing phase branch leaves retry ctx.startPoint absent", async () => {
		const dispatcher = makeDispatcher(() => ({ kind: "missing" }));
		await dispatcher.dispatch(retryRequest());
		await dispatcher.drain();
		expect(startPointAtLaunch).toBeUndefined();
	});

	it("FLY-1257: indeterminate git probe aborts before TURN transfer or Blueprint launch", async () => {
		const seed = new CommDB(commDbPathForProject("proj"));
		seed.grantTurn("issue-1", "old-exec", "design", 100);
		seed.close();
		const runtime = makeRuntime();
		const onSpawnFailed = vi.fn();
		const successorExecutionId = "probe-failure-exec";
		const dispatcher = new RunDispatcher(
			new Map([["proj", runtime]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			undefined,
			async () => ({ admitted: true }),
			{ commitLaunch: vi.fn(async () => ({ ok: true })), onSpawnFailed },
			() => ({ kind: "indeterminate", error: "git exit 128" }),
		);
		await expect(
			dispatcher.dispatch(retryRequest({ successorExecutionId })),
		).rejects.toThrow(/phase retry startPoint.*indeterminate.*git exit 128/i);
		expect(runtime.blueprint.run).not.toHaveBeenCalled();
		const db = new CommDB(commDbPathForProject("proj"));
		expect(db.getTurn("issue-1")?.holder_exec_id).toBe("old-exec");
		expect(db.getSession(successorExecutionId)).toBeUndefined();
		db.close();
		expect(onSpawnFailed).toHaveBeenCalledWith(successorExecutionId);
	});

	it("FLY-1257 review R1: an indeterminate post-TURN probe never launches a stale startPoint", async () => {
		const seed = new CommDB(commDbPathForProject("proj"));
		seed.grantTurn("issue-1", "old-exec", "design", 100);
		seed.close();
		const runtime = makeRuntime();
		const onSpawnFailed = vi.fn();
		const successorExecutionId = "post-fence-probe-failure";
		const compute = vi
			.fn()
			.mockReturnValueOnce({ kind: "found" as const, sha: "a".repeat(40) })
			.mockReturnValueOnce({
				kind: "indeterminate" as const,
				error: "git timed out",
			});
		const dispatcher = new RunDispatcher(
			new Map([["proj", runtime]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			undefined,
			async () => ({ admitted: true }),
			{ commitLaunch: vi.fn(async () => ({ ok: true })), onSpawnFailed },
			compute,
		);

		await expect(
			dispatcher.dispatch(retryRequest({ successorExecutionId })),
		).rejects.toThrow(/phase retry startPoint.*git timed out/i);
		expect(compute).toHaveBeenCalledTimes(2);
		expect(runtime.blueprint.run).not.toHaveBeenCalled();
		const db = new CommDB(commDbPathForProject("proj"));
		// Ownership remains fenced on the never-launched successor so the normal
		// dead-holder reconciler can recover it; no stale predecessor can write.
		expect(db.getTurn("issue-1")?.holder_exec_id).toBe(successorExecutionId);
		db.close();
		expect(onSpawnFailed).toHaveBeenCalledWith(successorExecutionId);
	});

	it("FLY-1257: retry TURN grant failure aborts inflight + pre-registration + launch claim", async () => {
		const grantSpy = vi
			.spyOn(CommDB.prototype, "grantTurn")
			.mockImplementation(() => {
				throw new Error("sqlite is read-only");
			});
		const onSpawnFailed = vi.fn();
		const commitLaunch = vi.fn(async () => ({ ok: true }));
		const dispatcher = new RunDispatcher(
			new Map([["proj", makeRuntime()]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			undefined,
			async () => ({ admitted: true }),
			{ commitLaunch, onSpawnFailed },
			() => ({ kind: "missing" }),
		);
		const successorExecutionId = "retry-exec-1257";
		await expect(
			dispatcher.dispatch(retryRequest({ successorExecutionId })),
		).rejects.toThrow(/pre-launch TURN grant failed.*retry/i);
		expect(grantSpy).toHaveBeenCalledOnce();
		expect(dispatcher.hasInflightForRole("issue-1", "design")).toBe(false);
		const db = new CommDB(commDbPathForProject("proj"));
		expect(db.getSession(successorExecutionId)).toBeUndefined();
		db.close();
		expect(onSpawnFailed).toHaveBeenCalledWith(successorExecutionId);
		expect(onSpawnFailed).toHaveBeenCalledOnce();
		expect(commitLaunch).not.toHaveBeenCalled();
	});

	it("FLY-1257 review R1: lifecycle commit refusal preserves cancelled state", async () => {
		const onSpawnFailed = vi.fn();
		const runtime = makeRuntime();
		const dispatcher = new RunDispatcher(
			new Map([["proj", runtime]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			undefined,
			async () => ({ admitted: true }),
			{
				commitLaunch: vi.fn(async () => ({ ok: false, reason: "parked" })),
				onSpawnFailed,
			},
			() => ({ kind: "missing" }),
		);

		await expect(dispatcher.dispatch(retryRequest())).rejects.toThrow(
			/parked/i,
		);
		expect(runtime.blueprint.run).not.toHaveBeenCalled();
		expect(onSpawnFailed).not.toHaveBeenCalled();
	});

	it("FLY-1257: fresh start TURN grant failure uses the same complete pre-launch abort", async () => {
		vi.spyOn(CommDB.prototype, "grantTurn").mockImplementation(() => {
			throw new Error("sqlite is read-only");
		});
		const onSpawnFailed = vi.fn();
		const dispatcher = new RunDispatcher(
			new Map([["proj", makeRuntime()]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			undefined,
			async () => ({ admitted: true }),
			{ commitLaunch: vi.fn(async () => ({ ok: true })), onSpawnFailed },
		);
		await expect(
			dispatcher.start({
				issueId: "issue-1",
				projectName: "proj",
				sessionRole: "implement",
				shareParentBranch: true,
			}),
		).rejects.toThrow(/pre-launch TURN grant failed/i);
		expect(dispatcher.hasInflightForRole("issue-1", "implement")).toBe(false);
		expect(onSpawnFailed).toHaveBeenCalledOnce();
		const failedExec = onSpawnFailed.mock.calls[0]?.[0] as string;
		const db = new CommDB(commDbPathForProject("proj"));
		expect(db.getSession(failedExec)).toBeUndefined();
		db.close();
	});

	it("FLY-1788: generic activation mint failure aborts before Blueprint launch", async () => {
		vi.spyOn(CommDB.prototype, "grantTurn").mockImplementation(() => {
			throw new Error("sqlite is read-only");
		});
		const onSpawnFailed = vi.fn();
		const runtime = makeRuntime();
		const dispatcher = new RunDispatcher(
			new Map([["proj", runtime]]),
			[],
			RunnerAdmissionController.alwaysAdmit(),
			undefined,
			undefined,
			undefined,
			async () => ({ admitted: true }),
			{ commitLaunch: vi.fn(async () => ({ ok: true })), onSpawnFailed },
		);
		const { workflow } = genericExecution({
			executionId: "engine-generic-failure",
			runId: "run-prd",
			nodeId: "produce",
		});

		await expect(
			dispatcher.start({
				issueId: "issue-1",
				projectName: "proj",
				sessionRole: "main",
				generalizedExecution: workflow,
			}),
		).rejects.toThrow(/pre-launch TURN grant failed/i);
		expect(runtime.blueprint.run).not.toHaveBeenCalled();
		expect(dispatcher.hasInflightForRole("issue-1", "main")).toBe(false);
		expect(onSpawnFailed).toHaveBeenCalledWith("engine-generic-failure");
	});

	it("byte-compat: a non-phase (no shareParentBranch) dispatch grants NO turn", async () => {
		const dispatcher = makeDispatcher();
		await dispatcher.start({
			issueId: "issue-1",
			projectName: "proj",
			sessionRole: "main",
		});
		await dispatcher.drain();
		expect(turnAtLaunch).toBeNull();
	});

	it("FLY-1257 byte-compat: non-phase retry calls no TURN grant", async () => {
		const grantSpy = vi.spyOn(CommDB.prototype, "grantTurn");
		const dispatcher = makeDispatcher();
		await dispatcher.dispatch(
			retryRequest({ sessionRole: "main", shareParentBranch: undefined }),
		);
		await dispatcher.drain();
		expect(grantSpy).not.toHaveBeenCalled();
	});
});

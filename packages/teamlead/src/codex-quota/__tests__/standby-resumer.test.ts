import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createCodexStandbyRun,
	quotaWall,
	rawDb,
} from "../../__tests__/helpers/codex-quota-standby-fixture.js";
import {
	CodexQuotaQueuedError,
	type StartRequest,
} from "../../bridge/retry-dispatcher.js";
import { DoaBackoffError } from "../../bridge/run-dispatcher.js";
import { AdmissionDeferredError } from "../../bridge/runner-admission.js";
import type { WorkflowActorSession } from "../../bridge/workflow-actor-session.js";
import type {
	SameExecutionLifecycle,
	SameExecutionRelaunchResult,
} from "../../bridge/workflow-same-execution-relaunch.js";
import { relaunchSameWorkflowExecution } from "../../bridge/workflow-same-execution-relaunch.js";
import { StateStore } from "../../StateStore.js";
import { createCodexQuotaFallbackEvaluator } from "../quota-fallback.js";
import {
	CODEX_STANDBY_IDENTITY_TIMEOUT_MS,
	CODEX_STANDBY_PROGRESS_TIMEOUT_MS,
	createCodexQuotaStandbyResumer,
} from "../standby-resumer.js";

const ROOT = "root-canonical";
const ACCOUNT = "a".repeat(64);
const cleanups: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const path of cleanups.splice(0))
		rmSync(path, { recursive: true, force: true });
});

async function parkedWithPermit(count = 1) {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.codexQuotaStandbyEnabled = () => true;
	store.codexQuota.initializeRoot({
		rootKey: ROOT,
		accountKey: ACCOUNT,
		profile: "business",
		generation: 1,
	});
	const executions: string[] = [];
	for (let i = 0; i < count; i += 1) {
		const ids = createCodexStandbyRun(store, {
			runId: `run-${i}`,
			executionId: `exec-${i}`,
			issueId: `FLY-${2900 + i}`,
			cleanups,
		});
		store.recordEnrolledTerminalSignal(quotaWall(ids.executionId, `wall-${i}`));
		executions.push(ids.executionId);
	}
	const nowMs = Date.now();
	expect(
		store.codexQuota.issueReadingConfirmedPermit({
			rootKey: ROOT,
			expectedGeneration: 1,
			authDigest: "d".repeat(64),
			reading: {
				name: "business",
				identityKey: ACCOUNT,
				observedAt: new Date(nowMs - 10_000).toISOString(),
				fiveH: { usedPercent: 1, resetAt: null },
				weekly: { usedPercent: 2, resetAt: null },
				requestSeq: store.codexQuota.allocateCausalSeq(),
			},
			activeAccount: "business",
			nowMs,
		}),
	).toMatchObject({ outcome: "issued" });
	return { store, executions };
}

type Script = (
	lifecycle: SameExecutionLifecycle,
) => Promise<SameExecutionRelaunchResult>;

const verified = (): SameExecutionRelaunchResult => ({
	ok: true,
	expectedSessionId: "t",
	observedSessionId: "t",
	expectedModel: "gpt-5.6-sol",
	observedModel: "gpt-5.6-sol",
	expectedCwd: "/wt",
	observedCwd: "/wt",
	queueMs: 0,
	startupMs: 1,
	totalMs: 1,
});

/** The adapter's happy path: identity, continue started, first model output. */
const happy: Script = async (lifecycle) => {
	lifecycle.onIdentityVerified?.({
		sessionId: "t",
		model: "gpt-5.6-sol",
		cwd: "/wt",
		verifiedAt: "t",
	});
	expect(lifecycle.resumeVerificationStatus?.()).toBe("accepted");
	expect(lifecycle.quotaResume!.onContinueStarted({ turnId: "turn-c" })).toBe(
		true,
	);
	lifecycle.quotaResume!.onContinueProgress({
		turnId: "turn-c",
		itemType: "agentMessage",
	});
	return verified();
};

function resumer(
	store: StateStore,
	script: Script,
	overrides: Partial<Parameters<typeof createCodexQuotaStandbyResumer>[0]> = {},
) {
	let clock = Date.now();
	const cleanup = vi.fn(async () => ({ ok: true }));
	const revive = vi.fn(async () => ({ ok: true }));
	const relaunch = vi.fn(
		async (input: {
			session: WorkflowActorSession;
			lifecycle: (identity: never) => SameExecutionLifecycle;
		}) => script(input.lifecycle(undefined as never)),
	);
	const r = createCodexQuotaStandbyResumer({
		store,
		ownerPrefix: "bridge:1:boot",
		getSession: (id) =>
			({
				execution_id: id,
				issue_id: "FLY-2900",
				project_name: "flywheel",
			}) as WorkflowActorSession,
		relaunch: relaunch as never,
		cleanup,
		reviveCommDbSession: revive,
		turnHolder: async (session) => session.execution_id,
		now: () => clock,
		warn: () => undefined,
		...overrides,
	});
	return {
		r,
		cleanup,
		revive,
		relaunch,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

const ctx = (root = true) => ({
	now: Date.now(),
	root: root
		? {
				rootKey: ROOT,
				accountKey: ACCOUNT,
				profile: "business",
				generation: 1,
				authDigest: "d".repeat(64),
			}
		: null,
	readings: null,
});

describe("FLY-2900 C5 — standby resumer", () => {
	it("claims, relaunches the same execution and lets the handshake close it", async () => {
		const { store, executions } = await parkedWithPermit();
		const t = resumer(store, happy);
		await t.r.tick(ctx());
		await t.r.settled();
		expect(t.relaunch).toHaveBeenCalledOnce();
		expect(t.revive).toHaveBeenCalledOnce();
		expect(store.codexQuota.getStandby(executions[0]!)?.state).toBe("closed");
		await t.r.tick(ctx());
		expect(t.cleanup).not.toHaveBeenCalled();
		expect(t.r.inFlight()).toEqual([]);
	});

	it.each([
		[
			"deploy brake",
			new AdmissionDeferredError("admission_paused", "deploy", 60),
		],
		[
			"pressure hold",
			new AdmissionDeferredError("pressure_hold", "pressure", 60),
		],
		["load pressure", new AdmissionDeferredError("load_pressure", "load", 60)],
		[
			"memory pressure",
			new AdmissionDeferredError("memory_pressure", "memory", 60),
		],
		["DOA backoff", new DoaBackoffError("recent_failure", 60)],
		["quota queued", new CodexQuotaQueuedError("exec-0", ROOT, 1)],
		["shutdown", new Error("RunDispatcher is shutting down")],
		[
			"engine brake",
			Object.assign(new Error("engine_admission_deploy_brake"), {
				admissionBrake: true,
			}),
		],
	])(
		"retries %s twice without spending mechanical or fallback budget",
		async (_name, error) => {
			const { store, executions } = await parkedWithPermit();
			const executionId = executions[0]!;
			const start = vi.fn(async (request: StartRequest) => {
				if (start.mock.calls.length <= 2) throw error;
				await happy(request.processLifecycle!);
				return {};
			});
			const t = resumer(store, happy, {
				getSession: (id) =>
					({
						execution_id: id,
						issue_id: "FLY-2900",
						project_name: "flywheel",
						worktree_path: "/wt",
						chat_thread_role: "implement",
					}) as WorkflowActorSession,
				relaunch: (input) =>
					relaunchSameWorkflowExecution(
						{
							startDispatcher: { start },
							getRuntime: () => ({
								vendor: "codex",
								model: "gpt-5.6-sol",
								effort: "high",
								node_id: "implement",
							}),
							resolveCurrentActivation: () => ({
								kind: "current",
								run: { project_name: "flywheel" },
							}),
							manifestPath: () => "/manifest",
							readManifest: () => ({
								threadId: "t",
								resolvedModel: "gpt-5.6-sol",
								cwd: "/wt",
							}),
							realpath: (path) => path,
							gitIdentity: async () => ({ head: "abc", dirty: false }),
							frozenLeadId: () => "flywheel-eng-lead",
						},
						input,
					),
			});
			const checkpoint = vi.fn(() => ({ kind: "clean" as const, head: "abc" }));
			const fallback = createCodexQuotaFallbackEvaluator({
				store,
				pool: () => [],
				claudeFallbackEnabled: () => true,
				claudeDispatch: () => ({ model: "claude-opus-5-5", effort: "xhigh" }),
				checkpoint,
				warn: () => undefined,
			});
			// Real relaunch, real dispatcher error classes, real durable counters and
			// fallback evaluator: two admission denials must not replace this thread.
			for (let attempt = 1; attempt <= 2; attempt++) {
				await t.r.tick(ctx());
				await t.r.settled();
				expect(start).toHaveBeenCalledTimes(attempt);
				await fallback.tick(ctx());
				await t.r.tick(ctx());
				await t.r.settled();
				expect(start).toHaveBeenCalledTimes(attempt);
				const retrySeconds =
					"retryAfterSeconds" in error ? error.retryAfterSeconds : undefined;
				const delay =
					typeof retrySeconds === "number" ? retrySeconds * 1_000 : 15_000;
				t.advance(delay - 1);
				await t.r.tick(ctx());
				await t.r.settled();
				expect(start).toHaveBeenCalledTimes(attempt);
				t.advance(1);
			}
			expect(checkpoint).not.toHaveBeenCalled();
			expect(store.codexQuota.getStandby(executionId)).toMatchObject({
				state: "standby",
				mechanical_failures: 0,
				fallback_attempt: 0,
				resume_attempt: 1,
				continue_attempt_id: expect.any(String),
			});
			await t.r.tick(ctx());
			await t.r.settled();
			expect(start).toHaveBeenCalledTimes(3);
			expect(store.codexQuota.getStandby(executionId)).toMatchObject({
				state: "closed",
				mechanical_failures: 0,
				fallback_attempt: 0,
			});
			expect(start.mock.calls.map(([req]) => req.successorExecutionId)).toEqual(
				[executionId, executionId, executionId],
			);
			expect(
				start.mock.calls.map(([req]) => req.previousSession?.threadId),
			).toEqual(["t", "t", "t"]);
		},
	);

	it("makes no claim while the loop has no qualified root this round", async () => {
		const { store } = await parkedWithPermit();
		const t = resumer(store, happy);
		await t.r.tick(ctx(false));
		expect(t.relaunch).not.toHaveBeenCalled();
	});

	it("keeps at most two relaunches in flight", async () => {
		const { store } = await parkedWithPermit(3);
		const pending: Array<() => void> = [];
		const t = resumer(
			store,
			() =>
				new Promise((resolve) => {
					pending.push(() => resolve(verified()));
				}),
		);
		const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
		await t.r.tick(ctx());
		await flush();
		expect(t.relaunch).toHaveBeenCalledTimes(2);
		expect(t.r.inFlight()).toHaveLength(2);
		await t.r.tick(ctx());
		await flush();
		expect(t.relaunch).toHaveBeenCalledTimes(2);
		for (const release of pending) release();
	});

	it("counts a failed relaunch once and reaps its process on the next tick", async () => {
		const { store, executions } = await parkedWithPermit();
		const t = resumer(store, async () => ({
			ok: false,
			error: "resume_identity_timeout",
			cleanupRequired: true,
		}));
		await t.r.tick(ctx());
		await t.r.settled();
		expect(store.codexQuota.getStandby(executions[0]!)).toMatchObject({
			state: "standby",
			mechanical_failures: 1,
			last_error_code: "identity_timeout",
		});
		await t.r.tick(ctx());
		expect(t.cleanup).toHaveBeenCalledOnce();
	});

	it("reaps the process when an operator releases the claim mid-flight", async () => {
		const { store, executions } = await parkedWithPermit();
		const t = resumer(store, () => new Promise(() => undefined));
		await t.r.tick(ctx());
		store.releaseCodexQuotaStandby({
			executionId: executions[0]!,
			reason: "operator_terminated",
			now: new Date().toISOString(),
		});
		// The in-flight launch never settles; cleanup must not wait on it.
		await t.r.tick(ctx());
		expect(t.cleanup).toHaveBeenCalledOnce();
		expect(t.r.inFlight()).toEqual([]);
		expect(store.codexQuota.getStandby(executions[0]!)).toMatchObject({
			state: "released",
			owner_claim_id: null,
		});
		await t.r.tick(ctx());
		expect(t.cleanup).toHaveBeenCalledOnce();
	});

	it("reaps a claim released before a Bridge restart on the next Bridge's tick", async () => {
		const { store, executions } = await parkedWithPermit();
		const claimed = store.claimCodexQuotaResume({
			executionId: executions[0]!,
			ownerClaimId: "bridge:0:oldboot:x",
			now: new Date().toISOString(),
		});
		expect(claimed.ok).toBe(true);
		// Released mid-resume; the old Bridge died before its cleanup ran.
		store.releaseCodexQuotaStandby({
			executionId: executions[0]!,
			reason: "operator_terminated",
			now: new Date().toISOString(),
		});
		expect(store.codexQuota.getStandby(executions[0]!)?.owner_claim_id).toBe(
			"bridge:0:oldboot:x",
		);
		const failing = vi.fn(async () => ({
			ok: false,
			error: "daemon_residual",
		}));
		const t = resumer(store, happy, { cleanup: failing });
		await t.r.tick(ctx());
		expect(failing).toHaveBeenCalledOnce();
		// Not proven reaped: keep the owner so a later tick retries.
		expect(store.codexQuota.getStandby(executions[0]!)?.owner_claim_id).toBe(
			"bridge:0:oldboot:x",
		);
		failing.mockResolvedValue({ ok: true });
		await t.r.tick(ctx());
		expect(failing).toHaveBeenCalledTimes(2);
		expect(store.codexQuota.getStandby(executions[0]!)).toMatchObject({
			state: "released",
			owner_claim_id: null,
		});
		await t.r.tick(ctx());
		expect(failing).toHaveBeenCalledTimes(2);
		expect(t.relaunch).not.toHaveBeenCalled();
	});

	it("fails a relaunch that never produces model output in time", async () => {
		const { store, executions } = await parkedWithPermit();
		const t = resumer(store, async (lifecycle) => {
			lifecycle.onIdentityVerified?.({
				sessionId: "t",
				model: "gpt-5.6-sol",
				cwd: "/wt",
				verifiedAt: "t",
			});
			lifecycle.quotaResume!.onContinueStarted({ turnId: "turn-c" });
			return verified();
		});
		await t.r.tick(ctx());
		await t.r.settled();
		t.advance(
			CODEX_STANDBY_IDENTITY_TIMEOUT_MS + CODEX_STANDBY_PROGRESS_TIMEOUT_MS + 1,
		);
		await t.r.tick(ctx());
		expect(store.codexQuota.getStandby(executions[0]!)).toMatchObject({
			state: "standby",
			mechanical_failures: 1,
			last_error_code: "progress_timeout",
			// The continue's fate is unknown: keep the id for reconciliation.
			continue_attempt_id: expect.any(String),
		});
		await t.r.tick(ctx());
		expect(t.cleanup).toHaveBeenCalledOnce();
	});

	it("never relaunches without the TURN", async () => {
		const { store, executions } = await parkedWithPermit();
		const t = resumer(store, happy, { turnHolder: async () => "someone-else" });
		await t.r.tick(ctx());
		await t.r.settled();
		expect(t.relaunch).not.toHaveBeenCalled();
		expect(store.codexQuota.getStandby(executions[0]!)).toMatchObject({
			state: "standby",
			mechanical_failures: 1,
			last_error_code: "turn_not_held",
		});
	});

	it("returns a claim from a previous Bridge process to standby on its first tick", async () => {
		const { store, executions } = await parkedWithPermit();
		const claimed = store.claimCodexQuotaResume({
			executionId: executions[0]!,
			ownerClaimId: "bridge:0:oldboot:x",
			now: new Date().toISOString(),
		});
		expect(claimed.ok).toBe(true);
		const t = resumer(store, happy);
		await t.r.tick(ctx());
		await t.r.settled();
		// Recovered to standby uncounted, then claimed and resumed by this process.
		expect(store.codexQuota.getStandby(executions[0]!)).toMatchObject({
			state: "closed",
			mechanical_failures: 0,
		});
		expect(rawDb(store).prepare("SELECT 1").get()).toBeTruthy();
	});

	it("settles a non-quota continue failure as one mechanical failure", async () => {
		const { store, executions } = await parkedWithPermit();
		const t = resumer(store, async (lifecycle) => {
			lifecycle.onIdentityVerified?.({
				sessionId: "t",
				model: "gpt-5.6-sol",
				cwd: "/wt",
				verifiedAt: "t",
			});
			lifecycle.quotaResume!.onContinueStarted({ turnId: "turn-c" });
			lifecycle.quotaResume!.onContinueFailed({
				turnId: "turn-c",
				reasonCode: "continue_turn_failed_before_output",
				usageLimited: false,
			});
			return verified();
		});
		await t.r.tick(ctx());
		await t.r.settled();
		expect(store.codexQuota.getStandby(executions[0]!)).toMatchObject({
			state: "standby",
			mechanical_failures: 1,
			continue_attempt_id: null,
		});
	});
});

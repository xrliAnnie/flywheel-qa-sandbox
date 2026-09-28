/**
 * FLY-2900 integration bench: real StateStore + the resume loop, the standby
 * resumer and the fallback evaluator on a fake clock. The daemon is modelled
 * by the relaunch stub, which drives the adapter's lifecycle callbacks the
 * way the real runner does (identity → continue started → first output).
 */
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createCodexStandbyRun,
	quotaWall,
	rawDb,
} from "../../__tests__/helpers/codex-quota-standby-fixture.js";
import type { WorkflowActorSession } from "../../bridge/workflow-actor-session.js";
import type {
	SameExecutionLifecycle,
	SameExecutionRelaunchResult,
} from "../../bridge/workflow-same-execution-relaunch.js";
import { StateStore } from "../../StateStore.js";
import type { CodexAccountQuotaStore } from "../codex-account-quota-store.js";
import { createCodexQuotaFallbackEvaluator } from "../quota-fallback.js";
import { createCodexQuotaResumeLoop } from "../resume-loop.js";
import { createCodexQuotaStandbyResumer } from "../standby-resumer.js";

const cleanups: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const path of cleanups.splice(0))
		rmSync(path, { recursive: true, force: true });
});

const ROOT = "root-canonical";
const BUSINESS = "a".repeat(64);
const SCHOOL = "b".repeat(64);
const TICK_MS = 3_000;

type Behaviour =
	| "healthy"
	| "resume_rejected"
	| "continue_failed"
	| "missing_auth_digest"
	| "hang";

async function bench(options: { runs?: number; bound?: boolean } = {}) {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.codexQuotaStandbyEnabled = () => true;
	let clock = Date.now();
	const iso = () => new Date(clock).toISOString();
	store.codexQuota.initializeRoot({
		rootKey: ROOT,
		accountKey: BUSINESS,
		profile: "business",
		generation: 1,
	});
	const executions: string[] = [];
	for (let i = 0; i < (options.runs ?? 1); i += 1) {
		const ids = createCodexStandbyRun(store, {
			runId: `run-${i}`,
			executionId: `exec-${i}`,
			issueId: `FLY-${3000 + i}`,
			cleanups,
		});
		executions.push(ids.executionId);
		if (options.bound) {
			store.codexQuota.registerBinding({
				bindingId: `bind-${i}`,
				executionId: ids.executionId,
				runId: ids.runId,
				purpose: "runner",
				accountKey: BUSINESS,
				profile: "business",
				generation: 1,
				credentialRootKey: ROOT,
			});
		}
		store.recordEnrolledTerminalSignal({
			...quotaWall(ids.executionId, `wall-${i}`, { now: iso() }),
			...(options.bound
				? {
						quotaSignal: {
							version: 1 as const,
							vendor: "codex" as const,
							source: "goal_ended" as const,
							sourceEventId: `wall-${i}`,
							bindingId: `bind-${i}`,
							evidence: "usageLimited" as const,
							observedAt: iso(),
						},
					}
				: {}),
		});
	}
	let readings: CodexAccountQuotaStore | null = null;
	const behaviour = new Map<string, Behaviour>();
	const launches: string[] = [];
	const inFlight = new Set<string>();
	let maxInFlight = 0;
	let claudeEnabled = true;
	const relaunch = vi.fn(
		async (input: {
			session: WorkflowActorSession;
			lifecycle: (identity: never) => SameExecutionLifecycle;
		}): Promise<SameExecutionRelaunchResult> => {
			const id = input.session.execution_id;
			launches.push(id);
			inFlight.add(id);
			maxInFlight = Math.max(maxInFlight, inFlight.size);
			try {
				const mode = behaviour.get(id) ?? "healthy";
				if (mode === "resume_rejected")
					return {
						ok: false,
						error: "thread_resume_failed",
						cleanupRequired: true,
					};
				const lifecycle = input.lifecycle(undefined as never);
				lifecycle.onIdentityVerified?.({
					sessionId: "thread",
					model: "gpt-5.6-sol",
					cwd: "/wt",
					verifiedAt: iso(),
					...(mode === "missing_auth_digest"
						? {}
						: { authDigest: "d".repeat(64) }),
				});
				if (lifecycle.resumeVerificationStatus?.() !== "accepted")
					return {
						ok: false,
						error: "resume_durable_verification_rejected",
						cleanupRequired: true,
					};
				const quota = lifecycle.quotaResume!;
				if (mode === "hang") return new Promise(() => undefined);
				quota.onContinueStarted({ turnId: `turn-${id}` });
				if (mode === "continue_failed") {
					quota.onContinueFailed({
						turnId: `turn-${id}`,
						reasonCode: "continue_turn_failed_before_output",
						usageLimited: false,
					});
				} else {
					quota.onContinueProgress({
						turnId: `turn-${id}`,
						itemType: "agentMessage",
					});
				}
				return {
					ok: true,
					expectedSessionId: "thread",
					observedSessionId: "thread",
					expectedModel: "gpt-5.6-sol",
					observedModel: "gpt-5.6-sol",
					expectedCwd: "/wt",
					observedCwd: "/wt",
					queueMs: 0,
					startupMs: 1,
					totalMs: 1,
				};
			} finally {
				inFlight.delete(id);
			}
		},
	);
	const makeResumer = (ownerPrefix: string) =>
		createCodexQuotaStandbyResumer({
			store,
			ownerPrefix,
			getSession: (id) =>
				store.getSession(id) as WorkflowActorSession | undefined,
			relaunch: relaunch as never,
			cleanup: async () => ({ ok: true }),
			reviveCommDbSession: async () => ({ ok: true }),
			turnHolder: async (session) => session.execution_id,
			now: () => clock,
			warn: () => undefined,
		});
	let resumer = makeResumer("bridge:1:boot");
	const makeLoop = () =>
		createCodexQuotaResumeLoop({
			store,
			reconcileCanonical: async () => {
				const root = store.codexQuota.getRoot(ROOT)!;
				return { ...root, authDigest: "d".repeat(64) };
			},
			readiness: async () => ({ ready: true }),
			readReadings: () => readings,
			requestReadingRefresh: async () => undefined,
			resumer: { tick: (context) => resumer.tick(context) },
			fallback: createCodexQuotaFallbackEvaluator({
				store,
				claudeFallbackEnabled: () => claudeEnabled,
				pool: () => [
					{ profile: "business", accountKey: BUSINESS },
					{ profile: "school", accountKey: SCHOOL },
				],
				claudeDispatch: () => ({ model: "claude-opus-5-5", effort: "xhigh" }),
				checkpoint: () => ({ kind: "clean", head: "h" }),
				now: () => clock,
				warn: () => undefined,
			}),
			now: () => clock,
			warn: () => undefined,
		});
	let loop = makeLoop();
	const tickFor = async (ms: number) => {
		const end = clock + ms;
		while (clock < end) {
			await loop.tick();
			// Let settled launches finish; a hung daemon is never awaited.
			for (let flush = 0; flush < 3; flush += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
			clock += TICK_MS;
		}
	};
	const reading = (
		profile: "business" | "school",
		accountKey: string,
		used: number,
		resetInMs = 3_600_000,
	) => ({
		name: profile,
		registeredProfile: profile,
		identityKey: accountKey,
		observedAt: iso(),
		authHealth: "valid" as const,
		note: null,
		planType: "plus",
		fiveH: {
			usedPercent: used === 100 ? 20 : used,
			windowMinutes: 300,
			resetAt: new Date(clock + resetInMs).toISOString(),
		},
		weekly: {
			usedPercent: used,
			windowMinutes: 10080,
			resetAt: new Date(clock + resetInMs).toISOString(),
		},
		credits: { known: false, hasCredits: null, unlimited: null, balance: null },
		resetCredits: {
			known: false,
			value: null,
			availableCount: null,
			credits: null,
		},
		unclassifiedWindows: 0,
		requestSeq: store.codexQuota.allocateCausalSeq(),
	});
	return {
		store,
		executions,
		behaviour,
		launches,
		relaunch,
		tickFor,
		now: () => clock,
		iso,
		setReadings: (value: CodexAccountQuotaStore | null) => {
			readings = value;
		},
		reading,
		setClaude: (enabled: boolean) => {
			claudeEnabled = enabled;
		},
		restartBridge: () => {
			resumer = makeResumer("bridge:2:reboot");
			loop = makeLoop();
		},
		maxInFlight: () => maxInFlight,
		state: (id: string) => store.codexQuota.getStandby(id),
		blindReplacements: () =>
			Number(
				(
					rawDb(store)
						.prepare(
							"SELECT COUNT(*) AS n FROM workflow_side_effect_ledger WHERE purpose='fault_replacement'",
						)
						.get() as { n: number }
				).n,
			),
	};
}

const commitSwitch = (store: StateStore) => {
	const quota = store.codexQuota;
	quota.recordInstalling({
		incidentId: `codex:${ROOT}:1`,
		profile: "school",
		accountKey: SCHOOL,
		priorAuthDigest: "p".repeat(64),
		installedAuthDigest: "i".repeat(64),
		recoveryMaterialPath: "/tmp/recovery",
	});
	quota.commitGeneration({
		incidentId: `codex:${ROOT}:1`,
		expectedGeneration: 1,
		accountKey: SCHOOL,
		profile: "school",
		authDigest: "i".repeat(64),
		probeResult: "ok",
	});
};

describe("FLY-2900 standby bench", () => {
	it("B1 a committed switch resumes six parked runs in place, at most two at a time, within 3 minutes", async () => {
		const b = await bench({ runs: 6, bound: true });
		for (const id of b.executions) expect(b.state(id)?.state).toBe("standby");
		expect(b.blindReplacements()).toBe(0);
		commitSwitch(b.store);
		await b.tickFor(3 * 60_000);
		for (const id of b.executions) {
			expect(b.state(id)?.state).toBe("closed");
			expect(b.store.getSession(id)?.status).toBe("running");
		}
		expect(new Set(b.launches)).toEqual(new Set(b.executions));
		expect(b.launches).toHaveLength(6);
		expect(b.maxInFlight()).toBeLessThanOrEqual(2);
		expect(b.blindReplacements()).toBe(0);
		expect(
			b.store.codexQuota
				.listOutbox()
				.filter((row) => row.kind === "resume_notice"),
		).toHaveLength(6);
	});

	it("B2 a post-wall reading of the same account resumes an unbound wall within 5 minutes; a later wall is attributed to the new generation", async () => {
		const b = await bench({ runs: 1 });
		const [id] = b.executions as [string];
		b.setReadings({
			version: 1,
			generatedAt: b.iso(),
			activeAccount: "business",
			accounts: [b.reading("business", BUSINESS, 40)],
		});
		await b.tickFor(5 * 60_000);
		expect(b.state(id)?.state).toBe("closed");
		const row = b.state(id)!;
		const binding = b.store.codexQuota.getBinding(String(row.binding_id))!;
		expect(binding.generation).toBe(
			b.store.codexQuota.getRoot(ROOT)!.generation,
		);
		// The resumed body walls again on the claim's binding: a new entry,
		// bound to the current generation.
		b.store.recordEnrolledTerminalSignal({
			...quotaWall(id, "wall-again", { now: b.iso() }),
			quotaSignal: {
				version: 1,
				vendor: "codex",
				source: "goal_ended",
				sourceEventId: "wall-again",
				bindingId: binding.bindingId,
				evidence: "usageLimited",
				observedAt: b.iso(),
			},
		});
		expect(b.state(id)).toMatchObject({
			state: "standby",
			entry_seq: 2,
			generation: binding.generation,
		});
	});

	it("B2 a wall while resuming is a capacity rejection, never a fallback", async () => {
		const b = await bench({ runs: 1 });
		const [id] = b.executions as [string];
		b.behaviour.set(id, "hang");
		b.setReadings({
			version: 1,
			generatedAt: b.iso(),
			activeAccount: "business",
			accounts: [b.reading("business", BUSINESS, 40)],
		});
		await b.tickFor(30_000);
		expect(b.state(id)?.state).toBe("resuming");
		b.store.recordEnrolledTerminalSignal(
			quotaWall(id, "wall-during-resume", { now: b.iso() }),
		);
		expect(b.state(id)).toMatchObject({
			state: "standby",
			capacity_rejections: 1,
			mechanical_failures: 0,
		});
		await b.tickFor(30_000);
		expect(b.state(id)?.fallback_attempt).toBe(0);
	});

	it("B3 a manual switch is recognised by reading confirmation without another generation bump", async () => {
		const b = await bench({ runs: 1, bound: true });
		const [id] = b.executions as [string];
		b.store.codexQuota.reconcileExternalRoot({
			rootKey: ROOT,
			expectedGeneration: 1,
			accountKey: SCHOOL,
			profile: "school",
			authDigest: "e".repeat(64),
		});
		expect(b.store.codexQuota.getIncident(`codex:${ROOT}:1`)?.state).toBe(
			"identity_uncertain",
		);
		b.setReadings({
			version: 1,
			generatedAt: b.iso(),
			activeAccount: "school",
			accounts: [b.reading("school", SCHOOL, 10)],
		});
		await b.tickFor(60_000);
		expect(b.state(id)?.state).toBe("closed");
		expect(b.store.codexQuota.getRoot(ROOT)!.generation).toBe(2);
		expect(b.store.codexQuota.getIncident(`codex:${ROOT}:1`)?.state).toBe(
			"settled",
		);
	});

	it("B3 never settles the old incident when the resumed process cannot prove its credential digest", async () => {
		const b = await bench({ runs: 1, bound: true });
		const [id] = b.executions as [string];
		b.behaviour.set(id, "missing_auth_digest");
		b.store.codexQuota.reconcileExternalRoot({
			rootKey: ROOT,
			expectedGeneration: 1,
			accountKey: SCHOOL,
			profile: "school",
			authDigest: "e".repeat(64),
		});
		b.setReadings({
			version: 1,
			generatedAt: b.iso(),
			activeAccount: "school",
			accounts: [b.reading("school", SCHOOL, 10)],
		});
		await b.tickFor(60_000);
		expect(b.state(id)?.state).toBe("closed");
		expect(b.store.codexQuota.getIncident(`codex:${ROOT}:1`)?.state).toBe(
			"identity_uncertain",
		);
		expect(
			b.store.codexQuota.getResumeOutputRecoveryPermit(`codex:${ROOT}:1`),
		).toBeUndefined();
	});

	it("B4 a walled pool hands the node to Claude only with the switch on and recovery more than 30 minutes away", async () => {
		const b = await bench({ runs: 1 });
		const [id] = b.executions as [string];
		const walled = (resetInMs: number): CodexAccountQuotaStore => ({
			version: 1,
			generatedAt: b.iso(),
			activeAccount: "business",
			accounts: [
				b.reading("business", BUSINESS, 100, resetInMs),
				b.reading("school", SCHOOL, 100, resetInMs),
			],
		});
		b.setReadings(walled(20 * 60_000));
		await b.tickFor(30_000);
		expect(b.state(id)?.state).toBe("standby");
		b.setClaude(false);
		b.setReadings(walled(2 * 3_600_000));
		await b.tickFor(30_000);
		expect(b.state(id)?.state).toBe("standby");
		b.setClaude(true);
		await b.tickFor(30_000);
		expect(b.state(id)).toMatchObject({
			state: "fallback_prepared",
			fallback_vendor: "claude",
		});
		const newExecutionId = String(b.state(id)!.fallback_execution_id);
		// Admission refuses the Claude body: roll back, the original stays resumable.
		b.store.revertCodexQuotaFallback({
			newExecutionId,
			reason: "admission_same_vendor_review",
			now: b.iso(),
		});
		b.setClaude(false);
		b.setReadings({
			version: 1,
			generatedAt: b.iso(),
			activeAccount: "business",
			accounts: [b.reading("business", BUSINESS, 30)],
		});
		await b.tickFor(60_000);
		expect(b.state(id)?.state).toBe("closed");
		expect(b.launches).toEqual([id]);
	});

	it("B5 two failed relaunches under one permit hand the node to one fresh Codex body; no blind replacement", async () => {
		const b = await bench({ runs: 1 });
		const [id] = b.executions as [string];
		b.behaviour.set(id, "resume_rejected");
		b.setReadings({
			version: 1,
			generatedAt: b.iso(),
			activeAccount: "business",
			accounts: [b.reading("business", BUSINESS, 40)],
		});
		await b.tickFor(60_000);
		expect(b.state(id)).toMatchObject({
			state: "fallback_prepared",
			fallback_vendor: "codex",
			fallback_reason: "resume_attempts_exhausted",
			mechanical_failures: 2,
		});
		expect(b.launches).toEqual([id, id]);
		expect(b.blindReplacements()).toBe(0);
	});

	it("B5 a continue that fails before any output counts as a failure and never announces success", async () => {
		const b = await bench({ runs: 1 });
		const [id] = b.executions as [string];
		b.behaviour.set(id, "continue_failed");
		b.setReadings({
			version: 1,
			generatedAt: b.iso(),
			activeAccount: "business",
			accounts: [b.reading("business", BUSINESS, 40)],
		});
		await b.tickFor(60_000);
		expect(b.state(id)?.mechanical_failures).toBe(2);
		expect(
			b.store.codexQuota
				.listOutbox()
				.filter(
					(row) =>
						row.kind === "resume_notice" &&
						String(row.payload_json).includes('"resumed"'),
				),
		).toHaveLength(0);
	});

	it("B6 an operator release at any stage stops every later relaunch and fallback", async () => {
		for (const stage of ["standby", "resuming", "fallback_prepared"] as const) {
			const b = await bench({ runs: 1 });
			const [id] = b.executions as [string];
			if (stage === "resuming") b.behaviour.set(id, "hang");
			if (stage === "fallback_prepared")
				rawDb(b.store)
					.prepare(
						"UPDATE codex_quota_standby SET mechanical_failures=2 WHERE execution_id=?",
					)
					.run(id);
			if (stage !== "standby") {
				b.setReadings({
					version: 1,
					generatedAt: b.iso(),
					activeAccount: "business",
					accounts: [b.reading("business", BUSINESS, 40)],
				});
				await b.tickFor(30_000);
			}
			expect(b.state(id)?.state).toBe(stage);
			b.store.holdWorkflowRunByOperator({
				runId: b.state(id)!.run_id,
				reason: "operator hold",
				clientRequestId: `hold-${stage}`,
				principal: "master",
				evidence: [],
				now: b.iso(),
			});
			expect(b.state(id)?.state).toBe("released");
			const launches = b.launches.length;
			b.setReadings({
				version: 1,
				generatedAt: b.iso(),
				activeAccount: "business",
				accounts: [b.reading("business", BUSINESS, 40)],
			});
			await b.tickFor(60_000);
			expect(b.launches.length).toBe(launches);
			expect(b.state(id)?.state).toBe("released");
		}
	});

	it("B6 a Bridge restart mid-resume resumes the same execution once, without counting a failure", async () => {
		const b = await bench({ runs: 1 });
		const [id] = b.executions as [string];
		b.behaviour.set(id, "hang");
		b.setReadings({
			version: 1,
			generatedAt: b.iso(),
			activeAccount: "business",
			accounts: [b.reading("business", BUSINESS, 40)],
		});
		await b.tickFor(15_000);
		expect(b.state(id)?.state).toBe("resuming");
		b.behaviour.set(id, "healthy");
		b.restartBridge();
		await b.tickFor(30_000);
		expect(b.state(id)).toMatchObject({
			state: "closed",
			mechanical_failures: 0,
		});
		expect(b.launches).toEqual([id, id]);
	});
});

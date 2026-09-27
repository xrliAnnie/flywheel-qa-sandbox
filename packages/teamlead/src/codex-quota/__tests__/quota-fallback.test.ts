import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createCodexStandbyRun,
	quotaWall,
	rawDb,
} from "../../__tests__/helpers/codex-quota-standby-fixture.js";
import { StateStore } from "../../StateStore.js";
import { resolveNodeDispatchAtLaunch } from "../../workflow-dispatch-resolution.js";
import type { CodexAccountQuotaStore } from "../codex-account-quota-store.js";
import {
	CODEX_STANDBY_OVERDUE_MS,
	createCodexQuotaFallbackEvaluator,
	evaluatePoolExhaustionFromReadings,
} from "../quota-fallback.js";

const cleanups: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const path of cleanups.splice(0))
		rmSync(path, { recursive: true, force: true });
});

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const POOL = [
	{ profile: "business", accountKey: "a".repeat(64) },
	{ profile: "school", accountKey: "b".repeat(64) },
];

function walledReadings(
	overrides: {
		resetInMs?: number;
		stale?: boolean;
		resetUnknown?: boolean;
	} = {},
): CodexAccountQuotaStore {
	const observedAt = new Date(
		NOW - (overrides.stale ? 21 * 60_000 : 60_000),
	).toISOString();
	const resetAt = overrides.resetUnknown
		? null
		: new Date(NOW + (overrides.resetInMs ?? 2 * 3_600_000)).toISOString();
	return {
		version: 1,
		generatedAt: observedAt,
		activeAccount: "business",
		accounts: POOL.map((member, index) => ({
			name: member.profile,
			registeredProfile: member.profile,
			identityKey: member.accountKey,
			observedAt,
			authHealth: "valid" as const,
			note: null,
			planType: "plus",
			fiveH: { usedPercent: 10, windowMinutes: 300, resetAt: null },
			weekly: {
				usedPercent: 100,
				windowMinutes: 10080,
				resetAt:
					resetAt === null
						? null
						: new Date(Date.parse(resetAt) + index * 3_600_000).toISOString(),
			},
			credits: {
				known: false,
				hasCredits: null,
				unlimited: null,
				balance: null,
			},
			resetCredits: {
				known: false,
				value: null,
				availableCount: null,
				credits: null,
			},
			unclassifiedWindows: 0,
		})),
	};
}

describe("FLY-2900 C6 — the walled-pool verdict", () => {
	it("is walled with the earliest recovery when every fresh account has a 100% window", () => {
		expect(
			evaluatePoolExhaustionFromReadings(walledReadings(), POOL, NOW),
		).toMatchObject({ exhausted: true, earliestResetMs: NOW + 2 * 3_600_000 });
	});

	it.each([
		[
			"a stale reading",
			walledReadings({ stale: true }),
			"reading_stale:business",
		],
		[
			"an unknown reset",
			walledReadings({ resetUnknown: true }),
			"reset_unknown:business",
		],
	])("is not walled with %s", (_n, readings, reason) => {
		expect(evaluatePoolExhaustionFromReadings(readings, POOL, NOW)).toEqual({
			exhausted: false,
			reason,
		});
	});

	it("is not walled when an account has capacity or its identity is unproven", () => {
		const capacity = walledReadings();
		capacity.accounts[1]!.weekly!.usedPercent = 90;
		expect(evaluatePoolExhaustionFromReadings(capacity, POOL, NOW)).toEqual({
			exhausted: false,
			reason: "capacity_left:school",
		});
		const foreign = walledReadings();
		foreign.accounts[0]!.identityKey = "c".repeat(64);
		expect(evaluatePoolExhaustionFromReadings(foreign, POOL, NOW)).toEqual({
			exhausted: false,
			reason: "identity_unproven:business",
		});
		expect(evaluatePoolExhaustionFromReadings(null, POOL, NOW)).toEqual({
			exhausted: false,
			reason: "readings_missing",
		});
	});
});

async function parked(options: { mechanicalFailures?: number } = {}) {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.codexQuotaStandbyEnabled = () => true;
	const ids = createCodexStandbyRun(store, { cleanups });
	store.recordEnrolledTerminalSignal(
		quotaWall(ids.executionId, "wall-1", {
			now: new Date(NOW - 60_000).toISOString(),
		}),
	);
	if (options.mechanicalFailures !== undefined)
		rawDb(store)
			.prepare(
				"UPDATE codex_quota_standby SET mechanical_failures=? WHERE execution_id=?",
			)
			.run(options.mechanicalFailures, ids.executionId);
	return { store, ...ids };
}

function evaluator(
	store: StateStore,
	overrides: Partial<
		Parameters<typeof createCodexQuotaFallbackEvaluator>[0]
	> = {},
) {
	let n = 0;
	return createCodexQuotaFallbackEvaluator({
		store,
		claudeFallbackEnabled: () => true,
		pool: () => POOL,
		claudeDispatch: () => ({ model: "claude-opus-5-5", effort: "xhigh" }),
		checkpoint: () => ({ kind: "clean", head: "h" }),
		now: () => NOW,
		newExecutionId: () => {
			n += 1;
			return `fallback-${n}`;
		},
		warn: () => undefined,
		...overrides,
	});
}

const ctx = (readings: CodexAccountQuotaStore | null) => ({
	now: NOW,
	root: null,
	readings,
});

function node(store: StateStore, runId: string) {
	return rawDb(store)
		.prepare(
			"SELECT state, execution_id FROM workflow_run_node WHERE run_id=? AND node_id='implement' AND attempt=1",
		)
		.get(runId) as { state: string; execution_id: string };
}

describe("FLY-2900 C6 — fallback evaluation", () => {
	it("hands a body that failed twice to a fresh Codex execution with its frozen dispatch", async () => {
		const { store, executionId, runId } = await parked({
			mechanicalFailures: 2,
		});
		await evaluator(store).tick(ctx(null));
		expect(store.codexQuota.getStandby(executionId)).toMatchObject({
			state: "fallback_prepared",
			fallback_attempt: 1,
			fallback_execution_id: "fallback-1",
			fallback_vendor: "codex",
			fallback_reason: "resume_attempts_exhausted",
		});
		expect(node(store, runId)).toEqual({
			state: "pending",
			execution_id: "fallback-1",
		});
		expect(store.getCodexQuotaPreparedDemand("fallback-1")).toMatchObject({
			sourceExecutionId: executionId,
			vendor: "codex",
			model: "gpt-5.6-sol",
			effort: "low",
			reason: "resume_attempts_exhausted",
		});
		// The original execution is untouched until the new launch commits.
		expect(store.getSession(executionId)?.status).toBe("running");
		expect(
			rawDb(store)
				.prepare(
					"SELECT purpose, source_demand_id FROM workflow_side_effect_ledger WHERE execution_id='fallback-1'",
				)
				.get(),
		).toEqual({
			purpose: "resume_fallback",
			source_demand_id: `codex-quota-standby:${executionId}:1:1`,
		});
	});

	it("hands a walled pool to Claude only when recovery is more than 30 minutes away", async () => {
		const far = await parked();
		await evaluator(far.store).tick(ctx(walledReadings()));
		expect(far.store.codexQuota.getStandby(far.executionId)).toMatchObject({
			state: "fallback_prepared",
			fallback_vendor: "claude",
			fallback_reason: "codex_quota_fallback",
		});
		expect(far.store.getCodexQuotaPreparedDemand("fallback-1")).toMatchObject({
			vendor: "claude",
			model: "claude-opus-5-5",
			effort: "xhigh",
		});
		const near = await parked();
		await evaluator(near.store).tick(
			ctx(walledReadings({ resetInMs: 20 * 60_000 })),
		);
		expect(near.store.codexQuota.getStandby(near.executionId)?.state).toBe(
			"standby",
		);
	});

	it("keeps waiting when the Claude fallback switch is off or the verdict is unproven", async () => {
		const off = await parked();
		await evaluator(off.store, { claudeFallbackEnabled: () => false }).tick(
			ctx(walledReadings()),
		);
		expect(off.store.codexQuota.getStandby(off.executionId)?.state).toBe(
			"standby",
		);
		const stale = await parked();
		await evaluator(stale.store).tick(ctx(walledReadings({ stale: true })));
		expect(stale.store.codexQuota.getStandby(stale.executionId)?.state).toBe(
			"standby",
		);
	});

	it("records a same-vendor refusal once and never prepares", async () => {
		const { store, executionId } = await parked();
		vi.spyOn(store, "codexQuotaFallbackSameVendorViolation").mockReturnValue({
			violated: true,
			evidence: { conflicts: ["reviewer:qa"] },
		});
		const e = evaluator(store);
		await e.tick(ctx(walledReadings()));
		await e.tick(ctx(walledReadings()));
		expect(store.codexQuota.getStandby(executionId)?.state).toBe("standby");
		expect(
			store.codexQuota
				.listResumeAudit(executionId)
				.filter((row) => row.action === "fallback_blocked")
				.map((row) => row.detail_code),
		).toEqual(["same_vendor_review"]);
	});

	it("blocks and tells the Lead when the worktree cannot be checkpointed", async () => {
		const { store, executionId } = await parked({ mechanicalFailures: 2 });
		rawDb(store)
			.prepare("UPDATE sessions SET worktree_path='/wt' WHERE execution_id=?")
			.run(executionId);
		await evaluator(store, {
			checkpoint: () => ({ kind: "refused", code: "unmerged_entries" }),
		}).tick(ctx(null));
		expect(store.codexQuota.getStandby(executionId)?.state).toBe("standby");
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) =>
					String(row.event_id).includes("wip_checkpoint_unmerged"),
				),
		).toHaveLength(1);
	});

	it("pages the Lead once after 12 hours without a permit, never falling back for waiting", async () => {
		const { store, executionId } = await parked();
		const e = evaluator(store, {
			now: () => NOW + CODEX_STANDBY_OVERDUE_MS + 60_000,
		});
		await e.tick(ctx(null));
		await e.tick(ctx(null));
		expect(store.codexQuota.getStandby(executionId)?.state).toBe("standby");
		expect(
			store.codexQuota
				.listResumeAudit(executionId)
				.filter((row) => row.action === "standby_overdue"),
		).toHaveLength(1);
	});
});

describe("FLY-2900 C6 — two-phase fallback allocation", () => {
	const prepare = (
		store: StateStore,
		executionId: string,
		newExecutionId: string,
		model = "gpt-5.6-sol",
	) =>
		store.prepareCodexQuotaFallback({
			executionId,
			vendor: "codex",
			model,
			effort: "low",
			reason: "resume_attempts_exhausted",
			newExecutionId,
			sameVendorEvidence: {},
			now: new Date(NOW).toISOString(),
		});

	it("replays to the original new execution and refuses changed parameters", async () => {
		const { store, executionId } = await parked();
		expect(prepare(store, executionId, "new-a")).toMatchObject({
			ok: true,
			newExecutionId: "new-a",
			idempotentReplay: false,
		});
		expect(prepare(store, executionId, "new-b")).toMatchObject({
			ok: true,
			newExecutionId: "new-a",
			idempotentReplay: true,
		});
		expect(prepare(store, executionId, "new-c", "other-model")).toEqual({
			ok: false,
			reason: "fallback_replay_conflict",
		});
	});

	it("reverts a refused body back to standby, then allows one more attempt before exhaustion", async () => {
		const { store, executionId, runId } = await parked();
		prepare(store, executionId, "new-a");
		expect(
			store.revertCodexQuotaFallback({
				newExecutionId: "new-a",
				reason: "admission_same_vendor_review",
				now: new Date(NOW).toISOString(),
			}),
		).toBe(true);
		expect(store.codexQuota.getStandby(executionId)).toMatchObject({
			state: "standby",
			last_error_code: "fallback_refused:admission_same_vendor_review",
		});
		expect(node(store, runId).execution_id).toBe(executionId);
		expect(
			rawDb(store)
				.prepare(
					"SELECT state FROM workflow_side_effect_ledger WHERE execution_id='new-a'",
				)
				.get(),
		).toEqual({ state: "abandoned" });
		expect(prepare(store, executionId, "new-b")).toMatchObject({
			ok: true,
			newExecutionId: "new-b",
			fallbackAttempt: 2,
		});
		store.revertCodexQuotaFallback({
			newExecutionId: "new-b",
			reason: "launch_released",
			now: new Date(NOW).toISOString(),
		});
		expect(prepare(store, executionId, "new-c")).toEqual({
			ok: false,
			reason: "fallback_exhausted",
		});
		// The original session stayed resumable throughout.
		expect(store.getSession(executionId)?.status).toBe("running");
		expect(store.isCodexQuotaStandby(executionId)).toBe(true);
	});

	it("commits on the new launch: original failed with a teardown fact, carrier closed, notice queued; replay is a no-op", async () => {
		const { store, executionId } = await parked();
		prepare(store, executionId, "new-a");
		const commit = store as unknown as {
			commitCodexQuotaFallbackTx(id: string, now: string): void;
			db: { transaction(fn: () => void): void };
		};
		commit.db.transaction(() =>
			commit.commitCodexQuotaFallbackTx("new-a", new Date(NOW).toISOString()),
		);
		expect(store.getSession(executionId)).toMatchObject({
			status: "failed",
			last_error: "codex_quota_fallback",
		});
		expect(store.codexQuota.getStandby(executionId)?.state).toBe("closed");
		// The replaced original keeps its writer fence (late activity is a zombie).
		expect(store.getWorkflowDeadExecutionWatch(executionId)).toMatchObject({
			new_execution_id: "new-a",
		});
		expect(
			rawDb(store)
				.prepare(
					"SELECT COUNT(*) AS n FROM workflow_run_event WHERE execution_id=? AND kind='generalized_teardown_recorded'",
				)
				.get(executionId),
		).toEqual({ n: 1 });
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) => row.kind === "resume_notice"),
		).toHaveLength(1);
		const before = JSON.stringify(
			store.codexQuota.listResumeAudit(executionId),
		);
		commit.db.transaction(() =>
			commit.commitCodexQuotaFallbackTx("new-a", new Date(NOW).toISOString()),
		);
		expect(JSON.stringify(store.codexQuota.listResumeAudit(executionId))).toBe(
			before,
		);
	});

	it("voids a prepared body in the same transaction as an operator close intent", async () => {
		const { store, executionId, runId } = await parked();
		prepare(store, executionId, "new-a");
		store.prepareWorkflowOperatorCloseIntent({
			executionId,
			mode: "abandon",
			reason: "founder cancelled",
			now: new Date(NOW).toISOString(),
		});
		expect(store.codexQuota.getStandby(executionId)?.state).toBe("released");
		expect(store.getCodexQuotaPreparedDemand("new-a")).toBeUndefined();
		expect(node(store, runId).execution_id).toBe(executionId);
		expect(store.getWorkflowDeadExecutionWatch(executionId)).toBeUndefined();
	});

	it("resolves a prepared body to its frozen demand, whatever the live template says", async () => {
		const { store, executionId, runId } = await parked();
		store.prepareCodexQuotaFallback({
			executionId,
			vendor: "claude",
			model: "claude-opus-5-5",
			effort: "xhigh",
			reason: "codex_quota_fallback",
			newExecutionId: "new-claude",
			sameVendorEvidence: {},
			poolEvidenceRef: "readings:x",
			now: new Date(NOW).toISOString(),
		});
		expect(
			resolveNodeDispatchAtLaunch(store, {
				runId,
				nodeId: "implement",
				executionId: "new-claude",
			}),
		).toMatchObject({
			dispatch: { vendor: "claude", model: "claude-opus-5-5", effort: "xhigh" },
			source: "codex_quota_demand",
			quotaFallback: {
				sourceExecutionId: executionId,
				dispatchReason: "codex_quota_fallback",
				poolEvidenceRef: "readings:x",
			},
		});
		// Any other execution of the node resolves normally.
		expect(
			resolveNodeDispatchAtLaunch(store, { runId, nodeId: "implement" }).source,
		).not.toBe("codex_quota_demand");
	});
});

describe("FLY-2900 C6 — scorecard exclusion", () => {
	it("recognises a quota-fallback activation by its dispatch record", async () => {
		const { readScorecardQuotaFallback } = await import(
			"../../workflow-model-assignment.js"
		);
		const events = [
			{
				run_id: "r",
				node_id: "implement",
				kind: "dispatch_quota_fallback",
				event_uid: "dispatch_quota_fallback:r:implement:e",
				payload: { activationId: "act-1" },
			},
		] as never;
		expect(
			readScorecardQuotaFallback(events, {
				runId: "r",
				nodeId: "implement",
				activationId: "act-1",
			}),
		).toBe(true);
		expect(
			readScorecardQuotaFallback(events, {
				runId: "r",
				nodeId: "implement",
				activationId: "act-2",
			}),
		).toBe(false);
	});
});

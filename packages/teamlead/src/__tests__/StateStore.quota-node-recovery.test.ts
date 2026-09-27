import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import {
	legacyWorkflowSeeds,
	pinLegacyWorkflowSeedAgents,
} from "./fixtures/legacy-workflow-manifests.js";

const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
async function engineRunWithImplement(
	sessionStatus: "running" | "failed" = "failed",
	standbyLifecycle = false,
): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const seed = pinLegacyWorkflowSeedAgents(
		legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!,
	);
	store.importWorkflowTemplateSeed(seed);
	store.materializeWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1335",
		projectName: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		canonicalRoot: REPO_ROOT,
		env: WORKFLOW_ON,
		startReservation: {
			idempotencyKey: "start-1",
			selectionDigest: "selection-1",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			createdAt: "2026-07-20T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-1",
	});
	expect(
		store.commitWorkflowTransitionTx({
			nodeReuseEnabled: false,
			runId: "run-1",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: "implement-dead",
			subjectDigest: "a".repeat(40),
			now: "2026-07-20T00:05:00.000Z",
		}),
	).toMatchObject({ ok: true });
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "implement",
			executionId: "implement-dead",
			attempt: 1,
			expiresAt: "2026-07-20T01:00:00.000Z",
			absoluteDeadlineAt: "2026-07-21T00:00:00.000Z",
			now: "2026-07-20T00:06:00.000Z",
			env: WORKFLOW_ON,
			standbyResumeEnabled: standbyLifecycle,
		}),
	).toMatchObject({ ok: true });
	store.applyWorkflowLedgerBatch({
		projectName: "flywheel",
		issueId: "FLY-1335",
		runId: "run-1",
		ops: [
			{
				op: "side_effect",
				node: "implement",
				attempt: 1,
				executionId: "implement-dead",
				to: "started",
			},
		],
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "implement",
		attempt: 1,
		state: "running",
		executionId: "implement-dead",
	});
	store.upsertSession({
		execution_id: "implement-dead",
		issue_id: "FLY-1335",
		project_name: "flywheel",
		status: sessionStatus,
		workflow_node_id: "implement",
	});
	return store;
}

function raw(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}
function quotaTarget(store: StateStore) {
	const quota = store.codexQuota;
	quota.initializeRoot({
		rootKey: "root",
		accountKey: "account",
		profile: "business",
		generation: 1,
	});
	quota.registerBinding({
		bindingId: "binding",
		executionId: "implement-dead",
		runId: "run-1",
		purpose: "runner",
		accountKey: "account",
		profile: "business",
		generation: 1,
		credentialRootKey: "root",
	});
	quota.recordSignal({
		executionId: "implement-dead",
		bindingId: "binding",
		nodeId: "implement",
		attempt: 1,
	});
	return quota;
}
const request = {
	runId: "run-1",
	nodeId: "implement",
	attempt: 1,
	deadExecutionId: "implement-dead",
	newExecutionId: "implement-retry",
	reason: "terminal_session_and_dead_probe",
	livenessEvidence: {
		liveness: "dead" as const,
		observedAt: "2026-07-20T00:10:00.000Z",
	},
	now: "2026-07-20T00:10:00.000Z",
};
const operationId = "dead_rollback:run-1:implement:1:implement-dead";

function installPermit(
	quota: StateStore["codexQuota"],
	incidentId = "codex:root:1",
	expectedGeneration = 1,
) {
	quota.recordInstalling({
		incidentId,
		profile: "school",
		accountKey: "school-account",
		priorAuthDigest: "prior",
		installedAuthDigest: "digest",
		recoveryMaterialPath: "/fixture/auth",
	});
	quota.commitGeneration({
		incidentId,
		expectedGeneration,
		accountKey: "school-account",
		profile: "school",
		authDigest: "digest",
		probeResult: "ok",
	});
}
function terminationRequest(
	quota: StateStore["codexQuota"],
	permitIncidentId = "codex:root:1",
	installedGeneration = 2,
) {
	const waiting = quota.getTargetFence("codex:root:1", "runner", "run-1")!;
	expect(quota.compareAndSwapTarget(waiting, { state: "terminating" })).toBe(
		true,
	);
	return {
		runId: "run-1",
		reason: "quota recovery",
		clientRequestId: "codex-quota:codex:root:1:run-1:terminate",
		principal: "master",
		now: request.now,
		evidence: [],
		collectExecutions: true,
		quotaRecovery: {
			target: quota.getTargetFence("codex:root:1", "runner", "run-1")!,
			nodeId: "implement",
			attempt: 1,
			launchOrdinal: 1,
			permitIncidentId,
			installedGeneration,
		},
	};
}

describe("quota target delegation to same-node recovery", () => {
	it("atomically delegates waiting quota ownership while replacing the dead body in the same run", async () => {
		const store = await engineRunWithImplement();
		const quota = quotaTarget(store);
		expect(store.rollbackDeadWorkflowNodeExecution(request)).toMatchObject({
			ok: true,
			launchOrdinal: 2,
			idempotentReplay: false,
		});
		expect(quota.listTargets("codex:root:1")).toEqual([
			expect.objectContaining({
				state: "abandoned",
				last_error: `delegated_to_node_recovery:${operationId}`,
				new_run_id: "run-1",
				new_execution_id: "implement-retry",
			}),
		]);
		expect(store.getWorkflowRun("run-1")).toMatchObject({
			status: "active",
			current_node_id: "implement",
		});
		expect(store.rollbackDeadWorkflowNodeExecution(request)).toMatchObject({
			ok: true,
			launchOrdinal: 2,
			idempotentReplay: true,
		});
		expect(
			store
				.listWorkflowSideEffects("run-1")
				.filter((row) => row.node_id === "implement"),
		).toHaveLength(2);
	});
	it.each(["terminating", "terminated", "starting", "queued"])(
		"refuses %s ownership before changing the node or ledger",
		async (state) => {
			const store = await engineRunWithImplement();
			const quota = quotaTarget(store);
			raw(store).prepare("UPDATE codex_quota_target SET state=?").run(state);
			expect(() => store.rollbackDeadWorkflowNodeExecution(request)).toThrow(
				"quota_recovery_inflight",
			);
			expect(quota.listTargets("codex:root:1")[0]).toMatchObject({
				state,
				new_execution_id: null,
			});
			expect(
				store
					.listWorkflowSideEffects("run-1")
					.filter((row) => row.node_id === "implement"),
			).toHaveLength(1);
		},
	);
	it("resolves an old nullable attempt from unique binding and ledger evidence", async () => {
		const store = await engineRunWithImplement();
		const quota = quotaTarget(store);
		raw(store).prepare("UPDATE codex_quota_target SET attempt=NULL").run();
		expect(store.rollbackDeadWorkflowNodeExecution(request)).toMatchObject({
			ok: true,
		});
		expect(quota.listTargets("codex:root:1")[0]).toMatchObject({
			state: "abandoned",
			attempt: null,
		});
	});
	it("rolls quota delegation back when the replacement ledger write fails", async () => {
		const store = await engineRunWithImplement();
		const quota = quotaTarget(store);
		raw(store).exec(
			"CREATE TRIGGER deny_replacement BEFORE INSERT ON workflow_side_effect_ledger WHEN NEW.execution_id='implement-retry' BEGIN SELECT RAISE(ABORT,'fixture_ledger_failure'); END",
		);
		expect(() => store.rollbackDeadWorkflowNodeExecution(request)).toThrow(
			"fixture_ledger_failure",
		);
		expect(quota.listTargets("codex:root:1")[0]).toMatchObject({
			state: "waiting",
			new_execution_id: null,
		});
		expect(
			store
				.listWorkflowSideEffects("run-1")
				.filter((row) => row.node_id === "implement"),
		).toHaveLength(1);
	});
	it("compares original tuple, target state and incident generations before persisting worker authority", async () => {
		const store = await engineRunWithImplement();
		const quota = quotaTarget(store);
		const fence = quota.getTargetFence("codex:root:1", "runner", "run-1")!;
		raw(store)
			.prepare(
				"UPDATE codex_quota_incident SET installed_generation=2 WHERE incident_id='codex:root:1'",
			)
			.run();
		expect(quota.compareAndSwapTarget(fence, { state: "terminating" })).toBe(
			false,
		);
		const current = quota.getTargetFence("codex:root:1", "runner", "run-1")!;
		expect(quota.compareAndSwapTarget(current, { state: "terminating" })).toBe(
			true,
		);
		expect(quota.compareAndSwapTarget(current, { state: "abandoned" })).toBe(
			false,
		);
	});
	it("refuses a stale quota terminate request after recovery delegated the old body", async () => {
		const store = await engineRunWithImplement();
		quotaTarget(store);
		expect(store.rollbackDeadWorkflowNodeExecution(request)).toMatchObject({
			ok: true,
		});
		expect(
			store.terminateWorkflowRunByOperator({
				runId: "run-1",
				reason: "quota recovery",
				clientRequestId: "codex-quota:codex:root:1:run-1:terminate",
				principal: "master",
				now: request.now,
				evidence: [],
				collectExecutions: true,
			}),
		).toEqual({ ok: false, reason: "quota_source_advanced" });
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
	});
	it("records the enrolled attempt when producing a new quota target", async () => {
		const store = await engineRunWithImplement("running");
		const quota = store.codexQuota;
		quota.registerBinding({
			bindingId: "binding",
			executionId: "implement-dead",
			runId: "run-1",
			purpose: "runner",
			accountKey: "account",
			profile: "business",
			generation: 1,
			credentialRootKey: "root",
		});
		expect(
			store.recordEnrolledTerminalSignal({
				executionId: "implement-dead",
				sourceEventId: "quota-terminal",
				signal: "failed",
				failureKind: "goal_usage_limited",
				source: "direct-event-sink",
				quotaSignal: {
					version: 1,
					vendor: "codex",
					source: "goal_ended",
					sourceEventId: "quota-terminal",
					bindingId: "binding",
					evidence: "usageLimited",
					observedAt: request.now,
				},
			}),
		).toMatchObject({ ok: true });
		expect(quota.listTargets("codex:root:1")[0]).toMatchObject({
			node_id: "implement",
			attempt: 1,
		});
	});
	it("rolls all target claims back if a second waiting target loses its generation CAS", async () => {
		const store = await engineRunWithImplement();
		const quota = quotaTarget(store);
		raw(store)
			.prepare(
				"INSERT INTO codex_quota_target SELECT incident_id,target_kind,'second',run_id,node_id,attempt,old_execution_id,state,terminate_key,start_key,start_request_json,new_run_id,new_execution_id,last_error FROM codex_quota_target",
			)
			.run();
		raw(store).exec(
			"CREATE TRIGGER race_generation AFTER UPDATE OF state ON codex_quota_target WHEN NEW.target_id='run-1' BEGIN UPDATE codex_quota_incident SET installed_generation=99; END",
		);
		expect(() => store.rollbackDeadWorkflowNodeExecution(request)).toThrow(
			"quota_recovery_target_changed",
		);
		expect(
			quota
				.listTargets("codex:root:1")
				.every((target) => target.state === "waiting"),
		).toBe(true);
		expect(quota.getIncident("codex:root:1")?.installed_generation).toBeNull();
	});
	it("refuses ambiguous historical execution attribution", async () => {
		const store = await engineRunWithImplement();
		const quota = quotaTarget(store);
		raw(store).prepare("UPDATE codex_quota_target SET attempt=NULL").run();
		raw(store)
			.prepare(
				"INSERT INTO workflow_execution_binding(activation_id,execution_id,run_id,node_id,attempt,mode,bound_at) SELECT 'ambiguous',execution_id,run_id,node_id,2,mode,bound_at FROM workflow_execution_binding WHERE execution_id='implement-dead'",
			)
			.run();
		expect(() => store.rollbackDeadWorkflowNodeExecution(request)).toThrow(
			"quota_recovery_provenance_missing",
		);
		expect(quota.listTargets("codex:root:1")[0].state).toBe("waiting");
	});

	it("requires exact terminating ownership and accepts its current installation permit", async () => {
		const store = await engineRunWithImplement();
		const quota = quotaTarget(store);
		quota.recordInstalling({
			incidentId: "codex:root:1",
			profile: "school",
			accountKey: "school-account",
			priorAuthDigest: "prior",
			installedAuthDigest: "digest",
			recoveryMaterialPath: "/fixture/auth",
		});
		quota.commitGeneration({
			incidentId: "codex:root:1",
			expectedGeneration: 1,
			accountKey: "school-account",
			profile: "school",
			authDigest: "digest",
			probeResult: "ok",
		});
		const waiting = quota.getTargetFence("codex:root:1", "runner", "run-1")!;
		expect(quota.compareAndSwapTarget(waiting, { state: "terminating" })).toBe(
			true,
		);
		const target = quota.getTargetFence("codex:root:1", "runner", "run-1")!;
		const terminate = {
			runId: "run-1",
			reason: "quota recovery",
			clientRequestId: "codex-quota:codex:root:1:run-1:terminate",
			principal: "master",
			now: request.now,
			evidence: [],
			collectExecutions: true,
			quotaRecovery: {
				target,
				nodeId: "implement",
				attempt: 1,
				launchOrdinal: 1,
				permitIncidentId: "codex:root:1",
				installedGeneration: 2,
			},
		};
		expect(
			store.terminateWorkflowRunByOperator({
				...terminate,
				quotaRecovery: { ...terminate.quotaRecovery, target: waiting },
			}),
		).toEqual({ ok: false, reason: "quota_source_advanced" });
		expect(store.terminateWorkflowRunByOperator(terminate)).toMatchObject({
			ok: true,
			status: "terminated",
		});
		expect(store.terminateWorkflowRunByOperator(terminate)).toMatchObject({
			ok: true,
			idempotentReplay: true,
		});
	});

	it("allows a late-generation permit without rewriting original incident attribution", async () => {
		const store = await engineRunWithImplement();
		const quota = quotaTarget(store);
		installPermit(quota);
		quota.registerBinding({
			bindingId: "next-binding",
			executionId: "later",
			runId: "later-run",
			purpose: "runner",
			accountKey: "school-account",
			profile: "school",
			generation: 2,
			credentialRootKey: "root",
		});
		quota.recordSignal({
			executionId: "later",
			bindingId: "next-binding",
			nodeId: "implement",
			attempt: 1,
		});
		installPermit(quota, "codex:root:2", 2);
		const terminate = terminationRequest(quota, "codex:root:2", 3);
		expect(terminate.quotaRecovery.target.installedGeneration).toBe(2);
		expect(store.terminateWorkflowRunByOperator(terminate)).toMatchObject({
			ok: true,
		});
	});
	it("rolls the legacy start reservation back when target ownership changes during mint", async () => {
		const store = await engineRunWithImplement();
		const quota = quotaTarget(store);
		installPermit(quota);
		const terminate = terminationRequest(quota);
		expect(store.terminateWorkflowRunByOperator(terminate)).toMatchObject({
			ok: true,
		});
		expect(
			quota.compareAndSwapTarget(terminate.quotaRecovery.target, {
				state: "starting",
			}),
		).toBe(true);
		raw(store).exec(
			"CREATE TRIGGER race_start BEFORE INSERT ON workflow_run WHEN NEW.run_id<>'run-1' BEGIN UPDATE codex_quota_target SET state='abandoned'; END",
		);
		expect(() =>
			store.reserveCodexQuotaRecoveryStart({
				recoveryId: "codex:root:1:runner:run-1",
				startKey: "codex-quota:codex:root:1:run-1:start",
			}),
		).toThrow("quota_recovery_target_changed");
		expect(quota.listTargets("codex:root:1")[0]).toMatchObject({
			state: "starting",
			new_run_id: null,
			new_execution_id: null,
		});
		expect(
			raw(store).prepare("SELECT COUNT(*) AS count FROM workflow_run").get(),
		).toEqual({ count: 1 });
	});
});

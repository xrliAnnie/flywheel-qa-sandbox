import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";

let store: StateStore;
const cleanups: string[] = [];
afterEach(() => {
	for (const path of cleanups.splice(0))
		rmSync(path, { recursive: true, force: true });
});
const workflowEnv = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

function createGeneralizedRun(
	store: StateStore,
	options: { runId?: string; executionId?: string } = {},
) {
	const runId = options.runId ?? "run-fly1427";
	const executionId = options.executionId ?? "exec-fly1427";
	const root = mkdtempSync(join(tmpdir(), "fly1427-terminal-run-"));
	cleanups.push(root);
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Execute safely.\n");
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: `tpl-${runId}`, revision: 1 },
		canonicalRoot: root,
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "execute",
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "low",
					agent_file: "agents/generic.md",
				},
				{ id: "founder_gate", type: "gate" },
			],
			edges: [
				{
					id: "done",
					from: "execute",
					to: "founder_gate",
					condition: "node_done",
				},
			],
			loops: [],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			ship_claims: ["founder_approved"],
		},
	});
	store.createWorkflowRun({
		runId,
		issueId: "FLY-1427",
		projectName: "flywheel",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: false,
	});
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId,
			nodeId: "execute",
			executionId,
			attempt: 1,
			now: "2026-07-22T00:00:00.000Z",
			expiresAt: "2026-07-22T01:00:00.000Z",
			absoluteDeadlineAt: "2026-07-23T00:00:00.000Z",
			env: workflowEnv,
		}),
	).toMatchObject({ ok: true });
	return { runId, executionId };
}

afterEach(() => store?.close());
const binding = (i = 0) => ({
	bindingId: `b${i}`,
	executionId: `e${i}`,
	runId: `r${i}`,
	purpose: "runner" as const,
	accountKey: "account",
	profile: "business",
	generation: 1,
	credentialRootKey: "root",
});
describe("Codex quota durable provenance", () => {
	it("deduplicates six casualties into one incident and one outbox before rollback", async () => {
		store = await StateStore.create(":memory:");
		for (let i = 0; i < 6; i++) {
			store.codexQuota.registerBinding(binding(i));
			store.codexQuota.recordSignal({
				bindingId: `b${i}`,
				executionId: `e${i}`,
			});
		}
		expect(store.codexQuota.listIncidents()).toHaveLength(1);
		expect(store.codexQuota.listTargets("codex:root:1")).toHaveLength(6);
		expect(store.codexQuota.listOutbox()).toHaveLength(1);
		expect(store.codexQuota.isExecutionPaused("e0")).toBe(true);
		expect(
			store.rollbackDeadWorkflowNodeExecution({
				runId: "r0",
				nodeId: "implement",
				attempt: 1,
				deadExecutionId: "e0",
				newExecutionId: "replacement",
				reason: "dead",
				livenessEvidence: {
					liveness: "dead",
					observedAt: new Date().toISOString(),
				},
			}),
		).toEqual({ ok: false, reason: "codex_quota_paused" });
	});
	it("rejects foreign execution binding and reports missing attribution once without pausing or blaming a root", async () => {
		store = await StateStore.create(":memory:");
		store.codexQuota.registerBinding(binding());
		expect(() =>
			store.codexQuota.recordSignal({
				bindingId: "b0",
				executionId: "foreign",
			}),
		).toThrow("quota_binding_mismatch");
		store.codexQuota.recordSignal({ executionId: "unbound" });
		expect(store.codexQuota.isExecutionPaused("unbound")).toBe(false);
		store.codexQuota.recordSignal({ executionId: "unbound" });
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) => row.kind === "lead_diagnostic"),
		).toHaveLength(1);
		expect(
			(store as any).db.raw
				.prepare(
					"SELECT * FROM codex_quota_execution_pause WHERE execution_id=?",
				)
				.all("unbound"),
		).toHaveLength(0);
		expect(store.codexQuota.listIncidents()).toHaveLength(0);
	});
});

it("persists enrolled usage limit atomically and rejects replay substitution", async () => {
	store = await StateStore.create(":memory:");
	const { executionId, runId } = createGeneralizedRun(store);
	store.codexQuota.registerBinding({ ...binding(), executionId, runId });
	const signal = {
		version: 1 as const,
		vendor: "codex" as const,
		source: "goal_ended" as const,
		sourceEventId: "quota-event",
		bindingId: "b0",
		evidence: "usageLimited" as const,
		observedAt: "2026-09-09T00:00:00.000Z",
	};
	const event = {
		executionId,
		sourceEventId: "quota-event",
		signal: "failed" as const,
		failureKind: "goal_usage_limited",
		source: "direct-event-sink",
		quotaSignal: signal,
	};
	expect(store.recordEnrolledTerminalSignal(event)).toMatchObject({ ok: true });
	expect(store.codexQuota.isExecutionPaused(executionId)).toBe(true);
	expect(store.codexQuota.listOutbox()).toHaveLength(1);
	expect(
		store.recordEnrolledTerminalSignal({
			...event,
			quotaSignal: { ...signal, bindingId: "other" },
		}),
	).toMatchObject({ ok: false });
});
it("pauses every bound execution on the same root, preserves foreign roots, and refuses credentials in waiters", async () => {
	store = await StateStore.create(":memory:");
	store.codexQuota.registerBinding(binding());
	store.codexQuota.registerBinding(binding(1));
	store.codexQuota.registerBinding({
		...binding(2),
		credentialRootKey: "foreign",
	});
	store.codexQuota.recordSignal({ executionId: "e0", bindingId: "b0" });
	expect(store.codexQuota.isExecutionPaused("e1")).toBe(true);
	expect(store.codexQuota.isExecutionPaused("e2")).toBe(false);
	expect(() =>
		store.codexQuota.enqueueAdmissionWait({
			startKey: "missing",
			rootKey: "root",
			generation: 1,
			dispatchJson: "{}",
			requestContext: "{}",
		}),
	).toThrow("quota_start_reservation_missing");
});
it("commits a probed generation with compare-and-swap and never unpauses on a failed probe", async () => {
	store = await StateStore.create(":memory:");
	store.codexQuota.initializeRoot({
		rootKey: "root",
		accountKey: "account",
		profile: "business",
		generation: 1,
	});
	store.codexQuota.registerBinding(binding());
	store.codexQuota.recordSignal({ executionId: "e0", bindingId: "b0" });
	expect(() =>
		store.codexQuota.commitGeneration({
			incidentId: "codex:root:1",
			expectedGeneration: 1,
			accountKey: "school-account",
			profile: "school",
			authDigest: "digest",
			probeResult: "failed",
		}),
	).toThrow("quota_probe_not_successful");
	expect(store.codexQuota.isPaused("root")).toBe(true);
	expect(() =>
		store.codexQuota.commitGeneration({
			incidentId: "codex:root:1",
			expectedGeneration: 1,
			accountKey: "school-account",
			profile: "school",
			authDigest: "digest",
			probeResult: "ok",
		}),
	).toThrow("quota_installation_not_recorded");
	store.codexQuota.recordInstalling({
		incidentId: "codex:root:1",
		profile: "school",
		accountKey: "school-account",
		priorAuthDigest: "prior",
		installedAuthDigest: "digest",
		recoveryMaterialPath: "/fixture/retained-auth",
	});
	store.codexQuota.commitGeneration({
		incidentId: "codex:root:1",
		expectedGeneration: 1,
		accountKey: "school-account",
		profile: "school",
		authDigest: "digest",
		probeResult: "ok",
	});
	expect(store.codexQuota.getRoot("root")).toMatchObject({
		generation: 2,
		profile: "school",
	});
	expect(store.codexQuota.isPaused("root")).toBe(false);
	expect(() =>
		store.codexQuota.commitGeneration({
			incidentId: "codex:root:1",
			expectedGeneration: 1,
			accountKey: "other",
			profile: "other",
			authDigest: "digest",
			probeResult: "ok",
		}),
	).toThrow("quota_generation_conflict");
});
it("late prior-generation incident cannot pause a current healthy root", async () => {
	store = await StateStore.create(":memory:");
	store.codexQuota.initializeRoot({
		rootKey: "root",
		profile: "school",
		accountKey: "school-account",
		generation: 2,
	});
	store.codexQuota.registerBinding(binding());
	store.codexQuota.recordSignal({ executionId: "e0", bindingId: "b0" });
	expect(store.codexQuota.isPaused("root")).toBe(false);
	// The old casualty stays fenced; it cannot trigger a blind replacement.
	expect(store.codexQuota.isExecutionPaused("e0")).toBe(true);
});
it("records an unbound legacy quota failure and diagnostic atomically without a fence", async () => {
	store = await StateStore.create(":memory:");
	expect(
		store.recordLegacyCodexQuotaFailure({
			executionId: "legacy",
			sourceEventId: "event",
			issueId: "FLY-2465",
			projectName: "flywheel",
			source: "direct-event-sink",
		}),
	).toMatchObject({ ok: true });
	expect(store.codexQuota.isExecutionPaused("legacy")).toBe(false);
	expect(store.getSession("legacy")?.status).toBe("failed");
	expect(store.codexQuota.listOutbox()).toMatchObject([
		{ kind: "lead_diagnostic" },
	]);
});
it("rolls back terminal and pause when quota outbox persistence fails", async () => {
	store = await StateStore.create(":memory:");
	store.codexQuota.registerBinding({ ...binding(), executionId: "legacy" });
	const raw = (
		store as unknown as { db: { raw: import("better-sqlite3").Database } }
	).db.raw;
	raw.exec(
		"CREATE TRIGGER reject_quota_outbox BEFORE INSERT ON codex_quota_outbox BEGIN SELECT RAISE(ABORT, 'fixture_outbox_unavailable'); END",
	);
	expect(() =>
		store.recordLegacyCodexQuotaFailure({
			executionId: "legacy",
			sourceEventId: "event",
			issueId: "FLY-2465",
			projectName: "flywheel",
			source: "direct-event-sink",
			quotaSignal: {
				version: 1,
				vendor: "codex",
				bindingId: "b0",
				source: "goal_ended",
				sourceEventId: "provider-event",
				evidence: "usageLimited",
				observedAt: "2026-09-09T00:00:00.000Z",
			},
		}),
	).toThrow("fixture_outbox_unavailable");
	expect(store.codexQuota.listIncidents()).toHaveLength(0);
	expect(store.codexQuota.isExecutionPaused("legacy")).toBe(false);
	expect(store.getSession("legacy")).toBeUndefined();
	expect(
		raw.prepare("SELECT 1 FROM session_events WHERE event_id='event'").get(),
	).toBeUndefined();
});
it("rejects late quota at physical launch and delivery-repair fences", async () => {
	store = await StateStore.create(":memory:");
	store.codexQuota.registerBinding(binding());
	store.codexQuota.recordSignal({ executionId: "e0", bindingId: "b0" });
	const now = new Date().toISOString();
	expect(
		store.fencedCommitWorkflowLaunch({
			executionId: "e0",
			ownerId: "owner",
			generation: 1,
			deliveryAttempt: 1,
			markerPath: "/tmp/quota-must-not-write",
			now,
		}),
	).toMatchObject({ ok: false, reason: "codex_quota_paused" });
	expect(
		store.commitWorkflowLaunchDeliveryRepair({
			executionId: "e0",
			repairOwner: "owner",
			generation: 1,
			attempt: 1,
			markerPath: "/tmp/quota-must-not-write",
			now,
		}),
	).toMatchObject({ ok: false, reason: "codex_quota_paused" });
});
it("rechecks quota on admission even for an already admitted activation", async () => {
	store = await StateStore.create(":memory:");
	const { runId, executionId } = createGeneralizedRun(store);
	store.codexQuota.registerBinding({ ...binding(), runId, executionId });
	store.codexQuota.recordSignal({ executionId, bindingId: "b0" });
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId,
			executionId,
			nodeId: "execute",
			attempt: 1,
			now: "2026-07-22T00:00:00.000Z",
			expiresAt: "2026-07-22T01:00:00.000Z",
			absoluteDeadlineAt: "2026-07-23T00:00:00.000Z",
			env: workflowEnv,
		}),
	).toMatchObject({ ok: false, reason: "codex_quota_paused" });
});
it("reserves legacy start identity durably and rejects same-key ownership changes", async () => {
	store = await StateStore.create(":memory:");
	const input = {
		startKey: "legacy-key",
		projectName: "project",
		issueId: "issue",
		executionId: "legacy-exec",
		requestDigest: "digest",
		requestContext: "{}",
	};
	expect(store.codexQuota.reserveLegacyStart(input).execution_id).toBe(
		"legacy-exec",
	);
	expect(
		store.codexQuota.reserveLegacyStart({ ...input, executionId: "new-random" })
			.execution_id,
	).toBe("legacy-exec");
	expect(() =>
		store.codexQuota.reserveLegacyStart({ ...input, issueId: "foreign" }),
	).toThrow("quota_legacy_start_conflict");
	store.codexQuota.enqueueLegacyAdmissionWait({
		startKey: "legacy-key",
		rootKey: "root",
		generation: 1,
	});
	expect(store.codexQuota.getAdmissionWait("legacy-key")).toMatchObject({
		execution_id: "legacy-exec",
		run_id: null,
		state: "waiting",
	});
});
it("review quota pauses the Codex root without pausing its Claude parent execution", async () => {
	store = await StateStore.create(":memory:");
	store.codexQuota.registerBinding({
		...binding(),
		executionId: "claude-parent",
		purpose: "review",
	});
	const id = store.codexQuota.recordSignal({
		executionId: "claude-parent",
		bindingId: "b0",
	});
	expect(store.codexQuota.isPaused("root")).toBe(true);
	expect(store.codexQuota.isExecutionPaused("claude-parent")).toBe(false);
	expect(store.codexQuota.listTargets(id!)).toMatchObject([
		{ target_kind: "review", target_id: "b0" },
	]);
});
it("a quota arriving after a real launch acquisition prevents marker commit", async () => {
	store = await StateStore.create(":memory:");
	const { runId, executionId } = createGeneralizedRun(store);
	const root = mkdtempSync(join(tmpdir(), "quota-fence-"));
	cleanups.push(root);
	const markerPath = join(root, "launch-marker");
	const now = "2026-07-22T00:00:00.000Z";
	const acquired = store.recoverOrAcquireWorkflowLaunch({
		executionId,
		ownerId: "owner",
		now,
		leaseExpiresAt: "2026-07-22T01:00:00.000Z",
		markerPath,
	});
	expect(acquired.status).toBe("acquired");
	if (acquired.status !== "acquired")
		throw new Error("fixture acquisition failed");
	store.codexQuota.registerBinding({ ...binding(), runId, executionId });
	store.codexQuota.recordSignal({ executionId, bindingId: "b0" });
	expect(
		store.fencedCommitWorkflowLaunch({
			executionId,
			ownerId: "owner",
			generation: acquired.generation,
			deliveryAttempt: acquired.deliveryAttempt,
			markerPath,
			now,
		}),
	).toMatchObject({ ok: false, reason: "codex_quota_paused" });
	expect(
		store.getWorkflowLaunchOwner(executionId)?.committed_generation,
	).toBeNull();
	expect(existsSync(markerPath)).toBe(false);
});
it("backfills held historical quota pairs once and never attributes an unbound or operator-held run to the current account", async () => {
	store = await StateStore.create(":memory:");
	const raw = (store as any).db.raw;
	for (const [runId, executionId, error, operator] of [
		[
			"historical-bound",
			"old-bound",
			"goal ended non-complete: usageLimited",
			false,
		],
		[
			"historical-unbound",
			"old-unbound",
			"goal ended non-complete: usageLimited",
			false,
		],
		["other-error", "old-other", "rateLimitExceeded", false],
		[
			"operator-held",
			"old-operator",
			"goal ended non-complete: usageLimited",
			true,
		],
		["other-held", "old-held", "goal ended non-complete: usageLimited", false],
	] as const) {
		createGeneralizedRun(store, { runId, executionId });
		store.upsertSession({
			execution_id: executionId,
			issue_id: "FLY-HISTORY",
			project_name: "fixture",
			status: "failed",
			last_error: error,
		});
		raw
			.prepare("UPDATE workflow_run SET status='held' WHERE run_id=?")
			.run(runId);
		raw
			.prepare(
				"INSERT INTO workflow_run_event(run_id,seq,event_uid,kind,node_id,execution_id,payload) VALUES(?,100,?,'retry_limit_escalated','execute',?,?)",
			)
			.run(runId, `${runId}:retry`, executionId, '{"attempt":1}');
		if (runId === "other-held")
			raw
				.prepare(
					"INSERT INTO workflow_run_event(run_id,seq,event_uid,kind,node_id,execution_id,payload) VALUES(?,101,?,'environment_failure_escalated','execute',?,'{}')",
				)
				.run(runId, `${runId}:other`, executionId);
		if (operator)
			raw
				.prepare(
					"INSERT INTO workflow_run_event(run_id,seq,event_uid,kind,node_id,execution_id,payload) VALUES(?,101,?,'run_held_by_operator','execute',?,'{}')",
				)
				.run(runId, `${runId}:operator`, executionId);
	}
	store.codexQuota.registerBinding({
		...binding(),
		bindingId: "history-binding",
		executionId: "old-bound",
		runId: "historical-bound",
	});
	expect(store.codexQuota.backfillHistoricalQuotaFailures()).toBe(2);
	// Boot replay receipts are independent of execution pause rows.
	raw.prepare("DELETE FROM codex_quota_execution_pause").run();
	expect(store.codexQuota.backfillHistoricalQuotaFailures()).toBe(0);
	expect(store.codexQuota.listIncidents()).toHaveLength(1);
	expect(store.codexQuota.isExecutionPaused("old-bound")).toBe(true);
	expect(store.codexQuota.isExecutionPaused("old-unbound")).toBe(false);
	expect(store.codexQuota.isExecutionPaused("old-other")).toBe(false);
	expect(store.codexQuota.isExecutionPaused("old-operator")).toBe(false);
	expect(store.codexQuota.isExecutionPaused("old-held")).toBe(false);
	expect(
		store.codexQuota
			.listOutbox()
			.filter((row) => row.kind === "lead_diagnostic"),
	).toHaveLength(1);
});

it("ignores historical null-incident pause residue when an operator resumes an unbound execution", async () => {
	store = await StateStore.create(":memory:");
	const { runId, executionId } = createGeneralizedRun(store);
	const raw = (store as any).db.raw;
	raw
		.prepare(
			"INSERT INTO codex_quota_execution_pause VALUES(?,NULL,'identity_uncertain',?)",
		)
		.run(executionId, new Date().toISOString());
	expect(store.codexQuota.isExecutionPaused(executionId)).toBe(false);
	const result = store.rollbackDeadWorkflowNodeExecution({
		runId,
		nodeId: "execute",
		attempt: 1,
		deadExecutionId: executionId,
		newExecutionId: "operator-resumed",
		reason: "operator resumed historical hold",
		livenessEvidence: {
			liveness: "dead",
			observedAt: new Date().toISOString(),
		},
	});
	expect(result).not.toMatchObject({ ok: false, reason: "codex_quota_paused" });
	store.codexQuota.registerBinding({ ...binding(), executionId, runId });
	store.codexQuota.recordSignal({ executionId, bindingId: "b0" });
	expect(store.codexQuota.isExecutionPaused(executionId)).toBe(true);
});

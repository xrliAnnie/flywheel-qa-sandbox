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

function insertHistoricalHeld(store: StateStore, index: number): void {
	const runId = `historical-${index}`;
	const executionId = `historical-exec-${index}`;
	const raw = (store as any).db.raw as import("better-sqlite3").Database;
	raw
		.prepare(
			"INSERT INTO workflow_run(run_id,issue_id,project_name,current_node_id,status) VALUES(?,?,'fixture','execute','held')",
		)
		.run(runId, `FLY-HISTORY-${index}`);
	raw
		.prepare(
			"INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id) VALUES(?,'execute',1,'failed',?)",
		)
		.run(runId, executionId);
	store.upsertSession({
		execution_id: executionId,
		issue_id: `FLY-HISTORY-${index}`,
		project_name: "fixture",
		status: "failed",
		last_error: "goal ended non-complete: usageLimited",
	});
	raw
		.prepare(
			"INSERT INTO workflow_run_event(run_id,seq,event_uid,kind,node_id,execution_id,payload) VALUES(?,100,?,'retry_limit_escalated','execute',?,'{\"attempt\":1}')",
		)
		.run(runId, `${runId}:retry`, executionId);
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
	it("records each manual quota event as N11 without creating an automatic incident", async () => {
		store = await StateStore.create(":memory:");
		store.codexQuota.initializeRoot({
			rootKey: "root",
			accountKey: "account",
			profile: "business",
			generation: 1,
		});
		store.codexQuota.registerBinding(binding());
		const availability = {
			mode: "manual" as const,
			reasons: ["readiness_receipt_missing" as const],
			revision: 1,
			checkedAt: "2026-09-11T18:45:00.000Z",
		};
		for (const sourceEventId of ["event-1", "event-2", "event-3"])
			store.codexQuota.recordSignal({
				executionId: "e0",
				bindingId: "b0",
				source: "runner_terminal",
				sourceEventId,
				availability,
			});
		store.codexQuota.recordSignal({
			executionId: "e0",
			bindingId: "b0",
			source: "runner_terminal",
			sourceEventId: "event-2",
			availability,
		});
		expect(() =>
			store.codexQuota.recordSignal({
				executionId: "e0",
				bindingId: "b0",
				nodeId: "different-node",
				source: "runner_terminal",
				sourceEventId: "event-2",
				availability,
			}),
		).toThrow("quota_signal_event_conflict");

		expect(store.codexQuota.listIncidents()).toHaveLength(0);
		expect(store.codexQuota.isPaused("root")).toBe(false);
		// A known terminal casualty stays fenced even though admission is manual.
		expect(store.codexQuota.isExecutionPaused("e0")).toBe(true);
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) => row.kind === "automation_disabled"),
		).toHaveLength(3);
		const raw = (store as any).db.raw;
		expect(
			raw
				.prepare(
					"SELECT source_event_id,disposition,reason_codes_json FROM codex_quota_signal_event ORDER BY source_event_id",
				)
				.all(),
		).toEqual([
			{
				source_event_id: "event-1",
				disposition: "manual",
				reason_codes_json: '["readiness_receipt_missing"]',
			},
			{
				source_event_id: "event-2",
				disposition: "manual",
				reason_codes_json: '["readiness_receipt_missing"]',
			},
			{
				source_event_id: "event-3",
				disposition: "manual",
				reason_codes_json: '["readiness_receipt_missing"]',
			},
		]);
		expect(
			raw
				.prepare(
					"SELECT reason FROM codex_quota_manual_disposition WHERE incident_id='codex:root:1'",
				)
				.get(),
		).toEqual({ reason: "readiness_receipt_missing" });

		store.codexQuota.reconcileExternalRoot({
			rootKey: "root",
			expectedGeneration: 1,
			accountKey: "replacement",
			profile: "school",
			authDigest: "a".repeat(64),
		});
		expect(store.codexQuota.isExecutionPaused("e0")).toBe(false);
	});

	it("keeps an unbound manual event visible but diagnostic-only", async () => {
		store = await StateStore.create(":memory:");
		store.codexQuota.recordSignal({
			executionId: "unbound",
			source: "runner_terminal",
			sourceEventId: "event-unbound",
			availability: {
				mode: "manual",
				reasons: ["runtime_unavailable"],
				revision: 1,
				checkedAt: "2026-09-11T18:45:00.000Z",
			},
		});
		expect(store.codexQuota.isExecutionPaused("unbound")).toBe(false);
		expect(store.codexQuota.listIncidents()).toHaveLength(0);
		expect(store.codexQuota.listOutbox()).toMatchObject([
			{ kind: "automation_disabled", incident_id: null },
		]);
	});

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
it("pauses admission for the affected root without turning healthy siblings into casualties", async () => {
	store = await StateStore.create(":memory:");
	store.codexQuota.registerBinding(binding());
	store.codexQuota.registerBinding(binding(1));
	store.codexQuota.registerBinding({
		...binding(2),
		credentialRootKey: "foreign",
	});
	store.codexQuota.recordSignal({ executionId: "e0", bindingId: "b0" });
	expect(store.codexQuota.isExecutionPaused("e1")).toBe(false);
	expect(store.isCodexQuotaLaunchPaused("e1", "root")).toBe(true);
	expect(store.codexQuota.isExecutionPaused("e2")).toBe(false);
	expect(store.isCodexQuotaLaunchPaused("e2", "foreign")).toBe(false);
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
it("uses only the latest unresolved capacity fact as the current guard", async () => {
	store = await StateStore.create(":memory:");
	const now = Date.parse("2026-09-17T20:00:00.000Z");
	store.codexQuota.initializeRoot({
		rootKey: "root",
		accountKey: "business-key",
		profile: "business",
		generation: 1,
	});
	store.codexQuota.registerBinding(binding());
	store.codexQuota.recordSignal({ executionId: "e0", bindingId: "b0" });
	const observations = (observedAt: number, resetsAt: number) =>
		["business", "school", "personal"].map((profile) => ({
			profile,
			accountKey: `${profile}-key`,
			observedAt,
			identityVerified: true,
			authHealth: "valid" as const,
			scopeKnown: true,
			windows: [{ usedPercent: 100, resetsAt }],
		}));
	store.codexQuota.recordPoolExhausted({
		incidentId: "codex:root:1",
		observations: observations(now - 1_000, now + 60_000),
		observedAt: now - 1_000,
		nextAttemptAt: now + 60_000,
	});
	store.codexQuota.recordPoolExhausted({
		incidentId: "codex:root:1",
		observations: observations(now - 500, now - 1),
		observedAt: now - 500,
		nextAttemptAt: now + 60_000,
	});

	expect(store.codexQuota.hasCurrentCapacityGuard("codex:root:1", now)).toBe(
		false,
	);
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
it("migrates held historical quota pairs once into one manual summary without guessing an account", async () => {
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
	store.codexQuota.initializeRoot({
		rootKey: "root",
		accountKey: "account",
		profile: "business",
		generation: 1,
	});
	store.codexQuota.registerBinding({
		...binding(),
		bindingId: "history-binding",
		executionId: "old-bound",
		runId: "historical-bound",
	});
	expect(store.codexQuota.backfillHistoricalQuotaFailures()).toBe(2);
	expect(store.codexQuota.backfillHistoricalQuotaFailures()).toBe(0);
	expect(store.codexQuota.listIncidents()).toHaveLength(0);
	// Historical provenance is visible, but only live runner_terminal signals
	// create the dead-execution casualty fence.
	expect(store.codexQuota.isExecutionPaused("old-bound")).toBe(false);
	expect(store.codexQuota.isExecutionPaused("old-unbound")).toBe(false);
	expect(store.codexQuota.isExecutionPaused("old-other")).toBe(false);
	expect(store.codexQuota.isExecutionPaused("old-operator")).toBe(false);
	expect(store.codexQuota.isExecutionPaused("old-held")).toBe(false);
	const summaries = store.codexQuota
		.listOutbox()
		.filter((row) => row.kind === "automation_disabled");
	expect(summaries).toHaveLength(1);
	expect(JSON.parse(String(summaries[0]?.payload_json))).toMatchObject({
		scope: "legacy_batch",
		totalCount: 2,
		manualCount: 2,
		guardedCount: 0,
		skippedCount: 0,
	});
});

it("releases the 9-11 overwritten readiness incident to manual and supersedes its stale pause alert", async () => {
	store = await StateStore.create(":memory:");
	store.codexQuota.initializeRoot({
		rootKey: "root",
		accountKey: "business-key",
		profile: "business",
		generation: 1,
	});
	store.codexQuota.registerBinding(binding());
	store.codexQuota.recordSignal({
		executionId: "e0",
		bindingId: "b0",
		source: "runner_terminal",
		sourceEventId: "september-11-quota",
		availability: {
			mode: "automatic",
			reasons: [],
			revision: 1,
			checkedAt: "2026-09-11T18:37:00.000Z",
		},
	});
	store.codexQuota.setIncidentState(
		"codex:root:1",
		"retry_wait",
		"readiness_failed",
		"2026-09-11T18:45:00.000Z",
	);
	store.codexQuota.enqueueOutbox({
		incidentId: "codex:root:1",
		kind: "founder_alert",
		destination: "founder",
		payload: { reason: "quota_pause_expired" },
	});

	expect(store.codexQuota.backfillHistoricalQuotaFailures()).toBe(1);
	expect(store.codexQuota.isIncidentManual("codex:root:1")).toBe(true);
	expect(store.codexQuota.isPaused("root")).toBe(false);
	expect(
		store.codexQuota.listOutbox().find((row) => row.kind === "founder_alert"),
	).toMatchObject({ delivery_state: "superseded" });
	expect(store.codexQuota.listTargets("codex:root:1")).toMatchObject([
		{
			state: "waiting",
			terminate_key: null,
			start_key: null,
			new_execution_id: null,
		},
	]);
	expect(
		store.codexQuota
			.listOutbox()
			.filter((row) => row.kind === "automation_disabled"),
	).toHaveLength(1);
});

it("seals 1001 frozen legacy members only after the second bounded pass and emits one summary", async () => {
	store = await StateStore.create(":memory:");
	for (let index = 0; index < 1001; index++) insertHistoricalHeld(store, index);
	const raw = (store as any).db.raw as import("better-sqlite3").Database;

	expect(store.codexQuota.backfillHistoricalQuotaFailures()).toBe(1000);
	expect(
		raw.prepare("SELECT state FROM codex_quota_legacy_batch").get(),
	).toEqual({ state: "collecting" });
	expect(store.codexQuota.listOutbox()).toHaveLength(0);
	for (const sourceEventId of ["live-during-batch-1", "live-during-batch-2"])
		store.codexQuota.recordSignal({
			executionId: `live-${sourceEventId}`,
			source: "runner_terminal",
			sourceEventId,
			availability: {
				mode: "manual",
				reasons: ["readiness_receipt_missing"],
				revision: 2,
				checkedAt: "2026-09-17T20:00:00.000Z",
			},
		});
	expect(store.codexQuota.backfillHistoricalQuotaFailures()).toBe(1);
	expect(store.codexQuota.backfillHistoricalQuotaFailures()).toBe(0);
	expect(
		raw
			.prepare("SELECT COUNT(*) AS count FROM codex_quota_legacy_member")
			.get(),
	).toEqual({ count: 1001 });
	expect(
		raw
			.prepare(`
				SELECT COUNT(*) AS count
				FROM codex_quota_signal_event signal
				JOIN codex_quota_legacy_member member
					ON member.event_key = signal.event_key
			`)
			.get(),
	).toEqual({ count: 1001 });
	expect(
		raw.prepare("SELECT COUNT(*) AS count FROM codex_quota_signal_event").get(),
	).toEqual({ count: 1003 });
	const notices = store.codexQuota
		.listOutbox()
		.filter((row) => row.kind === "automation_disabled");
	expect(notices).toHaveLength(3);
	expect(
		notices.filter(
			(row) => JSON.parse(String(row.payload_json)).scope === "legacy_batch",
		),
	).toHaveLength(1);
});

it("seals with a visible skipped member after three migration failures", async () => {
	store = await StateStore.create(":memory:");
	insertHistoricalHeld(store, 0);
	const raw = (store as any).db.raw as import("better-sqlite3").Database;
	raw.exec(`
		CREATE TRIGGER reject_legacy_signal BEFORE INSERT ON codex_quota_signal_event
		WHEN NEW.source='legacy_backfill'
		BEGIN SELECT RAISE(ABORT, 'fixture legacy member failure'); END
	`);

	expect(store.codexQuota.backfillHistoricalQuotaFailures()).toBe(1);
	expect(store.codexQuota.backfillHistoricalQuotaFailures()).toBe(1);
	expect(store.codexQuota.listOutbox()).toHaveLength(0);
	expect(store.codexQuota.backfillHistoricalQuotaFailures()).toBe(1);
	expect(
		raw
			.prepare(
				"SELECT result,reason,attempt_count FROM codex_quota_legacy_member",
			)
			.get(),
	).toEqual({
		result: "skipped",
		reason: "legacy_member_skipped_after_3_failures",
		attempt_count: 3,
	});
	expect(
		raw
			.prepare(
				"SELECT state,failed_count,skipped_count FROM codex_quota_legacy_batch",
			)
			.get(),
	).toEqual({ state: "sealed", failed_count: 1, skipped_count: 1 });
	expect(store.codexQuota.listOutbox()).toHaveLength(1);
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

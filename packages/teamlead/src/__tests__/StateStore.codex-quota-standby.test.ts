import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import {
	createCodexStandbyRun as createRun,
	quotaWall,
} from "./helpers/codex-quota-standby-fixture.js";

const cleanups: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const path of cleanups.splice(0))
		rmSync(path, { recursive: true, force: true });
});

async function open(path = ":memory:"): Promise<StateStore> {
	const store = await StateStore.create(path);
	stores.push(store);
	return store;
}

function raw(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

function createCodexStandbyRun(
	store: StateStore,
	options: Parameters<typeof createRun>[1] = {},
) {
	return createRun(store, { ...options, cleanups });
}

function columns(store: StateStore, table: string): string[] {
	return (
		raw(store).prepare(`PRAGMA table_info(${table})`).all() as {
			name: string;
		}[]
	).map((column) => column.name);
}

describe("FLY-2900 C1 — quota causal sequence and standby schema", () => {
	it("creates the standby carrier, permit, demand, audit and sequence tables", async () => {
		const store = await open();
		for (const table of [
			"codex_quota_sequence",
			"codex_quota_standby",
			"codex_quota_capacity_permit",
			"codex_quota_dispatch_demand",
			"codex_quota_resume_output_proof",
			"codex_quota_resume_audit",
		])
			expect(columns(store, table).length).toBeGreaterThan(0);
		expect(columns(store, "codex_quota_signal_event")).toContain("signal_seq");
		expect(columns(store, "codex_quota_external_generation")).toContain(
			"reason",
		);
		expect(columns(store, "codex_quota_standby")).toEqual(
			expect.arrayContaining([
				"execution_id",
				"entry_seq",
				"trigger_signal_seq",
				"state",
				"resume_phase",
				"continue_attempt_id",
				"permit_id",
				"resume_attempt",
				"mechanical_failures",
				"capacity_rejections",
				"owner_claim_id",
				"lease_expires_at",
				"fallback_attempt",
				"checkpoint_commit",
			]),
		);
	});

	it("rejects out-of-contract standby states and demand vendors", async () => {
		const store = await open();
		const db = raw(store);
		expect(() =>
			db
				.prepare(
					"INSERT INTO codex_quota_standby(execution_id,run_id,node_id,attempt,entry_seq,trigger_signal_seq,source_event_id,state,entered_at,updated_at) VALUES('e','r','n',1,1,1,'s','parked','t','t')",
				)
				.run(),
		).toThrow(/CHECK/);
		expect(() =>
			db
				.prepare(
					"INSERT INTO codex_quota_dispatch_demand(new_execution_id,source_execution_id,entry_seq,fallback_attempt,vendor,model,effort,reason,same_vendor_evidence_json,state,created_at) VALUES('n','e',1,1,'gemini','m','x','codex_quota_fallback','{}','prepared','t')",
				)
				.run(),
		).toThrow(/CHECK/);
	});

	it("allocates strictly increasing causal numbers inside one millisecond", async () => {
		const store = await open();
		const quota = store.codexQuota;
		const seen = Array.from({ length: 50 }, () => quota.allocateCausalSeq());
		for (let i = 1; i < seen.length; i += 1)
			expect(seen[i]).toBe(seen[i - 1]! + 1);
		expect(seen[0]).toBeGreaterThan(0);
	});

	it("continues the causal counter after a restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2900-seq-"));
		cleanups.push(dir);
		const path = join(dir, "teamlead.db");
		const first = await StateStore.create(path);
		const before = [
			first.codexQuota.allocateCausalSeq(),
			first.codexQuota.allocateCausalSeq(),
		];
		first.close();
		const second = await open(path);
		expect(second.codexQuota.allocateCausalSeq()).toBe(before[1]! + 1);
	});

	it("gives every recorded signal a causal number from the shared counter", async () => {
		const store = await open();
		const quota = store.codexQuota;
		const a = quota.allocateCausalSeq();
		quota.recordSignal({
			executionId: "exec-a",
			source: "runner_terminal",
			sourceEventId: "evt-a",
			now: "2026-09-25T00:00:00.000Z",
		});
		quota.recordSignal({
			executionId: "exec-b",
			source: "runner_terminal",
			sourceEventId: "evt-b",
			now: "2026-09-25T00:00:00.000Z",
		});
		const seqA = quota.signalSeqFor("runner_terminal", "exec-a", "evt-a");
		const seqB = quota.signalSeqFor("runner_terminal", "exec-b", "evt-b");
		expect(seqA).toBe(a + 1);
		expect(seqB).toBe(a + 2);
		// A replay of the same source event neither re-allocates nor rewrites.
		quota.recordSignal({
			executionId: "exec-a",
			source: "runner_terminal",
			sourceEventId: "evt-a",
			now: "2026-09-25T00:00:01.000Z",
		});
		expect(quota.signalSeqFor("runner_terminal", "exec-a", "evt-a")).toBe(seqA);
		expect(quota.allocateCausalSeq()).toBe(a + 3);
		expect(quota.signalSeqFor("runner_terminal", "nope", "evt-x")).toBeNull();
	});

	it("treats a legacy signal row without a causal number as zero", async () => {
		const store = await open();
		const quota = store.codexQuota;
		quota.recordSignal({
			executionId: "exec-old",
			source: "runner_terminal",
			sourceEventId: "evt-old",
			now: "2026-09-25T00:00:00.000Z",
		});
		raw(store)
			.prepare("UPDATE codex_quota_signal_event SET signal_seq=NULL")
			.run();
		expect(quota.signalSeqFor("runner_terminal", "exec-old", "evt-old")).toBe(
			0,
		);
	});

	it("answers the single standby predicate from the carrier state", async () => {
		const store = await open();
		const db = raw(store);
		const insert = (executionId: string, state: string) =>
			db
				.prepare(
					"INSERT INTO codex_quota_standby(execution_id,run_id,node_id,attempt,entry_seq,trigger_signal_seq,source_event_id,state,resume_phase,entered_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
				)
				.run(
					executionId,
					"run",
					"implement",
					1,
					1,
					1,
					`src-${executionId}`,
					state,
					state === "resuming" ? "launching" : null,
					"2026-09-25T00:00:00.000Z",
					"2026-09-25T00:00:00.000Z",
				);
		for (const state of [
			"standby",
			"resuming",
			"fallback_prepared",
			"released",
			"closed",
		])
			insert(`exec-${state}`, state);
		expect(store.codexQuota.isCodexQuotaStandby("exec-standby")).toBe(true);
		expect(store.codexQuota.isCodexQuotaStandby("exec-resuming")).toBe(true);
		expect(store.codexQuota.isCodexQuotaStandby("exec-fallback_prepared")).toBe(
			true,
		);
		expect(store.codexQuota.isCodexQuotaStandby("exec-released")).toBe(false);
		expect(store.codexQuota.isCodexQuotaStandby("exec-closed")).toBe(false);
		expect(store.codexQuota.isCodexQuotaStandby("exec-absent")).toBe(false);
		expect(store.isCodexQuotaStandby("exec-standby")).toBe(true);
	});

	it("still records a manual canonical switch after the reason column is added", async () => {
		const store = await open();
		const quota = store.codexQuota;
		quota.initializeRoot({
			rootKey: "root",
			accountKey: "acct-business",
			profile: "business",
			generation: 1,
		});
		quota.reconcileExternalRoot({
			rootKey: "root",
			expectedGeneration: 1,
			accountKey: "acct-school",
			profile: "school",
			authDigest: "a".repeat(64),
		});
		expect(quota.getRoot("root")).toMatchObject({
			profile: "school",
			generation: 2,
		});
		expect(
			raw(store)
				.prepare(
					"SELECT reason FROM codex_quota_external_generation WHERE root_key='root' AND generation=2",
				)
				.get(),
		).toEqual({ reason: null });
	});
});

function teardownFacts(store: StateStore, executionId: string): number {
	return (
		raw(store)
			.prepare(
				"SELECT COUNT(*) AS n FROM workflow_run_event WHERE execution_id=? AND kind='generalized_teardown_recorded'",
			)
			.get(executionId) as { n: number }
	).n;
}

function standbyRow(store: StateStore, executionId: string) {
	return raw(store)
		.prepare("SELECT * FROM codex_quota_standby WHERE execution_id=?")
		.get(executionId) as Record<string, unknown> | undefined;
}

function audits(store: StateStore, executionId: string) {
	return raw(store)
		.prepare(
			"SELECT action,detail_code FROM codex_quota_resume_audit WHERE execution_id=? ORDER BY at,rowid",
		)
		.all(executionId) as { action: string; detail_code: string | null }[];
}

function dump(store: StateStore): string {
	const db = raw(store);
	return JSON.stringify({
		sessions: db
			.prepare(
				"SELECT execution_id,status,last_error FROM sessions ORDER BY execution_id",
			)
			.all(),
		events: db
			.prepare(
				"SELECT event_id,event_type,payload,source FROM session_events ORDER BY event_id",
			)
			.all(),
		runEvents: db
			.prepare(
				"SELECT event_uid,kind,execution_id,payload FROM workflow_run_event ORDER BY event_uid",
			)
			.all(),
		signals: db
			.prepare(
				"SELECT source,source_event_id,execution_id,disposition FROM codex_quota_signal_event ORDER BY event_key",
			)
			.all(),
		standby: db.prepare("SELECT * FROM codex_quota_standby").all(),
		audit: db.prepare("SELECT * FROM codex_quota_resume_audit").all(),
	});
}

describe("FLY-2900 C2 — a usage-limit wall enters quota standby", () => {
	it("keeps the old failure path byte-for-byte while the standby flag is off", async () => {
		const store = await open();
		const { executionId } = createCodexStandbyRun(store);
		const result = store.recordEnrolledTerminalSignal(quotaWall(executionId));
		expect(result).toMatchObject({ ok: true, status: "failed" });
		expect(result).not.toHaveProperty("quotaStandby", true);
		expect(store.getSession(executionId)?.status).toBe("failed");
		expect(teardownFacts(store, executionId)).toBe(1);
		expect(standbyRow(store, executionId)).toBeUndefined();
	});

	it("parks the execution: running kept, no teardown, one carrier row and one audit", async () => {
		const store = await open();
		store.codexQuotaStandbyEnabled = () => true;
		const { executionId, runId } = createCodexStandbyRun(store);
		const result = store.recordEnrolledTerminalSignal({
			...quotaWall(executionId),
			leadIntent: { leadId: "flywheel-eng-lead" } as never,
		});
		expect(result).toMatchObject({
			ok: true,
			quotaStandby: true,
			idempotentReplay: false,
			effectiveStatus: "running",
			statusChanged: false,
		});
		expect(result).not.toHaveProperty("leadEventSeq");
		const session = store.getSession(executionId);
		expect(session?.status).toBe("running");
		expect(session?.last_error).toBe("codex_quota_standby");
		expect(teardownFacts(store, executionId)).toBe(0);
		const row = standbyRow(store, executionId)!;
		expect(row).toMatchObject({
			run_id: runId,
			node_id: "implement",
			attempt: 1,
			entry_seq: 1,
			state: "standby",
			source_event_id: "wall-1",
			mechanical_failures: 0,
			resume_attempt: 0,
		});
		expect(row.trigger_signal_seq).toBe(
			store.codexQuota.signalSeqFor("runner_terminal", executionId, "wall-1"),
		);
		expect(row.activation_id).toBeTruthy();
		expect(audits(store, executionId)).toEqual([
			{ action: "standby_entered", detail_code: null },
		]);
		const db = raw(store);
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM workflow_run_event WHERE execution_id=? AND kind='codex_quota_standby_entered'",
				)
				.get(executionId),
		).toEqual({ n: 1 });
		const event = db
			.prepare("SELECT payload FROM session_events WHERE event_id='wall-1'")
			.get() as { payload: string };
		expect(JSON.parse(event.payload)).toMatchObject({
			failureKind: "goal_usage_limited",
			quotaStandby: true,
		});
		expect(store.isCodexQuotaStandby(executionId)).toBe(true);
	});

	it("records the binding's root and generation when the wall was bound", async () => {
		const store = await open();
		store.codexQuotaStandbyEnabled = () => true;
		const { executionId, runId } = createCodexStandbyRun(store);
		store.codexQuota.registerBinding({
			bindingId: "bind-1",
			executionId,
			runId,
			purpose: "runner",
			accountKey: "acct-business",
			profile: "business",
			generation: 3,
			credentialRootKey: "root-1",
		});
		expect(
			store.recordEnrolledTerminalSignal({
				...quotaWall(executionId),
				quotaSignal: {
					version: 1,
					vendor: "codex",
					source: "goal_ended",
					sourceEventId: "wall-1",
					bindingId: "bind-1",
					evidence: "usageLimited",
					observedAt: "2026-09-25T00:10:00.000Z",
				},
			}),
		).toMatchObject({ ok: true, quotaStandby: true });
		expect(standbyRow(store, executionId)).toMatchObject({
			root_key: "root-1",
			generation: 3,
			binding_id: "bind-1",
		});
	});

	it("replays the same wall with zero writes and refuses a substituted payload", async () => {
		const store = await open();
		store.codexQuotaStandbyEnabled = () => true;
		const { executionId } = createCodexStandbyRun(store);
		store.recordEnrolledTerminalSignal(quotaWall(executionId));
		const before = dump(store);
		const replay = store.recordEnrolledTerminalSignal(quotaWall(executionId));
		expect(replay).toMatchObject({
			ok: true,
			idempotentReplay: true,
			quotaStandby: true,
		});
		expect(dump(store)).toBe(before);
		expect(
			store.recordEnrolledTerminalSignal(
				quotaWall(executionId, "wall-1", { lastError: "different" }),
			),
		).toEqual({ ok: false, reason: "terminal_signal_conflict" });
		expect(dump(store)).toBe(before);
	});

	const counterexamples: [
		string,
		(store: StateStore, ids: { runId: string; executionId: string }) => void,
		{ vendor?: "claude"; engineOwned?: boolean },
	][] = [
		[
			"the flag is off",
			(store) => {
				store.codexQuotaStandbyEnabled = () => false;
			},
			{},
		],
		["the run is not engine-owned", () => undefined, { engineOwned: false }],
		[
			"the run is held",
			(store, ids) =>
				raw(store)
					.prepare("UPDATE workflow_run SET status='held' WHERE run_id=?")
					.run(ids.runId),
			{},
		],
		[
			"the node no longer runs on this execution",
			(store, ids) =>
				raw(store)
					.prepare(
						"UPDATE workflow_run_node SET state='done' WHERE run_id=? AND execution_id=?",
					)
					.run(ids.runId, ids.executionId),
			{},
		],
		["the runtime vendor is claude", () => undefined, { vendor: "claude" }],
		[
			"an operator close intent is prepared",
			(store, ids) =>
				raw(store)
					.prepare(
						"INSERT INTO workflow_operator_close_intent(execution_id,mode,reason,stage,created_at,updated_at) VALUES(?,'abandon','x','prepared','t','t')",
					)
					.run(ids.executionId),
			{},
		],
		[
			"a completion receipt exists",
			(store, ids) =>
				raw(store)
					.prepare(
						"INSERT INTO workflow_node_completion(activation_id,run_id,node_id,attempt,execution_id,route,event_uid,source_event_id,completion_submission_digest,completed_at) VALUES(NULL,?,'implement',1,?,'done','uid-c','src-c','d','t')",
					)
					.run(ids.runId, ids.executionId),
			{},
		],
		[
			"the entry budget for the attempt is used up",
			(store, ids) => {
				for (let i = 0; i < 6; i += 1)
					raw(store)
						.prepare(
							"INSERT INTO codex_quota_resume_audit(event_uid,at,execution_id,run_id,node_id,attempt,action) VALUES(?,?,?,?,'implement',1,'standby_entered')",
						)
						.run(
							`seed-${i}`,
							"2026-09-25T00:05:00.000Z",
							`older-${i}`,
							ids.runId,
						);
			},
			{},
		],
	];
	for (const [name, mutate, options] of counterexamples) {
		it(`takes the old failure path when ${name}`, async () => {
			const store = await open();
			store.codexQuotaStandbyEnabled = () => true;
			const ids = createCodexStandbyRun(store, {
				...(options.vendor ? { vendor: options.vendor } : {}),
				...(options.engineOwned === false ? { engineOwned: false } : {}),
			});
			mutate(store, ids);
			const baseline = await open();
			baseline.codexQuotaStandbyEnabled = () => false;
			const baseIds = createCodexStandbyRun(baseline, {
				...(options.vendor ? { vendor: options.vendor } : {}),
				...(options.engineOwned === false ? { engineOwned: false } : {}),
			});
			mutate(baseline, baseIds);
			baseline.codexQuotaStandbyEnabled = () => false;
			const result = store.recordEnrolledTerminalSignal(
				quotaWall(ids.executionId),
			);
			const expected = baseline.recordEnrolledTerminalSignal(
				quotaWall(baseIds.executionId),
			);
			expect(result).toEqual(expected);
			expect(standbyRow(store, ids.executionId)).toBeUndefined();
			const strip = (text: string) =>
				text.replace(/"(seq|signal_seq)":\d+/g, "");
			expect(strip(dump(store)).replace(/lead_diagnostic[^"]*/g, "")).toBe(
				strip(dump(baseline)),
			);
		});
	}

	it("sends a review-exec wall down the old path", async () => {
		const store = await open();
		store.codexQuotaStandbyEnabled = () => true;
		const { executionId, runId } = createCodexStandbyRun(store);
		store.codexQuota.registerBinding({
			bindingId: "bind-review",
			executionId,
			runId,
			purpose: "review",
			accountKey: "acct",
			profile: "business",
			generation: 1,
			credentialRootKey: "root-1",
		});
		const result = store.recordEnrolledTerminalSignal({
			...quotaWall(executionId),
			quotaSignal: {
				version: 1,
				vendor: "codex",
				source: "review_exec",
				sourceEventId: "wall-1",
				bindingId: "bind-review",
				evidence: "usageLimited",
				observedAt: "2026-09-25T00:10:00.000Z",
			},
		});
		expect(result).toMatchObject({ ok: true, status: "failed" });
		expect(standbyRow(store, executionId)).toBeUndefined();
		expect(store.getSession(executionId)?.status).toBe("failed");
	});

	it("tells the Lead once when the entry budget sends a wall down the old path", async () => {
		const store = await open();
		store.codexQuotaStandbyEnabled = () => true;
		const ids = createCodexStandbyRun(store);
		for (let i = 0; i < 6; i += 1)
			raw(store)
				.prepare(
					"INSERT INTO codex_quota_resume_audit(event_uid,at,execution_id,run_id,node_id,attempt,action) VALUES(?,?,?,?,'implement',1,'standby_entered')",
				)
				.run(`seed-${i}`, "2026-09-25T00:05:00.000Z", `older-${i}`, ids.runId);
		store.recordEnrolledTerminalSignal(quotaWall(ids.executionId));
		const diagnostics = store.codexQuota
			.listOutbox()
			.filter(
				(row) =>
					row.kind === "lead_diagnostic" &&
					String(row.payload_json).includes("standby_entry_limit"),
			);
		expect(diagnostics).toHaveLength(1);
	});

	it("re-enters with a fresh entry after a closed resume and resets the per-entry budgets", async () => {
		const store = await open();
		store.codexQuotaStandbyEnabled = () => true;
		const { executionId } = createCodexStandbyRun(store);
		store.recordEnrolledTerminalSignal(quotaWall(executionId));
		raw(store)
			.prepare(
				"UPDATE codex_quota_standby SET state='closed',mechanical_failures=1,capacity_rejections=2,resume_attempt=2,fallback_attempt=1 WHERE execution_id=?",
			)
			.run(executionId);
		const result = store.recordEnrolledTerminalSignal(
			quotaWall(executionId, "wall-2", { now: "2026-09-25T02:00:00.000Z" }),
		);
		expect(result).toMatchObject({ ok: true, quotaStandby: true });
		expect(standbyRow(store, executionId)).toMatchObject({
			state: "standby",
			entry_seq: 2,
			source_event_id: "wall-2",
			mechanical_failures: 0,
			capacity_rejections: 0,
			resume_attempt: 0,
			fallback_attempt: 0,
		});
		expect(
			audits(store, executionId).filter((a) => a.action === "standby_entered"),
		).toHaveLength(2);
	});

	it("settles a wall hit while resuming as a capacity rejection, not a mechanical failure", async () => {
		const store = await open();
		store.codexQuotaStandbyEnabled = () => true;
		const { executionId } = createCodexStandbyRun(store);
		store.recordEnrolledTerminalSignal(quotaWall(executionId));
		raw(store)
			.prepare(
				"UPDATE codex_quota_standby SET state='resuming',resume_phase='continuing',owner_claim_id='claim-1',lease_expires_at='2026-09-25T01:00:00.000Z',permit_id='p1',resume_attempt=1,continue_attempt_id='cont-1' WHERE execution_id=?",
			)
			.run(executionId);
		const result = store.recordEnrolledTerminalSignal(
			quotaWall(executionId, "wall-2", { now: "2026-09-25T00:30:00.000Z" }),
		);
		expect(result).toMatchObject({ ok: true, quotaStandby: true });
		const row = standbyRow(store, executionId)!;
		expect(row).toMatchObject({
			state: "standby",
			resume_phase: null,
			entry_seq: 1,
			owner_claim_id: null,
			capacity_rejections: 1,
			mechanical_failures: 0,
			continue_attempt_id: null,
		});
		expect(row.trigger_signal_seq).toBe(
			store.codexQuota.signalSeqFor("runner_terminal", executionId, "wall-2"),
		);
		expect(audits(store, executionId).map((a) => a.action)).toEqual([
			"standby_entered",
			"capacity_rejected",
		]);
		expect(store.getSession(executionId)?.status).toBe("running");
		expect(teardownFacts(store, executionId)).toBe(0);
	});
});

describe("FLY-2900 C3 — operator actions release a parked execution", () => {
	async function parked(state: "standby" | "resuming" = "standby") {
		const store = await open();
		store.codexQuotaStandbyEnabled = () => true;
		const ids = createCodexStandbyRun(store);
		store.recordEnrolledTerminalSignal(quotaWall(ids.executionId));
		if (state === "resuming")
			raw(store)
				.prepare(
					"UPDATE codex_quota_standby SET state='resuming',resume_phase='launching',owner_claim_id='claim-1',lease_expires_at='2026-09-25T02:00:00.000Z',resume_attempt=1 WHERE execution_id=?",
				)
				.run(ids.executionId);
		raw(store)
			.prepare(
				"INSERT INTO codex_quota_target(incident_id,target_kind,target_id,run_id,node_id,attempt,old_execution_id,state) VALUES('codex:root:1','runner',?,?,'implement',1,?,'waiting')",
			)
			.run(ids.runId, ids.runId, ids.executionId);
		return { store, ...ids };
	}

	for (const state of ["standby", "resuming"] as const) {
		it(`releases a ${state} carrier in the same transaction that prepares a close intent`, async () => {
			const { store, executionId } = await parked(state);
			expect(
				store.prepareWorkflowOperatorCloseIntent({
					executionId,
					mode: "abandon",
					reason: "founder cancelled",
					now: "2026-09-25T00:20:00.000Z",
				}),
			).toMatchObject({ ok: true });
			const row = standbyRow(store, executionId)!;
			expect(row).toMatchObject({
				state: "released",
				resume_phase: null,
				release_reason: "operator_close_intent",
			});
			// The owner claim survives so the resumer (or the next loop) reaps its process.
			if (state === "resuming") expect(row.owner_claim_id).toBe("claim-1");
			expect(store.isCodexQuotaStandby(executionId)).toBe(false);
			expect(
				store.codexQuota.listTargets("codex:root:1").map((t) => t.state),
			).toEqual(["abandoned"]);
			expect(audits(store, executionId).map((a) => a.action)).toEqual([
				"standby_entered",
				"released",
			]);
			// Finalizing again writes nothing more.
			expect(
				store.codexQuota.finalizeReleasedStandby("2026-09-25T00:22:00.000Z"),
			).toBe(0);
			expect(audits(store, executionId)).toHaveLength(2);
		});

		it(`releases a ${state} carrier when the operator holds the run`, async () => {
			const { store, executionId, runId } = await parked(state);
			const held = store.holdWorkflowRunByOperator({
				runId,
				reason: "lead hold",
				clientRequestId: "hold-1",
				principal: "master",
				evidence: [],
				now: "2026-09-25T00:20:00.000Z",
			});
			expect(held).toMatchObject({ ok: true });
			expect(standbyRow(store, executionId)).toMatchObject({
				state: "released",
				release_reason: "operator_held",
			});
			expect(
				store.codexQuota.listTargets("codex:root:1").map((t) => t.state),
			).toEqual(["abandoned"]);
			expect(audits(store, executionId).at(-1)).toEqual({
				action: "released",
				detail_code: "operator_held",
			});
		});

		it(`releases a ${state} carrier when any writer terminates the run`, async () => {
			const { store, executionId, runId } = await parked(state);
			raw(store)
				.prepare("UPDATE workflow_run SET status='terminated' WHERE run_id=?")
				.run(runId);
			expect(standbyRow(store, executionId)).toMatchObject({
				state: "released",
				release_reason: "run_terminated",
				resume_phase: null,
			});
			// A bare status writer has no hook; the resume loop finalizes it.
			expect(
				store.codexQuota.finalizeReleasedStandby("2026-09-25T00:21:00.000Z"),
			).toBe(1);
			expect(
				store.codexQuota.listTargets("codex:root:1").map((t) => t.state),
			).toEqual(["abandoned"]);
		});
	}

	it("does not release on an engine hold; the carrier waits for the run to resume", async () => {
		const { store, executionId, runId } = await parked();
		raw(store)
			.prepare("UPDATE workflow_run SET status='held' WHERE run_id=?")
			.run(runId);
		expect(standbyRow(store, executionId)?.state).toBe("standby");
	});

	it("is idempotent and leaves closed carriers alone", async () => {
		const { store, executionId } = await parked();
		const first = store.releaseCodexQuotaStandby({
			executionId,
			reason: "operator_terminated",
			now: "2026-09-25T00:20:00.000Z",
		});
		expect(first).toBe(1);
		expect(
			store.releaseCodexQuotaStandby({
				executionId,
				reason: "operator_terminated",
				now: "2026-09-25T00:21:00.000Z",
			}),
		).toBe(0);
		expect(
			audits(store, executionId).filter((a) => a.action === "released"),
		).toHaveLength(1);
		raw(store)
			.prepare(
				"UPDATE codex_quota_standby SET state='closed' WHERE execution_id=?",
			)
			.run(executionId);
		expect(
			store.releaseCodexQuotaStandby({
				executionId,
				reason: "operator_terminated",
				now: "2026-09-25T00:22:00.000Z",
			}),
		).toBe(0);
		expect(standbyRow(store, executionId)?.state).toBe("closed");
	});
});

describe("FLY-2900 C5 — claim, explicit authorization and the resume handshake", () => {
	const ROOT = "root-canonical";
	const ACCOUNT = "a".repeat(64);
	// Launch gates validate the lease against the real clock.
	const NOW_MS = Date.now();
	const NOW = new Date(NOW_MS).toISOString();

	async function claimable(options: { bound?: boolean } = {}) {
		const store = await open();
		store.codexQuotaStandbyEnabled = () => true;
		const ids = createCodexStandbyRun(store);
		store.codexQuota.initializeRoot({
			rootKey: ROOT,
			accountKey: ACCOUNT,
			profile: "business",
			generation: 1,
		});
		if (options.bound) {
			store.codexQuota.registerBinding({
				bindingId: "bind-0",
				executionId: ids.executionId,
				runId: ids.runId,
				purpose: "runner",
				accountKey: ACCOUNT,
				profile: "business",
				generation: 1,
				credentialRootKey: ROOT,
			});
			store.recordEnrolledTerminalSignal({
				...quotaWall(ids.executionId),
				quotaSignal: {
					version: 1,
					vendor: "codex",
					source: "goal_ended",
					sourceEventId: "wall-1",
					bindingId: "bind-0",
					evidence: "usageLimited",
					observedAt: "2026-09-25T00:10:00.000Z",
				},
			});
		} else store.recordEnrolledTerminalSignal(quotaWall(ids.executionId));
		const permit = issuePermit(store);
		expect(permit).toMatchObject({ outcome: "issued" });
		return { store, ...ids };
	}

	function issuePermit(store: StateStore) {
		const root = store.codexQuota.getRoot(ROOT)!;
		return store.codexQuota.issueReadingConfirmedPermit({
			rootKey: ROOT,
			expectedGeneration: root.generation,
			authDigest: "d".repeat(64),
			reading: {
				name: "business",
				identityKey: ACCOUNT,
				observedAt: new Date(NOW_MS - 30_000).toISOString(),
				fiveH: { usedPercent: 1, resetAt: null },
				weekly: { usedPercent: 2, resetAt: null },
				requestSeq: store.codexQuota.allocateCausalSeq(),
			},
			activeAccount: "business",
			nowMs: NOW_MS,
		});
	}

	function claim(
		store: StateStore,
		executionId: string,
		claimId = "bridge:1:boot:c1",
	) {
		return store.claimCodexQuotaResume({
			executionId,
			ownerClaimId: claimId,
			now: NOW,
		});
	}

	it("claims a permit, mints a new-generation binding and returns an explicit authorization", async () => {
		const { store, executionId, runId } = await claimable();
		const claimed = claim(store, executionId);
		expect(claimed).toMatchObject({
			ok: true,
			authorization: {
				executionId,
				claimId: "bridge:1:boot:c1",
				entrySeq: 1,
				resumeAttempt: 1,
			},
			continueAttemptFresh: true,
		});
		if (!claimed.ok) throw new Error("unreachable");
		const row = standbyRow(store, executionId)!;
		expect(row).toMatchObject({
			state: "resuming",
			resume_phase: "launching",
			owner_claim_id: "bridge:1:boot:c1",
			continue_attempt_id: claimed.continueAttemptId,
			resume_attempt: 1,
			permit_id: claimed.permit.permit_id,
			root_key: ROOT,
		});
		const binding = store.codexQuota.getBinding(String(row.binding_id))!;
		expect(binding).toMatchObject({
			executionId,
			runId,
			purpose: "runner",
			credentialRootKey: ROOT,
			generation: store.codexQuota.getRoot(ROOT)!.generation,
		});
		expect(audits(store, executionId).map((a) => a.action)).toEqual([
			"standby_entered",
			"resume_started",
		]);
		expect(claim(store, executionId, "bridge:1:boot:c2")).toEqual({
			ok: false,
			reason: "not_standby",
		});
	});

	it("refuses a claim without a permit, on a lost node, on a held run and after two mechanical failures", async () => {
		const store = await open();
		store.codexQuotaStandbyEnabled = () => true;
		const ids = createCodexStandbyRun(store);
		store.recordEnrolledTerminalSignal(quotaWall(ids.executionId));
		expect(claim(store, ids.executionId)).toEqual({
			ok: false,
			reason: "no_permit",
		});
		const lost = await claimable();
		raw(lost.store)
			.prepare(
				"UPDATE workflow_run_node SET state='superseded' WHERE execution_id=?",
			)
			.run(lost.executionId);
		expect(claim(lost.store, lost.executionId)).toEqual({
			ok: false,
			reason: "node_not_live",
		});
		const held = await claimable();
		raw(held.store)
			.prepare("UPDATE workflow_run SET status='held' WHERE run_id=?")
			.run(held.runId);
		expect(claim(held.store, held.executionId)).toEqual({
			ok: false,
			reason: "run_not_active",
		});
		const spent = await claimable();
		raw(spent.store)
			.prepare(
				"UPDATE codex_quota_standby SET mechanical_failures=2 WHERE execution_id=?",
			)
			.run(spent.executionId);
		expect(claim(spent.store, spent.executionId)).toEqual({
			ok: false,
			reason: "mechanical_budget_exhausted",
		});
	});

	it("a prepared close intent stops the claim at once", async () => {
		const { store, executionId } = await claimable();
		store.prepareWorkflowOperatorCloseIntent({
			executionId,
			mode: "abandon",
			reason: "operator",
			now: NOW,
		});
		expect(claim(store, executionId)).toEqual({
			ok: false,
			reason: "not_standby",
		});
	});

	it("authorizes past a casualty target, a root safety guard and a root pause; everything else stays paused", async () => {
		const { store, executionId, runId } = await claimable({ bound: true });
		// Every historical fence at once.
		raw(store)
			.prepare(
				"INSERT OR REPLACE INTO codex_quota_target(incident_id,target_kind,target_id,run_id,node_id,attempt,old_execution_id,state,start_key) VALUES('codex:root-canonical:2','runner','x',?,'implement',1,?,'starting','k')",
			)
			.run(runId, executionId);
		raw(store)
			.prepare(
				"INSERT OR IGNORE INTO codex_quota_incident(incident_id,root_key,generation,state,first_seen_at) VALUES('codex:root-canonical:2',?,2,'retry_wait','t')",
			)
			.run(ROOT);
		const claimed = claim(store, executionId);
		if (!claimed.ok) throw new Error(claimed.reason);
		const auth = claimed.authorization;
		expect(store.codexQuota.isExecutionPaused(executionId)).toBe(true);
		expect(store.codexQuota.hasRootSafetyGuard(ROOT)).toBe(true);
		expect(store.codexQuotaLaunchDecision(executionId, ROOT)).toBe("paused");
		expect(store.codexQuotaLaunchDecision(executionId, ROOT, auth)).toBe(
			"authorized",
		);
		expect(store.isCodexQuotaLaunchPaused(executionId, ROOT, auth)).toBe(false);
		for (const bad of [
			{ ...auth, claimId: "bridge:9:boot:other" },
			{ ...auth, entrySeq: 2 },
			{ ...auth, resumeAttempt: 2 },
			{ ...auth, executionId: "someone-else" },
		])
			expect(store.codexQuotaLaunchDecision(executionId, ROOT, bad)).toBe(
				"paused",
			);
		raw(store)
			.prepare(
				"UPDATE codex_quota_standby SET lease_expires_at=? WHERE execution_id=?",
			)
			.run(new Date(NOW_MS - 1000).toISOString(), executionId);
		expect(store.codexQuotaLaunchDecision(executionId, ROOT, auth)).toBe(
			"paused",
		);
	});

	it("voids the authorization once a relevant wall lands after the permit", async () => {
		const { store, executionId } = await claimable();
		const claimed = claim(store, executionId);
		if (!claimed.ok) throw new Error(claimed.reason);
		expect(
			store.codexQuotaLaunchDecision(executionId, ROOT, claimed.authorization),
		).toBe("authorized");
		store.codexQuota.recordSignal({
			executionId: "other-exec",
			source: "runner_terminal",
			sourceEventId: "late-wall",
			now: NOW,
		});
		expect(
			store.codexQuotaLaunchDecision(executionId, ROOT, claimed.authorization),
		).toBe("paused");
	});

	it("lets attempt 2 through every gate after attempt 1 really failed", async () => {
		const { store, executionId } = await claimable();
		const first = claim(store, executionId, "bridge:1:boot:a1");
		if (!first.ok) throw new Error(first.reason);
		expect(
			store.failCodexQuotaResume({
				authorization: first.authorization,
				kind: "mechanical",
				detailCode: "thread_resume_failed",
				continueDetermined: false,
				now: NOW,
			}),
		).toMatchObject({ ok: true, mechanicalFailures: 1 });
		const second = claim(store, executionId, "bridge:1:boot:a2");
		expect(second).toMatchObject({
			ok: true,
			authorization: { resumeAttempt: 2 },
			continueAttemptFresh: false,
		});
		if (!second.ok) throw new Error(second.reason);
		expect(second.continueAttemptId).toBe(
			first.ok ? first.continueAttemptId : "",
		);
		expect(
			store.codexQuotaLaunchDecision(executionId, ROOT, second.authorization),
		).toBe("authorized");
		// The first attempt's authorization is dead.
		expect(
			store.codexQuotaLaunchDecision(executionId, ROOT, first.authorization),
		).toBe("paused");
	});

	it("walks the three-step handshake and settles success only on the first model output", async () => {
		const { store, executionId, runId } = await claimable();
		for (const incident of ["codex:root-canonical:1", "codex:root-canonical:0"])
			raw(store)
				.prepare(
					"INSERT INTO codex_quota_target(incident_id,target_kind,target_id,run_id,node_id,attempt,old_execution_id,state) VALUES(?,'runner',?,?,'implement',1,?,'waiting')",
				)
				.run(incident, runId, runId, executionId);
		const claimed = claim(store, executionId);
		if (!claimed.ok) throw new Error(claimed.reason);
		const auth = claimed.authorization;
		expect(store.codexQuotaResumeVerificationStatus(auth)).toBe("pending");
		expect(store.markCodexQuotaResumeIdentityVerified(auth, NOW)).toBe(true);
		expect(store.codexQuotaResumeVerificationStatus(auth)).toBe("accepted");
		expect(
			store.settleCodexQuotaResumeSuccess({
				authorization: auth,
				turnId: "turn-1",
				now: NOW,
			}),
		).toBe(false);
		expect(store.markCodexQuotaContinueStarted(auth, "turn-1", NOW)).toBe(true);
		expect(standbyRow(store, executionId)).toMatchObject({
			resume_phase: "continuing",
			continue_turn_id: "turn-1",
		});
		expect(
			store.settleCodexQuotaResumeSuccess({
				authorization: auth,
				turnId: "turn-other",
				now: NOW,
			}),
		).toBe(false);
		expect(
			store.settleCodexQuotaResumeSuccess({
				authorization: auth,
				turnId: "turn-1",
				now: NOW,
			}),
		).toBe(true);
		expect(standbyRow(store, executionId)).toMatchObject({
			state: "closed",
			resume_phase: null,
			owner_claim_id: null,
			continue_attempt_id: null,
		});
		expect(
			raw(store)
				.prepare(
					"SELECT state FROM codex_quota_target WHERE old_execution_id=? ORDER BY incident_id",
				)
				.all(executionId),
		).toEqual([{ state: "recovered" }, { state: "recovered" }]);
		expect(audits(store, executionId).map((a) => a.action)).toEqual([
			"standby_entered",
			"resume_started",
			"identity_verified",
			"continue_started",
			"resumed",
		]);
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) => row.kind === "resume_notice"),
		).toHaveLength(1);
		expect(store.codexQuotaResumeVerificationStatus(auth)).toBe("rejected");
		expect(store.getSession(executionId)?.last_error ?? null).toBeNull();
	});

	it("reconciles a carried continue: proven closes, absent resends, failures count once", async () => {
		const proven = await claimable();
		const p = claim(proven.store, proven.executionId);
		if (!p.ok) throw new Error(p.reason);
		proven.store.markCodexQuotaResumeIdentityVerified(p.authorization, NOW);
		const provenResult = proven.store.reconcileCodexQuotaContinue({
			authorization: p.authorization,
			outcome: { kind: "proven" },
			now: NOW,
		});
		expect(provenResult).toMatchObject({ action: "send", settled: true });
		if (provenResult.action !== "send") throw new Error("unreachable");
		expect(provenResult.continueAttemptId).not.toBe(p.continueAttemptId);
		expect(standbyRow(proven.store, proven.executionId)?.state).toBe("closed");

		const absent = await claimable();
		const a = claim(absent.store, absent.executionId);
		if (!a.ok) throw new Error(a.reason);
		expect(
			absent.store.reconcileCodexQuotaContinue({
				authorization: a.authorization,
				outcome: { kind: "absent" },
				now: NOW,
			}),
		).toEqual({
			action: "send",
			continueAttemptId: a.continueAttemptId,
			settled: false,
		});

		const failed = await claimable();
		const f = claim(failed.store, failed.executionId);
		if (!f.ok) throw new Error(f.reason);
		expect(
			failed.store.reconcileCodexQuotaContinue({
				authorization: f.authorization,
				outcome: { kind: "failed_before_output", usageLimited: false },
				now: NOW,
			}),
		).toEqual({
			action: "abort",
			reason: "continue_turn_failed_before_output",
		});
		expect(standbyRow(failed.store, failed.executionId)).toMatchObject({
			state: "standby",
			mechanical_failures: 1,
			continue_attempt_id: null,
		});

		const walled = await claimable();
		const w = claim(walled.store, walled.executionId);
		if (!w.ok) throw new Error(w.reason);
		expect(
			walled.store.reconcileCodexQuotaContinue({
				authorization: w.authorization,
				outcome: { kind: "failed_before_output", usageLimited: true },
				now: NOW,
			}),
		).toEqual({ action: "abort", reason: "capacity_rejected" });
		expect(standbyRow(walled.store, walled.executionId)).toMatchObject({
			state: "standby",
			mechanical_failures: 0,
			capacity_rejections: 1,
			continue_attempt_id: null,
		});
	});

	it("never blind-sends when reconciliation is unavailable and tells the Lead after three rounds", async () => {
		const { store, executionId } = await claimable();
		let continueId: string | undefined;
		for (let round = 1; round <= 3; round += 1) {
			const claimed = claim(store, executionId, `bridge:1:boot:r${round}`);
			if (!claimed.ok) throw new Error(claimed.reason);
			continueId ??= claimed.continueAttemptId;
			expect(claimed.continueAttemptId).toBe(continueId);
			expect(
				store.reconcileCodexQuotaContinue({
					authorization: claimed.authorization,
					outcome: { kind: "unavailable" },
					now: NOW,
				}),
			).toEqual({ action: "abort", reason: "continue_reconcile_unavailable" });
		}
		expect(standbyRow(store, executionId)).toMatchObject({
			state: "standby",
			mechanical_failures: 0,
			reconcile_failures: 3,
			continue_attempt_id: continueId,
		});
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) =>
					String(row.payload_json).includes("continue_reconcile_unavailable"),
				),
		).toHaveLength(1);
	});

	it("returns a claim left by a previous Bridge process to standby without counting it", async () => {
		const { store, executionId } = await claimable();
		const claimed = claim(store, executionId, "bridge:1:oldboot:c1");
		if (!claimed.ok) throw new Error(claimed.reason);
		store.markCodexQuotaResumeIdentityVerified(claimed.authorization, NOW);
		expect(
			store.recoverAbandonedCodexQuotaClaims("bridge:2:newboot", NOW),
		).toEqual([executionId]);
		expect(standbyRow(store, executionId)).toMatchObject({
			state: "standby",
			resume_phase: null,
			owner_claim_id: null,
			mechanical_failures: 0,
			continue_attempt_id: claimed.continueAttemptId,
		});
		expect(
			store.recoverAbandonedCodexQuotaClaims("bridge:2:newboot", NOW),
		).toEqual([]);
	});

	it("renews the lease only for the live claim", async () => {
		const { store, executionId } = await claimable();
		const claimed = claim(store, executionId);
		if (!claimed.ok) throw new Error(claimed.reason);
		const later = new Date(NOW_MS + 5 * 60_000).toISOString();
		expect(store.renewCodexQuotaResumeLease(claimed.authorization, later)).toBe(
			true,
		);
		expect(String(standbyRow(store, executionId)?.lease_expires_at)).toBe(
			new Date(NOW_MS + 15 * 60_000).toISOString(),
		);
		expect(
			store.renewCodexQuotaResumeLease(
				{ ...claimed.authorization, claimId: "other" },
				later,
			),
		).toBe(false);
	});

	it("counts a non-quota terminal failure of the resumed body as a resume failure, never a teardown", async () => {
		const { store, executionId } = await claimable();
		const claimed = claim(store, executionId);
		if (!claimed.ok) throw new Error(claimed.reason);
		const result = store.recordEnrolledTerminalSignal(
			quotaWall(executionId, "resumed-crash", {
				failureKind: "goal_failed",
				lastError: "daemon exited",
			}),
		);
		expect(result).toMatchObject({ ok: true, quotaStandby: true });
		expect(standbyRow(store, executionId)).toMatchObject({
			state: "standby",
			mechanical_failures: 1,
			owner_claim_id: null,
		});
		expect(store.getSession(executionId)?.status).toBe("running");
		expect(teardownFacts(store, executionId)).toBe(0);
		expect(
			store.codexQuotaLaunchDecision(executionId, ROOT, claimed.authorization),
		).toBe("paused");
	});

	it("closes the carrier on completion without announcing an unproven resume", async () => {
		const { store, executionId } = await claimable();
		const claimed = claim(store, executionId);
		if (!claimed.ok) throw new Error(claimed.reason);
		const result = store.recordEnrolledTerminalSignal({
			executionId,
			sourceEventId: "resumed-done",
			signal: "completed",
			source: "direct-event-sink",
			now: NOW,
		});
		expect(result).toMatchObject({ ok: true, status: "completed" });
		expect(result).not.toHaveProperty("quotaStandby");
		// Completion is not first-output evidence: the carrier closes, but no
		// `resumed` audit, no thread notice and no claim survives.
		expect(standbyRow(store, executionId)).toMatchObject({
			state: "closed",
			owner_claim_id: null,
			resume_phase: null,
			last_error_code: "completed_while_resuming",
		});
		expect(audits(store, executionId).map((a) => a.action)).not.toContain(
			"resumed",
		);
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) => row.kind === "resume_notice"),
		).toHaveLength(0);
		expect(
			store.codexQuotaResumeVerificationStatus(claimed.authorization),
		).toBe("rejected");
		expect(store.getSession(executionId)?.status).toBe("completed");
	});
});

describe("FLY-2900 C3 — StateStore consumers leave a parked body alone", () => {
	async function parkedStore(park = true) {
		const store = await open();
		store.codexQuotaStandbyEnabled = () => park;
		const ids = createCodexStandbyRun(store);
		store.recordEnrolledTerminalSignal(quotaWall(ids.executionId));
		if (park) expect(store.isCodexQuotaStandby(ids.executionId)).toBe(true);
		return { store, ...ids };
	}

	it("dead-execution rollback refuses a parked body with zero writes", async () => {
		const { store, executionId, runId } = await parkedStore();
		const before = dump(store);
		expect(
			store.rollbackDeadWorkflowNodeExecution({
				runId,
				nodeId: "implement",
				attempt: 1,
				deadExecutionId: executionId,
				newExecutionId: "replacement-exec",
				reason: "dead",
				livenessEvidence: {
					liveness: "dead",
					observedAt: "2026-09-25T00:20:00.000Z",
				},
				now: "2026-09-25T00:20:00.000Z",
			}),
		).toEqual({ ok: false, reason: "codex_quota_standby" });
		expect(dump(store)).toBe(before);
	});

	it("turn-wake retries wait for a parked body instead of pushing or cancelling", async () => {
		const { store, executionId } = await parkedStore();
		expect(
			store.inspectWorkflowTurnWakeRetry({
				wakeId: "wake-1",
				executionId,
				epoch: 1,
			}),
		).toEqual({ disposition: "wait", reason: "codex_quota_standby" });
		const control = await parkedStore(false);
		expect(
			control.store.inspectWorkflowTurnWakeRetry({
				wakeId: "wake-1",
				executionId: control.executionId,
				epoch: 1,
			}).reason,
		).not.toBe("codex_quota_standby");
	});

	for (const park of [true, false]) {
		it(`resident expiry ${park ? "skips a parked body" : "still expires a normal body"}`, async () => {
			const { store, executionId, runId } = await parkedStore(park);
			const activation = raw(store)
				.prepare(
					"SELECT activation_id FROM workflow_execution_binding WHERE execution_id=?",
				)
				.get(executionId) as { activation_id: string };
			raw(store)
				.prepare(
					"INSERT INTO workflow_resident_hold(execution_id,run_id,node_id,attempt,activation_id,vendor,revision,boundary_seq,state,grace_started_at,grace_expires_at,updated_at) VALUES(?,?,'implement',1,?,'codex',1,1,'resident','2026-09-25T00:00:00.000Z','2026-09-25T00:05:00.000Z','2026-09-25T00:00:00.000Z')",
				)
				.run(executionId, runId, activation.activation_id);
			const expired = store.expireResidentHoldsTx("2026-09-25T01:00:00.000Z");
			expect(expired.length).toBe(park ? 0 : 1);
		});
	}
});

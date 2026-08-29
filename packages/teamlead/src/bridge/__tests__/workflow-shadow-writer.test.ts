import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	createWorkflowShadowWriterFromEnv,
	type WorkflowShadowEvidenceProbes,
	WorkflowShadowWriter,
} from "../workflow-shadow-writer.js";

/**
 * FLY-1232 module ② — WorkflowShadowWriter: the transition-table adapter
 * between the production pipeline hooks and `applyWorkflowShadowBatch`.
 *
 * Posture under test (plan §0 red lines):
 *   - observation only, never throws into production flow (B5);
 *   - default-off: the env factory is the single switch point (B1);
 *   - evidence truth table (research §F.3) drives every side-effect
 *     advancement — persistent facts only, never live probes (B7);
 *   - honest gaps: absence of evidence never fabricates history.
 */

const PROJECT = "flywheel";
const ISSUE = "FLY-1232";

async function makeWriter(
	opts: {
		probes?: WorkflowShadowEvidenceProbes;
		warn?: (m: string) => void;
	} = {},
) {
	const store = await StateStore.create(":memory:");
	let n = 0;
	const writer = new WorkflowShadowWriter({
		store,
		probes: opts.probes,
		newRunId: () => `run-${++n}`,
		logger: { warn: opts.warn ?? (() => {}) },
	});
	return { store, writer };
}

function uids(store: StateStore, runId: string): string[] {
	return store.listWorkflowRunEvents(runId).map((e) => e.event_uid);
}

describe("createWorkflowShadowWriterFromEnv — the single default-off switch (B1)", () => {
	it("flag absent/0 → undefined (no writer, no seam, byte-compat); flag=1 → a writer", async () => {
		const store = await StateStore.create(":memory:");
		expect(createWorkflowShadowWriterFromEnv({}, store)).toBeUndefined();
		expect(
			createWorkflowShadowWriterFromEnv(
				{ FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "0" },
				store,
			),
		).toBeUndefined();
		expect(
			createWorkflowShadowWriterFromEnv(
				{ FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1" },
				store,
			),
		).toBeInstanceOf(WorkflowShadowWriter);
	});
});

describe("failure posture — shadow errors are loud warnings, never production throws (B5)", () => {
	it("a store that throws inside the batch surfaces as a warn with identifiers, not a throw", async () => {
		const warns: string[] = [];
		const store = await StateStore.create(":memory:");
		const writer = new WorkflowShadowWriter({
			store,
			logger: { warn: (m) => warns.push(m) },
		});
		vi.spyOn(store, "applyWorkflowShadowBatch").mockImplementation(() => {
			throw new Error("disk exploded");
		});
		expect(() =>
			writer.onSpawnDispatch({
				projectName: PROJECT,
				issueId: ISSUE,
				executionId: "exec-1",
				context: { node: "design", attempt: 1 },
			}),
		).not.toThrow();
		expect(warns.some((w) => w.includes("disk exploded"))).toBe(true);
		expect(warns.some((w) => w.includes(ISSUE))).toBe(true);
	});

	it("currentAttempt never throws — a failing store yields NaN, which the next write refuses fail-closed", async () => {
		const warns: string[] = [];
		const store = await StateStore.create(":memory:");
		const writer = new WorkflowShadowWriter({
			store,
			logger: { warn: (m) => warns.push(m) },
		});
		vi.spyOn(store, "getActiveWorkflowRunForIssue").mockImplementation(() => {
			throw new Error("run lookup failed");
		});
		const attempt = writer.currentAttempt(ISSUE);
		expect(Number.isNaN(attempt)).toBe(true);
		// feeding the NaN into a hook stays non-throwing (validation refuses inside)
		expect(() =>
			writer.onWake({
				projectName: PROJECT,
				issueId: ISSUE,
				executionId: "exec-1",
				node: "implement",
				attempt,
			}),
		).not.toThrow();
	});
});

describe("transition-table hooks — uid sequences (B2)", () => {
	it("T1 fresh dispatch: node_dispatched + intent_recorded ledger row", async () => {
		const { store, writer } = await makeWriter();
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-d1",
			context: { node: "design", attempt: 1 },
		});
		expect(uids(store, "run-1")).toEqual(["run:run-1:dispatch:design:1:1"]);
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(1);
	});

	it("T2 handoff spawn: edge_traversed + node_dispatched + intent in ONE call", async () => {
		const { store, writer } = await makeWriter();
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-i1",
			context: {
				node: "implement",
				attempt: 1,
				edge: { from: "design", to: "implement" },
			},
		});
		expect(uids(store, "run-1")).toEqual([
			"run:run-1:edge:design:implement:1",
			"run:run-1:dispatch:implement:1:1",
		]);
	});

	it("T7 replacement start: same (node, attempt), NEW execution → new ordinal row; edge dedupes", async () => {
		const { store, writer } = await makeWriter();
		const ctx = {
			node: "qa",
			attempt: 1,
			edge: { from: "implement", to: "qa" },
		};
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-qa1",
			context: ctx,
		});
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-qa2",
			context: ctx,
		});
		expect(uids(store, "run-1")).toEqual([
			"run:run-1:edge:implement:qa:1",
			"run:run-1:dispatch:qa:1:1",
			"run:run-1:dispatch:qa:1:2",
		]);
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(2);
	});

	it("T3 keep-alive fix wake: node_dispatched(wake) only — no edge, no ledger row", async () => {
		const { store, writer } = await makeWriter();
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-i1",
			context: { node: "implement", attempt: 1 },
		});
		writer.onWake({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-i1",
			node: "implement",
			attempt: 2,
		});
		expect(uids(store, "run-1")).toEqual([
			"run:run-1:dispatch:implement:1:1",
			"run:run-1:wake:implement:2",
		]);
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(1);
	});

	it("T3b retest wake handoff: edge_traversed + wake in ONE call (R3#3)", async () => {
		const { store, writer } = await makeWriter();
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-qa1",
			context: { node: "qa", attempt: 1 },
		});
		writer.onWake({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-qa1",
			node: "qa",
			attempt: 2,
			edge: { from: "implement", to: "qa" },
		});
		expect(uids(store, "run-1")).toContain("run:run-1:edge:implement:qa:2");
		expect(uids(store, "run-1")).toContain("run:run-1:wake:qa:2");
	});

	it("T4 node complete + T5 QA pass (complete + qa→end edge) + T6 kickback + T9 finalize", async () => {
		const { store, writer } = await makeWriter();
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-d1",
			context: { node: "design", attempt: 1 },
		});
		writer.onNodeComplete({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-d1",
			node: "design",
			attempt: 1,
		});
		writer.onKickback({ projectName: PROJECT, issueId: ISSUE, round: 1 });
		writer.onQaPass({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-qa1",
			attempt: 2,
		});
		writer.onShipFinalized({ projectName: PROJECT, issueId: ISSUE });

		const u = uids(store, "run-1");
		expect(u).toContain("run:run-1:complete:design:1:exec-d1");
		expect(u).toContain("run:run-1:kickback:1");
		expect(u).toContain("run:run-1:complete:qa:2:exec-qa1");
		expect(u).toContain("run:run-1:edge:qa:end:2");
		expect(store.getWorkflowRun("run-1")?.status).toBe("completed");
	});

	it("replay idempotency: every hook run twice leaves the event list unchanged (B4)", async () => {
		const { store, writer } = await makeWriter();
		const fire = () => {
			writer.onSpawnDispatch({
				projectName: PROJECT,
				issueId: ISSUE,
				executionId: "exec-d1",
				context: { node: "design", attempt: 1 },
			});
			writer.onWake({
				projectName: PROJECT,
				issueId: ISSUE,
				executionId: "exec-d1",
				node: "design",
				attempt: 1,
			});
			writer.onNodeComplete({
				projectName: PROJECT,
				issueId: ISSUE,
				executionId: "exec-d1",
				node: "design",
				attempt: 1,
			});
			writer.onKickback({ projectName: PROJECT, issueId: ISSUE, round: 1 });
			writer.onQaPass({
				projectName: PROJECT,
				issueId: ISSUE,
				executionId: "exec-qa1",
				attempt: 2,
			});
		};
		fire();
		const first = uids(store, "run-1");
		fire();
		expect(uids(store, "run-1")).toEqual(first);
	});
});

describe("currentAttempt — 1 + the ACTIVE shadow run's OWN loop_iteration count (Codex R1 #2)", () => {
	it("derives from the run's shadow kickbacks — covering BOTH belt paths — and never leaks across runs", async () => {
		const { store, writer } = await makeWriter();
		expect(writer.currentAttempt(ISSUE)).toBe(1); // no run yet

		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-1",
			context: { node: "implement", attempt: 1 },
		});
		expect(writer.currentAttempt(ISSUE)).toBe(1);
		// the T6 hook fires on BOTH the keep-alive and the legacy close-respawn
		// belt paths, so the run's own loop events are the complete round source.
		writer.onKickback({ projectName: PROJECT, issueId: ISSUE, round: 1 });
		expect(writer.currentAttempt(ISSUE)).toBe(2);

		// a SECOND workflow on the same issue must start back at attempt 1 —
		// run-1's rounds are run-1 history, never inherited (B3/B10).
		writer.onShipFinalized({ projectName: PROJECT, issueId: ISSUE });
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-2",
			context: { node: "design", attempt: 1 },
		});
		const secondRun = store.getActiveWorkflowRun(PROJECT, ISSUE);
		expect(secondRun?.run_id).not.toBe("run-1");
		expect(writer.currentAttempt(ISSUE)).toBe(1);
	});
});

describe("Codex R1 fixes — evidence tri-state, run-scoped backfill, completed-run reconcile", () => {
	it("R1#1: a CommDB lookup ERROR never authorizes abandonment (lookup_error keeps state, B7)", async () => {
		const { store, writer } = await makeWriter({
			probes: {
				hasCommitMarker: () => false,
				hasNonPendingCommDbRow: () => "unknown",
			},
		});
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-1",
			context: { node: "design", attempt: 1 },
		});
		writer.onDispatchFailed({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-1",
			node: "design",
			attempt: 1,
			error: "blueprint refused",
		});
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe(
			"intent_recorded",
		);
	});

	it("R1#1: reconcile with marker + UNKNOWN row stops at launch_committed — started needs a PROVEN row", async () => {
		const { store, writer } = await makeWriter({
			probes: {
				hasCommitMarker: () => true,
				hasNonPendingCommDbRow: () => "unknown",
			},
		});
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-1",
			context: { node: "qa", attempt: 1 },
		});
		writer.reconcileSideEffects();
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe(
			"launch_committed",
		);
	});

	it("R1#3: reconciles non-terminal ledger rows of COMPLETED runs (a same-process ship must not strand evidence)", async () => {
		const { store, writer } = await makeWriter({
			probes: {
				hasCommitMarker: () => true,
				hasNonPendingCommDbRow: () => true,
			},
		});
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-1",
			context: { node: "implement", attempt: 1 },
		});
		writer.onShipFinalized({ projectName: PROJECT, issueId: ISSUE }); // run completed, row still intent_recorded
		writer.reconcileSideEffects();
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe("started");
	});

	it("R1#2/R2#1: T8 kickback backfill is EXECUTION-attributed — only rounds reported by an execution THIS run dispatched, with their real round numbers", async () => {
		const { store, writer } = await makeWriter();
		// a fix-round reported by an execution this run never dispatched
		// (a previous workflow's QA) — no timestamp games can attach it here
		store.insertEvent({
			event_id: "three-stage-fix-round-old",
			execution_id: "exec-foreign-qa",
			issue_id: ISSUE,
			project_name: PROJECT,
			event_type: "three_stage_fix_round",
			source: "test",
			payload: { round: 1 },
		});
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-qa-1",
			context: { node: "qa", attempt: 1 },
		});
		writer.reconcileOnStartup();
		expect(uids(store, "run-1").some((u) => u.includes(":kickback:"))).toBe(
			false,
		);

		// a round reported by THIS run's own QA execution backfills with its
		// REAL production round number, not a re-derived 1..N
		store.insertEvent({
			event_id: "three-stage-fix-round-cur",
			execution_id: "exec-qa-1",
			issue_id: ISSUE,
			project_name: PROJECT,
			event_type: "three_stage_fix_round",
			source: "test",
			payload: { round: 3 },
		});
		writer.reconcileOnStartup();
		const u = uids(store, "run-1");
		expect(u).toContain("run:run-1:kickback:3");
		expect(u.some((x) => x.endsWith(":kickback:1"))).toBe(false);
	});

	it("R2#2: a PRIOR run's QA PASS intent never backfills into a NEW run (execution attribution)", async () => {
		const { store, writer } = await makeWriter();
		// run-1: dispatched qa exec, shipped, finalized
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-qa-old",
			context: { node: "qa", attempt: 1 },
		});
		writer.onShipFinalized({ projectName: PROJECT, issueId: ISSUE });
		// the old QA session row (terminal, pass intent) is still the newest qa row
		store.upsertSession({
			execution_id: "exec-qa-old",
			issue_id: ISSUE,
			project_name: PROJECT,
			status: "completed",
			chat_thread_role: "qa",
		});
		const { patchSessionParams } = await import("../proofshot-session.js");
		patchSessionParams(store, "exec-qa-old", (cur) => ({
			...cur,
			three_stage_verdict: { status: "pass", event_id: "old", at: "t" },
		}));
		// run-2 starts fresh
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-design-new",
			context: { node: "design", attempt: 1 },
		});
		const newRun = store.getActiveWorkflowRun(PROJECT, ISSUE);
		writer.reconcileOnStartup();
		expect(
			uids(store, newRun?.run_id ?? "").some((u) =>
				u.includes(":complete:qa:"),
			),
		).toBe(false);
	});

	it("R2#3: a PRIOR run's ship-finalization claim never finalizes a NEW run; the run's OWN claim does", async () => {
		const { store, writer } = await makeWriter();
		// run-1 dispatched exec-old, shipped (claim event), finalized
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-old",
			context: { node: "implement", attempt: 1 },
		});
		store.insertEvent({
			event_id: "post-ship-finalization-exec-old",
			execution_id: "exec-old",
			issue_id: ISSUE,
			project_name: PROJECT,
			event_type: "post_ship_finalization_claim",
			source: "bridge.post-ship-finalization",
			payload: {},
		});
		writer.onShipFinalized({ projectName: PROJECT, issueId: ISSUE });
		// run-2 starts fresh — the old claim must NOT finalize it
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-new",
			context: { node: "design", attempt: 1 },
		});
		const newRun = store.getActiveWorkflowRun(PROJECT, ISSUE);
		writer.reconcileOnStartup();
		expect(store.getWorkflowRun(newRun?.run_id ?? "")?.status).toBe("active");

		// run-2's OWN claim (its execution) finalizes it
		store.insertEvent({
			event_id: "post-ship-finalization-exec-new",
			execution_id: "exec-new",
			issue_id: ISSUE,
			project_name: PROJECT,
			event_type: "post_ship_finalization_claim",
			source: "bridge.post-ship-finalization",
			payload: {},
		});
		writer.reconcileOnStartup();
		expect(store.getWorkflowRun(newRun?.run_id ?? "")?.status).toBe(
			"completed",
		);
	});

	it("R2#4: a transiently-failed T6 shadow write cannot skew the attempt — durable attributed rounds heal it", async () => {
		const { store, writer } = await makeWriter();
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-qa-1",
			context: { node: "qa", attempt: 1 },
		});
		// production recorded the round (durable, attributed to this run's QA)
		// but the shadow onKickback batch FAILED (no loop_iteration written)
		store.insertEvent({
			event_id: "three-stage-fix-round-r1",
			execution_id: "exec-qa-1",
			issue_id: ISSUE,
			project_name: PROJECT,
			event_type: "three_stage_fix_round",
			source: "test",
			payload: { round: 1 },
		});
		expect(writer.currentAttempt(ISSUE)).toBe(2);
	});

	it("R1#4: T8 backfills ONLY the newest boundary row per role — historical completes stay a declared gap", async () => {
		const { store, writer } = await makeWriter();
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "impl-current",
			context: { node: "implement", attempt: 1 },
		});
		// two implement rows at awaiting_review — a legacy close-respawn leftover
		// (old) and the current one; only the NEWEST may backfill T4.
		store.upsertSession({
			execution_id: "impl-old",
			issue_id: ISSUE,
			project_name: PROJECT,
			status: "awaiting_review",
			chat_thread_role: "implement",
			last_activity_at: "2000-01-01 00:00:00",
		});
		store.upsertSession({
			execution_id: "impl-current",
			issue_id: ISSUE,
			project_name: PROJECT,
			status: "awaiting_review",
			chat_thread_role: "implement",
			last_activity_at: "2999-01-01 00:00:00",
		});
		writer.reconcileOnStartup();
		const completes = uids(store, "run-1").filter((u) =>
			u.includes(":complete:implement:"),
		);
		expect(completes).toEqual(["run:run-1:complete:implement:1:impl-current"]);
	});
});

describe("onDispatchFailed — evidence-checked abandon (truth table, B7)", () => {
	function seeded(probes: WorkflowShadowEvidenceProbes) {
		return makeWriter({ probes }).then(({ store, writer }) => {
			writer.onSpawnDispatch({
				projectName: PROJECT,
				issueId: ISSUE,
				executionId: "exec-1",
				context: { node: "design", attempt: 1 },
			});
			return { store, writer };
		});
	}

	it("pre-commit positive failure (no marker, no row) → abandoned with reason", async () => {
		const { store, writer } = await seeded({
			hasCommitMarker: () => false,
			hasNonPendingCommDbRow: () => false,
		});
		writer.onDispatchFailed({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-1",
			node: "design",
			attempt: 1,
			error: "blueprint refused",
		});
		const row = store.listWorkflowSideEffects("run-1")[0];
		expect(row?.state).toBe("abandoned");
		expect(row?.reason).toContain("blueprint refused");
	});

	it("post-start failure (marker durable) → stops at launch_committed, NEVER abandoned", async () => {
		const { store, writer } = await seeded({
			hasCommitMarker: () => true,
			hasNonPendingCommDbRow: () => false,
		});
		writer.onDispatchFailed({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-1",
			node: "design",
			attempt: 1,
			error: "run() rejected after start",
		});
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe(
			"launch_committed",
		);
	});

	it("Codex pre-goal failure (row exists, marker never written) → stays intent_recorded forever (R3#1)", async () => {
		const { store, writer } = await seeded({
			hasCommitMarker: () => false,
			hasNonPendingCommDbRow: () => true,
		});
		writer.onDispatchFailed({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-1",
			node: "design",
			attempt: 1,
			error: "goal runtime never came up",
		});
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe(
			"intent_recorded",
		);
	});
});

describe("reconcileSideEffects — durable-evidence advancement only (B7/B8)", () => {
	async function seededWriter(probes: WorkflowShadowEvidenceProbes) {
		const { store, writer } = await makeWriter({ probes });
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-1",
			context: { node: "qa", attempt: 1 },
		});
		return { store, writer };
	}

	it("dual evidence (marker ∧ non-pending row) → started, a TERMINAL state", async () => {
		const { store, writer } = await seededWriter({
			hasCommitMarker: () => true,
			hasNonPendingCommDbRow: () => true,
		});
		writer.reconcileSideEffects();
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe("started");
	});

	it("marker only → launch_committed (row is the second REQUIRED evidence — no shortcut)", async () => {
		const { store, writer } = await seededWriter({
			hasCommitMarker: () => true,
			hasNonPendingCommDbRow: () => false,
		});
		writer.reconcileSideEffects();
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe(
			"launch_committed",
		);
	});

	it("row only (Codex adapter-created row, marker never written) → stays intent_recorded, NEVER started (R3#1)", async () => {
		const { store, writer } = await seededWriter({
			hasCommitMarker: () => false,
			hasNonPendingCommDbRow: () => true,
		});
		writer.reconcileSideEffects();
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe(
			"intent_recorded",
		);
	});

	it("both adapter orders converge: marker-then-row and row-then-marker both end started (B7)", async () => {
		// TmuxAdapter order: marker first.
		let marker = true;
		let row = false;
		const probes: WorkflowShadowEvidenceProbes = {
			hasCommitMarker: () => marker,
			hasNonPendingCommDbRow: () => row,
		};
		const a = await seededWriter(probes);
		a.writer.reconcileSideEffects(); // marker only → launch_committed
		row = true;
		a.writer.reconcileSideEffects(); // both → started
		expect(a.store.listWorkflowSideEffects("run-1")[0]?.state).toBe("started");

		// CodexTmuxAdapter order: row first.
		marker = false;
		row = true;
		const b = await seededWriter(probes);
		b.writer.reconcileSideEffects(); // row only → intent_recorded
		marker = true;
		b.writer.reconcileSideEffects(); // both → started
		expect(b.store.listWorkflowSideEffects("run-1")[0]?.state).toBe("started");
	});

	it("a runner that exited after starting stays started — the ledger records launch HISTORY, not liveness", async () => {
		let evidence = true;
		const { store, writer } = await seededWriter({
			hasCommitMarker: () => evidence,
			hasNonPendingCommDbRow: () => evidence,
		});
		writer.reconcileSideEffects();
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe("started");
		evidence = false; // teardown removed marker dir + CommDB row later
		writer.reconcileSideEffects();
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe("started");
	});

	it("reconcile without probes is a warn'd no-op (cannot prove anything — fail-closed)", async () => {
		const warns: string[] = [];
		const { store, writer } = await makeWriter({
			warn: (m) => warns.push(m),
		});
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-1",
			context: { node: "qa", attempt: 1 },
		});
		writer.reconcileSideEffects();
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe(
			"intent_recorded",
		);
	});
});

describe("reconcileOnStartup — T8 crash-window backfill from durable sources (B4)", () => {
	it("backfills missing loop_iteration events from three_stage_fix_round rows", async () => {
		const { store, writer } = await makeWriter();
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-1",
			context: { node: "qa", attempt: 1 },
		});
		// production wrote the durable fix-round record (reported by this run's
		// own QA execution); crash before the shadow batch
		store.insertEvent({
			event_id: "three-stage-fix-round-ev1",
			execution_id: "exec-1",
			issue_id: ISSUE,
			project_name: PROJECT,
			event_type: "three_stage_fix_round",
			source: "test",
			payload: { round: 1 },
		});
		writer.reconcileOnStartup();
		expect(uids(store, "run-1")).toContain("run:run-1:kickback:1");
		// replay-safe
		writer.reconcileOnStartup();
		expect(
			uids(store, "run-1").filter((u) => u === "run:run-1:kickback:1"),
		).toHaveLength(1);
	});

	it("finalizes an active run whose post_ship_finalization_claim exists (T9 claim repair — external merge path, B10)", async () => {
		const { store, writer } = await makeWriter();
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-1",
			context: { node: "implement", attempt: 1 },
		});
		store.insertEvent({
			event_id: "post-ship-finalization-exec-1",
			execution_id: "exec-1",
			issue_id: ISSUE,
			project_name: PROJECT,
			event_type: "post_ship_finalization_claim",
			source: "bridge.post-ship-finalization",
			payload: {},
		});
		writer.reconcileOnStartup();
		expect(store.getWorkflowRun("run-1")?.status).toBe("completed");
	});

	it("declared gaps stay gaps: reconcile fabricates NO wake events (R2#4/R3#4)", async () => {
		const { store, writer } = await makeWriter();
		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-1",
			context: { node: "implement", attempt: 1 },
		});
		writer.reconcileOnStartup();
		expect(uids(store, "run-1").some((u) => u.includes(":wake:"))).toBe(false);
	});
});

describe("real-tool integration — marker file + CommDB probes over a temp filesystem", () => {
	it("advances a ledger row to started from a REAL commit-marker file and a REAL non-pending CommDB row", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1232-evidence-"));
		const markerDir = join(dir, "launch-commits");
		mkdirSync(markerDir, { recursive: true });
		const commDbPath = join(dir, "comm.db");

		const store = await StateStore.create(":memory:");
		const writer = new WorkflowShadowWriter({
			store,
			newRunId: () => "run-real",
			probes: {
				// the adapter writes the commit record inside this deterministic dir
				hasCommitMarker: (execId) => existsSync(join(markerDir, execId)),
				hasNonPendingCommDbRow: (_project, execId) => {
					const db = new CommDB(commDbPath);
					try {
						const s = db.getSession(execId) as
							| { tmux_window?: string }
							| undefined;
						return !!s && !String(s.tmux_window ?? "").endsWith(":pending");
					} finally {
						db.close();
					}
				},
			},
			logger: { warn: () => {} },
		});

		writer.onSpawnDispatch({
			projectName: PROJECT,
			issueId: ISSUE,
			executionId: "exec-real",
			context: { node: "qa", attempt: 1 },
		});

		// no evidence yet
		writer.reconcileSideEffects();
		expect(store.listWorkflowSideEffects("run-real")[0]?.state).toBe(
			"intent_recorded",
		);

		// adapter writes the durable commit marker (a real file)
		writeFileSync(join(markerDir, "exec-real"), "committed\n");
		writer.reconcileSideEffects();
		expect(store.listWorkflowSideEffects("run-real")[0]?.state).toBe(
			"launch_committed",
		);

		// pre-registration row is :pending — still not started
		const db = new CommDB(commDbPath);
		db.registerSession("exec-real", "flywheel:pending", PROJECT, ISSUE);
		db.close();
		writer.reconcileSideEffects();
		expect(store.listWorkflowSideEffects("run-real")[0]?.state).toBe(
			"launch_committed",
		);

		// runner self-registers a REAL tmux target → dual evidence → started
		const db2 = new CommDB(commDbPath);
		db2.registerSession("exec-real", "flywheel:1.2", PROJECT, ISSUE);
		db2.close();
		writer.reconcileSideEffects();
		expect(store.listWorkflowSideEffects("run-real")[0]?.state).toBe("started");
	});
});

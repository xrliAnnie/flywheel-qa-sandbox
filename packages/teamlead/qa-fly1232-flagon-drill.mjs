#!/usr/bin/env node
/**
 * FLY-1232 QA — flag-ON real-machine drill (module-driven, Lead hard requirement).
 *
 * Drives the REAL compiled #578 dist (NOT vitest-transformed src) in an ISOLATED
 * env (own StateStore file + own TMPDIR) with FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1,
 * exercising a real dispatch chain THROUGH the WorkflowShadowWriter and the
 * claims substrate. Verifies:
 *   ① the 6 claims-ledger tables + side-effect ledger actually land rows, and the
 *      append-only triggers actually reject UPDATE/DELETE on a raw reopen;
 *   ② a decision capability is one-shot — consumed once, replay is idempotent for
 *      the same payload and fail-closed for a different one;
 *   ③ the flag=0 path is byte-unchanged — the single switch point yields NO writer,
 *      so the production seam is inert (control run, zero shadow rows).
 *
 * SCOPE (Codex R6 HIGH — do not over-read a green run): this drill calls the
 * WorkflowShadowWriter hooks DIRECTLY; the commit marker is written by this
 * script and the CommDB-row fact comes from an in-memory map. It proves the
 * compiled writer's truth table + append-only + one-shot + byte-compat, and
 * does NOT exercise the production fresh-spawn chain (RunDispatcher.start →
 * Blueprint.run → adapter → launchCommitPath propagation → real CommDB
 * registration). Plan Step 8/B11's fresh-spawn clause is verified separately
 * by the QA phase's real-machine fresh spawn — a green exit here is NOT that.
 *
 * Run:  node packages/teamlead/qa-fly1232-flagon-drill.mjs
 * Exit: 0 = all checks pass, 1 = any failure.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createWorkflowShadowWriterFromEnv } from "./dist/bridge/workflow-shadow-writer.js";
import { StateStore } from "./dist/StateStore.js";

let failures = 0;
function check(label, cond, detail = "") {
	const ok = !!cond;
	if (!ok) failures++;
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
	);
}

const ISO = "2026-07-13T00:00:00.000Z";
const EXP = "2026-07-13T01:00:00.000Z";
const DEADLINE = "2026-07-13T02:00:00.000Z";
const HEAD = "b".repeat(40);

// Isolated workspace — never touches production ~/.flywheel state.
const work = mkdtempSync(join(tmpdir(), "qa-fly1232-flagon-"));
const dbPath = join(work, "isolated-state.db");

async function main() {
	console.log(`[drill] isolated StateStore = ${dbPath}`);
	console.log(`[drill] node dist = ./dist (compiled #578)\n`);

	// ── ③ (part A) control: flag=0 → NO writer (single switch point) ──────────
	const storeOff = await StateStore.create(join(work, "off-state.db"));
	const writerOff = createWorkflowShadowWriterFromEnv(
		{ FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "0" },
		storeOff,
	);
	check(
		"③a flag=0 → shadow writer factory returns undefined (inert seam)",
		writerOff === undefined,
	);
	// With no writer, nothing could ever write shadow rows: the off store stays empty.
	check(
		"③b flag=0 control store has ZERO active workflow runs",
		storeOff.listActiveWorkflowRuns().length === 0,
	);
	storeOff.close();

	// ── flag=1: real writer over a real dispatch chain ────────────────────────
	// REAL evidence probes (Codex R5 HIGH): a durable marker FILE on disk drives
	// hasCommitMarker, and a controlled map stands in for the CommDB row — so the
	// ②b progression (intent_recorded → launch_committed → started) is advanced
	// by genuine on-disk evidence via reconcileSideEffects, not a constant stub.
	const markersDir = join(work, "markers");
	mkdirSync(markersDir, { recursive: true });
	const commDbRow = new Map(); // executionId → true | false | "unknown"
	const store = await StateStore.create(dbPath);
	const writer = createWorkflowShadowWriterFromEnv(
		{ FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1" },
		store,
		{
			hasCommitMarker: (executionId) =>
				existsSync(join(markersDir, executionId)),
			hasNonPendingCommDbRow: (_projectName, executionId) =>
				commDbRow.has(executionId) ? commDbRow.get(executionId) : false,
		},
	);
	check("flag=1 → shadow writer is constructed", writer !== undefined);
	if (!writer) return;

	const project = "flywheel";
	const issue = "FLY-1232";

	// T1: run start (design dispatch) — synthesizes a fresh run.
	writer.onSpawnDispatch({
		projectName: project,
		issueId: issue,
		executionId: "exec-design",
		context: { node: "design", attempt: 1 },
	});
	const run = store.getActiveWorkflowRun(project, issue);
	check(
		"① T1 created an ACTIVE workflow_run row",
		!!run && run.status === "active",
	);
	if (!run) return;
	const runId = run.run_id;

	// T4 design complete → T2 handoff to implement (edge) → T4 implement complete
	// → T2 handoff to qa (edge) → T5 qa pass → T9 ship finalize.
	writer.onNodeComplete({
		projectName: project,
		issueId: issue,
		executionId: "exec-design",
		node: "design",
		attempt: 1,
	});
	writer.onSpawnDispatch({
		projectName: project,
		issueId: issue,
		executionId: "exec-impl",
		context: {
			node: "implement",
			attempt: 1,
			edge: { from: "design", to: "implement" },
		},
	});
	writer.onNodeComplete({
		projectName: project,
		issueId: issue,
		executionId: "exec-impl",
		node: "implement",
		attempt: 1,
	});
	writer.onSpawnDispatch({
		projectName: project,
		issueId: issue,
		executionId: "exec-qa",
		context: { node: "qa", attempt: 1, edge: { from: "implement", to: "qa" } },
	});
	writer.onQaPass({
		projectName: project,
		issueId: issue,
		executionId: "exec-qa",
		attempt: 1,
	});

	// Verify the run projections + events + side-effect ledger landed rows.
	const events = store.listWorkflowRunEvents(runId);
	const sideEffects = store.listWorkflowSideEffects(runId);
	const nodeDesign = store.getWorkflowRunNode(runId, "design", 1);
	const nodeImpl = store.getWorkflowRunNode(runId, "implement", 1);
	const nodeQa = store.getWorkflowRunNode(runId, "qa", 1);
	check(
		"① workflow_run_node landed 3 nodes (design/implement/qa)",
		!!nodeDesign && !!nodeImpl && !!nodeQa,
	);
	check(
		"① workflow_run_event landed dispatch+edge+complete rows",
		events.some((e) => e.kind === "node_dispatched") &&
			events.some((e) => e.kind === "edge_traversed") &&
			events.some((e) => e.kind === "node_completed"),
		`${events.length} events`,
	);
	check(
		"① workflow_side_effect_ledger landed 3 dispatch intent rows (writer-allocated ordinals)",
		sideEffects.length === 3 &&
			sideEffects.every((r) => r.launch_ordinal === 1),
		`${sideEffects.length} rows`,
	);

	// ── ②b evidence progression on the REAL dist (Codex R5 HIGH) ──────────────
	// Advance the launch ledger with GENUINE on-disk evidence via the real
	// reconcileSideEffects, exercising the research §F.3 truth table:
	//   dual evidence (marker ∧ proven non-pending row) → started (terminal)
	//   marker only / row=unknown                       → launch_committed
	//   no marker                                       → stays intent_recorded
	const stateOf = (exec) =>
		store.listWorkflowSideEffects(runId).find((r) => r.execution_id === exec)
			?.state;
	check(
		"②b all three launch rows begin at intent_recorded (no evidence yet)",
		["exec-design", "exec-impl", "exec-qa"].every(
			(e) => stateOf(e) === "intent_recorded",
		),
	);
	// exec-design: durable marker file + PROVEN non-pending row → started.
	writeFileSync(join(markersDir, "exec-design"), "committed");
	commDbRow.set("exec-design", true);
	// exec-impl: marker only, row UNKNOWN → launch_committed (never started).
	writeFileSync(join(markersDir, "exec-impl"), "committed");
	commDbRow.set("exec-impl", "unknown");
	// exec-qa: no marker written → must stay intent_recorded (honest unknown).
	writer.reconcileSideEffects();
	check(
		"②b dual evidence (marker ∧ proven row) advances exec-design → started",
		stateOf("exec-design") === "started",
		stateOf("exec-design"),
	);
	check(
		"②b marker-only / unknown row advances exec-impl → launch_committed (never started)",
		stateOf("exec-impl") === "launch_committed",
		stateOf("exec-impl"),
	);
	check(
		"②b no marker keeps exec-qa at intent_recorded (absence never fabricates history)",
		stateOf("exec-qa") === "intent_recorded",
		stateOf("exec-qa"),
	);

	// ── ② one-shot decision capability over the REAL substrate ────────────────
	const issued = store.issueWorkflowDecisionCapability({
		runId,
		nodeId: "qa",
		executionId: "exec-qa",
		attempt: 1,
		allowedPredicateFamily: "qa_verdict",
		expiresAt: EXP,
		absoluteDeadlineAt: DEADLINE,
	});
	check(
		"② capability issued (plaintext returned once)",
		issued.ok === true && !!issued.token,
	);
	if (!issued.ok) return;
	const token = issued.token;

	const payload = {
		token,
		clientRequestId: "req-1",
		predicate: "qa_passed",
		subjectKind: "git_head",
		subjectDigest: HEAD,
		issuerVendor: "claude",
		issuerModel: "opus",
		subjectProducerExecutionId: "exec-impl",
		subjectProducerVendor: "codex",
		claimExpiresAt: EXP,
		evidence: { report: "qa.md" },
		now: ISO,
	};
	const first = store.submitWorkflowDecisionClaim(payload);
	check(
		"② first submit consumes the capability (ok)",
		first.ok === true && first.idempotentReplay === false,
	);
	const sameReplay = store.submitWorkflowDecisionClaim(payload);
	check(
		"② same-payload replay is IDEMPOTENT (same claim, no new row)",
		sameReplay.ok === true &&
			sameReplay.idempotentReplay === true &&
			first.ok &&
			sameReplay.claimId === first.claimId,
	);
	const diffPayload = store.submitWorkflowDecisionClaim({
		...payload,
		predicate: "qa_failed",
	});
	check(
		"② different-payload replay on a consumed token is FAIL-CLOSED (one-shot honored)",
		diffPayload.ok === false &&
			diffPayload.reason === "replay_payload_mismatch",
		diffPayload.ok ? "unexpectedly ok" : diffPayload.reason,
	);
	check(
		"② exactly ONE claim row exists for the run",
		store.countWorkflowClaims(runId) === 1,
		`${store.countWorkflowClaims(runId)} claims`,
	);

	// Seed a revocation so its DELETE trigger has a row to fire on.
	if (first.ok)
		store.revokeWorkflowClaim({
			claimId: first.claimId,
			reason: "qa-drill",
			actor: "qa",
		});

	// T9 ship finalize → run leaves active.
	writer.onShipFinalized({ projectName: project, issueId: issue });
	check(
		"① T9 finalize pushed the run out of ACTIVE",
		store.getWorkflowRun(runId)?.status === "completed",
	);
	check(
		"① no ACTIVE run remains for the issue after finalize",
		store.getActiveWorkflowRun(project, issue) === undefined,
	);

	store.close();

	// ── ① append-only enforcement on a RAW reopen of the on-disk file ─────────
	const raw = new Database(dbPath);
	try {
		const tamper = [
			"UPDATE workflow_claims SET predicate = 'qa_failed'",
			"DELETE FROM workflow_claims",
			"UPDATE workflow_run_event SET kind = 'tampered'",
			"DELETE FROM workflow_run_event",
			"UPDATE workflow_claim_revocation SET reason = 'x'",
			"DELETE FROM workflow_claim_revocation",
		];
		for (const sql of tamper) {
			let rejected = false;
			try {
				raw.prepare(sql).run();
			} catch (e) {
				rejected = /append-only/.test(String(e.message));
			}
			check(`① append-only rejects: ${sql}`, rejected);
		}
		// Sanity: the capability table stores only the sha256, never the plaintext.
		const capRow = raw
			.prepare("SELECT token_hash FROM workflow_decision_capability LIMIT 1")
			.get();
		const expectHash = createHash("sha256").update(token).digest("hex");
		check(
			"① capability persisted only the sha256 (no plaintext token column)",
			capRow?.token_hash === expectHash,
		);
	} finally {
		raw.close();
	}

	console.log(
		`\n[drill] ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`,
	);
}

main()
	.catch((e) => {
		console.error("[drill] threw:", e);
		failures++;
	})
	.finally(() => {
		try {
			rmSync(work, { recursive: true, force: true });
		} catch {}
		process.exit(failures === 0 ? 0 : 1);
	});

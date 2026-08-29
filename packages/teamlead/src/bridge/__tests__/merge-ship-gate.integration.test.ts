/**
 * FLY-869 B — merge-race ship gate, END-TO-END integration (Annie's explicit ask).
 *
 * Real StateStore (native better-sqlite3, per-statement autocommit) + real CommDB
 * (via FLYWHEEL_COMM_DIR redirect) + the actual `verifyApproval` ship-authority +
 * the QA snapshot gate + the Bridge seam (`computeShipDecision` / `parkMergeBlock` /
 * `isMergeBlocked` / `clearMergeBlockOnApproval`) + the finalization chokepoint
 * (`isPostApproveShipComplete`). NO mocks on the decision path — this is the real
 * merged→completed mapping every sink (DirectEventSink / event-route / W2 /
 * complete-marker-reconciler) computes.
 *
 * Two groups Annie required, plus the two anti-regressions the plan pins:
 *   ① FLY-120 — a GENUINELY approved + merged session PASSES the gate to `completed`
 *      (NOT stranded in awaiting_review). This is the fragile hot-spot the whole
 *      issue must not regress.
 *   ② merged-WITHOUT-approval (runner 抢跑 self-merge) → merge_block marker + NOT Done
 *      (决定③: no auto-revert, leave open, loud alert). Idempotent once-per-head.
 *   ③ recovery — a same-head founder approval CLEARS the block (B-3, R2 HIGH-5).
 *   ④ emergency kill-switch — FLYWHEEL_MERGE_APPROVAL_GATE=0 restores the old
 *      merged→completed behavior (决定②: default ON, emergency-off if problems).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	computeAuthoritativeShipDecision,
	computeShipDecision,
	finalizeRecoveredMerge,
	isMergeBlocked,
	parkMergeBlock,
} from "../merge-ship-gate.js";
import { isPostApproveShipComplete } from "../post-ship-finalization.js";
import type { BridgeConfig } from "../types.js";

const EXEC = "exec-fly869-b";
const LEAD = "flywheel-eng-lead";
const PROJECT = "proj";
const ISSUE = "FLY-869";
const HEAD = "a".repeat(40);

// All three gates ON — the production default this issue ships (决定②).
const GATES_ON = {
	FLYWHEEL_MERGE_APPROVAL_GATE: "1",
	FLYWHEEL_QA_DONE_GATE: "1",
	FLYWHEEL_CODEX_HARD_GATE: "1",
} as NodeJS.ProcessEnv;

describe("FLY-869 B — merge-race ship gate (real StateStore + real CommDB)", () => {
	let tmpDir: string;
	let store: StateStore;
	let commRoot: string;
	let worktreePath: string;
	let prevCommDir: string | undefined;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly869-b-int-"));
		// Redirect commDbPathForProject → <tmp>/comm/<project>/comm.db (never the
		// live Bridge comm.db). computeShipDecision reads process.env for this.
		commRoot = join(tmpDir, "comm");
		mkdirSync(join(commRoot, PROJECT), { recursive: true });
		prevCommDir = process.env.FLYWHEEL_COMM_DIR;
		process.env.FLYWHEEL_COMM_DIR = commRoot;
		store = await StateStore.create(join(tmpDir, "teamlead.db"));
		worktreePath = join(tmpDir, "worktree");
		execFileSync("git", ["init", "-q", worktreePath]);
		const headRef = execFileSync(
			"git",
			["-C", worktreePath, "symbolic-ref", "HEAD"],
			{ encoding: "utf8" },
		).trim();
		mkdirSync(join(worktreePath, ".git", headRef, ".."), {
			recursive: true,
		});
		writeFileSync(join(worktreePath, ".git", headRef), `${HEAD}\n`);
	});

	afterEach(() => {
		if (prevCommDir === undefined) delete process.env.FLYWHEEL_COMM_DIR;
		else process.env.FLYWHEEL_COMM_DIR = prevCommDir;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function commDbPath(): string {
		return join(commRoot, PROJECT, "comm.db");
	}

	/** Insert an approve_to_ship question FROM the runner + a structured approval. */
	function foundersApproved(): string {
		const db = new CommDB(commDbPath());
		try {
			const qid = db.insertQuestion(EXEC, LEAD, "PR ready", {
				checkpoint: "approve_to_ship",
			});
			db.insertResponse(qid, "bridge", JSON.stringify({ approved: true }));
			return qid;
		} finally {
			db.close();
		}
	}

	/** A session with a PASSED QA record + APPROVED Codex record for HEAD. */
	function withQaAndCodexGreen(): void {
		store.setQaRequiredSnapshot({
			executionId: EXEC,
			required: 1,
			reason: "test",
		});
		store.claimAutoQaRecord({
			parentExecutionId: EXEC,
			targetPrHeadSha: HEAD,
			issueId: ISSUE,
			projectName: PROJECT,
		});
		store.setAutoQaStatus(EXEC, HEAD, "passed", {});
		store.recordCodexReviewApproved({
			executionId: EXEC,
			targetPrHeadSha: HEAD,
			issueId: ISSUE,
			projectName: PROJECT,
		});
	}

	function upsert(status: string, reviewQuestionId?: string): void {
		store.upsertSession({
			execution_id: EXEC,
			issue_id: ISSUE,
			project_name: PROJECT,
			status,
			session_role: "main",
			branch: "fly-869",
			worktree_path: worktreePath,
		});
		store.setReviewBinding(EXEC, {
			questionId: reviewQuestionId ?? null,
			prHeadSha: HEAD,
		});
	}

	// ── Group ① — FLY-120: genuinely approved + merged → eligible → completed ──
	it("approved + merged PASSES the gate to completed (FLY-120 not regressed)", () => {
		const qid = foundersApproved();
		upsert("approved_to_ship", qid);
		withQaAndCodexGreen();

		const session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		const d = computeShipDecision(store, session, HEAD, GATES_ON);

		expect(d.eligible).toBe(true);
		expect(d.mergeApprovalOk).toBe(true);
		expect(d.qaOk).toBe(true);
		// The sink does NOT park an eligible merge → the founder-hold suppressor stays clear.
		expect(isMergeBlocked(session)).toBe(false);
		// The single finalization chokepoint drives it to Done (existingStatus was
		// approved_to_ship — the exact FLY-120 "approved then already-merged" shape).
		expect(
			isPostApproveShipComplete({
				existingStatus: "approved_to_ship",
				route: "needs_review",
				landingStatus: { status: "merged" },
				shipEligible: d.eligible,
			}),
		).toBe(true);
	});

	it("claims READ makes worktree HEAD authoritative and rejects stale cached evidence", async () => {
		upsert("awaiting_review");
		const session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		const decision = await computeAuthoritativeShipDecision(
			store,
			session,
			"b".repeat(40),
			{
				...GATES_ON,
				FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
			} as NodeJS.ProcessEnv,
		);
		expect(decision).toMatchObject({
			eligible: false,
			mergeReason: "head_authority_mismatch",
			qaReason: "head_authority_mismatch_failclosed",
			authoritativeHead: HEAD,
		});
	});

	// ── Group ② — merged WITHOUT approval → merge_block + not Done (决定③) ──
	it("merged without approval → merge_block marker + NOT completed (idempotent once-per-head)", () => {
		// Runner 抢跑: merged landing, but never approved (status still awaiting_review,
		// no answered approve_to_ship question). QA + Codex green — proving it is the
		// MERGE-APPROVAL gate, not QA/Codex, that blocks it.
		upsert("awaiting_review");
		withQaAndCodexGreen();

		let session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		const d = computeShipDecision(store, session, HEAD, GATES_ON);
		expect(d.eligible).toBe(false);
		expect(d.mergeApprovalOk).toBe(false);
		expect(d.qaOk).toBe(true); // QA passed — the block is purely merge-approval.

		// Park it (决定③ — no auto-revert, durable head-bound marker).
		expect(parkMergeBlock(store, session, HEAD, d)).toBe(true);
		session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		expect(isMergeBlocked(session)).toBe(true);
		expect(session.merge_block_reason).toContain("merge_without_approval");
		expect(session.merge_block_head?.toLowerCase()).toBe(HEAD);
		// NOT marked completed / Done.
		expect(session.status).not.toBe("completed");
		// The finalization chokepoint refuses to finalize a non-eligible merge.
		expect(
			isPostApproveShipComplete({
				existingStatus: "awaiting_review",
				route: "needs_review",
				landingStatus: { status: "merged" },
				shipEligible: d.eligible,
			}),
		).toBe(false);

		// Idempotent: a replay / second surface does not re-claim (single alert).
		expect(parkMergeBlock(store, session, HEAD, d)).toBe(false);
	});

	// ── Group ③ — recovery: a same-head approval eligibility-gated CLEARS + COMPLETES
	//    (B-3, R2 HIGH-5 + Codex R1 #1 / R2 #2 — clear only when eligible, then complete) ──
	it("a same-head founder approval on a parked eligible session clears + drives it to completed", async () => {
		// Start parked (as in Group ②): merged, QA + Codex green, but not yet approved.
		upsert("awaiting_review");
		withQaAndCodexGreen();
		const session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		parkMergeBlock(
			store,
			session,
			HEAD,
			computeShipDecision(store, session, HEAD, GATES_ON),
		);
		expect(isMergeBlocked(store.getSession(EXEC))).toBe(true);

		// The founder approves THIS head (FSM flips approved_to_ship + CommDB answered) —
		// the marker is STILL present when finalizeRecoveredMerge runs (Codex R2 #2: it
		// gates the clear on eligibility). Now fully eligible → clears + completes.
		const qid = foundersApproved();
		upsert("approved_to_ship", qid);
		const completed = await finalizeRecoveredMerge(
			store,
			{} as BridgeConfig,
			[],
			EXEC,
			undefined,
			GATES_ON,
		);
		expect(completed).toBe(true);
		expect(isMergeBlocked(store.getSession(EXEC))).toBe(false); // marker cleared
		expect(store.getSession(EXEC)?.status).toBe("completed");
	});

	// ── FLY-907 (Codex R1 MED-2): the recovered-merge path is the FOURTH
	// completion sink — it must close a three-stage issue's parked phases and
	// only THEN run the terminal display refresh (order enforced by
	// runPostShipFinalization: phase finalization step 1.25 before the
	// display-refresh step 1.3, both before archive). ──
	it("recovered merge runs finalizeThreeStagePhases BEFORE the terminal display refresh", async () => {
		upsert("awaiting_review");
		withQaAndCodexGreen();
		const session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		parkMergeBlock(
			store,
			session,
			HEAD,
			computeShipDecision(store, session, HEAD, GATES_ON),
		);
		const qid = foundersApproved();
		upsert("approved_to_ship", qid);

		const order: string[] = [];
		const completed = await finalizeRecoveredMerge(
			store,
			{} as BridgeConfig,
			[],
			EXEC,
			undefined,
			GATES_ON,
			async () => {
				order.push("refresh");
			},
			async () => {
				order.push("finalize-phases");
			},
		);
		expect(completed).toBe(true);
		expect(order).toEqual(["finalize-phases", "refresh"]);
	});

	// ── Group ③b — recovery LEAVES the marker when a gate is still unmet (Codex R2 #2) ──
	it("recovery does NOT clear the marker nor complete when the QA gate is still unmet", async () => {
		// Parked (merged, Codex approved) but QA REQUIRED with no passing record; founder approves.
		upsert("awaiting_review");
		store.setQaRequiredSnapshot({
			executionId: EXEC,
			required: 1,
			reason: "t",
		});
		store.recordCodexReviewApproved({
			executionId: EXEC,
			targetPrHeadSha: HEAD,
			issueId: ISSUE,
			projectName: PROJECT,
		});
		const session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		// Park it (not eligible — QA required, no passing record).
		parkMergeBlock(
			store,
			session,
			HEAD,
			computeShipDecision(store, session, HEAD, GATES_ON),
		);
		expect(isMergeBlocked(store.getSession(EXEC))).toBe(true);

		const qid = foundersApproved();
		upsert("approved_to_ship", qid);
		// QA gate still unmet → recovery must NOT complete AND must LEAVE the marker (held).
		const completed = await finalizeRecoveredMerge(
			store,
			{} as BridgeConfig,
			[],
			EXEC,
			undefined,
			GATES_ON,
		);
		expect(completed).toBe(false);
		expect(store.getSession(EXEC)?.status).toBe("approved_to_ship");
		// Codex R2 #2: the durable suppressor is NOT dropped — the session stays held.
		expect(isMergeBlocked(store.getSession(EXEC))).toBe(true);
	});

	// ── Group ④ — emergency kill-switch restores the pre-gate behavior (决定②) ──
	it("FLYWHEEL_MERGE_APPROVAL_GATE=0 bypasses the merge gate (emergency-off)", () => {
		upsert("awaiting_review"); // unapproved
		withQaAndCodexGreen(); // QA on + passing → isolates the merge kill-switch
		const session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		const d = computeShipDecision(store, session, HEAD, {
			FLYWHEEL_MERGE_APPROVAL_GATE: "0", // B emergency-off
			FLYWHEEL_QA_DONE_GATE: "1",
			FLYWHEEL_CODEX_HARD_GATE: "1",
		} as NodeJS.ProcessEnv);
		expect(d.mergeApprovalOk).toBe(true); // bypassed
		expect(d.qaOk).toBe(true);
		expect(d.eligible).toBe(true); // merged→completed restored
	});
});

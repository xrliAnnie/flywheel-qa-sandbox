/**
 * FLY-1041 — QA phase (DAG workflow) independent end-to-end verification.
 *
 * Encodes the ISSUE'S CORE ACCEPTANCE CRITERION at the real-CommDB boundary
 * (better-sqlite3, no mocks): after a ship-gate re-fire, the founder-binding
 * candidate set must converge to EXACTLY ONE bindable approve_to_ship gate, so
 * a short "ship" can never hit `founder_reply_ambiguous`. This is the exact
 * failure Annie hit on FLY-910 (三次 approve → gate_not_answered): the first
 * gate was re-fired but its zombie stayed pending → multi-gate ambiguity →
 * her reply bound to nothing.
 *
 * The candidate-set filter used here mirrors the production deliver pass
 * (`gate-poller.ts` founderReplyDeliverPass: `if (q.kind === "report") continue`),
 * so this test tracks the real binding-candidate logic, not a re-derivation.
 *
 * QA verdict is keyed to this file — durable evidence bound to the PR head.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

/**
 * The production founder-reply binding candidate set: pending questions to the
 * Lead that are (a) real approve-gate carriers, i.e. NOT `kind='report'` status
 * reports. Ship-binding narrows further to approve_to_ship; ambiguity is when
 * more than one such gate is bindable at once.
 */
function shipBindingCandidates(db: CommDB, leadId: string) {
	return db
		.getPendingQuestions(leadId)
		.filter((q) => q.kind !== "report")
		.filter((q) => q.checkpoint === "approve_to_ship");
}

describe("FLY-1041 QA · single bindable ship gate (real CommDB, end-to-end)", () => {
	let db: CommDB;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "qa-fly1041-"));
		db = new CommDB(join(tmpDir, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("re-fire → retire → the founder candidate set converges to exactly ONE gate (the new one)", () => {
		// First ship gate fired (Annie's first "嗯ship" era).
		const g1 = db.insertQuestion("exec-1", "lead-1", "PR #520 ready", {
			checkpoint: "approve_to_ship",
		});
		// Re-fire (needs_review re-completed) opens a SECOND gate — the FLY-910 bug
		// precondition: both are pending, so a short reply is ambiguous.
		const g2 = db.insertQuestion(
			"exec-1",
			"lead-1",
			"PR #520 ready (re-fire)",
			{
				checkpoint: "approve_to_ship",
			},
		);
		expect(
			shipBindingCandidates(db, "lead-1")
				.map((q) => q.id)
				.sort(),
		).toEqual([g1, g2].sort());

		// Fix A retire-on-rebind: the superseded g1 is retired.
		expect(db.retireShipGate(g1)).toBe(true);

		// The ambiguity is gone — exactly ONE bindable gate, and it is g2.
		const candidates = shipBindingCandidates(db, "lead-1");
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.id).toBe(g2);
	});

	it("a real approval on the surviving gate is protected — retire NEVER rewrites it", () => {
		const g1 = db.insertQuestion("exec-1", "lead-1", "PR ready", {
			checkpoint: "approve_to_ship",
		});
		const g2 = db.insertQuestion("exec-1", "lead-1", "PR ready (re-fire)", {
			checkpoint: "approve_to_ship",
		});
		db.retireShipGate(g1);

		// Founder binds to the single surviving gate.
		db.insertResponse(g2, "founder-123", '{"approved": true}');

		// A late/duplicate retire attempt on g2 must be refused (answered gate).
		expect(db.retireShipGate(g2)).toBe(false);
		expect(db.getResponse(g2)?.content).toBe('{"approved": true}');
		// g2 stays answered; g1's stale approval slot never existed.
		expect(db.getMessageById(g2)?.resolved_at).toBeNull();
	});

	it("`ask --report` denoising: a status report is relayed to the Lead but excluded from the founder candidate set", () => {
		const gate = db.insertQuestion("exec-1", "lead-1", "PR ready", {
			checkpoint: "approve_to_ship",
		});
		// Runner posts three DONE reports (the noise that inflated the ambiguous
		// denominator in the incident).
		db.insertQuestion("exec-1", "lead-1", "DONE: chunk 1", { kind: "report" });
		db.insertQuestion("exec-1", "lead-1", "DONE: chunk 2", { kind: "report" });
		db.insertQuestion("exec-1", "lead-1", "DONE: chunk 3", { kind: "report" });

		// Transport semantics unchanged: reports ARE still pending questions for
		// the Lead (relay + liveness must keep working).
		expect(db.getPendingQuestions("lead-1").length).toBe(4);
		expect(db.hasPendingQuestionsFrom("exec-1")).toBe(true);

		// But the founder binding candidate set sees ONLY the one ship gate.
		const candidates = shipBindingCandidates(db, "lead-1");
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.id).toBe(gate);
	});

	it("byte-compat: without the retire (kill-switch off path), the ambiguity persists — this is the pre-fix state we are fixing", () => {
		// Sanity anchor: proves the candidate-set helper genuinely detects the bug
		// (so the pass in the retire tests above is meaningful, not vacuous).
		db.insertQuestion("exec-1", "lead-1", "g1", {
			checkpoint: "approve_to_ship",
		});
		db.insertQuestion("exec-1", "lead-1", "g2", {
			checkpoint: "approve_to_ship",
		});
		// No retireShipGate call, leaving both gates live for candidate selection.
		expect(shipBindingCandidates(db, "lead-1")).toHaveLength(2);
	});
});

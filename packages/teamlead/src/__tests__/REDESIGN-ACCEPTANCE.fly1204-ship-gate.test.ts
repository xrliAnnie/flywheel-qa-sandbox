/**
 * ██  THIS TEST IS SUPPOSED TO FAIL.  ██
 *
 * It is not broken. It is not flaky. It is not "to be fixed later" by deleting it.
 * It is the ACCEPTANCE LINE for the FLY-1204 / FLY-1221 redesign, and it is RED on purpose.
 *
 * **When it goes GREEN, the redesign is done. Until then, it must stay RED.**
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHY IT EXISTS
 *
 * Everything green lied to us. Over one night, in this issue alone, the same bug class was
 * caught five times — each time wearing a better disguise:
 *
 *   role   standing in for the directory        (a session's worktree)
 *   status standing in for liveness             (failed/blocked KEEP their tmux)
 *   marker standing in for evidence             ("I am the QA phase" ≠ "the QA passed")
 *   a one-shot snapshot standing in for a continuing fact
 *   a self-declaration standing in for verifiable evidence
 *
 * Seven tests in this repo were, at one point, GREEN while certifying a ship-gate bypass:
 * they asserted that a three-stage `qa` phase may ship with no QA evidence at all, and
 * seeded none. One of them predated the work that was supposed to fix the bug. A green test
 * that certifies a bypass is worse than no test.
 *
 * So the redesign gets exactly one test it cannot lie to, and it is this one. It is RED.
 * Red does not flatter anybody.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INVARIANT THE REDESIGN MUST DELIVER
 *
 *   **The head that ships must have a QA that passed FOR THAT HEAD.**
 *
 * Two things make that impossible to express in the current shape, and both are proven
 * below:
 *
 *   1. `qa_required` is a WRITE-ONCE snapshot (`UPDATE ... WHERE qa_required IS NULL`),
 *      while the head MOVES. A `0` written when the QA passed for H1 survives the QA
 *      FAILING and the head advancing to H2 — and `ship-eligibility.ts` reads `0` as an
 *      outright pass. Once 0, always 0. A one-way door cannot carry a fact that expires.
 *
 *   2. The QA verdict is a RUNNER SELF-DECLARATION. Every runner shares one ingest bearer
 *      and the CLI hands the caller both `--exec-id` and `--pr-head`, so any runner can
 *      claim a PASS for any head. That is an opinion box, not a gate. (Codex R13 HIGH-3.)
 *
 * A correct redesign must verify the PASS against the CURRENT head AT SHIP TIME (or key the
 * QA evidence by head), and the evidence must be server-verifiable — not compressed into a
 * headless boolean, and not asserted by the party being verified.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DO NOT "FIX" THIS FILE BY WEAKENING IT.
 * If you make it green by loosening the assertion, you have rebuilt the bypass.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateQaShipGate } from "flywheel-comm/ship-eligibility";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

/** The head the QA actually tested and passed. */
const H1 = "1".repeat(40);
/** The head that exists after the fix-loop pushed new commits. QA never saw it. */
const H2 = "2".repeat(40);

describe("FLY-1204 REDESIGN ACCEPTANCE — the ship gate must refuse a head whose QA did not pass", () => {
	it("REFUSES a head whose QA FAILED (currently PASSES it — this is the bug)", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "fly1204-acceptance-")),
			"state.db",
		);
		const store = await StateStore.create(dbPath);

		store.upsertSession({
			execution_id: "qa-phase",
			issue_id: "FLY-1204",
			project_name: "proj",
			status: "awaiting_review",
			session_role: "qa",
			chat_thread_role: "qa",
			pr_number: 571,
		});
		store.patchSessionMetadata("qa-phase", { pr_head_sha: H1 });

		// ① The QA genuinely PASSED for H1. The exemption is written. This part is CORRECT.
		store.setQaRequiredSnapshot({
			executionId: "qa-phase",
			required: 0,
			reason: "three_stage_phase:qa",
		});

		// ② Founder feedback → the QA FAILS → Implement fixes → the head ADVANCES to H2.
		//    The PASS evidence is dutifully cleared…
		store.setSessionParams("qa-phase", {
			three_stage_verdict: {
				status: "fail",
				event_id: "f1",
				at: "2026-07-13T00:00:00Z",
			},
		});
		store.patchSessionMetadata("qa-phase", { pr_head_sha: H2 });
		//    …but the snapshot is WRITE-ONCE, so the truthful value cannot be written back:
		store.setQaRequiredSnapshot({
			executionId: "qa-phase",
			required: 1,
			reason: "the-truth-that-cannot-be-recorded",
		});
		store.save();

		const row = store.getSession("qa-phase");
		expect(row?.pr_head_sha).toBe(H2);
		expect(row?.qa_required).toBe(0); // the one-way door: still 0, for a head QA never saw

		// ③ THE GATE, on the NEW head, whose QA FAILED, reading the real DB:
		const verdict = evaluateQaShipGate({
			execId: "qa-phase",
			prHead: H2,
			stateDbPath: dbPath,
			// Pin the rollback switch so a developer's live ~/.flywheel/.env cannot
			// substitute production emergency state for this acceptance fact.
			env: {
				FLYWHEEL_QA_DONE_GATE: "1",
				FLYWHEEL_WORKFLOW_FORCE_LEGACY: "0",
			},
		});

		// ────────────────────────────────────────────────────
		// THIS IS THE LINE. It fails today. It must pass when the redesign lands.
		//
		// Today: passed=true, reason="qa_not_required".
		// The gate waves through a head whose QA failed and never ran, because a `0` written
		// for a DIFFERENT head is immovable and headless.
		expect(verdict.passed).toBe(false);
		expect(verdict.reason).not.toBe("qa_not_required");
		// ────────────────────────────────────────────────────
	});
});

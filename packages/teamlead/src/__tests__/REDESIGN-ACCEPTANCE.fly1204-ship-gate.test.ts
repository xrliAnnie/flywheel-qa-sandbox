/**
 * FLY-1204 / FLY-1221 acceptance line, closed by FLY-1981.
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
 * they asserted that a DAG workflow `qa` phase may ship with no QA evidence at all, and
 * seeded none. One of them predated the work that was supposed to fix the bug. A green test
 * that certifies a bypass is worse than no test.
 *
 * So the redesign gets exactly one test it cannot lie to, and it is this one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INVARIANT THE REDESIGN MUST DELIVER
 *
 *   **The head that ships must have a QA that passed FOR THAT HEAD.**
 *
 * Two things made that impossible to express in the old shape:
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
 * FLY-1981 removes the configurable gate bypass and retires the auto-QA writer.
 * A durable DAG QA session is therefore evaluated from head-bound claims and
 * must never fall back to a stale historical `qa_required=0` snapshot. This test
 * keeps the moving-head scenario as a regression sentinel for that contract.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateQaShipGate } from "flywheel-comm/ship-eligibility";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { setHistoricalQaRequiredSnapshot } from "./helpers/historical-qa.js";

/** The head the QA actually tested and passed. */
const H1 = "1".repeat(40);
/** The head that exists after the fix-loop pushed new commits. QA never saw it. */
const H2 = "2".repeat(40);

describe("FLY-1204 REDESIGN ACCEPTANCE — the ship gate must refuse a head whose QA did not pass", () => {
	it("refuses a moved head even when a stale historical exemption exists", async () => {
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

		// ① A historical caller tries to persist the old QA-node exemption for H1.
		setHistoricalQaRequiredSnapshot(store, {
			executionId: "qa-phase",
			required: 0,
			reason: "workflow_node:qa",
		});
		expect(store.getSession("qa-phase")?.qa_required).toBe(0);

		// ② Founder feedback → the QA FAILS → Implement fixes → the head ADVANCES to H2.
		//    The head-bound verdict records the failure.
		store.setSessionParams("qa-phase", {
			workflow_verdict: {
				status: "fail",
				event_id: "f1",
				at: "2026-07-13T00:00:00Z",
			},
		});
		store.patchSessionMetadata("qa-phase", { pr_head_sha: H2 });
		store.save();

		const row = store.getSession("qa-phase");
		expect(row?.pr_head_sha).toBe(H2);
		expect(row?.qa_required).toBe(0);

		// ③ THE GATE, on the NEW head, whose QA FAILED, reading the real DB:
		const verdict = evaluateQaShipGate({
			execId: "qa-phase",
			prHead: H2,
			stateDbPath: dbPath,
		});

		// ────────────────────────────────────────────────────
		// The hard gate refuses the moved head: there is no configurable
		// `qa_not_required` escape hatch left.
		expect(verdict.passed).toBe(false);
		expect(verdict.reason).toBe("qa_claim_gate_unenrolled_failclosed");
		// ────────────────────────────────────────────────────
	});
});

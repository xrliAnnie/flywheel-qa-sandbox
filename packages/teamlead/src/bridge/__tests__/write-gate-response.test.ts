/**
 * FLY-799 Part A-4 — shared writeGateResponseAndRunPostWrite (RED first).
 *
 * The ONE trusted write primitive for approve_to_ship gate responses, shared by
 * Surface B (gate-response-router) and the founder-reply path (Codex R1 #3), so
 * the two can never drift into subtly-different approval semantics. Guards:
 * checkpoint == approve_to_ship, questionId == the session's current review
 * question, session in awaiting_review (or already approved_to_ship, idempotent),
 * prior identical answer re-runs the hook, conflicting prior answer is rejected.
 * `retrySafe` tells the founder-reply caller whether it may advance its cursor:
 * false only when the response was written but the post-write hook did not reach
 * a safe state (so it re-runs next pass — the hook is idempotent).
 */

import { describe, expect, it, vi } from "vitest";
import { writeGateResponseAndRunPostWrite } from "../approval-signal/write-gate-response.js";

const APPROVE = '{"approved": true}';

function fakeDb(
	question: { checkpoint: string | null; from_agent: string } | undefined,
	priorResponse?: { content: string; from_agent: string },
) {
	const responses = new Map<string, { content: string; from_agent: string }>();
	if (priorResponse) responses.set("Q-1", priorResponse);
	return {
		getMessageById: vi.fn().mockReturnValue(question),
		getResponse: vi.fn((id: string) => responses.get(id)),
		insertResponse: vi.fn((id: string, from: string, content: string) => {
			responses.set(id, { content, from_agent: from });
		}),
		_responses: responses,
	};
}

const store = (status?: string) => ({
	getSession: vi.fn().mockReturnValue(status ? { status } : undefined),
});

const baseArgs = {
	questionId: "Q-1",
	executionId: "E-1",
	source: "text" as const,
	actor: "founder-discord",
	answer: APPROVE,
	expectedCurrentReviewQuestionId: "Q-1",
};

describe("writeGateResponseAndRunPostWrite — happy path", () => {
	it("writes the approval and runs the post-write hook (retrySafe)", async () => {
		const db = fakeDb({ checkpoint: "approve_to_ship", from_agent: "E-1" });
		const onResponseWritten = vi.fn().mockResolvedValue({ ok: true });
		const r = await writeGateResponseAndRunPostWrite({
			...baseArgs,
			db,
			store: store("awaiting_review"),
			onResponseWritten,
		});
		expect(r).toMatchObject({ written: true, retrySafe: true });
		expect(db.insertResponse).toHaveBeenCalledWith(
			"Q-1",
			"founder-discord",
			APPROVE,
		);
		expect(onResponseWritten).toHaveBeenCalledOnce();
	});

	it("hook failure after write → retrySafe:false (re-run next pass)", async () => {
		const db = fakeDb({ checkpoint: "approve_to_ship", from_agent: "E-1" });
		const r = await writeGateResponseAndRunPostWrite({
			...baseArgs,
			db,
			store: store("awaiting_review"),
			onResponseWritten: vi.fn().mockResolvedValue({ ok: false }),
		});
		expect(r).toMatchObject({ written: true, retrySafe: false });
	});
});

describe("writeGateResponseAndRunPostWrite — guards (no write)", () => {
	it("rejects a non approve_to_ship checkpoint", async () => {
		const db = fakeDb({ checkpoint: "brainstorm", from_agent: "E-1" });
		const r = await writeGateResponseAndRunPostWrite({
			...baseArgs,
			db,
			store: store("awaiting_review"),
		});
		expect(r.written).toBe(false);
		expect(db.insertResponse).not.toHaveBeenCalled();
	});

	it("rejects a stale (non-current) review question", async () => {
		const db = fakeDb({ checkpoint: "approve_to_ship", from_agent: "E-1" });
		const r = await writeGateResponseAndRunPostWrite({
			...baseArgs,
			db,
			store: store("awaiting_review"),
			expectedCurrentReviewQuestionId: "Q-DIFFERENT",
		});
		expect(r.written).toBe(false);
		expect(db.insertResponse).not.toHaveBeenCalled();
	});

	it("rejects when the session is not awaiting_review / approved_to_ship", async () => {
		const db = fakeDb({ checkpoint: "approve_to_ship", from_agent: "E-1" });
		const r = await writeGateResponseAndRunPostWrite({
			...baseArgs,
			db,
			store: store("running"),
		});
		expect(r.written).toBe(false);
		expect(db.insertResponse).not.toHaveBeenCalled();
	});

	it("missing question → no write", async () => {
		const db = fakeDb(undefined);
		const r = await writeGateResponseAndRunPostWrite({
			...baseArgs,
			db,
			store: store("awaiting_review"),
		});
		expect(r.written).toBe(false);
		expect(db.insertResponse).not.toHaveBeenCalled();
	});
});

describe("writeGateResponseAndRunPostWrite — idempotency (Codex R2 HIGH-2)", () => {
	it("prior identical approval → re-runs hook, does NOT double-write", async () => {
		const db = fakeDb(
			{ checkpoint: "approve_to_ship", from_agent: "E-1" },
			{ content: APPROVE, from_agent: "founder-discord" },
		);
		const onResponseWritten = vi.fn().mockResolvedValue({ ok: true });
		const r = await writeGateResponseAndRunPostWrite({
			...baseArgs,
			db,
			store: store("approved_to_ship"),
			holdReasonFor: () => "merge_block",
			onResponseWritten,
		});
		expect(db.insertResponse).not.toHaveBeenCalled();
		expect(onResponseWritten).toHaveBeenCalledOnce();
		expect(r.retrySafe).toBe(true);
		expect(r.disposition).toBe("already_applied");
	});

	it("conflicting prior feedback → rejected (a different decision needs a new round)", async () => {
		const db = fakeDb(
			{ checkpoint: "approve_to_ship", from_agent: "E-1" },
			{ content: '{"approved": false}', from_agent: "lead" },
		);
		const r = await writeGateResponseAndRunPostWrite({
			...baseArgs,
			db,
			store: store("awaiting_review"),
		});
		expect(r.written).toBe(false);
		expect(db.insertResponse).not.toHaveBeenCalled();
	});
});

describe("writeGateResponseAndRunPostWrite — live review binding (Codex R1 HIGH-2)", () => {
	it("refuses when the LIVE review_question_id no longer matches (re-review during eval)", async () => {
		const db = fakeDb({ checkpoint: "approve_to_ship", from_agent: "E-1" });
		const liveStore = {
			getSession: vi.fn().mockReturnValue({
				status: "awaiting_review",
				review_question_id: "Q-NEW", // session re-bound to a newer gate
			}),
		};
		const r = await writeGateResponseAndRunPostWrite({
			...baseArgs, // questionId: "Q-1"
			db,
			store: liveStore,
		});
		expect(r.written).toBe(false);
		expect(r.reason).toBe("stale_review_question_live");
		expect(db.insertResponse).not.toHaveBeenCalled();
	});

	it("writes when the LIVE review_question_id still matches the gate", async () => {
		const db = fakeDb({ checkpoint: "approve_to_ship", from_agent: "E-1" });
		const liveStore = {
			getSession: vi.fn().mockReturnValue({
				status: "awaiting_review",
				review_question_id: "Q-1",
			}),
		};
		const r = await writeGateResponseAndRunPostWrite({
			...baseArgs,
			db,
			store: liveStore,
			onResponseWritten: vi.fn().mockResolvedValue({ ok: true }),
		});
		expect(r.written).toBe(true);
	});
});

describe("writeGateResponseAndRunPostWrite — FLY-1244 founder boundary", () => {
	it("runs the route-scoped card authority hook before a fresh approval write", async () => {
		const db = fakeDb({ checkpoint: "approve_to_ship", from_agent: "E-1" });
		const cardAuthority = vi.fn().mockReturnValue({
			ok: false,
			reason: "inactive_card",
		});
		const args = {
			...baseArgs,
			db,
			store: store("awaiting_review"),
			source: "reaction",
			targetMessageId: "M-1",
			cardAuthority,
		} as Parameters<typeof writeGateResponseAndRunPostWrite>[0] & {
			source: "reaction";
			targetMessageId: string;
			cardAuthority: (input: {
				executionId: string;
				source: "reaction";
				targetMessageId?: string;
			}) => { ok: true } | { ok: false; reason: string };
		};

		const r = await writeGateResponseAndRunPostWrite(args);

		expect(cardAuthority).toHaveBeenCalledWith({
			executionId: "E-1",
			source: "reaction",
			targetMessageId: "M-1",
		});
		expect(r).toMatchObject({
			written: false,
			retrySafe: true,
			disposition: "reject",
			reason: "card_authority_inactive_card",
		});
		expect(db.insertResponse).not.toHaveBeenCalled();
	});

	it("returns defer before any write while Codex or QA still holds review", async () => {
		const db = fakeDb({ checkpoint: "approve_to_ship", from_agent: "E-1" });
		const r = await writeGateResponseAndRunPostWrite({
			...baseArgs,
			db,
			store: store("awaiting_review"),
			holdReasonFor: () => "qa_not_green",
		});
		expect(r).toMatchObject({ written: false, disposition: "defer" });
		expect(db.insertResponse).not.toHaveBeenCalled();
	});

	it.each([
		"qa_evidence_missing",
		"qa_evidence_unknown",
		"no_qualified_reviewer",
	] as const)("returns reject for NEVER-deferrable hold %s", async (reason) => {
		const db = fakeDb({ checkpoint: "approve_to_ship", from_agent: "E-1" });
		const r = await writeGateResponseAndRunPostWrite({
			...baseArgs,
			db,
			store: store("awaiting_review"),
			holdReasonFor: () => reason as never,
		});
		expect(r).toMatchObject({
			written: false,
			disposition: "reject",
			reason: `held_${reason}`,
		});
		expect(db.insertResponse).not.toHaveBeenCalled();
	});

	it("returns reject before any write for a merge-block hold", async () => {
		const db = fakeDb({ checkpoint: "approve_to_ship", from_agent: "E-1" });
		const r = await writeGateResponseAndRunPostWrite({
			...baseArgs,
			db,
			store: store("awaiting_review"),
			holdReasonFor: () => "merge_block",
		});
		expect(r).toMatchObject({ written: false, disposition: "reject" });
		expect(db.insertResponse).not.toHaveBeenCalled();
	});

	it("uses the atomic source writer only for trusted structured approval", async () => {
		const db = {
			...fakeDb({ checkpoint: "approve_to_ship", from_agent: "E-1" }),
			insertFounderApprovalResponseWithSource: vi.fn().mockReturnValue(true),
		};
		const r = await writeGateResponseAndRunPostWrite({
			...baseArgs,
			actor: "bridge",
			db,
			store: store("awaiting_review"),
			founderId: "founder-discord",
			founderSource: {
				project: "flywheel",
				runId: "run-1",
				issueId: "FLY-1244",
				approvedHead: "a".repeat(40),
				classification: "dashboard_founder_action",
				authorityId: "Q-1",
			},
		});
		expect(r).toMatchObject({ written: true, disposition: "written" });
		expect(db.insertFounderApprovalResponseWithSource).toHaveBeenCalledOnce();
		expect(db.insertResponse).not.toHaveBeenCalled();
	});

	it("never emits a founder source event for feedback or an untrusted actor", async () => {
		const db = {
			...fakeDb({ checkpoint: "approve_to_ship", from_agent: "E-1" }),
			insertFounderApprovalResponseWithSource: vi.fn().mockReturnValue(true),
		};
		await writeGateResponseAndRunPostWrite({
			...baseArgs,
			actor: "lead",
			db,
			store: store("awaiting_review"),
			founderId: "founder-discord",
			founderSource: {
				project: "flywheel",
				runId: "run-1",
				issueId: "FLY-1244",
				approvedHead: "a".repeat(40),
				classification: "audit_only",
				authorityId: "Q-1",
			},
		});
		expect(db.insertFounderApprovalResponseWithSource).not.toHaveBeenCalled();
		expect(db.insertResponse).toHaveBeenCalledOnce();
	});
});

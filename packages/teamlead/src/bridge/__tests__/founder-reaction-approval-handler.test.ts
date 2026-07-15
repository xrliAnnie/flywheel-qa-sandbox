/**
 * FLY-799 — founder REACTION ship-approval handler (RED first).
 *
 * The per-gate analog of the text handler: a founder ✅ on the durably-bound
 * ship-gate message is a zero-AI approval. Narrows to the CURRENT review
 * question of an awaiting_review session with a known pr_head + a stored
 * binding, evaluates the reaction, and (on ✅) writes {"approved":true}
 * attributed to the canonical founder via the shared write helper.
 */

import { describe, expect, it, vi } from "vitest";
import { tryFounderReactionApproval } from "../approval-signal/founder-reaction-approval-handler.js";

const BINDING = {
	questionId: "Q-1",
	executionId: "E-1",
	issueId: "I",
	prHeadSha: "sha-1",
	threadId: "T",
	gateMessageId: "GATEMSG-1",
	checkpoint: "approve_to_ship",
	postedAt: "2026-07-02T00:00:00.000Z",
};

const gate = {
	questionId: "Q-1",
	executionId: "E-1",
	checkpoint: "approve_to_ship",
	createdAtMs: 1,
};
const ctx = {
	issueId: "I",
	threadId: "T",
	projectName: "proj",
	projectRoot: "/repo",
};

function make(over: Record<string, unknown> = {}) {
	const session = {
		status: "awaiting_review",
		review_question_id: "Q-1",
		pr_head_sha: "sha-1",
		pr_number: 42,
		issue_identifier: "FLY-1",
	};
	const store = { getSession: vi.fn().mockReturnValue(session) };
	const writeGateResponseImpl = vi
		.fn()
		.mockResolvedValue({ written: true, retrySafe: true });
	const evaluateReactionImpl = vi.fn().mockResolvedValue({
		source: "reaction",
		kind: "approve",
		questionId: "Q-1",
		prHeadSha: "sha-1",
		targetMessageId: "GATEMSG-1",
		emoji: "✅",
		reactorUserId: "FOUNDER-1",
	});
	const deps = {
		canonicalFounderId: "FOUNDER-1",
		store,
		db: {} as never,
		reactionFetcherImpl: vi.fn(),
		readBindingImpl: vi.fn().mockReturnValue(BINDING),
		evaluateReactionImpl,
		writeGateResponseImpl,
		...over,
	};
	return { deps, store, writeGateResponseImpl, evaluateReactionImpl };
}

describe("tryFounderReactionApproval", () => {
	it("founder ✅ on the bound gate message → writes {approved:true} attributed to founder", async () => {
		const cardAuthority = vi.fn().mockReturnValue({ ok: true });
		const { deps, writeGateResponseImpl } = make({ cardAuthority });
		const r = await tryFounderReactionApproval({ gate, ctx }, deps as never);
		expect(r).toEqual({ handled: ["Q-1"], retrySafe: true });
		expect(writeGateResponseImpl).toHaveBeenCalledOnce();
		const w = writeGateResponseImpl.mock.calls[0][0];
		expect(w.actor).toBe("FOUNDER-1");
		expect(JSON.parse(w.answer).approved).toBe(true);
		expect(w.questionId).toBe("Q-1");
		expect(w).toMatchObject({
			source: "reaction",
			targetMessageId: "GATEMSG-1",
			cardAuthority,
		});
	});

	it("passes the bound targetMessageId to the reaction evaluator", async () => {
		const { deps, evaluateReactionImpl } = make();
		await tryFounderReactionApproval({ gate, ctx }, deps as never);
		const boundGate = evaluateReactionImpl.mock.calls[0][0];
		expect(boundGate.targetMessageId).toBe("GATEMSG-1");
		expect(boundGate.canonicalFounderId).toBe("FOUNDER-1");
		expect(boundGate.prHeadSha).toBe("sha-1");
	});

	it("no ✅ yet (evaluator → null) → returns null, no write", async () => {
		const { deps, writeGateResponseImpl } = make({
			evaluateReactionImpl: vi.fn().mockResolvedValue(null),
		});
		const r = await tryFounderReactionApproval({ gate, ctx }, deps as never);
		expect(r).toBeNull();
		expect(writeGateResponseImpl).not.toHaveBeenCalled();
	});

	it("no stored binding → null (never infer a reaction target)", async () => {
		const { deps, writeGateResponseImpl } = make({
			readBindingImpl: vi.fn().mockReturnValue(null),
		});
		const r = await tryFounderReactionApproval({ gate, ctx }, deps as never);
		expect(r).toBeNull();
		expect(writeGateResponseImpl).not.toHaveBeenCalled();
	});

	it("session not awaiting_review → null (A-2 narrow)", async () => {
		const { deps, writeGateResponseImpl } = make({
			store: {
				getSession: vi.fn().mockReturnValue({
					status: "approved_to_ship",
					review_question_id: "Q-1",
					pr_head_sha: "sha-1",
				}),
			},
		});
		const r = await tryFounderReactionApproval({ gate, ctx }, deps as never);
		expect(r).toBeNull();
		expect(writeGateResponseImpl).not.toHaveBeenCalled();
	});

	it("review_question_id !== gate question → null (stale gate)", async () => {
		const { deps, writeGateResponseImpl } = make({
			store: {
				getSession: vi.fn().mockReturnValue({
					status: "awaiting_review",
					review_question_id: "Q-OTHER",
					pr_head_sha: "sha-1",
				}),
			},
		});
		const r = await tryFounderReactionApproval({ gate, ctx }, deps as never);
		expect(r).toBeNull();
		expect(writeGateResponseImpl).not.toHaveBeenCalled();
	});

	it("no pr_head_sha → null", async () => {
		const { deps, writeGateResponseImpl } = make({
			store: {
				getSession: vi.fn().mockReturnValue({
					status: "awaiting_review",
					review_question_id: "Q-1",
				}),
			},
		});
		const r = await tryFounderReactionApproval({ gate, ctx }, deps as never);
		expect(r).toBeNull();
		expect(writeGateResponseImpl).not.toHaveBeenCalled();
	});

	it("write reached durable state but post-write hook failed → retrySafe:false", async () => {
		const { deps } = make({
			writeGateResponseImpl: vi
				.fn()
				.mockResolvedValue({ written: false, retrySafe: false }),
		});
		const r = await tryFounderReactionApproval({ gate, ctx }, deps as never);
		expect(r).toEqual({ handled: [], retrySafe: false });
	});
});

describe("tryFounderReactionApproval — hold guard (FLY-1041 Chunk 5, Codex R2 note 2)", () => {
	it("held + founder ✅ → exactly one held_declined audit, NO write, null", async () => {
		const auditSink = vi.fn();
		const { deps, writeGateResponseImpl } = make({
			isHeld: vi.fn().mockReturnValue(true),
			auditSink,
		});
		const r = await tryFounderReactionApproval({ gate, ctx }, deps as never);
		expect(r).toBeNull();
		expect(writeGateResponseImpl).not.toHaveBeenCalled();
		const heldCalls = auditSink.mock.calls.filter(
			(c) => c[0] === "held_declined",
		);
		expect(heldCalls).toHaveLength(1);
	});

	it("held + NO ✅ (evaluator null) → ZERO held_declined audits (no noise per tick)", async () => {
		const auditSink = vi.fn();
		const { deps, writeGateResponseImpl } = make({
			isHeld: vi.fn().mockReturnValue(true),
			auditSink,
			evaluateReactionImpl: vi.fn().mockResolvedValue(null),
		});
		const r = await tryFounderReactionApproval({ gate, ctx }, deps as never);
		expect(r).toBeNull();
		expect(writeGateResponseImpl).not.toHaveBeenCalled();
		expect(
			auditSink.mock.calls.filter((c) => c[0] === "held_declined"),
		).toHaveLength(0);
	});

	it("un-held + founder ✅ → write proceeds (byte-compat)", async () => {
		const { deps, writeGateResponseImpl } = make({
			isHeld: vi.fn().mockReturnValue(false),
		});
		const r = await tryFounderReactionApproval({ gate, ctx }, deps as never);
		expect(r).toEqual({ handled: ["Q-1"], retrySafe: true });
		expect(writeGateResponseImpl).toHaveBeenCalledOnce();
	});
});

describe("tryFounderReactionApproval — FLY-1238 merged guard", () => {
	it("MERGED suppresses the response write without reporting handled", async () => {
		const { deps, writeGateResponseImpl } = make({
			mergedGateGuard: vi.fn().mockResolvedValue({
				kind: "suppress_merged",
				cleanupComplete: true,
			}),
		});
		const result = await tryFounderReactionApproval(
			{ gate, ctx },
			deps as never,
		);
		expect(result).toEqual({ handled: [], retrySafe: true });
		expect(writeGateResponseImpl).not.toHaveBeenCalled();
	});

	it("UNKNOWN remains retryable and does not write", async () => {
		const { deps, writeGateResponseImpl } = make({
			mergedGateGuard: vi.fn().mockResolvedValue({
				kind: "retry_later",
				reason: "unknown",
			}),
		});
		const result = await tryFounderReactionApproval(
			{ gate, ctx },
			deps as never,
		);
		expect(result).toEqual({ handled: [], retrySafe: false });
		expect(writeGateResponseImpl).not.toHaveBeenCalled();
	});
});

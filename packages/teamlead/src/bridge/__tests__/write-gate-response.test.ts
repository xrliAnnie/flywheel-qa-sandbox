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
			onResponseWritten,
		});
		expect(db.insertResponse).not.toHaveBeenCalled();
		expect(onResponseWritten).toHaveBeenCalledOnce();
		expect(r.retrySafe).toBe(true);
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

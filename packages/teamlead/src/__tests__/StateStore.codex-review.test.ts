/**
 * FLY-827: codex_review_record durable gate methods.
 *
 * The record is the AUTHORITATIVE "did Codex code review APPROVE this exact head?"
 * source (not a PR comment). Key invariants tested here:
 *   - recordCodexReviewApproved is INSERT-OR-APPROVE (works with NO pending row) — R1 HIGH-1
 *   - approved is idempotent + preserves audit fields (COALESCE) — R2 LOW-4
 *   - skipped is never overwritten by an approval
 *   - pending never downgrades an approved/skipped row
 *   - sha comparison is case-normalized
 */

import { beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("StateStore — FLY-827 codex_review_record", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("recordCodexReviewApproved creates an approved row when NO pending row exists (R1 HIGH-1)", () => {
		expect(store.isCodexCodeReviewApproved("exec1", SHA_A)).toBe(false);
		const ok = store.recordCodexReviewApproved({
			executionId: "exec1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
			verdictEventId: "evt-1",
			reviewedTarget: "https://github.com/x/y/pull/1",
			rounds: 2,
		});
		expect(ok).toBe(true);
		expect(store.isCodexCodeReviewApproved("exec1", SHA_A)).toBe(true);
		const rec = store.getCodexReviewRecord("exec1", SHA_A);
		expect(rec?.status).toBe("approved");
		expect(rec?.verdict_event_id).toBe("evt-1");
		expect(rec?.rounds).toBe(2);
		expect(rec?.approved_at).toBeTruthy();
	});

	it("migrates a pending row to approved", () => {
		store.upsertCodexReviewPending({
			executionId: "exec1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
		});
		expect(store.getCodexReviewRecord("exec1", SHA_A)?.status).toBe("pending");
		expect(store.isCodexCodeReviewApproved("exec1", SHA_A)).toBe(false);
		store.recordCodexReviewApproved({
			executionId: "exec1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
			verdictEventId: "evt-1",
		});
		expect(store.isCodexCodeReviewApproved("exec1", SHA_A)).toBe(true);
	});

	it("approved is idempotent and preserves original audit fields on replay (R2 LOW-4)", () => {
		store.recordCodexReviewApproved({
			executionId: "exec1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
			verdictEventId: "evt-first",
			reviewedTarget: "target-first",
		});
		const first = store.getCodexReviewRecord("exec1", SHA_A);
		// Replay with different metadata — must NOT overwrite the original.
		store.recordCodexReviewApproved({
			executionId: "exec1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
			verdictEventId: "evt-second",
			reviewedTarget: "target-second",
		});
		const second = store.getCodexReviewRecord("exec1", SHA_A);
		expect(second?.status).toBe("approved");
		expect(second?.verdict_event_id).toBe("evt-first");
		expect(second?.reviewed_target).toBe("target-first");
		expect(second?.approved_at).toBe(first?.approved_at);
	});

	it("skipped is never overwritten by an approval, and satisfies the gate", () => {
		store.markCodexReviewSkipped({
			executionId: "exec1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
		});
		expect(store.isCodexCodeReviewApproved("exec1", SHA_A)).toBe(true);
		store.recordCodexReviewApproved({
			executionId: "exec1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
			verdictEventId: "evt-1",
		});
		expect(store.getCodexReviewRecord("exec1", SHA_A)?.status).toBe("skipped");
	});

	it("pending never downgrades an already-approved row", () => {
		store.recordCodexReviewApproved({
			executionId: "exec1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
		});
		store.upsertCodexReviewPending({
			executionId: "exec1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
		});
		expect(store.getCodexReviewRecord("exec1", SHA_A)?.status).toBe("approved");
	});

	it("keys by (exec, head): a different head is not approved", () => {
		store.recordCodexReviewApproved({
			executionId: "exec1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
		});
		expect(store.isCodexCodeReviewApproved("exec1", SHA_A)).toBe(true);
		expect(store.isCodexCodeReviewApproved("exec1", SHA_B)).toBe(false);
	});

	it("normalizes sha case on write and read", () => {
		const upper = SHA_A.toUpperCase();
		store.recordCodexReviewApproved({
			executionId: "exec1",
			targetPrHeadSha: upper,
			issueId: "FLY-1",
			projectName: "proj",
		});
		expect(store.isCodexCodeReviewApproved("exec1", SHA_A)).toBe(true);
		expect(store.isCodexCodeReviewApproved("exec1", upper)).toBe(true);
	});
});

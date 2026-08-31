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

describe("StateStore — FLY-1278 frozen review payload", () => {
	it("persists reviewer/effective verdict split and the exact canonical response", async () => {
		const store = await StateStore.create(":memory:");
		store.insertCodexReviewJob({
			requestId: "r1",
			executionId: "e1",
			issueId: "FLY-1278",
			projectName: "proj",
			reviewType: "code",
			questionId: "q1",
		});
		const responseJson = JSON.stringify({ reviewVerdict: "APPROVED" });
		store.completeCodexReviewJob("r1", "APPROVED", "[]", {
			reviewerVerdict: "CHANGES_REQUESTED",
			advisoriesJson: "[]",
			settledJson: "[]",
			responseJson,
			payloadVersion: 2,
		});

		expect(store.getCodexReviewJob("r1")).toMatchObject({
			verdict: "APPROVED",
			reviewer_verdict: "CHANGES_REQUESTED",
			advisories_json: "[]",
			settled_json: "[]",
			response_json: responseJson,
			payload_version: 2,
		});
	});

	it("keeps the legacy completion call byte-compatible", async () => {
		const store = await StateStore.create(":memory:");
		store.insertCodexReviewJob({
			requestId: "r1",
			executionId: "e1",
			projectName: "proj",
			reviewType: "design",
			questionId: "q1",
		});
		store.completeCodexReviewJob("r1", "CHANGES_REQUESTED", "[]");

		expect(store.getCodexReviewJob("r1")).toMatchObject({
			verdict: "CHANGES_REQUESTED",
		});
		expect(store.getCodexReviewJob("r1")?.payload_version).toBeUndefined();
		expect(store.getCodexReviewJob("r1")?.response_json).toBeUndefined();
	});
});

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

	it("keys by (exec, repo identity, head) so identical cross-repo SHAs coexist", () => {
		store.recordCodexReviewApproved({
			executionId: "exec1",
			targetRepoIdentity: "__main__",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1434",
			projectName: "proj",
		});
		store.recordCodexReviewApproved({
			executionId: "exec1",
			targetRepoIdentity: "acme/fork",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1434",
			projectName: "proj",
		});

		expect(
			store.getCodexReviewRecord("exec1", SHA_A)?.target_repo_identity,
		).toBe("__main__");
		expect(
			store.getCodexReviewRecord("exec1", "acme/fork", SHA_A)
				?.target_repo_identity,
		).toBe("acme/fork");
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

describe("StateStore — FLY-1254 review failure evidence", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	function insertJob(requestId: string) {
		store.insertCodexReviewJob({
			requestId,
			executionId: "exec-failure-raw",
			issueId: "FLY-1254",
			projectName: "flywheel",
			reviewType: "code",
			questionId: `q-${requestId}`,
		});
	}

	it("initializes durable retry and failure-attempt fields", () => {
		insertJob("retry-defaults");
		expect(store.getCodexReviewJob("retry-defaults")).toMatchObject({
			auto_retry_count: 0,
			failure_attempt_count: 0,
		});
		expect(store.getCodexReviewJob("retry-defaults")?.retry_at).toBeUndefined();
	});

	it("atomically records a failure generation and schedules one retry", () => {
		insertJob("retry-scheduled");
		const result = store.recordCodexReviewJobFailure({
			requestId: "retry-scheduled",
			reason: "nonzero_exit",
			failureRaw: "quota evidence",
			retryAt: "2026-08-31T00:10:00.000Z",
		});

		expect(result.updated).toBe(true);
		expect(result.scheduled).toBe(true);
		expect(result.job).toMatchObject({
			status: "failed",
			failure_reason: "nonzero_exit",
			failure_raw: "quota evidence",
			retry_at: "2026-08-31T00:10:00.000Z",
			auto_retry_count: 1,
			failure_attempt_count: 1,
		});
	});

	it("claiming a scheduled retry clears its due time but preserves counters", () => {
		insertJob("retry-claim");
		store.recordCodexReviewJobFailure({
			requestId: "retry-claim",
			reason: "nonzero_exit",
			retryAt: "2026-08-31T00:10:00.000Z",
		});

		expect(store.claimCodexReviewJobRunning("retry-claim")).toBe(true);
		expect(store.getCodexReviewJob("retry-claim")).toMatchObject({
			status: "running",
			auto_retry_count: 1,
			failure_attempt_count: 1,
		});
		expect(store.getCodexReviewJob("retry-claim")?.retry_at).toBeUndefined();
	});

	it("caps automatic retry budget while every failure gets a new generation", () => {
		insertJob("retry-budget");
		const scheduled: boolean[] = [];
		for (let attempt = 1; attempt <= 4; attempt += 1) {
			const result = store.recordCodexReviewJobFailure({
				requestId: "retry-budget",
				reason: "nonzero_exit",
				retryAt: `2026-08-31T00:1${attempt}:00.000Z`,
			});
			scheduled.push(result.scheduled);
			if (attempt < 4) {
				expect(store.claimCodexReviewJobRunning("retry-budget")).toBe(true);
			}
		}

		expect(scheduled).toEqual([true, true, true, false]);
		expect(store.getCodexReviewJob("retry-budget")).toMatchObject({
			status: "failed",
			auto_retry_count: 3,
			failure_attempt_count: 4,
		});
		expect(store.getCodexReviewJob("retry-budget")?.retry_at).toBeUndefined();
	});

	it("lists only scheduled failed jobs in due-time order", () => {
		for (const requestId of ["retry-later", "retry-sooner", "not-scheduled"]) {
			insertJob(requestId);
		}
		store.recordCodexReviewJobFailure({
			requestId: "retry-later",
			reason: "nonzero_exit",
			retryAt: "2026-08-31T00:20:00.000Z",
		});
		store.recordCodexReviewJobFailure({
			requestId: "retry-sooner",
			reason: "nonzero_exit",
			retryAt: "2026-08-31T00:10:00.000Z",
		});
		store.failCodexReviewJob("not-scheduled", "timeout");

		expect(
			store.listScheduledCodexReviewJobs().map((job) => job.request_id),
		).toEqual(["retry-sooner", "retry-later"]);
	});

	it("failure_raw is overwritten by each failure instead of retaining stale evidence", () => {
		insertJob("raw-overwrite");
		store.failCodexReviewJob("raw-overwrite", "no_verdict", "first raw");
		expect(store.getCodexReviewJob("raw-overwrite")).toMatchObject({
			status: "failed",
			failure_reason: "no_verdict",
			failure_raw: "first raw",
		});

		store.failCodexReviewJob("raw-overwrite", "timeout");
		expect(store.getCodexReviewJob("raw-overwrite")).toMatchObject({
			status: "failed",
			failure_reason: "timeout",
		});
		expect(
			store.getCodexReviewJob("raw-overwrite")?.failure_raw,
		).toBeUndefined();
	});

	it("claiming a retry clears the previous failure reason and raw evidence", () => {
		insertJob("raw-claim");
		store.failCodexReviewJob("raw-claim", "nonzero_exit", "diagnostic");
		expect(store.claimCodexReviewJobRunning("raw-claim")).toBe(true);
		expect(store.getCodexReviewJob("raw-claim")).toMatchObject({
			status: "running",
		});
		expect(
			store.getCodexReviewJob("raw-claim")?.failure_reason,
		).toBeUndefined();
		expect(store.getCodexReviewJob("raw-claim")?.failure_raw).toBeUndefined();
	});

	it("completing a retried job clears failure reason and raw evidence", () => {
		insertJob("raw-complete");
		store.failCodexReviewJob("raw-complete", "no_verdict", "diagnostic");
		store.completeCodexReviewJob("raw-complete", "APPROVED", "[]");
		expect(store.getCodexReviewJob("raw-complete")).toMatchObject({
			status: "done",
			verdict: "APPROVED",
		});
		expect(
			store.getCodexReviewJob("raw-complete")?.failure_reason,
		).toBeUndefined();
		expect(
			store.getCodexReviewJob("raw-complete")?.failure_raw,
		).toBeUndefined();
	});

	it("terminal completion removes any outstanding retry schedule", () => {
		insertJob("retry-complete");
		store.recordCodexReviewJobFailure({
			requestId: "retry-complete",
			reason: "nonzero_exit",
			retryAt: "2026-08-31T00:10:00.000Z",
		});
		store.completeCodexReviewJob("retry-complete", "APPROVED", "[]");

		expect(store.getCodexReviewJob("retry-complete")?.status).toBe("done");
		expect(store.getCodexReviewJob("retry-complete")?.retry_at).toBeUndefined();
	});
});

describe("StateStore — FLY-1188 family-aware review authority", () => {
	let store: StateStore;
	const SHA = "c".repeat(40);

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	function registerSession(execId: string, adapterType?: string) {
		store.upsertSession({
			execution_id: execId,
			issue_id: "FLY-1188",
			project_name: "proj",
			status: "running",
			...(adapterType && { adapter_type: adapterType }),
		});
	}

	function approve(
		execId: string,
		families?: {
			author?: string;
			reviewer?: string;
			requestId?: string;
			eventId?: string;
		},
	) {
		return store.recordCodexReviewApproved({
			executionId: execId,
			targetPrHeadSha: SHA,
			issueId: "FLY-1188",
			projectName: "proj",
			verdictEventId: families?.eventId ?? "evt-f",
			...(families?.author && { authorFamily: families.author }),
			...(families?.reviewer && { reviewerFamily: families.reviewer }),
			...(families?.requestId && { requestId: families.requestId }),
		});
	}

	it("cross-family approval (claude author, codex reviewer) satisfies the gate + persists stamps", () => {
		registerSession("exec-cf", "claude-tmux");
		expect(approve("exec-cf", { author: "claude", reviewer: "codex" })).toBe(
			true,
		);
		const rec = store.getCodexReviewRecord("exec-cf", SHA);
		expect(rec?.author_family).toBe("claude");
		expect(rec?.reviewer_family).toBe("codex");
	});

	it("cross-family approval (codex author, claude reviewer) satisfies the gate", () => {
		registerSession("exec-inv", "codex-tmux");
		expect(
			approve("exec-inv", {
				author: "codex",
				reviewer: "claude",
				requestId: "req-1",
			}),
		).toBe(true);
		expect(store.getCodexReviewRecord("exec-inv", SHA)?.request_id).toBe(
			"req-1",
		);
	});

	it("SAME-family approval NEVER satisfies the gate (codex reviewed codex)", () => {
		registerSession("exec-same", "codex-tmux");
		expect(approve("exec-same", { author: "codex", reviewer: "codex" })).toBe(
			false,
		);
		expect(store.isCodexCodeReviewApproved("exec-same", SHA)).toBe(false);
	});

	it("FLY-1224 (T13 ③): SAME-family approval fails the OTHER direction too (claude reviewed claude)", () => {
		// Annie's directive: author family ≠ reviewer family, BOTH directions.
		// Explicit claude/claude stamps beat the grandfather exemption (which
		// only covers UNSTAMPED historical rows).
		registerSession("exec-same-claude", "claude-tmux");
		expect(
			approve("exec-same-claude", { author: "claude", reviewer: "claude" }),
		).toBe(false);
		expect(store.isCodexCodeReviewApproved("exec-same-claude", SHA)).toBe(
			false,
		);
	});

	it("legacy UNSTAMPED approval stays valid for a claude-tmux author (byte-compat)", () => {
		registerSession("exec-legacy-claude", "claude-tmux");
		expect(approve("exec-legacy-claude")).toBe(true);
	});

	it("legacy UNSTAMPED approval stays valid when adapter_type is NULL (pre-FLY-493 session)", () => {
		registerSession("exec-legacy-null");
		expect(approve("exec-legacy-null")).toBe(true);
	});

	it("legacy UNSTAMPED approval FAILS CLOSED for a codex-tmux author", () => {
		registerSession("exec-legacy-codex", "codex-tmux");
		expect(approve("exec-legacy-codex")).toBe(false);
		expect(store.isCodexCodeReviewApproved("exec-legacy-codex", SHA)).toBe(
			false,
		);
	});

	it("skipped satisfies the gate regardless of family (sanctioned governance bypass)", () => {
		registerSession("exec-skip", "codex-tmux");
		store.markCodexReviewSkipped({
			executionId: "exec-skip",
			targetPrHeadSha: SHA,
			issueId: "FLY-1188",
			projectName: "proj",
		});
		expect(store.isCodexCodeReviewApproved("exec-skip", SHA)).toBe(true);
	});

	// R8 MEDIUM recovery: an invalid same-family `approved` row for a head
	// must NOT permanently block a later valid cross-family review of the
	// SAME head — the later explicit stamps are authoritative.
	it("recovery: codex/codex row is corrected by a later codex/claude verdict (same head)", () => {
		registerSession("exec-recover", "codex-tmux");
		expect(
			approve("exec-recover", {
				author: "codex",
				reviewer: "codex",
				requestId: "req-invalid",
			}),
		).toBe(false);
		expect(
			approve("exec-recover", {
				author: "codex",
				reviewer: "claude",
				requestId: "req-valid",
			}),
		).toBe(true);
		const rec = store.getCodexReviewRecord("exec-recover", SHA);
		expect(rec?.reviewer_family).toBe("claude");
		expect(rec?.request_id).toBe("req-valid");
		expect(store.isCodexCodeReviewApproved("exec-recover", SHA)).toBe(true);
	});

	it("legacy caller WITHOUT families does not wipe existing stamps (NULL preserves)", () => {
		registerSession("exec-preserve", "codex-tmux");
		expect(
			approve("exec-preserve", { author: "codex", reviewer: "claude" }),
		).toBe(true);
		// e.g. a replayed pre-FLY-1188 event shape re-records without stamps
		expect(approve("exec-preserve")).toBe(true);
		const rec = store.getCodexReviewRecord("exec-preserve", SHA);
		expect(rec?.author_family).toBe("codex");
		expect(rec?.reviewer_family).toBe("claude");
	});

	// R9 MEDIUM: the evidence group must be replaced ATOMICALLY per verdict
	// identity — the surviving stamps must all describe the verdict that
	// actually backs the gate, never a mix of two verdicts.
	it("distinct-event recovery: requestless codex/codex row is FULLY replaced by a request-bound codex/claude verdict", () => {
		registerSession("exec-atomic", "codex-tmux");
		// production shape: today's requestless codex lane writes the invalid row
		expect(
			approve("exec-atomic", {
				author: "codex",
				reviewer: "codex",
				eventId: "evt-invalid",
			}),
		).toBe(false);
		// future request-bound claude-reviewer lane corrects it
		expect(
			approve("exec-atomic", {
				author: "codex",
				reviewer: "claude",
				requestId: "req-valid",
				eventId: "evt-valid",
			}),
		).toBe(true);
		const rec = store.getCodexReviewRecord("exec-atomic", SHA);
		expect(rec?.verdict_event_id).toBe("evt-valid");
		expect(rec?.request_id).toBe("req-valid");
		expect(rec?.author_family).toBe("codex");
		expect(rec?.reviewer_family).toBe("claude");
	});

	it("late requestless codex/codex event does NOT downgrade a request-bound codex/claude record", () => {
		registerSession("exec-late", "codex-tmux");
		expect(
			approve("exec-late", {
				author: "codex",
				reviewer: "claude",
				requestId: "req-valid",
				eventId: "evt-valid",
			}),
		).toBe(true);
		// late/replayed legacy codex-lane event (requestless, same-family stamps)
		expect(
			approve("exec-late", {
				author: "codex",
				reviewer: "codex",
				eventId: "evt-late",
			}),
		).toBe(true); // gate STAYS satisfied — record untouched
		const rec = store.getCodexReviewRecord("exec-late", SHA);
		expect(rec?.reviewer_family).toBe("claude");
		expect(rec?.verdict_event_id).toBe("evt-valid");
		expect(rec?.request_id).toBe("req-valid");
		expect(store.isCodexCodeReviewApproved("exec-late", SHA)).toBe(true);
	});

	// R10 MEDIUM: a requestless legacy event must not touch a request-bound
	// PENDING row either — filling it with legacy evidence would make the
	// real verdict for that request look like a replay (unreplaceable).
	it("requestless event on a request-bound PENDING row is a no-op; the bound request's verdict then lands cleanly", () => {
		registerSession("exec-pending-bound", "codex-tmux");
		store.claimCodexHoldNotify({
			executionId: "exec-pending-bound",
			targetPrHeadSha: SHA,
			issueId: "FLY-1188",
			projectName: "proj",
		});
		// bind the pending row to a review request (§7.1 lane shape)
		(
			store as unknown as {
				db: { run: (sql: string, params: unknown[]) => void };
			}
		).db.run(
			"UPDATE codex_review_record SET request_id = ? WHERE execution_id = ?",
			["req-valid", "exec-pending-bound"],
		);
		// late requestless legacy event: must NOT approve/pollute the row
		expect(
			approve("exec-pending-bound", {
				author: "codex",
				reviewer: "codex",
				eventId: "evt-legacy",
			}),
		).toBe(false);
		const pending = store.getCodexReviewRecord("exec-pending-bound", SHA);
		expect(pending?.status).toBe("pending");
		expect(pending?.verdict_event_id).toBeUndefined();
		expect(pending?.request_id).toBe("req-valid");
		// the bound request's real cross-family verdict lands cleanly
		expect(
			approve("exec-pending-bound", {
				author: "codex",
				reviewer: "claude",
				requestId: "req-valid",
				eventId: "evt-valid",
			}),
		).toBe(true);
		const rec = store.getCodexReviewRecord("exec-pending-bound", SHA);
		expect(rec?.status).toBe("approved");
		expect(rec?.verdict_event_id).toBe("evt-valid");
		expect(rec?.reviewer_family).toBe("claude");
	});

	it("replay of the SAME request-bound verdict preserves first-write anchors (R2 LOW-4)", () => {
		registerSession("exec-replay", "codex-tmux");
		expect(
			approve("exec-replay", {
				author: "codex",
				reviewer: "claude",
				requestId: "req-1",
				eventId: "evt-1",
			}),
		).toBe(true);
		// re-delivered verdict for the SAME request (e.g. transport retry)
		expect(
			approve("exec-replay", {
				author: "codex",
				reviewer: "claude",
				requestId: "req-1",
				eventId: "evt-1-redelivered",
			}),
		).toBe(true);
		const rec = store.getCodexReviewRecord("exec-replay", SHA);
		expect(rec?.verdict_event_id).toBe("evt-1"); // anchor not restamped
		expect(rec?.request_id).toBe("req-1");
	});
});

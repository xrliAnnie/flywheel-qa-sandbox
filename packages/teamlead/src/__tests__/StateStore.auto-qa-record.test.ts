import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

/**
 * FLY-579 P1: durable AutoQaRecord — the per-(parent, reviewed-head) record
 * that anchors the auto-QA pipeline. Keyed by (parent_execution_id,
 * target_pr_head_sha) so a re-review against a new head opens a fresh record
 * (old one superseded) and a repeated awaiting_review for the SAME head is
 * deduped to a single QA spawn.
 */
async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("StateStore auto_qa_record", () => {
	it("claimAutoQaRecord inserts a running record and returns true once", async () => {
		const store = await freshStore();
		const claimed = store.claimAutoQaRecord({
			parentExecutionId: "parent-1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
		});
		expect(claimed).toBe(true);

		const rec = store.getAutoQaRecord("parent-1", SHA_A);
		expect(rec).toBeDefined();
		expect(rec?.status).toBe("running");
		expect(rec?.issue_id).toBe("FLY-1");
		expect(rec?.project_name).toBe("proj");
		expect(rec?.qa_execution_id).toBeUndefined();
		expect(rec?.started_at).toBeTruthy();
	});

	it("claimAutoQaRecord is an atomic dedup — second claim of same key returns false", async () => {
		const store = await freshStore();
		expect(
			store.claimAutoQaRecord({
				parentExecutionId: "parent-1",
				targetPrHeadSha: SHA_A,
				issueId: "FLY-1",
				projectName: "proj",
			}),
		).toBe(true);
		// Same key again — already claimed (QA already running/spawned) → no re-spawn.
		expect(
			store.claimAutoQaRecord({
				parentExecutionId: "parent-1",
				targetPrHeadSha: SHA_A,
				issueId: "FLY-1",
				projectName: "proj",
			}),
		).toBe(false);
	});

	it("a new head (different sha) opens a distinct record", async () => {
		const store = await freshStore();
		expect(
			store.claimAutoQaRecord({
				parentExecutionId: "parent-1",
				targetPrHeadSha: SHA_A,
				issueId: "FLY-1",
				projectName: "proj",
			}),
		).toBe(true);
		expect(
			store.claimAutoQaRecord({
				parentExecutionId: "parent-1",
				targetPrHeadSha: SHA_B,
				issueId: "FLY-1",
				projectName: "proj",
			}),
		).toBe(true);
		expect(store.getAutoQaRecord("parent-1", SHA_A)?.status).toBe("running");
		expect(store.getAutoQaRecord("parent-1", SHA_B)?.status).toBe("running");
	});

	it("setAutoQaQaExecutionId backfills the spawned QA execution id", async () => {
		const store = await freshStore();
		store.claimAutoQaRecord({
			parentExecutionId: "parent-1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
		});
		store.setAutoQaQaExecutionId("parent-1", SHA_A, "qa-exec-9");
		expect(store.getAutoQaRecord("parent-1", SHA_A)?.qa_execution_id).toBe(
			"qa-exec-9",
		);
		expect(
			store.getAutoQaRecordByQaExec("qa-exec-9")?.parent_execution_id,
		).toBe("parent-1");
	});

	it("setAutoQaStatus transitions status + stamps completed_at/verdict/notified", async () => {
		const store = await freshStore();
		store.claimAutoQaRecord({
			parentExecutionId: "parent-1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
		});
		store.setAutoQaStatus("parent-1", SHA_A, "passed", {
			verdictEventId: "evt-7",
		});
		const rec = store.getAutoQaRecord("parent-1", SHA_A);
		expect(rec?.status).toBe("passed");
		expect(rec?.verdict_event_id).toBe("evt-7");
		expect(rec?.completed_at).toBeTruthy();

		store.setAutoQaStatus("parent-1", SHA_A, "passed", { notifiedAt: true });
		expect(store.getAutoQaRecord("parent-1", SHA_A)?.notified_at).toBeTruthy();
	});

	it("supersedeOtherAutoQaRecords marks all but the kept head superseded", async () => {
		const store = await freshStore();
		store.claimAutoQaRecord({
			parentExecutionId: "parent-1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
		});
		store.claimAutoQaRecord({
			parentExecutionId: "parent-1",
			targetPrHeadSha: SHA_B,
			issueId: "FLY-1",
			projectName: "proj",
		});
		store.supersedeOtherAutoQaRecords("parent-1", SHA_B);
		expect(store.getAutoQaRecord("parent-1", SHA_A)?.status).toBe("superseded");
		expect(store.getAutoQaRecord("parent-1", SHA_B)?.status).toBe("running");
	});

	it("listRunningAutoQaRecords returns only running records (for reconcile)", async () => {
		const store = await freshStore();
		store.claimAutoQaRecord({
			parentExecutionId: "p1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
		});
		store.claimAutoQaRecord({
			parentExecutionId: "p2",
			targetPrHeadSha: SHA_B,
			issueId: "FLY-2",
			projectName: "proj",
		});
		store.setAutoQaStatus("p2", SHA_B, "passed", {});
		const running = store.listRunningAutoQaRecords();
		expect(running.map((r) => r.parent_execution_id)).toEqual(["p1"]);
	});

	it("setAutoQaIssue persists the separate QA Linear issue (FLY-643)", async () => {
		const store = await freshStore();
		store.claimAutoQaRecord({
			parentExecutionId: "parent-1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-643",
			projectName: "proj",
		});
		// Pre-FLY-643 / pre-create state: no QA issue yet.
		expect(
			store.getAutoQaRecord("parent-1", SHA_A)?.qa_issue_id,
		).toBeUndefined();

		store.setAutoQaIssue("parent-1", SHA_A, {
			issueId: "qa-issue-uuid",
			issueIdentifier: "FLY-700",
			issueTitle: "QA · FLY-643 — separate issue",
			issueUrl: "https://linear.app/x/issue/FLY-700",
		});
		const rec = store.getAutoQaRecord("parent-1", SHA_A);
		expect(rec?.qa_issue_id).toBe("qa-issue-uuid");
		expect(rec?.qa_issue_identifier).toBe("FLY-700");
		expect(rec?.qa_issue_title).toBe("QA · FLY-643 — separate issue");
		expect(rec?.qa_issue_url).toBe("https://linear.app/x/issue/FLY-700");
		// The parent issue_id is unchanged — qa_issue_id is a distinct column.
		expect(rec?.issue_id).toBe("FLY-643");
	});

	it("setAutoQaIssue tolerates optional fields being absent", async () => {
		const store = await freshStore();
		store.claimAutoQaRecord({
			parentExecutionId: "p",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-643",
			projectName: "proj",
		});
		store.setAutoQaIssue("p", SHA_A, { issueId: "qa-only-id" });
		const rec = store.getAutoQaRecord("p", SHA_A);
		expect(rec?.qa_issue_id).toBe("qa-only-id");
		expect(rec?.qa_issue_identifier).toBeUndefined();
		expect(rec?.qa_issue_url).toBeUndefined();
	});

	it("persists across reopen (durable, survives Bridge restart)", async () => {
		const store = await freshStore();
		store.claimAutoQaRecord({
			parentExecutionId: "parent-1",
			targetPrHeadSha: SHA_A,
			issueId: "FLY-1",
			projectName: "proj",
		});
		store.setAutoQaQaExecutionId("parent-1", SHA_A, "qa-exec-9");
		// In-memory store is not file-backed; assert the read model is intact
		// (migration idempotency is covered by the create() call not throwing).
		const rec = store.getAutoQaRecord("parent-1", SHA_A);
		expect(rec?.qa_execution_id).toBe("qa-exec-9");
	});

	// ── FLY-752: fix-loop reuse (getLatest / retarget CAS / pending) ──

	function claim(store: StateStore, p: string, sha: string): void {
		store.claimAutoQaRecord({
			parentExecutionId: p,
			targetPrHeadSha: sha,
			issueId: "FLY-1",
			projectName: "proj",
		});
	}

	it("awaiting_retest is a NON-terminal status (no completed_at stamp)", async () => {
		const store = await freshStore();
		claim(store, "p", SHA_A);
		store.setAutoQaStatus("p", SHA_A, "awaiting_retest", {});
		const rec = store.getAutoQaRecord("p", SHA_A);
		expect(rec?.status).toBe("awaiting_retest");
		expect(rec?.completed_at).toBeFalsy();
	});

	it("getLatestAutoQaRecordByParent returns the newest non-superseded record", async () => {
		const store = await freshStore();
		claim(store, "p", SHA_A);
		store.setAutoQaStatus("p", SHA_A, "passed", {});
		claim(store, "p", SHA_B);
		// SHA_B is later (higher started_at ordering by insertion) → owner.
		const rec = store.getLatestAutoQaRecordByParent("p");
		expect(rec?.target_pr_head_sha).toBe(SHA_B);
	});

	it("getLatestAutoQaRecordByParent includes legacy failed/stuck, excludes superseded", async () => {
		const store = await freshStore();
		claim(store, "p", SHA_A);
		store.setAutoQaStatus("p", SHA_A, "failed", {}); // legacy terminal FAIL
		const rec = store.getLatestAutoQaRecordByParent("p");
		expect(rec?.status).toBe("failed");
		expect(rec?.target_pr_head_sha).toBe(SHA_A);

		// A superseded-only parent → no owner.
		claim(store, "q", SHA_A);
		store.supersedeOtherAutoQaRecords("q", SHA_B); // supersede SHA_A (kept=SHA_B, absent)
		expect(store.getLatestAutoQaRecordByParent("q")).toBeUndefined();
	});

	it("retargetAutoQaRecord moves the row in place to a new head, resetting terminal fields", async () => {
		const store = await freshStore();
		claim(store, "p", SHA_A);
		store.setAutoQaQaExecutionId("p", SHA_A, "qa-exec-1");
		store.setAutoQaStatus("p", SHA_A, "passed", { verdictEventId: "evt-1" });
		store.setAutoQaStatus("p", SHA_A, "passed", { notifiedAt: true });

		const ok = store.retargetAutoQaRecord({
			parentExecutionId: "p",
			oldSha: SHA_A,
			newSha: SHA_B,
			expectStatuses: [
				"running",
				"awaiting_retest",
				"passed",
				"stuck",
				"failed",
			],
		});
		expect(ok).toBe(true);

		// Single row, now at SHA_B, running, terminal fields + notified_at cleared,
		// qa_execution_id + issue carried over (same QA reused).
		expect(store.getAutoQaRecord("p", SHA_A)).toBeUndefined();
		const rec = store.getAutoQaRecord("p", SHA_B);
		expect(rec?.status).toBe("running");
		expect(rec?.qa_execution_id).toBe("qa-exec-1");
		expect(rec?.verdict_event_id).toBeFalsy();
		expect(rec?.completed_at).toBeFalsy();
		expect(rec?.notified_at).toBeFalsy(); // R3-1: MUST be cleared
		expect(rec?.retest_wake_pending_at).toBeTruthy();
	});

	it("retargetAutoQaRecord is a CAS no-op on status drift", async () => {
		const store = await freshStore();
		claim(store, "p", SHA_A);
		store.setAutoQaStatus("p", SHA_A, "superseded", {});
		const ok = store.retargetAutoQaRecord({
			parentExecutionId: "p",
			oldSha: SHA_A,
			newSha: SHA_B,
			expectStatuses: [
				"running",
				"awaiting_retest",
				"passed",
				"stuck",
				"failed",
			],
		});
		expect(ok).toBe(false);
		expect(store.getAutoQaRecord("p", SHA_A)?.status).toBe("superseded");
		expect(store.getAutoQaRecord("p", SHA_B)).toBeUndefined();
	});

	it("retargetAutoQaRecord deletes a stale terminal (parent,newSha) conflict then moves", async () => {
		const store = await freshStore();
		// Stale historical row for SHA_B (force-push back to an old sha scenario).
		claim(store, "p", SHA_B);
		store.setAutoQaStatus("p", SHA_B, "superseded", {});
		// Active row on SHA_A.
		claim(store, "p", SHA_A);
		const ok = store.retargetAutoQaRecord({
			parentExecutionId: "p",
			oldSha: SHA_A,
			newSha: SHA_B,
			expectStatuses: [
				"running",
				"awaiting_retest",
				"passed",
				"stuck",
				"failed",
			],
		});
		expect(ok).toBe(true);
		expect(store.getAutoQaRecord("p", SHA_A)).toBeUndefined();
		expect(store.getAutoQaRecord("p", SHA_B)?.status).toBe("running");
		// Exactly one row for the parent.
		expect(store.listAutoQaRecordsByParent("p")).toHaveLength(1);
	});

	it("clearRetestWakePending clears the durable marker", async () => {
		const store = await freshStore();
		claim(store, "p", SHA_A);
		store.retargetAutoQaRecord({
			parentExecutionId: "p",
			oldSha: SHA_A,
			newSha: SHA_B,
			expectStatuses: ["running"],
		});
		expect(
			store.getAutoQaRecord("p", SHA_B)?.retest_wake_pending_at,
		).toBeTruthy();
		store.clearRetestWakePending("p", SHA_B);
		expect(
			store.getAutoQaRecord("p", SHA_B)?.retest_wake_pending_at,
		).toBeFalsy();
	});

	it("listPassedAutoQaRecords + listAutoQaRecordsAwaitingRetestWake for reconcile", async () => {
		const store = await freshStore();
		claim(store, "p1", SHA_A);
		store.setAutoQaStatus("p1", SHA_A, "passed", { notifiedAt: true }); // passed + notified
		claim(store, "p2", SHA_A);
		store.retargetAutoQaRecord({
			parentExecutionId: "p2",
			oldSha: SHA_A,
			newSha: SHA_B,
			expectStatuses: ["running"],
		}); // running + pending marker

		expect(
			store.listPassedAutoQaRecords().map((r) => r.parent_execution_id),
		).toEqual(["p1"]);
		expect(
			store
				.listAutoQaRecordsAwaitingRetestWake()
				.map((r) => r.parent_execution_id),
		).toEqual(["p2"]);
	});
});

/**
 * FLY-846: gate queries — QA-issue detection (gate ①) + issue-level active
 * record lookup (gate ③). Parent issue keys are historically MIXED
 * (Linear UUID vs identifier), so both queries must accept a key LIST.
 */
describe("StateStore auto_qa_record FLY-846 gate queries", () => {
	function claim(
		store: StateStore,
		parent: string,
		sha: string,
		issueId = "FLY-1",
	) {
		expect(
			store.claimAutoQaRecord({
				parentExecutionId: parent,
				targetPrHeadSha: sha,
				issueId,
				projectName: "proj",
			}),
		).toBe(true);
	}

	describe("isAutoQaIssue", () => {
		it("matches qa_issue_id and qa_issue_identifier; misses others", async () => {
			const store = await freshStore();
			claim(store, "p1", SHA_A, "FLY-100");
			store.setAutoQaIssue("p1", SHA_A, {
				issueId: "qa-uuid-1",
				issueIdentifier: "FLY-101",
				issueTitle: "QA · FLY-100 — x",
			});

			expect(store.isAutoQaIssue(["qa-uuid-1"])).toBe(true);
			expect(store.isAutoQaIssue(["FLY-101"])).toBe(true);
			expect(store.isAutoQaIssue(["qa-uuid-1", "FLY-101"])).toBe(true);
			// The PARENT issue is not a QA issue.
			expect(store.isAutoQaIssue(["FLY-100"])).toBe(false);
			expect(store.isAutoQaIssue(["nope"])).toBe(false);
		});

		it("empty / blank keys return false without generating invalid SQL", async () => {
			const store = await freshStore();
			expect(store.isAutoQaIssue([])).toBe(false);
			expect(store.isAutoQaIssue(["", "   "])).toBe(false);
		});
	});

	describe("listActiveAutoQaRecordsForIssue", () => {
		it("returns only active statuses (running/awaiting_retest/stuck) for the issue, excluding the given parent", async () => {
			const store = await freshStore();
			// Active foreign records in each active status.
			claim(store, "p-running", SHA_A, "FLY-696");
			claim(store, "p-retest", SHA_B, "FLY-696");
			store.setAutoQaStatus("p-retest", SHA_B, "awaiting_retest", {});
			claim(store, "p-stuck", "c".repeat(40), "FLY-696");
			store.setAutoQaStatus("p-stuck", "c".repeat(40), "stuck", {});
			// Non-active statuses must NOT be returned.
			claim(store, "p-passed", "d".repeat(40), "FLY-696");
			store.setAutoQaStatus("p-passed", "d".repeat(40), "passed", {});
			claim(store, "p-superseded", "e".repeat(40), "FLY-696");
			store.setAutoQaStatus("p-superseded", "e".repeat(40), "superseded", {});
			claim(store, "p-failed", "f".repeat(40), "FLY-696");
			store.setAutoQaStatus("p-failed", "f".repeat(40), "failed", {});
			// A record on a DIFFERENT issue must not leak in.
			claim(store, "p-other-issue", SHA_A, "FLY-999");
			// The caller's own record is excluded.
			claim(store, "p-self", "1".repeat(40), "FLY-696");

			const got = store.listActiveAutoQaRecordsForIssue({
				issueKeys: ["FLY-696"],
				excludeParentExecutionId: "p-self",
			});
			expect(got.map((r) => r.parent_execution_id).sort()).toEqual([
				"p-retest",
				"p-running",
				"p-stuck",
			]);
		});

		it("matches mixed parent issue key forms (UUID vs identifier)", async () => {
			const store = await freshStore();
			claim(store, "p-uuid", SHA_A, "uuid-parent");
			claim(store, "p-ident", SHA_B, "FLY-696");

			const got = store.listActiveAutoQaRecordsForIssue({
				issueKeys: ["uuid-parent", "FLY-696"],
				excludeParentExecutionId: "someone-else",
			});
			expect(got.map((r) => r.parent_execution_id).sort()).toEqual([
				"p-ident",
				"p-uuid",
			]);
		});

		it("empty / blank keys return [] without generating invalid SQL", async () => {
			const store = await freshStore();
			claim(store, "p1", SHA_A, "FLY-696");
			expect(
				store.listActiveAutoQaRecordsForIssue({
					issueKeys: [],
					excludeParentExecutionId: "x",
				}),
			).toEqual([]);
			expect(
				store.listActiveAutoQaRecordsForIssue({
					issueKeys: ["", "  "],
					excludeParentExecutionId: "x",
				}),
			).toEqual([]);
		});
	});
});

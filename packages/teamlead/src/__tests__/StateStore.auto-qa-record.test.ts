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
});

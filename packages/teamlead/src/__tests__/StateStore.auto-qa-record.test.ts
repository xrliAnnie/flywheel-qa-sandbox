import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function insertHistory(
	store: StateStore,
	input: {
		parent: string;
		head: string;
		issue?: string;
		qaExec?: string;
		qaIssue?: string;
		qaIdentifier?: string;
		status?: string;
		notified?: boolean;
		retestPending?: boolean;
	},
): void {
	(
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db.run(
		`INSERT INTO auto_qa_record
		 (parent_execution_id, target_pr_head_sha, issue_id, project_name,
		  qa_execution_id, qa_issue_id, qa_issue_identifier, status, started_at,
		  notified_at, retest_wake_pending_at)
		 VALUES (?, ?, ?, 'proj', ?, ?, ?, ?, datetime('now'),
		  CASE WHEN ? THEN datetime('now') END,
		  CASE WHEN ? THEN datetime('now') END)`,
		[
			input.parent,
			input.head,
			input.issue ?? "FLY-1",
			input.qaExec ?? null,
			input.qaIssue ?? null,
			input.qaIdentifier ?? null,
			input.status ?? "running",
			input.notified ? 1 : 0,
			input.retestPending ? 1 : 0,
		],
	);
}

describe("StateStore historical auto_qa_record compatibility", () => {
	it("keeps every historical read/query API without exposing a write API", async () => {
		const store = await StateStore.create(":memory:");
		insertHistory(store, {
			parent: "historical",
			head: SHA_A,
			qaExec: "qa-shared",
			qaIssue: "qa-uuid",
			qaIdentifier: "FLY-2",
			status: "passed",
			notified: true,
		});
		insertHistory(store, {
			parent: "active",
			head: SHA_B,
			qaExec: "qa-shared",
			status: "running",
			retestPending: true,
		});

		expect(store.getAutoQaRecord("historical", SHA_A)?.status).toBe("passed");
		expect(store.getAutoQaRecordByQaExec("qa-shared")).toBeDefined();
		expect(store.listAutoQaRecordsByQaExec("qa-shared")).toHaveLength(2);
		expect(store.listAutoQaRecordsByParent("active")).toHaveLength(1);
		expect(
			store.findAutoQaOwnershipByQaExec("qa-shared")?.parent_execution_id,
		).toBe("active");
		expect(store.listRunningAutoQaRecords()).toHaveLength(1);
		expect(store.listPassedUnnotifiedAutoQaRecords()).toHaveLength(0);
		expect(store.listPassedAutoQaRecords()).toHaveLength(1);
		expect(store.listAutoQaRecordsByStatus("passed")).toHaveLength(1);
		expect(store.listAutoQaRecordsAwaitingRetestWake()).toHaveLength(1);
		expect(
			store.getLatestAutoQaRecordByParent("active")?.target_pr_head_sha,
		).toBe(SHA_B);
		expect(store.isAutoQaIssue(["qa-uuid", "FLY-2"])).toBe(true);
		expect(
			store.listActiveAutoQaRecordsForIssue({
				issueKeys: ["FLY-1"],
				excludeParentExecutionId: "historical",
			}),
		).toHaveLength(1);
		expect(store.findAutoQaRecordsByQaIssueKeys(["qa-uuid"])).toHaveLength(1);
		expect(store.findAutoQaRecordsByParentIssueKeys(["FLY-1"])).toHaveLength(2);
		const retiredMutations = [
			"claimAutoQaRecord",
			"setAutoQaQaExecutionId",
			"markDeadAutoQaExecution",
			"claimAutoQaRetryAfterSpawnFailure",
			"claimAutoQaRetryLaunch",
			"completeAutoQaRetryLaunch",
			"failAutoQaRetryLaunch",
			"setAutoQaIssue",
			"setAutoQaStatus",
			"supersedeOtherAutoQaRecords",
			"setQaRequiredSnapshot",
			"retargetAutoQaRecord",
			"clearRetestWakePending",
			"reopenAutoQaRecordForRespawn",
			"reviveAutoQaRecordForManualSpawn",
		] as const;
		for (const method of retiredMutations) {
			expect(
				(store as unknown as Record<string, unknown>)[method],
			).toBeUndefined();
		}
	});

	it("migrates the legacy table while retaining historical rows", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1981-auto-qa-history-"));
		const dbPath = join(dir, "state.db");
		try {
			const legacy = new BetterSqlite3(dbPath);
			legacy.exec(`
				CREATE TABLE auto_qa_record (
					parent_execution_id TEXT NOT NULL,
					target_pr_head_sha TEXT NOT NULL,
					issue_id TEXT NOT NULL,
					project_name TEXT NOT NULL,
					qa_execution_id TEXT,
					status TEXT NOT NULL DEFAULT 'running',
					verdict_event_id TEXT,
					started_at TEXT NOT NULL DEFAULT (datetime('now')),
					completed_at TEXT,
					notified_at TEXT,
					PRIMARY KEY (parent_execution_id, target_pr_head_sha)
				);
				INSERT INTO auto_qa_record
				 (parent_execution_id, target_pr_head_sha, issue_id, project_name)
				 VALUES ('legacy-parent', '${SHA_A}', 'FLY-1981', 'flywheel');
			`);
			legacy.close();

			const store = await StateStore.create(dbPath);
			expect(store.getAutoQaRecord("legacy-parent", SHA_A)).toMatchObject({
				enrollment_source: "auto",
				auto_retry_count: 0,
			});
			store.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

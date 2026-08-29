import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

/**
 * FLY-1165: StateStore queries backing the done-thread reconcile sweep —
 * (1) `getUnarchivedIssueChatThreads` enumerates the reconcile candidate set
 * (main-table threads that are not archived, not Discord-missing, and carry an
 * issue key); (2) `getSessionsForIssueAliases` is the alias-aware (issue UUID
 * ↔ Linear identifier) session lookup the liveness veto runs on; (3)
 * `isChatThreadArchived` is the fresh archive-once read the sink guard uses.
 */
async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

describe("FLY-1165 StateStore reconcile helpers", () => {
	it("getUnarchivedIssueChatThreads: only unarchived, non-missing, issue-keyed main-table rows (with lead_id)", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-open", "chan-1", "FLY-100", "eng-lead");
		store.upsertChatThread("t-archived", "chan-1", "FLY-101", "eng-lead");
		store.markChatThreadArchived("t-archived");
		store.upsertChatThread("t-missing", "chan-1", "FLY-102", "eng-lead");
		store.markChatThreadMissing("t-missing");
		store.upsertChatThread("t-no-issue", "chan-1", "", "eng-lead");
		store.upsertChatThread("t-no-lead", "chan-2", "FLY-103");

		const rows = store.getUnarchivedIssueChatThreads();
		expect(rows.map((r) => r.thread_id).sort()).toEqual([
			"t-no-lead",
			"t-open",
		]);
		const open = rows.find((r) => r.thread_id === "t-open");
		expect(open).toMatchObject({
			thread_id: "t-open",
			channel_id: "chan-1",
			issue_id: "FLY-100",
			lead_id: "eng-lead",
		});
		const noLead = rows.find((r) => r.thread_id === "t-no-lead");
		expect(noLead?.lead_id).toBeNull();
	});

	it("getSessionsForIssueAliases: issue_id OR issue_identifier matches on any alias key (UUID↔identifier both ways)", async () => {
		const store = await freshStore();
		const uuid = "a1b2c3d4-0000-0000-0000-000000000001";
		// Legacy UUID-keyed session that also recorded the identifier.
		store.upsertSession({
			execution_id: "e-uuid",
			issue_id: uuid,
			issue_identifier: "FLY-200",
			project_name: "flywheel",
			status: "awaiting_review",
		});
		// Identifier-keyed session (post-FLY-270 shape), no identifier column.
		store.upsertSession({
			execution_id: "e-ident",
			issue_id: "FLY-200",
			project_name: "flywheel",
			status: "completed",
		});
		// Unrelated issue must not match.
		store.upsertSession({
			execution_id: "e-other",
			issue_id: "FLY-999",
			project_name: "flywheel",
			status: "running",
		});

		// Query by identifier alone hits both alias shapes.
		const byIdentifier = store.getSessionsForIssueAliases(["FLY-200"]);
		expect(byIdentifier.map((r) => r.execution_id).sort()).toEqual([
			"e-ident",
			"e-uuid",
		]);
		// Query by UUID alone hits the UUID-keyed row.
		const byUuid = store.getSessionsForIssueAliases([uuid]);
		expect(byUuid.map((r) => r.execution_id)).toEqual(["e-uuid"]);
		// Combined alias set (what the reconcile pipeline passes) hits both, deduped.
		const byBoth = store.getSessionsForIssueAliases(["FLY-200", uuid]);
		expect(byBoth.map((r) => r.execution_id).sort()).toEqual([
			"e-ident",
			"e-uuid",
		]);
		const uuidRow = byBoth.find((r) => r.execution_id === "e-uuid");
		expect(uuidRow).toMatchObject({
			status: "awaiting_review",
			project_name: "flywheel",
			issue_id: uuid,
			issue_identifier: "FLY-200",
		});
		// Empty key list is a no-op, not a full scan.
		expect(store.getSessionsForIssueAliases([])).toEqual([]);
	});

	it("isChatThreadArchived: fresh archived_at read (false before mark, true after)", async () => {
		const store = await freshStore();
		store.upsertChatThread("t-fresh", "chan-1", "FLY-300", "eng-lead");
		expect(store.isChatThreadArchived("t-fresh")).toBe(false);
		store.markChatThreadArchived("t-fresh");
		expect(store.isChatThreadArchived("t-fresh")).toBe(true);
		// Unknown thread reads as not-archived (caller layers its own guards).
		expect(store.isChatThreadArchived("t-unknown")).toBe(false);
	});
});

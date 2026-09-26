import { describe, expect, it } from "vitest";
import type { LeadNudgeRow } from "../bridge/lead-pending-escalation.js";
import { StateStore } from "../StateStore.js";

/**
 * FLY-637-ext: durable per-(execution, question) backoff state. Keyed by
 * (execution_id, question_id) so multiple pending questions of the same runner
 * never share/overwrite state (Codex R1 #1). Survives a Bridge restart.
 */
async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

const ROW: LeadNudgeRow = {
	stuck_key: "sk1",
	nudge_count: 2,
	last_nudge_at_ms: 1000,
	next_eligible_at_ms: 5000,
	paged_annie: false,
};

describe("StateStore lead_pending_escalation (FLY-637-ext)", () => {
	it("upsert then get returns the row; absent = undefined", async () => {
		const s = await freshStore();
		expect(s.getLeadPendingEscalation("e1", "q1")).toBeUndefined();
		s.upsertLeadPendingEscalation("e1", "q1", ROW);
		expect(s.getLeadPendingEscalation("e1", "q1")).toEqual(ROW);
	});

	it("upsert overwrites the same (execId, questionId)", async () => {
		const s = await freshStore();
		s.upsertLeadPendingEscalation("e1", "q1", ROW);
		s.upsertLeadPendingEscalation("e1", "q1", {
			...ROW,
			nudge_count: 4,
			paged_annie: true,
		});
		const got = s.getLeadPendingEscalation("e1", "q1");
		expect(got?.nudge_count).toBe(4);
		expect(got?.paged_annie).toBe(true);
	});

	it("multiple pending questions of the SAME runner are independent (R1 #1)", async () => {
		const s = await freshStore();
		s.upsertLeadPendingEscalation("e1", "q1", { ...ROW, nudge_count: 1 });
		s.upsertLeadPendingEscalation("e1", "q2", { ...ROW, nudge_count: 3 });
		expect(s.getLeadPendingEscalation("e1", "q1")?.nudge_count).toBe(1);
		expect(s.getLeadPendingEscalation("e1", "q2")?.nudge_count).toBe(3);
	});

	it("clear(execId, questionId) clears only that row; clear(execId) clears all of the runner's", async () => {
		const s = await freshStore();
		s.upsertLeadPendingEscalation("e1", "q1", ROW);
		s.upsertLeadPendingEscalation("e1", "q2", ROW);
		s.upsertLeadPendingEscalation("e2", "q3", ROW);
		s.clearLeadPendingEscalation("e1", "q1");
		expect(s.getLeadPendingEscalation("e1", "q1")).toBeUndefined();
		expect(s.getLeadPendingEscalation("e1", "q2")).toBeDefined();
		s.clearLeadPendingEscalation("e1");
		expect(s.getLeadPendingEscalation("e1", "q2")).toBeUndefined();
		expect(s.getLeadPendingEscalation("e2", "q3")).toBeDefined();
	});

	it("prune keeps rows whose question_id is in the active set, drops the rest", async () => {
		const s = await freshStore();
		s.upsertLeadPendingEscalation("e1", "keep", ROW);
		s.upsertLeadPendingEscalation("e1", "drop", ROW);
		s.upsertLeadPendingEscalation("e2", "keep", ROW);
		s.pruneLeadPendingEscalationNotIn(["keep"]);
		expect(s.getLeadPendingEscalation("e1", "keep")).toBeDefined();
		expect(s.getLeadPendingEscalation("e2", "keep")).toBeDefined();
		expect(s.getLeadPendingEscalation("e1", "drop")).toBeUndefined();
	});

	it("prune([]) clears ALL rows (empty-set guard, no SQL error)", async () => {
		const s = await freshStore();
		s.upsertLeadPendingEscalation("e1", "q1", ROW);
		expect(() => s.pruneLeadPendingEscalationNotIn([])).not.toThrow();
		expect(s.getLeadPendingEscalation("e1", "q1")).toBeUndefined();
	});

	it("survives a reopen of the same DB file (restart-tolerant)", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "fly637ext-store-"));
		const dbPath = join(dir, "teamlead.db");
		try {
			const s1 = await StateStore.create(dbPath);
			s1.upsertLeadPendingEscalation("e1", "q1", { ...ROW, nudge_count: 3 });
			s1.close();
			const s2 = await StateStore.create(dbPath);
			expect(s2.getLeadPendingEscalation("e1", "q1")?.nudge_count).toBe(3);
			s2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

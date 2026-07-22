import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { requestLandCleanupOpportunities } from "../land-cleanup-opportunity.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("land cleanup opportunity", () => {
	it("notifies every issue session and bounds unacknowledged runners", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-land-cleanup-"));
		roots.push(root);
		const commPath = join(root, "comm.db");
		const store = await StateStore.create(":memory:");
		for (const executionId of ["design-1", "qa-1"]) {
			store.upsertSession({
				execution_id: executionId,
				issue_id: "issue-1",
				project_name: "flywheel",
				status: "awaiting_review",
			});
		}
		const operation = store.ensureLandOperation({
			issueId: "issue-1",
			projectName: "flywheel",
			prNumber: 1,
			approvedHead: "a".repeat(40),
			now: "2026-07-21T20:00:00.000Z",
		});
		let clock = 1_000;
		const report = await requestLandCleanupOpportunities(operation, {
			store,
			commDbPathForProject: () => commPath,
			graceMs: 10,
			nowMs: () => clock,
			sleep: async () => {
				const db = new CommDB(commPath);
				const control = db.getRunnerShutdown("design-1")!;
				db.finishRunnerShutdown(
					"design-1",
					control.request_id,
					{ ok: true },
					clock,
				);
				db.close();
				clock += 10;
			},
		});
		expect(report).toEqual({ requested: 2, acked: 1, timedOut: 1 });
		const db = CommDB.openReadonly(commPath);
		try {
			expect(db.getRunnerShutdown("design-1")?.state).toBe("acked");
			expect(db.getRunnerShutdown("qa-1")?.state).toBe("requested");
		} finally {
			db.close();
		}
		store.close();
	});
});

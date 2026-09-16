import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { assertLeadGithubPrBinding } from "../lead-github-binding.js";

it("requires live StateStore PR binding and unambiguous existing patrol owner attribution", async () => {
	const root = mkdtempSync(join(tmpdir(), "github-binding-"));
	const store = await StateStore.create(":memory:");
	const comm = new CommDB(join(root, "comm.db"));
	const check = () =>
		assertLeadGithubPrBinding({
			store,
			comm,
			projectName: "demo",
			leadId: "eng",
			prNumber: 7,
			assertCurrent: () => {},
		});
	try {
		expect(check).toThrow("pr_not_bound_to_lead");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "ISSUE-1",
			project_name: "demo",
			status: "running",
			pr_number: 7,
		});
		expect(check).toThrow("pr_not_bound_to_lead");
		comm.registerSession("exec-1", "runner:0", "demo", "ISSUE-1", "eng");
		expect(check()).toEqual({ executionIds: ["exec-1"], issueId: "ISSUE-1" });

		comm.registerSession("exec-2", "runner:0", "demo", "ISSUE-1", "other");
		// The existing exact execution owner wins over a mixed current issue cohort.
		expect(check()).toEqual({ executionIds: ["exec-1"], issueId: "ISSUE-1" });
		store.upsertSession({
			execution_id: "exec-2",
			issue_id: "ISSUE-1",
			project_name: "demo",
			status: "running",
			pr_number: 7,
		});
		expect(check).toThrow("pr_not_bound_to_lead");
		const fallback = (number: number) =>
			assertLeadGithubPrBinding({
				store,
				comm,
				projectName: "demo",
				leadId: "eng",
				prNumber: number,
				assertCurrent: () => {},
			});
		store.upsertSession({
			execution_id: "absent",
			issue_id: "ISSUE-2",
			project_name: "demo",
			status: "running",
			pr_number: 8,
		});
		comm.registerSession("cohort-eng", "runner:0", "demo", "ISSUE-2", "eng");
		expect(() => fallback(8)).toThrow("pr_not_bound_to_lead");
		comm.registerSession(
			"cohort-other",
			"runner:0",
			"demo",
			"ISSUE-2",
			"other",
		);
		expect(() => fallback(8)).toThrow("pr_not_bound_to_lead");
		store.upsertSession({
			execution_id: "latest-absent",
			issue_id: "ISSUE-3",
			project_name: "demo",
			status: "running",
			pr_number: 9,
		});
		comm.registerSession("latest-eng", "runner:0", "demo", "ISSUE-3", "eng");
		comm.updateSessionStatus("latest-eng", "completed");
		expect(() => fallback(9)).toThrow("pr_not_bound_to_lead");
		expect(() =>
			assertLeadGithubPrBinding({
				store,
				comm,
				projectName: "foreign",
				leadId: "eng",
				prNumber: 9,
				assertCurrent: () => {},
			}),
		).toThrow("pr_not_bound_to_lead");
	} finally {
		comm.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

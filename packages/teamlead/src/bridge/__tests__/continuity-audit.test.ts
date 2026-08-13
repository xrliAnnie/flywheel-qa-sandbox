import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContinuityAudit } from "../continuity-audit.js";

describe("FLY-1718 explicit fresh-start audit", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("durably records actor, reason, branch, and the deliberately skipped tip", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1718-audit-"));
		roots.push(root);
		const dbPath = join(root, "continuity.db");
		const audit = new ContinuityAudit(dbPath, () => "2026-08-12T00:00:00Z");
		expect(
			audit.recordFreshStart({
				executionId: "exec-1",
				projectName: "flywheel",
				issueId: "issue-uuid",
				role: "main",
				actor: "master:flywheel-eng-lead",
				reason: "founder requested a clean redesign",
				branch: "flywheel-FLY-1718",
				skippedOriginTip: "a".repeat(40),
			}),
		).toBe(true);
		audit.close();

		const reopened = new ContinuityAudit(dbPath);
		expect(reopened.forExecution("exec-1")).toEqual([
			expect.objectContaining({
				ts: "2026-08-12T00:00:00Z",
				actor: "master:flywheel-eng-lead",
				reason: "founder requested a clean redesign",
				branch: "flywheel-FLY-1718",
				skipped_origin_tip: "a".repeat(40),
			}),
		]);
		reopened.close();
	});

	it("is idempotent for a replay of the same execution", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1718-audit-"));
		roots.push(root);
		const audit = new ContinuityAudit(join(root, "continuity.db"));
		const record = {
			executionId: "exec-1",
			projectName: "flywheel",
			issueId: "issue-uuid",
			role: "main",
			actor: "scoped:lead",
			reason: "redo",
			branch: "flywheel-FLY-1718",
		};
		expect(audit.recordFreshStart(record)).toBe(true);
		expect(audit.recordFreshStart(record)).toBe(true);
		expect(audit.forExecution("exec-1")).toHaveLength(1);
		audit.close();
	});
});

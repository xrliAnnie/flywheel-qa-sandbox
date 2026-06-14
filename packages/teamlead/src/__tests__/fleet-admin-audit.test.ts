import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FleetAdminAudit } from "../bridge/fleet-admin-audit.js";

describe("FleetAdminAudit (FLY-247 inc2a §2.2)", () => {
	let dir: string;
	let audit: FleetAdminAudit;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "faa-"));
		audit = new FleetAdminAudit(join(dir, "audit.db"));
	});
	afterEach(() => {
		audit.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("records a staged event", () => {
		expect(
			audit.record({
				batchId: "b1",
				event: "staged",
				canonicalRequest: "{...}",
			}),
		).toBe(true);
		const rows = audit.forBatch("b1");
		expect(rows).toHaveLength(1);
		expect(rows[0]!.event).toBe("staged");
	});

	it("singleton events are idempotent (staged twice → one row, upserted)", () => {
		audit.record({ batchId: "b1", event: "staged", reason: "first" });
		audit.record({ batchId: "b1", event: "staged", reason: "second" });
		const rows = audit.forBatch("b1").filter((r) => r.event === "staged");
		expect(rows).toHaveLength(1);
		expect(rows[0]!.reason).toBe("second"); // upserted
	});

	it("denied is append-only — repeated attacks each leave a row", () => {
		audit.record({
			batchId: "b1",
			event: "denied",
			attemptId: "a1",
			reason: "replay",
		});
		audit.record({
			batchId: "b1",
			event: "denied",
			attemptId: "a2",
			reason: "forged",
		});
		const denied = audit.forBatch("b1").filter((r) => r.event === "denied");
		expect(denied).toHaveLength(2);
	});

	it("denied without an attemptId is rejected (false)", () => {
		expect(audit.record({ batchId: "b1", event: "denied" })).toBe(false);
	});

	it("apply-result upsert is idempotent + hasApplyResult reflects it", () => {
		expect(audit.hasApplyResult("b1")).toBe(false);
		audit.record({ batchId: "b1", event: "apply-result", result: "applied" });
		audit.record({ batchId: "b1", event: "apply-result", result: "applied" });
		expect(
			audit.forBatch("b1").filter((r) => r.event === "apply-result"),
		).toHaveLength(1);
		expect(audit.hasApplyResult("b1")).toBe(true);
	});

	it("schema persists — reopening the same db file keeps the rows", () => {
		audit.record({ batchId: "b1", event: "staged" });
		audit.close();
		const reopened = new FleetAdminAudit(join(dir, "audit.db"));
		expect(reopened.forBatch("b1")).toHaveLength(1);
		reopened.close();
		// re-open the original handle for afterEach close()
		audit = new FleetAdminAudit(join(dir, "audit.db"));
	});
});

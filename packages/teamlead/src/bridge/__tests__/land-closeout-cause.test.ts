import { describe, expect, it } from "vitest";
import {
	describeLandCloseoutCause,
	inferLandCloseoutCause,
	landCloseoutCauseFromReason,
	landCloseoutReason,
	renderLandThreadNotification,
} from "../land-closeout-cause.js";

describe("land closeout cause", () => {
	it("keeps a bounded machine token in the retry-compatible reason", () => {
		const reason = landCloseoutReason("husk_lease_stale");
		expect(reason).toBe("issue_closeout_incomplete:cause=husk_lease_stale");
		expect(landCloseoutCauseFromReason(reason)).toBe("husk_lease_stale");
		expect(landCloseoutCauseFromReason("issue_closeout_incomplete")).toBe(
			"unknown",
		);
	});

	it("maps cleanup failures without leaking raw errors to founder copy", () => {
		expect(
			inferLandCloseoutCause([
				"phase-shutdown: phase_shutdown_controller_lease_stale_live_pane",
			]),
		).toBe("husk_lease_stale");
		expect(inferLandCloseoutCause(["commdb finalize: sqlite busy"])).toBe(
			"commdb_finalize_failed",
		);
		expect(describeLandCloseoutCause("window_cleanup_failed")).toContain(
			"窗口",
		);
		expect(describeLandCloseoutCause("husk_lease_stale")).toContain("Runner");
	});

	it("renders partial and held thread truth without raw JSON", () => {
		const partial = renderLandThreadNotification("finalization_partial", 923, {
			reason: "issue_closeout_incomplete:cause=husk_lease_stale",
			executionIds: ["secret-exec"],
		});
		const held = renderLandThreadNotification("finalization_held", 923, {
			reason:
				"retry_exhausted:issue_closeout_incomplete:cause=husk_lease_stale",
		});
		expect(partial).toContain("正在自动重试");
		expect(partial).toContain("暂不归档");
		expect(held).toContain("自动重试已停止");
		expect(held).toContain("resume");
		expect(partial).not.toContain("{");
		expect(partial).not.toContain("secret-exec");
	});
});

import { describe, expect, it } from "vitest";
import { bodyFor, titleFor } from "../alert-kind-copy.js";

describe("alert kind copy", () => {
	it("describes Discord plugin integrity failures with recovery guidance", () => {
		expect(titleFor("discord_plugin_integrity_failed")).toBe(
			"Discord plugin fork integrity failed",
		);
		expect(bodyFor("discord_plugin_integrity_failed", "ignored")).toBe(
			"A Lead could not prove the configured Discord plugin came from the Flywheel fork at the expected remote SHA. Keep that Lead stopped, repair the pointer install, then rerun the integrity check before restarting it.",
		);
	});

	it("keeps the historical auto_qa_stuck kind but gives it neutral recovery copy", () => {
		expect(titleFor("auto_qa_stuck")).toBe("Review or ship authorization held");
		const body = bodyFor("auto_qa_stuck", "ignored");
		expect(body).toContain("authorization invariant");
		expect(body).toContain("cancel unsafe state");
		expect(body).toContain("DAG recovery and redispatch");
		expect(body).not.toMatch(/spawn|auto-QA|QA Runner/i);
	});

	it("keeps generic review failure copy neutral about the recovery path", () => {
		const body = bodyFor("review_job_failed", "ignored");
		expect(body).toBe(
			"Cross-family review failed closed. Inspect the failure reason and live bound-gate state before choosing the recovery path; obsolete or non-replayable requests require a fresh gate or request.",
		);
		expect(body).not.toMatch(/same requestId/i);
	});

	it("points Bridge deploy failures at rotating, startup, and marker evidence", () => {
		const body = bodyFor("deploy_failed", "ignored");
		expect(body).toContain("/tmp/flywheel-bridge.log");
		expect(body).toContain("bridge-startup.log");
		expect(body).toContain("bridge-log-rotation-error.json");
		expect(body).toContain("deployed-sha");
	});

	it("provides a static fail-closed fallback for meeting artifact failures", () => {
		expect(titleFor("meeting_notes_failed")).toBe("会议留痕管线故障");
		expect(bodyFor("meeting_notes_failed", "ignored")).toContain(
			"idempotent tick",
		);
		expect(bodyFor("meeting_notes_failed", "ignored")).toContain(
			"failureClass",
		);
	});
});

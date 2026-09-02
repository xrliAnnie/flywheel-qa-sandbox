import { describe, expect, it } from "vitest";
import { bodyFor, severityFor, titleFor } from "../alert-kind-copy.js";

describe("alert kind copy", () => {
	it("renders Fable family updates as informational registry receipts", () => {
		expect(titleFor("model_family_updated")).toBe(
			"Fable model family authority updated",
		);
		expect(bodyFor("model_family_updated", "ignored")).toContain("models.json");
		expect(severityFor("model_family_updated")).toBe("info");
	});

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

	it("renders founder-calendar wild writes as an actionable warning", () => {
		expect(titleFor("calendar_wild_write")).toBe(
			"Founder calendar write governance finding",
		);
		expect(bodyFor("calendar_wild_write", "ignored")).toContain(
			"raya_meeting_id",
		);
		expect(bodyFor("calendar_wild_write", "ignored")).toContain("FLY-2137");
		expect(severityFor("calendar_wild_write")).toBe("warning");
	});
});

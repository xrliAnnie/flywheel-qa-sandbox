import { describe, expect, it } from "vitest";
import { buildTuiWindowLostAlert } from "../tui-window-alert.js";

const baseEvidence = {
	executionId: "exec-2170",
	issueId: "FLY-2170",
	projectName: "flywheel",
	leadId: "flywheel-eng-lead",
	episodeStartedAt: 1_788_470_000_000,
	attempts: 0,
	lastFailure: undefined,
} as const;

describe("buildTuiWindowLostAlert", () => {
	it("explains that label-unavailable suppresses only the founder window", () => {
		const alert = buildTuiWindowLostAlert({
			...baseEvidence,
			trigger: "label-unavailable",
		});

		expect(alert.body).toBe(
			"Recovery could not prove the runner's birth window label, so no founder-facing window was opened. The resident worker is still running; inspect execution exec-2170.",
		);
		expect(alert.eventId).toBe("tui-window-lost:exec-2170:1788470000000");
		expect(alert.episodeId).toBe(alert.eventId);
	});

	it("preserves the existing never-acquired body for other triggers", () => {
		const alert = buildTuiWindowLostAlert({
			...baseEvidence,
			trigger: "deadline-exhausted",
			attempts: 3,
			lastFailure: {
				category: "retryable-transient-ipc",
				reason: "marker_unproven",
			},
		});

		expect(alert.body).toBe(
			"The founder-facing Codex pane never acquired an immutable tmux window id. trigger=deadline-exhausted; attempts=3; last=retryable-transient-ipc/marker_unproven. The resident run continued; inspect execution exec-2170.",
		);
	});
});

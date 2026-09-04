import type { RunnerTuiWindowLostEvidence } from "flywheel-claude-runner";
import type { AlertPayload } from "../LeadAlertNotifier.js";

export function buildTuiWindowLostAlert(
	evidence: RunnerTuiWindowLostEvidence,
): AlertPayload {
	const eventId = `tui-window-lost:${evidence.executionId}:${evidence.episodeStartedAt}`;
	const reason = evidence.lastFailure
		? `${evidence.lastFailure.category}/${evidence.lastFailure.reason}`
		: "unknown";
	const body =
		evidence.trigger === "label-unavailable"
			? `Recovery could not prove the runner's birth window label, so no founder-facing window was opened. The resident worker is still running; inspect execution ${evidence.executionId}.`
			: `The founder-facing Codex pane never acquired an immutable tmux window id. trigger=${evidence.trigger}; attempts=${evidence.attempts}; last=${reason}. The resident run continued; inspect execution ${evidence.executionId}.`;

	return {
		leadId: evidence.leadId,
		projectName: evidence.projectName,
		eventId,
		eventType: "tui_window_lost",
		title: `Codex runner TUI not visible (${evidence.issueId})`,
		body,
		severity: "warning",
		sessionKey: evidence.executionId,
		episodeId: eventId,
	};
}

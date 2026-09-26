/**
 * FLY-2883 plan §6.2 — the Claude Lead pane side of a controlled interrupt,
 * built on the FLY-2882 readers (no second busy/idle vocabulary).
 *
 * "Safe to type" = the FLY-2882 status-slot parser says busy AND this Lead's
 * input box is empty AND the same live Claude process sat under the pane
 * before and after the capture. Anything else is never typed into: the letter
 * is delivered as ordinary mail instead.
 *
 * Typing re-runs the whole judgment first (fresh locate + capture + process
 * check), calls the owner guard, and hands the send to
 * `sendLiteralLineToLeadPane`, which re-proves pane identity and the exact
 * Claude pid immediately before typing the fixed phrase. Pane text is never
 * logged, persisted or returned.
 */

import type {
	LeadWindowRef,
	V2LeadClaudeProcess,
} from "../LeadWindowLocator.js";
import { parseClaudeLeadPaneActivity } from "./lead-activity/claude-pane-activity.js";
import type {
	ClaudeInterruptPane,
	ClaudePaneAssessment,
} from "./lead-interrupt-delivery.js";

/** Same window FLY-2882 proved covers the status slot. */
export const CLAUDE_INTERRUPT_CAPTURE_LINES = 150;

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escape sequences from tmux pane
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The `❯` line directly under this Lead's box border (the same border the
 * FLY-2882 parser anchors on) carries nothing but whitespace.
 */
export function claudePromptEmpty(pane: string, leadId: string): boolean {
	const lines = pane.replace(ANSI, "").replace(/\r/g, "").split("\n");
	const border = new RegExp(`^─{6,}.*@${escapeRegExp(leadId)}\\s+─`, "u");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!border.test(lines[i]!.replace(/\s+$/u, ""))) continue;
		const prompt = lines[i + 1];
		return prompt !== undefined && /^❯\s*$/u.test(prompt);
	}
	return false;
}

export interface ClaudeInterruptPaneDeps {
	leadId: string;
	locate(): Promise<LeadWindowRef | null>;
	/** Identity-checked capture (`defaultLeadPaneCapture()` in production). */
	capture(window: LeadWindowRef, lines: number): Promise<string>;
	/** `readV2LeadClaudePid` in production. */
	claudeProcess(window: LeadWindowRef): Promise<V2LeadClaudeProcess>;
	/** `sendLiteralLineToLeadPane(window, PHRASE, { expectedClaudePid })`. */
	sendPhrase(
		window: LeadWindowRef,
		expectedClaudePid: string,
	): Promise<{ sent: boolean; error?: string }>;
}

type Judgment =
	| { assessment: { state: "busy_safe" }; window: LeadWindowRef; pid: string }
	| { assessment: Exclude<ClaudePaneAssessment, { state: "busy_safe" }> };

export function createClaudeInterruptPane(
	deps: ClaudeInterruptPaneDeps,
): ClaudeInterruptPane {
	const unknown = (reason: string): Judgment => ({
		assessment: { state: "unknown", reason },
	});

	const judge = async (): Promise<Judgment> => {
		let window: LeadWindowRef | null;
		try {
			window = await deps.locate();
		} catch {
			window = null;
		}
		if (!window) return unknown("lead_window_unavailable");
		const before = await deps.claudeProcess(window);
		if (before.state !== "running")
			return unknown(
				before.state === "absent"
					? "lead_process_not_running"
					: "lead_process_unverified",
			);
		let pane: string;
		try {
			pane = await deps.capture(window, CLAUDE_INTERRUPT_CAPTURE_LINES);
		} catch {
			return unknown("pane_capture_failed");
		}
		const after = await deps.claudeProcess(window);
		if (after.state !== "running" || after.pid !== before.pid)
			return unknown("lead_process_unverified");
		const parsed = parseClaudeLeadPaneActivity(pane, deps.leadId);
		if (parsed.state === "unknown") return unknown(parsed.reason);
		if (parsed.state === "idle")
			return { assessment: { state: "idle", reason: "done_line" } };
		if (!claudePromptEmpty(pane, deps.leadId))
			return {
				assessment: { state: "busy_unsafe", reason: "prompt_not_empty" },
			};
		return { assessment: { state: "busy_safe" }, window, pid: after.pid };
	};

	return {
		async assess() {
			return (await judge()).assessment;
		},
		async typePhrase(assertCurrentOwner) {
			const fresh = await judge();
			if (!("window" in fresh)) {
				return { outcome: "skipped", reason: fresh.assessment.reason };
			}
			// Throws propagate: a lost owner or settled letter sends nothing.
			assertCurrentOwner();
			const sent = await deps.sendPhrase(fresh.window, fresh.pid);
			return sent.sent
				? { outcome: "nudged" }
				: { outcome: "failed", reason: "send_failed" };
		},
	};
}

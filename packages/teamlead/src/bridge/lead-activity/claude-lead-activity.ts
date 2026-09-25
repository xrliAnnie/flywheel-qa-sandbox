/**
 * FLY-2882 §4.2 — Claude-carrier Lead activity: locate the Lead's private
 * terminal, capture it (identity-verified, read-only), parse in memory.
 *
 * The capture string never leaves this function: it is not logged, persisted
 * or returned. No new exec/spawn call site — capture reuses
 * `defaultLeadPaneCapture()` (which re-verifies pane identity before reading).
 */

import type { LeadWindowRef } from "../../LeadWindowLocator.js";
import { parseClaudeLeadPaneActivity } from "./claude-pane-activity.js";
import { type LeadActivityReading, undetermined } from "./types.js";

export const CLAUDE_PANE_CAPTURE_LINES = 150;
/** Thrown verbatim by `defaultLeadPaneCapture` when pane identity is unproven. */
const PANE_IDENTITY_ERROR = "private Lead body pane identity is indeterminate";

export interface ClaudeLeadActivityDeps {
	locate(projectName: string, leadId: string): Promise<LeadWindowRef | null>;
	capture(window: LeadWindowRef, lines: number): Promise<string>;
	now(): number;
}

export async function readClaudeLeadActivity(
	projectName: string,
	leadId: string,
	deps: ClaudeLeadActivityDeps,
): Promise<{ reading: LeadActivityReading; observedAtMs: number }> {
	const unknown = (
		reason: Extract<LeadActivityReading, { state: "unknown" }>["reason"],
	) => ({
		reading: { state: "unknown" as const, reason },
		observedAtMs: deps.now(),
	});
	let window: LeadWindowRef | null;
	try {
		window = await deps.locate(projectName, leadId);
	} catch {
		window = null;
	}
	if (!window) return unknown("lead_window_unavailable");
	let pane: string;
	try {
		pane = await deps.capture(window, CLAUDE_PANE_CAPTURE_LINES);
	} catch (error) {
		return unknown(
			error instanceof Error && error.message === PANE_IDENTITY_ERROR
				? "lead_window_unavailable"
				: "pane_capture_failed",
		);
	}
	const observedAtMs = deps.now();
	const parsed = parseClaudeLeadPaneActivity(pane, leadId);
	if (parsed.state === "unknown")
		return { reading: { state: "unknown", reason: parsed.reason }, observedAtMs };
	if (parsed.state === "idle") return { reading: { state: "idle" }, observedAtMs };
	return {
		reading: {
			state: "busy",
			turn: {
				startedAt: new Date(observedAtMs - parsed.elapsedMs).toISOString(),
				elapsedMs: parsed.elapsedMs,
				precision: parsed.precision,
				origin: "unknown",
			},
			trigger: undetermined("causality_unproven"),
		},
		observedAtMs,
	};
}

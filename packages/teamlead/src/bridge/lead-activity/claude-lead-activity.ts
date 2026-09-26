/**
 * FLY-2882 §4.2 + design-correction C2 — Claude-carrier Lead activity.
 *
 * Order: locate (capture-strength identity) → Claude pid₁ → capture (identity
 * re-checked by `defaultLeadPaneCapture`) → Claude pid₂. The screen is parsed
 * only when pid₁ and pid₂ are the same live Claude process: after Claude
 * exits, its last done line and input box stay on screen until the wrapper
 * kills tmux, so the picture alone can never prove a live, idle Lead.
 *
 * The capture string never leaves this function: it is not logged, persisted
 * or returned. Process checks read pid / ppid / kernel name only.
 */

import type {
	LeadWindowRef,
	V2LeadClaudeProcess,
} from "../../LeadWindowLocator.js";
import { parseClaudeLeadPaneActivity } from "./claude-pane-activity.js";
import { type LeadActivityReading, undetermined } from "./types.js";

export const CLAUDE_PANE_CAPTURE_LINES = 150;
/** Thrown verbatim by `defaultLeadPaneCapture` when pane identity is unproven. */
const PANE_IDENTITY_ERROR = "private Lead body pane identity is indeterminate";

export interface ClaudeLeadActivityDeps {
	locate(projectName: string, leadId: string): Promise<LeadWindowRef | null>;
	/** A `CaptureFn` built once by `defaultLeadPaneCapture()`. */
	capture(window: LeadWindowRef, lines: number): Promise<string>;
	/** `readV2LeadClaudePid` in production. */
	claudeProcess(window: LeadWindowRef): Promise<V2LeadClaudeProcess>;
	now(): number;
}

type UnknownReason = Extract<
	LeadActivityReading,
	{ state: "unknown" }
>["reason"];

function livenessFailure(process: V2LeadClaudeProcess): UnknownReason {
	return process.state === "absent"
		? "lead_process_not_running"
		: "lead_process_unverified";
}

export async function readClaudeLeadActivity(
	projectName: string,
	leadId: string,
	deps: ClaudeLeadActivityDeps,
): Promise<{ reading: LeadActivityReading; observedAtMs: number }> {
	const unknown = (reason: UnknownReason, observedAtMs = deps.now()) => ({
		reading: { state: "unknown" as const, reason },
		observedAtMs,
	});
	let window: LeadWindowRef | null;
	try {
		window = await deps.locate(projectName, leadId);
	} catch {
		window = null;
	}
	if (!window) return unknown("lead_window_unavailable");
	const before = await deps.claudeProcess(window);
	if (before.state !== "running") return unknown(livenessFailure(before));
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
	const after = await deps.claudeProcess(window);
	if (after.state !== "running")
		return unknown(livenessFailure(after), observedAtMs);
	if (after.pid !== before.pid)
		return unknown("lead_process_unverified", observedAtMs);
	const parsed = parseClaudeLeadPaneActivity(pane, leadId);
	if (parsed.state === "unknown")
		return {
			reading: { state: "unknown", reason: parsed.reason },
			observedAtMs,
		};
	if (parsed.state === "idle")
		return { reading: { state: "idle" }, observedAtMs };
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

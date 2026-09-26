/**
 * FLY-368: shared, AUDITED Lead resume-menu unstick (a single Enter).
 *
 * This is the ONLY sanctioned way the auto-repair bot may press Enter on a live
 * LEAD pane. It mirrors the runner recovery-nudge safety contract (Codex R2
 * HIGH-1): a durable `attempt` row is written to `alert_repair_attempts` BEFORE
 * the keystroke, and if that write fails NO Enter is sent. Lead alerts have no
 * real execution/issue, so the audit goes to the purpose-built table — never to
 * `session_events` with synthetic ids.
 *
 * Gate: the live pane must STILL be the exact resume-menu shape
 * (`isSafeResumeMenuForEnter`). Compact prompt / in-flight compaction / a
 * permission prompt never match (they are human-only — Codex R1 MEDIUM-7).
 */

import { isSafeResumeMenuForEnter } from "../LeadWatchdog.js";
import type { LeadWindowRef } from "../LeadWindowLocator.js";
import type { StateStore } from "../StateStore.js";

export interface LeadResumeEnterDeps {
	store: StateStore;
	/** Locate the Lead's tmux window (defaults to locateLeadWindow in the Bridge). */
	locateWindowFn: (
		projectName: string,
		leadId: string,
	) => Promise<LeadWindowRef | null>;
	/** Capture the Lead pane text (defaults to defaultLeadPaneCapture). */
	captureFn: (windowId: string, lines: number) => Promise<string>;
	/** Send a bare Enter (defaults to sendEnterToWindow). */
	sendEnter: (windowId: string) => Promise<{ sent: boolean; error?: string }>;
}

export interface LeadResumeEnterInput {
	actor: string;
	projectName: string;
	leadId: string;
	correlationKey: string;
	eventId: string;
}

export interface LeadResumeEnterOutcome {
	sent: boolean;
	reason: string;
}

export async function attemptLeadResumeEnter(
	input: LeadResumeEnterInput,
	deps: LeadResumeEnterDeps,
): Promise<LeadResumeEnterOutcome> {
	const { store } = deps;
	const action = "lead_resume_enter";

	const record = (
		result: "attempt" | "sent" | "refused",
		reason: string,
	): boolean =>
		store.recordAlertRepairAttempt({
			correlationKey: input.correlationKey,
			eventId: input.eventId,
			actor: input.actor,
			action,
			leadId: input.leadId,
			projectName: input.projectName,
			result,
			reason,
		});

	const refuse = (reason: string): LeadResumeEnterOutcome => {
		record("refused", reason);
		return { sent: false, reason };
	};

	let windowRef: LeadWindowRef | null;
	try {
		windowRef = await deps.locateWindowFn(input.projectName, input.leadId);
	} catch (err) {
		return refuse(`locate window failed: ${(err as Error).message}`);
	}
	if (!windowRef) return refuse("no tmux window found for this lead");

	let pane: string;
	try {
		pane = await deps.captureFn(windowRef.windowId, 200);
	} catch (err) {
		return refuse(`pane capture failed: ${(err as Error).message}`);
	}

	// Gate: the live pane must STILL be the exact safe resume-menu shape.
	if (!isSafeResumeMenuForEnter(pane)) {
		return refuse(
			"live pane is not the safe resume-menu shape — refusing (compact prompt / permission / other are human-only)",
		);
	}

	// Audit the attempt BEFORE the keystroke. Audit store down → NO Enter.
	if (!record("attempt", `sending Enter to ${windowRef.windowId}`)) {
		return {
			sent: false,
			reason: "audit store unavailable — refusing fail-closed (no Enter sent)",
		};
	}

	const sendResult = await deps.sendEnter(windowRef.windowId);
	if (!sendResult.sent) {
		return refuse(`tmux send-enter failed: ${sendResult.error ?? "unknown"}`);
	}
	record("sent", `Enter sent to ${windowRef.windowId}`);
	return {
		sent: true,
		reason: `Enter sent to resume menu (${windowRef.windowId})`,
	};
}

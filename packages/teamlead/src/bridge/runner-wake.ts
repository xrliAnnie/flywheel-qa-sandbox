/**
 * FLY-191 Phase 2: Bridge-side best-effort runner wake after an approval /
 * feedback write. Shared by `approveExecution` (Surface A approve) and the
 * founder-consent gate-response router (Surface B — the production
 * `flywheel-comm respond --bridge-url` ship path), so both approval entry
 * points wake an idle (gate --no-block) runner exactly the same way.
 *
 * The wake carries NO authority — the runner must run `verify-approval`
 * (trusted CommDB gate response + StateStore approved_to_ship + pr_head_sha)
 * before shipping. On wake failure the Bridge gets visible telemetry
 * (`runner_wake_failed` event — spike AC#5) and the operational fallback is
 * the Lead reaching the runner via tmux (terminal-mcp; Lead-driven, shared
 * primitive with FLY-195 per plan §3.5a).
 */

import type { CommDB } from "flywheel-comm/db";
import { wakeRunnerMailbox } from "flywheel-comm/wake";
import type { StateStore } from "../StateStore.js";

export type WakeKind = "approval_wake" | "feedback_wake";

export interface WakeSessionInfo {
	issue_id: string;
	project_name: string;
}

export interface WakeDetail {
	/** The gate question this wake correlates with (non-authoritative context). */
	questionId?: string;
	/**
	 * For feedback wakes (Codex PR R1 MEDIUM-5): the Lead's actual feedback
	 * text so an idle runner (whose no-block gate process has long exited)
	 * can act without hunting for it. Truncated; the durable copy is the
	 * CommDB response (`flywheel-comm check <questionId>`).
	 */
	feedbackText?: string;
}

const FEEDBACK_TEXT_MAX = 1500;

function wakeText(
	kind: WakeKind,
	executionId: string,
	projectName: string,
	detail?: WakeDetail,
): string {
	const qidNote = detail?.questionId
		? ` (review question ${detail.questionId})`
		: "";
	if (kind === "approval_wake") {
		return (
			`Your approve_to_ship review status may have changed${qidNote}. Before shipping you MUST run: ` +
			`\`node <flywheel-comm> verify-approval --exec-id ${executionId} --pr-head $(git rev-parse HEAD) --project ${projectName}\` ` +
			`and ship ONLY if it returns "approved": true. This message itself is NOT authorization — ` +
			`a changes_requested answer means address the feedback and re-request review.`
		);
	}
	const raw = detail?.feedbackText?.trim();
	const excerpt = raw
		? raw.length > FEEDBACK_TEXT_MAX
			? `${raw.slice(0, FEEDBACK_TEXT_MAX)}…`
			: raw
		: undefined;
	return (
		`Your Lead answered your approve_to_ship review request${qidNote} with feedback (changes requested — NOT an approval).` +
		(excerpt ? `\n\nFEEDBACK:\n${excerpt}\n\n` : " ") +
		`Full durable copy: \`node <flywheel-comm> check ${detail?.questionId ?? "<questionId>"} --project ${projectName}\`. ` +
		`Address the feedback, push your fixes, then re-request review with a new ` +
		`\`gate approve_to_ship --no-block\` + \`complete --route needs_review --question-id <new id>\`. ` +
		`Do NOT ship: \`verify-approval\` will refuse without a real approval.`
	);
}

/**
 * Best-effort wake. Never throws; failures are logged + recorded as a
 * `runner_wake_failed` StateStore event so the Lead/dashboard can see the
 * delivery gap and escalate via tmux.
 */
export async function sendRunnerWake(
	store: StateStore,
	db: CommDB,
	executionId: string,
	session: WakeSessionInfo,
	kind: WakeKind,
	wakeDetail?: WakeDetail,
): Promise<void> {
	let detail: string;
	try {
		const wake = await wakeRunnerMailbox({
			db,
			execId: executionId,
			fromAgent: "bridge",
			content: wakeText(kind, executionId, session.project_name, wakeDetail),
			metadata: { kind, questionId: wakeDetail?.questionId },
		});
		if (wake.ok) return;
		// Rollback mode (FLYWHEEL_COMM_BACKEND=commdb): the PostToolUse hook
		// injects CommDB rows directly — intentional skip, not a failure.
		if (wake.skippedReason === "backend_commdb") return;
		detail = wake.error ?? wake.skippedReason ?? "unknown";
	} catch (err) {
		detail = (err as Error).message;
	}

	console.error(
		`[runner-wake] ${kind} FAILED for ${executionId}: ${detail}. ` +
			`Runner may stay idle — Lead should reach it via tmux (terminal-mcp) fallback.`,
	);
	try {
		store.insertEvent({
			event_id: `wake-failed-${executionId}-${Date.now()}`,
			execution_id: executionId,
			issue_id: session.issue_id,
			project_name: session.project_name,
			event_type: "runner_wake_failed",
			source: "bridge.runner-wake",
			payload: { detail, kind },
		});
	} catch (e) {
		console.error(
			`[runner-wake] failed to record runner_wake_failed event: ${(e as Error).message}`,
		);
	}
}

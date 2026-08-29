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
import {
	defaultGateMarkerDir,
	readGateMarker,
} from "flywheel-comm/gate-marker";
import { wakeRunnerMailbox } from "flywheel-comm/wake";
import type { StateStore } from "../StateStore.js";
import { EXECUTOR_TO_TRANSPORT } from "./role-adapter-resolver.js";

/**
 * FLY-493: a session whose executor backend has `transport: "none"` (e.g.
 * antigravity / kimi) has no mailbox to wake. Recognize it from the persisted
 * `adapter_type` via the generic EXECUTOR_TO_TRANSPORT table.
 */
function isNoTransportBackend(adapterType: string | undefined): boolean {
	if (!adapterType) return false;
	return (
		Object.hasOwn(EXECUTOR_TO_TRANSPORT, adapterType) &&
		EXECUTOR_TO_TRANSPORT[adapterType as keyof typeof EXECUTOR_TO_TRANSPORT] ===
			"none"
	);
}

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

/** Exported for unit testing the wake-text contract (FLY-939 G-B deferral). */
export function wakeText(
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
		// FLY-939 (G-B): role-neutral deferral. A three-stage QA phase must NOT edit
		// code on feedback — its role prompt defines a kickback protocol (re-emit
		// qa-result FAIL so the parked IMPLEMENT phase fixes). A single-session
		// runner has no such protocol, so the generic re-request steps still apply to
		// it byte-compatibly.
		`If your role's prompt defines a different feedback protocol (e.g. a three-stage QA kickback), follow YOUR ROLE PROMPT instead of the generic steps that follow. ` +
		`Otherwise: address the feedback, push your fixes, then re-request review with a new ` +
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
	// FLY-493 (Codex R2 #1 defense-in-depth): a no-transport (e.g. antigravity /
	// kimi) session has NO mailbox — routing a wake to the env-default claude
	// mailbox would report a misleading success for a process that isn't
	// listening. Skip
	// it and record honest telemetry instead. (Design (B) terminalizes such
	// runners at `pr_handoff` so this path is normally unreachable; this guard
	// guarantees no false wake-success from ANY surface.)
	const persisted = store.getSession(executionId);
	if (isNoTransportBackend(persisted?.adapter_type)) {
		console.warn(
			`[runner-wake] ${kind} SKIPPED for ${executionId}: no-transport backend ` +
				`(${persisted?.adapter_type}) has no mailbox to wake. The founder drives the ship.`,
		);
		try {
			store.insertEvent({
				event_id: `no-transport-wake-${executionId}-${Date.now()}`,
				execution_id: executionId,
				issue_id: session.issue_id,
				project_name: session.project_name,
				event_type: "runner_wake_no_transport",
				source: "bridge.runner-wake",
				payload: { kind, adapterType: persisted?.adapter_type },
			});
		} catch {
			// best-effort telemetry
		}
		return;
	}

	let detail: string;
	try {
		// FLY-123 (code review R1 MEDIUM-4): route the wake by the TARGET
		// runner's transport backend when a question-bound gate marker exists
		// — never the process-wide env (Phase 1 locks the Bridge env to
		// claude-code; a Codex runner's wake would land in the wrong mailbox).
		// Markerless questions (all Claude runners) keep the legacy fromEnv
		// path byte-compatibly. Best-effort: the adapter's CommDB belt covers
		// a missed wake, but the wake should still go to the right place.
		let backend: string | undefined;
		if (wakeDetail?.questionId) {
			try {
				const marker = readGateMarker(
					defaultGateMarkerDir(),
					wakeDetail.questionId,
				);
				if (marker && marker.executionId === executionId) {
					backend = marker.vendor;
				}
			} catch {
				// marker unreadable — legacy routing
			}
		}
		const wake = await wakeRunnerMailbox({
			db,
			execId: executionId,
			fromAgent: "bridge",
			content: wakeText(kind, executionId, session.project_name, wakeDetail),
			metadata: { kind, questionId: wakeDetail?.questionId },
			...(backend && { backend }),
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

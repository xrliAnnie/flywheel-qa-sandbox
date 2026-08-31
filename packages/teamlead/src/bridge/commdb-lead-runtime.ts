/**
 * FLY-47: CommDBLeadRuntime — delivers events to Lead via CommDB instructions.
 *
 * Bridge writes events to CommDB as instructions. Lead picks them up via the
 * flywheel-inbox MCP / inbox-check.sh hook (same mechanism as Runner → Lead).
 * (FLY-77 removed the predecessor Discord control-channel transport entirely.)
 *
 * Internal Bridge → Lead transport uses no Discord channel and no Bridge bot
 * token. Discord is only used for Lead → Annie (outbound chat messages).
 */

import { CommDB } from "flywheel-comm/db";
import { truncateCodePoints } from "flywheel-comm/text-truncate";
import {
	formatDetectionEscalation,
	formatDetectionSuspicious,
	formatDurationMs,
	formatGateQuestion,
	formatMisroutedReport,
	formatPatrolTick,
	formatRunnerQuestion,
	formatSessionStuck,
	formatShipApprovalRequest,
	formatStuckEscalation,
	formatWorkflowClaimRecorded,
	formatWorkflowReplacementEligibility,
} from "./hook-payload.js";
import { appendLeadEventAckInstructions } from "./lead-event-ack-render.js";
import type {
	DeliveryResult,
	LeadBootstrap,
	LeadEventEnvelope,
	LeadRuntime,
	LeadRuntimeHealth,
} from "./lead-runtime.js";

export class CommDBLeadRuntime implements LeadRuntime {
	readonly type = "commdb" as const;
	private lastDeliveryAt: string | null = null;
	private lastDeliveredSeq = 0;
	private commDb: CommDB;

	constructor(
		commDbPath: string,
		private leadId: string,
	) {
		this.commDb = new CommDB(commDbPath);
	}

	async deliver(envelope: LeadEventEnvelope): Promise<DeliveryResult> {
		try {
			const content = appendLeadEventAckInstructions(
				this.renderEnvelope(envelope),
				envelope,
			);
			if (envelope.deliveryAttemptId) {
				this.commDb.insertInstruction("bridge", this.leadId, content, {
					dedupeId: `lead-event-attempt-${envelope.deliveryAttemptId}`,
				});
			} else {
				this.commDb.insertInstruction("bridge", this.leadId, content);
			}
			this.lastDeliveryAt = new Date().toISOString();
			this.lastDeliveredSeq = envelope.seq;
			return { delivered: true };
		} catch (err) {
			const error = (err as Error).message;
			console.warn(
				`[commdb-runtime] Delivery failed for seq=${envelope.seq}:`,
				error,
			);
			return { delivered: false, error };
		}
	}

	async sendBootstrap(snapshot: LeadBootstrap): Promise<void> {
		const content = this.formatBootstrap(snapshot);
		this.commDb.insertInstruction("bridge", this.leadId, content);
	}

	async health(): Promise<LeadRuntimeHealth> {
		return {
			status: this.lastDeliveryAt ? "healthy" : "degraded",
			lastDeliveryAt: this.lastDeliveryAt,
			lastDeliveredSeq: this.lastDeliveredSeq,
		};
	}

	async shutdown(): Promise<void> {
		this.commDb.close();
	}

	renderEnvelope(env: LeadEventEnvelope): string {
		return this.formatEnvelope(env);
	}

	private formatEnvelope(env: LeadEventEnvelope): string {
		const e = env.event;
		if (e.event_type === "patrol_tick") return formatPatrolTick(env);
		if (e.event_type === "workflow_replacement_eligibility") {
			return formatWorkflowReplacementEligibility(env);
		}
		if (e.event_type === "workflow_claim_recorded") {
			return formatWorkflowClaimRecorded(env);
		}

		// FLY-161: runner_question — non-blocking Runner ask. Distinct prompt
		// shape from gate_question: no checkpoint tag, framing emphasises
		// "Runner continues working", points the Lead at `flywheel-comm respond`
		// explicitly so the prompt is self-contained.
		if (e.event_type === "runner_question") {
			return formatRunnerQuestion(env);
		}

		// FLY-62: gate_question gets a special format
		if (e.event_type === "gate_question") {
			// FLY-208 6a: shared renderer (parity-by-construction; the
			// approve_to_ship JSON-shape guidance must not drift between runtimes).
			return formatGateQuestion(env);
		}

		// FLY-159: gate_timed_out gets a special format so Lead notifications
		// surface checkpoint, wait duration, original Runner message, and
		// fail-close vs fail-open behavior. Generic formatter (below) would
		// otherwise drop these fields.
		if (e.event_type === "gate_timed_out") {
			const tag = e.checkpoint?.toUpperCase() ?? "GATE";
			const issueRef = e.issue_identifier || e.issue_id;
			const roleLabel =
				e.session_role && e.session_role !== "main"
					? `[${e.session_role.toUpperCase()}] `
					: "";
			const waited = formatDurationMs(e.waited_ms);
			const behavior = e.timeout_behavior ?? "fail-close";
			const source = e.timeout_behavior_source ?? "default";
			const lines = [
				`[Event #${env.seq}] ${roleLabel}gate_timed_out`,
				`ID: ${e.execution_id || "---"} | Issue: ${issueRef || "---"}`,
				`[${tag}] Gate timed out — waited ${waited} (behavior: ${behavior}, source: ${source})`,
				"---",
				"Original Runner message:",
				e.original_message ?? "(no original message captured)",
				"---",
				`Question ID: ${e.question_id ?? "---"}`,
				"Notify Annie via Discord — ask whether to retry or cancel.",
			];
			if (e.chat_thread_id) lines.push(`Chat-Thread: ${e.chat_thread_id}`);
			return lines.join("\n");
		}

		// FLY-1018: ship_approval_request — gemini-agent's request-shaped ship
		// surface. Shared renderer (parity-by-construction, FLY-195 lesson):
		// PR URL / requester / "nothing merged" note must render verbatim.
		if (e.event_type === "ship_approval_request") {
			return formatShipApprovalRequest(env);
		}

		// FLY-195 hotfix: runner_stuck_escalation MUST render the
		// episode_fingerprint (+ stuck evidence) — the generic formatter below
		// drops them, the Lead cannot echo the fingerprint, its disposition
		// POST fails validation, and the Q7 fallback false-pages Annie
		// (production incident 2026-06-03, GEO-397). Shared renderer keeps
		// mailbox/commdb parity by construction.
		if (e.event_type === "runner_stuck_escalation") {
			return formatStuckEscalation(env);
		}

		// FLY-208 A2: misrouted-report advisory (black-hole inbox patrol).
		// Shared renderer — same parity-by-construction rationale as
		// formatStuckEscalation (FLY-195 lesson).
		if (e.event_type === "runner_misrouted_report") {
			return formatMisroutedReport(env);
		}

		// FLY-1048 (A5): detection_suspicious — the generic formatter would drop
		// suspicious_reason / suspicious_pane_tail entirely. Shared renderer
		// (parity with MailboxLeadRuntime by construction).
		if (e.event_type === "detection_suspicious") {
			return formatDetectionSuspicious(env);
		}

		// FLY-1048 (C2): detection_escalation — Lead-first leg of the unified
		// escalation flow. Shared renderer (parity by construction).
		if (e.event_type === "detection_escalation") {
			return formatDetectionEscalation(env);
		}

		// FLY-1234: session_stuck — the generic formatter would drop the
		// confirm-layer annotation (confirm_note). Shared renderer, byte-compat
		// with the generic branch when the annotation is absent.
		if (e.event_type === "session_stuck") {
			return formatSessionStuck(env);
		}

		// FLY-59: Prefix role label for non-main sessions
		const roleLabel =
			e.session_role && e.session_role !== "main"
				? `[${e.session_role.toUpperCase()}] `
				: "";
		const lines = [
			`[Event #${env.seq}] ${roleLabel}${e.event_type}`,
			`ID: ${e.execution_id || "—"} | Issue: ${e.issue_identifier || e.issue_id || "—"}`,
		];
		if (
			e.event_type === "session_started" &&
			e.session_role === "design" &&
			e.design_backend
		) {
			lines.push(`Design Backend: ${e.design_backend}`);
		}
		if (e.issue_title) lines.push(`Title: ${e.issue_title}`);
		if (e.status) lines.push(`Status: ${e.status}`);
		if (e.decision_route) lines.push(`Route: ${e.decision_route}`);
		// FLY-1586 C: render-time truncation mints poison just as readily as
		// write-time truncation — this text goes straight into mailbox.content.
		if (e.summary)
			lines.push(`Summary: ${truncateCodePoints(e.summary, 300).text}`);
		if (e.last_error)
			lines.push(`Error: ${truncateCodePoints(e.last_error, 200).text}`);
		if (e.action)
			lines.push(
				`Action: ${e.action} (${e.action_source_status} → ${e.action_target_status})`,
			);
		if (e.commit_count)
			lines.push(
				`Commits: ${e.commit_count} | +${e.lines_added ?? 0}/-${e.lines_removed ?? 0}`,
			);
		if (e.filter_priority) lines.push(`Priority: ${e.filter_priority}`);
		if (e.notification_context)
			lines.push(`Context: ${e.notification_context}`);
		if (e.pr_number) lines.push(`PR: #${e.pr_number}`);
		if (e.stage_context) lines.push(`Note: ${e.stage_context}`);
		// FLY-91: Chat thread hint for per-issue conversation
		if (e.chat_thread_id) lines.push(`Chat-Thread: ${e.chat_thread_id}`);

		lines.push(`Timestamp: ${env.timestamp} | Session Key: ${env.sessionKey}`);
		return lines.join("\n");
	}

	private formatBootstrap(snapshot: LeadBootstrap): string {
		const sections: string[] = [
			`## Bootstrap — Lead: ${snapshot.leadId}`,
			`Generated at ${new Date().toISOString()}`,
			"",
		];

		if (snapshot.activeSessions.length > 0) {
			sections.push("### Active Sessions");
			for (const s of snapshot.activeSessions) {
				const roleTag =
					s.sessionRole && s.sessionRole !== "main"
						? ` [${s.sessionRole.toUpperCase()}]`
						: "";
				const chatHint = s.chatThreadId
					? ` (Chat-Thread: ${s.chatThreadId})`
					: "";
				sections.push(
					`- ${s.issueIdentifier ?? s.issueId}${roleTag}: ${s.issueTitle ?? "—"} [${s.status}]${chatHint}`,
				);
			}
			sections.push("");
		}

		if (snapshot.pendingDecisions.length > 0) {
			sections.push("### Pending Decisions");
			for (const d of snapshot.pendingDecisions) {
				const roleTag =
					d.sessionRole && d.sessionRole !== "main"
						? ` [${d.sessionRole.toUpperCase()}]`
						: "";
				sections.push(
					`- ${d.issueIdentifier ?? d.issueId}${roleTag}: ${d.issueTitle ?? "—"} (${d.decisionRoute ?? "unknown"})`,
				);
			}
			sections.push("");
		}

		if (snapshot.recentFailures.length > 0) {
			sections.push("### Recent Failures");
			for (const f of snapshot.recentFailures) {
				const roleTag =
					f.sessionRole && f.sessionRole !== "main"
						? ` [${f.sessionRole.toUpperCase()}]`
						: "";
				sections.push(
					`- ${f.issueIdentifier ?? f.issueId}${roleTag}: ${f.lastError?.slice(0, 100) ?? "—"}`,
				);
			}
			sections.push("");
		}

		if (snapshot.recentEvents.length > 0) {
			sections.push(
				`### Recent Events (last 5 min — ${snapshot.recentEvents.length} events)`,
			);
			for (const e of snapshot.recentEvents) {
				sections.push(
					`- [#${e.seq}] ${e.event.event_type} — ${e.event.issue_identifier ?? e.event.issue_id ?? "—"}`,
				);
			}
			sections.push("");
		}

		if (snapshot.pendingGateQuestions?.length) {
			sections.push("### Pending Gate Questions");
			for (const gq of snapshot.pendingGateQuestions) {
				const tag = gq.checkpoint.toUpperCase();
				const issue = gq.issueIdentifier ?? gq.executionId;
				// FLY-59: Role label for non-main sessions
				const roleLabel =
					gq.sessionRole && gq.sessionRole !== "main"
						? `[${gq.sessionRole.toUpperCase()}] `
						: "";
				sections.push(
					`- ${roleLabel}[${tag}] ${issue} (ID: ${gq.questionId}, DB: ${gq.commDbPath}): ${gq.content.slice(0, 200)}${gq.content.length > 200 ? "..." : ""}`,
				);
			}
			sections.push(
				'Action: For each, relay to Annie, then: flywheel-comm respond --db <DB path above> --lead <your_id> <question_id> "reply"',
			);
			sections.push("");
		}

		// FLY-161: non-blocking Runner asks (`flywheel-comm ask`). Listed as a
		// separate section so the Lead doesn't conflate them with hard gates.
		if (snapshot.pendingRunnerQuestions?.length) {
			sections.push("### Pending Runner Questions");
			for (const rq of snapshot.pendingRunnerQuestions) {
				const issue = rq.issueIdentifier ?? rq.executionId;
				const roleLabel =
					rq.sessionRole && rq.sessionRole !== "main"
						? `[${rq.sessionRole.toUpperCase()}] `
						: "";
				const threadHint = rq.chatThreadId
					? ` (Chat-Thread: ${rq.chatThreadId})`
					: "";
				sections.push(
					`- ${roleLabel}[ASK] ${issue} (ID: ${rq.questionId}, DB: ${rq.commDbPath})${threadHint}: ${rq.content.slice(0, 200)}${rq.content.length > 200 ? "..." : ""}`,
				);
			}
			sections.push(
				'Action: Surface each to Annie (Runner is continuing work — non-blocking). Reply with: flywheel-comm respond --db <DB path above> --lead <your_id> <question_id> "reply"',
			);
			sections.push("");
		}

		if (snapshot.memoryRecall) {
			sections.push("### Memory Recall");
			sections.push(snapshot.memoryRecall);
			sections.push("");
		}

		return sections.join("\n");
	}
}

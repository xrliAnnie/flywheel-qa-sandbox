import { formatBootstrap } from "./bootstrap-format.js";
/**
 * FLY-142 PR 1.4: MailboxLeadRuntime — delivers events to Lead via the
 * vendor-neutral mailbox transport (claude-code mailbox, picked up by
 * stock `useInboxPoller`).
 *
 * Replaces CommDBLeadRuntime as the default delivery path when
 * `FLYWHEEL_COMM_BACKEND=mailbox` (the new default). CommDBLeadRuntime is
 * preserved for the hard-gate path (Batch 2 PR 2.1 will swap it for
 * StructuredInboxRouter once await-mcp ships).
 *
 * Why this fixes FLY-142 wake bug:
 * - The buggy `~/.flywheel/hooks/inbox-check.sh` filter (only reads
 *   `type='instruction'`, drops `type='response'`) is bypassed entirely.
 * - Lead's stock `useInboxPoller` reads `<CLAUDE_CONFIG_DIR>/teams/<lead>/inboxes/<lead>.json`
 *   on its own loop and injects directly into the conversation.
 *
 * Hard gate path (commdb-lead-runtime + flywheel-comm respond) is NOT
 * affected by this PR — preserved per plan §B-2 Codex r3 critical #1.
 */

import type {
	IAgentTeamTransport,
	MailboxPayload,
} from "flywheel-agent-team-transport";
import { truncateCodePoints } from "flywheel-comm/text-truncate";
import { MailboxTransport } from "../mailbox/MailboxTransport.js";
import {
	formatBusinessWake,
	formatDetectionEscalation,
	formatDetectionSuspicious,
	formatDurationMs,
	formatEpicIntake,
	formatGateQuestion,
	formatMisroutedReport,
	formatPatrolTick,
	formatRunnerQuestion,
	formatSessionStuck,
	formatShipApprovalRequest,
	formatStuckEscalation,
	formatSummaryDue,
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
import { formatArtifactDelivery } from "./proofshot-deliver.js";

export interface MailboxLeadRuntimeOptions {
	/** Lead agent id (also serves as the team name + recipient inbox name). */
	leadId: string;
	/** Vendor-neutral transport (typically built by AgentTeamTransportFactory.fromEnv()). */
	transport: IAgentTeamTransport;
	/**
	 * Per-message write timeout in ms. Defaults to 3000 to match the
	 * CommDBLeadRuntime / FLY-25 contract (callers depend on bounded latency).
	 */
	writeTimeoutMs?: number;
	/** Optional logger override (defaults to console.warn for failures). */
	logger?: (msg: string, ctx?: Record<string, unknown>) => void;
}

const DEFAULT_WRITE_TIMEOUT_MS = 3000;

/**
 * Mailbox-backed LeadRuntime — single-write per envelope, verified via
 * MailboxTransport.writeVerified semantics (write + read-after-write check
 * to detect lock-cooperation drift with stock claude-code).
 */
export class MailboxLeadRuntime implements LeadRuntime {
	readonly type = "mailbox" as const;
	private readonly mailbox: MailboxTransport;
	private readonly leadId: string;
	private readonly writeTimeoutMs: number;
	private readonly log: (msg: string, ctx?: Record<string, unknown>) => void;
	private lastDeliveryAt: string | null = null;
	private lastDeliveredSeq = 0;

	constructor(opts: MailboxLeadRuntimeOptions) {
		this.leadId = opts.leadId;
		this.mailbox = new MailboxTransport(opts.transport);
		this.writeTimeoutMs = opts.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
		this.log =
			opts.logger ??
			((msg, ctx) => {
				console.warn(`[mailbox-lead-runtime] ${msg}`, ctx ?? {});
			});
	}

	async deliver(envelope: LeadEventEnvelope): Promise<DeliveryResult> {
		const content = appendLeadEventAckInstructions(
			this.renderEnvelope(envelope),
			envelope,
		);
		const payload: MailboxPayload = {
			from: "bridge",
			to: this.leadId,
			content,
			metadata: {
				// Deterministic flywheelId for cross-process idempotency: envelope.seq +
				// leadId + executionId (executionId may be empty for non-session events).
				// Sidecar dedupe in ClaudeMailboxCodec ensures same envelope re-emitted
				// during retry doesn't double-write.
				flywheelId: this.buildFlywheelId(envelope),
				eventType: envelope.event.event_type,
				seq: String(envelope.seq),
			},
		};

		try {
			await this.withTimeout(
				this.mailbox.writeVerified({
					leadName: this.leadId,
					recipient: this.leadId,
					payload,
				}),
				this.writeTimeoutMs,
				`writeVerified seq=${envelope.seq}`,
			);
			this.lastDeliveryAt = new Date().toISOString();
			// Codex r1 PR 1.4 non-blocking note: use Math.max to keep
			// lastDeliveredSeq monotonic when concurrent deliver() calls finish
			// out of order (seq=2 completes before seq=1). The durable store
			// (StateStore.markLeadEventDelivered) handles per-seq delivery
			// tracking; this field is for health visibility only.
			this.lastDeliveredSeq = Math.max(this.lastDeliveredSeq, envelope.seq);
			return { delivered: true };
		} catch (err) {
			const error = (err as Error).message;
			this.log(`Delivery failed for seq=${envelope.seq}: ${error}`, {
				leadId: this.leadId,
				seq: envelope.seq,
				eventType: envelope.event.event_type,
			});
			return { delivered: false, error };
		}
	}

	async sendBootstrap(snapshot: LeadBootstrap): Promise<void> {
		const content = formatBootstrap(snapshot);
		const payload: MailboxPayload = {
			from: "bridge",
			to: this.leadId,
			content,
			metadata: {
				// Bootstrap is non-idempotent across daemon restarts (each restart
				// produces a fresh snapshot reflecting current state). Stamping by
				// a per-restart timestamp prevents the sidecar from de-duping a
				// legitimately-fresh post-restart bootstrap against a prior write.
				flywheelId: `bootstrap-${this.leadId}-${Date.now()}`,
				eventType: "bootstrap",
			},
		};
		// Bootstrap MUST not silently fail — surface the throw so daemon startup
		// can decide whether to abort. (deliver() catches; sendBootstrap throws.)
		await this.withTimeout(
			this.mailbox.writeVerified({
				leadName: this.leadId,
				recipient: this.leadId,
				payload,
			}),
			this.writeTimeoutMs,
			"sendBootstrap",
		);
	}

	async health(): Promise<LeadRuntimeHealth> {
		return {
			status: this.lastDeliveryAt ? "healthy" : "degraded",
			lastDeliveryAt: this.lastDeliveryAt,
			lastDeliveredSeq: this.lastDeliveredSeq,
		};
	}

	async shutdown(): Promise<void> {
		// MailboxTransport holds no resources of its own. The underlying
		// IAgentTeamTransport (ClaudeCodeAdapter) is stateless for write/read.
	}

	// ----------------------------------------------------------------------
	// Helpers
	// ----------------------------------------------------------------------

	private buildFlywheelId(env: LeadEventEnvelope): string {
		if (env.deliveryAttemptId) {
			return `${this.leadId}-${env.deliveryAttemptId}`;
		}
		const exec = env.event.execution_id ?? "no-exec";
		return `${this.leadId}-${env.seq}-${exec}`;
	}

	private async withTimeout<T>(
		promise: Promise<T>,
		ms: number,
		label: string,
	): Promise<T> {
		let timer: NodeJS.Timeout | null = null;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`${label} timed out after ${ms}ms`)),
				ms,
			);
		});
		try {
			return await Promise.race([promise, timeoutPromise]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/**
	 * Format envelope as plain text — identical structure to
	 * CommDBLeadRuntime.formatEnvelope so Lead-side prompts that key off
	 * `[Event #N]` etc. continue to work without modification.
	 */
	renderEnvelope(env: LeadEventEnvelope): string {
		return this.formatEnvelope(env);
	}

	private formatEnvelope(env: LeadEventEnvelope): string {
		const e = env.event;
		if (e.event_type === "epic_intake") return formatEpicIntake(env);
		if (e.event_type === "patrol_tick") return formatPatrolTick(env);
		if (e.event_type === "summary_due") return formatSummaryDue(env);
		if (e.event_type === "business_wake") return formatBusinessWake(env);
		if (e.event_type === "workflow_replacement_eligibility") {
			return formatWorkflowReplacementEligibility(env);
		}
		if (e.event_type === "workflow_claim_recorded") {
			return formatWorkflowClaimRecorded(env);
		}

		// FLY-161: runner_question — non-blocking ask from Runner. The Runner
		// continues working regardless of when the Lead responds, so the prompt
		// must NOT prefix with a checkpoint tag (no `[BRAINSTORM]`/`[REVIEW]`)
		// and must lead with "non-blocking" framing.
		if (e.event_type === "runner_question") {
			return formatRunnerQuestion(env);
		}

		if (e.event_type === "gate_question") {
			// FLY-208 6a: shared renderer (parity-by-construction; the
			// approve_to_ship JSON-shape guidance must not drift between runtimes).
			return formatGateQuestion(env);
		}

		// GEO-151: ProofShot artifact delivery → Lead invokes Discord MCP reply.
		if (e.event_type === "artifact_delivery") {
			return formatArtifactDelivery(env);
		}

		// FLY-159: gate_timed_out gets a special format so the Lead sees
		// checkpoint name, how long Runner waited, the original message, and
		// the timeout behavior (fail-close vs fail-open). Without this branch
		// the generic formatter skips all gate_timed_out-specific fields and
		// the Lead has nothing actionable to relay to Annie.
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
		// (parity with CommDBLeadRuntime by construction).
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
		if (e.action) {
			lines.push(
				`Action: ${e.action} (${e.action_source_status} → ${e.action_target_status})`,
			);
		}
		if (e.commit_count) {
			lines.push(
				`Commits: ${e.commit_count} | +${e.lines_added ?? 0}/-${e.lines_removed ?? 0}`,
			);
		}
		if (e.filter_priority) lines.push(`Priority: ${e.filter_priority}`);
		if (e.notification_context) {
			lines.push(`Context: ${e.notification_context}`);
		}
		if (e.pr_number) lines.push(`PR: #${e.pr_number}`);
		if (e.stage_context) lines.push(`Note: ${e.stage_context}`);
		if (e.chat_thread_id) lines.push(`Chat-Thread: ${e.chat_thread_id}`);

		lines.push(`Timestamp: ${env.timestamp} | Session Key: ${env.sessionKey}`);
		return lines.join("\n");
	}
}

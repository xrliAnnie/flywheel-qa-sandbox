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
import { MailboxTransport } from "../mailbox/MailboxTransport.js";
import {
	formatDetectionEscalation,
	formatDetectionSuspicious,
	formatDurationMs,
	formatGateQuestion,
	formatMisroutedReport,
	formatSessionStuck,
	formatShipApprovalRequest,
	formatStuckEscalation,
} from "./hook-payload.js";
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
		const content = this.formatEnvelope(envelope);
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
		const content = this.formatBootstrap(snapshot);
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
	private formatEnvelope(env: LeadEventEnvelope): string {
		const e = env.event;

		// FLY-161: runner_question — non-blocking ask from Runner. The Runner
		// continues working regardless of when the Lead responds, so the prompt
		// must NOT prefix with a checkpoint tag (no `[BRAINSTORM]`/`[REVIEW]`)
		// and must lead with "non-blocking" framing.
		if (e.event_type === "runner_question") {
			const issueRef = e.issue_identifier || e.issue_id;
			const roleLabel =
				e.session_role && e.session_role !== "main"
					? `[${e.session_role.toUpperCase()}] `
					: "";
			const lines = [
				`[Event #${env.seq}] ${roleLabel}runner_question`,
				`ID: ${e.execution_id || "---"} | Issue: ${issueRef || "---"}`,
				"[ASK] Runner is asking (non-blocking — Runner continues working):",
				"---",
				e.summary ?? "(no content)",
				"---",
				`Reply via: flywheel-comm respond --db ${e.comm_db_path} --lead <your_id> ${e.question_id} "your reply"`,
				`Question ID: ${e.question_id}`,
				`CommDB: ${e.comm_db_path}`,
			];
			if (e.chat_thread_id) lines.push(`Chat-Thread: ${e.chat_thread_id}`);
			return lines.join("\n");
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
		if (e.issue_title) lines.push(`Title: ${e.issue_title}`);
		if (e.status) lines.push(`Status: ${e.status}`);
		if (e.decision_route) lines.push(`Route: ${e.decision_route}`);
		if (e.summary) lines.push(`Summary: ${e.summary.slice(0, 300)}`);
		if (e.last_error) lines.push(`Error: ${e.last_error.slice(0, 200)}`);
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

		// FLY-161: non-blocking Runner questions (`flywheel-comm ask`). Lead
		// surfaces these to Annie, but the Runner is NOT blocked — phrase the
		// snapshot text accordingly so the Lead doesn't treat them like gates.
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

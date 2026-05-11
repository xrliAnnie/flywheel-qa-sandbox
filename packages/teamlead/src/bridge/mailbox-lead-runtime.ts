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
import type {
	DeliveryResult,
	LeadBootstrap,
	LeadEventEnvelope,
	LeadRuntime,
	LeadRuntimeHealth,
} from "./lead-runtime.js";

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
			this.lastDeliveredSeq = envelope.seq;
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

		if (e.event_type === "gate_question") {
			const tag = e.checkpoint?.toUpperCase() ?? "GATE";
			const issueRef = e.issue_identifier || e.issue_id;
			const roleLabel =
				e.session_role && e.session_role !== "main"
					? `[${e.session_role.toUpperCase()}] `
					: "";
			const lines = [
				`[Event #${env.seq}] ${roleLabel}gate_question`,
				`ID: ${e.execution_id || "---"} | Issue: ${issueRef || "---"}`,
				`[${tag}] Runner asks:`,
				"---",
				e.summary ?? "(no content)",
				"---",
				`Reply to approve or provide feedback. Question ID: ${e.question_id}`,
				`CommDB: ${e.comm_db_path}`,
			];
			if (e.chat_thread_id) lines.push(`Chat-Thread: ${e.chat_thread_id}`);
			return lines.join("\n");
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
		if (e.thread_id) lines.push(`Forum-Thread: ${e.thread_id}`);
		if (e.forum_channel) lines.push(`Forum: ${e.forum_channel}`);
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

		if (snapshot.memoryRecall) {
			sections.push("### Memory Recall");
			sections.push(snapshot.memoryRecall);
			sections.push("");
		}

		return sections.join("\n");
	}
}

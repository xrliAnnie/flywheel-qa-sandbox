/**
 * FLY-47: CommDBLeadRuntime — delivers events to Lead via CommDB instructions.
 *
 * Replaces ClaudeDiscordRuntime: instead of posting to a Discord control channel,
 * writes to CommDB as instructions. Lead picks these up via inbox-check.sh hook
 * (same mechanism as Runner → Lead communication).
 *
 * This eliminates the need for:
 * - ClaudeBot token for internal Bridge → Lead communication
 * - allowBots Discord configuration
 * - Discord control channel as internal transport
 *
 * Discord is now only used for Lead → Annie (outbound Chat messages).
 */

import { CommDB } from "flywheel-comm/db";
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
			const content = this.formatEnvelope(envelope);
			this.commDb.insertInstruction("bridge", this.leadId, content);
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

	private formatEnvelope(env: LeadEventEnvelope): string {
		const e = env.event;

		// FLY-62: gate_question gets a special format
		if (e.event_type === "gate_question") {
			const tag = e.checkpoint?.toUpperCase() ?? "GATE";
			const issueRef = e.issue_identifier || e.issue_id;
			const lines = [
				`[Event #${env.seq}] gate_question`,
				`ID: ${e.execution_id || "---"} | Issue: ${issueRef || "---"}`,
				`[${tag}] Runner asks:`,
				"---",
				e.summary ?? "(no content)",
				"---",
				`Reply to approve or provide feedback. Question ID: ${e.question_id}`,
				`CommDB: ${e.comm_db_path}`,
			];
			return lines.join("\n");
		}

		const lines = [
			`[Event #${env.seq}] ${e.event_type}`,
			`ID: ${e.execution_id || "—"} | Issue: ${e.issue_identifier || e.issue_id || "—"}`,
		];
		if (e.issue_title) lines.push(`Title: ${e.issue_title}`);
		if (e.status) lines.push(`Status: ${e.status}`);
		if (e.decision_route) lines.push(`Route: ${e.decision_route}`);
		if (e.summary) lines.push(`Summary: ${e.summary.slice(0, 300)}`);
		if (e.last_error) lines.push(`Error: ${e.last_error.slice(0, 200)}`);
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
		if (e.thread_id) lines.push(`Thread: ${e.thread_id}`);
		if (e.forum_channel) lines.push(`Forum: ${e.forum_channel}`);

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
				sections.push(
					`- ${s.issueIdentifier ?? s.issueId}: ${s.issueTitle ?? "—"} [${s.status}]`,
				);
			}
			sections.push("");
		}

		if (snapshot.pendingDecisions.length > 0) {
			sections.push("### Pending Decisions");
			for (const d of snapshot.pendingDecisions) {
				sections.push(
					`- ${d.issueIdentifier ?? d.issueId}: ${d.issueTitle ?? "—"} (${d.decisionRoute ?? "unknown"})`,
				);
			}
			sections.push("");
		}

		if (snapshot.recentFailures.length > 0) {
			sections.push("### Recent Failures");
			for (const f of snapshot.recentFailures) {
				sections.push(
					`- ${f.issueIdentifier ?? f.issueId}: ${f.lastError?.slice(0, 100) ?? "—"}`,
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
				sections.push(
					`- [${tag}] ${issue} (ID: ${gq.questionId}, DB: ${gq.commDbPath}): ${gq.content.slice(0, 200)}${gq.content.length > 200 ? "..." : ""}`,
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

/**
 * GEO-195: ClaudeDiscordRuntime — delivers events to a Claude Code persistent
 * session via a hidden Discord control channel. Uses Discord REST API directly.
 */

import {
	DISCORD_API,
	splitDiscordMessage,
} from "./discord-utils.js";
import type {
	LeadBootstrap,
	LeadEventEnvelope,
	LeadRuntime,
	LeadRuntimeHealth,
} from "./lead-runtime.js";

const DELIVERY_TIMEOUT_MS = 3000;

export class ClaudeDiscordRuntime implements LeadRuntime {
	readonly type = "claude-discord" as const;
	private lastDeliveryAt: string | null = null;
	private lastDeliveredSeq = 0;

	constructor(
		private controlChannelId: string,
		private discordBotToken: string,
	) {}

	async deliver(envelope: LeadEventEnvelope): Promise<void> {
		const content = this.formatEnvelope(envelope);
		await this.postDiscordMessage(content);
		this.lastDeliveryAt = new Date().toISOString();
		this.lastDeliveredSeq = envelope.seq;
	}

	async sendBootstrap(snapshot: LeadBootstrap): Promise<void> {
		const content = this.formatBootstrap(snapshot);
		// Bootstrap can be large — split into chunks if needed
		const chunks = splitDiscordMessage(content);
		for (const chunk of chunks) {
			// throwOnError=true so bootstrap endpoint can report delivery failure
			await this.postDiscordMessage(chunk, true);
		}
	}

	async health(): Promise<LeadRuntimeHealth> {
		return {
			status: this.lastDeliveryAt ? "healthy" : "degraded",
			lastDeliveryAt: this.lastDeliveryAt,
			lastDeliveredSeq: this.lastDeliveredSeq,
		};
	}

	async shutdown(): Promise<void> {
		// No persistent connection to clean up — Discord REST is stateless.
	}

	/**
	 * Post a message to the Discord control channel.
	 * @param throwOnError If true, throw on non-ok response or network failure
	 *   instead of swallowing. Used by sendBootstrap() so the bootstrap endpoint
	 *   can report delivery failures.
	 */
	private async postDiscordMessage(
		content: string,
		throwOnError = false,
	): Promise<void> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
		try {
			const res = await fetch(
				`${DISCORD_API}/channels/${this.controlChannelId}/messages`,
				{
					method: "POST",
					headers: {
						Authorization: `Bot ${this.discordBotToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ content }),
					signal: controller.signal,
				},
			);
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				if (throwOnError) {
					throw new Error(
						`Discord returned ${res.status}: ${body.slice(0, 200)}`,
					);
				}
				console.warn(
					`[claude-discord] Discord returned ${res.status}: ${body.slice(0, 200)}`,
				);
			}
		} catch (err) {
			if (throwOnError) throw err;
			console.warn(
				"[claude-discord] Failed to deliver to control channel:",
				(err as Error).message,
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	private formatEnvelope(env: LeadEventEnvelope): string {
		const e = env.event;
		const lines = [
			`**[Event #${env.seq}]** \`${e.event_type}\``,
			`> **ID**: \`${e.execution_id || "—"}\` | **Issue**: \`${e.issue_identifier || e.issue_id || "—"}\``,
		];
		if (e.issue_title) lines.push(`> **Title**: ${e.issue_title}`);
		if (e.status) lines.push(`> **Status**: ${e.status}`);
		if (e.decision_route) lines.push(`> **Route**: ${e.decision_route}`);
		if (e.summary) lines.push(`> **Summary**: ${e.summary.slice(0, 300)}`);
		if (e.last_error) lines.push(`> **Error**: ${e.last_error.slice(0, 200)}`);
		if (e.action)
			lines.push(
				`> **Action**: ${e.action} (${e.action_source_status} → ${e.action_target_status})`,
			);
		if (e.commit_count)
			lines.push(
				`> **Commits**: ${e.commit_count} | +${e.lines_added ?? 0}/-${e.lines_removed ?? 0}`,
			);
		if (e.filter_priority) lines.push(`> **Priority**: ${e.filter_priority}`);
		if (e.notification_context)
			lines.push(`> **Context**: ${e.notification_context}`);
		if (e.thread_id) lines.push(`> **Thread**: ${e.thread_id}`);
		if (e.forum_channel) lines.push(`> **Forum**: ${e.forum_channel}`);

		lines.push(
			`> **Timestamp**: ${env.timestamp} | **Session Key**: \`${env.sessionKey}\``,
		);
		return lines.join("\n");
	}

	private formatBootstrap(snapshot: LeadBootstrap): string {
		const sections: string[] = [
			`## 🔄 Bootstrap — Lead: ${snapshot.leadId}`,
			`*Generated at ${new Date().toISOString()}*`,
			"",
		];

		// Active sessions
		if (snapshot.activeSessions.length > 0) {
			sections.push("### Active Sessions");
			for (const s of snapshot.activeSessions) {
				sections.push(
					`- \`${s.issueIdentifier ?? s.issueId}\`: ${s.issueTitle ?? "—"} [${s.status}]`,
				);
			}
			sections.push("");
		}

		// Pending decisions
		if (snapshot.pendingDecisions.length > 0) {
			sections.push("### Pending Decisions");
			for (const d of snapshot.pendingDecisions) {
				sections.push(
					`- \`${d.issueIdentifier ?? d.issueId}\`: ${d.issueTitle ?? "—"} (${d.decisionRoute ?? "unknown"})`,
				);
			}
			sections.push("");
		}

		// Recent failures
		if (snapshot.recentFailures.length > 0) {
			sections.push("### Recent Failures");
			for (const f of snapshot.recentFailures) {
				sections.push(
					`- \`${f.issueIdentifier ?? f.issueId}\`: ${f.lastError?.slice(0, 100) ?? "—"}`,
				);
			}
			sections.push("");
		}

		// Recent events (for re-processing)
		if (snapshot.recentEvents.length > 0) {
			sections.push(
				`### Recent Events (last 5 min — ${snapshot.recentEvents.length} events)`,
			);
			for (const e of snapshot.recentEvents) {
				sections.push(
					`- [#${e.seq}] \`${e.event.event_type}\` — ${e.event.issue_identifier ?? e.event.issue_id ?? "—"}`,
				);
			}
			sections.push("");
		}

		// Memory recall
		if (snapshot.memoryRecall) {
			sections.push("### Memory Recall");
			sections.push(snapshot.memoryRecall.slice(0, 500));
			sections.push("");
		}

		return sections.join("\n");
	}

}

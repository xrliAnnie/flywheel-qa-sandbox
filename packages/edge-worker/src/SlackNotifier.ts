import type { DecisionResult, ExecutionContext } from "flywheel-core";
import type { SlackMessageService } from "flywheel-slack-event-transport";

export interface SlackNotifierConfig {
	channelId: string;
	botToken: string;
	projectRepo?: string;
	linearTeamKey?: string;
}

export class SlackNotifier {
	constructor(
		private config: SlackNotifierConfig,
		private messageService: SlackMessageService,
	) {}

	async notify(
		ctx: ExecutionContext,
		decision: DecisionResult,
		extra?: { tmuxSession?: string; consecutiveFailures?: number },
	): Promise<{ sent: boolean }> {
		if (decision.route === "auto_approve") {
			return { sent: false };
		}

		const blocks =
			decision.route === "needs_review"
				? this.buildNeedsReviewBlocks(ctx, decision)
				: this.buildBlockedBlocks(ctx, decision, extra);

		const fallbackText =
			decision.route === "needs_review"
				? `Review Required: ${ctx.issueIdentifier} — ${ctx.issueTitle}`
				: `Blocked: ${ctx.issueIdentifier} — ${ctx.issueTitle}`;

		await this.messageService.postMessage({
			token: this.config.botToken,
			channel: this.config.channelId,
			text: fallbackText,
			blocks,
		});

		return { sent: true };
	}

	private buildNeedsReviewBlocks(
		ctx: ExecutionContext,
		decision: DecisionResult,
	): unknown[] {
		const blocks: unknown[] = [
			// Header
			{
				type: "header",
				text: {
					type: "plain_text",
					text: `Review Required: ${ctx.issueIdentifier}`,
				},
			},
			// Issue info
			{
				type: "section",
				fields: [
					{
						type: "mrkdwn",
						text: `*Issue:*\n${ctx.issueIdentifier}: ${ctx.issueTitle}`,
					},
					{
						type: "mrkdwn",
						text: `*Commits:*\n${ctx.commitCount}`,
					},
					{
						type: "mrkdwn",
						text: `*Changed:*\n${ctx.filesChangedCount} files (+${ctx.linesAdded}/-${ctx.linesRemoved})`,
					},
					{
						type: "mrkdwn",
						text: `*Duration:*\n${Math.round(ctx.durationMs / 1000)}s`,
					},
				],
			},
			// Decision reasoning
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: [
						`*Decision:* ${decision.route} (confidence: ${(decision.confidence * 100).toFixed(0)}%)`,
						`*Reasoning:* ${decision.reasoning}`,
					].join("\n"),
				},
			},
		];

		// Concerns (conditional)
		if (decision.concerns.length > 0) {
			blocks.push({
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Concerns:*\n${decision.concerns.map((c) => `- ${c}`).join("\n")}`,
				},
			});
		}

		// Commit messages (truncate to stay within Slack's 3000-char section limit)
		if (ctx.commitMessages.length > 0) {
			const maxChars = 2500; // leave room for label + formatting
			const lines: string[] = [];
			let charCount = 0;
			for (const msg of ctx.commitMessages) {
				if (charCount + msg.length + 1 > maxChars) break;
				lines.push(msg);
				charCount += msg.length + 1;
			}
			const omitted = ctx.commitMessages.length - lines.length;
			let text = `*Commit messages:*\n\`\`\`\n${lines.join("\n")}\n\`\`\``;
			if (omitted > 0) {
				text += `\n_...and ${omitted} more_`;
			}
			blocks.push({
				type: "section",
				text: { type: "mrkdwn", text },
			});
		}

		// Action buttons
		const prUrl = this.config.projectRepo
			? `https://github.com/${this.config.projectRepo}/pulls`
			: undefined;

		const elements: unknown[] = [
			{
				type: "button",
				text: { type: "plain_text", text: "Approve & Merge" },
				style: "primary",
				action_id: `flywheel_approve_${ctx.issueId}`,
				value: JSON.stringify({ issueId: ctx.issueId, action: "approve" }),
			},
			{
				type: "button",
				text: { type: "plain_text", text: "Reject" },
				style: "danger",
				action_id: `flywheel_reject_${ctx.issueId}`,
				value: JSON.stringify({ issueId: ctx.issueId, action: "reject" }),
			},
			{
				type: "button",
				text: { type: "plain_text", text: "Defer" },
				action_id: `flywheel_defer_${ctx.issueId}`,
				value: JSON.stringify({ issueId: ctx.issueId, action: "defer" }),
			},
		];

		if (prUrl) {
			elements.push({
				type: "button",
				text: { type: "plain_text", text: "View PR" },
				url: prUrl,
				action_id: `flywheel_view_pr_${ctx.issueId}`,
			});
		}

		blocks.push({ type: "actions", elements });

		// Footer
		const attempt = (ctx.consecutiveFailures ?? 0) + 1;
		blocks.push({
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: `Flywheel Decision Layer | Source: ${decision.decisionSource} | Attempt: ${attempt}`,
				},
			],
		});

		return blocks;
	}

	private buildBlockedBlocks(
		ctx: ExecutionContext,
		decision: DecisionResult,
		extra?: { tmuxSession?: string; consecutiveFailures?: number },
	): unknown[] {
		const attempt = (extra?.consecutiveFailures ?? ctx.consecutiveFailures ?? 0) + 1;

		return [
			// Header
			{
				type: "header",
				text: {
					type: "plain_text",
					text: `Blocked: ${ctx.issueIdentifier}`,
				},
			},
			// Info
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: [
						`:warning: *${ctx.issueIdentifier}: ${ctx.issueTitle}* is blocked.`,
						"",
						`*Reason:* ${decision.reasoning}`,
						`*Attempts:* ${attempt}`,
						`*Consecutive failures:* ${ctx.consecutiveFailures}`,
					].join("\n"),
				},
			},
			// Action buttons
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Retry" },
						style: "primary",
						action_id: `flywheel_retry_${ctx.issueId}`,
						value: JSON.stringify({ issueId: ctx.issueId, action: "retry" }),
					},
					{
						type: "button",
						text: { type: "plain_text", text: "Shelve" },
						action_id: `flywheel_shelve_${ctx.issueId}`,
						value: JSON.stringify({ issueId: ctx.issueId, action: "shelve" }),
					},
				],
			},
		];
	}
}

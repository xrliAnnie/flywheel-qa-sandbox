import type { SlackBot } from "./SlackBot.js";
import type { StateStore, Session } from "./StateStore.js";

/**
 * Template-based Slack notifications.
 * Sends Block Kit messages via SlackBot and tracks conversation threads.
 */
export class TemplateNotifier {
	constructor(
		private bot: SlackBot,
		private store: StateStore,
	) {}

	async onSessionCompleted(session: Session): Promise<void> {
		const route = session.decision_route;

		if (route === "auto_approve" || session.status === "approved") {
			const text = `Auto-approved: ${session.issue_identifier ?? session.issue_id} — ${session.summary ?? "completed"}`;
			const ts = await this.bot.postMessage(text);
			if (ts) this.store.upsertThread(ts, "", session.issue_id);
			return;
		}

		if (route === "needs_review" || session.status === "awaiting_review") {
			const blocks = this.buildNeedsReviewBlocks(session);
			const text = `Review Required: ${session.issue_identifier ?? session.issue_id}`;
			const ts = await this.bot.postMessage(text, blocks);
			if (ts) this.store.upsertThread(ts, "", session.issue_id);
			return;
		}

		if (route === "blocked" || session.status === "blocked") {
			const blocks = this.buildBlockedBlocks(session);
			const text = `Blocked: ${session.issue_identifier ?? session.issue_id}`;
			const ts = await this.bot.postMessage(text, blocks);
			if (ts) this.store.upsertThread(ts, "", session.issue_id);
			return;
		}

		// Fallback — generic completed
		const text = `Completed: ${session.issue_identifier ?? session.issue_id} — ${session.summary ?? "done"}`;
		const ts = await this.bot.postMessage(text);
		if (ts) this.store.upsertThread(ts, "", session.issue_id);
	}

	async onSessionFailed(session: Session): Promise<void> {
		const blocks = this.buildFailedBlocks(session);
		const text = `Failed: ${session.issue_identifier ?? session.issue_id}`;
		const ts = await this.bot.postMessage(text, blocks);
		if (ts) this.store.upsertThread(ts, "", session.issue_id);
	}

	async onSessionStuck(session: Session, minutesSinceActivity: number): Promise<void> {
		const blocks = this.buildStuckBlocks(session, minutesSinceActivity);
		const text = `Possible Stuck: ${session.issue_identifier ?? session.issue_id}`;
		const ts = await this.bot.postMessage(text, blocks);
		if (ts) this.store.upsertThread(ts, "", session.issue_id);
	}

	private buildNeedsReviewBlocks(session: Session): unknown[] {
		const identifier = session.issue_identifier ?? session.issue_id;
		const blocks: unknown[] = [
			{
				type: "header",
				text: { type: "plain_text", text: `Review Required: ${identifier}` },
			},
			{
				type: "section",
				fields: [
					{ type: "mrkdwn", text: `*Issue:*\n${identifier}: ${session.issue_title ?? ""}` },
					{ type: "mrkdwn", text: `*Commits:*\n${session.commit_count ?? 0}` },
					{
						type: "mrkdwn",
						text: `*Changed:*\n${session.files_changed ?? 0} files (+${session.lines_added ?? 0}/-${session.lines_removed ?? 0})`,
					},
				],
			},
		];

		if (session.decision_reasoning) {
			blocks.push({
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Decision:* ${session.decision_route ?? "needs_review"}\n*Reasoning:* ${session.decision_reasoning}`,
				},
			});
		}

		const valueBase = { issueId: session.issue_id, executionId: session.execution_id };
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Approve & Merge" },
					style: "primary",
					action_id: `flywheel_approve_${session.issue_id}`,
					value: JSON.stringify({ ...valueBase, action: "approve" }),
				},
				{
					type: "button",
					text: { type: "plain_text", text: "Reject" },
					style: "danger",
					action_id: `flywheel_reject_${session.issue_id}`,
					value: JSON.stringify({ ...valueBase, action: "reject" }),
				},
				{
					type: "button",
					text: { type: "plain_text", text: "Defer" },
					action_id: `flywheel_defer_${session.issue_id}`,
					value: JSON.stringify({ ...valueBase, action: "defer" }),
				},
			],
		});

		return blocks;
	}

	private buildBlockedBlocks(session: Session): unknown[] {
		const identifier = session.issue_identifier ?? session.issue_id;
		const valueBase = { issueId: session.issue_id, executionId: session.execution_id };

		return [
			{
				type: "header",
				text: { type: "plain_text", text: `Blocked: ${identifier}` },
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `:warning: *${identifier}: ${session.issue_title ?? ""}* is blocked.\n\n*Reason:* ${session.decision_reasoning ?? "Unknown"}`,
				},
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Retry" },
						style: "primary",
						action_id: `flywheel_retry_${session.issue_id}`,
						value: JSON.stringify({ ...valueBase, action: "retry" }),
					},
					{
						type: "button",
						text: { type: "plain_text", text: "Shelve" },
						action_id: `flywheel_shelve_${session.issue_id}`,
						value: JSON.stringify({ ...valueBase, action: "shelve" }),
					},
				],
			},
		];
	}

	private buildFailedBlocks(session: Session): unknown[] {
		const identifier = session.issue_identifier ?? session.issue_id;
		const valueBase = { issueId: session.issue_id, executionId: session.execution_id };

		return [
			{
				type: "header",
				text: { type: "plain_text", text: `Failed: ${identifier}` },
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Error:* ${session.last_error ?? "Unknown error"}`,
				},
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Retry" },
						style: "primary",
						action_id: `flywheel_retry_${session.issue_id}`,
						value: JSON.stringify({ ...valueBase, action: "retry" }),
					},
					{
						type: "button",
						text: { type: "plain_text", text: "Shelve" },
						action_id: `flywheel_shelve_${session.issue_id}`,
						value: JSON.stringify({ ...valueBase, action: "shelve" }),
					},
				],
			},
		];
	}

	private buildStuckBlocks(session: Session, minutesSinceActivity: number): unknown[] {
		const identifier = session.issue_identifier ?? session.issue_id;

		return [
			{
				type: "header",
				text: { type: "plain_text", text: `Possible Stuck: ${identifier}` },
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `No activity for *${minutesSinceActivity}* minutes`,
				},
			},
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: `execution: ${session.execution_id} | started: ${session.started_at ?? "unknown"}`,
					},
				],
			},
		];
	}
}

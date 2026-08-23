import { phaseMessageTag } from "flywheel-config";
import {
	type ProjectEntry,
	resolveAnnouncerBotToken,
	resolveLeadForIssue,
} from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import { postDiscordMessageToChannel } from "./discord-utils.js";
import type { BridgeConfig } from "./types.js";

export interface ReviewThreadEffectDeps {
	store: StateStore;
	projects: ProjectEntry[];
	config: BridgeConfig;
	fetchImpl?: typeof fetch;
}

/** Neutral result-bearing issue-thread post used by review workflows. */
export class ReviewThreadEffect {
	constructor(private readonly deps: ReviewThreadEffectDeps) {}

	private resolveThread(
		session: Session,
	): { threadId: string; botToken: string } | undefined {
		try {
			const { lead } = resolveLeadForIssue(
				this.deps.projects,
				session.project_name,
				parseLabels(session.issue_labels),
			);
			const channel = lead.chatChannel;
			const botToken = lead.botToken ?? this.deps.config.discordBotToken;
			if (!channel || !botToken) return undefined;
			const thread = this.deps.store.getChatThreadByIssue(
				session.issue_id,
				channel,
			);
			return thread ? { threadId: thread.thread_id, botToken } : undefined;
		} catch {
			return undefined;
		}
	}

	async postThread(args: { session: Session; text: string }): Promise<void> {
		await this.postThreadResult(args);
	}

	async postThreadResult(args: {
		session: Session;
		text: string;
	}): Promise<{ ok: boolean; messageId?: string }> {
		const thread = this.resolveThread(args.session);
		if (!thread) {
			console.warn(
				`[review-thread-effect] no chat thread for ${args.session.issue_id} — skipping thread post`,
			);
			return { ok: false };
		}
		const prefix = phaseMessageTag(
			args.session.chat_thread_role,
			args.session.runner_model,
			args.session.design_backend,
		);
		const botToken =
			resolveAnnouncerBotToken(this.deps.projects, args.session.project_name) ??
			thread.botToken;
		const result = await postDiscordMessageToChannel(
			thread.threadId,
			`${prefix}${args.text}`,
			botToken,
			{ origin: "automation" },
			this.deps.fetchImpl ?? fetch,
		);
		if (!result.ok) {
			console.warn(
				`[review-thread-effect] thread post failed for ${args.session.issue_id}: ${result.error}`,
			);
			return { ok: false };
		}
		return { ok: true, messageId: result.messageIds[0] };
	}
}

function parseLabels(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value)
			? value.filter((label): label is string => typeof label === "string")
			: [];
	} catch {
		return [];
	}
}

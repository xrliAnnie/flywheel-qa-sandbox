import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import {
	discordId,
	readDiscordJson,
} from "../ship-judgment/discord-message.js";
import type { FounderReplyDeliverDeps } from "./founder-reply-deliverer.js";

export interface ShipJudgmentReplyThreadPage {
	threads: {
		threadId: string;
		issueId: string;
		projectName: string;
		leadId: string;
	}[];
	nextCursor?: string;
}
export function listShipJudgmentReplyThreads(
	deps: { store: StateStore; projects: ProjectEntry[]; mode(): string },
	after?: string,
): ShipJudgmentReplyThreadPage {
	const rows = deps.store
		.getShipJudgmentClarifications(deps.mode)
		.replyThreads(after);
	const threads: ShipJudgmentReplyThreadPage["threads"] = [];
	for (const row of rows) {
		const holder = deps.store.getWorkflowGateHolderByQuestionId(row.questionId);
		const run = holder ? deps.store.getWorkflowRun(holder.run_id) : undefined;
		if (!holder || run?.project_name !== "flywheel") continue;
		const lead = resolveLeadForIssue(
			deps.projects,
			"flywheel",
			deps.store.getSessionLabels(holder.source_execution_id),
		);
		if (lead.matchMethod !== "label") continue;
		threads.push({
			threadId: row.threadId,
			issueId: run.issue_id,
			projectName: "flywheel",
			leadId: lead.lead.agentId,
		});
	}
	return { threads, nextCursor: rows.at(-1)?.threadId };
}

/** Reference-only ingress; original message text/identity always comes from an authenticated fetch. */
export function createShipJudgmentReplyObserver(deps: {
	store: StateStore;
	projects: ProjectEntry[];
	mode(): string;
	canonicalFounderId(): string | undefined;
	defaultBotToken?: string;
	fetchImpl?: typeof fetch;
}): NonNullable<FounderReplyDeliverDeps["observeShipJudgmentReply"]> {
	return async (reference) => {
		if (reference.projectName !== "flywheel") return "ignored";
		const target = deps.store
			.getShipJudgmentClarifications(deps.mode)
			.replyTarget(reference.threadId, reference.replyToMessageId);
		if (!target) return "ignored";
		const holder = deps.store.getWorkflowGateHolderByQuestionId(
			target.questionId,
		);
		if (
			!holder ||
			deps.store.getWorkflowRun(holder.run_id)?.project_name !== "flywheel"
		)
			return "retry";
		const lead = resolveLeadForIssue(
			deps.projects,
			"flywheel",
			deps.store.getSessionLabels(holder.source_execution_id),
		);
		const token = lead.lead?.botToken ?? deps.defaultBotToken;
		if (
			lead.matchMethod !== "label" ||
			lead.lead.agentId !== reference.leadId ||
			!token ||
			!discordId.safeParse(deps.canonicalFounderId()).success
		)
			return "retry";
		const observer = deps.store.getShipJudgmentClarifications(deps.mode, {
			canonicalFounderId: deps.canonicalFounderId,
			fetchMessage: async (ref, signal) => {
				const response = await (deps.fetchImpl ?? fetch)(
					`https://discord.com/api/v10/channels/${ref.threadId}/messages/${ref.messageId}`,
					{
						headers: { Authorization: `Bot ${token}` },
						signal,
						redirect: "error",
					},
				);
				if (!response.ok) {
					await response.body?.cancel();
					throw new Error("learning_reply_fetch_failed");
				}
				return readDiscordJson(response, signal, 65536);
			},
		});
		const result = await observer.observe(
			{
				threadId: reference.threadId,
				messageId: reference.messageId,
				replyToMessageId: reference.replyToMessageId,
			},
			Date.now(),
			AbortSignal.timeout(10_000),
		);
		return result.status === "recorded" || result.status === "existing"
			? "handled"
			: result.status === "unavailable"
				? "retry"
				: "ignored";
	};
}

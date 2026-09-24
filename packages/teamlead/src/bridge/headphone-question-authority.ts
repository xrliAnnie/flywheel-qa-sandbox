import type { CommDB } from "flywheel-comm/db";
import type {
	HeadphoneCollectorMessage,
	HeadphoneCollectorScope,
} from "./headphone-collector.js";
import type { HeadphoneInboxStore } from "./headphone-inbox.js";

type QuestionDb = Pick<
	CommDB,
	"close" | "getMessageById" | "isQuestionPending" | "listAttentionQuestions"
>;

export interface HeadphoneAuthorityProject {
	projectName: string;
	leads: readonly {
		agentId: string;
		chatChannel: string;
		botUserId?: string;
		botToken?: string;
	}[];
}

export interface HeadphoneQuestionAuthorityOptions {
	store: HeadphoneInboxStore;
	founderUserId: string;
	projects: readonly HeadphoneAuthorityProject[];
	openCommDb(projectName: string): QuestionDb;
	questionIdByMessage(
		projectName: string,
		messageId: string,
	): string | undefined;
	botUserIdFromToken(token: string | undefined): string | null;
	globalBotUserId?: string | null;
	log?: (message: string) => void;
}

/** Joins Discord cards to CommDB question authority without text heuristics. */
export class HeadphoneQuestionAuthority {
	constructor(private readonly options: HeadphoneQuestionAuthorityOptions) {}

	classifyMessages(
		scope: HeadphoneCollectorScope,
		messages: readonly HeadphoneCollectorMessage[],
	): ReadonlyMap<
		string,
		{ questionId: string; needsDecision: boolean; resolved: boolean }
	> {
		const bindings = new Map<string, string>();
		for (const message of messages) {
			try {
				const questionId = this.options.questionIdByMessage(
					scope.projectName,
					message.id,
				);
				if (questionId) bindings.set(message.id, questionId);
			} catch (error) {
				this.options.log?.(
					`[headphone-inbox] question binding ignored for ${scope.projectName}/${message.id}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (bindings.size === 0) return new Map();
		let db: QuestionDb;
		try {
			db = this.options.openCommDb(scope.projectName);
		} catch (error) {
			this.options.log?.(
				`[headphone-inbox] question classification unavailable for ${scope.projectName}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return new Map();
		}
		try {
			const result = new Map<
				string,
				{ questionId: string; needsDecision: boolean; resolved: boolean }
			>();
			for (const [messageId, questionId] of bindings) {
				try {
					const question = db.getMessageById(questionId);
					if (!question || question.type !== "question")
						throw new Error("headphone_question_authority_missing");
					const pending =
						db.isQuestionPending(questionId) &&
						question.resolved_at === null &&
						question.superseded_at === null;
					result.set(messageId, {
						questionId,
						needsDecision: true,
						resolved: !pending,
					});
				} catch (error) {
					this.options.log?.(
						`[headphone-inbox] question authority ignored for ${scope.projectName}/${messageId}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			return result;
		} finally {
			db.close();
		}
	}

	projectQuestions(): void {
		for (const project of this.options.projects) {
			let db: QuestionDb | undefined;
			try {
				db = this.options.openCommDb(project.projectName);
				const openQuestionIds: string[] = [];
				let authorityComplete = true;
				let cursor: { created_at: string; id: string } | null | undefined;
				do {
					const page = db.listAttentionQuestions({
						limit: 1_000,
						...(cursor ? { cursor } : {}),
					});
					for (const summary of page.questions) {
						if (summary.kind !== "ship" && summary.kind !== "founder_gate")
							continue;
						try {
							const question = db.getMessageById(summary.id);
							if (!question)
								throw new Error("headphone_founder_question_missing");
							if (!db.isQuestionPending(summary.id)) continue;
							const lead = project.leads.find(
								(candidate) => candidate.agentId === question.to_agent,
							);
							const authorId =
								lead?.botUserId ??
								this.options.botUserIdFromToken(lead?.botToken) ??
								this.options.globalBotUserId;
							if (!lead?.chatChannel || !authorId || !question.content.trim())
								throw new Error("headphone_founder_question_route_missing");
							this.options.store.upsert({
								questionId: question.id,
								projectName: project.projectName,
								founderUserId: this.options.founderUserId,
								channelId: lead.chatChannel,
								sourceMessageId: question.id,
								sourceRevision: `comm:${question.id}`,
								authorId,
								needsDecision: true,
								text: question.content.trim(),
								sourceCreatedAt: question.created_at,
							});
							openQuestionIds.push(question.id);
						} catch (error) {
							authorityComplete = false;
							this.options.log?.(
								`[headphone-inbox] question projection ignored for ${project.projectName}/${summary.id}: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}
					cursor = page.nextCursor;
				} while (cursor);
				if (authorityComplete)
					this.options.store.reconcileQuestionAuthority({
						projectName: project.projectName,
						founderUserId: this.options.founderUserId,
						openQuestionIds,
					});
			} catch (error) {
				this.options.log?.(
					`[headphone-inbox] question projection failed for ${project.projectName}: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				db?.close();
			}
		}
	}
}

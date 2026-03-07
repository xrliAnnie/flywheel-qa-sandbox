import Anthropic from "@anthropic-ai/sdk";
import type { StateStore } from "./StateStore.js";
import { PromptAssembler } from "./PromptAssembler.js";

export interface BrainConfig {
	model: string;
	maxTokens: number;
}

const ISSUE_ID_PATTERN = /[A-Za-z][A-Za-z0-9_-]*-\d+/g;

function extractIssueIds(text: string): string[] {
	return [...new Set(text.match(ISSUE_ID_PATTERN) ?? [])];
}

export class TeamLeadBrain {
	private client: Anthropic;
	private assembler: PromptAssembler;
	private config: BrainConfig;

	constructor(
		config: BrainConfig,
		private store: StateStore,
		apiKey: string,
		client?: Anthropic,
	) {
		this.config = config;
		this.client = client ?? new Anthropic({ apiKey });
		this.assembler = new PromptAssembler();
	}

	async answer(question: string, threadTs?: string): Promise<string | null> {
		// 1. Extract issue IDs from question
		const issueIds = extractIssueIds(question);
		let focusIssueId = issueIds[0];

		// 2. If threadTs, look up issue from conversation_threads
		if (!focusIssueId && threadTs) {
			focusIssueId = this.store.getThreadIssue(threadTs) ?? undefined;
		}

		// 3. Load context from StateStore
		const activeSessions = this.store.getRecentSessions(20);
		const issueHistory = focusIssueId
			? this.store.getSessionHistory(focusIssueId, 5)
			: undefined;
		// Use the most recent session from history as focus (avoids extra DB query)
		const focusSession = issueHistory?.length
			? issueHistory[issueHistory.length - 1]
			: undefined;

		// 4. Assemble prompt
		const prompt = this.assembler.assemble(
			question,
			activeSessions,
			focusSession,
			issueHistory,
		);

		// 5. Call Anthropic
		try {
			const response = await this.client.messages.create({
				model: this.config.model,
				max_tokens: this.config.maxTokens,
				system: prompt.system,
				messages: [{ role: "user", content: prompt.userContent }],
			});

			// 6. Extract text response
			const textBlock = response.content.find(
				(block: any) => block.type === "text",
			);
			return textBlock ? (textBlock as any).text : null;
		} catch (err: unknown) {
			const status = (err as any)?.status;
			if (status === 429) {
				return "I'm being rate-limited right now. Please try again in a moment.";
			}
			console.error("[TeamLeadBrain] LLM error:", err);
			return "Something went wrong. Please try again later.";
		}
	}
}

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
		// 1. Extract issue identifiers from question (e.g., "GEO-95")
		const issueIds = extractIssueIds(question);
		let focusIdentifier = issueIds[0];

		// 2. If threadTs, look up issue_id from conversation_threads, then resolve identifier
		if (!focusIdentifier && threadTs) {
			const threadIssueId = this.store.getThreadIssue(threadTs);
			if (threadIssueId) {
				// Thread stores issue_id (UUID); look up the session to get its identifier
				const session = this.store.getSessionByIssue(threadIssueId);
				focusIdentifier = session?.issue_identifier;
			}
		}

		// 3. Load context from StateStore
		// CEO mentions identifiers like "GEO-95", which map to issue_identifier (not issue_id UUID)
		const activeSessions = this.store.getRecentSessions(20);
		const issueHistory = focusIdentifier
			? this.store.getSessionHistoryByIdentifier(focusIdentifier, 5)
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

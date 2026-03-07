import { spawn } from "node:child_process";
import type { StateStore } from "./StateStore.js";
import { PromptAssembler } from "./PromptAssembler.js";

export interface BrainConfig {
	model: string;
	maxTokens: number;
}

/**
 * Generic LLM call function — abstracts SDK vs CLI backends.
 */
export type LlmCall = (system: string, userContent: string) => Promise<string | null>;

/**
 * Create an LLM backend using the Anthropic SDK (requires API key).
 */
export async function createSdkLlm(apiKey: string, model: string, maxTokens: number): Promise<LlmCall> {
	const { default: Anthropic } = await import("@anthropic-ai/sdk");
	const client = new Anthropic({ apiKey });
	return async (system, userContent) => {
		const response = await client.messages.create({
			model,
			max_tokens: maxTokens,
			system,
			messages: [{ role: "user", content: userContent }],
		});
		const textBlock = response.content.find((b: any) => b.type === "text");
		return textBlock ? (textBlock as any).text : null;
	};
}

/**
 * Create an LLM backend using the Claude CLI (uses subscription, no API key needed).
 * Spawns `claude -p` as a subprocess for each call.
 */
export function createCliLlm(model: string): LlmCall {
	return (system, userContent) => {
		return new Promise((resolve) => {
			const proc = spawn("claude", ["-p", "--model", model], {
				env: { ...process.env, CLAUDECODE: "" },
				stdio: ["pipe", "pipe", "pipe"],
			});

			let stdout = "";
			proc.stdout.on("data", (d) => { stdout += d; });
			proc.stderr.on("data", () => { /* ignore stderr noise */ });

			proc.on("error", (err) => {
				console.error("[TeamLeadBrain] CLI spawn error:", err);
				resolve("Something went wrong. Please try again later.");
			});

			proc.on("close", (code) => {
				if (code !== 0 || !stdout.trim()) {
					console.error(`[TeamLeadBrain] CLI exited with code ${code}`);
					resolve("Something went wrong. Please try again later.");
					return;
				}
				resolve(stdout.trim());
			});

			// Pass system prompt + user content via stdin
			proc.stdin.write(`${system}\n\n${userContent}`);
			proc.stdin.end();
		});
	};
}

const ISSUE_ID_PATTERN = /[A-Za-z][A-Za-z0-9_-]*-\d+/g;

function extractIssueIds(text: string): string[] {
	return [...new Set(text.match(ISSUE_ID_PATTERN) ?? [])];
}

export class TeamLeadBrain {
	private assembler: PromptAssembler;

	constructor(
		private store: StateStore,
		private llmCall: LlmCall,
	) {
		this.assembler = new PromptAssembler();
	}

	async answer(question: string, threadTs?: string): Promise<string | null> {
		// 1. Extract issue identifiers from question and validate against DB
		//    The regex is broad (matches "sonnet-4" etc.), so we verify each
		//    candidate exists before using it as the focus identifier.
		const candidates = extractIssueIds(question);
		let focusIdentifier: string | undefined;
		for (const candidate of candidates) {
			if (this.store.getSessionByIdentifier(candidate)) {
				focusIdentifier = candidate;
				break;
			}
		}

		// 2. If no valid identifier in question and we're in a known thread, use thread context
		let focusIssueId: string | undefined;
		if (!focusIdentifier && threadTs) {
			const threadIssueId = this.store.getThreadIssue(threadTs);
			if (threadIssueId) {
				// Thread stores issue_id (UUID); look up the session to get its identifier
				const session = this.store.getSessionByIssue(threadIssueId);
				if (session?.issue_identifier) {
					focusIdentifier = session.issue_identifier;
				} else {
					// Fallback: session exists but has no identifier (e.g., only session_failed received)
					focusIssueId = threadIssueId;
				}
			}
		}

		// 3. Load context from StateStore
		// Use truly active sessions for <agent_status> (running + awaiting_review).
		// Completed/failed sessions are available via <issue_history> when a specific issue is focused.
		const activeSessions = this.store.getActiveSessions().slice(0, 20);
		const issueHistory = focusIdentifier
			? this.store.getSessionHistoryByIdentifier(focusIdentifier, 5)
			: focusIssueId
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

		// 5. Call LLM
		try {
			return await this.llmCall(prompt.system, prompt.userContent);
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

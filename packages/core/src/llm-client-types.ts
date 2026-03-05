/**
 * Abstract LLM client interface — model agnostic.
 * Preserves architecture boundary: edge-worker depends on this interface,
 * concrete SDK adapters live in their respective runner packages.
 */
export interface LLMClient {
	chat(params: {
		model: string;
		messages: Array<{ role: string; content: string }>;
		max_tokens: number;
	}): Promise<{ content: string }>;
}

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
		/** Optional system prompt (FLY-175 founder-consent evaluator). */
		system?: string;
	}): Promise<{
		content: string;
		/** Token usage when the provider reports it. */
		usage?: { input_tokens?: number; output_tokens?: number };
	}>;
}

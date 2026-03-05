import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient } from "flywheel-core";

export class AnthropicLLMClient implements LLMClient {
	private client: Anthropic;

	constructor(apiKey?: string) {
		this.client = new Anthropic({ apiKey });
	}

	async chat(params: {
		model: string;
		messages: Array<{ role: string; content: string }>;
		max_tokens: number;
	}): Promise<{ content: string }> {
		const response = await this.client.messages.create({
			model: params.model,
			max_tokens: params.max_tokens,
			messages: params.messages.map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			})),
		});
		const textBlock = response.content.find((b) => b.type === "text");
		return { content: textBlock?.text ?? "" };
	}
}

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
		system?: string;
	}): Promise<{
		content: string;
		usage?: { input_tokens?: number; output_tokens?: number };
	}> {
		const response = await this.client.messages.create({
			model: params.model,
			max_tokens: params.max_tokens,
			...(params.system ? { system: params.system } : {}),
			messages: params.messages.map((m) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			})),
		});
		const textBlock = response.content.find((b) => b.type === "text");
		return {
			content: textBlock?.text ?? "",
			usage: {
				input_tokens: response.usage?.input_tokens,
				output_tokens: response.usage?.output_tokens,
			},
		};
	}
}

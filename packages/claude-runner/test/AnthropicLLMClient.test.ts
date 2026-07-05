import { describe, expect, it, vi } from "vitest";
import { AnthropicLLMClient } from "../src/AnthropicLLMClient.js";

// Mock the Anthropic SDK
vi.mock("@anthropic-ai/sdk", () => {
	const MockAnthropic = vi.fn().mockImplementation(() => ({
		messages: {
			create: vi.fn(),
		},
	}));
	return { default: MockAnthropic };
});

describe("AnthropicLLMClient", () => {
	it("chat() calls Anthropic messages.create with correct params", async () => {
		const client = new AnthropicLLMClient("test-key");
		const mockCreate = (client as any).client.messages.create;
		mockCreate.mockResolvedValue({
			content: [{ type: "text", text: "hello" }],
		});

		await client.chat({
			model: "claude-haiku-4-5-20251001",
			messages: [{ role: "user", content: "test" }],
			max_tokens: 1024,
		});

		expect(mockCreate).toHaveBeenCalledWith({
			model: "claude-haiku-4-5-20251001",
			max_tokens: 1024,
			messages: [{ role: "user", content: "test" }],
		});
	});

	it("chat() extracts text from response", async () => {
		const client = new AnthropicLLMClient("test-key");
		const mockCreate = (client as any).client.messages.create;
		mockCreate.mockResolvedValue({
			content: [{ type: "text", text: "the answer" }],
		});

		const result = await client.chat({
			model: "claude-haiku-4-5-20251001",
			messages: [{ role: "user", content: "question" }],
			max_tokens: 256,
		});

		expect(result.content).toBe("the answer");
	});

	it("chat() returns empty string when no text block", async () => {
		const client = new AnthropicLLMClient("test-key");
		const mockCreate = (client as any).client.messages.create;
		mockCreate.mockResolvedValue({
			content: [{ type: "tool_use", id: "t1", name: "tool", input: {} }],
		});

		const result = await client.chat({
			model: "claude-haiku-4-5-20251001",
			messages: [{ role: "user", content: "question" }],
			max_tokens: 256,
		});

		expect(result.content).toBe("");
	});
});

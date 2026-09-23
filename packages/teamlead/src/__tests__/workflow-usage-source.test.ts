import { describe, expect, it } from "vitest";
import {
	parseClaudeUsageLine,
	parseCodexUsageLine,
} from "../workflow-usage-source.js";

describe("workflow usage source normalization", () => {
	it("counts Claude cache classes once and requires a native request id", () => {
		const line = JSON.stringify({
			type: "assistant",
			requestId: "req-1",
			timestamp: "2026-09-23T04:00:01.000Z",
			message: {
				model: "claude-opus-5",
				usage: {
					input_tokens: 10,
					output_tokens: 20,
					cache_read_input_tokens: 30,
					cache_creation_input_tokens: 40,
				},
			},
		});
		expect(
			parseClaudeUsageLine(line, { offset: 123, nativeTurnId: "turn-1" }),
		).toMatchObject({
			providerRequestId: "req-1",
			nativeTurnId: "turn-1",
			observedModelId: "claude-opus-5",
			inputTokens: 10,
			outputTokens: 20,
			cacheReadTokens: 30,
			cacheWriteTokens: 40,
			totalTokens: 100,
			sourceRecordId: "123",
		});
		expect(
			parseClaudeUsageLine(
				line.replace('"requestId":"req-1",', '"uuid":"fallback",'),
				{ offset: 123, nativeTurnId: "turn-1" },
			),
		).toBeNull();
	});

	it("normalizes Codex cumulative totals without double-counting cached or reasoning subsets", () => {
		const line = JSON.stringify({
			timestamp: "2026-09-23T04:00:02.000Z",
			type: "event_msg",
			payload: {
				type: "token_count",
				info: {
					total_token_usage: {
						input_tokens: 120,
						cached_input_tokens: 80,
						output_tokens: 30,
						reasoning_output_tokens: 20,
						total_tokens: 150,
					},
				},
			},
		});
		expect(
			parseCodexUsageLine(line, {
				offset: 456,
				nativeTurnId: "turn-2",
				model: "gpt-6-sol",
			}),
		).toMatchObject({
			nativeTurnId: "turn-2",
			observedModelId: "gpt-6-sol",
			inputTokens: 120,
			outputTokens: 30,
			cacheReadTokens: 80,
			reasoningTokens: 20,
			totalTokens: 150,
			sourceRecordId: "456",
		});
	});
});

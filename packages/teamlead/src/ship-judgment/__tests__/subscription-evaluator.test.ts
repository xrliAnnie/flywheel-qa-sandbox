import { describe, expect, it, vi } from "vitest";
import type { FrozenPacket } from "../contract.js";
import * as config from "../subscription-config.js";
import {
	evaluateSubscription,
	JUDGMENT_PROMPT,
	judgmentModelSnapshot,
} from "../subscription-evaluator.js";
import type { SubscriptionProcessOptions } from "../subscription-process.js";

describe("subscription evaluator composition", () => {
	it("passes the frozen packet once and saves validated output and numeric usage", async () => {
		const model = judgmentModelSnapshot();
		const packet: FrozenPacket = {
			questionId: "q",
			channelId: "c",
			bindingDigest: "a".repeat(64),
			targets: [
				{
					repo_identity: "repo",
					pr_number: 1,
					head_sha: "b".repeat(40),
					diff_base_sha: "c".repeat(40),
				},
			],
			sources: [
				{ source_id: "plan", kind: "plan", revision: "1", text: "R1 required" },
			],
			files: [],
			requirements: [
				{
					requirement_id: "R1",
					source_id: "plan",
					quote_start: 0,
					quote_end: 11,
				},
			],
			model,
			prompt: JUDGMENT_PROMPT,
		};
		const output = {
			schema_version: 1,
			alignment: {
				verdict: "undetermined",
				evidence: [],
				reason_code: "missing_diff",
			},
			coverage: {
				verdict: "undetermined",
				evidence: [],
				reason_code: "missing_qa",
			},
			requirements: [
				{ requirement_id: "R1", implementation_evidence: [], use_cases: [] },
			],
		};
		const run = vi.fn(async (_options: SubscriptionProcessOptions) => ({
			ok: true as const,
			spawned: true as const,
			stdout: JSON.stringify({
				type: "result",
				subtype: "success",
				is_error: false,
				result: JSON.stringify(output),
				terminal_reason: "end_turn",
				fast_mode_state: "off",
				usage: {
					input_tokens: 10,
					output_tokens: 20,
					output_tokens_details: {},
					iterations: [],
				},
				total_cost_usd: 0.01,
			}),
		}));
		const result = await evaluateSubscription(packet, { bin: "/fixture", run });
		expect(result).toMatchObject({
			spawned: true,
			evaluation: {
				resultCode: "evaluated",
				costUsd: 0.01,
				usage: { input_tokens: 10, output_tokens: 20 },
			},
		});
		expect(run).toHaveBeenCalledTimes(1);
		expect(JSON.parse(run.mock.calls[0]![0].input)).toEqual(packet);
		for (const envelope of [
			{
				type: "result",
				subtype: "error",
				is_error: true,
				result: JSON.stringify(output),
			},
			{
				type: "result",
				subtype: "success",
				is_error: false,
				result: JSON.stringify(output),
				tool_calls: [{}],
			},
		]) {
			run.mockResolvedValueOnce({
				ok: true,
				spawned: true,
				stdout: JSON.stringify(envelope),
			});
			expect(
				(await evaluateSubscription(packet, { bin: "/fixture", run }))
					.evaluation.resultCode,
			).toBe("envelope_invalid");
		}
		const frozenConfig = config.subscriptionConfiguration(
			model.model,
			model.effort,
		);
		const configurationSpy = vi.spyOn(config, "subscriptionConfiguration");
		try {
			for (const altered of [
				{
					...frozenConfig,
					settingsJson: frozenConfig.settingsJson.replace("english", "chinese"),
				},
				{
					...frozenConfig,
					configDirectory: {
						...frozenConfig.configDirectory,
						allowedFiles: [".credentials.json", "settings.json"],
					},
				},
				{ ...frozenConfig, argv: [...frozenConfig.argv, "--effort", "low"] },
			]) {
				configurationSpy.mockReturnValue(altered);
				const before = run.mock.calls.length;
				expect(
					(await evaluateSubscription(packet, { bin: "/fixture", run }))
						.evaluation.resultCode,
				).toBe("model_or_prompt_changed");
				expect(run).toHaveBeenCalledTimes(before);
			}
		} finally {
			configurationSpy.mockRestore();
		}
		const count = run.mock.calls.length;
		expect(
			(
				await evaluateSubscription(
					{ ...packet, prompt: "override" },
					{ bin: "/fixture", run },
				)
			).spawned,
		).toBe(false);
		expect(run).toHaveBeenCalledTimes(count);
	});
});

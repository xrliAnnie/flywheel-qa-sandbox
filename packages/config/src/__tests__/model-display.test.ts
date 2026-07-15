import { describe, expect, it } from "vitest";
import { renderRunnerModelDisplay } from "../model-display.js";

describe("renderRunnerModelDisplay (FLY-1255)", () => {
	it.each([
		[
			"claude",
			"claude-fable-5",
			{ threadMarker: "F", windowLabel: "claude-Fable" },
		],
		[
			"claude",
			"claude-opus-4-8[1m]",
			{ threadMarker: "O", windowLabel: "claude-Opus" },
		],
		[
			"codex",
			"gpt-5.6-sol",
			{ threadMarker: "Model GPT-5.6", windowLabel: "codex-GPT-5-6" },
		],
		[
			"kimi",
			"kimi-for-coding",
			{
				threadMarker: "Model kimi-for-coding",
				windowLabel: "kimi-kimi-for-coding",
			},
		],
	] as const)("renders %s/%s", (vendor, model, expected) => {
		expect(renderRunnerModelDisplay({ vendor, model })).toEqual(expected);
	});

	it("does not reinterpret a vendor/model mismatch", () => {
		expect(
			renderRunnerModelDisplay({
				vendor: "codex",
				model: "claude-fable-5",
			}),
		).toEqual({
			threadMarker: "Model claude-fable-5",
			windowLabel: "codex-claude-fable-5",
		});
	});

	it("infers a known family only when vendor metadata is absent", () => {
		expect(
			renderRunnerModelDisplay({ vendor: undefined, model: "gpt-5.6-sol" }),
		).toEqual({
			threadMarker: "Model GPT-5.6",
			windowLabel: "codex-GPT-5-6",
		});
		expect(
			renderRunnerModelDisplay({ vendor: undefined, model: "future-v9" }),
		).toEqual({
			threadMarker: "Model future-v9",
			windowLabel: "unknown-future-v9",
		});
		expect(
			renderRunnerModelDisplay({ vendor: undefined, model: "opus" }),
		).toEqual({
			threadMarker: "O",
			windowLabel: "claude-Opus",
		});
	});

	it("bounds and sanitizes opaque model ids", () => {
		expect(
			renderRunnerModelDisplay({ vendor: "kimi", model: " bad] model🔥 " }),
		).toEqual({
			threadMarker: "Model bad-model",
			windowLabel: "kimi-bad-model",
		});
		const long = renderRunnerModelDisplay({
			vendor: "future",
			model: "x".repeat(80),
		});
		expect(long?.threadMarker).toBe(`Model ${"x".repeat(24)}`);
		expect(long?.windowLabel.length).toBeLessThanOrEqual(32);
	});

	it.each([null, undefined, "", "   "])(
		"does not guess an absent model: %s",
		(model) => {
			expect(
				renderRunnerModelDisplay({ vendor: "codex", model }),
			).toBeUndefined();
		},
	);
});

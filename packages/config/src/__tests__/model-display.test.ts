import { describe, expect, it } from "vitest";
import { renderRunnerModelDisplay } from "../model-display.js";

describe("renderRunnerModelDisplay (FLY-1255 Plan B — single-letter codes)", () => {
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
		// Plan B: codex/GPT-5.6 folds to the single letter `G` (was `Model GPT-5.6`).
		["codex", "gpt-5.6-sol", { threadMarker: "G", windowLabel: "codex-G" }],
		// Plan B: kimi folds to the single letter `K` (was `Model kimi-for-coding`).
		[
			"kimi",
			"kimi-for-coding",
			{ threadMarker: "K", windowLabel: "kimi-K" },
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
		// Missing backend metadata stays honest: a gpt-5.6 row is still `G`
		// (codex), never a Claude letter and never a fabricated one.
		expect(
			renderRunnerModelDisplay({ vendor: undefined, model: "gpt-5.6-sol" }),
		).toEqual({
			threadMarker: "G",
			windowLabel: "codex-G",
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

	it("never fabricates a letter for an unvetted vendor/model (Plan B ③)", () => {
		// A future gpt-6 is NOT the curated gpt-5.6 signature → long fallback, not `G`.
		expect(
			renderRunnerModelDisplay({ vendor: "codex", model: "gpt-6" }),
		).toEqual({
			threadMarker: "Model gpt-6",
			windowLabel: "codex-gpt-6",
		});
		// Uncurated families (gemini, antigravity) never get a letter.
		expect(
			renderRunnerModelDisplay({ vendor: "gemini", model: "gemini-3-pro" }),
		).toEqual({
			threadMarker: "Model gemini-3-pro",
			windowLabel: "gemini-gemini-3-pro",
		});
		expect(
			renderRunnerModelDisplay({ vendor: "antigravity", model: "agy-1" }),
		).toEqual({
			threadMarker: "Model agy-1",
			windowLabel: "antigravity-agy-1",
		});
	});

	it("bounds and sanitizes opaque model ids on the fallback path", () => {
		// Uncurated vendor → long fallback, which is where sanitization matters.
		expect(
			renderRunnerModelDisplay({ vendor: "gemini", model: " bad] model🔥 " }),
		).toEqual({
			threadMarker: "Model bad-model",
			windowLabel: "gemini-bad-model",
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

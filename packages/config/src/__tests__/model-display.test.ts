import { describe, expect, it } from "vitest";
import { renderRunnerModelDisplay } from "../model-display.js";

describe("renderRunnerModelDisplay (FLY-2936 — vendor + model codes)", () => {
	it.each([
		[
			"claude",
			"claude-fable-5",
			{ threadMarker: "[A][F]", windowLabel: "claude-AF" },
		],
		[
			"claude",
			"claude-opus-4-8[1m]",
			{ threadMarker: "[A][O]", windowLabel: "claude-AO" },
		],
		[
			"claude",
			"claude-sonnet-5",
			{ threadMarker: "[A][S]", windowLabel: "claude-AS" },
		],
		[
			"claude",
			"claude-haiku-4-5-20251001",
			{ threadMarker: "[A][H]", windowLabel: "claude-AH" },
		],
		[
			"codex",
			"gpt-6-astra",
			{ threadMarker: "[O][A]", windowLabel: "codex-OA" },
		],
		[
			"codex",
			"gpt-5.6-sol",
			{ threadMarker: "[O][S]", windowLabel: "codex-OS" },
		],
		["codex", "gpt-6-sol", { threadMarker: "[O][S]", windowLabel: "codex-OS" }],
		// Unnamed GPT families keep the generic fallback marker.
		["codex", "gpt-6", { threadMarker: "[O][G]", windowLabel: "codex-OG" }],
		[
			"kimi",
			"kimi-for-coding",
			{ threadMarker: "[K][K]", windowLabel: "kimi-KK" },
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
			threadMarker: "[O][Model claude-fable-5]",
			windowLabel: "codex-O-claude-fable-5",
		});
	});

	it("infers a known family only when vendor metadata is absent", () => {
		// Missing backend metadata still follows the model id family.
		// (codex), never a Claude letter and never a fabricated one.
		expect(
			renderRunnerModelDisplay({ vendor: undefined, model: "gpt-5.6-sol" }),
		).toEqual({
			threadMarker: "[O][S]",
			windowLabel: "codex-OS",
		});
		expect(
			renderRunnerModelDisplay({ vendor: undefined, model: "future-v9" }),
		).toEqual({
			threadMarker: "[U][Model future-v9]",
			windowLabel: "unknown-U-future-v9",
		});
		expect(
			renderRunnerModelDisplay({ vendor: undefined, model: "opus" }),
		).toEqual({
			threadMarker: "[A][O]",
			windowLabel: "claude-AO",
		});
	});

	it("uses a vendor initial but preserves an honest model-id fallback", () => {
		// Uncurated families get the founder-specified vendor initial, while the
		// model stays explicit instead of receiving a fabricated family code.
		expect(
			renderRunnerModelDisplay({ vendor: "gemini", model: "gemini-3-pro" }),
		).toEqual({
			threadMarker: "[G][Model gemini-3-pro]",
			windowLabel: "gemini-G-gemini-3-pro",
		});
		expect(
			renderRunnerModelDisplay({ vendor: "antigravity", model: "agy-1" }),
		).toEqual({
			threadMarker: "[A][Model agy-1]",
			windowLabel: "antigravity-A-agy-1",
		});
	});

	it("bounds and sanitizes opaque model ids on the fallback path", () => {
		// Uncurated vendor → long fallback, which is where sanitization matters.
		expect(
			renderRunnerModelDisplay({ vendor: "gemini", model: " bad] model🔥 " }),
		).toEqual({
			threadMarker: "[G][Model bad-model]",
			windowLabel: "gemini-G-bad-model",
		});
		const long = renderRunnerModelDisplay({
			vendor: "future",
			model: "x".repeat(80),
		});
		expect(long?.threadMarker).toBe(`[F][Model ${"x".repeat(24)}]`);
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

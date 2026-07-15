import { describe, expect, it } from "vitest";
import { sessionModelDisplay } from "../runner-model-display.js";

describe("sessionModelDisplay (FLY-1255)", () => {
	it("actual resolved runner_model wins over dispatch_model", () => {
		expect(
			sessionModelDisplay({
				adapter_type: "codex-tmux",
				runner_model: "gpt-5.6-sol",
				dispatch_model: "claude-fable-5",
				chat_thread_role: "implement",
			}),
		).toEqual({
			threadMarker: "Model GPT-5.6",
			windowLabel: "codex-GPT-5-6",
		});
	});

	it("pending implement falls back to the phase dispatch plan", () => {
		expect(
			sessionModelDisplay({ chat_thread_role: "implement" }, {}),
		).toMatchObject({ threadMarker: "Model GPT-5.6" });
	});

	it("phase fallback follows both kill switches", () => {
		expect(
			sessionModelDisplay(
				{ chat_thread_role: "implement" },
				{ FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT: "0" },
			),
		).toEqual({ threadMarker: "F", windowLabel: "claude-Fable" });
		expect(
			sessionModelDisplay(
				{ chat_thread_role: "design" },
				{ FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "1" },
			),
		).toEqual({
			threadMarker: "Model GPT-5.6",
			windowLabel: "codex-GPT-5-6",
		});
	});

	it("non-phase may fall back to persisted dispatch_model", () => {
		expect(
			sessionModelDisplay({
				adapter_type: "claude-tmux",
				dispatch_model: "claude-fable-5",
				chat_thread_role: "main",
			}),
		).toEqual({ threadMarker: "F", windowLabel: "claude-Fable" });
	});

	it("does not lie that a GPT row with missing adapter metadata is Claude", () => {
		expect(
			sessionModelDisplay({
				adapter_type: undefined,
				runner_model: "gpt-5.6-sol",
				chat_thread_role: "main",
			}),
		).toEqual({
			threadMarker: "Model GPT-5.6",
			windowLabel: "codex-GPT-5-6",
		});
	});

	it("returns undefined without actual, phase plan, or dispatch model", () => {
		expect(sessionModelDisplay({ chat_thread_role: "main" })).toBeUndefined();
	});
});

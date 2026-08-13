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
			threadMarker: "G",
			windowLabel: "codex-G",
		});
	});

	it("does not guess a model from a phase role", () => {
		expect(
			sessionModelDisplay({ chat_thread_role: "implement" }),
		).toBeUndefined();
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
			threadMarker: "G",
			windowLabel: "codex-G",
		});
	});

	it("returns undefined without an actual or persisted dispatch model", () => {
		expect(sessionModelDisplay({ chat_thread_role: "main" })).toBeUndefined();
	});
});

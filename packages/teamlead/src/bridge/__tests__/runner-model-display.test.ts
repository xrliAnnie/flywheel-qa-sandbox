import { describe, expect, it } from "vitest";
import { sessionModelDisplay } from "../runner-model-display.js";
import { applyModelMarker } from "../stage-utils.js";

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
			threadMarker: "[O][S]",
			windowLabel: "codex-OS",
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
		).toEqual({ threadMarker: "[A][F]", windowLabel: "claude-AF" });
	});

	it("does not lie that a GPT row with missing adapter metadata is Claude", () => {
		expect(
			sessionModelDisplay({
				adapter_type: undefined,
				runner_model: "gpt-5.6-sol",
				chat_thread_role: "main",
			}),
		).toEqual({
			threadMarker: "[O][S]",
			windowLabel: "codex-OS",
		});
	});

	it.each([
		["FLY-2922", "codex-tmux", "gpt-6-astra", "[O][A]"],
		["FLY-2896", "codex-tmux", "gpt-5.6-sol", "[O][S]"],
		["FLY-2886", "claude-tmux", "claude-opus-5-5", "[A][O]"],
		["FLY-2862", "claude-tmux", "claude-fable-5-1", "[A][F]"],
	] as const)(
		"renders the 2026-09-26 persisted %s %s/%s session model as %s in the thread title",
		(_issueId, adapter_type, runner_model, expectedCode) => {
			const display = sessionModelDisplay({
				adapter_type,
				runner_model,
				chat_thread_role: "implement",
			});
			expect(
				applyModelMarker("[FLY-2936] model title", display?.threadMarker),
			).toBe(`${expectedCode} [FLY-2936] model title`);
		},
	);

	it("returns undefined without an actual or persisted dispatch model", () => {
		expect(sessionModelDisplay({ chat_thread_role: "main" })).toBeUndefined();
	});
});

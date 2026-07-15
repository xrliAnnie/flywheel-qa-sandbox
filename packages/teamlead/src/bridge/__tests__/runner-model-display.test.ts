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

	it("pending implement falls back to the phase dispatch plan", () => {
		expect(
			sessionModelDisplay({ chat_thread_role: "implement" }, {}),
		).toMatchObject({ threadMarker: "G" });
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
			threadMarker: "G",
			windowLabel: "codex-G",
		});
	});

	it("FLY-1259: locked codex design backend beats a disabled global switch", () => {
		expect(
			sessionModelDisplay(
				{
					chat_thread_role: "design",
					design_backend: "codex",
					adapter_type: undefined,
					runner_model: undefined,
					dispatch_model: undefined,
				},
				{ FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "0" },
			),
		).toEqual({ threadMarker: "G", windowLabel: "codex-G" });
	});

	it("FLY-1259: locked claude design backend beats an enabled global switch", () => {
		expect(
			sessionModelDisplay(
				{
					chat_thread_role: "design",
					design_backend: "claude",
					adapter_type: undefined,
					runner_model: undefined,
					dispatch_model: undefined,
				},
				{ FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "1" },
			),
		).toEqual({ threadMarker: "F", windowLabel: "claude-Fable" });
	});

	it("FLY-1259: the actual runner_model still outranks a locked backend", () => {
		expect(
			sessionModelDisplay(
				{
					chat_thread_role: "design",
					design_backend: "claude",
					adapter_type: "codex-tmux",
					runner_model: "gpt-5.6-sol",
					dispatch_model: undefined,
				},
				{ FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "0" },
			),
		).toEqual({ threadMarker: "G", windowLabel: "codex-G" });
	});

	it("FLY-1259: the lock never leaks into implement/qa phase fallbacks", () => {
		expect(
			sessionModelDisplay(
				{ chat_thread_role: "implement", design_backend: "claude" },
				{ FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT: "1" },
			),
		).toEqual(sessionModelDisplay({ chat_thread_role: "implement" }, {}));
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

	it("returns undefined without actual, phase plan, or dispatch model", () => {
		expect(sessionModelDisplay({ chat_thread_role: "main" })).toBeUndefined();
	});
});

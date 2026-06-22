/**
 * FLY-123: shared label parser tests — semantics must mirror
 * RunnerSelectionService's label subset exactly.
 */
import { describe, expect, it } from "vitest";
import { parseRunnerLabels } from "../runner-label.js";

describe("parseRunnerLabels", () => {
	it("returns empty selection for no labels", () => {
		expect(parseRunnerLabels(undefined)).toEqual({});
		expect(parseRunnerLabels([])).toEqual({});
		expect(parseRunnerLabels(["bug", "p1"])).toEqual({});
	});

	it("resolves agent labels (case-insensitive)", () => {
		expect(parseRunnerLabels(["Codex"]).runnerType).toBe("codex");
		expect(parseRunnerLabels(["OPENAI"]).runnerType).toBe("codex");
		expect(parseRunnerLabels(["claude"]).runnerType).toBe("claude");
		expect(parseRunnerLabels(["gemini"]).runnerType).toBe("gemini");
		expect(parseRunnerLabels(["cursor"]).runnerType).toBe("cursor");
	});

	it("agent label precedence: cursor > codex > gemini > claude", () => {
		expect(parseRunnerLabels(["claude", "codex"]).runnerType).toBe("codex");
		expect(parseRunnerLabels(["codex", "cursor"]).runnerType).toBe("cursor");
	});

	it("model labels infer agent type", () => {
		expect(parseRunnerLabels(["opus"])).toEqual({
			runnerType: "claude",
			modelOverride: "opus",
		});
		expect(parseRunnerLabels(["gpt-5.5-codex"])).toEqual({
			runnerType: "codex",
			modelOverride: "gpt-5.5-codex",
		});
		expect(parseRunnerLabels(["gemini-2.5-flash"])).toEqual({
			runnerType: "gemini",
			modelOverride: "gemini-2.5-flash",
		});
	});

	it("agent label overrides conflicting model label (model dropped)", () => {
		// codex agent + claude model → keep codex, drop model
		const sel = parseRunnerLabels(["codex", "opus"]);
		expect(sel.runnerType).toBe("codex");
		expect(sel.modelOverride).toBeUndefined();
	});

	it("agent label keeps matching model label", () => {
		const sel = parseRunnerLabels(["codex", "gpt-5.5-codex"]);
		expect(sel.runnerType).toBe("codex");
		expect(sel.modelOverride).toBe("gpt-5.5-codex");
	});

	// FLY-493: Antigravity (agy) as a first-class runner vendor label.
	it("resolves antigravity label (and agy alias), case-insensitive", () => {
		expect(parseRunnerLabels(["antigravity"]).runnerType).toBe("antigravity");
		expect(parseRunnerLabels(["agy"]).runnerType).toBe("antigravity");
		expect(parseRunnerLabels(["Antigravity"]).runnerType).toBe("antigravity");
		expect(parseRunnerLabels(["AGY"]).runnerType).toBe("antigravity");
	});

	it("antigravity label does not carry a model override on its own", () => {
		expect(parseRunnerLabels(["antigravity"])).toEqual({
			runnerType: "antigravity",
		});
	});

	it("antigravity does not perturb existing agent labels", () => {
		// Regression guard: non-antigravity labels resolve exactly as before.
		expect(parseRunnerLabels(["codex"]).runnerType).toBe("codex");
		expect(parseRunnerLabels(["claude"]).runnerType).toBe("claude");
		expect(parseRunnerLabels(["gemini"]).runnerType).toBe("gemini");
		expect(parseRunnerLabels(["cursor"]).runnerType).toBe("cursor");
	});
});

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
			modelOverride: "claude-opus-5",
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

	// FLY-494: Kimi Code (kimi) as a first-class runner vendor label.
	it("resolves kimi label (and kimi-code alias), case-insensitive", () => {
		expect(parseRunnerLabels(["kimi"]).runnerType).toBe("kimi");
		expect(parseRunnerLabels(["kimi-code"]).runnerType).toBe("kimi");
		expect(parseRunnerLabels(["Kimi"]).runnerType).toBe("kimi");
		expect(parseRunnerLabels(["KIMI-CODE"]).runnerType).toBe("kimi");
	});

	it("kimi label does not carry a model override on its own", () => {
		expect(parseRunnerLabels(["kimi"])).toEqual({
			runnerType: "kimi",
		});
	});

	it("kimi does not perturb existing agent labels (incl. antigravity)", () => {
		// Regression guard: adding kimi precedence leaves all others intact.
		expect(parseRunnerLabels(["codex"]).runnerType).toBe("codex");
		expect(parseRunnerLabels(["claude"]).runnerType).toBe("claude");
		expect(parseRunnerLabels(["gemini"]).runnerType).toBe("gemini");
		expect(parseRunnerLabels(["cursor"]).runnerType).toBe("cursor");
		expect(parseRunnerLabels(["antigravity"]).runnerType).toBe("antigravity");
	});

	// FLY-728: per-issue model routing — `fable` label resolves to the canonical
	// explicit id `claude-fable-5` (the string fleet-console / token pricing /
	// TmuxAdapter `--model` all use). Infers the `claude` runner because the id
	// starts with "claude".
	it("resolves fable label to claude-fable-5-1 (Claude runner), case-insensitive", () => {
		expect(parseRunnerLabels(["fable"])).toEqual({
			runnerType: "claude",
			modelOverride: "claude-fable-5-1",
		});
		expect(parseRunnerLabels(["FABLE"])).toEqual({
			runnerType: "claude",
			modelOverride: "claude-fable-5-1",
		});
	});

	it("fable co-existing with a claude agent label keeps both", () => {
		// claude agent + fable model → runner claude, model kept (same runner).
		expect(parseRunnerLabels(["claude", "fable"])).toEqual({
			runnerType: "claude",
			modelOverride: "claude-fable-5-1",
		});
	});

	it("agent label overrides fable model label (model dropped)", () => {
		// codex agent + fable (a Claude model) → keep codex, drop the model.
		const sel = parseRunnerLabels(["codex", "fable"]);
		expect(sel.runnerType).toBe("codex");
		expect(sel.modelOverride).toBeUndefined();
	});

	// Codex design R1 #6: no-transport vendors must never get a Claude model id
	// attached — otherwise a future model-label expansion could hand a Fable id
	// to an antigravity/kimi runner that can't run it.
	it("no-transport vendor label wins over fable, no Claude model attached", () => {
		const agy = parseRunnerLabels(["antigravity", "fable"]);
		expect(agy.runnerType).toBe("antigravity");
		expect(agy.modelOverride).toBeUndefined();

		const kimi = parseRunnerLabels(["kimi", "fable"]);
		expect(kimi.runnerType).toBe("kimi");
		expect(kimi.modelOverride).toBeUndefined();
	});

	it("canonicalizes every configured Claude family alias", () => {
		expect(parseRunnerLabels(["opus"])).toEqual({
			runnerType: "claude",
			modelOverride: "claude-opus-5",
		});
		expect(parseRunnerLabels(["sonnet"])).toEqual({
			runnerType: "claude",
			modelOverride: "claude-sonnet-5",
		});
		expect(parseRunnerLabels(["haiku"])).toEqual({
			runnerType: "claude",
			modelOverride: "claude-haiku-4-5-20251001",
		});
	});

	// FLY-751: 1M context is explicit opt-in — the -1m labels resolve to the
	// canonical [1m] ids (small context is the fleet default everywhere else).
	it("resolves opus-1m / fable-1m labels to the [1m] ids (Claude runner)", () => {
		expect(parseRunnerLabels(["opus-1m"])).toEqual({
			runnerType: "claude",
			modelOverride: "claude-opus-5[1m]",
		});
		expect(parseRunnerLabels(["FABLE-1M"])).toEqual({
			runnerType: "claude",
			modelOverride: "claude-fable-5-1[1m]",
		});
	});

	it("1m label wins over the bare alias when both are present", () => {
		expect(parseRunnerLabels(["opus", "opus-1m"])).toEqual({
			runnerType: "claude",
			modelOverride: "claude-opus-5[1m]",
		});
		expect(parseRunnerLabels(["fable-1m", "fable"])).toEqual({
			runnerType: "claude",
			modelOverride: "claude-fable-5-1[1m]",
		});
	});

	it("agent label overrides a conflicting 1m model label (model dropped)", () => {
		const sel = parseRunnerLabels(["codex", "opus-1m"]);
		expect(sel.runnerType).toBe("codex");
		expect(sel.modelOverride).toBeUndefined();
	});
});

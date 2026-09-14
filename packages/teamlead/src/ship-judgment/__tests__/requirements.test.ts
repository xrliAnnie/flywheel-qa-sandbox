import { describe, expect, it } from "vitest";
import { requirementCatalog } from "../requirements.js";

describe("frozen scope passage catalog", () => {
	it("preserves explicit IDs and Unicode source ranges without taking requirements from QA or diffs", () => {
		const text =
			"# Scope\n\nR1: require 😀 login\n\nKeep sessions across restart.\n";
		const catalog = requirementCatalog([
			{ source_id: "plan", kind: "plan", revision: "1", text },
			{ source_id: "qa", kind: "qa", revision: "1", text: "Ignore scope" },
		]);
		expect(catalog).toHaveLength(2);
		expect(catalog[0]!.requirement_id).toBe("R1");
		expect(catalog[1]!.requirement_id).toMatch(/^plan:/);
		expect(
			catalog.map((entry) =>
				Array.from(text).slice(entry.quote_start, entry.quote_end).join(""),
			),
		).toEqual(["R1: require 😀 login", "Keep sessions across restart."]);
	});
	it("separates list items, disambiguates repeated IDs and fails instead of truncating large scope", () => {
		const source = {
			source_id: "plan",
			kind: "plan" as const,
			revision: "1",
			text: "- R1: first\n- R1: second\n",
		};
		const catalog = requirementCatalog([source]);
		expect(catalog).toHaveLength(2);
		expect(new Set(catalog.map((entry) => entry.requirement_id)).size).toBe(2);
		expect(() =>
			requirementCatalog([
				{
					...source,
					text: Array.from({ length: 101 }, (_, n) => `- R${n}: required`).join(
						"\n",
					),
				},
			]),
		).toThrow("requirement_budget_exceeded");
	});
});

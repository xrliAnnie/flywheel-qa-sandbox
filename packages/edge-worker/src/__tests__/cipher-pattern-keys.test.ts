import { describe, expect, it } from "vitest";
import {
	generatePatternKeys,
	getFallbackOrder,
} from "../cipher/pattern-keys.js";
import type { PatternDimensions } from "../cipher/types.js";

function makeDims(
	overrides: Partial<PatternDimensions> = {},
): PatternDimensions {
	return {
		primaryLabel: "bug",
		sizeBucket: "small",
		areaTouched: "backend",
		exitStatus: "completed",
		hasPriorFailures: false,
		commitVolume: "few",
		diffScale: "small",
		hasTests: true,
		touchesAuth: false,
		...overrides,
	};
}

describe("generatePatternKeys", () => {
	it("generates exactly 15 keys", () => {
		const keys = generatePatternKeys(makeDims());
		expect(keys).toHaveLength(15);
	});

	it("includes 9 single-dimension keys", () => {
		const keys = generatePatternKeys(makeDims());
		expect(keys).toContain("label:bug");
		expect(keys).toContain("size:small");
		expect(keys).toContain("area:backend");
		expect(keys).toContain("exit:completed");
		expect(keys).toContain("failures:false");
		expect(keys).toContain("commits:few");
		expect(keys).toContain("diff:small");
		expect(keys).toContain("tests:true");
		expect(keys).toContain("auth:false");
	});

	it("includes 5 pair keys", () => {
		const keys = generatePatternKeys(makeDims());
		expect(keys).toContain("label+size:bug+small");
		expect(keys).toContain("area+size:backend+small");
		expect(keys).toContain("label+area:bug+backend");
		expect(keys).toContain("exit+failures:completed+false");
		expect(keys).toContain("auth+size:false+small");
	});

	it("includes 1 triple key", () => {
		const keys = generatePatternKeys(makeDims());
		expect(keys).toContain("label+area+size:bug+backend+small");
	});
});

describe("getFallbackOrder", () => {
	it("groups keys by specificity", () => {
		const keys = generatePatternKeys(makeDims());
		const [triples, pairs, singles] = getFallbackOrder(keys);
		expect(triples).toHaveLength(1);
		expect(pairs).toHaveLength(5);
		expect(singles).toHaveLength(9);
	});

	it("returns empty arrays for empty input", () => {
		const [triples, pairs, singles] = getFallbackOrder([]);
		expect(triples).toHaveLength(0);
		expect(pairs).toHaveLength(0);
		expect(singles).toHaveLength(0);
	});

	it("counts dimensions correctly (not value segments)", () => {
		// key like "label+size:my-label+small" has 2 dims, not 3 segments
		const keys = ["label+size:bug+small", "label:bug"];
		const [triples, pairs, singles] = getFallbackOrder(keys);
		expect(triples).toHaveLength(0);
		expect(pairs).toHaveLength(1);
		expect(singles).toHaveLength(1);
	});
});

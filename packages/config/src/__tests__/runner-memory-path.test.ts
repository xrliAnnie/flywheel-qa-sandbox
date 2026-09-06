import { describe, expect, it } from "vitest";
import {
	decodeMemoryPathComponent,
	encodeMemoryPathComponent,
} from "../index.js";

describe("runner memory path components", () => {
	it.each([
		["flywheel", "flywheel"],
		["implement", "implement"],
		["Implement", "implement--1"],
		["Sub", "sub--1"],
		["sub--5", "sub--5--0"],
	])(
		"round-trips %s with a case-insensitive-safe encoding",
		(input, encoded) => {
			expect(encodeMemoryPathComponent(input)).toBe(encoded);
			expect(decodeMemoryPathComponent(encoded)).toBe(input);
		},
	);

	it("keeps identifiers that differ only by case on different paths", () => {
		expect(encodeMemoryPathComponent("implement")).not.toBe(
			encodeMemoryPathComponent("Implement"),
		);
	});
});

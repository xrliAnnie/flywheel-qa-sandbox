import { describe, expect, it } from "vitest";
import {
	hashRunnerMemoryArm,
	resolveRunnerMemorySelection,
} from "../runner-memory-mode.js";

describe("FLY-2147 runner memory experiment mode", () => {
	it("keeps the same issue on one split arm across repeated resolutions", () => {
		const decisions = Array.from({ length: 20 }, () =>
			resolveRunnerMemorySelection({
				mode: "split",
				issueIdentifier: "FLY-2147",
			}),
		);
		expect(new Set(decisions).size).toBe(1);
		expect(decisions[0]).toMatch(/^(role|shared)$/);
	});

	it("includes the team prefix in the split hash key", () => {
		expect(hashRunnerMemoryArm("FLY-2147")).toBe("role");
		expect(hashRunnerMemoryArm("GEO-2147")).toBe("shared");
	});

	it("covers both arms across distinct issue groups", () => {
		const decisions = Array.from({ length: 64 }, (_, index) =>
			hashRunnerMemoryArm(`FLY-${index + 1}`),
		);
		expect(new Set(decisions)).toEqual(new Set(["role", "shared"]));
	});

	it.each([
		[undefined, "off"],
		[null, "off"],
		["", "off"],
		["invalid", "off"],
		["off", "off"],
		["role", "role"],
		["shared", "shared"],
	] as const)("resolves mode %s to %s", (mode, expected) => {
		expect(
			resolveRunnerMemorySelection({
				mode,
				issueIdentifier: "FLY-2147",
			}),
		).toBe(expected);
	});
});

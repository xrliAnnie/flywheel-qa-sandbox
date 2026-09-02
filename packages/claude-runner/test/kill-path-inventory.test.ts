import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { KillPathInventoryEntry } from "./kill-path-inventory.js";
import { scanKillPathInventory } from "./kill-path-inventory.js";

describe("FLY-2211 kill-path inventory", () => {
	it("classifies every mechanical kill-path hit in production roots", () => {
		const expected = JSON.parse(
			readFileSync(
				new URL("./fixtures/kill-path-inventory.json", import.meta.url),
				"utf8",
			),
		) as KillPathInventoryEntry[];
		expect(scanKillPathInventory()).toEqual(expected);
		expect(
			expected.some(
				(entry) => entry.classification === "runner-affecting-mutation",
			),
		).toBe(true);
		expect(
			expected.some((entry) => entry.classification === "signal-0-probe"),
		).toBe(true);
		expect(expected.some((entry) => entry.classification === "qa-only")).toBe(
			true,
		);
	}, 15_000);
});

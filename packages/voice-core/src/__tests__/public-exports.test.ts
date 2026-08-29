/**
 * FLY-1160 — public-export sentinel (Codex R2 #4c): the new resident
 * components must be importable from the package root, and the legacy
 * parseStreamLine re-export path must never break — otherwise the 545/1006
 * wiring branches cannot import from flywheel-voice-core.
 */
import { describe, expect, it } from "vitest";
import {
	HeadlessClaudeBrain,
	parseStreamEvent,
	parseStreamLine,
	ResidentBrainManager,
	ResidentClaudeBrain,
} from "../index.js";

describe("package-root exports (FLY-1160)", () => {
	it("exposes the resident components and keeps the legacy parser path", () => {
		expect(typeof ResidentClaudeBrain).toBe("function");
		expect(typeof ResidentBrainManager).toBe("function");
		expect(typeof parseStreamEvent).toBe("function");
		expect(typeof parseStreamLine).toBe("function");
		expect(typeof HeadlessClaudeBrain).toBe("function");
		// legacy shape intact through the root import
		expect(parseStreamLine("not json")).toEqual({ recognized: false });
		expect(parseStreamEvent("not json")).toEqual({
			kind: "other",
			recognized: false,
		});
	});
});

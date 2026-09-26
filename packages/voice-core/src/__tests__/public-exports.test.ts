/**
 * FLY-1160 — public-export sentinel (Codex R2 #4c): the legacy parseStreamLine
 * re-export path must never break. FLY-2860 retired the resident brain, the
 * talk-session rotator and the converse backend; they must stay off the root.
 */
import { describe, expect, it } from "vitest";
import * as root from "../index.js";
import {
	HeadlessClaudeBrain,
	parseStreamEvent,
	parseStreamLine,
} from "../index.js";

describe("package-root exports (FLY-1160)", () => {
	it("no longer exposes the retired legacy voice components (FLY-2860)", () => {
		for (const name of [
			"ResidentBrainManager",
			"ResidentClaudeBrain",
			"TalkSessionRotator",
			"createGenaiTransport",
			"deriveCapabilities",
			"verifyConverseComponents",
		]) {
			expect(name in root, name).toBe(false);
		}
	});

	it("keeps the legacy parser path", () => {
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

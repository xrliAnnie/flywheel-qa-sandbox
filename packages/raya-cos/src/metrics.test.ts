import { describe, expect, it } from "vitest";
import { summarizeContextUsage } from "./metrics.js";

describe("standard Lead metrics projection", () => {
	it("summarizes platform rows without a private process assumption", () => {
		expect(
			summarizeContextUsage([
				{
					ts: "2026-09-08T20:00:00.000Z",
					totalTokens: 10,
					modelContextWindow: 100,
				},
				{
					ts: "2026-09-08T20:01:00.000Z",
					totalTokens: 35,
					modelContextWindow: 100,
				},
			]),
		).toEqual({
			samples: 2,
			latestTokens: 35,
			peakTokens: 35,
			effectiveContextWindows: [100],
		});
	});
});

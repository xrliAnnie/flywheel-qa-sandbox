import { describe, expect, it } from "vitest";
import { buildSessionKey, formatDurationMs } from "../bridge/hook-payload.js";

describe("buildSessionKey", () => {
	it("uses issue_identifier when available", () => {
		expect(
			buildSessionKey({ issue_identifier: "GEO-42", issue_id: "abc-123" }),
		).toBe("flywheel:GEO-42");
	});

	it("falls back to issue_id when issue_identifier is undefined", () => {
		expect(buildSessionKey({ issue_id: "abc-123" })).toBe("flywheel:abc-123");
	});

	it("falls back to issue_id when issue_identifier is explicitly undefined", () => {
		expect(
			buildSessionKey({ issue_identifier: undefined, issue_id: "xyz" }),
		).toBe("flywheel:xyz");
	});
});

describe("formatDurationMs (FLY-159)", () => {
	it("renders sub-minute durations in seconds", () => {
		expect(formatDurationMs(10_000)).toBe("10s");
		expect(formatDurationMs(0)).toBe("0s");
		expect(formatDurationMs(59_999)).toBe("59s");
	});

	it("renders sub-hour durations as Xm or Xm Ys", () => {
		expect(formatDurationMs(60_000)).toBe("1m");
		expect(formatDurationMs(90_000)).toBe("1m 30s");
		expect(formatDurationMs(59 * 60_000)).toBe("59m");
	});

	it("renders hour-scale durations as Xh or Xh Ym", () => {
		expect(formatDurationMs(3_600_000)).toBe("1h");
		expect(formatDurationMs(5_400_000)).toBe("1h 30m");
		expect(formatDurationMs(86_400_000)).toBe("24h");
		expect(formatDurationMs(172_800_000)).toBe("48h");
		expect(formatDurationMs(14_400_000)).toBe("4h"); // floor
	});

	it("handles null / undefined / negative / non-finite as em-dash", () => {
		expect(formatDurationMs(undefined)).toBe("—");
		expect(formatDurationMs(null)).toBe("—");
		expect(formatDurationMs(-1)).toBe("—");
		expect(formatDurationMs(Number.NaN)).toBe("—");
		expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe("—");
	});
});

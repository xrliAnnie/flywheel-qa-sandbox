import { afterEach, describe, expect, it, vi } from "vitest";
import { parseReviewerTimeoutMs } from "../plugin.js";

describe("parseReviewerTimeoutMs", () => {
	afterEach(() => vi.restoreAllMocks());

	it("leaves the runner's 30-minute default in control when unset or blank", () => {
		expect(parseReviewerTimeoutMs(undefined)).toBeUndefined();
		expect(parseReviewerTimeoutMs("   ")).toBeUndefined();
	});

	it("accepts finite safe integers across the supported timer range", () => {
		expect(parseReviewerTimeoutMs("60000")).toBe(60_000);
		expect(parseReviewerTimeoutMs("2147483647")).toBe(2_147_483_647);
	});

	it.each(["not-a-number", "60000.5", "59999", "2147483648"])(
		"warns and falls back for invalid value %s",
		(raw) => {
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			expect(parseReviewerTimeoutMs(raw)).toBeUndefined();
			expect(warning).toHaveBeenCalledOnce();
			expect(warning.mock.calls[0]?.[0]).toContain(
				"FLYWHEEL_CLAUDE_REVIEW_TIMEOUT_MS",
			);
		},
	);
});

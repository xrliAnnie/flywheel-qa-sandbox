import { describe, expect, it } from "vitest";
import { parseReceiveHealth } from "../receive-health.js";

describe("receive health contract", () => {
	it("accepts the bounded versioned snapshot", () => {
		expect(
			parseReceiveHealth({
				version: 1,
				sequence: 2,
				state: "degraded",
				reason: "dave_decrypt",
				failures: 1,
				retries: 1,
				lastPcmAt: null,
			}),
		).toEqual({
			version: 1,
			sequence: 2,
			state: "degraded",
			reason: "dave_decrypt",
			failures: 1,
			retries: 1,
			lastPcmAt: null,
		});
	});

	it.each([
		{ version: 2 },
		{ sequence: 0 },
		{ sequence: Number.MAX_SAFE_INTEGER + 1 },
		{ state: "live" },
		{ reason: "raw_error_text" },
		{ failures: -1 },
		{ retries: 1.5 },
		{ lastPcmAt: "not-a-date" },
		{ secret: "must-not-be-forwarded" },
	])("rejects an invalid or unbounded field %#", (override) => {
		expect(() =>
			parseReceiveHealth({
				version: 1,
				sequence: 1,
				state: "unknown",
				reason: "awaiting_audio",
				failures: 0,
				retries: 0,
				lastPcmAt: null,
				...override,
			}),
		).toThrow("invalid_receive_health");
	});
});

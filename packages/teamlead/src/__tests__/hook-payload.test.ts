import { describe, expect, it } from "vitest";
import { buildSessionKey } from "../bridge/hook-payload.js";

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

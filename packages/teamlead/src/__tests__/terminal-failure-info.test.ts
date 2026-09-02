import { describe, expect, it } from "vitest";
import { normalizeTerminalFailureInfo } from "../terminal-failure-info.js";

describe("normalizeTerminalFailureInfo", () => {
	it("preserves the codex recovery exhaustion discriminator", () => {
		expect(
			normalizeTerminalFailureInfo({
				failureKind: "reown_exhausted",
				failureReason: "Codex recovery exhausted after 2 attempts",
			}),
		).toEqual({
			failureKind: "reown_exhausted",
			failureReason: "Codex recovery exhausted after 2 attempts",
		});
	});
});

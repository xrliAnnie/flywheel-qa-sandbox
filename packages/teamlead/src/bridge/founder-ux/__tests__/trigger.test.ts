/**
 * FLY-598: founder-ux gate — Layer A trigger snapshot (run-start) unit tests.
 * Pure decision function, exhaustively testable. The fail-closed-on-read-failure
 * case is the Codex R1 MEDIUM fix.
 */

import { describe, expect, it } from "vitest";
import { resolveFounderFacingUx } from "../trigger.js";

describe("FLY-598 resolveFounderFacingUx (Layer A trigger)", () => {
	it("is founder-facing when the founder-facing-ux label is present", () => {
		expect(
			resolveFounderFacingUx(["product", "founder-facing-ux"], false),
		).toBe(true);
	});

	it("is NOT founder-facing when labels were read and the label is absent", () => {
		expect(resolveFounderFacingUx(["product", "backend"], false)).toBe(false);
	});

	it("is NOT founder-facing for an empty (but successfully read) label set", () => {
		expect(resolveFounderFacingUx([], false)).toBe(false);
	});

	it("FAIL-CLOSED: is founder-facing when the label fetch FAILED (cannot prove otherwise)", () => {
		// An unreadable label set must never be treated as 'not founder-facing'.
		expect(resolveFounderFacingUx([], true)).toBe(true);
	});

	it("FAIL-CLOSED dominates even with an unrelated label present on a failed read", () => {
		// (defensive) labels would normally be empty on failure, but the fail-closed
		// flag must win regardless of what partial data is around.
		expect(resolveFounderFacingUx(["backend"], true)).toBe(true);
	});
});

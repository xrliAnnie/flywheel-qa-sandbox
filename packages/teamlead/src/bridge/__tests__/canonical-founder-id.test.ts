/**
 * FLY-799 Part A-1 — canonical founder id derivation (RED first).
 *
 * The founder Discord id lives in two config fields today (`discordOwnerUserId`
 * for the founder-reply deliverer; `founderConsent.founderUserId` for the
 * evaluator). This new authoritative approval-write path must resolve ONE
 * canonical id and FAIL-CLOSED (Codex R1 #4): if both are missing, or both are
 * present but differ, there is no trustworthy founder identity and no approval
 * may be attributed. A single present value (or two matching values) resolves.
 */

import { describe, expect, it } from "vitest";
import { deriveCanonicalFounderId } from "../approval-signal/canonical-founder-id.js";

describe("deriveCanonicalFounderId", () => {
	it("resolves when only discordOwnerUserId is set", () => {
		expect(deriveCanonicalFounderId("123", undefined)).toBe("123");
	});

	it("resolves when only founderConsent.founderUserId is set", () => {
		expect(deriveCanonicalFounderId(undefined, "456")).toBe("456");
	});

	it("resolves when both are set and equal", () => {
		expect(deriveCanonicalFounderId("789", "789")).toBe("789");
	});

	it("treats blank/whitespace as unset", () => {
		expect(deriveCanonicalFounderId("  ", "456")).toBe("456");
		expect(deriveCanonicalFounderId("123", "")).toBe("123");
	});

	it("fail-closed (null) when both are missing", () => {
		expect(deriveCanonicalFounderId(undefined, undefined)).toBeNull();
		expect(deriveCanonicalFounderId("", "  ")).toBeNull();
	});

	it("fail-closed (null) when both are present but differ (misconfig guard)", () => {
		expect(deriveCanonicalFounderId("123", "456")).toBeNull();
	});
});

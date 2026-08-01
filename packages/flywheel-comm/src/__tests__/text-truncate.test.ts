import { describe, expect, it } from "vitest";
import {
	countCodePoints,
	truncateCodePoints,
	truncateCodePointsFromEnd,
} from "../text-truncate.js";

/**
 * FLY-1586 C — code-point-safe truncation.
 *
 * Contract (plan §5): C ONLY guarantees it will not SPLIT a well-formed
 * surrogate pair. It deliberately does NOT repair lone surrogates that were
 * already present in the input — that repair, and its sanitation audit, belong
 * to A at the authoritative enqueue boundary. Keeping the repair in exactly one
 * place is what makes the audit trustworthy.
 */

// 🏆 U+1F3C6 — the shape that detonated FLY-1586: high D83C + low DFC6.
const TROPHY = "\u{1F3C6}";
const LONE_HIGH = "\uD83C";
const LONE_LOW = "\uDFC6";

const isLoneSurrogate = (s: string): boolean => {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const next = s.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			i++;
		} else if (c >= 0xdc00 && c <= 0xdfff) {
			return true;
		}
	}
	return false;
};

describe("countCodePoints", () => {
	it("counts an astral character as one, not two", () => {
		expect(countCodePoints(TROPHY)).toBe(1);
		expect(TROPHY.length).toBe(2); // the trap this whole change exists for
	});

	it("counts ASCII and empty input", () => {
		expect(countCodePoints("")).toBe(0);
		expect(countCodePoints("abc")).toBe(3);
	});

	it("counts a lone surrogate as one code point (does not throw)", () => {
		expect(countCodePoints(LONE_HIGH)).toBe(1);
		expect(countCodePoints(LONE_LOW)).toBe(1);
	});
});

describe("truncateCodePoints", () => {
	it("returns input unchanged when within the limit", () => {
		expect(truncateCodePoints("hello", 500)).toEqual({
			text: "hello",
			truncated: false,
		});
	});

	it("handles empty input", () => {
		expect(truncateCodePoints("", 500)).toEqual({ text: "", truncated: false });
	});

	it("never splits a surrogate pair at the cut point", () => {
		// 499 ASCII + one trophy = 500 code points but 501 UTF-16 code units.
		// `.slice(0, 500)` would keep only the HIGH half — the FLY-1586 bug.
		const input = "a".repeat(499) + TROPHY;
		const naive = input.slice(0, 500);
		expect(isLoneSurrogate(naive)).toBe(true); // proves the old behaviour was broken

		const out = truncateCodePoints(input, 500);
		expect(out.truncated).toBe(false);
		expect(out.text).toBe(input);
		expect(isLoneSurrogate(out.text)).toBe(false);
	});

	it("cuts on a code-point boundary when it must truncate", () => {
		const input = "a".repeat(500) + TROPHY;
		const out = truncateCodePoints(input, 500);
		expect(out.truncated).toBe(true);
		expect(out.text).toBe("a".repeat(500));
		expect(isLoneSurrogate(out.text)).toBe(false);
	});

	it("keeps whole astral characters when the boundary lands mid-pair", () => {
		const input = TROPHY.repeat(10);
		const out = truncateCodePoints(input, 4);
		expect(out.truncated).toBe(true);
		expect(out.text).toBe(TROPHY.repeat(4));
		expect(countCodePoints(out.text)).toBe(4);
		expect(isLoneSurrogate(out.text)).toBe(false);
	});

	it("handles many adjacent astral characters", () => {
		const input = `${TROPHY}${TROPHY}${TROPHY}`;
		expect(truncateCodePoints(input, 3).text).toBe(input);
		expect(truncateCodePoints(input, 2).text).toBe(TROPHY.repeat(2));
	});

	it("truncates at exactly the limit boundary", () => {
		expect(truncateCodePoints("abcde", 5)).toEqual({
			text: "abcde",
			truncated: false,
		});
		expect(truncateCodePoints("abcdef", 5)).toEqual({
			text: "abcde",
			truncated: true,
		});
	});

	it("passes a pre-existing lone surrogate through untouched (repair belongs to A)", () => {
		// Explicit contract test: C must NOT quietly repair. If it did, A's
		// sanitation audit would lose the only record that a poison row existed.
		const input = `ok${LONE_HIGH}tail`;
		const out = truncateCodePoints(input, 500);
		expect(out.text).toBe(input);
		expect(out.truncated).toBe(false);
		expect(isLoneSurrogate(out.text)).toBe(true);
	});

	it("does not create a NEW lone surrogate from well-formed input at any cut length", () => {
		const input = `${"x".repeat(3)}${TROPHY}${"y".repeat(3)}${TROPHY}`;
		// limit starts at 1 — 0 is rejected by contract (see the throw test).
		for (let limit = 1; limit <= countCodePoints(input) + 2; limit++) {
			const out = truncateCodePoints(input, limit);
			expect(isLoneSurrogate(out.text)).toBe(false);
		}
	});

	it("rejects a non-positive or non-integer limit", () => {
		expect(() => truncateCodePoints("abc", 0)).toThrow();
		expect(() => truncateCodePoints("abc", -1)).toThrow();
		expect(() => truncateCodePoints("abc", 1.5)).toThrow();
	});
});

describe("truncateCodePointsFromEnd", () => {
	// Guards `tail.slice(-N)` (hook-payload.ts:253-257) — the negative-direction
	// cut that the plan's original `.slice(0, N)` grep could not even find.
	it("returns input unchanged when within the limit", () => {
		expect(truncateCodePointsFromEnd("hello", 500)).toEqual({
			text: "hello",
			truncated: false,
		});
	});

	it("keeps the TAIL, not the head", () => {
		const out = truncateCodePointsFromEnd("abcdef", 3);
		expect(out).toEqual({ text: "def", truncated: true });
	});

	it("never splits a surrogate pair at the leading cut point", () => {
		const input = TROPHY + "a".repeat(3);
		const naive = input.slice(-4); // keeps the LOW half only
		expect(isLoneSurrogate(naive)).toBe(true);

		const out = truncateCodePointsFromEnd(input, 4);
		expect(out.truncated).toBe(false);
		expect(isLoneSurrogate(out.text)).toBe(false);
		expect(out.text).toBe(input);
	});

	it("keeps whole astral characters when cutting from the front", () => {
		const input = TROPHY.repeat(10);
		const out = truncateCodePointsFromEnd(input, 3);
		expect(out.truncated).toBe(true);
		expect(countCodePoints(out.text)).toBe(3);
		expect(isLoneSurrogate(out.text)).toBe(false);
	});

	it("passes a pre-existing lone surrogate through untouched", () => {
		const input = `${LONE_LOW}tail`;
		const out = truncateCodePointsFromEnd(input, 500);
		expect(out.text).toBe(input);
		expect(isLoneSurrogate(out.text)).toBe(true);
	});
});

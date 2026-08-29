import { describe, expect, it } from "vitest";
import { truncateResult } from "../truncate.js";

describe("truncateResult (plan §2.5 — head-keep + explicit marker, no compaction)", () => {
	it("returns short bodies unchanged", () => {
		const r = truncateResult("hello", 100);
		expect(r.body).toBe("hello");
		expect(r.truncated).toBe(false);
	});

	it("returns a body exactly at the cap unchanged", () => {
		const body = "x".repeat(100);
		const r = truncateResult(body, 100);
		expect(r.body).toBe(body);
		expect(r.truncated).toBe(false);
	});

	it("truncates over-cap bodies: head preserved + explicit marker with dropped count", () => {
		const body = `${"a".repeat(100)}${"b".repeat(50)}`;
		const r = truncateResult(body, 100);
		expect(r.truncated).toBe(true);
		expect(r.body.startsWith("a".repeat(100))).toBe(true);
		expect(r.body.endsWith("\n...[truncated 50 chars]")).toBe(true);
		expect(r.body).not.toContain("b");
	});

	it("truncates a 1-char overflow", () => {
		const r = truncateResult("x".repeat(101), 100);
		expect(r.truncated).toBe(true);
		expect(r.body).toContain("[truncated 1 chars]");
	});
});

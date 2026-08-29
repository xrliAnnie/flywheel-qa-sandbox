import { describe, expect, it } from "vitest";
import { RoundtableThreadRegistry } from "../RoundtableThreadRegistry.js";

describe("RoundtableThreadRegistry", () => {
	it("add/has/remove round-trips", () => {
		const r = new RoundtableThreadRegistry();
		expect(r.has("t1")).toBe(false);
		expect(r.add("t1")).toBe(true);
		expect(r.has("t1")).toBe(true);
		expect(r.size).toBe(1);
		expect(r.remove("t1")).toBe(true);
		expect(r.has("t1")).toBe(false);
		expect(r.remove("t1")).toBe(false);
	});

	it("add is idempotent (no double-add)", () => {
		const r = new RoundtableThreadRegistry();
		expect(r.add("t1")).toBe(true);
		expect(r.add("t1")).toBe(false);
		expect(r.size).toBe(1);
	});

	it("ignores empty ids", () => {
		const r = new RoundtableThreadRegistry();
		expect(r.add("")).toBe(false);
		expect(r.size).toBe(0);
	});

	it("preserves insertion order for cap eviction (oldest-first)", () => {
		const r = new RoundtableThreadRegistry();
		r.add("a");
		r.add("b");
		r.add("c");
		expect(r.list()).toEqual(["a", "b", "c"]);
		expect(r.oldest()).toBe("a");
		r.remove("a");
		expect(r.oldest()).toBe("b");
	});

	it("oldest is undefined when empty", () => {
		expect(new RoundtableThreadRegistry().oldest()).toBeUndefined();
	});
});

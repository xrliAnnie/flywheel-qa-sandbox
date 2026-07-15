/**
 * FLY-1065 P2 — TurnAccumulator: per-role delta-fragment buffers whose flush
 * returns the aggregated turn text. Pure string concatenation (probe evidence:
 * output fragments are non-overlapping deltas; input arrives whole) — no
 * joiner, no CJK special-casing (language contract: 中英混排 works untouched).
 */
import { describe, expect, it } from "vitest";
import { TurnAccumulator } from "../backends/gemini/turn-accumulator.js";

describe("TurnAccumulator", () => {
	it("accumulates fragments per role and flush returns the concatenation", () => {
		const acc = new TurnAccumulator();
		acc.append("user", "今天聊");
		acc.append("user", "转写面板");
		acc.append("assistant", "好的,");
		acc.append("assistant", "we can mix English");
		expect(acc.flush("user")).toBe("今天聊转写面板");
		expect(acc.flush("assistant")).toBe("好的,we can mix English");
	});

	it("flush clears the buffer — a second flush returns null", () => {
		const acc = new TurnAccumulator();
		acc.append("user", "hi");
		expect(acc.flush("user")).toBe("hi");
		expect(acc.flush("user")).toBeNull();
	});

	it("flushing an empty buffer returns null (the idempotency gate for multi-signal flushes)", () => {
		const acc = new TurnAccumulator();
		expect(acc.flush("user")).toBeNull();
		expect(acc.flush("assistant")).toBeNull();
	});

	it("roles are independent — flushing one leaves the other buffered", () => {
		const acc = new TurnAccumulator();
		acc.append("user", "her line");
		acc.append("assistant", "its line");
		expect(acc.flush("user")).toBe("her line");
		expect(acc.flush("assistant")).toBe("its line");
	});

	it("flushAll drains both roles (rotator close must not lose tails)", () => {
		const acc = new TurnAccumulator();
		acc.append("user", "尾巴 user");
		acc.append("assistant", "尾巴 assistant");
		expect(acc.flushAll()).toEqual({
			user: "尾巴 user",
			assistant: "尾巴 assistant",
		});
		expect(acc.flushAll()).toEqual({ user: null, assistant: null });
	});
});

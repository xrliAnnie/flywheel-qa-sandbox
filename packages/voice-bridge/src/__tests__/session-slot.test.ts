/**
 * FLY-545 — SessionSlot: the single-session mutex of the resident VC.
 *
 * Shared chassis (Tadashi's 545/967 boundary ruling): /meet (huddle) and
 * /live (assistant) hold the SAME slot — one voice session at a time in the
 * one resident VC. Generic semantics: acquire/release + a founder-facing
 * busy rejection carrying who holds it.
 */
import { describe, expect, it } from "vitest";
import { SessionSlot } from "../SessionSlot.js";

describe("SessionSlot", () => {
	it("acquires when free and reports the holder", () => {
		const slot = new SessionSlot();
		const r = slot.acquire("meet", "FLY-1001");
		expect(r.ok).toBe(true);
		expect(slot.current()).toMatchObject({ mode: "meet", holder: "FLY-1001" });
	});

	it("rejects a second acquire with holder info + founder-facing message", () => {
		const slot = new SessionSlot();
		slot.acquire("meet", "FLY-1001");
		const r = slot.acquire("live", "annie-live");
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.busy).toMatchObject({ mode: "meet", holder: "FLY-1001" });
		expect(r.message).toContain("meet");
		expect(r.message).toContain("FLY-1001");
	});

	it("release by the current holder frees the slot", () => {
		const slot = new SessionSlot();
		slot.acquire("meet", "FLY-1001");
		expect(slot.release("meet", "FLY-1001")).toBe(true);
		expect(slot.current()).toBeNull();
		expect(slot.acquire("live", "annie-live").ok).toBe(true);
	});

	it("release by a non-holder is rejected and the slot is kept", () => {
		const slot = new SessionSlot();
		slot.acquire("meet", "FLY-1001");
		expect(slot.release("live", "annie-live")).toBe(false);
		expect(slot.release("meet", "someone-else")).toBe(false);
		expect(slot.current()).toMatchObject({ mode: "meet", holder: "FLY-1001" });
	});

	it("release on a free slot is a no-op false", () => {
		const slot = new SessionSlot();
		expect(slot.release("meet", "FLY-1001")).toBe(false);
	});

	it("records an acquisition timestamp", () => {
		const slot = new SessionSlot({
			now: () => new Date("2026-07-07T10:00:00Z"),
		});
		slot.acquire("meet", "FLY-1001");
		expect(slot.current()?.since).toBe("2026-07-07T10:00:00.000Z");
	});
});

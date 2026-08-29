import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

/**
 * FLY-818 M3: per-eventId founder-page ledger. Lets the stuck detector's
 * same-eventId retry (which claims.db dedups) learn the REAL founder-page delivery
 * outcome instead of resolving on a dedup alone. MONOTONIC (converge — Lead Q3):
 * once a page truly lands it stays landed.
 */
async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

describe("StateStore founder_page_ledger (FLY-818 M3)", () => {
	it("undefined before any record (fail-closed: unknown ⇒ not paged)", async () => {
		const store = await freshStore();
		expect(store.getFounderPaged("evt-1")).toBeUndefined();
	});

	it("records true / false and reads it back", async () => {
		const store = await freshStore();
		store.recordFounderPaged("evt-true", true);
		expect(store.getFounderPaged("evt-true")).toBe(true);
		store.recordFounderPaged("evt-false", false);
		expect(store.getFounderPaged("evt-false")).toBe(false);
	});

	it("MONOTONIC: once truly paged, a later false never downgrades it (converge)", async () => {
		const store = await freshStore();
		store.recordFounderPaged("evt-x", true);
		store.recordFounderPaged("evt-x", false); // e.g. a later retry that couldn't confirm
		expect(store.getFounderPaged("evt-x")).toBe(true);
	});

	it("a failed page (false) CAN later flip to true when the page finally lands", async () => {
		const store = await freshStore();
		store.recordFounderPaged("evt-y", false);
		expect(store.getFounderPaged("evt-y")).toBe(false);
		store.recordFounderPaged("evt-y", true);
		expect(store.getFounderPaged("evt-y")).toBe(true);
	});

	it("distinct eventIds are independent", async () => {
		const store = await freshStore();
		store.recordFounderPaged("evt-a", true);
		expect(store.getFounderPaged("evt-a")).toBe(true);
		expect(store.getFounderPaged("evt-b")).toBeUndefined();
	});
});

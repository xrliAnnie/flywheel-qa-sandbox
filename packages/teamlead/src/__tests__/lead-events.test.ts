import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("Lead Event Journal (GEO-195)", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	describe("appendLeadEvent()", () => {
		it("inserts event and returns monotonic seq", () => {
			const seq1 = store.appendLeadEvent(
				"product-lead",
				"evt-1",
				"session_completed",
				'{"event_type":"session_completed"}',
				"flywheel:GEO-100",
			);
			const seq2 = store.appendLeadEvent(
				"product-lead",
				"evt-2",
				"session_failed",
				'{"event_type":"session_failed"}',
			);
			expect(seq1).toBeGreaterThan(0);
			expect(seq2).toBeGreaterThan(seq1);
		});

		it("dedup on (lead_id, event_id) — returns existing seq", () => {
			const seq1 = store.appendLeadEvent(
				"product-lead",
				"evt-1",
				"session_completed",
				"{}",
			);
			const seq2 = store.appendLeadEvent(
				"product-lead",
				"evt-1",
				"session_completed",
				"{}",
			);
			expect(seq2).toBe(seq1);
		});

		it("same event_id for different leads is allowed", () => {
			const seq1 = store.appendLeadEvent("product-lead", "evt-1", "test", "{}");
			const seq2 = store.appendLeadEvent("ops-lead", "evt-1", "test", "{}");
			expect(seq2).not.toBe(seq1);
		});
	});

	describe("markLeadEventDelivered()", () => {
		it("sets delivered_at on the event", () => {
			const seq = store.appendLeadEvent("product-lead", "evt-1", "test", "{}");
			store.markLeadEventDelivered(seq);

			const events = store.getRecentDeliveredEvents("product-lead", 60);
			expect(events).toHaveLength(1);
			expect(events[0]!.delivered_at).toBeTruthy();
		});
	});

	describe("getRecentDeliveredEvents()", () => {
		it("returns events within window, ordered by seq asc", () => {
			const seq1 = store.appendLeadEvent("product-lead", "evt-1", "started", "{}");
			const seq2 = store.appendLeadEvent("product-lead", "evt-2", "completed", "{}");
			store.markLeadEventDelivered(seq1);
			store.markLeadEventDelivered(seq2);

			const events = store.getRecentDeliveredEvents("product-lead", 5);
			expect(events).toHaveLength(2);
			expect(events[0]!.seq).toBe(seq1);
			expect(events[1]!.seq).toBe(seq2);
		});

		it("excludes undelivered events", () => {
			store.appendLeadEvent("product-lead", "evt-1", "started", "{}");
			// Not marked as delivered
			const events = store.getRecentDeliveredEvents("product-lead", 5);
			expect(events).toHaveLength(0);
		});

		it("filters by lead_id", () => {
			const seq1 = store.appendLeadEvent("product-lead", "evt-1", "test", "{}");
			const seq2 = store.appendLeadEvent("ops-lead", "evt-2", "test", "{}");
			store.markLeadEventDelivered(seq1);
			store.markLeadEventDelivered(seq2);

			const productEvents = store.getRecentDeliveredEvents("product-lead", 5);
			expect(productEvents).toHaveLength(1);
			expect(productEvents[0]!.lead_id).toBe("product-lead");
		});

		it("returns empty array for no matches", () => {
			const events = store.getRecentDeliveredEvents("nonexistent", 5);
			expect(events).toHaveLength(0);
		});
	});

	describe("getLastDeliveredSeq()", () => {
		it("returns 0 when no events", () => {
			expect(store.getLastDeliveredSeq("product-lead")).toBe(0);
		});

		it("returns highest delivered seq", () => {
			const seq1 = store.appendLeadEvent("product-lead", "evt-1", "test", "{}");
			const seq2 = store.appendLeadEvent("product-lead", "evt-2", "test", "{}");
			store.markLeadEventDelivered(seq1);
			store.markLeadEventDelivered(seq2);

			expect(store.getLastDeliveredSeq("product-lead")).toBe(seq2);
		});

		it("ignores undelivered events", () => {
			const seq1 = store.appendLeadEvent("product-lead", "evt-1", "test", "{}");
			store.appendLeadEvent("product-lead", "evt-2", "test2", "{}");
			store.markLeadEventDelivered(seq1);

			expect(store.getLastDeliveredSeq("product-lead")).toBe(seq1);
		});
	});
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const SLOT = "2026-09-07T00:00:00.000Z";

function due(leadId: string, slot = SLOT) {
	return {
		leadId,
		eventId: `summary_due:flywheel/${leadId}:${slot}`,
		payload: JSON.stringify({ lead_id: leadId, slot_start: slot }),
	};
}

describe("FLY-2382 StateStore summary due journal", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => store.close());

	it("appends one slot atomically and keeps repeated writes idempotent", () => {
		store.appendSummaryDueRows([due("eng-lead"), due("product-lead")]);
		store.appendSummaryDueRows([due("eng-lead"), due("product-lead")]);

		expect(
			store.listSummaryDueRows(SLOT).map((row) => ({
				lead: row.lead_id,
				type: row.event_type,
				session: row.session_key,
			})),
		).toEqual([
			{ lead: "eng-lead", type: "summary_due", session: "summary-due" },
			{
				lead: "product-lead",
				type: "summary_due",
				session: "summary-due",
			},
		]);
	});

	it("rolls back every due row when one insert in the slot fails", () => {
		store.db.run(`CREATE TRIGGER reject_summary_due
			BEFORE INSERT ON lead_events
			WHEN NEW.lead_id = 'reject-me'
			BEGIN SELECT RAISE(ABORT, 'synthetic due failure'); END`);

		expect(() =>
			store.appendSummaryDueRows([due("eng-lead"), due("reject-me")]),
		).toThrow(/synthetic due failure/);
		expect(store.listSummaryDueRows(SLOT)).toEqual([]);
	});

	it("matches only the literal summary_due prefix and exact slot suffix", () => {
		store.appendSummaryDueRows([due("eng-lead")]);
		store.appendLeadEvent(
			"lookalike",
			`summaryXdue:flywheel/lookalike:${SLOT}`,
			"summary_due",
			"{}",
			"summary-due",
		);
		store.appendSummaryDueRows([due("other-slot", "2026-09-07T06:00:00.000Z")]);

		expect(store.listSummaryDueRows(SLOT).map((row) => row.lead_id)).toEqual([
			"eng-lead",
		]);
	});

	it("gets a journal row by its exact lead and event identity", () => {
		const row = due("eng-lead");
		store.appendSummaryDueRows([row]);
		store.appendLeadEvent(
			"other-lead",
			row.eventId,
			"summary_due",
			"{}",
			"summary-due",
		);

		expect(
			store.getLeadEventByLeadAndId(row.leadId, row.eventId),
		).toMatchObject({ lead_id: row.leadId, event_id: row.eventId });
		expect(store.getLeadEventByLeadAndId("missing", row.eventId)).toBeNull();
	});
});

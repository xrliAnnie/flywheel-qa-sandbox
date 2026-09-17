import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const SLOT = "2026-09-07T00:00:00.000Z";
const SIX_HOURS_MS = 6 * 60 * 60_000;

function due(leadId: string, slot = SLOT) {
	return {
		leadId,
		eventId: `summary_due:flywheel/${leadId}:${slot}`,
		payload: JSON.stringify({ lead_id: leadId, slot_start: slot }),
	};
}

function skipped(leadId: string, slot = SLOT) {
	return {
		leadId,
		eventId: `summary_due_skipped:flywheel/${leadId}:${slot}`,
		eventType: "summary_due_skipped" as const,
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

	it("keeps skipped decisions separate and returns the latest decision cursor", () => {
		store.appendSummaryDecisionRows(() => [
			{ ...due("eng-lead"), eventType: "summary_due" },
		]);
		store.appendSummaryDecisionRows(() => [skipped("eng-lead")]);
		store.appendLeadEvent(
			"eng-lead",
			"summary_slot_settled:2026-09-07T00:00:00.000Z",
			"summary_slot_settled",
			"{}",
			"summary-clock",
		);

		expect(store.listSummaryDueRows(SLOT)).toHaveLength(1);
		expect(store.listSummaryDueSkippedRows(SLOT)).toHaveLength(1);
		expect(
			store
				.listLatestSummaryDecisionRows("eng-lead")
				.map((row) => row.event_type),
		).toEqual(["summary_due_skipped", "summary_due"]);
	});

	it("rolls back every decision row when the transactional builder fails", () => {
		expect(() =>
			store.appendSummaryDecisionRows(() => {
				store.appendLeadEvent(
					"eng-lead",
					"business-inside-transaction",
					"runner_question",
					"{}",
				);
				throw new Error("synthetic decision failure");
			}),
		).toThrow(/synthetic decision failure/);
		expect(
			store.getLeadEventByLeadAndId("eng-lead", "business-inside-transaction"),
		).toBeNull();
	});

	it("rolls back a mixed due and skipped decision batch when either insert fails", () => {
		store.db.run(`CREATE TRIGGER reject_summary_skip
			BEFORE INSERT ON lead_events
			WHEN NEW.event_type = 'summary_due_skipped'
			BEGIN SELECT RAISE(ABORT, 'synthetic skipped failure'); END`);

		expect(() =>
			store.appendSummaryDecisionRows(() => [
				{ ...due("eng-lead"), eventType: "summary_due" },
				skipped("product-lead"),
			]),
		).toThrow(/synthetic skipped failure/);
		expect(store.listSummaryDueRows(SLOT)).toEqual([]);
		expect(store.listSummaryDueSkippedRows(SLOT)).toEqual([]);
	});

	it("normalizes timestamp formats and keeps the activity window left-closed", () => {
		const fromMs = Date.parse("2026-09-07T00:00:00.500Z");
		const toMs = fromMs + SIX_HOURS_MS + 137;
		const rows = [
			["left-19", "2026-09-07 00:00:00"],
			["left-23", "2026-09-07 00:00:00.500"],
			["middle-24", "2026-09-07T03:00:00.999Z"],
			["right", "2026-09-07T06:00:00.637Z"],
		] as const;
		for (const [eventId, createdAt] of rows) {
			store.appendLeadEvent("eng-lead", eventId, "runner_question", "{}");
			store.db.run("UPDATE lead_events SET created_at=? WHERE event_id=?", [
				createdAt,
				eventId,
			]);
		}
		const cursor = store.appendLeadEvent(
			"eng-lead",
			"decision-cursor",
			"summary_due",
			"{}",
		);

		expect(
			store.countLeadEventActivity("eng-lead", fromMs, toMs, cursor, true),
		).toBe(2);
	});

	it("counts each cursor quadrant once and fails open on unparsable late rows", () => {
		const fromMs = Date.parse("2026-09-07T00:00:00.000Z");
		const toMs = fromMs + SIX_HOURS_MS;
		const beforeCursor = store.appendLeadEvent(
			"eng-lead",
			"window-row-before-cursor",
			"runner_question",
			"{}",
		);
		store.db.run("UPDATE lead_events SET created_at=? WHERE seq=?", [
			"2026-09-07T02:00:00.000Z",
			beforeCursor,
		]);
		const cursor = store.appendLeadEvent(
			"eng-lead",
			"previous-decision",
			"summary_due",
			"{}",
		);
		for (const [eventId, createdAt] of [
			["late-old-row", "2026-09-06T23:00:00.000Z"],
			["post-probe-window-row", "2026-09-07T03:00:00.000Z"],
			["unparsable-late-row", "not-a-time"],
			["next-window-early-row", "2026-09-07T07:00:00.000Z"],
		] as const) {
			store.appendLeadEvent("eng-lead", eventId, "runner_question", "{}");
			store.db.run("UPDATE lead_events SET created_at=? WHERE event_id=?", [
				createdAt,
				eventId,
			]);
		}

		expect(
			store.countLeadEventActivity("eng-lead", fromMs, toMs, cursor, true),
		).toBe(4);
		expect(
			store.countLeadEventActivity(
				"eng-lead",
				toMs,
				toMs + SIX_HOURS_MS,
				store.appendLeadEvent(
					"eng-lead",
					"current-decision",
					"summary_due",
					"{}",
				),
				true,
			),
		).toBe(1);
	});
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";

/**
 * FLY-1586 B (lower half) — the durable quarantine marker.
 *
 * `onRowQuarantine` is only allowed to let the loop skip a row once that row is
 * DURABLY recorded. This is that record.
 *
 * ## Two decisions worth stating explicitly
 *
 * **The commit point is the marker, not the alert.** An earlier draft tied
 * "may skip this row" to the alert being accepted by Discord. That would have
 * converted "one bad row wedges the fleet" into "an alert-channel outage wedges
 * the fleet" — the same failure with a different trigger. So: marker committed
 * ⇒ row settled ⇒ cutover continues. Alert delivery advances independently and
 * is allowed to stay red.
 *
 * **It never writes `delivered_at`.** The whole value of this path is that
 * "was it delivered?" stays truthful. A quarantined row was NOT delivered, and
 * nothing here may imply otherwise — that is exactly the class of lie that made
 * the original incident unanswerable 61 hours later.
 */

describe("FLY-1586 B — legacy cutover quarantine marker", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => store.close());

	function append(eventId: string, payload = '{"event_type":"x"}'): number {
		return store.appendLeadEvent(
			"lead-1",
			eventId,
			"session_completed",
			payload,
			"exec-1",
		);
	}

	const now = "2026-07-31T22:00:00.000Z";

	it("records a marker and hides the row from the cutover scan", () => {
		const seq = append("evt-1");
		expect(store.listUndeliveredLeadEvents().map((r) => r.seq)).toContain(seq);

		store.quarantineLegacyCutoverRow({
			seq,
			leadId: "lead-1",
			reason: "invalid_payload_json",
			now,
		});

		// This is what actually stops the re-wedge: every boot rescans, and an
		// un-hidden poison row would throw again on every single one.
		expect(store.listUndeliveredLeadEvents().map((r) => r.seq)).not.toContain(
			seq,
		);
	});

	it("NEVER marks the row delivered", () => {
		const seq = append("evt-2");
		store.quarantineLegacyCutoverRow({
			seq,
			leadId: "lead-1",
			reason: "invalid_payload_json",
			now,
		});
		const row = store.listQuarantinedLegacyRows().find((r) => r.seq === seq);
		expect(row).toBeDefined();
		// Read the journal directly: delivered_at must still be NULL.
		const raw = store.getLeadEventBySeq(seq);
		expect(raw?.delivered_at ?? null).toBeNull();
	});

	it("is idempotent — re-quarantining the same row does not duplicate or reset", () => {
		const seq = append("evt-3");
		store.quarantineLegacyCutoverRow({
			seq,
			leadId: "lead-1",
			reason: "invalid_payload_json",
			now,
		});
		store.quarantineLegacyCutoverRow({
			seq,
			leadId: "lead-1",
			reason: "invalid_payload_json",
			now: "2026-07-31T23:00:00.000Z",
		});
		const rows = store.listQuarantinedLegacyRows().filter((r) => r.seq === seq);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.created_at).toBe(now); // first write wins
	});

	it("starts in pending_alert — alert delivery advances separately", () => {
		const seq = append("evt-4");
		store.quarantineLegacyCutoverRow({
			seq,
			leadId: "lead-1",
			reason: "invalid_payload_json",
			now,
		});
		const row = store.listQuarantinedLegacyRows().find((r) => r.seq === seq);
		expect(row?.state).toBe("pending_alert");
		// The marker alone settles the row. Discord availability is deliberately
		// NOT a precondition for the cutover to proceed.
	});

	it("keeps a payload digest so the record survives the row being edited", () => {
		const seq = append("evt-5", '{"a":1}');
		store.quarantineLegacyCutoverRow({
			seq,
			leadId: "lead-1",
			reason: "invalid_payload_json",
			now,
		});
		const row = store.listQuarantinedLegacyRows().find((r) => r.seq === seq);
		expect(row?.payload_digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("records the field for a rejected write validation", () => {
		const seq = append("evt-6");
		store.quarantineLegacyCutoverRow({
			seq,
			leadId: "lead-1",
			reason: "lone_surrogate",
			field: "source",
			now,
		});
		const row = store.listQuarantinedLegacyRows().find((r) => r.seq === seq);
		expect(row?.reason).toBe("lone_surrogate");
		expect(row?.field).toBe("source");
	});

	it("a replayed row returns to the cutover scan", () => {
		const seq = append("evt-7");
		store.quarantineLegacyCutoverRow({
			seq,
			leadId: "lead-1",
			reason: "invalid_payload_json",
			now,
		});
		expect(store.listUndeliveredLeadEvents().map((r) => r.seq)).not.toContain(
			seq,
		);

		// Manual replay is a human decision (plan §4.3): clear the marker, keep
		// the audit. It must NOT delete history.
		store.markLegacyQuarantineReplayed(seq, "2026-08-01T00:00:00.000Z");

		expect(store.listUndeliveredLeadEvents().map((r) => r.seq)).toContain(seq);
		const row = store.listQuarantinedLegacyRows().find((r) => r.seq === seq);
		expect(row?.replayed_at).toBe("2026-08-01T00:00:00.000Z");
	});

	it("does not hide unrelated rows", () => {
		const poisoned = append("evt-8");
		const healthy = append("evt-9");
		store.quarantineLegacyCutoverRow({
			seq: poisoned,
			leadId: "lead-1",
			reason: "invalid_payload_json",
			now,
		});
		const visible = store.listUndeliveredLeadEvents().map((r) => r.seq);
		expect(visible).not.toContain(poisoned);
		expect(visible).toContain(healthy);
	});
});

describe("FLY-1586 R2 HIGH-5 — quarantine alert state machine", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => store.close());

	const now = "2026-08-01T02:00:00.000Z";

	function quarantined(eventId: string): number {
		const seq = store.appendLeadEvent(
			"lead-1",
			eventId,
			"session_completed",
			'{"event_type":"x"}',
			"exec-1",
		);
		store.quarantineLegacyCutoverRow({
			seq,
			leadId: "lead-1",
			reason: "invalid_payload_json",
			now,
		});
		return seq;
	}

	it("a fresh marker is pending — the row is skipped, the alert is not yet sent", () => {
		const seq = quarantined("evt-a");
		expect(store.listPendingQuarantineAlerts().map((r) => r.seq)).toContain(
			seq,
		);
	});

	it("acceptance moves it out of pending without touching the skip", () => {
		const seq = quarantined("evt-b");
		store.markQuarantineAlertAccepted(seq, now);
		expect(store.listPendingQuarantineAlerts()).toEqual([]);
		// The row stays skipped — the MARKER settles it, not the alert. Tying the
		// skip to alert delivery would turn an alert-channel outage into the same
		// fleet-wide wedge with a different trigger.
		expect(store.listUndeliveredLeadEvents().map((r) => r.seq)).not.toContain(
			seq,
		);
	});

	it("a failing sink keeps it RETRYABLE and visible, never silently dropped", () => {
		const seq = quarantined("evt-c");
		store.recordQuarantineAlertFailure(seq, "FetchError", 5);
		const row = store.listPendingQuarantineAlerts().find((r) => r.seq === seq);
		// Still pending: an alert that quietly gives up is indistinguishable from
		// no problem at all.
		expect(row?.alert_attempts).toBe(1);
		expect(row?.alert_last_error).toBe("FetchError");
	});

	it("dead-letters after the cap but stays queryable", () => {
		const seq = quarantined("evt-d");
		for (let i = 0; i < 5; i++) {
			store.recordQuarantineAlertFailure(seq, "FetchError", 5);
		}
		expect(store.listPendingQuarantineAlerts().map((r) => r.seq)).not.toContain(
			seq,
		);
		const row = store.listQuarantinedLegacyRows().find((r) => r.seq === seq);
		// Visible and red, not erased — an operator can still find it.
		expect(row?.state).toBe("dead_lettered");
		expect(row?.alert_attempts).toBe(5);
	});
});

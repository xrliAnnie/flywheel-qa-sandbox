import { beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("StateStore.tryClaimLeadEvent", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("returns true on first claim and false on subsequent duplicate", () => {
		const first = store.tryClaimLeadEvent(
			"product-lead",
			"silent-heartbeat-2026-04-16T10-00",
			"lead_alert_silent_pane",
			JSON.stringify({ kind: "silent" }),
		);
		expect(first).toBe(true);

		const second = store.tryClaimLeadEvent(
			"product-lead",
			"silent-heartbeat-2026-04-16T10-00",
			"lead_alert_silent_pane",
			JSON.stringify({ kind: "silent" }),
		);
		expect(second).toBe(false);
	});

	it("scopes dedup by leadId (same eventId across leads both succeed)", () => {
		expect(
			store.tryClaimLeadEvent(
				"product-lead",
				"evt-1",
				"lead_alert_silent_pane",
				"{}",
			),
		).toBe(true);
		expect(
			store.tryClaimLeadEvent(
				"ops-lead",
				"evt-1",
				"lead_alert_silent_pane",
				"{}",
			),
		).toBe(true);
	});

	it("distinguishes different eventIds for the same lead", () => {
		expect(
			store.tryClaimLeadEvent(
				"product-lead",
				"evt-silent-1",
				"lead_alert_silent_pane",
				"{}",
			),
		).toBe(true);
		expect(
			store.tryClaimLeadEvent(
				"product-lead",
				"evt-silent-2",
				"lead_alert_silent_pane",
				"{}",
			),
		).toBe(true);
	});

	it("writes the row to lead_events so appendLeadEvent detects the duplicate", () => {
		const claimed = store.tryClaimLeadEvent(
			"product-lead",
			"evt-xyz",
			"lead_alert_permission_blocked",
			JSON.stringify({ marker: "permission_blocked" }),
			"session-abc",
		);
		expect(claimed).toBe(true);

		// appendLeadEvent on UNIQUE conflict returns the existing seq (> 0).
		const seq = store.appendLeadEvent(
			"product-lead",
			"evt-xyz",
			"lead_alert_permission_blocked",
			"{}",
		);
		expect(seq).toBeGreaterThan(0);

		// And tryClaim itself returns false on retry.
		expect(
			store.tryClaimLeadEvent(
				"product-lead",
				"evt-xyz",
				"lead_alert_permission_blocked",
				"{}",
			),
		).toBe(false);
	});
});

import { describe, expect, it, vi } from "vitest";
import type { AlertPayload } from "../../LeadAlertNotifier.js";
import { attachDeliveredAlertLifecycles } from "../drained-alert-routing.js";

function payload(eventType: AlertPayload["eventType"]): AlertPayload {
	return {
		leadId: "quota-monitor",
		projectName: "flywheel",
		eventId: `evt-${eventType}`,
		eventType,
		title: "quota event",
		body: "details",
		severity: "info",
	};
}

describe("FLY-1256 drained alert routing", () => {
	it("account_switched stays root-only: no Hub thread/ticket/ARC dispatch", async () => {
		const attachThreadForDelivered = vi.fn(async () => {});
		await attachDeliveredAlertLifecycles(
			[
				{
					payload: payload("account_switched" as AlertPayload["eventType"]),
					channelId: "ops",
					messageId: "root-info",
				},
			],
			{ attachThreadForDelivered },
		);
		expect(attachThreadForDelivered).not.toHaveBeenCalled();
	});

	it("actionable quota kinds still enter the normal Hub lifecycle", async () => {
		const attachThreadForDelivered = vi.fn(async () => {});
		const actionable = payload("quota_no_target" as AlertPayload["eventType"]);
		await attachDeliveredAlertLifecycles(
			[
				{
					payload: actionable,
					channelId: "ops",
					messageId: "root-actionable",
				},
			],
			{ attachThreadForDelivered },
		);
		expect(attachThreadForDelivered).toHaveBeenCalledExactlyOnceWith(
			actionable,
			"ops",
			"root-actionable",
		);
	});
});

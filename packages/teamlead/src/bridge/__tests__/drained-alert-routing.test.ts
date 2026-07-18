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
	it.each([
		"account_switched",
		"model_cap_switched",
		"model_cap_unknown",
		"quota_switch_confirmation",
	] as const)(
		"%s stays root-only: no Hub thread/ticket/ARC dispatch",
		async (kind) => {
			const attachThreadForDelivered = vi.fn(async () => {});
			await attachDeliveredAlertLifecycles(
				[
					{
						payload: payload(kind as AlertPayload["eventType"]),
						channelId: "ops",
						messageId: "root-info",
					},
				],
				{ attachThreadForDelivered },
			);
			expect(attachThreadForDelivered).not.toHaveBeenCalled();
		},
	);

	it.each([
		"quota_no_target",
		"machine_account_conflict",
		"model_cap_persistent_unknown",
		"model_bench_malformed",
		"quota_choice",
	] as const)(
		"actionable %s still enters the normal Hub lifecycle",
		async (kind) => {
			const attachThreadForDelivered = vi.fn(async () => {});
			const actionable = payload(kind as AlertPayload["eventType"]);
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
		},
	);
});

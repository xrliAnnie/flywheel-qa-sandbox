import { describe, expect, it, vi } from "vitest";
import {
	type StrictDeliveryResult,
	sendQuotaMonitorAlert,
} from "../account-heal/quota-monitor-alert.js";

const alert = {
	kind: "quota_monitor_down" as const,
	severity: "severe" as const,
	title: "Quota monitor stopped",
	body: "No usage response",
	signature: "quota-monitor-down-2026-07-14",
};

describe("sendQuotaMonitorAlert", () => {
	it.each(["sent", "queued_transient", "duplicate"] as StrictDeliveryResult[])(
		"maps %s to a non-throwing accepted result",
		async (delivery) => {
			const execFile = vi.fn(async () => ({
				stdout: `${delivery}\n`,
				stderr: "",
			}));
			await expect(
				sendQuotaMonitorAlert(alert, {
					binPath: "/repo/scripts/lead-alert.sh",
					execFile,
				}),
			).resolves.toBe(delivery);
			expect(execFile).toHaveBeenCalledWith(
				"/repo/scripts/lead-alert.sh",
				[
					"--lead",
					"quota-monitor",
					"--project",
					"flywheel",
					"--kind",
					"quota_monitor_down",
					"--severity",
					"severe",
					"--title",
					"Quota monitor stopped",
					"--body",
					"No usage response",
					"--signature",
					"quota-monitor-down-2026-07-14",
					"--strict-delivery",
				],
				expect.objectContaining({ timeout: 30_000 }),
			);
		},
	);

	it.each(["dead_lettered", "config_error", "unexpected"])(
		"fails loud for %s",
		async (delivery) => {
			await expect(
				sendQuotaMonitorAlert(alert, {
					execFile: async () => ({ stdout: delivery, stderr: "secret detail" }),
				}),
			).rejects.toThrow(/strict delivery failed/i);
		},
	);
});

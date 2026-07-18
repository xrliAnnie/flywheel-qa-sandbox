import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeliveryReport,
	drainQuotaMonitorAlertOutbox,
	sendQuotaMonitorAlert,
} from "../account-heal/quota-monitor-alert.js";
import { emptyQuotaMonitorState } from "../account-heal/quota-monitor-state.js";

const alert = {
	kind: "quota_monitor_down" as const,
	severity: "severe" as const,
	title: "Quota monitor stopped",
	body: "No usage response",
	signature: "quota-monitor-down-2026-07-14",
};

beforeEach(() => {
	delete process.env.FLYWHEEL_QUOTA_ALERT_MENTION_USER;
	delete process.env.FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID;
	delete process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID;
});

afterEach(() => {
	delete process.env.FLYWHEEL_QUOTA_ALERT_MENTION_USER;
	delete process.env.FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID;
	delete process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID;
});

describe("sendQuotaMonitorAlert", () => {
	it.each([
		["sent", { primary: "sent" }],
		["queued_transient", { primary: "queued_transient" }],
		["duplicate", { primary: "duplicate" }],
	] as const)(
		"returns a primary delivery report for %s",
		async (delivery, expected) => {
			const execFile = vi.fn(async () => ({
				stdout: `${delivery}\n`,
				stderr: "",
			}));
			await expect(
				sendQuotaMonitorAlert(alert, {
					binPath: "/repo/scripts/lead-alert.sh",
					execFile,
				}),
			).resolves.toEqual(expected satisfies DeliveryReport);
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

	it.each(["queued_transient", "config_error", "dead_lettered"] as const)(
		"uses strict stdout %s from a non-zero child exit",
		async (delivery) => {
			const error = Object.assign(new Error("redacted process failure"), {
				stdout: `${delivery}\n`,
				stderr: "must-not-surface",
			});
			await expect(
				sendQuotaMonitorAlert(alert, {
					execFile: async () => Promise.reject(error),
				}),
			).resolves.toEqual({ primary: delivery });
		},
	);

	it("accepts a proven durable queue receipt even though lead-alert exits 2", async () => {
		await expect(
			sendQuotaMonitorAlert(alert, {
				execFile: async () => {
					throw Object.assign(new Error("exit 2"), {
						stdout: "queued_transient\n",
						stderr: "queued",
					});
				},
			}),
		).resolves.toEqual({ primary: "queued_transient" });
	});

	it("clears the durable outbox only for sent or durably queued receipts", async () => {
		const state = emptyQuotaMonitorState(8);
		state.alertOutbox = [
			{
				eventId: "event-1",
				generation: 8,
				createdAt: 1,
				alert,
			},
		];
		const persistState = vi.fn(async () => {});

		const unconfirmed = await drainQuotaMonitorAlertOutbox(state, {
			send: async () => "duplicate",
			persistState,
		});
		expect(unconfirmed.state.alertOutbox).toHaveLength(1);
		expect(persistState).not.toHaveBeenCalled();

		const queued = await drainQuotaMonitorAlertOutbox(state, {
			send: async () => "queued_transient",
			persistState,
		});
		expect(queued.state.alertOutbox).toEqual([]);
		expect(persistState).toHaveBeenCalledWith(queued.state);
	});

	it.each([
		[
			"spawn failure",
			async () => Promise.reject(new Error("secret path")),
			"process_error",
		],
		[
			"empty stdout",
			async () => ({ stdout: "", stderr: "secret" }),
			"process_error",
		],
		[
			"invalid stdout",
			async () => ({ stdout: "surprise", stderr: "secret" }),
			"invalid_result",
		],
	] as const)(
		"normalizes %s without throwing",
		async (_label, execFile, expected) => {
			await expect(sendQuotaMonitorAlert(alert, { execFile })).resolves.toEqual(
				{
					primary: expected,
				},
			);
		},
	);

	it("mentions and dual-routes severe kinds while preserving asymmetric results", async () => {
		process.env.FLYWHEEL_QUOTA_ALERT_MENTION_USER = "123456789";
		process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID = "111";
		process.env.FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID = "222";
		const execFile = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "sent\n", stderr: "" })
			.mockResolvedValueOnce({ stdout: "config_error\n", stderr: "" });

		await expect(
			sendQuotaMonitorAlert(
				{
					kind: "account_switch_degraded",
					severity: "severe",
					title: "Degraded switch",
					body: "shopping->school",
					signature: "degraded-1",
				},
				{ execFile },
			),
		).resolves.toEqual({ primary: "sent", secondary: "config_error" });
		expect(execFile).toHaveBeenCalledTimes(2);
		for (const call of execFile.mock.calls) {
			expect(call[1]).toEqual(
				expect.arrayContaining(["--mention-user", "123456789"]),
			);
		}
		expect(execFile.mock.calls[1]?.[1]).toEqual(
			expect.arrayContaining(["--signature", "degraded-1-core"]),
		);
		expect(execFile.mock.calls[1]?.[2]).toEqual(
			expect.objectContaining({
				env: expect.objectContaining({
					FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "222",
				}),
			}),
		);
	});

	it("deduplicates severe routing when the severe and unified channels match", async () => {
		process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID = "111";
		process.env.FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID = "111";
		const execFile = vi.fn(async () => ({ stdout: "sent\n", stderr: "" }));

		await sendQuotaMonitorAlert(
			{
				kind: "quota_no_target",
				severity: "severe",
				title: "No target",
				body: "none",
				signature: "none-1",
			},
			{ execFile },
		);

		expect(execFile).toHaveBeenCalledTimes(1);
	});

	it("escalates transition-journal conflicts with mention + severe dual route", async () => {
		process.env.FLYWHEEL_QUOTA_ALERT_MENTION_USER = "123456789";
		process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID = "111";
		process.env.FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID = "222";
		const execFile = vi.fn(async () => ({ stdout: "sent\n", stderr: "" }));

		await sendQuotaMonitorAlert(
			{
				kind: "account_switch_failed",
				severity: "severe",
				title: "Switch failed",
				body: "reason=transition_journal_conflict; degraded=false",
				signature: "journal-conflict-1",
			},
			{ execFile },
		);

		expect(execFile).toHaveBeenCalledTimes(2);
		for (const call of execFile.mock.calls) {
			expect(call[1]).toEqual(
				expect.arrayContaining(["--mention-user", "123456789"]),
			);
		}
	});

	it.each([
		[
			"identity mismatch",
			{
				kind: "account_identity_mismatch" as const,
				severity: "severe" as const,
				title: "Identity mismatch",
				body: "label=shopping",
				signature: "identity-mismatch-1",
			},
		],
		[
			"identity rollback failure",
			{
				kind: "account_switch_failed" as const,
				severity: "severe" as const,
				title: "Switch failed",
				body: "reason=identity_rollback_failed; degraded=false",
				signature: "identity-rollback-1",
			},
		],
	] as const)(
		"escalates %s with mention + severe dual route",
		async (_name, input) => {
			process.env.FLYWHEEL_QUOTA_ALERT_MENTION_USER = "123456789";
			process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID = "111";
			process.env.FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID = "222";
			const execFile = vi.fn(async () => ({ stdout: "sent\n", stderr: "" }));

			await sendQuotaMonitorAlert(input, { execFile });

			expect(execFile).toHaveBeenCalledTimes(2);
			for (const call of execFile.mock.calls) {
				expect(call[1]).toEqual(
					expect.arrayContaining(["--mention-user", "123456789"]),
				);
			}
		},
	);

	it("does not mention informational recovery alerts", async () => {
		process.env.FLYWHEEL_QUOTA_ALERT_MENTION_USER = "123456789";
		const execFile = vi.fn(async () => ({ stdout: "sent\n", stderr: "" }));

		await sendQuotaMonitorAlert(
			{
				kind: "quota_blocked_recovered",
				severity: "info",
				title: "Recovered",
				body: "healthy",
				signature: "recovered-1",
			},
			{ execFile },
		);

		expect(execFile.mock.calls[0]?.[1]).not.toContain("--mention-user");
	});
});

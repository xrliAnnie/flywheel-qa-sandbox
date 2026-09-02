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
	delete process.env.FLYWHEEL_NOTIFY_CHANNEL;
	delete process.env.FLYWHEEL_FOUNDER_USER_ID;
});

afterEach(() => {
	delete process.env.FLYWHEEL_QUOTA_ALERT_MENTION_USER;
	delete process.env.FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID;
	delete process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID;
	delete process.env.FLYWHEEL_NOTIFY_CHANNEL;
	delete process.env.FLYWHEEL_FOUNDER_USER_ID;
});

describe("sendQuotaMonitorAlert", () => {
	it("routes a complete account switch notice to notification with the founder mention", async () => {
		process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID = "alerts-channel";
		process.env.FLYWHEEL_NOTIFY_CHANNEL = "notification-channel";
		const founderUserId = "1".repeat(18);
		process.env.FLYWHEEL_FOUNDER_USER_ID = founderUserId;
		const body =
			"shopping->school; scope=5h; degraded=false; from5h=91; from7d=74; to5h=12; to7d=8; revived=2; pending=0; login_expired=0";
		const execFile = vi.fn(async () => ({ stdout: "sent\n", stderr: "" }));

		await expect(
			sendQuotaMonitorAlert(
				{
					kind: "account_switched",
					severity: "info",
					title: "Claude account switched before quota exhaustion",
					body,
					signature: "account-switched-shopping-school-7",
				},
				{ execFile },
			),
		).resolves.toEqual({ primary: "sent" });

		expect(execFile).toHaveBeenCalledTimes(1);
		const call = execFile.mock.calls[0];
		expect(call?.[1]).toEqual(
			expect.arrayContaining([
				"--mention-user",
				founderUserId,
				"--plain-message",
			]),
		);
		const bodyIndex = call?.[1].indexOf("--body") ?? -1;
		expect(call?.[1][bodyIndex + 1]).toBe(body);
		expect(call?.[2]).toEqual(
			expect.objectContaining({
				env: expect.objectContaining({
					FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "notification-channel",
				}),
			}),
		);
	});

	it.each([
		["account_switch_degraded", "severe"],
		["quota_switch_confirmation", "info"],
	] as const)("routes %s to notification", async (kind, severity) => {
		process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID = "alerts-channel";
		process.env.FLYWHEEL_NOTIFY_CHANNEL = "notification-channel";
		const execFile = vi.fn(async () => ({ stdout: "sent\n", stderr: "" }));

		await sendQuotaMonitorAlert(
			{
				kind,
				severity,
				title: `Title for ${kind}`,
				body: `Body for ${kind}`,
				signature: `signature-${kind}`,
			},
			{ execFile },
		);

		expect(execFile).toHaveBeenCalledTimes(1);
		expect(execFile.mock.calls[0]?.[2]).toEqual(
			expect.objectContaining({
				env: expect.objectContaining({
					FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "notification-channel",
				}),
			}),
		);
		expect(execFile.mock.calls[0]?.[1]).toContain("--plain-message");
	});

	it("keeps the degraded severe secondary as an alert while its notification primary is plain", async () => {
		process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID = "alerts-channel";
		process.env.FLYWHEEL_NOTIFY_CHANNEL = "notification-channel";
		process.env.FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID = "severe-channel";
		const execFile = vi.fn(async () => ({ stdout: "sent\n", stderr: "" }));

		await sendQuotaMonitorAlert(
			{
				kind: "account_switch_degraded",
				severity: "severe",
				title: "Degraded switch",
				body: "human body",
				signature: "degraded-switch-style",
			},
			{ execFile },
		);

		expect(execFile).toHaveBeenCalledTimes(2);
		expect(execFile.mock.calls[0]?.[1]).toContain("--plain-message");
		expect(execFile.mock.calls[1]?.[1]).not.toContain("--plain-message");
		expect(execFile.mock.calls[0]?.[2].env).toEqual(
			expect.objectContaining({
				FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "notification-channel",
			}),
		);
		expect(execFile.mock.calls[1]?.[2].env).toEqual(
			expect.objectContaining({
				FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "severe-channel",
			}),
		);
	});

	it("keeps quota_no_target on the unified alerts channel when notify is configured", async () => {
		process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID = "alerts-channel";
		process.env.FLYWHEEL_NOTIFY_CHANNEL = "notification-channel";
		const observedChannels: Array<string | undefined> = [];
		const execFile = vi.fn(async (_file, _args, options) => {
			observedChannels.push(
				options.env?.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID ??
					process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID,
			);
			return { stdout: "sent\n", stderr: "" };
		});

		await sendQuotaMonitorAlert(
			{
				kind: "quota_no_target",
				severity: "severe",
				title: "No target",
				body: "scope=5h",
				signature: "quota-no-target-negative-control",
			},
			{ execFile },
		);

		expect(observedChannels).toEqual(["alerts-channel"]);
		expect(execFile.mock.calls[0]?.[2].env).toEqual(
			expect.objectContaining({
				FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "alerts-channel",
			}),
		);
		expect(execFile.mock.calls[0]?.[1]).not.toContain("--plain-message");
	});

	it.each([
		["account_switched", "info"],
		["account_switch_degraded", "severe"],
		["quota_switch_confirmation", "info"],
	] as const)(
		"fails closed instead of falling back to alerts when %s has no notify channel",
		async (kind, severity) => {
			process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID = "alerts-channel";
			const execFile = vi.fn(async () => ({ stdout: "sent\n", stderr: "" }));

			await expect(
				sendQuotaMonitorAlert(
					{
						kind,
						severity,
						title: `Title for ${kind}`,
						body: `Body for ${kind}`,
						signature: `missing-notify-${kind}`,
					},
					{ execFile },
				),
			).resolves.toEqual({ primary: "config_error" });
			expect(execFile).not.toHaveBeenCalled();
		},
	);

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
		process.env.FLYWHEEL_NOTIFY_CHANNEL = "333";
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
		expect(execFile.mock.calls[0]?.[2]).toEqual(
			expect.objectContaining({
				env: expect.objectContaining({
					FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "333",
				}),
			}),
		);
		expect(execFile.mock.calls[1]?.[2]).toEqual(
			expect.objectContaining({
				env: expect.objectContaining({
					FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "222",
				}),
			}),
		);
	});

	it.each([
		["notification primary", "222", "222"],
		["global unified alerts", "333", "111"],
	] as const)(
		"does not send a degraded switch secondary to the %s channel",
		async (_label, notifyChannel, severeChannel) => {
			process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID = "111";
			process.env.FLYWHEEL_NOTIFY_CHANNEL = notifyChannel;
			process.env.FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID = severeChannel;
			const execFile = vi.fn(async () => ({ stdout: "sent\n", stderr: "" }));

			await sendQuotaMonitorAlert(
				{
					kind: "account_switch_degraded",
					severity: "severe",
					title: "Degraded switch",
					body: "shopping->school",
					signature: `degraded-no-secondary-${notifyChannel}-${severeChannel}`,
				},
				{ execFile },
			);

			expect(execFile).toHaveBeenCalledTimes(1);
			expect(execFile.mock.calls[0]?.[2].env).toEqual(
				expect.objectContaining({
					FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: notifyChannel,
				}),
			);
		},
	);

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

	// FLY-1366: during the incident neither quota mention env was set on the
	// daemon, so quota_no_target reached #flywheel-alerts with no @ and the
	// founder never saw it. FLYWHEEL_FOUNDER_USER_ID was present all along.
	describe("mention fallback to the founder", () => {
		const noTarget = {
			kind: "quota_no_target" as const,
			severity: "severe" as const,
			title: "No verified Claude account has quota",
			body: "scope=5h",
			signature: "quota-no-target-2026-07-18",
		};

		afterEach(() => {
			delete process.env.FLYWHEEL_FOUNDER_USER_ID;
		});

		it.each([
			["unset", undefined],
			["empty", ""],
			["whitespace only", "   "],
		])(
			"falls back to the founder when the quota mention env is %s",
			async (_label, configured) => {
				if (configured !== undefined) {
					process.env.FLYWHEEL_QUOTA_ALERT_MENTION_USER = configured;
				}
				process.env.FLYWHEEL_FOUNDER_USER_ID = "1138241636057481306";
				const execFile = vi.fn(async () => ({ stdout: "sent\n", stderr: "" }));

				await sendQuotaMonitorAlert(noTarget, { execFile });

				expect(execFile.mock.calls[0]?.[1]).toEqual(
					expect.arrayContaining(["--mention-user", "1138241636057481306"]),
				);
			},
		);

		it("prefers an explicitly configured quota mention over the founder", async () => {
			process.env.FLYWHEEL_QUOTA_ALERT_MENTION_USER = "123456789";
			process.env.FLYWHEEL_FOUNDER_USER_ID = "1138241636057481306";
			const execFile = vi.fn(async () => ({ stdout: "sent\n", stderr: "" }));

			await sendQuotaMonitorAlert(noTarget, { execFile });

			expect(execFile.mock.calls[0]?.[1]).toEqual(
				expect.arrayContaining(["--mention-user", "123456789"]),
			);
		});

		it("never mentions on a non-mention alert kind even with a founder id set", async () => {
			process.env.FLYWHEEL_FOUNDER_USER_ID = "1138241636057481306";
			const execFile = vi.fn(async () => ({ stdout: "sent\n", stderr: "" }));

			await sendQuotaMonitorAlert(
				{
					kind: "quota_blocked_recovered",
					severity: "info",
					title: "Recovered",
					body: "healthy",
					signature: "recovered-2",
				},
				{ execFile },
			);

			expect(execFile.mock.calls[0]?.[1]).not.toContain("--mention-user");
		});

		it("sends without a mention when neither env is usable", async () => {
			process.env.FLYWHEEL_QUOTA_ALERT_MENTION_USER = "  ";
			const execFile = vi.fn(async () => ({ stdout: "sent\n", stderr: "" }));

			await sendQuotaMonitorAlert(noTarget, { execFile });

			expect(execFile.mock.calls[0]?.[1]).not.toContain("--mention-user");
		});
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { GatePoller, type GatePollerConfig } from "../gate-poller.js";

const LEAD = {
	agentId: "flywheel-eng-lead",
	chatChannel: "C1",
	botToken: "bot-token",
	match: { labels: ["flywheel"] },
};

function makePoller(overrides: Record<string, unknown> = {}) {
	const store = {
		getActiveSessions: vi.fn(() => []),
		getEventsByType: vi.fn(() => []),
		listPendingFounderActions: vi.fn(() => []),
		pruneLeadPendingEscalationNotIn: vi.fn(),
		recoverFromCorruption: vi.fn(),
	};
	return new GatePoller({
		pollIntervalMs: 60_000,
		projects: [{ projectName: "flywheel", leads: [LEAD] }],
		store: store as unknown as GatePollerConfig["store"],
		runtimeRegistry: {} as unknown as GatePollerConfig["runtimeRegistry"],
		...overrides,
	});
}

async function poll(poller: GatePoller): Promise<void> {
	await (poller as unknown as { poll(): Promise<void> }).poll();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("FLY-1392 receipt-foundation emergency rollback alerts", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fails loud at startup when receipt chasing is paused", async () => {
		const alert = vi.fn(async () => ({ sent: true }));
		const error = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const poller = makePoller({
			receiptFoundationEnabled: () => false,
			leadAlertSink: { alert },
		});

		poller.start();
		await vi.waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
		poller.stop();

		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("receipt foundation OFF — 追办已暂停"),
		);
		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				eventType: "receipt_foundation_off",
				eventId: expect.stringMatching(/^receipt-foundation-off:startup:/),
				title: "receipt foundation OFF — 追办已暂停",
				severity: "severe",
			}),
		);
	});

	it("repeats the fail-loud alert on the bounded poll cadence", async () => {
		const alert = vi.fn(async () => ({ sent: true }));
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const poller = makePoller({
			receiptFoundationEnabled: () => false,
			receiptFoundationOffAlertEveryNTicks: 2,
			leadAlertSink: { alert },
		});

		for (let tick = 0; tick < 5; tick += 1) await poll(poller);

		expect(alert).toHaveBeenCalledTimes(2);
		expect(alert.mock.calls.map(([payload]) => payload.eventId)).toEqual([
			expect.stringMatching(/^receipt-foundation-off:periodic:.*:2$/),
			expect.stringMatching(/^receipt-foundation-off:periodic:.*:4$/),
		]);
	});

	it("stays silent while the receipt foundation is enabled", async () => {
		const alert = vi.fn(async () => ({ sent: true }));
		const error = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const poller = makePoller({
			receiptFoundationEnabled: () => true,
			receiptFoundationOffAlertEveryNTicks: 1,
			leadAlertSink: { alert },
		});

		poller.start();
		await poll(poller);
		poller.stop();

		expect(alert).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});
});

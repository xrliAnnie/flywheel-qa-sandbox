import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertPayload } from "../LeadAlertNotifier.js";
import { LeadWatchdog } from "../LeadWatchdog.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const singleLeadProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geo",
		generalChannel: "core-1",
		leads: [
			{
				agentId: "cos-lead",
				forumChannel: "forum-1",
				chatChannel: "chat-1",
				match: { labels: ["cos"] },
				alertChannel: "alerts-1",
				alertBotTokenEnv: "SIMBA_BOT_TOKEN",
			},
		],
	},
];

const multiLeadProjects: ProjectEntry[] = [
	{
		...singleLeadProjects[0]!,
		leads: [
			...singleLeadProjects[0]!.leads,
			{
				agentId: "product-lead",
				forumChannel: "forum-2",
				chatChannel: "chat-2",
				match: { labels: ["Product"] },
				alertChannel: "alerts-1",
				alertBotTokenEnv: "PETER_BOT_TOKEN",
			},
		],
	},
];

const projects = singleLeadProjects;

interface NotifierStub {
	alert: ReturnType<typeof vi.fn>;
	results: AlertPayload[];
}

function makeNotifier(): NotifierStub {
	const results: AlertPayload[] = [];
	const alert = vi.fn(async (p: AlertPayload) => {
		results.push(p);
		return { sent: true };
	});
	return { alert, results };
}

describe("LeadWatchdog", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("stays in AwaitingFirstCapture when tmux window is not found yet", async () => {
		const notifier = makeNotifier();
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => null,
			captureFn: async () => {
				throw new Error("should not be called");
			},
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 0,
		});
		await wd.pollOnce();
		expect(notifier.alert).not.toHaveBeenCalled();
		expect(wd.getState("cos-lead")).toBe("AwaitingFirstCapture");
	});

	it("transitions to Healthy on first successful capture", async () => {
		const notifier = makeNotifier();
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => "some pane content\ncursor: typing",
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 0,
		});
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Healthy");
		expect(notifier.alert).not.toHaveBeenCalled();
	});

	it("goes Healthy → Suspicious → Alert after 3 unchanged cycles with blocked prompt", async () => {
		const notifier = makeNotifier();
		const stuckContent =
			"rate limit: too many requests. try again at 14:30.\n> ";
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => stuckContent,
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 1_700_000_000_000,
		});

		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Healthy");

		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Suspicious");

		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Cooldown");
		expect(notifier.alert).toHaveBeenCalledTimes(1);
		const payload = notifier.results[0]!;
		expect(payload.leadId).toBe("cos-lead");
		expect(payload.eventType).toBe("rate_limit");
	});

	it("falls back to pane_hash_stuck when unchanged pane has no blocked keywords", async () => {
		const notifier = makeNotifier();
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => "idle working...",
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 0,
		});
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		expect(notifier.alert).toHaveBeenCalledTimes(1);
		expect(notifier.results[0]!.eventType).toBe("pane_hash_stuck");
	});

	it("resets stuck counter and stays Healthy when pane changes", async () => {
		const notifier = makeNotifier();
		let tick = 0;
		const captures = ["first", "first", "second", "third"];
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => captures[tick++]!,
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 0,
		});
		await wd.pollOnce();
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Suspicious");
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Healthy");
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Healthy");
		expect(notifier.alert).not.toHaveBeenCalled();
	});

	it("early-exits to Silent when a blocked marker file is present", async () => {
		const notifier = makeNotifier();
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => "anything",
			claimsReader: async () => new Set(),
			blockedMarkerReader: async (leadId) =>
				leadId === "cos-lead" ? ["permission_blocked"] : [],
			now: () => 0,
		});
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Silent");
		expect(notifier.alert).not.toHaveBeenCalled();
	});

	it("goes to Silent when shell already claimed the current eventId", async () => {
		const notifier = makeNotifier();
		const stuckContent = "permission required to write file /tmp/x\n> ";
		const capturedEventIds: string[] = [];
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => stuckContent,
			claimsReader: async () => {
				// Fake: shell already claimed the eventId the watchdog is about to try.
				const payload: AlertPayload = {
					leadId: "cos-lead",
					projectName: "geoforge3d",
					eventId: "placeholder",
					eventType: "permission_blocked",
					title: "t",
					body: "b",
					severity: "severe",
				};
				capturedEventIds.push(payload.eventId);
				// Return wildcard match — any eventId reads as "already claimed".
				return new Set(["__any__"]);
			},
			blockedMarkerReader: async () => [],
			now: () => 1_700_000_000_000,
			// Testing hook: treat any claimsReader hit as a dedup win.
			claimsReaderMatchAll: true,
		});
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Silent");
		expect(notifier.alert).not.toHaveBeenCalled();
	});

	it("enters Cooldown after alert and does not re-alert within cooldownMs", async () => {
		const notifier = makeNotifier();
		const stuckContent = "rate limit reached, please try again.\n> ";
		let nowMs = 1_700_000_000_000;
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async () => ({
				windowId: "@7",
				windowName: "geoforge3d-cos-lead",
			}),
			captureFn: async () => stuckContent,
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => nowMs,
		});
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Cooldown");
		nowMs += 60_000;
		await wd.pollOnce();
		await wd.pollOnce();
		await wd.pollOnce();
		expect(notifier.alert).toHaveBeenCalledTimes(1);
	});

	it("tracks multiple leads independently", async () => {
		const notifier = makeNotifier();
		const wd = new LeadWatchdog({
			pollIntervalMs: 30_000,
			paneHashStuckCycles: 2,
			paneHashAlertCycles: 3,
			cooldownMs: 300_000,
			projects: multiLeadProjects,
			store,
			notifier: notifier.alert,
			locateWindowFn: async (_p, lead) =>
				lead === "cos-lead"
					? { windowId: "@7", windowName: "geoforge3d-cos-lead" }
					: null,
			captureFn: async () => "fresh",
			claimsReader: async () => new Set(),
			blockedMarkerReader: async () => [],
			now: () => 0,
		});
		await wd.pollOnce();
		expect(wd.getState("cos-lead")).toBe("Healthy");
		expect(wd.getState("product-lead")).toBe("AwaitingFirstCapture");
	});

	it("start/stop wires up and tears down the poll timer", async () => {
		vi.useFakeTimers();
		try {
			const notifier = makeNotifier();
			const locateWindowFn = vi.fn(async () => null);
			const wd = new LeadWatchdog({
				pollIntervalMs: 30_000,
				paneHashStuckCycles: 2,
				paneHashAlertCycles: 3,
				cooldownMs: 300_000,
				projects,
				store,
				notifier: notifier.alert,
				locateWindowFn,
				captureFn: async () => "",
				claimsReader: async () => new Set(),
				blockedMarkerReader: async () => [],
				now: () => 0,
			});
			wd.start();
			await vi.advanceTimersByTimeAsync(30_000);
			expect(locateWindowFn).toHaveBeenCalled();
			wd.stop();
			const calls = locateWindowFn.mock.calls.length;
			await vi.advanceTimersByTimeAsync(120_000);
			expect(locateWindowFn.mock.calls.length).toBe(calls);
		} finally {
			vi.useRealTimers();
		}
	});
});

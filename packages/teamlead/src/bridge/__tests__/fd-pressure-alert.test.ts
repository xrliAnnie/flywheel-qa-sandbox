import { afterEach, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { AlertChannelHub, correlationKeyFor } from "../AlertChannelHub.js";
import { FdPressureAlert } from "../fd-pressure-alert.js";
import type { FdHealth } from "../process-resource-monitor.js";
const stores: StateStore[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
});
const sample = {
	used: 81,
	limit: 100,
	usage_ratio: 0.81,
	status: "fresh",
} as FdHealth;
it("keeps one boot/episode identity across rejected attempts and requires receipt evidence for duplicates", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const alert = vi
		.fn()
		.mockResolvedValueOnce({ skipped: "disabled" })
		.mockResolvedValue({ skipped: "duplicate" });
	const source = new FdPressureAlert({
		store,
		bootId: "boot-one",
		alert,
		resolve: async () => {},
	});
	expect(await source.alert(sample)).toBe(false);
	expect(await source.alert(sample)).toBe(false);
	const payload = alert.mock.calls[0][0];
	expect(alert.mock.calls[1][0]).toEqual(payload);
	expect(payload).toMatchObject({
		eventType: "bridge_fd_pressure",
		projectName: "machine",
		sessionKey: "bridge-fd:boot-one",
	});
	store.recordAlertDeliveryReceipt(
		payload.eventId,
		"queued_durable",
		new Date().toISOString(),
	);
	expect(await source.alert(sample)).toBe(true);
});
it("resolves only the matching episode, preserves failures, and creates a new identity after recovery", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const alert = vi.fn(async () => ({ queued: true }));
	const resolve = vi
		.fn()
		.mockRejectedValueOnce(new Error("transport"))
		.mockResolvedValue(undefined);
	const source = new FdPressureAlert({
		store,
		bootId: "boot-two",
		alert,
		resolve,
	});
	await source.alert(sample);
	const old = alert.mock.calls[0][0];
	await expect(source.resolve()).rejects.toThrow("transport");
	expect(
		source.recoveryProbe({
			event_id: old.eventId,
			session_key: old.sessionKey,
		}),
	).toBe(false);
	expect(await source.resolve()).toBe(true);
	expect(
		source.recoveryProbe({
			event_id: old.eventId,
			session_key: old.sessionKey,
		}),
	).toBe(true);
	expect(
		source.recoveryProbe({ event_id: old.eventId, session_key: "other-boot" }),
	).toBeNull();
	await source.alert(sample);
	expect(alert.mock.calls[1][0].eventId).not.toBe(old.eventId);
	expect(alert.mock.calls[1][0].sessionKey).toBe(old.sessionKey);
});
it("quietly resolves a delayed Hub delivery through the same boot recovery probe", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const queued: import("../../LeadAlertNotifier.js").AlertPayload[] = [];
	const source = new FdPressureAlert({
		store,
		bootId: "delayed",
		alert: async (p) => {
			queued.push(p);
			return { queued: true };
		},
		resolve: async () => {},
	});
	await source.alert(sample);
	await source.resolve();
	const posts = vi.fn(async () => {});
	const archive = vi.fn(async () => {});
	const hub = new AlertChannelHub({
		store,
		notifier: {
			alert: async () => ({
				sent: true,
				channelId: "channel",
				messageId: "root",
			}),
		},
		discord: {
			createThreadFromMessage: async () => "thread",
			postToThread: posts,
			archiveThread: archive,
		},
		fleetRecovery: async (row) => source.recoveryProbe(row),
	});
	const payload = queued[0]!;
	await hub.handle(payload);
	expect(store.getActiveAlertThread(correlationKeyFor(payload))).toBeDefined();
	await hub.reconcile();
	expect(
		store.getActiveAlertThread(correlationKeyFor(payload)),
	).toBeUndefined();
	expect(archive).toHaveBeenCalledTimes(1);
	expect(posts.mock.calls.every((call) => !call[2]?.mentionUserId)).toBe(true);
});

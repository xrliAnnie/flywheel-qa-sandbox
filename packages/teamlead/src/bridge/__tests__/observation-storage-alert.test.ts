import { expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { AlertChannelHub, correlationKeyFor } from "../AlertChannelHub.js";
import { ObservationStorageAlert } from "../observation-storage-alert.js";

it("alerts on consecutive starvation and allocates a new episode after recovery", async () => {
	const store = await StateStore.create(":memory:");
	try {
		const alert = vi.fn(async () => ({ queued: true }));
		const source = new ObservationStorageAlert({
			store,
			bootId: "starved",
			alert,
		});
		await source.tick();
		expect(alert).not.toHaveBeenCalled();
		for (let i = 0; i < 3; i++)
			store.recordShipJudgmentObservationProgress("closeout", 0, 30, 25);
		await source.tick();
		const first = alert.mock.calls[0][0];
		expect(first.body).toContain("zero-progress");
		expect(
			source.recoveryProbe({
				event_id: first.eventId,
				session_key: first.sessionKey,
			}),
		).toBe(false);
		store.recordShipJudgmentObservationProgress("closeout", 1, 30, 25);
		await source.tick();
		for (let i = 0; i < 3; i++)
			store.recordShipJudgmentObservationProgress("closeout", 0, 30, 25);
		await source.tick();
		expect(alert.mock.calls[1][0].eventId).not.toBe(first.eventId);
		expect(
			source.recoveryProbe({
				event_id: first.eventId,
				session_key: first.sessionKey,
			}),
		).toBe(true);
	} finally {
		store.close();
	}
});

it("does not let an in-flight delivery rejection abort shutdown", async () => {
	const store = await StateStore.create(":memory:");
	try {
		for (let i = 0; i < 3; i++)
			store.recordShipJudgmentObservationProgress("verdict", 0, 30, 25);
		let reject!: (error: Error) => void;
		const source = new ObservationStorageAlert({
			store,
			bootId: "reject",
			alert: () =>
				new Promise((_, fail) => {
					reject = fail;
				}),
		});
		const failed = source.tick().catch(() => false);
		await Promise.resolve();
		const stopping = source.stop();
		reject(new Error("transport unavailable"));
		await expect(stopping).resolves.toBeUndefined();
		expect(await failed).toBe(false);
	} finally {
		store.close();
	}
});

it("retries rejected delivery with a stable identity and requires a durable duplicate receipt", async () => {
	const store = await StateStore.create(":memory:");
	try {
		vi.spyOn(store, "getShipJudgmentObservationStorage").mockReturnValue({
			status: "unavailable",
			reason: "schema_drift",
		});
		const alert = vi
			.fn()
			.mockResolvedValueOnce({ skipped: "disabled" })
			.mockResolvedValue({ skipped: "duplicate" });
		const source = new ObservationStorageAlert({
			store,
			bootId: "boot-one",
			alert,
		});
		expect(await source.tick()).toBe(false);
		expect(await source.tick()).toBe(false);
		const payload = alert.mock.calls[0][0];
		expect(payload).toMatchObject({
			eventType: "ship_judgment_observation_unavailable",
			projectName: "machine",
		});
		expect(alert.mock.calls[1][0]).toEqual(payload);
		store.recordAlertDeliveryReceipt(
			payload.eventId,
			"queued_durable",
			new Date().toISOString(),
		);
		expect(await source.tick()).toBe(true);
		await source.tick();
		expect(alert).toHaveBeenCalledTimes(3);
	} finally {
		store.close();
	}
});

it("reconciles an earlier failed boot only when the current storage is ready", async () => {
	const store = await StateStore.create(":memory:");
	try {
		const read = vi
			.spyOn(store, "getShipJudgmentObservationStorage")
			.mockReturnValue({ status: "unavailable", reason: "migration_failed" });
		const alert = vi.fn(async () => ({ queued: true }));
		const source = new ObservationStorageAlert({ store, bootId: "old", alert });
		await source.tick();
		const payload = alert.mock.calls[0][0];
		const recovered = new ObservationStorageAlert({
			store,
			bootId: "new",
			alert,
		});
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
				postToThread: async () => {},
				archiveThread: archive,
			},
			fleetRecovery: async (row) => recovered.recoveryProbe(row),
		});
		await hub.handle(payload);
		await hub.reconcile();
		expect(
			store.getActiveAlertThread(correlationKeyFor(payload)),
		).toBeDefined();
		read.mockReturnValue({ status: "ready", reason: null });
		await hub.reconcile();
		expect(
			store.getActiveAlertThread(correlationKeyFor(payload)),
		).toBeUndefined();
		expect(archive).toHaveBeenCalledTimes(1);
		await recovered.tick();
		expect(alert).toHaveBeenCalledTimes(1);
		expect(
			recovered.recoveryProbe({ event_id: "unrelated", session_key: "other" }),
		).toBeNull();
	} finally {
		store.close();
	}
});

it("keeps a single delivery flight and waits for it before shutdown", async () => {
	const store = await StateStore.create(":memory:");
	try {
		vi.spyOn(store, "getShipJudgmentObservationStorage").mockReturnValue({
			status: "unavailable",
			reason: "not_initialized",
		});
		let release!: () => void;
		const alert = vi.fn(
			() =>
				new Promise<{ queued: true }>((resolve) => {
					release = () => resolve({ queued: true });
				}),
		);
		const source = new ObservationStorageAlert({
			store,
			bootId: "pending",
			alert,
		});
		const first = source.tick();
		expect(source.tick()).toBe(first);
		await Promise.resolve();
		let stopped = false;
		const stopping = source.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		release();
		await stopping;
		await source.tick();
		expect(alert).toHaveBeenCalledTimes(1);
	} finally {
		store.close();
	}
});

it("refreshes delivered alert bodies on every failure-mode transition without a healthy tick", async () => {
	const store = await StateStore.create(":memory:");
	try {
		const read = vi
			.spyOn(store, "getShipJudgmentObservationStorage")
			.mockReturnValue({ status: "ready", reason: null });
		for (let i = 0; i < 3; i++)
			store.recordShipJudgmentObservationProgress("verdict", 0, 30, 25);
		const alert = vi.fn().mockResolvedValue({ queued: true });
		const source = new ObservationStorageAlert({
			store,
			bootId: "transition",
			alert,
		});
		await source.tick();
		expect(alert.mock.calls[0][0].body).toContain("zero-progress");
		read.mockReturnValue({ status: "unavailable", reason: "schema_drift" });
		await source.tick();
		expect(alert).toHaveBeenCalledTimes(2);
		expect(alert.mock.calls[1][0].body).toContain("schema_drift");
		read.mockReturnValue({ status: "unavailable", reason: "migration_failed" });
		await source.tick();
		expect(alert.mock.calls[2][0].body).toContain("migration_failed");
		read.mockReturnValue({ status: "ready", reason: null });
		await source.tick();
		expect(alert.mock.calls[3][0].body).toContain("zero-progress");
		expect(
			new Set(alert.mock.calls.map(([payload]) => payload.eventId)).size,
		).toBe(4);
		await source.tick();
		expect(alert).toHaveBeenCalledTimes(4);
		const old = alert.mock.calls[0][0];
		expect(
			source.recoveryProbe({
				event_id: old.eventId,
				session_key: old.sessionKey,
			}),
		).toBe(true);
	} finally {
		store.close();
	}
});

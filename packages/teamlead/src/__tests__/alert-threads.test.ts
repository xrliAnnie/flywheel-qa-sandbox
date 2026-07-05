/**
 * FLY-368: StateStore alert_threads (active-mapping) + alert_repair_attempts (audit).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("StateStore.alert_threads (FLY-368)", () => {
	let store: StateStore;

	const base = {
		correlationKey: "flywheel|tadashi|pane_hash_stuck|",
		eventId: "evt-1",
		episodeSignature: "sig-1",
		threadId: "thread-1",
		rootMessageId: "msg-1",
		channelId: "chan-1",
		leadId: "tadashi",
		projectName: "flywheel",
		eventType: "pane_hash_stuck",
	};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("opens and reads back an active alert thread", () => {
		store.openAlertThread(base);
		const row = store.getActiveAlertThread(base.correlationKey);
		expect(row).toBeDefined();
		expect(row?.thread_id).toBe("thread-1");
		expect(row?.event_id).toBe("evt-1");
		expect(row?.resolved_at).toBeNull();
	});

	it("returns undefined for an unknown correlation key", () => {
		expect(store.getActiveAlertThread("nope")).toBeUndefined();
	});

	it("lists only active (unresolved) threads", () => {
		store.openAlertThread(base);
		store.openAlertThread({
			...base,
			correlationKey: "flywheel|rafiki|rate_limit|",
			eventId: "evt-2",
			threadId: "thread-2",
			leadId: "rafiki",
			eventType: "rate_limit",
		});
		expect(store.listActiveAlertThreads()).toHaveLength(2);
		store.resolveAlertThread(base.correlationKey);
		const active = store.listActiveAlertThreads();
		expect(active).toHaveLength(1);
		expect(active[0]?.lead_id).toBe("rafiki");
	});

	it("resolve makes the row no longer active", () => {
		store.openAlertThread(base);
		store.resolveAlertThread(base.correlationKey);
		expect(store.getActiveAlertThread(base.correlationKey)).toBeUndefined();
	});

	it("stale replacement: a new event_id under same correlation_key UPSERTs and re-activates", () => {
		store.openAlertThread(base);
		// Caller resolves the prior (stale) thread, then opens the new episode.
		store.resolveAlertThread(base.correlationKey);
		store.openAlertThread({
			...base,
			eventId: "evt-NEW",
			episodeSignature: "sig-NEW",
			threadId: "thread-NEW",
			rootMessageId: "msg-NEW",
		});
		const row = store.getActiveAlertThread(base.correlationKey);
		expect(row).toBeDefined();
		expect(row?.event_id).toBe("evt-NEW");
		expect(row?.thread_id).toBe("thread-NEW");
		expect(row?.resolved_at).toBeNull();
		// active-mapping only: exactly one row for the correlation key
		expect(
			store
				.listActiveAlertThreads()
				.filter((r) => r.correlation_key === base.correlationKey),
		).toHaveLength(1);
	});

	it("setAlertRepairStatus updates the active row", () => {
		store.openAlertThread(base);
		store.setAlertRepairStatus(base.correlationKey, "needs_human");
		expect(store.getActiveAlertThread(base.correlationKey)?.repair_status).toBe(
			"needs_human",
		);
	});

	it("survives a reopen (persistence simulated by a fresh read)", () => {
		store.openAlertThread(base);
		// listActiveAlertThreads is what the reconcile pass uses after a restart
		// (the row is durable; a fresh Hub with empty memory still finds it).
		const active = store.listActiveAlertThreads();
		expect(active).toHaveLength(1);
		expect(active[0]?.correlation_key).toBe(base.correlationKey);
	});
});

describe("StateStore.alert_repair_attempts (FLY-368)", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	it("records an attempt and returns true on success", () => {
		const ok = store.recordAlertRepairAttempt({
			correlationKey: "flywheel|tadashi|pane_hash_stuck|",
			eventId: "evt-1",
			actor: "auto-repair-bot",
			action: "lead_resume_enter",
			leadId: "tadashi",
			projectName: "flywheel",
			result: "attempt",
			reason: "sending Enter to resume menu",
		});
		expect(ok).toBe(true);
	});
});

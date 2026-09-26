import { afterEach, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createVoiceCapabilityEventPump } from "../voice-capability-events.js";

const stores: StateStore[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
});
it("recovers unknown writes, retries the same durable notification, and reminds once after thirty minutes", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const owner = {
		projectName: "flywheel",
		leadId: "eng",
		targetKey: "flywheel:linear:fly-2886",
		actor: "voice" as const,
		activationId: "voice:session",
		requestId: "10000000-0000-4000-8000-000000000001",
		now: 1_000,
		deadline: 2_000,
	};
	const lock = store.acquireCapabilityTargetLock(owner);
	if (lock.status !== "acquired") throw new Error("fixture");
	store.markCapabilityTargetLockDispatched({
		...owner,
		fence: lock.fence,
		now: 1_100,
	});
	let now = 3_000;
	const deliver = vi
		.fn()
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue({ delivered: true });
	const pump = createVoiceCapabilityEventPump({
		store,
		now: () => now,
		deliver,
	});
	await pump.tick();
	expect(store.getCapabilityTargetLock(owner.targetKey)?.state).toBe("unknown");
	expect(store.listPendingVoiceCapabilityEvents()).toHaveLength(1);
	const eventId = deliver.mock.calls[0]![0].eventId;
	expect(deliver.mock.calls[0]![0].event.summary).toContain(owner.requestId);
	await pump.tick();
	expect(deliver.mock.calls[1]![0].eventId).toBe(eventId);
	expect(store.listPendingVoiceCapabilityEvents()).toHaveLength(0);
	now = 1_801_001;
	await pump.tick();
	await pump.tick();
	expect(deliver).toHaveBeenCalledTimes(3);
	expect(deliver.mock.calls[2]![0].eventId).not.toBe(eventId);
	expect(store.getCapabilityTargetLock(owner.targetKey)?.state).toBe("unknown");
});
it("atomically journals voice action outcomes and requires an explicit risk acknowledgment to force clear", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const owner = {
		projectName: "flywheel",
		leadId: "eng",
		targetKey: "flywheel:linear:fly-2886",
		actor: "voice" as const,
		activationId: "voice:session",
		requestId: "10000000-0000-4000-8000-000000000001",
		now: 1_000,
		deadline: 2_000,
	};
	const lock = store.acquireCapabilityTargetLock(owner);
	if (lock.status !== "acquired") throw new Error("fixture");
	const binding = { ...owner, fence: lock.fence };
	store.markCapabilityTargetLockDispatched({ ...binding, now: 1_100 });
	store.releaseCapabilityTargetLock({
		...binding,
		outcome: "unknown",
		operationId: "linear.issue.update",
		reason: "operation_timeout",
	});
	expect(store.listPendingVoiceCapabilityEvents()).toHaveLength(1);
	const force = {
		targetKey: owner.targetKey,
		projectName: owner.projectName,
		leadId: owner.leadId,
		requestId: owner.requestId,
		fence: lock.fence,
		actorActivation: "resident:1",
		riskAcknowledgement: "可能被旧请求覆盖",
		now: 4_000,
	};
	expect(() =>
		store.forceClearCapabilityTargetLock({
			...force,
			riskAcknowledgement: "checked old value",
		}),
	).toThrow();
	expect(store.getCapabilityTargetLock(owner.targetKey)).toBeDefined();
	expect(store.forceClearCapabilityTargetLock(force)).toBe("released");
	const audit = store.getLeadEventByLeadAndId(
		"eng",
		`voice-target-force-clear:${lock.fence}`,
	);
	expect(audit?.payload).toContain("可能被旧请求覆盖");
	expect(audit?.payload).toContain(owner.requestId);
	expect(store.getCapabilityTargetLock(owner.targetKey)).toBeUndefined();
});

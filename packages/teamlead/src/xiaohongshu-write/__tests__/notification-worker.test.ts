import { afterEach, expect, it } from "vitest";
import { XhsNotificationWorker } from "../notification-worker.js";
import { fixture, NOW } from "./store-fixture.js";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.close();
});
function setup() {
	const f = fixture();
	fixtures.push(f);
	return f;
}
it("retries only notification delivery after failure and restart", async () => {
	const f = setup();
	f.approve();
	let calls = 0;
	const transport = {
		async notify(_eventId: string, content: string) {
			calls++;
			expect(content).toContain("已批准");
			if (calls === 1) throw Error("429");
		},
	};
	await new XhsNotificationWorker(f.store, transport, () => NOW + 3000).poll();
	expect(f.store.pendingFounderNotifications()[0]?.attemptCount).toBe(1);
	f.restart();
	await new XhsNotificationWorker(f.store, transport, () => NOW + 4000).poll();
	expect(f.store.pendingFounderNotifications()).toEqual([]);
	expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
		"approved",
	);
	expect(f.store.claim(f.request, NOW + 5000).kind).toBe("claimed");
});
it("expires before selecting notifications and sends no obsolete approval", async () => {
	const f = setup();
	f.approve();
	const messages: string[] = [];
	await new XhsNotificationWorker(
		f.store,
		{
			async notify(_id, content) {
				messages.push(content);
			},
		},
		() => f.decision.expiresAt,
	).poll();
	expect(messages).toHaveLength(1);
	expect(messages[0]).toContain("已过期，未发送，需要新卡");
	expect(f.store.claim(f.request, f.decision.expiresAt).kind).toBe("denied");
});
it("does not overlap polls or resend delivered notices", async () => {
	const f = setup();
	f.approve();
	let release!: () => void;
	const wait = new Promise<void>((r) => {
		release = r;
	});
	let calls = 0;
	const worker = new XhsNotificationWorker(
		f.store,
		{
			async notify() {
				calls++;
				await wait;
			},
		},
		() => NOW + 3000,
	);
	const first = worker.poll();
	await worker.poll();
	expect(calls).toBe(1);
	release();
	await first;
	await worker.poll();
	expect(calls).toBe(1);
});
it("records one revocation notice and cannot send a stale delay afterward", async () => {
	const f = setup();
	f.approve();
	f.store.flagDelayedNotifications(NOW + 62000);
	const message = {
		messageId: "revoke-a",
		messageDigest: "f".repeat(64),
		observedAt: NOW + 63000,
	};
	f.store.recordFounderRevocation(f.frozen.proposalId, message, () => {});
	f.store.recordFounderRevocation(f.frozen.proposalId, message, () => {});
	const messages: string[] = [];
	await new XhsNotificationWorker(
		f.store,
		{
			async notify(_id, content) {
				messages.push(content);
			},
		},
		() => NOW + 64000,
	).poll();
	expect(messages).toHaveLength(1);
	expect(messages[0]).toContain("已撤回，未发送");
});
it("stops starting notifications after shutdown but records the in-flight delivery", async () => {
	const f = setup();
	f.approve();
	f.store.flagDelayedNotifications(NOW + 62000);
	const controller = new AbortController();
	let sent = 0;
	await new XhsNotificationWorker(
		f.store,
		{
			async notify() {
				sent++;
				controller.abort();
			},
		},
		() => NOW + 63000,
	).poll(controller.signal);
	expect(sent).toBe(1);
	expect(f.store.pendingFounderNotifications()).toMatchObject([
		{ eventKind: "delivery_delayed" },
	]);
});

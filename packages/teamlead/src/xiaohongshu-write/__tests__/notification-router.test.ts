import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { contentDigest } from "../canonical.js";
import { createFounderNotificationRouter } from "../notification-router.js";
import { XhsNotificationWorker } from "../notification-worker.js";
import { fixture, NOW } from "./store-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanups.splice(0)) close();
});
function setup() {
	const f = fixture();
	cleanups.push(() => f.close());
	const registry = [0, 1].map((n) => ({
		projectId: `project-${n}`,
		leadId: `lead-${n}`,
		guildId: "100000000000000001",
		channelId: `20000000000000000${n}`,
	}));
	for (const entry of registry) {
		const frozen = {
			...f.frozen,
			proposalId: randomUUID(),
			projectId: entry.projectId,
			leadId: entry.leadId,
		};
		f.store.prepare(
			{ frozen, prepareRequestId: randomUUID(), expiresAt: NOW + 600000 },
			NOW,
		);
		const cardId = "300000000000000001";
		f.store.delivered(
			frozen.proposalId,
			{
				previewDigest: "d".repeat(64),
				manifestJson: "{}",
				cardId,
				challenge: "ABCDEFGH",
				guildId: entry.guildId,
				channelId: entry.channelId,
			},
			NOW,
		);
		f.store.recordDecision({
			...f.decision,
			receiptId: randomUUID(),
			proposalId: frozen.proposalId,
			contentDigest: contentDigest(frozen),
			founderMessageId: randomUUID(),
			guildId: entry.guildId,
			channelId: entry.channelId,
			cardId,
		});
	}
	const sent: { channel: string; eventId: string }[] = [];
	const source = (channel: string) => ({
		async notify(eventId: string) {
			sent.push({ channel, eventId });
		},
	});
	return { f, registry, source, sent };
}
it("routes two projects from the real notification ledger to their own frozen card channels", async () => {
	const s = setup();
	const expected = s.f.store.pendingFounderNotifications();
	const router = createFounderNotificationRouter({
		store: s.f.store,
		registry: s.registry,
		source: s.source,
	});
	await new XhsNotificationWorker(s.f.store, router, () => NOW + 3000).poll();
	expect(s.sent).toEqual(
		expected.map((notice) => ({
			eventId: notice.eventId,
			channel: s.registry.find((e) => e.projectId === notice.projectId)!
				.channelId,
		})),
	);
	expect(s.f.store.pendingFounderNotifications()).toEqual([]);
});
it("does not redirect an old card when root registry destination changes and still serves other scopes", async () => {
	const s = setup();
	s.registry[0]!.channelId = "200000000000000009";
	const router = createFounderNotificationRouter({
		store: s.f.store,
		registry: s.registry,
		source: s.source,
	});
	await new XhsNotificationWorker(s.f.store, router, () => NOW + 3000).poll();
	expect(s.sent.map((s) => s.channel)).toEqual([s.registry[1]!.channelId]);
	expect(s.f.store.pendingFounderNotifications()).toMatchObject([
		{ projectId: "project-0", attemptCount: 1 },
	]);
	await expect(router.notify("forged-event", "fake")).rejects.toThrow(
		"notification_route_unavailable",
	);
});
it("rejects duplicate scope registry and snapshots routing input", async () => {
	const s = setup();
	expect(() =>
		createFounderNotificationRouter({
			store: s.f.store,
			registry: [...s.registry, s.registry[0]!],
			source: s.source,
		}),
	).toThrow("notification_route_unavailable");
	const router = createFounderNotificationRouter({
		store: s.f.store,
		registry: s.registry,
		source: s.source,
	});
	const channel = s.registry[0]!.channelId;
	s.registry[0]!.channelId = "200000000000000009";
	await new XhsNotificationWorker(s.f.store, router, () => NOW + 3000).poll();
	expect(s.sent[0]!.channel).toBe(channel);
});

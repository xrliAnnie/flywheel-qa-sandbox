import { afterEach, expect, it } from "vitest";
import { createChannelFounderObserver } from "../channel-observer.js";
import { fixture, NOW } from "./store-fixture.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
});
const channelId = "100000000000000001",
	initialCursor = "200000000000000001",
	messageId = "200000000000000002";
function setup() {
	const f = fixture();
	cleanup.push(() => f.close());
	const policies = [0, 1].map((n) => ({
		...f.identity,
		projectId: `project-${n}`,
		leadId: `lead-${n}`,
		founderId: "300000000000000001",
		canonicalFounderId: "300000000000000001",
		botId: "300000000000000002",
		guildId: "400000000000000001",
		channelId,
	}));
	const state = { calls: 0, failAt: 0, pages: 0 };
	const source = {
		async listMessageIdsBefore() {
			state.pages++;
			return [messageId];
		},
		async fetchMessage() {
			state.calls++;
			if (state.calls === state.failAt) throw Error("transient");
			return {
				id: messageId,
				channel_id: channelId,
				type: 0,
				author: { id: policies[0]!.founderId },
			};
		},
		async channelGuild() {
			return policies[0]!.guildId;
		},
		async readAttachment() {
			return Buffer.alloc(0);
		},
	};
	const create = () =>
		createChannelFounderObserver({
			store: f.store,
			source,
			scopes: policies.map((p) => ({ policy: () => p, initialCursor })),
			now: () => NOW,
		});
	return { f, policies, state, source, create };
}
it("processes every scope before advancing the one durable channel cursor", async () => {
	const s = setup();
	await s.create().poll();
	expect(s.state).toMatchObject({ calls: 2, pages: 1 });
	expect(s.f.store.observerState(channelId, initialCursor).cursor).toBe(
		messageId,
	);
});
it("keeps the cursor before a partially handled message and retries all scopes after restart", async () => {
	const s = setup();
	s.state.failAt = 2;
	await expect(s.create().poll()).rejects.toThrow("founder_source_unavailable");
	expect(s.f.store.observerState(channelId, initialCursor).cursor).toBe(
		initialCursor,
	);
	s.f.restart();
	s.state.failAt = 0;
	await s.create().poll();
	expect(s.state).toMatchObject({ calls: 4, pages: 1 });
	expect(s.f.store.observerState(channelId, initialCursor).cursor).toBe(
		messageId,
	);
});
it("rejects mixed channels and duplicate scopes, and never advances under changed policy", async () => {
	const s = setup();
	const observer = s.create();
	s.policies[1]!.channelId = "100000000000000009";
	expect(s.create).toThrow("observer_scope_invalid");
	await expect(observer.poll()).rejects.toThrow("founder_policy_changed");
	expect(s.f.store.observerState(channelId, initialCursor).cursor).toBe(
		initialCursor,
	);
	s.policies[1] = { ...s.policies[0]! };
	expect(s.create).toThrow("observer_scope_invalid");
});
it("uses the oldest channel seed but respects each scope's own initial cursor", async () => {
	const s = setup();
	const observer = createChannelFounderObserver({
		store: s.f.store,
		source: s.source,
		scopes: s.policies.map((p, n) => ({
			policy: () => p,
			initialCursor: n === 0 ? initialCursor : messageId,
		})),
		now: () => NOW,
	});
	await observer.poll();
	expect(s.state.calls).toBe(1);
	expect(s.f.store.observerState(channelId, initialCursor).cursor).toBe(
		messageId,
	);
});
it("does not advance a message when shutdown begins between scopes", async () => {
	const s = setup();
	const controller = new AbortController();
	const fetchMessage = s.source.fetchMessage;
	s.source.fetchMessage = async () => {
		const message = await fetchMessage();
		controller.abort();
		return message;
	};
	const observer = createChannelFounderObserver({
		store: s.f.store,
		source: s.source,
		scopes: s.policies.map((p) => ({ policy: () => p, initialCursor })),
		signal: controller.signal,
	});
	await expect(observer.poll()).rejects.toThrow("observer_stopped");
	expect(s.state.calls).toBe(1);
	expect(s.f.store.observerState(channelId, initialCursor).cursor).toBe(
		initialCursor,
	);
});

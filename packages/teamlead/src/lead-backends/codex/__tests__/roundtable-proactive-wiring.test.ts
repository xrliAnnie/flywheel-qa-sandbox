import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildReplyInThreadWiring } from "../roundtable-reply-in-thread-wiring.js";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const receipt = {
	socketOwnerId: "owner",
	parentChannelId: "99999999999999999",
	messageId: "11111111111111111",
	eventId: "event:out",
	payloadHash: "a".repeat(64),
};
function setup(root: string, pending = false) {
	const source = {
		addChannel: vi.fn(async () => {}),
		removeChannel: () => {},
		isSubscribed: () => false,
		proactiveCursor: () => "11111111111111113",
		catchUpProactiveChannel: vi.fn(async (_id, opts) => {
			opts.assertCurrentOwner();
			opts.saveProgress("11111111111111112");
			return pending ? ("pending" as const) : ("ready" as const);
		}),
	};
	const fetchImpl = vi.fn(
		async () =>
			({
				ok: true,
				status: 200,
				json: async () => ({
					id: receipt.messageId,
					type: 11,
					parent_id: receipt.parentChannelId,
					default_auto_archive_duration: 1440,
				}),
			}) as Response,
	);
	const wiring = buildReplyInThreadWiring({
		cfg: {
			enabled: true,
			parentChannelId: receipt.parentChannelId,
			autoContinue: true,
			budgetN: 2,
		},
		stateDir: root,
		botToken: "tok",
		botUserId: "self",
		crossDeptChannelIds: [],
		source,
		fetchImpl,
	})!;
	return { wiring, source, fetchImpl };
}
it("freezes receipt and seed before catchup and resumes the persisted cursor after restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "rt-proactive-"));
	roots.push(root);
	const a = setup(root, true);
	await a.wiring.restoreState();
	expect(await a.wiring.onProactiveTopicEngaged(receipt, () => {})).toBe(
		"pending",
	);
	expect(a.source.addChannel).not.toHaveBeenCalled();
	const first = a.wiring.registry.entries()[0];
	expect(first.continuation?.remaining).toBe(2);
	expect(first.proactive).toMatchObject({
		eventId: receipt.eventId,
		after: "11111111111111112",
		through: "11111111111111113",
		engagement: "pending",
	});
	a.wiring.budgetStore.admit!({
		threadId: receipt.messageId,
		sourceMessageId: "22222222222222222",
		authorBot: true,
	});
	const b = setup(root);
	await b.wiring.restoreState();
	expect(await b.wiring.onProactiveTopicEngaged(receipt, () => {})).toBe(
		"ready",
	);
	expect(b.source.catchUpProactiveChannel.mock.calls[0][1].after).toBe(
		"11111111111111112",
	);
	expect(b.wiring.registry.entries()[0].continuation?.remaining).toBe(1);
	await expect(
		b.wiring.onProactiveTopicEngaged(
			{ ...receipt, payloadHash: "b".repeat(64) },
			() => {},
		),
	).rejects.toThrow(/binding/);
});

it("does not recreate a retired subscription or reseed its budget when the same receipt is replayed", async () => {
	const root = mkdtempSync(join(tmpdir(), "rt-proactive-retired-"));
	roots.push(root);
	const a = setup(root);
	await a.wiring.restoreState();
	await a.wiring.onProactiveTopicEngaged(receipt, () => {});
	await a.wiring.unsubscribeThread(receipt.messageId, "operator", "cli");
	const b = setup(root);
	await b.wiring.restoreState();
	await expect(
		b.wiring.onProactiveTopicEngaged(receipt, () => {}),
	).rejects.toThrow(/retired/);
	expect(b.source.catchUpProactiveChannel).not.toHaveBeenCalled();
});

import { InMemoryInboundCursorStore } from "../InboundCursorStore.js";
import { buildMentionGate } from "../mention-gate.js";
import { RestPollDiscordInboundSource } from "../RestPollDiscordInboundSource.js";

it("connects real REST catchup to durable budget before accepting an early unmentioned reply", async () => {
	const root = mkdtempSync(join(tmpdir(), "rt-proactive-real-"));
	roots.push(root);
	const reply = "11111111111111112";
	const fetchImpl = vi.fn(async (url) => {
		const u = new URL(String(url));
		const json = u.pathname.endsWith("/messages")
			? u.searchParams.get("after") === receipt.messageId
				? [
						{
							id: reply,
							channel_id: receipt.messageId,
							author: { id: "sibling", bot: true },
							content: "early answer",
						},
					]
				: []
			: {
					id: receipt.messageId,
					parent_id: receipt.parentChannelId,
					type: 11,
					default_auto_archive_duration: 1440,
				};
		return { ok: true, status: 200, json: async () => json } as Response;
	});
	const source = new RestPollDiscordInboundSource({
		botToken: "tok",
		channelIds: [],
		cursorStore: new InMemoryInboundCursorStore(),
		fetchImpl,
	});
	const wiring = buildReplyInThreadWiring({
		cfg: {
			enabled: true,
			parentChannelId: receipt.parentChannelId,
			autoContinue: true,
			budgetN: 2,
		},
		stateDir: root,
		botToken: "tok",
		botUserId: "self",
		crossDeptChannelIds: [],
		source,
		fetchImpl,
	})!;
	const gate = buildMentionGate({
		botUserId: "self",
		sharedChannelIds: [],
		dynamicSharedChannels: wiring.registry,
		autoContinue: true,
		budgetN: 2,
		budgetStore: wiring.budgetStore,
	});
	const delivered: string[] = [];
	source.onMessage((m) => {
		if (gate(m)) delivered.push(m.id);
		return true;
	});
	await wiring.restoreState();
	expect(await wiring.onProactiveTopicEngaged(receipt, () => {})).toBe("ready");
	expect(delivered).toEqual([reply]);
	expect(wiring.registry.entries()[0].continuation).toEqual({
		remaining: 1,
		admissions: { [reply]: true },
	});
	expect(source.isSubscribed(receipt.messageId)).toBe(true);
});

it("does not resurrect a subscription cancelled while thread ensure is awaited", async () => {
	const root = mkdtempSync(join(tmpdir(), "rt-proactive-cancel-"));
	roots.push(root);
	const a = setup(root);
	await a.wiring.restoreState();
	await a.wiring.onProactiveTopicEngaged(receipt, () => {});
	let entered!: () => void, resume!: () => void;
	const started = new Promise<void>((r) => {
			entered = r;
		}),
		deferred = new Promise<void>((r) => {
			resume = r;
		});
	a.fetchImpl.mockImplementationOnce(async () => {
		entered();
		await deferred;
		return {
			ok: true,
			status: 200,
			json: async () => ({
				id: receipt.messageId,
				type: 11,
				parent_id: receipt.parentChannelId,
			}),
		} as Response;
	});
	const pending = expect(
		a.wiring.onProactiveTopicEngaged(receipt, () => {}),
	).rejects.toThrow(/retired/);
	await started;
	await a.wiring.unsubscribeThread(receipt.messageId, "operator", "cli");
	resume();
	await pending;
	expect(a.wiring.registry.has(receipt.messageId)).toBe(false);
});

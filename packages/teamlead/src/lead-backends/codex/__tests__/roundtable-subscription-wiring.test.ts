import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReplyInThreadWiring } from "../roundtable-reply-in-thread-wiring.js";
import {
	ledgerPath,
	persistSnapshot,
} from "../roundtable-subscription-ledger.js";

const RT = "99999999999999999",
	T = "11111111111111111",
	B = "22222222222222222";
const dirs: string[] = [];
const route = (id = T, parentChannelId = RT) => ({
	kind: "roundtable_thread_from_message" as const,
	threadId: id,
	sourceMessageId: id,
	parentChannelId,
});
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function make(
	over: Partial<Parameters<typeof buildReplyInThreadWiring>[0]> = {},
) {
	const d = mkdtempSync(join(tmpdir(), "rt-wiring-"));
	dirs.push(d);
	let now = 1000;
	let timer = () => {};
	const slots = new Set<string>();
	const source = {
		addChannel: vi.fn(async (id: string) => {
			slots.add(id);
		}),
		removeChannel: vi.fn((id: string) => {
			slots.delete(id);
		}),
		isSubscribed: (id: string) => slots.has(id),
	};
	const wiring = buildReplyInThreadWiring({
		cfg: { enabled: true, parentChannelId: RT, subscriptionTtlMs: 100, cap: 1 },
		stateDir: d,
		botToken: "tok",
		botUserId: "bot",
		crossDeptChannelIds: [RT],
		source,
		now: () => now,
		setTimer: (fn) => {
			timer = fn;
			return { cancel: () => {} };
		},
		...over,
	})!;
	return {
		d,
		wiring,
		source,
		advance: (n: number) => {
			now = n;
		},
		sweep: () => timer(),
	};
}
describe("durable accepted subscription wiring", () => {
	it("route computation cannot subscribe; accepted engagement persists, domain rejects, TTL sweeps", async () => {
		const m = make();
		await m.wiring.restoreState();
		await m.wiring.activateSource();
		m.wiring.resolveReplyRoute({
			id: T,
			channelId: RT,
			authorId: "u",
			authorBot: false,
			content: "topic",
		});
		expect(m.wiring.registry.size).toBe(0);
		expect(m.source.addChannel).not.toHaveBeenCalled();
		await m.wiring.onTopicEngaged(route());
		expect(m.wiring.registry.has(T)).toBe(true);
		expect(
			JSON.parse(readFileSync(ledgerPath(m.d), "utf8")).entries,
		).toHaveLength(1);
		await m.wiring.onTopicEngaged(route(B, "88888888888888888"));
		expect(m.wiring.registry.has(B)).toBe(false);
		m.advance(1100);
		expect(m.wiring.registry.has(T)).toBe(false);
		m.sweep();
		await Promise.resolve();
		expect(m.source.removeChannel).toHaveBeenCalledWith(T);
		expect(m.wiring.registry.entries()).toHaveLength(0);
		await m.wiring.stop();
	});
	it("persist failure leaves memory and polling unchanged; existing-ledger restore fails before traffic", async () => {
		let fail = false;
		const persist = vi.fn(
			(p: string, s: Parameters<typeof persistSnapshot>[1]) => {
				if (fail) throw Error("disk full");
				persistSnapshot(p, s);
			},
		);
		const m = make({ persistSnapshot: persist });
		await m.wiring.restoreState();
		await m.wiring.onTopicEngaged(route());
		fail = true;
		await m.wiring.onTopicEngaged(route(B));
		expect(m.wiring.registry.list()).toEqual([T]);
		expect(m.source.addChannel).toHaveBeenCalledTimes(1);
		const restart = make({ stateDir: m.d, persistSnapshot: persist });
		await expect(restart.wiring.restoreState()).rejects.toThrow("disk full");
		expect(restart.source.addChannel).not.toHaveBeenCalled();
		fail = false;
		await restart.wiring.restoreState();
		await restart.wiring.activateSource();
		expect(restart.wiring.registry.has(T)).toBe(true);
		await restart.wiring.stop();
	});
	it("touch persists only active entries and unsubscribe cannot resurrect through restart", async () => {
		const m = make();
		await m.wiring.restoreState();
		await m.wiring.onTopicEngaged(route());
		m.advance(1050);
		m.wiring.onInputAccepted({ replyChannelId: T });
		m.advance(1100);
		expect(m.wiring.registry.has(T)).toBe(true);
		expect(await m.wiring.unsubscribeThread(T, "operator", "cli")).toBe(true);
		const restart = make({ stateDir: m.d });
		await restart.wiring.restoreState();
		await restart.wiring.activateSource();
		expect(restart.wiring.registry.has(T)).toBe(false);
		await restart.wiring.stop();
	});
});

it("cap add+evict is one durable write; crash after ledger before source restores the addition", async () => {
	const writes: unknown[] = [];
	const persist = (p: string, s: Parameters<typeof persistSnapshot>[1]) => {
		writes.push(structuredClone(s));
		persistSnapshot(p, s);
	};
	const m = make({ persistSnapshot: persist });
	await m.wiring.restoreState();
	await m.wiring.onTopicEngaged(route());
	const before = writes.length;
	m.source.addChannel.mockRejectedValueOnce(Error("source offline"));
	await m.wiring.onTopicEngaged(route(B));
	expect(writes.length - before).toBe(1);
	expect(m.wiring.registry.list()).toEqual([B]);
	expect(m.source.removeChannel).toHaveBeenCalledWith(T);
	const restart = make({ stateDir: m.d });
	await restart.wiring.restoreState();
	await restart.wiring.activateSource();
	expect(restart.source.addChannel).toHaveBeenCalledWith(B);
	await restart.wiring.stop();
});

it("restore normalizes wrong domain, expired, duplicates, cap before source activation", async () => {
	const m = make();
	const e = (
		threadId: string,
		subscribedAt: number,
		parentChannelId = RT,
		expiresAt = 2000,
	) => ({
		threadId,
		parentChannelId,
		source: "mention" as const,
		subscribedAt: new Date(subscribedAt).toISOString(),
		lastActivityAt: new Date(subscribedAt).toISOString(),
		expiresAt: new Date(expiresAt).toISOString(),
	});
	persistSnapshot(ledgerPath(m.d), {
		version: 1,
		entries: [
			e(T, 1),
			e(T, 2),
			e(B, 3),
			e("33333333333333333", 4, "88888888888888888"),
			e("44444444444444444", 5, RT, 999),
		],
	});
	await m.wiring.restoreState();
	expect(
		JSON.parse(readFileSync(ledgerPath(m.d), "utf8")).entries.map(
			(entry: { threadId: string }) => entry.threadId,
		),
	).toEqual([B]);
	await m.wiring.activateSource();
	expect(m.source.addChannel.mock.calls).toEqual([[B]]);
	await m.wiring.stop();
});

it("ignores abandoned temp and existing quarantine files, quarantines corruption without overwriting", async () => {
	const m = make();
	const path = ledgerPath(m.d);
	writeFileSync(`${path}.abandoned.tmp`, "partial");
	writeFileSync(`${path}.corrupt.previous`, "old evidence");
	writeFileSync(path, "broken");
	await m.wiring.restoreState();
	await m.wiring.activateSource();
	expect(m.wiring.registry.size).toBe(0);
	expect(readFileSync(`${path}.corrupt.previous`, "utf8")).toBe("old evidence");
	expect(
		readdirSync(m.d).filter((name) => name.includes(".corrupt.")),
	).toHaveLength(2);
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
		version: 1,
		entries: [],
	});
	await m.wiring.stop();
});

import { CodexDiscordGateway } from "../CodexDiscordGateway.js";
import { LeadInputRouter } from "../LeadInputRouter.js";
import { InMemoryJournalStore, LeadJournal } from "../LeadJournal.js";

it("gateway retry, journal error and expired duplicate cannot mint or resurrect; a fresh accepted mention can", async () => {
	const m = make();
	await m.wiring.restoreState();
	const journal = new LeadJournal({ store: new InMemoryJournalStore() });
	const router = new LeadInputRouter({
		leadId: "lead",
		threadId: "thread",
		journal,
		onTopicEngaged: m.wiring.onTopicEngaged,
		onInputAccepted: m.wiring.onInputAccepted,
		executor: {
			startTurn: async () => "turn",
			awaitCompletion: async () => ({ output: "reply" }),
			reconcile: async () => null,
		},
		sender: { enqueue: async () => "out", deliver: async () => {} },
	});
	let accept: "legacy" | "retry" = "retry";
	const source = {
		assertAuthenticatedBotUser: async () => {},
		onMessage: () => {},
		start: async () => {},
		stop: async () => {},
	};
	const gateway = new CodexDiscordGateway({
		source,
		router,
		botUserId: "bot",
		channelIds: [RT],
		resolveReplyRoute: m.wiring.resolveReplyRoute,
		registry: m.wiring.registry,
		durableAccept: () => accept,
		logger: { warn: () => {} },
	});
	const message = {
		id: T,
		channelId: RT,
		authorId: "user",
		authorBot: false,
		content: "<@bot> topic",
		mentions: ["bot"],
	};
	expect(gateway.handle(message)).toBe(false);
	expect(m.wiring.registry.size).toBe(0);
	accept = "legacy";
	const original = journal.accept.bind(journal);
	const mock = vi.spyOn(journal, "accept").mockImplementation(() => {
		throw Error("disk full");
	});
	expect(gateway.handle(message)).toBe(false);
	expect(m.wiring.registry.size).toBe(0);
	mock.mockImplementation(original);
	expect(gateway.handle(message)).toBe(true);
	expect(m.wiring.registry.has(T)).toBe(true);
	await router.whenIdle();
	m.advance(1200);
	expect(m.wiring.registry.has(T)).toBe(false);
	expect(gateway.handle(message)).toBe(true);
	expect(m.wiring.registry.has(T)).toBe(false);
	expect(gateway.handle({ ...message, id: B })).toBe(true);
	expect(m.wiring.registry.has(B)).toBe(true);
	await router.whenIdle();
});

it("unsubscribe during restored source drain cannot re-add a later restored slot", async () => {
	const m = make({
		cfg: {
			enabled: true,
			parentChannelId: RT,
			cap: 5,
			subscriptionTtlMs: 1000,
		},
	});
	await m.wiring.restoreState();
	await m.wiring.onTopicEngaged(route());
	m.advance(1001);
	await m.wiring.onTopicEngaged(route(B));
	const restart = make({
		stateDir: m.d,
		cfg: {
			enabled: true,
			parentChannelId: RT,
			cap: 5,
			subscriptionTtlMs: 1000,
		},
	});
	restart.source.addChannel.mockImplementation(async (id) => {
		if (id === T)
			await restart.wiring.unsubscribeThread(B, "during drain", "cli");
	});
	await restart.wiring.restoreState();
	await restart.wiring.activateSource();
	expect(restart.source.addChannel.mock.calls).toEqual([[T]]);
	expect(restart.wiring.registry.has(B)).toBe(false);
	await restart.wiring.stop();
});

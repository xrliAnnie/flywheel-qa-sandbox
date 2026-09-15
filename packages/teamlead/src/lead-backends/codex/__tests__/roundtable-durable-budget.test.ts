import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexDiscordGateway } from "../CodexDiscordGateway.js";
import { buildMentionGate } from "../mention-gate.js";
import { buildReplyInThreadWiring } from "../roundtable-reply-in-thread-wiring.js";
import {
	ledgerPath,
	persistSnapshot,
} from "../roundtable-subscription-ledger.js";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const parent = "99999999999999999",
	thread = "11111111111111111";
const route = {
	kind: "roundtable_thread_from_message" as const,
	parentChannelId: parent,
	threadId: thread,
	sourceMessageId: thread,
};
function setup(root: string, persist = persistSnapshot) {
	const wiring = buildReplyInThreadWiring({
		cfg: {
			enabled: true,
			parentChannelId: parent,
			autoContinue: true,
			budgetN: 2,
		},
		stateDir: root,
		botToken: "test",
		botUserId: "self",
		crossDeptChannelIds: [parent],
		source: {
			addChannel: async () => {},
			removeChannel: () => {},
			isSubscribed: () => true,
		},
		persistSnapshot: persist,
	})!;
	const gate = buildMentionGate({
		botUserId: "self",
		sharedChannelIds: [parent],
		dynamicSharedChannels: wiring.registry,
		autoContinue: true,
		budgetStore: wiring.budgetStore,
		budgetN: 2,
	});
	return { wiring, gate };
}
const msg = (id: string, authorBot = true) => ({
	id,
	channelId: thread,
	authorId: "other",
	authorBot,
	content: "hello",
});
it("persists admission with the remaining budget, replays without consuming twice, and never reseeds on restart or repeat engagement", async () => {
	const root = mkdtempSync(join(tmpdir(), "rt-budget-"));
	roots.push(root);
	const first = setup(root);
	await first.wiring.restoreState();
	await first.wiring.onTopicEngaged(route);
	expect(first.gate(msg("22222222222222222"))).toBe(true);
	expect(first.gate(msg("22222222222222222"))).toBe(true);
	const restart = setup(root);
	await restart.wiring.restoreState();
	await restart.wiring.onTopicEngaged(route);
	expect(restart.gate(msg("22222222222222222"))).toBe(true);
	expect(restart.gate(msg("33333333333333333"))).toBe(true);
	expect(restart.gate(msg("44444444444444444"))).toBe(false);
	expect(restart.gate(msg("55555555555555555", false))).toBe(true);
	expect(restart.gate(msg("66666666666666666"))).toBe(true);
	expect(restart.gate(msg("55555555555555555", false))).toBe(true);
	expect(restart.gate(msg("77777777777777777"))).toBe(true);
	expect(restart.gate(msg("88888888888888888"))).toBe(false);
});
it("keeps a failed admission retryable without mutating the budget", async () => {
	const root = mkdtempSync(join(tmpdir(), "rt-budget-"));
	roots.push(root);
	let fail = false;
	const m = setup(root, (p, s) => {
		if (fail) throw Error("disk full");
		persistSnapshot(p, s);
	});
	await m.wiring.restoreState();
	await m.wiring.onTopicEngaged(route);
	fail = true;
	expect(() => m.gate(msg("22222222222222222"))).toThrow("disk full");
	fail = false;
	expect(m.gate(msg("22222222222222222"))).toBe(true);
	expect(m.gate(msg("33333333333333333"))).toBe(true);
	expect(m.gate(msg("44444444444444444"))).toBe(false);
});

it("restores legacy subscriptions as exhausted until a new human message", async () => {
	const root = mkdtempSync(join(tmpdir(), "rt-budget-old-"));
	roots.push(root);
	const now = new Date().toISOString();
	persistSnapshot(ledgerPath(root), {
		version: 1,
		entries: [
			{
				threadId: thread,
				parentChannelId: parent,
				source: "mention",
				subscribedAt: now,
				lastActivityAt: now,
				expiresAt: new Date(Date.now() + 86400000).toISOString(),
			},
		],
	});
	const m = setup(root);
	await m.wiring.restoreState();
	await m.wiring.onTopicEngaged(route);
	expect(m.gate(msg("22222222222222222"))).toBe(false);
	expect(m.gate(msg("33333333333333333", false))).toBe(true);
	expect(m.gate(msg("44444444444444444"))).toBe(true);
});
it("gateway leaves the source cursor retryable on admission persistence failure", async () => {
	const root = mkdtempSync(join(tmpdir(), "rt-budget-gateway-"));
	roots.push(root);
	let fail = false;
	const m = setup(root, (p, s) => {
		if (fail) throw Error("disk full");
		persistSnapshot(p, s);
	});
	await m.wiring.restoreState();
	await m.wiring.onTopicEngaged(route);
	const accepted = vi.fn(() => "handled" as const);
	const gateway = new CodexDiscordGateway({
		botUserId: "self",
		channelIds: [parent],
		registry: m.wiring.registry,
		shouldHandle: m.gate,
		durableAccept: accepted,
		router: { submit: vi.fn() } as never,
		source: {
			assertAuthenticatedBotUser: async () => {},
			onMessage: () => {},
			start: async () => {},
			stop: async () => {},
		},
		logger: { warn: () => {} },
	});
	fail = true;
	expect(gateway.handle(msg("22222222222222222"))).toBe(false);
	expect(accepted).not.toHaveBeenCalled();
	fail = false;
	expect(gateway.handle(msg("22222222222222222"))).toBe(true);
	expect(accepted).toHaveBeenCalledOnce();
});

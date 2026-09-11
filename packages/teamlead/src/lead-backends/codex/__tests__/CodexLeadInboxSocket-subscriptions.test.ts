import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	CodexLeadInboxServer,
	listCodexLeadSubscriptions,
	submitCodexLeadInboxBatch,
	unsubscribeCodexLeadThread,
} from "../CodexLeadInboxSocket.js";
import { LeadInputRouter } from "../LeadInputRouter.js";
import { InMemoryJournalStore, LeadJournal } from "../LeadJournal.js";
import { buildReplyInThreadWiring } from "../roundtable-reply-in-thread-wiring.js";
import {
	ledgerPath,
	persistSnapshot,
} from "../roundtable-subscription-ledger.js";

const roots: string[] = [];
const servers: CodexLeadInboxServer[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

it("authenticates subscription list and removal, preserving the actor and reason", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly1942-sub-socket-"));
	roots.push(root);
	const entry = {
		threadId: "12345678901234567",
		parentChannelId: "22345678901234567",
		source: "mention" as const,
		subscribedAt: "2026-09-11T00:00:00.000Z",
		lastActivityAt: "2026-09-11T00:00:00.000Z",
		expiresAt: "2026-09-12T00:00:00.000Z",
	};
	const remove = vi.fn(async () => true);
	const submitBatch = vi.fn(() => {
		throw new Error("subscription operations must not submit model input");
	});
	const args = {
		socketPath: join(root, "inbox.sock"),
		leadId: "lead-a",
		authSecret: "test-secret",
	};
	const server = new CodexLeadInboxServer({
		...args,
		router: { submitBatch },
		subscriptions: { list: () => [entry], remove },
	});
	servers.push(server);
	await server.listen();
	expect(await listCodexLeadSubscriptions(args)).toEqual([entry]);
	await expect(
		unsubscribeCodexLeadThread({
			...args,
			threadId: entry.threadId,
			reason: "operator request",
		}),
	).resolves.toBe(true);
	expect(remove).toHaveBeenCalledWith(
		entry.threadId,
		"operator request",
		"cli",
	);
	await expect(
		listCodexLeadSubscriptions({ ...args, authSecret: "wrong" }),
	).rejects.toThrow(/authentication rejected/);
	await expect(
		unsubscribeCodexLeadThread({
			...args,
			leadId: "lead-b",
			threadId: entry.threadId,
			reason: "wrong lead",
		}),
	).rejects.toThrow(/binding mismatch/);
	await expect(
		unsubscribeCodexLeadThread({
			...args,
			threadId: "invalid",
			reason: "invalid",
		}),
	).rejects.toThrow(/malformed/);
	expect(remove).toHaveBeenCalledTimes(1);
	expect(submitBatch).not.toHaveBeenCalled();
});

it("renews through accepted socket batches only, preserving disk and TTL on duplicate or persist failure", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly1942-touch-socket-"));
	roots.push(root);
	let now = 1000;
	let fail = false;
	const threadId = "11111111111111111";
	const parentChannelId = "99999999999999999";
	const wiring = buildReplyInThreadWiring({
		cfg: { enabled: true, parentChannelId, subscriptionTtlMs: 100 },
		stateDir: root,
		botToken: "test",
		botUserId: "bot",
		crossDeptChannelIds: [parentChannelId],
		source: {
			addChannel: async () => {},
			removeChannel: () => {},
			isSubscribed: () => true,
		},
		now: () => now,
		persistSnapshot: (path, snapshot) => {
			if (fail) throw Error("disk full");
			persistSnapshot(path, snapshot);
		},
	})!;
	await wiring.restoreState();
	await wiring.onTopicEngaged({
		kind: "roundtable_thread_from_message",
		threadId,
		parentChannelId,
		sourceMessageId: threadId,
	});
	const router = new LeadInputRouter({
		leadId: "lead-a",
		threadId: "thread-a",
		journal: new LeadJournal({ store: new InMemoryJournalStore() }),
		executor: {
			startTurn: async () => "turn",
			awaitCompletion: async () => ({ output: "ok" }),
			reconcile: async () => ({ exists: false, completed: false }),
		},
		sender: { enqueue: async () => "out", deliver: async () => {} },
		onInputAccepted: wiring.onInputAccepted,
	});
	const args = {
		socketPath: join(root, "inbox.sock"),
		leadId: "lead-a",
		authSecret: "test-secret",
		ownerEpoch: "epoch",
		protocolVersion: 2 as const,
	};
	const server = new CodexLeadInboxServer({ ...args, router });
	servers.push(server);
	await server.listen();
	const batch = {
		batchId: "batch-1",
		memberIds: ["member-1"],
		payload: "hello",
		replyChannelId: threadId,
	};
	now = 1050;
	expect((await submitCodexLeadInboxBatch({ ...args, batch })).status).toBe(
		"accepted_new",
	);
	await router.whenIdle();
	expect(wiring.registry.entries()[0].expiresAt).toBe(
		new Date(1150).toISOString(),
	);
	const durable = readFileSync(ledgerPath(root), "utf8");
	now = 1075;
	expect((await submitCodexLeadInboxBatch({ ...args, batch })).status).not.toBe(
		"accepted_new",
	);
	expect(readFileSync(ledgerPath(root), "utf8")).toBe(durable);
	expect(wiring.registry.entries()[0].expiresAt).toBe(
		new Date(1150).toISOString(),
	);
	now = 1100;
	fail = true;
	expect(
		(
			await submitCodexLeadInboxBatch({
				...args,
				batch: { ...batch, batchId: "batch-2", memberIds: ["member-2"] },
			})
		).status,
	).toBe("accepted_new");
	await router.whenIdle();
	expect(readFileSync(ledgerPath(root), "utf8")).toBe(durable);
	expect(wiring.registry.entries()[0].expiresAt).toBe(
		new Date(1150).toISOString(),
	);
	await wiring.stop();
});

import { mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CodexLeadInboxServer,
	probeCodexLeadInboxCapabilities,
	submitCodexLeadInboxBatch,
} from "../CodexLeadInboxSocket.js";
import { LeadInputRouter } from "../LeadInputRouter.js";
import { InMemoryJournalStore, LeadJournal } from "../LeadJournal.js";

const servers: CodexLeadInboxServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

function harness(afterCommit?: () => void | Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "fly1373-codex-inbox-"));
	const socketPath = join(dir, "inbox.sock");
	const store = new InMemoryJournalStore();
	const journal = new LeadJournal({ store });
	let turns = 0;
	const router = new LeadInputRouter({
		leadId: "lead-a",
		threadId: "thread-a",
		journal,
		executor: {
			async startTurn() {
				turns++;
				return `turn-${turns}`;
			},
			async awaitCompletion() {
				return { output: "ok" };
			},
			async reconcile() {
				return { exists: false, completed: false };
			},
		},
		sender: {
			async enqueue() {
				return "out-1";
			},
			async deliver() {},
		},
	});
	const server = new CodexLeadInboxServer({
		socketPath,
		leadId: "lead-a",
		router,
		authSecret: "lead-bot-token",
		...(afterCommit ? { afterCommit } : {}),
	});
	servers.push(server);
	return { server, socketPath, router, store, getTurns: () => turns };
}

const batch = {
	batchId: "batch-1",
	memberIds: ["delivery-1", "delivery-2"],
	payload: "one packaged turn",
};

describe("CodexLeadInboxSocket", () => {
	it("binds lead + owner epoch and durably submits exactly one batch turn", async () => {
		const h = harness();
		await h.server.listen();
		const first = await submitCodexLeadInboxBatch({
			socketPath: h.socketPath,
			leadId: "lead-a",
			ownerEpoch: "epoch-1",
			authSecret: "lead-bot-token",
			batch,
		});
		expect(first.status).toBe("accepted_new");
		await h.router.whenIdle();
		expect(h.getTurns()).toBe(1);
		expect(h.store.listMemberIds(first.entryId)).toEqual(batch.memberIds);
	});

	it("probes v2 capabilities without touching the journal", async () => {
		const h = harness();
		await h.server.listen();
		await expect(
			probeCodexLeadInboxCapabilities({
				socketPath: h.socketPath,
				leadId: "lead-a",
				authSecret: "lead-bot-token",
			}),
		).resolves.toMatchObject({
			protocolVersions: [1, 2],
			features: ["discord_route_v2"],
			socketOwnerId: expect.any(String),
		});
		expect(h.store.listUnfinished()).toEqual([]);
	});

	it("pauses after lock loss and resumes only while the bound inode is current", async () => {
		const h = harness();
		await h.server.listen();
		h.server.pauseAccepting();
		await expect(
			probeCodexLeadInboxCapabilities({
				socketPath: h.socketPath,
				leadId: "lead-a",
				authSecret: "lead-bot-token",
			}),
		).rejects.toThrow();
		expect(h.server.resumeIfBoundPathCurrent()).toBe(true);
		await expect(
			probeCodexLeadInboxCapabilities({
				socketPath: h.socketPath,
				leadId: "lead-a",
				authSecret: "lead-bot-token",
			}),
		).resolves.toMatchObject({ features: ["discord_route_v2"] });
	});

	it("persists v2 Discord reply route metadata", async () => {
		const h = harness();
		await h.server.listen();
		const accepted = await submitCodexLeadInboxBatch({
			socketPath: h.socketPath,
			leadId: "lead-a",
			ownerEpoch: "epoch-1",
			authSecret: "lead-bot-token",
			protocolVersion: 2,
			batch: {
				...batch,
				replyChannelId: "123456789012345678",
				replyRoute: {
					kind: "roundtable_thread_from_message",
					parentChannelId: "123456789012345679",
					sourceMessageId: "123456789012345680",
					threadId: "123456789012345680",
				},
			},
		});
		expect(h.store.getById(accepted.entryId)).toMatchObject({
			replyChannelId: "123456789012345678",
			replyRoute: { threadId: "123456789012345680" },
		});
	});

	it("rejects a wrong Lead or unauthenticated caller before journal accept", async () => {
		const h = harness();
		await h.server.listen();
		await expect(
			submitCodexLeadInboxBatch({
				socketPath: h.socketPath,
				leadId: "lead-b",
				ownerEpoch: "epoch-1",
				authSecret: "lead-bot-token",
				batch,
			}),
		).rejects.toThrow("lead binding mismatch");
		await expect(
			submitCodexLeadInboxBatch({
				socketPath: h.socketPath,
				leadId: "lead-a",
				ownerEpoch: "epoch-1",
				authSecret: "attacker-controlled-token",
				batch,
			}),
		).rejects.toThrow("authentication rejected");
		expect(h.store.listUnfinished()).toEqual([]);
	});

	it("commit-before-reply loss retries as duplicate without another turn", async () => {
		let crashOnce = true;
		const h = harness(() => {
			if (crashOnce) {
				crashOnce = false;
				throw new Error("simulated crash after commit");
			}
		});
		await h.server.listen();
		await expect(
			submitCodexLeadInboxBatch({
				socketPath: h.socketPath,
				leadId: "lead-a",
				ownerEpoch: "epoch-1",
				authSecret: "lead-bot-token",
				batch,
			}),
		).rejects.toThrow("closed without a receipt");
		const retry = await submitCodexLeadInboxBatch({
			socketPath: h.socketPath,
			leadId: "lead-a",
			ownerEpoch: "epoch-1",
			authSecret: "lead-bot-token",
			batch,
		});
		expect(retry.status).toBe("accepted_duplicate_same_membership");
		await h.router.whenIdle();
		expect(h.getTurns()).toBe(1);
	});

	it("fails closed while the TUI process/socket is unavailable", async () => {
		const h = harness();
		await expect(
			submitCodexLeadInboxBatch({
				socketPath: h.socketPath,
				leadId: "lead-a",
				ownerEpoch: "epoch-1",
				authSecret: "lead-bot-token",
				batch,
				timeoutMs: 100,
			}),
		).rejects.toThrow();
		expect(h.store.listUnfinished()).toEqual([]);
	});

	it("survives an oversized client request and continues accepting authenticated work", async () => {
		const h = harness();
		await h.server.listen();
		await new Promise<void>((resolve) => {
			const socket = createConnection(h.socketPath);
			socket.once("connect", () =>
				socket.write(Buffer.alloc(5 * 1024 * 1024 + 1)),
			);
			socket.once("error", () => resolve());
			socket.once("close", () => resolve());
		});
		await expect(
			submitCodexLeadInboxBatch({
				socketPath: h.socketPath,
				leadId: "lead-a",
				ownerEpoch: "epoch-1",
				authSecret: "lead-bot-token",
				batch,
			}),
		).resolves.toMatchObject({ status: "accepted_new" });
	});

	it("closes promptly even while a client holds a connection open", async () => {
		const h = harness();
		await h.server.listen();
		const socket = createConnection(h.socketPath);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		const closing = h.server.close();
		const completed = await Promise.race([
			closing.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
		]);
		if (!completed) {
			socket.destroy();
			await closing;
		}
		expect(completed).toBe(true);
	});
});

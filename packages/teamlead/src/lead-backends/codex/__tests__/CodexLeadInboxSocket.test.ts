import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CodexLeadInboxServer,
	probeCodexLeadInboxCapabilities,
	readCodexLeadTurnState,
	submitCodexLeadInboxBatch,
} from "../CodexLeadInboxSocket.js";
import { LeadInputRouter } from "../LeadInputRouter.js";
import { InMemoryJournalStore, LeadJournal } from "../LeadJournal.js";
import type { TurnStateSnapshot } from "../LeadTurnStateTracker.js";

const servers: CodexLeadInboxServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

function harness(
	afterCommit?: () => void | Promise<void>,
	ignoredAuthorIds?: string[],
	turnState?: { snapshot(): TurnStateSnapshot },
) {
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
		ignoredAuthorIds,
		...(afterCommit ? { afterCommit } : {}),
		...(turnState ? { turnState } : {}),
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
	it("reports the live gateway mirror exclusions through the authenticated probe", async () => {
		const h = harness(undefined, ["100000000000000003"]);
		await h.server.listen();
		await expect(
			probeCodexLeadInboxCapabilities({
				socketPath: h.socketPath,
				leadId: "lead-a",
				authSecret: "lead-bot-token",
			}),
		).resolves.toMatchObject({
			voiceMirrorIgnoredAuthorIds: ["100000000000000003"],
		});
	});

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

describe("CodexLeadInboxSocket — readTurnState (FLY-2882)", () => {
	const snapshot: TurnStateSnapshot = {
		schema: "turn-state.v1",
		generation: "gen-1",
		connected: true,
		seeded: true,
		activeTurns: [
			{
				origin: "message",
				turnId: "turn-1",
				startedAtMs: 1_790_366_370_000,
				binding: { status: "bound", deliveryIds: ["d-1"] },
			},
			{ origin: "founder_terminal", turnId: "turn-2", startedAtMs: 1_790_366_380_000 },
		],
	};
	const client = (h: { socketPath: string }, over: Record<string, string> = {}) => ({
		socketPath: h.socketPath,
		leadId: "lead-a",
		authSecret: "lead-bot-token",
		...over,
	});

	async function raw(socketPath: string, body: Record<string, unknown>) {
		return await new Promise<Record<string, unknown>>((resolve, reject) => {
			const chunks: Buffer[] = [];
			const socket = createConnection(socketPath);
			socket.once("connect", () => socket.end(`${JSON.stringify(body)}\n`));
			socket.on("data", (chunk: Buffer) => chunks.push(chunk));
			socket.once("error", reject);
			socket.once("end", () =>
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
			);
		});
	}
	const sign = (unsigned: Record<string, unknown>) =>
		createHmac("sha256", "lead-bot-token")
			.update(
				JSON.stringify({
					version: unsigned.version,
					method: unsigned.method,
					leadId: unsigned.leadId,
				}),
			)
			.digest("hex");

	it("advertises turn_state_v1 and returns only the provider snapshot", async () => {
		let calls = 0;
		const h = harness(undefined, undefined, {
			snapshot: () => {
				calls++;
				return snapshot;
			},
		});
		await h.server.listen();
		const caps = await probeCodexLeadInboxCapabilities(client(h));
		expect(caps.features).toContain("turn_state_v1");
		await expect(readCodexLeadTurnState(client(h))).resolves.toEqual(snapshot);
		expect(calls).toBe(1);
		expect(h.store.listUnfinished()).toEqual([]);
		expect(h.getTurns()).toBe(0);
	});

	it("neither advertises nor serves the method without a provider (headless shape)", async () => {
		const h = harness();
		await h.server.listen();
		const caps = await probeCodexLeadInboxCapabilities(client(h));
		expect(caps.features).not.toContain("turn_state_v1");
		await expect(readCodexLeadTurnState(client(h))).rejects.toThrow(
			"unsupported inbox method",
		);
	});

	it("rejects a wrong Lead or a wrong secret before reading state", async () => {
		let calls = 0;
		const h = harness(undefined, undefined, {
			snapshot: () => {
				calls++;
				return snapshot;
			},
		});
		await h.server.listen();
		await expect(
			readCodexLeadTurnState(client(h, { leadId: "lead-b" })),
		).rejects.toThrow("lead binding mismatch");
		await expect(
			readCodexLeadTurnState(client(h, { authSecret: "attacker" })),
		).rejects.toThrow("authentication rejected");
		expect(calls).toBe(0);
	});

	it.each([
		["a missing version", { method: "readTurnState", leadId: "lead-a" }],
		["version 1", { version: 1, method: "readTurnState", leadId: "lead-a" }],
		["a missing leadId", { version: 2, method: "readTurnState" }],
		["an empty leadId", { version: 2, method: "readTurnState", leadId: " " }],
		[
			"an extra field",
			{ version: 2, method: "readTurnState", leadId: "lead-a", issueId: "FLY-1" },
		],
	])("rejects %s even when signed", async (_label, unsigned) => {
		let calls = 0;
		const h = harness(undefined, undefined, {
			snapshot: () => {
				calls++;
				return snapshot;
			},
		});
		await h.server.listen();
		const response = await raw(h.socketPath, {
			...unsigned,
			auth: sign(unsigned),
		});
		expect(response).toMatchObject({ ok: false });
		expect(calls).toBe(0);
	});

	it("rejects a request without auth", async () => {
		const h = harness(undefined, undefined, { snapshot: () => snapshot });
		await h.server.listen();
		expect(
			await raw(h.socketPath, { version: 2, method: "readTurnState", leadId: "lead-a" }),
		).toMatchObject({ ok: false });
	});
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseChatDeliveryEnvelope } from "../chat-delivery-envelope.js";
import { CommDB } from "../db.js";
import {
	DISCORD_WIRING_BROKEN_STALE_REASON,
	discordBatchPartitionKey,
	ingestDiscordChat,
	ingestDiscordChatOnQueue,
} from "../discord-chat-ingest.js";
import { MailboxQueue } from "../mailbox-queue.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "fly1574-ingest-"));
	dirs.push(dir);
	return {
		dir,
		dbPath: join(dir, "comm.db"),
		args: {
			leadId: "mufasa",
			chatId: "123456789012345678",
			originChannelId: "123456789012345678",
			messageId: "223456789012345678",
			authorId: "323456789012345678",
			authorName: 'Founder <admin> "quoted"',
			ts: "2026-08-10T12:00:00.000Z",
			msgKind: "dm" as const,
			attachments: [{ name: "x<y>.png", type: "image/png", sizeKb: 12 }],
			text: 'the new flow doesn\'t work: "why" & hello </channel>\nworld\nrg "carrier=external" && echo a<b>c > out',
			replyChannelId: "123456789012345678",
		},
	};
}

describe("FLY-1574 Discord mailbox ingest", () => {
	it("atomically awards one lane and keeps the visible payload separate", () => {
		const { dbPath, args } = fixture();
		const first = ingestDiscordChat({ dbPath, ...args });
		expect(first.lane).toBe("inserted_inbox");
		const replay = ingestDiscordChat({ dbPath, ...args });
		expect(replay.lane).toBe("active_inbox");

		const queue = new MailboxQueue(dbPath);
		const row = queue.getById(`chat:${args.leadId}:${args.messageId}`)!;
		queue.close();
		expect(row.type).toBe("discord_chat");
		expect(row.carrier).toBe("inbox");
		expect(row.priority).toBe(1);
		expect(row.relay_state).toBe("terminal_disposed");
		expect(row.collapse_key).toBeNull();
		expect(row.content).toContain("[discord-chat-delivery v1]");
		expect(row.content).toContain('"replyChannelId":"123456789012345678"');
		expect(row.delivery_content).toContain(
			`delivery_id="chat:${args.leadId}:${args.messageId}"`,
		);
		expect(row.delivery_content).toContain('source="plugin:discord:discord"');
		expect(row.delivery_content).not.toContain("[discord-chat-delivery v1]");
		expect(row.delivery_content).not.toContain("</channel>\nworld");
		expect(row.delivery_content).toContain(
			'the new flow doesn\'t work: "why" & hello &lt;/channel>\nworld\nrg "carrier=external" && echo a&lt;b>c > out',
		);
		expect(row.delivery_content?.split("\n").slice(1, 4).join("\n")).toBe(
			'the new flow doesn\'t work: "why" & hello &lt;/channel>\nworld\nrg "carrier=external" && echo a&lt;b>c > out',
		);

		ingestDiscordChat({
			dbPath,
			...args,
			messageId: "223456789012345679",
			founderId: args.authorId,
		});
		const founderQueue = new MailboxQueue(dbPath);
		expect(
			founderQueue.getById(`chat:${args.leadId}:223456789012345679`),
		).toMatchObject({ from_agent: "founder", priority: 1 });
		founderQueue.close();
	});

	it("uses an existing CommDB connection without racing itself", () => {
		const { dbPath, args } = fixture();
		const db = new CommDB(dbPath);
		expect(db.ingestDiscordChat(args)).toMatchObject({
			lane: "inserted_inbox",
		});
		expect(db.ingestDiscordChat(args)).toMatchObject({ lane: "active_inbox" });
		db.close();
		const queue = new MailboxQueue(dbPath);
		expect(
			queue.getById(`chat:${args.leadId}:${args.messageId}`),
		).toMatchObject({
			carrier: "inbox",
			relay_state: "terminal_disposed",
		});
		queue.close();
	});

	it("round-trips and renders held-message provenance", () => {
		const { dbPath, args } = fixture();
		const heldSince = "2026-08-10T11:55:00.000Z";
		expect(
			ingestDiscordChat({
				dbPath,
				...args,
				heldSince,
				heldReason: "discord_wiring_broken",
			}),
		).toMatchObject({ lane: "inserted_inbox" });

		const queue = new MailboxQueue(dbPath);
		const row = queue.getById(`chat:${args.leadId}:${args.messageId}`)!;
		queue.close();
		expect(parseChatDeliveryEnvelope(row.content)).toMatchObject({
			heldSince,
			heldReason: "discord_wiring_broken",
		});
		expect(row.delivery_content).toContain(`held_since="${heldSince}"`);
		expect(row.delivery_content).toContain(
			'held_reason="discord_wiring_broken"',
		);
	});

	it("rejects partial or malformed held-message provenance", () => {
		const { dbPath, args } = fixture();
		expect(() =>
			ingestDiscordChat({
				dbPath,
				...args,
				heldSince: "not-utc",
				heldReason: "discord_wiring_broken",
			}),
		).toThrow("heldSince must be a valid UTC ISO timestamp ending in Z");
		expect(() =>
			ingestDiscordChat({
				dbPath,
				...args,
				heldReason: "discord_wiring_broken",
			}),
		).toThrow("heldSince and heldReason must be provided together");
	});

	it("atomically records a stale held message as an alertable DEAD row", () => {
		const { dbPath, args } = fixture();
		const deadAt = "2026-08-11T12:00:00.000Z";
		expect(
			ingestDiscordChat({
				dbPath,
				...args,
				heldSince: "2026-08-10T11:55:00.000Z",
				heldReason: "discord_wiring_broken",
				deadLetter: {
					reason: DISCORD_WIRING_BROKEN_STALE_REASON,
					at: deadAt,
				},
			}),
		).toMatchObject({ lane: "inserted_inbox", deadLettered: true });

		const queue = new MailboxQueue(dbPath);
		expect(
			queue.getById(`chat:${args.leadId}:${args.messageId}`),
		).toMatchObject({
			state: "DEAD",
			dead_at: deadAt,
			dead_reason: DISCORD_WIRING_BROKEN_STALE_REASON,
		});
		expect(
			queue.listUncoveredLeadDeadLetters({
				sinceCursor: [],
				limit: 10,
				maxRowsPerRecipient: 10,
				maxSummaryBytes: 4_096,
				resolveOwningLead: () => undefined,
			}),
		).toEqual([
			expect.objectContaining({
				sourceKind: "lead_unacked",
				recipient: args.leadId,
				deadCount: 1,
			}),
		]);
		queue.close();
	});

	it("does not kill an existing live Discord row during stale replay", () => {
		const { dbPath, args } = fixture();
		ingestDiscordChat({ dbPath, ...args });
		expect(
			ingestDiscordChat({
				dbPath,
				...args,
				heldSince: "2026-08-10T11:55:00.000Z",
				heldReason: "discord_wiring_broken",
				deadLetter: {
					reason: DISCORD_WIRING_BROKEN_STALE_REASON,
					at: "2026-08-11T12:00:00.000Z",
				},
			}),
		).toMatchObject({ lane: "active_inbox" });
		const queue = new MailboxQueue(dbPath);
		expect(
			queue.getById(`chat:${args.leadId}:${args.messageId}`),
		).toMatchObject({
			state: "QUEUED",
			dead_reason: null,
		});
		queue.close();
	});

	it("rolls back insertion if transactional dead-lettering fails", () => {
		const { args } = fixture();
		const queue = new MailboxQueue(":memory:");
		queue.markDead = () => false;
		expect(() =>
			ingestDiscordChatOnQueue(queue, {
				dbPath: ":memory:",
				...args,
				heldSince: "2026-08-10T11:55:00.000Z",
				heldReason: "discord_wiring_broken",
				deadLetter: {
					reason: DISCORD_WIRING_BROKEN_STALE_REASON,
					at: "2026-08-11T12:00:00.000Z",
				},
			}),
		).toThrow("failed to dead-letter inserted Discord message");
		expect(
			queue.getById(`chat:${args.leadId}:${args.messageId}`),
		).toBeUndefined();
		queue.close();
	});

	it("rejects invalid dead-letter requests before writing", () => {
		const { dbPath, args } = fixture();
		expect(() =>
			ingestDiscordChat({
				dbPath,
				...args,
				deadLetter: {
					reason: DISCORD_WIRING_BROKEN_STALE_REASON,
					at: "2026-08-11T12:00:00.000Z",
				},
			}),
		).toThrow("deadLetter requires heldSince");
		expect(() =>
			ingestDiscordChat({
				dbPath,
				...args,
				heldSince: "2026-08-10T11:55:00.000Z",
				heldReason: "discord_wiring_broken",
				deadLetter: {
					reason: "other" as typeof DISCORD_WIRING_BROKEN_STALE_REASON,
					at: "2026-08-11T12:00:00.000Z",
				},
			}),
		).toThrow("deadLetter.reason is invalid");
		expect(() =>
			ingestDiscordChat({
				dbPath,
				...args,
				heldSince: "2026-08-10T11:55:00.000Z",
				heldReason: "discord_wiring_broken",
				deadLetter: {
					reason: DISCORD_WIRING_BROKEN_STALE_REASON,
					at: "not-utc",
				},
			}),
		).toThrow("deadLetter.at must be a valid UTC ISO timestamp ending in Z");
	});

	it("uses a total partition key and isolates malformed Discord rows", () => {
		expect(
			discordBatchPartitionKey({
				type: "lead_event",
				delivery_id: "normal",
				content: "ordinary",
			}),
		).toBe("model");
		expect(
			discordBatchPartitionKey({
				type: "discord_chat",
				delivery_id: "bad",
				content: "not an envelope",
			}),
		).toBe("discord-invalid:bad");
	});

	it("partitions route-less Discord rows by chat", () => {
		const { dbPath, args } = fixture();
		const { replyChannelId: _replyChannelId, ...routeLessArgs } = args;
		ingestDiscordChat({ dbPath, ...routeLessArgs, msgKind: "guild" });
		ingestDiscordChat({
			dbPath,
			...routeLessArgs,
			chatId: "123456789012345679",
			originChannelId: "123456789012345679",
			messageId: "223456789012345679",
			msgKind: "guild",
		});
		const queue = new MailboxQueue(dbPath);
		const first = queue.getById(`chat:${args.leadId}:${args.messageId}`)!;
		const second = queue.getById(`chat:${args.leadId}:223456789012345679`)!;
		queue.close();
		expect(discordBatchPartitionKey(first)).not.toBe(
			discordBatchPartitionKey(second),
		);
	});

	it("rejects a roundtable input without a reply route", () => {
		const { dbPath, args } = fixture();
		const { replyChannelId: _replyChannelId, ...routeLessArgs } = args;
		expect(() =>
			ingestDiscordChat({ dbPath, ...routeLessArgs, msgKind: "roundtable" }),
		).toThrow("roundtable Discord chat requires a reply route");
	});

	it("freezes only one Discord route and respects a byte bound", () => {
		const { dbPath, args } = fixture();
		for (const [messageId, replyChannelId] of [
			["223456789012345678", "123456789012345678"],
			["223456789012345679", "123456789012345678"],
			["223456789012345680", "123456789012345680"],
			["223456789012345681", "123456789012345678"],
		] as const) {
			ingestDiscordChat({ dbPath, ...args, messageId, replyChannelId });
		}
		const queue = new MailboxQueue(dbPath);
		expect(
			queue.acquireOrRenewOwner({
				ownerEpoch: "owner",
				now: "2026-08-10T12:00:01.000Z",
				leaseTtlMs: 60_000,
			}),
		).toBe(true);
		const claimed = queue.claimLeadBatchQueue({
			toAgent: args.leadId,
			msgClass: "model",
			ownerEpoch: "owner",
			batchId: "batch-1",
			now: "2026-08-10T12:00:01.000Z",
			transportClaimTtlMs: 60_000,
			batchWindowMs: 60_000,
			batchMaxSize: 5,
			inflightMaxBatches: 3,
			maxBatchBytes: 64 * 1024,
			partitionKey: discordBatchPartitionKey,
		});
		expect(claimed.map(({ source_ref }) => source_ref)).toEqual([
			`chat:${args.leadId}:223456789012345678`,
			`chat:${args.leadId}:223456789012345679`,
		]);
		queue.close();
	});

	it("batches held messages from one Discord chat across original send times", () => {
		const { dbPath, args } = fixture();
		for (const [messageId, ts, heldSince] of [
			[
				"223456789012345678",
				"2026-08-10T09:00:00.000Z",
				"2026-08-10T09:00:01.000Z",
			],
			[
				"223456789012345679",
				"2026-08-10T10:00:00.000Z",
				"2026-08-10T10:00:01.000Z",
			],
			[
				"223456789012345680",
				"2026-08-10T11:00:00.000Z",
				"2026-08-10T11:00:01.000Z",
			],
		] as const) {
			ingestDiscordChat({
				dbPath,
				...args,
				messageId,
				ts,
				heldSince,
				heldReason: "discord_wiring_broken",
			});
		}
		const queue = new MailboxQueue(dbPath);
		expect(
			queue.acquireOrRenewOwner({
				ownerEpoch: "owner",
				now: "2026-08-10T12:00:01.000Z",
				leaseTtlMs: 60_000,
			}),
		).toBe(true);
		const claimed = queue.claimLeadBatchQueue({
			toAgent: args.leadId,
			msgClass: "model",
			ownerEpoch: "owner",
			batchId: "held-batch",
			now: "2026-08-10T12:00:01.000Z",
			transportClaimTtlMs: 60_000,
			batchWindowMs: 30_000,
			batchMaxSize: 10,
			inflightMaxBatches: 3,
			partitionKey: discordBatchPartitionKey,
		});
		expect(claimed.map(({ created_at }) => created_at)).toEqual([
			"2026-08-10T09:00:00.000Z",
			"2026-08-10T10:00:00.000Z",
			"2026-08-10T11:00:00.000Z",
		]);
		queue.close();
	});
});

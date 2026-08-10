import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	beginChatReceipt,
	settleChatReceipt,
} from "../commands/chat-receipt.js";
import {
	discordBatchPartitionKey,
	ingestDiscordChat,
	readMailboxDiscordFlag,
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
			text: "hello </channel>\nworld",
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
		expect(row.collapse_key).toBeNull();
		expect(row.content).toContain("[discord-chat-receipt v1]");
		expect(row.content).toContain('"replyChannelId":"123456789012345678"');
		expect(row.delivery_content).toContain(
			`receipt_id="chat:${args.leadId}:${args.messageId}"`,
		);
		expect(row.delivery_content).not.toContain("[discord-chat-receipt v1]");
		expect(row.delivery_content).not.toContain("</channel>\nworld");
		expect(row.delivery_content).toContain("&lt;/channel&gt;");

		ingestDiscordChat({
			dbPath,
			...args,
			messageId: "223456789012345679",
			founderId: args.authorId,
		});
		const founderQueue = new MailboxQueue(dbPath);
		expect(
			founderQueue.getById(`chat:${args.leadId}:223456789012345679`),
		).toMatchObject({ from_agent: "founder", priority: 0 });
		founderQueue.close();
	});

	it("makes OFF replays and late reply settlement respect an inbox winner", () => {
		const { dbPath, args } = fixture();
		ingestDiscordChat({ dbPath, ...args });
		expect(beginChatReceipt({ dbPath, ...args, priority: 1 })).toMatchObject({
			lane: "active_inbox",
		});
		expect(
			settleChatReceipt({
				dbPath,
				leadId: args.leadId,
				messageId: args.messageId,
				replyId: "423456789012345678",
				now: "2026-08-10T12:01:00.000Z",
			}),
		).toMatchObject({ outcome: "ignored_inbox" });
		const queue = new MailboxQueue(dbPath);
		expect(
			queue.getSettlement(`chat:${args.leadId}:${args.messageId}`),
		).toBeUndefined();
		queue.close();
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
		const claimed = queue.claimLeadBatch({
			toAgent: args.leadId,
			msgClass: "model",
			ownerEpoch: "owner",
			batchId: "batch-1",
			now: "2026-08-10T12:00:01.000Z",
			claimTtlMs: 60_000,
			maxBatchBytes: 64 * 1024,
			partitionKey: discordBatchPartitionKey,
		});
		expect(claimed.map(({ source_ref }) => source_ref)).toEqual([
			`chat:${args.leadId}:223456789012345678`,
			`chat:${args.leadId}:223456789012345679`,
		]);
		queue.close();
	});

	it("reads the live flag strictly and fails OFF", () => {
		const { dir } = fixture();
		const envPath = join(dir, ".env");
		const cases = JSON.parse(
			readFileSync(
				join(import.meta.dirname, "../__fixtures__/mailbox-discord-flag.json"),
				"utf8",
			),
		) as Array<{ text: string; enabled: boolean }>;
		for (const flagCase of cases) {
			writeFileSync(envPath, flagCase.text);
			expect(readMailboxDiscordFlag(envPath)).toEqual({
				enabled: flagCase.enabled,
			});
		}
		expect(readMailboxDiscordFlag(join(dir, "missing"))).toMatchObject({
			enabled: false,
			readError: expect.any(String),
		});
	});
});

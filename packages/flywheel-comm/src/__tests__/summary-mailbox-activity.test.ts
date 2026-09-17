import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

const FROM = "2026-09-16T00:00:00.000Z";
const TO = "2026-09-16T06:00:00.000Z";
const NEXT_TO = "2026-09-16T12:00:00.000Z";
const LEAD_ID = "growth-lead";
const LEAD_BOT = "10000000000000001";
const DISPATCHER_BOT = "10000000000000002";
const RECIPIENT_BOT = "10000000000000003";
const FOUNDER = "10000000000000004";
const OUTSIDER = "10000000000000005";

describe("FLY-2634 CommDB summary mailbox activity", () => {
	let db: CommDB;
	let root: string;
	let nextMessage = 20000000000000000n;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly2634-mailbox-"));
		db = new CommDB(join(root, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});

	function ingest(input: {
		authorId: string;
		text: string;
		ts?: string;
		founder?: boolean;
	}): void {
		const messageId = String(nextMessage++);
		db.ingestDiscordChat({
			leadId: LEAD_ID,
			chatId: "30000000000000000",
			originChannelId: "30000000000000000",
			messageId,
			authorId: input.authorId,
			authorName: `author-${input.authorId}`,
			ts: input.ts ?? "2026-09-16T02:00:00.000Z",
			msgKind: "dm",
			attachments: [],
			text: input.text,
			...(input.founder ? { founderId: input.authorId } : {}),
		});
	}

	function read(input?: {
		fromIso?: string;
		toIso?: string;
		allocatedSeq?: number | null;
		contiguous?: boolean;
		founderUserId?: string;
	}) {
		return db.readMailboxActivity({
			leadId: LEAD_ID,
			leadBotUserId: LEAD_BOT,
			founderUserId: input?.founderUserId ?? FOUNDER,
			recipientBotUserId: RECIPIENT_BOT,
			senderBotUserIds: [DISPATCHER_BOT, RECIPIENT_BOT],
			fromIso: input?.fromIso ?? FROM,
			toIso: input?.toIso ?? TO,
			allocatedSeq: input?.allocatedSeq ?? 0,
			contiguous: input?.contiguous ?? true,
		});
	}

	it("counts founder and configured bot dispatch mentions only", () => {
		ingest({
			authorId: FOUNDER,
			text: "normalized founder fact",
			founder: true,
		});
		ingest({ authorId: FOUNDER, text: "raw founder fallback" });
		ingest({ authorId: DISPATCHER_BOT, text: `please act <@${LEAD_BOT}>` });
		ingest({ authorId: DISPATCHER_BOT, text: `legacy act <@!${LEAD_BOT}>` });
		ingest({ authorId: DISPATCHER_BOT, text: "shared channel chatter" });
		ingest({ authorId: RECIPIENT_BOT, text: `summary review <@${LEAD_BOT}>` });
		ingest({ authorId: OUTSIDER, text: `ordinary user <@${LEAD_BOT}>` });

		const result = read();
		expect(result.count).toBe(4);
		expect(result.allocatedSeq).toBe(7);
		expect(result.instance.schema_generation).toMatch(/^mailbox_/);
		expect(result.instance.completed_at).toMatch(/Z$/);
	});

	it("refuses to claim complete mailbox observation without a valid founder id", () => {
		expect(() => read({ founderUserId: "not-a-snowflake" })).toThrow(
			"founderUserId must be a Discord snowflake",
		);
	});

	it("counts late old messages above the cursor and future messages in their own window", () => {
		ingest({
			authorId: DISPATCHER_BOT,
			text: `next window <@${LEAD_BOT}>`,
			ts: "2026-09-16T07:00:00.000Z",
		});
		const first = read();
		expect(first.count).toBe(0);

		ingest({
			authorId: DISPATCHER_BOT,
			text: `late ingest <@${LEAD_BOT}>`,
			ts: "2026-09-15T23:00:00.000Z",
		});
		expect(
			read({
				fromIso: TO,
				toIso: NEXT_TO,
				allocatedSeq: first.allocatedSeq,
			}).count,
		).toBe(2);
	});

	it("keeps the AUTOINCREMENT cursor after hot rows disappear", () => {
		ingest({ authorId: OUTSIDER, text: "not activity" });
		const before = read();
		const raw = (
			db as unknown as {
				db: {
					exec(sql: string): void;
					prepare(sql: string): { run(): void };
				};
			}
		).db;
		raw.exec("DROP TRIGGER mailbox_delete_requires_archive");
		raw.prepare("DELETE FROM mailbox").run();
		const after = read({ allocatedSeq: before.allocatedSeq });
		expect(after).toMatchObject({
			count: 0,
			allocatedSeq: before.allocatedSeq,
		});
	});

	it("does not treat archive metadata without a hot mailbox row as activity", () => {
		const raw = (
			db as unknown as {
				db: {
					prepare(sql: string): { run(...args: unknown[]): void };
				};
			}
		).db;
		raw
			.prepare(
				`INSERT INTO mailbox_terminal_archive
				 (id, delivery_id, insert_projection_hash, terminal_at, archived_at,
				  mailbox_json, logs_json, payload_sha256)
				 VALUES (?, ?, ?, ?, ?, NULL, '[]', ?)`,
			)
			.run(
				"cold-only",
				"cold-only-delivery",
				"projection",
				"2026-09-16T02:00:00.000Z",
				"2026-09-16T03:00:00.000Z",
				"a".repeat(64),
			);
		expect(read()).toMatchObject({ count: 0, allocatedSeq: 0 });
	});
});

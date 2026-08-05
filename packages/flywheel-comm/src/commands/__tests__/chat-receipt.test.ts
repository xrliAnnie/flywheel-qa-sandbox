import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CommDB } from "../../db.js";
import { MailboxQueue } from "../../mailbox-queue.js";
import { encodeSenderRef } from "../../sender-ref.js";
import {
	beginChatReceipt,
	completeChatReceipt,
	listPendingChatReceipts,
	parseChatReceiptEnvelope,
	quarantineChatReceipt,
	settleChatReceipt,
} from "../chat-receipt.js";

const COMM_CLI = fileURLToPath(
	new URL("../../../dist/index.js", import.meta.url),
);

describe("FLY-1426 chat-receipt command", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function freshDb(): string {
		const dir = mkdtempSync(join(tmpdir(), "fly1426-chat-receipt-"));
		dirs.push(dir);
		const dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
		return dbPath;
	}

	function begin(dbPath: string, overrides: Record<string, unknown> = {}) {
		return beginChatReceipt({
			dbPath,
			leadId: "flywheel-eng-lead",
			chatId: "100000000000000001",
			originChannelId: "100000000000000002",
			messageId: "100000000000000003",
			authorId: "100000000000000004",
			authorName: "Annie",
			priority: 0,
			ts: "2026-07-22T12:00:00.000Z",
			msgKind: "guild",
			attachments: [{ name: "brief.png", type: "image/png", sizeKb: 12.5 }],
			text: "请更新 batch 报告\n并在今天完成",
			...overrides,
		});
	}

	it("begins a canonical external receipt with a round-trippable v1 envelope", () => {
		const dbPath = freshDb();
		const first = begin(dbPath);
		const replay = begin(dbPath);
		expect(replay).toEqual(first);

		const queue = new MailboxQueue(dbPath);
		try {
			const row = queue.getById("chat:flywheel-eng-lead:100000000000000003");
			expect(row).toMatchObject({
				from_agent: "founder",
				to_agent: "flywheel-eng-lead",
				source_kind: "discord_chat",
				type: "external_delivery",
				msg_class: "model",
				priority: 0,
				ref_id: null,
				carrier: "external",
				state: "QUEUED",
			});
			const parsed = parseChatReceiptEnvelope(row?.content ?? "");
			expect(parsed).toMatchObject({
				v: 1,
				receiptId: "chat:flywheel-eng-lead:100000000000000003",
				leadId: "flywheel-eng-lead",
				chatId: "100000000000000001",
				originChannelId: "100000000000000002",
				messageId: "100000000000000003",
				authorId: "100000000000000004",
				authorName: "Annie",
				priority: 0,
				msgKind: "guild",
				text: "请更新 batch 报告\n并在今天完成",
			});
			expect(parsed.attachments).toEqual([
				{ name: "brief.png", type: "image/png", sizeKb: 12.5 },
			]);
			expect(row?.content).toContain(
				"\nAnnie: 请更新 batch 报告\n并在今天完成",
			);
		} finally {
			queue.close();
		}
	});

	it("rejects a replay that changes fields under the same Discord message id", () => {
		const dbPath = freshDb();
		begin(dbPath);
		expect(() => begin(dbPath, { authorName: "Someone else" })).toThrow(
			/identity conflict/,
		);
	});

	it("coexists with the founder lane for the same Discord message id", () => {
		const dbPath = freshDb();
		const queue = new MailboxQueue(dbPath);
		try {
			queue.enqueue({
				id: "founder_msg:100000000000000003",
				fromAgent: "founder",
				toAgent: "flywheel-eng-lead",
				recipientKind: "lead",
				sourceKind: "founder_reply",
				type: "founder_reply",
				msgClass: "model",
				priority: 0,
				content: "founder lane",
				refId: "100000000000000003",
				createdAt: "2026-07-22T12:00:00.000Z",
				senderRef: encodeSenderRef(),
			});
		} finally {
			queue.close();
		}
		begin(dbPath);
		const verify = new MailboxQueue(dbPath);
		try {
			expect(
				verify.getById("chat:flywheel-eng-lead:100000000000000003"),
			).toBeDefined();
			expect(verify.getById("founder_msg:100000000000000003")).toBeDefined();
		} finally {
			verify.close();
		}
	});

	it("completes with the shared priority windows and settles only with typed reply evidence", () => {
		const dbPath = freshDb();
		begin(dbPath);
		const completed = completeChatReceipt({
			dbPath,
			leadId: "flywheel-eng-lead",
			messageId: "100000000000000003",
			now: "2026-07-22T12:01:00.000Z",
			env: { FLYWHEEL_RECEIPT_WINDOW_P0_MIN: "2" },
		});
		expect(completed.receiptId).toBe(
			"chat:flywheel-eng-lead:100000000000000003",
		);
		// A later replay is a no-op and must not move the original receipt window.
		completeChatReceipt({
			dbPath,
			leadId: "flywheel-eng-lead",
			messageId: "100000000000000003",
			now: "2026-07-22T12:02:00.000Z",
			env: { FLYWHEEL_RECEIPT_WINDOW_P0_MIN: "2" },
		});

		settleChatReceipt({
			dbPath,
			leadId: "flywheel-eng-lead",
			messageId: "100000000000000003",
			replyId: "100000000000000099",
			now: "2026-07-22T12:03:00.000Z",
		});
		// Exact evidence replay is idempotent.
		settleChatReceipt({
			dbPath,
			leadId: "flywheel-eng-lead",
			messageId: "100000000000000003",
			replyId: "100000000000000099",
			now: "2026-07-22T12:04:00.000Z",
		});

		const queue = new MailboxQueue(dbPath);
		try {
			const row = queue.getById("chat:flywheel-eng-lead:100000000000000003");
			expect(row).toMatchObject({
				state: "ACKED",
				acked_at: "2026-07-22T12:01:00.000Z",
			});
			expect(queue.getSettlement(row?.id ?? "")).toEqual({
				event: "processed",
				at: "2026-07-22T12:03:00.000Z",
				evidence: {
					v: 1,
					kind: "discord_explicit_reply",
					ref: "100000000000000099",
					actor: "flywheel-eng-lead",
					actor_kind: "lead",
					fence: {
						leadId: "flywheel-eng-lead",
						chatReplyTo: "100000000000000003",
					},
					basis: ["discord_reply_reference"],
				},
			});
		} finally {
			queue.close();
		}
	});

	it("lists only this Lead's unsettled chat lane with stable cursor pagination", () => {
		const dbPath = freshDb();
		for (const [messageId, ts] of [
			["100000000000000010", "2026-07-22T10:00:00.000Z"],
			["100000000000000011", "2026-07-22T10:01:00.000Z"],
			["100000000000000012", "2026-07-22T10:02:00.000Z"],
		] as const) {
			begin(dbPath, { messageId, ts, text: messageId, attachments: [] });
		}
		begin(dbPath, {
			leadId: "other-lead",
			messageId: "100000000000000020",
			text: "other lead",
			attachments: [],
		});
		const queue = new MailboxQueue(dbPath);
		try {
			queue.enqueue({
				id: "xdept:flywheel-eng-lead:100000000000000030",
				fromAgent: "flywheel-product-lead",
				toAgent: "flywheel-eng-lead",
				recipientKind: "lead",
				sourceKind: "discord_cross_department",
				type: "external_delivery",
				msgClass: "model",
				content: "not chat lane",
				carrier: "external",
				createdAt: "2026-07-22T10:00:00.000Z",
				senderRef: encodeSenderRef(),
			});
			queue.settle({
				messageOrDeliveryId: "chat:flywheel-eng-lead:100000000000000011",
				event: "processed",
				now: "2026-07-22T10:03:00.000Z",
				evidence: {
					v: 1,
					kind: "discord_explicit_reply",
					ref: "100000000000000090",
					actor: "flywheel-eng-lead",
					actor_kind: "lead",
					fence: { chatReplyTo: "100000000000000011" },
				},
			});
		} finally {
			queue.close();
		}

		const first = listPendingChatReceipts({
			dbPath,
			leadId: "flywheel-eng-lead",
			cursorSeq: 0,
			limit: 1,
		});
		expect(first.rows.map((row) => row.envelope?.messageId)).toEqual([
			"100000000000000010",
		]);
		const second = listPendingChatReceipts({
			dbPath,
			leadId: "flywheel-eng-lead",
			cursorSeq: first.nextCursor,
			limit: 10,
		});
		expect(second.rows.map((row) => row.envelope?.messageId)).toEqual([
			"100000000000000012",
		]);
	});

	it("surfaces malformed envelopes instead of swallowing the row", () => {
		const dbPath = freshDb();
		const queue = new MailboxQueue(dbPath);
		try {
			queue.enqueue({
				id: "chat:flywheel-eng-lead:100000000000000050",
				fromAgent: "founder",
				toAgent: "flywheel-eng-lead",
				recipientKind: "lead",
				sourceKind: "discord_chat",
				type: "external_delivery",
				msgClass: "model",
				content: "broken",
				carrier: "external",
				createdAt: "2026-07-22T10:00:00.000Z",
				senderRef: encodeSenderRef(),
			});
		} finally {
			queue.close();
		}
		const result = listPendingChatReceipts({
			dbPath,
			leadId: "flywheel-eng-lead",
		});
		expect(result.rows).toEqual([
			expect.objectContaining({
				id: "chat:flywheel-eng-lead:100000000000000050",
				envelope: null,
				parse_error: expect.stringMatching(/v1 envelope/),
			}),
		]);
	});

	it("quarantines to a stable DEAD state that cannot later complete", () => {
		const dbPath = freshDb();
		begin(dbPath);
		expect(
			quarantineChatReceipt({
				dbPath,
				leadId: "flywheel-eng-lead",
				messageId: "100000000000000003",
				now: "2026-07-22T13:00:00.000Z",
			}),
		).toMatchObject({ quarantined: true });
		expect(
			quarantineChatReceipt({
				dbPath,
				leadId: "flywheel-eng-lead",
				messageId: "100000000000000003",
				now: "2026-07-22T13:05:00.000Z",
			}),
		).toMatchObject({ quarantined: true });
		expect(() =>
			completeChatReceipt({
				dbPath,
				leadId: "flywheel-eng-lead",
				messageId: "100000000000000003",
				now: "2026-07-22T13:06:00.000Z",
				env: {},
			}),
		).toThrow(/not found or not external/);
		const queue = new MailboxQueue(dbPath);
		try {
			expect(
				queue.getById("chat:flywheel-eng-lead:100000000000000003"),
			).toMatchObject({
				state: "DEAD",
				dead_reason: "chat_delivery_unconfirmed",
			});
		} finally {
			queue.close();
		}
	});

	it("rejects invalid priority, message kind, timestamps, ids, and attachments", () => {
		const dbPath = freshDb();
		expect(() => begin(dbPath, { priority: 2 })).toThrow(/priority/);
		expect(() => begin(dbPath, { msgKind: "thread" })).toThrow(/msgKind/);
		expect(() => begin(dbPath, { ts: "today" })).toThrow(/ts/);
		expect(() => begin(dbPath, { messageId: "not-a-snowflake" })).toThrow(
			/messageId/,
		);
		expect(() =>
			begin(dbPath, {
				attachments: [{ name: "bad", type: "text/plain", sizeKb: -1 }],
			}),
		).toThrow(/attachments/);
	});

	it("runs begin, pending, complete, and settle through the built CLI", () => {
		const dbPath = freshDb();
		const baseArgs = [
			COMM_CLI,
			"chat-receipt",
			"begin",
			"--lead",
			"flywheel-eng-lead",
			"--chat-id",
			"100000000000000001",
			"--origin-channel-id",
			"100000000000000002",
			"--message-id",
			"100000000000000003",
			"--author-id",
			"100000000000000004",
			"--author-name",
			"Annie",
			"--priority",
			"0",
			"--ts",
			"2026-07-22T12:00:00.000Z",
			"--msg-kind",
			"guild",
			"--attachments-json",
			"[]",
			"--content-stdin",
			"--json",
		];
		const run = (args: string[], input?: string) => {
			const result = spawnSync(process.execPath, args, {
				encoding: "utf8",
				input,
				env: { ...process.env, FLYWHEEL_COMM_DB: dbPath },
			});
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);
			return JSON.parse(result.stdout) as Record<string, unknown>;
		};

		expect(run(baseArgs, "请更新 batch 报告")).toMatchObject({
			receiptId: "chat:flywheel-eng-lead:100000000000000003",
		});
		const pending = run([
			COMM_CLI,
			"chat-receipt",
			"pending",
			"--lead",
			"flywheel-eng-lead",
			"--json",
		]);
		expect(pending.rows).toEqual([
			expect.objectContaining({
				id: "chat:flywheel-eng-lead:100000000000000003",
			}),
		]);
		run([
			COMM_CLI,
			"chat-receipt",
			"complete",
			"--lead",
			"flywheel-eng-lead",
			"--message-id",
			"100000000000000003",
			"--json",
		]);
		run([
			COMM_CLI,
			"chat-receipt",
			"settle",
			"--lead",
			"flywheel-eng-lead",
			"--message-id",
			"100000000000000003",
			"--reply-id",
			"100000000000000099",
			"--json",
		]);
		const queue = new MailboxQueue(dbPath);
		try {
			expect(
				queue.getById("chat:flywheel-eng-lead:100000000000000003"),
			).toMatchObject({
				state: "ACKED",
			});
			expect(
				queue.getSettlement("chat:flywheel-eng-lead:100000000000000003"),
			).toMatchObject({
				event: "processed",
				evidence: { kind: "discord_explicit_reply" },
			});
		} finally {
			queue.close();
		}
	});
});

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CodexLeadOutboundHandler,
	type DiscordSendFn,
	InMemoryOutboundDedupStore,
} from "../CodexLeadOutboundHandler.js";
import { SqliteOutboundDedupStore } from "../SqliteOutboundDedupStore.js";

describe("SqliteOutboundDedupStore — contract", () => {
	let store: SqliteOutboundDedupStore;
	beforeEach(() => {
		store = new SqliteOutboundDedupStore(":memory:");
	});
	afterEach(() => store.close());

	it("absent key → undefined", () => {
		expect(store.get("nope")).toBeUndefined();
	});

	it("setInFlight then markSent transitions status + records messageId", () => {
		store.setInFlight("k");
		expect(store.get("k")).toMatchObject({ status: "in_flight" });
		store.markSent("k", "msg-1");
		expect(store.get("k")).toEqual({
			idempotencyKey: "k",
			status: "sent",
			messageId: "msg-1",
		});
	});

	it("setInFlight is an ATOMIC CLAIM: returns true only for the first caller (HIGH-2)", () => {
		expect(store.setInFlight("k")).toBe(true); // claimed
		expect(store.setInFlight("k")).toBe(false); // already in_flight → lost
		store.markSent("k", "msg-1");
		expect(store.setInFlight("k")).toBe(false); // already sent → lost
	});

	it("setInFlight never clobbers an existing sent record", () => {
		store.markSent("k", "msg-1");
		store.setInFlight("k"); // must NOT downgrade
		expect(store.get("k")).toMatchObject({
			status: "sent",
			messageId: "msg-1",
		});
	});

	it("delete removes the marker (retry path)", () => {
		store.setInFlight("k");
		store.delete("k");
		expect(store.get("k")).toBeUndefined();
	});

	it("returns copies (external mutation can't corrupt the store)", () => {
		store.markSent("k", "m");
		const r = store.get("k")!;
		(r as { status: string }).status = "in_flight";
		expect(store.get("k")?.status).toBe("sent");
	});
});

describe("SqliteOutboundDedupStore — durable across reopen + handler integration", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly224-dedup-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("a SENT record survives reopen → exactly-once after a Bridge restart", () => {
		const path = join(dir, "dedup.db");
		const s1 = new SqliteOutboundDedupStore(path);
		s1.markSent("e1:out", "msg-77");
		s1.close();
		const s2 = new SqliteOutboundDedupStore(path);
		expect(s2.get("e1:out")).toEqual({
			idempotencyKey: "e1:out",
			status: "sent",
			messageId: "msg-77",
		});
		s2.close();
	});

	it("creates a missing parent directory on a fresh Bridge host", () => {
		const path = join(dir, "fresh-home", ".flywheel", "dedup.db");
		const freshStore = new SqliteOutboundDedupStore(path);
		expect(existsSync(path)).toBe(true);
		freshStore.close();
	});

	it("drives the handler exactly-once on the sqlite store (no re-send on repeat)", async () => {
		const store = new SqliteOutboundDedupStore(":memory:");
		let n = 0;
		const send: DiscordSendFn = async () => `msg-${++n}`;
		const handler = new CodexLeadOutboundHandler({
			store,
			send,
			expectedApiToken: "tok",
		});
		const body = {
			projectName: "p",
			leadId: "l",
			channelId: "c",
			text: "hi",
			idempotencyKey: "e1:out",
			nonce: "n1",
		};
		const r1 = await handler.handle({ body, providedToken: "tok" });
		const r2 = await handler.handle({ body, providedToken: "tok" });
		expect(r1).toMatchObject({ status: "sent", messageId: "msg-1" });
		expect(r2).toMatchObject({ status: "deduped", messageId: "msg-1" });
		expect(n).toBe(1); // sent exactly once
		store.close();
	});
});

it("closes the acquired connection when receipt schema initialization fails", () => {
	const home = mkdtempSync(join(tmpdir(), "outbound-init-fail-")),
		path = join(home, "outbound.db"),
		db = new Database(path);
	db.exec("CREATE TABLE lead_operation_receipts (unexpected TEXT)");
	db.close();
	const close = vi.spyOn(Database.prototype, "close");
	try {
		expect(() => new SqliteOutboundDedupStore(path)).toThrow();
		expect(close).toHaveBeenCalledTimes(1);
	} finally {
		close.mockRestore();
		rmSync(home, { recursive: true, force: true });
	}
});

describe("proactive roundtable dedup persistence", () => {
	const binding = {
		projectName: "p",
		leadId: "l",
		parentChannelId: "12345678901234567",
		payloadHash: "a".repeat(64),
	};
	it("keeps sent and pending engagement separately through reopen and marks only the bound receipt ready", () => {
		const dir = mkdtempSync(join(tmpdir(), "rt-dedup-"));
		const path = join(dir, "dedup.db");
		let store = new SqliteOutboundDedupStore(path);
		try {
			expect(store.setInFlight("key", binding)).toBe(true);
			expect(() =>
				store.markEngagementReady("key", binding, "12345678901234568"),
			).toThrow();
			store.markSent("key", "12345678901234568");
			store.close();
			store = new SqliteOutboundDedupStore(path);
			expect(store.get("key")).toMatchObject({
				status: "sent",
				messageId: "12345678901234568",
				binding,
				engagement: "pending",
			});
			expect(() =>
				store.setInFlight("key", { ...binding, leadId: "other" }),
			).toThrow(/binding/);
			expect(() =>
				store.markEngagementReady("key", binding, "12345678901234569"),
			).toThrow();
			store.markEngagementReady("key", binding, "12345678901234568");
			expect(store.setInFlight("key", binding)).toBe(false);
			store.close();
			store = new SqliteOutboundDedupStore(path);
			expect(store.get("key")).toMatchObject({ engagement: "ready", binding });
			const oldReader = new Database(path, { readonly: true });
			try {
				expect(
					oldReader
						.prepare(
							"SELECT status, message_id FROM outbound_dedup WHERE idempotency_key = ?",
						)
						.get("key"),
				).toEqual({ status: "sent", message_id: "12345678901234568" });
			} finally {
				oldReader.close();
			}
			expect(() => store.markSent("key", "12345678901234569")).toThrow();
			expect(store.get("key")?.messageId).toBe("12345678901234568");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("keeps the in-memory contract identical and prevents binding mutation by callers", () => {
		const store = new InMemoryOutboundDedupStore();
		const input = { ...binding };
		store.setInFlight("k", input);
		input.leadId = "changed";
		const returned = store.get("k")!;
		returned.binding!.leadId = "changed-again";
		store.markSent("k", "12345678901234568");
		store.markEngagementReady("k", binding, "12345678901234568");
		expect(store.get("k")).toMatchObject({
			binding,
			engagement: "ready",
			status: "sent",
		});
		expect(() => store.setInFlight("k")).toThrow(/binding/);
	});

	it("migrates old rows without granting them an engagement binding", () => {
		const dir = mkdtempSync(join(tmpdir(), "rt-dedup-old-"));
		const path = join(dir, "dedup.db");
		const old = new Database(path);
		old.exec(
			"CREATE TABLE outbound_dedup (idempotency_key TEXT PRIMARY KEY, status TEXT NOT NULL, message_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO outbound_dedup VALUES ('old', 'sent', 'old-message', 1, 1)",
		);
		old.close();
		const store = new SqliteOutboundDedupStore(path);
		try {
			expect(store.get("old")).toEqual({
				idempotencyKey: "old",
				status: "sent",
				messageId: "old-message",
			});
			expect(() => store.setInFlight("old", binding)).toThrow(/binding/);
			expect(() =>
				store.markEngagementReady("old", binding, "old-message"),
			).toThrow();
			expect(store.setInFlight("old")).toBe(false);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

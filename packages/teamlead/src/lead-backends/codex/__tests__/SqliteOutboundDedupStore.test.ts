import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CodexLeadOutboundHandler,
	type DiscordSendFn,
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

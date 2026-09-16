import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { InMemoryOutboundDedupStore } from "../CodexLeadOutboundHandler.js";
import { createBrokerDiscordOutboundSender } from "../capability-outbound.js";

function fixture(
	fetchImpl: typeof fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ id: "333333333333333333" }), {
				status: 200,
			}),
	),
	dbPath = ":memory:",
) {
	const sender = createBrokerDiscordOutboundSender({
		sender: {
			bridgeUrl: "http://unused.local",
			apiToken: "PRIVATE",
			projectName: "proj",
			leadId: "lead",
			channelId: "111111111111111111",
			dbPath,
		},
		store: new InMemoryOutboundDedupStore(),
		resolveBotToken: () => "BOT_PRIVATE",
		authorizeLeadChannel: async () => true,
		fetchImpl,
	});
	return { sender, fetchImpl };
}
const guard = () => ({
	beforeSideEffect: vi.fn(async () => {}),
	assertSideEffectCurrent: vi.fn(() => {}),
	signal: new AbortController().signal,
});
it("migrates existing outbox rows and reopens reply evidence without sending or accepting mismatched input", async () => {
	const dir = mkdtempSync("/tmp/outbound-reply-");
	const path = join(dir, "outbox.db");
	const db = new Database(path);
	db.exec(
		"CREATE TABLE outbox (outbox_id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE NOT NULL,lead_id TEXT NOT NULL,text TEXT NOT NULL,nonce TEXT NOT NULL,channel_id TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL); INSERT INTO outbox VALUES ('old','old','lead','old text','n','111111111111111111','pending',1,1)",
	);
	db.close();
	const initial = fixture(undefined, path);
	const expected = {
		leadId: "lead",
		text: "hello",
		replyTo: "222222222222222222",
	};
	try {
		expect(
			initial.sender.getDeliveryStatus("old", {
				leadId: "lead",
				text: "old text",
			}),
		).toEqual({ status: "pending" });
		const id = await initial.sender.enqueue({
			...expected,
			idempotencyKey: "new",
		});
		await initial.sender.deliverWithResult(id, guard());
	} finally {
		initial.sender.close();
	}
	const reopened = fixture(undefined, path);
	try {
		expect(reopened.sender.getDeliveryStatus("new", expected)).toEqual({
			status: "sent",
			messageId: "333333333333333333",
		});
		for (const changed of [
			{ ...expected, text: "changed" },
			{ ...expected, channelId: "444444444444444444" },
			{ ...expected, replyTo: "555555555555555555" },
			{ ...expected, leadId: "foreign" },
		])
			expect(() => reopened.sender.getDeliveryStatus("new", changed)).toThrow(
				"outbound_evidence_conflict",
			);
		await reopened.sender.deliverWithResult("new", guard());
		expect(reopened.fetchImpl).not.toHaveBeenCalled();
	} finally {
		reopened.sender.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
it("uses the existing durable outbound chain with exact reply target and no duplicate resend", async () => {
	const { sender, fetchImpl } = fixture();
	try {
		const id = await sender.enqueue({
			leadId: "lead",
			channelId: "111111111111111111",
			text: "hello",
			idempotencyKey: "event-1",
			replyTo: "222222222222222222",
		});
		expect(sender.getDeliveryStatus(id)).toEqual({ status: "pending" });
		const result = await sender.deliverWithResult(id, guard());
		expect(result.messageId).toBe("333333333333333333");
		expect(sender.getDeliveryStatus(id)).toEqual({
			status: "sent",
			messageId: "333333333333333333",
		});
		const post = vi.mocked(fetchImpl).mock.calls[0]!;
		expect(JSON.parse(post[1]!.body as string)).toMatchObject({
			message_reference: { message_id: "222222222222222222" },
			allowed_mentions: { parse: [] },
		});
		await sender.deliverWithResult(id, guard());
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		await expect(
			sender.enqueue({
				leadId: "lead",
				text: "hello",
				idempotencyKey: "event-1",
				replyTo: "444444444444444444",
			}),
		).rejects.toThrow(/conflict/);
	} finally {
		sender.close();
	}
});
it("checks authorization between chunks and preserves ambiguous state without retry", async () => {
	let current = true;
	const fetchImpl = vi.fn(async () => {
		current = false;
		return new Response(JSON.stringify({ id: "333333333333333333" }), {
			status: 200,
		});
	});
	const { sender } = fixture(fetchImpl as typeof fetch);
	const guarded = {
		...guard(),
		assertSideEffectCurrent: () => {
			if (!current) throw new Error("private revocation");
		},
	};
	try {
		const id = await sender.enqueue({
			leadId: "lead",
			text: "x".repeat(3000),
			idempotencyKey: "event-1",
		});
		await expect(sender.deliverWithResult(id, guarded)).rejects.toThrow();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(sender.getDeliveryStatus(id)).toEqual({ status: "ambiguous" });
		await expect(sender.deliverWithResult(id, guard())).rejects.toThrow(
			/ambiguous/,
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	} finally {
		sender.close();
	}
});
it("never dispatches an unguarded broker delivery", async () => {
	const { sender, fetchImpl } = fixture();
	try {
		const id = await sender.enqueue({
			leadId: "lead",
			text: "hello",
			idempotencyKey: "event-1",
		});
		await expect(sender.deliverWithResult(id)).rejects.toThrow();
		expect(fetchImpl).not.toHaveBeenCalled();
	} finally {
		sender.close();
	}
});

it("shares a trusted delivery context across guarded senders with different operation keys", async () => {
	const store = new InMemoryOutboundDedupStore();
	const fetchImpl = vi.fn(
		async () =>
			new Response(JSON.stringify({ id: "333333333333333333" }), {
				status: 200,
			}),
	);
	const senders = ["tool", "automatic"].map((kind) =>
		createBrokerDiscordOutboundSender({
			sender: {
				bridgeUrl: "http://unused.local",
				apiToken: "PRIVATE",
				projectName: "proj",
				leadId: "lead",
				channelId: "111111111111111111",
				dbPath: ":memory:",
			},
			store,
			resolveBotToken: () => "BOT_PRIVATE",
			authorizeLeadChannel: async () => true,
			fetchImpl,
			deliveryContext: kind === "tool" ? "parent-entry-1" : undefined,
		}),
	);
	try {
		for (const [index, sender] of senders.entries()) {
			const id = await sender.enqueue({
				leadId: "lead",
				text: "hello",
				idempotencyKey: `operation-${index}`,
				...(index === 1 ? { deliveryContext: "parent-entry-1" } : {}),
			});
			expect((await sender.deliverWithResult(id, guard())).messageId).toBe(
				"333333333333333333",
			);
		}
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	} finally {
		for (const sender of senders) sender.close();
	}
});

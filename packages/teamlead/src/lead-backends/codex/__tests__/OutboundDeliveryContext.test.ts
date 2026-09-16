import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CodexLeadOutboundHandler } from "../CodexLeadOutboundHandler.js";
import { SqliteOutboundDedupStore } from "../SqliteOutboundDedupStore.js";

it("shares confirmed delivery across operation keys after restart only within the same trusted context, target and body", async () => {
	const root = mkdtempSync(join(tmpdir(), "outbound-context-"));
	let store = new SqliteOutboundDedupStore(join(root, "outbound.db"));
	const send = vi.fn(async () => `message-${send.mock.calls.length}`);
	const handler = () =>
		new CodexLeadOutboundHandler({ store, send, expectedApiToken: "test" });
	const request = (
		key: string,
		context = "entry-1",
		text = "hello",
		channelId = "thread-1",
	) => ({
		providedToken: "test",
		deliveryContext: context,
		body: {
			projectName: "project",
			leadId: "lead",
			channelId,
			text,
			idempotencyKey: key,
			nonce: key,
		},
	});
	try {
		expect((await handler().handle(request("tool-key"))).status).toBe("sent");
		store.close();
		store = new SqliteOutboundDedupStore(join(root, "outbound.db"));
		expect(await handler().handle(request("automatic-key"))).toMatchObject({
			status: "deduped",
			messageId: "message-1",
		});
		expect(send).toHaveBeenCalledTimes(1);
		for (const req of [
			request("other-entry", "entry-2"),
			request("other-body", "entry-1", "changed"),
			request("other-target", "entry-1", "hello", "thread-2"),
		]) {
			expect((await handler().handle(req)).status).toBe("sent");
		}
		expect(send).toHaveBeenCalledTimes(4);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("keeps uncertain cross-path delivery ambiguous across restart without a second send", async () => {
	const root = mkdtempSync(join(tmpdir(), "outbound-context-"));
	let store = new SqliteOutboundDedupStore(join(root, "outbound.db"));
	const send = vi.fn(async (): Promise<string> => {
		throw new Error("response lost");
	});
	const make = () =>
		new CodexLeadOutboundHandler({ store, send, expectedApiToken: "test" });
	const request = {
		providedToken: "test",
		deliveryContext: "entry-1",
		body: {
			projectName: "project",
			leadId: "lead",
			channelId: "thread",
			text: "hello",
			nonce: "nonce",
			idempotencyKey: "tool",
		},
	};
	try {
		expect((await make().handle(request)).status).toBe("ambiguous");
		store.close();
		store = new SqliteOutboundDedupStore(join(root, "outbound.db"));
		expect(
			await make().handle({
				...request,
				body: { ...request.body, idempotencyKey: "automatic" },
			}),
		).toMatchObject({ status: "ambiguous", reason: "prior_attempt_unproven" });
		expect(send).toHaveBeenCalledTimes(1);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("does not trust delivery context supplied in an outbound body", async () => {
	const root = mkdtempSync(join(tmpdir(), "outbound-context-"));
	const store = new SqliteOutboundDedupStore(join(root, "outbound.db"));
	const send = vi.fn(async () => "message");
	const handler = new CodexLeadOutboundHandler({
		store,
		send,
		expectedApiToken: "test",
	});
	try {
		for (const key of ["first", "second"]) {
			const body = {
				projectName: "project",
				leadId: "lead",
				channelId: "thread",
				text: "hello",
				nonce: "nonce",
				idempotencyKey: key,
				deliveryContext: "forged",
			};
			expect(
				(await handler.handle({ providedToken: "test", body })).status,
			).toBe("sent");
		}
		expect(send).toHaveBeenCalledTimes(2);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteOutboundDedupStore } from "../../lead-backends/codex/SqliteOutboundDedupStore.js";
import { executeDiscordAttachmentSend } from "../discord-attachments.js";

const roots: string[] = [],
	stores: SqliteOutboundDedupStore[] = [];
function open(path?: string) {
	const root = mkdtempSync(join(tmpdir(), "fly2519-attachment-receipt-"));
	roots.push(root);
	const dbPath = path ?? join(root, "outbound.db");
	const store = new SqliteOutboundDedupStore(dbPath);
	stores.push(store);
	return { store, dbPath };
}
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function fixture(store: SqliteOutboundDedupStore) {
	return {
		projectName: "flywheel",
		leadId: "honey",
		activationId: "activation-1",
		requestId: "123e4567-e89b-42d3-a456-426614174000",
		threadId: "111111111111111111",
		text: "report",
		files: [
			{
				handle: "artifact-1",
				data: Buffer.from("hello"),
				mimeType: "text/plain",
			},
		],
		botToken: "PRIVATE_TOKEN",
		secrets: [],
		signal: new AbortController().signal,
		assertCurrent: vi.fn(),
		receipts: store.operationReceipts,
		fetchImpl: vi.fn<typeof fetch>(async () =>
			Response.json({
				id: "222222222222222222",
				channel_id: "111111111111111111",
			}),
		),
	};
}
it("replays a persisted message receipt after reopening SQLite and never resends", async () => {
	const { store, dbPath } = open();
	const f = fixture(store);
	expect(await executeDiscordAttachmentSend(f)).toMatchObject({
		status: "succeeded",
		data: { messageId: "222222222222222222" },
	});
	store.close();
	stores.splice(stores.indexOf(store), 1);
	const reopened = open(dbPath).store;
	const replay = await executeDiscordAttachmentSend({
		...f,
		receipts: reopened.operationReceipts,
		activationId: "activation-2",
	});
	expect(replay).toMatchObject({
		status: "succeeded",
		data: { messageId: "222222222222222222" },
	});
	expect(f.fetchImpl).toHaveBeenCalledOnce();
});
it("binds UUID to file bytes, MIME, order, handles and text", async () => {
	const f = fixture(open().store);
	f.files.push({
		handle: "artifact-2",
		data: Buffer.from("second"),
		mimeType: "text/plain",
	});
	await executeDiscordAttachmentSend(f);
	for (const patch of [
		{ text: "changed" },
		{ files: [...f.files].reverse() },
		{ files: [{ ...f.files[0]!, data: Buffer.from("changed") }] },
		{ files: [{ ...f.files[0]!, mimeType: "application/json" }] },
		{ files: [{ ...f.files[0]!, handle: "artifact-2" }] },
	])
		expect(
			await executeDiscordAttachmentSend({ ...f, ...patch }),
		).toMatchObject({ status: "rejected", errorCode: "input_digest_conflict" });
	expect(f.fetchImpl).toHaveBeenCalledOnce();
});
it("receipt-only without a receipt neither authorizes a send nor creates a row", async () => {
	const f = fixture(open().store);
	expect(
		await executeDiscordAttachmentSend({ ...f, receiptOnly: true }),
	).toMatchObject({ status: "unknown" });
	expect(f.fetchImpl).not.toHaveBeenCalled();
	expect(
		f.receipts.get({
			projectName: f.projectName,
			leadId: f.leadId,
			operationId: "discord.message.attachments.send",
			requestId: f.requestId,
		}),
	).toBeUndefined();
});
it("claims one concurrent send and preserves unknown on interrupted provider work", async () => {
	const f = fixture(open().store),
		controller = new AbortController();
	f.fetchImpl.mockImplementation(() => new Promise(() => {}));
	const pending = executeDiscordAttachmentSend({
		...f,
		signal: controller.signal,
	});
	await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
	expect(await executeDiscordAttachmentSend(f)).toMatchObject({
		status: "unknown",
	});
	controller.abort();
	expect(await pending).toMatchObject({ status: "unknown" });
	expect(
		await executeDiscordAttachmentSend({ ...f, activationId: "activation-2" }),
	).toMatchObject({ status: "unknown" });
	expect(f.fetchImpl).toHaveBeenCalledOnce();
});
it("current authorization is required even for a successful replay", async () => {
	const f = fixture(open().store);
	await executeDiscordAttachmentSend(f);
	f.assertCurrent.mockImplementation(() => {
		throw new Error("PRIVATE_TOKEN");
	});
	expect(await executeDiscordAttachmentSend(f)).toMatchObject({
		status: "rejected",
		errorCode: "discord_attachment_scope_denied",
	});
	expect(f.fetchImpl).toHaveBeenCalledOnce();
});

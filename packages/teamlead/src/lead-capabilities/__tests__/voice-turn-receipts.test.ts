import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { LeadCapabilityBroker } from "../broker.js";

const scope = {
	projectName: "flywheel",
	leadId: "product",
	activationId: "voice:session",
};
const request = {
	schemaVersion: 1 as const,
	operationId: "discord.thread.reply",
	requestId: "123e4567-e89b-42d3-a456-426614174000",
	input: { threadId: "123", text: "hello" },
};
it.each(["succeeded", "unknown"] as const)(
	"durably associates current-turn replay of older %s receipt without executing again",
	async (state) => {
		const root = mkdtempSync(join(tmpdir(), "voice-turn-receipts-"));
		const path = join(root, "journal.db");
		let store = new SqliteJournalStore(path);
		let entryId = "entry-first";
		const execute = vi.fn(async () =>
			state === "succeeded"
				? {
						status: "succeeded" as const,
						providerRef: "message:456",
						data: {
							threadId: "123",
							messageId: "456",
							receiptId: "receipt",
							observedAt: "2026-09-26T00:00:00.000Z",
						},
					}
				: { status: "unknown" as const, errorCode: "provider_timeout" },
		);
		const broker = new LeadCapabilityBroker({
			...scope,
			receipts: store.operationReceipts,
			secrets: [],
			allowedOperationIds: () => new Set([request.operationId]),
			assertCurrent: async () => {},
			deliveryContext: () => ({ id: entryId, assertCurrent: () => {} }),
			handlers: new Map([
				[request.operationId, { authorize: async () => {}, execute }],
			]),
			targetLocks: {
				actor: "voice",
				acquire: async () => ({
					status: "acquired",
					fence: "123e4567-e89b-42d3-a456-426614174001",
				}),
				markDispatched: async () => true,
				release: async () => {},
				cancel: async () => {},
			},
		});
		try {
			expect((await broker.execute(request)).status).toBe(state);
			entryId = "entry-repeat";
			expect((await broker.execute(request)).status).toBe(state);
			expect(execute).toHaveBeenCalledOnce();
			await broker.close();
			store.close();
			store = new SqliteJournalStore(path);
			for (const id of ["entry-first", "entry-repeat"])
				expect(
					store.operationReceipts.listByDelivery({ ...scope, entryId: id }),
				).toEqual([
					expect.objectContaining({ requestId: request.requestId, state }),
				]);
			expect(
				store.operationReceipts.listByDelivery({
					...scope,
					activationId: "voice:other",
					entryId,
				}),
			).toEqual([]);
			expect(
				store.operationReceipts.listByDelivery({
					...scope,
					entryId: "missing",
				}),
			).toEqual([]);
		} finally {
			await broker.close();
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

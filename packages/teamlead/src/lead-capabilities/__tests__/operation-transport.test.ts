import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { requestLeadOperation } from "flywheel-comm/lead-operation-client";
import { expect, it, vi } from "vitest";
import { createLeadCapabilityProxy } from "../../lead-backends/codex/lead-capability-proxy.js";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { LeadCapabilityBroker } from "../broker.js";
import { LeadCapabilitySocket } from "../broker-socket.js";
import { getLeadCapability } from "../catalog.js";
import { createLeadCapabilityManifest } from "../manifest.js";

it("shares durable deduplication across native MCP and CLI client reconnects", async () => {
	const dir = mkdtempSync("/tmp/lead-transport-");
	const store = new SqliteJournalStore(join(dir, "journal.db"));
	const socketPath = join(dir, "s");
	const request = {
		schemaVersion: 1 as const,
		operationId: "discord.thread.reply",
		requestId: "123e4567-e89b-42d3-a456-426614174000",
		input: { threadId: "123", text: "hello" },
	};
	const execute = vi.fn(async () => ({
		status: "succeeded" as const,
		providerRef: "456",
		data: {
			threadId: "123",
			messageId: "456",
			receiptId: "r",
			observedAt: "2026-09-13T00:00:00.000Z",
		},
	}));
	const broker = new LeadCapabilityBroker({
		projectName: "flywheel",
		leadId: "product",
		activationId: "a1",
		receipts: store.operationReceipts,
		allowedOperationIds: () => new Set([request.operationId]),
		assertCurrent: async () => {},
		handlers: new Map([
			[request.operationId, { authorize: async () => {}, execute }],
		]),
		secrets: ["CANARY_SECRET"],
	});
	const socket = new LeadCapabilitySocket({
		socketPath,
		dispatch: (request) => broker.execute(request),
	});
	const manifest = createLeadCapabilityManifest({
		projectName: "flywheel",
		leadId: "product",
		identityDigest: "a".repeat(64),
		backend: "codex-app-server",
		profile: "full-access",
		activationId: "a1",
		sourceRevision: "abc",
		operations: [getLeadCapability(request.operationId)!],
		ruleSources: [],
		skillSources: [],
		integrations: [],
	});
	try {
		await socket.listen();
		for (let i = 0; i < 2; i++) {
			const server = createLeadCapabilityProxy({ manifest, socketPath });
			const client = new Client({ name: "test", version: "1" });
			const [a, b] = InMemoryTransport.createLinkedPair();
			try {
				await Promise.all([server.connect(a), client.connect(b)]);
				const result = await client.callTool({
					name: "lead_operation",
					arguments: request,
				});
				expect(result.isError).toBe(false);
				const content = result.content as { type: string; text: string }[];
				expect(content[0]?.type).toBe("text");
				expect(JSON.parse(content[0]!.text)).toMatchObject({
					requestId: request.requestId,
					status: "succeeded",
					resourceRefs: ["456"],
				});
				expect(JSON.stringify(result)).not.toContain("CANARY_SECRET");
			} finally {
				await client.close();
				await server.close();
			}
		}
		expect(await requestLeadOperation(socketPath, request)).toEqual({
			requestId: request.requestId,
			status: "succeeded",
			resourceRefs: ["456"],
		});
		expect(
			(
				await requestLeadOperation(socketPath, {
					...request,
					input: { ...request.input, text: "changed" },
				})
			).errorCode,
		).toBe("input_digest_conflict");
		expect(execute).toHaveBeenCalledTimes(1);
	} finally {
		await socket.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

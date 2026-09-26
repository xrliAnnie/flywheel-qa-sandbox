import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { createLeadCapabilityProxy } from "../../lead-backends/codex/lead-capability-proxy.js";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { LeadCapabilityBroker } from "../broker.js";
import { getLeadCapability } from "../catalog.js";
import { createLeadCapabilityManifest } from "../manifest.js";

const requestId = "a0000000-0000-4000-8000-000000000001";
const activationId = "voice:b0000000-0000-4000-8000-000000000001";
const request = (operationId: string) => ({
	schemaVersion: 1 as const,
	operationId,
	requestId,
	input: { resourceId: "7" },
});
const manifest = createLeadCapabilityManifest({
	projectName: "flywheel",
	leadId: "eng",
	identityDigest: "a".repeat(64),
	backend: "codex-app-server",
	profile: "full-access",
	activationId,
	sourceRevision: "abc",
	operations: [getLeadCapability("discord.thread.read")!],
	ruleSources: [],
	skillSources: [],
	integrations: [],
});
it.each(["bridge.merge", "bridge.terminate"])(
	"routes voice-only %s denial through the trusted broker and reports only confirmed Lead recording",
	async (operationId) => {
		const journal = new SqliteJournalStore(":memory:");
		const record = vi.fn(async () => "lead-event:123");
		const authorize = vi.fn(async () => {}),
			execute = vi.fn(async () => ({ status: "succeeded" as const }));
		const broker = new LeadCapabilityBroker({
			projectName: "flywheel",
			leadId: "eng",
			activationId,
			receipts: journal.operationReceipts,
			allowedOperationIds: () => new Set(manifest.operationIds),
			assertCurrent: async () => {},
			secrets: [],
			handlers: new Map([[operationId, { authorize, execute }]]),
			voiceDenials: { leadName: "eng", record },
		});
		const dispatch = vi.fn(async (_socket, envelope) =>
			broker.execute(envelope),
		);
		const server = createLeadCapabilityProxy({
			manifest,
			socketPath: "/tmp/voice/broker.sock",
			requestClient: dispatch,
		});
		const client = new Client({ name: "test", version: "1" });
		const [a, b] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(a), client.connect(b)]);
		try {
			const result = await client.callTool({
				name: "lead_operation",
				arguments: request(operationId),
			});
			expect(result.isError).toBe(true);
			const body = JSON.parse(
				(result.content as Array<{ text: string }>)[0]!.text,
			);
			expect(body).toMatchObject({
				status: "rejected",
				errorCode: "founder_only_denied",
				data: {
					spokenText: "这个只能你本人做，我已经记给 eng",
					leadReceiptId: "lead-event:123",
				},
			});
			expect(dispatch).toHaveBeenCalledTimes(1);
			expect(record).toHaveBeenCalledWith({ requestId, operationId });
			expect(authorize).not.toHaveBeenCalled();
			expect(execute).not.toHaveBeenCalled();
		} finally {
			await client.close();
			await server.close();
			await broker.close();
			journal.close();
		}
	},
);
it("classifies missing, unknown, and reserved operations separately without inventing a failed inbox receipt", async () => {
	const journal = new SqliteJournalStore(":memory:");
	const record = vi.fn(async () => {
		throw new Error("inbox_down");
	});
	const broker = new LeadCapabilityBroker({
		projectName: "flywheel",
		leadId: "eng",
		activationId,
		receipts: journal.operationReceipts,
		allowedOperationIds: () => new Set(["discord.thread.read"]),
		assertCurrent: async () => {},
		secrets: [],
		handlers: new Map(),
		voiceDenials: { leadName: "eng", record },
	});
	try {
		expect(await broker.execute(request("browser.click"))).toMatchObject({
			errorCode: "unavailable",
			data: { spokenText: "这场没开这个能力" },
		});
		expect(await broker.execute(request("not.real"))).toMatchObject({
			errorCode: "invalid",
		});
		expect(record).not.toHaveBeenCalled();
		expect(await broker.execute(request("bridge.merge"))).toMatchObject({
			errorCode: "founder_only_denied",
			data: { spokenText: "这个只能你本人做" },
		});
		expect(record).toHaveBeenCalledTimes(1);
	} finally {
		await broker.close();
		journal.close();
	}
});

it("never accepts an outside-manifest voice success as operation authority", async () => {
	const server = createLeadCapabilityProxy({
		manifest,
		socketPath: "/tmp/voice/broker.sock",
		requestClient: async (_socket, envelope) => ({
			requestId: envelope.requestId,
			status: "succeeded",
			resourceRefs: [],
		}),
	});
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	try {
		const result = await client.callTool({
			name: "lead_operation",
			arguments: request("bridge.merge"),
		});
		expect(result.isError).toBe(true);
		expect(
			JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
				.errorCode,
		).toBe("invalid_broker_result");
	} finally {
		await client.close();
		await server.close();
	}
});
it("preserves resident denial results without installing voice reporting", async () => {
	const journal = new SqliteJournalStore(":memory:");
	const broker = new LeadCapabilityBroker({
		projectName: "flywheel",
		leadId: "eng",
		activationId: "resident",
		receipts: journal.operationReceipts,
		allowedOperationIds: () => new Set(),
		assertCurrent: async () => {},
		secrets: [],
		handlers: new Map(),
	});
	try {
		expect(await broker.execute(request("bridge.merge"))).toEqual({
			requestId,
			status: "rejected",
			resourceRefs: [],
			errorCode: "reserved_operation",
		});
		expect(await broker.execute(request("not.real"))).toEqual({
			requestId,
			status: "rejected",
			resourceRefs: [],
			errorCode: "unknown_operation",
		});
	} finally {
		await broker.close();
		journal.close();
	}
});

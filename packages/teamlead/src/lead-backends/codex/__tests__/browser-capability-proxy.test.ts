import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { getLeadCapability } from "../../../lead-capabilities/catalog.js";
import { createLeadCapabilityManifest } from "../../../lead-capabilities/manifest.js";
import {
	browserFacadeSchemaDigest,
	createBrowserCapabilityProxy,
} from "../browser-capability-proxy.js";

const manifest = createLeadCapabilityManifest({
	projectName: "flywheel",
	leadId: "product",
	identityDigest: "a".repeat(64),
	backend: "codex-app-server",
	profile: "full-access",
	activationId: "activation",
	browserGeneration: "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	sourceRevision: "sha",
	operations: [
		getLeadCapability("browser.click")!,
		getLeadCapability("browser.list_pages")!,
	],
	ruleSources: [],
	skillSources: [],
	integrations: [
		{
			id: "browser",
			version: "1.9.0",
			toolSchemaDigest: browserFacadeSchemaDigest(["click", "list_pages"]),
		},
	],
});
it("advertises only available native tools and forwards through the typed broker with bound generation", async () => {
	const requestClient = vi.fn(
		async (_socket: string, request: { requestId: string }) => ({
			requestId: request.requestId,
			status: "succeeded",
			resourceRefs: [],
			data: { content: [{ type: "text", text: "page" }] },
		}),
	);
	const server = createBrowserCapabilityProxy({
		manifest,
		socketPath: "/tmp/activation/broker.sock",
		requestClient,
	});
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	try {
		const tools = (await client.listTools()).tools;
		expect(tools.map((t) => t.name).sort()).toEqual(["click", "list_pages"]);
		expect(JSON.stringify(tools)).not.toMatch(/filePath|carrierClaim/);
		expect(
			await client.callTool({ name: "click", arguments: { uid: "1" } }),
		).toMatchObject({ content: [{ type: "text", text: "page" }] });
		expect(requestClient).toHaveBeenCalledWith(
			"/tmp/activation/broker.sock",
			expect.objectContaining({
				schemaVersion: 1,
				operationId: "browser.click",
				input: {
					generation: manifest.browserGeneration,
					arguments: { uid: "1" },
				},
			}),
		);
		expect(
			(
				await client.callTool({
					name: "upload_file",
					arguments: { filePaths: ["/etc/passwd"] },
				})
			).isError,
		).toBe(true);
		expect(requestClient).toHaveBeenCalledOnce();
	} finally {
		await client.close();
		await server.close();
	}
});
it("rejects missing generation or modified manifest instead of attaching a bare upstream MCP", () => {
	for (const bad of [
		{ ...manifest, browserGeneration: undefined },
		{ ...manifest, manifestDigest: "c".repeat(64) },
	])
		expect(() =>
			createBrowserCapabilityProxy({
				manifest: bad,
				socketPath: "/tmp/b.sock",
			}),
		).toThrow(/browser|manifest/);
});

it("runs native facade through real Unix socket, broker and SQLite receipt before worker dispatch", async () => {
	const { mkdtempSync, mkdirSync, rmSync, realpathSync } = await import(
		"node:fs"
	);
	const { join } = await import("node:path");
	const { LeadCapabilitySocket } = await import(
		"../../../lead-capabilities/broker-socket.js"
	);
	const { LeadCapabilityBroker } = await import(
		"../../../lead-capabilities/broker.js"
	);
	const { SqliteJournalStore } = await import("../SqliteJournalStore.js");
	const { LeadArtifactStore } = await import(
		"../../../lead-capabilities/artifacts.js"
	);
	const { createBrowserHandlers } = await import(
		"../../../lead-capabilities/handlers/browser.js"
	);
	const { requestLeadOperation } = await import(
		"flywheel-comm/lead-operation-client"
	);
	const root = realpathSync(mkdtempSync("/tmp/fly2519-browser-wire-")),
		artifactRoot = join(root, "artifacts"),
		socketPath = join(root, "broker.sock");
	mkdirSync(artifactRoot, { mode: 0o700 });
	const journal = new SqliteJournalStore(join(root, "journal.db")),
		artifacts = new LeadArtifactStore({
			projectRoot: root,
			artifactRoot,
			assertCurrent() {},
		});
	let lastRequest: any;
	const call = vi.fn(async () => {
		expect(
			journal.operationReceipts.get({
				projectName: "flywheel",
				leadId: "product",
				operationId: "browser.click",
				requestId: lastRequest.requestId,
			})?.state,
		).toBe("dispatched");
		return { result: { content: [{ type: "text", text: "clicked" }] } };
	});
	const handlers = createBrowserHandlers({
		activationId: manifest.activationId,
		generation: manifest.browserGeneration!,
		worker: { call },
		workerArtifactRoot: join(root, "private", "artifacts"),
		store: artifacts,
		assertCurrent() {},
	});
	const broker = new LeadCapabilityBroker({
		projectName: "flywheel",
		leadId: "product",
		activationId: manifest.activationId,
		receipts: journal.operationReceipts,
		allowedOperationIds: () => new Set(manifest.operationIds),
		assertCurrent: async () => {},
		handlers,
		secrets: ["PARENT_SECRET"],
	});
	const socket = new LeadCapabilitySocket({
		socketPath,
		dispatch: (request) => broker.execute(request),
	});
	await socket.listen();
	const proxy = createBrowserCapabilityProxy({
			manifest,
			socketPath,
			requestClient: async (path, request) => {
				lastRequest = request;
				return requestLeadOperation(path, request);
			},
		}),
		client = new Client({ name: "test", version: "1" }),
		[a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([proxy.connect(a), client.connect(b)]);
	try {
		expect(
			await client.callTool({ name: "click", arguments: { uid: "1" } }),
		).toMatchObject({ content: [{ type: "text", text: "clicked" }] });
		expect((await requestLeadOperation(socketPath, lastRequest)).status).toBe(
			"succeeded",
		);
		expect(call).toHaveBeenCalledOnce();
		const foreign = {
			...lastRequest,
			requestId: "cccc0000-cccc-4ccc-8ccc-cccccccccccc",
			input: {
				...lastRequest.input,
				generation: "bbbb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			},
		};
		expect((await requestLeadOperation(socketPath, foreign)).status).toBe(
			"rejected",
		);
		expect(call).toHaveBeenCalledOnce();
		call.mockRejectedValueOnce(Error("lost output"));
		expect(
			(await client.callTool({ name: "click", arguments: { uid: "2" } }))
				.isError,
		).toBe(true);
		expect((await requestLeadOperation(socketPath, lastRequest)).status).toBe(
			"unknown",
		);
		expect(call).toHaveBeenCalledTimes(2);
	} finally {
		await client.close();
		await proxy.close();
		await socket.close();
		artifacts.close();
		journal.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("preserves a definite broker rejection in the native browser facade", async () => {
	const server = createBrowserCapabilityProxy({
		manifest,
		socketPath: "/tmp/broker.sock",
		requestClient: async (_socket, request) => ({
			requestId: request.requestId,
			status: "rejected",
			resourceRefs: [],
			errorCode: "browser_tool_denied",
		}),
	});
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	try {
		const result = await client.callTool({ name: "list_pages", arguments: {} });
		expect(
			JSON.parse((result.content as Array<{ text: string }>)[0]!.text),
		).toMatchObject({ status: "rejected", errorCode: "browser_tool_denied" });
	} finally {
		await client.close();
		await server.close();
	}
});

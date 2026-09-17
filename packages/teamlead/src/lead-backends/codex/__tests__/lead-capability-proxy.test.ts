import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { getLeadCapability } from "../../../lead-capabilities/catalog.js";
import { createLeadCapabilityManifest } from "../../../lead-capabilities/manifest.js";
import {
	createLeadCapabilityProxy,
	loadLeadCapabilityProxyConfig,
} from "../lead-capability-proxy.js";

const manifest = createLeadCapabilityManifest({
	projectName: "flywheel",
	leadId: "product",
	identityDigest: "a".repeat(64),
	backend: "codex-app-server",
	profile: "full-access",
	activationId: "activation",
	sourceRevision: "abc",
	operations: [getLeadCapability("discord.thread.read")!],
	ruleSources: [],
	skillSources: [],
	integrations: [],
});
const request = {
	schemaVersion: 1,
	operationId: "discord.thread.read",
	requestId: "123e4567-e89b-42d3-a456-426614174000",
	input: { threadId: "123", limit: 10 },
};
const result = {
	requestId: request.requestId,
	status: "succeeded" as const,
	resourceRefs: [],
	data: {
		threadId: "123",
		messages: [],
		nextCursor: null,
		receiptId: "r",
		observedAt: "2026-09-13T00:00:00.000Z",
	},
};
async function connected(requestClient = vi.fn(async () => result)) {
	const server = createLeadCapabilityProxy({
		manifest,
		socketPath: "/tmp/activation/broker.sock",
		requestClient,
	});
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	return {
		client,
		requestClient,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}
describe("native lead capability MCP proxy", () => {
	it("lists only the explicit manifest operations as concrete discriminated input contracts", async () => {
		const f = await connected();
		try {
			const tools = (await f.client.listTools()).tools;
			expect(tools.map((tool) => tool.name)).toEqual(["lead_operation"]);
			const schema = JSON.stringify(tools[0]!.inputSchema);
			expect(schema).toContain("discord.thread.read");
			expect(schema).toContain("threadId");
			expect(schema).toContain("maximum");
			expect(schema).not.toContain("discord.thread.reply");
		} finally {
			await f.close();
		}
	});
	it("dispatches exact request envelope and preserves the same requestId across proxy recreations", async () => {
		const dispatch = vi.fn(async () => result);
		for (let i = 0; i < 2; i++) {
			const f = await connected(dispatch);
			try {
				const response = await f.client.callTool({
					name: "lead_operation",
					arguments: request,
				});
				expect(response.isError).not.toBe(true);
			} finally {
				await f.close();
			}
		}
		expect(dispatch).toHaveBeenCalledTimes(2);
		for (const call of dispatch.mock.calls)
			expect(call).toEqual(["/tmp/activation/broker.sock", request]);
	});
	it("rejects unknown named tools, undeclared operations, invalid UUID and extra fields before dispatch", async () => {
		const f = await connected();
		try {
			for (const args of [
				{ ...request, operationId: "discord.thread.reply" },
				{ ...request, requestId: "bad" },
				{ ...request, input: { ...request.input, token: "secret" } },
				{ ...request, claim: "secret" },
			])
				expect(
					(await f.client.callTool({ name: "lead_operation", arguments: args }))
						.isError,
				).toBe(true);
			expect(
				(await f.client.callTool({ name: "raw_http", arguments: request }))
					.isError,
			).toBe(true);
			expect(f.requestClient).not.toHaveBeenCalled();
		} finally {
			await f.close();
		}
	});
	it("fails closed for reserved unknown duplicate or mismatched manifest versions", () => {
		for (const change of [
			{ operationIds: ["bridge.ship"] },
			{ operationIds: ["provider.new"] },
			{ operationIds: ["discord.thread.read", "discord.thread.read"] },
			{ bundleVersion: 3 },
		])
			expect(() =>
				createLeadCapabilityProxy({
					manifest: { ...manifest, ...change } as typeof manifest,
					socketPath: "/tmp/broker.sock",
				}),
			).toThrow();
	});
	it("returns stable transport errors without raw provider or credential details", async () => {
		const f = await connected(
			vi.fn(async () => {
				throw new Error("CANARY_TOKEN");
			}),
		);
		try {
			const response = await f.client.callTool({
				name: "lead_operation",
				arguments: request,
			});
			expect(response.isError).toBe(true);
			expect(JSON.stringify(response)).not.toContain("CANARY_TOKEN");
			expect(JSON.stringify(response)).toContain("unknown");
			expect(JSON.stringify(response)).toContain(request.requestId);
		} finally {
			await f.close();
		}
	});
	it("requires only explicit public endpoint coordinates and does not infer legacy credentials", () => {
		expect(() =>
			loadLeadCapabilityProxyConfig({ BRIDGE_API_TOKEN: "CANARY" }),
		).toThrow();
	});
});

it("keeps malformed post-dispatch results unknown with the original requestId", async () => {
	const f = await connected(
		vi.fn(async () => ({
			...result,
			requestId: "123e4567-e89b-42d3-a456-426614174001",
		})),
	);
	try {
		const response = await f.client.callTool({
			name: "lead_operation",
			arguments: request,
		});
		expect(JSON.stringify(response)).toContain("unknown");
		expect(JSON.stringify(response)).toContain(request.requestId);
	} finally {
		await f.close();
	}
});

it("loads a verified public manifest without forwarding unrelated environment", () => {
	const dir = mkdtempSync(join(tmpdir(), "lead-proxy-"));
	try {
		const path = join(dir, "manifest.json");
		writeFileSync(path, JSON.stringify(manifest));
		const config = loadLeadCapabilityProxyConfig({
			FLYWHEEL_LEAD_CAPABILITY_SOCKET: "/tmp/broker.sock",
			FLYWHEEL_LEAD_CAPABILITY_MANIFEST: path,
			BRIDGE_API_TOKEN: "CANARY",
		});
		expect(config.manifest).toEqual(manifest);
		expect(JSON.stringify(config)).not.toContain("CANARY");
		writeFileSync(
			path,
			JSON.stringify({ ...manifest, activationId: "tampered" }),
		);
		expect(() =>
			loadLeadCapabilityProxyConfig({
				FLYWHEEL_LEAD_CAPABILITY_SOCKET: "/tmp/broker.sock",
				FLYWHEEL_LEAD_CAPABILITY_MANIFEST: path,
			}),
		).toThrow("invalid_capability_manifest");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("retains runner tool names while forwarding only UUID-bound broker operations", async () => {
	const names = [
		"start_runner",
		"list_runners",
		"get_runner_status",
		"read_runner_tmux",
		"send_runner",
		"respond_runner",
	];
	const dispatch = vi.fn(
		async (_path: string, input: { requestId: string }) => ({
			requestId: input.requestId,
			status: "unknown" as const,
			resourceRefs: [],
		}),
	);
	const server = createLeadCapabilityProxy({
		manifest: createLeadCapabilityManifest({
			...manifest,
			operations: names.map((name) => getLeadCapability(name)!),
		}),
		socketPath: "/tmp/activation/broker.sock",
		requestClient: dispatch,
	});
	const client = new Client({ name: "runner-test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	try {
		expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
			"lead_operation",
			...names,
		]);
		await client.callTool({
			name: "send_runner",
			arguments: {
				requestId: request.requestId,
				executionId: request.requestId,
				text: "hello",
				idempotencyKey: "same-business-key",
			},
		});
		expect(dispatch).toHaveBeenCalledWith("/tmp/activation/broker.sock", {
			schemaVersion: 1,
			operationId: "send_runner",
			requestId: request.requestId,
			input: {
				executionId: request.requestId,
				text: "hello",
				idempotencyKey: "same-business-key",
			},
		});
		await client.callTool({
			name: "respond_runner",
			arguments: { questionId: request.requestId, answer: "yes" },
		});
		expect(dispatch).toHaveBeenCalledOnce();
	} finally {
		await client.close();
		await server.close();
	}
});

it("advertises and dispatches receipt-only XHS input while rejecting mixed content", async () => {
	const xhsManifest = createLeadCapabilityManifest({
		projectName: "flywheel",
		leadId: "product",
		identityDigest: "a".repeat(64),
		backend: "codex-app-server",
		profile: "full-access",
		activationId: "activation",
		sourceRevision: "abc",
		operations: [getLeadCapability("xiaohongshu.like_feed")!],
		ruleSources: [],
		skillSources: [],
		integrations: [],
	});
	const dispatch = vi.fn(async () => ({
		...result,
		data: {
			result: { attemptId: request.requestId, state: "succeeded" },
			untrusted: true,
			receiptId: "123e4567-e89b-42d3-a456-426614174001",
			observedAt: "2026-09-15T08:00:00.000Z",
		},
	}));
	const server = createLeadCapabilityProxy({
		manifest: xhsManifest,
		socketPath: "/tmp/activation/broker.sock",
		requestClient: dispatch,
	});
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(a), client.connect(b)]);
	const input = {
		proposalId: request.requestId,
		receiptId: "123e4567-e89b-42d3-a456-426614174001",
		expectedContentDigest: "a".repeat(64),
	};
	const xhsRequest = {
		...request,
		operationId: "xiaohongshu.like_feed",
		input,
	};
	try {
		const schema = JSON.stringify(
			(await client.listTools()).tools[0]!.inputSchema,
		);
		expect(schema).toContain("expectedContentDigest");
		expect(schema).toContain("anyOf");
		expect(schema).not.toContain("xsec_token");
		expect(
			(await client.callTool({ name: "lead_operation", arguments: xhsRequest }))
				.isError,
		).not.toBe(true);
		expect(dispatch).toHaveBeenCalledWith(
			"/tmp/activation/broker.sock",
			xhsRequest,
		);
		expect(
			(
				await client.callTool({
					name: "lead_operation",
					arguments: {
						...xhsRequest,
						input: { ...input, feed_id: "replacement" },
					},
				})
			).isError,
		).toBe(true);
		expect(dispatch).toHaveBeenCalledTimes(1);
	} finally {
		await client.close();
		await server.close();
	}
});

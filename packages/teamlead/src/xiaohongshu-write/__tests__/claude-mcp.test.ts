import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";
import { createClaudeXhsWriteMcp } from "../claude-mcp.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
async function setup(injected = true) {
	const state = {
		calls: [] as unknown[],
		output: { state: "revoked" } as unknown,
	};
	const server = createClaudeXhsWriteMcp({
		env: {},
		...(injected
			? {
					readClient: {
						async read(action: string, input: unknown) {
							state.calls.push({ action, input });
							return state.output;
						},
					},
					client: {
						async call(action: string, input: unknown) {
							state.calls.push({ action, input });
							return state.output;
						},
					},
				}
			: {}),
	});
	const client = new Client({ name: "fixture", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	await client.connect(b);
	cleanup.push(async () => {
		await client.close();
		await server.close();
	});
	return { client, state };
}
it("lists exactly four receipt-based tools and forwards the fixed envelope", async () => {
	const s = await setup();
	const tools = await s.client.listTools();
	expect(
		tools.tools
			.filter((tool) => tool.name.startsWith("xiaohongshu.write."))
			.map((tool) => tool.name)
			.sort(),
	).toEqual([
		"xiaohongshu.write.cancel",
		"xiaohongshu.write.execute",
		"xiaohongshu.write.prepare",
		"xiaohongshu.write.status",
	]);
	const args = { requestId: randomUUID(), input: { proposalId: randomUUID() } };
	const result = await s.client.callTool({
		name: "xiaohongshu.write.cancel",
		arguments: args,
	});
	expect(result.isError).not.toBe(true);
	expect(s.state.calls).toEqual([{ action: "cancel", input: args }]);
});
it("rejects arbitrary methods, forged approval, extra receipt content and secret-bearing results", async () => {
	const s = await setup();
	for (const request of [
		{ name: "publish_content", arguments: {} },
		{
			name: "xiaohongshu.write.cancel",
			arguments: {
				requestId: randomUUID(),
				input: { proposalId: randomUUID(), approved: true },
			},
		},
		{
			name: "xiaohongshu.write.execute",
			arguments: {
				requestId: randomUUID(),
				input: {
					proposalId: randomUUID(),
					receiptId: randomUUID(),
					expectedContentDigest: "a".repeat(64),
					operationId: "xiaohongshu.like_feed",
					content: "changed",
				},
			},
		},
	])
		expect((await s.client.callTool(request)).isError).toBe(true);
	expect(s.state.calls).toEqual([]);
	s.state.output = { state: "revoked", xsec_token: "private" };
	const result = await s.client.callTool({
		name: "xiaohongshu.write.cancel",
		arguments: { requestId: randomUUID(), input: { proposalId: randomUUID() } },
	});
	expect(result.isError).toBe(true);
	expect(JSON.stringify(result)).not.toContain("private");
});
it("keeps tools discoverable but refuses writes without launch lease credentials", async () => {
	const s = await setup(false);
	expect((await s.client.listTools()).tools).toHaveLength(12);
	const result = await s.client.callTool({
		name: "xiaohongshu.write.cancel",
		arguments: { requestId: randomUUID(), input: { proposalId: randomUUID() } },
	});
	expect(result.isError).toBe(true);
	expect(JSON.stringify(result)).toContain("founder_write_gate_absent");
});

it("exposes eight reads, preserves untrusted handles and renders QR as an image", async () => {
	const s = await setup();
	const tools = (await s.client.listTools()).tools;
	expect(tools).toHaveLength(12);
	expect(tools.some((tool) => tool.name === "xiaohongshu.user_profile")).toBe(
		false,
	);
	const handle = randomUUID();
	s.state.output = { text: JSON.stringify({ resourceHandle: handle }) };
	const read = await s.client.callTool({
		name: "xiaohongshu.list_feeds",
		arguments: { requestId: randomUUID(), input: {} },
	});
	expect(read.isError).not.toBe(true);
	expect(JSON.stringify(read)).toContain(handle);
	expect(JSON.stringify(read)).toContain("untrusted");
	s.state.output = {
		loggedIn: false,
		image:
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9S8AAAAASUVORK5CYII=",
		expiresAt: Date.now() + 60000,
	};
	const qr = await s.client.callTool({
		name: "xiaohongshu.get_login_qrcode",
		arguments: { requestId: randomUUID(), input: {} },
	});
	expect(qr.isError).not.toBe(true);
	expect(qr.content).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: "image", mimeType: "image/png" }),
		]),
	);
	s.state.output = { ...(s.state.output as object), expiresAt: Date.now() - 1 };
	expect(
		(
			await s.client.callTool({
				name: "xiaohongshu.get_login_qrcode",
				arguments: { requestId: randomUUID(), input: {} },
			})
		).isError,
	).toBe(true);
});

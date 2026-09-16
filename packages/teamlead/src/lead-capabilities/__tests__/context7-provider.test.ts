import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { startContext7Provider } from "../context7-provider.js";

vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({ assertActivationCurrent: () => {} }),
}));
it("runs the real MCP SDK over a fixed bounded transport and invalidates calls on close", async () => {
	const snapshot = JSON.parse(
		readFileSync(
			resolve(
				"../../engineering/doc/FLY-2519-codex-lead-parity/upstream-context7-schema.json",
			),
			"utf8",
		),
	);
	const calls: Array<{ url: string; init: RequestInit }> = [];
	let stall = false,
		entered = () => {};
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const canceled = vi.fn();
	const fetchImpl = vi.fn(async (url, init) => {
		calls.push({ url: String(url), init: init! });
		if (init?.method === "GET") return new Response(null, { status: 405 });
		const request = JSON.parse(init!.body as string);
		if (!("id" in request)) return new Response(null, { status: 202 });
		if (stall && request.method === "tools/call") {
			entered();
			return new Response(new ReadableStream({ cancel: canceled }), {
				headers: { "content-type": "application/json" },
			});
		}
		const result =
			request.method === "initialize"
				? {
						protocolVersion: request.params.protocolVersion,
						capabilities: { tools: {} },
						serverInfo: { name: "Context7", version: "4.1.0" },
					}
				: request.method === "tools/list"
					? { tools: snapshot.tools }
					: { content: [{ type: "text", text: "Documentation" }] };
		return Response.json({ jsonrpc: "2.0", id: request.id, result });
	}) as typeof fetch;
	const provider = await startContext7Provider({
		env: { FLYWHEEL_PROJECT_NAME: "demo", FLYWHEEL_LEAD_ID: "eng" },
		activationId: "a1",
		apiKey: "KEY_CANARY",
		secrets: [],
		fetchImpl,
	});
	const context = {
		projectName: "demo",
		leadId: "eng",
		activationId: "a1",
		requestId: randomUUID(),
		signal: new AbortController().signal,
		assertCurrent: async () => {},
	};
	expect(
		(
			await provider.handlers
				.get("docs.lookup")!
				.execute({ libraryId: "/org/repo", query: "setup" }, context)
		).status,
	).toBe("succeeded");
	expect(
		calls.every(
			(c) =>
				c.url === "https://mcp.context7.com/mcp" && c.init.redirect === "error",
		),
	).toBe(true);
	expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
		"Bearer KEY_CANARY",
	);
	stall = true;
	const pending = provider.handlers
		.get("docs.lookup")!
		.execute(
			{ libraryId: "/org/repo", query: "setup" },
			{ ...context, requestId: randomUUID() },
		);
	await started;
	await provider.close();
	expect((await pending).status).toBe("unknown");
	expect(canceled).toHaveBeenCalled();
	const count = calls.length;
	expect(
		(
			await provider.handlers
				.get("docs.lookup")!
				.execute({ libraryId: "/org/repo", query: "setup" }, context)
		).status,
	).not.toBe("succeeded");
	expect(calls).toHaveLength(count);
	await provider.close();
});
it("rejects oversized startup responses and closes their stream", async () => {
	const cancel = vi.fn();
	const fetchImpl = vi.fn(
		async () =>
			new Response(new ReadableStream({ cancel }), {
				headers: {
					"content-type": "application/json",
					"content-length": "300000",
				},
			}),
	) as typeof fetch;
	await expect(
		startContext7Provider({
			env: { FLYWHEEL_PROJECT_NAME: "demo", FLYWHEEL_LEAD_ID: "eng" },
			activationId: "a1",
			secrets: [],
			fetchImpl,
		}),
	).rejects.toThrow();
	expect(cancel).toHaveBeenCalled();
});

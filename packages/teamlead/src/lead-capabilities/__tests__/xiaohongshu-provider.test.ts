import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { LeadArtifactStore } from "../artifacts.js";
import { startXiaohongshuProvider } from "../xiaohongshu-provider.js";

vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({ assertActivationCurrent: () => {} }),
}));
it("runs the real MCP SDK over a fixed bounded transport and invalidates calls on close", async () => {
	const snapshot = JSON.parse(
		readFileSync(
			resolve(
				"../../engineering/doc/FLY-2519-codex-lead-parity/upstream-xiaohongshu-mcp-schema.json",
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
						serverInfo: { name: "xiaohongshu-mcp", version: "2.0.0" },
					}
				: request.method === "tools/list"
					? { tools: snapshot.tools }
					: { content: [{ type: "text", text: "Documentation" }] };
		return Response.json({ jsonrpc: "2.0", id: request.id, result });
	}) as typeof fetch;
	const root = realpathSync(mkdtempSync(join(tmpdir(), "xhs-provider-")));
	const artifactRoot = join(root, "artifacts");
	mkdirSync(artifactRoot, { mode: 0o700 });
	const artifacts = new LeadArtifactStore({
		projectRoot: root,
		artifactRoot,
		assertCurrent: () => {},
	});
	try {
		const provider = await startXiaohongshuProvider({
			env: { FLYWHEEL_PROJECT_NAME: "demo", FLYWHEEL_LEAD_ID: "eng" },
			activationId: "a1",
			artifacts,
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
					.get("xiaohongshu.list_feeds")!
					.execute({}, context)
			).status,
		).toBe("succeeded");
		expect(
			calls.every(
				(c) =>
					c.url === "http://127.0.0.1:18060/mcp" && c.init.redirect === "error",
			),
		).toBe(true);
		expect(new Headers(calls[0]!.init.headers).get("authorization")).toBeNull();
		stall = true;
		const pending = provider.handlers
			.get("xiaohongshu.list_feeds")!
			.execute({}, { ...context, requestId: randomUUID() });
		await started;
		await provider.close();
		expect((await pending).status).toBe("unknown");
		expect(canceled).toHaveBeenCalled();
		const count = calls.length;
		expect(
			(
				await provider.handlers
					.get("xiaohongshu.list_feeds")!
					.execute({}, context)
			).status,
		).not.toBe("succeeded");
		expect(calls).toHaveLength(count);
		await provider.close();
	} finally {
		artifacts.close();
		rmSync(root, { recursive: true, force: true });
	}
});

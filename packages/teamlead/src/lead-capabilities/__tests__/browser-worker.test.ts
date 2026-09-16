import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { verifyBrowserHostIdentity } from "../browser-host-identity.js";
import { BROWSER_TOOL_SCHEMAS } from "../browser-tools.js";
import {
	BrowserWorker,
	browserUpstreamSchemaDigest,
} from "../browser-worker.js";

vi.mock("../browser-host-identity.js", () => ({
	verifyBrowserHostIdentity: vi.fn(() => ({ codesign: "verified" })),
}));
const state = vi.hoisted(() => ({
	launches: 0,
	tools: [] as {
		name: string;
		inputSchema: {
			type: "object";
			properties?: Record<string, unknown>;
			required?: string[];
		};
	}[],
}));
vi.mock("../browser-sandbox.js", () => ({
	buildBrowserSandboxSpec: (input: { qaRoot: string }) => ({
		command: "/usr/bin/sandbox-exec",
		args: [
			"-p",
			"(version 1) (deny default)",
			"/trusted/node",
			"/trusted/worker",
		],
		env: { HOME: input.qaRoot },
		cwd: input.qaRoot,
		policy: "fixture",
	}),
}));
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (
			_command: string,
			_args: string[],
			options: Record<string, unknown>,
		) => {
			state.launches++;
			return actual.spawn(
				process.execPath,
				[
					"-e",
					`let data='';const tools=${JSON.stringify(state.tools)};process.stdin.on('data',c=>{data+=c;let n;while((n=data.indexOf('\\n'))>=0){const q=JSON.parse(data.slice(0,n));data=data.slice(n+1);if(!('id'in q))continue;let result;if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.9.0'}};else if(q.method==='tools/list')result={tools};else if(q.method==='tools/call'){if(q.params.arguments?.function==='crash')process.exit(2);if(q.params.arguments?.function==='hang')continue;result={content:[{type:'text',text:String(process.pid)}]};}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}});`,
				],
				options,
			);
		},
	};
});
const dirs: string[] = [],
	workers: BrowserWorker[] = [];
afterEach(async () => {
	await Promise.all(workers.splice(0).map((w) => w.close()));
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	state.launches = 0;
});
function setup(mutateTools?: (tools: typeof state.tools) => void) {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "fly2519-browser-worker-")),
	);
	dirs.push(root);
	state.tools = Object.keys(BROWSER_TOOL_SCHEMAS).map((name) => ({
		name,
		inputSchema: { type: "object" },
	}));
	mutateTools?.(state.tools);
	const assertCurrent = vi.fn(),
		verifyIsolation = vi.fn(async () => {});
	const worker = new BrowserWorker({
		input: {
			qaRoot: root,
			projectRoot: "/unread/project",
			packageRoot: "/trusted/package",
			nodeExecutable: "/trusted/node",
			chromeExecutable: "/trusted/Chrome",
			proxyPort: 1234,
		},
		artifactRoot: root,
		expectedUpstreamSchemaDigest: browserUpstreamSchemaDigest(state.tools),
		assertCurrent,
		verifyIsolation,
	});
	workers.push(worker);
	return { worker, assertCurrent, verifyIsolation };
}
it("requires isolation verification before spawning and reuses one worker across turn consumers", async () => {
	const { worker, verifyIsolation } = setup();
	vi.mocked(verifyBrowserHostIdentity).mockClear();
	const generation = await worker.start();
	expect(verifyBrowserHostIdentity).toHaveBeenCalledOnce();
	expect(verifyIsolation).toHaveBeenCalledOnce();
	const a = await worker.call(generation, "list_pages", {}),
		b = await worker.call(generation, "list_pages", {});
	expect(a.result).toEqual(b.result);
	expect(state.launches).toBe(1);
	await expect(worker.call("old-generation", "list_pages", {})).rejects.toThrow(
		/browser/,
	);
	await expect(
		worker.call(generation, "upload_file", { filePaths: ["/etc/passwd"] }),
	).rejects.toThrow(/browser/);
});
it("fails closed on unsupported isolation without a bare spawn fallback", async () => {
	const { worker, verifyIsolation } = setup();
	verifyIsolation.mockRejectedValueOnce(Error("unsupported"));
	await expect(worker.start()).rejects.toThrow(/browser/);
	expect(state.launches).toBe(0);
});
it("rejects changed upstream schema before any business call", async () => {
	const { worker } = setup();
	state.tools.pop();
	await expect(worker.start()).rejects.toThrow(/browser/);
	expect(state.launches).toBe(1);
});
it("rejects upstream-required arguments missing from the audited facade", async () => {
	const { worker } = setup((tools) => {
		const snapshot = tools.find((tool) => tool.name === "take_snapshot")!;
		snapshot.inputSchema = {
			type: "object",
			properties: { pageId: { type: "number" } },
			required: ["pageId"],
		};
	});
	await expect(worker.start()).rejects.toThrow(/browser/);
});
it("invalidates page generation on crash and never silently restarts", async () => {
	const { worker } = setup(),
		generation = await worker.start();
	await expect(
		worker.call(generation, "evaluate_script", { function: "crash" }),
	).rejects.toThrow(/browser/);
	await expect(worker.call(generation, "list_pages", {})).rejects.toThrow(
		/browser/,
	);
	await expect(worker.start()).rejects.toThrow(/browser/);
	expect(state.launches).toBe(1);
});

it("keeps two Lead processes separate when one owner closes", async () => {
	const first = setup().worker,
		second = setup().worker;
	const a = await first.start(),
		b = await second.start();
	expect(a).not.toBe(b);
	const ar = await first.call(a, "list_pages", {}),
		br = await second.call(b, "list_pages", {});
	expect(ar.result).not.toEqual(br.result);
	await first.close();
	expect(await second.call(b, "list_pages", {})).toEqual(br);
});
it("rejects concurrent selection changes while preserving a live session after cancellation", async () => {
	const { worker } = setup(),
		generation = await worker.start(),
		controller = new AbortController();
	const running = worker.call(
		generation,
		"evaluate_script",
		{ function: "hang" },
		controller.signal,
	);
	await expect(
		worker.call(generation, "select_page", { pageId: 2 }),
	).rejects.toThrow("browser_busy");
	// Let prepare complete so cancellation concerns an issued MCP request.
	await new Promise((r) => setTimeout(r, 20));
	controller.abort();
	await expect(running).rejects.toThrow("browser_operation_interrupted");
	expect(await worker.call(generation, "list_pages", {})).toHaveProperty(
		"result",
	);
	expect(state.launches).toBe(1);
});

it("does not spawn when pinned host identity fails", async () => {
	const { worker, verifyIsolation } = setup();
	vi.mocked(verifyBrowserHostIdentity).mockImplementationOnce(() => {
		throw new Error("browser_host_identity_unverified");
	});
	await expect(worker.start()).rejects.toThrow("browser_lost");
	expect(state.launches).toBe(0);
	expect(verifyIsolation).not.toHaveBeenCalled();
});

it("preserves the live generation after an MCP request timeout", async () => {
	const { worker } = setup(),
		generation = await worker.start();
	const before = await worker.call(generation, "list_pages", {});
	const call = vi
		.spyOn(Client.prototype, "callTool")
		.mockRejectedValueOnce(new McpError(ErrorCode.RequestTimeout, "Timed out"));
	try {
		await expect(worker.call(generation, "list_pages", {})).rejects.toThrow(
			"browser_operation_interrupted",
		);
	} finally {
		call.mockRestore();
	}
	expect(await worker.call(generation, "list_pages", {})).toEqual(before);
	expect(state.launches).toBe(1);
});

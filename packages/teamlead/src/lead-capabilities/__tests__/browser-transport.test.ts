import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserStdioTransport } from "../browser-transport.js";

const launches = vi.hoisted(
	() =>
		[] as {
			command: string;
			args: string[];
			options: Record<string, unknown>;
		}[],
);
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (
			command: string,
			args: string[],
			options: Record<string, unknown>,
		) => {
			launches.push({ command, args, options });
			// Replace only the OS sandbox executable boundary. The child and MCP wire are real.
			return actual.spawn(process.execPath, ["-e", fixture], options);
		},
	};
});
const fixture = `let pending='';process.stdin.on('data',c=>{pending+=c;let p;while((p=pending.indexOf('\\n'))>=0){const q=JSON.parse(pending.slice(0,p));pending=pending.slice(p+1);if(!('id'in q))continue;let result;if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};else if(q.method==='tools/list')result={tools:[]};else if(q.method==='tools/call'){if(q.params.name==='crash')process.exit(2);if(q.params.name==='orphan'){const c=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"],{stdio:'ignore'});setTimeout(()=>{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:String(c.pid)}]}})+'\\n');setTimeout(()=>process.exit(2),20);},100);continue;}if(q.params.name==='oversized'){process.stdout.write('x'.repeat(4194305));continue;}result={content:[{type:'text',text:JSON.stringify({pid:process.pid,env:process.env})}]};}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}});`;
const open: BrowserStdioTransport[] = [];
afterEach(async () => {
	await Promise.all(open.splice(0).map((x) => x.close()));
	launches.length = 0;
	vi.unstubAllEnvs();
});
function transport() {
	const t = new BrowserStdioTransport({
		command: "/usr/bin/sandbox-exec",
		args: [
			"-p",
			"(version 1) (deny default)",
			"/trusted/node",
			"/trusted/worker.js",
		],
		env: { HOME: "/tmp/qa", PATH: "/usr/bin:/bin" },
		cwd: "/tmp",
	});
	open.push(t);
	return t;
}
it("uses exact washed environment and retains one real child across MCP calls", async () => {
	vi.stubEnv("FLYWHEEL_API_TOKEN", "parent-secret");
	vi.stubEnv("SHELL", "/untrusted/shell");
	const t = transport(),
		client = new Client({ name: "test", version: "1" });
	await client.connect(t);
	await client.listTools();
	const a = await client.callTool({ name: "read", arguments: {} }),
		b = await client.callTool({ name: "read", arguments: {} });
	const first = JSON.parse((a.content as { text: string }[])[0]!.text),
		second = JSON.parse((b.content as { text: string }[])[0]!.text);
	expect(first.pid).toBe(second.pid);
	// CoreFoundation may add this locale variable inside the macOS child.
	delete first.env.__CF_USER_TEXT_ENCODING;
	expect(first.env).toEqual({ HOME: "/tmp/qa", PATH: "/usr/bin:/bin" });
	expect(launches[0]!.options.env).toEqual({
		HOME: "/tmp/qa",
		PATH: "/usr/bin:/bin",
	});
	expect(launches).toHaveLength(1);
	expect(launches[0]).toMatchObject({
		command: "/usr/bin/sandbox-exec",
		options: { shell: false, detached: true },
	});
	await client.close();
	expect(t.pid).toBeNull();
});
it.each(["crash", "oversized"])(
	"fails outstanding RPC when worker %s without respawning",
	async (name) => {
		const t = transport(),
			client = new Client({ name: "test", version: "1" });
		await client.connect(t);
		await expect(
			client.callTool({ name, arguments: {} }, undefined, { timeout: 3000 }),
		).rejects.toThrow();
		expect(launches).toHaveLength(1);
		await t.close();
		expect(t.pid).toBeNull();
	},
);
it("refuses arbitrary executable and unsafe environment before spawning", () => {
	expect(
		() =>
			new BrowserStdioTransport({
				command: process.execPath,
				args: [],
				env: {},
				cwd: "/tmp",
			}),
	).toThrow(/browser/);
	expect(
		() =>
			new BrowserStdioTransport({
				command: "/usr/bin/sandbox-exec",
				args: [],
				env: { NODE_OPTIONS: "--require=/tmp/evil" },
				cwd: "/tmp",
			}),
	).toThrow(/browser/);
	expect(launches).toHaveLength(0);
});

it("cleans its own stubborn child group after the MCP parent exits", async () => {
	const t = transport(),
		client = new Client({ name: "test", version: "1" });
	await client.connect(t);
	const result = await client.callTool({ name: "orphan", arguments: {} });
	const orphan = Number((result.content as { text: string }[])[0]!.text);
	try {
		await new Promise((r) => setTimeout(r, 60));
		await t.close();
		await expect
			.poll(
				() => {
					try {
						process.kill(orphan, 0);
						return true;
					} catch {
						return false;
					}
				},
				{ timeout: 2000 },
			)
			.toBe(false);
	} finally {
		try {
			process.kill(orphan, "SIGKILL");
		} catch {
			/* cleaned */
		}
	}
});

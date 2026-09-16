import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { expect, it, vi } from "vitest";
import { GbrainStdioTransport } from "../gbrain-transport.js";

const calls = vi.hoisted(() => [] as any[]);
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (command: string, args: string[], options: any) => {
			calls.push({ command, args, options });
			return actual.spawn(
				process.execPath,
				[
					"-e",
					`let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const q=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(!('id'in q))continue;const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'gbrain',version:'0.9.0'}}:{tools:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}});`,
				],
				options,
			);
		},
	};
});
it("checks pins before spawn and washes ambient database and preload variables", async () => {
	const assertCurrent = vi.fn(),
		pin = {
			launch: {
				command: "/trusted/bun",
				args: [
					"--no-env-file",
					"--config",
					"/dev/null",
					"/trusted/gbrain/src/cli.ts",
					"serve",
				],
				env: { HOME: "/tmp", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
				cwd: "/tmp",
			},
			assertCurrent,
		};
	const transport = new GbrainStdioTransport(pin),
		client = new Client({ name: "test", version: "1" });
	try {
		await client.connect(transport);
		expect(assertCurrent).toHaveBeenCalled();
		await client.listTools();
		expect(calls[0].options.env).toEqual(pin.launch.env);
		expect(transport.evidence.migrationsApplied).toBe(0);
	} finally {
		await client.close();
		await transport.close();
	}
	await expect(transport.start()).rejects.toThrow();
	const before = calls.length;
	assertCurrent.mockImplementation(() => {
		throw new Error("drift");
	});
	await expect(new GbrainStdioTransport(pin).start()).rejects.toThrow("drift");
	expect(calls).toHaveLength(before);
});

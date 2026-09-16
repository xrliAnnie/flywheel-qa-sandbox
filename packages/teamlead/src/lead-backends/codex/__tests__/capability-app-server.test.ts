import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { LeadCapabilityParent } from "../../../lead-capabilities/runtime-parent.js";
import { startCapabilityAppServer } from "../capability-app-server.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture(mode = "listen") {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ftui-test-")));
	roots.push(root);
	const bin = join(root, "codex");
	writeFileSync(
		bin,
		`#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2); const socket=args[args.indexOf('--listen')+1].slice(7);
fs.writeFileSync(${JSON.stringify(join(root, "capture.json"))}, JSON.stringify({args, env:process.env, pid:process.pid}));
if (${JSON.stringify(mode)}==='exit') process.exit(2);
if (${JSON.stringify(mode)}==='listen') require('node:net').createServer().listen(socket);
else setInterval(()=>{},1000);
`,
	);
	chmodSync(bin, 0o700);
	const parent = {
		codexPath: bin,
		pins: {
			codexHome: root,
			brokerSocket: join(root, "broker.sock"),
			manifestPath: join(root, "manifest.json"),
			artifactRoot: join(root, "artifacts"),
			modelTempRoot: join(root, "tmp"),
			projectName: "demo",
			leadId: "lead",
			activationId: "test",
		},
		permissionArgv: ["-c", 'default_permissions="flywheel-lead-v2"'],
		mcp: { argv: ["-c", "mcp_servers={}"] },
		assertCurrent: vi.fn(async () => {}),
	} as unknown as LeadCapabilityParent;
	return { root, parent };
}

it("owns a real child and private Unix socket, washes secrets and records the actual spawn inputs", async () => {
	const f = fixture();
	const server = await startCapabilityAppServer({
		parent: f.parent,
		env: {
			PATH: "/usr/bin:/bin",
			HOME: f.root,
			DISCORD_BOT_TOKEN: "synthetic-secret",
			FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "synthetic-claim",
		},
	});
	try {
		const captured = JSON.parse(
			readFileSync(join(f.root, "capture.json"), "utf8"),
		);
		expect(captured.args).toEqual([
			"app-server",
			"--strict-config",
			"--listen",
			`unix://${server.socketPath}`,
			...f.parent.permissionArgv,
			...f.parent.mcp.argv,
		]);
		expect(captured.env.DISCORD_BOT_TOKEN).toBeUndefined();
		expect(captured.env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID).toBeUndefined();
		expect(server.receipt).toMatchObject({
			transport: "app_server_socket",
			pid: captured.pid,
		});
		expect(server.receipt.argvSha256).toMatch(/^[a-f0-9]{64}$/);
		await server.assertCurrent();
	} finally {
		await server.close();
	}
	expect(existsSync(server.socketPath)).toBe(false);
	await expect(server.assertCurrent()).rejects.toThrow(
		"capability_app_server_closed",
	);
	await server.close();
});

it.each(["exit", "hang"])(
	"cleans up a child that fails startup: %s",
	async (mode) => {
		const f = fixture(mode);
		await expect(
			startCapabilityAppServer({
				parent: f.parent,
				env: {},
				startupTimeoutMs: mode === "exit" ? 5000 : 1500,
			}),
		).rejects.toThrow(/capability_app_server_(exited|timeout)/);
		const captured = JSON.parse(
			readFileSync(join(f.root, "capture.json"), "utf8"),
		);
		expect(() => process.kill(captured.pid, 0)).toThrow();
		expect(existsSync(captured.args[3].slice(7))).toBe(false);
	},
);

it("does not spawn after authority rejection", async () => {
	const f = fixture();
	vi.mocked(f.parent.assertCurrent).mockRejectedValue(
		new Error("stale activation"),
	);
	await expect(
		startCapabilityAppServer({ parent: f.parent, env: {} }),
	).rejects.toThrow("stale activation");
	expect(existsSync(join(f.root, "capture.json"))).toBe(false);
});

it("cancels an in-flight startup and reaps its exact child", async () => {
	const f = fixture("hang");
	const abort = new AbortController();
	const pending = startCapabilityAppServer({
		parent: f.parent,
		env: {},
		signal: abort.signal,
	});
	try {
		await vi.waitFor(
			() => expect(existsSync(join(f.root, "capture.json"))).toBe(true),
			{ timeout: 3000 },
		);
		abort.abort(new Error("cancelled-start"));
		await expect(pending).rejects.toThrow("cancelled-start");
	} finally {
		abort.abort();
		await pending.catch(() => {});
	}

	const captured = JSON.parse(
		readFileSync(join(f.root, "capture.json"), "utf8"),
	);
	expect(() => process.kill(captured.pid, 0)).toThrow();
	expect(existsSync(captured.args[3].slice(7))).toBe(false);
});

import { spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import {
	BROWSER_UPSTREAM_SCHEMA_DIGEST,
	buildBrowserWorkerSpec,
} from "../browser-config.js";
import { browserUpstreamSchemaDigest } from "../browser-worker.js";

it("pins real installed upstream tools/list under exact worker flags without launching Chrome", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "browser-upstream-")));
	let child: ReturnType<typeof spawn> | undefined;
	try {
		for (const dir of ["qa", "project"])
			mkdirSync(join(root, dir), { mode: 0o700 });
		const chrome = join(root, "chrome");
		writeFileSync(chrome, "not executable: tools/list must not launch Chrome");
		const spec = buildBrowserWorkerSpec({
			packageRoot: realpathSync(
				join(__dirname, "../../../node_modules/chrome-devtools-mcp"),
			),
			nodeExecutable: process.execPath,
			chromeExecutable: chrome,
			qaRoot: join(root, "qa"),
			projectRoot: join(root, "project"),
			proxyPort: 32189,
		});
		child = spawn(spec.nodeExecutable, spec.args, {
			cwd: spec.qaRoot,
			env: spec.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stderr!.resume();
		const pending = new Map<
			number,
			{ resolve: (value: any) => void; reject: (error: Error) => void }
		>();
		const lines = createInterface({ input: child.stdout! });
		lines.on("line", (line) => {
			const message = JSON.parse(line);
			if (message.id !== undefined) {
				const p = pending.get(message.id);
				pending.delete(message.id);
				message.error
					? p?.reject(new Error("upstream_rpc_failed"))
					: p?.resolve(message.result);
			}
		});
		child.on("close", () => {
			for (const p of pending.values()) p.reject(new Error("upstream_closed"));
		});
		const request = (id: number, method: string, params: unknown) =>
			new Promise<any>((resolve, reject) => {
				pending.set(id, { resolve, reject });
				child!.stdin!.write(
					`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
				);
			});
		const timer = setTimeout(() => child?.kill("SIGKILL"), 5000);
		try {
			await request(1, "initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "flywheel-schema-test", version: "1" },
			});
			child.stdin!.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					method: "notifications/initialized",
				})}\n`,
			);
			const result = await request(2, "tools/list", {});
			expect(result.nextCursor).toBeUndefined();
			expect(result.tools).toHaveLength(29);
			expect(browserUpstreamSchemaDigest(result.tools)).toBe(
				BROWSER_UPSTREAM_SCHEMA_DIGEST,
			);
		} finally {
			clearTimeout(timer);
			lines.close();
		}
	} finally {
		if (child && child.exitCode === null) {
			child.kill("SIGTERM");
			await new Promise<void>((resolve) =>
				child!.once("close", () => resolve()),
			);
		}
		rmSync(root, { recursive: true, force: true });
	}
});

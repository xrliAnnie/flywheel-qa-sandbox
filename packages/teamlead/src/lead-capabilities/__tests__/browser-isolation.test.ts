import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { verifyBrowserIsolation } from "../browser-isolation.js";
import type { buildBrowserSandboxSpec } from "../browser-sandbox.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

it.each(["unconfined", "empty", "failed"])(
	"rejects an unproven %s child",
	async (mode) => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "browser-canary-test-")),
		);
		try {
			const qa = join(root, "qa");
			mkdirSync(qa, { mode: 0o700 });
			mkdirSync(join(qa, "tmp"), { mode: 0o700 });
			const { spawn } =
				await vi.importActual<typeof import("node:child_process")>(
					"node:child_process",
				);
			const launch = {
				command: "/usr/bin/sandbox-exec",
				args: ["-p", "(version 1)\n(allow default)", process.execPath],
				policy: "(version 1)\n(allow default)",
				env: {
					HOME: qa,
					TMPDIR: join(qa, "tmp"),
					PATH: "/usr/bin:/bin",
					LANG: "en_US.UTF-8",
				},
				cwd: qa,
			} as ReturnType<typeof buildBrowserSandboxSpec>;
			const parent = await import("node:net");
			const server = parent.createServer((socket) => socket.end());
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			try {
				const address = server.address() as { port: number };
				let observed = "";
				const spawnSpy = vi
					.mocked((await import("node:child_process")).spawn)
					.mockImplementation(((
						command: string,
						args: string[],
						options: any,
					) => {
						expect(command).toBe("/usr/bin/sandbox-exec");
						expect(args.slice(0, 3)).toEqual([
							"-p",
							launch.policy,
							process.execPath,
						]);
						expect(options.env).toEqual(launch.env);
						const child = spawn(
							process.execPath,
							mode === "unconfined"
								? args.slice(3)
								: ["-e", mode === "empty" ? "" : "process.exit(71)"],
							options,
						);
						child.stdout!.on("data", (chunk) => {
							observed += chunk.toString();
						});
						return child;
					}) as typeof spawn);
				try {
					await expect(
						verifyBrowserIsolation(launch, { proxyPort: address.port }),
					).rejects.toThrow("browser_isolation_unproven");
					if (mode === "unconfined")
						expect(JSON.parse(observed)).toMatchObject({
							writable: true,
							proxyAllowed: true,
							readDenied: false,
							symlinkDenied: false,
							writeDenied: false,
							privateDenied: false,
							listenDenied: false,
						});
				} finally {
					spawnSpy.mockRestore();
				}
				expect(readdirSync(qa)).toEqual(["tmp"]);
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

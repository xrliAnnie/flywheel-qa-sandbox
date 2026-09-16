import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ModelIsolationOptions } from "../model-isolation.js";
import { verifyModelIsolation } from "../model-isolation.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

it.each(["unconfined", "empty", "failed"])(
	"rejects an unproven %s child",
	async (mode) => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "model-canary-test-")),
		);
		try {
			const qa = join(root, "qa");
			mkdirSync(qa, { mode: 0o700 });
			mkdirSync(join(qa, "tmp"), { mode: 0o700 });
			const { spawn } =
				await vi.importActual<typeof import("node:child_process")>(
					"node:child_process",
				);
			const home = join(root, "home"),
				artifacts = join(qa, "artifacts"),
				deployment = join(root, "deployment");
			for (const path of [home, artifacts, deployment])
				mkdirSync(path, { mode: 0o700 });
			const credentialProbePath = join(home, "auth.json");
			writeFileSync(credentialProbePath, "synthetic-credential", {
				mode: 0o600,
			});
			const launch: Omit<ModelIsolationOptions, "proxyPort"> = {
				codexExecutable: "/opt/codex",
				nodeExecutable: process.execPath,
				pins: {
					codexHome: home,
					brokerSocket: join(root, "broker.sock"),
					manifestPath: join(root, "manifest.json"),
					artifactRoot: artifacts,
					modelTempRoot: join(qa, "tmp"),
					projectName: "flywheel",
					leadId: "honey",
					activationId: "test",
				},
				projectRoot: qa,
				deploymentRoot: deployment,
				credentialProbePath,
				env: {
					HOME: home,
					PATH: "/usr/bin:/bin",
					FLYWHEEL_SYNTHETIC_SECRET: "must-not-inherit",
					NODE_OPTIONS: "--invalid",
				},
				assertCurrent: () => {},
			};
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
						expect(command).toBe("/opt/codex");
						expect(args.slice(0, 7)).toEqual([
							"sandbox",
							"--permission-profile",
							"flywheel-lead-v2",
							"--cd",
							qa,
							"--",
							process.execPath,
						]);
						expect(options.env.FLYWHEEL_SYNTHETIC_SECRET).toBeUndefined();
						expect(options.env.NODE_OPTIONS).toBeUndefined();
						expect(options.env.CODEX_HOME).toBe(home);
						const child = spawn(
							process.execPath,
							mode === "unconfined"
								? args.slice(7)
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
						verifyModelIsolation({ ...launch, proxyPort: address.port }),
					).rejects.toThrow("model_isolation_unproven");
					if (mode === "unconfined")
						expect(JSON.parse(observed)).toMatchObject({
							writable: true,
							proxyAllowed: true,
							readDenied: false,
							credentialDenied: false,
							symlinkDenied: false,
							writeDenied: false,
							artifactWriteDenied: false,
							deploymentWriteDenied: false,
							privateDenied: false,
							listenDenied: false,
						});
				} finally {
					spawnSpy.mockRestore();
				}
				expect(readdirSync(qa)).toEqual(["artifacts", "tmp"]);
				expect(readdirSync(artifacts)).toEqual([]);
				expect(readdirSync(deployment)).toEqual([]);
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

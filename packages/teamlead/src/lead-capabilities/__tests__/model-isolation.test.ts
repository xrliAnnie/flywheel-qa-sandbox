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
			const opensslConf = join(root, "openssl.cnf");
			writeFileSync(opensslConf, "", { mode: 0o400 });
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
					opensslConf,
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
			const http = await import("node:http");
			const managed = http.createServer((_request, response) => {
				response.writeHead(403, { connection: "close" });
				response.end();
			});
			await new Promise<void>((resolve) =>
				managed.listen(0, "127.0.0.1", resolve),
			);
			const managedProxy = managed.address() as { port: number };
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
						expect(options.env.OPENSSL_CONF).toBe(opensslConf);
						const child = spawn(
							process.execPath,
							mode === "unconfined"
								? args.slice(7)
								: ["-e", mode === "empty" ? "" : "process.exit(71)"],
							// Stand in for the sandbox's managed proxy announcement.
							{
								...options,
								env: {
									...options.env,
									HTTP_PROXY: `http://127.0.0.1:${managedProxy.port}`,
								},
							},
						);
						child.stdout!.on("data", (chunk) => {
							observed += chunk.toString();
						});
						return child;
					}) as typeof spawn);
				try {
					await expect(
						verifyModelIsolation({
							...launch,
							proxyPort: address.port,
							egressProbeSeen: () => true,
						}),
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
							opensslConfRead: true,
							// The stand-in managed proxy is not chained to the egress proxy.
							egressChained: false,
							cryptoReady: true,
						});
				} finally {
					spawnSpy.mockRestore();
				}
				expect(readdirSync(qa)).toEqual(["artifacts", "tmp"]);
				expect(readdirSync(artifacts)).toEqual([]);
				expect(readdirSync(deployment)).toEqual([]);
			} finally {
				managed.closeAllConnections();
				await new Promise<void>((resolve) => managed.close(() => resolve()));
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it("refuses to probe without the parent-pinned OpenSSL config", async () => {
	const { spawn } = await import("node:child_process");
	vi.mocked(spawn).mockClear();
	await expect(
		verifyModelIsolation({
			codexExecutable: "/opt/codex",
			nodeExecutable: process.execPath,
			pins: {
				codexHome: "/tmp/h",
				brokerSocket: "/tmp/b.sock",
				manifestPath: "/tmp/m.json",
				artifactRoot: "/tmp/a",
				modelTempRoot: "/tmp/t",
				projectName: "flywheel",
				leadId: "honey",
				activationId: "test",
			},
			projectRoot: "/tmp/p",
			deploymentRoot: "/tmp/d",
			credentialProbePath: "/tmp/h/auth.json",
			proxyPort: 18080,
			egressProbeSeen: () => true,
			env: {},
			assertCurrent: () => {},
		}),
	).rejects.toThrow("model_isolation_unproven");
	expect(spawn).not.toHaveBeenCalled();
});

it.each([false, true])(
	"requires the activation egress proxy to have answered the chain probe (seen=%s)",
	async (seen) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "model-chain-test-")));
		try {
			const qa = join(root, "qa");
			for (const path of [
				qa,
				join(qa, "tmp"),
				join(qa, "artifacts"),
				join(root, "home"),
				join(root, "deployment"),
			])
				mkdirSync(path, { recursive: true, mode: 0o700 });
			const credential = join(root, "home/auth.json");
			writeFileSync(credential, "synthetic", { mode: 0o600 });
			const opensslConf = join(root, "openssl.cnf");
			writeFileSync(opensslConf, "", { mode: 0o400 });
			const { spawn } =
				await vi.importActual<typeof import("node:child_process")>(
					"node:child_process",
				);
			let probeUrl = "";
			const spawnSpy = vi
				.mocked((await import("node:child_process")).spawn)
				.mockImplementation(((
					_command: string,
					args: string[],
					options: any,
				) => {
					const data = JSON.parse(args.at(-1)!);
					probeUrl = data.egressProbeUrl;
					const result = {
						nonce: data.nonce,
						...Object.fromEntries(
							[
								"writable",
								"readDenied",
								"credentialDenied",
								"symlinkDenied",
								"writeDenied",
								"artifactWriteDenied",
								"deploymentWriteDenied",
								"proxyAllowed",
								"privateDenied",
								"listenDenied",
								"opensslConfRead",
								"egressChained",
								"cryptoReady",
							].map((key) => [key, true]),
						),
					};
					return spawn(
						process.execPath,
						[
							"-e",
							`process.stdout.write(${JSON.stringify(JSON.stringify(result))})`,
						],
						options,
					);
				}) as typeof spawn);
			const observed: string[] = [];
			try {
				const pending = verifyModelIsolation({
					codexExecutable: "/opt/codex",
					nodeExecutable: process.execPath,
					pins: {
						codexHome: join(root, "home"),
						brokerSocket: join(root, "broker.sock"),
						manifestPath: join(root, "manifest.json"),
						artifactRoot: join(qa, "artifacts"),
						modelTempRoot: join(qa, "tmp"),
						projectName: "flywheel",
						leadId: "honey",
						activationId: "test",
						opensslConf,
					},
					projectRoot: qa,
					deploymentRoot: join(root, "deployment"),
					credentialProbePath: credential,
					proxyPort: 18080,
					egressProbeSeen: (nonce) => {
						observed.push(nonce);
						return seen;
					},
					env: { PATH: "/usr/bin:/bin" },
					assertCurrent: () => {},
				});
				if (seen) await expect(pending).resolves.toBeUndefined();
				else await expect(pending).rejects.toThrow("model_isolation_unproven");
			} finally {
				spawnSpy.mockRestore();
			}
			expect(probeUrl).toMatch(
				/^http:\/\/example\.com\/\.well-known\/flywheel-egress-probe\/[0-9a-f-]{36}$/u,
			);
			expect(observed).toEqual([probeUrl.split("/").at(-1)]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

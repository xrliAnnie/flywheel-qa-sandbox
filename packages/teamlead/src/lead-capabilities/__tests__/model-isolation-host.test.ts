import { spawn, spawnSync } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startBrowserEgressProxy } from "../browser-egress-proxy.js";
import { ensureLeadCapabilityHome } from "../capability-home.js";
import {
	buildLeadModelEnv,
	type LeadModelEnvPins,
	writeLeadOpensslConf,
} from "../model-env.js";
import { verifyModelIsolation } from "../model-isolation.js";
import {
	leadNodeRuntimeReadPaths,
	resolveNodeRuntimeClosure,
} from "../node-runtime-closure.js";
import {
	LEAD_PERMISSION_PROFILE,
	type LeadPermissionProfileSpec,
} from "../permission-profile.js";

/**
 * FLY-2886 §14.5 QA-R3: the real Codex 0.156.1 sandbox with the real Homebrew
 * node and a resident-shaped permission profile. Skipped where either is absent.
 */
const codexBin =
	process.env.FLYWHEEL_TEST_CODEX_0156_BIN ??
	join(homedir(), ".flywheel/codex-standalone/0.156.1/bin/codex");
const nodePath = realpathSync(process.execPath);
const hostReady =
	process.platform === "darwin" &&
	existsSync(codexBin) &&
	existsSync("/usr/bin/otool") &&
	nodePath.startsWith("/opt/homebrew/Cellar/node/");

let root: string;
let egress: Awaited<ReturnType<typeof startBrowserEgressProxy>>;
let proxyPort: number;
/** Hostnames the activation egress proxy was asked to resolve (i.e. forwarded to it). */
let egressHosts: string[];
beforeEach(async () => {
	// The profile denies /tmp (:slash_tmp); a real Lead workspace lives elsewhere.
	root = realpathSync(
		mkdtempSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"../../../.host-isolation-",
			),
		),
	);
	egressHosts = [];
	egress = await startBrowserEgressProxy({
		policy: () => ({ protectedPorts: [], localQaTargets: [] }),
		assertCurrent: () => {},
		lookup: async (hostname) => {
			egressHosts.push(hostname);
			return (await dnsLookup(hostname, { all: true, verbatim: true })).map(
				(row) => ({ address: row.address, family: row.family }),
			);
		},
	});
	proxyPort = egress.port;
});
afterEach(async () => {
	await egress.close();
	rmSync(root, { recursive: true, force: true });
});

async function prepare(readNode: "executable" | "closure", openssl: boolean) {
	const dir = (path: string) => {
		mkdirSync(path, { recursive: true, mode: 0o700 });
		return path;
	};
	const deploymentRoot = dir(join(root, "deployment"));
	const projectRoot = dir(join(root, "project"));
	const artifactRoot = dir(join(projectRoot, ".flywheel-artifacts-host"));
	const modelTempRoot = dir(join(projectRoot, ".flywheel-model-host"));
	const codexHome = dir(join(root, "codex-home"));
	const activationRoot = dir(join(root, "activation"));
	const run = dir(join(activationRoot, "run-host"));
	const credential = join(codexHome, "auth.json");
	writeFileSync(credential, "synthetic-credential", { mode: 0o600 });
	const opensslConf = openssl ? writeLeadOpensslConf(run) : undefined;
	const pins: LeadModelEnvPins = {
		codexHome,
		brokerSocket: join(run, "broker.sock"),
		manifestPath: join(run, "manifest.json"),
		artifactRoot,
		modelTempRoot,
		projectName: "flywheel",
		leadId: "host-probe",
		activationId: "host-probe",
		...(opensslConf ? { opensslConf } : {}),
		egressProxyUrl: `http://127.0.0.1:${proxyPort}`,
	};
	const spec: LeadPermissionProfileSpec = {
		deploymentRoot,
		projectRoot,
		artifactRoot,
		readPaths: [
			deploymentRoot,
			...(readNode === "closure"
				? leadNodeRuntimeReadPaths(resolveNodeRuntimeClosure(nodePath))
				: [nodePath]),
			realpathSync(codexBin),
			...(opensslConf ? [opensslConf] : []),
		],
		credentialPaths: [credential],
		brokerSocket: pins.brokerSocket,
		proxyPort,
	};
	await ensureLeadCapabilityHome({
		codexHome,
		activationRoot,
		permissionProfile: spec,
		assertCurrent: async () => {},
	});
	return { pins, spec, credential };
}

function sandboxNode(
	pins: LeadModelEnvPins,
	projectRoot: string,
	program: string,
) {
	const result = spawnSync(
		codexBin,
		[
			"sandbox",
			"--permission-profile",
			LEAD_PERMISSION_PROFILE,
			"--cd",
			projectRoot,
			"--",
			nodePath,
			"-e",
			program,
		],
		{
			cwd: projectRoot,
			env: buildLeadModelEnv(process.env, pins),
			encoding: "utf8",
			timeout: 20_000,
		},
	);
	return { status: result.status, signal: result.signal };
}

it.skipIf(!hostReady)(
	"the executable-only grant cannot even load Homebrew node (the QA@2 exit 134)",
	async () => {
		const { pins, spec } = await prepare("executable", true);
		const result = sandboxNode(pins, spec.projectRoot, "process.exit(0)");
		expect(result.status === 0 && result.signal === null).toBe(false);
	},
	30_000,
);

it.skipIf(!hostReady)(
	"the loader closure plus the pinned OPENSSL_CONF runs node and crypto inside the sandbox",
	async () => {
		const { pins, spec } = await prepare("closure", true);
		expect(
			sandboxNode(
				pins,
				spec.projectRoot,
				"require('node:fs').readFileSync(process.env.OPENSSL_CONF);require('node:crypto').randomBytes(1)",
			),
		).toEqual({ status: 0, signal: null });
	},
	30_000,
);

it.skipIf(!hostReady)(
	"verifyModelIsolation passes with the real codex, real node and the resident-shaped profile",
	async () => {
		const { pins, spec, credential } = await prepare("closure", true);
		await expect(
			verifyModelIsolation({
				codexExecutable: codexBin,
				nodeExecutable: nodePath,
				pins,
				projectRoot: spec.projectRoot,
				deploymentRoot: spec.deploymentRoot,
				credentialProbePath: credential,
				proxyPort,
				egressProbeSeen: egress.probeSeen,
				env: process.env,
				assertCurrent: () => {},
			}),
		).resolves.toBeUndefined();
	},
	30_000,
);

it.skipIf(!hostReady)(
	"verifyModelIsolation rejects the executable-only grant with the real codex",
	async () => {
		const { pins, spec, credential } = await prepare("executable", true);
		await expect(
			verifyModelIsolation({
				codexExecutable: codexBin,
				nodeExecutable: nodePath,
				pins,
				projectRoot: spec.projectRoot,
				deploymentRoot: spec.deploymentRoot,
				credentialProbePath: credential,
				proxyPort,
				egressProbeSeen: egress.probeSeen,
				env: process.env,
				assertCurrent: () => {},
			}),
		).rejects.toThrow("model_isolation_unproven");
	},
	30_000,
);

/**
 * Lead ruling B regression (resident and voice share this profile): chaining the
 * managed sandbox proxy to the activation egress proxy adds that hop and allows
 * nothing more. Same targets, same outcomes; only the egress proxy now sees the
 * public requests. Needs public DNS/HTTP for example.com.
 */
it.skipIf(!hostReady)(
	"upstream chaining changes no outcome and puts the egress proxy in the path",
	async () => {
		const local = createHttpServer((_request, response) => response.end("ok"));
		await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
		const localPort = (local.address() as { port: number }).port;
		const targets: Array<[string, string]> = [
			["public https", "https://example.com/"],
			["public http", "http://example.com/"],
			["loopback", `http://127.0.0.1:${localPort}/`],
			["localhost", `http://localhost:${localPort}/`],
			["name to loopback", `http://localtest.me:${localPort}/`],
			["metadata", "http://169.254.169.254/"],
			["rfc1918", "http://10.255.255.1/"],
			["name to rfc1918", "http://10.0.0.1.nip.io/"],
		];
		const run = async (legacy: boolean) => {
			const { pins, spec } = await prepare("closure", true);
			const env: NodeJS.ProcessEnv = {
				...buildLeadModelEnv(process.env, pins),
			};
			if (legacy) {
				// Pre-ruling shape: no upstream, no egress proxy env.
				const config = join(pins.codexHome, "config.toml");
				chmodSync(config, 0o600);
				writeFileSync(
					config,
					readFileSync(config, "utf8").replace(
						"allow_upstream_proxy = true",
						"allow_upstream_proxy = false",
					),
				);
				for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"])
					delete env[key];
			}
			const script = [
				...targets.map(
					([name, url]) =>
						`printf '%s|%s\\n' '${name}' "$(/usr/bin/curl -s -m 8 -o /dev/null -w '%{http_code}' '${url}')"`,
				),
				`printf 'direct public|%s\\n' "$(/usr/bin/curl --noproxy '*' -s -m 8 -o /dev/null -w '%{http_code}' https://example.com/)"`,
				`printf 'direct loopback|%s\\n' "$(/usr/bin/curl --noproxy '*' -s -m 8 -o /dev/null -w '%{http_code}' http://127.0.0.1:${localPort}/)"`,
			].join("\n");
			egressHosts.length = 0;
			const output = await new Promise<string>((resolve) => {
				const child = spawn(
					codexBin,
					[
						"sandbox",
						"--permission-profile",
						LEAD_PERMISSION_PROFILE,
						"--cd",
						spec.projectRoot,
						"--",
						"/bin/sh",
						"-c",
						script,
					],
					{ cwd: spec.projectRoot, env },
				);
				let text = "";
				child.stdout.on("data", (chunk) => {
					text += chunk;
				});
				child.on("close", () => resolve(text));
			});
			rmSync(join(root, "codex-home"), { recursive: true, force: true });
			rmSync(join(root, "activation"), { recursive: true, force: true });
			return {
				outcomes: Object.fromEntries(
					output
						.trim()
						.split("\n")
						.map((line) => line.split("|") as [string, string]),
				),
				hosts: [...new Set(egressHosts)],
			};
		};
		try {
			const before = await run(true);
			const after = await run(false);
			expect(after.outcomes).toEqual(before.outcomes);
			expect(after.outcomes).toEqual({
				"public https": "200",
				"public http": "200",
				loopback: "403",
				localhost: "403",
				"name to loopback": "403",
				metadata: "403",
				rfc1918: "403",
				"name to rfc1918": "403",
				"direct public": "000",
				"direct loopback": "000",
			});
			expect(before.hosts).toEqual([]);
			expect(after.hosts).toEqual(["example.com"]);
		} finally {
			await new Promise<void>((resolve) => local.close(() => resolve()));
		}
	},
	120_000,
);

it.skipIf(!hostReady)(
	"verifyModelIsolation rejects a managed proxy that bypasses the egress proxy",
	async () => {
		const { pins, spec, credential } = await prepare("closure", true);
		const config = join(pins.codexHome, "config.toml");
		chmodSync(config, 0o600);
		writeFileSync(
			config,
			readFileSync(config, "utf8").replace(
				"allow_upstream_proxy = true",
				"allow_upstream_proxy = false",
			),
		);
		await expect(
			verifyModelIsolation({
				codexExecutable: codexBin,
				nodeExecutable: nodePath,
				pins,
				projectRoot: spec.projectRoot,
				deploymentRoot: spec.deploymentRoot,
				credentialProbePath: credential,
				proxyPort,
				egressProbeSeen: egress.probeSeen,
				env: process.env,
				assertCurrent: () => {},
			}),
		).rejects.toThrow("model_isolation_unproven");
	},
	60_000,
);

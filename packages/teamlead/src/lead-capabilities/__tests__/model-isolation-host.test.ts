import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ensureLeadCapabilityHome } from "../capability-home.js";
import {
	buildLeadModelEnv,
	type LeadModelEnvPins,
	writeLeadOpensslConf,
} from "../model-env.js";
import { verifyModelIsolation } from "../model-isolation.js";
import { leadNodeRuntimeReadPaths } from "../node-runtime-closure.js";
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
let proxy: Server;
let proxyPort: number;
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
	proxy = createServer((socket) => socket.end());
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	proxyPort = (proxy.address() as { port: number }).port;
});
afterEach(async () => {
	await new Promise<void>((resolve) => proxy.close(() => resolve()));
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
	};
	const spec: LeadPermissionProfileSpec = {
		deploymentRoot,
		projectRoot,
		artifactRoot,
		readPaths: [
			deploymentRoot,
			...(readNode === "closure"
				? leadNodeRuntimeReadPaths(nodePath)
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
				env: process.env,
				assertCurrent: () => {},
			}),
		).rejects.toThrow("model_isolation_unproven");
	},
	30_000,
);

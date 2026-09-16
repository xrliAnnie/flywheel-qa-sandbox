#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LeadArtifactStore } from "../packages/teamlead/dist/lead-capabilities/artifacts.js";
import { verifyBrowserHostIdentity } from "../packages/teamlead/dist/lead-capabilities/browser-host-identity.js";
import { startBrowserProvider } from "../packages/teamlead/dist/lead-capabilities/browser-provider.js";
import { buildBrowserSandboxSpec } from "../packages/teamlead/dist/lead-capabilities/browser-sandbox.js";

import { verifyNativeHeadedChrome } from "./lib/fly2519-browser-process.mjs";

// Isolated host evidence only: no registry, credential, production provider or user profile.
const require = createRequire(
	new URL("../packages/teamlead/package.json", import.meta.url),
);
const root = realpathSync(
	mkdtempSync(join(tmpdir(), "fly2519-browser-canary-")),
);
const evidenceRoot = realpathSync(
	mkdtempSync(join(tmpdir(), "fly2519-browser-evidence-")),
);
const evidenceLog = join(evidenceRoot, "canary.jsonl");
const emit = (data) => {
	const line = JSON.stringify({ ...data, evidenceLog });
	appendFileSync(evidenceLog, `${line}\n`, { mode: 0o600 });
	console.log(line);
};
const projectRoot = join(root, "project"),
	qaParentRoot = join(root, "qa"),
	artifactRoot = join(projectRoot, "artifacts");
for (const path of [projectRoot, qaParentRoot, artifactRoot])
	mkdirSync(path, { mode: 0o700 });
const store = new LeadArtifactStore({
	projectRoot,
	artifactRoot,
	assertCurrent: () => {},
});
let provider,
	current = true,
	revoked = false,
	stage = "startup";
const started = Date.now();
const assertCurrent = () => {
	if (!current) throw new Error("canary_closed");
};
try {
	stage = "host-identity";
	verifyBrowserHostIdentity({
		nodeExecutable: process.execPath,
		chromeExecutable:
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	});
	stage = "sandbox-configuration";
	const probeRoot = join(qaParentRoot, "configuration-probe");
	mkdirSync(probeRoot, { mode: 0o700 });
	const launch = buildBrowserSandboxSpec({
		packageRoot: dirname(require.resolve("chrome-devtools-mcp/package.json")),
		nodeExecutable: process.execPath,
		chromeExecutable:
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		qaRoot: probeRoot,
		projectRoot,
		proxyPort: 4311,
	});
	stage = "seatbelt-node-launch";
	try {
		execFileSync(
			launch.command,
			[
				"-p",
				launch.policy,
				launch.args[2],
				"-e",
				"process.stdout.write('node-canary')",
			],
			{
				cwd: launch.cwd,
				env: launch.env,
				encoding: "utf8",
				timeout: 5000,
				maxBuffer: 4096,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (error) {
		const diagnostic = String(error.stderr ?? error.message).slice(0, 4096);
		emit({ stage, diagnostic });
		throw new Error(
			diagnostic
				.split("\n")
				.some(
					(line) =>
						line.trim() ===
						"sandbox-exec: sandbox_apply: Operation not permitted",
				)
				? "nested_sandbox_unavailable"
				: "seatbelt_node_launch_failed",
		);
	}
	rmSync(probeRoot, { recursive: true, force: true });
	stage = "isolation-and-mcp-startup";
	provider = await startBrowserProvider({
		activationId: "isolated-host-canary",
		projectRoot,
		qaParentRoot,
		packageRoot: dirname(require.resolve("chrome-devtools-mcp/package.json")),
		nodeExecutable: process.execPath,
		chromeExecutable:
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		store,
		assertCurrent,
		egress: () => ({
			protectedOrigins: [],
			protectedPorts: [],
			localQaTargets: [],
		}),
		revokeQaIdentity: async () => {
			revoked = true;
		},
	});
	stage = "chrome-launch";
	const result = await provider.handlers.get("browser.list_pages").execute(
		{ generation: provider.generation, arguments: {} },
		{
			projectName: "isolated",
			leadId: "isolated",
			activationId: "isolated-host-canary",
			requestId: randomUUID(),
			signal: AbortSignal.timeout(15000),
			assertCurrent: async () => assertCurrent(),
		},
	);
	if (result.status !== "succeeded" || result.data?.isError === true)
		throw new Error("chrome_launch_unproven");
	stage = "native-headed-chrome";
	emit({ stage, ...verifyNativeHeadedChrome(qaParentRoot) });
	stage = "forced-egress";
	const denied = await fetch(`http://127.0.0.1:${provider.proxyPort}/`, {
		signal: AbortSignal.timeout(5000),
	});
	await denied.body?.cancel();
	if (denied.status !== 403) throw new Error("forced_egress_unproven");
	stage = "close";
	await provider.close();
	if (!revoked) throw new Error("browser_revocation_unproven");
	const after = await provider.handlers.get("browser.list_pages").execute(
		{ generation: provider.generation, arguments: {} },
		{
			projectName: "isolated",
			leadId: "isolated",
			activationId: "isolated-host-canary",
			requestId: randomUUID(),
			signal: AbortSignal.timeout(1000),
			assertCurrent: async () => assertCurrent(),
		},
	);
	if (after.status === "succeeded")
		throw new Error("closed_browser_still_callable");
	emit({
		status: "passed",
		node: process.version,
		elapsedMs: Date.now() - started,
		checks: [
			"Seatbelt synthetic canaries",
			"pinned MCP initialization",
			"native Chrome list_pages",
			"forced-egress proxy refusal and Seatbelt network canaries",
			"session invalidation",
		],
	});
} catch (error) {
	emit({
		status: "failed",
		stage,
		code: error instanceof Error ? error.message : "unknown",
		node: process.version,
		elapsedMs: Date.now() - started,
	});
	process.exitCode = 1;
} finally {
	try {
		await provider?.close();
	} finally {
		current = false;
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
}

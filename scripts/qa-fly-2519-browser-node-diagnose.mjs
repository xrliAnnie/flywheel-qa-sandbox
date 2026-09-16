#!/usr/bin/env node
// Read-only host diagnostic for QA's Node SIGABRT. Never changes the deployed
// policy, reads credentials, starts a Lead/Chrome, or claims browser acceptance.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BROWSER_HOST_BASELINE } from "../packages/teamlead/dist/lead-capabilities/browser-host-identity.js";
import { buildBrowserSandboxSpec } from "../packages/teamlead/dist/lead-capabilities/browser-sandbox.js";

if (process.platform !== "darwin") throw new Error("macos_host_required");
const require = createRequire(
	new URL("../packages/teamlead/package.json", import.meta.url),
);
const root = realpathSync(
	mkdtempSync(join(tmpdir(), "fly2519-node-diagnose-")),
);
try {
	const qaRoot = join(root, "qa"),
		projectRoot = join(root, "project");
	mkdirSync(qaRoot, { mode: 0o700 });
	mkdirSync(projectRoot, { mode: 0o700 });
	const launch = buildBrowserSandboxSpec({
		packageRoot: dirname(require.resolve("chrome-devtools-mcp/package.json")),
		nodeExecutable: BROWSER_HOST_BASELINE.node.path,
		chromeExecutable: join(
			BROWSER_HOST_BASELINE.chrome.root,
			"Contents/MacOS/Google Chrome",
		),
		qaRoot,
		projectRoot,
		proxyPort: 4311,
	});
	// Every probe runs only this literal trusted program, with a fresh private HOME
	// and the original executable/write/network restrictions. Candidate additions
	// never grant global file-data reads. Results are diagnostic, not production rules.
	const program =
		"const os=require('node:os');require('node:crypto').randomUUID();process.stdout.write(JSON.stringify({version:process.version,cpus:os.availableParallelism(),memory:os.totalmem()}))";
	const candidates = [
		["baseline", ""],
		["metadata", "(allow file-read-metadata)"],
		["devices", '(allow file-read* (subpath "/dev"))'],
		[
			"dyld",
			'(allow file-read* (subpath "/System/Library/dyld") (subpath "/private/preboot/Cryptexes/OS/usr/lib"))',
		],
		[
			"metadata-devices",
			'(allow file-read-metadata)\n(allow file-read* (subpath "/dev"))',
		],
		[
			"metadata-dyld",
			'(allow file-read-metadata)\n(allow file-read* (subpath "/System/Library/dyld") (subpath "/private/preboot/Cryptexes/OS/usr/lib"))',
		],
	];
	let passes = 0;
	for (const [name, files] of candidates) {
		for (const sysctl of [false, true]) {
			const started = Date.now();
			const result = spawnSync(
				launch.command,
				[
					"-p",
					`${launch.policy}\n${files}\n${sysctl ? "(allow sysctl-read)" : ""}`,
					launch.args[2],
					"-e",
					program,
				],
				{
					cwd: launch.cwd,
					env: launch.env,
					encoding: "utf8",
					timeout: 10000,
					maxBuffer: 4096,
				},
			);
			const nested = result.stderr?.includes(
				"sandbox_apply: Operation not permitted",
			);
			let observed;
			try {
				observed = JSON.parse(result.stdout);
			} catch {}
			const passed =
				result.status === 0 &&
				observed?.version === BROWSER_HOST_BASELINE.node.version &&
				observed.cpus > 0 &&
				observed.memory > 0;
			if (passed) passes++;
			console.log(
				JSON.stringify({
					candidate: name,
					sysctlRead: sysctl ? "all" : "baseline",
					passed,
					status: result.status,
					signal: result.signal,
					error: result.error?.code,
					elapsedMs: Date.now() - started,
					diagnostic: nested
						? "nested_sandbox_unavailable"
						: result.stderr?.slice(0, 4096),
					observed,
					scope: "node_startup_diagnostic_only",
				}),
			);
			if (nested) throw new Error("nested_sandbox_unavailable");
		}
	}
	if (!passes) throw new Error("no_candidate_booted_node");
} catch (error) {
	console.error(error instanceof Error ? error.message : "diagnostic_failed");
	process.exitCode = 1;
} finally {
	rmSync(root, { recursive: true, force: true });
}

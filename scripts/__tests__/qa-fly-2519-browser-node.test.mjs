import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BROWSER_UPSTREAM_SCHEMA_DIGEST } from "../../packages/teamlead/dist/lead-capabilities/browser-config.js";
import { startBrowserEgressProxy } from "../../packages/teamlead/dist/lead-capabilities/browser-egress-proxy.js";
import { BROWSER_HOST_BASELINE } from "../../packages/teamlead/dist/lead-capabilities/browser-host-identity.js";
import { verifyBrowserIsolation } from "../../packages/teamlead/dist/lead-capabilities/browser-isolation.js";
import {
	browserCredentialProbeRoot,
	buildBrowserSandboxSpec,
} from "../../packages/teamlead/dist/lead-capabilities/browser-sandbox.js";
import { BrowserWorker } from "../../packages/teamlead/dist/lead-capabilities/browser-worker.js";

import { verifyNativeHeadedChrome } from "../lib/fly2519-browser-process.mjs";

test("final policy denies non-enumerated home secrets and limits Crashpad and its children to metadata", (t) => {
	if (process.platform !== "darwin")
		return t.skip("host-only: requires macOS Seatbelt");
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "fly2519-home-boundary-")),
	);
	const home = join(root, "home"),
		qaRoot = join(root, "qa"),
		projectRoot = join(root, "project");
	const previousHome = process.env.HOME;
	try {
		for (const path of [home, qaRoot, projectRoot])
			mkdirSync(path, { mode: 0o700 });
		const require = createRequire(
			new URL("../../packages/teamlead/package.json", import.meta.url),
		);
		// Synthetic home, never overwrite or read an existing user's credentials.
		// Construct the real production policy; no policy replacement or process mock.
		process.env.HOME = home;
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
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		const files = [
			"Dev/unlisted-repository/.env",
			".zprofile",
			".zshenv",
			".bash_profile",
			".profile",
			".future-secret",
		].map((name) => join(home, name));
		for (const file of files) {
			mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
			writeFileSync(file, "SYNTHETIC-NOT-A-REAL-SECRET", {
				flag: "wx",
				mode: 0o600,
			});
		}
		const library = join(home, "Library/Application Support"),
			crashpad = join(library, "Google/Chrome/Crashpad");
		mkdirSync(crashpad, { recursive: true, mode: 0o700 });
		const crashpadNew = join(crashpad, "new");
		mkdirSync(crashpadNew, { mode: 0o700 });
		const dump = join(crashpadNew, "synthetic-dump");
		writeFileSync(dump, "SYNTHETIC", { flag: "wx", mode: 0o600 });
		const xattrName = "org.flywheel.synthetic";
		const xattrValue = "SYNTHETIC-NOT-A-REAL-SECRET";
		for (const target of [crashpad, crashpadNew, files[0]]) {
			const seeded = spawnSync(
				"/usr/bin/xattr",
				["-w", xattrName, xattrValue, target],
				{
					encoding: "utf8",
					timeout: 10000,
				},
			);
			assert.equal(seeded.status, 0, seeded.stderr);
		}
		const link = join(qaRoot, "home-secret-link");
		symlinkSync(files[0], link);
		const result = spawnSync(
			launch.command,
			[
				"-p",
				launch.policy,
				launch.args[2],
				"-e",
				`
const fs=require('node:fs'),p=JSON.parse(process.argv[1]);
const denied=f=>{try{f();return false}catch(e){return ['EACCES','EPERM'].includes(e.code)}};
process.stdout.write(JSON.stringify({
version:process.version,
readDenied:p.files.every(f=>denied(()=>fs.readFileSync(f))),
metadataDenied:p.files.every(f=>denied(()=>fs.statSync(f))),
symlinkDenied:denied(()=>fs.readFileSync(p.link)),
enumerationDenied:denied(()=>fs.readdirSync(p.library)),
crashpadMetadata:fs.statSync(p.crashpad).isDirectory(),
crashpadChildMetadata:fs.statSync(p.crashpadNew).isDirectory(),
crashpadDataDenied:denied(()=>fs.readdirSync(p.crashpad))&&denied(()=>fs.readdirSync(p.crashpadNew))&&denied(()=>fs.readFileSync(p.dump))
}));`,
				JSON.stringify({ files, link, library, crashpad, crashpadNew, dump }),
			],
			{
				cwd: launch.cwd,
				env: launch.env,
				encoding: "utf8",
				timeout: 10000,
				maxBuffer: 4096,
			},
		);
		if (result.stderr?.includes("sandbox_apply: Operation not permitted"))
			return t.skip("nested_sandbox_unavailable: no host acceptance evidence");
		assert.equal(
			result.status,
			0,
			`signal=${result.signal}, error=${result.error?.code}, stderr=${result.stderr}`,
		);
		assert.deepEqual(JSON.parse(result.stdout), {
			version: BROWSER_HOST_BASELINE.node.version,
			readDenied: true,
			metadataDenied: true,
			symlinkDenied: true,
			enumerationDenied: true,
			crashpadMetadata: true,
			crashpadChildMetadata: true,
			crashpadDataDenied: true,
		});
		// Lead cb2b9cb9: direct getxattr avoids xattr CLI file opens. The
		// helper applies the exact generated policy to itself before the syscalls.
		// No extra execution, mapping or file-read permissions are added.
		const helper = join(root, "xattr-probe");
		const compile = spawnSync(
			"/usr/bin/clang",
			[
				"-Wno-deprecated-declarations",
				new URL("../lib/fly2519-xattr-probe.c", import.meta.url).pathname,
				"-o",
				helper,
			],
			{ encoding: "utf8", timeout: 30000 },
		);
		assert.equal(compile.status, 0, compile.stderr);
		const policyFile = join(root, "xattr-policy.sb");
		assert.ok(
			launch.policy.includes(
				`(allow file-read-xattr (subpath ${JSON.stringify(crashpad)}))`,
			),
			"generated xattr grant must match synthetic Crashpad",
		);
		writeFileSync(policyFile, launch.policy, { mode: 0o600, flag: "wx" });
		const observed = spawnSync(
			helper,
			[policyFile, crashpad, crashpadNew, files[0], xattrName, xattrValue],
			{ cwd: launch.cwd, env: launch.env, encoding: "utf8", timeout: 10000 },
		);
		assert.equal(
			observed.status,
			0,
			JSON.stringify({ stdout: observed.stdout, stderr: observed.stderr }),
		);
		assert.deepEqual(JSON.parse(observed.stdout), {
			directoryXattrReadable: true,
			childXattrReadable: true,
			outsideXattrDenied: true,
		});
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
});

// Host regression: build first, then run with node --test. No mocked process,
// alternate policy or unsandboxed fallback. Ruling 7eddea27 permits explicit
// host-only/nested-sandbox skips; a skip never supplies the required host proof.
test(
	"final Seatbelt policy boots pinned Node, MCP and native Chrome",
	{ timeout: 180000 },
	async (t) => {
		if (process.platform !== "darwin") {
			t.skip(
				"host-only: requires a macOS QA host; no Seatbelt acceptance evidence",
			);
			return;
		}
		const require = createRequire(
			new URL("../../packages/teamlead/package.json", import.meta.url),
		);
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "fly2519-node-regression-")),
		);
		let worker, proxy;
		try {
			const qaRoot = join(root, "qa"),
				projectRoot = join(root, "project");
			mkdirSync(qaRoot, { mode: 0o700 });
			mkdirSync(projectRoot, { mode: 0o700 });
			const launch = buildBrowserSandboxSpec({
				packageRoot: dirname(
					require.resolve("chrome-devtools-mcp/package.json"),
				),
				nodeExecutable: BROWSER_HOST_BASELINE.node.path,
				chromeExecutable: join(
					BROWSER_HOST_BASELINE.chrome.root,
					"Contents/MacOS/Google Chrome",
				),
				qaRoot,
				projectRoot,
				proxyPort: 4311,
			});
			const deniedRoot = browserCredentialProbeRoot(qaRoot);
			mkdirSync(deniedRoot, { mode: 0o700 });
			const secret = join(deniedRoot, "synthetic-credential"),
				link = join(qaRoot, "credential-link");
			writeFileSync(secret, "SYNTHETIC-NOT-A-REAL-SECRET", { mode: 0o600 });
			symlinkSync(secret, link);
			const result = spawnSync(
				launch.command,
				[
					"-p",
					launch.policy,
					launch.args[2],
					"-e",
					"const os=require('node:os'),fs=require('node:fs'),paths=JSON.parse(process.argv[1]);require('node:crypto').randomUUID();const denied=p=>{try{fs.readFileSync(p);return false}catch(e){return ['EACCES','EPERM'].includes(e.code)}};process.stdout.write(JSON.stringify({version:process.version,cpus:os.availableParallelism(),memory:os.totalmem(),readDenied:denied(paths.secret),symlinkDenied:denied(paths.link)}))",
					JSON.stringify({ secret, link }),
				],
				{
					cwd: launch.cwd,
					env: launch.env,
					encoding: "utf8",
					timeout: 10000,
					maxBuffer: 4096,
				},
			);
			if (result.stderr?.includes("sandbox_apply: Operation not permitted")) {
				t.skip(
					"nested_sandbox_unavailable: rerun on the unsandboxed macOS QA host; no acceptance evidence",
				);
				return;
			}
			const diagnostic = `Node failed: signal=${result.signal}, error=${result.error?.code}, stderr=${result.stderr}`;
			assert.equal(result.status, 0, diagnostic);
			const observed = JSON.parse(result.stdout);
			assert.equal(observed.version, BROWSER_HOST_BASELINE.node.version);
			assert.ok(observed.cpus > 0);
			assert.ok(observed.memory > 0);
			assert.equal(observed.readDenied, true);
			assert.equal(observed.symlinkDenied, true);
			t.diagnostic(
				"final-policy Node startup, readDenied and symlinkDenied passed",
			);
			// Real final-policy launch catches macOS shell-variant exec denials.
			const chromeVersion = spawnSync(
				launch.command,
				["-p", launch.policy, join(qaRoot, "chrome-arm64"), "--version"],
				{
					cwd: launch.cwd,
					env: launch.env,
					encoding: "utf8",
					timeout: 10000,
					maxBuffer: 4096,
				},
			);
			assert.equal(
				chromeVersion.status,
				0,
				`Final-policy Chrome failed: signal=${chromeVersion.signal}, error=${chromeVersion.error?.code}, stderr=${chromeVersion.stderr}`,
			);
			assert.match(chromeVersion.stdout, /^Google Chrome \d+\./);
			t.diagnostic("final-policy pinned Chrome argv launcher passed");
			// The production verifier exclusively creates this same synthetic root.
			rmSync(link);
			rmSync(deniedRoot, { recursive: true });
			for (const name of ["profile", "tmp", "artifacts"])
				mkdirSync(join(qaRoot, name), { mode: 0o700 });
			const egress = () => ({
				protectedOrigins: [],
				protectedPorts: [],
				localQaTargets: [],
			});
			proxy = await startBrowserEgressProxy({
				policy: egress,
				assertCurrent() {},
			});
			worker = new BrowserWorker({
				input: {
					packageRoot: dirname(
						require.resolve("chrome-devtools-mcp/package.json"),
					),
					nodeExecutable: BROWSER_HOST_BASELINE.node.path,
					chromeExecutable: join(
						BROWSER_HOST_BASELINE.chrome.root,
						"Contents/MacOS/Google Chrome",
					),
					qaRoot,
					projectRoot,
					proxyPort: proxy.port,
				},
				artifactRoot: join(qaRoot, "artifacts"),
				expectedUpstreamSchemaDigest: BROWSER_UPSTREAM_SCHEMA_DIGEST,
				assertCurrent() {},
				egress,
				verifyIsolation: (finalLaunch) =>
					verifyBrowserIsolation(finalLaunch, { proxyPort: proxy.port }),
			});
			// start performs real initialize and tools/list, checking the pinned digest.
			const generation = await worker.start();
			t.diagnostic("final-policy MCP initialize and pinned tools/list passed");
			const { result: pages } = await worker.call(generation, "list_pages", {});
			assert.notEqual(pages.isError, true, JSON.stringify(pages));
			assert.ok(Array.isArray(pages.content) && pages.content.length > 0);
			t.diagnostic(JSON.stringify(verifyNativeHeadedChrome(qaRoot)));
			t.diagnostic("final-policy native headed Chrome list_pages passed");
		} finally {
			try {
				await worker?.close();
			} finally {
				try {
					await proxy?.close();
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}
		}
	},
);

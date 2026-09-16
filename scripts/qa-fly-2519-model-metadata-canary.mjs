#!/usr/bin/env node
// Host-only, synthetic fixture. No auth, model turn, production config or MCP execution.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderLeadPermissionProfile } from "../packages/teamlead/dist/lead-capabilities/permission-profile.js";

const codex = realpathSync(join(homedir(), ".local/bin/codex"));
assert.equal(
	createHash("sha256").update(readFileSync(codex)).digest("hex"),
	"195ace4100a634a9df39147f493e730e666b5bd87795f3c9f3251d8542400424",
	"pinned_codex_binary_drift",
);
const fixtureParent = join(homedir(), ".flywheel", "qa");
mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });
const root = realpathSync(
	mkdtempSync(join(fixtureParent, "fly2519-model-metadata-")),
);
const project = join(root, "project"),
	home = join(root, "home");
try {
	for (const name of [
		"home",
		"project",
		"deployment",
		"artifacts",
		"credentials",
	])
		mkdirSync(join(root, name), { mode: 0o700 });
	for (const name of [".codex", ".git", ".git/hooks"])
		mkdirSync(join(project, name), { mode: 0o700 });
	const spec = {
		deploymentRoot: join(root, "deployment"),
		projectRoot: project,
		artifactRoot: join(root, "artifacts"),
		readPaths: [codex],
		credentialPaths: [join(root, "credentials")],
		brokerSocket: join(root, "broker.sock"),
		proxyPort: 32767,
	};
	writeFileSync(join(home, "config.toml"), renderLeadPermissionProfile(spec), {
		mode: 0o600,
	});
	const env = {
		HOME: root,
		CODEX_HOME: home,
		PATH: "/usr/bin:/bin",
		TMPDIR: root,
	};
	const run = (args) =>
		spawnSync(codex, args, {
			cwd: project,
			env,
			encoding: "utf8",
			timeout: 30000,
			maxBuffer: 65536,
		});
	assert.match(run(["--version"]).stdout, /0\.153\.2/);
	const probe = run([
		"sandbox",
		"--permission-profile",
		"flywheel-lead-v2",
		"--cd",
		project,
		"--",
		"/bin/sh",
		"-c",
		`
set -eu
printf source > ordinary-source.txt
printf 'SOURCE_WRITE_OK\\n'
if printf '[mcp_servers.evilprobe]\\ncommand="/usr/bin/true"\\n' > .codex/config.toml; then echo CONFIG_WRITABLE; exit 41; fi
if printf git > .git/config; then echo GIT_WRITABLE; exit 42; fi
if printf hook > .git/hooks/pre-commit; then echo HOOK_WRITABLE; exit 43; fi
printf 'METADATA_WRITE_DENIED\\n'
`,
	]);
	if (probe.stderr?.includes("sandbox_apply: Operation not permitted"))
		throw new Error(
			"nested_sandbox_unavailable: rerun unsandboxed; no host acceptance",
		);
	assert.equal(
		probe.status,
		0,
		JSON.stringify({
			stdout: probe.stdout,
			stderr: probe.stderr,
			error: probe.error?.message,
		}),
	);
	assert.match(probe.stdout, /SOURCE_WRITE_OK/);
	assert.match(probe.stdout, /METADATA_WRITE_DENIED/);
	assert.equal(
		readFileSync(join(project, "ordinary-source.txt"), "utf8"),
		"source",
	);
	const listed = run(["mcp", "list", "--json"]);
	assert.equal(listed.status, 0, listed.stderr);
	const servers = JSON.parse(listed.stdout);
	assert.ok(Array.isArray(servers));
	assert.ok(
		!servers.some((server) => server.name === "evilprobe"),
		"planted_server_loaded",
	);
	console.log(
		JSON.stringify({
			status: "pass",
			ordinarySourceWritable: true,
			codexConfigWriteDenied: true,
			gitConfigWriteDenied: true,
			gitHookWriteDenied: true,
			plantedServerAbsent: true,
			isolatedHome: true,
			authCopied: false,
			modelTurnStarted: false,
			productionWrites: false,
		}),
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}

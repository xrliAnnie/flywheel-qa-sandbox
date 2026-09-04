#!/usr/bin/env node

import {
	accessSync,
	chmodSync,
	constants,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const [repoRoot, slotRoot, agentId, codexCommand] = process.argv.slice(2);
const SLOT_RE = /^\/(?:private\/)?tmp\/flywheel-test-slot-[1-9][0-9]*$/;
const AGENT_RE = /^[a-z0-9][a-z0-9-]*$/;
const RELEASE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(message) {
	throw new Error(`[qa-codex-home] ${message}`);
}

function releaseRootFor(command) {
	if (!isAbsolute(command)) fail("Codex command must be absolute");
	const binary = realpathSync(command);
	if (!lstatSync(binary).isFile()) fail("Codex command must resolve to a file");
	const parent = dirname(binary);
	const root = basename(parent) === "bin" ? dirname(parent) : parent;
	const rootCommand = join(root, "codex");
	if (!existsSync(rootCommand) || realpathSync(rootCommand) !== binary) {
		fail("Codex command is not a standalone release");
	}
	if (!RELEASE_RE.test(basename(root))) fail("Codex release name is invalid");
	return root;
}

async function main() {
	if (!repoRoot || !slotRoot || !agentId || !codexCommand) {
		fail("usage: <repo-root> <slot-root> <agent-id> <codex-command>");
	}
	if (
		!isAbsolute(repoRoot) ||
		!isAbsolute(slotRoot) ||
		!SLOT_RE.test(slotRoot)
	) {
		fail("repository and slot roots must be absolute QA paths");
	}
	if (!AGENT_RE.test(agentId)) fail("agent id is invalid");
	const slotReal = realpathSync(slotRoot);
	if (!SLOT_RE.test(slotReal))
		fail("slot root resolves outside the QA namespace");
	const homesRoot = join(slotReal, "cdxh");
	mkdirSync(homesRoot, { recursive: true, mode: 0o700 });
	const homesInfo = lstatSync(homesRoot);
	if (homesInfo.isSymbolicLink() || !homesInfo.isDirectory()) {
		fail("Codex homes root must be a real directory");
	}
	if (realpathSync(homesRoot) !== homesRoot) {
		fail("Codex homes root resolves outside the slot");
	}
	chmodSync(homesRoot, 0o700);
	const home = join(homesRoot, agentId);
	if (existsSync(home)) fail("destination Codex home already exists");
	if (
		Buffer.byteLength(
			join(home, "app-server-control", "app-server-control.sock"),
			"utf8",
		) > 100
	) {
		fail("Codex daemon socket path exceeds 100 bytes");
	}

	const releaseRoot = releaseRootFor(codexCommand);
	const releaseName = basename(releaseRoot);
	const provisionerUrl = pathToFileURL(
		join(repoRoot, "packages/claude-runner/dist/index.js"),
	).href;
	let provisioned = false;
	try {
		const { provisionCodexHome } = await import(provisionerUrl);
		if (typeof provisionCodexHome !== "function") {
			fail("production Codex provisioner is unavailable");
		}
		const env = {
			...process.env,
			FLYWHEEL_CODEX_HOMES_ROOT: homesRoot,
		};
		const result = provisionCodexHome({
			executionId: agentId,
			env,
			ledgerRoot: join(slotReal, "state", "codex-account-ledger"),
		});
		if (result !== home || realpathSync(result) !== realpathSync(home)) {
			fail("production provisioner returned the wrong home");
		}
		provisioned = true;

		// The shared birth engine owns credential selection and copying. The
		// resident Lead layer owns its own policy, prompt, and skills, so discard
		// only those non-credential runner artifacts before ensure-home assembles
		// the carrier-specific config.
		rmSync(join(home, "config.toml"), { force: true });
		rmSync(join(home, "AGENTS.md"), { force: true });
		rmSync(join(home, "skills"), { recursive: true, force: true });

		const releases = join(home, "packages", "standalone", "releases");
		mkdirSync(releases, { recursive: true, mode: 0o700 });
		cpSync(releaseRoot, join(releases, releaseName), {
			recursive: true,
			force: false,
			mode: constants.COPYFILE_FICLONE,
		});
		const current = join(home, "packages", "standalone", "current");
		const relativeTarget = join("releases", releaseName);
		symlinkSync(relativeTarget, current, "dir");
		const installed = realpathSync(join(current, "codex"));
		if (!lstatSync(installed).isFile())
			fail("installed Codex command is invalid");
		accessSync(installed, constants.X_OK);
	} catch (error) {
		if (provisioned || existsSync(home)) {
			rmSync(home, { recursive: true, force: true });
		}
		throw error;
	}
}

main().catch((error) => {
	console.error(
		error instanceof Error ? error.message : "[qa-codex-home] failed",
	);
	process.exitCode = 1;
});

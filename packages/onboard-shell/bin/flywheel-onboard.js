#!/usr/bin/env node
// FLY-1062 PR2 · public thin shell entry — the ONE command a customer runs.
// Zero prompts/copy/build-artifacts of its own; it exchanges a license key
// for the gated payload and hands off to the packaged Buddy onboard.
//
//   flywheel-onboard            install (or re-exec if already installed)
//   flywheel-onboard license set   rotate the stored license key
//   flywheel-onboard update        update to the latest payload version
import { resolveConfig } from "../lib/config.mjs";
import { runLicenseSet } from "../lib/license.mjs";
import { MSG } from "../lib/messages.mjs";
import { runOnboard } from "../lib/onboard.mjs";
import { runUpdate } from "../lib/update.mjs";

const io = {
	out: (s) => process.stdout.write(s),
	err: (s) => process.stderr.write(String(s).replace(/\n?$/, "\n")),
	input: process.stdin,
	output: process.stdout,
};

async function main(argv) {
	const cfg = resolveConfig(process.env);
	const cmd = argv[0];
	if (cmd === "license" && argv[1] === "set") return runLicenseSet(cfg, { io });
	if (cmd === "update") return runUpdate(cfg, { io });
	if (cmd && cmd !== "install") {
		// NEVER echo the argv back — a customer who mistypes their license key
		// as an argument must not have it reflected to the terminal (Codex R1#6).
		io.err(MSG.unknownCommand);
		return 2;
	}
	return runOnboard(cfg, { io });
}

main(process.argv.slice(2))
	.then((code) => process.exit(code || 0))
	.catch((_e) => {
		io.err(`安装遇到意外错误,请重试或联系我们。`);
		process.exit(1);
	});

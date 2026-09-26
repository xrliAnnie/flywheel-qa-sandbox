#!/usr/bin/env node
// FLY-1062 broker PR · shell publish PREPARE stage (plan §3 ③).
//
// Two-stage shell publishing, symmetric with the payload promote:
//   prepare (HERE, untrusted domain ok): `npm pack` the EXACT tarball →
//     sha256 → stage it under the publish-staging dir → print the broker
//     request tuple. The founder's approval will bind THIS sha256.
//   publish (broker only): the broker re-verifies the staged bytes with the
//     AUTHORITATIVE content gate + rehash, then publishes with the in-memory
//     GAT. Nothing this script does is trusted by the broker — it only
//     stages and reports.
//
// Usage:
//   node scripts/release/shell-prepare.mjs [--out <stage-dir>] [--allow-placeholder]
//
// Prints ONE JSON line: {action, releaseId, sha256, stagedPath, name, version}
// (the exact broker-request body; releaseId = shell-<version>, deterministic).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = path.join(SELF_DIR, "..", "..", "packages", "onboard-shell");

function die(msg) {
	console.error(`[shell-prepare] ${msg}`);
	process.exit(1);
}

function argValue(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const allowPlaceholder = process.argv.includes("--allow-placeholder");

const pkg = JSON.parse(
	fs.readFileSync(path.join(SHELL_DIR, "package.json"), "utf8"),
);
if (pkg.private) die("package is private:true — not a publishable form");

// fast feedback only — the AUTHORITATIVE gate re-runs in the broker
if (
	!allowPlaceholder &&
	fs
		.readFileSync(path.join(SHELL_DIR, "lib", "config.mjs"), "utf8")
		.includes("flywheel.invalid")
) {
	die(
		"DEFAULT_ENDPOINT is still the placeholder — fill the real hosting URL before staging a publish (override for tests: --allow-placeholder)",
	);
}

const stageDir = path.resolve(
	argValue(
		"out",
		process.env.FW_SHELL_STAGE_DIR ||
			path.join(os.homedir(), ".flywheel", "publish-staging", "shell"),
	),
);
fs.mkdirSync(stageDir, { recursive: true });

const packOut = fs.mkdtempSync(path.join(os.tmpdir(), "fw-shell-pack-"));
const packed = execFileSync("npm", ["pack", "--pack-destination", packOut], {
	cwd: SHELL_DIR,
	encoding: "utf8",
})
	.trim()
	.split("\n")
	.pop();
const packedPath = path.join(packOut, packed);
if (!fs.existsSync(packedPath)) die("npm pack produced no tarball");

const bytes = fs.readFileSync(packedPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const stagedPath = path.join(
	stageDir,
	`${pkg.name.split("/").pop()}-${pkg.version}.tgz`,
);
fs.copyFileSync(packedPath, stagedPath);
fs.rmSync(packOut, { recursive: true, force: true });

process.stdout.write(
	`${JSON.stringify({
		action: "publish-shell",
		releaseId: `shell-${pkg.version}`,
		sha256,
		stagedPath,
		name: pkg.name,
		version: pkg.version,
	})}\n`,
);

#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(packageRoot, "native", "reclose-peer", "addon.cc");
const outputDirectory = resolve(
	process.env.FLYWHEEL_RECLOSE_PEER_NATIVE_OUT_DIR ??
		join(packageRoot, "dist", "native"),
);
const output = join(
	outputDirectory,
	`reclose-peer-${process.platform}-${process.arch}.node`,
);
const statusPath = join(outputDirectory, "reclose-peer-build-status.json");

await mkdir(outputDirectory, { recursive: true });
await rm(output, { force: true });

async function recordStatus(status) {
	await writeFile(
		statusPath,
		`${JSON.stringify(
			{
				...status,
				platform: process.platform,
				arch: process.arch,
				napi: process.versions.napi ?? null,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

async function unavailable(reason, detail) {
	await recordStatus({ available: false, reason, detail });
	process.stderr.write(
		`[reclose-peer-native] peer_adapter_unavailable: ${reason}: ${detail}\n`,
	);
}

if (process.platform !== "darwin") {
	await unavailable(
		"unsupported_platform",
		"native peer verification is enabled only on Darwin source deployments",
	);
	process.exit(0);
}

if (process.env.FLYWHEEL_RECLOSE_PEER_NATIVE_FORCE_FAIL === "1") {
	await unavailable("native_build_failed", "forced failure injection");
	process.exit(0);
}

const headerCandidates = [
	process.env.npm_config_nodedir
		? join(process.env.npm_config_nodedir, "include", "node")
		: undefined,
	join(resolve(dirname(process.execPath), ".."), "include", "node"),
	"/opt/homebrew/include/node",
	"/usr/local/include/node",
].filter(Boolean);

let nodeInclude;
for (const candidate of headerCandidates) {
	try {
		await access(join(candidate, "node_api.h"), constants.R_OK);
		nodeInclude = candidate;
		break;
	} catch {
		// Try the next local header root. Never download headers at build time.
	}
}

if (!nodeInclude) {
	await unavailable(
		"native_build_failed",
		`Node headers not found in local roots: ${headerCandidates.join(", ")}`,
	);
	process.exit(0);
}

const compiler = process.env.CXX || "clang++";
const args = [
	"-std=c++17",
	"-O2",
	"-fPIC",
	"-dynamiclib",
	"-undefined",
	"dynamic_lookup",
	`-I${nodeInclude}`,
	source,
	"-o",
	output,
];
const result = spawnSync(compiler, args, { encoding: "utf8" });
if (result.error || result.status !== 0) {
	await unavailable(
		"native_build_failed",
		(result.error?.message || result.stderr || `compiler exit ${result.status}`)
			.trim()
			.slice(0, 2_000),
	);
	process.exit(0);
}

await recordStatus({
	available: true,
	reason: "built",
	compiler,
	headerRoot: nodeInclude,
	output,
});
process.stdout.write(`[reclose-peer-native] built ${output}\n`);

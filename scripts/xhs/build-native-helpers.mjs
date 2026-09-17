// Offline fixed-source C helper assembly. Never installs or runs privileged code.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const sources = [
	["xhs-peer-credentials", "scripts/xhs/xhs-peer-credentials.c"],
	["xhs-authority-launcher", "scripts/xhs/xhs-authority-launcher.c"],
	["xhs-fixture-principal", "scripts/xhs/xhs-fixture-principal.c"],
	["xhs-installer-bootstrap", "scripts/xhs/xhs-installer-bootstrap.c"],
	[
		"xhs-browser-guardian",
		".claude/worktrees/xiaohongshu-mcp/guardian/xhs-browser-guardian.c",
	],
];
const headers = [
	"scripts/xhs/xhs-installation-verify.h",
	"scripts/xhs/xhs-native-tree.h",
	"scripts/xhs/xhs-native-manifest.h",
];
const hash = (path) =>
	createHash("sha256").update(readFileSync(path)).digest("hex");
try {
	const output = process.argv[3];
	if (
		process.getuid?.() === 0 ||
		process.platform !== "darwin" ||
		process.arch !== "arm64" ||
		process.argv.length !== 4 ||
		process.argv[2] !== "--output-dir" ||
		!isAbsolute(output) ||
		normalize(output) !== output ||
		output.endsWith("/")
	)
		throw Error();
	const inputs = [...sources.map(([, path]) => path), ...headers].map(
		(path) => ({ path, sha256: hash(join(repo, path)) }),
	);
	mkdirSync(output, { mode: 0o700 });
	const files = [];
	for (const [name, source] of sources) {
		const path = join(output, name);
		execFileSync(
			"/usr/bin/cc",
			["-Wall", "-Wextra", "-Werror", "-O2", join(repo, source), "-o", path],
			{
				env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
				timeout: 30000,
				maxBuffer: 128 * 1024,
			},
		);
		files.push({ path: name, sha256: hash(path) });
	}
	for (const input of inputs)
		if (hash(join(repo, input.path)) !== input.sha256) throw Error();
	const receipt = {
		schemaVersion: 1,
		kind: "offline_native_helpers",
		hostAcceptance: false,
		inputs,
		files,
	};
	writeFileSync(
		join(output, "build-receipt.json"),
		`${JSON.stringify(receipt)}\n`,
		{ flag: "wx", mode: 0o600 },
	);
	process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch {
	process.stderr.write("offline_native_helpers_unavailable\n");
	process.exitCode = 1;
}

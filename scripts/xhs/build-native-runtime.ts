// Offline, unprivileged assembly of the reviewed macOS arm64 Node/SQLite pair.
// No downloads, package installation, signing, or host/service changes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { inspectNativeLoadCommands } from "../../packages/teamlead/src/xiaohongshu-write/native-assets.js";
import { buildRuntime } from "./build-runtime.mjs";

const pins = {
	node: "e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b",
	"better_sqlite3.node":
		"7fd5c877dee29bd0cad8850eff93e82589d55f118934d9b333095fe64bb6faca",
	LICENSE: "5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace",
	ffmpeg: "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584",
	ffprobe: "bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64",
	"media.LICENSE":
		"cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2",
	"media.README":
		"05ba4b92c96605434b1aaae3eedf5a2c280c9607bf78ffca9a5b536d9af2dc6a",
} as const;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function readPinned(path: string, digest: string) {
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024 * 1024)
			throw Error();
		const bytes = readFileSync(fd);
		if (sha(bytes) !== digest) throw Error();
		return bytes;
	} finally {
		closeSync(fd);
	}
}

try {
	if (
		process.platform !== "darwin" ||
		process.arch !== "arm64" ||
		process.getuid?.() === 0 ||
		process.argv.length !== 6 ||
		process.argv[2] !== "--assets" ||
		process.argv[4] !== "--output-dir"
	)
		throw Error();
	const assets = process.argv[3]!,
		output = process.argv[5]!;
	for (const path of [assets, output])
		if (!isAbsolute(path) || normalize(path) !== path || path.endsWith("/"))
			throw Error();
	// Measure all inputs before creating output. No caller-supplied digest override.
	const node = readPinned(join(assets, "node"), pins.node);
	const addon = readPinned(
		join(assets, "better_sqlite3.node"),
		pins["better_sqlite3.node"],
	);
	const license = readPinned(join(assets, "LICENSE"), pins.LICENSE);
	const media = [
		{ source: "ffmpeg", path: "ffmpeg", mode: 0o755 },
		{ source: "ffprobe", path: "ffprobe", mode: 0o755 },
		{ source: "media.LICENSE", path: "licenses/media.txt", mode: 0o644 },
		{ source: "media.README", path: "licenses/media-readme.txt", mode: 0o644 },
	] as const;
	const mediaFiles = media.map((item) => ({
		...item,
		bytes: readPinned(join(assets, item.source), pins[item.source]),
	}));
	const receipt = await buildRuntime(output, addon);
	for (const item of mediaFiles)
		writeFileSync(join(output, item.path), item.bytes, {
			flag: "wx",
			mode: item.mode,
		});
	writeFileSync(join(output, "node"), node, { flag: "wx", mode: 0o755 });
	writeFileSync(join(output, "licenses/node.txt"), license, {
		flag: "wx",
		mode: 0o644,
	});
	const env = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
	const dependencies: Record<string, string[]> = {};
	for (const [name, path, digest] of [
		["node", join(output, "node"), pins.node],
		["ffmpeg", join(output, "ffmpeg"), pins.ffmpeg],
		["ffprobe", join(output, "ffprobe"), pins.ffprobe],
		[
			"sqlite",
			join(
				output,
				"node_modules/better-sqlite3/build/Release/better_sqlite3.node",
			),
			pins["better_sqlite3.node"],
		],
	]) {
		readPinned(path!, digest!);
		dependencies[name!] = inspectNativeLoadCommands(
			execFileSync("/usr/bin/otool", ["-l", path!], {
				env,
				encoding: "utf8",
				timeout: 10000,
				maxBuffer: 256 * 1024,
			}),
		);
	}
	const probe = execFileSync(
		join(output, "node"),
		[
			"--input-type=module",
			"-e",
			"import Database from 'better-sqlite3'; if(process.version!=='v24.21.0'||process.versions.modules!=='137')throw Error(); const db=new Database(':memory:');const value=db.prepare('select 41+1 value').get().value;db.close();if(value!==42)throw Error();console.log('node24-sqlite137-ok');",
		],
		{ cwd: output, env, encoding: "utf8", timeout: 10000, maxBuffer: 4096 },
	);
	if (probe !== "node24-sqlite137-ok\n") throw Error();
	for (const name of ["ffmpeg", "ffprobe"] as const) {
		const version = execFileSync(join(output, name), ["-version"], {
			cwd: output,
			env,
			encoding: "utf8",
			timeout: 10000,
			maxBuffer: 16384,
		});
		// b6.1.1 is the upstream asset release tag; these arm64 binaries report 6.0.
		if (!version.startsWith(`${name} version 6.0 `)) throw Error();
		readPinned(join(output, name), pins[name]);
	}
	readPinned(join(output, "node"), pins.node);
	readPinned(
		join(
			output,
			"node_modules/better-sqlite3/build/Release/better_sqlite3.node",
		),
		pins["better_sqlite3.node"],
	);
	for (const [path, bytes] of [
		["node", node],
		["licenses/node.txt", license],
	] as const)
		receipt.files.push({ path, bytes: bytes.length, sha256: sha(bytes) });
	for (const item of mediaFiles)
		receipt.files.push({
			path: item.path,
			bytes: item.bytes.length,
			sha256: sha(item.bytes),
		});
	receipt.files.sort((a: { path: string }, b: { path: string }) =>
		a.path.localeCompare(b.path),
	);
	process.stdout.write(
		`${JSON.stringify({ ...receipt, kind: "offline_native_js_runtime", bytes: receipt.bytes + node.length + license.length + mediaFiles.reduce((sum, item) => sum + item.bytes.length, 0), nodeVersion: "24.21.0", sqliteVersion: "12.8.0", abi: 137, mediaRelease: "b6.1.1", mediaBinaryVersion: "6.0", dependencies, hostAcceptance: false })}\n`,
	);
} catch {
	// Retain any partial exclusive output for diagnosis; never reuse it.
	process.stderr.write("offline_native_runtime_unavailable\n");
	process.exitCode = 1;
}

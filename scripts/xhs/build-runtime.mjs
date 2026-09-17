// Offline artifact builder. Never installed as a privileged helper; fixed source
// entries and fixed SQLite runtime files only. No install, account or service IO.
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version } from "esbuild";

const repo = realpathSync(
	join(dirname(fileURLToPath(import.meta.url)), "../.."),
);
const names = ["installer-main", "authority-main", "boundary-probe-entry"];
const builtin = new Set(
	builtinModules.map((name) => name.replace(/^node:/, "")),
);
export async function buildRuntime(output, sqliteAddon) {
	if (
		process.getuid?.() === 0 ||
		version !== "0.25.10" ||
		!isAbsolute(output) ||
		normalize(output) !== output ||
		output.endsWith(sep) ||
		(sqliteAddon !== undefined && !Buffer.isBuffer(sqliteAddon))
	)
		throw Error("offline_runtime_build_unavailable");
	mkdirSync(output, { mode: 0o700 }); // Exclusive; failed artifacts are retained.
	let total = 0,
		count = 0;
	const files = [];
	const write = (path, bytes) => {
		count++;
		total += bytes.length;
		if (
			count > 256 ||
			bytes.length > 16 * 1024 * 1024 ||
			total > 64 * 1024 * 1024
		)
			throw Error("runtime_artifact_limit");
		const destination = join(output, path);
		if (
			relative(output, destination).startsWith("..") ||
			!path ||
			isAbsolute(path)
		)
			throw Error("runtime_artifact_path");
		mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
		writeFileSync(destination, bytes, {
			flag: "wx",
			mode:
				path ===
				"packages/teamlead/dist/xiaohongshu-write/boundary-probe-entry.js"
					? 0o755
					: 0o644,
		});
		files.push({
			path,
			bytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		});
	};
	const copy = (source, path) => {
		const stat = lstatSync(source);
		if (stat.isDirectory()) {
			for (const name of readdirSync(source).sort())
				copy(join(source, name), `${path}/${name}`);
		} else {
			if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
				throw Error("runtime_source_unavailable");
			write(path, readFileSync(source));
		}
	};
	const outdir = join(output, "packages/teamlead/dist/xiaohongshu-write");
	const result = await build({
		absWorkingDir: repo,
		entryPoints: names.map(
			(name) => `packages/teamlead/src/xiaohongshu-write/${name}.ts`,
		),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		external: ["better-sqlite3"],
		outdir,
		write: false,
		metafile: true,
		sourcemap: false,
		logLevel: "silent",
	});
	if (result.warnings.length) throw Error("runtime_bundle_warning");
	const imports = [
		...new Set(
			Object.values(result.metafile.outputs)
				.flatMap((output) => output.imports)
				.filter((item) => item.external)
				.map((item) => item.path),
		),
	].sort();
	if (
		imports.some(
			(name) =>
				name !== "better-sqlite3" && !builtin.has(name.replace(/^node:/, "")),
		)
	)
		throw Error("runtime_external_unavailable");
	for (const file of result.outputFiles)
		write(relative(output, file.path), file.contents);
	write("package.json", Buffer.from('{"private":true,"type":"module"}\n'));
	copy(join(repo, "scripts/xhs/installer-entry.mjs"), "installer-entry.js");
	const req = createRequire(join(repo, "packages/teamlead/package.json"));
	const sqlite = req.resolve("better-sqlite3/package.json");
	const bindings = createRequire(sqlite).resolve("bindings/package.json");
	const uri = createRequire(bindings).resolve("file-uri-to-path/package.json");
	for (const [name, manifest, paths] of [
		[
			"better-sqlite3",
			sqlite,
			["package.json", "LICENSE", "lib", "build/Release/better_sqlite3.node"],
		],
		["bindings", bindings, ["package.json", "LICENSE.md", "bindings.js"]],
		["file-uri-to-path", uri, ["package.json", "LICENSE", "index.js"]],
	])
		for (const path of paths) {
			const target = `node_modules/${name}/${path}`;
			if (
				name === "better-sqlite3" &&
				path === "build/Release/better_sqlite3.node" &&
				sqliteAddon
			)
				write(target, sqliteAddon);
			else copy(join(dirname(manifest), path), target);
		}
	const zod = req.resolve("zod/package.json");
	copy(join(dirname(zod), "LICENSE"), "licenses/zod.txt");
	return {
		schemaVersion: 1,
		kind: "offline_js_runtime",
		esbuildVersion: version,
		externalImports: imports,
		files: files.sort((a, b) => a.path.localeCompare(b.path)),
		bytes: total,
	};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv.length !== 4 || process.argv[2] !== "--output-dir")
			throw Error();
		process.stdout.write(
			`${JSON.stringify(await buildRuntime(process.argv[3]))}\n`,
		);
	} catch {
		process.stderr.write("offline_runtime_build_unavailable\n");
		process.exitCode = 1;
	}
}

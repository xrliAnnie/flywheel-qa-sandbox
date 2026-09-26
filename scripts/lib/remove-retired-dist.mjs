#!/usr/bin/env node
// FLY-2860: `tsc` never deletes the outputs of source files that were removed,
// and package-onboard copies dist/ verbatim. A reused checkout would keep
// shipping retired modules. Each package lists its retired outputs in a
// version-controlled `retired-outputs.json`; its build runs this first.
//
// usage: node scripts/lib/remove-retired-dist.mjs <package-dir>
//
// retired-outputs.json: { "stems": ["cli", "audio/resample"], "dirs": ["huddle"] }
//   stems expand to <stem>.js / .d.ts / .js.map / .d.ts.map under dist/;
//   dirs are removed recursively. Every entry must stay inside <package>/dist.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OUTPUT_EXTENSIONS = [".js", ".d.ts", ".js.map", ".d.ts.map"];

function validEntry(entry) {
	if (typeof entry !== "string" || entry.length === 0) return false;
	if (entry.includes("\0") || entry.includes("\\")) return false;
	if (path.isAbsolute(entry)) return false;
	return entry
		.split("/")
		.every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function readManifest(pkgDir) {
	const file = path.join(pkgDir, "retired-outputs.json");
	const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	const stems = parsed?.stems ?? [];
	const dirs = parsed?.dirs ?? [];
	if (!Array.isArray(stems) || !Array.isArray(dirs)) {
		throw new Error("retired_outputs_invalid: stems/dirs must be arrays");
	}
	for (const entry of [...stems, ...dirs]) {
		if (!validEntry(entry)) {
			throw new Error(
				`retired_outputs_invalid_entry: ${JSON.stringify(entry)}`,
			);
		}
	}
	return { stems, dirs };
}

// A parent directory that resolves outside dist (symlink escape) is refused.
function assertInsideDist(realDist, target) {
	let probe = path.dirname(target);
	while (!fs.existsSync(probe)) probe = path.dirname(probe);
	const real = fs.realpathSync(probe);
	if (real !== realDist && !real.startsWith(`${realDist}${path.sep}`)) {
		throw new Error(
			`retired_outputs_escape: ${path.relative(realDist, target)}`,
		);
	}
}

/** Plan every removal first so an invalid entry deletes nothing. */
export function planRetiredOutputs(pkgDir) {
	const { stems, dirs } = readManifest(pkgDir);
	const dist = path.join(pkgDir, "dist");
	if (!fs.existsSync(dist)) return [];
	if (fs.lstatSync(dist).isSymbolicLink()) {
		throw new Error("retired_outputs_escape: dist is a symlink");
	}
	const realDist = fs.realpathSync(dist);
	const targets = [
		...stems.flatMap((stem) =>
			OUTPUT_EXTENSIONS.map((ext) => path.join(dist, `${stem}${ext}`)),
		),
		...dirs.map((dir) => path.join(dist, dir)),
	];
	for (const target of targets) assertInsideDist(realDist, target);
	return targets;
}

export function removeRetiredDist(pkgDir) {
	let removed = 0;
	for (const target of planRetiredOutputs(pkgDir)) {
		let stat;
		try {
			stat = fs.lstatSync(target);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			throw error;
		}
		if (stat.isDirectory()) fs.rmSync(target, { recursive: true });
		else fs.unlinkSync(target);
		removed++;
	}
	return removed;
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
) {
	const pkgDir = process.argv[2];
	if (!pkgDir) {
		console.error("usage: remove-retired-dist.mjs <package-dir>");
		process.exit(2);
	}
	try {
		const removed = removeRetiredDist(path.resolve(pkgDir));
		console.log(
			`remove-retired-dist: removed ${removed} retired output path(s)`,
		);
	} catch (error) {
		console.error(`remove-retired-dist: ${error.message}`);
		process.exit(1);
	}
}

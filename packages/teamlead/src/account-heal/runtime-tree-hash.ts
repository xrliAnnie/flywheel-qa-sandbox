import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Deterministic digest of the owner-controlled JavaScript runtime tree. */
export function runtimeTreeSha256(root: string): string {
	const uid = process.getuid?.();
	if (uid === undefined)
		throw new Error("runtime tree owner identity unavailable");
	const suppliedRootStat = lstatSync(root);
	if (
		!suppliedRootStat.isDirectory() ||
		suppliedRootStat.isSymbolicLink() ||
		suppliedRootStat.uid !== uid
	) {
		throw new Error("FLY-1252 runtime tree root is unsafe");
	}
	const rootPath = realpathSync(root);
	const files: string[] = [];
	const visit = (directory: string): void => {
		const directoryStat = lstatSync(directory);
		if (
			!directoryStat.isDirectory() ||
			directoryStat.isSymbolicLink() ||
			directoryStat.uid !== uid
		) {
			throw new Error("FLY-1252 runtime tree contains an unsafe directory");
		}
		for (const name of readdirSync(directory).sort()) {
			const entry = join(directory, name);
			const stat = lstatSync(entry);
			if (stat.isSymbolicLink()) {
				throw new Error("FLY-1252 runtime tree contains a symlink");
			}
			if (stat.isDirectory()) {
				visit(entry);
			} else if (stat.isFile() && name.endsWith(".js")) {
				if (stat.uid !== uid) {
					throw new Error("FLY-1252 runtime tree contains a foreign file");
				}
				files.push(entry);
			}
		}
	};
	visit(rootPath);
	if (files.length === 0)
		throw new Error("FLY-1252 runtime tree has no JavaScript");
	const digest = createHash("sha256");
	for (const file of files.sort()) {
		const name = relative(rootPath, file).split(sep).join("/");
		const bytes = readFileSync(file);
		digest.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`);
		digest.update(bytes);
	}
	return digest.digest("hex");
}

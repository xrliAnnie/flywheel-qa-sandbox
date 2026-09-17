import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CATEGORIES = Object.freeze({
	teamlead: [
		"deleteTarget",
		"retiredOptional",
		"protectedAuthority",
		"protectedCurrentOrReference",
	],
	comm: [
		"deleteTarget",
		"protectedCurrentOrAuthority",
		"protectedCurrentOrReference",
	],
});
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function compileRetentionEntries(entries) {
	const result = Object.fromEntries(
		Object.entries(CATEGORIES).map(([database, categories]) => [
			database,
			Object.fromEntries(categories.map((category) => [category, []])),
		]),
	);
	const seen = new Set();
	for (const entry of entries) {
		if (
			!entry ||
			typeof entry !== "object" ||
			Array.isArray(entry) ||
			Object.keys(entry).sort().join(",") !== "classification,database,table" ||
			typeof entry.database !== "string" ||
			!Object.hasOwn(CATEGORIES, entry.database) ||
			typeof entry.table !== "string" ||
			!/^[a-z][a-z0-9_]*$/.test(entry.table) ||
			entry.table.startsWith("sqlite_") ||
			typeof entry.classification !== "string" ||
			!CATEGORIES[entry.database].includes(entry.classification)
		)
			throw new Error("retention_entry_invalid");
		const identity = `${entry.database}:${entry.table}`;
		if (seen.has(identity))
			throw new Error(`schema_registry_overlap:${entry.database}`);
		seen.add(identity);
		result[entry.database][entry.classification].push(entry.table);
	}
	for (const categories of Object.values(result)) {
		for (const names of Object.values(categories)) Object.freeze(names.sort());
		Object.freeze(categories);
	}
	return Object.freeze(result);
}

// root is the fragment directory; source inputs are its fixed siblings.
// Input paths are relative to the module directory (scripts/lib in production).
export function loadRetentionSnapshot(root) {
	// Strip trailing separators before lstat: a trailing slash follows directory symlinks.
	const directory = resolve(fileURLToPath(root));
	const moduleRoot = dirname(directory);
	const prefix = "fly-2006-retention-tables";
	const inputs = [];
	const entries = [];
	function requireKind(path, relative, kind) {
		let stat;
		try {
			stat = lstatSync(path);
		} catch {
			throw new Error(`retention_path_invalid:${relative}`);
		}
		if (
			stat.isSymbolicLink() ||
			!(kind === "directory" ? stat.isDirectory() : stat.isFile())
		)
			throw new Error(`retention_path_invalid:${relative}`);
	}
	function readInput(path, relative) {
		requireKind(path, relative, "file");
		const bytes = readFileSync(path);
		inputs.push(Object.freeze({ path: relative, sha256: sha256(bytes) }));
		return bytes;
	}
	requireKind(directory, prefix, "directory");
	for (const name of readdirSync(directory).sort()) {
		if (!Object.hasOwn(CATEGORIES, name))
			throw new Error(`retention_path_invalid:${prefix}/${name}`);
	}
	for (const database of Object.keys(CATEGORIES)) {
		const dbDirectory = join(directory, database);
		requireKind(dbDirectory, `${prefix}/${database}`, "directory");
		const filenames = readdirSync(dbDirectory).sort();
		if (filenames.length === 0)
			throw new Error(`retention_database_empty:${database}`);
		for (const filename of filenames) {
			const relative = `${prefix}/${database}/${filename}`;
			if (!filename.endsWith(".json"))
				throw new Error(`retention_path_invalid:${relative}`);
			const bytes = readInput(join(dbDirectory, filename), relative);
			let entry;
			try {
				entry = JSON.parse(bytes.toString("utf8"));
			} catch {
				throw new Error(`retention_json_invalid:${relative}`);
			}
			try {
				compileRetentionEntries([entry]);
			} catch {
				throw new Error(`retention_entry_invalid:${relative}`);
			}
			if (entry.database !== database || filename !== `${entry.table}.json`)
				throw new Error(`retention_identity_mismatch:${relative}`);
			entries.push(entry);
		}
	}
	for (const name of [
		"fly-2006-retention-loader.mjs",
		"fly-2006-retention-registry.mjs",
	])
		readInput(join(moduleRoot, name), name);
	inputs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return Object.freeze({
		classifications: compileRetentionEntries(entries),
		inputs: Object.freeze(inputs),
		digest: sha256(
			JSON.stringify({
				format: "fly-2413-retention-inputs-v1",
				inputs: inputs.map(({ path, sha256 }) => [path, sha256]),
			}),
		),
	});
}

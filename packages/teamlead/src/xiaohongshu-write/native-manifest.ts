import { posix } from "node:path";
import { parseInstalledTreeManifest } from "./installed-tree.js";

/** Deterministic root-policy-pinned native projection. This only serializes a
 * reviewed inventory; it never measures files or authorizes execution. */
export function projectNativeManifest(raw: string): string {
	try {
		const manifest = parseInstalledTreeManifest(raw);
		if (manifest.root !== "/Library/Application Support/Flywheel/Xhs/runtime")
			throw Error();
		const directories = new Set<string>(),
			needed = new Set<string>();
		const rows: string[] = [];
		for (const entry of [...manifest.entries].sort((a, b) =>
			a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
		)) {
			const path = entry.path;
			if (
				[...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126) ||
				path.startsWith(" ") ||
				path.endsWith(" ") ||
				path.includes("  ") ||
				path
					.split("/")
					.some(
						(part) =>
							part === ".." || part.startsWith(" ") || part.endsWith(" "),
					)
			)
				throw Error();
			if (entry.kind === "directory") {
				directories.add(path);
				continue;
			}
			let parent = posix.dirname(path);
			while (parent !== ".") {
				needed.add(parent);
				parent = posix.dirname(parent);
			}
			rows.push(
				`${entry.sha256} ${entry.mode.toString(8).padStart(4, "0")} 0:0 ${path}\n`,
			);
		}
		if (
			!rows.length ||
			directories.size !== needed.size ||
			[...directories].some((path) => !needed.has(path))
		)
			throw Error();
		const output = rows.join("");
		if (Buffer.byteLength(output) > 4 * 1024 * 1024) throw Error();
		return output;
	} catch {
		throw Error("native_manifest_unavailable");
	}
}

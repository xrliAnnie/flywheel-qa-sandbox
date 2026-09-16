import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { isAbsolute } from "node:path";
/** Load once in the trusted parent. The resulting immutable text, not a later
 * re-read of launcher paths, is supplied to v2 thread start and resume. */
export function readManifestMarkdown(
	sources: readonly { path: string; sha256: string }[],
	secrets: readonly string[],
): readonly string[] {
	try {
		if (sources.length === 0 || sources.length > 256) throw new Error();
		const parts: string[] = [];
		let total = 0;
		for (const source of sources) {
			if (!isAbsolute(source.path) || !source.path.endsWith(".md"))
				throw new Error();
			const path = realpathSync(source.path);
			const fd = openSync(
				path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				const before = fstatSync(fd);
				if (
					!before.isFile() ||
					before.size === 0 ||
					before.size > 1024 * 1024 ||
					total + before.size > 4 * 1024 * 1024
				)
					throw new Error();
				const buffer = Buffer.alloc(before.size + 1);
				const size = readSync(fd, buffer, 0, buffer.length, 0),
					after = fstatSync(fd);
				if (
					size !== before.size ||
					after.size !== before.size ||
					after.mtimeMs !== before.mtimeMs ||
					after.ctimeMs !== before.ctimeMs
				)
					throw new Error();
				const bytes = buffer.subarray(0, size);
				if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
					throw new Error();
				const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				if (
					secrets.some((secret) => secret.length > 0 && text.includes(secret))
				)
					throw new Error();
				const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
				if (!body) throw new Error();
				parts.push(text);
				total += size;
			} finally {
				closeSync(fd);
			}
		}
		return parts;
	} catch {
		throw new Error("capability_rules_unverified");
	}
}

export function readManifestInstructions(
	sources: readonly { path: string; sha256: string }[],
	secrets: readonly string[],
): string {
	return readManifestMarkdown(sources, secrets)
		.map((text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim())
		.join("\n\n");
}

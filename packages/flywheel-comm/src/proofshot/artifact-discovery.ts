/**
 * GEO-151 ProofShot — discover + categorize artifact files in the output dir.
 *
 * Bridge between the on-disk reality of `proofshot stop`'s output and the
 * pure `selectVisionArtifacts()` selector (which expects `ArtifactFile[]`).
 *
 * Categorization is name-based — ProofShot writes `SUMMARY.md`, numbered
 * `step-NN-<desc>.png`, and `session-<id>.webm`. We don't trust extensions
 * blindly — we also check the file is a regular file (not a dir, symlink to
 * the wrong thing, etc.) and skip anything unreadable.
 */

import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { ArtifactFile } from "../select-vision-artifacts.js";

export interface DiscoverOptions {
	/**
	 * Hint regex matched against the basename — files where the match
	 * suggests "error" rank the highest in PNG selection.
	 */
	errorPattern?: RegExp;
	/**
	 * Hint regex matched against the basename — files where the match
	 * suggests "key" rank above generic.
	 */
	keyPattern?: RegExp;
}

const DEFAULT_ERROR_PATTERN = /error|fail|exception/i;
const DEFAULT_KEY_PATTERN = /\bkey\b|\bcritical\b/i;

/**
 * Walk one level deep (non-recursive) and return categorized artifacts.
 * Files are sorted by name for deterministic first/last ranking.
 */
export function discoverArtifacts(
	outputDir: string,
	options: DiscoverOptions = {},
): ArtifactFile[] {
	const errorPattern = options.errorPattern ?? DEFAULT_ERROR_PATTERN;
	const keyPattern = options.keyPattern ?? DEFAULT_KEY_PATTERN;

	let entries: string[];
	try {
		entries = readdirSync(outputDir);
	} catch {
		return [];
	}
	entries.sort();

	const out: ArtifactFile[] = [];
	for (const entry of entries) {
		const full = join(outputDir, entry);
		let bytes: number;
		try {
			const st = statSync(full);
			if (!st.isFile()) continue;
			bytes = st.size;
		} catch {
			continue;
		}
		const kind = categorize(entry);
		const file: ArtifactFile = { path: full, bytes, kind };
		if (kind === "png") {
			if (errorPattern.test(entry)) file.isError = true;
			else if (keyPattern.test(entry)) file.isKey = true;
		}
		out.push(file);
	}
	return out;
}

function categorize(name: string): ArtifactFile["kind"] {
	const lower = name.toLowerCase();
	if (lower === "summary.md") return "summary";
	const ext = extname(lower);
	if (ext === ".png") return "png";
	if (ext === ".webm" || ext === ".mp4" || ext === ".mov") return "webm";
	return "other";
}

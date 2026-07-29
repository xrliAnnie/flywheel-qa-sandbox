import type { CanonicalValue } from "./digests.js";
import { digestJson } from "./digests.js";
import { DagContractError } from "./errors.js";
import type { GitPort, ManifestEntry } from "./types.js";

const MAX_ENTRIES = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const REGULAR_MODES = new Set(["000000", "100644", "100755"]);

function validPath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.startsWith("/") &&
		!path.includes("\0") &&
		!path
			.split("/")
			.some((part) => part === "" || part === "." || part === "..")
	);
}

function classify(path: string): ManifestEntry["classification"] {
	const lower = path.toLowerCase();
	if (
		/(^|\/)(__tests__|tests?|specs?)(\/|$)/.test(lower) ||
		/\.(test|spec)\.[^/]+$/.test(lower)
	) {
		return "test";
	}
	if (
		/^(doc|docs|engineering\/doc|product\/doc)\//.test(lower) ||
		/(^|\/)(readme|changelog|contributing)(\.[^/]*)?$/.test(lower) ||
		/\.(md|mdx|txt|rst)$/.test(lower)
	) {
		return "docs";
	}
	return "product";
}

function strictest(
	left: ManifestEntry["classification"],
	right: ManifestEntry["classification"],
): ManifestEntry["classification"] {
	const rank = { docs: 0, test: 1, product: 2 } as const;
	return rank[left] >= rank[right] ? left : right;
}

export function parseRawManifest(raw: string): ManifestEntry[] {
	if (Buffer.byteLength(raw) > MAX_BYTES) {
		throw new DagContractError("git manifest exceeds byte limit");
	}
	if (raw.length === 0) return [];
	const tokens = raw.split("\0");
	if (tokens.at(-1) === "") tokens.pop();
	const entries: ManifestEntry[] = [];
	let cursor = 0;
	while (cursor < tokens.length) {
		const header = tokens[cursor];
		cursor += 1;
		if (header === undefined)
			throw new DagContractError("manifest header missing");
		const match =
			/^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([ADMRC])(\d{0,3})$/.exec(
				header,
			);
		if (!match) throw new DagContractError("unsupported git manifest record");
		const [, oldMode, newMode, , , status] = match;
		if (
			oldMode === undefined ||
			newMode === undefined ||
			status === undefined ||
			!REGULAR_MODES.has(oldMode) ||
			!REGULAR_MODES.has(newMode)
		) {
			throw new DagContractError("manifest contains a non-regular file");
		}
		const firstPath = tokens[cursor];
		cursor += 1;
		if (firstPath === undefined || !validPath(firstPath)) {
			throw new DagContractError("manifest path is invalid");
		}
		if (status === "R" || status === "C") {
			const secondPath = tokens[cursor];
			cursor += 1;
			if (secondPath === undefined || !validPath(secondPath)) {
				throw new DagContractError("manifest destination path is invalid");
			}
			entries.push({
				status: status as ManifestEntry["status"],
				oldPath: firstPath,
				path: secondPath,
				classification: strictest(classify(firstPath), classify(secondPath)),
			});
		} else {
			entries.push({
				status: status as ManifestEntry["status"],
				path: firstPath,
				classification: classify(firstPath),
			});
		}
		if (entries.length > MAX_ENTRIES) {
			throw new DagContractError("git manifest exceeds entry limit");
		}
	}
	return entries;
}

export async function readManifest(
	git: GitPort,
	worktreePath: string,
	base: string,
	head: string,
): Promise<{ entries: ManifestEntry[]; digest: string }> {
	if (!(await git.isAncestor(worktreePath, base, head))) {
		throw new DagContractError("span anchor diverged");
	}
	const raw = await git.rawDiff(worktreePath, base, head);
	const entries = parseRawManifest(raw);
	return {
		entries,
		digest: digestJson(entries as unknown as CanonicalValue),
	};
}

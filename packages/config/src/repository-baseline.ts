import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "./canonical-json.js";

export interface RepositoryBaselineEntry {
	relative_path: string;
	remote_identity: string;
	baseline_head: string;
}

export interface RepositoryBaselineSet {
	version: 1;
	repositories: RepositoryBaselineEntry[];
}

export interface RepositoryBaselineSeal {
	json: string;
	digest: string;
}

const SKIP_DISCOVERY_DIRS = new Set([
	".flywheel",
	".pnpm-store",
	"coverage",
	"dist",
	"node_modules",
]);

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 16 * 1024 * 1024,
		timeout: 20_000,
		killSignal: "SIGKILL",
	}).trim();
}

function normalizeRemoteIdentity(raw: string, repoRoot: string): string {
	const value = raw.trim();
	if (!value) {
		const common = git(repoRoot, ["rev-parse", "--git-common-dir"]);
		return `local:${realpathSync(resolve(repoRoot, common))}`;
	}
	const scp = value.match(/^(?:[^@/]+@)?([^:]+):(.+)$/);
	if (scp && !value.includes("://")) {
		return `${scp[1]!.toLowerCase()}/${scp[2]!.replace(/^\/+|\.git$/g, "")}`;
	}
	try {
		const url = new URL(value);
		if (url.protocol === "file:") return `local:${realpathSync(url.pathname)}`;
		return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+|\.git$/g, "")}`;
	} catch {
		return `local:${realpathSync(resolve(repoRoot, value))}`;
	}
}

function contains(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return (
		rel === "" ||
		(!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
	);
}

function discoverRepositoryRoots(authorityRoot: string): string[] {
	const root = realpathSync(authorityRoot);
	const repositories: string[] = [];
	let visited = 0;
	const walk = (directory: string): void => {
		visited += 1;
		if (visited > 100_000) throw new Error("repository_inventory_too_large");
		if (!contains(root, realpathSync(directory))) {
			throw new Error("repository_inventory_containment_failed");
		}
		const entries = readdirSync(directory, { withFileTypes: true }).sort(
			(a, b) => a.name.localeCompare(b.name),
		);
		if (entries.some((entry) => entry.name === ".git")) {
			const top = realpathSync(
				git(directory, ["rev-parse", "--show-toplevel"]),
			);
			if (top !== realpathSync(directory) || !contains(root, top)) {
				throw new Error("repository_inventory_root_mismatch");
			}
			repositories.push(top);
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) {
				if (SKIP_DISCOVERY_DIRS.has(entry.name)) continue;
				const child = resolve(directory, entry.name);
				try {
					if (statSync(child).isDirectory()) {
						throw new Error("repository_inventory_symlink_directory");
					}
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === "repository_inventory_symlink_directory"
					) {
						throw error;
					}
					throw new Error("repository_inventory_symlink_indeterminate");
				}
				continue;
			}
			if (
				entry.name === ".git" ||
				SKIP_DISCOVERY_DIRS.has(entry.name) ||
				!entry.isDirectory()
			) {
				continue;
			}
			const child = resolve(directory, entry.name);
			walk(child);
		}
	};
	walk(root);
	if (!repositories.includes(root)) {
		throw new Error("repository_inventory_authority_root_missing");
	}
	return repositories.sort((left, right) =>
		relative(root, left).localeCompare(relative(root, right)),
	);
}

export function captureRepositoryBaselineSet(
	authorityRoot: string,
): RepositoryBaselineSeal {
	const root = realpathSync(authorityRoot);
	const identities = new Set<string>();
	const repositories = discoverRepositoryRoots(root).map((repoRoot) => {
		const dirty = git(repoRoot, [
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
		]);
		if (dirty) throw new Error("repository_inventory_dirty");
		const head = git(repoRoot, ["rev-parse", "HEAD"]).toLowerCase();
		if (!/^[0-9a-f]{40}$/.test(head)) {
			throw new Error("repository_inventory_head_invalid");
		}
		let remote = "";
		try {
			remote = git(repoRoot, ["config", "--get", "remote.origin.url"]);
		} catch {
			// A local-only repository is identified by its canonical common-dir.
		}
		const remoteIdentity = normalizeRemoteIdentity(remote, repoRoot);
		if (identities.has(remoteIdentity)) {
			throw new Error("repository_inventory_duplicate_identity");
		}
		identities.add(remoteIdentity);
		return {
			relative_path: relative(root, repoRoot).replaceAll(sep, "/") || ".",
			remote_identity: remoteIdentity,
			baseline_head: head,
		};
	});
	const baseline: RepositoryBaselineSet = { version: 1, repositories };
	return {
		json: canonicalJsonString(baseline),
		digest: canonicalSubmissionDigest(baseline),
	};
}

export function verifyRepositoryBaselineSet(input: {
	authorityRoot: string;
	baselineJson: string;
	baselineDigest: string;
}): { ok: true; currentDigest: string } | { ok: false; reason: string } {
	let baseline: unknown;
	try {
		baseline = JSON.parse(input.baselineJson);
	} catch {
		return { ok: false, reason: "repository_baseline_invalid" };
	}
	if (
		canonicalJsonString(baseline) !== input.baselineJson ||
		canonicalSubmissionDigest(baseline) !== input.baselineDigest
	) {
		return { ok: false, reason: "repository_baseline_digest_mismatch" };
	}
	try {
		const current = captureRepositoryBaselineSet(input.authorityRoot);
		return current.json === input.baselineJson
			? { ok: true, currentDigest: current.digest }
			: { ok: false, reason: "repository_baseline_changed" };
	} catch (error) {
		return {
			ok: false,
			reason:
				error instanceof Error ? error.message : "repository_probe_failed",
		};
	}
}

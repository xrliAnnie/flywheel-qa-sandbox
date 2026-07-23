import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BoundRepositoryAuthority {
	path: string;
	identity: string;
	probeRepoSlug: string;
	headSha: string;
}

export function normalizeGitHubRepoSlug(remote: string): string {
	const withoutQuery = remote.split(/[?#]/, 1)[0] ?? remote;
	const pathPart = withoutQuery.includes("://")
		? new URL(withoutQuery).pathname
		: withoutQuery.replace(/^[^@/]+@[^:]+:/, "");
	const pieces = pathPart
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "")
		.split("/")
		.filter(Boolean);
	if (pieces.length < 2) {
		throw new Error("repository origin cannot be normalized to owner/repo");
	}
	const owner = pieces.at(-2)!;
	const repo = pieces.at(-1)!;
	if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
		throw new Error("repository origin contains an invalid owner/repo");
	}
	return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

export async function resolveBoundRepositoryAuthority(input: {
	authorityRoot: string;
	requestedRepoPath?: string;
}): Promise<BoundRepositoryAuthority> {
	const requested = input.requestedRepoPath?.trim();
	const hasControlCharacter = requested
		? [...requested].some((character) => {
				const code = character.charCodeAt(0);
				return code <= 31 || code === 127;
			})
		: false;
	if (
		requested &&
		(isAbsolute(requested) ||
			requested.startsWith("~") ||
			hasControlCharacter ||
			requested.split(/[\\/]/).includes(".."))
	) {
		throw new Error("targetRepoPath must be a safe relative path");
	}
	const root = await realpath(input.authorityRoot);
	const target = requested ? await realpath(resolve(root, requested)) : root;
	const rel = relative(root, target);
	if (
		requested &&
		(!rel ||
			rel === ".." ||
			rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
			isAbsolute(rel))
	) {
		throw new Error("target repository escapes the immutable worktree");
	}
	const { stdout: toplevelOut } = await execFileAsync(
		"git",
		["-C", target, "rev-parse", "--show-toplevel"],
		{ timeout: 15_000 },
	);
	const toplevel = await realpath(toplevelOut.trim());
	if (toplevel !== target) {
		throw new Error("target must resolve to an exact git repository root");
	}
	const [{ stdout: remoteOut }, { stdout: headOut }] = await Promise.all([
		execFileAsync("git", ["-C", target, "remote", "get-url", "origin"], {
			timeout: 15_000,
		}),
		execFileAsync("git", ["-C", target, "rev-parse", "HEAD"], {
			timeout: 15_000,
		}),
	]);
	const headSha = headOut.trim().toLowerCase();
	if (!/^[0-9a-f]{40}$/.test(headSha)) {
		throw new Error("target repository HEAD is invalid");
	}
	const probeRepoSlug = normalizeGitHubRepoSlug(remoteOut.trim());
	return {
		path: target,
		identity: requested ? probeRepoSlug : "__main__",
		probeRepoSlug,
		headSha,
	};
}

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface ResolvedRoleInstruction {
	projectRoot: string;
	/**
	 * Provenance only: the worktree path the pinned blob was addressed by.
	 * FLY-1556: nothing reads this path after resolution — the pinned CONTENT
	 * travels in `content` and is materialized by the launcher into an
	 * engine-owned content-addressed file. A task whose job is to edit its own
	 * node instruction file can therefore run to completion without poisoning
	 * its own pin.
	 */
	sourcePath: string;
	/** FLY-1556: the immutable pin source — the commit the blob was read at. */
	sourceCommit: string;
	/** FLY-1556: the git blob sha of the pinned content (immutable object). */
	sourceBlob: string;
	contentDigest: string;
	contentBytes: number;
	/** The pinned instruction text itself, read from the blob — never from the
	 * mutable working file. */
	content: string;
}

/**
 * FLY-1544 ①: the role/岗位 layer is deleted. The instruction book hangs off
 * the DAG node kind: `.flywheel/agents/nodes/<taskKind>.md`. There is no
 * config.yaml `agents:` section and no logicalAgentId indirection any more --
 * a missing node instruction file fails closed here, at dispatch.
 *
 * FLY-1556: the pin is taken from the worktree's git object store (the blob at
 * HEAD), not from the mutable working file. Admission refuses a dirty worktree
 * and anchors the writer chain at HEAD, so the blob at HEAD IS the admission
 * state of the instruction book; once resolved, the blob sha is immutable no
 * matter what any runner later writes into the working tree.
 */
const NODE_KIND_SHAPE = /^[a-z0-9][a-z0-9_-]*$/;

const LS_TREE_SHAPE = /^(\d{6}) blob ([0-9a-f]{40,64})\t/;

function git(gitBin: string, projectRoot: string, args: string[]): Buffer {
	return execFileSync(gitBin, ["-C", projectRoot, ...args], {
		maxBuffer: 16 * 1024 * 1024,
	});
}

export function resolveRoleInstruction(input: {
	projectRoot: string;
	taskKind: string;
	gitBin?: string;
}): ResolvedRoleInstruction {
	if (!isAbsolute(input.projectRoot)) {
		throw new TypeError("projectRoot must be absolute");
	}
	const gitBin = input.gitBin ?? "/usr/bin/git";
	if (!isAbsolute(gitBin)) {
		throw new TypeError("gitBin must be absolute");
	}
	// The kind becomes a path segment; anything outside the strict shape is
	// refused before any filesystem access so it can never traverse.
	if (!NODE_KIND_SHAPE.test(input.taskKind)) {
		throw new TypeError(
			`task kind ${input.taskKind || "<empty>"} is not a valid node instruction name`,
		);
	}
	const projectRoot = realpathSync.native(input.projectRoot);
	const relativeSource = `.flywheel/agents/nodes/${input.taskKind}.md`;
	const sourcePath = join(projectRoot, relativeSource);
	const fail = (reason: string): never => {
		throw new Error(
			`node instruction for ${input.taskKind} cannot be resolved at ${sourcePath}: ${reason}`,
		);
	};
	let sourceCommit: string;
	try {
		sourceCommit = git(gitBin, projectRoot, ["rev-parse", "HEAD^{commit}"])
			.toString("utf8")
			.trim();
	} catch (error) {
		return fail(
			`worktree HEAD is unreadable (${
				error instanceof Error ? error.message : String(error)
			})`,
		);
	}
	if (!/^[0-9a-f]{40,64}$/.test(sourceCommit)) {
		return fail("worktree HEAD is not a commit");
	}
	let listed: string;
	try {
		listed = git(gitBin, projectRoot, [
			"ls-tree",
			sourceCommit,
			"--",
			relativeSource,
		])
			.toString("utf8")
			.trim();
	} catch (error) {
		return fail(
			`tree entry is unreadable (${
				error instanceof Error ? error.message : String(error)
			})`,
		);
	}
	if (listed.length === 0) {
		return fail(`no committed file at ${sourceCommit.slice(0, 12)}`);
	}
	const entry = LS_TREE_SHAPE.exec(listed);
	if (!entry) {
		// 120000 is a symlink blob, 040000 a tree, 160000 a gitlink — none of
		// them is an instruction book. The regex also refuses multi-line output,
		// which a single exact pathspec cannot legitimately produce.
		return fail("committed entry is not a regular-file blob");
	}
	if (entry[1] !== "100644" && entry[1] !== "100755") {
		return fail(`committed entry mode ${entry[1]} is not a regular file`);
	}
	const sourceBlob = entry[2] as string;
	let content: Buffer;
	try {
		content = git(gitBin, projectRoot, ["cat-file", "blob", sourceBlob]);
	} catch (error) {
		return fail(
			`blob ${sourceBlob} is unreadable (${
				error instanceof Error ? error.message : String(error)
			})`,
		);
	}
	if (content.length === 0 || content.toString("utf8").trim().length === 0) {
		throw new Error("node instruction must contain role instructions");
	}
	return {
		projectRoot,
		sourcePath,
		sourceCommit,
		sourceBlob,
		contentDigest: createHash("sha256").update(content).digest("hex"),
		contentBytes: content.length,
		content: content.toString("utf8"),
	};
}

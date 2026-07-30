import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export interface ResolvedRoleInstruction {
	projectRoot: string;
	sourcePath: string;
	contentDigest: string;
	contentBytes: number;
}

/**
 * FLY-1544 ①: the role/岗位 layer is deleted. The instruction book hangs off
 * the DAG node kind: `.flywheel/agents/nodes/<taskKind>.md`. There is no
 * config.yaml `agents:` section and no logicalAgentId indirection any more --
 * a missing node instruction file fails closed here, at dispatch.
 */
const NODE_KIND_SHAPE = /^[a-z0-9][a-z0-9_-]*$/;

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function regularNonSymlink(path: string, label: string): string {
	if (lstatSync(path).isSymbolicLink()) {
		throw new Error(`${label} must not be a symbolic link`);
	}
	const canonical = realpathSync.native(path);
	if (!statSync(canonical).isFile()) {
		throw new Error(`${label} must be a regular file`);
	}
	return canonical;
}

export function resolveRoleInstruction(input: {
	projectRoot: string;
	taskKind: string;
}): ResolvedRoleInstruction {
	if (!isAbsolute(input.projectRoot)) {
		throw new TypeError("projectRoot must be absolute");
	}
	// The kind becomes a path segment; anything outside the strict shape is
	// refused before any filesystem access so it can never traverse.
	if (!NODE_KIND_SHAPE.test(input.taskKind)) {
		throw new TypeError(
			`task kind ${input.taskKind || "<empty>"} is not a valid node instruction name`,
		);
	}
	const projectRoot = realpathSync.native(input.projectRoot);
	const lexicalSource = join(
		projectRoot,
		".flywheel",
		"agents",
		"nodes",
		`${input.taskKind}.md`,
	);
	if (!contained(projectRoot, lexicalSource)) {
		throw new Error("node instruction escapes the project root");
	}
	let sourcePath: string;
	try {
		sourcePath = regularNonSymlink(
			lexicalSource,
			`node instruction for ${input.taskKind}`,
		);
	} catch (error) {
		throw new Error(
			`node instruction for ${input.taskKind} cannot be resolved at ${lexicalSource}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (!contained(projectRoot, sourcePath)) {
		throw new Error("node instruction resolves outside the project root");
	}
	const content = readFileSync(sourcePath);
	if (content.length === 0 || content.toString("utf8").trim().length === 0) {
		throw new Error("node instruction must contain role instructions");
	}
	return {
		projectRoot,
		sourcePath,
		contentDigest: createHash("sha256").update(content).digest("hex"),
		contentBytes: content.length,
	};
}

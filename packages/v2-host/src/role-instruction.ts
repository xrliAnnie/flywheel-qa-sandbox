import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";

export interface ResolvedRoleInstruction {
	projectRoot: string;
	configPath: string;
	sourcePath: string;
	contentDigest: string;
	contentBytes: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

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
	logicalAgentId: string;
}): ResolvedRoleInstruction {
	if (!isAbsolute(input.projectRoot)) {
		throw new TypeError("projectRoot must be absolute");
	}
	if (input.logicalAgentId.trim().length === 0) {
		throw new TypeError("logicalAgentId must not be empty");
	}
	const projectRoot = realpathSync.native(input.projectRoot);
	const configPath = regularNonSymlink(
		join(projectRoot, ".flywheel", "config.yaml"),
		"project role config",
	);
	if (!contained(projectRoot, configPath)) {
		throw new Error("project role config escapes the project root");
	}
	let config: Record<string, unknown>;
	try {
		config = record(parse(readFileSync(configPath, "utf8")), "project config");
	} catch (error) {
		throw new Error(
			`project role config is malformed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const agents = record(config.agents, "project config agents");
	const entry = record(
		agents[input.logicalAgentId],
		`agent ${input.logicalAgentId}`,
	);
	if (typeof entry.agent_file !== "string" || entry.agent_file.length === 0) {
		throw new Error(`agent ${input.logicalAgentId} has no agent_file`);
	}
	if (isAbsolute(entry.agent_file)) {
		throw new Error("agent_file must be project-relative");
	}
	const lexicalSource = resolve(projectRoot, entry.agent_file);
	if (!contained(projectRoot, lexicalSource)) {
		throw new Error("agent_file escapes the project root");
	}
	const sourcePath = regularNonSymlink(lexicalSource, "agent_file");
	if (!contained(projectRoot, sourcePath)) {
		throw new Error("agent_file resolves outside the project root");
	}
	const content = readFileSync(sourcePath);
	if (content.length === 0 || content.toString("utf8").trim().length === 0) {
		throw new Error("agent_file must contain role instructions");
	}
	return {
		projectRoot,
		configPath,
		sourcePath,
		contentDigest: createHash("sha256").update(content).digest("hex"),
		contentBytes: content.length,
	};
}

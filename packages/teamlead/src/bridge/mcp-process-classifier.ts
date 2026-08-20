/**
 * FLY-1867 — exact Playwright MCP process classifier shared by P0 and P3.
 *
 * Deliberately no command-line substring matching. The npm/npx wrappers are
 * recognized by exact argv positions. The browser-owning inner process is
 * recognized by both its lexical package path and canonical package-local
 * cli.js target. Filesystem inspection failures are unknown, never clean.
 */

import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

export type McpProcessShape =
	| "npm_wrapper"
	| "npx_wrapper"
	| "inner_bin"
	| "inner_cli";

export interface McpProcessInput {
	pid: number;
	ppid: number;
	lstart: string;
	comm: string;
	argv: string[];
}

export interface McpProcessClassification {
	pid: number;
	verdict: "match" | "no_match" | "unknown";
	shape?: McpProcessShape;
	reason: string;
}

export interface McpSnapshotClassification {
	overall: "clean" | "has_match" | "unknown";
	rows: McpProcessClassification[];
}

const packageToken = /^@playwright\/mcp(?:@[^/\s]+)?$/;

function wrapperBinary(input: McpProcessInput): string {
	return basename(input.argv[0] ?? input.comm);
}

function nodeInvocation(input: McpProcessInput): boolean {
	return basename(input.argv[0] ?? input.comm) === "node";
}

function binPackagePaths(
	candidate: string,
): { bin: string; cli: string } | undefined {
	if (!isAbsolute(candidate) || basename(candidate) !== "playwright-mcp") {
		return undefined;
	}
	const binDir = dirname(candidate);
	if (basename(binDir) !== ".bin") return undefined;
	const nodeModules = dirname(binDir);
	if (basename(nodeModules) !== "node_modules") return undefined;
	return {
		bin: normalize(candidate),
		cli: join(nodeModules, "@playwright", "mcp", "cli.js"),
	};
}

function cliPackagePath(candidate: string): string | undefined {
	if (!isAbsolute(candidate) || basename(candidate) !== "cli.js")
		return undefined;
	const mcpDir = dirname(candidate);
	const playwrightDir = dirname(mcpDir);
	const nodeModules = dirname(playwrightDir);
	if (
		basename(mcpDir) !== "mcp" ||
		basename(playwrightDir) !== "@playwright" ||
		basename(nodeModules) !== "node_modules"
	) {
		return undefined;
	}
	return normalize(candidate);
}

export function classifyMcpProcess(
	input: McpProcessInput,
): McpProcessClassification {
	const binary = wrapperBinary(input);
	if (
		binary === "npm" &&
		input.argv.length === 3 &&
		input.argv[1] === "exec" &&
		packageToken.test(input.argv[2] ?? "")
	) {
		return {
			pid: input.pid,
			verdict: "match",
			shape: "npm_wrapper",
			reason: "exact_npm_exec",
		};
	}
	if (
		binary === "npx" &&
		input.argv.length === 2 &&
		packageToken.test(input.argv[1] ?? "")
	) {
		return {
			pid: input.pid,
			verdict: "match",
			shape: "npx_wrapper",
			reason: "exact_npx_package",
		};
	}

	if (!nodeInvocation(input) || input.argv.length !== 2) {
		return {
			pid: input.pid,
			verdict: "no_match",
			reason: "unsupported_argv_shape",
		};
	}

	const script = input.argv[1] ?? "";
	const binPaths = binPackagePaths(script);
	if (binPaths) {
		try {
			if (!lstatSync(binPaths.bin).isSymbolicLink()) {
				return {
					pid: input.pid,
					verdict: "no_match",
					shape: "inner_bin",
					reason: "bin_not_symlink",
				};
			}
			if (realpathSync(binPaths.bin) !== realpathSync(binPaths.cli)) {
				return {
					pid: input.pid,
					verdict: "no_match",
					shape: "inner_bin",
					reason: "bin_target_mismatch",
				};
			}
			return {
				pid: input.pid,
				verdict: "match",
				shape: "inner_bin",
				reason: "package_local_bin_symlink",
			};
		} catch (error) {
			return {
				pid: input.pid,
				verdict: "unknown",
				shape: "inner_bin",
				reason: `filesystem_probe_failed:${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	const cli = cliPackagePath(script);
	if (cli) {
		try {
			const info = lstatSync(cli);
			if (!info.isFile()) {
				return {
					pid: input.pid,
					verdict: "no_match",
					shape: "inner_cli",
					reason: "cli_not_regular_file",
				};
			}
			realpathSync(cli);
			return {
				pid: input.pid,
				verdict: "match",
				shape: "inner_cli",
				reason: "canonical_package_cli",
			};
		} catch (error) {
			return {
				pid: input.pid,
				verdict: "unknown",
				shape: "inner_cli",
				reason: `filesystem_probe_failed:${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	return { pid: input.pid, verdict: "no_match", reason: "not_playwright_mcp" };
}

export function classifyMcpSnapshot(
	rows: readonly McpProcessInput[],
): McpSnapshotClassification {
	const classified = rows.map(classifyMcpProcess);
	const overall = classified.some((row) => row.verdict === "match")
		? "has_match"
		: classified.some((row) => row.verdict === "unknown")
			? "unknown"
			: "clean";
	return { overall, rows: classified };
}

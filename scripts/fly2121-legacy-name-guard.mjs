#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCAN_ROOTS = [".flywheel", ".lead", "packages", "scripts"];
const SOURCE_EXTENSIONS = new Set([
	".cjs",
	".js",
	".json",
	".md",
	".mjs",
	".sh",
	".ts",
	".tsx",
	".yaml",
	".yml",
]);
const RETIRED_PATHS = [
	"menus/shapes",
	".flywheel/agents/design.md",
	".flywheel/agents/designer.md",
	".flywheel/agents/generic.md",
	".flywheel/agents/prototype.md",
	".flywheel/agents/qa.md",
];
const SKIP_DIRS = new Set([".git", "dist", "node_modules", "__tests__"]);
const IDENTITY_PATTERNS = [
	/\b(?:eng_design|product_design|general)\b\s*:\s*["'](?:design|designer|generic)["']/,
	/\bproduct-designer-executor(?:\.md)?\b/,
	/^\s*\|\s*`design`\s*\|/,
	/\brole\s*:\s*["']designer["']/,
	/\bid\s*:\s*["'](?:produce|execute)["']/,
	/\bshape\s*:\s*["']design["']/,
	/\btaskCategory\s*:\s*["']design["']/,
	/\.nodes[^\n]*\.role[^\n]*\[\s*["']design["']\s*,\s*["']implement["']\s*,\s*["']qa["']\s*\]/,
	/\blistWorkflowRunNodes\([^\n]*["']design["']\s*\)/,
	/\bnode_id\s*=\s*["']design["']/i,
];

function extension(path) {
	const dot = path.lastIndexOf(".");
	return dot < 0 ? "" : path.slice(dot);
}

function walk(root, absolute, files) {
	if (!existsSync(absolute)) return;
	for (const entry of readdirSync(absolute, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) continue;
		const target = resolve(absolute, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) walk(root, target, files);
			continue;
		}
		if (entry.isFile() && SOURCE_EXTENSIONS.has(extension(entry.name))) {
			files.push(relative(root, target).split(sep).join("/"));
		}
	}
}

function isRegistryPath(path) {
	return (
		path.endsWith("/.flywheel/agents/registry.yaml") ||
		path === ".flywheel/agents/registry.yaml" ||
		path.startsWith(".flywheel/menus/")
	);
}

/** Return exact active-source violations; historical test fixtures are excluded. */
export function scanLegacyWorkflowNames(repoRoot) {
	const root = resolve(repoRoot);
	const violations = [];
	for (const retiredPath of RETIRED_PATHS) {
		if (existsSync(resolve(root, retiredPath))) {
			violations.push({ path: retiredPath, kind: "retired_path", line: 0 });
		}
	}

	const files = [];
	for (const scanRoot of SCAN_ROOTS) walk(root, resolve(root, scanRoot), files);
	for (const path of files.sort()) {
		if (path === "scripts/fly2121-legacy-name-guard.mjs") continue;
		const lines = readFileSync(resolve(root, path), "utf8").split(/\r?\n/);
		for (const [index, line] of lines.entries()) {
			if (/FLY-2121-history/.test(line)) continue;
			let retiredIdentity = IDENTITY_PATTERNS.some((pattern) =>
				pattern.test(line),
			);
			if (
				path !== "packages/config/src/node-type-registry.ts" &&
				/\bid\s*:\s*["']design["']/.test(line)
			) {
				retiredIdentity = true;
			}
			if (
				isRegistryPath(path) &&
				(/^\s*(?:design|designer|produce|execute)\s*:/.test(line) ||
					/\bnodes\s*:\s*\[[^\]]*\b(?:design|designer|produce|execute)\b/.test(
						line,
					) ||
					/\bfile\s*:\s*(?:nodes\/)?(?:design|designer|generic|prototype)\.md\b/.test(
						line,
					))
			) {
				retiredIdentity = true;
			}
			if (retiredIdentity) {
				violations.push({
					path,
					kind: "retired_identity",
					line: index + 1,
					text: line.trim(),
				});
			}
		}
	}
	return violations;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
	const repoRoot =
		process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const violations = scanLegacyWorkflowNames(repoRoot);
	if (violations.length === 0) {
		process.stdout.write("FLY-2121 legacy workflow name guard: PASS\n");
	} else {
		for (const violation of violations) {
			process.stderr.write(
				`${violation.path}${violation.line ? `:${violation.line}` : ""}: ${violation.kind}${violation.text ? `: ${violation.text}` : ""}\n`,
			);
		}
		process.exitCode = 1;
	}
}

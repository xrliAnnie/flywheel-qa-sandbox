/**
 * FLY-137 Phase 6: `flywheel init` — scaffold a fresh project.
 *
 * Creates `.flywheel/config.yaml`, a node-only project registry, and a starter
 * `.flywheel/agents/nodes/example.md` implementation.
 *
 * Flags:
 *   --project-path <path>  Target project (default: cwd, init does not walk up)
 *   --depts <a,b,c>        Comma-separated dept list (skips interactive prompt)
 *   --no-depts             Flat agents dir, no dept subdirs
 *   --force                Allow scaffolding into a dir with existing .flywheel/
 *   --project-name <name>  Override config.yaml project.name (default: basename)
 *
 * Out of scope for v1.27.2 init implementation: Linear label fetch
 * suggestions (`--linear-team` flag) — kept for v1.28 follow-up.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectPath } from "../lib/resolve-project.js";

export interface InitOpts {
	projectPath?: string;
	depts?: string[];
	noDepts?: boolean;
	force?: boolean;
	projectName?: string;
}

export interface InitResult {
	projectPath: string;
	configPath: string;
	registryPath: string;
	depts: string[];
	exampleAgentPath: string;
}

function isGitRepo(path: string): boolean {
	return existsSync(join(path, ".git"));
}

function templateDir(): string {
	// Resolve to <package>/src/templates in dev, <package>/dist/templates in
	// build. Both are produced (build copies templates) so checking either
	// works.
	const here = dirname(fileURLToPath(import.meta.url));
	// `here` is either `<root>/src/commands` (ts-node / vitest) or
	// `<root>/dist/commands` (compiled). Templates live one dir up.
	const candidate = resolvePath(here, "..", "templates");
	if (existsSync(candidate)) return candidate;
	const fallback = resolvePath(here, "..", "..", "src", "templates");
	if (existsSync(fallback)) return fallback;
	throw new Error(
		`[flywheel init] template dir not found near ${here}; package may be missing dist/templates`,
	);
}

function readTemplate(name: string): string {
	return readFileSync(join(templateDir(), name), "utf-8");
}

function expandTemplate(content: string, vars: Record<string, string>): string {
	let out = content;
	for (const [key, value] of Object.entries(vars)) {
		out = out.replace(new RegExp(`{{${key}}}`, "g"), value);
	}
	return out;
}

export function init(opts: InitOpts): InitResult {
	const projectPath = resolveProjectPath({
		explicit: opts.projectPath,
		expectExisting: false,
	});

	if (!isGitRepo(projectPath)) {
		throw new Error(
			`flywheel init must run inside a git repository (no .git/ at ${projectPath})`,
		);
	}

	const dotFly = join(projectPath, ".flywheel");
	if (existsSync(dotFly) && !opts.force) {
		throw new Error(
			`.flywheel/ already exists at ${dotFly}. Pass --force to overwrite (config.yaml + agents/ template only).`,
		);
	}

	// Resolve dept list.
	let depts: string[] = [];
	if (opts.noDepts) {
		depts = [];
	} else if (opts.depts !== undefined && opts.depts.length > 0) {
		depts = opts.depts.map((d) => d.trim()).filter((d) => d.length > 0);
	}

	// Create the project registry implementation root. Department is semantic
	// registry metadata, never derived from this path.
	mkdirSync(dotFly, { recursive: true });
	const agentsDir = join(dotFly, "agents");
	const nodesDir = join(agentsDir, "nodes");
	mkdirSync(nodesDir, { recursive: true });

	// Write config.yaml.
	const projectName =
		opts.projectName ??
		basename(projectPath).toLowerCase().replace(/\s+/g, "-");
	const configPath = join(dotFly, "config.yaml");
	const configContent = expandTemplate(readTemplate("config.yaml.tmpl"), {
		PROJECT_NAME: projectName,
	});
	writeFileSync(configPath, configContent);

	// Write starter node implementation + node-only project registry.
	const examplePath = join(nodesDir, "example.md");
	const exampleContent = readTemplate("example-executor.md.tmpl");
	writeFileSync(examplePath, exampleContent);
	const registryPath = join(agentsDir, "registry.yaml");
	writeFileSync(
		registryPath,
		[
			"nodes:",
			"  example:",
			"    file: nodes/example.md",
			"    label: Example",
			`    department: ${depts[0] ?? "general"}`,
			"",
		].join("\n"),
	);

	return {
		projectPath,
		configPath,
		registryPath,
		depts,
		exampleAgentPath: examplePath,
	};
}

/**
 * CLI entry-point — prints human-readable output. Throws on error so
 * the top-level dispatcher can convert to exit code.
 */
export function runInit(opts: InitOpts): void {
	const result = init(opts);
	const summary = [
		`✓ Flywheel scaffolded at ${result.projectPath}`,
		`  config:        ${result.configPath}`,
		`  registry:      ${result.registryPath}`,
		`  example agent: ${result.exampleAgentPath}`,
		`  depts:         ${result.depts.length > 0 ? result.depts.join(", ") : "(flat — no dept subdirs)"}`,
		``,
		`Next steps:`,
		`  1. Edit registry.yaml to declare stable nodes and display labels.`,
		`  2. Edit config.yaml to map dispatch aliases to those nodes.`,
		`  3. Run 'flywheel doctor' to validate setup.`,
	].join("\n");
	console.log(summary);
}

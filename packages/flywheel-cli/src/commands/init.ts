/**
 * FLY-137 Phase 6: `flywheel init` — scaffold a fresh project.
 *
 * Creates `.flywheel/config.yaml` + `.flywheel/agents/<dept>/.gitkeep`
 * (or top-level `.flywheel/agents/` if `--no-depts`) + a starter
 * `example-executor.md` under the first declared dept (or top-level).
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

import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
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

	// Create directories.
	mkdirSync(dotFly, { recursive: true });
	const agentsDir = join(dotFly, "agents");
	mkdirSync(agentsDir, { recursive: true });
	if (depts.length > 0) {
		for (const d of depts) {
			const dir = join(agentsDir, d);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, ".gitkeep"), "");
		}
	} else {
		writeFileSync(join(agentsDir, ".gitkeep"), "");
	}

	// Write config.yaml.
	const projectName =
		opts.projectName ??
		basename(projectPath).toLowerCase().replace(/\s+/g, "-");
	const configPath = join(dotFly, "config.yaml");
	const configContent = expandTemplate(readTemplate("config.yaml.tmpl"), {
		PROJECT_NAME: projectName,
	});
	writeFileSync(configPath, configContent);

	// Write starter executor. Under first dept if depts declared, else top-level.
	const targetDir = depts.length > 0 ? join(agentsDir, depts[0]!) : agentsDir;
	const examplePath = join(targetDir, "example-executor.md");
	const exampleContent = readTemplate("example-executor.md.tmpl");
	writeFileSync(examplePath, exampleContent);

	return {
		projectPath,
		configPath,
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
		`  example agent: ${result.exampleAgentPath}`,
		`  depts:         ${result.depts.length > 0 ? result.depts.join(", ") : "(flat — no dept subdirs)"}`,
		``,
		`Next steps:`,
		`  1. Edit .flywheel/config.yaml to declare your agents.`,
		`  2. Replace the example executor file with your role definition.`,
		`  3. Run 'flywheel doctor' to validate setup.`,
	].join("\n");
	console.log(summary);
}

// Silence unused — kept for future use (statSync used elsewhere).
void statSync;

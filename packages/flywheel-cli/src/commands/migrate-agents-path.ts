/**
 * FLY-137 Phase 6: `flywheel migrate-agents-path`.
 *
 * Relocates legacy `.claude/agents/<file>.md` to dept-aware
 * `.flywheel/agents/<dept>/<file>.md`, and rewrites `agent_file` paths
 * + adds `department:` fields in `.flywheel/config.yaml`.
 *
 * Dept resolution (per Codex Round 1 #3):
 *   1. `--dept-map <file>` JSON: { "<filename.md>": "<dept>" or "__top__" }
 *   2. Otherwise: parse `.claude/agents/README.md` mapping table when
 *      present (column "Linear label" determines dept).
 *   3. Otherwise: interactive prompt per unmapped file (the CLI emits
 *      a structured prompt; non-TTY environments must use --dept-map).
 *
 * Safety rails:
 *   - Refuses on dirty `.claude/agents` / `.flywheel/agents` / config.yaml
 *     unless `--force`.
 *   - Idempotent: if destination exists + matches content, skips file.
 *   - Refuses on destination-differs without `--force`.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveProjectPath } from "../lib/resolve-project.js";

export interface MigrateOpts {
	projectPath?: string;
	deptMap?: string;
	force?: boolean;
	/**
	 * Test/non-interactive fallback. When provided, files NOT covered by
	 * the README parser OR `--dept-map` use this function to ask the
	 * operator (or stub) for the dept. Default: throws (refuse to
	 * migrate without explicit mapping).
	 */
	askDept?: (filename: string) => string | null;
}

export interface MigrateResult {
	projectPath: string;
	moved: { from: string; to: string; dept: string | "__top__" }[];
	skipped: { file: string; reason: string }[];
}

const TOP_LEVEL = "__top__" as const;

function gitStatus(projectPath: string, paths: string[]): string {
	try {
		return execFileSync("git", ["status", "--porcelain", "--", ...paths], {
			cwd: projectPath,
			encoding: "utf-8",
		});
	} catch {
		return "";
	}
}

function gitMv(
	projectPath: string,
	source: string,
	destination: string,
): boolean {
	try {
		execFileSync("git", ["mv", "-f", source, destination], {
			cwd: projectPath,
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

function loadDeptMap(filePath: string): Record<string, string> {
	const raw = readFileSync(filePath, "utf-8");
	return JSON.parse(raw) as Record<string, string>;
}

/**
 * Best-effort parser for `.claude/agents/README.md` mapping tables.
 * Looks for markdown table rows with cells containing `*-executor.md`
 * tokens. Maps Linear-label cell text to a dept slug.
 */
/**
 * Strip common markdown wrappers from a YAML/table cell so the parser
 * can match the underlying scalar.
 *
 *   `**Marketing**` → `Marketing`
 *   `*Product*`     → `Product`
 *   `` `qa` ``      → `qa`
 *
 * Bold/emphasis can appear because GeoForge3D's README highlights newer
 * teams (Operations / Marketing) with `**…**`. Inline code wraps are
 * less common but harmless to strip.
 */
function stripCellDecorations(cell: string): string {
	let stripped = cell.trim();
	// Strip outer `` ` `` backticks, `**`, `*` symmetrically. Loop because
	// `**\`Marketing\`**` (bold + code) is plausible.
	for (let i = 0; i < 3; i++) {
		const next = stripped
			.replace(/^\*\*(.*)\*\*$/, "$1")
			.replace(/^\*(.*)\*$/, "$1")
			.replace(/^`(.*)`$/, "$1")
			.trim();
		if (next === stripped) break;
		stripped = next;
	}
	return stripped;
}

function parseReadmeMapping(readmePath: string): Record<string, string> {
	if (!existsSync(readmePath)) return {};
	const raw = readFileSync(readmePath, "utf-8");
	const mapping: Record<string, string> = {};
	const lines = raw.split("\n");
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line.startsWith("|") || !line.endsWith("|")) continue;
		const cells = line
			.slice(1, -1)
			.split("|")
			.map((c) => stripCellDecorations(c));
		const fileCell = cells.find((c) => /[\w-]+-executor\.md/.test(c));
		if (!fileCell) continue;
		const fileMatch = fileCell.match(/([\w-]+-executor\.md)/);
		if (!fileMatch) continue;
		const filename = fileMatch[1]!;

		// Find a likely "Linear label" cell — case-insensitive Product/
		// Operations/Marketing token. `any`, `—` (em-dash), and `-`
		// (hyphen) all route to top-level for the catch-all / no-Linear-
		// label rows (e.g. plan-generator and qa-plan-generator rows
		// carry `—` in the GeoForge3D README).
		const labelCell = cells.find((c) =>
			/^(product|operations|marketing|any|—|-)$/i.test(c),
		);
		if (!labelCell) continue;
		const l = labelCell.toLowerCase();
		let dept = "";
		if (l === "product") dept = "product";
		else if (l === "operations") dept = "operations";
		else if (l === "marketing") dept = "marketing";
		else if (l === "any" || l === "—" || l === "-") dept = TOP_LEVEL;
		if (dept.length > 0) {
			mapping[filename] = dept;
		}
	}
	return mapping;
}

export function migrate(opts: MigrateOpts): MigrateResult {
	const projectPath = resolveProjectPath({ explicit: opts.projectPath });
	const claudeAgentsDir = join(projectPath, ".claude", "agents");
	const flywheelAgentsDir = join(projectPath, ".flywheel", "agents");
	const configPath = join(projectPath, ".flywheel", "config.yaml");

	if (!existsSync(claudeAgentsDir)) {
		throw new Error(
			`No legacy .claude/agents/ directory at ${claudeAgentsDir} — nothing to migrate.`,
		);
	}
	if (!existsSync(configPath)) {
		throw new Error(
			`Missing .flywheel/config.yaml at ${configPath}. Run \`flywheel init\` first.`,
		);
	}

	// Pre-flight: dirty git check.
	if (!opts.force) {
		const dirty = gitStatus(projectPath, [
			".claude/agents",
			".flywheel/agents",
			".flywheel/config.yaml",
		]);
		if (dirty.trim().length > 0) {
			throw new Error(
				`Refusing to migrate while these paths have uncommitted changes:\n${dirty}` +
					`Commit or stash first, or pass --force.`,
			);
		}
	}

	const explicit = opts.deptMap ? loadDeptMap(opts.deptMap) : {};
	const fromReadme = parseReadmeMapping(join(claudeAgentsDir, "README.md"));
	const mapping: Record<string, string> = { ...fromReadme, ...explicit };

	const allFiles = readdirSync(claudeAgentsDir).filter(
		(f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md",
	);

	const moved: MigrateResult["moved"] = [];
	const skipped: MigrateResult["skipped"] = [];

	// QA Finding 2: pre-flight pass — resolve every file's dept BEFORE
	// any `git mv` runs. The previous loop interleaved resolution + move,
	// so a missing mapping on file #5 left files #1-4 already half-staged
	// and required manual `git reset --hard && git clean -fd` to recover.
	// Now we collect all decisions up-front; any unmapped file throws or
	// is recorded for `--skip` before we touch disk.
	type ResolvedEntry = { filename: string; dept: string | "__top__" };
	const resolved: ResolvedEntry[] = [];
	for (const filename of allFiles) {
		let dept: string | undefined = mapping[filename];
		if (!dept) {
			if (filename === "general-executor.md") {
				dept = TOP_LEVEL;
			} else if (opts.askDept) {
				const answer = opts.askDept(filename);
				if (!answer) {
					skipped.push({ file: filename, reason: "no-dept-mapping" });
					continue;
				}
				dept = answer === "top" ? TOP_LEVEL : answer;
			} else {
				// Atomicity: throw BEFORE the move loop so no partial
				// state lingers in the worktree.
				throw new Error(
					`No dept mapping for ${filename}. Provide --dept-map <file> with { "${filename}": "<dept>" or "__top__" }, ` +
						`or add it to .claude/agents/README.md's mapping table.`,
				);
			}
		}
		resolved.push({ filename, dept });
	}

	for (const { filename, dept } of resolved) {
		const sourcePath = join(claudeAgentsDir, filename);
		const destDir =
			dept === TOP_LEVEL ? flywheelAgentsDir : join(flywheelAgentsDir, dept);
		const destPath = join(destDir, filename);

		if (existsSync(destPath)) {
			const srcContent = readFileSync(sourcePath, "utf-8");
			const destContent = readFileSync(destPath, "utf-8");
			if (srcContent === destContent) {
				skipped.push({ file: filename, reason: "destination-identical" });
				continue;
			}
			if (!opts.force) {
				throw new Error(
					`Destination already exists and differs: ${destPath}. Pass --force to overwrite.`,
				);
			}
		}

		mkdirSync(destDir, { recursive: true });
		const moved_via_git = gitMv(projectPath, sourcePath, destPath);
		if (!moved_via_git) {
			// Fall back to plain copy + delete (e.g. file not tracked).
			writeFileSync(destPath, readFileSync(sourcePath, "utf-8"));
			try {
				unlinkSync(sourcePath);
			} catch {
				/* best-effort */
			}
		}
		moved.push({
			from: `.claude/agents/${filename}`,
			to:
				dept === TOP_LEVEL
					? `.flywheel/agents/${filename}`
					: `.flywheel/agents/${dept}/${filename}`,
			dept,
		});
	}

	// Rewrite config.yaml agent_file paths + insert `department:` fields for
	// dept-owned agents. Per plan §Phase 6 acceptance criteria: "rewrites
	// config.yaml agent_file paths AND adds `department:` fields".
	const rawConfig = readFileSync(configPath, "utf-8");
	let newConfig = rawConfig;
	for (const entry of moved) {
		newConfig = newConfig.replace(
			new RegExp(escapeRegex(entry.from), "g"),
			entry.to,
		);
	}
	for (const entry of moved) {
		if (entry.dept === TOP_LEVEL) continue;
		newConfig = ensureDepartmentField(newConfig, entry.to, entry.dept);
	}
	if (newConfig !== rawConfig) {
		writeFileSync(configPath, newConfig);
	}

	return { projectPath, moved, skipped };
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ensure the agent block referenced by `agentFilePath` carries a
 * `department: <dept>` field at the same indentation as the
 * `agent_file:` line. If a `department:` line already exists in the
 * same block, replaces its value; otherwise inserts a new line
 * immediately after `agent_file:`.
 *
 * Codex R2 #2 fix: handle common scalar shapes — bare value, single-
 * and double-quoted values, optional trailing whitespace, and trailing
 * `#`-comments. Inline-flow YAML (`agents: {backend: {agent_file: …}}`)
 * is NOT supported by the line-based scanner; if the regex doesn't
 * match we throw so the operator notices and fixes the config by hand
 * rather than getting a silently incomplete migration.
 *
 * The agent block ends at the next non-blank line whose indentation is
 * less than the agent_file indent (sibling agent name or top-level key).
 */
function ensureDepartmentField(
	yaml: string,
	agentFilePath: string,
	dept: string,
): string {
	// Accept: bare path, "double", 'single'; allow trailing whitespace and
	// trailing comment.
	const pattern = new RegExp(
		`^([ \\t]+)agent_file:[ \\t]+(?:"|')?${escapeRegex(agentFilePath)}(?:"|')?[ \\t]*(?:#[^\\n]*)?$`,
		"m",
	);
	const match = yaml.match(pattern);
	if (!match) {
		// If the path appears in the config at all (e.g., inline-flow
		// `agents: { backend: { agent_file: …} }`) but not as a block-style
		// scalar, we can't insert `department:` safely. Fail loud so the
		// operator either hand-edits or converts to block style. If the
		// path is absent entirely (agent moved but never declared in this
		// config), silently no-op.
		//
		// Strip line-comments before the inclusion check — the
		// `flywheel init` template documents the canonical layout in a
		// commented-out example, and matching that comment would cause a
		// spurious throw on freshly scaffolded projects.
		const yamlSansComments = yaml
			.split("\n")
			.map((line) => line.replace(/\s+#.*$/, "").replace(/^\s*#.*$/, ""))
			.join("\n");
		if (yamlSansComments.includes(agentFilePath)) {
			throw new Error(
				`[migrate-agents-path] Could not locate \`agent_file: ${agentFilePath}\` as a block-style YAML scalar — ` +
					`unable to insert \`department: ${dept}\`. Hand-edit the config or convert inline-flow ` +
					`agents to block style and re-run migrate.`,
			);
		}
		return yaml;
	}
	const indent = match[1] ?? "";
	const lines = yaml.split("\n");
	const agentFileLineIdx = lines.findIndex(
		(line) => line.replace(/\s+$/, "") === match[0].replace(/\s+$/, ""),
	);
	if (agentFileLineIdx === -1) return yaml;

	// Scan forward to find an existing `department:` at the same indent
	// inside the same agent block. Stop at the next line whose indent is
	// less than `indent` (sibling agent name or back to top-level).
	let existingDeptIdx = -1;
	for (let j = agentFileLineIdx + 1; j < lines.length; j++) {
		const ln = lines[j] ?? "";
		if (ln.trim() === "") continue;
		const ind = ln.length - ln.trimStart().length;
		if (ind < indent.length) break;
		if (ind === indent.length && /^department\s*:/.test(ln.trim())) {
			existingDeptIdx = j;
		}
	}

	const newDeptLine = `${indent}department: ${dept}`;
	if (existingDeptIdx !== -1) {
		lines[existingDeptIdx] = newDeptLine;
	} else {
		lines.splice(agentFileLineIdx + 1, 0, newDeptLine);
	}
	return lines.join("\n");
}

export function runMigrate(opts: MigrateOpts): number {
	const result = migrate(opts);
	const lines = [
		`Flywheel migrate-agents-path — ${result.projectPath}`,
		``,
		`Moved (${result.moved.length}):`,
	];
	for (const m of result.moved) {
		lines.push(`  ${m.from} → ${m.to}  (dept=${m.dept})`);
	}
	if (result.skipped.length > 0) {
		lines.push(``, `Skipped (${result.skipped.length}):`);
		for (const s of result.skipped) {
			lines.push(`  ${s.file}  (${s.reason})`);
		}
	}
	console.log(lines.join("\n"));
	return 0;
}

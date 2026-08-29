/**
 * FLY-137 Phase 6: `flywheel doctor` — validate a project's .flywheel/ setup.
 *
 * Sequence (per Codex Round 4 — order matters):
 *   1. Locate `.flywheel/config.yaml`.
 *   2. Pre-scan raw YAML for legacy `.claude/agents/` paths → if found,
 *      exit 1 with migration diagnostic BEFORE parsing (so a hard parse
 *      error doesn't mask the migration hint).
 *   3. Light YAML parse (sufficient for path validation + alias check
 *      — does NOT depend on Bridge's full ConfigLoader).
 *   4. Validate `agent_file` paths resolve to existing files.
 *   5. Warn on duplicate `match.labels` across agents.
 *   6. Warn on orphan dept dirs (agents/<dept>/ with no matching Lead
 *      declaration — info-level since Lead config lives outside `.flywheel/`).
 *
 * Linear cross-check is deferred to v1.28 (avoid LINEAR_API_KEY
 * requirement for a quick local validator). The plan calls for it but
 * the gain vs. dependency cost is low for the v1.27.2 ship.
 *
 * Exit code: 0 on all-green or warnings-only; 1 on hard errors (missing
 * config, legacy paths detected, broken agent_file).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { resolveProjectPath } from "../lib/resolve-project.js";

export interface DoctorOpts {
	projectPath?: string;
}

export interface DoctorReport {
	projectPath: string;
	errors: string[];
	warnings: string[];
	info: string[];
}

interface AgentDecl {
	name: string;
	agentFile?: string;
	department?: string;
	labels: string[];
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Light YAML parser tailored to .flywheel/config.yaml. Not a full YAML
 * implementation — only handles the `agents:` block structure we ship
 * via `flywheel init`. Returns an empty agents list if the structure
 * doesn't match the expected shape (doctor surfaces config malformation
 * via the file-existence check, not via parse correctness).
 */
function parseAgentsBlock(raw: string): AgentDecl[] {
	const agents: AgentDecl[] = [];
	const lines = raw.split("\n");
	let inAgents = false;
	let currentAgent: AgentDecl | null = null;
	let agentsIndent = 0;

	for (const rawLine of lines) {
		// Strip trailing comment after a `#` not in quotes.
		const line = rawLine.replace(/\s+#.*$/, "");
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;

		const indent = line.length - line.trimStart().length;

		// Top-level `agents:` block.
		if (!inAgents) {
			if (/^agents\s*:\s*(\{\s*\}\s*)?$/.test(trimmed)) {
				inAgents = true;
				agentsIndent = indent;
			}
			continue;
		}

		// End of agents block: dedent to <= agentsIndent.
		if (indent <= agentsIndent) {
			if (currentAgent) agents.push(currentAgent);
			currentAgent = null;
			inAgents = false;
			continue;
		}

		// Agent name (single-level inside agents).
		if (indent === agentsIndent + 2 && /:\s*$/.test(trimmed)) {
			if (currentAgent) agents.push(currentAgent);
			currentAgent = {
				name: trimmed.replace(/:\s*$/, ""),
				labels: [],
			};
			continue;
		}

		if (!currentAgent) continue;

		// Fields of the agent.
		const fieldMatch = trimmed.match(/^([\w_-]+)\s*:\s*(.*)$/);
		if (!fieldMatch) continue;
		const [, key, value] = fieldMatch;
		if (key === "agent_file") {
			currentAgent.agentFile = value!.replace(/^["']|["']$/g, "").trim();
		} else if (key === "department") {
			currentAgent.department = value!.replace(/^["']|["']$/g, "").trim();
		} else if (key === "labels") {
			// Inline array: `labels: ["a", "b"]`
			const arrayMatch = value!.match(/^\[(.+)\]/);
			if (arrayMatch) {
				currentAgent.labels = arrayMatch[1]!
					.split(",")
					.map((s) => s.trim().replace(/^["']|["']$/g, ""))
					.filter((s) => s.length > 0);
			}
		}
	}
	if (currentAgent) agents.push(currentAgent);
	return agents;
}

export function doctor(opts: DoctorOpts = {}): DoctorReport {
	const projectPath = resolveProjectPath({ explicit: opts.projectPath });
	const configPath = join(projectPath, ".flywheel", "config.yaml");
	const report: DoctorReport = {
		projectPath,
		errors: [],
		warnings: [],
		info: [],
	};

	if (!existsSync(configPath)) {
		report.errors.push(
			`Missing .flywheel/config.yaml at ${configPath}. Run \`flywheel init\` first.`,
		);
		return report;
	}

	const rawConfig = readFileSync(configPath, "utf-8");

	// Step 1: legacy `.claude/agents/` pre-scan — must happen BEFORE parse.
	if (/\.claude\/agents\//.test(rawConfig)) {
		report.errors.push(
			`Found legacy .claude/agents/ paths in config.yaml. ` +
				`Run \`flywheel migrate-agents-path\` to relocate executor files to .flywheel/agents/<dept>/.`,
		);
		return report;
	}

	// Step 2: parse + agent_file existence check.
	const agents = parseAgentsBlock(rawConfig);
	for (const a of agents) {
		if (!a.agentFile) continue;
		const resolved = resolvePath(projectPath, a.agentFile);
		if (!existsSync(resolved)) {
			report.errors.push(
				`agents.${a.name}.agent_file does not exist: ${a.agentFile} (resolved: ${resolved})`,
			);
		}
		if (a.labels.length === 0) {
			report.warnings.push(
				`agents.${a.name}.match.labels is empty — agent only dispatchable via Lead \`agentName\` override.`,
			);
		}
	}

	// Step 3: duplicate alias detection.
	const labelOwners = new Map<string, string[]>();
	for (const a of agents) {
		for (const label of a.labels) {
			const key = label.toLowerCase();
			const owners = labelOwners.get(key) ?? [];
			owners.push(a.name);
			labelOwners.set(key, owners);
		}
	}
	for (const [label, owners] of labelOwners) {
		if (owners.length > 1) {
			report.warnings.push(
				`Alias '${label}' is declared by multiple agents: ${owners.join(", ")}. ` +
					`Dispatcher picks the first match (${owners[0]}). Deduplicate aliases or rely on Lead override.`,
			);
		}
	}

	// Step 4: orphan dept dir cross-check.
	const agentsDir = join(projectPath, ".flywheel", "agents");
	if (existsSync(agentsDir) && isDir(agentsDir)) {
		const subdirs = readdirSync(agentsDir)
			.filter((name) => name !== ".gitkeep")
			.filter((name) => isDir(join(agentsDir, name)));
		const declaredDepts = new Set(
			agents
				.map((a) => a.department)
				.filter((d): d is string => typeof d === "string" && d.length > 0),
		);
		for (const dir of subdirs) {
			if (!declaredDepts.has(dir)) {
				report.info.push(
					`Department '${dir}' has agents directory but no agent declares department: '${dir}'. ` +
						`This is OK for orphan / future-Lead departments (e.g. marketing-without-Lead).`,
				);
			}
		}
	}

	return report;
}

export function runDoctor(opts: DoctorOpts): number {
	const report = doctor(opts);
	const lines: string[] = [];
	lines.push(`Flywheel doctor — ${report.projectPath}`);
	for (const e of report.errors) lines.push(`  ERROR:   ${e}`);
	for (const w of report.warnings) lines.push(`  WARN:    ${w}`);
	for (const i of report.info) lines.push(`  INFO:    ${i}`);
	if (
		report.errors.length === 0 &&
		report.warnings.length === 0 &&
		report.info.length === 0
	) {
		lines.push(`  ✓ All checks passed.`);
	}
	console.log(lines.join("\n"));
	return report.errors.length > 0 ? 1 : 0;
}

/** Validate both agent-registry entry points and registry-backed config aliases. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ConfigLoader,
	loadBundledRegistry,
	resolveAgentConfigs,
	resolveProjectRegistry,
} from "flywheel-config";
import { resolveBundledRegistryPath } from "../lib/agent-registry-path.js";
import { resolveProjectPath } from "../lib/resolve-project.js";

export interface DoctorOpts {
	projectPath?: string;
	bundledRegistryPath?: string;
}

export interface DoctorReport {
	projectPath: string;
	errors: string[];
	warnings: string[];
	info: string[];
}

export async function doctor(opts: DoctorOpts = {}): Promise<DoctorReport> {
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

	const rawConfig = readFileSync(configPath, "utf8");
	if (/\bagent_file\s*:/.test(rawConfig)) {
		report.errors.push(
			"Retired agents.*.agent_file authoring found. Run `flywheel migrate-agent-registry` before activation.",
		);
		return report;
	}

	try {
		const bundledPath = resolveBundledRegistryPath(opts.bundledRegistryPath);
		const bundled = loadBundledRegistry(bundledPath);
		report.info.push("Bundled registry preflight passed");
		const config = await new ConfigLoader(async (path) =>
			readFileSync(path, "utf8"),
		).load(configPath);
		const resolved = resolveProjectRegistry({
			bundled,
			projectName: config.project,
			projectRoot: projectPath,
		});
		resolveAgentConfigs(config.agents, resolved);
		report.info.push("Project registry preflight passed");

		const owners = new Map<string, string[]>();
		for (const [name, source] of Object.entries(config.agents ?? {})) {
			for (const label of source.match.labels) {
				const key = label.toLowerCase();
				owners.set(key, [...(owners.get(key) ?? []), name]);
			}
		}
		for (const [label, names] of owners) {
			if (names.length > 1) {
				report.warnings.push(
					`Alias '${label}' is declared by multiple agents: ${names.join(", ")}`,
				);
			}
		}
	} catch (error) {
		report.errors.push(error instanceof Error ? error.message : String(error));
	}
	return report;
}

export async function runDoctor(opts: DoctorOpts): Promise<number> {
	const report = await doctor(opts);
	const lines = [`Flywheel doctor — ${report.projectPath}`];
	for (const error of report.errors) lines.push(`  ERROR:   ${error}`);
	for (const warning of report.warnings) lines.push(`  WARN:    ${warning}`);
	for (const info of report.info) lines.push(`  INFO:    ${info}`);
	if (
		report.errors.length === 0 &&
		report.warnings.length === 0 &&
		report.info.length === 0
	) {
		lines.push("  ✓ All checks passed.");
	}
	console.log(lines.join("\n"));
	return report.errors.length > 0 ? 1 : 0;
}

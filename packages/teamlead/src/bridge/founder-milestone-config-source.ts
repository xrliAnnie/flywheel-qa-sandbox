/**
 * FLY-725: load each project's founder milestone-report config from its
 * CANONICAL root — mirrors `auto-qa-config-source.ts::loadQaConfigByProject`.
 *
 * SECURITY: reads `<projectRoot>/.flywheel/config.yaml` — the mainline checkout,
 * NEVER an implementation PR's worktree. This is the same source run-infra +
 * auto-QA use, so a runner cannot edit its own PR's config to change which
 * founder notifications fire. Returns a map keyed by projectName; a project with
 * no config file or no `founder_milestone_report` block maps to undefined
 * (feature off for it). A malformed config is logged + treated as off (one bad
 * project must not break Bridge startup).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ConfigLoader,
	type FounderMilestoneReportConfig,
} from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";

export async function loadFounderMilestoneReportConfigByProject(
	projects: ProjectEntry[],
	readFile: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): Promise<Map<string, FounderMilestoneReportConfig | undefined>> {
	const map = new Map<string, FounderMilestoneReportConfig | undefined>();
	for (const project of projects) {
		const configPath = join(project.projectRoot, ".flywheel", "config.yaml");
		try {
			const loader = new ConfigLoader(async (p) => readFile(p));
			const cfg = await loader.load(configPath);
			map.set(project.projectName, cfg?.founder_milestone_report);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				console.warn(
					`[founder-milestone] config load failed for ${project.projectName}: ${(err as Error).message} — feature off for it`,
				);
			}
			map.set(project.projectName, undefined);
		}
	}
	return map;
}

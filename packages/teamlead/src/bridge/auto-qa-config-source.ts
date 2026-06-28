/**
 * FLY-579 P3: load each project's auto-QA config from its CANONICAL root.
 *
 * SECURITY: reads `<projectRoot>/.flywheel/config.yaml` — the mainline checkout,
 * NEVER an implementation PR's worktree. This is the same source run-infra uses
 * for checkpoints/agents/doc_flow, so a runner cannot edit its own PR's config
 * to skip its own QA. Returns a map keyed by projectName; a project with no
 * config file or no `qa` block maps to undefined (auto-QA off for it). A
 * malformed config is logged + treated as off (one bad project must not break
 * Bridge startup).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigLoader } from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { AutoQaPolicyConfig } from "./auto-qa-policy.js";

export async function loadQaConfigByProject(
	projects: ProjectEntry[],
	readFile: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): Promise<Map<string, AutoQaPolicyConfig | undefined>> {
	const map = new Map<string, AutoQaPolicyConfig | undefined>();
	for (const project of projects) {
		const configPath = join(project.projectRoot, ".flywheel", "config.yaml");
		try {
			const loader = new ConfigLoader(async (p) => readFile(p));
			const cfg = await loader.load(configPath);
			map.set(project.projectName, cfg?.qa);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				console.warn(
					`[auto-qa] qa config load failed for ${project.projectName}: ${(err as Error).message} — auto-QA off for it`,
				);
			}
			map.set(project.projectName, undefined);
		}
	}
	return map;
}

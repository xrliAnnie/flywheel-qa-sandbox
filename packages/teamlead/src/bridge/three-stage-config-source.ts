/**
 * FLY-793: load each project's `pipeline` config from its CANONICAL root.
 *
 * SECURITY: reads `<projectRoot>/.flywheel/config.yaml` — the mainline checkout,
 * NEVER an implementation PR's worktree (mirrors auto-qa-config-source.ts), so a
 * runner cannot flip its own three-stage enablement mid-pipeline.
 *
 * Unlike auto-QA (opt-out tri-state), three-stage is opt-IN / default-OFF, so a
 * missing file / missing `pipeline` block / malformed config all collapse to
 * `undefined` → `resolveThreeStagePolicy` returns disabled (fail-closed). A
 * malformed `pipeline` block already throws at `ConfigLoader.load` (same as
 * `doc_flow` / `qa`); we log + treat it as `undefined` here so one project's
 * broken config can never block Bridge boot or accidentally ENABLE the feature.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigLoader, type PipelineConfig } from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";

export async function loadPipelineConfigByProject(
	projects: ProjectEntry[],
	readFile: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): Promise<Map<string, PipelineConfig | undefined>> {
	const map = new Map<string, PipelineConfig | undefined>();
	for (const project of projects) {
		const configPath = join(project.projectRoot, ".flywheel", "config.yaml");
		try {
			const loader = new ConfigLoader(async (p) => readFile(p));
			const cfg = await loader.load(configPath);
			map.set(project.projectName, cfg?.pipeline);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				// Parse / validation error → treat as undefined (OFF, fail-closed).
				console.warn(
					`[three-stage] pipeline config load failed for ${project.projectName}: ${
						(err as Error).message
					} — three-stage OFF for it`,
				);
			}
			map.set(project.projectName, undefined);
		}
	}
	return map;
}

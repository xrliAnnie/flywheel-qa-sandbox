/**
 * FLY-1048 PR-C (C3-w): load each project's `detection.lead_grace_ms`
 * override from its CANONICAL root (`<projectRoot>/.flywheel/config.yaml` —
 * the auto-qa-config-source precedent: mainline checkout, never a PR
 * worktree, so a runner cannot tune its own escalation grace).
 *
 * Absence semantics (deliberately simpler than the qa tri-state): a missing
 * file, a config without a `detection` block, or a block without
 * `lead_grace_ms` all mean "no override" — the GLOBAL grace
 * (FLYWHEEL_DETECTION_LEAD_GRACE_MS / 30min default) applies. A MALFORMED
 * config also falls back to the global grace, with a warning: a broken
 * tuning knob must neither disable escalation nor invent a value.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigLoader } from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";

export async function loadDetectionGraceByProject(
	projects: ProjectEntry[],
	readFile: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): Promise<Map<string, number>> {
	const map = new Map<string, number>();
	for (const project of projects) {
		const configPath = join(project.projectRoot, ".flywheel", "config.yaml");
		try {
			const loader = new ConfigLoader(async (p) => readFile(p));
			const cfg = await loader.load(configPath);
			const graceMs = cfg?.detection?.lead_grace_ms;
			if (typeof graceMs === "number") {
				map.set(project.projectName, graceMs);
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				console.warn(
					`[detection-escalation] detection config unreadable for ${project.projectName}: ${(err as Error).message} — global grace applies`,
				);
			}
		}
	}
	return map;
}

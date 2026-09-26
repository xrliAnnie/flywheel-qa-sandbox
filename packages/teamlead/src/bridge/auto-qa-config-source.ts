/**
 * FLY-579 / FLY-752: load each project's auto-QA config from its CANONICAL root.
 *
 * SECURITY: reads `<projectRoot>/.flywheel/config.yaml` — the mainline checkout,
 * NEVER an implementation PR's worktree. Same source run-infra uses for
 * checkpoints/agents/doc_flow, so a runner cannot edit its own PR's config to skip
 * its own QA.
 *
 * FLY-752 (fleet-wide opt-out): the result is a TRI-STATE so the policy can
 * distinguish, and treat differently:
 *   - `absent`    — no config file (ENOENT) OR a config with no `qa` block. →
 *                   auto-QA ON (opt-out default; fleet-wide).
 *   - `malformed` — the config failed to load/parse/validate (e.g. `qa.auto` is a
 *                   non-boolean). → auto-QA fail-CLOSED OFF (a broken or
 *                   fat-fingered opt-out must never accidentally ENABLE QA).
 *   - `config`    — a valid `qa` block. `auto` may be absent (→ ON), true (→ ON),
 *                   or false (→ explicit opt-out OFF).
 *
 * Collapsing malformed → absent (the pre-FLY-752 behaviour) would, under
 * default-on, silently flip a broken config from off to on — hence the split.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigLoader } from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";

/** Minimal shape of the project qa config (matches config.QaConfig structurally). */
export interface AutoQaConfigShape {
	auto?: boolean;
	skip_labels?: string[];
}

/** FLY-752 tri-state result of loading a project's qa config. */
export type QaConfigResult =
	| { kind: "absent" }
	| { kind: "malformed"; reason: string }
	| ({ kind: "config" } & AutoQaConfigShape);

export async function loadQaConfigByProject(
	projects: ProjectEntry[],
	readFile: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): Promise<Map<string, QaConfigResult>> {
	const map = new Map<string, QaConfigResult>();
	for (const project of projects) {
		const configPath = join(project.projectRoot, ".flywheel", "config.yaml");
		try {
			const loader = new ConfigLoader(async (p) => readFile(p));
			const cfg = await loader.load(configPath);
			if (!cfg?.qa) {
				// No `qa` block → treat like absent → default-on.
				map.set(project.projectName, { kind: "absent" });
			} else {
				map.set(project.projectName, { kind: "config", ...cfg.qa });
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				// No config file at all → absent → default-on (fleet-wide).
				map.set(project.projectName, { kind: "absent" });
			} else {
				// Parse / validation error → MALFORMED → fail-closed OFF downstream.
				const reason = (err as Error).message;
				console.warn(
					`[auto-qa] qa config MALFORMED for ${project.projectName}: ${reason} — auto-QA fail-closed OFF for it`,
				);
				map.set(project.projectName, { kind: "malformed", reason });
			}
		}
	}
	return map;
}

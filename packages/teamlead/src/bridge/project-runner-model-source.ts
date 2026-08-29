/**
 * FLY-709 ② (b) — derive the per-project DEFAULT runner model/effort/backend
 * (read-only) from each project's `roles.runner` (FLY-671) in config.yaml.
 *
 * REUSES the per-project config map the feature-flag resolver already loads
 * (`loadFeatureFlagProjectConfigs`) — NO extra config.yaml IO. This only DISPLAYS
 * the default; it never writes. A malformed config surfaces as `error` (shown as
 * data), matching the flag read-only region; a missing/no-override config reads as
 * account-default (`model:null`), never an error.
 *
 * Distinct from the FLY-247 per-Lead model chips (those stay editable + unchanged,
 * plan §6). Changing the runner default is a follow-up (config writer / the FLY-728
 * label path), not this PR.
 */

import type { ProjectEntry } from "../ProjectConfig.js";
import type { ProjectConfigEntry } from "./feature-flag-config-source.js";
import type {
	CronModelView,
	ProjectRunnerDefaultView,
} from "./fleet-console-model.js";

export function buildProjectRunnerDefaults(
	projects: ProjectEntry[],
	configs: Map<string, ProjectConfigEntry>,
): ProjectRunnerDefaultView[] {
	const out: ProjectRunnerDefaultView[] = [];
	for (const project of projects) {
		const entry = configs.get(project.projectName);
		if (entry?.error) {
			out.push({
				projectName: project.projectName,
				model: null,
				effort: null,
				backend: null,
				error: entry.error,
			});
			continue;
		}
		const runner = entry?.config?.roles?.runner;
		out.push({
			projectName: project.projectName,
			model: runner?.model ?? null,
			effort: runner?.effort ?? null,
			backend: runner?.backend ?? null,
		});
	}
	return out;
}

/**
 * FLY-709 P4.4 — cron (recurring xiaohongshu trigger issue) model rows.
 *
 * Derived from the SAME cached config map. Only projects whose
 * `xiaohongshu_learning.enabled` is true contribute rows — one per collection,
 * with the configured `model` (null = project/account default). The console
 * renders these with a copy-command that targets
 * `flywheel-comm runner-config apply --cron`.
 */
export function buildCronModelViews(
	projects: ProjectEntry[],
	configs: Map<string, ProjectConfigEntry>,
): CronModelView[] {
	const out: CronModelView[] = [];
	for (const project of projects) {
		const learning = configs.get(project.projectName)?.config
			?.xiaohongshu_learning;
		if (!learning?.enabled || !learning.collections?.length) continue;
		for (const col of learning.collections) {
			out.push({
				projectName: project.projectName,
				collectionId: col.collection_id,
				label: col.label,
				leadId: col.lead_id,
				model: col.model ?? null,
			});
		}
	}
	return out;
}

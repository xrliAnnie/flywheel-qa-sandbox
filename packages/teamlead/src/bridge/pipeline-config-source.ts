/**
 * FLY-793: load each project's `pipeline` config from its CANONICAL root.
 *
 * SECURITY: reads `<projectRoot>/.flywheel/config.yaml` — the mainline checkout,
 * NEVER an implementation PR's worktree, so a
 * runner cannot flip its own DAG enrollment mid-run. A malformed `pipeline`
 * block already throws at `ConfigLoader.load`; this reader logs and treats it
 * as absent so one project's broken config cannot block Bridge boot.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ConfigLoader,
	type PipelineConfig,
	WORKFLOW_MENU_BINDINGS,
} from "flywheel-config";
import { parse } from "yaml";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { hasProjectMenuConfig } from "../workflow-menu.js";

export type WorkKindConfigCause =
	| "work_kind_not_boolean"
	| "work_kind_requires_dag";

export type WorkKindConfigResult =
	| { ok: true; workKind: boolean; dag: boolean }
	| { ok: false; cause: WorkKindConfigCause };

/**
 * FLY-1407 narrow strict reader for fresh master /api/runs/start dispatches.
 *
 * Only the new work_kind key and its dag:true dependency are fail-loud. Every
 * unrelated parse/config problem keeps today's behavior: work-kind is disabled.
 */
export function loadWorkKindConfigStrict(
	project: ProjectEntry,
	readFile: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): WorkKindConfigResult {
	const configPath = join(project.projectRoot, ".flywheel", "config.yaml");
	let content: string;
	try {
		content = readFile(configPath);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			console.warn(
				`[work-kind] config read failed for ${project.projectName}: ${(err as Error).message} — work-kind OFF, DAG dispatch held`,
			);
			return { ok: true, workKind: false, dag: false };
		}
		return { ok: true, workKind: false, dag: true };
	}

	let raw: unknown;
	try {
		raw = parse(content);
	} catch (err) {
		console.warn(
			`[work-kind] unrelated config parse failed for ${project.projectName}: ${(err as Error).message} — work-kind OFF`,
		);
		return { ok: true, workKind: false, dag: false };
	}
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: true, workKind: false, dag: false };
	}
	const pipeline = (raw as Record<string, unknown>).pipeline;
	if (pipeline == null) {
		return { ok: true, workKind: false, dag: true };
	}
	if (typeof pipeline !== "object" || Array.isArray(pipeline)) {
		return { ok: true, workKind: false, dag: false };
	}
	const values = pipeline as Record<string, unknown>;
	if (
		Object.hasOwn(values, "work_kind") &&
		typeof values.work_kind !== "boolean"
	) {
		return { ok: false, cause: "work_kind_not_boolean" };
	}
	const workKind = values.work_kind === true;
	const dag = values.dag === undefined || values.dag === true;
	if (workKind && !dag) {
		return { ok: false, cause: "work_kind_requires_dag" };
	}
	return { ok: true, workKind, dag };
}

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
				// Parse / validation error → explicit held value (fail-closed).
				console.warn(
					`[pipeline] config load failed for ${project.projectName}: ${(err as Error).message} — DAG dispatch OFF for it`,
				);
				map.set(project.projectName, { dag: false });
				continue;
			}
			// FLY-1981: no project config (or no pipeline block) is DAG-on.
			map.set(project.projectName, { dag: true });
		}
	}
	return map;
}

/**
 * FLY-1981 fleet migration: projects without their own menu get the canonical
 * six exact category bindings. Existing operator bindings are never replaced,
 * menu-managed projects keep their exact adopted bindings, and explicit
 * `pipeline.dag: false` remains unbound so dispatch can reject it loudly.
 */
export function reconcileDefaultDagCategoryBindings(
	store: Pick<
		StateStore,
		"getWorkflowCategoryBindingExact" | "bindWorkflowCategory"
	>,
	projects: readonly ProjectEntry[],
): {
	bound: number;
	existing: number;
	disabled: number;
	menuManaged: number;
	errors: string[];
} {
	let bound = 0;
	let existing = 0;
	let disabled = 0;
	let menuManaged = 0;
	const errors: string[] = [];
	for (const project of projects) {
		const config = loadWorkKindConfigStrict(project);
		if (!config.ok || !config.dag) {
			disabled += 1;
			continue;
		}
		if (hasProjectMenuConfig(project.projectRoot)) {
			menuManaged += 1;
			continue;
		}
		for (const binding of WORKFLOW_MENU_BINDINGS) {
			if (
				store.getWorkflowCategoryBindingExact(
					project.projectName,
					binding.taskCategory,
				)
			) {
				existing += 1;
				continue;
			}
			try {
				store.bindWorkflowCategory({
					project: project.projectName,
					taskCategory: binding.taskCategory,
					templateId: binding.templateId,
					updatedBy: "system:fly-1981-dag-default",
				});
				bound += 1;
			} catch (error) {
				const detail = `${project.projectName}:${binding.taskCategory}:${error instanceof Error ? error.message : String(error)}`;
				errors.push(detail);
			}
		}
	}
	return { bound, existing, disabled, menuManaged, errors };
}

/** FLY-2103: project pipeline enrollment is read from scoped flag-store rows. */

import { WORKFLOW_MENU_BINDINGS } from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { hasProjectMenuConfig } from "../workflow-menu.js";
import {
	type FlagStoreRuntime,
	storePipelineDagEnabled,
	storePipelineWorkKindEnabled,
} from "./flag-store-runtime.js";

export type WorkKindConfigCause = "work_kind_requires_dag";

export type WorkKindConfigResult =
	| { ok: true; workKind: boolean; dag: boolean }
	| { ok: false; cause: WorkKindConfigCause };

/** Read both coupled flags at call time; any store failure holds DAG closed. */
export function readPipelineEnrollment(
	flagStore: FlagStoreRuntime,
	projectName: string,
): WorkKindConfigResult {
	try {
		const dag = storePipelineDagEnabled(flagStore, projectName);
		const workKind = storePipelineWorkKindEnabled(flagStore, projectName);
		if (workKind && !dag) {
			return { ok: false, cause: "work_kind_requires_dag" };
		}
		return { ok: true, workKind, dag };
	} catch (error) {
		console.warn(
			`[pipeline] flag-store read failed for ${projectName}: ${error instanceof Error ? error.message : String(error)} — work-kind OFF, DAG dispatch held`,
		);
		return { ok: true, workKind: false, dag: false };
	}
}

/**
 * FLY-1981 fleet migration: projects without their own menu get the canonical
 * six exact category bindings. Existing operator bindings are never replaced,
 * menu-managed projects keep their exact adopted bindings, and explicit
 * `pipeline.dag: false` remains unbound so dispatch can reject it loudly.
 */
export function reconcileDefaultDagCategoryBindings(
	store: StateStore,
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
	const flagStore: FlagStoreRuntime = { mode: "ready", store };
	for (const project of projects) {
		const config = readPipelineEnrollment(flagStore, project.projectName);
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

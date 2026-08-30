import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import {
	importWorkflowMenuSeeds,
	reconcileMenuCategoryBindings,
	workflowMenuBindings,
} from "../../workflow-menu.js";
import { initializeFlagStore } from "../flag-store-runtime.js";
import { reconcileDefaultDagCategoryBindings } from "../pipeline-config-source.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function project(name: string, config?: string): ProjectEntry {
	const projectRoot = mkdtempSync(join(tmpdir(), `fly1981-${name}-`));
	roots.push(projectRoot);
	if (config !== undefined) {
		mkdirSync(join(projectRoot, ".flywheel"), { recursive: true });
		writeFileSync(join(projectRoot, ".flywheel", "config.yaml"), config);
	}
	return { projectName: name, projectRoot } as ProjectEntry;
}

describe("FLY-1981 fleet DAG default binding reconcile", () => {
	it("converges a six-project fleet to six exact category rows per project", async () => {
		const workflowBindings = workflowMenuBindings();
		const store = await StateStore.create(":memory:");
		try {
			initializeFlagStore(store, {});
			importWorkflowMenuSeeds(store);
			const menuManaged = project("flywheel");
			const menuDirectory = join(menuManaged.projectRoot, ".flywheel", "menus");
			mkdirSync(menuDirectory, { recursive: true });
			writeFileSync(
				join(menuDirectory, "adoption.yaml"),
				`lead:\n${workflowBindings.map(({ taskCategory }) => `  - ${taskCategory}`).join("\n")}\n`,
			);
			const defaultProjects = Array.from({ length: 5 }, (_, index) =>
				project(`default-${index + 1}`),
			);
			const projects = [menuManaged, ...defaultProjects];

			expect(reconcileMenuCategoryBindings(store, projects)).toEqual({
				bound: 6,
				existing: 0,
				errors: [],
			});
			expect(
				reconcileDefaultDagCategoryBindings(store, projects),
			).toMatchObject({
				bound: 30,
				existing: 0,
				menuManaged: 1,
			});

			for (const projectEntry of projects) {
				const rows = store.listWorkflowCategoryBindings(
					projectEntry.projectName,
				);
				expect(rows).toHaveLength(6);
				expect(rows.some(({ task_category }) => task_category === "*")).toBe(
					false,
				);
				for (const binding of workflowBindings) {
					expect(
						store.getWorkflowCategoryBindingExact(
							projectEntry.projectName,
							binding.taskCategory,
						),
					).toMatchObject({ template_id: binding.templateId });
				}
			}
		} finally {
			store.close();
		}
	});

	it("seeds six exact menu-shaped bindings and resolves every category idempotently", async () => {
		const workflowBindings = workflowMenuBindings();
		const store = await StateStore.create(":memory:");
		try {
			initializeFlagStore(store, {});
			importWorkflowMenuSeeds(store);
			const defaultOn = project("default-on");

			const first = reconcileDefaultDagCategoryBindings(store, [defaultOn]);

			expect(first).toMatchObject({ bound: 6, existing: 0, disabled: 0 });
			expect(
				store.getWorkflowCategoryBindingExact(defaultOn.projectName, "*"),
			).toBeUndefined();
			for (const binding of workflowBindings) {
				expect(
					store.getWorkflowCategoryBindingExact(
						defaultOn.projectName,
						binding.taskCategory,
					),
				).toMatchObject({
					template_id: binding.templateId,
					updated_by: "system:fly-1981-dag-default",
				});
				expect(
					store.getWorkflowCategoryBinding(
						defaultOn.projectName,
						binding.taskCategory,
					),
				).toMatchObject({
					task_category: binding.taskCategory,
					template_id: binding.templateId,
				});
			}

			const second = reconcileDefaultDagCategoryBindings(store, [defaultOn]);

			expect(second).toMatchObject({ bound: 0, existing: 6, disabled: 0 });
			expect(
				store.listWorkflowCategoryBindings(defaultOn.projectName),
			).toHaveLength(6);
		} finally {
			store.close();
		}
	});

	it("keeps an agent-registry-only project on default DAG bindings", async () => {
		const store = await StateStore.create(":memory:");
		try {
			importWorkflowMenuSeeds(store);
			const registryOnly = project("registry-only", "pipeline:\n  dag: true\n");
			const agentsDirectory = join(
				registryOnly.projectRoot,
				".flywheel",
				"agents",
			);
			mkdirSync(agentsDirectory, { recursive: true });
			writeFileSync(join(agentsDirectory, "registry.yaml"), "nodes: {}\n");

			expect(reconcileMenuCategoryBindings(store, [registryOnly])).toEqual({
				bound: 0,
				existing: 0,
				errors: [],
			});
			expect(
				reconcileDefaultDagCategoryBindings(store, [registryOnly]),
			).toMatchObject({
				bound: 6,
				existing: 0,
				disabled: 0,
				menuManaged: 0,
				errors: [],
			});
		} finally {
			store.close();
		}
	});

	it("preserves operator exact and wildcard bindings while filling missing exact categories", async () => {
		const store = await StateStore.create(":memory:");
		try {
			initializeFlagStore(store, {});
			importWorkflowMenuSeeds(store);
			const custom = project("custom");
			store.bindWorkflowCategory({
				project: custom.projectName,
				taskCategory: "*",
				templateId: "tpl_generic_menu",
				updatedBy: "lead",
			});
			store.bindWorkflowCategory({
				project: custom.projectName,
				taskCategory: "product_design_flow",
				templateId: "tpl_generic_menu",
				updatedBy: "lead",
			});

			const result = reconcileDefaultDagCategoryBindings(store, [custom]);

			expect(result).toMatchObject({ bound: 5, existing: 1, disabled: 0 });
			expect(
				store.getWorkflowCategoryBindingExact(custom.projectName, "*"),
			).toMatchObject({
				template_id: "tpl_generic_menu",
				updated_by: "lead",
			});
			expect(
				store.getWorkflowCategoryBindingExact(
					custom.projectName,
					"product_design_flow",
				),
			).toMatchObject({ template_id: "tpl_generic_menu", updated_by: "lead" });
			expect(
				store.getWorkflowCategoryBindingExact(custom.projectName, "code"),
			).toMatchObject({
				template_id: "tpl_code",
				updated_by: "system:fly-1981-dag-default",
			});
			expect(
				store.listWorkflowCategoryBindings(custom.projectName),
			).toHaveLength(7);
		} finally {
			store.close();
		}
	});

	it("leaves an explicitly disabled project unbound", async () => {
		const store = await StateStore.create(":memory:");
		try {
			initializeFlagStore(store, {});
			importWorkflowMenuSeeds(store);
			const explicitOff = project("explicit-off");
			expect(
				store.applyScopedFlagValueChange({
					name: "pipeline_dag",
					scope: explicitOff.projectName,
					op: "set",
					rawTo: "0",
					expectedChangeSeq: 0,
					actor: "fixture",
					reason: "explicit project opt-out",
				}),
			).toMatchObject({ ok: true });

			const result = reconcileDefaultDagCategoryBindings(store, [explicitOff]);

			expect(result).toMatchObject({ bound: 0, existing: 0, disabled: 1 });
			expect(
				store.listWorkflowCategoryBindings(explicitOff.projectName),
			).toEqual([]);
		} finally {
			store.close();
		}
	});
});

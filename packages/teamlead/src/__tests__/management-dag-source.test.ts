import { describe, expect, it } from "vitest";
import {
	createManagementDagProvider,
	readManagementDags,
} from "../bridge/management-dag-source.js";
import { StateStore } from "../StateStore.js";
import { validateWorkflowManifest } from "../workflow-template.js";
import {
	importLegacyWorkflowSeeds,
	legacyWorkflowSeeds,
} from "./fixtures/legacy-workflow-manifests.js";

async function catalog(templateId = "tpl_eng_heavy") {
	const store = await StateStore.create(":memory:");
	importLegacyWorkflowSeeds(store);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "*",
		templateId,
		updatedBy: "test",
	});
	return store;
}

describe("management DAG source", () => {
	it("projects current category bindings into editable design/implement/qa nodes", async () => {
		const store = await catalog();
		const projection = readManagementDags({
			reader: store,
			projectNames: ["flywheel", "personal-assistant"],
		});
		const flywheel = projection.projectDags.find(
			(item) => item.projectName === "flywheel",
		)!;
		expect(flywheel.dags).toHaveLength(1);
		expect(flywheel.dags[0]).toMatchObject({
			templateId: "tpl_eng_heavy",
			revision: 1,
			nodes: [
				{ name: "design", dispatch: { current: { provider: "anthropic" } } },
				{ name: "implement", dispatch: { current: { provider: "openai" } } },
				{ name: "qa", dispatch: { current: { provider: "anthropic" } } },
			],
		});
		expect(
			projection.projectDags.find(
				(item) => item.projectName === "personal-assistant",
			)?.dags,
		).toEqual([]);
		store.close();
	});

	it("keeps node target ids stable when a new revision changes a value", async () => {
		const store = await catalog();
		const first = readManagementDags({
			reader: store,
			projectNames: ["flywheel"],
		}).projectDags[0]!.dags[0]!;
		const seed = legacyWorkflowSeeds().find(
			(item) => item.templateId === "tpl_eng_heavy",
		)!;
		const changed = {
			...seed.manifest,
			nodes: seed.manifest.nodes.map((node) =>
				node.id === "design" ? { ...node, effort: "high" as const } : node,
			),
		};
		const revision = store.createWorkflowTemplateRevision({
			templateId: seed.templateId,
			manifest: changed,
			schemaVersion: 1,
			createdBy: "test",
		});
		store.publishWorkflowTemplate({
			templateId: seed.templateId,
			revision,
			expectedRevision: 1,
			publishedBy: "test",
		});
		const second = readManagementDags({
			reader: store,
			projectNames: ["flywheel"],
		}).projectDags[0]!.dags[0]!;
		expect(second.revision).toBe(2);
		expect(second.nodes.map((node) => node.dispatch.targetId)).toEqual(
			first.nodes.map((node) => node.dispatch.targetId),
		);
		expect(second.nodes[0]!.dispatch.source.revision).not.toBe(
			first.nodes[0]!.dispatch.source.revision,
		);
		store.close();
	});

	it("omits engine-owned land nodes without hiding agent model bindings", async () => {
		const store = await catalog("tpl_eng_heavy_land_v1");
		const dag = readManagementDags({
			reader: store,
			projectNames: ["flywheel"],
		}).projectDags[0]!.dags[0]!;

		expect(dag.error).toBeUndefined();
		expect(dag.nodes.map((node) => node.name)).toEqual([
			"design",
			"implement",
			"qa",
		]);
		expect(dag.nodes.some((node) => node.name === "land")).toBe(false);
		expect(
			dag.nodes.every((node) => node.dispatch.writeCapability.writable),
		).toBe(true);
		store.close();
	});

	it("still reports an agent node that truly has no model binding", async () => {
		const store = await catalog();
		const seed = legacyWorkflowSeeds().find(
			(item) => item.templateId === "tpl_eng_heavy",
		)!;
		const missingBindingManifest = structuredClone(seed.manifest) as {
			nodes: Array<Record<string, unknown>>;
		};
		const design = missingBindingManifest.nodes.find(
			(node) => node.id === "design",
		)!;
		delete design.vendor;
		delete design.model;
		expect(() =>
			validateWorkflowManifest(missingBindingManifest, {
				allowUnsupportedModels: true,
			}),
		).not.toThrow();

		const revision = store.createWorkflowTemplateRevision({
			templateId: seed.templateId,
			manifest: missingBindingManifest,
			schemaVersion: 1,
			createdBy: "test",
		});
		store.publishWorkflowTemplate({
			templateId: seed.templateId,
			revision,
			expectedRevision: 1,
			publishedBy: "test",
		});
		const dag = readManagementDags({
			reader: store,
			projectNames: ["flywheel"],
		}).projectDags[0]!.dags[0]!;
		expect(dag.error).toMatch(/workflow node design has no model binding/);
		store.close();
	});

	it("surfaces missing revisions as errors but keeps retired models repairable", () => {
		const base = legacyWorkflowSeeds()[0]!;
		const binding = {
			project: "flywheel",
			task_category: "*",
			template_id: base.templateId,
			updated_by: "test",
			updated_at: "now",
		};
		const template = {
			template_id: base.templateId,
			name: base.name,
			project_scope: "global",
			current_published_revision: 9,
			created_by: "system",
			created_at: "now",
			seed_owner: "system" as const,
			seed_content_hash: null,
		};
		const missing = readManagementDags({
			reader: {
				listWorkflowCategoryBindings: () => [binding],
				getWorkflowTemplate: () => template,
				getWorkflowTemplateRevision: () => undefined,
			},
			projectNames: ["flywheel"],
		});
		expect(missing.projectDags[0]!.dags[0]!.error).toMatch(/revision/i);

		const invalidManifest = {
			...base.manifest,
			nodes: base.manifest.nodes.map((node) =>
				node.id === "design" ? { ...node, model: "claude-invented" } : node,
			),
		};
		const invalid = readManagementDags({
			reader: {
				listWorkflowCategoryBindings: () => [binding],
				getWorkflowTemplate: () => template,
				getWorkflowTemplateRevision: () => ({
					template_id: base.templateId,
					revision: 9,
					manifest: JSON.stringify(invalidManifest),
					manifest_digest: "bad",
					schema_version: 1,
					created_by: "test",
					created_at: "now",
				}),
			},
			projectNames: ["flywheel"],
		});
		const retiredDag = invalid.projectDags[0]!.dags[0]!;
		expect(retiredDag.error).toBeUndefined();
		expect(
			retiredDag.nodes.find((node) => node.name === "design")?.dispatch,
		).toMatchObject({
			current: { provider: "anthropic", model: "claude-invented" },
			writeCapability: { writable: true },
		});
	});

	it("exposes a data provider for snapshot orchestration", async () => {
		const store = await catalog();
		const provider = createManagementDagProvider({
			reader: store,
			projectNames: () => ["flywheel"],
		});
		expect(provider.sourceKind).toBe("workflow_catalog");
		expect(provider.read().fragment.projectDags?.[0]!.dags).toHaveLength(1);
		store.close();
	});
});

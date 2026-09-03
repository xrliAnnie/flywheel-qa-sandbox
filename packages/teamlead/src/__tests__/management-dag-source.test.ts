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
	it("exposes a governed workflow alias as its persisted spelling", async () => {
		const store = await catalog();
		const seed = legacyWorkflowSeeds().find(
			(item) => item.templateId === "tpl_eng_heavy",
		)!;
		const aliasManifest = {
			...seed.manifest,
			nodes: seed.manifest.nodes.map((node) =>
				node.id === "design" ? { ...node, model: "fable" } : node,
			),
		};
		expect(
			store.createAndPublishWorkflowTemplateRevision({
				templateId: seed.templateId,
				manifest: aliasManifest,
				expectedRevision: 1,
				createdBy: "founder",
				allowUnsupportedModels: true,
			}),
		).toEqual({ status: "published", revision: 2 });

		const dag = readManagementDags({
			reader: store,
			projectNames: ["flywheel"],
		}).projectDags[0]!.dags[0]!;
		expect(
			dag.nodes.find((node) => node.nodeId === "design")?.dispatch,
		).toMatchObject({
			canonicalModel: "claude-fable-5-1",
			current: { provider: "anthropic", model: "fable" },
		});
		store.close();
	});

	it("projects historical bindings with decoded backend display labels", async () => {
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
				{
					nodeId: "design",
					name: "设计(工程)",
					dispatch: { current: { provider: "anthropic" } },
				},
				{
					nodeId: "implement",
					name: "实现",
					dispatch: { current: { provider: "openai" } },
				},
				{
					nodeId: "qa",
					name: "QA 验证",
					dispatch: { current: { provider: "anthropic" } },
				},
			],
		});
		expect(flywheel.dags[0]!.graph?.loops[0]?.maxIterations).toBe(3);
		expect(
			projection.projectDags.find(
				(item) => item.projectName === "personal-assistant",
			)?.dags,
		).toEqual([]);
		store.close();
	});

	it("projects the complete current manifest graph with raw node ids", async () => {
		const store = await StateStore.create(":memory:");
		const { importWorkflowMenuSeeds } = await import("../workflow-menu.js");
		importWorkflowMenuSeeds(store);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "code",
			templateId: "tpl_code",
			updatedBy: "test",
		});
		const dag = readManagementDags({
			reader: store,
			projectNames: ["flywheel"],
		}).projectDags[0]!.dags[0]!;
		expect(dag.title).toBe("工程开发");
		expect(dag.nodes.map((node) => [node.nodeId, node.name])).toEqual([
			["eng_design", "设计(工程)"],
			["implement", "实现"],
			["qa", "QA 验证"],
		]);
		expect(dag.graph).toEqual({
			nodes: [
				{
					id: "eng_design",
					name: "设计(工程)",
					type: "design",
					execution: "agent",
				},
				{
					id: "implement",
					name: "实现",
					type: "implement",
					execution: "agent",
				},
				{
					id: "qa",
					name: "QA 验证",
					type: "qa",
					execution: "agent",
				},
				{
					id: "founder_gate",
					name: "创始人门",
					type: "gate",
					execution: "gate",
				},
				{
					id: "land",
					name: "合入",
					type: "land",
					execution: "engine",
				},
			],
			edges: [
				{ id: "design_done", from: "eng_design", to: "implement" },
				{ id: "implement_done", from: "implement", to: "qa" },
				{ id: "qa_pass", from: "qa", to: "founder_gate" },
				{ id: "founder_gate_approved", from: "founder_gate", to: "land" },
			],
			loops: [
				{
					id: "qa_retry",
					from: "qa",
					to: "implement",
					maxIterations: null,
				},
				{
					id: "founder_rework",
					from: "founder_gate",
					to: "implement",
					maxIterations: null,
				},
			],
		});
		store.close();
	});

	it("preserves manifest node order while edges retain their declared endpoints", async () => {
		const store = await StateStore.create(":memory:");
		const { importWorkflowMenuSeeds } = await import("../workflow-menu.js");
		importWorkflowMenuSeeds(store);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "code",
			templateId: "tpl_code",
			updatedBy: "test",
		});
		const original = store.getWorkflowTemplateRevision("tpl_code", 1)!;
		const manifest = JSON.parse(original.manifest) as {
			nodes: Array<{ id: string }>;
		};
		manifest.nodes = [
			manifest.nodes.find((node) => node.id === "land")!,
			...manifest.nodes.filter((node) => node.id !== "land"),
		];
		const revision = store.createWorkflowTemplateRevision({
			templateId: "tpl_code",
			manifest,
			schemaVersion: 2,
			createdBy: "test",
		});
		store.publishWorkflowTemplate({
			templateId: "tpl_code",
			revision,
			expectedRevision: 1,
			publishedBy: "test",
		});

		const graph = readManagementDags({
			reader: store,
			projectNames: ["flywheel"],
		}).projectDags[0]!.dags[0]!.graph;
		expect(graph?.nodes[0]?.id).toBe("land");
		expect(graph?.edges).toContainEqual({
			id: "founder_gate_approved",
			from: "founder_gate",
			to: "land",
		});
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
		expect(dag.nodes.map((node) => [node.nodeId, node.name])).toEqual([
			["design", "设计(工程)"],
			["implement", "实现"],
			["qa", "QA 验证"],
		]);
		expect(dag.nodes.some((node) => node.nodeId === "land")).toBe(false);
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
		expect(dag.graph).toBeNull();
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
		expect(missing.projectDags[0]!.dags[0]!.graph).toBeNull();

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
			retiredDag.nodes.find((node) => node.nodeId === "design")?.dispatch,
		).toMatchObject({
			current: { provider: "anthropic", model: "claude-invented" },
			writeCapability: { writable: true },
		});

		const badEndpointManifest = structuredClone(base.manifest);
		badEndpointManifest.edges[0] = {
			...badEndpointManifest.edges[0]!,
			to: "missing_node",
		};
		const badEndpoint = readManagementDags({
			reader: {
				listWorkflowCategoryBindings: () => [binding],
				getWorkflowTemplate: () => template,
				getWorkflowTemplateRevision: () => ({
					template_id: base.templateId,
					revision: 9,
					manifest: JSON.stringify(badEndpointManifest),
					manifest_digest: "bad-endpoint",
					schema_version: 1,
					created_by: "test",
					created_at: "now",
				}),
			},
			projectNames: ["flywheel"],
		}).projectDags[0]!.dags[0]!;
		expect(badEndpoint.graph).toBeNull();
		expect(badEndpoint.error).toMatch(/unknown node|missing_node/i);
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

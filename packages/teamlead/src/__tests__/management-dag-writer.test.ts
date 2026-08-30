import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { readManagementDags } from "../bridge/management-dag-source.js";
import { applyManagementDagEdit } from "../bridge/management-dag-writer.js";
import { createManagementDagWriter } from "../bridge/management-existing-writers.js";
import { StateStore } from "../StateStore.js";
import { validateWorkflowManifest } from "../workflow-template.js";
import { importLegacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

async function setup() {
	const store = await StateStore.create(":memory:");
	importLegacyWorkflowSeeds(store);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "*",
		templateId: "tpl_eng_heavy",
		updatedBy: "test",
	});
	const dag = readManagementDags({
		reader: store,
		projectNames: ["flywheel"],
	}).projectDags[0]!.dags[0]!;
	return { store, dag };
}

describe("management DAG writer", () => {
	it("copies the current manifest, mutates only the targeted node, and atomically publishes", async () => {
		const { store, dag } = await setup();
		const beforeRow = store.getWorkflowTemplateRevision(dag.templateId, 1)!;
		const before = validateWorkflowManifest(JSON.parse(beforeRow.manifest));
		const target = dag.nodes.find((node) => node.nodeId === "design")!;
		const publish = vi.spyOn(store, "createAndPublishWorkflowTemplateRevision");
		const result = applyManagementDagEdit({
			store,
			targetId: target.dispatch.targetId,
			expectedRevision: dag.revision,
			expectedDigest: dag.digest,
			desired: {
				provider: "openai",
				model: "gpt-5.6-sol",
				effort: "xhigh",
			},
			actor: "founder",
		});
		expect(result).toEqual({ status: "published", revision: 2 });
		expect(publish.mock.calls[0]?.[0]).toMatchObject({
			modelSnapshot: expect.objectContaining({
				revision: expect.any(String),
			}),
		});
		const after = validateWorkflowManifest(
			JSON.parse(
				store.getWorkflowTemplateRevision(dag.templateId, 2)!.manifest,
			),
		);
		expect(after.nodes.find((node) => node.id === "design")).toMatchObject({
			vendor: "codex",
			model: "gpt-5.6-sol",
			effort: "xhigh",
		});
		expect(after.nodes.filter((node) => node.id !== "design")).toEqual(
			before.nodes.filter((node) => node.id !== "design"),
		);
		expect({
			edges: after.edges,
			loops: after.loops,
			terminal_gate: after.terminal_gate,
			ship_claims: after.ship_claims,
		}).toEqual({
			edges: before.edges,
			loops: before.loops,
			terminal_gate: before.terminal_gate,
			ship_claims: before.ship_claims,
		});
		store.close();
	});

	it("rejects stale digests and unsupported selections with zero mutation", async () => {
		const { store, dag } = await setup();
		const targetId = dag.nodes[0]!.dispatch.targetId;
		const before = {
			revisions: store.listWorkflowTemplateRevisions(dag.templateId).length,
			publications: store.listWorkflowTemplatePublications(dag.templateId)
				.length,
		};
		expect(
			applyManagementDagEdit({
				store,
				targetId,
				expectedRevision: dag.revision,
				expectedDigest: "stale",
				desired: {
					provider: "anthropic",
					model: "claude-fable-5",
					effort: "high",
				},
				actor: "founder",
			}),
		).toEqual({ status: "conflict", currentRevision: 1 });
		expect(
			applyManagementDagEdit({
				store,
				targetId,
				expectedRevision: dag.revision,
				expectedDigest: dag.digest,
				desired: {
					provider: "openai",
					model: "claude-fable-5",
					effort: "high",
				},
				actor: "founder",
			}),
		).toMatchObject({ status: "invalid" });
		expect({
			revisions: store.listWorkflowTemplateRevisions(dag.templateId).length,
			publications: store.listWorkflowTemplatePublications(dag.templateId)
				.length,
		}).toEqual(before);
		store.close();
	});

	it("applies multiple node edits from one reviewed revision without self-conflicting", async () => {
		const { store, dag } = await setup();
		const writer = createManagementDagWriter({
			store,
			projectNames: () => ["flywheel"],
			actor: "founder",
		});
		const editedNodes = dag.nodes
			.filter((node) => node.dispatch.current.provider === "anthropic")
			.slice(0, 2);
		const changes = [];
		for (const node of editedNodes) {
			const target = await writer.resolve(node.dispatch.targetId);
			const checked = await writer.preflight(
				target!,
				{
					provider: "openai",
					model: "gpt-5.6-sol",
					effort: "xhigh",
				},
				target!.sourceRevision,
			);
			if (!checked.ok) throw new Error(checked.reason);
			changes.push(checked.change);
		}
		expect(await writer.applyGroup!(changes)).toEqual([
			expect.objectContaining({ status: "applied" }),
			expect.objectContaining({ status: "applied" }),
		]);
		const template = store.getWorkflowTemplate(dag.templateId)!;
		const latest = validateWorkflowManifest(
			JSON.parse(
				store.getWorkflowTemplateRevision(
					dag.templateId,
					template.current_published_revision!,
				)!.manifest,
			),
		);
		for (const node of editedNodes) {
			expect(
				latest.nodes.find((candidate) => candidate.id === node.nodeId),
			).toMatchObject({
				vendor: "codex",
				model: "gpt-5.6-sol",
				effort: "xhigh",
			});
		}
		store.close();
	});

	it("isolates an invalid stored template while editing a different valid template", async () => {
		const root = mkdtempSync(join(tmpdir(), "management-dag-isolation-"));
		const dbPath = join(root, "state.db");
		let store = await StateStore.create(dbPath);
		importLegacyWorkflowSeeds(store);
		const templates = store.listWorkflowTemplates();
		const invalid = templates[0]!;
		const valid = templates.find(
			(template) => template.template_id === "tpl_eng_light",
		)!;
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "invalid",
			templateId: invalid.template_id,
			updatedBy: "test",
		});
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "valid",
			templateId: valid.template_id,
			updatedBy: "test",
		});
		store.close();

		const raw = new BetterSqlite3(dbPath);
		raw.exec("DROP TRIGGER workflow_template_revision_no_update");
		raw
			.prepare(
				`UPDATE workflow_template_revision
				 SET manifest = ?
				 WHERE template_id = ? AND revision = ?`,
			)
			.run(
				JSON.stringify({ schema_version: 1, nodes: "corrupt" }),
				invalid.template_id,
				invalid.current_published_revision,
			);
		raw.close();

		store = await StateStore.create(dbPath);
		const dags = readManagementDags({
			reader: store,
			projectNames: ["flywheel"],
		}).projectDags[0]!.dags;
		expect(
			dags.find((dag) => dag.templateId === invalid.template_id)?.error,
		).toBeTruthy();
		const validDag = dags.find((dag) => dag.templateId === valid.template_id)!;
		const target = validDag.nodes[0]!;
		expect(
			applyManagementDagEdit({
				store,
				targetId: target.dispatch.targetId,
				expectedRevision: validDag.revision,
				expectedDigest: validDag.digest,
				desired: {
					provider: "openai",
					model: "gpt-5.6-sol",
					effort: "xhigh",
				},
				actor: "founder",
			}),
		).toMatchObject({ status: "published" });
		store.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps a retired persisted model visible and lets the console repair it", async () => {
		const root = mkdtempSync(join(tmpdir(), "management-dag-retired-model-"));
		const dbPath = join(root, "state.db");
		let store = await StateStore.create(dbPath);
		importLegacyWorkflowSeeds(store);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "*",
			templateId: "tpl_eng_heavy",
			updatedBy: "test",
		});
		const template = store.getWorkflowTemplate("tpl_eng_heavy")!;
		const revision = store.getWorkflowTemplateRevision(
			template.template_id,
			template.current_published_revision!,
		)!;
		const retired = JSON.parse(revision.manifest);
		retired.nodes = retired.nodes.map((node: { id: string }) =>
			node.id === "design" || node.id === "implement"
				? { ...node, model: "claude-retired-model" }
				: node,
		);
		store.close();

		const raw = new BetterSqlite3(dbPath);
		raw.exec("DROP TRIGGER workflow_template_revision_no_update");
		raw
			.prepare(
				`UPDATE workflow_template_revision
				 SET manifest = ?
				 WHERE template_id = ? AND revision = ?`,
			)
			.run(JSON.stringify(retired), template.template_id, revision.revision);
		raw.close();

		store = await StateStore.create(dbPath);
		const dag = readManagementDags({
			reader: store,
			projectNames: ["flywheel"],
		}).projectDags[0]!.dags[0]!;
		expect(dag.error).toBeUndefined();
		expect(dag.nodes).toHaveLength(3);
		const target = dag.nodes.find((node) => node.nodeId === "design")!;
		expect(target.dispatch).toMatchObject({
			current: {
				provider: "anthropic",
				model: "claude-retired-model",
			},
			writeCapability: { writable: true },
		});

		expect(
			applyManagementDagEdit({
				store,
				targetId: target.dispatch.targetId,
				expectedRevision: dag.revision,
				expectedDigest: dag.digest,
				desired: {
					provider: "openai",
					model: "gpt-5.6-sol",
					effort: "xhigh",
				},
				actor: "founder-management-console",
			}),
		).toMatchObject({ status: "published" });
		let repairedTemplate = store.getWorkflowTemplate(template.template_id)!;
		const partiallyRepaired = validateWorkflowManifest(
			JSON.parse(
				store.getWorkflowTemplateRevision(
					template.template_id,
					repairedTemplate.current_published_revision!,
				)!.manifest,
			),
			{ allowUnsupportedModels: true },
		);
		expect(
			partiallyRepaired.nodes.find((node) => node.id === "implement"),
		).toMatchObject({ model: "claude-retired-model" });

		const nextDag = readManagementDags({
			reader: store,
			projectNames: ["flywheel"],
		}).projectDags[0]!.dags[0]!;
		const secondTarget = nextDag.nodes.find(
			(node) => node.nodeId === "implement",
		)!;
		expect(
			applyManagementDagEdit({
				store,
				targetId: secondTarget.dispatch.targetId,
				expectedRevision: nextDag.revision,
				expectedDigest: nextDag.digest,
				desired: {
					provider: "openai",
					model: "gpt-5.6-sol",
					effort: "xhigh",
				},
				actor: "founder-management-console",
			}),
		).toMatchObject({ status: "published" });
		repairedTemplate = store.getWorkflowTemplate(template.template_id)!;
		expect(() =>
			validateWorkflowManifest(
				JSON.parse(
					store.getWorkflowTemplateRevision(
						template.template_id,
						repairedTemplate.current_published_revision!,
					)!.manifest,
				),
			),
		).not.toThrow();

		store.close();
		rmSync(root, { recursive: true, force: true });
	});
});

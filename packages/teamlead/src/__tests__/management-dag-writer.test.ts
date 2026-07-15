import { describe, expect, it } from "vitest";
import { readManagementDags } from "../bridge/management-dag-source.js";
import { applyManagementDagEdit } from "../bridge/management-dag-writer.js";
import { createManagementDagWriter } from "../bridge/management-existing-writers.js";
import { StateStore } from "../StateStore.js";
import {
	importBundledWorkflowSeeds,
	validateWorkflowManifest,
} from "../workflow-template.js";

async function setup() {
	const store = await StateStore.create(":memory:");
	importBundledWorkflowSeeds(store);
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
		const target = dag.nodes.find((node) => node.name === "design")!;
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
				latest.nodes.find((candidate) => candidate.id === node.name),
			).toMatchObject({
				vendor: "codex",
				model: "gpt-5.6-sol",
				effort: "xhigh",
			});
		}
		store.close();
	});
});

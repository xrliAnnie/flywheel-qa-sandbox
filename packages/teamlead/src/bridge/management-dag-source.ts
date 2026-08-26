import {
	canonicalSubmissionDigest,
	getModelConfigSnapshot,
} from "flywheel-config";
import type {
	WorkflowCategoryBindingRow,
	WorkflowTemplateRevisionRow,
	WorkflowTemplateRow,
} from "../StateStore.js";
import { validateWorkflowManifest } from "../workflow-template.js";
import {
	buildTargetId,
	databaseSourceRevision,
	type ManagementDagView,
} from "./management-console-contract.js";
import type { ManagementSnapshotProvider } from "./management-console-snapshot.js";

export interface WorkflowCatalogReader {
	listWorkflowCategoryBindings(project?: string): WorkflowCategoryBindingRow[];
	getWorkflowTemplate(templateId: string): WorkflowTemplateRow | undefined;
	getWorkflowTemplateRevision(
		templateId: string,
		revision: number,
	): WorkflowTemplateRevisionRow | undefined;
}

export interface ManagementDagProjection {
	projectDags: Array<{ projectName: string; dags: ManagementDagView[] }>;
	revision: string;
}

function dagId(
	projectName: string,
	binding: WorkflowCategoryBindingRow,
): string {
	return [projectName, binding.task_category, binding.template_id]
		.map(encodeURIComponent)
		.join("/");
}

function providerForVendor(vendor: "claude" | "codex"): "anthropic" | "openai" {
	return vendor === "claude" ? "anthropic" : "openai";
}

function errorDag(
	projectName: string,
	binding: WorkflowCategoryBindingRow,
	template: WorkflowTemplateRow | undefined,
	error: unknown,
): ManagementDagView {
	return {
		id: dagId(projectName, binding),
		title: template?.name ?? binding.template_id,
		templateId: binding.template_id,
		revision: template?.current_published_revision ?? 0,
		digest: "",
		nodes: [],
		error: error instanceof Error ? error.message : String(error),
	};
}

function projectDag(
	projectName: string,
	binding: WorkflowCategoryBindingRow,
	reader: WorkflowCatalogReader,
): ManagementDagView {
	const modelSnapshot = getModelConfigSnapshot();
	const template = reader.getWorkflowTemplate(binding.template_id);
	try {
		if (!template) {
			throw new Error(`workflow template not found: ${binding.template_id}`);
		}
		if (!template.current_published_revision) {
			throw new Error(`workflow template has no published revision`);
		}
		const revision = reader.getWorkflowTemplateRevision(
			template.template_id,
			template.current_published_revision,
		);
		if (!revision) {
			throw new Error(
				`workflow template revision not found: ${template.current_published_revision}`,
			);
		}
		const manifest = validateWorkflowManifest(JSON.parse(revision.manifest), {
			allowUnsupportedModels: true,
		});
		const sourceRevision = databaseSourceRevision(
			revision.revision,
			revision.manifest_digest,
		);
		const nodes: ManagementDagView["nodes"] = manifest.nodes
			.filter((node) => node.type !== "gate" && node.execution !== "engine")
			.map((node) => {
				if (!node.vendor || !node.model) {
					throw new Error(`workflow node ${node.id} has no model binding`);
				}
				const registered = modelSnapshot.getModelRegistryEntry(node.model);
				const supported = Boolean(
					registered &&
						modelSnapshot.isModelSelectionSupported({
							surface: "workflow",
							model: node.model,
							effort: node.effort,
							runtimeVendor: node.vendor,
						}),
				);
				return {
					id: `${template.template_id}/${node.id}`,
					name: node.id,
					dispatch: {
						targetId: buildTargetId("dag", [
							template.template_id,
							node.id,
							"dispatch",
						]),
						current: {
							provider: supported
								? registered!.provider
								: providerForVendor(node.vendor),
							model: supported ? registered!.id : node.model,
							effort: node.effort ?? null,
						},
						source: {
							kind: "workflow_catalog" as const,
							revision: sourceRevision,
							hint: `${template.template_id}@${revision.revision}`,
						},
						writeCapability: {
							writable: true,
							consequence: "new-run" as const,
							requiresAcknowledgement: true,
						},
					},
				};
			});
		return {
			id: dagId(projectName, binding),
			title:
				binding.task_category === "*"
					? template.name
					: `${template.name} · ${binding.task_category}`,
			templateId: template.template_id,
			revision: revision.revision,
			digest: revision.manifest_digest,
			nodes,
		};
	} catch (error) {
		return errorDag(projectName, binding, template, error);
	}
}

export function readManagementDags(input: {
	reader: WorkflowCatalogReader;
	projectNames: readonly string[];
}): ManagementDagProjection {
	const projectDags = [...new Set(input.projectNames)]
		.sort((a, b) => a.localeCompare(b))
		.map((projectName) => ({
			projectName,
			dags: input.reader
				.listWorkflowCategoryBindings(projectName)
				.map((binding) => projectDag(projectName, binding, input.reader))
				.sort((a, b) => a.title.localeCompare(b.title)),
		}));
	return {
		projectDags,
		revision: `workflow:${canonicalSubmissionDigest(projectDags)}`,
	};
}

export function createManagementDagProvider(input: {
	reader: WorkflowCatalogReader;
	projectNames(): readonly string[];
}): ManagementSnapshotProvider {
	return {
		id: "workflow-catalog",
		sourceKind: "workflow_catalog",
		read: () => {
			const result = readManagementDags({
				reader: input.reader,
				projectNames: input.projectNames(),
			});
			return {
				revision: result.revision,
				hint: "teamlead.db/workflow_template",
				fragment: { projectDags: result.projectDags },
			};
		},
	};
}

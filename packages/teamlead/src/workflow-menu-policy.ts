import { createHash } from "node:crypto";
import {
	canonicalJsonString,
	getModelConfigSnapshot,
	type ModelConfigSnapshot,
} from "flywheel-config";
import { loadWorkflowMenuLibrary } from "./workflow-menu.js";
import type { WorkflowEffort } from "./workflow-template.js";

const POLICY_SOURCE = ".flywheel/agents/registry.yaml";

export interface WorkflowMenuAllowedSelection {
	vendor: "claude" | "codex";
	model: string;
	effort: WorkflowEffort;
}

export interface WorkflowMenuPolicyModel {
	alias: string;
	provider: "anthropic" | "openai";
	vendor: "claude" | "codex";
	model: string;
	label: string;
	allowedEfforts: WorkflowEffort[];
	defaultEffort: WorkflowEffort;
}

export interface WorkflowMenuNodePolicy {
	nodeId: string;
	label: string;
	type: "design" | "implement" | "qa" | "generic";
	defaultModel: string;
	models: WorkflowMenuPolicyModel[];
	allowedSelections: WorkflowMenuAllowedSelection[];
	source: string;
}

export interface WorkflowMenuTaskCategoryPolicy {
	taskCategory: string;
	templateId: string;
	label: string;
	source: string;
	nodes: WorkflowMenuNodePolicy[];
}

export interface WorkflowMenuPolicyCatalog {
	schemaVersion: 1;
	revision: string;
	source: string;
	taskCategories: WorkflowMenuTaskCategoryPolicy[];
}

export function buildWorkflowMenuPolicyCatalog(
	input: { registryPath?: string; modelSnapshot?: ModelConfigSnapshot } = {},
): WorkflowMenuPolicyCatalog {
	const modelSnapshot = input.modelSnapshot ?? getModelConfigSnapshot();
	const taskCategories = loadWorkflowMenuLibrary({
		...(input.registryPath ? { registryPath: input.registryPath } : {}),
	}).map((menu): WorkflowMenuTaskCategoryPolicy => {
		const source = `${POLICY_SOURCE}#graphs.${menu.shape}`;
		return {
			taskCategory: menu.shape,
			templateId: menu.templateId,
			label: menu.label,
			source,
			nodes: menu.nodes
				.filter((node) => node.type !== "gate")
				.map((node): WorkflowMenuNodePolicy => {
					if (node.type === "gate") {
						throw new Error("gate nodes do not have workflow model policies");
					}
					const models = node.models!.map((policy): WorkflowMenuPolicyModel => {
						const entry = modelSnapshot.getModelRegistryEntry(policy.model);
						if (!entry || !entry.surfaces.includes("workflow")) {
							throw new Error(
								`workflow policy model is not registered: ${policy.model}`,
							);
						}
						return {
							alias: policy.model,
							provider: entry.provider,
							vendor: entry.runtimeVendor,
							model: entry.id,
							label: entry.label,
							allowedEfforts: [...policy.allowedEfforts],
							defaultEffort: policy.defaultEffort,
						};
					});
					return {
						nodeId: node.id,
						label: node.label,
						type: node.type,
						defaultModel: node.defaultModel!,
						models,
						allowedSelections: models.flatMap((model) =>
							model.allowedEfforts.map((effort) => ({
								vendor: model.vendor,
								model: model.model,
								effort,
							})),
						),
						source: `${source}.policies.${node.id}`,
					};
				}),
		};
	});
	const revision = createHash("sha256")
		.update(canonicalJsonString(taskCategories))
		.digest("hex");
	return {
		schemaVersion: 1,
		revision: `sha256:${revision}`,
		source: POLICY_SOURCE,
		taskCategories,
	};
}

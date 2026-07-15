import {
	getModelRegistryEntry,
	isModelSelectionSupported,
} from "flywheel-config";
import type {
	StateStore,
	WorkflowTemplatePublishResult,
} from "../StateStore.js";
import {
	validateWorkflowManifest,
	type WorkflowManifestV1,
} from "../workflow-template.js";
import {
	buildTargetId,
	type ModelSelection,
} from "./management-console-contract.js";

export type ManagementDagWriteResult =
	| WorkflowTemplatePublishResult
	| { status: "invalid"; reason: string };

export interface ManagementDagEdit {
	store: StateStore;
	targetId: string;
	expectedRevision: number;
	expectedDigest: string;
	desired: ModelSelection;
	actor: string;
}

function invalid(error: unknown): ManagementDagWriteResult {
	return {
		status: "invalid",
		reason: error instanceof Error ? error.message : String(error),
	};
}

/** Resolve the opaque target from current server state; never trust client ids. */
function resolveTarget(input: ManagementDagEdit):
	| {
			templateId: string;
			revision: number;
			digest: string;
			manifest: WorkflowManifestV1;
			nodeId: string;
	  }
	| undefined {
	for (const template of input.store.listWorkflowTemplates()) {
		if (!template.current_published_revision) continue;
		const revision = input.store.getWorkflowTemplateRevision(
			template.template_id,
			template.current_published_revision,
		);
		if (!revision) continue;
		const manifest = validateWorkflowManifest(JSON.parse(revision.manifest));
		for (const node of manifest.nodes) {
			if (node.type === "gate") continue;
			const serverTarget = buildTargetId("dag", [
				template.template_id,
				node.id,
				"dispatch",
			]);
			if (serverTarget !== input.targetId) continue;
			return {
				templateId: template.template_id,
				revision: revision.revision,
				digest: revision.manifest_digest,
				manifest,
				nodeId: node.id,
			};
		}
	}
	return undefined;
}

export function applyManagementDagEdit(
	input: ManagementDagEdit,
): ManagementDagWriteResult {
	let target: ReturnType<typeof resolveTarget>;
	try {
		target = resolveTarget(input);
	} catch (error) {
		return invalid(error);
	}
	if (!target) return { status: "not_found" };
	if (
		target.revision !== input.expectedRevision ||
		target.digest !== input.expectedDigest
	) {
		return { status: "conflict", currentRevision: target.revision };
	}

	const registered = getModelRegistryEntry(input.desired.model);
	if (
		!registered ||
		registered.provider !== input.desired.provider ||
		!isModelSelectionSupported({
			surface: "workflow",
			model: input.desired.model,
			effort: input.desired.effort ?? undefined,
			runtimeVendor: registered.runtimeVendor,
		})
	) {
		return invalid("desired workflow model selection is not supported");
	}

	try {
		const next = structuredClone(target.manifest);
		const node = next.nodes.find((candidate) => candidate.id === target.nodeId);
		if (!node || node.type === "gate") {
			return { status: "not_found" };
		}
		node.vendor = registered.runtimeVendor;
		node.model = registered.id;
		if (input.desired.effort)
			node.effort = input.desired.effort as typeof node.effort;
		else delete node.effort;
		const validated = validateWorkflowManifest(next);
		return input.store.createAndPublishWorkflowTemplateRevision({
			templateId: target.templateId,
			manifest: validated,
			expectedRevision: input.expectedRevision,
			createdBy: input.actor,
		});
	} catch (error) {
		return invalid(error);
	}
}

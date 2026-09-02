import {
	getModelConfigSnapshot,
	type ModelConfigSnapshot,
} from "flywheel-config";
import type {
	StateStore,
	WorkflowTemplatePublishResult,
} from "../StateStore.js";
import {
	validateWorkflowManifest,
	type WorkflowEffort,
	type WorkflowManifest,
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

function workflowEffort(
	value: string | null | undefined,
): WorkflowEffort | undefined {
	if (value == null) return undefined;
	switch (value) {
		case "low":
		case "medium":
		case "high":
		case "xhigh":
			return value;
		default:
			throw new Error(`unsupported workflow effort: ${value}`);
	}
}

/** Resolve the opaque target from current server state; never trust client ids. */
function resolveTarget(
	input: ManagementDagEdit,
	modelSnapshot: ModelConfigSnapshot,
):
	| {
			templateId: string;
			revision: number;
			digest: string;
			manifest: WorkflowManifest;
			nodeId: string;
	  }
	| undefined {
	for (const template of input.store.listWorkflowTemplates()) {
		try {
			if (!template.current_published_revision) continue;
			const revision = input.store.getWorkflowTemplateRevision(
				template.template_id,
				template.current_published_revision,
			);
			if (!revision) continue;
			const manifest = validateWorkflowManifest(JSON.parse(revision.manifest), {
				allowUnsupportedModels: true,
				modelSnapshot,
			});
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
		} catch {
			// A legacy/retired model in one persisted template must not block
			// edits to independent healthy templates. The read model exposes that
			// template's diagnostic separately.
		}
	}
	return undefined;
}

export function applyManagementDagEdit(
	input: ManagementDagEdit,
): ManagementDagWriteResult {
	// One immutable model generation for the complete edit decision. A hot
	// config replacement may affect the next request, never half of this one.
	const modelSnapshot = getModelConfigSnapshot();
	let target: ReturnType<typeof resolveTarget>;
	try {
		target = resolveTarget(input, modelSnapshot);
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

	const desiredModel = input.desired.model.trim();
	const registered = modelSnapshot.getModelRegistryEntry(desiredModel);
	if (
		!desiredModel ||
		!registered ||
		registered.provider !== input.desired.provider ||
		!modelSnapshot.isModelSelectionSupported({
			surface: "workflow",
			model: desiredModel,
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
		// Persist the validated source spelling for workflow templates. Stable
		// aliases intentionally follow the registry authority for future runs;
		// materialization canonicalizes once into each immutable run snapshot.
		node.model = desiredModel;
		const effort = workflowEffort(input.desired.effort);
		if (effort) node.effort = effort;
		else delete node.effort;
		const validated = validateWorkflowManifest(next, {
			allowUnsupportedModels: true,
			modelSnapshot,
		});
		return input.store.createAndPublishWorkflowTemplateRevision({
			templateId: target.templateId,
			manifest: validated,
			expectedRevision: input.expectedRevision,
			createdBy: input.actor,
			allowUnsupportedModels: true,
			modelSnapshot,
		});
	} catch (error) {
		return invalid(error);
	}
}

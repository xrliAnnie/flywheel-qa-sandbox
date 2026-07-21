import { resolvePhaseDispatch } from "flywheel-config";
import type { StateStore } from "./StateStore.js";
import { parseWorkflowRunSnapshot } from "./workflow-run-snapshot.js";
import {
	validateWorkflowManifest,
	type WorkflowEffort,
	type WorkflowVendor,
} from "./workflow-template.js";

export interface WorkflowDispatchResolution {
	dispatch: {
		vendor: WorkflowVendor;
		model: string;
		effort?: WorkflowEffort;
	};
	source:
		| "current_config"
		| "live_template"
		| "snapshot_fallback"
		| "approved_design_fallback";
	audit: boolean;
}

const APPROVED_FALLBACK_SOURCE_MODEL = "claude-fable-5";
const APPROVED_FALLBACK_TARGET = {
	vendor: "codex" as const,
	model: "gpt-5.6-sol",
	effort: "xhigh" as const,
};
const APPROVED_REPLACEMENT_MODELS = new Set([
	APPROVED_FALLBACK_SOURCE_MODEL,
	APPROVED_FALLBACK_TARGET.model,
]);

/**
 * Resolve the physical dispatch immediately before admission. The immutable
 * runtime row written by admission is the launch source of truth; failures in
 * mutable config/template lookup conservatively fall back to the pinned node.
 */
export function resolveNodeDispatchAtLaunch(
	store: StateStore,
	input: {
		runId: string;
		nodeId: string;
		env?: Record<string, string | undefined>;
		approvedDesignFallback?: boolean;
	},
): WorkflowDispatchResolution {
	const run = store.getWorkflowRun(input.runId);
	if (!run?.snapshot) throw new Error("workflow_dispatch_run_snapshot_missing");
	const snapshot = parseWorkflowRunSnapshot(run.snapshot);
	const node = snapshot.resolved.nodes.find(
		(candidate) => candidate.id === input.nodeId,
	);
	if (!node?.dispatch) throw new Error("workflow_dispatch_node_not_executable");
	const pinned = { ...node.dispatch };
	const env = input.env ?? process.env;

	if (input.approvedDesignFallback) {
		if (
			node.type !== "design" ||
			pinned.vendor !== "claude" ||
			pinned.model !== APPROVED_FALLBACK_SOURCE_MODEL ||
			!APPROVED_REPLACEMENT_MODELS.has(pinned.model) ||
			!APPROVED_REPLACEMENT_MODELS.has(APPROVED_FALLBACK_TARGET.model)
		) {
			throw new Error("workflow_dispatch_fallback_not_allowlisted");
		}
		return {
			dispatch: { ...APPROVED_FALLBACK_TARGET },
			source: "approved_design_fallback",
			audit: true,
		};
	}

	if (env.FLYWHEEL_VENDOR_AT_DISPATCH === "0") {
		return { dispatch: pinned, source: "snapshot_fallback", audit: false };
	}

	if (
		snapshot.schema_version === 1 &&
		(node.type === "design" || node.type === "implement" || node.type === "qa")
	) {
		const configured = resolvePhaseDispatch(node.type, env);
		const effort = configured.effort === "max" ? "xhigh" : configured.effort;
		return {
			dispatch: {
				vendor: configured.vendor,
				model: configured.model,
				...(effort ? { effort } : {}),
			},
			source: "current_config",
			audit: true,
		};
	}

	try {
		const template = store.getWorkflowTemplate(run.template_id!);
		if (!template?.current_published_revision) throw new Error("no_revision");
		const revision = store.getWorkflowTemplateRevision(
			template.template_id,
			template.current_published_revision,
		);
		if (!revision) throw new Error("revision_missing");
		const manifest = validateWorkflowManifest(JSON.parse(revision.manifest));
		const live = manifest.nodes.find(
			(candidate) => candidate.id === input.nodeId,
		);
		if (!live?.vendor || !live.model) throw new Error("node_dispatch_missing");
		return {
			dispatch: {
				vendor: live.vendor,
				model: live.model,
				...(live.effort ? { effort: live.effort } : {}),
			},
			source: "live_template",
			audit: true,
		};
	} catch {
		return { dispatch: pinned, source: "snapshot_fallback", audit: true };
	}
}

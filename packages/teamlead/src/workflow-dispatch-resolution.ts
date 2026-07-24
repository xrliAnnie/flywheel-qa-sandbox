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
	source: "current_config" | "live_template" | "snapshot_fallback";
	audit: boolean;
}

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

	if (env.FLYWHEEL_VENDOR_AT_DISPATCH === "0") {
		return { dispatch: pinned, source: "snapshot_fallback", audit: false };
	}
	if (node.dispatchPinned) {
		return { dispatch: pinned, source: "snapshot_fallback", audit: true };
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

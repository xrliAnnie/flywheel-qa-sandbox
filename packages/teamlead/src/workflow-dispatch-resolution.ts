import { resolveAllowedEffort } from "flywheel-config";
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
	source: "live_template" | "snapshot_fallback";
	audit: boolean;
}

/**
 * FLY-1650 (Codex R2): drop an effort the resolved model does not support,
 * HERE — at admission — rather than only at the launch seam. The row admission
 * writes is immutable and is what the audit trail reports, so a narrowing that
 * happened later would leave the ledger claiming an effort the run never used.
 *
 * This is also the one place that can MANUFACTURE a bad pair: the `max` → `xhigh`
 * remap below turns a phase configured as `max` — which Opus 4.6 does support —
 * into `xhigh`, which it does not.
 *
 * Surface is `workflow`, matching what these nodes are. That keeps every Codex
 * node byte-identical (its workflow surface carries the full effort ladder,
 * unlike its runner surface) and narrows only models with a declared gap.
 */
function narrowEffort(dispatch: {
	vendor: WorkflowVendor;
	model: string;
	effort?: WorkflowEffort;
}): { vendor: WorkflowVendor; model: string; effort?: WorkflowEffort } {
	if (!dispatch.effort) return dispatch;
	const allowed = resolveAllowedEffort(dispatch.model, dispatch.effort, {
		surface: "workflow",
	});
	if (allowed === dispatch.effort) return dispatch;
	const { effort: _dropped, ...rest } = dispatch;
	return rest;
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
	if (node.dispatchPinned) {
		return {
			dispatch: narrowEffort(pinned),
			source: "snapshot_fallback",
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
			dispatch: narrowEffort({
				vendor: live.vendor,
				model: live.model,
				...(live.effort ? { effort: live.effort } : {}),
			}),
			source: "live_template",
			audit: true,
		};
	} catch {
		return {
			dispatch: narrowEffort(pinned),
			source: "snapshot_fallback",
			audit: true,
		};
	}
}

import { MODEL_IDS } from "flywheel-config";
import type { StateStore } from "./StateStore.js";
import type { WorkflowEffort, WorkflowVendor } from "./workflow-template.js";

export interface WorkflowReviewRoute {
	reviewerVendor: WorkflowVendor;
	reviewerModel: string;
	reviewerEffort: WorkflowEffort;
}

export function resolveWorkflowReviewRoute(input: {
	reviewType: "design" | "code";
	authorVendor: WorkflowVendor;
	authorModel: string;
}): WorkflowReviewRoute {
	if (input.authorVendor !== "claude" && input.authorVendor !== "codex")
		throw new Error(
			`unsupported ${input.reviewType} review author vendor: ${input.authorVendor}`,
		);
	return input.authorVendor === "claude"
		? {
				reviewerVendor: "codex",
				reviewerModel:
					input.reviewType === "code"
						? MODEL_IDS.CODEX_STANDARD
						: MODEL_IDS.CODEX_ASTRA,
				reviewerEffort: "xhigh",
			}
		: {
				reviewerVendor: "claude",
				reviewerModel: MODEL_IDS.OPUS_55,
				reviewerEffort: "xhigh",
			};
}

export function resolveWorkflowReviewRouteForExecution(
	store: Pick<
		StateStore,
		| "getWorkflowExecutionRuntime"
		| "getWorkflowRunNodeForExecution"
		| "getWorkflowRun"
	>,
	executionId: string,
	reviewType: "design" | "code",
):
	| (WorkflowReviewRoute & {
			authorModel: string;
			authorVendor: WorkflowVendor;
	  })
	| undefined {
	const binding = store.getWorkflowRunNodeForExecution(executionId);
	const run = binding ? store.getWorkflowRun(binding.run_id) : undefined;
	const runtime = store.getWorkflowExecutionRuntime(executionId);
	if (!run?.snapshot) return undefined;
	let snapshot: unknown;
	try {
		snapshot = JSON.parse(run.snapshot);
	} catch {
		throw new Error(`workflow run ${binding?.run_id} snapshot is corrupt`);
	}
	if (
		!snapshot ||
		typeof snapshot !== "object" ||
		!("modelRouting" in snapshot)
	)
		return undefined;
	if (!runtime?.model || !runtime.vendor)
		throw new Error(
			`routed execution ${executionId} has no immutable workflow runtime model`,
		);
	if (runtime.vendor !== "claude" && runtime.vendor !== "codex")
		throw new Error(
			`routed execution ${executionId} has invalid immutable workflow runtime vendor`,
		);
	return {
		authorModel: runtime.model,
		authorVendor: runtime.vendor,
		...resolveWorkflowReviewRoute({
			reviewType,
			authorModel: runtime.model,
			authorVendor: runtime.vendor,
		}),
	};
}

export function recordWorkflowReviewRoute(
	store: Pick<
		StateStore,
		"appendWorkflowRunEventChecked" | "getWorkflowRunNodeForExecution"
	>,
	input: {
		executionId: string;
		reviewType: "design" | "code";
		requestId: string;
		route: WorkflowReviewRoute & {
			authorModel: string;
			authorVendor: WorkflowVendor;
		};
	},
): void {
	const binding = store.getWorkflowRunNodeForExecution(input.executionId);
	if (!binding) return;
	store.appendWorkflowRunEventChecked({
		runId: binding.run_id,
		nodeId: binding.node_id,
		executionId: input.executionId,
		eventUid: `review_model_routed:${binding.run_id}:${binding.node_id}:${input.reviewType}:${input.requestId}`,
		kind: "review_model_routed",
		payload: {
			schemaVersion: 1,
			reviewType: input.reviewType,
			requestId: input.requestId,
			authorModel: input.route.authorModel,
			authorVendor: input.route.authorVendor,
			reviewerVendor: input.route.reviewerVendor,
			reviewerModel: input.route.reviewerModel,
			reviewerEffort: input.route.reviewerEffort,
		},
	});
}

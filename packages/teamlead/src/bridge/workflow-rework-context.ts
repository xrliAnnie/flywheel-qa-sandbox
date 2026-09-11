import { canonicalSubmissionDigest } from "flywheel-config";
import type {
	WorkflowReworkRequestRow,
	WorkflowReworkRouteRevisionRow,
} from "../StateStore.js";

export interface WorkflowReworkContext {
	requestId: string;
	authority: WorkflowReworkRequestRow["authority"];
	authorityContext: unknown;
	target: {
		nodeId: string;
		attempt: number;
		invalidationScope: string[];
		verificationPolicy: string[];
	};
}

export function buildWorkflowReworkContext(input: {
	request: Pick<
		WorkflowReworkRequestRow,
		"request_id" | "authority" | "authority_context_json"
	>;
	route: Pick<
		WorkflowReworkRouteRevisionRow,
		| "target_node_id"
		| "target_attempt"
		| "invalidation_scope"
		| "verification_policy"
	>;
}):
	| { ok: true; context: WorkflowReworkContext }
	| { ok: false; reason: "authority_context_corrupt" } {
	let authorityContext: unknown;
	try {
		authorityContext = JSON.parse(input.request.authority_context_json);
	} catch {
		return { ok: false, reason: "authority_context_corrupt" };
	}
	return {
		ok: true,
		context: {
			requestId: input.request.request_id,
			authority: input.request.authority,
			authorityContext,
			target: {
				nodeId: input.route.target_node_id,
				attempt: input.route.target_attempt,
				invalidationScope: input.route.invalidation_scope,
				verificationPolicy: input.route.verification_policy,
			},
		},
	};
}

export function isWorkflowReworkNodeReuseContext(context: unknown): boolean {
	if (!context || typeof context !== "object" || Array.isArray(context))
		return false;
	const authorityContext = (context as { authorityContext?: unknown })
		.authorityContext;
	return (
		authorityContext !== null &&
		typeof authorityContext === "object" &&
		!Array.isArray(authorityContext) &&
		(authorityContext as { kind?: unknown }).kind === "node_reuse"
	);
}

export function renderWorkflowReworkContextLine(context: unknown): string {
	return `${isWorkflowReworkNodeReuseContext(context) ? "Verification context" : "Rework context"}: ${JSON.stringify(context)}`;
}

export function renderWorkflowReworkLaunchStableSection(input: {
	context: WorkflowReworkContext;
	baseRevision: string;
}): string {
	const { context, baseRevision } = input;
	const authority = context.authorityContext;
	const outcome =
		authority && typeof authority === "object"
			? (authority as { outcome?: unknown }).outcome
			: undefined;
	return `## Rework context (replacement launch)\n\nYou replace a dead actor for rework request ${context.requestId}. Authority: ${context.authority}. Previous verdict: ${outcome ?? "n/a"}.\nBase revision under rework: ${baseRevision}. Do the requested rework before completing; a completion with no change against the base revision may be sent back by the verifying node.\n${renderWorkflowReworkContextLine(context)}`;
}

export function workflowReworkLaunchDigest(input: {
	requestId: string;
	routeRevision: number;
	stableSection: string;
}): string {
	return canonicalSubmissionDigest(input);
}

export function renderWorkflowReworkLaunchSection(input: {
	stableSection: string;
	qaSummary?: string;
}): string {
	return `${input.stableSection}\nQA summary: ${input.qaSummary ?? "(no QA summary provided)"}`;
}

export const WORKFLOW_AGENT_CONTENT_BUDGET = 40_000;

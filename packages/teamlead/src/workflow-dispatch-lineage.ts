import type { WorkflowRunEventRow } from "./StateStore.js";

type TransitionPayload = Record<string, unknown>;
function payloadOf(event: WorkflowRunEventRow): TransitionPayload | undefined {
	try {
		const value: unknown =
			typeof event.payload === "string"
				? JSON.parse(event.payload)
				: event.payload;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as TransitionPayload)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Read the immutable replacement chain shared by preflight and dispatch. */
export function resolveWorkflowDispatchLineage(
	events: readonly WorkflowRunEventRow[],
	target: {
		runId: string;
		nodeId: string;
		attempt: number;
		executionId: string;
		/** Only a validated rework route may consult historical immutable actor or dispatch identities. */
		hasReworkActorOrigin?: (executionId: string, attempt: number) => boolean;
	},
): {
	transition: WorkflowRunEventRow | undefined;
	transitionPayload: TransitionPayload | undefined;
	originExecutionId: string;
	replacementEventUids: string[];
} {
	const matchesAttempt = (executionId: string, attempt: unknown): boolean =>
		attempt === target.attempt ||
		(typeof attempt === "number" &&
			Number.isSafeInteger(attempt) &&
			attempt > 0 &&
			attempt < target.attempt &&
			target.hasReworkActorOrigin?.(executionId, attempt) === true);
	const decoded = events.map((event) => ({ event, payload: payloadOf(event) }));
	const visited = new Set<string>();
	const replacementEventUids: string[] = [];
	let originExecutionId = target.executionId;
	for (;;) {
		if (visited.has(originExecutionId))
			throw new Error("workflow_lineage_cycle");
		visited.add(originExecutionId);
		const edges = decoded.filter(
			({ event, payload }) =>
				event.kind === "edge_traversed" &&
				payload?.successorExecutionId === originExecutionId,
		);
		const replacements = decoded.filter(
			({ event, payload }) =>
				(event.kind === "execution_dead_rolled_back" ||
					event.kind === "codex_quota_fallback_prepared") &&
				payload?.newExecutionId === originExecutionId,
		);
		if (edges.length + replacements.length > 1)
			throw new Error("workflow_lineage_ambiguous");
		const edge = edges[0];
		if (edge) {
			if (
				edge.event.run_id !== target.runId ||
				!edge.event.execution_id ||
				edge.payload?.targetNodeId !== target.nodeId ||
				!matchesAttempt(originExecutionId, edge.payload.targetAttempt)
			)
				throw new Error("workflow_lineage_target_mismatch");
			return {
				transition: edge.event,
				transitionPayload: edge.payload,
				originExecutionId,
				replacementEventUids,
			};
		}
		const replacement = replacements[0];
		if (!replacement)
			return {
				transition: undefined,
				transitionPayload: undefined,
				originExecutionId,
				replacementEventUids,
			};
		if (
			replacement.event.run_id !== target.runId ||
			replacement.event.node_id !== target.nodeId ||
			(replacement.event.kind === "execution_dead_rolled_back" &&
				!matchesAttempt(originExecutionId, replacement.payload?.attempt)) ||
			!replacement.event.execution_id
		)
			throw new Error("workflow_lineage_target_mismatch");
		replacementEventUids.push(replacement.event.event_uid);
		originExecutionId = replacement.event.execution_id;
	}
}

import { describe, expect, it } from "vitest";
import type { WorkflowRunEventRow } from "../StateStore.js";
import { resolveWorkflowDispatchLineage } from "../workflow-dispatch-lineage.js";

const target = {
	runId: "run",
	nodeId: "implement",
	attempt: 2,
	executionId: "new",
};
function event(
	kind: string,
	executionId: string,
	payload: unknown,
	overrides: Partial<WorkflowRunEventRow> = {},
): WorkflowRunEventRow {
	return {
		run_id: "run",
		seq: 1,
		event_uid: `${kind}:${executionId}`,
		kind,
		node_id: "implement",
		execution_id: executionId,
		edge_id: null,
		at: "2026-09-26T00:00:00.000Z",
		payload,
		...overrides,
	};
}
const edge = event(
	"edge_traversed",
	"qa",
	{
		successorExecutionId: "first",
		targetNodeId: "implement",
		targetAttempt: 2,
		outcome: "qa_fail",
		loopIteration: 1,
		founderFeedback: "retain feedback",
	},
	{ node_id: "qa" },
);
const chain = [
	edge,
	event("execution_dead_rolled_back", "first", {
		newExecutionId: "second",
		attempt: 2,
	}),
	event("execution_dead_rolled_back", "second", {
		newExecutionId: "new",
		attempt: 2,
	}),
];

describe("shared workflow dispatch lineage", () => {
	it("follows consecutive replacements to the original edge without losing decision context", () => {
		const resolved = resolveWorkflowDispatchLineage(chain, target);
		expect(resolved.transition).toBe(edge);
		expect(resolved.transitionPayload).toMatchObject({
			outcome: "qa_fail",
			loopIteration: 1,
			founderFeedback: "retain feedback",
		});
		expect(resolved.originExecutionId).toBe("first");
		expect(resolved.replacementEventUids).toEqual([
			chain[2]!.event_uid,
			chain[1]!.event_uid,
		]);
	});
	it("follows a quota fallback body to its parked source transition", () => {
		const fallback = event("codex_quota_fallback_prepared", "first", {
			newExecutionId: "new",
			fallbackAttempt: 1,
		});
		const resolved = resolveWorkflowDispatchLineage([edge, fallback], target);
		expect(resolved.transition).toBe(edge);
		expect(resolved.originExecutionId).toBe("first");
		expect(resolved.replacementEventUids).toEqual([fallback.event_uid]);
	});
	it("accepts a prior rework actor attempt only with its exact immutable origin", () => {
		const historical = {
			...edge,
			payload: { ...(edge.payload as object), targetAttempt: 1 },
		};
		const events = [historical, ...chain.slice(1)];
		expect(() => resolveWorkflowDispatchLineage(events, target)).toThrow(
			"workflow_lineage_target_mismatch",
		);
		expect(
			resolveWorkflowDispatchLineage(events, {
				...target,
				hasReworkActorOrigin: (id, attempt) => id === "first" && attempt === 1,
			}).transition,
		).toBe(historical);
		expect(() =>
			resolveWorkflowDispatchLineage(events, {
				...target,
				hasReworkActorOrigin: () => false,
			}),
		).toThrow("workflow_lineage_target_mismatch");
	});
	it("returns an unresolved origin for the caller to verify an exact root reservation", () => {
		expect(
			resolveWorkflowDispatchLineage(chain.slice(1), target),
		).toMatchObject({ transition: undefined, originExecutionId: "first" });
	});
	it("rejects ambiguous edges or replacements instead of selecting the latest event", () => {
		expect(() =>
			resolveWorkflowDispatchLineage(
				[...chain, { ...edge, event_uid: "different-edge" }],
				target,
			),
		).toThrow("workflow_lineage_ambiguous");
		expect(() =>
			resolveWorkflowDispatchLineage(
				[
					...chain,
					event("execution_dead_rolled_back", "other", {
						newExecutionId: "new",
						attempt: 2,
					}),
				],
				target,
			),
		).toThrow("workflow_lineage_ambiguous");
	});
	it("rejects cycles and cross-run, node, or attempt replacement evidence", () => {
		expect(() =>
			resolveWorkflowDispatchLineage(
				[
					event("execution_dead_rolled_back", "new", {
						newExecutionId: "new",
						attempt: 2,
					}),
				],
				target,
			),
		).toThrow("workflow_lineage_cycle");
		for (const invalid of [
			{ run_id: "other" },
			{ node_id: "qa" },
			{ payload: { newExecutionId: "new", attempt: 1 } },
		]) {
			expect(() =>
				resolveWorkflowDispatchLineage(
					[
						event(
							"execution_dead_rolled_back",
							"old",
							{ newExecutionId: "new", attempt: 2 },
							invalid,
						),
					],
					target,
				),
			).toThrow("workflow_lineage_target_mismatch");
		}
	});
	it("rejects an edge to a different target and preserves unrelated history", () => {
		expect(() =>
			resolveWorkflowDispatchLineage(
				[
					{
						...edge,
						payload: {
							successorExecutionId: "new",
							targetNodeId: "qa",
							targetAttempt: 2,
						},
					},
				],
				target,
			),
		).toThrow("workflow_lineage_target_mismatch");
		expect(
			resolveWorkflowDispatchLineage(
				[...chain, event("edge_traversed", "unrelated", "bad json")],
				target,
			).transition,
		).toBe(edge);
	});
});

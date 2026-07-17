import { describe, expect, it } from "vitest";
import {
	findMaterializedProducerNode,
	receiptBackedMaterializedHeadAuthority,
} from "../bridge/materialized-head-authority.js";
import type { WorkflowRunSnapshot } from "../workflow-run-snapshot.js";

function snapshot(
	edges: Array<{ from: string; to: string }>,
): WorkflowRunSnapshot {
	return {
		schema_version: 2,
		template: { id: "tpl_product_v1", revision: 1 },
		manifest: {
			schema_version: 2,
			nodes: [],
			edges: edges.map((edge, index) => ({
				id: `edge-${index}`,
				...edge,
				condition: "node_done" as const,
			})),
			loops: [],
			terminal_gate: { node: "founder", predicate: "founder_approved" },
			ship_claims: ["design_review_approved", "founder_approved"],
		},
		manifest_digest: "manifest",
		resolved: {
			nodes: [
				{
					id: "produce",
					type: "generic",
					capabilities: { produces_output: true },
				} as never,
				{
					id: "other",
					type: "generic",
					capabilities: { produces_output: true },
				} as never,
				{ id: "review", type: "review", capabilities: {} } as never,
			],
		},
		snapshot_digest: "snapshot",
	};
}

describe("receipt-backed materialized head authority", () => {
	it("finds the single output-producing predecessor of a review node", () => {
		expect(
			findMaterializedProducerNode(
				snapshot([{ from: "produce", to: "review" }]),
				"review",
			),
		).toBe("produce");
	});

	it("fails closed for an absent or ambiguous producer", () => {
		expect(() => findMaterializedProducerNode(snapshot([]), "review")).toThrow(
			/materialized_producer_unavailable/,
		);
		expect(() =>
			findMaterializedProducerNode(
				snapshot([
					{ from: "produce", to: "review" },
					{ from: "other", to: "review" },
				]),
				"review",
			),
		).toThrow(/materialized_producer_ambiguous/);
	});

	it("returns only a current push-confirmed receipt", async () => {
		const snap = snapshot([{ from: "produce", to: "review" }]);
		const authority = receiptBackedMaterializedHeadAuthority(
			{
				getWorkflowRun: () => ({ snapshot: JSON.stringify(snap) }),
				getWorkflowMaterializedHead: () => ({
					head: "a".repeat(40),
					outputId: 7,
					attempt: 2,
				}),
			} as never,
			{
				parseSnapshot: () => snap,
			},
		);
		await expect(authority.resolve("run", "review")).resolves.toEqual({
			head: "a".repeat(40),
			outputId: 7,
			attempt: 2,
		});

		const unavailable = receiptBackedMaterializedHeadAuthority(
			{
				getWorkflowRun: () => ({ snapshot: JSON.stringify(snap) }),
				getWorkflowMaterializedHead: () => undefined,
			} as never,
			{ parseSnapshot: () => snap },
		);
		await expect(unavailable.resolve("run", "review")).rejects.toThrow(
			/materialized_head_unavailable/,
		);
	});
});

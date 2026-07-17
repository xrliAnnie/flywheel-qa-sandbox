export interface MaterializedHeadAuthorityResult {
	head: string;
	outputId: number;
	attempt: number;
}

/**
 * Trusted read port for a review node's materialized producer. PR-7.5 supplies
 * the durable receipt-backed implementation; PR-7 deliberately defaults to a
 * closed port so a missing materializer can never promote caller-supplied data.
 */
export interface MaterializedHeadAuthority {
	resolve(
		runId: string,
		reviewNodeId: string,
	): Promise<MaterializedHeadAuthorityResult>;
}

export const unavailableMaterializedHeadAuthority: MaterializedHeadAuthority = {
	async resolve(): Promise<never> {
		throw new Error("materialized_head_unavailable");
	},
};

export function findMaterializedProducerNode(
	snapshot: WorkflowRunSnapshot,
	reviewNodeId: string,
): string {
	const review = snapshot.resolved.nodes.find(
		(node) => node.id === reviewNodeId,
	);
	if (review?.type !== "review") {
		throw new Error("materialized_review_node_unavailable");
	}
	const producerIds = new Set(
		snapshot.manifest.edges
			.filter(
				(edge) => edge.to === reviewNodeId && edge.condition === "node_done",
			)
			.map((edge) => edge.from),
	);
	const producers = snapshot.resolved.nodes.filter(
		(node) => producerIds.has(node.id) && node.capabilities.produces_output,
	);
	if (producers.length === 0) {
		throw new Error("materialized_producer_unavailable");
	}
	if (producers.length !== 1) {
		throw new Error("materialized_producer_ambiguous");
	}
	return producers[0]!.id;
}

type MaterializedHeadStore = Pick<
	StateStore,
	"getWorkflowRun" | "getWorkflowMaterializedHead"
>;

export function receiptBackedMaterializedHeadAuthority(
	store: MaterializedHeadStore,
	options: {
		parseSnapshot?: typeof parseWorkflowRunSnapshot;
	} = {},
): MaterializedHeadAuthority {
	const parseSnapshot = options.parseSnapshot ?? parseWorkflowRunSnapshot;
	return {
		async resolve(runId, reviewNodeId) {
			const run = store.getWorkflowRun(runId);
			if (!run?.snapshot)
				throw new Error("materialized_run_snapshot_unavailable");
			const snapshot = parseSnapshot(run.snapshot);
			const producerNodeId = findMaterializedProducerNode(
				snapshot,
				reviewNodeId,
			);
			const resolved = store.getWorkflowMaterializedHead(runId, producerNodeId);
			if (!resolved) throw new Error("materialized_head_unavailable");
			return resolved;
		},
	};
}

import type { StateStore } from "../StateStore.js";
import {
	parseWorkflowRunSnapshot,
	type WorkflowRunSnapshot,
} from "../workflow-run-snapshot.js";

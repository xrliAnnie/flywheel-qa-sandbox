import { DagResolver } from "flywheel-dag-resolver";
import type { DagNode } from "flywheel-dag-resolver";
import type { Blueprint, BlueprintContext, BlueprintResult } from "./Blueprint.js";

/** Result of a full DAG dispatch run */
export interface DispatchResult {
	completed: string[];
	shelved: string[];
	totalCostUsd: number;
}

/** Callback for dispatch progress events */
export type OnNodeComplete = (
	nodeId: string,
	result: BlueprintResult,
) => Promise<void>;

/**
 * DagDispatcher: loops through ready nodes from DAG resolver,
 * executes Blueprint for each, marks done or shelves.
 *
 * Phase 1: sequential execution (one node at a time).
 * Phase 3+: can be extended for parallel execution.
 */
export class DagDispatcher {
	/** Callback for per-node completion events */
	onNodeComplete?: OnNodeComplete;

	constructor(
		private resolver: DagResolver,
		private blueprint: Blueprint,
		private projectRoot: string,
		private buildContext: (node: DagNode) => BlueprintContext,
	) {}

	async dispatch(): Promise<DispatchResult> {
		const completed: string[] = [];
		const shelved: string[] = [];
		let totalCostUsd = 0;

		while (this.resolver.remaining() > 0) {
			const ready = this.resolver.getReady();
			if (ready.length === 0) {
				// All remaining nodes are blocked — nothing more to do
				break;
			}

			// Phase 1: sequential — process one node at a time
			const node = ready[0]!;
			const ctx = this.buildContext(node);
			const result = await this.blueprint.run(
				node,
				this.projectRoot,
				ctx,
			);
			totalCostUsd += result.costUsd;

			if (result.success) {
				this.resolver.markDone(node.id);
				completed.push(node.id);
			} else {
				this.resolver.shelve(node.id);
				shelved.push(node.id);
			}

			if (this.onNodeComplete) {
				await this.onNodeComplete(node.id, result);
			}
		}

		return { completed, shelved, totalCostUsd };
	}
}

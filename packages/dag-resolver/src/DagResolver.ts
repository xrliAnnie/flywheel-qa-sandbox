import type {
	DagNode,
	DagResolverOptions,
	DagWarning,
	NodeStatus,
} from "./types.js";

/**
 * DAG dependency resolver using Kahn's topological sort algorithm.
 *
 * Manages a directed acyclic graph of tasks (nodes) with blocking relationships.
 * Provides methods to get the next ready tasks, mark tasks done, and shelve tasks.
 *
 * Key behaviors:
 * - Unknown blockers (IDs not in the graph) block by default + emit warnings
 * - Cycles are detected at construction time
 * - Shelving blocks downstream by default (configurable via allowBypassBlockers)
 */
export class DagResolver {
	private nodes: Map<string, DagNode>;
	private status: Map<string, NodeStatus>;
	private inDegree: Map<string, number>;
	private warnings: DagWarning[] = [];
	private options: Required<DagResolverOptions>;
	private resolvedExternalBlockers: Map<string, Set<string>> = new Map();

	constructor(nodes: DagNode[], options: DagResolverOptions = {}) {
		this.options = { allowBypassBlockers: false, ...options };
		this.nodes = new Map(nodes.map((n) => [n.id, n]));
		this.status = new Map(nodes.map((n) => [n.id, "pending"]));
		this.inDegree = new Map();

		// First pass: compute known-only in-degrees for cycle detection
		const knownInDegree = new Map<string, number>();
		for (const node of nodes) {
			const unknownBlockers = node.blockedBy.filter(
				(id) => !this.nodes.has(id),
			);

			for (const blockerId of unknownBlockers) {
				this.warnings.push({
					type: "unknown_blocker",
					nodeId: node.id,
					blockerId,
				});
			}

			const knownCount = node.blockedBy.filter((id) =>
				this.nodes.has(id),
			).length;
			knownInDegree.set(node.id, knownCount);
		}

		// Validate no cycles exist among known nodes
		this.validateNoCycles(nodes, knownInDegree);

		// Second pass: runtime in-degrees include unknown blockers (block by default)
		for (const node of nodes) {
			const unknownCount = node.blockedBy.filter(
				(id) => !this.nodes.has(id),
			).length;
			const knownCount = knownInDegree.get(node.id)!;
			this.inDegree.set(node.id, knownCount + unknownCount);
		}
	}

	/** Get warnings emitted during graph construction */
	getWarnings(): DagWarning[] {
		return this.warnings;
	}

	/** Get all nodes that are ready to execute (in-degree 0, status pending) */
	getReady(): DagNode[] {
		const ready: DagNode[] = [];
		for (const [id, deg] of this.inDegree) {
			if (deg === 0 && this.status.get(id) === "pending") {
				ready.push(this.nodes.get(id)!);
			}
		}
		return ready;
	}

	/** Mark a node as completed and release its downstream dependents */
	markDone(id: string): void {
		this.assertNodeExists(id);
		if (this.status.get(id) !== "pending") return; // idempotent
		this.status.set(id, "done");
		this.decrementDownstream(id);
	}

	/**
	 * Shelve a node (e.g., failed, deferred).
	 * By default, shelving does NOT release downstream dependents.
	 * Set `allowBypassBlockers: true` in options to release them.
	 */
	shelve(id: string): void {
		this.assertNodeExists(id);
		if (this.status.get(id) !== "pending") return; // idempotent
		this.status.set(id, "shelved");
		if (this.options.allowBypassBlockers) {
			this.decrementDownstream(id);
		}
	}

	/**
	 * Resolve an external (unknown) blocker for a specific node.
	 * Idempotent — calling twice with the same blockerId is a no-op.
	 */
	resolveExternalBlocker(nodeId: string, blockerId: string): void {
		this.assertNodeExists(nodeId);
		// Only accept blockers that are actually unknown (not in the graph)
		const node = this.nodes.get(nodeId)!;
		if (!node.blockedBy.includes(blockerId) || this.nodes.has(blockerId)) {
			return; // not an external blocker for this node
		}

		if (!this.resolvedExternalBlockers.has(nodeId)) {
			this.resolvedExternalBlockers.set(nodeId, new Set());
		}
		const resolved = this.resolvedExternalBlockers.get(nodeId)!;
		if (resolved.has(blockerId)) return;
		resolved.add(blockerId);

		const current = this.inDegree.get(nodeId) ?? 0;
		if (current > 0) {
			this.inDegree.set(nodeId, current - 1);
		}
	}

	/** Count of nodes still pending (not done or shelved) */
	remaining(): number {
		let count = 0;
		for (const s of this.status.values()) {
			if (s === "pending") count++;
		}
		return count;
	}

	/** Validate that no cycles exist in the known dependency graph */
	private validateNoCycles(
		nodes: DagNode[],
		knownInDegree: Map<string, number>,
	): void {
		// BFS-based cycle detection using only known blockers
		const temp = new Map(knownInDegree);
		const queue: string[] = [];
		let visited = 0;

		for (const [id, deg] of temp) {
			if (deg === 0) queue.push(id);
		}

		while (queue.length > 0) {
			const cur = queue.shift()!;
			visited++;

			// Find all nodes that depend on cur (cur is in their blockedBy)
			for (const node of nodes) {
				if (
					node.blockedBy.includes(cur) &&
					this.nodes.has(node.id) // Only known nodes
				) {
					const deg = temp.get(node.id)! - 1;
					temp.set(node.id, deg);
					if (deg === 0) queue.push(node.id);
				}
			}
		}

		if (visited < nodes.length) {
			throw new Error(
				`Cycle detected in dependency graph. ${nodes.length - visited} node(s) in cycle.`,
			);
		}
	}

	/** Decrement in-degree for all downstream dependents of a node */
	private decrementDownstream(id: string): void {
		for (const [nodeId, node] of this.nodes) {
			if (node.blockedBy.includes(id)) {
				const current = this.inDegree.get(nodeId) ?? 0;
				if (current > 0) {
					this.inDegree.set(nodeId, current - 1);
				}
			}
		}
	}

	/** Assert that a node exists in the graph */
	private assertNodeExists(id: string): void {
		if (!this.nodes.has(id)) {
			throw new Error(`Node "${id}" not found in graph`);
		}
	}
}

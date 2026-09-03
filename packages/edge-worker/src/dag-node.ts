/**
 * FLY-2144: the only surviving type from the retired dependency-ordering path.
 * Production reads `id` only; `blockedBy` remains for test fixtures.
 */
export interface DagNode {
	id: string;
	blockedBy: string[];
}

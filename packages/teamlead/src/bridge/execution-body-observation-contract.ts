/**
 * Consumer-side structural contract for FLY-2919's exported BodyObservation.
 * This module intentionally contains no process probing or verdict logic: the
 * single shared provider owns those decisions, and consumers only fail closed.
 */
export interface BodyObservation {
	identity: {
		executionId: string;
		activationId: string | null;
		generation: number;
		lifecycleRevision: number;
		adapter: "codex-tmux" | "claude-tmux" | "kimi-tmux" | "antigravity-tmux";
	};
	ownerToken: string;
	spawnEpoch: number;
	verdict: "alive" | "dead" | "unknown";
	observedAt: string;
	expiresAt: string;
	bindingDigest: string;
	reason: string;
}

export interface ExecutionBodyObserver {
	observe(executionId: string): Promise<BodyObservation | undefined>;
	/** Synchronous identity/owner/epoch/TTL check adjacent to a consumer CAS. */
	isCurrent(observation: BodyObservation): boolean;
}

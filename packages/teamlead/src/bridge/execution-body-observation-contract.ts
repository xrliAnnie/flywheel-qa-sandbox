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

/**
 * Provider-owned proof for an execution that failed before a process binding
 * could be persisted.  The source receipt alone is never a death verdict: the
 * shared provider must also close launch/owner, socket, and spawn-lock state.
 */
export interface NeverStartedBodyObservation {
	identity: BodyObservation["identity"];
	source: {
		origin: "live_preflight" | "legacy_compat";
		projectName: string;
		issueId: string;
		executionRunId: string;
		sourceEventId: string;
		proofDigest: string;
		launchClaimState: "closed" | "unknown";
		daemonLedger: "missing" | "no_group" | "unknown";
		daemonLedgerShape: "missing" | "prelaunch_home_only" | "unknown";
	};
	ownership: {
		state: "absent" | "unknown";
		spawnInflight: false | null;
		restartInProgress: false | null;
		censusDigest: string;
	};
	socket: { state: "absent" | "unknown"; evidenceDigest: string };
	lock: { state: "absent" | "unknown"; evidenceDigest: string };
	verdict: "dead" | "unknown";
	observedAt: string;
	expiresAt: string;
	bindingDigest: string;
	reason: string;
}

export interface ExecutionBodyObserver {
	observe(executionId: string): Promise<BodyObservation | undefined>;
	/** Synchronous identity/owner/epoch/TTL check adjacent to a consumer CAS. */
	isCurrent(observation: BodyObservation): boolean;
	/** Optional FLY-2754 source branch; absent support must remain unknown. */
	observeNeverStarted?(
		executionId: string,
	): Promise<NeverStartedBodyObservation | undefined>;
	isCurrentNeverStarted?(observation: NeverStartedBodyObservation): boolean;
}

/**
 * Missing provider support is an unknown observation, never permission to use
 * a second physical-death authority. Production injects this until the shared
 * provider factory is available.
 */
export const FAIL_CLOSED_EXECUTION_BODY_OBSERVER: ExecutionBodyObserver =
	Object.freeze({
		async observe() {
			return undefined;
		},
		isCurrent() {
			return false;
		},
		async observeNeverStarted() {
			return undefined;
		},
		isCurrentNeverStarted() {
			return false;
		},
	});

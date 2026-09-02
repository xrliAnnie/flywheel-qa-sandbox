import type { Session, StateStore } from "../StateStore.js";

const DEFAULT_EXECUTION_MUTATION_LEASE_TTL_MS = 60_000;

type ExecutionMutationLeaseStore = Pick<
	StateStore,
	"getSession" | "claimExecutionMutationLease" | "commitExecutionMutationLease"
>;

/**
 * Serialize a cross-store execution mutation against Codex recovery.
 *
 * A thrown mutation deliberately leaves the lease durable until TTL: CommDB may
 * already have committed while the StateStore projector failed, so releasing
 * early would reopen the destructive recovery path before replay converges it.
 */
export function withExecutionMutationLease<T>(input: {
	store: ExecutionMutationLeaseStore;
	executionId: string | null | undefined;
	holder: string;
	mutate: () => T;
	nowMs?: () => number;
	ttlMs?: number;
}): T {
	if (!input.executionId) return input.mutate();
	const session: Pick<Session, "lifecycle_revision"> | undefined =
		input.store.getSession(input.executionId);
	if (!session) return input.mutate();
	const expectedRevision = session.lifecycle_revision ?? 0;
	const nowMs = input.nowMs ?? Date.now;
	const claim = input.store.claimExecutionMutationLease(
		input.executionId,
		expectedRevision,
		{
			holder: input.holder,
			nowMs: nowMs(),
			ttlMs: input.ttlMs ?? DEFAULT_EXECUTION_MUTATION_LEASE_TTL_MS,
		},
	);
	if (!claim.ok) {
		throw new Error(`execution mutation lease refused: ${claim.reason}`);
	}

	const result = input.mutate();
	const committed = input.store.commitExecutionMutationLease(
		input.executionId,
		claim.claimToken,
		expectedRevision,
		nowMs(),
	);
	if (!committed.ok) {
		throw new Error(
			`execution mutation lease commit refused: ${committed.reason}`,
		);
	}
	return result;
}

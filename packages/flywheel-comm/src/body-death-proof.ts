/** Bridge-internal projection of an immutable StateStore body_death event.
 * No Runner HTTP or CLI route accepts this proof or its verifier. */
export interface BodyDeathProjectionProof {
	version: 1;
	obligationId: string;
	executionId: string;
	activationId: string | null;
	generation: number;
	ownerToken: string;
	spawnEpoch: number;
	bindingDigest: string;
	lifecycleRevision: number;
	runId: string | null;
	nodeId: string | null;
	attempt: number | null;
	projectName: string;
	issueId: string;
	evidenceId: string;
	expectedIdentityRevision: string;
	observedTurnEpoch: number | null;
	observedAt: string;
	expiresAt: string;
	committedAt: string;
	terminalLifecycleId: string;
	terminalStatus: "completed" | "failed" | "blocked" | "timeout";
	terminalReason: string;
}
export type BodyDeathProjectionResult =
	| {
			projected: true;
			idempotentReplay: boolean;
			result: {
				retiredQuestionCount: number;
				retiredAskCount: number;
				deletedSessionCount: number;
				turnRevoked: boolean;
				founderWakeIds: string[];
				/** Historical snapshot only. Rework/ordinary wake settlement uses existing receipts. */
				pendingWakeIds: string[];
			};
	  }
	| {
			projected: false;
			reason:
				| "invalid_body_death_proof"
				| "body_death_unverified"
				| "closeout_receipt_conflict"
				| "closeout_identity_changed"
				| "turn_changed";
	  };

export function isBodyDeathProjectionProof(
	proof: BodyDeathProjectionProof,
	nowMs: number,
): boolean {
	const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
	const observed = Date.parse(proof.observedAt);
	const expires = Date.parse(proof.expiresAt);
	const committed = Date.parse(proof.committedAt);
	const workflowScope =
		typeof proof.activationId === "string" &&
		proof.activationId.trim().length > 0 &&
		proof.activationId.length <= 4096 &&
		typeof proof.runId === "string" &&
		proof.runId.trim().length > 0 &&
		proof.runId.length <= 4096 &&
		typeof proof.nodeId === "string" &&
		proof.nodeId.trim().length > 0 &&
		proof.nodeId.length <= 4096 &&
		proof.attempt !== null &&
		positive(proof.attempt);
	const legacyScope =
		proof.activationId === null &&
		proof.runId === null &&
		proof.nodeId === null &&
		proof.attempt === null;
	return (
		proof.version === 1 &&
		[
			proof.executionId,
			proof.ownerToken,
			proof.projectName,
			proof.issueId,
			proof.terminalLifecycleId,
			proof.terminalReason,
		].every(
			(v) => typeof v === "string" && v.trim().length > 0 && v.length <= 4096,
		) &&
		positive(proof.generation) &&
		positive(proof.spawnEpoch) &&
		(workflowScope || legacyScope) &&
		Number.isSafeInteger(proof.lifecycleRevision) &&
		proof.lifecycleRevision >= 0 &&
		(proof.observedTurnEpoch === null || positive(proof.observedTurnEpoch)) &&
		proof.obligationId ===
			`body_death:${proof.executionId}:${proof.generation}` &&
		proof.obligationId.length <= 280 &&
		/^[a-f0-9]{64}$/.test(proof.bindingDigest) &&
		/^[a-f0-9]{64}$/.test(proof.evidenceId) &&
		/^epoch:(?:0|[1-9][0-9]*)$/.test(proof.expectedIdentityRevision) &&
		["completed", "failed", "blocked", "timeout"].includes(
			proof.terminalStatus,
		) &&
		Number.isSafeInteger(nowMs) &&
		nowMs >= 0 &&
		Number.isFinite(observed) &&
		Number.isFinite(expires) &&
		Number.isFinite(committed) &&
		observed <= committed &&
		committed < expires &&
		expires - observed <= 10000 &&
		nowMs >= committed
	);
}

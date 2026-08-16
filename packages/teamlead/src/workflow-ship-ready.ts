export const SHIP_READY_REMIND_MS = 30 * 60 * 1_000;

export type WorkflowShipReadyNotice = {
	runId: string;
	issueId: string;
	issueIdentifier?: string;
	projectName: string;
	templateId: string;
	gateNodeId: string;
	attempt: number;
	gateOpenedAt: string;
	sourceExecutionId: string;
	ageMinutes: number;
	evidence: {
		headSha?: string;
		prNumber?: number;
		qaPassed: boolean;
	};
	pending: {
		lead: boolean;
		founder: boolean;
	};
};

export type ShipReadyFounderOutcome =
	| { kind: "posted" }
	| { kind: "transient"; reason: string; retryAfterMs?: number }
	| { kind: "permanent"; reason: string };

export type ShipReadyHandledOutcome =
	| { kind: "handled"; reason: "pr_merged" | "founder_approved" }
	| { kind: "unhandled" }
	| { kind: "unknown" };

export type WorkflowRunnerShipMergeCandidate = {
	runId: string;
	issueId: string;
	projectName: string;
	templateId: string;
	gateNodeId: string;
	attempt: number;
	questionId: string;
	holderState: "materializing" | "awaiting_review" | "approved";
	carrierBindingState: "unbound" | "bound";
	subjectDigest: string;
	sourceExecutionId: string;
	gateOpenedAt: string;
	/** Stable pre-attempt identity for durable completion retry/backoff state. */
	completionContextDigest: string;
	authority: WorkflowRunnerShipAuthorityResolution;
	fingerprint?: string;
	mergedObserved?:
		| { status: "valid"; headSha: string }
		| { status: "needs_rest" };
	observationConflict?: {
		fingerprint: string;
		digest: string;
		conflictingHeads: string[];
	};
	/** Compatibility projection for legacy call sites while authority migrates. */
	prNumber?: number;
};

export type WorkflowRunnerShipResolvedAuthority = {
	status: "resolved";
	repoIdentity: string;
	probeRepoSlug: string;
	prNumber: number;
	source: "ship_target" | "node_binding" | "ship_target_session";
};

export type WorkflowRunnerShipAuthorityResolution =
	| WorkflowRunnerShipResolvedAuthority
	| { status: "legacy_missing"; prNumber: number }
	| { status: "authority_conflict"; digest: string }
	| { status: "unavailable" };

export type WorkflowRunnerShipMergeProbe = {
	state: "merged" | "closed" | "open" | "unknown";
	headRefOid?: string;
	rawHeadRefOid?: string;
	evidence?: "current" | "verified" | "hydrated_unverified";
	fingerprint?: string;
	failure?: {
		kind: "head_enrichment" | "hydration_revalidation";
		reason: string;
		notify: boolean;
	};
};

export type ShipReadyMarkerPayload = {
	path: "lead" | "founder" | "failed";
	reason?: string;
	at: string;
};

export type WorkflowShipReadyArm = {
	queueLeadNotice(
		notice: WorkflowShipReadyNotice,
	): Promise<{ queued: boolean }>;
	postFounderCard(
		notice: WorkflowShipReadyNotice,
	): Promise<ShipReadyFounderOutcome>;
	classifyShipHandled(
		batch: readonly WorkflowShipReadyNotice[],
	): Promise<Map<string, ShipReadyHandledOutcome>>;
	/** Epoch-1 merge completion backstop; absent only in narrow legacy tests. */
	classifyRunnerShipMerged?(
		batch: readonly WorkflowRunnerShipMergeCandidate[],
	): Promise<Map<string, WorkflowRunnerShipMergeProbe>>;
};

export function workflowShipReadyUid(input: {
	runId: string;
	gateNodeId: string;
	attempt: number;
}): string {
	return `${input.runId}:${input.gateNodeId}:${input.attempt}`;
}

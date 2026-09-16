import type { BetaCandidate, VetoBinding } from "flywheel-release-contract";

export type CustomerReleaseState =
	| "evaluating"
	| "preparing"
	| "notice_pending"
	| "window_open"
	| "awaiting_attempt"
	| "committing"
	| "commit_unknown"
	| "cancelled"
	| "manual_ready"
	| "published";

export interface CustomerReleaseCycle {
	cycleId: string;
	projectId: string;
	slotDate: string;
	weekStart: string;
	releaseId: string;
	frozenBeta: BetaCandidate;
	binding: VetoBinding | null;
	policyRevision: string;
	activationEpoch: number;
	state: CustomerReleaseState;
	revision: number;
	windowOpenedAt: number | null;
	deadlineAt: number | null;
	claimNotAfter: number | null;
	cancelReason: string | null;
	invalidatedEventSeq: number | null;
	latestVerdictId: string | null;
	createdAt: number;
}

export interface CustomerReleaseEvent {
	seq: number;
	eventId: string;
	cycleId: string;
	kind: string;
	who: string;
	when: number;
	reason: string | null;
}

export interface CustomerReleaseReservation {
	projectId: string;
	slotDate: string;
	releaseId: string;
	activationEpoch: number;
	policyRevision: string;
	betaVersion: string;
	manifest: unknown;
	now: number;
}

/** These are internal adapter receipts, never accepted directly from a runner or HTTP caller. */
export interface CustomerPrepareReceipt {
	workflowRunId: string;
	equivalenceVerified: boolean;
	readbackSha256: string;
}
export interface CustomerNoticeIntent {
	noticeId: string;
	messageDigest: string;
	channelId: string;
	applicationId: string;
	botUserId: string;
	founderId: string;
	noticeAt: number;
	deadlineAt: number;
	claimNotAfter: number;
	minimumVetoMinutes: number;
}
export interface CustomerNotice extends CustomerNoticeIntent {
	bindingDigest: string;
	sendState: "intent" | "sending" | "uncertain" | "delivered" | "rejected";
	messageId: string | null;
	deliveredAt: number | null;
}
export interface CustomerDeliveryReceipt extends CustomerNoticeIntent {
	messageId: string;
	verifiedAt: number;
	accessVerified: boolean;
	gatewayHealthy: boolean;
}

/** Created only by the authenticated interaction adapter after schema/user validation. */
export interface CustomerVetoAction {
	interactionId: string;
	actorId: string;
	applicationId: string;
	channelId: string;
	messageId: string;
	noticeId: string;
	bindingDigest: string;
}
export interface CustomerActionReceipt {
	interactionId: string;
	cycleId: string;
	actorId: string;
	effectiveAt: number;
	result: "cancelled" | "post_claim";
}

/** Verified endpoint readback, never an untrusted workflow dispatch input. */
export interface CustomerReadyAttempt {
	attemptId: string;
	cycleId: string;
	projectId: string;
	audience: string;
	activationEpoch: number;
	nonce: string;
	baseEtag: string;
	readyAt: number;
	fullBinding: VetoBinding;
	readbackSha256: string;
}
/** Collected synchronously from current policy and verified founder enable evidence. */
export interface CustomerClaimActivation {
	mode: string;
	enabled: boolean;
	enableReceiptValid: boolean;
	founderId: string;
	enableReceiptId: string;
	evidenceBundleDigest: string;
	activationEpoch: number;
	policyRevision: string;
	audience: string;
	sourcesHealthy: boolean;
}
export interface CustomerReleasePermit extends CustomerReadyAttempt {
	decisionId: string;
	action: "commit";
	trigger: "silence_auto" | "founder_go" | "founder_override";
	actor: string;
	manualRequestId?: string;
	readiness?: { state: string; reasons: unknown[] };
	verdictId: string;
	evidenceRevision: number;
	claimedAt: number;
	notAfter: number;
}

/** Authenticated endpoint observation; workflow completion/expiry alone is never no_write. */
export interface CustomerAttemptResult {
	attemptId: string;
	decisionId: string;
	nonce: string;
	baseEtag: string;
	kind: "unknown" | "no_write" | "published" | "fenced";
	reason?: "guard_rejected" | "cas_conflict";
	manifest?: unknown;
	manifestEtag?: string;
}

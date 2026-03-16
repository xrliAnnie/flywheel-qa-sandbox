/**
 * CIPHER types — Pattern dimensions, snapshot/outcome params, statistics, context.
 */

/**
 * Pre-decision observable features — only fields known BEFORE DecisionLayer runs.
 * Post-decision fields (systemRoute, confidenceBand, decisionSource) are stored
 * in decision_snapshots directly but NOT used as pattern keys for lookup.
 */
export interface PatternDimensions {
	primaryLabel: string;
	sizeBucket: "tiny" | "small" | "medium" | "large";
	areaTouched:
		| "frontend"
		| "backend"
		| "auth"
		| "test"
		| "config"
		| "mixed";
	exitStatus: "completed" | "timeout" | "error";
	hasPriorFailures: boolean;
	commitVolume: "single" | "few" | "many";
	diffScale: "trivial" | "small" | "medium" | "large";
	hasTests: boolean;
	touchesAuth: boolean;
}

export interface SnapshotParams {
	executionId: string;
	issueId: string;
	issueIdentifier: string;
	issueTitle: string;
	projectId: string;
	issueLabels: string[];
	dimensions: PatternDimensions;
	patternKeys: string[];
	systemRoute: string;
	systemConfidence: number;
	decisionSource: string;
	decisionReasoning?: string;
	commitCount: number;
	filesChanged: number;
	linesAdded: number;
	linesRemoved: number;
	diffSummary?: string;
	commitMessages: string[];
	changedFilePaths: string[];
	exitReason: string;
	durationMs: number;
	consecutiveFailures: number;
}

export interface OutcomeParams {
	executionId: string;
	ceoAction: "approve" | "reject" | "defer";
	ceoActionTimestamp: string;
	sourceStatus?: string;
}

export interface PatternStatistics {
	patternKey: string;
	approveCount: number;
	rejectCount: number;
	totalCount: number;
	posteriorMean: number;
	wilsonLower: number;
	maturityLevel: "exploratory" | "tentative" | "established" | "trusted";
}

export interface CipherContext {
	relevantPatterns: PatternStatistics[];
	globalApproveRate: number;
	promptText: string;
}

/** DTO for event-route boundary — validated before constructing SnapshotParams */
export interface SnapshotInputDto {
	labels: string[];
	exitReason: string;
	changedFilePaths: string[];
	commitCount: number;
	filesChangedCount: number;
	linesAdded: number;
	linesRemoved: number;
	consecutiveFailures: number;
}

/** Payload shape for CIPHER principle proposal notifications. */
export interface CipherProposalPayload {
	event_type: "cipher_principle_proposed";
	cipher_principle_id: string;
	cipher_skill_id: string;
	cipher_proposal_rule: string;
	cipher_proposal_rule_type: "block" | "escalate";
	cipher_proposal_confidence: number;
	cipher_proposal_samples: number;
	cipher_source_pattern: string;
}

/** Callback injected by TeamLead composition root for proposal notifications. */
export type CipherNotifyFn = (
	payload: CipherProposalPayload,
) => Promise<void>;

/** Internal representation of a cipher_principles row */
export interface CipherPrinciple {
	id: string;
	skill_id: string;
	rule_type: "block" | "escalate";
	rule_definition: string;
	confidence: number;
	sample_count: number;
	source_pattern: string;
	graduation_criteria: string;
	status: "proposed" | "active" | "retired";
	activated_at?: string;
	retired_at?: string;
	retired_reason?: string;
	created_at: string;
}

/** Internal representation of a cipher_skills row */
export interface CipherSkill {
	id: string;
	name: string;
	description: string;
	source_pattern_key?: string;
	trigger_conditions: string;
	recommended_action: string;
	confidence: number;
	sample_count: number;
	derived_from_reviews?: string;
	derived_by: "statistical" | "llm";
	status: "draft" | "active" | "retired";
	created_at: string;
	updated_at: string;
}

/** Internal representation of a cipher_questions row */
export interface CipherQuestion {
	id: string;
	question_type: "pattern_conflict" | "new_territory" | "drift_detected";
	description: string;
	related_pattern_key?: string;
	evidence: string;
	asked_at?: string;
	resolved_at?: string;
	resolution?: string;
	status: "open" | "asked" | "resolved";
	created_at: string;
}

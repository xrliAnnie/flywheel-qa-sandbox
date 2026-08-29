/**
 * Decision Layer types — ExecutionContext, DecisionResult, and related.
 * Used by HardRuleEngine, HaikuTriageAgent, HaikuVerifier, FallbackHeuristic.
 */

// FLY-493: `pr_handoff` — DecisionLayer routes a no-transport (antigravity)
// ready_to_merge build to this terminal route instead of needs_review.
// FLY-793: `phase_design_complete` — a three-stage Design phase-session finished
// (docs committed to the shared branch, no PR/code). The PhaseOrchestrator acts
// on it to hand off to the Implement phase. Maps to the non-terminal `design_done`
// status (NOT a founder-facing terminal); no PR/merge evidence.
export type DecisionRoute =
	| "auto_approve"
	| "needs_review"
	| "blocked"
	| "pr_handoff"
	| "phase_design_complete";

export type DecisionSource =
	| "hard_rule"
	| "haiku_triage"
	| "haiku_verify"
	| "fallback_heuristic"
	| "decision_error_fallback";

/** Landing status signal from flywheel-land skill */
export interface LandingStatus {
	status: "merged" | "failed" | "ready_to_merge";
	prNumber?: number;
	mergedAt?: string;
	mergeCommitSha?: string;
	failureReason?: string;
	failureDetail?: string;
}

export interface ExecutionContext {
	// Execution identity
	executionId: string;

	// Issue identity
	issueId: string;
	issueIdentifier: string;
	issueTitle: string;
	labels: string[];
	projectId: string;

	// Execution state
	exitReason: "completed" | "timeout" | "error";
	baseSha: string;

	// Evidence (from ExecutionEvidenceCollector)
	commitCount: number;
	commitMessages: string[];
	changedFilePaths: string[];
	filesChangedCount: number;
	linesAdded: number;
	linesRemoved: number;
	diffSummary: string;
	headSha: string | null;
	durationMs: number;

	// Error tracking
	consecutiveFailures: number;

	// Partial evidence flag
	partial: boolean;

	// Landing status (v0.6 — undefined if landing not attempted)
	landingStatus?: LandingStatus;

	/**
	 * FLY-493 — set to `"none"` for a no-transport (antigravity) Runner that
	 * cannot be woken to drive the founder-gated ship. When this is `"none"` and
	 * the landing is `ready_to_merge`, the DecisionLayer routes to `pr_handoff`
	 * (terminal build+PR handoff) instead of the wake-dependent `needs_review`.
	 */
	runnerTransportMode?: "none";
}

export interface DecisionResult {
	route: DecisionRoute;
	confidence: number;
	reasoning: string;
	concerns: string[];
	decisionSource: DecisionSource;
	hardRuleId?: string;
	verification?: VerificationResult;
}

export interface VerificationResult {
	approved: boolean;
	confidence: number;
	concerns: string[];
	checklist: {
		matchesIssue: boolean;
		noObviousBugs: boolean;
		errorHandling: boolean;
		noSecrets: boolean;
		appropriateScope: boolean;
	};
}

export interface HardRuleResult {
	triggered: boolean;
	action: "escalate" | "block";
	reason: string;
	ruleId: string;
}

/**
 * Decision Layer types — ExecutionContext, DecisionResult, and related.
 * Used by HardRuleEngine, HaikuTriageAgent, HaikuVerifier, FallbackHeuristic.
 */

export type DecisionRoute = "auto_approve" | "needs_review" | "blocked";

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

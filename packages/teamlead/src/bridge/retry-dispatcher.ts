/** GEO-168: IRetryDispatcher interface — retry creates a new execution. */

export interface RetryRequest {
	oldExecutionId: string;
	issueId: string;
	issueIdentifier?: string;
	issueTitle?: string;
	projectName: string;
	reason?: string;
	previousError?: string;
	previousDecisionRoute?: string;
	previousReasoning?: string;
	runAttempt: number;
	// GEO-206: Lead ID for bidirectional communication
	leadId?: string;
	/** FLY-59: Session role for multi-session-per-issue support */
	sessionRole?: string;
}

export interface RetryResult {
	newExecutionId: string;
	oldExecutionId: string;
}

export interface IRetryDispatcher {
	dispatch(req: RetryRequest): Promise<RetryResult>;
	getInflightIssues(): Set<string>;
	/** FLY-59: Check if a specific issue+role combo is currently inflight */
	hasInflightForRole(issueId: string, role: string): boolean;
	stopAccepting(): void;
	drain(): Promise<void>;
	teardownRuntimes(): Promise<void>;
}

/** GEO-267: Start a new Runner execution (no predecessor session) */
export interface StartRequest {
	issueId: string;
	projectName: string;
	leadId?: string;
	/** FLY-24: Pre-fetched issue title from runs-route Linear pre-flight */
	issueTitle?: string;
	/** FLY-24: Pre-fetched issue identifier (e.g. "GEO-304") from runs-route Linear pre-flight */
	issueIdentifier?: string;
	/** FLY-59: Session role for multi-session-per-issue support */
	sessionRole?: string;
}

export interface StartResult {
	executionId: string;
	issueId: string;
}

export interface IStartDispatcher {
	start(req: StartRequest): Promise<StartResult>;
	/** Current count of inflight (dispatched but not yet completed) executions */
	getInflightCount(): number;
}

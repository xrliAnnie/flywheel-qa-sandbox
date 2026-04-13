/**
 * GEO-195: LeadRuntime abstraction — per-lead runtime adapter.
 */

import type { HookPayload } from "./hook-payload.js";

/** Result of a deliver() call — success or transport failure. */
export interface DeliveryResult {
	delivered: boolean;
	error?: string;
}

/**
 * Guardrail event types — delivery failures must NOT be silently swallowed.
 * These events represent critical alerts (stuck/orphan/stale) that the Lead
 * must act on. Failed delivery triggers retry on next heartbeat cycle.
 */
export const GUARDRAIL_EVENT_TYPES = new Set([
	"session_stuck",
	"session_orphaned",
	"session_stale_completed",
	"runner_idle_detected", // FLY-92: idle watchdog events must be reliably delivered
]);

/** Monotonically sequenced event envelope for lead delivery. */
export interface LeadEventEnvelope {
	seq: number;
	event: HookPayload;
	sessionKey: string;
	leadId: string;
	timestamp: string;
}

/** Bootstrap snapshot for crash recovery. */
export interface LeadBootstrap {
	leadId: string;
	activeSessions: BootstrapSession[];
	pendingDecisions: BootstrapDecision[];
	recentFailures: BootstrapFailure[];
	/** Events delivered in the last 5 min — may need re-processing after crash. */
	recentEvents: LeadEventEnvelope[];
	memoryRecall: string | null;
	/** FLY-62: Pending gate questions awaiting Annie's response */
	pendingGateQuestions?: BootstrapGateQuestion[];
}

/** FLY-62: Gate question included in bootstrap for crash recovery */
export interface BootstrapGateQuestion {
	questionId: string;
	checkpoint: string;
	executionId: string;
	issueIdentifier?: string;
	content: string;
	commDbPath: string;
	createdAt: string;
	/** FLY-59: Session role for distinguishing concurrent same-issue gate questions */
	sessionRole?: string;
}

export interface BootstrapSession {
	executionId: string;
	issueId: string;
	issueIdentifier?: string;
	issueTitle?: string;
	projectName: string;
	status: string;
	startedAt?: string;
	threadId?: string;
	/** FLY-91: Chat thread ID for per-issue conversation in chatChannel */
	chatThreadId?: string;
	/** FLY-59: Session role for multi-session-per-issue support */
	sessionRole?: string;
}

export interface BootstrapDecision {
	executionId: string;
	issueId: string;
	issueIdentifier?: string;
	issueTitle?: string;
	projectName: string;
	decisionRoute?: string;
	commitCount?: number;
	summary?: string;
	/** FLY-59: Session role for multi-session-per-issue support */
	sessionRole?: string;
}

export interface BootstrapFailure {
	executionId: string;
	issueId: string;
	issueIdentifier?: string;
	issueTitle?: string;
	projectName: string;
	lastError?: string;
	failedAt?: string;
	/** FLY-59: Session role for multi-session-per-issue support */
	sessionRole?: string;
}

export interface LeadRuntimeHealth {
	status: "healthy" | "degraded" | "down";
	lastDeliveryAt: string | null;
	lastDeliveredSeq: number;
}

/**
 * Runtime adapter for a Lead agent.
 *
 * Delivery contract (FLY-25 upgrade from fire-and-forget to result-based):
 * - Returns DeliveryResult: { delivered: boolean; error?: string }
 * - 3s timeout via AbortController
 * - Never throws — transport failures are captured in the result
 * - Callers use result to decide whether to mark event as delivered
 */
export interface LeadRuntime {
	readonly type: string;
	deliver(envelope: LeadEventEnvelope): Promise<DeliveryResult>;
	sendBootstrap(snapshot: LeadBootstrap): Promise<void>;
	health(): Promise<LeadRuntimeHealth>;
	shutdown(): Promise<void>;
}

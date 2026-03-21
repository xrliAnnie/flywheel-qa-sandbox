/**
 * GEO-195: LeadRuntime abstraction — per-lead switchable runtime adapter.
 * Allows OpenClaw and Claude Discord to run side-by-side, selected per lead.
 */

import type { HookPayload } from "./hook-payload.js";

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
}

export interface BootstrapFailure {
	executionId: string;
	issueId: string;
	issueIdentifier?: string;
	issueTitle?: string;
	projectName: string;
	lastError?: string;
	failedAt?: string;
}

export interface LeadRuntimeHealth {
	status: "healthy" | "degraded" | "down";
	lastDeliveryAt: string | null;
	lastDeliveredSeq: number;
}

/**
 * Runtime adapter for a Lead agent. Each lead can use a different runtime
 * (OpenClaw webhook vs Claude Discord control channel).
 *
 * Delivery contract (matches original notifyAgent() semantics):
 * - Fire-and-forget: callers wrap with .catch(() => {})
 * - 3s timeout via AbortController
 * - Error swallowing: failures warn, never throw to caller
 * - No retry: recovery via event journal + bootstrap
 */
export interface LeadRuntime {
	readonly type: "openclaw" | "claude-discord";
	deliver(envelope: LeadEventEnvelope): Promise<void>;
	sendBootstrap(snapshot: LeadBootstrap): Promise<void>;
	health(): Promise<LeadRuntimeHealth>;
	shutdown(): Promise<void>;
}

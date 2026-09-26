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
	"gate_timed_out", // FLY-159: Lead must reliably notify Annie when Runner gate times out (fail-close path only)
	"session_monitoring_lost", // FLY-172: Lead must reliably learn it lost monitoring of a live Runner (fall back to tmux)
	"runner_stuck_escalation", // FLY-195: stuck-candidate handoff to owning Lead — Lead judges + re-manages (plan §3.2)
	"runner_lead_pending_escalation", // FLY-637-ext: Lead has not answered a runner's blocking question gate — reliable nudge (R1 #6)
	"scheduled_run_blocked", // FLY-742: a scheduled/cron run-start was DECLINED by a stale session — Lead/founder must reliably learn the job is silently skipping
	"detection_suspicious", // FLY-1048 (A5): fail-suspicious is "never silent" — a dropped delivery would BE the silence it exists to prevent
	"detection_escalation", // FLY-1048 (C2): Lead-first leg of the unified escalation flow — the ~30min founder-grace clock starts here, so the Lead must reliably receive it
]);

/**
 * GEO-151: All event types that the HeartbeatService redelivery loop should
 * retry when `runtime.deliver` returns `{delivered:false}` or throws. Includes
 * the guardrail set plus `artifact_delivery` so a ProofShot capture that the
 * Lead failed to forward to Discord doesn't silently disappear.
 *
 * Bounded by existing `MAX_DELIVERY_ATTEMPTS` (5) — after exhaustion the row
 * stays undelivered with `last_error` populated, FLY-83 stuck alert tells
 * Annie.
 */
export const RETRYABLE_LEAD_EVENT_TYPES = new Set<string>([
	...GUARDRAIL_EVENT_TYPES,
	"artifact_delivery",
	// FLY-1018: a queued-but-undelivered ship-approval REQUEST must reach the
	// Lead eventually — "durably queued = accepted" (the route's 200) is only
	// true because this redelivery loop owns the tail.
	"ship_approval_request",
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
	/**
	 * FLY-161: Pending non-blocking Runner questions (`flywheel-comm ask`)
	 * awaiting Lead surface to Annie. Distinct bucket from `pendingGateQuestions`
	 * so the prompt can frame them as non-blocking (Runner continues working
	 * regardless of when the Lead responds).
	 */
	pendingRunnerQuestions?: BootstrapRunnerQuestion[];
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

/**
 * FLY-161: Non-blocking Runner question (from `flywheel-comm ask`, checkpoint
 * is NULL in CommDB). Routes by `q.to_agent` (the Lead the Runner explicitly
 * named), unlike `BootstrapGateQuestion` which is gated by source session
 * label-routing. Survives Runner completion — the question stays pending in
 * the bootstrap until the Lead responds (or the CommDB row TTLs out).
 */
export interface BootstrapRunnerQuestion {
	questionId: string;
	executionId: string;
	issueIdentifier?: string;
	content: string;
	commDbPath: string;
	createdAt: string;
	/** FLY-59 parity: session role for non-main sessions */
	sessionRole?: string;
	/**
	 * FLY-91 + FLY-161 R4: Chat thread for the target Lead's chatChannel
	 * (resolved from `targetLead.chatChannel`, NOT from source session labels —
	 * `runner_question` routes by `to_agent`, so chat-thread routing follows
	 * the target Lead, not the source session's label-derived Lead).
	 */
	chatThreadId?: string;
}

export interface BootstrapSession {
	executionId: string;
	issueId: string;
	issueIdentifier?: string;
	issueTitle?: string;
	projectName: string;
	status: string;
	startedAt?: string;
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

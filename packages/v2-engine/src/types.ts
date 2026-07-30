export interface EngineConfig {
	pollIntervalMs: number;
	heartbeatWriteIntervalMs: number;
	heartbeatStaleAfterMs: number;
	runningAttemptMaxAgeMs: number;
	coldStartAlertAfterMs: number;
	vipBurst: number;
	promotionAgeMs: number;
	maxAttempts: number;
	retryBaseMs: number;
	retryCapMs: number;
	noticePendingLimit: number;
}

export const DEFAULT_ENGINE_CONFIG: Readonly<EngineConfig> = Object.freeze({
	pollIntervalMs: 1_000,
	heartbeatWriteIntervalMs: 5_000,
	heartbeatStaleAfterMs: 30_000,
	runningAttemptMaxAgeMs: 30 * 60_000,
	coldStartAlertAfterMs: 5 * 60_000,
	vipBurst: 4,
	promotionAgeMs: 30 * 60_000,
	maxAttempts: 5,
	retryBaseMs: 30_000,
	retryCapMs: 15 * 60_000,
	noticePendingLimit: 500,
});

export class EngineConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EngineConfigError";
	}
}

export class PollTransientError extends Error {
	readonly code: "SQLITE_BUSY" | "SQLITE_LOCKED";

	constructor(code: "SQLITE_BUSY" | "SQLITE_LOCKED", cause: unknown) {
		super(`poll transient SQLite error: ${code}`, { cause });
		this.name = "PollTransientError";
		this.code = code;
	}
}

export interface EngineClock {
	nowMs(): number;
	nowIso(): string;
}

export interface EngineRuntime {
	clock: EngineClock;
}

export interface ConsumerAuthority {
	agentId: string;
	kind: "lead" | "runner";
	generation: number;
}

export interface SessionBinding {
	v: 1;
	hostEpoch: string;
	sessionId: string;
	pid: number;
	pidStart: string;
}

export type LeadIdentityDraft = {
	kind: "lead";
	leadId: string;
	instanceId: string;
	sessionBinding: SessionBinding;
};

/** FLY-1543 ①⑤: registration is lead-only; a runner's ledger identity is its
 * `activations` row, keyed by session_ref, and never enters `agents`. */
export type IdentityDraft = LeadIdentityDraft;

/**
 * FLY-1543 ⑤: every mailbox recipient is either a lead (an `agents` row) or a
 * session (an active `activations` row whose session_ref carries this prefix).
 * SQL and TS share this single discriminator; a test asserts the two agree.
 */
export const SESSION_RECIPIENT_PREFIX = "v2dag:";

export function isSessionRecipient(agentId: string): boolean {
	return agentId.startsWith(SESSION_RECIPIENT_PREFIX);
}

export type RegisteredAgent =
	| {
			kind: "lead";
			agentId: string;
			instanceId: string;
			generation: number;
			sessionBinding: SessionBinding;
	  }
	| {
			kind: "runner";
			/** = session_ref (agentId and instanceId are the same value). */
			agentId: string;
			instanceId: string;
			activationId: string;
			/** = activations.generation (the DAG attempt generation). */
			generation: number;
			/**
			 * Absent until the spawned process is bound (bindSpawnedRunnerTx): the
			 * first delivery envelope is prepared BEFORE the tmux session exists.
			 */
			sessionBinding?: SessionBinding;
	  };

export interface AttemptHandle {
	attemptUid: string;
	messageUid: string;
	agent: RegisteredAgent;
}

export type Effect =
	| {
			kind: "task";
			taskKind: string;
			state: "draft" | "ready";
			payload: string;
			projectId: string;
			lineageRootTaskId?: string;
	  }
	| { kind: "event"; eventKind: string; payload: string };

export const MAX_EFFECTS_PER_PROPOSAL = 32;
export const MAX_PROPOSAL_TOTAL_BYTES = 262_144;
export const MAX_FIELD_BYTES = 256;

export interface ConversionProposal {
	handle: AttemptHandle;
	effects: Effect[];
}

export interface ProposalAuthorization {
	capabilityId: string;
	token: string;
}

export type ConversionResult =
	| {
			ok: true;
			effects: Effect[];
			authorization?: ProposalAuthorization;
	  }
	| { ok: false; error: string };

export interface ConversionActionSpec {
	kind: string;
	payload: JsonValue;
	logicalEffectId: string;
	qualifier?: string;
	authorization?: JsonValue;
	supersedesActionId?: string;
	retryBasis?: {
		evidenceRef: string;
		reason: string;
	};
}

export interface ConversionContext {
	handle: AttemptHandle;
	performAction<Result extends JsonValue>(
		action: ConversionActionSpec,
		perform: () => Result | Promise<Result>,
	): Promise<RunRecordedActionResult>;
}

export type Converter = (
	message: {
		messageUid: string;
		payload: string;
		kind: string;
		sourceKind: string;
		seq: number;
	},
	context: ConversionContext,
) => Promise<ConversionResult>;

export type PollResult =
	| {
			status: "available";
			handle: AttemptHandle;
			payload: string;
			kind: string;
			sourceKind: string;
			seq: number;
			resumed: boolean;
	  }
	| { status: "busy"; attemptUid: string }
	| { status: "empty"; retryAfterMs: number };

import type { RunRecordedActionResult } from "flywheel-v2-actions";
import type { JsonValue } from "flywheel-v2-kernel";

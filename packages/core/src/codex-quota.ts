import { z } from "zod";

const identity = z
	.string()
	.min(1)
	.max(512)
	.regex(/^[^\s\p{Cc}]+$/u);

/** Wire contract. Account identity comes exclusively from a registered binding. */
export const codexQuotaSignalV1Schema = z.strictObject({
	version: z.literal(1),
	vendor: z.literal("codex"),
	source: z.enum(["goal_ended", "review_exec"]),
	sourceEventId: identity,
	bindingId: identity,
	evidence: z.enum(["usageLimited", "usageLimitExceeded"]),
	observedAt: z
		.string()
		.max(40)
		.pipe(z.iso.datetime({ offset: true })),
});
export type CodexQuotaSignalV1 = z.infer<typeof codexQuotaSignalV1Schema>;

export const codexQuotaBindingV1Schema = z.strictObject({
	bindingId: identity,
	executionId: identity,
	runId: identity.nullable(),
	accountKey: identity,
	profile: identity,
	generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	credentialRootKey: identity,
	purpose: z.enum(["runner", "review"]),
});
export type CodexQuotaBindingV1 = z.infer<typeof codexQuotaBindingV1Schema>;

export function parseCodexQuotaSignalV1(
	value: unknown,
): CodexQuotaSignalV1 | undefined {
	const result = codexQuotaSignalV1Schema.safeParse(value);
	return result.success ? result.data : undefined;
}
export function parseCodexQuotaBindingV1(
	value: unknown,
): CodexQuotaBindingV1 | undefined {
	const result = codexQuotaBindingV1Schema.safeParse(value);
	return result.success ? result.data : undefined;
}

export const CODEX_QUOTA_FAILURE_REASON =
	"goal ended non-complete: usageLimited";

/**
 * FLY-2900: explicit, Bridge-minted authorization for one Codex quota
 * standby relaunch of the same execution. It rides the real launch call graph
 * (StartRequest.processLifecycle.quotaResume → RunDispatcher admission →
 * Blueprint → CodexTmuxAdapter → beforeCodexDaemonStart) and is re-validated
 * against the durable claim at every quota gate; nothing infers it from the DB.
 */
export interface CodexQuotaResumeAuthorization {
	executionId: string;
	claimId: string;
	entrySeq: number;
	resumeAttempt: number;
}

/** FLY-2900: what the runner learned about a carried continue turn. */
export type CodexQuotaContinueReconciliation =
	| { kind: "proven" }
	| { kind: "absent" }
	| { kind: "failed_before_output"; usageLimited: boolean }
	| { kind: "unavailable" };

/** FLY-2900: the Bridge's verdict on a reconciled continue. */
export type CodexQuotaContinueDecision =
	| { action: "send"; continueAttemptId: string; settled: boolean }
	| { action: "abort"; reason: string };

/**
 * FLY-2900: the quota-resume half of a process lifecycle. Only the Bridge
 * builds it; the adapter forwards `authorization` to the daemon-start gate and
 * the daemon client runs the reconcile → reactivate → continue sequence.
 */
export interface CodexQuotaResumeLifecycle {
	authorization: CodexQuotaResumeAuthorization;
	/** Durable continue id; also the `clientUserMessageId` and the text marker. */
	continueAttemptId: string;
	/** True when the id was minted by this claim and cannot exist in history. */
	continueAttemptFresh: boolean;
	onContinueReconciled(
		outcome: CodexQuotaContinueReconciliation,
	): CodexQuotaContinueDecision;
	/** Called synchronously once turn/start returned, before buffered events drain. */
	onContinueStarted(input: { turnId: string }): boolean;
	/** First model-output item of the continue turn: the only success point. */
	onContinueProgress(input: { turnId: string; itemType: string }): void;
	/** The continue turn ended before any model output. */
	onContinueFailed(input: {
		turnId: string | null;
		reasonCode: string;
		usageLimited: boolean;
	}): void;
}

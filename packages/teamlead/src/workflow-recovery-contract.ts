import { canonicalSubmissionDigest } from "flywheel-config";
import { z } from "zod";

const identity = z.string().trim().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const head = z.string().regex(/^[a-f0-9]{40}$/);
const ordinal = z.number().int().safe().nonnegative();
const positiveOrdinal = ordinal.min(1);

const initialPolicy = z
	.object({
		resume: z
			.object({
				progressPath: identity,
				priorExecutionId: identity,
				resumeKind: z.enum(["restart", "terminate", "reboot", "handoff"]),
				effectiveStage: z.enum(["design", "implement", "qa"]).optional(),
				startPoint: head,
				shareParentBranch: z.literal(true),
			})
			.strict()
			.nullable(),
		continuityInherit: z
			.object({
				branch: identity,
				sha: head,
				prNumber: positiveOrdinal.optional(),
				prUrl: identity.optional(),
			})
			.strict()
			.optional(),
		continuityBranch: identity.optional(),
		skippedOriginTip: head.optional(),
		startPoint: identity.optional(),
		shareParentBranch: z.boolean().optional(),
	})
	.strict();

const startAuthority = z
	.object({
		mode: z.enum(["root_initial", "execution_head", "resume_anchor"]),
		sourceExecutionId: identity.nullable(),
		reservationKey: identity.nullable(),
		repositoryIdentity: identity,
		branch: identity,
		headSha: head,
		evidenceDigest: digest,
		provenance: identity,
		initialPolicy: initialPolicy.optional(),
	})
	.strict();

export const workflowRecoveryTargetSchema = z
	.object({
		operationKind: z.enum([
			"redispatch_current",
			"resume_existing",
			"rearm_gate_probe",
			"apply_recorded_decision",
		]),
		runId: identity,
		nodeId: identity,
		attempt: positiveOrdinal,
		previousExecutionId: identity.nullable(),
		previousLaunchOrdinal: ordinal,
		snapshotDigest: digest,
		holdSetDigest: digest,
		startAuthority: startAuthority.nullable(),
		sourceHoldEventUids: z
			.array(identity)
			.min(1)
			.refine((uids) => new Set(uids).size === uids.length)
			.transform((uids) => uids.sort()),
		rework: z
			.object({
				requestId: identity,
				routeRevision: positiveOrdinal,
			})
			.strict()
			.nullable(),
		land: z
			.object({
				operationId: identity,
				resumeGeneration: ordinal,
				approvedHead: head,
			})
			.strict()
			.nullable(),
	})
	.strict()
	.refine(
		(target) =>
			target.holdSetDigest ===
			canonicalSubmissionDigest(target.sourceHoldEventUids),
	);

export type WorkflowRecoveryTarget = z.infer<
	typeof workflowRecoveryTargetSchema
>;

export const workflowRecoveryCanonicalSchema = z
	.object({
		version: z.literal(2),
		runId: identity,
		shape: z.literal("workflow_node_recovery"),
		holdEventUid: identity,
		decision: identity.nullable(),
		reason: identity.max(500),
		principal: z.literal("master"),
		clientRequestId: identity.max(240),
		target: workflowRecoveryTargetSchema,
	})
	.strict()
	.refine(
		(canonical) =>
			canonical.runId === canonical.target.runId &&
			canonical.target.sourceHoldEventUids.includes(canonical.holdEventUid),
	);

export type WorkflowRecoveryCanonical = z.infer<
	typeof workflowRecoveryCanonicalSchema
>;

const receiptBase = {
	operationId: identity,
	canonicalDigest: digest,
	target: workflowRecoveryTargetSchema,
};

// This is a dispatch commitment, not evidence that a Runner has started.
export const workflowRecoveryReceiptSchema = z
	.discriminatedUnion("state", [
		z
			.object({
				...receiptBase,
				state: z.literal("dispatch_recorded"),
				executionId: identity,
				launchOrdinal: positiveOrdinal,
				dispatchLedgerId: positiveOrdinal,
			})
			.strict(),
		z
			.object({
				...receiptBase,
				state: z.literal("state_applied"),
			})
			.strict(),
	])
	.superRefine((receipt, context) => {
		if (receipt.operationId !== `hold-resume:${receipt.canonicalDigest}`) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "receipt_operation_mismatch",
			});
		}
		if (receipt.state === "dispatch_recorded") {
			if (
				!["redispatch_current", "apply_recorded_decision"].includes(
					receipt.target.operationKind,
				) ||
				receipt.executionId === receipt.target.previousExecutionId ||
				(receipt.target.operationKind === "redispatch_current" &&
					receipt.launchOrdinal <= receipt.target.previousLaunchOrdinal)
			) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "receipt_dispatch_mismatch",
				});
			}
		} else if (receipt.target.operationKind === "redispatch_current") {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "receipt_dispatch_missing",
			});
		}
	});

export type WorkflowRecoveryReceipt = z.infer<
	typeof workflowRecoveryReceiptSchema
>;

/** Server-only observation. Never deserialize this from an HTTP request. */
export interface WorkflowRecoveryPreflight {
	target: WorkflowRecoveryTarget;
	stateDigest: string;
	sourceSessionDigest: string;
	sourceEvidenceDigest: string;
	observedAt: string;
	liveness: "dead" | "not_required";
}

export function workflowRecoveryEvidenceDigest(
	proof: Pick<
		WorkflowRecoveryPreflight,
		"stateDigest" | "sourceSessionDigest" | "sourceEvidenceDigest"
	>,
): string {
	return canonicalSubmissionDigest({
		stateDigest: proof.stateDigest,
		sourceSessionDigest: proof.sourceSessionDigest,
		sourceEvidenceDigest: proof.sourceEvidenceDigest,
	});
}

/** Legacy diagnostic names only locate the unified recovery operation. */
export function isWorkflowNodeRecoveryFaultShape(shape: string): boolean {
	return [
		"workflow_node_recovery",
		"legacy_active_orphan",
		"rework_activation_stalled_held",
		"rework_pane_loss_handoff",
		"rework_retry_exhausted",
		"unlaunched_admission_rolled_back",
		"unlaunched_admission_held",
		"completion_receipt_missing",
		"retry_limit_escalated",
		"environment_failure_escalated",
		"land_held_with_operation",
		"land_held_without_operation",
	].includes(shape);
}

export function isWorkflowStateRecoveryShape(shape: string): boolean {
	return [
		"run_held_by_operator",
		"workflow_gate_origin_preflight_terminal",
		"loop_limit_escalated",
		"rework_suppressed_idle_spin",
	].includes(shape);
}

/** Informational close result; stage/apply still resolves its own trusted target. */
export interface WorkflowCarrierCloseOutcome {
	executionClosed: true;
	runTerminated: false;
	runStatus: string;
	completionAccepted: boolean;
	recoveryTarget: {
		operationKind: "redispatch_current";
		runId: string;
		nodeId: string;
		attempt: number;
		previousExecutionId: string;
		previousLaunchOrdinal: number;
	} | null;
}

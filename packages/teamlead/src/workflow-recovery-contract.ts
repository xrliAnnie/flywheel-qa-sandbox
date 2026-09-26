import { canonicalSubmissionDigest } from "flywheel-config";
import { z } from "zod";

const identity = z.string().trim().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const head = z.string().regex(/^[a-f0-9]{40}$/);
const ordinal = z.number().int().safe().nonnegative();
const positiveOrdinal = ordinal.min(1);

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

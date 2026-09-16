import { z } from "zod";

const ids = z
	.array(z.string().uuid())
	.max(500)
	.refine(
		(values) => new Set(values).size === values.length,
		"duplicate child IDs",
	);
export const epicIntakeResultSchema = z
	.object({
		outcome: z.enum(["complete", "needs_founder", "superseded"]),
		childIssueIds: ids,
		firstBatchIssueIds: ids,
		ledgerObservedAt: z.string().datetime(),
		threadId: z
			.string()
			.regex(/^\d{17,20}$/)
			.optional(),
		messageId: z
			.string()
			.regex(/^\d{17,20}$/)
			.optional(),
		founderQuestion: z.string().trim().min(1).max(4000).nullable(),
	})
	.strict()
	.refine(
		(value) =>
			value.firstBatchIssueIds.every((id) => value.childIssueIds.includes(id)),
		"first batch must be a child subset",
	)
	.refine(
		(value) =>
			value.outcome !== "needs_founder" ||
			(value.founderQuestion !== null && !!value.threadId && !!value.messageId),
		"founder question and message required",
	)
	.refine(
		(value) => !value.messageId || !!value.threadId,
		"message requires thread",
	);
export type EpicIntakeResult = z.infer<typeof epicIntakeResultSchema>;

/** Server observations only: never populate these fields from request JSON. */
export interface EpicIntakeEvidenceObservation {
	active: boolean;
	directChildIds: string[];
	canonicalThreadId: string | null;
	message: { id: string; channelId: string; authorId: string } | null;
	leadBotUserId: string | null;
	now: string;
	patrolIntervalMs: number;
}

export function validateEpicIntakeEvidence(
	evidence: EpicIntakeResult,
	observation: EpicIntakeEvidenceObservation,
): void {
	const value = epicIntakeResultSchema.parse(evidence);
	const age = Date.parse(observation.now) - Date.parse(value.ledgerObservedAt);
	if (
		!Number.isFinite(age) ||
		age < 0 ||
		!Number.isFinite(observation.patrolIntervalMs) ||
		observation.patrolIntervalMs <= 0 ||
		age > observation.patrolIntervalMs
	)
		throw new Error("intake_ledger_time_invalid");
	if (observation.active === (value.outcome === "superseded"))
		throw new Error("intake_episode_changed");
	if (
		value.outcome !== "superseded" &&
		value.childIssueIds.some((id) => !observation.directChildIds.includes(id))
	)
		throw new Error("intake_child_mismatch");
	if (!value.messageId) {
		if (value.threadId && value.threadId !== observation.canonicalThreadId)
			throw new Error("intake_thread_evidence_invalid");
		return;
	}
	if (
		!observation.message ||
		!observation.leadBotUserId ||
		value.threadId !== observation.canonicalThreadId ||
		observation.message.id !== value.messageId ||
		observation.message.channelId !== value.threadId ||
		observation.message.authorId !== observation.leadBotUserId
	)
		throw new Error("intake_thread_evidence_invalid");
}

/** Stored receipts are server metadata, excluded only for request replay comparison. */
export function sameEpicIntakeEvidence(
	stored: unknown,
	evidence: EpicIntakeResult,
): boolean {
	if (!stored || typeof stored !== "object" || Array.isArray(stored))
		return false;
	const { receipt: _receipt, ...request } = stored as Record<string, unknown>;
	const parsed = epicIntakeResultSchema.safeParse(request);
	return (
		parsed.success &&
		JSON.stringify(parsed.data) ===
			JSON.stringify(epicIntakeResultSchema.parse(evidence))
	);
}

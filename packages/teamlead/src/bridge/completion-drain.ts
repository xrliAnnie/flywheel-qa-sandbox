export type CompletionDrainEnvelope =
	| {
			ok: true;
			completionSubmission: Record<string, unknown>;
			receiptChallengeId?: string;
	  }
	| { ok: false; reason: "drain_receipt_rejected" };

/** Strip the receipt from the authority-bearing business payload. */
export function parseCompletionDrainEnvelope(
	payload: Record<string, unknown> | undefined,
): CompletionDrainEnvelope {
	const source = payload ?? {};
	const { drainReceipt, ...completionSubmission } = source;
	if (drainReceipt === undefined) {
		return { ok: true, completionSubmission };
	}
	if (
		typeof drainReceipt !== "object" ||
		drainReceipt === null ||
		Array.isArray(drainReceipt) ||
		typeof (drainReceipt as Record<string, unknown>).challengeId !== "string" ||
		!/^[A-Za-z0-9:._-]{1,512}$/.test(
			(drainReceipt as Record<string, unknown>).challengeId as string,
		)
	) {
		return { ok: false, reason: "drain_receipt_rejected" };
	}
	return {
		ok: true,
		completionSubmission,
		receiptChallengeId: (drainReceipt as { challengeId: string }).challengeId,
	};
}

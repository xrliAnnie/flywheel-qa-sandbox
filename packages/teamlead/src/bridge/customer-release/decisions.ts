import type {
	CustomerClaimActivation,
	CustomerReadyAttempt,
	CustomerReleaseCycle,
} from "./types.js";

const bindingFields = [
	"releaseId",
	"betaVersion",
	"betaPayloadSha256",
	"releaseVersion",
	"releasePayloadSha256",
	"sourceCommit",
] as const;
const attemptFields = [
	"attemptId",
	"cycleId",
	"projectId",
	"audience",
	"activationEpoch",
	"nonce",
	"baseEtag",
	"readyAt",
	"fullBinding",
	"readbackSha256",
] as const;
export function equalBinding(
	left: CustomerReadyAttempt["fullBinding"],
	right: CustomerReadyAttempt["fullBinding"],
): boolean {
	return (
		!!left &&
		!!right &&
		Object.keys(left).length === bindingFields.length &&
		Object.keys(right).length === bindingFields.length &&
		bindingFields.every((key) => left[key] === right[key])
	);
}
export function attemptBytes(attempt: CustomerReadyAttempt): string {
	if (
		!attempt ||
		typeof attempt !== "object" ||
		Object.keys(attempt).length !== attemptFields.length ||
		attemptFields.some((key) => !(key in attempt)) ||
		!attempt.fullBinding ||
		Object.keys(attempt.fullBinding).length !== bindingFields.length ||
		bindingFields.some((key) => !(key in attempt.fullBinding))
	)
		throw new Error("customer release attempt invalid");
	return JSON.stringify(
		Object.fromEntries(
			attemptFields.map((key) => [
				key,
				key === "fullBinding"
					? Object.fromEntries(
							bindingFields.map((field) => [field, attempt.fullBinding[field]]),
						)
					: attempt[key],
			]),
		),
	);
}
export function claimRejection(
	cycle: CustomerReleaseCycle,
	attempt: CustomerReadyAttempt,
	activation: CustomerClaimActivation,
	now: number,
): string | null {
	if (
		!activation ||
		activation.mode !== "canary" ||
		activation.enabled !== true ||
		activation.enableReceiptValid !== true ||
		activation.sourcesHealthy !== true ||
		activation.activationEpoch !== cycle.activationEpoch ||
		activation.policyRevision !== cycle.policyRevision
	)
		return "activation_invalid";
	if (
		!cycle.binding ||
		!equalBinding(attempt.fullBinding, cycle.binding) ||
		attempt.readbackSha256 !== cycle.binding.releasePayloadSha256 ||
		attempt.cycleId !== cycle.cycleId ||
		attempt.projectId !== cycle.projectId ||
		attempt.activationEpoch !== cycle.activationEpoch ||
		attempt.audience !== activation.audience
	)
		return "attempt_binding_invalid";
	const evidenceError = attemptEvidenceRejection(attempt, now);
	if (evidenceError) return evidenceError;
	if (
		cycle.deadlineAt === null ||
		now < cycle.deadlineAt ||
		cycle.claimNotAfter === null ||
		now >= cycle.claimNotAfter ||
		cycle.windowOpenedAt === null
	)
		return "claim_window_invalid";
	return null;
}

export function attemptEvidenceRejection(
	attempt: CustomerReadyAttempt,
	now: number,
): string | null {
	if (
		![attempt.attemptId, attempt.audience].every(
			(value) =>
				typeof value === "string" &&
				/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value),
		) ||
		typeof attempt.nonce !== "string" ||
		!/^[a-f0-9]{64}$/.test(attempt.nonce) ||
		typeof attempt.baseEtag !== "string" ||
		!/^[\x21-\x7e]{1,128}$/.test(attempt.baseEtag) ||
		!Number.isSafeInteger(attempt.readyAt) ||
		Math.abs(now - attempt.readyAt) > 5000
	)
		return "attempt_evidence_invalid";
	return null;
}

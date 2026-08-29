/**
 * FLY-799 Part A-1 — canonical founder id derivation.
 *
 * Resolves the ONE trusted founder Discord id for the authoritative ship-approval
 * write path from the two config sources that carry it today
 * (`discordOwnerUserId` and `founderConsent.founderUserId`). Fail-closed
 * (Codex R1 #4): returns null when neither is set, or when both are set but
 * disagree — a split/misconfigured identity must never let a message read as the
 * founder. The caller treats null as "no canonical founder id" → WAKE-only, no
 * approval written.
 */

function clean(value: string | undefined): string | undefined {
	const t = value?.trim();
	return t ? t : undefined;
}

/**
 * @returns the canonical founder Discord user id, or null when it cannot be
 *   resolved fail-closed (both missing, or both present and unequal).
 */
export function deriveCanonicalFounderId(
	discordOwnerUserId: string | undefined,
	founderConsentUserId: string | undefined,
): string | null {
	const owner = clean(discordOwnerUserId);
	const consent = clean(founderConsentUserId);

	if (owner && consent) {
		return owner === consent ? owner : null; // misconfig guard
	}
	return owner ?? consent ?? null;
}

/**
 * FLY-2896 §5.8 — the display-only reset-card model for the account quota page.
 *
 * The page route reads the proposal and consent files best-effort and hands
 * the result here. Nothing in this module feeds grouping, ordering or the
 * switch decision: it is the same treatment as `nextCharge`. Any read error or
 * invalid file yields null, and the page then renders exactly as before.
 */

import type {
	ResetCardConsent,
	ResetCardFiles,
	ResetCardProposal,
} from "../account-heal/reset-card-files.js";

/** Plan §4: `resetCardAskPct` default when the config does not set it. */
export const DEFAULT_RESET_CARD_ASK_PCT = 85;

export type ResetCardDecisionState =
	| { kind: "not_posted" }
	| { kind: "posted"; postedAt: string | null }
	| { kind: "approved" }
	| { kind: "in_progress" }
	| { kind: "rejected" }
	| { kind: "expired" }
	| { kind: "post_failed"; reason: string | null }
	| { kind: "cancelled" }
	| { kind: "failed" }
	| { kind: "ambiguous" };

/** Chip beside the target row: only while the founder's answer still matters. */
export type ResetCardChip = "awaiting" | "approved";

export interface ResetCardDecision {
	proposalId: string;
	/** The active account the proposal was written for (== the live active). */
	active: string;
	/** Live max(5h, 7d) percentage of the active account as the page saw it. */
	activePct: number;
	target: string;
	state: ResetCardDecisionState;
	chip: ResetCardChip | null;
}

export interface ResetCardDecisionContext {
	askPct: number;
	activeAccount: string | null;
	activeGeneration: number | null;
	/** max(5h, 7d) of the live active account; null when neither is read. */
	activeMaxPct: number | null;
}

export interface LoadResetCardDecisionInput extends ResetCardDecisionContext {
	files: Pick<ResetCardFiles, "readProposal" | "readConsent">;
}

const IN_PROGRESS_STATUSES: ReadonlySet<ResetCardProposal["status"]> = new Set([
	"executing",
	"redeem_unconfirmed",
	"grant_already_used",
	"redeem_confirmed",
	"recovered_without_proven_redeem",
	"switching",
	"switch_committed",
	"settled",
]);

/**
 * max(5h, 7d) of the single active account. Accepts the capacity snapshot's
 * Claude account entries as they are, so the route needs no reshaping.
 */
export function activeClaudeMaxPct(
	accounts: ReadonlyArray<{
		active: boolean;
		fiveHPct: number | null;
		sevenDPct: number | null;
	}>,
): number | null {
	const active = accounts.find((account) => account.active);
	if (active === undefined) return null;
	const observed = [active.fiveHPct, active.sevenDPct].filter(
		(value): value is number =>
			typeof value === "number" && Number.isFinite(value),
	);
	return observed.length === 0 ? null : Math.max(...observed);
}

/** A consent only speaks for the proposal it was written against. */
function consentFor(
	proposal: ResetCardProposal,
	consent: ResetCardConsent | null,
): ResetCardConsent | null {
	if (consent === null) return null;
	return consent.proposalId === proposal.proposalId &&
		consent.digest === proposal.digest
		? consent
		: null;
}

function awaitingConsentState(
	consent: ResetCardConsent | null,
): ResetCardDecisionState {
	switch (consent?.state) {
		case "posted":
			return { kind: "posted", postedAt: consent.postedAt };
		case "approved":
			return { kind: "approved" };
		case "rejected":
			return { kind: "rejected" };
		case "expired":
			return { kind: "expired" };
		case "post_failed":
			return { kind: "post_failed", reason: consent.reason };
		default:
			// absent, pending_post, or a superseded record: no live card yet.
			return { kind: "not_posted" };
	}
}

function stateOf(
	proposal: ResetCardProposal,
	consent: ResetCardConsent | null,
): ResetCardDecisionState | null {
	if (IN_PROGRESS_STATUSES.has(proposal.status)) return { kind: "in_progress" };
	switch (proposal.status) {
		case "switched":
			return null;
		case "awaiting_consent":
			return awaitingConsentState(consent);
		case "rejected":
			return { kind: "rejected" };
		case "expired":
			return { kind: "expired" };
		case "post_failed":
			return {
				kind: "post_failed",
				reason: proposal.statusReason ?? consent?.reason ?? null,
			};
		case "cancelled":
			return { kind: "cancelled" };
		case "failed":
		case "redeemed_switch_failed":
		case "switched_unverified":
			return { kind: "failed" };
		case "redeem_ambiguous":
			return { kind: "ambiguous" };
		default:
			return null;
	}
}

function chipOf(state: ResetCardDecisionState): ResetCardChip | null {
	switch (state.kind) {
		case "not_posted":
		case "posted":
			return "awaiting";
		case "approved":
			return "approved";
		default:
			return null;
	}
}

/**
 * Pure: proposal + consent + the live active reading → what the page shows.
 * Null means "no banner": the proposal is for another episode, the active
 * account has dropped back under askPct, or the card already switched.
 */
export function buildResetCardDecision(
	proposal: ResetCardProposal,
	consent: ResetCardConsent | null,
	context: ResetCardDecisionContext,
): ResetCardDecision | null {
	const { askPct, activeAccount, activeGeneration, activeMaxPct } = context;
	if (!Number.isFinite(askPct)) return null;
	if (activeAccount === null || proposal.active.name !== activeAccount) {
		return null;
	}
	if (
		activeGeneration === null ||
		proposal.active.generation !== activeGeneration
	) {
		return null;
	}
	if (
		activeMaxPct === null ||
		!Number.isFinite(activeMaxPct) ||
		activeMaxPct < askPct
	) {
		return null;
	}
	const state = stateOf(proposal, consentFor(proposal, consent));
	if (state === null) return null;
	return {
		proposalId: proposal.proposalId,
		active: proposal.active.name,
		activePct: activeMaxPct,
		target: proposal.target.name,
		state,
		chip: chipOf(state),
	};
}

/**
 * Best-effort read of both files. Never throws: a missing proposal, an
 * invalid file, or a throwing reader all yield null (fail closed, §5.7).
 */
export function loadResetCardDecision(
	input: LoadResetCardDecisionInput,
): ResetCardDecision | null {
	try {
		const proposal = input.files.readProposal();
		if (proposal.status !== "ok") return null;
		const consent = input.files.readConsent();
		if (consent.status === "invalid") return null;
		return buildResetCardDecision(
			proposal.value,
			consent.status === "ok" ? consent.value : null,
			input,
		);
	} catch {
		return null;
	}
}

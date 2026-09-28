import {
	computeProposalDigest,
	type ResetCardConsent,
	type ResetCardProposal,
} from "../account-heal/reset-card-files.js";

export const PROPOSAL_ID = "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607";
export const OTHER_PROPOSAL_ID = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d";
export const REQUEST_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
export const GRANT_ID = "opus55-launch-promax-20260921";
export const EPISODE_KEY = "a".repeat(64);
export const FOUNDER_ID = "111111111111111111";
export const CHANNEL_ID = "222222222222222222";
export const MESSAGE_ID = "333333333333333333";

export function sampleProposal(
	patch: Partial<ResetCardProposal> = {},
): ResetCardProposal {
	const base: Omit<ResetCardProposal, "digest"> = {
		schemaVersion: 1,
		proposalId: PROPOSAL_ID,
		episodeKey: EPISODE_KEY,
		createdAt: "2026-09-25T23:05:00.000Z",
		expiresAt: "2026-09-26T01:05:00.000Z",
		status: "awaiting_consent",
		statusReason: null,
		statusAt: "2026-09-25T23:05:00.000Z",
		active: {
			name: "personal",
			generation: 7,
			drivingWindow: "5h",
			switchAtPct: 90,
			fiveHPct: 88,
			sevenDPct: 41,
			fiveHResetAt: "2026-09-26T02:00:00.000Z",
			sevenDResetAt: "2026-09-29T02:00:00.000Z",
		},
		target: {
			name: "business",
			recoveryAt: "2026-10-01T02:00:00.000Z",
			exhausted: ["seven_day"],
			fiveHPct: 12,
			sevenDPct: 100,
			fiveHResetAt: "2026-09-26T02:00:00.000Z",
			sevenDResetAt: "2026-10-01T02:00:00.000Z",
		},
		grant: {
			id: GRANT_ID,
			endsAt: "2026-10-22T16:00:00.000Z",
			clears: ["five_hour", "seven_day", "seven_day_overage_included"],
			resetsLeftBefore: 1,
			cardsLeftTotal: 1,
		},
		runway: { fiveHourMinutes: 270 },
		redeem: null,
		switchIntent: null,
		blockedEpisodeAtSwitch: null,
	};
	const merged = { ...base, ...patch };
	return {
		...merged,
		digest: patch.digest ?? computeProposalDigest(merged),
	} as ResetCardProposal;
}

export function sampleConsent(
	proposal: ResetCardProposal = sampleProposal(),
	patch: Partial<ResetCardConsent> = {},
): ResetCardConsent {
	return {
		schemaVersion: 1,
		proposalId: proposal.proposalId,
		digest: proposal.digest,
		state: "approved",
		reason: null,
		channelId: CHANNEL_ID,
		messageId: MESSAGE_ID,
		postedAt: "2026-09-25T23:05:10.000Z",
		decidedAt: "2026-09-25T23:10:00.000Z",
		founderId: FOUNDER_ID,
		outcomeRenderedFor: null,
		...patch,
	};
}

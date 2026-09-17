export const CODEX_QUOTA_PROFILES = ["business", "personal", "school"] as const;

export type CodexQuotaProfile = (typeof CODEX_QUOTA_PROFILES)[number];
export type QuotaState = "available" | "exhausted" | "unknown";

export interface CodexResetCreditState {
	id: string | null;
	expiresAt: number | null;
	available: boolean | null;
}

export interface CodexResetAccountState {
	profile: CodexQuotaProfile;
	auth: "valid" | "invalid" | "unknown";
	weeklyQuota: QuotaState;
	shortWindowQuota: QuotaState | "not_applicable";
	weeklyResetAt: number | null;
	resetCredits: {
		availableCount: bigint | null;
		credits: readonly CodexResetCreditState[] | null;
	} | null;
}

export type CodexResetSelectionExclusionCode =
	| "explicitly_excluded"
	| "auth_invalid"
	| "reset_time_unknown"
	| "card_count_unknown"
	| "credit_details_unknown"
	| "no_available_credit";

export interface CodexResetSelectionExclusion {
	profile: CodexQuotaProfile;
	reasonCodes: readonly CodexResetSelectionExclusionCode[];
}

export type CodexResetSelectionReasonCode =
	| "credit_expires_before_reset"
	| "latest_reset"
	| "most_credits"
	| "profile_order"
	| "sole_candidate";

export type CodexResetNoRecommendationCode =
	| "invalid_input"
	| "quota_available"
	| "quota_state_unknown"
	| "auth_state_unknown"
	| "all_candidates_excluded"
	| "no_usable_account"
	| "reset_time_unknown"
	| "card_count_unknown"
	| "credit_details_unknown"
	| "no_available_credit";

export type CodexResetCreditSelection =
	| {
			kind: "selected";
			profile: CodexQuotaProfile;
			creditId: string;
			weeklyResetAt: number;
			creditExpiresAt: number;
			availableCount: number;
			reasonCode: CodexResetSelectionReasonCode;
			reason: string;
			exclusions: readonly CodexResetSelectionExclusion[];
	  }
	| {
			kind: "no_recommendation";
			reasonCode: CodexResetNoRecommendationCode;
			reason: string;
			exclusions: readonly CodexResetSelectionExclusion[];
	  };

interface Candidate {
	profile: CodexQuotaProfile;
	weeklyResetAt: number;
	availableCount: bigint;
	credit: { id: string; expiresAt: number };
	creditExpiresBeforeReset: boolean;
}

const exclusionOrder: readonly CodexResetSelectionExclusionCode[] = [
	"explicitly_excluded",
	"auth_invalid",
	"reset_time_unknown",
	"card_count_unknown",
	"credit_details_unknown",
	"no_available_credit",
];

const noRecommendationReasons: Record<CodexResetNoRecommendationCode, string> =
	{
		invalid_input: "输入不是完整且有效的三号快照，无法安全推荐。",
		quota_available: "至少一个有效账号仍有周额度，不应兑卡。",
		quota_state_unknown: "至少一个有效账号的周额度状态未知，无法确认全线停摆。",
		auth_state_unknown: "至少一个账号的登录状态未知，无法确认全线停摆。",
		all_candidates_excluded: "三个账号都已被本次重算明确排除，无法继续推荐。",
		no_usable_account: "三个账号的登录都已失效，没有可兑卡的账号。",
		reset_time_unknown: "候选号的周重置时刻读不到，无法安全推荐。",
		card_count_unknown: "候选号的重置卡张数读不到，无法安全推荐。",
		credit_details_unknown:
			"候选号的重置卡明细不完整，无法显式选择最早过期的卡。",
		no_available_credit: "候选号都没有可用重置卡，无法推荐。",
	};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isProfile = (value: unknown): value is CodexQuotaProfile =>
	typeof value === "string" &&
	(CODEX_QUOTA_PROFILES as readonly string[]).includes(value);

const validEpoch = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function profileRank(profile: CodexQuotaProfile): number {
	return CODEX_QUOTA_PROFILES.indexOf(profile);
}

function noRecommendation(
	reasonCode: CodexResetNoRecommendationCode,
	exclusions: readonly CodexResetSelectionExclusion[] = [],
): CodexResetCreditSelection {
	return {
		kind: "no_recommendation",
		reasonCode,
		reason: noRecommendationReasons[reasonCode],
		exclusions,
	};
}

function validAccountShape(value: unknown): value is CodexResetAccountState {
	if (!isRecord(value) || !isProfile(value.profile)) return false;
	if (!["valid", "invalid", "unknown"].includes(String(value.auth)))
		return false;
	if (
		!["available", "exhausted", "unknown"].includes(String(value.weeklyQuota))
	)
		return false;
	if (
		!["available", "exhausted", "unknown", "not_applicable"].includes(
			String(value.shortWindowQuota),
		)
	)
		return false;
	if (value.weeklyResetAt !== null && !validEpoch(value.weeklyResetAt))
		return false;
	if (value.resetCredits === null) return true;
	if (!isRecord(value.resetCredits)) return false;
	const count = value.resetCredits.availableCount;
	if (
		count !== null &&
		(typeof count !== "bigint" ||
			count < 0n ||
			count > BigInt(Number.MAX_SAFE_INTEGER))
	)
		return false;
	const credits = value.resetCredits.credits;
	if (credits !== null && !Array.isArray(credits)) return false;
	if (credits === null) return true;
	const ids = new Set<string>();
	for (const credit of credits) {
		if (!isRecord(credit)) return false;
		if (
			credit.id !== null &&
			(typeof credit.id !== "string" || credit.id.length === 0)
		)
			return false;
		if (credit.expiresAt !== null && !validEpoch(credit.expiresAt))
			return false;
		if (credit.available !== null && typeof credit.available !== "boolean")
			return false;
		if (typeof credit.id === "string") {
			if (ids.has(credit.id)) return false;
			ids.add(credit.id);
		}
	}
	return true;
}

function selectedReason(
	candidate: Candidate,
	reasonCode: CodexResetSelectionReasonCode,
): string {
	switch (reasonCode) {
		case "credit_expires_before_reset":
			return `${candidate.profile} 的 ${candidate.credit.id} 会在该号周重置前最早过期。`;
		case "latest_reset":
			return `${candidate.profile} 的周重置时刻最晚，烧它最不浪费。`;
		case "most_credits":
			return `${candidate.profile} 与其它候选同刻重置且剩卡最多。`;
		case "profile_order":
			return `候选在前序阶梯全部平手，按固定账号序选择 ${candidate.profile}。`;
		case "sole_candidate":
			return `${candidate.profile} 是唯一可安全显式兑卡的候选号。`;
	}
}

function compareCandidates(a: Candidate, b: Candidate): number {
	if (a.creditExpiresBeforeReset !== b.creditExpiresBeforeReset)
		return a.creditExpiresBeforeReset ? -1 : 1;
	if (a.creditExpiresBeforeReset && a.credit.expiresAt !== b.credit.expiresAt)
		return a.credit.expiresAt - b.credit.expiresAt;
	if (a.weeklyResetAt !== b.weeklyResetAt)
		return b.weeklyResetAt - a.weeklyResetAt;
	if (a.availableCount !== b.availableCount)
		return a.availableCount > b.availableCount ? -1 : 1;
	return profileRank(a.profile) - profileRank(b.profile);
}

function selectionReasonCode(
	selected: Candidate,
	candidates: readonly Candidate[],
): CodexResetSelectionReasonCode {
	if (
		selected.creditExpiresBeforeReset &&
		candidates.some(
			(candidate) =>
				!candidate.creditExpiresBeforeReset ||
				candidate.credit.expiresAt > selected.credit.expiresAt,
		)
	)
		return "credit_expires_before_reset";
	if (candidates.length === 1)
		return selected.creditExpiresBeforeReset
			? "credit_expires_before_reset"
			: "sole_candidate";
	const expiryPeers = selected.creditExpiresBeforeReset
		? candidates.filter(
				(candidate) =>
					candidate.creditExpiresBeforeReset &&
					candidate.credit.expiresAt === selected.credit.expiresAt,
			)
		: candidates.filter((candidate) => !candidate.creditExpiresBeforeReset);
	if (
		expiryPeers.some(
			(candidate) => candidate.weeklyResetAt < selected.weeklyResetAt,
		)
	)
		return "latest_reset";
	const resetPeers = expiryPeers.filter(
		(candidate) => candidate.weeklyResetAt === selected.weeklyResetAt,
	);
	if (
		resetPeers.some(
			(candidate) => candidate.availableCount < selected.availableCount,
		)
	)
		return "most_credits";
	return "profile_order";
}

export function selectCodexResetCredit(
	accounts: readonly CodexResetAccountState[],
	options: { excludedProfiles?: readonly CodexQuotaProfile[] } = {},
): CodexResetCreditSelection {
	if (
		!Array.isArray(accounts) ||
		accounts.length !== CODEX_QUOTA_PROFILES.length
	)
		return noRecommendation("invalid_input");
	if (!accounts.every(validAccountShape))
		return noRecommendation("invalid_input");
	const byProfile = new Map(
		accounts.map((account) => [account.profile, account] as const),
	);
	if (
		byProfile.size !== CODEX_QUOTA_PROFILES.length ||
		CODEX_QUOTA_PROFILES.some((profile) => !byProfile.has(profile))
	)
		return noRecommendation("invalid_input");
	const excludedInput = options.excludedProfiles ?? [];
	if (!Array.isArray(excludedInput) || !excludedInput.every(isProfile))
		return noRecommendation("invalid_input");
	const excludedProfiles = new Set(excludedInput);
	const ordered = CODEX_QUOTA_PROFILES.map(
		(profile) => byProfile.get(profile)!,
	);

	if (
		ordered.some(
			(account) =>
				account.auth === "valid" && account.weeklyQuota === "available",
		)
	)
		return noRecommendation("quota_available");
	if (
		ordered.some(
			(account) =>
				account.auth === "valid" && account.weeklyQuota === "unknown",
		)
	)
		return noRecommendation("quota_state_unknown");
	if (ordered.some((account) => account.auth === "unknown"))
		return noRecommendation("auth_state_unknown");

	const reasons = new Map<
		CodexQuotaProfile,
		Set<CodexResetSelectionExclusionCode>
	>();
	const addReason = (
		profile: CodexQuotaProfile,
		reason: CodexResetSelectionExclusionCode,
	) => {
		const current = reasons.get(profile) ?? new Set();
		current.add(reason);
		reasons.set(profile, current);
	};
	const candidates: Candidate[] = [];
	let invalidInventory = false;

	for (const account of ordered) {
		if (excludedProfiles.has(account.profile))
			addReason(account.profile, "explicitly_excluded");
		if (account.auth === "invalid") addReason(account.profile, "auth_invalid");
		if (account.weeklyResetAt === null)
			addReason(account.profile, "reset_time_unknown");

		const inventory = account.resetCredits;
		let safeCredits: Array<{ id: string; expiresAt: number }> = [];
		let availableCount: bigint | null = null;
		if (inventory === null || inventory.availableCount === null) {
			addReason(account.profile, "card_count_unknown");
		} else {
			availableCount = inventory.availableCount;
			if (inventory.credits === null) {
				addReason(
					account.profile,
					availableCount === 0n
						? "no_available_credit"
						: "credit_details_unknown",
				);
			} else {
				const detailsUnknown = inventory.credits.some(
					(credit) =>
						credit.available === null ||
						(credit.available === true &&
							(typeof credit.id !== "string" || credit.expiresAt === null)),
				);
				safeCredits = inventory.credits
					.filter(
						(
							credit,
						): credit is { id: string; expiresAt: number; available: true } =>
							credit.available === true &&
							typeof credit.id === "string" &&
							credit.expiresAt !== null,
					)
					.map(({ id, expiresAt }) => ({ id, expiresAt }));
				if (BigInt(safeCredits.length) > availableCount) {
					invalidInventory = true;
				} else if (
					detailsUnknown ||
					BigInt(safeCredits.length) < availableCount
				) {
					addReason(account.profile, "credit_details_unknown");
				} else if (availableCount === 0n) {
					addReason(account.profile, "no_available_credit");
				}
			}
		}

		if (
			(reasons.get(account.profile)?.size ?? 0) > 0 ||
			account.weeklyResetAt === null ||
			availableCount === null ||
			safeCredits.length === 0
		)
			continue;
		const credit = [...safeCredits].sort(
			(a, b) =>
				a.expiresAt - b.expiresAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		)[0];
		if (!credit) {
			invalidInventory = true;
			continue;
		}
		candidates.push({
			profile: account.profile,
			weeklyResetAt: account.weeklyResetAt,
			availableCount,
			credit,
			creditExpiresBeforeReset: credit.expiresAt < account.weeklyResetAt,
		});
	}

	if (invalidInventory) return noRecommendation("invalid_input");
	const exclusions = CODEX_QUOTA_PROFILES.flatMap((profile) => {
		const profileReasons = reasons.get(profile);
		if (!profileReasons?.size) return [];
		return [
			{
				profile,
				reasonCodes: exclusionOrder.filter((reason) =>
					profileReasons.has(reason),
				),
			},
		];
	});
	if (excludedProfiles.size === CODEX_QUOTA_PROFILES.length)
		return noRecommendation("all_candidates_excluded", exclusions);
	if (ordered.every((account) => account.auth === "invalid"))
		return noRecommendation("no_usable_account", exclusions);
	if (!candidates.length) {
		const present = new Set(exclusions.flatMap((entry) => entry.reasonCodes));
		for (const reasonCode of [
			"reset_time_unknown",
			"card_count_unknown",
			"credit_details_unknown",
			"no_available_credit",
		] as const) {
			if (present.has(reasonCode))
				return noRecommendation(reasonCode, exclusions);
		}
		return noRecommendation("no_available_credit", exclusions);
	}

	const selected = [...candidates].sort(compareCandidates)[0];
	if (!selected) return noRecommendation("no_available_credit", exclusions);
	const reasonCode = selectionReasonCode(selected, candidates);
	return {
		kind: "selected",
		profile: selected.profile,
		creditId: selected.credit.id,
		weeklyResetAt: selected.weeklyResetAt,
		creditExpiresAt: selected.credit.expiresAt,
		availableCount: Number(selected.availableCount),
		reasonCode,
		reason: selectedReason(selected, reasonCode),
		exclusions,
	};
}

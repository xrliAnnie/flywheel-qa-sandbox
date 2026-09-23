import { describe, expect, it } from "vitest";
import {
	type CodexQuotaProfile,
	type CodexResetAccountState,
	selectCodexResetCredit,
} from "../reset-credit-selector.js";

const day = 86_400_000;
const base = Date.parse("2026-09-17T20:00:00.000Z");
const profileOrder: readonly CodexQuotaProfile[] = [
	"business",
	"personal",
	"school",
];

function account(
	profile: CodexQuotaProfile,
	overrides: Partial<CodexResetAccountState> = {},
): CodexResetAccountState {
	const index = profileOrder.indexOf(profile);
	const weeklyResetAt = base + (index + 1) * day;
	return {
		profile,
		auth: "valid",
		weeklyQuota: "exhausted",
		shortWindowQuota: "not_applicable",
		weeklyResetAt,
		resetCredits: {
			availableCount: 1n,
			credits: [
				{
					id: `${profile}-card-a`,
					expiresAt: weeklyResetAt + day,
					available: true,
				},
			],
		},
		...overrides,
	};
}

function fleet(
	overrides: Partial<
		Record<CodexQuotaProfile, Partial<CodexResetAccountState>>
	> = {},
): CodexResetAccountState[] {
	return profileOrder.map((profile) => account(profile, overrides[profile]));
}

function permutations<T>(values: readonly [T, T, T]): T[][] {
	const [a, b, c] = values;
	return [
		[a, b, c],
		[a, c, b],
		[b, a, c],
		[b, c, a],
		[c, a, b],
		[c, b, a],
	];
}

describe("selectCodexResetCredit", () => {
	it("never recommends a card while a valid account still has weekly quota", () => {
		const result = selectCodexResetCredit(
			fleet({
				personal: {
					weeklyQuota: "available",
					shortWindowQuota: "exhausted",
				},
			}),
		);

		expect(result).toMatchObject({
			kind: "no_recommendation",
			reasonCode: "quota_available",
		});
	});

	it.each([
		[{ weeklyQuota: "unknown" as const }, "quota_state_unknown"],
		[{ auth: "unknown" as const }, "auth_state_unknown"],
	])(
		"does not turn an unknown state into exhaustion",
		(override, reasonCode) => {
			const result = selectCodexResetCredit(fleet({ personal: override }));

			expect(result).toMatchObject({ kind: "no_recommendation", reasonCode });
		},
	);

	it("keeps login failure separate while selecting another account", () => {
		const result = selectCodexResetCredit(
			fleet({ business: { auth: "invalid" } }),
		);

		expect(result).toMatchObject({
			kind: "selected",
			profile: "school",
			exclusions: [{ profile: "business", reasonCodes: ["auth_invalid"] }],
		});
	});

	it.each([
		["card_count_unknown", { resetCredits: null }],
		[
			"card_count_unknown",
			{ resetCredits: { availableCount: null, credits: [] } },
		],
		[
			"no_available_credit",
			{ resetCredits: { availableCount: 0n, credits: [] } },
		],
		[
			"credit_details_unknown",
			{ resetCredits: { availableCount: 1n, credits: null } },
		],
		[
			"credit_details_unknown",
			{
				resetCredits: {
					availableCount: 2n,
					credits: [{ id: "visible", expiresAt: base + day, available: true }],
				},
			},
		],
		[
			"credit_details_unknown",
			{
				resetCredits: {
					availableCount: 1n,
					credits: [
						{ id: "unknown-status", expiresAt: base + day, available: null },
					],
				},
			},
		],
		[
			"credit_details_unknown",
			{
				resetCredits: {
					availableCount: 1n,
					credits: [{ id: "unknown-expiry", expiresAt: null, available: true }],
				},
			},
		],
	] as const)(
		"surfaces %s without hiding viable accounts",
		(reasonCode, override) => {
			const result = selectCodexResetCredit(fleet({ business: override }));

			expect(result).toMatchObject({
				kind: "selected",
				profile: "school",
				exclusions: [
					{
						profile: "business",
						reasonCodes: [reasonCode],
					},
				],
			});
		},
	);

	it("returns N9 when every weekly reset time is missing", () => {
		const result = selectCodexResetCredit(
			fleet({
				business: { weeklyResetAt: null },
				personal: { weeklyResetAt: null },
				school: { weeklyResetAt: null },
			}),
		);

		expect(result).toMatchObject({
			kind: "no_recommendation",
			reasonCode: "reset_time_unknown",
			exclusions: profileOrder.map((profile) => ({
				profile,
				reasonCodes: ["reset_time_unknown"],
			})),
		});
	});

	it.each([
		[
			"no_usable_account",
			fleet({
				business: { auth: "invalid" },
				personal: { auth: "invalid" },
				school: { auth: "invalid" },
			}),
		],
		[
			"card_count_unknown",
			fleet({
				business: { resetCredits: null },
				personal: { resetCredits: null },
				school: { resetCredits: null },
			}),
		],
		[
			"credit_details_unknown",
			fleet({
				business: {
					resetCredits: { availableCount: 1n, credits: null },
				},
				personal: {
					resetCredits: { availableCount: 1n, credits: null },
				},
				school: {
					resetCredits: { availableCount: 1n, credits: null },
				},
			}),
		],
		[
			"no_available_credit",
			fleet({
				business: {
					resetCredits: { availableCount: 0n, credits: [] },
				},
				personal: {
					resetCredits: { availableCount: 0n, credits: [] },
				},
				school: {
					resetCredits: { availableCount: 0n, credits: [] },
				},
			}),
		],
	] as const)(
		"uses the deterministic terminal reason %s",
		(reasonCode, input) => {
			expect(selectCodexResetCredit(input)).toMatchObject({
				kind: "no_recommendation",
				reasonCode,
			});
		},
	);

	it("prioritizes a card that expires before its account refills", () => {
		const result = selectCodexResetCredit(
			fleet({
				business: {
					weeklyResetAt: base + 10 * day,
					resetCredits: {
						availableCount: 1n,
						credits: [{ id: "urgent", expiresAt: base + day, available: true }],
					},
				},
				school: { weeklyResetAt: base + 20 * day },
			}),
		);

		expect(result).toMatchObject({
			kind: "selected",
			profile: "business",
			creditId: "urgent",
			reasonCode: "credit_expires_before_reset",
		});
	});

	it("chooses the earliest expiry across accounts that would lose a card", () => {
		const result = selectCodexResetCredit(
			fleet({
				business: {
					weeklyResetAt: base + 10 * day,
					resetCredits: {
						availableCount: 1n,
						credits: [
							{ id: "later", expiresAt: base + 2 * day, available: true },
						],
					},
				},
				personal: {
					weeklyResetAt: base + 8 * day,
					resetCredits: {
						availableCount: 1n,
						credits: [
							{ id: "earlier", expiresAt: base + day, available: true },
						],
					},
				},
			}),
		);

		expect(result).toMatchObject({
			kind: "selected",
			profile: "personal",
			creditId: "earlier",
			reasonCode: "credit_expires_before_reset",
		});
	});

	it("continues through reset, count, and profile ties after equal urgent expiry", () => {
		const expiresAt = base + day;
		const withUrgentCard = (
			profile: CodexQuotaProfile,
			weeklyResetAt: number,
			availableCount: bigint,
		): Partial<CodexResetAccountState> => ({
			weeklyResetAt,
			resetCredits: {
				availableCount,
				credits: Array.from({ length: Number(availableCount) }, (_, index) => ({
					id: `${profile}-${index}`,
					expiresAt,
					available: true,
				})),
			},
		});

		let result = selectCodexResetCredit(
			fleet({
				business: withUrgentCard("business", base + 8 * day, 1n),
				personal: withUrgentCard("personal", base + 10 * day, 1n),
				school: withUrgentCard("school", base + 9 * day, 1n),
			}),
		);
		expect(result).toMatchObject({
			kind: "selected",
			profile: "personal",
			reasonCode: "latest_reset",
		});

		result = selectCodexResetCredit(
			fleet({
				business: withUrgentCard("business", base + 10 * day, 2n),
				personal: withUrgentCard("personal", base + 10 * day, 1n),
				school: withUrgentCard("school", base + 10 * day, 1n),
			}),
		);
		expect(result).toMatchObject({
			kind: "selected",
			profile: "business",
			reasonCode: "most_credits",
		});

		result = selectCodexResetCredit(
			fleet({
				business: withUrgentCard("business", base + 10 * day, 1n),
				personal: withUrgentCard("personal", base + 10 * day, 1n),
				school: withUrgentCard("school", base + 10 * day, 1n),
			}),
		);
		expect(result).toMatchObject({
			kind: "selected",
			profile: "business",
			reasonCode: "profile_order",
		});
	});

	it("uses latest reset, then availableCount, then fixed profile order", () => {
		let result = selectCodexResetCredit(fleet());
		expect(result).toMatchObject({
			kind: "selected",
			profile: "school",
			reasonCode: "latest_reset",
		});

		const sameReset = base + day;
		result = selectCodexResetCredit(
			fleet({
				business: {
					weeklyResetAt: sameReset,
					resetCredits: {
						availableCount: 2n,
						credits: [
							{ id: "b-1", expiresAt: sameReset + day, available: true },
							{ id: "b-2", expiresAt: sameReset + 2 * day, available: true },
						],
					},
				},
				personal: { weeklyResetAt: sameReset },
				school: { weeklyResetAt: sameReset },
			}),
		);
		expect(result).toMatchObject({
			kind: "selected",
			profile: "business",
			reasonCode: "most_credits",
		});

		result = selectCodexResetCredit(
			fleet({
				business: { weeklyResetAt: sameReset },
				personal: { weeklyResetAt: sameReset },
				school: { weeklyResetAt: sameReset },
			}),
		);
		expect(result).toMatchObject({
			kind: "selected",
			profile: "business",
			reasonCode: "profile_order",
		});
	});

	it("chooses the earliest card expiry and then creditId within the selected account", () => {
		const resetAt = base + 10 * day;
		const result = selectCodexResetCredit(
			fleet({
				school: {
					weeklyResetAt: resetAt,
					resetCredits: {
						availableCount: 3n,
						credits: [
							{ id: "z", expiresAt: resetAt + 3 * day, available: true },
							{ id: "b", expiresAt: resetAt + 2 * day, available: true },
							{ id: "a", expiresAt: resetAt + 2 * day, available: true },
						],
					},
				},
			}),
		);

		expect(result).toMatchObject({
			kind: "selected",
			profile: "school",
			creditId: "a",
			creditExpiresAt: resetAt + 2 * day,
		});
	});

	it("uses sole_candidate only when no higher selection tier applies", () => {
		const result = selectCodexResetCredit(
			fleet({
				business: {
					resetCredits: { availableCount: 0n, credits: [] },
				},
				personal: {
					resetCredits: { availableCount: 0n, credits: [] },
				},
			}),
		);

		expect(result).toMatchObject({
			kind: "selected",
			profile: "school",
			reasonCode: "sole_candidate",
		});
	});

	it("recomputes after noCredit and terminates when all profiles are excluded", () => {
		let result = selectCodexResetCredit(fleet(), {
			excludedProfiles: ["school"],
		});
		expect(result).toMatchObject({
			kind: "selected",
			profile: "personal",
			exclusions: expect.arrayContaining([
				{ profile: "school", reasonCodes: ["explicitly_excluded"] },
			]),
		});

		result = selectCodexResetCredit(fleet(), {
			excludedProfiles: ["school", "business", "personal"],
		});
		expect(result).toMatchObject({
			kind: "no_recommendation",
			reasonCode: "all_candidates_excluded",
		});
	});

	it("uses a stable top-level reason when multiple exclusion causes coexist", () => {
		const input = fleet({
			business: { auth: "invalid", weeklyResetAt: null },
			personal: { weeklyResetAt: null },
			school: { resetCredits: { availableCount: null, credits: null } },
		});
		const expected = selectCodexResetCredit(input);

		expect(expected).toMatchObject({
			kind: "no_recommendation",
			reasonCode: "reset_time_unknown",
			exclusions: expect.arrayContaining([
				{
					profile: "business",
					reasonCodes: ["auth_invalid", "reset_time_unknown"],
				},
			]),
		});
		for (const replay of permutations(
			input as [
				CodexResetAccountState,
				CodexResetAccountState,
				CodexResetAccountState,
			],
		)) {
			expect(selectCodexResetCredit(replay)).toEqual(expected);
		}
	});

	it("is invariant to account and card order and never mutates its input", () => {
		const input = fleet({
			school: {
				resetCredits: {
					availableCount: 2n,
					credits: [
						{ id: "late", expiresAt: base + 5 * day, available: true },
						{ id: "early", expiresAt: base + 4 * day, available: true },
					],
				},
			},
		});
		const snapshot = structuredClone(input);
		const expected = selectCodexResetCredit(input);

		for (const replay of permutations(
			input as [
				CodexResetAccountState,
				CodexResetAccountState,
				CodexResetAccountState,
			],
		)) {
			const reversedCards = replay.map((entry) => ({
				...entry,
				resetCredits:
					entry.resetCredits === null
						? null
						: {
								...entry.resetCredits,
								credits: entry.resetCredits.credits?.toReversed() ?? null,
							},
			}));
			expect(selectCodexResetCredit(reversedCards)).toEqual(expected);
		}
		expect(input).toEqual(snapshot);
		expect(expected.reason).toMatch(/。$/);
		expect(() => JSON.stringify(expected)).not.toThrow();
	});

	it.each([
		["empty account pool", []],
		[
			"duplicate profile",
			[account("business"), account("business"), account("school")],
		],
		[
			"negative count",
			fleet({
				business: { resetCredits: { availableCount: -1n, credits: [] } },
			}),
		],
		[
			"duplicate credit id",
			fleet({
				business: {
					resetCredits: {
						availableCount: 2n,
						credits: [
							{ id: "same", expiresAt: base + day, available: true },
							{ id: "same", expiresAt: base + 2 * day, available: true },
						],
					},
				},
			}),
		],
		[
			"more visible cards than availableCount",
			fleet({
				business: {
					resetCredits: {
						availableCount: 1n,
						credits: [
							{ id: "one", expiresAt: base + day, available: true },
							{ id: "two", expiresAt: base + 2 * day, available: true },
						],
					},
				},
			}),
		],
	] as const)(
		"returns invalid_input without throwing for %s",
		(_name, input) => {
			expect(() => selectCodexResetCredit(input)).not.toThrow();
			expect(selectCodexResetCredit(input)).toMatchObject({
				kind: "no_recommendation",
				reasonCode: "invalid_input",
			});
		},
	);
});

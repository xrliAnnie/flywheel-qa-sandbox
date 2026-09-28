import { describe, expect, it } from "vitest";
import type {
	CedarGrant,
	CedarStatus,
} from "../account-heal/reset-card-contract.js";
import {
	type CardCandidateInput,
	drivingWindow,
	episodeKey,
	estimateRunway,
	naturalRecoveryAt,
	proposalDigest,
	selectResetCardTarget,
	usableGrant,
} from "../account-heal/reset-card-select.js";
import { usageResult } from "./quota-monitor-test-helpers.js";

const NOW = Date.parse("2026-09-25T23:05:00.000Z");
const GRANT_ID = "opus55-launch-promax-20260921";

function grant(patch: Partial<CedarGrant> = {}): CedarGrant {
	return {
		id: GRANT_ID,
		resetsLeft: 1,
		resetsTotal: 1,
		startsAt: "2026-09-22T16:00:00.000Z",
		endsAt: "2026-10-22T16:00:00.000Z",
		clears: ["five_hour", "seven_day", "seven_day_overage_included"],
		blocking: [],
		blockingUnknown: false,
		paused: false,
		usableNow: true,
		useRequiresLimit: true,
		...patch,
	};
}

function cedar(patch: Partial<CedarStatus> = {}): CedarStatus {
	return {
		eligible: true,
		ineligibleReason: null,
		atLimit: true,
		exhausted: ["seven_day"],
		exhaustedUnknown: false,
		grants: [grant()],
		nextGrantId: GRANT_ID,
		cooldownUntil: null,
		...patch,
	};
}

function weeklyFull(name: string, weeklyReset: string): CardCandidateInput {
	return {
		name,
		usage: usageResult(10, 100, {
			five: "2026-09-26T02:00:00.000Z",
			seven: weeklyReset,
		}).ok,
		cedar: cedar(),
		subscription: "active",
	};
}

describe("usableGrant", () => {
	it("offers the next grant for an at-limit account", () => {
		expect(usableGrant(cedar(), NOW)).toEqual({ grant: grant() });
	});

	it.each<[string, Partial<CedarStatus>, string]>([
		["ineligible", { eligible: false }, "ineligible"],
		["not at limit", { atLimit: false }, "not_at_limit"],
		[
			"not at limit even when use_requires_limit=false",
			{ atLimit: false, grants: [grant({ useRequiresLimit: false })] },
			"not_at_limit",
		],
		["no next grant", { nextGrantId: null }, "no_next_grant"],
		["next grant missing from list", { nextGrantId: "other" }, "no_next_grant"],
		["paused", { grants: [grant({ paused: true })] }, "paused"],
		[
			"not usable now",
			{ grants: [grant({ usableNow: false })] },
			"not_usable_now",
		],
		[
			"no resets left",
			{ grants: [grant({ resetsLeft: 0 })] },
			"no_resets_left",
		],
		[
			"expired",
			{ grants: [grant({ endsAt: "2026-09-25T23:00:00.000Z" })] },
			"grant_expired",
		],
		[
			"not started",
			{ grants: [grant({ startsAt: "2026-09-26T00:00:00.000Z" })] },
			"grant_not_started",
		],
		[
			"blocking",
			{ grants: [grant({ blocking: ["seven_day_opus"] })] },
			"blocking",
		],
		[
			"unknown blocking",
			{ grants: [grant({ blockingUnknown: true })] },
			"blocking",
		],
		[
			"exhausted not cleared",
			{ grants: [grant({ clears: ["five_hour"] })] },
			"exhausted_not_cleared",
		],
		["nothing exhausted", { exhausted: [] }, "no_exhausted"],
		["opus window", { exhausted: ["seven_day_opus"] }, "unsupported_limit"],
		[
			"cowork mixed in",
			{ exhausted: ["seven_day", "seven_day_cowork"] },
			"unsupported_limit",
		],
		["unknown exhausted key", { exhaustedUnknown: true }, "unsupported_limit"],
	])("rejects %s", (_label, patch, reason) => {
		expect(usableGrant(cedar(patch), NOW)).toEqual({ none: reason });
	});
});

describe("Lead ruling 2026-09-25: weekly overage-included window", () => {
	it("offers a card when a weekly-capped account also reports overage_included (FLY-2864 sample clears)", () => {
		expect(
			usableGrant(
				cedar({ exhausted: ["seven_day", "seven_day_overage_included"] }),
				NOW,
			),
		).toEqual({ grant: grant() });
		expect(
			selectResetCardTarget(
				[
					{
						...weeklyFull("business", "2026-10-01T02:00:00.000Z"),
						cedar: cedar({
							exhausted: ["seven_day", "seven_day_overage_included"],
						}),
					},
				],
				NOW,
			),
		).toMatchObject({ target: { name: "business" } });
	});

	it("still refuses an unknown exhausted key", () => {
		expect(
			usableGrant(
				cedar({
					exhausted: ["seven_day", "seven_day_overage_included"],
					exhaustedUnknown: true,
				}),
				NOW,
			),
		).toEqual({ none: "unsupported_limit" });
	});

	it("refuses when the card does not clear overage_included", () => {
		expect(
			usableGrant(
				cedar({
					exhausted: ["seven_day", "seven_day_overage_included"],
					grants: [grant({ clears: ["five_hour", "seven_day"] })],
				}),
				NOW,
			),
		).toEqual({ none: "exhausted_not_cleared" });
	});

	it("overage_included alone has no readable window to recover, so it is not selected", () => {
		expect(
			selectResetCardTarget(
				[
					{
						...weeklyFull("business", "2026-10-01T02:00:00.000Z"),
						usage: usageResult(10, 60).ok,
						cedar: cedar({ exhausted: ["seven_day_overage_included"] }),
					},
				],
				NOW,
			),
		).toEqual({ none: [{ name: "business", reason: "recovery_unknown" }] });
	});
});

describe("naturalRecoveryAt", () => {
	it("takes the latest reset of every exhausted window", () => {
		expect(
			naturalRecoveryAt(
				usageResult(100, 100, {
					five: "2026-09-26T02:00:00.000Z",
					seven: "2026-10-01T02:00:00.000Z",
				}).ok,
			),
		).toBe("2026-10-01T02:00:00.000Z");
		expect(
			naturalRecoveryAt(
				usageResult(100, 40, {
					five: "2026-09-26T02:00:00.000Z",
					seven: "2026-10-01T02:00:00.000Z",
				}).ok,
			),
		).toBe("2026-09-26T02:00:00.000Z");
	});

	it("is null when an exhausted window has no reset, or nothing is exhausted", () => {
		expect(
			naturalRecoveryAt(usageResult(100, 40, { five: null }).ok),
		).toBeNull();
		expect(naturalRecoveryAt(usageResult(99, 40).ok)).toBeNull();
	});
});

describe("selectResetCardTarget", () => {
	it("picks the account whose natural recovery is latest", () => {
		const selected = selectResetCardTarget(
			[
				weeklyFull("school", "2026-09-29T02:00:00.000Z"),
				weeklyFull("business", "2026-10-01T02:00:00.000Z"),
				weeklyFull("shopping", "2026-09-30T02:00:00.000Z"),
			],
			NOW,
		);
		expect(selected).toMatchObject({
			target: { name: "business" },
			grant: { id: GRANT_ID },
			recoveryAt: "2026-10-01T02:00:00.000Z",
			cardsLeft: 1,
		});
	});

	it("breaks a same-minute tie by remaining cards, then by name", () => {
		const a = weeklyFull("alpha", "2026-10-01T02:00:10.000Z");
		const b = {
			...weeklyFull("bravo", "2026-10-01T02:00:40.000Z"),
			cedar: cedar({
				grants: [
					grant(),
					grant({ id: "second-grant", resetsLeft: 2, resetsTotal: 2 }),
				],
			}),
		};
		expect(selectResetCardTarget([a, b], NOW)).toMatchObject({
			target: { name: "bravo" },
			cardsLeft: 3,
		});
		const c = weeklyFull("charlie", "2026-10-01T02:00:59.000Z");
		expect(selectResetCardTarget([c, a], NOW)).toMatchObject({
			target: { name: "alpha" },
		});
	});

	it("excludes canceled, ineligible and recovery-unknown accounts with reasons", () => {
		const selected = selectResetCardTarget(
			[
				{
					...weeklyFull("personal1", "2026-10-01T02:00:00.000Z"),
					subscription: "canceled",
				},
				{
					...weeklyFull("school", "2026-10-01T02:00:00.000Z"),
					cedar: cedar({ eligible: false, ineligibleReason: "surface" }),
				},
				{
					...weeklyFull("shopping", "2026-10-01T02:00:00.000Z"),
					usage: usageResult(10, 100, { seven: null }).ok,
				},
			],
			NOW,
		);
		expect(selected).toEqual({
			none: [
				{ name: "personal1", reason: "subscription_canceled" },
				{ name: "school", reason: "ineligible" },
				{ name: "shopping", reason: "recovery_unknown" },
			],
		});
	});

	it("returns none for an empty candidate list", () => {
		expect(selectResetCardTarget([], NOW)).toEqual({ none: [] });
	});
});

describe("estimateRunway", () => {
	it("extrapolates the active 5h burn rate", () => {
		// Window opened 4h ago (reset in 1h) and is at 80% → 20%/h → 5h cap.
		expect(
			estimateRunway(
				usageResult(80, 40, { five: "2026-09-26T00:05:00.000Z" }).ok,
				NOW,
			),
		).toEqual({ fiveHourMinutes: 300 });
		// Window opened 2h ago at 88% → 44%/h → 100/44h ≈ 136 minutes.
		expect(
			estimateRunway(
				usageResult(88, 40, { five: "2026-09-26T02:05:00.000Z" }).ok,
				NOW,
			),
		).toEqual({ fiveHourMinutes: 136 });
	});

	it("refuses to guess too early or without a reset", () => {
		expect(
			estimateRunway(
				usageResult(88, 40, { five: "2026-09-26T03:55:00.000Z" }).ok,
				NOW,
			),
		).toEqual({ unknown: "too_early" });
		expect(estimateRunway(usageResult(88, 40, { five: null }).ok, NOW)).toEqual(
			{
				unknown: "no_reset_time",
			},
		);
	});
});

describe("drivingWindow / episodeKey", () => {
	it("picks the window at or above askPct, earlier reset when both are", () => {
		expect(
			drivingWindow(
				usageResult(88, 40, { five: "2026-09-26T02:00:00.000Z" }).ok,
				85,
			),
		).toEqual({ window: "5h", resetAt: "2026-09-26T02:00:00.000Z" });
		expect(
			drivingWindow(
				usageResult(90, 95, {
					five: "2026-09-26T02:00:00.000Z",
					seven: "2026-09-26T01:00:00.000Z",
				}).ok,
				85,
			),
		).toEqual({ window: "7d", resetAt: "2026-09-26T01:00:00.000Z" });
		expect(drivingWindow(usageResult(50, 40).ok, 85)).toBeNull();
		expect(drivingWindow(usageResult(90, 40, { five: null }).ok, 85)).toEqual({
			window: "5h",
			resetAt: null,
		});
	});

	it("rounds jitter across a minute boundary while separating genuinely new resets", () => {
		const base = episodeKey("personal", 7, "5h", "2026-09-26T02:00:00.000Z");
		for (const resetAt of [
			"2026-09-26T02:00:00.123456+00:00",
			"2026-09-26T01:59:59.876543+00:00",
			"2026-09-25T19:00:00.401234-07:00",
		]) {
			expect(episodeKey("personal", 7, "5h", resetAt)).toBe(base);
		}
		expect(
			episodeKey("personal", 7, "5h", "2026-09-26T02:01:00.000Z"),
		).not.toBe(base);
		expect(
			episodeKey("business", 7, "5h", "2026-09-26T02:00:00.000Z"),
		).not.toBe(base);
	});

	it("changes when any episode input changes", () => {
		const base = episodeKey("personal", 7, "5h", "2026-09-26T02:00:00.000Z");
		expect(base).toMatch(/^[a-f0-9]{64}$/);
		expect(episodeKey("personal", 7, "5h", "2026-09-26T02:00:00.000Z")).toBe(
			base,
		);
		expect(
			episodeKey("personal", 8, "5h", "2026-09-26T02:00:00.000Z"),
		).not.toBe(base);
		expect(
			episodeKey("personal", 7, "7d", "2026-09-26T02:00:00.000Z"),
		).not.toBe(base);
	});
});

describe("proposalDigest", () => {
	it("is canonical over key order and sensitive to clears", () => {
		const one = proposalDigest({ b: 1, a: { y: [2, 1], x: "s" } });
		const two = proposalDigest({ a: { x: "s", y: [2, 1] }, b: 1 });
		expect(one).toBe(two);
		expect(one).toMatch(/^[a-f0-9]{64}$/);
		expect(proposalDigest({ b: 1, a: { y: [1, 2], x: "s" } })).not.toBe(one);
	});
});

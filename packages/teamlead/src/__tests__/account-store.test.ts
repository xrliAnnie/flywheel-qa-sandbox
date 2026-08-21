/**
 * FLY-696 M1/C2 — selectNextAccount: pick the next usable Claude account when
 * the active one hits a cap.
 *
 *  - 5h cap    → temporary: switch to any usable account (the current one comes
 *                back after its 5h reset), don't burn the weekly pool.
 *  - weekly/both cap → switch to the account whose WEEKLY reset is soonest
 *                ("周五先用周一 reset 的"); accounts with unknown weekly reset are
 *                deprioritized; never return an account still exhausted this week.
 *  - all others unusable → null (caller pages Annie with the earliest reset).
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AccountEntry,
	type AccountStore,
	applyObservation,
	earliestReset,
	emptyStore,
	inspectModelSetBench,
	isAuthUnusable,
	isModelSetUsable,
	isQuotaUsable,
	readStore,
	recordObservationInStore,
	selectNextAccount,
	summarizeModelBenchPool,
	syncActiveAccountInStore,
	syncFreshenedActiveAccountInStore,
	writeStore,
} from "../account-heal/account-store.js";

const NOW = new Date("2026-07-03T20:00:00Z");

function store(accounts: AccountEntry[], active: string): AccountStore {
	return { generation: 1, activeAccount: active, accounts };
}
const acct = (
	name: string,
	over: Partial<AccountEntry> = {},
): AccountEntry => ({
	name,
	quotaExhaustedUntil: null,
	weeklyResetAt: null,
	authExpired: false,
	...over,
});

describe("selectNextAccount", () => {
	it("weekly cap → picks the account with the SOONEST weekly reset", () => {
		const s = store(
			[
				acct("personal", { quotaExhaustedUntil: "2026-07-10T00:00:00Z" }),
				acct("business", { weeklyResetAt: "2026-07-07T14:00:00Z" }), // Tue
				acct("school", { weeklyResetAt: "2026-07-06T14:00:00Z" }), // Mon (sooner)
			],
			"personal",
		);
		expect(
			selectNextAccount(s, {
				scope: "weekly",
				currentName: "personal",
				now: NOW,
			}),
		).toBe("school");
	});

	it("weekly cap → an account with unknown weekly reset is deprioritized", () => {
		const s = store(
			[
				acct("personal", { quotaExhaustedUntil: "2026-07-10T00:00:00Z" }),
				acct("business", { weeklyResetAt: null }), // unknown → last
				acct("school", { weeklyResetAt: "2026-07-08T14:00:00Z" }),
			],
			"personal",
		);
		expect(
			selectNextAccount(s, {
				scope: "weekly",
				currentName: "personal",
				now: NOW,
			}),
		).toBe("school");
	});

	it("weekly cap → never returns an account still weekly-exhausted this week", () => {
		const s = store(
			[
				acct("personal", { quotaExhaustedUntil: "2026-07-10T00:00:00Z" }),
				acct("school", { quotaExhaustedUntil: "2026-07-09T00:00:00Z" }), // also dead
				acct("business", { weeklyResetAt: "2026-07-08T14:00:00Z" }),
			],
			"personal",
		);
		expect(
			selectNextAccount(s, {
				scope: "weekly",
				currentName: "personal",
				now: NOW,
			}),
		).toBe("business");
	});

	it("5h cap → picks the usable account with the soonest weekly reset", () => {
		const s = store(
			[
				acct("personal"),
				acct("business", { weeklyResetAt: "2026-07-09T14:00:00Z" }),
				acct("school", { weeklyResetAt: "2026-07-06T14:00:00Z" }),
				acct("shopping", { weeklyResetAt: null }),
			],
			"personal",
		);
		expect(
			selectNextAccount(s, {
				scope: "5h",
				currentName: "personal",
				now: NOW,
			}),
		).toBe("school");
	});

	it("an account whose quotaExhaustedUntil is in the PAST is usable again", () => {
		const s = store(
			[
				acct("personal", { quotaExhaustedUntil: "2026-07-10T00:00:00Z" }),
				acct("school", { quotaExhaustedUntil: "2026-07-03T18:00:00Z" }), // past → back
			],
			"personal",
		);
		expect(
			selectNextAccount(s, { scope: "5h", currentName: "personal", now: NOW }),
		).toBe("school");
	});

	it("auth-expired accounts are not eligible for a quota switch", () => {
		const s = store(
			[acct("personal"), acct("school", { authExpired: true })],
			"personal",
		);
		expect(
			selectNextAccount(s, { scope: "5h", currentName: "personal", now: NOW }),
		).toBeNull();
	});

	it("returns null when no other account is usable (caller pages Annie)", () => {
		const s = store(
			[
				acct("personal", { quotaExhaustedUntil: "2026-07-10T00:00:00Z" }),
				acct("school", { quotaExhaustedUntil: "2026-07-09T00:00:00Z" }),
			],
			"personal",
		);
		expect(
			selectNextAccount(s, {
				scope: "weekly",
				currentName: "personal",
				now: NOW,
			}),
		).toBeNull();
	});

	it("preferredOrder restricts eligibility to the verified list and preserves its rank", () => {
		const s = store(
			[acct("personal"), acct("business"), acct("school"), acct("shopping")],
			"personal",
		);
		expect(
			selectNextAccount(s, {
				scope: "5h",
				currentName: "personal",
				now: NOW,
				preferredOrder: ["school", "business"],
			}),
		).toBe("school");
		expect(
			selectNextAccount(s, {
				scope: "5h",
				currentName: "personal",
				now: NOW,
				preferredOrder: ["ghost"],
			}),
		).toBeNull();
	});

	it("preferredOrder never bypasses existing auth or cooldown usability guards", () => {
		const s = store(
			[
				acct("personal"),
				acct("school", { authExpired: true }),
				acct("business", { quotaExhaustedUntil: "2026-07-04T20:00:00Z" }),
				acct("shopping"),
			],
			"personal",
		);
		expect(
			selectNextAccount(s, {
				scope: "weekly",
				currentName: "personal",
				now: NOW,
				preferredOrder: ["school", "business", "shopping"],
			}),
		).toBe("shopping");
	});

	it("preferredOrder ignores cooldown facts that predate the live verification", () => {
		const s = store(
			[
				acct("personal"),
				acct("school", {
					quotaExhaustedUntil: "2026-07-04T20:00:00Z",
					lastObservedAt: "2026-07-03T19:55:00Z",
				}),
				acct("business", {
					quotaExhaustedUntil: "2026-07-04T20:00:00Z",
				}),
			],
			"personal",
		);
		expect(
			selectNextAccount(s, {
				scope: "weekly",
				currentName: "personal",
				now: NOW,
				preferredOrder: ["school", "business"],
				verifiedAt: "2026-07-03T20:00:00Z",
			}),
		).toBe("school");
	});

	it("preferredOrder honors a newer exhausted observation over live verification", () => {
		const s = store(
			[
				acct("personal"),
				acct("school", {
					quotaExhaustedUntil: "2026-07-04T20:00:00Z",
					lastObservedAt: "2026-07-03T20:00:01Z",
				}),
				acct("business"),
			],
			"personal",
		);
		expect(
			selectNextAccount(s, {
				scope: "weekly",
				currentName: "personal",
				now: NOW,
				preferredOrder: ["school", "business"],
				verifiedAt: "2026-07-03T20:00:00Z",
			}),
		).toBe("business");
	});

	it.each([
		{
			label: "invalid verifiedAt",
			verifiedAt: "not-an-instant",
			lastObservedAt: "2026-07-03T19:55:00Z",
		},
		{
			label: "invalid lastObservedAt",
			verifiedAt: "2026-07-03T20:00:00Z",
			lastObservedAt: "not-an-instant",
		},
	])("preferredOrder conservatively honors cooldown for $label", (input) => {
		const s = store(
			[
				acct("personal"),
				acct("school", {
					quotaExhaustedUntil: "2026-07-04T20:00:00Z",
					lastObservedAt: input.lastObservedAt,
				}),
				acct("business"),
			],
			"personal",
		);
		expect(
			selectNextAccount(s, {
				scope: "weekly",
				currentName: "personal",
				now: NOW,
				preferredOrder: ["school", "business"],
				verifiedAt: input.verifiedAt,
			}),
		).toBe("business");
	});

	it("exports the single usability predicates used by the daemon pre-filter", () => {
		expect(isAuthUnusable(acct("school", { refreshTokenInvalid: true }))).toBe(
			true,
		);
		expect(isAuthUnusable(acct("school"))).toBe(false);
		expect(
			isAuthUnusable(
				acct("school", {
					identityMismatch: {
						actualDigest: "abc123",
						markedBy: "audit",
						markedAt: "2026-07-03T20:00:00Z",
					},
				}),
			),
		).toBe(true);
		expect(
			isQuotaUsable(
				acct("school", { quotaExhaustedUntil: "2026-07-03T18:00:00Z" }),
				NOW.getTime(),
			),
		).toBe(true);
		expect(
			isQuotaUsable(
				acct("school", { quotaExhaustedUntil: "2026-07-03T21:00:00Z" }),
				NOW.getTime(),
			),
		).toBe(false);
	});

	it("model selection excludes a candidate when any model in the canonical set is still benched", () => {
		const future = new Date(NOW.getTime() + 60 * 60_000).toISOString();
		const s = store(
			[
				acct("personal"),
				acct("school", {
					modelCaps: {
						"Fable 5": { until: future, backoffMs: 30 * 60_000 },
					},
				}),
				acct("business", {
					modelCaps: {
						"Sonnet 5": { until: future, backoffMs: 30 * 60_000 },
					},
				}),
				acct("shopping"),
			],
			"personal",
		);
		expect(
			selectNextAccount(s, {
				scope: "model",
				models: ["Fable 5", "Sonnet 5"],
				currentName: "personal",
				now: NOW,
				preferredOrder: ["school", "business", "shopping"],
			}),
		).toBe("shopping");
	});

	it("validates the whole modelCaps object and fails closed on malformed state while missing state remains compatible", () => {
		expect(isModelSetUsable(acct("school"), ["Fable 5"], NOW.getTime())).toBe(
			true,
		);
		const malformed = acct("school", {
			modelCaps: {
				"Fable 5": { until: "not-a-date", backoffMs: 30 * 60_000 },
			},
		});
		expect(inspectModelSetBench(malformed, ["Fable 5"], NOW.getTime())).toEqual(
			expect.objectContaining({ state: "malformed" }),
		);
		expect(isModelSetUsable(malformed, ["Fable 5"], NOW.getTime())).toBe(false);

		const unrelatedCorruption = acct("business", {
			modelCaps: {
				"Fable 5": {
					until: new Date(NOW.getTime() - 1).toISOString(),
					backoffMs: 30 * 60_000,
				},
				Broken: { until: "never", backoffMs: -1 },
			},
		});
		expect(
			inspectModelSetBench(unrelatedCorruption, ["Fable 5"], NOW.getTime()),
		).toMatchObject({ state: "malformed" });
	});

	it("computes pool retry as max per account then min across accounts", () => {
		const at = (minutes: number) =>
			new Date(NOW.getTime() + minutes * 60_000).toISOString();
		const accounts = [
			acct("school", {
				modelCaps: {
					"Fable 5": { until: at(30), backoffMs: 30 * 60_000 },
					"Sonnet 5": { until: at(60), backoffMs: 60 * 60_000 },
				},
			}),
			acct("business", {
				modelCaps: {
					"Fable 5": { until: at(45), backoffMs: 45 * 60_000 },
					"Sonnet 5": { until: at(40), backoffMs: 40 * 60_000 },
				},
			}),
		];

		expect(
			summarizeModelBenchPool(accounts, ["Fable 5", "Sonnet 5"], NOW.getTime()),
		).toEqual({
			eligibleAccounts: [],
			nextRetryAt: at(45),
			hasUnknown: false,
		});
	});

	it("keeps malformed benches at infinity without hiding another account's finite retry", () => {
		const finite = new Date(NOW.getTime() + 45 * 60_000).toISOString();
		const malformed = acct("school", {
			modelCaps: {
				"Fable 5": { until: "unknown", backoffMs: 30 * 60_000 },
			},
		});
		const valid = acct("business", {
			modelCaps: {
				"Fable 5": { until: finite, backoffMs: 45 * 60_000 },
			},
		});
		expect(
			summarizeModelBenchPool([malformed, valid], ["Fable 5"], NOW.getTime()),
		).toEqual({
			eligibleAccounts: [],
			nextRetryAt: finite,
			hasUnknown: true,
		});
		expect(
			summarizeModelBenchPool([malformed], ["Fable 5"], NOW.getTime()),
		).toEqual({
			eligibleAccounts: [],
			nextRetryAt: null,
			hasUnknown: true,
		});
	});
});

describe("quota observation projection", () => {
	const observedAt = "2026-07-03T20:00:00Z";
	const base = acct("school", {
		quotaExhaustedUntil: "2026-07-03T21:00:00Z",
		weeklyResetAt: "2026-07-08T14:00:00Z",
		authExpired: true,
		refreshTokenInvalid: true,
	});

	const observation = (over: Record<string, unknown> = {}) => ({
		fiveHPct: 25,
		sevenDPct: 50,
		fiveHResetAt: "2026-07-04T01:00:00Z",
		sevenDResetAt: "2026-07-08T14:00:00Z",
		observedAt,
		...over,
	});

	it("weekly exhaustion wins and refreshes every observation field", () => {
		const after = applyObservation(
			base,
			observation({ fiveHPct: 100, sevenDPct: 100 }),
		);
		expect(after).toMatchObject({
			name: "school",
			quotaExhaustedUntil: "2026-07-08T14:00:00Z",
			weeklyResetAt: "2026-07-08T14:00:00Z",
			lastObservedAt: observedAt,
			observedFiveHPct: 100,
			observedSevenDPct: 100,
			authExpired: true,
			refreshTokenInvalid: true,
		});
	});

	it("uses the 5h reset when only the 5h window is exhausted", () => {
		expect(
			applyObservation(base, observation({ fiveHPct: 100 }))
				.quotaExhaustedUntil,
		).toBe("2026-07-04T01:00:00Z");
	});

	it("clears stale exhaustion after a healthy live observation", () => {
		expect(
			applyObservation(base, observation()).quotaExhaustedUntil,
		).toBeNull();
	});

	it("preserves an intentional post-switch cooldown across healthy observations", () => {
		const switchCooldownUntil = "2026-07-04T01:00:00Z";
		const after = applyObservation(
			{
				...base,
				authExpired: false,
				refreshTokenInvalid: false,
				switchCooldownUntil,
			},
			observation(),
		);

		expect(after.quotaExhaustedUntil).toBeNull();
		expect(after.switchCooldownUntil).toBe(switchCooldownUntil);
		expect(
			selectNextAccount(store([acct("personal"), after], "personal"), {
				scope: "5h",
				currentName: "personal",
				now: NOW,
				preferredOrder: ["school"],
				verifiedAt: observedAt,
			}),
		).toBeNull();
	});

	it.each([
		{ label: "unparseable reset", reset: "not-an-instant" },
		{ label: "reset at observation time", reset: observedAt },
		{ label: "reset in the past", reset: "2026-07-03T19:59:59Z" },
	])("does not mark exhaustion for an invalid $label", ({ reset }) => {
		const after = applyObservation(
			base,
			observation({
				fiveHPct: 100,
				fiveHResetAt: reset,
				sevenDResetAt: "not-an-instant",
			}),
		);
		expect(after.quotaExhaustedUntil).toBeNull();
		expect(after.weeklyResetAt).toBe(base.weeklyResetAt);
	});

	// FLY-1366: an idle account reports `resets_at: null` for an unopened window.
	it("projects an idle account's null resets without inventing exhaustion", () => {
		const after = applyObservation(
			base,
			observation({ fiveHPct: 0, sevenDPct: 0, fiveHResetAt: null }),
		);

		expect(after.quotaExhaustedUntil).toBeNull();
		expect(after.weeklyResetAt).toBe("2026-07-08T14:00:00Z");
		expect(after.observedFiveHPct).toBe(0);
	});

	it("keeps the prior weekly reset when the weekly window has not opened", () => {
		const after = applyObservation(
			base,
			observation({ sevenDPct: 0, sevenDResetAt: null }),
		);

		expect(after.weeklyResetAt).toBe(base.weeklyResetAt);
		expect(after.quotaExhaustedUntil).toBeNull();
	});

	it("never marks exhaustion from a null reset even at 100 percent", () => {
		const after = applyObservation(
			base,
			observation({
				fiveHPct: 100,
				sevenDPct: 100,
				fiveHResetAt: null,
				sevenDResetAt: null,
			}),
		);

		expect(after.quotaExhaustedUntil).toBeNull();
		expect(after.weeklyResetAt).toBe(base.weeklyResetAt);
	});
});

describe("earliestReset", () => {
	it("ignores an expired switch cooldown and reports the real future reset", () => {
		expect(
			earliestReset(
				store(
					[
						acct("personal", {
							switchCooldownUntil: "2026-07-03T19:00:00Z",
							quotaExhaustedUntil: "2026-07-03T21:00:00Z",
							weeklyResetAt: "2026-07-08T14:00:00Z",
						}),
					],
					"personal",
				),
				NOW.getTime(),
			),
		).toBe("2026-07-03T21:00:00Z");
	});

	it("reports when both a future cooldown and quota exhaustion have cleared", () => {
		expect(
			earliestReset(
				store(
					[
						acct("personal", {
							switchCooldownUntil: "2026-07-03T22:00:00Z",
							quotaExhaustedUntil: "2026-07-03T21:00:00Z",
						}),
					],
					"personal",
				),
				NOW.getTime(),
			),
		).toBe("2026-07-03T22:00:00Z");
	});
});

describe("recordObservationInStore", () => {
	let dir: string;
	let path: string;
	const observedAt = "2026-07-03T20:00:00Z";
	const observation = {
		fiveHPct: 42,
		sevenDPct: 100,
		fiveHResetAt: "2026-07-04T01:00:00Z",
		sevenDResetAt: "2026-07-08T14:00:00Z",
		observedAt,
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1252-observation-"));
		path = join(dir, "claude-accounts.json");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("updates one account without changing generation or activeAccount", () => {
		writeStore(store([acct("personal"), acct("school")], "personal"), path);
		const before = readStore(path);
		expect(
			recordObservationInStore(path, "school", observation, {
				expectedGeneration: before.generation,
			}),
		).toBe("updated");
		const after = readStore(path);
		expect(after.generation).toBe(before.generation);
		expect(after.activeAccount).toBe(before.activeAccount);
		expect(
			after.accounts.find((entry) => entry.name === "school"),
		).toMatchObject({
			quotaExhaustedUntil: observation.sevenDResetAt,
			lastObservedAt: observedAt,
			observedFiveHPct: 42,
			observedSevenDPct: 100,
		});
	});

	it("returns stale_generation without writing", () => {
		writeStore(store([acct("school")], "school"), path);
		const before = readFileSync(path, "utf-8");
		expect(
			recordObservationInStore(path, "school", observation, {
				expectedGeneration: 999,
			}),
		).toBe("stale_generation");
		expect(readFileSync(path, "utf-8")).toBe(before);
	});

	it("returns older_observation without replacing a newer fact", () => {
		writeStore(
			store(
				[acct("school", { lastObservedAt: "2026-07-03T20:00:01Z" })],
				"school",
			),
			path,
		);
		expect(recordObservationInStore(path, "school", observation)).toBe(
			"older_observation",
		);
	});

	it("returns missing_account without creating pool membership", () => {
		writeStore(store([acct("personal")], "personal"), path);
		expect(recordObservationInStore(path, "school", observation)).toBe(
			"missing_account",
		);
		expect(readStore(path).accounts.map((entry) => entry.name)).toEqual([
			"personal",
		]);
	});

	it("returns invalid_store for missing or corrupt input and preserves corrupt bytes", () => {
		expect(recordObservationInStore(path, "school", observation)).toBe(
			"invalid_store",
		);
		const corrupt = "{ definitely not json\n";
		writeFileSync(path, corrupt);
		expect(recordObservationInStore(path, "school", observation)).toBe(
			"invalid_store",
		);
		expect(readFileSync(path, "utf-8")).toBe(corrupt);
	});

	it("returns write_failed instead of throwing on atomic write failure", () => {
		writeStore(store([acct("school")], "school"), path);
		mkdirSync(`${path}.tmp.${process.pid}`);
		expect(recordObservationInStore(path, "school", observation)).toBe(
			"write_failed",
		);
	});
});

describe("syncActiveAccountInStore", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1252-active-sync-"));
		path = join(dir, "claude-accounts.json");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("updates only activeAccount and increments generation once", () => {
		const before = store([acct("personal"), acct("school")], "personal");
		before.generation = 7;
		writeStore(before, path);

		expect(syncActiveAccountInStore(path, "school")).toBe("synced");
		expect(readStore(path)).toEqual({
			...before,
			activeAccount: "school",
			generation: 8,
		});
	});

	it("returns noop without writing when the active account already matches", () => {
		const before = store([acct("personal"), acct("school")], "school");
		writeStore(before, path);
		const bytes = readFileSync(path, "utf8");

		expect(syncActiveAccountInStore(path, "school")).toBe("noop");
		expect(readFileSync(path, "utf8")).toBe(bytes);
	});

	it.each([
		["invalid_name", "../school"],
		["missing_account", "business"],
	] as const)("returns %s without mutating the store", (expected, name) => {
		writeStore(store([acct("personal"), acct("school")], "personal"), path);
		const bytes = readFileSync(path, "utf8");

		expect(syncActiveAccountInStore(path, name)).toBe(expected);
		expect(readFileSync(path, "utf8")).toBe(bytes);
	});

	it("returns invalid_store for missing or corrupt input and preserves corrupt bytes", () => {
		expect(syncActiveAccountInStore(path, "school")).toBe("invalid_store");
		const corrupt = "{ definitely not json\n";
		writeFileSync(path, corrupt);
		expect(syncActiveAccountInStore(path, "school")).toBe("invalid_store");
		expect(readFileSync(path, "utf8")).toBe(corrupt);
	});

	it("returns write_failed instead of throwing when the atomic write cannot complete", () => {
		writeStore(store([acct("personal"), acct("school")], "personal"), path);
		mkdirSync(`${path}.tmp.${process.pid}`);
		expect(syncActiveAccountInStore(path, "school")).toBe("write_failed");
	});
});

describe("syncFreshenedActiveAccountInStore", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1756-active-sync-strict-"));
		path = join(dir, "claude-accounts.json");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("clears auth-family flags and a matching identity mismatch in one generation", () => {
		writeStore(
			store(
				[
					acct("personal", {
						authExpired: true,
						refreshTokenInvalid: true,
						profileVerifyFailed: true,
						identity: {
							email: "xrliannie@gmail.com",
							uuid: "uuid-personal",
							setAt: "2026-08-01T00:00:00.000Z",
						},
						identityMismatch: {
							actualDigest: "a".repeat(64),
							markedBy: "executor",
							markedAt: "2026-08-01T00:00:00.000Z",
						},
					}),
				],
				"personal",
			),
			path,
		);

		expect(
			syncFreshenedActiveAccountInStore(path, "personal", {
				email: "xrliannie@gmail.com",
				uuid: "uuid-personal",
			}),
		).toBe("synced");
		const after = readStore(path);
		expect(after.generation).toBe(2);
		expect(after.accounts[0]).not.toHaveProperty("authExpired");
		expect(after.accounts[0]).not.toHaveProperty("refreshTokenInvalid");
		expect(after.accounts[0]).not.toHaveProperty("profileVerifyFailed");
		expect(after.accounts[0]).not.toHaveProperty("identityMismatch");
	});

	it("preserves identityMismatch when the trusted identity does not match the proof", () => {
		const mismatch = {
			actualDigest: "b".repeat(64),
			markedBy: "audit" as const,
			markedAt: "2026-08-01T00:00:00.000Z",
		};
		writeStore(
			store(
				[
					acct("personal", {
						authExpired: true,
						identity: {
							email: "different@example.com",
							setAt: "2026-08-01T00:00:00.000Z",
						},
						identityMismatch: mismatch,
					}),
				],
				"personal",
			),
			path,
		);

		expect(
			syncFreshenedActiveAccountInStore(path, "personal", {
				email: "xrliannie@gmail.com",
				uuid: "uuid-personal",
			}),
		).toBe("synced");
		expect(readStore(path).accounts[0]?.identityMismatch).toEqual(mismatch);
	});
});

describe("account-store IO", () => {
	let dir: string;
	let path: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly696-store-"));
		path = join(dir, "claude-accounts.json");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("readStore returns an empty store when the file is missing", () => {
		expect(readStore(path)).toEqual(emptyStore());
	});

	it("writeStore → readStore round-trips and writes 0600", () => {
		const s = store([acct("personal"), acct("school")], "personal");
		s.generation = 4;
		writeStore(s, path);
		expect(readStore(path)).toEqual(s);
		// 0600 — the state file references account names; keep it owner-only.
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("readStore returns an empty store on corrupt JSON (fail-soft, not throw)", () => {
		writeStore(store([acct("personal")], "personal"), path);
		// clobber with garbage
		writeFileSync(path, "{ not json");
		expect(readStore(path)).toEqual(emptyStore());
	});
});

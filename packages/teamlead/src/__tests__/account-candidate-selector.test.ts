import { describe, expect, it, vi } from "vitest";
import {
	type CandidateSelectionDeps,
	type CandidateSnapshot,
	verifyAndRankCandidates,
} from "../account-heal/account-candidate-selector.js";
import type { AccountStore } from "../account-heal/account-store.js";
import type { AccountUsageResult } from "../account-heal/quota-usage-api.js";

const NOW = Date.parse("2026-09-01T20:00:00.000Z");

function usage(
	fiveHPct: number,
	sevenDPct: number,
	sevenDReset: string | null,
): Extract<AccountUsageResult, { ok: unknown }> {
	return {
		ok: {
			raw: {
				five_hour: {
					utilization: fiveHPct,
					resets_at: "2026-09-01T22:00:00.000Z",
				},
				seven_day: {
					utilization: sevenDPct,
					resets_at: sevenDReset,
				},
			},
			fiveH: {
				pct: fiveHPct,
				resetsAt: "2026-09-01T22:00:00.000Z",
			},
			sevenD: { pct: sevenDPct, resetsAt: sevenDReset },
		},
	};
}

function store(): AccountStore {
	return {
		generation: 7,
		activeAccount: "personal1",
		accounts: ["personal1", "school", "personal", "business"].map((name) => ({
			name,
			quotaExhaustedUntil: null,
			weeklyResetAt: null,
		})),
	};
}

function harness(): {
	snapshot: CandidateSnapshot;
	deps: CandidateSelectionDeps;
	verifyCandidate: ReturnType<typeof vi.fn>;
	usages: Map<string, AccountUsageResult>;
} {
	const snapshot: CandidateSnapshot = {
		activeName: "personal1",
		activeCredential: {
			accessToken: "secret-active",
			expiresAt: NOW + 60_000,
			rawDigest: "active-digest",
		},
		store: store(),
		poolAccounts: ["personal1", "school", "personal", "business"],
	};
	const credentials = new Map(
		["school", "personal", "business"].map((name) => [
			name,
			{
				accessToken: `secret-${name}`,
				expiresAt: NOW + 60_000,
			},
		]),
	);
	const usages = new Map<string, AccountUsageResult>([
		["secret-school", usage(10, 20, "2026-09-02T18:00:00.000Z")],
		["secret-personal", usage(10, 20, "2026-09-02T16:00:00.000Z")],
		["secret-business", usage(10, 20, "2026-09-02T17:00:00.000Z")],
	]);
	const verifyCandidate = vi.fn(async () => ({
		fresh: "refreshed" as const,
		expiresAt: NOW + 60_000,
	}));
	return {
		snapshot,
		verifyCandidate,
		usages,
		deps: {
			now: () => NOW,
			withAccountsLock: async (fn) => fn(),
			readSnapshot: async () => snapshot,
			verifyCandidate,
			readPoolCredential: async (name) => credentials.get(name) ?? null,
			fetchUsage: async (token) => usages.get(token) ?? { error: "network" },
			recordObservation: vi.fn(async () => "updated" as const),
		},
	};
}

describe("verifyAndRankCandidates", () => {
	it("ranks the full live pool/store intersection by earliest weekly reset", async () => {
		const h = harness();

		const result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			headroomPolicy: { kind: "prefer_below_trigger", trigger5hPct: 90 },
		});

		expect(result.ranked).toEqual(["personal", "business", "school"]);
		expect(h.verifyCandidate).toHaveBeenCalledTimes(3);
	});

	it("never admits an explicitly requested stale candidate through a legacy freshness bypass", async () => {
		const h = harness();
		h.verifyCandidate.mockResolvedValueOnce({
			fresh: "stale",
			reason: "refresh refused (HTTP 400)",
		});

		const result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			onlyNames: ["business"],
			manualBypass: { freshness: true, quota: false },
			cooldownPolicy: "ignore_explicit_target",
			headroomPolicy: { kind: "explicit_target" },
		});

		expect(result.ranked).toEqual([]);
		expect(result.panorama).toContainEqual(
			expect.objectContaining({
				name: "business",
				excludedBy: "unverifiable",
				status: expect.stringContaining("freshness_stale"),
			}),
		);
	});

	it("never admits quota-unknown candidates through a legacy quota bypass", async () => {
		const h = harness();
		h.usages.set("secret-business", { error: "network" });

		const result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			manualBypass: { freshness: false, quota: true },
			headroomPolicy: { kind: "explicit_target" },
		});

		expect(result.ranked).toEqual(["personal", "school"]);
		expect(result.panorama).toContainEqual(
			expect.objectContaining({
				name: "business",
				excludedBy: "unverifiable",
				status: "usage_network",
			}),
		);
	});

	it("never lets a legacy freshness bypass override auth flags or identity mismatch", async () => {
		const h = harness();
		const business = h.snapshot.store.accounts.find(
			(account) => account.name === "business",
		);
		expect(business).toBeDefined();
		if (!business) return;
		business.authExpired = true;

		let result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			onlyNames: ["business"],
			manualBypass: { freshness: true, quota: false },
			headroomPolicy: { kind: "explicit_target" },
		});
		expect(result.ranked).toEqual([]);
		expect(result.panorama).toContainEqual(
			expect.objectContaining({
				name: "business",
				excludedBy: "auth",
				status: "auth_unusable",
			}),
		);

		business.identityMismatch = {
			actualDigest: "a".repeat(64),
			markedBy: "executor",
			markedAt: new Date(NOW).toISOString(),
		};
		result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			onlyNames: ["business"],
			manualBypass: { freshness: true, quota: false },
			headroomPolicy: { kind: "explicit_target" },
		});
		expect(result.ranked).toEqual([]);
		expect(result.panorama).toContainEqual(
			expect.objectContaining({
				name: "business",
				excludedBy: "auth",
				status: "identity_mismatch",
			}),
		);
	});

	it("returns a stable token-safe reason for every account when the pool is fully unusable", async () => {
		const h = harness();
		h.snapshot.poolAccounts = ["personal1", "school", "business", "shopping"];
		h.verifyCandidate.mockImplementation(async (name) =>
			name === "school"
				? { fresh: "stale" as const, reason: "refresh refused (HTTP 400)" }
				: { fresh: "refreshed" as const, expiresAt: NOW + 60_000 },
		);
		h.usages.set("secret-business", usage(100, 20, "2026-09-02T17:00:00.000Z"));

		const result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			headroomPolicy: { kind: "prefer_below_trigger", trigger5hPct: 90 },
		});

		expect(result.ranked).toEqual([]);
		expect(result.panorama).toEqual([
			expect.objectContaining({ name: "business", excludedBy: "quota" }),
			expect.objectContaining({ name: "personal", excludedBy: "pool" }),
			expect.objectContaining({ name: "school", excludedBy: "unverifiable" }),
			expect.objectContaining({ name: "shopping", status: "not_in_store" }),
		]);
		expect(JSON.stringify(result.panorama)).not.toContain("secret-");
	});

	it("excludes cooldowns normally and records an explicit manual cooldown bypass", async () => {
		const h = harness();
		const business = h.snapshot.store.accounts.find(
			(account) => account.name === "business",
		);
		expect(business).toBeDefined();
		if (!business) return;
		business.switchCooldownUntil = new Date(NOW + 60_000).toISOString();

		let result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			onlyNames: ["business"],
			headroomPolicy: { kind: "explicit_target" },
		});
		expect(result.ranked).toEqual([]);
		expect(result.panorama).toContainEqual(
			expect.objectContaining({
				name: "business",
				excludedBy: "cooldown",
			}),
		);

		result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			onlyNames: ["business"],
			cooldownPolicy: "ignore_explicit_target",
			headroomPolicy: { kind: "explicit_target" },
		});
		expect(result.ranked).toEqual(["business"]);
		expect(result.panorama).toContainEqual(
			expect.objectContaining({
				name: "business",
				bypassed: { cooldown: true },
			}),
		);
	});

	it("admits one live 5h cooldown fallback for a 7d-dominant source", async () => {
		const h = harness();
		const business = h.snapshot.store.accounts.find(
			(account) => account.name === "business",
		);
		expect(business).toBeDefined();
		if (!business) return;
		business.switchCooldownUntil = new Date(NOW + 60_000).toISOString();
		h.usages.set("secret-business", usage(95, 20, "2026-09-02T17:00:00.000Z"));

		const result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			onlyNames: ["business"],
			cooldownPolicy: "fallback_explicit_target",
			cooldownFallbackSourceWindow: "7d",
			headroomPolicy: { kind: "prefer_below_trigger", trigger5hPct: 90 },
		});

		expect(result.ranked).toEqual(["business"]);
		expect(result.cooldownFallbacks).toEqual(["business"]);
		expect(result.panorama).toContainEqual(
			expect.objectContaining({
				name: "business",
				status: "qualified_low_headroom_cooldown_fallback",
				excludedBy: null,
				bypassed: { cooldown: true },
			}),
		);
	});

	it("refuses a cooldown fallback when source and target are both 5h-hot", async () => {
		const h = harness();
		const business = h.snapshot.store.accounts.find(
			(account) => account.name === "business",
		);
		expect(business).toBeDefined();
		if (!business) return;
		business.switchCooldownUntil = "2026-09-01T21:00:00.000Z";
		business.weeklyResetAt = "2026-09-04T21:00:00.000Z";
		h.usages.set("secret-business", usage(95, 20, "2026-09-02T17:00:00.000Z"));

		const result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			onlyNames: ["business"],
			cooldownPolicy: "fallback_explicit_target",
			cooldownFallbackSourceWindow: "5h",
			headroomPolicy: { kind: "prefer_below_trigger", trigger5hPct: 90 },
		});

		expect(result.ranked).toEqual([]);
		expect(result.cooldownFallbacks).toEqual([]);
		expect(result.panorama).toContainEqual(
			expect.objectContaining({
				name: "business",
				status: "cooldown_fallback_same_window",
				excludedBy: "cooldown",
			}),
		);
	});

	it("uses high-5h candidates only when the healthy set is empty", async () => {
		const h = harness();
		h.usages.set("secret-school", usage(95, 20, "2026-09-02T15:00:00.000Z"));
		h.usages.set("secret-business", usage(10, 20, "2026-09-02T18:00:00.000Z"));

		let result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			headroomPolicy: { kind: "prefer_below_trigger", trigger5hPct: 90 },
		});
		expect(result.ranked).toEqual(["personal", "business"]);
		expect(result.headroomDegraded).toBe(false);

		h.usages.set("secret-personal", usage(96, 20, "2026-09-02T16:00:00.000Z"));
		h.usages.set("secret-business", usage(100, 20, "2026-09-02T18:00:00.000Z"));
		result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			headroomPolicy: { kind: "prefer_below_trigger", trigger5hPct: 90 },
		});
		expect(result.ranked).toEqual(["school", "personal"]);
		expect(result.headroomDegraded).toBe(true);
	});

	it("ranks a candidate with no live or ledger weekly reset after a dated candidate", async () => {
		const h = harness();
		h.usages.set("secret-school", usage(10, 20, null));
		h.usages.set("secret-business", usage(10, 20, "not-an-instant"));

		const result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			headroomPolicy: { kind: "prefer_below_trigger", trigger5hPct: 90 },
		});

		expect(result.ranked).toEqual(["personal", "school"]);
		expect(result.panorama).toContainEqual(
			expect.objectContaining({
				name: "school",
				resetClass: "idleUnopened",
			}),
		);
		expect(result.panorama).toContainEqual(
			expect.objectContaining({
				name: "business",
				status: "usage_malformed",
				excludedBy: "unverifiable",
			}),
		);
	});

	it("falls back to the ledger weekly reset when live usage has no reset", async () => {
		const h = harness();
		h.usages.set("secret-school", usage(10, 20, null));
		const school = h.snapshot.store.accounts.find(
			(account) => account.name === "school",
		);
		expect(school).toBeDefined();
		if (!school) return;
		school.weeklyResetAt = "2026-09-02T15:00:00.000Z";

		const result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			headroomPolicy: { kind: "prefer_below_trigger", trigger5hPct: 90 },
		});

		expect(result.ranked).toEqual(["school", "personal", "business"]);
	});

	it("does not fetch quota for stale credentials or after an active-witness race", async () => {
		const h = harness();
		const fetchUsage = vi.fn(h.deps.fetchUsage);
		h.deps.fetchUsage = fetchUsage;
		h.verifyCandidate.mockResolvedValue({
			fresh: "stale",
			reason: "refresh refused (HTTP 400)",
		});

		let result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			onlyNames: ["school"],
			headroomPolicy: { kind: "explicit_target" },
		});
		expect(result.ranked).toEqual([]);
		expect(fetchUsage).not.toHaveBeenCalled();

		h.verifyCandidate.mockResolvedValue({
			fresh: "refreshed",
			expiresAt: NOW + 60_000,
		});
		h.deps.readSnapshot = async () => ({
			...h.snapshot,
			activeName: "school",
			store: { ...h.snapshot.store, generation: 8 },
		});
		result = await verifyAndRankCandidates(h.deps, h.snapshot, {
			onlyNames: ["business"],
			headroomPolicy: { kind: "explicit_target" },
		});
		expect(result.ranked).toEqual([]);
		expect(result.panorama).toContainEqual(
			expect.objectContaining({
				name: "business",
				status: "active_witness_changed",
			}),
		);
		expect(fetchUsage).not.toHaveBeenCalled();
	});
});

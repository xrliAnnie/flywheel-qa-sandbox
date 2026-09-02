import type {
	AccountQuotaObservation,
	AccountStore,
	RecordObservationResult,
} from "./account-store.js";
import {
	inspectModelSetBench,
	isAuthUnusable,
	isSwitchCooldownActive,
} from "./account-store.js";
import type { FreshnessVerdict } from "./freshness.js";
import type { AccountUsageResult } from "./quota-usage-api.js";

export interface CandidateCredential {
	accessToken: string;
	expiresAt: number;
	rawDigest?: string;
}

export interface CandidateSnapshot {
	activeName: string | null;
	store: AccountStore;
	activeCredential: CandidateCredential | null;
	poolAccounts: string[];
}

export interface CandidateSelectionDeps {
	now: () => number;
	withAccountsLock: <T>(fn: () => Promise<T>) => Promise<T>;
	readSnapshot: () => Promise<CandidateSnapshot>;
	verifyCandidate: (
		name: string,
		activeName: string | null,
	) => Promise<FreshnessVerdict>;
	readPoolCredential: (name: string) => Promise<CandidateCredential | null>;
	fetchUsage: (accessToken: string) => Promise<AccountUsageResult>;
	recordObservation: (
		name: string,
		observation: AccountQuotaObservation,
		expectedGeneration: number,
	) => Promise<RecordObservationResult>;
}

export type CandidateExclusion =
	| "cooldown"
	| "auth"
	| "quota"
	| "unverifiable"
	| "model"
	| "pool"
	| null;

type SuccessfulUsage = Extract<AccountUsageResult, { ok: unknown }>["ok"];

export interface CandidatePanoramaEntry {
	name: string;
	status: string;
	excludedBy: CandidateExclusion;
	usage?: SuccessfulUsage;
	resetClass?: "idleUnopened" | "dated" | "resetUnknown";
	bypassed?: { cooldown: true };
}

export interface CandidateSelectionOptions {
	models?: readonly string[];
	onlyNames?: readonly string[];
	cooldownPolicy?: "exclude" | "ignore_explicit_target";
	headroomPolicy?:
		| { kind: "prefer_below_trigger"; trigger5hPct: number }
		| { kind: "explicit_target" };
}

export interface CandidateSelectionResult {
	ranked: string[];
	panorama: CandidatePanoramaEntry[];
	usageByName: Map<string, SuccessfulUsage>;
	malformedModelBenches: string[];
	verifiedAt: string;
	headroomDegraded: boolean;
}

type RankedCandidate = {
	name: string;
	resetMs: number;
};

function activeWitnessMatches(
	expected: CandidateSnapshot,
	actual: CandidateSnapshot,
): boolean {
	if (
		expected.activeName === null ||
		actual.activeName === null ||
		expected.activeName !== actual.activeName ||
		expected.store.generation !== actual.store.generation
	) {
		return false;
	}
	if (
		expected.activeCredential?.rawDigest !== undefined &&
		actual.activeCredential?.rawDigest !== undefined
	) {
		return (
			expected.activeCredential.rawDigest === actual.activeCredential.rawDigest
		);
	}
	return (
		expected.activeCredential?.accessToken ===
		actual.activeCredential?.accessToken
	);
}

async function readVerifiedCredential(
	deps: CandidateSelectionDeps,
	snapshot: CandidateSnapshot,
	name: string,
): Promise<
	{ credential: CandidateCredential } | { credential: null; reason: string }
> {
	return deps.withAccountsLock(async () => {
		const witness = await deps.readSnapshot();
		if (!activeWitnessMatches(snapshot, witness)) {
			return { credential: null, reason: "active_witness_changed" };
		}
		if (witness.activeName === name) {
			return { credential: null, reason: "became_active" };
		}
		const verdict = await deps.verifyCandidate(name, witness.activeName);
		if (verdict.fresh === "stale") {
			return {
				credential: null,
				reason: `freshness_stale: ${verdict.reason}`,
			};
		}
		const credential = await deps.readPoolCredential(name);
		return credential === null
			? { credential: null, reason: "credential_missing" }
			: { credential };
	});
}

function rank(candidates: RankedCandidate[]): string[] {
	return [...candidates]
		.sort(
			(a, b) => a.resetMs - b.resetMs || a.name.localeCompare(b.name, "en-US"),
		)
		.map((candidate) => candidate.name);
}

export async function verifyAndRankCandidates(
	deps: CandidateSelectionDeps,
	snapshot: CandidateSnapshot,
	options: CandidateSelectionOptions = {},
): Promise<CandidateSelectionResult> {
	const now = deps.now();
	const verifiedAt = new Date(now).toISOString();
	const pool = new Set(snapshot.poolAccounts);
	const only =
		options.onlyNames === undefined ? null : new Set(options.onlyNames);
	const panorama: CandidatePanoramaEntry[] = [];
	const usageByName = new Map<string, SuccessfulUsage>();
	const malformedModelBenches: string[] = [];
	const healthy: RankedCandidate[] = [];
	const highFiveH: RankedCandidate[] = [];

	const accountsByName = new Map(
		snapshot.store.accounts.map((entry) => [entry.name, entry]),
	);
	const candidateNames = [...new Set([...accountsByName.keys(), ...pool])].sort(
		(a, b) => a.localeCompare(b, "en-US"),
	);
	for (const name of candidateNames) {
		if (name === snapshot.activeName || (only !== null && !only.has(name))) {
			continue;
		}
		const entry = accountsByName.get(name);
		if (entry === undefined) {
			panorama.push({ name, status: "not_in_store", excludedBy: "pool" });
			continue;
		}
		if (!pool.has(name)) {
			panorama.push({ name, status: "not_in_pool", excludedBy: "pool" });
			continue;
		}
		if (entry.identityMismatch !== undefined) {
			panorama.push({
				name,
				status: "identity_mismatch",
				excludedBy: "auth",
			});
			continue;
		}
		if (isAuthUnusable(entry)) {
			panorama.push({ name, status: "auth_unusable", excludedBy: "auth" });
			continue;
		}
		const cooldownActive = isSwitchCooldownActive(entry, now);
		const cooldownBypassed =
			cooldownActive &&
			options.cooldownPolicy === "ignore_explicit_target" &&
			only?.size === 1 &&
			only.has(name);
		if (cooldownActive && !cooldownBypassed) {
			panorama.push({
				name,
				status: "switch_cooldown",
				excludedBy: "cooldown",
			});
			continue;
		}
		const modelBench = inspectModelSetBench(entry, options.models ?? [], now);
		if (modelBench.state === "malformed") {
			malformedModelBenches.push(name);
			panorama.push({
				name,
				status: `model_bench_malformed: ${modelBench.reason}`,
				excludedBy: "model",
			});
			continue;
		}
		if (modelBench.state === "benched") {
			panorama.push({
				name,
				status: `model_benched_until=${modelBench.retryAt}`,
				excludedBy: "model",
			});
			continue;
		}

		const checked = await readVerifiedCredential(deps, snapshot, name);
		if (checked.credential === null) {
			panorama.push({
				name,
				status: checked.reason,
				excludedBy: "unverifiable",
			});
			continue;
		}
		const usage = await deps.fetchUsage(checked.credential.accessToken);
		if (!("ok" in usage)) {
			panorama.push({
				name,
				status: `usage_${usage.error}`,
				excludedBy: "unverifiable",
			});
			continue;
		}
		await deps.recordObservation(
			name,
			{
				fiveHPct: usage.ok.fiveH.pct,
				sevenDPct: usage.ok.sevenD.pct,
				fiveHResetAt: usage.ok.fiveH.resetsAt,
				sevenDResetAt: usage.ok.sevenD.resetsAt,
				observedAt: verifiedAt,
			},
			snapshot.store.generation,
		);
		usageByName.set(name, usage.ok);
		if (usage.ok.fiveH.pct >= 100 || usage.ok.sevenD.pct >= 100) {
			panorama.push({
				name,
				status: "quota_exhausted",
				excludedBy: "quota",
				usage: usage.ok,
			});
			continue;
		}
		const effectiveResetAt = usage.ok.sevenD.resetsAt ?? entry.weeklyResetAt;
		const resetMs =
			effectiveResetAt == null
				? Number.POSITIVE_INFINITY
				: Date.parse(effectiveResetAt);
		if (!Number.isFinite(resetMs) && resetMs !== Number.POSITIVE_INFINITY) {
			panorama.push({
				name,
				status: "usage_malformed",
				excludedBy: "unverifiable",
			});
			continue;
		}
		const isHighFiveH =
			options.headroomPolicy?.kind === "prefer_below_trigger" &&
			usage.ok.fiveH.pct >= options.headroomPolicy.trigger5hPct;
		panorama.push({
			name,
			status: isHighFiveH ? "qualified_low_headroom" : "qualified",
			excludedBy: null,
			usage: usage.ok,
			...(cooldownBypassed
				? {
						bypassed: { cooldown: true as const },
					}
				: {}),
			resetClass: usage.ok.sevenD.resetsAt === null ? "idleUnopened" : "dated",
		});
		(isHighFiveH ? highFiveH : healthy).push({ name, resetMs });
	}

	const headroomDegraded = healthy.length === 0 && highFiveH.length > 0;
	return {
		ranked: rank(headroomDegraded ? highFiveH : healthy),
		panorama,
		usageByName,
		malformedModelBenches,
		verifiedAt,
		headroomDegraded,
	};
}

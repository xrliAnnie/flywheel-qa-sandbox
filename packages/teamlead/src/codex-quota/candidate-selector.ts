/** Times in observations are milliseconds. Only the protocol parser accepts seconds. */
export interface CodexQuotaWindow {
	usedPercent: number;
	resetsAt: number | null;
}
export interface CodexQuotaObservation {
	profile: string;
	accountKey: string;
	observedAt: number;
	identityVerified: boolean;
	authHealth:
		| "valid"
		| "refresh_invalid"
		| "in_use_unshared"
		| "missing"
		| "unknown";
	windows: CodexQuotaWindow[];
	scopeKnown: boolean;
	reached?: boolean;
	lastRefresh?: string;
	/** Digest only; distinguishes newly retained credential evidence from a clock-only reread. */
	credentialFingerprint?: string;
}

import { isCodexSlotName } from "flywheel-claude-runner/bin/codex-account-core.mjs";

const record = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
export function parseCodexRateLimits(
	value: unknown,
	limitId: string,
	now: number,
): { windows: CodexQuotaWindow[]; scopeKnown: boolean } {
	const unknown = { windows: [], scopeKnown: false };
	if (!record(value)) return unknown;
	const bucket = record(value.rateLimitsByLimitId)
		? value.rateLimitsByLimitId[limitId]
		: value.rateLimits;
	if (!record(bucket) || (bucket.limitId != null && bucket.limitId !== limitId))
		return unknown;
	const windows: CodexQuotaWindow[] = [];
	for (const name of ["primary", "secondary"]) {
		const w = bucket[name];
		if (w == null) continue;
		if (
			!record(w) ||
			!Number.isInteger(w.usedPercent) ||
			(w.usedPercent as number) < 0 ||
			(w.usedPercent as number) > 100
		)
			return unknown;
		let resetsAt: number | null = null;
		if (w.resetsAt != null) {
			if (
				typeof w.resetsAt !== "number" ||
				!Number.isSafeInteger(w.resetsAt) ||
				w.resetsAt < 946684800 ||
				w.resetsAt * 1000 > now + 366 * 86400_000
			)
				return unknown;
			resetsAt = w.resetsAt * 1000;
		}
		windows.push({ usedPercent: w.usedPercent as number, resetsAt });
	}
	return { windows, scopeKnown: true };
}
export interface CodexCandidateSelection {
	kind:
		| "selected"
		| "pool_exhausted"
		| "no_usable_credentials"
		| "observation_unavailable";
	candidate?: CodexQuotaObservation;
	nextAttemptAt?: number;
}
/**
 * FLY-2869: every exhausted window reports a reset that has already passed, so
 * the 100% no longer holds. Such an account is a candidate that must pass the
 * real `codex exec` probe in rotate() before it is installed. A reset of null,
 * or any exhausted window still in the future, keeps the account limited.
 */
export function codexObservationResetElapsed(
	o: Pick<CodexQuotaObservation, "windows">,
	now: number,
): boolean {
	const exhausted = o.windows.filter((w) => w.usedPercent === 100);
	return (
		exhausted.length > 0 &&
		exhausted.every(
			(w) =>
				w.resetsAt !== null && Number.isFinite(w.resetsAt) && w.resetsAt <= now,
		)
	);
}
/**
 * The observation the selector judges for each pool profile: that profile's
 * latest reading (older history and profiles outside the pool are ignored).
 * FLY-2830: the pool-exhausted alert snapshot is built from exactly this proof.
 */
export function latestPoolObservations(
	observations: readonly CodexQuotaObservation[],
	pool: readonly string[],
): (CodexQuotaObservation | undefined)[] {
	return pool.map(
		(p) =>
			observations
				.filter((o) => o.profile === p)
				.sort((a, b) => b.observedAt - a.observedAt)[0],
	);
}

export function selectCodexQuotaCandidate(
	observations: readonly CodexQuotaObservation[],
	options: {
		now: number;
		pool: readonly string[];
		excludedProfiles?: readonly string[];
	},
): CodexCandidateSelection {
	const { now } = options;
	if (!Array.isArray(options.pool)) throw new Error("invalid_codex_quota_pool");
	if (options.pool.length === 0) return { kind: "no_usable_credentials" };
	if (
		!options.pool.every(isCodexSlotName) ||
		new Set(options.pool).size !== options.pool.length
	)
		throw new Error("invalid_codex_quota_pool");
	const pool = latestPoolObservations(observations, options.pool);
	const fresh = (o: CodexQuotaObservation) =>
		Number.isFinite(o.observedAt) &&
		o.observedAt <= now &&
		now - o.observedAt <= 60_000;
	const valid = (o: CodexQuotaObservation) =>
		o.identityVerified && o.authHealth === "valid";
	// A past reset is only meaningful on an exhausted window (FLY-2869); on any
	// other window it still makes the observation untrustworthy.
	const windowsValid = (o: CodexQuotaObservation) =>
		o.windows.every(
			(w) =>
				Number.isInteger(w.usedPercent) &&
				w.usedPercent >= 0 &&
				w.usedPercent <= 100 &&
				(w.resetsAt === null ||
					(Number.isFinite(w.resetsAt) &&
						(w.resetsAt > now || w.usedPercent === 100))),
		);
	const resetElapsed = (o: CodexQuotaObservation) =>
		codexObservationResetElapsed(o, now);
	// `reached` comes from the same snapshot as the windows, so it is stale too
	// once every exhausted window has reset.
	const limited = (o: CodexQuotaObservation) =>
		(o.reached === true || o.windows.some((w) => w.usedPercent === 100)) &&
		!resetElapsed(o);
	const eligible = pool.filter(
		(o): o is CodexQuotaObservation =>
			!!o &&
			valid(o) &&
			fresh(o) &&
			windowsValid(o) &&
			!limited(o) &&
			!options.excludedProfiles?.includes(o.profile),
	);
	const known = eligible.filter(
		(o) => o.scopeKnown && o.windows.length > 0 && !resetElapsed(o),
	);
	const probeRequired = eligible
		.filter((o) => o.scopeKnown && o.windows.length > 0 && resetElapsed(o))
		.sort((a, b) =>
			a.profile < b.profile ? -1 : a.profile > b.profile ? 1 : 0,
		);
	if (!known.length && probeRequired[0])
		return { kind: "selected", candidate: probeRequired[0] };
	const candidates = known.length
		? known
		: eligible.filter((o) => o.windows.length === 0 || !o.scopeKnown);
	const reset = (o: CodexQuotaObservation) =>
		Math.min(
			...o.windows.flatMap((w) => (w.resetsAt === null ? [] : [w.resetsAt])),
		);
	const remaining = (o: CodexQuotaObservation) =>
		o.windows.length
			? Math.min(...o.windows.map((w) => 100 - w.usedPercent))
			: -1;
	candidates.sort(
		(a, b) =>
			reset(a) - reset(b) ||
			remaining(b) - remaining(a) ||
			(a.profile < b.profile ? -1 : a.profile > b.profile ? 1 : 0),
	);
	if (candidates[0]) return { kind: "selected", candidate: candidates[0] };
	if (
		pool.every(
			(o) =>
				o &&
				valid(o) &&
				fresh(o) &&
				o.scopeKnown &&
				windowsValid(o) &&
				limited(o),
		)
	) {
		const recoveries = pool.map((o) => {
			const exhausted = o!.windows.filter((w) => w.usedPercent === 100);
			return !exhausted.length || exhausted.some((w) => w.resetsAt === null)
				? now + 60_000
				: Math.max(...exhausted.map((w) => w.resetsAt!));
		});
		return { kind: "pool_exhausted", nextAttemptAt: Math.min(...recoveries) };
	}
	return {
		kind: pool.some(
			(o) =>
				!o ||
				["missing", "refresh_invalid", "in_use_unshared"].includes(
					o.authHealth,
				),
		)
			? "no_usable_credentials"
			: "observation_unavailable",
		nextAttemptAt: now + 60_000,
	};
}

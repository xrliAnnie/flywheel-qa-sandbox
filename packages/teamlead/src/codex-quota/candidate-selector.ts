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
const profiles = ["school", "personal", "business"];
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
export function selectCodexQuotaCandidate(
	observations: readonly CodexQuotaObservation[],
	options: { now: number; excludedProfiles?: readonly string[] },
): CodexCandidateSelection {
	const { now } = options;
	const pool = profiles.map(
		(p) =>
			observations
				.filter((o) => o.profile === p)
				.sort((a, b) => b.observedAt - a.observedAt)[0],
	);
	const fresh = (o: CodexQuotaObservation) =>
		Number.isFinite(o.observedAt) &&
		o.observedAt <= now &&
		now - o.observedAt <= 60_000;
	const valid = (o: CodexQuotaObservation) =>
		o.identityVerified && o.authHealth === "valid";
	const windowsValid = (o: CodexQuotaObservation) =>
		o.windows.every(
			(w) =>
				Number.isInteger(w.usedPercent) &&
				w.usedPercent >= 0 &&
				w.usedPercent <= 100 &&
				(w.resetsAt === null ||
					(Number.isFinite(w.resetsAt) && w.resetsAt > now)),
		);
	const limited = (o: CodexQuotaObservation) =>
		o.reached === true || o.windows.some((w) => w.usedPercent === 100);
	const eligible = pool.filter(
		(o): o is CodexQuotaObservation =>
			!!o &&
			valid(o) &&
			fresh(o) &&
			windowsValid(o) &&
			!limited(o) &&
			!options.excludedProfiles?.includes(o.profile),
	);
	const known = eligible.filter((o) => o.scopeKnown && o.windows.length > 0);
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

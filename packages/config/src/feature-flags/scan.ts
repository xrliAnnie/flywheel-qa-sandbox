import type { FeatureFlagSpec } from "./registry.js";
import type { FlagValueClock, FlagView } from "./resolve.js";

/** Annie explicitly chose a fixed weekly cadence. This is intentionally not configurable. */
export const FLAG_SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;

export type FlagIndeterminateClass =
	| "read_unavailable"
	| "observed_instability";

export type FlagSample =
	| { kind: "value"; canonical: string }
	| {
			kind: "indeterminate";
			class: FlagIndeterminateClass;
			reason: string;
	  };

export interface FlagScanState {
	flagName: string;
	canonical: string | null;
	streakStartedAt: number | null;
	streakSamples: number;
	lastSampledAt: number;
	indeterminateStreak: number;
	indeterminateClass: FlagIndeterminateClass | null;
	lastRetiringIssue: string | null;
	askCount: number;
	lastAskedRunId: number | null;
}

/** Independent stability clock for one resolved flag scope. */
export interface FlagScanScopeState {
	flagName: string;
	scope: string;
	canonical: string | null;
	streakStartedAt: number | null;
	streakSamples: number;
	lastSampledAt: number;
}

export interface FlagKeepAnchor {
	flagName: string;
	anchorCanonical: string;
	boundRunToken: string;
	decidedAt: string;
}

export interface ResolvedFlagKeepBinding {
	runToken: string;
	canonical: string;
	decidedAt: string;
}

export interface FlagScanCandidate {
	flagName: string;
	canonical: string;
	stableForMs: number;
	askPhrase: string;
	reason: string | null;
	previousAskCount: number;
}

export interface FlagScanNoClock {
	flagName: string;
	class: FlagIndeterminateClass;
	reason: string;
	indeterminateStreak: number;
}

export interface FlagScanClaimed {
	flagName: string;
	retiringIssue: string;
}

export interface FlagScanKeepUnbound {
	flagName: string;
	reason: string;
}

export interface FlagDeparture {
	flagName: string;
	kind: "feature_removed" | "governance_cleared";
}

export interface ProposedFlagScan {
	nextState: FlagScanState[];
	nextScopeState: FlagScanScopeState[];
	nextAnchors: FlagKeepAnchor[];
	candidates: FlagScanCandidate[];
	claimed: FlagScanClaimed[];
	noClock: FlagScanNoClock[];
	keepUnbound: FlagScanKeepUnbound[];
	departures: FlagDeparture[];
}

export interface ComputeFlagScanInput {
	rows: Array<{ spec: FeatureFlagSpec; view: FlagView }>;
	expectedProjectNames: string[];
	prevState: FlagScanState[];
	prevScopeState: FlagScanScopeState[];
	anchors: FlagKeepAnchor[];
	keepBindings: Map<string, ResolvedFlagKeepBinding | "unbound">;
	now: number;
}

function indeterminate(
	className: FlagIndeterminateClass,
	reason: string,
): FlagSample {
	return { kind: "indeterminate", class: className, reason };
}

function exactStringSet(actual: string[], expected: string[]): boolean {
	if (actual.length !== expected.length) return false;
	const actualSorted = [...actual].sort();
	const expectedSorted = [...expected].sort();
	return actualSorted.every((value, index) => value === expectedSorted[index]);
}

/**
 * Turn the resolver's secret-free view into the exact value whose stability is
 * governed. It deliberately consumes the resolved/effective value, never an
 * individual config source.
 */
export function canonicalizeFlagSample(
	spec: FeatureFlagSpec,
	view: FlagView,
	expectedProjectNames: string[] = [],
): FlagSample {
	if (spec.name !== view.name) {
		return indeterminate(
			"read_unavailable",
			`registry/view name mismatch: ${spec.name} != ${view.name}`,
		);
	}
	if (spec.dormant || view.dormant) {
		return { kind: "value", canonical: JSON.stringify({ k: "dormant" }) };
	}
	if (view.error) {
		return indeterminate("observed_instability", view.error);
	}
	if (view.divergence) {
		return indeterminate(
			view.divergence === "source_unavailable"
				? "read_unavailable"
				: "observed_instability",
			`resolved sources diverged: ${view.divergence}`,
		);
	}

	if (spec.scope === "bridge_global") {
		const effective = view.displayEffective ?? view.effective;
		if (effective === undefined) {
			return indeterminate(
				"read_unavailable",
				"resolved Bridge value is unavailable",
			);
		}
		return {
			kind: "value",
			canonical: JSON.stringify({ k: spec.valueKind, v: effective }),
		};
	}

	const rows = view.effectiveByProject ?? [];
	if (expectedProjectNames.length === 0) {
		return indeterminate(
			"read_unavailable",
			"resolved project roster is unavailable",
		);
	}
	const rowNames = rows.map((row) => row.projectName);
	if (
		new Set(rowNames).size !== rowNames.length ||
		new Set(expectedProjectNames).size !== expectedProjectNames.length ||
		!exactStringSet(rowNames, expectedProjectNames)
	) {
		return indeterminate(
			"read_unavailable",
			`project roster mismatch: expected ${JSON.stringify(
				expectedProjectNames,
			)}, got ${JSON.stringify(rowNames)}`,
		);
	}
	for (const row of rows) {
		if (row.error) {
			return indeterminate(
				"read_unavailable",
				`${row.projectName}: ${row.error}`,
			);
		}
		if (row.value === undefined) {
			return indeterminate(
				"read_unavailable",
				`${row.projectName}: resolved value is unavailable`,
			);
		}
	}
	const values = rows
		.map((row) => [row.projectName, row.value] as const)
		.sort(([left], [right]) => left.localeCompare(right));
	return {
		kind: "value",
		canonical: JSON.stringify({ k: spec.valueKind, v: values }),
	};
}

function emptyState(flagName: string): FlagScanState {
	return {
		flagName,
		canonical: null,
		streakStartedAt: null,
		streakSamples: 0,
		lastSampledAt: 0,
		indeterminateStreak: 0,
		indeterminateClass: null,
		lastRetiringIssue: null,
		askCount: 0,
		lastAskedRunId: null,
	};
}

function emptyScopeState(flagName: string, scope: string): FlagScanScopeState {
	return {
		flagName,
		scope,
		canonical: null,
		streakStartedAt: null,
		streakSamples: 0,
		lastSampledAt: 0,
	};
}

function advanceScopeState(
	previous: FlagScanScopeState,
	canonical: string,
	now: number,
): FlagScanScopeState {
	if (canonical === previous.canonical) {
		return {
			...previous,
			streakSamples: previous.streakSamples + 1,
			lastSampledAt: now,
		};
	}
	return {
		...previous,
		canonical,
		streakStartedAt: now,
		streakSamples: 1,
		lastSampledAt: now,
	};
}

function advanceState(
	previous: FlagScanState,
	sample: FlagSample,
	now: number,
	retiringIssue: string | undefined,
): FlagScanState {
	const common = {
		...previous,
		lastSampledAt: now,
		lastRetiringIssue: retiringIssue ?? previous.lastRetiringIssue,
	};
	if (sample.kind === "indeterminate") {
		return {
			...common,
			...(sample.class === "observed_instability"
				? { canonical: null, streakStartedAt: null, streakSamples: 0 }
				: {}),
			indeterminateStreak: previous.indeterminateStreak + 1,
			indeterminateClass: sample.class,
		};
	}
	if (sample.canonical === previous.canonical) {
		return {
			...common,
			streakSamples: previous.streakSamples + 1,
			indeterminateStreak: 0,
			indeterminateClass: null,
		};
	}
	return {
		...common,
		canonical: sample.canonical,
		streakStartedAt: now,
		streakSamples: 1,
		indeterminateStreak: 0,
		indeterminateClass: null,
	};
}

function askPhrase(spec: FeatureFlagSpec, canonical: string): string {
	let value: unknown;
	try {
		value = (JSON.parse(canonical) as { v?: unknown }).v;
	} catch {
		value = undefined;
	}
	if (spec.valueKind === "bool") {
		return value === true
			? "bake in（写死成默认行为）+ 删掉这个 flag?"
			: "删掉这个 flag?";
	}
	if (spec.valueKind === "enum") {
		return "选一个赢的 branch 留下，删其余分支 + 删 flag?";
	}
	return `把它写死成当前值 ${JSON.stringify(value)} + 删 flag?`;
}

function assertInputJoin(rows: ComputeFlagScanInput["rows"]): void {
	const names = new Set<string>();
	for (const row of rows) {
		if (row.spec.name !== row.view.name) {
			throw new Error(
				`flag scan registry/view join mismatch: ${row.spec.name} != ${row.view.name}`,
			);
		}
		if (names.has(row.spec.name)) {
			throw new Error(`duplicate flag scan row: ${row.spec.name}`);
		}
		names.add(row.spec.name);
	}
}

type StableClockResolution =
	| { kind: "ready"; stableSince: number }
	| { kind: "legacy"; stableSince: number }
	| { kind: "sampling"; stableSince: null }
	| { kind: "no_clock"; stableSince: number | null; reason: string }
	| { kind: "invalid"; reason: string };

function validClockTime(value: number, now: number): boolean {
	return Number.isSafeInteger(value) && value >= 0 && value <= now;
}

function validateClocks(
	clocks: FlagValueClock[],
	now: number,
): { byScope: Map<string, FlagValueClock>; error?: string } {
	const byScope = new Map<string, FlagValueClock>();
	for (const clock of clocks) {
		if (!clock.scopeKey || byScope.has(clock.scopeKey)) {
			return {
				byScope,
				error: `duplicate or empty value clock scope: ${clock.scopeKey || "<empty>"}`,
			};
		}
		if (
			!validClockTime(clock.firstRegisteredAt, now) ||
			(clock.valueLastChanged !== null &&
				!validClockTime(clock.valueLastChanged, now))
		) {
			return { byScope, error: `invalid value clock time: ${clock.scopeKey}` };
		}
		byScope.set(clock.scopeKey, clock);
	}
	return { byScope };
}

function clocksForSpec(
	spec: FeatureFlagSpec,
	view: FlagView,
	expectedProjectNames: string[],
	now: number,
): { clocks?: FlagValueClock[]; error?: string } {
	const clocks = view.valueClocks ?? [];
	if (clocks.length === 0) return { clocks: [] };
	const validated = validateClocks(clocks, now);
	if (validated.error) return { error: validated.error };
	if (spec.scope !== "project") {
		if (validated.byScope.size !== 1 || !validated.byScope.has("*")) {
			return { error: "Bridge-global value clock requires exactly scope *" };
		}
		return { clocks: [validated.byScope.get("*")!] };
	}
	const star = validated.byScope.get("*");
	const resolved: FlagValueClock[] = [];
	for (const projectName of expectedProjectNames) {
		const clock = validated.byScope.get(projectName) ?? star;
		if (!clock) {
			return { error: `missing value clock scope for project ${projectName}` };
		}
		resolved.push(clock);
	}
	return { clocks: resolved };
}

function resolveStableClock(input: {
	spec: FeatureFlagSpec;
	view: FlagView;
	advanced: FlagScanState;
	expectedProjectNames: string[];
	now: number;
}): StableClockResolution {
	const selected = clocksForSpec(
		input.spec,
		input.view,
		input.expectedProjectNames,
		input.now,
	);
	if (selected.error) return { kind: "invalid", reason: selected.error };
	const clocks = selected.clocks ?? [];
	if (input.view.clockReadiness === "ready") {
		if (clocks.length === 0) {
			return { kind: "invalid", reason: "ready value clock rows are missing" };
		}
		if (clocks.some((clock) => clock.readiness !== "ready")) {
			return {
				kind: "invalid",
				reason: "ready value clock contains no-clock row",
			};
		}
		return {
			kind: "ready",
			stableSince: Math.max(
				...clocks.map((clock) =>
					Math.max(
						clock.firstRegisteredAt,
						clock.valueLastChanged ?? clock.firstRegisteredAt,
					),
				),
			),
		};
	}

	const readiness = input.view.clockReadiness;
	const explicitlyNoClock = readiness?.startsWith("no_clock:") === true;
	if (explicitlyNoClock) {
		if (input.advanced.streakStartedAt === null) {
			return {
				kind: "no_clock",
				stableSince: null,
				reason: `${readiness}; scanner streak is missing its start time`,
			};
		}
		if (input.advanced.streakSamples < 2) {
			return { kind: "sampling", stableSince: null };
		}
		const registeredAt = clocks.length
			? Math.max(...clocks.map((clock) => clock.firstRegisteredAt))
			: null;
		return {
			kind: "legacy",
			stableSince:
				registeredAt === null
					? input.advanced.streakStartedAt
					: Math.max(registeredAt, input.advanced.streakStartedAt),
		};
	}

	if (clocks.length > 0) {
		return {
			kind: "invalid",
			reason: "value clock rows exist without clock readiness",
		};
	}
	if (
		input.advanced.streakSamples >= 2 &&
		input.advanced.streakStartedAt !== null
	) {
		return { kind: "legacy", stableSince: input.advanced.streakStartedAt };
	}
	return { kind: "legacy", stableSince: input.now };
}

export function computeFlagScan(input: ComputeFlagScanInput): ProposedFlagScan {
	assertInputJoin(input.rows);
	const currentNames = new Set(input.rows.map(({ spec }) => spec.name));
	const previousByName = new Map(
		input.prevState.map((row) => [row.flagName, row]),
	);
	const previousScopeByKey = new Map(
		input.prevScopeState.map((row) => [
			`${row.flagName}\u0000${row.scope}`,
			row,
		]),
	);
	const anchorByName = new Map(
		input.anchors
			.filter((anchor) => currentNames.has(anchor.flagName))
			.map((anchor) => [anchor.flagName, anchor]),
	);

	const departures = input.prevState
		.filter((row) => !currentNames.has(row.flagName))
		.map((row) => ({
			flagName: row.flagName,
			kind: row.lastRetiringIssue
				? ("governance_cleared" as const)
				: ("feature_removed" as const),
		}));
	const nextState: FlagScanState[] = [];
	const nextScopeState: FlagScanScopeState[] = [];
	const candidates: FlagScanCandidate[] = [];
	const claimed: FlagScanClaimed[] = [];
	const noClock: FlagScanNoClock[] = [];
	const keepUnbound: FlagScanKeepUnbound[] = [];

	for (const { spec, view } of input.rows) {
		const previous = previousByName.get(spec.name) ?? emptyState(spec.name);
		const sample = canonicalizeFlagSample(
			spec,
			view,
			input.expectedProjectNames,
		);
		const advanced = advanceState(previous, sample, input.now, spec.retiring);
		nextState.push(advanced);

		let scopes =
			spec.scope === "bridge_global" ? ["*"] : input.expectedProjectNames;
		if (spec.scope === "project" && scopes.length === 0) {
			scopes = input.prevScopeState
				.filter((row) => row.flagName === spec.name)
				.map((row) => row.scope);
		}
		scopes = [...new Set(scopes)];
		const projectRows = new Map(
			(view.effectiveByProject ?? []).map((row) => [row.projectName, row]),
		);
		for (const scope of scopes) {
			const key = `${spec.name}\u0000${scope}`;
			const previousScope =
				previousScopeByKey.get(key) ?? emptyScopeState(spec.name, scope);
			if (sample.kind === "indeterminate") {
				nextScopeState.push(previousScope);
				continue;
			}
			let canonical = sample.canonical;
			if (spec.scope === "project" && !spec.dormant && !view.dormant) {
				const value = projectRows.get(scope)?.value;
				if (value === undefined) {
					nextScopeState.push(previousScope);
					continue;
				}
				canonical = JSON.stringify({ k: spec.valueKind, v: value });
			}
			nextScopeState.push(
				advanceScopeState(previousScope, canonical, input.now),
			);
		}

		if (spec.retiring) {
			claimed.push({ flagName: spec.name, retiringIssue: spec.retiring });
			continue;
		}

		let keepChangedReason: string | null = null;
		if (spec.longTermKeep === true) {
			const binding = input.keepBindings.get(spec.name);
			if (!binding || binding === "unbound") {
				keepUnbound.push({
					flagName: spec.name,
					reason: "longTermKeep 缺少可验证的 flag-scan 候选绑定，不能静默豁免",
				});
				continue;
			}
			let anchor = anchorByName.get(spec.name);
			if (!anchor || anchor.boundRunToken !== binding.runToken) {
				anchor = {
					flagName: spec.name,
					anchorCanonical: binding.canonical,
					boundRunToken: binding.runToken,
					decidedAt: binding.decidedAt,
				};
				anchorByName.set(spec.name, anchor);
			}
			if (
				sample.kind === "value" &&
				sample.canonical === anchor.anchorCanonical
			) {
				continue;
			}
			keepChangedReason = `Annie ${anchor.decidedAt} 答过「留」，但解析后的生效值后来变了`;
		}

		if (sample.kind === "indeterminate") {
			noClock.push({
				flagName: spec.name,
				class: sample.class,
				reason: sample.reason,
				indeterminateStreak: advanced.indeterminateStreak,
			});
			continue;
		}
		const clock = resolveStableClock({
			spec,
			view,
			advanced,
			expectedProjectNames: input.expectedProjectNames,
			now: input.now,
		});
		if (clock.kind === "invalid" || clock.kind === "no_clock") {
			noClock.push({
				flagName: spec.name,
				class: "read_unavailable",
				reason: clock.reason,
				indeterminateStreak: advanced.indeterminateStreak,
			});
		}
		if (
			clock.kind !== "invalid" &&
			clock.stableSince !== null &&
			input.now - clock.stableSince >= FLAG_SCAN_INTERVAL_MS
		) {
			candidates.push({
				flagName: spec.name,
				canonical: sample.canonical,
				stableForMs: input.now - clock.stableSince,
				askPhrase: askPhrase(spec, sample.canonical),
				reason: keepChangedReason,
				previousAskCount: advanced.askCount,
			});
		}
	}

	return {
		nextState,
		nextScopeState: nextScopeState.sort(
			(left, right) =>
				left.flagName.localeCompare(right.flagName) ||
				left.scope.localeCompare(right.scope),
		),
		nextAnchors: [...anchorByName.values()].sort((left, right) =>
			left.flagName.localeCompare(right.flagName),
		),
		candidates,
		claimed,
		noClock,
		keepUnbound,
		departures,
	};
}

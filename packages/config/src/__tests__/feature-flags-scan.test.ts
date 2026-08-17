import { describe, expect, it } from "vitest";
import type { FeatureFlagSpec } from "../feature-flags/registry.js";
import type { FlagView } from "../feature-flags/resolve.js";
import {
	canonicalizeFlagSample,
	computeFlagScan,
	FLAG_SCAN_INTERVAL_MS,
	type FlagKeepAnchor,
	type FlagScanState,
} from "../feature-flags/scan.js";

const DAY = 24 * 60 * 60 * 1_000;

function flagSpec(
	name: string,
	overrides: Partial<FeatureFlagSpec> = {},
): FeatureFlagSpec {
	return {
		name,
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: `TEST_${name.toUpperCase()}`,
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: `${name} description`,
		readSites: [
			{
				file: "test.ts",
				symbol: "test",
				pattern: "process.env",
				timing: "call_time",
			},
		],
		toggleable: "readonly",
		...overrides,
	};
}

function flagView(
	spec: FeatureFlagSpec,
	overrides: Partial<FlagView> = {},
): FlagView {
	return {
		name: spec.name,
		category: spec.category,
		description: spec.description,
		toggleable: spec.toggleable,
		valueKind: spec.valueKind,
		scope: spec.scope,
		source: spec.source,
		envVar: spec.envVar,
		configKey: spec.configKey,
		readTimings: spec.readSites.map((site) => site.timing),
		enumValues: spec.enumValues,
		default: spec.default,
		effective: spec.default,
		displayEffective: spec.default,
		...overrides,
	};
}

function state(
	flagName: string,
	overrides: Partial<FlagScanState> = {},
): FlagScanState {
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
		...overrides,
	};
}

function scan(input: {
	specs: FeatureFlagSpec[];
	views?: FlagView[];
	prevState?: FlagScanState[];
	anchors?: FlagKeepAnchor[];
	keepBindings?: Map<
		string,
		{ runToken: string; canonical: string; decidedAt: string } | "unbound"
	>;
	expectedProjectNames?: string[];
	now?: number;
}) {
	return computeFlagScan({
		rows: input.specs.map((spec, index) => ({
			spec,
			view: input.views?.[index] ?? flagView(spec),
		})),
		expectedProjectNames: input.expectedProjectNames ?? [],
		prevState: input.prevState ?? [],
		anchors: input.anchors ?? [],
		keepBindings: input.keepBindings ?? new Map(),
		now: input.now ?? 10 * DAY,
	});
}

describe("canonicalizeFlagSample", () => {
	it("anchors Bridge values on displayEffective, with effective as the resolver-compatible fallback", () => {
		const spec = flagSpec("bridge");
		expect(
			canonicalizeFlagSample(spec, flagView(spec, { displayEffective: true })),
		).toEqual({ kind: "value", canonical: '{"k":"bool","v":true}' });
		expect(
			canonicalizeFlagSample(
				spec,
				flagView(spec, { displayEffective: undefined, effective: false }),
			),
		).toEqual({ kind: "value", canonical: '{"k":"bool","v":false}' });
	});

	it.each([
		["source_unavailable", "read_unavailable"],
		["staged_restart", "observed_instability"],
		["split_brain", "observed_instability"],
		["bridge_stale", "observed_instability"],
	] as const)(
		"classifies %s without guessing a value",
		(divergence, expected) => {
			const spec = flagSpec("bridge");
			expect(
				canonicalizeFlagSample(
					spec,
					flagView(spec, { divergence, displayEffective: undefined }),
				),
			).toMatchObject({ kind: "indeterminate", class: expected });
		},
	);

	it("requires the exact fresh project roster and sorts the canonical rows", () => {
		const spec = flagSpec("project", {
			source: "project_config",
			scope: "project",
			envVar: undefined,
			configKey: "qa.auto",
		});
		const view = flagView(spec, {
			effective: undefined,
			displayEffective: undefined,
			effectiveByProject: [
				{ projectName: "zeta", value: false },
				{ projectName: "alpha", value: true },
			],
		});
		expect(canonicalizeFlagSample(spec, view, ["alpha", "zeta"])).toEqual({
			kind: "value",
			canonical: '{"k":"bool","v":[["alpha",true],["zeta",false]]}',
		});
		expect(canonicalizeFlagSample(spec, view, ["alpha"])).toMatchObject({
			kind: "indeterminate",
			class: "read_unavailable",
		});
		expect(
			canonicalizeFlagSample(
				spec,
				{ ...view, effectiveByProject: [{ projectName: "alpha" }] },
				["alpha"],
			),
		).toMatchObject({ kind: "indeterminate", class: "read_unavailable" });
		expect(
			canonicalizeFlagSample(spec, { ...view, effectiveByProject: [] }, []),
		).toMatchObject({ kind: "indeterminate", class: "read_unavailable" });
	});

	it("uses a stable dormant sentinel instead of inventing an effective value", () => {
		const spec = flagSpec("dormant", {
			source: "project_config",
			scope: "project",
			envVar: undefined,
			configKey: "ponytail.enabled",
			dormant: true,
		});
		expect(
			canonicalizeFlagSample(
				spec,
				flagView(spec, {
					effective: undefined,
					displayEffective: undefined,
					dormant: true,
				}),
			),
		).toEqual({ kind: "value", canonical: '{"k":"dormant"}' });
	});
});

describe("computeFlagScan", () => {
	it("requires an exact one-to-one registry/view join", () => {
		const spec = flagSpec("one");
		expect(() =>
			computeFlagScan({
				rows: [
					{ spec, view: flagView(spec) },
					{ spec, view: flagView(spec) },
				],
				expectedProjectNames: [],
				prevState: [],
				anchors: [],
				keepBindings: new Map(),
				now: 0,
			}),
		).toThrow(/duplicate/i);
	});

	it("does not nominate a new flag until two equal samples span at least seven days", () => {
		const spec = flagSpec("new", { default: true });
		const first = scan({ specs: [spec], now: DAY });
		expect(first.candidates).toEqual([]);
		expect(first.nextState[0]).toMatchObject({
			streakSamples: 1,
			streakStartedAt: DAY,
		});

		const tooSoon = scan({
			specs: [spec],
			prevState: first.nextState,
			now: DAY + FLAG_SCAN_INTERVAL_MS - 1,
		});
		expect(tooSoon.candidates).toEqual([]);

		const due = scan({
			specs: [spec],
			prevState: first.nextState,
			now: DAY + FLAG_SCAN_INTERVAL_MS,
		});
		expect(due.candidates).toHaveLength(1);
		expect(due.candidates[0]?.askPhrase).toMatch(/bake in/i);
	});

	it("resets the streak on a changed effective value", () => {
		const spec = flagSpec("changed");
		const oldCanonical = '{"k":"bool","v":false}';
		const result = scan({
			specs: [spec],
			views: [flagView(spec, { effective: true, displayEffective: true })],
			prevState: [
				state(spec.name, {
					canonical: oldCanonical,
					streakStartedAt: DAY,
					streakSamples: 4,
				}),
			],
			now: 20 * DAY,
		});
		expect(result.candidates).toEqual([]);
		expect(result.nextState[0]).toMatchObject({
			canonical: '{"k":"bool","v":true}',
			streakSamples: 1,
			streakStartedAt: 20 * DAY,
		});
	});

	it("preserves a trustworthy streak through read_unavailable but destroys it on observed instability", () => {
		const spec = flagSpec("uncertain");
		const previous = state(spec.name, {
			canonical: '{"k":"bool","v":false}',
			streakStartedAt: DAY,
			streakSamples: 2,
		});
		const unavailable = scan({
			specs: [spec],
			views: [
				flagView(spec, {
					divergence: "source_unavailable",
					displayEffective: undefined,
				}),
			],
			prevState: [previous],
		});
		expect(unavailable.nextState[0]).toMatchObject({
			canonical: previous.canonical,
			streakSamples: 2,
			indeterminateClass: "read_unavailable",
			indeterminateStreak: 1,
		});
		expect(unavailable.noClock).toHaveLength(1);

		const unstable = scan({
			specs: [spec],
			views: [
				flagView(spec, {
					divergence: "split_brain",
					displayEffective: undefined,
				}),
			],
			prevState: [previous],
		});
		expect(unstable.nextState[0]).toMatchObject({
			canonical: null,
			streakStartedAt: null,
			streakSamples: 0,
			indeterminateClass: "observed_instability",
		});
	});

	it("keeps retiring flags out of candidates and classifies registry departures", () => {
		const retiring = flagSpec("retiring", { retiring: "FLY-999" });
		const result = scan({
			specs: [retiring],
			prevState: [
				state("retiring", {
					canonical: '{"k":"bool","v":false}',
					streakStartedAt: 0,
					streakSamples: 3,
				}),
				state("feature-removed"),
				state("governance-cleared", { lastRetiringIssue: "FLY-123" }),
			],
			now: 20 * DAY,
		});
		expect(result.candidates).toEqual([]);
		expect(result.claimed).toMatchObject([
			{ flagName: "retiring", retiringIssue: "FLY-999" },
		]);
		expect(result.departures).toEqual([
			{ flagName: "feature-removed", kind: "feature_removed" },
			{
				flagName: "governance-cleared",
				kind: "governance_cleared",
			},
		]);
	});

	it("binds longTermKeep to the frozen candidate value and re-asks only after a later value is stable", () => {
		const kept = flagSpec("kept", {
			longTermKeep: true,
			keepReason: "2026-08-16 [flag-scan:run-a]: still needed",
		});
		const canonicalA = '{"k":"bool","v":false}';
		const bindingA = {
			runToken: "run-a",
			canonical: canonicalA,
			decidedAt: "2026-08-16",
		};
		const suppressed = scan({
			specs: [kept],
			prevState: [
				state("kept", {
					canonical: canonicalA,
					streakStartedAt: 0,
					streakSamples: 3,
				}),
			],
			keepBindings: new Map([["kept", bindingA]]),
		});
		expect(suppressed.candidates).toEqual([]);
		expect(suppressed.nextAnchors).toEqual([
			{
				flagName: "kept",
				anchorCanonical: canonicalA,
				boundRunToken: "run-a",
				decidedAt: "2026-08-16",
			},
		]);

		const changed = scan({
			specs: [kept],
			views: [flagView(kept, { effective: true, displayEffective: true })],
			prevState: suppressed.nextState,
			anchors: suppressed.nextAnchors,
			keepBindings: new Map([["kept", bindingA]]),
			now: 20 * DAY,
		});
		expect(changed.candidates).toEqual([]);

		const stableB = scan({
			specs: [kept],
			views: [flagView(kept, { effective: true, displayEffective: true })],
			prevState: changed.nextState,
			anchors: changed.nextAnchors,
			keepBindings: new Map([["kept", bindingA]]),
			now: 20 * DAY + FLAG_SCAN_INTERVAL_MS,
		});
		expect(stableB.candidates).toHaveLength(1);
		expect(stableB.candidates[0]?.reason).toMatch(/2026-08-16/);
		expect(stableB.nextAnchors).toEqual(suppressed.nextAnchors);
	});

	it("surfaces an unbound keep forever instead of silently creating a current-value anchor", () => {
		const kept = flagSpec("unbound", { longTermKeep: true });
		const result = scan({
			specs: [kept],
			keepBindings: new Map([["unbound", "unbound"]]),
		});
		expect(result.keepUnbound).toMatchObject([{ flagName: "unbound" }]);
		expect(result.candidates).toEqual([]);
		expect(result.nextAnchors).toEqual([]);
	});
});

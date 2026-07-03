/**
 * FLY-709 — feature-flag resolver.
 *
 * Computes the effective (current) value of each registered flag from
 * process.env (Bridge-global env flags) and per-project config (project-scoped
 * config flags), reusing each flag's real in-line semantics so the displayed
 * value is byte-identical to what the owning code actually observes.
 *
 * env flags are Bridge-global → single `effective`.
 * project_config flags are per-project → `effectiveByProject[]` (env is global,
 * but qa.auto / doc_flow / etc. differ per project). Config-load errors are
 * surfaced as data, never silently defaulted. Dormant flags (ponytail: validated
 * by ConfigLoader but not loaded by run-infra) report no effective value.
 */

import { resolveDecisionMode } from "../decision-mode.js";
import type { FlywheelConfig } from "../types.js";
import {
	FEATURE_FLAGS,
	type FeatureFlagSpec,
	type FlagCategory,
	type FlagScope,
	type FlagSource,
	type FlagToggleability,
	type FlagValueKind,
	type ReadTiming,
} from "./registry.js";

export interface FlagResolveCtx {
	/** Defaults to process.env — the Bridge-global env for env flags. */
	env?: Record<string, string | undefined>;
	/** project name → its loaded config (or a load error). Used for project flags. */
	projectConfigs?: Map<string, { config?: FlywheelConfig; error?: string }>;
}

/** A project-scoped flag's effective value on one project. */
export interface FlagEffectiveByProject {
	projectName: string;
	/** Present when the project config loaded. */
	value?: boolean | string;
	/** Present when the project config failed to load (surfaced, not defaulted). */
	error?: string;
	isDefault?: boolean;
}

/** Secret-free DTO handed to the console / snapshot / report renderers. */
export interface FlagView {
	name: string;
	category: FlagCategory;
	description: string;
	toggleable: FlagToggleability;
	valueKind: FlagValueKind;
	scope: FlagScope;
	source: FlagSource;
	envVar?: string;
	configKey?: string;
	/** Deduped read-timings (drives the 生效路径 badge). */
	readTimings: ReadTiming[];
	enumValues?: string[];
	default: boolean | string;
	/** scope === "bridge_global": the single effective value. */
	effective?: boolean | string;
	/** scope === "project": per-project effective values. */
	effectiveByProject?: FlagEffectiveByProject[];
	/** Validated by ConfigLoader but not loaded by runtime → no effective value. */
	dormant?: boolean;
	/** For env flags: whether the effective value equals the default. */
	isDefault?: boolean;
	/**
	 * A DISPLAY-ONLY error for a malformed value (e.g. an invalid DECISION_MODE
	 * env that the real parser would throw on). When set, `effective` is absent —
	 * the UI must show this as an error, never as a valid state.
	 */
	error?: string;
	note?: string;
}

/** Navigate a dot path (e.g. "qa.auto") on a plain object; undefined if absent. */
function getByPath(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const key of path.split(".")) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur;
}

function uniqueTimings(spec: FeatureFlagSpec): ReadTiming[] {
	const seen = new Set<ReadTiming>();
	for (const s of spec.readSites) seen.add(s.timing);
	return [...seen];
}

/** Effective value of an env (Bridge-global) flag, byte-compat with its read site. */
function resolveEnvEffective(
	spec: FeatureFlagSpec,
	env: Record<string, string | undefined>,
): boolean | string {
	const raw = spec.envVar ? env[spec.envVar] : undefined;
	// enum / value: surface the raw value (or default). DECISION_MODE's real-parser
	// path (which throws on invalid) is handled in resolveFlag so a malformed value
	// becomes an explicit `error`, never a fake "valid" effective state.
	if (spec.valueKind === "enum" || spec.valueKind === "value") {
		return raw ?? String(spec.default);
	}
	// bool: reuse the two idioms exactly.
	return spec.polarity === "default_on" ? raw !== "0" : raw === "1";
}

/** Effective value of a project_config flag on one loaded config. */
function resolveConfigValue(
	spec: FeatureFlagSpec,
	config: FlywheelConfig,
): boolean | string {
	const raw = spec.configKey ? getByPath(config, spec.configKey) : undefined;
	if (raw === undefined || raw === null) return spec.default;
	if (spec.valueKind === "bool") return Boolean(raw);
	return String(raw);
}

export function resolveFlag(
	spec: FeatureFlagSpec,
	ctx: FlagResolveCtx,
): FlagView {
	const env = ctx.env ?? process.env;
	const base: FlagView = {
		name: spec.name,
		category: spec.category,
		description: spec.description,
		toggleable: spec.toggleable,
		valueKind: spec.valueKind,
		scope: spec.scope,
		source: spec.source,
		envVar: spec.envVar,
		configKey: spec.configKey,
		readTimings: uniqueTimings(spec),
		enumValues: spec.enumValues,
		default: spec.default,
		dormant: spec.dormant,
		note: spec.note,
	};

	if (spec.scope === "bridge_global") {
		// DECISION_MODE: reuse the real parser (throws on invalid). A dashboard must
		// not crash on a bad env var, but must NOT present the raw invalid string as
		// a valid governance mode — surface an explicit display-only error instead.
		if (spec.envVar === "FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE") {
			try {
				const effective = resolveDecisionMode(env);
				return { ...base, effective, isDefault: effective === spec.default };
			} catch {
				return {
					...base,
					error: `invalid ${spec.envVar}: ${env[spec.envVar]}`,
				};
			}
		}
		const effective = resolveEnvEffective(spec, env);
		return { ...base, effective, isDefault: effective === spec.default };
	}

	// project scope. Dormant flags never report an effective value.
	if (spec.dormant) return base;

	const configs = ctx.projectConfigs;
	if (!configs || configs.size === 0) {
		return { ...base, effectiveByProject: [] };
	}
	const effectiveByProject: FlagEffectiveByProject[] = [];
	for (const [projectName, entry] of configs) {
		// Only a real load error is an error row.
		if (entry.error !== undefined) {
			effectiveByProject.push({ projectName, error: entry.error });
			continue;
		}
		// Absent config (ENOENT → {}) = absent/default semantics, NOT an error.
		if (entry.config === undefined) {
			effectiveByProject.push({
				projectName,
				value: spec.default,
				isDefault: true,
			});
			continue;
		}
		const value = resolveConfigValue(spec, entry.config);
		effectiveByProject.push({
			projectName,
			value,
			isDefault: value === spec.default,
		});
	}
	return { ...base, effectiveByProject };
}

export function resolveAllFlags(ctx: FlagResolveCtx): FlagView[] {
	return FEATURE_FLAGS.map((spec) => resolveFlag(spec, ctx));
}

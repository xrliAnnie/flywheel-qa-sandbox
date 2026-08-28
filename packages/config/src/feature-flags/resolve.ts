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
 * but doc_flow / proofshot / etc. differ per project). Config-load errors are
 * surfaced as data, never silently defaulted. Dormant flags (ponytail: validated
 * by ConfigLoader but not loaded by run-infra) report no effective value.
 */

import { type EnvFileSource, readEnvFileValue } from "../env-file.js";
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
import type { FlagStoreCodec } from "./store-policy.js";

export interface FlagResolveCtx {
	/** Defaults to process.env — the Bridge-global env for env flags. */
	env?: Record<string, string | undefined>;
	/** Explicit shared .env snapshot. Omit for legacy Bridge-only resolution. */
	envFile?: EnvFileSource;
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
	/** FLY-2100: which layer supplied the displayed project value. */
	via?: "project_row" | "star_row" | "config" | "default";
	/** Batch-A transition: config.yaml is still the runtime source until Batch C. */
	runtimeConfigValue?: boolean | string;
	runtimeConfigError?: string;
	runtimeDivergence?: "config_pending_cutover";
}

export interface FlagScopedStoreView {
	/** Present rows only; absence means inherit. No revision or actor metadata. */
	rows: Array<{
		scope: string;
		raw: string;
		value: boolean | string;
	}>;
}

/** Persistent stable-value clock for one flag scope. Secret-free by design. */
export interface FlagValueClock {
	scopeKey: string;
	valueLastChanged: number | null;
	firstRegisteredAt: number;
	readiness: "ready" | "no_clock";
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
	/** Bridge process.env value. `effective` remains its compatibility alias. */
	bridgeEffective?: boolean | string;
	/** Current shared .env value; absent when the file is unavailable. */
	fileEffective?: boolean | string;
	/** Whether the readable shared .env still contains this exact assignment. */
	fileConfigured?: boolean;
	/** Safe display/control value; absent whenever sources disagree/degrade. */
	displayEffective?: boolean | string;
	divergence?:
		| "staged_restart"
		| "split_brain"
		| "bridge_stale"
		| "source_unavailable";
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
	retiring?: string;
	/** FLY-1778: true when SQLite, rather than legacy env/config, owns the value. */
	storeManaged?: boolean;
	/** FLY-2100: this project flag is writable through scoped SQLite rows. */
	projectStoreManaged?: boolean;
	/** Secret-free row-presence DTO used by phone controls. */
	scopedStore?: FlagScopedStoreView;
	/** Current effective value read from the owning SQLite row or boot bypass. */
	storeEffective?: boolean | string;
	/** Epoch milliseconds when the canonical effective value last changed. */
	valueLastChanged?: number | null;
	/** Whether the persistent value clock is safe for downstream consumers. */
	clockReadiness?:
		| "ready"
		| "no_clock:bypass"
		| "no_clock:degraded"
		| "no_clock:unmanaged";
	/** FLY-2104: scope-aware clocks; current single-row schema projects `*`. */
	valueClocks?: FlagValueClock[];
}

/** Navigate a schema path, expanding Record (`*`) and array (`[]`) segments. */
function getByPath(obj: unknown, path: string): unknown[] {
	let values: unknown[] = [obj];
	for (const segment of path.split(".")) {
		const arraySegment = segment.endsWith("[]");
		const key = arraySegment ? segment.slice(0, -2) : segment;
		values = values.flatMap((value) => {
			if (value == null || typeof value !== "object") return [undefined];
			if (key === "*") return Object.values(value);
			const next = (value as Record<string, unknown>)[key];
			if (!arraySegment) return [next];
			return Array.isArray(next) ? next : [];
		});
	}
	return values;
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
	// enum: a raw value outside enumValues THROWS (FLY-1356 R1#8) — the callers
	// (resolveFlag / withEnvSources) turn it into an explicit display-only
	// `error`, never a fake "valid" effective state. Empty string is treated as
	// unset (default), matching the owning parsers' fail-closed semantics.
	// DECISION_MODE's real-parser path is handled separately in resolveFlag.
	if (spec.valueKind === "enum") {
		if (raw === undefined || raw === "") return String(spec.default);
		if (spec.enumValues && !spec.enumValues.includes(raw)) {
			throw new Error(`invalid enum value: ${raw}`);
		}
		return raw;
	}
	// value: surface the raw value (or default).
	if (spec.valueKind === "value") {
		return raw ?? String(spec.default);
	}
	// bool: reuse the two idioms exactly.
	return spec.polarity === "default_on" ? raw !== "0" : raw === "1";
}

function divergenceFor(
	spec: FeatureFlagSpec,
): NonNullable<FlagView["divergence"]> {
	const timings = uniqueTimings(spec);
	if (timings.includes("dotenv_live")) return "split_brain";
	if (
		timings.includes("bridge_boot") ||
		timings.includes("object_construction")
	) {
		return "staged_restart";
	}
	return "bridge_stale";
}

function withEnvSources(
	base: FlagView,
	spec: FeatureFlagSpec,
	bridgeEffective: boolean | string,
	ctx: FlagResolveCtx,
): FlagView {
	const common = {
		...base,
		effective: bridgeEffective,
		bridgeEffective,
		isDefault: bridgeEffective === spec.default,
	};
	// Backward-compatible callers that have not supplied the file source retain
	// the historical single-source display behavior.
	if (!ctx.envFile) {
		return { ...common, displayEffective: bridgeEffective };
	}
	if (ctx.envFile.status === "unavailable") {
		return { ...common, divergence: "source_unavailable" };
	}
	const fileValue = spec.envVar
		? readEnvFileValue(ctx.envFile, spec.envVar)
		: { status: "readable" as const, raw: undefined };
	if (fileValue.status === "unavailable") {
		return { ...common, divergence: "source_unavailable" };
	}
	const fileRaw = fileValue.raw;
	const fileConfigured = fileRaw !== undefined;
	let fileEffective: boolean | string;
	try {
		fileEffective = resolveEnvEffective(spec, {
			...(spec.envVar ? { [spec.envVar]: fileRaw } : {}),
		});
	} catch {
		return {
			...common,
			fileConfigured,
			error: `invalid ${spec.envVar} in shared .env: ${fileRaw}`,
		};
	}
	if (fileEffective === bridgeEffective) {
		return {
			...common,
			fileConfigured,
			fileEffective,
			displayEffective: bridgeEffective,
		};
	}
	return {
		...common,
		fileConfigured,
		fileEffective,
		divergence: divergenceFor(spec),
	};
}

/** Effective value of a project_config flag on one loaded config. */
function resolveConfigValue(
	spec: FeatureFlagSpec,
	config: FlywheelConfig,
): { value: boolean | string } | { error: string } {
	const rawValues = spec.configKey ? getByPath(config, spec.configKey) : [];
	const values = (rawValues.length > 0 ? rawValues : [undefined]).map((raw) => {
		if (raw === undefined || raw === null) return spec.default;
		if (spec.valueKind === "bool") return Boolean(raw);
		return String(raw);
	});
	const value = values[0] ?? spec.default;
	if (values.some((candidate) => candidate !== value)) {
		return { error: `mixed values for ${spec.configKey}` };
	}
	return { value };
}

/**
 * Overlay project-scoped SQLite rows without changing the legacy config
 * resolver. No row means byte-compatible config/default fallback for the
 * FLY-2100 transition; an explicit project row wins over the `*` row.
 */
export function resolveScopedEffective(input: {
	spec: FeatureFlagSpec;
	projectName: string;
	rows: ReadonlyArray<{ scope: string; raw: string | null }>;
	configRow: FlagEffectiveByProject;
	codec: FlagStoreCodec;
}): FlagEffectiveByProject {
	const row =
		input.rows.find((candidate) => candidate.scope === input.projectName) ??
		input.rows.find((candidate) => candidate.scope === "*");
	if (row) {
		const value = input.codec.parse({ hasOverride: true, raw: row.raw });
		return {
			projectName: input.projectName,
			value,
			isDefault: value === input.spec.default,
			via: row.scope === "*" ? "star_row" : "project_row",
		};
	}
	return {
		...input.configRow,
		projectName: input.projectName,
		via: input.configRow.isDefault ? "default" : "config",
	};
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
		retiring: spec.retiring,
	};

	if (spec.scope === "bridge_global") {
		// FLY-1329 A2 (Codex R2 LOW): the activity window is a wording-only value the
		// runtime (`activityWindowMs`) sanitizes — junk / ≤0 / non-finite all become
		// the default. Report the SANITIZED effective value, not the raw env string,
		// so the dashboard never shows a value the runtime does not actually use.
		// Kept in lock-step with activityWindowMs() (same finite-&&->0 rule); config
		// cannot import teamlead, so the tiny rule is mirrored, not shared.
		if (spec.envVar === "FLYWHEEL_LIVENESS_ACTIVITY_WINDOW_MS") {
			const raw = env[spec.envVar];
			const n = Number(raw);
			const effective =
				raw !== undefined && Number.isFinite(n) && n > 0
					? String(n)
					: String(spec.default);
			return {
				...base,
				effective,
				isDefault: effective === String(spec.default),
			};
		}
		// FLY-1356 R1#8: an enum raw outside enumValues throws in
		// resolveEnvEffective — surface it as an explicit display-only error so
		// the console never shows garbage as the current mode while the owning
		// code actually runs its fail-closed default.
		let effective: boolean | string;
		try {
			effective = resolveEnvEffective(spec, env);
		} catch {
			return {
				...base,
				error: `invalid ${spec.envVar}: ${env[spec.envVar ?? ""]}`,
			};
		}
		return withEnvSources(base, spec, effective, ctx);
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
		const resolution = resolveConfigValue(spec, entry.config);
		if ("error" in resolution) {
			effectiveByProject.push({ projectName, error: resolution.error });
			continue;
		}
		const { value } = resolution;
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

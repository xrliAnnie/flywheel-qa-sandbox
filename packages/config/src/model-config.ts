import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	assertValidModelRegistry,
	BUILTIN_MODEL_TIERS,
	buildModelLookup,
	buildModelRegistry,
	DEFAULT_MODEL_BINDINGS,
	DEFAULT_OPUS_BINDINGS,
	LEGACY_FABLE_MODEL_IDS,
	MODEL_ALIASES,
	MODEL_IDS,
	MODEL_PROVIDERS,
	type ModelBindings,
	type ModelProviderId,
	type ModelRegistryEntry,
	type ModelRuntimeVendor,
	type ModelSurface,
	type ModelTier,
	type ModelTierSpec,
	modelFamilyCode,
	supportedRoleEfforts,
} from "./model-builtins.js";
import type { RoleEffort } from "./types.js";

const CONFIG_VERSION = 1;
const CONFIG_ENV = "FLYWHEEL_MODELS_CONFIG";
const MANAGED_SURFACES: readonly ModelSurface[] = [
	"lead",
	"runner",
	"workflow",
	"cron",
];
const ALL_SURFACES: readonly ModelSurface[] = ["dispatch", ...MANAGED_SURFACES];
const MODEL_SURFACES = new Set<ModelSurface>(ALL_SURFACES);
const MODEL_PROVIDERS_SET = new Set<ModelProviderId>(["anthropic", "openai"]);
const RUNTIME_VENDORS = new Set<ModelRuntimeVendor>(["claude", "codex"]);
const TIER_NAMES: readonly ModelTier[] = [
	"heavy",
	"medium",
	"light",
	"trivial",
];

export type ModelPolicyErrorCode = "INVALID_MODEL";

export class ModelPolicyError extends Error {
	readonly code: ModelPolicyErrorCode;
	readonly model: string;

	constructor(code: ModelPolicyErrorCode, model: string, message?: string) {
		super(message ?? `${code}: ${model}`);
		this.name = "ModelPolicyError";
		this.code = code;
		this.model = model;
	}
}

export interface ModelCatalog {
	version: 1;
	surface: ModelSurface;
	providers: Array<{
		id: ModelProviderId;
		label: string;
		models: Array<{
			id: string;
			label: string;
			runtimeVendor: ModelRuntimeVendor;
			efforts: readonly RoleEffort[];
			selectable: boolean;
		}>;
	}>;
}

export interface ModelConfigSnapshot {
	readonly revision: string;
	readonly sourcePath: string;
	readonly registry: readonly ModelRegistryEntry[];
	readonly bindings: ModelBindings;
	readonly tiers: Readonly<Record<ModelTier, ModelTierSpec>>;
	readonly acceptedDispatchModels: readonly string[];
	getModelRegistryEntry(raw: string): ModelRegistryEntry | null;
	getDispatchCanonical(raw: string): string | null;
	normalizeDispatchModel(raw: string): string | null;
	isModelSelectable(input: {
		surface: ModelSurface;
		model: string;
		runtimeVendor?: string;
	}): boolean;
	isModelSelectionSupported(input: {
		surface: ModelSurface;
		model: string;
		effort?: string;
		runtimeVendor?: string;
	}): boolean;
	buildModelCatalog(surface: ModelSurface): ModelCatalog;
	resolveCurrentModel(raw: string, surface: ModelSurface): CurrentModelView;
}

export interface CurrentModelView {
	id: string;
	label: string;
	provider: ModelProviderId | null;
	runtimeVendor: ModelRuntimeVendor | null;
	legacyCurrent: boolean;
	selectable: boolean;
}

interface ModelConfigFile {
	version?: unknown;
	bindings?: unknown;
	models?: unknown;
	tiers?: unknown;
}

interface SnapshotCache {
	key: string;
	snapshot: ModelConfigSnapshot;
}

let snapshotCache: SnapshotCache | undefined;

function configLocation(): { path: string; explicit: boolean } {
	const override = process.env[CONFIG_ENV]?.trim();
	return {
		path: override || join(homedir(), ".flywheel", "models.json"),
		explicit: Boolean(override),
	};
}

function fileCacheKey(path: string): string {
	try {
		const stat = statSync(path);
		return [
			path,
			stat.dev.toString(),
			stat.ino.toString(),
			stat.mtimeMs.toString(),
			stat.size.toString(),
		].join(":");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
		return `${path}:unavailable:${code}`;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedStrings(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		return null;
	}
	return value.map((item) => item.trim()).filter(Boolean);
}

function defaultEfforts(
	id: string,
	runtimeVendor: ModelRuntimeVendor,
	surfaces: readonly ModelSurface[],
): ModelRegistryEntry["effortsBySurface"] {
	const efforts: Partial<Record<ModelSurface, readonly RoleEffort[]>> = {};
	for (const surface of surfaces) {
		if (surface === "dispatch") continue;
		if (surface === "cron") {
			efforts[surface] = [];
		} else if (runtimeVendor === "codex" && surface === "runner") {
			// Codex R1 MEDIUM: 这条特例原来直接写死 ["xhigh"],绕过按 id 的收窄
			// —— 一个把 4.6 声明成 codex vendor 的 overlay 就能把 xhigh 拿回来。
			// 与该模型真正支持的档位取交集后再落表。
			const supported = supportedRoleEfforts(id);
			efforts[surface] = supported.includes("xhigh") ? ["xhigh"] : [];
		} else {
			// FLY-1650: overlay 走的是与内建条目同一张按 id 收窄的档位表,
			// 否则在 models.json 里重新声明一个模型就能把它不支持的档位拿回来。
			efforts[surface] = supportedRoleEfforts(id);
		}
	}
	return efforts;
}

function parseConfiguredModel(value: unknown): ModelRegistryEntry {
	if (!isObject(value)) throw new Error("model entry must be an object");
	const id = typeof value.id === "string" ? value.id.trim() : "";
	const label = typeof value.label === "string" ? value.label.trim() : "";
	const provider = value.provider;
	const runtimeVendor = value.runtimeVendor;
	const aliases = normalizedStrings(value.aliases ?? []);
	if (!id || !label) throw new Error("model id and label are required");
	if (
		typeof provider !== "string" ||
		!MODEL_PROVIDERS_SET.has(provider as ModelProviderId)
	) {
		throw new Error(`invalid provider for ${id}`);
	}
	if (
		typeof runtimeVendor !== "string" ||
		!RUNTIME_VENDORS.has(runtimeVendor as ModelRuntimeVendor)
	) {
		throw new Error(`invalid runtimeVendor for ${id}`);
	}
	if (!aliases) throw new Error(`invalid aliases for ${id}`);
	const maxInputTokens = value.maxInputTokens;
	if (
		maxInputTokens !== undefined &&
		(typeof maxInputTokens !== "number" ||
			!Number.isSafeInteger(maxInputTokens) ||
			maxInputTokens <= 0)
	) {
		throw new Error(`invalid maxInputTokens for ${id}`);
	}
	const contextWindowTokens = value.contextWindowTokens;
	if (
		contextWindowTokens !== undefined &&
		(typeof contextWindowTokens !== "number" ||
			!Number.isSafeInteger(contextWindowTokens) ||
			contextWindowTokens <= 0)
	) {
		throw new Error(`invalid contextWindowTokens for ${id}`);
	}

	const explicitSurfaces = normalizedStrings(value.surfaces);
	if (value.surfaces !== undefined && !explicitSurfaces) {
		throw new Error(`invalid surfaces for ${id}`);
	}
	const surfaces = explicitSurfaces
		? explicitSurfaces.map((surface) => {
				if (!MODEL_SURFACES.has(surface as ModelSurface)) {
					throw new Error(`invalid surface for ${id}: ${surface}`);
				}
				return surface as ModelSurface;
			})
		: value.dispatch === true
			? [...ALL_SURFACES]
			: [...MANAGED_SURFACES];

	const explicitSelectable = normalizedStrings(value.selectableSurfaces);
	if (value.selectableSurfaces !== undefined && !explicitSelectable) {
		throw new Error(`invalid selectableSurfaces for ${id}`);
	}
	const selectableSurfaces = explicitSelectable?.map((surface) => {
		if (!MODEL_SURFACES.has(surface as ModelSurface)) {
			throw new Error(`invalid selectable surface for ${id}: ${surface}`);
		}
		return surface as ModelSurface;
	});

	return {
		id,
		label,
		provider: provider as ModelProviderId,
		runtimeVendor: runtimeVendor as ModelRuntimeVendor,
		aliases,
		surfaces,
		...(maxInputTokens === undefined ? {} : { maxInputTokens }),
		...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
		...(selectableSurfaces ? { selectableSurfaces } : {}),
		effortsBySurface: defaultEfforts(
			id,
			runtimeVendor as ModelRuntimeVendor,
			surfaces,
		),
	};
}

function mergeModels(
	base: readonly ModelRegistryEntry[],
	value: unknown,
	warnings: string[],
): readonly ModelRegistryEntry[] {
	if (value === undefined) return base;
	if (!Array.isArray(value)) {
		warnings.push("models segment ignored: expected an array");
		return base;
	}
	try {
		const overlays = value.map(parseConfiguredModel);
		const byId = new Map(
			base.map((entry) => [entry.id.toLowerCase(), entry] as const),
		);
		for (const entry of overlays) {
			const key = entry.id.toLowerCase();
			const builtin = byId.get(key);
			if (!builtin) {
				byId.set(key, entry);
				continue;
			}
			const seenAliases = new Set<string>();
			const aliases = [...builtin.aliases, ...entry.aliases].filter((alias) => {
				const normalized = alias.trim().toLowerCase();
				if (seenAliases.has(normalized)) return false;
				seenAliases.add(normalized);
				return true;
			});
			byId.set(key, {
				...entry,
				aliases,
				...(entry.contextWindowTokens === undefined &&
				builtin.contextWindowTokens !== undefined
					? { contextWindowTokens: builtin.contextWindowTokens }
					: {}),
				...(entry.maxInputTokens === undefined &&
				builtin.maxInputTokens !== undefined
					? { maxInputTokens: builtin.maxInputTokens }
					: {}),
			});
		}
		const merged = [...byId.values()];
		assertValidModelRegistry(merged);
		return merged;
	} catch (error) {
		warnings.push(
			`models segment ignored: ${error instanceof Error ? error.message : String(error)}`,
		);
		return base;
	}
}

function resolveBindingTarget(
	value: unknown,
	fallback: string,
	lookup: ReadonlyMap<string, ModelRegistryEntry>,
	name: string,
	warnings: string[],
): string {
	if (value === undefined) return fallback;
	if (typeof value !== "string") {
		warnings.push(`bindings.${name} ignored: expected a model string`);
		return fallback;
	}
	const entry = lookup.get(value.trim().toLowerCase());
	if (!entry || entry.runtimeVendor !== "claude") {
		warnings.push(`bindings.${name} ignored: unknown Claude model ${value}`);
		return fallback;
	}
	return entry.id;
}

const FABLE_BASE_ID = /^claude-fable-[0-9]+(?:-[0-9]+)*$/;

function resolveFableBinding(
	value: unknown,
	lookup: ReadonlyMap<string, ModelRegistryEntry>,
	warnings: string[],
): string {
	if (value === undefined) return DEFAULT_MODEL_BINDINGS.fable;
	if (typeof value !== "string") {
		warnings.push("bindings.fable ignored: expected a model string");
		return DEFAULT_MODEL_BINDINGS.fable;
	}
	const entry = lookup.get(value.trim().toLowerCase());
	const oneM = entry ? lookup.get(`${entry.id}[1m]`.toLowerCase()) : undefined;
	if (
		!entry ||
		!FABLE_BASE_ID.test(entry.id) ||
		entry.provider !== "anthropic" ||
		entry.runtimeVendor !== "claude" ||
		!entry.surfaces.includes("dispatch") ||
		!entry.surfaces.includes("workflow") ||
		!oneM ||
		oneM.provider !== "anthropic" ||
		oneM.runtimeVendor !== "claude" ||
		!oneM.surfaces.includes("workflow") ||
		(!oneM.surfaces.includes("dispatch") && oneM.id !== MODEL_IDS.FABLE_1M)
	) {
		warnings.push(
			`bindings.fable ignored: incomplete or unavailable Fable family ${value}`,
		);
		return DEFAULT_MODEL_BINDINGS.fable;
	}
	return entry.id;
}

function applyBindings(
	registry: readonly ModelRegistryEntry[],
	value: unknown,
	warnings: string[],
): {
	registry: readonly ModelRegistryEntry[];
	bindings: ModelBindings;
} {
	if (value !== undefined && !isObject(value)) {
		warnings.push("bindings segment ignored: expected an object");
		value = undefined;
	}
	const configured = (value ?? {}) as Record<string, unknown>;
	const originalLookup = buildModelLookup(registry);
	const bindings = Object.freeze({
		fable: resolveFableBinding(configured.fable, originalLookup, warnings),
		opus: resolveBindingTarget(
			configured.opus,
			DEFAULT_OPUS_BINDINGS.opus,
			originalLookup,
			"opus",
			warnings,
		),
		opus1m: resolveBindingTarget(
			configured.opus1m,
			DEFAULT_OPUS_BINDINGS.opus1m,
			originalLookup,
			"opus1m",
			warnings,
		),
	});
	const aliasTargets = new Map<string, string>([
		[MODEL_ALIASES.FABLE, bindings.fable],
		["fable-1m", `${bindings.fable}[1m]`],
		["fable[1m]", `${bindings.fable}[1m]`],
		["opus", bindings.opus],
		["opus-1m", bindings.opus1m],
		["opus[1m]", bindings.opus1m],
	]);
	const rebound = registry.map((entry) => {
		const aliases = entry.aliases.filter(
			(alias) => !aliasTargets.has(alias.toLowerCase()),
		);
		for (const [alias, target] of aliasTargets) {
			if (entry.id === target) aliases.push(alias);
		}
		return Object.freeze({ ...entry, aliases: Object.freeze(aliases) });
	});
	assertValidModelRegistry(rebound);
	return { registry: Object.freeze(rebound), bindings };
}

function buildDispatchLookupForRegistry(
	registry: readonly ModelRegistryEntry[],
): ReadonlyMap<string, string> {
	const lookup = new Map<string, string>();
	for (const entry of registry) {
		if (
			!entry.surfaces.includes("dispatch") &&
			entry.id !== MODEL_IDS.FABLE_1M
		) {
			continue;
		}
		lookup.set(entry.id.toLowerCase(), entry.id);
		for (const alias of entry.aliases) {
			lookup.set(alias.toLowerCase(), entry.id);
		}
	}
	// Legacy identities stay accepted even when nothing binds to them, so a
	// carrier pinned before they were retired keeps dispatching. Pre-existing
	// back-compat — they are still absent from every tier and picker, so this
	// only keeps an explicit old pin working, it never routes new work here.
	for (const id of [
		MODEL_IDS.OPUS_48,
		MODEL_IDS.OPUS_48_1M,
		...LEGACY_FABLE_MODEL_IDS,
	]) {
		lookup.set(id.toLowerCase(), id);
	}
	return lookup;
}

function createSnapshot(
	path: string,
	revision: string,
	config: ModelConfigFile,
	warnings: string[],
): ModelConfigSnapshot {
	let registry = mergeModels(
		buildModelRegistry(DEFAULT_OPUS_BINDINGS),
		config.models,
		warnings,
	);
	const bindingResult = applyBindings(registry, config.bindings, warnings);
	registry = bindingResult.registry;
	const registryLookup = buildModelLookup(registry);
	const dispatchLookup = buildDispatchLookupForRegistry(registry);

	const tiers = {} as Record<ModelTier, ModelTierSpec>;
	const configuredTiers = isObject(config.tiers) ? config.tiers : {};
	if (config.tiers !== undefined && !isObject(config.tiers)) {
		warnings.push("tiers segment ignored: expected an object");
	}
	for (const tier of TIER_NAMES) {
		const builtinFallback = BUILTIN_MODEL_TIERS[tier];
		const fallback =
			tier === "heavy"
				? Object.freeze({
						...builtinFallback,
						id: bindingResult.bindings.fable,
						code: modelFamilyCode(bindingResult.bindings.fable),
					})
				: builtinFallback;
		const raw = configuredTiers[tier];
		if (raw === undefined) {
			tiers[tier] = fallback;
			continue;
		}
		if (typeof raw !== "string") {
			warnings.push(`tier ${tier} ignored: expected a model string`);
			tiers[tier] = fallback;
			continue;
		}
		const entry = registryLookup.get(raw.trim().toLowerCase());
		if (
			!entry ||
			entry.runtimeVendor !== "claude" ||
			!entry.surfaces.includes("dispatch")
		) {
			warnings.push(`tier ${tier} ignored: unavailable Claude model ${raw}`);
			tiers[tier] = fallback;
			continue;
		}
		tiers[tier] = Object.freeze({
			id: entry.id,
			aliases: Object.freeze([raw.trim().toLowerCase()]),
			code: modelFamilyCode(entry.id),
		});
	}
	const frozenTiers = Object.freeze(tiers);
	const getModelRegistryEntry = (raw: string): ModelRegistryEntry | null =>
		registryLookup.get(raw.trim().toLowerCase()) ?? null;
	const getDispatchCanonical = (raw: string): string | null => {
		const key = raw.trim().toLowerCase();
		if (!key) return null;
		return dispatchLookup.get(key) ?? null;
	};
	const normalizeDispatchModel = (raw: string): string | null => {
		return getDispatchCanonical(raw);
	};
	const isModelSelectable = (input: {
		surface: ModelSurface;
		model: string;
		runtimeVendor?: string;
	}): boolean => {
		const entry = getModelRegistryEntry(input.model);
		if (!entry) return false;
		if (input.runtimeVendor && entry.runtimeVendor !== input.runtimeVendor) {
			return false;
		}
		return (entry.selectableSurfaces ?? entry.surfaces).includes(input.surface);
	};
	const isModelSelectionSupported = (input: {
		surface: ModelSurface;
		model: string;
		effort?: string;
		runtimeVendor?: string;
	}): boolean => {
		const entry = getModelRegistryEntry(input.model);
		if (!entry || !entry.surfaces.includes(input.surface)) {
			return false;
		}
		if (input.runtimeVendor && entry.runtimeVendor !== input.runtimeVendor) {
			return false;
		}
		if (input.effort === undefined) return true;
		return (entry.effortsBySurface[input.surface] ?? []).includes(
			input.effort as RoleEffort,
		);
	};
	const buildModelCatalog = (surface: ModelSurface): ModelCatalog => {
		const providers: ModelCatalog["providers"] = [];
		for (const provider of Object.values(MODEL_PROVIDERS)) {
			const models = registry
				.filter(
					(entry) =>
						entry.provider === provider.id && entry.surfaces.includes(surface),
				)
				.map((entry) => ({
					id: entry.id,
					label: entry.label,
					runtimeVendor: entry.runtimeVendor,
					efforts: entry.effortsBySurface[surface] ?? [],
					selectable: (entry.selectableSurfaces ?? entry.surfaces).includes(
						surface,
					),
				}));
			if (models.length > 0) providers.push({ ...provider, models });
		}
		return { version: 1, surface, providers };
	};
	const resolveCurrentModel = (
		raw: string,
		surface: ModelSurface,
	): CurrentModelView => {
		const entry = getModelRegistryEntry(raw);
		if (!entry) {
			return {
				id: raw,
				label: raw,
				provider: null,
				runtimeVendor: null,
				legacyCurrent: true,
				selectable: false,
			};
		}
		const selectable = (entry.selectableSurfaces ?? entry.surfaces).includes(
			surface,
		);
		return {
			id: entry.id,
			label: entry.label,
			provider: entry.provider,
			runtimeVendor: entry.runtimeVendor,
			legacyCurrent: !selectable,
			selectable,
		};
	};
	const acceptedDispatchModels = Object.freeze([...dispatchLookup.keys()]);

	return Object.freeze({
		revision,
		sourcePath: path,
		registry,
		bindings: bindingResult.bindings,
		tiers: frozenTiers,
		acceptedDispatchModels,
		getModelRegistryEntry,
		getDispatchCanonical,
		normalizeDispatchModel,
		isModelSelectable,
		isModelSelectionSupported,
		buildModelCatalog,
		resolveCurrentModel,
	});
}

function loadSnapshot(
	path: string,
	revision: string,
	explicit: boolean,
): ModelConfigSnapshot {
	const warnings: string[] = [];
	let config: ModelConfigFile = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isObject(parsed) || parsed.version !== CONFIG_VERSION) {
			throw new Error(`expected object with version ${CONFIG_VERSION}`);
		}
		config = parsed;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		const detail =
			code === "ENOENT"
				? "file absent"
				: error instanceof Error
					? error.message
					: String(error);
		if (code !== "ENOENT" || explicit) {
			warnings.push(`using built-in model policy: ${detail}`);
		}
	}
	const snapshot = createSnapshot(path, revision, config, warnings);
	if (warnings.length > 0) {
		console.warn(`[model_config] ${warnings.join("; ")}`);
	}
	return snapshot;
}

/**
 * Hot-read facade. Callers capture this exactly once per business decision and
 * pass it through; the next decision sees an atomic file replacement.
 */
export function getModelConfigSnapshot(): ModelConfigSnapshot {
	const { path, explicit } = configLocation();
	const key = fileCacheKey(path);
	if (snapshotCache?.key === key) return snapshotCache.snapshot;
	const snapshot = loadSnapshot(path, key, explicit);
	snapshotCache = { key, snapshot };
	return snapshot;
}

export function resetModelConfigCacheForTests(): void {
	snapshotCache = undefined;
}

export function resolveAllowedCanonicalModel(
	raw: string,
	input: {
		surface: ModelSurface;
		runtimeVendor?: ModelRuntimeVendor;
		snapshot?: ModelConfigSnapshot;
	},
): string {
	const snapshot = input.snapshot ?? getModelConfigSnapshot();
	const entry = snapshot.getModelRegistryEntry(raw);
	if (!entry) {
		throw new ModelPolicyError("INVALID_MODEL", raw, `unknown model: ${raw}`);
	}
	if (
		!entry.surfaces.includes(input.surface) ||
		(input.runtimeVendor && entry.runtimeVendor !== input.runtimeVendor)
	) {
		throw new ModelPolicyError(
			"INVALID_MODEL",
			raw,
			`model ${entry.id} is unavailable for ${input.surface}`,
		);
	}
	return entry.id;
}

/**
 * FLY-1650 final effort seam — the counterpart to resolveAllowedCanonicalModel.
 *
 * The model is settled by that function after all precedence; the effort
 * arrives from a SEPARATE source (`roles.<role>.effort`, a workflow node, a
 * Lead launch argument) and used to be appended raw. A model whose registry
 * entry does not list the requested effort would then carry a parameter the
 * upstream API rejects — a 400 at spawn instead of a configuration error.
 * Validating the pair only at the writers is not enough: label, tier, and
 * workflow routes all reach the launch seam without passing a writer.
 *
 * NARROWING ONLY. An unknown model, or a surface the entry declares no effort
 * list for, is returned exactly as before — this must never become a new gate
 * on models it knows nothing about. A declared-but-empty list DOES mean "none
 * allowed" (that is what `cron: []` has always meant) and is honored.
 *
 * An unusable effort is DROPPED, loudly, rather than thrown: it must not cost
 * the fleet a Runner or a Lead. The model then runs at its own default — the
 * same availability stance resolveLeadLaunchSelection already takes when the
 * authoritative model itself is unresolvable.
 */
export function resolveAllowedEffort(
	model: string | undefined | null,
	effort: string | undefined | null,
	input: {
		surface: ModelSurface;
		snapshot?: ModelConfigSnapshot;
	},
): string | null {
	const wanted = effort?.trim();
	if (!wanted) return null;
	if (!model?.trim()) return wanted;
	const snapshot = input.snapshot ?? getModelConfigSnapshot();
	const entry = snapshot.getModelRegistryEntry(model);
	if (!entry) return wanted;
	const allowed = entry.effortsBySurface[input.surface];
	if (allowed === undefined) return wanted;
	if (allowed.includes(wanted as RoleEffort)) return wanted;
	console.warn(
		`[model_config] effort ${wanted} is unavailable for ${entry.id} on ${input.surface}; dropping it (supported: ${allowed.join(", ") || "none"})`,
	);
	return null;
}

/**
 * Writer boundary including the account-default sentinel. Null means "inherit
 * the account default" and is written through untouched; a spelled model is
 * canonicalized so persisted carriers never hold a bare alias.
 */
export function validateModelWrite(
	raw: string | null,
	input: {
		surface: ModelSurface;
		runtimeVendor?: ModelRuntimeVendor;
		snapshot?: ModelConfigSnapshot;
	},
): string | null {
	if (raw === null) return null;
	return resolveAllowedCanonicalModel(raw, input);
}

export interface LeadLaunchSelection {
	model: string;
	effort: string | null;
	substituted: boolean;
	reason: "configured" | "authoritative_absence" | "model_invalid";
}

/**
 * Lead boot is the sole availability exception: bad authoritative model data
 * is loudly substituted with the Fable family binding from this exact snapshot
 * so the fleet stays operable. Writer/spawn paths fail loud instead.
 */
export function resolveLeadLaunchSelection(
	rawModel: string | undefined,
	rawEffort: string | undefined,
	snapshot: ModelConfigSnapshot = getModelConfigSnapshot(),
): LeadLaunchSelection {
	const fallbackModel = snapshot.bindings.fable;
	if (!rawModel?.trim()) {
		return {
			model: fallbackModel,
			// FLY-1650: every branch resolves the effort against the model it
			// actually returns, so no exit from this function can emit a pair
			// the returned model does not support.
			effort: resolveAllowedEffort(fallbackModel, rawEffort, {
				surface: "lead",
				snapshot,
			}),
			substituted: false,
			reason: "authoritative_absence",
		};
	}
	try {
		const model = resolveAllowedCanonicalModel(rawModel, {
			surface: "lead",
			runtimeVendor: "claude",
			snapshot,
		});
		return {
			model,
			// FLY-1650: the effort comes from a different key than the model, so
			// the pair is only knowable here — after the model is settled.
			effort: resolveAllowedEffort(model, rawEffort, {
				surface: "lead",
				snapshot,
			}),
			substituted: false,
			reason: "configured",
		};
	} catch {
		// Availability guard, not policy: an unresolvable spelling in the
		// authoritative source must not leave the Lead unable to start.
		console.warn(
			`[model_config] Lead model ${rawModel} is not resolvable; substituting ${fallbackModel}`,
		);
		return {
			model: fallbackModel,
			// FLY-1650 (Codex R2): the substitute is a different model, so the
			// pair must be re-checked against it — not carried over from the
			// model that failed to resolve.
			effort: resolveAllowedEffort(fallbackModel, rawEffort, {
				surface: "lead",
				snapshot,
			}),
			substituted: true,
			reason: "model_invalid",
		};
	}
}

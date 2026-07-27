import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	assertValidModelRegistry,
	BUILTIN_MODEL_TIERS,
	BUILTIN_PHASE_DISPATCH,
	buildModelLookup,
	buildModelRegistry,
	DEFAULT_OPUS_BINDINGS,
	type DefaultOpusBindings,
	MODEL_IDS,
	MODEL_PROVIDERS,
	type ModelPhaseDispatchSpec,
	type ModelPhaseName,
	type ModelProviderId,
	type ModelRegistryEntry,
	type ModelRuntimeVendor,
	type ModelSurface,
	type ModelTier,
	type ModelTierSpec,
	modelFamilyCode,
} from "./model-builtins.js";
import { ROLE_EFFORT_LEVELS, type RoleEffort } from "./types.js";

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
const PHASE_NAMES: readonly ModelPhaseName[] = ["design", "implement", "qa"];

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
	readonly bindings: DefaultOpusBindings;
	readonly tiers: Readonly<Record<ModelTier, ModelTierSpec>>;
	readonly phases: Readonly<Record<ModelPhaseName, ModelPhaseDispatchSpec>>;
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
	phases?: unknown;
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
	runtimeVendor: ModelRuntimeVendor,
	surfaces: readonly ModelSurface[],
): ModelRegistryEntry["effortsBySurface"] {
	const efforts: Partial<Record<ModelSurface, readonly RoleEffort[]>> = {};
	for (const surface of surfaces) {
		if (surface === "dispatch") continue;
		if (surface === "cron") {
			efforts[surface] = [];
		} else if (runtimeVendor === "codex" && surface === "runner") {
			efforts[surface] = ["xhigh"];
		} else {
			efforts[surface] = ROLE_EFFORT_LEVELS;
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
		...(selectableSurfaces ? { selectableSurfaces } : {}),
		effortsBySurface: defaultEfforts(
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
		for (const entry of overlays) byId.set(entry.id.toLowerCase(), entry);
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

function applyBindings(
	registry: readonly ModelRegistryEntry[],
	value: unknown,
	warnings: string[],
): {
	registry: readonly ModelRegistryEntry[];
	bindings: DefaultOpusBindings;
} {
	if (value !== undefined && !isObject(value)) {
		warnings.push("bindings segment ignored: expected an object");
		value = undefined;
	}
	const configured = (value ?? {}) as Record<string, unknown>;
	const originalLookup = buildModelLookup(registry);
	const bindings = Object.freeze({
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
		["opus", bindings.opus],
		["opus-1m", bindings.opus1m],
		["opus[1m]", bindings.opus1m],
	]);
	const rebound = registry.map((entry) => {
		const aliases = entry.aliases.filter((alias) => !aliasTargets.has(alias));
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
	for (const id of [MODEL_IDS.OPUS_48, MODEL_IDS.OPUS_48_1M]) {
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
		const fallback = BUILTIN_MODEL_TIERS[tier];
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
	const phases = {} as Record<ModelPhaseName, ModelPhaseDispatchSpec>;
	const configuredPhases = isObject(config.phases) ? config.phases : {};
	if (config.phases !== undefined && !isObject(config.phases)) {
		warnings.push("phases segment ignored: expected an object");
	}
	for (const phase of PHASE_NAMES) {
		const fallback = BUILTIN_PHASE_DISPATCH[phase];
		const raw = configuredPhases[phase];
		if (raw === undefined) {
			phases[phase] = fallback;
			continue;
		}
		if (!isObject(raw)) {
			warnings.push(`phase ${phase} ignored: expected an object`);
			phases[phase] = fallback;
			continue;
		}
		const vendor = raw.vendor;
		const model = raw.model;
		const effort = raw.effort;
		const entry =
			typeof model === "string"
				? registryLookup.get(model.trim().toLowerCase())
				: undefined;
		const validEffort =
			effort === undefined ||
			(typeof effort === "string" &&
				(entry?.effortsBySurface.runner ?? []).includes(effort as RoleEffort));
		if (
			typeof vendor !== "string" ||
			!RUNTIME_VENDORS.has(vendor as ModelRuntimeVendor) ||
			!entry ||
			entry.runtimeVendor !== vendor ||
			!entry.surfaces.includes("runner") ||
			!validEffort
		) {
			warnings.push(`phase ${phase} ignored: unavailable dispatch selection`);
			phases[phase] = fallback;
			continue;
		}
		phases[phase] = Object.freeze({
			vendor: vendor as ModelRuntimeVendor,
			model: entry.id,
			...(typeof effort === "string" && {
				effort: effort as RoleEffort,
			}),
		});
	}
	const frozenPhases = Object.freeze(phases);

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
		phases: frozenPhases,
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
 * is loudly substituted with the literal built-in Fable id so the fleet stays
 * operable. Writer/spawn paths use resolveAllowedCanonicalModel and fail loud.
 */
export function resolveLeadLaunchSelection(
	rawModel: string | undefined,
	rawEffort: string | undefined,
	snapshot: ModelConfigSnapshot = getModelConfigSnapshot(),
): LeadLaunchSelection {
	if (!rawModel?.trim()) {
		return {
			model: MODEL_IDS.FABLE,
			effort: rawEffort?.trim() || null,
			substituted: false,
			reason: "authoritative_absence",
		};
	}
	try {
		return {
			model: resolveAllowedCanonicalModel(rawModel, {
				surface: "lead",
				runtimeVendor: "claude",
				snapshot,
			}),
			effort: rawEffort?.trim() || null,
			substituted: false,
			reason: "configured",
		};
	} catch {
		// Availability guard, not policy: an unresolvable spelling in the
		// authoritative source must not leave the Lead unable to start.
		console.warn(
			`[model_config] Lead model ${rawModel} is not resolvable; substituting ${MODEL_IDS.FABLE}`,
		);
		return {
			model: MODEL_IDS.FABLE,
			effort: rawEffort?.trim() || null,
			substituted: true,
			reason: "model_invalid",
		};
	}
}

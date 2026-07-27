import { ROLE_EFFORT_LEVELS, type RoleEffort } from "./types.js";

export type ModelProviderId = "anthropic" | "openai";
export type ModelRuntimeVendor = "claude" | "codex";
export type ModelSurface = "dispatch" | "lead" | "runner" | "workflow" | "cron";
export type ModelPhaseName = "design" | "implement" | "qa";

export interface ModelPhaseDispatchSpec {
	vendor: ModelRuntimeVendor;
	model: string;
	effort?: RoleEffort;
}

export interface ModelRegistryEntry {
	id: string;
	provider: ModelProviderId;
	runtimeVendor: ModelRuntimeVendor;
	label: string;
	aliases: readonly string[];
	surfaces: readonly ModelSurface[];
	selectableSurfaces?: readonly ModelSurface[];
	effortsBySurface: Partial<
		Readonly<Record<ModelSurface, readonly RoleEffort[]>>
	>;
}

export const MODEL_IDS = {
	FABLE: "claude-fable-5",
	FABLE_1M: "claude-fable-5[1m]",
	OPUS_5: "claude-opus-5",
	OPUS_5_1M: "claude-opus-5[1m]",
	OPUS_48: "claude-opus-4-8",
	OPUS_48_1M: "claude-opus-4-8[1m]",
	SONNET_46: "claude-sonnet-4-6",
	SONNET_5: "claude-sonnet-5",
	HAIKU: "claude-haiku-4-5-20251001",
	CODEX_STANDARD: "gpt-5.6-sol",
} as const;

export interface DefaultOpusBindings {
	readonly opus: string;
	readonly opus1m: string;
}

export const DEFAULT_OPUS_BINDINGS: DefaultOpusBindings = Object.freeze({
	opus: MODEL_IDS.OPUS_5,
	opus1m: MODEL_IDS.OPUS_5_1M,
});
export const DEFAULT_OPUS = DEFAULT_OPUS_BINDINGS.opus;
export const DEFAULT_OPUS_1M = DEFAULT_OPUS_BINDINGS.opus1m;

const ALL_MANAGED_SURFACES: readonly ModelSurface[] = Object.freeze([
	"lead",
	"runner",
	"workflow",
	"cron",
]);
const DISPATCH_AND_MANAGED_SURFACES: readonly ModelSurface[] = Object.freeze([
	"dispatch",
	...ALL_MANAGED_SURFACES,
]);

function claudeEntry(input: {
	id: string;
	label: string;
	aliases?: readonly string[];
	dispatch?: boolean;
	selectableSurfaces?: readonly ModelSurface[];
}): ModelRegistryEntry {
	const surfaces = input.dispatch
		? DISPATCH_AND_MANAGED_SURFACES
		: ALL_MANAGED_SURFACES;
	return {
		id: input.id,
		provider: "anthropic",
		runtimeVendor: "claude",
		label: input.label,
		aliases: input.aliases ?? [],
		surfaces,
		selectableSurfaces: input.selectableSurfaces ?? surfaces,
		effortsBySurface: {
			lead: ROLE_EFFORT_LEVELS,
			runner: ROLE_EFFORT_LEVELS,
			workflow: ROLE_EFFORT_LEVELS,
			cron: [],
		},
	};
}

const OPUS_IDENTITIES: readonly string[] = Object.freeze([
	MODEL_IDS.OPUS_5,
	MODEL_IDS.OPUS_5_1M,
	MODEL_IDS.OPUS_48,
	MODEL_IDS.OPUS_48_1M,
]);

const OPUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
	[MODEL_IDS.OPUS_5]: "Opus 5",
	[MODEL_IDS.OPUS_5_1M]: "Opus 5 (1M)",
	[MODEL_IDS.OPUS_48]: "Opus 4.8",
	[MODEL_IDS.OPUS_48_1M]: "Opus 4.8 (1M)",
});

export function buildModelRegistry(
	bindings: DefaultOpusBindings,
): readonly ModelRegistryEntry[] {
	const legacy = (id: string): ModelRegistryEntry =>
		claudeEntry({
			id,
			label: OPUS_LABELS[id] ?? id,
			selectableSurfaces: [],
		});
	const bound = (id: string, aliases: readonly string[]): ModelRegistryEntry =>
		claudeEntry({
			id,
			label: OPUS_LABELS[id] ?? id,
			aliases,
			dispatch: true,
		});

	return [
		claudeEntry({
			id: MODEL_IDS.FABLE,
			label: "Fable 5",
			aliases: ["fable"],
			dispatch: true,
		}),
		claudeEntry({
			id: MODEL_IDS.FABLE_1M,
			label: "Fable 5 (1M)",
			aliases: ["fable-1m", "fable[1m]"],
		}),
		bound(bindings.opus, ["opus"]),
		bound(bindings.opus1m, ["opus-1m", "opus[1m]"]),
		claudeEntry({ id: MODEL_IDS.SONNET_46, label: "Sonnet 4.6" }),
		claudeEntry({
			id: MODEL_IDS.SONNET_5,
			label: "Sonnet 5",
			aliases: ["sonnet"],
			dispatch: true,
		}),
		claudeEntry({
			id: MODEL_IDS.HAIKU,
			label: "Haiku 4.5",
			aliases: ["haiku"],
			dispatch: true,
		}),
		{
			id: MODEL_IDS.CODEX_STANDARD,
			provider: "openai",
			runtimeVendor: "codex",
			label: "GPT-5.6",
			aliases: ["codex"],
			surfaces: ["runner", "workflow", "cron"],
			effortsBySurface: {
				runner: ["xhigh"],
				workflow: ROLE_EFFORT_LEVELS,
				cron: [],
			},
		},
		...OPUS_IDENTITIES.filter(
			(id) => id !== bindings.opus && id !== bindings.opus1m,
		).map(legacy),
	];
}

export function assertValidModelRegistry(
	entries: readonly ModelRegistryEntry[],
): void {
	const ids = new Set<string>();
	const spellings = new Map<string, string>();
	for (const entry of entries) {
		const id = entry.id.trim().toLowerCase();
		if (!id || ids.has(id)) throw new Error(`duplicate model id: ${entry.id}`);
		ids.add(id);
		for (const spelling of [entry.id, ...entry.aliases]) {
			const normalized = spelling.trim().toLowerCase();
			if (!normalized) throw new Error(`empty model alias for ${entry.id}`);
			const owner = spellings.get(normalized);
			if (owner && owner.toLowerCase() !== entry.id.toLowerCase()) {
				throw new Error(`model alias collision: ${spelling}`);
			}
			spellings.set(normalized, entry.id);
		}
		for (const surface of entry.selectableSurfaces ?? entry.surfaces) {
			if (!entry.surfaces.includes(surface)) {
				throw new Error(
					`selectableSurfaces must be a subset of surfaces: ${entry.id}/${surface}`,
				);
			}
		}
		for (const surface of Object.keys(entry.effortsBySurface)) {
			if (!entry.surfaces.includes(surface as ModelSurface)) {
				throw new Error(`effort surface not enabled: ${entry.id}/${surface}`);
			}
		}
	}
}

export const MODEL_REGISTRY: readonly ModelRegistryEntry[] = Object.freeze(
	buildModelRegistry(DEFAULT_OPUS_BINDINGS),
);
assertValidModelRegistry(MODEL_REGISTRY);

export function buildModelLookup(
	entries: readonly ModelRegistryEntry[],
): ReadonlyMap<string, ModelRegistryEntry> {
	const lookup = new Map<string, ModelRegistryEntry>();
	for (const entry of entries) {
		for (const spelling of [entry.id, ...entry.aliases]) {
			lookup.set(spelling.trim().toLowerCase(), entry);
		}
	}
	return lookup;
}

/**
 * Dispatch lookup: ids and aliases of the models that carry a dispatch surface,
 * PLUS the legacy Opus identities. The legacy ids are injected deliberately so a
 * carrier pinned before they were retired keeps dispatching; they hold no tier
 * alias and are not selectable, so nothing NEW is ever routed to them.
 */
export function buildDispatchLookup(
	bindings: DefaultOpusBindings,
	entries: readonly ModelRegistryEntry[] = buildModelRegistry(bindings),
): ReadonlyMap<string, string> {
	const lookup = new Map<string, string>();
	for (const entry of entries) {
		const explicitOneM = entry.id === MODEL_IDS.FABLE_1M;
		if (!entry.surfaces.includes("dispatch") && !explicitOneM) continue;
		lookup.set(entry.id.toLowerCase(), entry.id);
		for (const alias of entry.aliases) {
			lookup.set(alias.toLowerCase(), entry.id);
		}
	}
	for (const id of OPUS_IDENTITIES) lookup.set(id.toLowerCase(), id);
	return lookup;
}

export type ModelTier = "heavy" | "medium" | "light" | "trivial";

export interface ModelTierSpec {
	id: string;
	aliases: readonly string[];
	code?: "F" | "O" | "S" | "H";
}

/**
 * Founder policy (2026-07-27 final revision): difficulty tiers use only Fable
 * and Opus 5. Sonnet/Haiku remain recognizable registry entries, never default
 * tiers. Executor-family selection remains a separate routing decision.
 */
export const BUILTIN_MODEL_TIERS: Readonly<Record<ModelTier, ModelTierSpec>> =
	Object.freeze({
		heavy: { id: MODEL_IDS.FABLE, aliases: ["fable"], code: "F" },
		medium: { id: MODEL_IDS.OPUS_5, aliases: ["opus"], code: "O" },
		light: { id: MODEL_IDS.OPUS_5, aliases: ["opus"], code: "O" },
		trivial: { id: MODEL_IDS.OPUS_5, aliases: ["opus"], code: "O" },
	});

/**
 * Stable fail-safe for three-stage dispatch. Runtime decisions read the
 * `phases` segment from the same hot snapshot as the difficulty tiers.
 */
export const BUILTIN_PHASE_DISPATCH: Readonly<
	Record<ModelPhaseName, ModelPhaseDispatchSpec>
> = Object.freeze({
	design: Object.freeze({ vendor: "claude", model: MODEL_IDS.FABLE }),
	implement: Object.freeze({
		vendor: "codex",
		model: MODEL_IDS.CODEX_STANDARD,
		effort: "xhigh",
	}),
	qa: Object.freeze({ vendor: "claude", model: MODEL_IDS.OPUS_5 }),
});

export const MODEL_PROVIDERS: Readonly<
	Record<ModelProviderId, { id: ModelProviderId; label: string }>
> = Object.freeze({
	anthropic: { id: "anthropic", label: "Anthropic" },
	openai: { id: "openai", label: "OpenAI" },
});

export function modelFamilyCode(
	model: string,
): "F" | "O" | "S" | "H" | undefined {
	const lower = model.toLowerCase();
	if (lower.startsWith("claude-fable")) return "F";
	if (lower.startsWith("claude-opus")) return "O";
	if (lower.startsWith("claude-sonnet")) return "S";
	if (lower.startsWith("claude-haiku")) return "H";
	return undefined;
}

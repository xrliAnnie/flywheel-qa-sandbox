import { ROLE_EFFORT_LEVELS, type RoleEffort } from "./types.js";

export type ModelProviderId = "anthropic" | "openai";
export type ModelRuntimeVendor = "claude" | "codex";
export type ModelSurface = "dispatch" | "lead" | "runner" | "workflow" | "cron";

export interface ModelRegistryEntry {
	id: string;
	provider: ModelProviderId;
	runtimeVendor: ModelRuntimeVendor;
	label: string;
	aliases: readonly string[];
	surfaces: readonly ModelSurface[];
	effortsBySurface: Partial<
		Readonly<Record<ModelSurface, readonly RoleEffort[]>>
	>;
}

export const MODEL_IDS = {
	FABLE: "claude-fable-5",
	FABLE_1M: "claude-fable-5[1m]",
	OPUS: "claude-opus-4-8",
	OPUS_1M: "claude-opus-4-8[1m]",
	SONNET_46: "claude-sonnet-4-6",
	SONNET_5: "claude-sonnet-5",
	HAIKU: "claude-haiku-4-5-20251001",
	CODEX_STANDARD: "gpt-5.6-sol",
} as const;

const ALL_MANAGED_SURFACES: readonly ModelSurface[] = [
	"lead",
	"runner",
	"workflow",
	"cron",
];
const DISPATCH_AND_MANAGED_SURFACES: readonly ModelSurface[] = [
	"dispatch",
	...ALL_MANAGED_SURFACES,
];
const WORKFLOW_EFFORT_LEVELS: readonly RoleEffort[] = ROLE_EFFORT_LEVELS;

function claudeEntry(input: {
	id: string;
	label: string;
	aliases?: readonly string[];
	dispatch?: boolean;
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
		effortsBySurface: {
			lead: ROLE_EFFORT_LEVELS,
			runner: ROLE_EFFORT_LEVELS,
			workflow: WORKFLOW_EFFORT_LEVELS,
			// The managed launchd carrier persists --model only. Advertising an
			// effort would make the console claim a write that cannot survive refresh.
			cron: [],
		},
	};
}

export const MODEL_REGISTRY: readonly ModelRegistryEntry[] = [
	claudeEntry({
		id: MODEL_IDS.FABLE,
		label: "Fable 5",
		aliases: ["fable"],
		dispatch: true,
	}),
	claudeEntry({
		id: MODEL_IDS.FABLE_1M,
		label: "Fable 5 (1M)",
		aliases: ["fable-1m"],
	}),
	claudeEntry({
		id: MODEL_IDS.OPUS,
		label: "Opus 4.8",
		aliases: ["opus"],
		dispatch: true,
	}),
	claudeEntry({
		id: MODEL_IDS.OPUS_1M,
		label: "Opus 4.8 (1M)",
		aliases: ["opus-1m"],
		dispatch: true,
	}),
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
];

const PROVIDERS: Readonly<
	Record<ModelProviderId, { id: ModelProviderId; label: string }>
> = {
	anthropic: { id: "anthropic", label: "Anthropic" },
	openai: { id: "openai", label: "OpenAI" },
};

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
			if (owner && owner !== entry.id) {
				throw new Error(`model alias collision: ${spelling}`);
			}
			spellings.set(normalized, entry.id);
		}
		for (const surface of Object.keys(entry.effortsBySurface)) {
			if (!entry.surfaces.includes(surface as ModelSurface)) {
				throw new Error(`effort surface not enabled: ${entry.id}/${surface}`);
			}
		}
	}
}

assertValidModelRegistry(MODEL_REGISTRY);

const MODEL_LOOKUP: ReadonlyMap<string, ModelRegistryEntry> = (() => {
	const lookup = new Map<string, ModelRegistryEntry>();
	for (const entry of MODEL_REGISTRY) {
		for (const spelling of [entry.id, ...entry.aliases]) {
			lookup.set(spelling.toLowerCase(), entry);
		}
	}
	return lookup;
})();

export function getModelRegistryEntry(raw: string): ModelRegistryEntry | null {
	return MODEL_LOOKUP.get(raw.trim().toLowerCase()) ?? null;
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
		}>;
	}>;
}

export function buildModelCatalog(surface: ModelSurface): ModelCatalog {
	const providers: ModelCatalog["providers"] = [];
	for (const provider of Object.values(PROVIDERS)) {
		const models = MODEL_REGISTRY.filter(
			(entry) =>
				entry.provider === provider.id && entry.surfaces.includes(surface),
		).map((entry) => ({
			id: entry.id,
			label: entry.label,
			runtimeVendor: entry.runtimeVendor,
			efforts: entry.effortsBySurface[surface] ?? [],
		}));
		if (models.length > 0) providers.push({ ...provider, models });
	}
	return { version: 1, surface, providers };
}

export function isModelSelectionSupported(input: {
	surface: ModelSurface;
	model: string;
	effort?: string;
	runtimeVendor?: string;
}): boolean {
	const entry = getModelRegistryEntry(input.model);
	if (!entry || !entry.surfaces.includes(input.surface)) return false;
	if (input.runtimeVendor && entry.runtimeVendor !== input.runtimeVendor) {
		return false;
	}
	if (input.effort === undefined) return true;
	return (entry.effortsBySurface[input.surface] ?? []).includes(
		input.effort as RoleEffort,
	);
}

export interface CurrentModelView {
	id: string;
	label: string;
	provider: ModelProviderId | null;
	runtimeVendor: ModelRuntimeVendor | null;
	legacyCurrent: boolean;
	selectable: boolean;
}

export function resolveCurrentModel(
	raw: string,
	surface: ModelSurface,
): CurrentModelView {
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
	const selectable = entry.surfaces.includes(surface);
	return {
		id: entry.id,
		label: entry.label,
		provider: entry.provider,
		runtimeVendor: entry.runtimeVendor,
		legacyCurrent: !selectable,
		selectable,
	};
}

import {
	assertValidModelRegistry,
	buildDispatchLookup,
	buildModelRegistry,
	DEFAULT_MODEL_BINDINGS,
	DEFAULT_OPUS,
	DEFAULT_OPUS_1M,
	DEFAULT_OPUS_BINDINGS,
	type DefaultOpusBindings,
	MODEL_ALIASES,
	MODEL_IDS,
	MODEL_PROVIDERS,
	MODEL_REGISTRY,
	type ModelBindings,
	type ModelProviderId,
	type ModelRegistryEntry,
	type ModelRuntimeVendor,
	type ModelSurface,
} from "./model-builtins.js";
import {
	type CurrentModelView,
	getModelConfigSnapshot,
	type ModelCatalog,
} from "./model-config.js";

export type {
	DefaultOpusBindings,
	ModelBindings,
	ModelProviderId,
	ModelRegistryEntry,
	ModelRuntimeVendor,
	ModelSurface,
};
export type { CurrentModelView, ModelCatalog };
export {
	assertValidModelRegistry,
	buildDispatchLookup,
	buildModelRegistry,
	DEFAULT_MODEL_BINDINGS,
	DEFAULT_OPUS,
	DEFAULT_OPUS_1M,
	DEFAULT_OPUS_BINDINGS,
	MODEL_ALIASES,
	MODEL_IDS,
	MODEL_REGISTRY,
};

/**
 * Public compatibility facade. Each call reads the current immutable model
 * configuration snapshot; callers making multi-step decisions should capture
 * getModelConfigSnapshot() directly and pass that snapshot through.
 */
export function getModelRegistryEntry(raw: string): ModelRegistryEntry | null {
	return getModelConfigSnapshot().getModelRegistryEntry(raw);
}

export function isModelSelectable(input: {
	surface: ModelSurface;
	model: string;
	runtimeVendor?: string;
}): boolean {
	return getModelConfigSnapshot().isModelSelectable(input);
}

export function isModelSelectionSupported(input: {
	surface: ModelSurface;
	model: string;
	effort?: string;
	runtimeVendor?: string;
}): boolean {
	return getModelConfigSnapshot().isModelSelectionSupported(input);
}

function buildCatalogFromRegistry(
	surface: ModelSurface,
	registry: readonly ModelRegistryEntry[],
): ModelCatalog {
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
}

export function buildModelCatalog(
	surface: ModelSurface,
	bindings?: DefaultOpusBindings,
): ModelCatalog {
	if (bindings !== undefined) {
		return buildCatalogFromRegistry(surface, buildModelRegistry(bindings));
	}
	return getModelConfigSnapshot().buildModelCatalog(surface);
}

export function resolveCurrentModel(
	raw: string,
	surface: ModelSurface,
): CurrentModelView {
	return getModelConfigSnapshot().resolveCurrentModel(raw, surface);
}

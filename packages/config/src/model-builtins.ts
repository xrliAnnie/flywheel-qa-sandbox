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
	selectableSurfaces?: readonly ModelSurface[];
	/** API capability ceiling; not necessarily the launched-session window. */
	maxInputTokens?: number;
	/** Trusted launched-session context window when independently corroborated. */
	contextWindowTokens?: number;
	effortsBySurface: Partial<
		Readonly<Record<ModelSurface, readonly RoleEffort[]>>
	>;
}

export const MODEL_IDS = {
	FABLE: "claude-fable-5-1",
	FABLE_1M: "claude-fable-5-1[1m]",
	OPUS_5: "claude-opus-5",
	OPUS_5_1M: "claude-opus-5[1m]",
	OPUS_48: "claude-opus-4-8",
	OPUS_48_1M: "claude-opus-4-8[1m]",
	OPUS_46: "claude-opus-4-6",
	OPUS_46_1M: "claude-opus-4-6[1m]",
	SONNET_46: "claude-sonnet-4-6",
	SONNET_5: "claude-sonnet-5",
	HAIKU: "claude-haiku-4-5-20251001",
	CODEX_STANDARD: "gpt-5.6-sol",
} as const;

export const MODEL_ALIASES = {
	FABLE: "fable",
} as const;

export interface DefaultOpusBindings {
	readonly opus: string;
	readonly opus1m: string;
}

export interface ModelBindings extends DefaultOpusBindings {
	readonly fable: string;
}

export const DEFAULT_OPUS_BINDINGS: DefaultOpusBindings = Object.freeze({
	opus: MODEL_IDS.OPUS_5,
	opus1m: MODEL_IDS.OPUS_5_1M,
});
export const DEFAULT_OPUS = DEFAULT_OPUS_BINDINGS.opus;
export const DEFAULT_OPUS_1M = DEFAULT_OPUS_BINDINGS.opus1m;
export const DEFAULT_MODEL_BINDINGS: ModelBindings = Object.freeze({
	...DEFAULT_OPUS_BINDINGS,
	fable: MODEL_IDS.FABLE,
});

/** Retired Fable identities accepted only for immutable historical pins. */
export const LEGACY_FABLE_MODEL_IDS = Object.freeze([
	"claude-fable-5",
	"claude-fable-5[1m]",
] as const);

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

/**
 * FLY-1650: 模型自身不支持的 reasoning 档位。`xhigh` 是 Opus 4.7 才引入的,
 * Opus 4.6 只认 low/medium/high/max —— 把 xhigh 放进它的档位面会让派工带着
 * 上游不认的参数出去,换回一个 400。
 *
 * 收窄按 **模型 id** 而不是按某个构造点,因为同一个 id 有三条进 registry 的
 * 路径(内建条目、被 DEFAULT_OPUS_BINDINGS 接管后的 bound 条目、models.json
 * 的 models overlay)。挂在 id 上,三条路径拿到的是同一张表。
 */
const UNSUPPORTED_EFFORTS_BY_MODEL: Readonly<
	Record<string, readonly RoleEffort[]>
> = Object.freeze({
	[MODEL_IDS.OPUS_46]: ["xhigh"],
	[MODEL_IDS.OPUS_46_1M]: ["xhigh"],
});

/** 某模型在可选档位面上真正支持的 effort 列表。未登记的模型 = 全档位。 */
export function supportedRoleEfforts(modelId: string): readonly RoleEffort[] {
	const unsupported =
		UNSUPPORTED_EFFORTS_BY_MODEL[modelId.trim().toLowerCase()];
	if (!unsupported || unsupported.length === 0) return ROLE_EFFORT_LEVELS;
	return ROLE_EFFORT_LEVELS.filter((effort) => !unsupported.includes(effort));
}

/**
 * Exact launched-session windows that were already trusted by the former
 * resume-gate compatibility table. Keeping them on registry entries makes the
 * resolver the only authority that can attach a numeric window; future model
 * ids receive no value unless the registry/API supplies one explicitly.
 */
const TRUSTED_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze(
	{
		[MODEL_IDS.FABLE]: 1_000_000,
		[MODEL_IDS.FABLE_1M]: 1_000_000,
		[LEGACY_FABLE_MODEL_IDS[0]]: 1_000_000,
		[LEGACY_FABLE_MODEL_IDS[1]]: 1_000_000,
		[MODEL_IDS.OPUS_5]: 200_000,
		[MODEL_IDS.OPUS_5_1M]: 1_000_000,
		[MODEL_IDS.OPUS_48]: 200_000,
		[MODEL_IDS.OPUS_48_1M]: 1_000_000,
		[MODEL_IDS.OPUS_46]: 200_000,
		[MODEL_IDS.OPUS_46_1M]: 1_000_000,
		[MODEL_IDS.SONNET_46]: 200_000,
		[MODEL_IDS.SONNET_5]: 1_000_000,
		[MODEL_IDS.HAIKU]: 200_000,
	},
);

function claudeEntry(input: {
	id: string;
	label: string;
	aliases?: readonly string[];
	dispatch?: boolean;
	surfaces?: readonly ModelSurface[];
	selectableSurfaces?: readonly ModelSurface[];
	maxInputTokens?: number;
	contextWindowTokens?: number;
}): ModelRegistryEntry {
	const surfaces =
		input.surfaces ??
		(input.dispatch ? DISPATCH_AND_MANAGED_SURFACES : ALL_MANAGED_SURFACES);
	const efforts = supportedRoleEfforts(input.id);
	const contextWindowTokens =
		input.contextWindowTokens ?? TRUSTED_CONTEXT_WINDOWS[input.id];
	// 档位面按实际启用的 surface 派生 —— assertValidModelRegistry 要求
	// effortsBySurface 的每个键都在 surfaces 里,写死四个键会让缩面条目非法。
	const effortsBySurface: Partial<Record<ModelSurface, readonly RoleEffort[]>> =
		{};
	for (const surface of surfaces) {
		if (surface === "dispatch") continue;
		effortsBySurface[surface] = surface === "cron" ? [] : efforts;
	}
	return {
		id: input.id,
		provider: "anthropic",
		runtimeVendor: "claude",
		label: input.label,
		aliases: input.aliases ?? [],
		surfaces,
		selectableSurfaces: input.selectableSurfaces ?? surfaces,
		...(input.maxInputTokens === undefined
			? {}
			: { maxInputTokens: input.maxInputTokens }),
		...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
		effortsBySurface,
	};
}

const OPUS_IDENTITIES: readonly string[] = Object.freeze([
	MODEL_IDS.OPUS_5,
	MODEL_IDS.OPUS_5_1M,
	MODEL_IDS.OPUS_48,
	MODEL_IDS.OPUS_48_1M,
]);

const LEGACY_FABLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
	[LEGACY_FABLE_MODEL_IDS[0]]: "Fable 5",
	[LEGACY_FABLE_MODEL_IDS[1]]: "Fable 5 (1M)",
});

const OPUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
	[MODEL_IDS.OPUS_5]: "Opus 5",
	[MODEL_IDS.OPUS_5_1M]: "Opus 5 (1M)",
	[MODEL_IDS.OPUS_48]: "Opus 4.8",
	[MODEL_IDS.OPUS_48_1M]: "Opus 4.8 (1M)",
	[MODEL_IDS.OPUS_46]: "Opus 4.6",
	[MODEL_IDS.OPUS_46_1M]: "Opus 4.6 (1M)",
});

/**
 * FLY-1650: runner 侧 Opus 4.6 试点条目。与 OPUS_IDENTITIES 里的 legacy 身份
 * 不同 —— legacy 是「退役后仍要能派工的旧载体」,不可被新选;4.6 是受控菜单里
 * **新增的一个可选项**,所以走完整 claudeEntry。
 *
 * 仍然按 bindings 过滤:万一将来把 opus 档绑到 4.6,bound() 会接管这两个 id,
 * 这里必须让位,否则 registry 撞重复 id、assertValidModelRegistry 在 import
 * 时直接抛。
 */
const PILOT_OPUS_ALIASES: Readonly<Record<string, readonly string[]>> =
	Object.freeze({
		[MODEL_IDS.OPUS_46]: ["opus-4-6"],
		[MODEL_IDS.OPUS_46_1M]: ["opus-4-6-1m", "opus-4-6[1m]"],
	});

const PILOT_OPUS_IDENTITIES: readonly string[] = Object.freeze([
	MODEL_IDS.OPUS_46,
	MODEL_IDS.OPUS_46_1M,
]);

/**
 * 试点是 **runner 侧** 的:founder 明确 Lead 这一轮不换模型。所以 4.6 不挂
 * `lead` 面 —— fleet console 的 Lead 模型下拉不会多出这两项,把 Lead 设成 4.6
 * 也会 fail-loud 而不是被静默接受。真要给 Lead 用,是另一个决定(把 opus 档
 * 绑到 4.6),走 DEFAULT_OPUS_BINDINGS 那条路。
 */
const PILOT_OPUS_SURFACES: readonly ModelSurface[] = Object.freeze([
	"dispatch",
	"runner",
	"workflow",
	"cron",
]);

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
	const pilot = (id: string): ModelRegistryEntry =>
		claudeEntry({
			id,
			label: OPUS_LABELS[id] ?? id,
			aliases: PILOT_OPUS_ALIASES[id] ?? [],
			surfaces: PILOT_OPUS_SURFACES,
		});

	return [
		claudeEntry({
			id: MODEL_IDS.FABLE,
			label: "Fable 5.1",
			aliases: [MODEL_ALIASES.FABLE],
			dispatch: true,
			maxInputTokens: 1_000_000,
			contextWindowTokens: 1_000_000,
		}),
		claudeEntry({
			id: MODEL_IDS.FABLE_1M,
			label: "Fable 5.1 (1M)",
			aliases: ["fable-1m", "fable[1m]"],
			maxInputTokens: 1_000_000,
			contextWindowTokens: 1_000_000,
		}),
		...LEGACY_FABLE_MODEL_IDS.map((id) =>
			claudeEntry({
				id,
				label: LEGACY_FABLE_LABELS[id] ?? id,
				selectableSurfaces: [],
			}),
		),
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
		...PILOT_OPUS_IDENTITIES.filter(
			(id) => id !== bindings.opus && id !== bindings.opus1m,
		).map(pilot),
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
		if (
			entry.maxInputTokens !== undefined &&
			(!Number.isSafeInteger(entry.maxInputTokens) || entry.maxInputTokens <= 0)
		) {
			throw new Error(`invalid max input tokens: ${entry.id}`);
		}
		if (
			entry.contextWindowTokens !== undefined &&
			(!Number.isSafeInteger(entry.contextWindowTokens) ||
				entry.contextWindowTokens <= 0)
		) {
			throw new Error(`invalid context window: ${entry.id}`);
		}
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
	for (const id of [...OPUS_IDENTITIES, ...LEGACY_FABLE_MODEL_IDS]) {
		lookup.set(id.toLowerCase(), id);
	}
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

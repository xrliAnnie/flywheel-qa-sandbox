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
	/**
	 * FLY-1467:**可被新选**的 surface 子集(缺省 = `surfaces`)。
	 *
	 * `surfaces` = 运行时**可接受**(已发布的 workflow revision 靠它继续跑);
	 * `selectableSurfaces` = catalog 展示与**新写入**时允许选择的集合。
	 * 两者分开,才能既不打断已发布的 4.8 revision,又不把 4.8 广告成新可选档。
	 */
	selectableSurfaces?: readonly ModelSurface[];
	effortsBySurface: Partial<
		Readonly<Record<ModelSurface, readonly RoleEffort[]>>
	>;
}

export const MODEL_IDS = {
	FABLE: "claude-fable-5",
	FABLE_1M: "claude-fable-5[1m]",
	// FLY-1467: 身份层 —— 每个 model 一个固定常量,值永不改动。
	// 刻意**没有** OPUS / OPUS_1M 这类「当前默认」成员:那会把身份与默认
	// 混在一起,回滚时主条目与 legacy 条目撞同一个 id,`assertValidModelRegistry`
	// 在 import 期就抛错。「当前默认指向谁」由下面的 DEFAULT_OPUS_BINDINGS 表达。
	OPUS_5: "claude-opus-5",
	OPUS_5_1M: "claude-opus-5[1m]",
	OPUS_48: "claude-opus-4-8",
	OPUS_48_1M: "claude-opus-4-8[1m]",
	SONNET_46: "claude-sonnet-4-6",
	SONNET_5: "claude-sonnet-5",
	HAIKU: "claude-haiku-4-5-20251001",
	CODEX_STANDARD: "gpt-5.6-sol",
} as const;

/**
 * FLY-1467 绑定层 —— **升级 / 回滚唯一要改的地方**。
 *
 * Annie 的原则(2026-07-24):配置只写档位(`opus` / `opus-1m`),永不写版本号;
 * 版本只存在 model-registry 这一处。这个对象就是那「一处」。
 */
export interface DefaultOpusBindings {
	readonly opus: string;
	readonly opus1m: string;
}

/** 当前默认档位绑定。回滚 = 把这两行指回 OPUS_48 / OPUS_48_1M。 */
export const DEFAULT_OPUS_BINDINGS: DefaultOpusBindings = {
	opus: MODEL_IDS.OPUS_5,
	opus1m: MODEL_IDS.OPUS_5_1M,
};

export const DEFAULT_OPUS = DEFAULT_OPUS_BINDINGS.opus;
export const DEFAULT_OPUS_1M = DEFAULT_OPUS_BINDINGS.opus1m;

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
			workflow: WORKFLOW_EFFORT_LEVELS,
			// The managed launchd carrier persists --model only. Advertising an
			// effort would make the console claim a write that cannot survive refresh.
			cron: [],
		},
	};
}

/**
 * FLY-1467:registry 由 bindings 构造的**纯工厂**。
 *
 * 之所以是工厂而不是模块级常量:测试要在**同一次 build 内**同时验证
 * 生产态(默认=Opus 5)与回滚态(默认=Opus 4.8),模块级 `const` 做不到。
 */
export function buildModelRegistry(
	bindings: DefaultOpusBindings,
): readonly ModelRegistryEntry[] {
	const boundOpus = bindings.opus;
	const boundOpus1m = bindings.opus1m;
	/** 未被绑定的 Opus 身份 = legacy:运行时仍可接受,但不作为新可选档广告。 */
	const legacy = (id: string): ModelRegistryEntry =>
		claudeEntry({
			id,
			label: OPUS_LABELS[id] ?? id,
			// surfaces 保持默认(运行时可接受),但 selectableSurfaces 置空
			// → 已发布 revision 继续跑,catalog / 新写入不列它。
			selectableSurfaces: [],
		});
	/** 被绑定的 Opus 身份 = 当前默认:alias + dispatch + 正常可选。 */
	const bound = (id: string, alias: string): ModelRegistryEntry =>
		claudeEntry({
			id,
			label: OPUS_LABELS[id] ?? id,
			aliases: [alias],
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
			aliases: ["fable-1m"],
		}),
		bound(boundOpus, "opus"),
		bound(boundOpus1m, "opus-1m"),
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
		// FLY-1467: the NOT-currently-bound Opus identities are APPENDED last so
		// every pre-existing ordinal stays byte-compatible (the same convention
		// FLY-728 used when it appended Sonnet 5). They keep their runtime
		// surfaces — an existing Lead/workflow pinned to them must keep working
		// and must keep rendering a human label — but carry no tier alias and
		// are not offered as new choices.
		...OPUS_IDENTITIES.filter(
			(id) => id !== boundOpus && id !== boundOpus1m,
		).map(legacy),
	];
}

/** 四个 Opus 身份(顺序稳定,便于 legacy 条目排列可预期)。 */
const OPUS_IDENTITIES: readonly string[] = [
	MODEL_IDS.OPUS_5,
	MODEL_IDS.OPUS_5_1M,
	MODEL_IDS.OPUS_48,
	MODEL_IDS.OPUS_48_1M,
];

const OPUS_LABELS: Readonly<Record<string, string>> = {
	[MODEL_IDS.OPUS_5]: "Opus 5",
	[MODEL_IDS.OPUS_5_1M]: "Opus 5 (1M)",
	[MODEL_IDS.OPUS_48]: "Opus 4.8",
	[MODEL_IDS.OPUS_48_1M]: "Opus 4.8 (1M)",
};

/** 生产实例 —— 由当前默认绑定构造。 */
export const MODEL_REGISTRY: readonly ModelRegistryEntry[] = buildModelRegistry(
	DEFAULT_OPUS_BINDINGS,
);

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

assertValidModelRegistry(MODEL_REGISTRY);

/**
 * FLY-1467:dispatch lookup 也由**同一 bindings** 构造,与 `buildModelRegistry`
 * 同源 —— 两个工厂不得各自漂移。
 *
 * 收录三类拼写:① 档位 alias(`opus` / `opus-1m`,指向当前绑定)
 * ② 全部固定身份 ID(含未绑定的 legacy,保 `/api/runs/start` 等边界的旧 pin)
 * ③ 其余 registry 条目自身的 id/alias。
 */
export function buildDispatchLookup(
	bindings: DefaultOpusBindings,
): ReadonlyMap<string, string> {
	const m = new Map<string, string>();
	for (const entry of buildModelRegistry(bindings)) {
		m.set(entry.id.toLowerCase(), entry.id);
		for (const alias of entry.aliases) m.set(alias.toLowerCase(), entry.id);
	}
	// legacy 身份即便未被绑定,也必须仍被接受(旧 pin 向后兼容)。
	for (const id of OPUS_IDENTITIES) m.set(id.toLowerCase(), id);
	return m;
}

/**
 * FLY-1467:`isModelSelectable` = **可被新选**(catalog 展示 / 新写入),
 * 与 `isModelSelectionSupported`(运行时**可接受**)是两件事,不可互相顶替。
 */
export function isModelSelectable(input: {
	surface: ModelSurface;
	model: string;
	runtimeVendor?: string;
}): boolean {
	const entry = getModelRegistryEntry(input.model);
	if (!entry) return false;
	if (input.runtimeVendor && entry.runtimeVendor !== input.runtimeVendor) {
		return false;
	}
	return (entry.selectableSurfaces ?? entry.surfaces).includes(input.surface);
}

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
			/** FLY-1467: may this be picked as a NEW choice? (legacy = false) */
			selectable: boolean;
		}>;
	}>;
}

export function buildModelCatalog(
	surface: ModelSurface,
	bindings: DefaultOpusBindings = DEFAULT_OPUS_BINDINGS,
): ModelCatalog {
	const providers: ModelCatalog["providers"] = [];
	const registry =
		bindings === DEFAULT_OPUS_BINDINGS
			? MODEL_REGISTRY
			: buildModelRegistry(bindings);
	for (const provider of Object.values(PROVIDERS)) {
		// FLY-1467: the catalog lists everything ACCEPTED on this surface, so an
		// existing pin keeps its human label and stays a legal target. Whether an
		// entry may be picked as a NEW choice is the per-model `selectable` flag
		// below — filtering the catalog itself would silently strip existing pins
		// (it made a Lead pinned to claude-opus-4-8[1m] render as a raw id and
		// dropped it from allowedModelTargets).
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
	// FLY-1467: selectable 报的是「能不能被新选」,与运行时可接受区分。
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
}

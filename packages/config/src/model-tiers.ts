import {
	BUILTIN_MODEL_TIERS,
	type ModelTier,
	type ModelTierSpec,
} from "./model-builtins.js";
import { getModelConfigSnapshot } from "./model-config.js";

export type { ModelTier, ModelTierSpec };

/**
 * Compatibility baseline for consumers that intentionally need a stable
 * module-level default. Runtime decisions should use getModelTiers().
 */
export const MODEL_TIERS: Readonly<Record<ModelTier, ModelTierSpec>> =
	BUILTIN_MODEL_TIERS;

export function getModelTiers(): Readonly<Record<ModelTier, ModelTierSpec>> {
	return getModelConfigSnapshot().tiers;
}

export function acceptedDispatchModels(): readonly string[] {
	return getModelConfigSnapshot().acceptedDispatchModels;
}

/**
 * Kept for source compatibility in error payloads. New request boundaries must
 * call acceptedDispatchModels() after capturing a decision snapshot.
 */
export const ACCEPTED_DISPATCH_MODELS: readonly string[] =
	getModelConfigSnapshot().acceptedDispatchModels;

export function normalizeDispatchModel(raw: string): string | null {
	return getModelConfigSnapshot().normalizeDispatchModel(raw);
}

export function modelShortCode(
	model: string | null | undefined,
): "F" | "O" | "S" | "H" | undefined {
	if (!model) return undefined;
	const normalized = model.toLowerCase();
	if (normalized === "fable" || normalized.startsWith("claude-fable")) {
		return "F";
	}
	if (normalized === "opus" || normalized.startsWith("claude-opus")) return "O";
	if (normalized === "sonnet" || normalized.startsWith("claude-sonnet")) {
		return "S";
	}
	if (normalized === "haiku" || normalized.startsWith("claude-haiku")) {
		return "H";
	}
	return undefined;
}

interface VendorShortCodeEntry {
	family: string;
	matches: (lowerModel: string) => boolean;
	code: "G" | "K";
}

const VENDOR_SHORT_CODES: readonly VendorShortCodeEntry[] = [
	{ family: "codex", matches: (model) => model.startsWith("gpt-"), code: "G" },
	{ family: "kimi", matches: (model) => model.startsWith("kimi-"), code: "K" },
];

export function vendorModelShortCode(
	family: string | null | undefined,
	model: string | null | undefined,
): "G" | "K" | undefined {
	const normalizedFamily = family?.toLowerCase();
	const normalizedModel = model?.toLowerCase() ?? "";
	if (!normalizedFamily || !normalizedModel) return undefined;
	for (const entry of VENDOR_SHORT_CODES) {
		if (entry.family === normalizedFamily && entry.matches(normalizedModel)) {
			return entry.code;
		}
	}
	return undefined;
}

const SHORT_CODE_DISPLAY_NAME: Readonly<Record<"F" | "O" | "S" | "H", string>> =
	{ F: "Fable", O: "Opus", S: "Sonnet", H: "Haiku" };

export function modelDisplayName(
	model: string | null | undefined,
	fallbackTier?: ModelTier,
): string | undefined {
	const normalized = model?.toLowerCase();
	if (normalized?.startsWith("gpt-5.6")) return "GPT-5.6";
	if (normalized?.startsWith("gpt-")) return "GPT";
	const code = modelShortCode(model);
	if (code) return SHORT_CODE_DISPLAY_NAME[code];
	if (fallbackTier) {
		const fallbackCode = getModelTiers()[fallbackTier].code;
		return fallbackCode ? SHORT_CODE_DISPLAY_NAME[fallbackCode] : undefined;
	}
	return undefined;
}

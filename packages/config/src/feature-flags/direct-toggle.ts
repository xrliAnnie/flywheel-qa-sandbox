import type {
	FlagCategory,
	FlagScope,
	FlagSource,
	FlagToggleability,
	FlagValueKind,
	ReadTiming,
} from "./registry.js";

export interface DirectToggleMetadata {
	source: FlagSource;
	scope: FlagScope;
	valueKind: FlagValueKind;
	/** For valueKind === "enum": required non-empty for direct toggling. */
	enumValues?: readonly string[];
	/** Store-backed value flags may opt in only when stage validates a strict codec. */
	strictValueCodec?: boolean;
	toggleable: FlagToggleability;
	category: FlagCategory;
	dormant?: boolean;
	readTimings: readonly ReadTiming[];
}

/**
 * One safety predicate shared by registry specs, server apply, and UI controls.
 * FLY-1356 R1#2: widened from bool-only to bool ∨ (enum with non-empty
 * enumValues) so the enum kill-switch `skill_framework_mode` can be applied
 * through the same admission gate. A value-kind flag additionally needs an
 * explicit strict-codec proof from the store-backed server boundary.
 */
export function isDirectToggleMetadata(
	metadata: DirectToggleMetadata,
): boolean {
	const valueKindOk =
		metadata.valueKind === "bool" ||
		(metadata.valueKind === "enum" && (metadata.enumValues?.length ?? 0) > 0) ||
		(metadata.valueKind === "value" && metadata.strictValueCodec === true);
	return (
		metadata.source === "env" &&
		metadata.scope === "bridge_global" &&
		valueKindOk &&
		metadata.toggleable === "direct" &&
		metadata.category !== "governance_gate" &&
		!metadata.dormant &&
		metadata.readTimings.length > 0 &&
		metadata.readTimings.every(
			(timing) => timing === "call_time" || timing === "dotenv_live",
		)
	);
}

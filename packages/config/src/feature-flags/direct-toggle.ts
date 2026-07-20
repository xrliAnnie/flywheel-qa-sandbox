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
	toggleable: FlagToggleability;
	category: FlagCategory;
	dormant?: boolean;
	readTimings: readonly ReadTiming[];
}

/**
 * One safety predicate shared by registry specs, server apply, and UI controls.
 * FLY-1356 R1#2: widened from bool-only to bool ∨ (enum with non-empty
 * enumValues) so the enum kill-switch `skill_framework_mode` can be applied
 * through the same admission gate. `value`-kind flags stay rejected — a free
 * string has no bounded target set for the stage layer to validate against.
 */
export function isDirectToggleMetadata(
	metadata: DirectToggleMetadata,
): boolean {
	const valueKindOk =
		metadata.valueKind === "bool" ||
		(metadata.valueKind === "enum" && (metadata.enumValues?.length ?? 0) > 0);
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

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
	toggleable: FlagToggleability;
	category: FlagCategory;
	dormant?: boolean;
	readTimings: readonly ReadTiming[];
}

/** One safety predicate shared by registry specs, server apply, and UI controls. */
export function isDirectToggleMetadata(
	metadata: DirectToggleMetadata,
): boolean {
	return (
		metadata.source === "env" &&
		metadata.scope === "bridge_global" &&
		metadata.valueKind === "bool" &&
		metadata.toggleable === "direct" &&
		metadata.category !== "governance_gate" &&
		!metadata.dormant &&
		metadata.readTimings.length > 0 &&
		metadata.readTimings.every(
			(timing) => timing === "call_time" || timing === "dotenv_live",
		)
	);
}

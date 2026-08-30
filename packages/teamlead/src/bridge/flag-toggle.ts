import {
	type FeatureFlagSpec,
	getFlagStoreCodec,
	isDirectToggleMetadata,
	STORE_MANAGED_FLAGS,
} from "flywheel-config";

/** Only flags read at call-time (live), non-governance, marked direct. */
export function isDirectToggleable(spec: FeatureFlagSpec): boolean {
	const codec = getFlagStoreCodec(spec.name);
	let strictValueCodec = false;
	if (
		spec.valueKind === "value" &&
		STORE_MANAGED_FLAGS.has(spec.name) &&
		codec !== undefined
	) {
		try {
			strictValueCodec =
				typeof codec.parse({ hasOverride: false, raw: null }) === "string";
		} catch {
			strictValueCodec = false;
		}
	}
	return isDirectToggleMetadata({
		...spec,
		strictValueCodec,
		readTimings: spec.readSites.map((site) => site.timing),
	});
}

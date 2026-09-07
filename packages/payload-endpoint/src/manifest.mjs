// FLY-2387: payload grammar, channels, and manifest constructors live in the
// zero-runtime-dependency contract package. Keep this compatibility module so
// existing endpoint imports do not acquire a second definition.
export * from "flywheel-release-contract";

export const MANIFEST_KEY = "manifest.json";
export const KEY_PREFIX = "keys/";

export function keyObjectKey(keySha256) {
	return `${KEY_PREFIX}${keySha256}.json`;
}

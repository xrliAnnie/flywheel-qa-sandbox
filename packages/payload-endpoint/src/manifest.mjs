// FLY-1062 PR3 · manifest grammar + shared constants (plan §B0-2/B0-3).
//
// Everything here is pure string/shape judgment — no I/O, no clock. The
// validator, the transition classifier, and the handler all share these so a
// grammar decision is made in exactly one place.

export const CHANNELS = ["internal-beta", "customer-release"];

// channel pointer name → version entry channel value
export const CHANNEL_OF_POINTER = {
	"internal-beta": "beta",
	"customer-release": "release",
};

export const VERSION_STATUSES = ["active", "quarantined", "expired"];
export const OP_STATES = ["reserved", "prepared", "committed", "abandoned"];
export const OP_KINDS = ["beta", "release"];

// retention windows (plan §B0-10-2): pointer-tenure / quarantine clocks.
export const RETENTION_WINDOW_MS = {
	beta: 14 * 24 * 60 * 60 * 1000,
	release: 28 * 24 * 60 * 60 * 1000,
};

export const CLEAN_SEMVER_RE = /^\d+\.\d+\.\d+$/;
export const BETA_SEMVER_RE = /^\d+\.\d+\.\d+-beta\.\d+$/;

export function isCleanSemver(v) {
	return typeof v === "string" && CLEAN_SEMVER_RE.test(v);
}

export function isBetaSemver(v) {
	return typeof v === "string" && BETA_SEMVER_RE.test(v);
}

export function isPayloadSemver(v) {
	return isCleanSemver(v) || isBetaSemver(v);
}

// baseOf <ver> → the clean X.Y.Z base (identity for clean versions).
export function baseOf(ver) {
	return typeof ver === "string" ? ver.replace(/-beta\.\d+$/, "") : ver;
}

export function isHex(s, len) {
	return typeof s === "string" && s.length === len && /^[0-9a-f]+$/.test(s);
}

export function isIso(s) {
	return (
		typeof s === "string" &&
		!Number.isNaN(Date.parse(s)) &&
		s === new Date(s).toISOString()
	);
}

// derived object key (invariant 2: never a free-form string).
export function payloadObjectKey(ver, sha256) {
	return `payloads/${ver}/${sha256}.tgz`;
}

export const MANIFEST_KEY = "manifest.json";
export const KEY_PREFIX = "keys/";

export function keyObjectKey(keySha256) {
	return `${KEY_PREFIX}${keySha256}.json`;
}

export function emptyManifest() {
	return {
		schemaVersion: 1,
		channels: {
			"internal-beta": { latest: null },
			"customer-release": { latest: null },
		},
		versions: {},
		releaseOps: {},
		releaseLedger: {},
		tombstones: [],
	};
}

// latestSet <manifest> → Set of version strings that are some channel's latest.
export function latestSet(manifest) {
	const s = new Set();
	for (const ch of CHANNELS) {
		const v = manifest?.channels?.[ch]?.latest;
		if (typeof v === "string") s.add(v);
	}
	return s;
}

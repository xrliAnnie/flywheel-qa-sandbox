const NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const CLEAN_SOURCE = `${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}`;

export const BASE_RE = new RegExp(`^${CLEAN_SOURCE}$`);
export const CLEAN_SEMVER_RE = BASE_RE;
export const BETA_SEMVER_RE = new RegExp(
	`^(${CLEAN_SOURCE})-beta\\.([1-9]\\d*)$`,
);

export const CHANNELS = ["internal-beta", "customer-release"];
export const CHANNEL_OF_POINTER = {
	"internal-beta": "beta",
	"customer-release": "release",
};
export const ENTITLEMENT_POINTER = {
	internal: "internal-beta",
	customer: "customer-release",
};
export const POINTER_CAPABILITY = {
	"internal-beta": "beta-publish",
	"customer-release": "customer-release",
};
export const VERSION_STATUSES = ["active", "quarantined", "expired"];
export const OP_STATES = ["reserved", "prepared", "committed", "abandoned"];
export const OP_KINDS = ["beta", "release"];
export const RETENTION_WINDOW_MS = {
	beta: 14 * 24 * 60 * 60 * 1000,
	release: 28 * 24 * 60 * 60 * 1000,
};

export function parsePayloadVersion(value) {
	if (typeof value !== "string") return null;
	if (CLEAN_SEMVER_RE.test(value)) {
		return { kind: "clean", base: value, betaN: null };
	}
	const beta = BETA_SEMVER_RE.exec(value);
	if (!beta) return null;
	return { kind: "beta", base: beta[1], betaN: Number(beta[2]) };
}

export function isCleanSemver(value) {
	return typeof value === "string" && CLEAN_SEMVER_RE.test(value);
}

export function isBetaSemver(value) {
	return typeof value === "string" && BETA_SEMVER_RE.test(value);
}

export function isPayloadSemver(value) {
	return parsePayloadVersion(value) !== null;
}

export function baseOf(value) {
	const parsed = parsePayloadVersion(value);
	if (!parsed) throw new Error(`invalid payload version: ${String(value)}`);
	return parsed.base;
}

export function isDerivationOf(baseVersion, payloadVersion) {
	if (!isCleanSemver(baseVersion)) return false;
	const parsed = parsePayloadVersion(payloadVersion);
	return parsed !== null && parsed.base === baseVersion;
}

export function normalizeVersionFile(text) {
	if (typeof text !== "string") {
		throw new Error("invalid base version: doc/VERSION must be text");
	}
	const normalized = text.replace(/\s/g, "");
	const baseVersion = normalized.startsWith("v")
		? normalized.slice(1)
		: normalized;
	if (!isCleanSemver(baseVersion)) {
		throw new Error(`invalid base version in doc/VERSION: ${normalized}`);
	}
	return baseVersion;
}

export function toDisplayLabel(payloadVersion) {
	if (!isPayloadSemver(payloadVersion)) {
		throw new Error(`invalid payload version: ${String(payloadVersion)}`);
	}
	return `v${payloadVersion}`;
}

export function isHex(value, length) {
	return (
		typeof value === "string" &&
		value.length === length &&
		/^[0-9a-f]+$/.test(value)
	);
}

export function isIso(value) {
	return (
		typeof value === "string" &&
		!Number.isNaN(Date.parse(value)) &&
		value === new Date(value).toISOString()
	);
}

export function payloadObjectKey(payloadVersion, sha256) {
	if (!isPayloadSemver(payloadVersion)) {
		throw new Error(`invalid payload version: ${String(payloadVersion)}`);
	}
	if (!isHex(sha256, 64)) {
		throw new Error(
			"invalid payload sha256: expected 64 lowercase hex characters",
		);
	}
	return `payloads/${payloadVersion}/${sha256}.tgz`;
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

export function latestSet(manifest) {
	const latest = new Set();
	for (const pointer of CHANNELS) {
		const version = manifest?.channels?.[pointer]?.latest;
		if (typeof version === "string") latest.add(version);
	}
	return latest;
}

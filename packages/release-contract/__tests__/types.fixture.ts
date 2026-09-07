import {
	deriveVetoBinding,
	emptyManifest,
	type Manifest,
	type PreparedReleaseOp,
} from "../index.js";

const empty: Manifest = emptyManifest();
empty.channels["internal-beta"].latest = null;

const reserved: Manifest = {
	schemaVersion: 1,
	channels: {
		"internal-beta": { latest: null },
		"customer-release": { latest: null },
	},
	versions: {},
	releaseOps: {
		"promo-1": {
			kind: "release",
			state: "reserved",
			ver: "1.55.0",
			betaVersion: "1.55.0-beta.2",
			sourceCommit: null,
			sha256: null,
			objectKey: null,
			createdAt: "2026-09-01T00:00:00.000Z",
		},
	},
	releaseLedger: {},
	tombstones: [],
};

const preparedOp: PreparedReleaseOp = {
	kind: "release",
	state: "prepared",
	ver: "1.55.0",
	betaVersion: "1.55.0-beta.2",
	sourceCommit: "a".repeat(40),
	sha256: "b".repeat(64),
	objectKey: `payloads/1.55.0/${"b".repeat(64)}.tgz`,
	createdAt: "2026-09-01T00:00:00.000Z",
};
reserved.releaseOps["promo-1"] = preparedOp;

const committed: Manifest = {
	...reserved,
	releaseOps: {
		...reserved.releaseOps,
		"promo-1": { ...preparedOp, state: "committed" },
	},
};
void committed;

const paused: Manifest = {
	...empty,
	channels: {
		"internal-beta": { latest: null },
		"customer-release": { latest: null },
	},
};
void paused;

const binding = deriveVetoBinding(reserved, "promo-1");
binding.betaPayloadSha256 satisfies string;
binding.releasePayloadSha256 satisfies string;
binding.betaVersion satisfies string;
binding.releaseVersion satisfies string;

const incompleteTuple = {
	kind: "release",
	state: "prepared",
	ver: "1.55.0",
	betaVersion: "1.55.0-beta.2",
	sourceCommit: null,
	sha256: null,
	objectKey: null,
	createdAt: "2026-09-01T00:00:00.000Z",
} as const;
// @ts-expect-error prepared operations require a complete tuple
const invalidPrepared: PreparedReleaseOp = incompleteTuple;
void invalidPrepared;

const extraChannel: Manifest = {
	...empty,
	channels: {
		"internal-beta": { latest: null },
		"customer-release": { latest: null },
		// @ts-expect-error channels are an exact named contract
		preview: { latest: null },
	},
};
void extraChannel;

const invalidStatus: Manifest = {
	...empty,
	versions: {
		"1.55.0": {
			sha256: "a".repeat(64),
			key: "payloads/example.tgz",
			size: 1,
			publishedAt: "2026-09-01T00:00:00.000Z",
			channel: "release",
			// @ts-expect-error paused is a channel state, not a version status
			status: "paused",
			sourceCommit: "b".repeat(40),
			releaseId: "promo-1",
			derivedFromBeta: "1.55.0-beta.2",
			retentionSince: null,
			quarantinedAt: null,
		},
	},
};
void invalidStatus;
